import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { StrataGate, scanEventDuplicates, eventDuplicateFingerprint, eventDuplicateMergeCompatible, type EventCardInput } from '../src/index.js';
import { SqliteStorage } from '../src/sqlite.js';

const fact = { title: '8/17 interview', summary: 'Interview for the Xidian master program on August 17.', scope: 'user' as const };
async function seed(memory: StrataGate, extra: Partial<EventCardInput> = {}) {
  const block = (await memory.appendTurn({ user: 'Interview source', assistant: 'Recorded' }, { deferDerivation: true })).sealedBlock!;
  return memory.addEvent({ ...fact, sourceBlockId: block.id, sourceMessageIds: [block.l5Raw[0]!.id], ...extra });
}
const pairFor = (a: any, b: any) => ({ leftId: a.id, rightId: b.id, leftFingerprint: eventDuplicateFingerprint(a),
  rightFingerprint: eventDuplicateFingerprint(b), exact: false, similarity: .9 });

describe('lossless duplicate consolidation', () => {
  it('preserves complementary information, both provenance blocks, classification, safe references and adoption through reopen', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-consolidation-')); const database = join(directory, 'memory.db');
    let memory = await StrataGate.open({ database, namespace: 'one', blockTurnSize: 1 });
    try {
      const a = await seed(memory, { quotes: ['Bring the original transcript.'], tags: ['interview'], criticality: 'routine' });
      const b = await seed(memory, { summary: fact.summary + ' The interviewer is Li.', tags: ['master'], criticality: 'identity', temporal: { participants: ['Li'], happenedStart: '2026-08-17', status: 'occurred', eventType: 'meeting' } });
      const later = await seed(memory, { title: 'Later step', temporal: { sameEventId: b.id, relatedEventIds: [b.id], afterEventIds: [b.id] } });
      await memory.recordMemoryUse([b.id], { receiptId: 'real-use' });
      const receipts = structuredClone(memory.listUsageReceipts()); const raw = structuredClone(memory.listBlocks());
      const pair = pairFor(a, b);
      expect(await memory.mergeDuplicateEvents(pair, a.id)).toBe(true);
      expect(await memory.mergeDuplicateEvents(pair, a.id)).toBe(true);
      await expect(memory.restoreEvent(b.id)).rejects.toThrow('已参与记忆合并');
      await expect(memory.forgetEvent(b.id)).rejects.toThrow('已参与记忆合并');
      expect(a).toMatchObject({ summary: expect.stringContaining('The interviewer is Li.'), quotes: ['Bring the original transcript.'],
        tags: ['interview', 'master'], criticality: 'identity', sourceMessageIds: [...a.sourceMessageIds],
        mergedFromEventIds: [b.id], temporal: { participants: ['Li'], happenedStart: '2026-08-17', status: 'occurred', eventType: 'meeting' }, weight: { lastAdoptedTurn: memory.turn } });
      expect(a.sourceMessageIds).toContain(b.sourceMessageIds[0]);
      expect(later.temporal).toMatchObject({ sameEventId: a.id, relatedEventIds: [a.id], afterEventIds: [a.id] });
      await memory.close(); memory = await StrataGate.open({ database, namespace: 'one' });
      const kept = memory.listAllEvents().find(event => event.id === a.id)!;
      expect(kept.mergedFromEventIds).toEqual([b.id]); expect(kept.sourceMessageIds).toEqual(a.sourceMessageIds);
      expect(memory.listBlocks()).toEqual(raw); expect(memory.listUsageReceipts()).toEqual(receipts);
      expect((await memory.searchEvents('Xidian', { trackRetrieval: false })).filter(result => result.event.title === fact.title).map(result => result.event.id)).toEqual([a.id]);
    } finally { await memory.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it('preserves a chain of three consolidated source cards through restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-chain-')); const database = join(directory, 'memory.db');
    let memory = await StrataGate.open({ database, namespace: 'chain', blockTurnSize: 1 });
    try {
      const a = await seed(memory); const b = await seed(memory); const c = await seed(memory);
      expect(await memory.mergeDuplicateEvents(pairFor(a,b),a.id)).toBe(true);
      expect(await memory.mergeDuplicateEvents(pairFor(a,c),c.id)).toBe(true);
      await memory.close(); memory = await StrataGate.open({ database, namespace: 'chain' });
      expect(memory.listEvents().find(event => event.id === c.id)?.sourceMessageIds).toHaveLength(3);
    } finally { await memory.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it('rejects stale evidence and temporal cycles without partial content or relation writes', async () => {
    const memory = StrataGate.inMemory({ blockTurnSize: 1 });
    const a = await seed(memory); const b = await seed(memory); const c = await seed(memory, { temporal: { afterEventIds: [a.id], beforeEventIds: [b.id] } });
    const before = memory.exportSnapshot();
    expect(await memory.mergeDuplicateEvents(pairFor(a,b),a.id)).toBe(false);
    expect(memory.exportSnapshot()).toEqual(before);
    const stale = pairFor(a,c); await memory.forgetEvent(c.id);
    expect(await memory.mergeDuplicateEvents(stale,a.id)).toBe(false);
    const anchors=StrataGate.inMemory({blockTurnSize:1});
    const first=await seed(anchors);const last=await seed(anchors);const middle=await seed(anchors,{temporal:{sameEventId:first.id}});
    last.temporal.sameEventId=middle.id;
    const anchorBefore=anchors.exportSnapshot();
    expect(await anchors.mergeDuplicateEvents(pairFor(first,last),first.id)).toBe(false);
    expect(anchors.exportSnapshot()).toEqual(anchorBefore);
  });

  it('allows classification/evidence differences but protects real scope, date, status and version conflicts', () => {
    expect(eventDuplicateMergeCompatible(fact,{...fact, criticality:'identity', temporal:{participants:['Li']}})).toBe(true);
    for (const other of [{scope:'session' as const}, {temporal:{happenedStart:'2026-08-18'}}, {temporal:{status:'cancelled' as const}}]) {
      expect(eventDuplicateMergeCompatible({...fact,temporal:{happenedStart:'2026-08-17',status:'occurred'}},{...fact,...other})).toBe(false);
    }
    expect(eventDuplicateMergeCompatible({...fact,summary:'version 1.2'}, {...fact,summary:'version 1.3'})).toBe(false);
  });

  it('adds the optional provenance table to an old schema-12 database without altering old cards', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-merge-upgrade-')); const database = join(directory, 'memory.db');
    let memory = await StrataGate.open({database,namespace:'old',blockTurnSize:1});
    try {
      await seed(memory); const before=memory.exportSnapshot(); await memory.close();
      const db=new DatabaseSync(database); db.exec('DROP TABLE event_merge_sources; PRAGMA user_version = 12; UPDATE memory_spaces SET schema_version = 12;'); db.close();
      const readonly=new SqliteStorage({filename:database,readonly:true});
      expect((await readonly.load('old'))?.snapshot.events).toEqual(before.events); await readonly.close();
      memory=await StrataGate.open({database,namespace:'old'}); expect(memory.listEvents()).toEqual(before.events);
    } finally {await memory.close();await rm(directory,{recursive:true,force:true});}
  });

  it('rolls back all content, references and archive state when persistence fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-merge-rollback-')); const database = join(directory, 'memory.db');
    const memory=await StrataGate.open({database,namespace:'rollback',blockTurnSize:1});
    try {
      const a=await seed(memory);const b=await seed(memory);await seed(memory,{temporal:{relatedEventIds:[b.id]}});
      const before=memory.exportSnapshot();const fail=vi.spyOn(SqliteStorage.prototype,'save').mockRejectedValueOnce(new Error('injected failure'));
      try {await expect(memory.mergeDuplicateEvents(pairFor(a,b),a.id)).rejects.toThrow('injected failure');}finally{fail.mockRestore();}
      expect(memory.exportSnapshot()).toEqual(before);
    }finally{await memory.close();await rm(directory,{recursive:true,force:true});}
  });

  it('refuses a batch import undo that would delete a consolidated card’s evidence', async () => {
    const memory=StrataGate.inMemory({blockTurnSize:1});
    const imported=await memory.importExternalMemory({text:'Imported interview source',
      extractor:async()=>({candidates:[fact]}),decider:async()=>({action:'ADD',confidence:1})});
    const a=imported.addedEvents[0]!;const b=await seed(memory);
    expect(await memory.mergeDuplicateEvents(pairFor(a,b),b.id)).toBe(true);
    const before=memory.exportSnapshot();
    await expect(memory.undoExternalMemoryImport(imported.sourceBlockId)).rejects.toThrow('已参与记忆合并');
    expect(memory.exportSnapshot()).toEqual(before);
  });
});
