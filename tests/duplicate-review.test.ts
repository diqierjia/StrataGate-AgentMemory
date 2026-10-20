import { mkdtemp, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import { StrataGate, type EventDuplicateDecision } from '@diqier/stratagate'
import { StrataGateRuntime } from '../src/runtime.js'
import { EventDuplicateMaintenance } from '../src/event-duplicate-maintenance.js'
import { handleAdminRequest } from '../src/web.js'
import type { DshModelBridge } from '../src/llm.js'

async function fixture(options: { conflict?: boolean; superseded?: boolean; thirdSuccessor?: boolean; ai?: EventDuplicateDecision; sourceText?: string; timeoutMs?: number } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'stratagate-review-ui-')); const database = join(directory, 'memory.db')
  const memory = await StrataGate.open({ database, namespace: 'review', blockTurnSize: 1 })
  const cards = []
  for (let i=0;i<2;i++) {
    const block=(await memory.appendTurn({user:options.sourceText ?? 'Interview source '+i,assistant:'Saved'}, {deferDerivation:true})).sealedBlock!
    cards.push(await memory.addEvent({title:'Xidian master interview',summary:'Interview for Xidian master program August 17.',
      criticality:i?'identity':'routine',quotes:i?[]:['Bring transcript'],temporal:{...(i?{participants:['Li']}:{ }),...(options.conflict?{happenedStart:i?'2026-08-18':'2026-08-17'}:{})},
      sourceBlockId:block.id,sourceMessageIds:[block.l5Raw[0]!.id]}))
  }
  if(options.thirdSuccessor){
    const third=await memory.addEvent({title:'Xidian master interview',summary:'Interview for Xidian master program August 17.',sourceBlockId:cards[1]!.sourceBlockId!,sourceMessageIds:cards[1]!.sourceMessageIds,temporal:{supersedesEventIds:[cards[0]!.id]}})
    cards[0]!.status='superseded';cards[0]!.supersededBy=third.id;cards[1]!.temporal.supersedesEventIds=[cards[0]!.id]
    await memory.appendTurn({user:'持久化历史关系',assistant:'已记录'},{deferDerivation:true})
  }else if(options.superseded){cards[0]!.status='superseded';cards[0]!.supersededBy=cards[1]!.id;await memory.appendTurn({user:'后续记录',assistant:'已记录'},{deferDerivation:true})}
  const journal=new EventDuplicateMaintenance(database)
  const decide=vi.fn(async()=>({action:'KEEP_BOTH' as const,confidence:.9,reason:'Need to confirm these sources describe the same interview.'}))
  await journal.tick('review',{snapshot:async()=>memory.exportSnapshot(),decide,archive:(pair,id)=>memory.mergeDuplicateEvents(pair,id)})
  await memory.close()
  const model=vi.fn(async(_context?:unknown)=>options.ai ?? {action:'REVIEW' as const,confidence:.6,reason:'Source ambiguity requires human review.'})
  const runtime=new StrataGateRuntime({database,namespaceMode:'project',namespacePrefix:'dsh',globalNamespace:'global',blockTurnSize:1,
    blockDecayLambda:.3,ingestSubagents:false,maxOutputTokens:2048,...(options.timeoutMs === undefined ? {} : {structuredTaskTimeoutMs:options.timeoutMs})},
    {isReady:()=>Boolean(options.ai),onAdaptersUpdated:()=>()=>{},eventDuplicateDecider:model,runDetached:async(_id:string,run:()=>Promise<unknown>)=>run()} as unknown as DshModelBridge)
  const request=async(method='GET',body?:unknown,query='')=>{
    const input=body as any
    if(input?.action==='merge'&&input.pair?.left&&input.draft===undefined) input.draft={title:'Xidian master interview',summary:'Interview for the Xidian master program on August 17: bring the transcript and meet Li.'}
    let status=0;let text=''
    await handleAdminRequest(runtime,{method,url:'/api/stratagate/duplicates?namespace=review'+query,body},
      {get statusCode(){return status},set statusCode(value){status=value},setHeader(){},end(value){text=value}})
    return {status,body:JSON.parse(text)}
  }
  const list=()=>request()
  return {directory,database,runtime,journal,cards,decide,model,request,list,
    close:async()=>{journal.close();await runtime.close();await rm(directory,{recursive:true,force:true})}}
}

