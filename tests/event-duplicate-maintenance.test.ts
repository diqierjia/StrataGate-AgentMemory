import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import { StrataGate, type EventCardInput, type EventDuplicateDecision, type EventDuplicatePair, type EventMergeDraft, type DuplicateReviewUndo } from '@diqier/stratagate'
import { EventDuplicateMaintenance } from '../src/event-duplicate-maintenance.js'
import { StrataGateRuntime } from '../src/runtime.js'
import type { DshModelBridge } from '../src/llm.js'

const fact = { title: 'Project storage preference', summary: 'The project uses SQLite for local durable storage.', scope: 'project' as const, criticality: 'preference' as const }
async function fixture(changes: Partial<EventCardInput> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'stratagate-duplicate-repair-'))
  const database = join(directory, 'journal.db')
  const memory = StrataGate.inMemory({ blockTurnSize: 1 })
  const add = async (input: Partial<EventCardInput> = {}) => {
    const block = (await memory.appendTurn({ user: 'The project uses SQLite for local durable storage.', assistant: 'Saved.' }, { deferDerivation: true })).sealedBlock!
    return memory.addEvent({ ...fact, sourceBlockId: block.id, sourceMessageIds: [block.l5Raw[0]!.id], ...input })
  }
  const left = await add(); const right = await add(changes)
  const journal = new EventDuplicateMaintenance(database)
  const decide = vi.fn(async (): Promise<EventDuplicateDecision> => ({ action: 'KEEP_LEFT', confidence: .99, reason: 'Same durable fact and same source-supported meaning.', draft:{title:fact.title,summary:fact.summary} }))
  const operations = { snapshot: async () => memory.exportSnapshot(), decide,
    archive: vi.fn((pair: EventDuplicatePair, keepId: string, draft?: EventMergeDraft, prepareUndo?: (undo: DuplicateReviewUndo)=>void) => memory.reviewDuplicateEvents(pair, keepId, 'merge', prepareUndo ?? (()=>{}), draft)) }
  return { directory, database, memory, left, right, add, journal, decide, operations,
    close: async () => { journal.close(); await memory.close(); await rm(directory, { recursive: true, force: true }) } }
}

