import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { StrataGate, eventDuplicateFingerprint, type EventCard, type EventCardInput, type DuplicateReviewUndo } from '../src/index.js';
import { SqliteStorage } from '../src/sqlite.js';

const pair = (a: EventCard, b: EventCard) => ({ leftId:a.id, rightId:b.id, leftFingerprint:eventDuplicateFingerprint(a), rightFingerprint:eventDuplicateFingerprint(b), exact:false, similarity:.9 });
async function add(memory: StrataGate, extra: Partial<EventCardInput> = {}) {
  const block=(await memory.appendTurn({user:'原始面试记录',assistant:'已记录'},{deferDerivation:true})).sealedBlock!;
  return memory.addEvent({title:'硕士面试',summary:'参加硕士面试并核对资料。',sourceBlockId:block.id,sourceMessageIds:[block.l5Raw[0]!.id],...extra});
}

describe('explicit choice between conflicting memories',()=>{
  it('archives a historical card without replacing its third successor, and undo restores it after restart',async()=>{
    const directory=await mkdtemp(join(tmpdir(),'stratagate-history-select-')),database=join(directory,'memory.db');
    let memory=await StrataGate.open({database,namespace:'history-select',blockTurnSize:1});
    try{
      const a=await add(memory),b=await add(memory),c=await add(memory,{title:'后续事实',temporal:{supersedesEventIds:[a.id]}});
      a.status='superseded';a.supersededBy=c.id;
      await memory.appendTurn({user:'保存历史',assistant:'好'},{deferDerivation:true});
      const before=memory.exportSnapshot();let undo!:DuplicateReviewUndo;
      expect(await memory.reviewDuplicateEvents(pair(a,b),b.id,'select',value=>{undo=structuredClone(value)})).toBe(true);
      expect(a).toMatchObject({status:'archived',supersededBy:c.id});
      expect(c).toEqual(before.events.find(e=>e.id===c.id));
      await memory.close();memory=await StrataGate.open({database,namespace:'history-select'});
      expect(memory.listAllEvents().find(e=>e.id===a.id)).toMatchObject({status:'archived',supersededBy:c.id});
      expect(await memory.undoDuplicateReview(undo)).toBe(true);
      expect(memory.exportSnapshot().events).toEqual(before.events);
    }finally{await memory.close();await rm(directory,{recursive:true,force:true});}
  });
  it.each(['missing','active','scope','cycle','unlisted-source'] as const)('still rejects invalid persisted provenance (%s)',async kind=>{
    const memory=StrataGate.inMemory({blockTurnSize:1}),a=await add(memory),b=await add(memory),c=await add(memory);
    const snapshot=memory.exportSnapshot(),left=snapshot.events.find(e=>e.id===a.id)!,right=snapshot.events.find(e=>e.id===b.id)!;
    right.status='archived';left.mergedFromEventIds=[right.id];
    if(kind==='missing')left.mergedFromEventIds=['nonexistent'];
    if(kind==='active')right.status='active';
    if(kind==='scope')right.scope='project';
    if(kind==='cycle'){left.status='archived';right.mergedFromEventIds=[left.id];}
    if(kind==='unlisted-source')left.sourceMessageIds.push(...c.sourceMessageIds);
    const storage={readonly:true,load:async()=>({snapshot,revision:0}),save:vi.fn(async()=>1),close:async()=>{}};
    await expect(StrataGate.openWithStorage({namespace:'invalid',storage})).rejects.toThrow(kind==='cycle'?'Cyclic merged source':kind==='unlisted-source'?'outside source block':'Invalid merged source');
    expect(storage.save).not.toHaveBeenCalled();
  });
  it('only permits an explicit human draft to supplement a current card without collapsing its history',async()=>{
    const directory=await mkdtemp(join(tmpdir(),'stratagate-history-merge-'));const database=join(directory,'memory.db');
    let memory=await StrataGate.open({database,namespace:'history',blockTurnSize:1});
    try{
      const old=await add(memory,{summary:'原面试安排，携带成绩单。',quotes:['携带成绩单'],tags:['原通知'],temporal:{happenedStart:'2026-08-17',participants:['李老师']}});
      const current=await add(memory,{summary:'面试改至8月18日，保留申请材料要求。',temporal:{happenedStart:'2026-08-18',supersedesEventIds:[old.id]}});
      const later=await add(memory,{title:'后续核验',temporal:{afterEventIds:[old.id],relatedEventIds:[old.id,current.id]}});
      old.status='superseded';old.supersededBy=current.id;old.weight.lastAdoptedTurn=10;current.weight.lastAdoptedTurn=20;
      await memory.appendTurn({user:'持久化原历史',assistant:'已记录'},{deferDerivation:true});
      const before=memory.exportSnapshot();const reviewed=pair(old,current);
      const draft={title:'最新面试安排',summary:'面试已改至8月18日，与李老师核对申请资料，需携带成绩单；8月17日为旧安排。'};let undo!:DuplicateReviewUndo;
      expect(await memory.reviewDuplicateEvents(reviewed,current.id,'merge',()=>{},draft)).toBe(false);
      expect(await memory.reviewDuplicateEvents(reviewed,current.id,'merge',()=>{},undefined,'manual')).toBe(false);
      expect(await memory.reviewDuplicateEvents(reviewed,old.id,'merge',()=>{},draft,'manual')).toBe(false);
      expect(memory.exportSnapshot()).toEqual(before);
      expect(await memory.reviewDuplicateEvents(reviewed,current.id,'merge',value=>{undo=structuredClone(value)},draft,'manual')).toBe(true);
      expect(current).toMatchObject({...draft,status:'active',quotes:['携带成绩单'],tags:['原通知'],mergedFromEventIds:[old.id],sourceMessageIds:expect.arrayContaining([...old.sourceMessageIds,...before.events.find(e=>e.id===current.id)!.sourceMessageIds]),weight:{lastAdoptedTurn:20},temporal:{happenedStart:'2026-08-18',participants:['李老师'],supersedesEventIds:[old.id]}});
      expect(old).toMatchObject({status:'archived',summary:'原面试安排，携带成绩单。',temporal:before.events.find(e=>e.id===old.id)!.temporal});
      expect(later.temporal).toEqual(before.events.find(e=>e.id===later.id)!.temporal);
      await memory.close();memory=await StrataGate.open({database,namespace:'history'});
      expect(memory.listAllEvents().find(e=>e.id===current.id)!.summary).toBe(draft.summary);
      expect(await memory.undoDuplicateReview(undo)).toBe(true);
      expect(memory.exportSnapshot().events).toEqual(before.events);
      expect(memory.listBlocks()).toEqual(before.blocks);
      expect(memory.listUsageReceipts()).toEqual(before.usageReceipts);
    }finally{await memory.close();await rm(directory,{recursive:true,force:true});}
  });
  it('supplements the selected current card while preserving a historical source pointing to a third successor, including restart and undo',async()=>{
    const directory=await mkdtemp(join(tmpdir(),'stratagate-third-successor-'));const database=join(directory,'memory.db');
    let memory=await StrataGate.open({database,namespace:'history',blockTurnSize:1});
    try{
      const a=await add(memory,{quotes:['原始证据'],temporal:{participants:['李老师']}});
      const b=await add(memory,{summary:'当前有效卡',temporal:{supersedesEventIds:[a.id]}});
      const c=await add(memory,{title:'另一条后续记录',temporal:{supersedesEventIds:[a.id],relatedEventIds:[b.id]}});
      a.status='superseded';a.supersededBy=c.id;
      await memory.appendTurn({user:'持久化版本关系',assistant:'已记录'},{deferDerivation:true});
      const before=memory.exportSnapshot(),reviewed=pair(a,b),draft={title:'核对后的安排',summary:'保留当前事实，并补入原始材料要求。'};let undo!:DuplicateReviewUndo;
      expect(await memory.reviewDuplicateEvents(reviewed,b.id,'merge',()=>{},draft)).toBe(false);
      expect(await memory.reviewDuplicateEvents(reviewed,b.id,'merge',value=>{undo=structuredClone(value)},draft,'manual')).toBe(true);
      expect(a).toMatchObject({status:'archived',supersededBy:c.id,summary:before.events.find(e=>e.id===a.id)!.summary});
      expect(b).toMatchObject({...draft,status:'active',mergedFromEventIds:[a.id],quotes:['原始证据'],sourceMessageIds:expect.arrayContaining([...a.sourceMessageIds,...before.events.find(e=>e.id===b.id)!.sourceMessageIds])});
      expect(c).toEqual(before.events.find(e=>e.id===c.id));
      const committed=memory.exportSnapshot();
      expect(await memory.mergeDuplicateEvents(reviewed,b.id)).toBe(true);
      expect(memory.exportSnapshot()).toEqual(committed);
      await memory.close();memory=await StrataGate.open({database,namespace:'history'});
      expect(memory.listAllEvents().find(e=>e.id===a.id)!.supersededBy).toBe(c.id);
      expect(memory.listAllEvents().find(e=>e.id===b.id)!.summary).toBe(draft.summary);
      expect(await memory.undoDuplicateReview(undo)).toBe(true);
      expect(memory.exportSnapshot().events).toEqual(before.events);
      expect(memory.listBlocks()).toEqual(before.blocks);
    }finally{await memory.close();await rm(directory,{recursive:true,force:true});}
  });
  it('rejects a pinned historical source without partial edits',async()=>{
    const memory=StrataGate.inMemory({blockTurnSize:1});const a=await add(memory);const b=await add(memory);const c=await add(memory);
    a.status='superseded';a.supersededBy=c.id;
    const draft={title:'核对后的安排',summary:'仅保留核对后的有效事实。'};
    a.weight.pinned=true;const before=memory.exportSnapshot();
    expect(await memory.reviewDuplicateEvents(pair(a,b),b.id,'merge',()=>{},draft,'manual')).toBe(false);
    expect(memory.exportSnapshot()).toEqual(before);
  });
  it.each(['afterEventIds','conflictsWithEventIds'] as const)('only a confirmed human draft may handle active cards with %s, leaving original relationships intact',async relation=>{
    const memory=StrataGate.inMemory({blockTurnSize:1});const a=await add(memory);const b=await add(memory,{temporal:{[relation]:[a.id]}});
    const later=await add(memory,{title:'后续核验',temporal:{relatedEventIds:[a.id,b.id]}});
    const reviewed=pair(a,b),before=memory.exportSnapshot(),draft={title:'人工核对结果',summary:'区分原安排与当前有效事实，保留来源中的不确定性。'};let undo!:DuplicateReviewUndo;
    expect(await memory.reviewDuplicateEvents(reviewed,b.id,'merge',()=>{},draft)).toBe(false);
    expect(memory.exportSnapshot()).toEqual(before);
    expect(await memory.reviewDuplicateEvents(reviewed,b.id,'merge',value=>{undo=value},draft,'manual')).toBe(true);
    expect(b.temporal).toEqual(before.events.find(e=>e.id===b.id)!.temporal);
    expect(later).toEqual(before.events.find(e=>e.id===later.id));
    expect(a.temporal).toEqual(before.events.find(e=>e.id===a.id)!.temporal);
    expect(await memory.undoDuplicateReview(undo)).toBe(true);
    expect(memory.exportSnapshot().events).toEqual(before.events);
  });
  it('saves the complete reviewed draft instead of concatenating and lets a reviewer interpret precision differences',async()=>{
    const memory=StrataGate.inMemory({blockTurnSize:1});
    const a=await add(memory,{summary:'8月17日参加面试。',quotes:['携带成绩单'],temporal:{happenedStart:'2026-08-17',precision:'day'}});
    const b=await add(memory,{summary:'上午十点与李老师面试。',quotes:['十点见'],criticality:'identity',temporal:{happenedStart:'2026-08-17T10:00:00+08:00',participants:['李老师']}});
    const draft={title:'西电硕士面试安排',summary:'8月17日上午十点，与李老师进行硕士面试，需携带成绩单。'};let undo!:DuplicateReviewUndo;
    expect(await memory.reviewDuplicateEvents(pair(a,b),a.id,'merge',value=>{undo=value},draft)).toBe(true);
    expect(memory.listEvents().find(card=>card.id===a.id)).toMatchObject({...draft,quotes:['携带成绩单','十点见'],sourceMessageIds:expect.arrayContaining([...a.sourceMessageIds,...b.sourceMessageIds]),temporal:{participants:['李老师'],happenedStart:'2026-08-17'}});
    expect(await memory.undoDuplicateReview(undo)).toBe(true);
    expect(memory.listEvents().find(card=>card.id===a.id)!.summary).toBe('8月17日参加面试。');
  });
  it.each(['merge','select'] as const)('undoes %s across restart, restoring evidence, weights, references and the original superseded state',async mode=>{
    const directory=await mkdtemp(join(tmpdir(),'stratagate-review-undo-'));const database=join(directory,'memory.db');
    let memory=await StrataGate.open({database,namespace:'undo',blockTurnSize:1});
    try{
      const a=await add(memory,{quotes:['带成绩单'],temporal:{participants:['李老师']}});
      const b=await add(memory,{tags:['研究生'],quotes:['带作品集']});
      await add(memory,{title:'后续通知',temporal:{relatedEventIds:[b.id]}});
      await memory.recordMemoryUse([b.id],{receiptId:'before-merge'});
      if(mode==='select'){a.status='superseded';a.supersededBy=b.id;}
      // Commit the original state, including the historical status, before creating an inverse.
      await memory.appendTurn({user:'独立验证',assistant:'好'},{deferDerivation:true});
      const before=memory.exportSnapshot();let undo!:DuplicateReviewUndo;
      expect(await memory.reviewDuplicateEvents(pair(a,b),a.id,mode,value=>{undo=structuredClone(value)})).toBe(true);
      await memory.close();memory=await StrataGate.open({database,namespace:'undo'});
      const unrelated=await add(memory,{title:'之后新增的独立记忆',summary:'保留这条新写入的数据'});
      expect(await memory.undoDuplicateReview(undo)).toBe(true);
      const after=memory.exportSnapshot();
      expect(after.events.filter(card=>card.id!==unrelated.id)).toEqual(before.events);
      expect(after.events.find(card=>card.id===unrelated.id)).toEqual(unrelated);
      expect(after.usageReceipts).toEqual(before.usageReceipts);
      expect(after.blocks.slice(0,before.blocks.length)).toEqual(before.blocks);
      expect(after.elementProjectionJobs.filter(job=>!job.sourceEventIds.includes(unrelated.id))).toEqual(before.elementProjectionJobs);
      expect(after.graphProjectionJobs.filter(job=>!job.sourceEventIds.includes(unrelated.id))).toEqual(before.graphProjectionJobs);
      // Repeating after a lost journal checkpoint is idempotent, without an additional adoption.
      expect(await memory.undoDuplicateReview(undo)).toBe(true);
    }finally{await memory.close();await rm(directory,{recursive:true,force:true});}
  });
  it('rejects undo after a real adoption without overwriting the newer weight or partially restoring cards',async()=>{
    const memory=StrataGate.inMemory({blockTurnSize:1});const a=await add(memory);const b=await add(memory);let undo!:DuplicateReviewUndo;
    await memory.reviewDuplicateEvents(pair(a,b),a.id,'merge',value=>{undo=value});
    await memory.recordMemoryUse([a.id],{receiptId:'after-merge'});const before=memory.exportSnapshot();
    await expect(memory.undoDuplicateReview(undo)).rejects.toThrow('无法安全撤销');
    expect(memory.exportSnapshot()).toEqual(before);
  });
  it('does not cancel a projection that has started using the processed cards',async()=>{
    const memory=StrataGate.inMemory({blockTurnSize:1});const a=await add(memory);const b=await add(memory);let undo!:DuplicateReviewUndo;
    await memory.reviewDuplicateEvents(pair(a,b),a.id,'merge',value=>{undo=value});
    expect(await memory.claimNextElementProjection()).not.toBeNull();const before=memory.exportSnapshot();
    await expect(memory.undoDuplicateReview(undo)).rejects.toThrow('后台投影已更新');
    expect(memory.exportSnapshot()).toEqual(before);
  });
  it('rolls back the entire undo if its SQLite save fails',async()=>{
    const directory=await mkdtemp(join(tmpdir(),'stratagate-undo-save-fail-'));const memory=await StrataGate.open({database:join(directory,'memory.db'),namespace:'undo',blockTurnSize:1});
    try{
      const a=await add(memory);const b=await add(memory);let undo!:DuplicateReviewUndo;
      await memory.reviewDuplicateEvents(pair(a,b),a.id,'merge',value=>{undo=value});const before=memory.exportSnapshot();
      const fail=vi.spyOn(SqliteStorage.prototype,'save').mockRejectedValueOnce(Error('disk unavailable'));
      try{await expect(memory.undoDuplicateReview(undo)).rejects.toThrow('disk unavailable');}finally{fail.mockRestore();}
      expect(memory.exportSnapshot()).toEqual(before);
      expect(await memory.undoDuplicateReview(undo)).toBe(true);
    }finally{await memory.close();await rm(directory,{recursive:true,force:true});}
  });
  it('does not commit an archive when its durable inverse cannot be saved',async()=>{
    const directory=await mkdtemp(join(tmpdir(),'stratagate-review-undo-fail-'));const memory=await StrataGate.open({database:join(directory,'memory.db'),namespace:'undo',blockTurnSize:1});
    try{
      const a=await add(memory);const b=await add(memory);const before=memory.exportSnapshot();
      await expect(memory.reviewDuplicateEvents(pair(a,b),a.id,'merge',()=>{throw Error('journal unavailable')})).rejects.toThrow('journal unavailable');
      expect(memory.exportSnapshot()).toEqual(before);
    }finally{await memory.close();await rm(directory,{recursive:true,force:true});}
  });
  it.each(['left','right'] as const)('retains the chosen %s fact and archives the other across restart without mixing dates or evidence',async side=>{
    const directory=await mkdtemp(join(tmpdir(),'stratagate-choice-'));const database=join(directory,'memory.db');
    let memory=await StrataGate.open({database,namespace:'choice',blockTurnSize:1});
    try{
      const a=await add(memory,{quotes:['带成绩单'],temporal:{happenedStart:'2026-08-17'}});
      const b=await add(memory,{quotes:['无需带成绩单'],temporal:{happenedStart:'2026-08-18',participants:['李老师']}});
      const later=await add(memory,{title:'资料核验',temporal:{afterEventIds:[b.id],relatedEventIds:[b.id]}});
      await memory.recordMemoryUse([b.id],{receiptId:'actual-use'});
      a.status='superseded';a.supersededBy=b.id;
      const selected=side==='left'?a:b;const other=side==='left'?b:a;
      const before=structuredClone(selected);const raw=structuredClone(memory.listBlocks());const receipts=structuredClone(memory.listUsageReceipts());const relationships=structuredClone(later.temporal);
      const jobs=memory.exportSnapshot();
      const reviewed=pair(a,b);expect(await memory.selectDuplicateEvent(reviewed,selected.id)).toBe(true);
      expect(memory.exportSnapshot().elementProjectionJobs).toEqual(jobs.elementProjectionJobs);
      expect(memory.exportSnapshot().graphProjectionJobs).toEqual(jobs.graphProjectionJobs);
      expect(await memory.selectDuplicateEvent(reviewed,selected.id)).toBe(true);
      await memory.close();memory=await StrataGate.open({database,namespace:'choice'});
      const kept=memory.listAllEvents().find(e=>e.id===selected.id)!;const archived=memory.listAllEvents().find(e=>e.id===other.id)!;
      expect(kept).toMatchObject({status:'active',supersededBy:null,summary:before.summary,quotes:before.quotes,temporal:before.temporal,sourceMessageIds:before.sourceMessageIds,weight:before.weight});
      expect(archived).toMatchObject({status:'archived',supersededBy:selected.id,quotes:other.quotes,sourceMessageIds:other.sourceMessageIds});
      expect(memory.listAllEvents().find(e=>e.id===later.id)!.temporal).toEqual(relationships);
      expect(memory.listBlocks()).toEqual(raw);expect(memory.listUsageReceipts()).toEqual(receipts);
      expect((await memory.searchEvents('硕士面试',{trackRetrieval:false})).map(r=>r.event.id)).toContain(selected.id);
      expect((await memory.searchEvents('硕士面试',{trackRetrieval:false})).map(r=>r.event.id)).not.toContain(other.id);
    }finally{await memory.close();await rm(directory,{recursive:true,force:true});}
  });
  it('rejects stale cards and pinned archives without partial changes',async()=>{
    const memory=StrataGate.inMemory({blockTurnSize:1});const a=await add(memory);const b=await add(memory);
    const reviewed=pair(a,b);b.summary='有更新的面试进展';const changed=memory.exportSnapshot();
    expect(await memory.selectDuplicateEvent(reviewed,a.id)).toBe(false);expect(memory.exportSnapshot()).toEqual(changed);
    b.weight.pinned=true;const pinned=memory.exportSnapshot();expect(await memory.selectDuplicateEvent(pair(a,b),a.id)).toBe(false);expect(memory.exportSnapshot()).toEqual(pinned);
  });
  it('does not relabel an already consolidated card as an unmixed manual choice',async()=>{
    const memory=StrataGate.inMemory({blockTurnSize:1});const a=await add(memory);const b=await add(memory,{quotes:['额外证据']});
    expect(await memory.mergeDuplicateEvents(pair(a,b),a.id)).toBe(true);
    const before=memory.exportSnapshot();expect(await memory.selectDuplicateEvent(pair(a,b),a.id)).toBe(false);expect(memory.exportSnapshot()).toEqual(before);
  });
  it('rolls back choice and projection state when persistence fails',async()=>{
    const directory=await mkdtemp(join(tmpdir(),'stratagate-choice-rollback-'));const memory=await StrataGate.open({database:join(directory,'memory.db'),namespace:'one',blockTurnSize:1});
    try{
      const a=await add(memory);const b=await add(memory);const before=memory.exportSnapshot();
      const fail=vi.spyOn(SqliteStorage.prototype,'save').mockRejectedValueOnce(Error('disk unavailable'));
      try{await expect(memory.selectDuplicateEvent(pair(a,b),a.id)).rejects.toThrow('disk unavailable');}finally{fail.mockRestore();}
      expect(memory.exportSnapshot()).toEqual(before);
    }finally{await memory.close();await rm(directory,{recursive:true,force:true});}
  });
});
