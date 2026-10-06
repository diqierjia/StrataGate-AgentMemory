import { describe, expect, it } from 'vitest';
import { StrataGate, type GraphProjectionContext, type PersistentStrataGateOptions } from '../src/index.js';
import { SqliteStorage } from '../src/sqlite.js';

const signature = 'StrataGate model did not produce a valid stratagate_project_knowledge_graph call after 2 attempts: StrataGate stratagate_project_knowledge_graph arguments were invalid: '
  + '"nodes[0].metadataProvenance.name[0]" must be a string; "nodes[11].metadataProvenance.name[0]" must be a string';

async function legacyFixture() {
  let now = new Date('2026-10-06T00:00:00.000Z');
  const storage = new SqliteStorage({ filename: ':memory:' });
  const calls: GraphProjectionContext[] = [];
  const options: PersistentStrataGateOptions = {
    storage, namespace: 'graph:113', blockTurnSize: 1, now: () => now,
    summarizer: async () => ({ l0Title: 'seed', l0Tags: [], l1Summary: 'seed', l2Keypoints: [], shouldExtract: false }),
    graphProjector: async (context) => {
      calls.push(context);
      const event = context.events[0]!;
      return { reason: 'recovered', nodes: [{ ref: event.id, name: event.title, type: 'project',
        sourceEventIds: [event.id], metadataProvenance: { name: [event.id] } }], edges: [] };
    },
  };
  const memory = await StrataGate.openWithStorage(options);
  await memory.appendTurn({ user: 'Graph recovery evidence', assistant: 'stored' });
  const block = memory.listBlocks()[0]!;
  const cases = ['affected', 'legacy-null-retry', 'unrelated', 'mixed-error', 'preview-only', 'completed',
    'pending', 'backoff', 'new-job', 'already-recovered', 'forgotten', 'archived'];
  for (const name of cases) {
    await memory.addEvent({ id: `evt_${name}`, title: name, summary: name,
      sourceBlockId: block.id, sourceMessageIds: [block.l5Raw[0]!.id] });
  }
  const loaded = (await storage.load(options.namespace))!;
  for (const job of loaded.snapshot.graphProjectionJobs) {
    const name = job.sourceEventIds[0]!.slice(4);
    delete job.nameProvenanceRecoveryVersion;
    job.status = 'failed';
    job.attempts = 3;
    job.nextRetryAt = null;
    job.lastError = signature + '\nCause: schema error\nRaw response (full):\nprivate model data';
    if (name === 'legacy-null-retry') job.attempts = 1;
    if (name === 'unrelated') job.lastError = 'rate limited';
    if (name === 'mixed-error') job.lastError = signature + '; "nodes[0].type" must be a string';
    if (name === 'preview-only') job.lastError = 'Provider failure\nRaw response (full):\n' + signature;
    if (name === 'completed') job.status = 'completed';
    if (name === 'pending') { job.status = 'pending'; job.attempts = 0; }
    if (name === 'backoff') { job.attempts = 1; job.nextRetryAt = '2026-10-07T00:00:00.000Z'; }
    if (name === 'new-job' || name === 'already-recovered') job.nameProvenanceRecoveryVersion = 1;
    if (name === 'forgotten' || name === 'archived') {
      loaded.snapshot.events.find(({ id }) => id === job.sourceEventIds[0])!.status = name;
    }
  }
  await storage.save(options.namespace, loaded.snapshot, loaded.revision);
  return { storage, options, calls, before: loaded.snapshot.graphProjectionJobs,
    advance: () => { now = new Date(now.getTime() + 60_000); } };
}