describe('durable one-time Event duplicate repair', () => {
  it('recognizes a committed human merge whose archived original retains a third successor without another model call',async()=>{
    const host=await fixture()
    try{
      const third=await host.add({title:'Independent later verification',summary:'A separate later fact.',temporal:{supersedesEventIds:[host.left.id]}})
      host.left.status='superseded';host.left.supersededBy=third.id;host.right.temporal.supersedesEventIds=[host.left.id]
      await host.journal.rescan('one',host.memory.exportSnapshot())
      const pair=host.journal.details('one').find(pair=>pair.leftId===host.left.id&&pair.rightId===host.right.id)!
      const original=structuredClone(third),draft={title:'Reviewed storage preference',summary:'The project uses SQLite, including the distinct original evidence.'}
      expect(await host.memory.reviewDuplicateEvents(pair,host.right.id,'merge',()=>{},draft,'manual')).toBe(true)
      const committed=host.memory.exportSnapshot(),reopened=new EventDuplicateMaintenance(host.database)
      try{
        expect(await reopened.tick('one',host.operations)).toBe(true)
        expect(reopened.details('one').find(p=>p.leftId===pair.leftId&&p.rightId===pair.rightId)).toMatchObject({outcome:'merged',keepId:host.right.id})
      }finally{reopened.close()}
      expect(host.decide).not.toHaveBeenCalled();expect(host.operations.archive).not.toHaveBeenCalled()
      expect(host.memory.exportSnapshot()).toEqual(committed);expect(third).toEqual(original)
      expect(host.left.supersededBy).toBe(third.id)
    }finally{await host.close()}
  })
  it('keeps the small evidence budget for automatic review without making a model call',async()=>{
    const host=await fixture()
    try{
      host.memory.listBlocks()[0]!.l5Raw[0]!.content='Long automatic source '.repeat(2000)
      await host.journal.tick('one',host.operations)
      expect(host.decide).not.toHaveBeenCalled();expect(host.operations.archive).not.toHaveBeenCalled()
      expect(host.journal.summary('one')).toMatchObject({retained:1,needsReview:1})
      expect(host.memory.listEvents().every(card=>card.status==='active')).toBe(true)
    }finally{await host.close()}
  })
  it.each(['KEEP_BOTH','REVIEW'] as const)('distinguishes a clear AI decision from human fallback (%s)',async action=>{
    const host=await fixture();
    try{
      host.decide.mockResolvedValue({action,confidence:.99,reason:action==='KEEP_BOTH'?'Different stages of the same project.':'Cannot tell whether these refer to one occurrence.'});
      await host.journal.tick('one',host.operations);
      expect(host.journal.summary('one')).toMatchObject({retained:1,needsReview:action==='KEEP_BOTH'?0:1,aiHandled:action==='KEEP_BOTH'?1:0});
      expect(host.operations.archive).not.toHaveBeenCalled();
    }finally{await host.close()}
  });
  it('sends an incomplete AI merge result to human review without falling back to concatenation',async()=>{
    const host=await fixture();
    try{
      host.decide.mockResolvedValue({action:'KEEP_LEFT',confidence:1,reason:'Same fact but no draft'});
      await host.journal.tick('one',host.operations);
      expect(host.journal.summary('one')).toMatchObject({merged:0,needsReview:1});
      expect(host.operations.archive).not.toHaveBeenCalled();expect(host.memory.listEvents().every(card=>card.status==='active')).toBe(true);
    }finally{await host.close()}
  });
  it('discovers newly stored candidates after a completed scan without re-reviewing previous AI keep-both decisions',async()=>{
    const directory=await mkdtemp(join(tmpdir(),'stratagate-incremental-review-'));const database=join(directory,'memory.db');
    const memory=await StrataGate.open({database,namespace:'incremental',blockTurnSize:1});const journal=new EventDuplicateMaintenance(database);
    const add=async()=>{const block=(await memory.appendTurn({user:fact.summary,assistant:'Saved'},{deferDerivation:true})).sealedBlock!;await memory.addEvent({...fact,sourceBlockId:block.id,sourceMessageIds:[block.l5Raw[0]!.id]})};
    const decide=vi.fn(async()=>({action:'KEEP_BOTH' as const,confidence:.99,reason:'Separate records retained'}));
    const ops={snapshot:async()=>memory.exportSnapshot(),decide,archive:vi.fn(async()=>false)};
    try{
      await add();await add();await journal.tick('incremental',ops);expect(decide).toHaveBeenCalledTimes(1);
      await add();while(await journal.tick('incremental',ops)){}
      expect(decide).toHaveBeenCalledTimes(3);expect(journal.summary('incremental')).toMatchObject({candidates:3,needsReview:0,aiHandled:3});
      expect(await journal.tick('incremental',ops)).toBe(false);
    }finally{journal.close();await memory.close();await rm(directory,{recursive:true,force:true})}
  });
  it('discovers every stored namespace through the runtime without requiring a new conversation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-duplicate-runtime-'))
    const database = join(directory, 'memory.db')
    const ready = vi.fn(() => false)
    const models = { isReady: ready, onAdaptersUpdated: () => () => {},
      runDetached: async <T>(_id: string, operation: () => Promise<T>) => operation(),
      eventDuplicateDecider: vi.fn(async () => ({ action: 'KEEP_LEFT', confidence: 1, reason: 'Same fact', draft:{title:fact.title,summary:fact.summary} })),
    } as unknown as DshModelBridge
    const runtime = new StrataGateRuntime({ database, namespaceMode: 'project', namespacePrefix: 'dsh', globalNamespace: 'global',
      blockTurnSize: 1, blockDecayLambda: .3, ingestSubagents: false, maxOutputTokens: 2048 }, models)
    try {
      for (const namespace of ['historical-one', 'historical-two']) {
        const seed = await StrataGate.open({ database, namespace, blockTurnSize: 1 })
        const block = (await seed.appendTurn({ user: fact.summary, assistant: 'Saved' }, { deferDerivation: true })).sealedBlock!
        for (let i = 0; i < 2; i++) await seed.addEvent({ ...fact, sourceBlockId: block.id, sourceMessageIds: [block.l5Raw[0]!.id] })
        await seed.close()
      }
      ready.mockReturnValue(true)
      for (let i = 0; i < 3; i++) await runtime.runEventDuplicateMaintenance()
      for (const namespace of ['historical-one', 'historical-two']) {
        expect(runtime.adminDuplicateRepairStatus(namespace)).toMatchObject({ status: 'completed', merged: 1, scannedEvents: 2 })
        expect((await runtime.adminSnapshot(namespace))!.events.filter(({ status }) => status === 'active')).toHaveLength(1)
      }
      expect(models.eventDuplicateDecider).toHaveBeenCalledTimes(2)
    } finally { await runtime.close(); await rm(directory, { recursive: true, force: true }) }
  })

  it('requires AI review even for matching text and completes once per namespace across restarts', async () => {
    const host = await fixture()
    try {
      expect(await host.journal.tick('one', host.operations)).toBe(true)
      expect(host.decide).toHaveBeenCalledTimes(1)
      expect(host.journal.summary('one')).toMatchObject({ status: 'completed', scannedEvents: 2, candidates: 1, merged: 1 })
      const second = new EventDuplicateMaintenance(host.database)
      try {
        await host.add()
        expect(await second.tick('one', host.operations)).toBe(false)
        expect(host.operations.archive).toHaveBeenCalledTimes(1)
        expect(await second.tick('another-namespace', host.operations)).toBe(true)
      } finally { second.close() }
    } finally { await host.close() }
  })

  it.each(['KEEP_LEFT', 'KEEP_RIGHT', 'KEEP_BOTH', 'low-confidence'] as const)('applies only a confident bounded model judgment (%s)', async (mode) => {
    const host = await fixture({ summary: 'The project uses SQLite for durable local storage.' })
    try {
      host.decide.mockResolvedValue({ action: mode === 'low-confidence' ? 'KEEP_LEFT' : mode,
        confidence: mode === 'low-confidence' ? .7 : .99, reason: 'Reviewed both complete cards and their sources.', draft:{title:fact.title,summary:fact.summary} })
      await host.journal.tick('one', host.operations)
      expect(host.decide).toHaveBeenCalledTimes(1)
      expect(host.decide.mock.calls[0]!.length).toBe(1)
      expect(host.memory.listEvents().filter(({ status }) => status === 'active'))
        .toHaveLength(mode === 'KEEP_LEFT' || mode === 'KEEP_RIGHT' ? 1 : 2)
      expect(host.journal.summary('one')).toMatchObject({ status: 'completed', processed: 1, failed: 0 })
    } finally { await host.close() }
  })

  it('preserves chronology regardless of lexical overlap or model confidence', async () => {
    const host = await fixture({ temporal: { happenedStart: '2026-10-19', eventType: 'change' } })
    try {
      // A concrete prior occurrence differs from the candidate's concrete date.
      host.left.temporal = { happenedStart: '2026-10-18', eventType: 'change' }
      host.decide.mockResolvedValue({action:'KEEP_BOTH',confidence:.99,reason:'Two different occurrences on successive days.'})
      await host.journal.tick('one', host.operations)
      expect(host.decide).toHaveBeenCalledTimes(1)
      expect(host.operations.archive).not.toHaveBeenCalled()
      expect(host.journal.summary('one')).toMatchObject({ merged: 0, retained: 1 })
    } finally { await host.close() }
  })

  it('leases a pair across two processes/instances and rechecks changed cards at core commit', async () => {
    const host = await fixture({ summary: 'The project uses SQLite for durable local storage.' })
    const other = new EventDuplicateMaintenance(host.database)
    try {
      let finish!: (decision: EventDuplicateDecision) => void
      let started!: () => void
      const ready = new Promise<void>((resolve) => { started = resolve })
      host.decide.mockImplementation(async () => { started(); return new Promise((resolve) => { finish = resolve }) })
      const first = host.journal.tick('one', host.operations)
      await ready
      expect(await other.tick('one', host.operations)).toBe(false)
      await host.memory.forgetEvent(host.right.id)
      finish({ action: 'KEEP_LEFT', confidence: 1, reason: 'stale model result' })
      await first
      expect(host.memory.listEvents().find(({ id }) => id === host.right.id)!.status).toBe('forgotten')
      expect(host.journal.summary('one')).toMatchObject({ merged: 0, retained: 1 })
      expect(host.decide).toHaveBeenCalledTimes(1)
    } finally { other.close(); await host.close() }
  })

  it('checkpoints failures with bounded attempts rather than rerunning indefinitely', async () => {
    const host = await fixture({ summary: 'The project uses SQLite for durable local storage.' })
    try {
      host.decide.mockRejectedValue(new Error('offline'))
      await host.journal.tick('one', host.operations)
      expect(host.journal.summary('one')).toMatchObject({ status: 'pending', processed: 0 })
      expect(await host.journal.tick('one', host.operations)).toBe(false)
      const db = new DatabaseSync(host.database)
      try {
        const row = db.prepare('SELECT state_json FROM stratagate_dsh_event_duplicate_repair WHERE namespace = ?').get('one') as { state_json: string }
        const state = JSON.parse(row.state_json); state.pairs[0].nextAt = 0
        db.prepare('UPDATE stratagate_dsh_event_duplicate_repair SET state_json = ? WHERE namespace = ?').run(JSON.stringify(state), 'one')
      } finally { db.close() }
      await host.journal.tick('one', host.operations)
      expect(host.decide).toHaveBeenCalledTimes(2)
      expect(host.journal.summary('one')).toMatchObject({ status: 'completed', failed: 1, merged: 0 })
      expect(await host.journal.tick('one', host.operations)).toBe(false)
      expect(host.memory.listEvents().every(({ status }) => status === 'active')).toBe(true)
    } finally { await host.close() }
  })

  it('recovers a crash between the core archive commit and the journal checkpoint idempotently', async () => {
    const host = await fixture()
    try {
      const original = host.operations.archive.getMockImplementation()!
      host.operations.archive.mockImplementationOnce(async (pair, keepId, draft, prepareUndo) => {
        await original(pair, keepId, draft, prepareUndo)
        throw new Error('simulated process failure after archive')
      })
      await expect(host.journal.tick('one', host.operations)).rejects.toThrow('simulated process failure')
      await host.journal.tick('one', host.operations)
      expect(host.journal.summary('one')).toMatchObject({ status: 'completed', merged: 1 })
      expect(host.operations.archive).toHaveBeenCalledTimes(1)
      expect(host.memory.listEvents().filter(({ status }) => status === 'archived')).toHaveLength(1)
    } finally { await host.close() }
  })
})