describe('duplicate review through actual admin boundary',()=>{
  it.each([false,true])('preserves a selected historical original third successor, including an interrupted checkpoint (%s)',async interrupted=>{
    const host=await fixture({thirdSuccessor:true})
    try{
      const row=(await host.list()).body.items.find((item:any)=>item.leftId===host.cards[0]!.id&&item.rightId===host.cards[1]!.id)
      const before=(await host.runtime.adminSnapshot('review'))!,successor=row.left.supersededBy
      if(interrupted){
        await expect(host.journal.resolve('review',row,row.rightId,async(pair,id,prepareUndo)=>{
          const memory=await StrataGate.open({database:host.database,namespace:'review'})
          try{expect(await memory.reviewDuplicateEvents(pair,id,'select',prepareUndo)).toBe(true)}finally{await memory.close()}
          throw Error('interrupted after core commit')
        },'select')).rejects.toThrow('after core commit')
        expect(await host.runtime.runEventDuplicateMaintenance()).toBe(true)
      }else expect((await host.request('POST',{action:'select',pair:row,keepId:row.rightId})).status).toBe(200)
      const saved=(await host.list()).body.items.find((item:any)=>item.leftId===row.leftId&&item.rightId===row.rightId)
      expect(saved).toMatchObject({outcome:'selected',keepId:row.rightId,userReviewed:true,left:{status:'archived',supersededBy:successor}})
      const snapshot=(await host.runtime.adminSnapshot('review'))!
      expect(snapshot.events.find(e=>e.id===successor)).toEqual(before.events.find(e=>e.id===successor))
      expect(snapshot.events.find(e=>e.id===row.rightId)).toMatchObject({summary:row.right.summary,sourceMessageIds:row.right.sourceMessageIds})
      expect((await host.request('POST',{action:'undo',pair:saved,undoId:saved.undoId})).status).toBe(200)
      expect((await host.runtime.adminSnapshot('review'))!.events).toEqual(before.events)
    }finally{await host.close()}
  })
  it.each([false,true])('saves a reviewed draft with a third successor and recovers a lost checkpoint (%s) without rewriting history',async interrupted=>{
    const draft={title:'核对后的硕士经历',summary:'保留当前有效事实、李老师及原始材料要求。'}
    const host=await fixture({thirdSuccessor:true,ai:{action:'KEEP_RIGHT',confidence:.99,reason:'Draft for confirmation',draft}})
    try{
      const row=(await host.list()).body.items.find((item:any)=>item.leftId===host.cards[0]!.id&&item.rightId===host.cards[1]!.id)
      expect(row).toMatchObject({canMerge:true,recommendedKeepId:host.cards[1]!.id,choices:{right:{canMerge:true}}})
      const before=(await host.runtime.adminSnapshot('review'))!,third=before.events.find(e=>e.id===row.left.supersededBy)!
      expect(host.journal.details('review')).toHaveLength(3)
      expect((await host.request('POST',{action:'draft',pair:row})).body.draft).toEqual(draft)
      if(interrupted){
        await expect(host.journal.resolve('review',row,row.rightId,async(pair,id,prepareUndo)=>{
          const memory=await StrataGate.open({database:host.database,namespace:'review'})
          try{expect(await memory.reviewDuplicateEvents(pair,id,'merge',prepareUndo,draft,'manual')).toBe(true)}finally{await memory.close()}
          throw Error('interruption after the durable core commit')
        })).rejects.toThrow('interruption')
        expect(await host.runtime.runEventDuplicateMaintenance()).toBe(true)
      }else expect((await host.request('POST',{action:'merge',pair:row,keepId:row.rightId,draft})).status).toBe(200)
      const saved=(await host.list()).body.items.find((item:any)=>item.leftId===row.leftId&&item.rightId===row.rightId)
      expect(saved).toMatchObject({outcome:'merged',keepId:row.rightId,userReviewed:true,left:{status:'archived',supersededBy:third.id},right:{...draft,mergedFromEventIds:[row.leftId]}})
      expect((await host.runtime.adminSnapshot('review'))!.events.find(e=>e.id===third.id)).toEqual(third)
      const allPairs=(await host.request('GET',undefined,'&limit=50')).body.items
      const otherHistoryPair=allPairs.find((item:any)=>[item.leftId,item.rightId].includes(row.leftId)&&[item.leftId,item.rightId].includes(third.id))
      expect(otherHistoryPair).toBeTruthy();expect(otherHistoryPair.outcome).not.toBe('selected');expect(otherHistoryPair.outcome).not.toBe('merged')
      expect(saved.right.sourceMessageIds).toEqual(expect.arrayContaining([...row.left.sourceMessageIds,...row.right.sourceMessageIds]))
      expect(host.model).toHaveBeenCalledTimes(1)
      const reopened=new EventDuplicateMaintenance(host.database)
      try{expect(reopened.details('review').find(pair=>pair.leftId===row.leftId&&pair.rightId===row.rightId)).toMatchObject({outcome:'merged',keepId:row.rightId,undo:{id:saved.undoId}})}finally{reopened.close()}
      expect((await host.request('POST',{action:'undo',pair:saved,undoId:saved.undoId})).status).toBe(200)
      expect((await host.runtime.adminSnapshot('review'))!.events).toEqual(before.events)
    }finally{await host.close()}
  })
  it.each(['pin','stale'] as const)('explains the actual %s rejection and does not mutate the reviewed cards',async kind=>{
    const host=await fixture()
    try{
      const row=(await host.list()).body.items[0],memory=await StrataGate.open({database:host.database,namespace:'review'})
      try{
        const other=memory.listAllEvents().find(e=>e.id===row.leftId)!
        if(kind==='pin')other.weight.pinned=true;else other.summary='新的事实更新'
        await memory.appendTurn({user:'持久化变化',assistant:'已记录'},{deferDerivation:true})
      }finally{await memory.close()}
      const before=(await host.runtime.adminSnapshot('review'))!.events,response=await host.request('POST',{action:'merge',pair:row,keepId:row.rightId})
      expect(response.status).toBe(409);expect(JSON.stringify(response.body)).toContain(kind==='pin'?'已置顶':'原卡在整理期间发生了变化')
      expect((await host.runtime.adminSnapshot('review'))!.events).toEqual(before)
    }finally{await host.close()}
  })
  it.each([false,true])('sends complete long sources for a manual draft, including historical cards (%s)',async superseded=>{
    const sourceText='完整原始资料。'.repeat(8000)+'末尾独有证据：保研进入西电硕士。'
    const host=await fixture({sourceText,superseded,ai:{action:'REVIEW',confidence:.7,reason:'Draft for user review',draft:{title:'完整经历',summary:'保研进入西电硕士，需结合历史来源核对当前事实。'}}})
    try{
      const row=(await host.list()).body.items[0],before=(await host.runtime.adminSnapshot('review'))!.events
      for(let retry=0;retry<3;retry++)expect((await host.request('POST',{action:'draft',pair:row,regenerate:true})).status).toBe(200)
      expect(host.model).toHaveBeenCalledTimes(3)
      for(const [input] of host.model.mock.calls){
        const context=input as {left:{messages:Array<{content:string}>};right:{messages:Array<{content:string}>}}
        expect(JSON.stringify(context).length).toBeGreaterThan(16000)
        expect(context.left.messages[0]!.content).toBe(sourceText)
        expect(context.right.messages[0]!.content).toBe(sourceText)
      }
      expect((await host.runtime.adminSnapshot('review'))!.events).toEqual(before)
    }finally{await host.close()}
  })
  it.each([undefined,300000])('uses the standard configured timeout for manual generation (%s)',async timeoutMs=>{
    const host=await fixture({...(timeoutMs === undefined ? {} : {timeoutMs}),ai:{action:'REVIEW',confidence:.7,reason:'Draft',draft:{title:'Full draft',summary:'Complete evidence-backed memory.'}}})
    const timeout=vi.spyOn(AbortSignal,'timeout').mockImplementation(()=>new AbortController().signal)
    try{
      const row=(await host.list()).body.items[0]
      expect((await host.request('POST',{action:'draft',pair:row,regenerate:true})).status).toBe(200)
      expect(timeout).toHaveBeenCalledWith(timeoutMs ?? 120000)
      expect(timeout).not.toHaveBeenCalledWith(30000)
    }finally{timeout.mockRestore();await host.close()}
  })
  it('holds a long manual request lease without dispatching extra model calls and releases it on completion',async()=>{
    const decision={action:'REVIEW' as const,confidence:.7,reason:'Draft',draft:{title:'Full draft',summary:'Complete evidence-backed memory.'}}
    const host=await fixture({ai:decision,timeoutMs:300000})
    let release!:(value:EventDuplicateDecision)=>void,start!:()=>void
    const started=new Promise<void>(resolve=>{start=resolve})
    host.model.mockImplementationOnce(()=>new Promise<EventDuplicateDecision>(resolve=>{release=resolve;start()}))
    const timeout=vi.spyOn(AbortSignal,'timeout').mockImplementation(()=>new AbortController().signal)
    try{
      const row=(await host.list()).body.items[0]
      vi.useFakeTimers({toFake:['Date','setInterval','clearInterval']})
      const pending=host.request('POST',{action:'draft',pair:row,regenerate:true});await started
      await vi.advanceTimersByTimeAsync(240000)
      expect((await host.request('POST',{action:'draft',pair:row,regenerate:true})).status).toBe(409)
      expect(host.model).toHaveBeenCalledTimes(1)
      release(decision);expect((await pending).status).toBe(200)
      expect(vi.getTimerCount()).toBe(0)
      expect((await host.request('POST',{action:'draft',pair:row,regenerate:true})).status).toBe(200)
      expect(vi.getTimerCount()).toBe(0);expect(host.model).toHaveBeenCalledTimes(2)
    }finally{release?.(decision);vi.useRealTimers();timeout.mockRestore();await host.close()}
  })
  it('regenerates only on explicit request and keeps the last good draft after failure',async()=>{
    const host=await fixture({ai:{action:'KEEP_RIGHT',confidence:.99,reason:'Same fact',draft:{title:'First draft',summary:'First complete summary'}}})
    try{
      const row=(await host.list()).body.items[0]
      await host.request('POST',{action:'draft',pair:row})
      host.model.mockResolvedValueOnce({action:'KEEP_RIGHT',confidence:.99,reason:'Rewritten',draft:{title:'New draft',summary:'A newly written complete summary'}})
      const response=await host.request('POST',{action:'draft',pair:row,regenerate:true})
      expect(response.body.draft.title).toBe('New draft');expect(host.model).toHaveBeenCalledTimes(2)
      expect((await host.request('POST',{action:'draft',pair:row})).body.draft.title).toBe('New draft')
      host.model.mockRejectedValueOnce(new Error('Temporary model failure'))
      expect((await host.request('POST',{action:'draft',pair:row,regenerate:true})).status).toBe(409)
      expect(host.model).toHaveBeenCalledTimes(3)
      expect((await host.request('POST',{action:'draft',pair:row})).body.draft.title).toBe('New draft')
      for(let i=0;i<4;i++)expect((await host.request('POST',{action:'draft',pair:row,regenerate:true})).status).toBe(200)
      expect(host.model).toHaveBeenCalledTimes(7)
      expect((await host.runtime.adminSnapshot('review'))!.events).toEqual([expect.objectContaining({status:'active'}),expect.objectContaining({status:'active'})])
    }finally{await host.close()}
  })
  it('allows manual retries from a persisted exhausted legacy budget without restarting automatic work',async()=>{
    const host=await fixture({ai:{action:'REVIEW',confidence:.6,reason:'Manual draft',draft:{title:'Full draft',summary:'Both source-supported facts.'}}})
    try{
      const row=(await host.list()).body.items[0],before=(await host.runtime.adminSnapshot('review'))!.events
      const db=new DatabaseSync(host.database)
      try{
        const stored=db.prepare('SELECT state_json FROM stratagate_dsh_event_duplicate_repair WHERE namespace=?').get('review') as {state_json:string}
        const state=JSON.parse(stored.state_json);state.status='completed';state.cursor=state.pairs.length
        Object.assign(state.pairs[0],{draftAttempts:2,attempts:2,outcome:'failed',nextAt:0,draftFingerprints:row.leftFingerprint+row.rightFingerprint})
        db.prepare('UPDATE stratagate_dsh_event_duplicate_repair SET state_json=? WHERE namespace=?').run(JSON.stringify(state),'review')
      }finally{db.close()}
      host.model.mockRejectedValueOnce(new Error('Temporary outage'))
      expect((await host.request('POST',{action:'draft',pair:row,regenerate:true})).status).toBe(409)
      expect(host.model).toHaveBeenCalledTimes(1)
      for(let i=0;i<4;i++)expect((await host.request('POST',{action:'draft',pair:row,regenerate:true})).status).toBe(200)
      expect(host.model).toHaveBeenCalledTimes(5)
      const reopened=new EventDuplicateMaintenance(host.database),automatic=vi.fn()
      try{
        expect(reopened.details('review')[0]).toMatchObject({attempts:2,outcome:'failed'})
        expect(reopened.details('review')[0]!.draftAttempts).toBeUndefined()
        expect(await reopened.tick('review',{snapshot:()=>host.runtime.adminSnapshot('review'),decide:automatic,archive:async()=>false})).toBe(false)
        expect(automatic).not.toHaveBeenCalled()
      }finally{reopened.close()}
      expect((await host.runtime.adminSnapshot('review'))!.events).toEqual(before)
    }finally{await host.close()}
  })
  it('does not queue extra model calls while one manual generation is in flight',async()=>{
    const decision={action:'REVIEW' as const,confidence:.6,reason:'Manual draft',draft:{title:'Full draft',summary:'Both source-supported facts.'}}
    const host=await fixture({ai:decision})
    let release!:(value:EventDuplicateDecision)=>void,start!:()=>void
    const started=new Promise<void>(resolve=>{start=resolve})
    host.model.mockImplementationOnce(()=>new Promise<EventDuplicateDecision>(resolve=>{release=resolve;start()}))
    try{
      const row=(await host.list()).body.items[0],pending=host.request('POST',{action:'draft',pair:row,regenerate:true})
      await started
      expect((await host.request('POST',{action:'draft',pair:row,regenerate:true})).status).toBe(409)
      expect(host.model).toHaveBeenCalledTimes(1)
      release(decision);expect((await pending).status).toBe(200)
      expect((await host.request('POST',{action:'draft',pair:row,regenerate:true})).status).toBe(200)
      expect(host.model).toHaveBeenCalledTimes(2)
    }finally{release?.(decision);await host.close()}
  })
  it('keeps both only after confirmation and can durably undo that decision without changing cards',async()=>{
    const host=await fixture()
    try{
      const row=(await host.list()).body.items[0],before=(await host.runtime.adminSnapshot('review'))!.events
      expect((await host.request('POST',{action:'keep',pair:row})).status).toBe(200)
      const saved=(await host.list()).body.items[0]
      expect(saved.undoId).toMatch(/^[a-f0-9-]{36}$/)
      expect((await host.request('POST',{action:'undo',pair:saved,undoId:saved.undoId})).status).toBe(200)
      expect((await host.list()).body.items[0]).toMatchObject({manualReopened:true,userReviewed:false})
      expect((await host.runtime.adminSnapshot('review'))!.events).toEqual(before)
    }finally{await host.close()}
  })
  it('returns original pre-merge cards for comparison without exposing inverse jobs',async()=>{
    const host=await fixture()
    try{
      const row=(await host.list()).body.items[0]
      expect(row.recommendedKeepId).toBeTruthy()
      expect((await host.request('POST',{action:'merge',pair:row,keepId:row.recommendedKeepId})).status).toBe(200)
      const saved=(await host.list()).body.items[0]
      expect(saved.originalLeft.summary).toBe(row.left.summary)
      expect(saved.originalRight.summary).toBe(row.right.summary)
      expect(saved.undo).toBeUndefined()
    }finally{await host.close()}
  })

  it('generates a historical merge draft on request without committing or dispatching an automatic decision',async()=>{
    const draft={title:'当前面试安排',summary:'以当前通知为准，与李老师核对资料并携带成绩单。'}
    const host=await fixture({superseded:true,ai:{action:'KEEP_RIGHT',confidence:.99,reason:'历史材料要求仍有效',draft}})
    try{
      const row=(await host.list()).body.items[0]
      const before=(await host.runtime.adminSnapshot('review'))!.events
      const response=await host.request('POST',{action:'draft',pair:row})
      expect(response.status).toBe(200);expect(response.body.draft).toEqual(draft)
      expect(host.decide).not.toHaveBeenCalled();expect(host.model).toHaveBeenCalledOnce()
      expect(host.model.mock.calls[0]![0]).toMatchObject({purpose:'manual-merge-preview',instruction:expect.stringContaining('不把已失效事实写成当前事实')})
      expect((await host.runtime.adminSnapshot('review'))!.events).toEqual(before)
      expect((await host.request('POST',{action:'merge',pair:row,keepId:row.rightId,draft})).status).toBe(200)
      expect(host.model).toHaveBeenCalledOnce()
    }finally{await host.close()}
  })
  it('durably transfers a pending AI candidate to the focused human queue without leaving an automatic merge racing it',async()=>{
    const host=await fixture();
    try{
      await host.request('POST',{action:'rescan'});const row=(await host.list()).body.items[0];
      expect((await host.request('POST',{action:'takeover',pair:row})).status).toBe(200);
      const page=(await host.request('GET',undefined,'&queue=review&limit=20&focusLeft='+row.leftId+'&focusRight='+row.rightId)).body;
      expect(page.focusIndex).toBe(0);expect(page.items[0]).toMatchObject({outcome:'kept',manualReopened:true});
      const model=vi.fn(async()=>({action:'KEEP_LEFT' as const,confidence:1,reason:'must not run'}));
      await host.journal.tick('review',{snapshot:()=>host.runtime.adminSnapshot('review'),decide:model,archive:async()=>true});
      expect(model).not.toHaveBeenCalled();expect((await host.runtime.adminSnapshot('review'))!.events.every(card=>card.status==='active')).toBe(true);
    }finally{await host.close()}
  });
  it('preserves existing undo records while upgrading the duplicate workflow version',async()=>{
    const host=await fixture();
    try{
      const row=(await host.list()).body.items[0];const before=(await host.runtime.adminSnapshot('review'))!;
      await host.request('POST',{action:'merge',pair:row,keepId:row.leftId});
      const processed=(await host.list()).body.items[0];
      const database=new DatabaseSync(host.database);const state=JSON.parse((database.prepare('SELECT state_json FROM stratagate_dsh_event_duplicate_repair WHERE namespace=?').get('review') as any).state_json);state.version=2;
      database.prepare('UPDATE stratagate_dsh_event_duplicate_repair SET version=2,state_json=? WHERE namespace=?').run(JSON.stringify(state),'review');database.close();
      await host.journal.tick('review',{snapshot:()=>host.runtime.adminSnapshot('review'),decide:async()=>{throw Error('must not re-review merged history')},archive:async()=>false});
      const updated=(await host.list()).body.items[0];expect(updated.undoId).toBe(processed.undoId);
      expect((await host.request('POST',{action:'undo',pair:updated,undoId:updated.undoId})).status).toBe(200);
      expect((await host.runtime.adminSnapshot('review'))!.events).toEqual(before.events);
    }finally{await host.close()}
  });
  it('persists AI drafts, reuses them on repeat preview, and saves an edited complete memory with its evidence and undo',async()=>{
    const host=await fixture({ai:{action:'KEEP_LEFT',confidence:.99,reason:'Same interview with complementary sources.',draft:{title:'西电硕士面试',summary:'8月17日参加西电硕士面试，与李老师见面，并携带成绩单。'}}});
    try{
      const row=(await host.list()).body.items[0];const before=(await host.runtime.adminSnapshot('review'))!;
      for(let i=0;i<2;i++){
        const response=await host.request('POST',{action:'draft',pair:row});expect(response.status).toBe(200);
        expect(response.body.draft.summary).toContain('李老师');
      }
      expect(host.model).toHaveBeenCalledTimes(1);
      expect((await host.runtime.adminSnapshot('review'))!.events).toEqual(before.events);
      const draft={title:'西电面试资料核对',summary:'8月17日西电硕士面试：与李老师见面，携带成绩单原件。'};
      expect((await host.request('POST',{action:'merge',pair:row,keepId:row.leftId,draft})).status).toBe(200);
      const result=(await host.list()).body.items[0];expect(result.left).toMatchObject(draft);
      expect(result.left.sourceMessageIds).toHaveLength(2);expect(result.left.quotes).toEqual(['Bring transcript']);
      expect((await host.request('POST',{action:'undo',pair:result,undoId:result.undoId})).status).toBe(200);
      expect((await host.runtime.adminSnapshot('review'))!.events).toEqual(before.events);
    }finally{await host.close()}
  });
  it('separates clear AI keep-both results from ambiguous cases in the human queue',async()=>{
    const host=await fixture();
    try{
      expect((await host.request('GET',undefined,'&queue=history')).body.total).toBe(1);
      expect((await host.request('GET',undefined,'&queue=review')).body.total).toBe(0);
      const row=(await host.list()).body.items[0];
      expect((await host.request('POST',{action:'draft',pair:row})).status).toBe(409);
      expect(host.model).not.toHaveBeenCalled();
    }finally{await host.close()}
  });
  it('recovers an interrupted undo checkpoint with the model offline, including after a rescan',async()=>{
    const host=await fixture();
    try{
      const row=(await host.list()).body.items[0];const before=(await host.runtime.adminSnapshot('review'))!;
      await host.request('POST',{action:'merge',pair:row,keepId:row.leftId});
      const processed=(await host.list()).body.items[0];
      await host.request('POST',{action:'rescan'});
      expect((await host.list()).body.items[0].undoId).toBe(processed.undoId);
      const database=new DatabaseSync(host.database);
      const state=JSON.parse((database.prepare('SELECT state_json FROM stratagate_dsh_event_duplicate_repair WHERE namespace=?').get('review') as any).state_json);
      state.pairs[0].undo.pending=true;
      database.prepare('UPDATE stratagate_dsh_event_duplicate_repair SET state_json=? WHERE namespace=?').run(JSON.stringify(state),'review');database.close();
      const memory=await StrataGate.open({database:host.database,namespace:'review'});
      try{await memory.undoDuplicateReview(state.pairs[0].undo.data)}finally{await memory.close()}
      expect(await host.runtime.runEventDuplicateMaintenance()).toBe(true);
      expect((await host.list()).body.items[0]).toMatchObject({outcome:'kept',manualReopened:true});
      expect((await host.runtime.adminSnapshot('review'))!.events).toEqual(before.events);
      expect(await host.runtime.runEventDuplicateMaintenance()).toBe(false);
    }finally{await host.close()}
  });
  it.each(['merge','select'] as const)('offers durable undo for %s without exposing the stored inverse in the API',async action=>{
    const host=await fixture(action==='select'?{superseded:true}:{});
    try{
      const row=(await host.list()).body.items[0];const before=(await host.runtime.adminSnapshot('review'))!;
      const calls=host.decide.mock.calls.length;
      expect((await host.request('POST',{action,pair:row,keepId:row.leftId})).status).toBe(200);
      const processed=(await host.list()).body.items[0];expect(processed.undoId).toMatch(/^[a-f0-9-]{36}$/);
      expect(processed.undo).toBeUndefined();expect(JSON.stringify(processed)).not.toContain('topicBefore');
      expect((await host.request('POST',{action:'undo',pair:processed,undoId:'00000000-0000-0000-0000-000000000000'})).status).toBe(409);
      expect((await host.request('POST',{action:'undo',pair:processed,undoId:processed.undoId})).status).toBe(200);
      const restored=(await host.runtime.adminSnapshot('review'))!;
      expect(restored.events).toEqual(before.events);expect(restored.agentEvents).toEqual(before.agentEvents);
      expect((await host.list()).body.items[0]).toMatchObject({outcome:'kept',userReviewed:false,manualReopened:true});
      expect(host.decide).toHaveBeenCalledTimes(calls);
      expect((await host.request('POST',{action:'undo',pair:processed,undoId:processed.undoId})).status).toBe(409);
    }finally{await host.close()}
  });
  it.each(['select','merge'] as const)('recovers a committed human %s after the core commit, even with the model offline',async mode=>{
    const host=await fixture()
    try{
      const row=(await host.list()).body.items[0]
      await expect(host.journal.resolve('review',row,row.rightId,async(pair,id)=>{
        const memory=await StrataGate.open({database:host.database,namespace:'review'})
        try{if(mode==='select')await memory.selectDuplicateEvent(pair,id);else await memory.mergeDuplicateEvents(pair,id)}finally{await memory.close()}
        throw Error('simulated interruption after commit')
      },mode)).rejects.toThrow('simulated interruption')
      expect(await host.runtime.runEventDuplicateMaintenance()).toBe(true)
      const result=(await host.list()).body.items[0]
      expect(result).toMatchObject({outcome:mode==='select'?'selected':'merged',keepId:row.rightId,userReviewed:true})
      expect(host.runtime.adminDuplicateRepairStatus('review')).toMatchObject({status:'completed',needsReview:0})
      expect(host.decide).toHaveBeenCalledTimes(1)
    }finally{await host.close()}
  })
  it('does not apply or ask a model to repeat an uncommitted interrupted human choice',async()=>{
    const host=await fixture()
    try{
      const row=(await host.list()).body.items[0]
      await expect(host.journal.resolve('review',row,row.leftId,async()=>{throw Error('interrupted before commit')},'select')).rejects.toThrow('before commit')
      expect(await host.runtime.runEventDuplicateMaintenance()).toBe(true)
      expect((await host.list()).body.items[0]).toMatchObject({outcome:'kept',userReviewed:false,reason:expect.stringContaining('未完成')})
      expect((await host.runtime.adminSnapshot('review'))!.events.every(card=>card.status==='active')).toBe(true)
      expect(host.decide).toHaveBeenCalledTimes(1)
    }finally{await host.close()}
  })
  it('keeps archived agent evidence readable from the explicit source view',async()=>{
    const host=await fixture()
    try{
      const memory=await StrataGate.open({database:host.database,namespace:'review'})
      const recorded=await memory.recordAgentEvent({content:'归档来源验收：用户希望周五核对论文材料。'})
      const agent=memory.listAgentEvents().find(card=>card.id===recorded.eventId)!
      agent.status='archived';agent.supersededBy=host.cards[0]!.id
      await memory.appendTurn({user:'保存验收状态',assistant:'已保存'},{deferDerivation:true});await memory.close()
      let status=0;let text=''
      await handleAdminRequest(host.runtime,{method:'GET',url:'/api/stratagate/sources?namespace=review&eventId='+agent.id},
        {get statusCode(){return status},set statusCode(value){status=value},setHeader(){},end(value){text=value}})
      expect(status).toBe(200);expect(JSON.parse(text).messages.length).toBeGreaterThan(0)
    }finally{await host.close()}
  })
  it.each([{conflict:true},{superseded:true}])('offers an explicit choice for protected merge candidates: %o',async options=>{
    const host=await fixture(options)
    try{
      const row=(await host.list()).body.items[0]
      expect(row.canMerge).toBe(true);expect(row.historyNotice || row.mergeWarning).toBeTruthy()
      if(options.superseded){expect(row.recommendedKeepId).toBe(row.rightId);expect(row.choices.left.canMerge).toBe(false);expect(row.choices.right.canMerge).toBe(true)}
      expect(row.choices.left.canSelect).toBe(true);expect(row.choices.right.canSelect).toBe(true)
      const original=structuredClone(row.right)
      expect((await host.request('POST',{action:'select',pair:row,keepId:row.rightId})).status).toBe(200)
      const result=(await host.list()).body.items[0]
      expect(result).toMatchObject({outcome:'selected',keepId:row.rightId,userReviewed:true,left:{status:'archived'},right:{status:'active',summary:original.summary,quotes:original.quotes,temporal:original.temporal,sourceMessageIds:original.sourceMessageIds}})
      expect(host.runtime.adminDuplicateRepairStatus('review')?.needsReview).toBe(0)
      expect((await host.request('POST',{action:'select',pair:row,keepId:row.leftId})).status).toBe(409)
    }finally{await host.close()}
  })
  it('lets a human preview and merge historical evidence into the current card, then undo through the admin boundary',async()=>{
    const host=await fixture({superseded:true})
    try{
      const row=(await host.list()).body.items[0]
      expect(host.decide).not.toHaveBeenCalled() // History is never automatically folded, even with a model draft.
      expect(row).toMatchObject({historicalMerge:true,canMerge:true,recommendedKeepId:row.rightId})
      const before=(await host.runtime.adminSnapshot('review'))!
      expect((await host.request('POST',{action:'merge',pair:row,keepId:row.leftId})).status).toBe(409)
      const draft={title:'西电硕士面试安排',summary:'8月17日参加西电硕士面试，携带成绩单并与李老师核对资料。'}
      expect((await host.request('POST',{action:'merge',pair:row,keepId:row.rightId,draft})).status).toBe(200)
      const result=(await host.list()).body.items[0]
      expect(result).toMatchObject({outcome:'merged',userReviewed:true,left:{status:'archived'},right:{status:'active',...draft,quotes:['Bring transcript'],sourceMessageIds:expect.arrayContaining([...row.left.sourceMessageIds,...row.right.sourceMessageIds])}})
      expect((await host.request('POST',{action:'undo',pair:result,undoId:result.undoId})).status).toBe(200)
      const after=(await host.runtime.adminSnapshot('review'))!
      expect(after.events).toEqual(before.events)
    }finally{await host.close()}
  })
  it('shows retained reasons and both complete cards, then consolidates the chosen primary through POST',async()=>{
    const host=await fixture()
    try{
      const response=await host.list();expect(response.status).toBe(200)
      const row=response.body.items[0];expect(row).toMatchObject({outcome:'kept',canMerge:true,reason:expect.stringContaining('same interview'),
        left:{quotes:['Bring transcript']},right:{temporal:{participants:['Li']}}})
      const beforeCalls=host.decide.mock.calls.length
      expect((await host.request('POST',{action:'merge',pair:row,keepId:row.leftId})).status).toBe(200)
      const after=(await host.list()).body.items[0];expect(after.outcome).toBe('merged');expect(after.userReviewed).toBe(true)
      expect(after.left).toMatchObject({quotes:['Bring transcript'],sourceMessageIds:expect.arrayContaining([host.cards[1]!.sourceMessageIds[0]]),
        temporal:{participants:['Li']},criticality:'identity'})
      expect(host.decide).toHaveBeenCalledTimes(beforeCalls)
      const namespace=(await host.runtime.adminSnapshot('review'))!
      expect(namespace.events.filter(event=>event.status==='active')).toHaveLength(1)
    }finally{await host.close()}
  })

  it('reopens a completed KEEP_BOTH scan only after explicit rescan, without another model call in the HTTP request',async()=>{
    const host=await fixture()
    try{
      expect(host.journal.summary('review')?.status).toBe('completed')
      expect((await host.request('POST',{action:'rescan'})).status).toBe(200)
      expect(host.journal.summary('review')).toMatchObject({status:'pending',processed:0})
      expect((await host.list()).body.items[0].outcome).toBe('pending')
      expect(host.decide).toHaveBeenCalledTimes(1)
    }finally{await host.close()}
  })

  it('records an explicit keep decision durably and rejects stale merge requests without mutating cards',async()=>{
    const host=await fixture()
    try{
      const row=(await host.list()).body.items[0]
      expect((await host.request('POST',{action:'keep',pair:row})).status).toBe(200)
      expect(host.runtime.adminDuplicateRepairStatus('review')?.needsReview).toBe(0)
      expect((await host.list()).body.items[0]).toMatchObject({userReviewed:true,reason:'用户确认保留两张'})
      const memory=await StrataGate.open({database:host.database,namespace:'review'})
      await memory.forgetEvent(row.rightId);await memory.close()
      expect((await host.request('POST',{action:'merge',pair:row,keepId:row.leftId})).status).toBe(409)
      expect((await host.runtime.adminSnapshot('review'))!.events.find(event=>event.id===row.leftId)?.status).toBe('active')
    }finally{await host.close()}
  })

  it('does not reset budgets or change decisions while another worker holds the lease',async()=>{
    const host=await fixture()
    try{
      const row=(await host.list()).body.items[0];const db=new DatabaseSync(host.database)
      db.prepare('UPDATE stratagate_dsh_event_duplicate_repair SET lease_owner=?,lease_until=? WHERE namespace=?').run('other-worker',Date.now()+60000,'review');db.close()
      expect((await host.request('POST',{action:'rescan'})).status).toBe(409)
      expect((await host.request('POST',{action:'merge',pair:row,keepId:row.leftId})).status).toBe(409)
      expect((await host.runtime.adminSnapshot('review'))!.events.filter(event=>event.status==='active')).toHaveLength(2)
    }finally{await host.close()}
  })

  it('validates namespace, malformed pairs, keepers, actions and bounded pagination',async()=>{
    const host=await fixture()
    try{
      expect((await host.request('POST',{action:'merge'})).status).toBe(400)
      expect((await host.request('POST',{action:'unknown'})).status).toBe(400)
      expect((await host.request('GET',undefined,'&offset=10&limit=100')).body).toMatchObject({items:[],total:1,offset:10,limit:50})
      const row=(await host.list()).body.items[0]
      expect((await host.request('POST',{action:'merge',pair:row,keepId:'foreign'})).status).toBe(400)
    }finally{await host.close()}
  })
})

