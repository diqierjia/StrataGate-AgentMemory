import { describe, expect, it } from 'vitest';
import { StrataGate, type GraphProjectionContext, type MemoryBlock } from '../src/index.js';
import { SqliteStorage } from '../src/sqlite.js';

const summarizer = async () => ({
  l0Title: 'batch', l0Tags: [], l1Summary: 'batch', l2Keypoints: [], shouldExtract: true,
});
const inputs = (target: MemoryBlock) => Array.from({ length: 17 }, (_, index) => ({
  id: `evt_batch_${index}`, title: `Project ${index}`, summary: `Evidence ${index}: ${'完整来源。'.repeat(100)}`,
  sourceBlockId: target.id, sourceMessageIds: [target.l5Raw[0]!.id],
}));
const projection = (context: GraphProjectionContext) => ({
  reason: 'projected',
  nodes: context.events.map(event => ({
    ref: event.id, name: event.title, type: 'project' as const,
    sourceEventIds: [event.id], metadataProvenance: { name: [event.id] },
    facts: [{ key: 'detail', value: event.summary, sourceEventIds: [event.id] }],
  })),
  edges: [],
});
async function drain(memory: StrataGate): Promise<number[]> {
  const sizes: number[] = [];
  for (let batch; (batch = await memory.claimNextGraphProjection());) {
    sizes.push(batch.events.length);
    await memory.completeGraphProjection(batch.jobId, projection(batch));
  }
  return sizes;
}

describe('Graph projection batches', () => {
  it('projects every Event from a large Block in batches of at most eight without shortening evidence', async () => {
    const called: number[] = [];
    const memory = StrataGate.inMemory({
      blockTurnSize: 1, disableElementProjection: true, summarizer,
      extractor: async ({ target }) => ({ shouldExtract: true, reason: 'events', events: inputs(target) }),
      graphProjector: async context => { called.push(context.events.length); return projection(context); },
    });
    await memory.appendTurn({ user: 'source', assistant: 'stored' });
    expect([...called, ...await drain(memory)]).toEqual([8, 8, 1]);
    expect(memory.listGraphNodes()).toHaveLength(17);
    for (const event of memory.listEvents()) {
      const node = memory.listGraphNodes().find(node => node.sourceEventIds.includes(event.id));
      expect(node?.facts[0]?.value).toBe(event.summary);
    }
    expect(memory.listGraphProjectionJobs().every(job => job.status === 'completed')).toBe(true);
  });

  it('also splits a large external-memory import', async () => {
    const memory = StrataGate.inMemory({ disableElementProjection: true, graphProjector: async context => projection(context) });
    const imported = await memory.importExternalMemory({
      text: 'external source',
      extractor: async () => ({ candidates: Array.from({ length: 17 }, (_, index) => ({
        title: `Imported project ${index}`, summary: `Independent evidence ${index}.`,
      })) }),
      decider: async () => ({ action: 'ADD', confidence: 1 }),
    });
    expect(imported.addedEvents).toHaveLength(17);
    expect(await drain(memory)).toEqual([8, 8, 1]);
    expect(memory.listGraphNodes()).toHaveLength(17);
    expect(memory.listGraphProjectionJobs().flatMap(job => job.sourceEventIds).sort())
      .toEqual(imported.addedEvents.map(event => event.id).sort());
  });

  it('durably splits an old retryable batch while preserving backoff, attempts and completed progress', async () => {
    let now = new Date('2026-10-16T00:00:00Z');
    const storage = new SqliteStorage({ filename: ':memory:' });
    const options = { storage, namespace: 'graph:legacy-batch', blockTurnSize: 1, disableElementProjection: true,
      now: () => now, summarizer, graphProjector: async (context: GraphProjectionContext) => projection(context) };
    try {
      const memory = await StrataGate.openWithStorage(options);
      await memory.appendTurn({ user: 'source', assistant: 'stored' });
      for (const input of inputs(memory.listBlocks()[0]!)) await memory.addEvent(input);
      const loaded = (await storage.load(options.namespace))!;
      const snapshot = loaded.snapshot;
      const original = snapshot.graphProjectionJobs[0]!;
      Object.assign(original, { sourceEventIds: snapshot.events.map(event => event.id), status: 'failed',
        attempts: 1, nextRetryAt: new Date(now.getTime() + 1_000).toISOString(), lastError: 'max-tokens' });
      snapshot.graphProjectionJobs = [original];
      await storage.save(options.namespace, snapshot, loaded.revision);

      const restored = await StrataGate.openWithStorage(options);
      expect(await restored.claimNextGraphProjection()).toBeNull();
      expect(restored.listGraphProjectionJobs()).toHaveLength(1);
      now = new Date(now.getTime() + 1_000);
      const batch = (await restored.claimNextGraphProjection())!;
      expect(batch.jobId).toBe(original.id);
      expect(batch.events).toHaveLength(8);
      const persisted = (await storage.load(options.namespace))!.snapshot.graphProjectionJobs;
      expect(persisted.map(job => job.sourceEventIds.length)).toEqual([8, 8, 1]);
      expect(persisted.map(job => job.attempts)).toEqual([2, 1, 1]);
      await restored.completeGraphProjection(batch.jobId, projection(batch));

      const reopened = await StrataGate.openWithStorage(options);
      expect(await drain(reopened)).toEqual([8, 1]);
      expect(reopened.listGraphNodes()).toHaveLength(17);
      expect(reopened.listGraphProjectionJobs().every(job => job.status === 'completed' && job.attempts === 2)).toBe(true);
      const complete = await StrataGate.openWithStorage(options);
      expect(await complete.claimNextGraphProjection()).toBeNull();

      // An exhausted legacy batch stays terminal until explicitly retried.
      const saved = (await storage.load(options.namespace))!;
      const terminal = saved.snapshot.graphProjectionJobs[0]!;
      Object.assign(terminal, { sourceEventIds: saved.snapshot.events.map(event => event.id), status: 'failed',
        attempts: 3, nextRetryAt: null, nodeIds: [] });
      saved.snapshot.graphProjectionJobs = [terminal];
      await storage.save(options.namespace, saved.snapshot, saved.revision);
      const exhausted = await StrataGate.openWithStorage(options);
      expect(await exhausted.claimNextGraphProjection()).toBeNull();
      expect(exhausted.listGraphProjectionJobs()).toHaveLength(1);
      await exhausted.retryGraphProjection(terminal.id);
      expect(exhausted.listGraphProjectionJobs().map(job => job.sourceEventIds.length)).toEqual([8, 8, 1]);
      expect(exhausted.listGraphProjectionJobs().map(job => job.attempts)).toEqual([1, 0, 0]);
    } finally {
      await storage.close();
    }
  });
});
