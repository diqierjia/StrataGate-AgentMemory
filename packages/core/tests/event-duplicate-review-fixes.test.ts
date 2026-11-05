import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SqliteStorage } from '../src/sqlite.js';
import { StrataGate, memoryWeightAt, scanEventDuplicates,
  type EventCard, type EventCardInput, type EventDuplicateDecision, type StrataGateOptions } from '../src/index.js';

const incomingSummary = 'The project uses SQLite for local durable storage.';
const previousSummary = 'The project uses SQLite for durable local storage.';

async function extractionFixture(action: EventDuplicateDecision['action'], pool: 'passive' | 'agent' = 'passive',
  options: { database?: string; beforeReview?: (memory: StrataGate, previous: EventCard) => Promise<void>; confidence?: number; repeatedOutput?: boolean } = {}) {
  let previous!: EventCard;
  let memory!: StrataGate;
  const decide = vi.fn(async () => {
    await options.beforeReview?.(memory, previous);
    return { action, confidence: options.confidence ?? .99, reason: 'Equivalent facts; select the better source card.', draft:{title:'Project storage preference',summary:incomingSummary+' SQLite stores the project data locally.'} };
  });
  const config: StrataGateOptions = { blockTurnSize: 1,
    summarizer: async () => ({ l0Title: 'SQLite storage', l0Tags: [], l1Summary: incomingSummary, l2Keypoints: [], shouldExtract: true }),
    extractor: async ({ target }) => {
      if (target.l5Raw[0]!.content === 'Previous source') return { shouldExtract: false, reason: 'seed', events: [] };
      const candidate: EventCardInput = { title: previous.title, summary: incomingSummary,
        scope: previous.scope, criticality: previous.criticality,
        sourceBlockId: target.id, sourceMessageIds: [target.l5Raw[0]!.id], quotes: ['SQLite stores the project data locally.'] };
      return { shouldExtract: true, reason: 'new source', events: options.repeatedOutput ? [candidate, { ...candidate }] : [candidate] };
    }, eventDuplicateDecider: decide,
    graphEnabled: true, graphProjector: async () => ({ reason: 'deterministic fixture', nodes: [], edges: [] }),
  };
  memory = options.database
    ? await StrataGate.open({ ...config, database: options.database, namespace: 'review-fixes' })
    : StrataGate.inMemory(config);
  if (pool === 'passive') {
    const block = (await memory.appendTurn({ user: 'Previous source', assistant: 'Saved.' })).sealedBlock!;
    previous = await memory.addEvent({ title: 'Project storage preference', summary: previousSummary, scope: 'project', criticality: 'preference',
      sourceBlockId: block.id, sourceMessageIds: [block.l5Raw[0]!.id] });
  } else {
    const result = await memory.recordAgentEvent({ content: previousSummary });
    previous = memory.listAgentEvents().find(({ id }) => id === result.eventId)!;
  }
  return { memory, previous, decide,
    extract: () => memory.appendTurn({ user: `${incomingSummary}\nSQLite stores the project data locally.`, assistant: 'Current source confirmed.' }) };
}

