import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { StrataGate, eventDuplicateCompatible, eventDuplicateFingerprint, isExactEventDuplicate, scanEventDuplicates,
  type EventCard, type EventCardInput, type EventDuplicateDecider } from '../src/index.js';

const fact = { title: 'Project storage preference', summary: 'The project uses SQLite for local durable storage.',
  scope: 'project' as const, criticality: 'preference' as const };
const summary = async () => ({ l0Title: 'Storage', l0Tags: [], l1Summary: fact.summary, l2Keypoints: [], shouldExtract: true });
function memoryWith(extras: { eventDuplicateDecider?: EventDuplicateDecider } = {}) {
  return StrataGate.inMemory({ blockTurnSize: 1, summarizer: summary, ...extras,
    extractor: async ({ target }) => ({ shouldExtract: true, reason: 'fact', events: [
      { ...fact, sourceBlockId: target.id, sourceMessageIds: [target.l5Raw[0]!.id] },
      { ...fact, sourceBlockId: target.id, sourceMessageIds: [target.l5Raw[0]!.id] },
    ] }) });
}
async function seed(memory: StrataGate, changes: Partial<EventCardInput> = {}) {
  const block = (await memory.appendTurn({ user: 'Source fact', assistant: 'Saved.' }, { deferDerivation: true })).sealedBlock!;
  return memory.addEvent({ ...fact, sourceBlockId: block.id, sourceMessageIds: [block.l5Raw[0]!.id], ...changes });
}