describe('duplicate review client controls',()=>{
  function client(item:any, options:any = {}) {
    const source=readFileSync(new URL('../src/client.js',import.meta.url),'utf8')
    let definition:any;const state:any[]=[];let index=0
    const React={createContext:()=>({}),useRef:()=>({current:null}),createElement:(...args:any[])=>args,Fragment:'fragment',useEffect:()=>{},useState:(initial:any)=>{
      const key=index++;if(!(key in state))state[key]=initial
      return [state[key],(next:any)=>{state[key]=typeof next==='function'?next(state[key]):next}]
    }}
    runInNewContext(source.replace("    exports.name = 'stratagate-dsh'","    exports.__test={DuplicatePair,DuplicateCard}; exports.name = 'stratagate-dsh'"),
      {window:{__ModuleLoader__:{load:(value:any)=>definition=value}},URLSearchParams})
    const plugin=definition.factory(()=>React);const resolve=options.resolve || vi.fn();const takeover=vi.fn();const prepare=options.prepare
    const render=()=>{index=0;const tree=plugin.__test.DuplicatePair({item,busy:false,openEvent(){},onResolve:resolve,onPrepareDraft:prepare,onTakeOver:takeover});const nodes:any[]=[]
      const visit=(value:any)=>{if(Array.isArray(value)){nodes.push(value);value.forEach(visit)}};visit(tree);return nodes}
    return {render,resolve,takeover}
  }
  const candidate=(canMerge:boolean)=>({leftId:'left',rightId:'right',outcome:'kept',canMerge,mergeBlockedReason:canMerge?'':'发生日期不同，不能混合',
    reason:'两条记录内容相似，日期需要核对',left:{id:'left',title:'8月17日面试',summary:'原始证据',quotes:['带成绩单'],sourceMessageIds:['m1'],temporal:{},weight:{}},
    right:{id:'right',title:'8月18日面试',summary:'补充证据',sourceMessageIds:['m2'],temporal:{participants:['李老师']},weight:{}}})
  const findButton=(nodes:any[],text:string)=>nodes.find(n=>n[0]==='button'&&JSON.stringify(n.slice(2)).includes(text))!
  it.each([['left','A'],['right','B']])('shows both complete cards before a human retains %s',async(id,letter)=>{
    const item=candidate(false),host=client(item);let nodes=host.render()
    expect(nodes.filter(n=>n[1]?.letter).every(n=>n[1].onSelect===null)).toBe(true)
    findButton(nodes,'只保留一张')[1].onClick();nodes=host.render()
    expect(findButton(nodes,'请选择 A 或 B')[1].disabled).toBe(true)
    expect(nodes.filter(n=>n[1]?.letter).every(n=>n[1].fullContent)).toBe(true)
    nodes.find(n=>n[1]?.letter===letter)[1].onSelect();nodes=host.render()
    expect(host.resolve).not.toHaveBeenCalled()
    expect(JSON.stringify(nodes)).toContain('独有内容不会合入')
    await findButton(nodes,'确认只保留 '+letter)[1].onClick()
    expect(host.resolve).toHaveBeenCalledWith('select',item,id,undefined)
  })
  it('opens a merge editor without selecting a primary, even when dates differ',()=>{
    const host=client(candidate(false));let nodes=host.render()
    expect(findButton(nodes,'合并双方内容')[1].disabled).toBeFalsy()
    findButton(nodes,'合并双方内容')[1].onClick();nodes=host.render()
    expect(nodes.some(n=>n[0]==='textarea')).toBe(true)
    expect(findButton(nodes,'确认保存合并稿')[1].disabled).toBe(true)
    findButton(nodes,'返回对比')[1].onClick();nodes=host.render()
    expect(nodes.some(n=>n[0]==='textarea')).toBe(false)
    expect(host.resolve).not.toHaveBeenCalled()
  })
  it('saves exactly the reviewed full draft and preserves edits when a save fails',async()=>{
    const item={...candidate(true),recommendedKeepId:'right'},resolve=vi.fn().mockRejectedValueOnce(Error('disk offline')).mockResolvedValueOnce({ok:true})
    const host=client(item,{resolve});let nodes=host.render()
    findButton(nodes,'合并双方内容')[1].onClick();nodes=host.render()
    nodes.find(n=>n[0]==='input'&&n[1]?.type==='text')[1].onChange({target:{value:'西电面试安排'}});nodes=host.render()
    const summary='8月17日参加面试，携带成绩单并与李老师见面。'
    nodes.find(n=>n[0]==='textarea')[1].onChange({target:{value:summary}});nodes=host.render()
    expect(findButton(nodes,'确认保存合并稿')[1].disabled).toBeFalsy()
    await findButton(nodes,'确认保存合并稿')[1].onClick();nodes=host.render()
    expect(nodes.find(n=>n[0]==='textarea')[1].value).toBe(summary)
    expect(JSON.stringify(nodes)).toContain('你的选择和编辑已保留')
    await findButton(nodes,'重试保存')[1].onClick()
    expect(resolve).toHaveBeenLastCalledWith('merge',item,'right',{title:'西电面试安排',summary})
  })
  it('requires confirmation before replacing human edits with a new AI draft',async()=>{
    const prepare=vi.fn(async()=>({draft:{title:'AI新稿',summary:'新正文'}})),host=client({...candidate(true),draft:{title:'原稿',summary:'原正文'}},{prepare});let nodes=host.render()
    findButton(nodes,'合并双方内容')[1].onClick();nodes=host.render()
    nodes.find(n=>n[0]==='textarea')[1].onChange({target:{value:'人工编辑'}});nodes=host.render()
    await findButton(nodes,'重新让 AI 整理')[1].onClick();nodes=host.render()
    expect(prepare).not.toHaveBeenCalled()
    expect(nodes.find(n=>n[0]==='textarea')[1].value).toBe('人工编辑')
    await findButton(nodes,'替换为新稿')[1].onClick();nodes=host.render()
    expect(prepare).toHaveBeenCalledWith(expect.anything(),true)
    expect(nodes.find(n=>n[0]==='textarea')[1].value).toBe('新正文')
  })
  it('previews keeping both and sends no mutation until confirmation',async()=>{
    const host=client(candidate(true));let nodes=host.render()
    findButton(nodes,'保留两张')[1].onClick();nodes=host.render()
    expect(host.resolve).not.toHaveBeenCalled()
    await findButton(nodes,'确认保留两张')[1].onClick()
    expect(host.resolve).toHaveBeenCalledWith('keep',expect.anything(),undefined,undefined)
  })
  it('keeps clear AI keep-both results out of approval and explicitly transfers a manual override',()=>{
    const item={...candidate(true),aiResolved:true},host=client(item),nodes=host.render()
    expect(nodes.filter(n=>n[1]?.letter).every(n=>n[1].onSelect===null)).toBe(true)
    findButton(nodes,'重新处理这组')[1].onClick()
    expect(host.takeover).toHaveBeenCalledWith(item)
    expect(host.resolve).not.toHaveBeenCalled()
  })
})