describe('duplicate review action semantics', () => {
  it.each(['passive', 'agent'] as const)('obeys KEEP_LEFT, KEEP_RIGHT and KEEP_BOTH for a %s source', async (pool) => {
    for (const action of ['KEEP_LEFT', 'KEEP_RIGHT', 'KEEP_BOTH'] as const) {
      const host = await extractionFixture(action, pool);
      const previousRaw = structuredClone(host.memory.listBlocks().find(({ id }) => id === host.previous.sourceBlockId)!.l5Raw);
      const result = await host.extract();
      expect(host.decide).toHaveBeenCalledTimes(1);
      const previous = host.memory.listAllEvents().find(({ id }) => id === host.previous.id)!;
      if (action === 'KEEP_LEFT') {
        expect(result.extractedEvents).toEqual([]);
        expect(previous.status).toBe('active');
      } else {
        expect(result.extractedEvents).toHaveLength(1);
        const incoming = result.extractedEvents[0]!;
        expect(incoming).toMatchObject({ summary: expect.stringContaining(incomingSummary), status: 'active', sourceBlockId: result.sealedBlock!.id,
          sourceMessageIds: expect.arrayContaining([result.sealedBlock!.l5Raw[0]!.id]), quotes: ['SQLite stores the project data locally.'] });
        expect(previous.status).toBe(action === 'KEEP_RIGHT' ? 'archived' : 'active');
        expect(previous.supersededBy).toBe(action === 'KEEP_RIGHT' ? incoming.id : null);
        expect(host.memory.listGraphProjectionJobs().filter(({ sourceEventIds }) => sourceEventIds.includes(incoming.id))).toHaveLength(1);
      }
      expect(host.memory.listBlocks().find(({ id }) => id === host.previous.sourceBlockId)!.l5Raw).toEqual(previousRaw);
      expect(host.memory.listExtractionJobs().every(({ status }) => status === 'succeeded' || status === 'skipped')).toBe(true);
      await host.memory.close();
    }
  });

  it.each(['pinned', 'history-anchor', 'forgotten', 'low-confidence'] as const)('never loses the new card when KEEP_RIGHT cannot archive the old one (%s)', async (mode) => {
    const host = await extractionFixture('KEEP_RIGHT', 'passive', {
      confidence: mode === 'low-confidence' ? .7 : .99,
      beforeReview: async (memory, previous) => {
        if (mode === 'pinned') await memory.pinEvent(previous.id);
        if (mode === 'forgotten') await memory.forgetEvent(previous.id);
        if (mode === 'history-anchor') await memory.addEvent({ title: 'Independent later development', summary: 'A later milestone refers to this history.',
          sourceBlockId: previous.sourceBlockId!, sourceMessageIds: previous.sourceMessageIds, temporal: { sameEventId: previous.id } });
      },
    });
    const result = await host.extract();
    expect(result.extractedEvents).toHaveLength(1);
    expect(result.extractedEvents[0]).toMatchObject({ status: 'active', summary: expect.stringContaining(incomingSummary) });
    expect(host.memory.listAllEvents().find(({ id }) => id === host.previous.id)!.status).toBe(mode === 'forgotten' ? 'forgotten' : mode === 'history-anchor' ? 'archived' : 'active');
  });

  it('handles repeated candidates after KEEP_RIGHT without archiving twice or duplicating projection work', async () => {
    const host = await extractionFixture('KEEP_RIGHT', 'passive', { repeatedOutput: true });
    const result = await host.extract();
    expect(result.extractedEvents).toHaveLength(1);
    expect(host.memory.listAllEvents().filter(({ status }) => status === 'active')).toHaveLength(1);
    expect(host.memory.listAllEvents().find(({ id }) => id === host.previous.id)!.supersededBy).toBe(result.extractedEvents[0]!.id);
    expect(host.memory.listGraphProjectionJobs().filter(({ sourceEventIds }) => sourceEventIds.includes(result.extractedEvents[0]!.id))).toHaveLength(1);
  });

  it('persists the selected new card and the archived old source together across restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-keep-right-review-'));
    const database = join(directory, 'memory.db');
    let memory: StrataGate | undefined;
    try {
      const host = await extractionFixture('KEEP_RIGHT', 'agent', { database });
      memory = host.memory;
      const result = await host.extract();
      expect(result.extractedEvents).toHaveLength(1);
      const incoming = result.extractedEvents[0]!;
      await memory.close(); memory = undefined;
      memory = await StrataGate.open({ database, namespace: 'review-fixes' });
      expect(memory.listEvents().find(({ id }) => id === incoming.id)).toMatchObject({ status: 'active', summary: expect.stringContaining(incomingSummary), sourceMessageIds: incoming.sourceMessageIds });
      expect(memory.listAgentEvents().find(({ id }) => id === host.previous.id)).toMatchObject({ status: 'archived', supersededBy: incoming.id,
        sourceMessageIds: host.previous.sourceMessageIds });
      expect((await memory.searchEvents('SQLite', { trackRetrieval: false })).map(({ event }) => event.id)).toEqual([incoming.id]);
    } finally { await memory?.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it('rolls back the archive and new card together if their shared save fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-keep-right-save-failure-'));
    const database = join(directory, 'memory.db');
    const host = await extractionFixture('KEEP_RIGHT', 'agent', { database });
    const originalSave = SqliteStorage.prototype.save;
    let failureInjected = false;
    const save = vi.spyOn(SqliteStorage.prototype, 'save').mockImplementation(async function (this: SqliteStorage, ...args: Parameters<SqliteStorage['save']>) {
      const snapshot = args[1];
      if (!failureInjected && snapshot.agentEvents.some(({ id, status }) => id === host.previous.id && status === 'archived')
        && snapshot.events.some(({ summary, status }) => summary.includes(incomingSummary) && status === 'active')) {
        failureInjected = true;
        throw new Error('injected shared-save failure');
      }
      return originalSave.apply(this, args);
    });
    try {
      const result = await host.extract();
      expect(failureInjected).toBe(true);
      expect(result.extractedEvents).toEqual([]);
      expect(host.memory.listAgentEvents().find(({ id }) => id === host.previous.id)).toMatchObject({ status: 'active', supersededBy: null });
      expect(host.memory.listEvents().some(({ summary }) => summary === incomingSummary)).toBe(false);
      const readonly = new SqliteStorage({ filename: database, readonly: true });
      try {
        const loaded = (await readonly.load('review-fixes'))!.snapshot;
        expect(loaded.agentEvents.find(({ id }) => id === host.previous.id)).toMatchObject({ status: 'active', supersededBy: null });
        expect(loaded.events.some(({ summary }) => summary === incomingSummary)).toBe(false);
      } finally { await readonly.close(); }
    } finally { save.mockRestore(); await host.memory.close(); await rm(directory, { recursive: true, force: true }); }
  });
});