describe('automatic Event duplicate gate and full-pool scan', () => {
  it('coalesces repeated outputs within one Block and requires an AI draft for cross-Block consolidation', async () => {
    const decide=vi.fn(async()=>({action:'KEEP_LEFT' as const,confidence:.99,reason:'same fact',draft:{title:fact.title,summary:fact.summary}}));
    const memory = memoryWith({eventDuplicateDecider:decide});
    const first = await memory.appendTurn({ user: 'SQLite is preferred.', assistant: 'Saved.' });
    expect(first.extractedEvents).toHaveLength(1);
    const before = structuredClone(memory.listEvents()[0]);
    const jobsBefore = memory.listGraphProjectionJobs().length;
    const second = await memory.appendTurn({ user: 'SQLite is still preferred.', assistant: 'Saved again.' });
    expect(second.extractedEvents).toEqual([]);
    expect(decide).toHaveBeenCalledTimes(1);
    expect(memory.listEvents().filter(card=>card.status==='active')).toHaveLength(1);
    expect(memory.listEvents()[0]!.weight).toEqual({...before!.weight,lastAdoptedTurn:memory.exportSnapshot().currentTurn});
    expect(memory.listEvents()[0]!.sourceMessageIds).toHaveLength(2);
    expect(memory.listGraphProjectionJobs()).toHaveLength(jobsBefore);
    expect(memory.listBlocks()).toHaveLength(2);
    expect(memory.listBlocks().every(({ processingStatus }) => processingStatus === 'ready')).toBe(true);
    expect(memory.listExtractionJobs().every(({ status }) => status === 'succeeded')).toBe(true);
  });

  it.each([
    { scope: 'session' as const }, { summary: fact.summary + ' Remote storage will use PostgreSQL.' },
    { temporal: { happenedStart: '2026-10-19', eventType: 'change' } },
    { temporal: { status: 'planned' as const, eventType: 'plan' } },
    { temporal: { sameEventId: 'old-event' } },
  ])('preserves distinct facts or progression (%j)', async (change) => {
    const existing = { ...fact, temporal: { eventType: 'other' } };
    expect(isExactEventDuplicate(existing, { ...existing, ...change })).toBe(false);
  });

  it('does not treat the same wording about an undated recurring occurrence as an exact duplicate', () => {
    const incident = { ...fact, temporal: { eventType: 'incident' } };
    expect(isExactEventDuplicate(incident, incident)).toBe(false);
  });

  it('does not let similarity override changed version numbers, negation, or additional source quotations', () => {
    expect(eventDuplicateCompatible({ ...fact, summary: 'The project runs version 1.2.' }, { ...fact, summary: 'The project runs version 1.3.' })).toBe(false);
    expect(eventDuplicateCompatible(fact, { ...fact, summary: 'The project does not use SQLite for local durable storage.' })).toBe(false);
    expect(isExactEventDuplicate(fact, { ...fact, quotes: ['A new constraint is only present in this quote.'] })).toBe(false);
  });

  it('checks the agent-authored pool before adding an extracted equivalent fact', async () => {
    const text = 'The user prefers SQLite for local storage.';
    const memory = StrataGate.inMemory({ blockTurnSize: 1, summarizer: summary,
      eventDuplicateDecider:async()=>({action:'KEEP_LEFT',confidence:.99,reason:'same fact',draft:{title:text,summary:text}}),
      extractor: async ({ target }) => ({ shouldExtract: true, reason: 'same fact', events: [{ title: text, summary: text,
        sourceBlockId: target.id, sourceMessageIds: [target.l5Raw[0]!.id] }] }) });
    await memory.recordAgentEvent({ content: text });
    expect(memory.listAgentEvents()).toHaveLength(1);
    const result = await memory.appendTurn({ user: text, assistant: 'Saved.' });
    expect(result.extractedEvents).toEqual([]);
    expect(memory.listEvents().filter(card=>card.status==='active')).toEqual([]);
    expect(memory.listAgentEvents()[0]!.weight.mentionCount).toBe(1);
  });

  it('does not archive an Event that is another card’s explicit history anchor', async () => {
    const memory = StrataGate.inMemory({ blockTurnSize: 1 });
    const a = await seed(memory); const b = await seed(memory);
    const [pair] = await scanEventDuplicates(memory.listEvents());
    await seed(memory, { summary: 'A later development', temporal: { sameEventId: b.id } });
    expect(await memory.archiveDuplicateEvent(pair!, a.id)).toBe(false);
  });

  it.each(['approve', 'uncertain', 'failed', 'forgotten-during-review'] as const)('checks semantic candidates without risking unreviewed new facts (%s)', async (mode) => {
    let memory: StrataGate;
    let old: EventCard;
    const decide = vi.fn(async () => {
      if (mode === 'failed') throw new Error('model offline');
      if (mode === 'forgotten-during-review') await memory.forgetEvent(old.id);
      return { action: 'KEEP_LEFT' as const, confidence: mode === 'uncertain' ? .8 : .99, reason: 'same durable fact',draft:{title:fact.title,summary:fact.summary} };
    });
    memory = memoryWith({ eventDuplicateDecider: decide });
    old = await seed(memory, { summary: 'The project uses SQLite for durable local storage.' });
    await memory.resumePendingWork();
    expect(decide).toHaveBeenCalled();
    expect(memory.listEvents().filter(({ status }) => status === 'active')).toHaveLength(mode === 'approve' || mode === 'forgotten-during-review' ? 1 : 2);
    if (mode === 'approve') expect(memory.listEvents()[0]!.id).toBe(old.id);
    expect(memory.listBlocks()[0]!.processingStatus).toBe('ready');
  });

  it('scans every live card in both pools without mutating memory or hiding late duplicates', async () => {
    const memory = StrataGate.inMemory({ blockTurnSize: 1 });
    const originals: EventCard[] = [];
    for (let i = 0; i < 110; i++) originals.push(await seed(memory, { title: `Unrelated ${i}`, summary: `Independent fact number ${i}.` }));
    const old = await seed(memory);
    const copy = await seed(memory);
    await memory.recordAgentEvent({ content: 'A distinct agent-authored fact about a calendar.' });
    const before = memory.exportSnapshot();
    const all = memory.listAllEvents();
    const pairs = await scanEventDuplicates(all);
    expect(pairs).toContainEqual(expect.objectContaining({ leftId: old.id, rightId: copy.id, exact: true }));
    expect(memory.exportSnapshot()).toEqual(before);
    const forgotten = { ...copy, id: 'forgotten', status: 'forgotten' as const };
    expect((await scanEventDuplicates([old, forgotten]))).toEqual([]);
  });

  it('archives atomically with stale/pinned guards, idempotence, and intact provenance across SQLite reopen', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-duplicates-'));
    const database = join(directory, 'memory.db');
    let memory = await StrataGate.open({ database, namespace: 'test', blockTurnSize: 1,
      graphProjector: async () => ({ reason: 'none', nodes: [], edges: [] }) });
    try {
      const a = await seed(memory); const b = await seed(memory);
      const [pair] = await scanEventDuplicates(memory.listEvents());
      const raw = structuredClone(memory.listBlocks());
      await memory.pinEvent(b.id);
      expect(await memory.archiveDuplicateEvent(pair!, a.id)).toBe(false);
      await memory.pinEvent(b.id, false);
      expect(await memory.archiveDuplicateEvent(pair!, a.id)).toBe(true);
      expect(await memory.archiveDuplicateEvent(pair!, a.id)).toBe(true);
      await memory.close();
      memory = await StrataGate.open({ database, namespace: 'test' });
      expect(memory.listEvents().find(({ id }) => id === b.id)).toMatchObject({ status: 'archived', supersededBy: a.id, sourceMessageIds: b.sourceMessageIds });
      expect(memory.listBlocks()).toEqual(raw);
      expect((await memory.searchEvents('SQLite')).map(({ event }) => event.id)).toEqual([a.id]);
      expect(memory.listGraphProjectionJobs().some(({ sourceEventIds }) => sourceEventIds.includes(a.id))).toBe(true);
    } finally { await memory.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it('checks stale factual data even if a model previously judged it a duplicate', async () => {
    const memory = StrataGate.inMemory({ blockTurnSize: 1 });
    const a = await seed(memory); const b = await seed(memory);
    const [pair] = await scanEventDuplicates(memory.listEvents());
    await memory.forgetEvent(b.id);
    expect(await memory.archiveDuplicateEvent(pair!, a.id)).toBe(false);
    expect(eventDuplicateFingerprint(b)).not.toBe(pair!.rightFingerprint);
    expect(eventDuplicateCompatible(a, { ...b, temporal: { happenedStart: '2026-10-18' } })).toBe(false);
  });
});