describe('one-time recovery of legacy Graph name schema failures (#113)', () => {
  it('queues only affected terminal jobs on writer open, persists once, and completes through the normal worker', async () => {
    const { storage, options, calls, before } = await legacyFixture();
    const readonly = await StrataGate.openWithStorage({ ...options, storage: {
      readonly: true, load: storage.load.bind(storage), save: async () => { throw new Error('read-only write'); },
    } });
    expect(readonly.listGraphProjectionJobs()).toEqual(before);

    const writer = await StrataGate.openWithStorage(options);
    const affectedIds = before.filter(({ sourceEventIds }) => ['evt_affected', 'evt_legacy-null-retry'].includes(sourceEventIds[0]!))
      .map(({ id }) => id);
    expect(affectedIds).toHaveLength(2);
    for (const job of writer.listGraphProjectionJobs()) {
      if (affectedIds.includes(job.id)) {
        expect(job).toMatchObject({ status: 'pending', attempts: 0, lastError: null, nextRetryAt: null, nameProvenanceRecoveryVersion: 1 });
      } else expect(job).toEqual(before.find(({ id }) => id === job.id));
    }
    expect(calls).toEqual([]); // Startup queues work; it does not make model calls.
    const reopened = await StrataGate.openWithStorage(options);
    expect(reopened.listGraphProjectionJobs()).toEqual(writer.listGraphProjectionJobs());
    expect((await storage.load(options.namespace))!.snapshot.graphProjectionJobs.filter(({ id }) => affectedIds.includes(id)))
      .toEqual(reopened.listGraphProjectionJobs().filter(({ id }) => affectedIds.includes(id)));
    for (let count = 0; count < 3; count += 1) await reopened.resumePendingWork();
    expect(calls.map(({ events }) => events[0]!.id).sort()).toEqual(['evt_affected', 'evt_legacy-null-retry', 'evt_pending'].sort());
    for (const id of affectedIds) expect(reopened.listGraphProjectionJobs().find((job) => job.id === id))
      .toMatchObject({ status: 'completed', attempts: 1, nameProvenanceRecoveryVersion: 1 });
    expect((await reopened.searchGraphNodes('affected'))[0]?.node.metadataProvenance?.name).toEqual(['evt_affected']);
    const final = await StrataGate.openWithStorage(options);
    await final.resumePendingWork();
    expect(calls).toHaveLength(3);
    await final.close();
  });

  it('does not reset a recovered job again after it exhausts the ordinary bounded retry cycle', async () => {
    const { options, advance } = await legacyFixture();
    const failingOptions = { ...options, graphProjector: async () => { throw new Error(signature); } };
    const writer = await StrataGate.openWithStorage(failingOptions);
    const affected = writer.listGraphProjectionJobs().find(({ sourceEventIds }) => sourceEventIds[0] === 'evt_affected')!;
    for (let count = 0; count < 12; count += 1) { await writer.resumePendingWork(); advance(); }
    expect(writer.listGraphProjectionJobs().find(({ id }) => id === affected.id))
      .toMatchObject({ status: 'failed', attempts: 3, nextRetryAt: null, nameProvenanceRecoveryVersion: 1 });
    const reopened = await StrataGate.openWithStorage(failingOptions);
    expect(reopened.listGraphProjectionJobs().find(({ id }) => id === affected.id))
      .toEqual(writer.listGraphProjectionJobs().find(({ id }) => id === affected.id));
    expect(await reopened.claimNextGraphProjection()).toBeNull();
    await reopened.close();
  });

  it('preserves affected jobs without a configured projector until a writer can recover them', async () => {
    const { options, before } = await legacyFixture();
    const { graphProjector: _projector, ...unconfiguredOptions } = options;
    const unconfigured = await StrataGate.openWithStorage(unconfiguredOptions);
    expect(unconfigured.listGraphProjectionJobs()).toEqual(before);
    const configured = await StrataGate.openWithStorage(options);
    expect(configured.listGraphProjectionJobs().find(({ sourceEventIds }) => sourceEventIds[0] === 'evt_affected'))
      .toMatchObject({ status: 'pending', attempts: 0, nameProvenanceRecoveryVersion: 1 });
    await configured.close();
  });
});