describe('duplicate archive preserves real adoption recency', () => {
  it('persists the last actual adoption across reopen without substituting the repair turn', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-adoption-review-'));
    const database = join(directory, 'memory.db');
    let memory = await StrataGate.open({ database, namespace: 'adoption-review', blockTurnSize: 1 });
    try {
      const cards: EventCard[] = [];
      for (let turn = 1; turn <= 8; turn++) {
        const block = (await memory.appendTurn({ user: `Source ${turn}`, assistant: 'Saved.' }, { deferDerivation: true })).sealedBlock!;
        if (turn <= 2) cards.push(await memory.addEvent({ title: 'Storage choice', summary: incomingSummary,
          sourceBlockId: block.id, sourceMessageIds: [block.l5Raw[0]!.id] }));
        if (turn === 2) await memory.recordMemoryUse([cards[0]!.id], { receiptId: 'actual-use-2' });
        if (turn === 7) await memory.recordMemoryUse([cards[1]!.id], { receiptId: 'actual-use-7' });
      }
      const [pair] = await scanEventDuplicates(memory.listEvents());
      const receipts = structuredClone(memory.listUsageReceipts());
      const expectedWeight = memoryWeightAt(cards[1]!, memory.turn);
      expect(await memory.archiveDuplicateEvent(pair!, cards[0]!.id)).toBe(true);
      expect(cards[0]!.weight.lastAdoptedTurn).toBe(7);
      expect(cards[0]!.weight.lastAdoptedTurn).not.toBe(memory.turn);
      const keptId = cards[0]!.id;
      await memory.close();
      memory = await StrataGate.open({ database, namespace: 'adoption-review' });
      const kept = memory.listEvents().find(({ id }) => id === keptId)!;
      expect(kept.weight.lastAdoptedTurn).toBe(7);
      expect(memoryWeightAt(kept, memory.turn)).toBeCloseTo(expectedWeight, 12);
      expect(memory.listUsageReceipts()).toEqual(receipts);
    } finally { await memory.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it.each(['older', 'newer'] as const)('retains the most recent real adoption when keeping the %s card', async (keeper) => {
    const memory = StrataGate.inMemory({ blockTurnSize: 1 });
    const cards: EventCard[] = [];
    for (let turn = 1; turn <= 100; turn++) {
      const block = (await memory.appendTurn({ user: `Recorded source ${turn}`, assistant: 'Saved.' }, { deferDerivation: true })).sealedBlock!;
      if (turn <= 2) cards.push(await memory.addEvent({ title: 'SQLite storage', summary: incomingSummary,
        scope: 'project', criticality: 'preference', sourceBlockId: block.id, sourceMessageIds: [block.l5Raw[0]!.id] }));
      if (turn === 10) await memory.recordMemoryUse([cards[0]!.id], { receiptId: 'actual-adoption-10' });
      if (turn === 100) await memory.recordMemoryUse([cards[1]!.id], { receiptId: 'actual-adoption-100' });
    }
    expect(cards.map(({ weight }) => weight.lastAdoptedTurn)).toEqual([10, 100]);
    const [pair] = await scanEventDuplicates(memory.listAllEvents());
    const chosen = cards[keeper === 'older' ? 0 : 1]!;
    const receipts = structuredClone(memory.listUsageReceipts());
    const counts = cards.map(({ weight }) => weight.mentionCount);
    const lastRetrieved = chosen.weight.lastRetrievedAt;
    const expectedWeight = Math.max(...cards.map((event) => memoryWeightAt(event, 105)));
    expect(await memory.archiveDuplicateEvent(pair!, chosen.id)).toBe(true);
    expect(chosen.weight.lastAdoptedTurn).toBe(100);
    expect(chosen.weight.mentionCount).toBe(Math.max(...counts));
    expect(chosen.weight.lastRetrievedAt).toBe(lastRetrieved);
    expect(memoryWeightAt(chosen, 105)).toBeCloseTo(expectedWeight, 12);
    expect(memory.listUsageReceipts()).toEqual(receipts);
    expect(await memory.archiveDuplicateEvent(pair!, chosen.id)).toBe(true);
    expect(chosen.weight.lastAdoptedTurn).toBe(100);
    expect(memory.listUsageReceipts()).toEqual(receipts);
  });
});
