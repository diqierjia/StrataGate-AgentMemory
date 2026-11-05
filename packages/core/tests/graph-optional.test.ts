import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { StrataGate, type GraphRuntimePolicy, type GraphProjectionContext } from '../src/index.js';
import { SqliteStorage } from '../src/sqlite.js';
import { backgroundWorkTimes } from '../src/background-work.js';
import { DERIVATION_LEASE_MS } from '../src/storage.js';

const summarizer = async () => ({ l0Title: 'source', l0Tags: [], l1Summary: 'source', l2Keypoints: [], shouldExtract: false });
const empty = { reason: 'none', nodes: [], edges: [] };

describe('optional Graph policy', () => {
  it('commits Event ingestion but suppresses a newly queued Graph job when disabled immediately before save', async () => {
    let policy: GraphRuntimePolicy = { enabled: true, paused: false, epoch: 1, backfillEventIds: [] };
    const storage = new SqliteStorage({ filename: ':memory:', graphPolicy: () => policy });
    const memory = await StrataGate.openWithStorage({ storage, namespace: 'enqueue-race', blockTurnSize: 1, summarizer, graphPolicy: () => policy, graphProjector: async () => empty });
    await memory.appendTurn({ user: 'source', assistant: 'saved' });
    const block = memory.listBlocks()[0]!;
    const save = storage.save.bind(storage);
    vi.spyOn(storage, 'save').mockImplementationOnce(async (...args) => { policy = { ...policy, enabled: false, epoch: 2 }; return save(...args); });
    await memory.addEvent({ title: 'kept fact', summary: 'ordinary search still works', sourceBlockId: block.id, sourceMessageIds: [block.l5Raw[0]!.id] });
    expect(memory.listGraphProjectionJobs()).toEqual([]);
    expect((await storage.load('enqueue-race'))!.snapshot.graphProjectionJobs).toEqual([]);
    expect((await memory.searchEvents('ordinary')).length).toBe(1);
    await memory.close();
  });

  it('defaults off with a configured model, keeps Events/search/topics and explicitly enables a finite batch', async () => {
    const model = vi.fn(async (_context: GraphProjectionContext) => empty);
    const memory = StrataGate.inMemory({ blockTurnSize: 1, summarizer, graphProjector: model });
    await memory.appendTurn({ user: 'source', assistant: 'saved' });
    const block = memory.listBlocks()[0]!;
    for (let i = 0; i < 19; i++) await memory.addEvent({ id: `event-${i}`, title: `project ${i}`, summary: 'Useful saved fact', sourceBlockId: block.id, sourceMessageIds: [block.l5Raw[0]!.id] });
    await memory.resumePendingWork();
    expect(memory.graphEnabled).toBe(false);
    expect(model).not.toHaveBeenCalled();
    expect(memory.listGraphProjectionJobs()).toEqual([]);
    expect((await memory.searchEvents('Useful')).length).toBeGreaterThan(0);
    expect(memory.hasPendingTopicWork()).toBe(true);
    const ids = memory.graphBackfillEventIds();
    await memory.setGraphEnabled(true, ids.slice(0, 9));
    await memory.resumePendingWork();
    expect(model).toHaveBeenCalledTimes(1);
    expect(memory.listGraphProjectionJobs().map(job => job.sourceEventIds.length)).toEqual([8, 1]);
    await memory.resumePendingWork();
    await memory.resumePendingWork();
    expect(model).toHaveBeenCalledTimes(2);
    expect(memory.listEvents()).toHaveLength(19);
    expect(memory.graphBackfillEventIds()).toHaveLength(10);
  });

  it('migrates the additive switch once, preserves graph bytes, and preserves manual state across reopen', async () => {
    const root = await mkdtemp(join(tmpdir(), 'graph-toggle-migration-'));
    const database = join(root, 'memory.db');
    try {
      const seed = await StrataGate.open({ database, namespace: 'legacy', blockTurnSize: 1, summarizer, graphEnabled: true, graphProjector: async () => empty });
      await seed.appendTurn({ user: 'source', assistant: 'saved' });
      const block = seed.listBlocks()[0]!;
      const event = await seed.addEvent({ title: 'Project uses SQLite', summary: 'preserved evidence', sourceBlockId: block.id, sourceMessageIds: [block.l5Raw[0]!.id] });
      const claim = (await seed.claimNextGraphProjection())!;
      await seed.completeGraphProjection(claim.jobId, { reason: 'preserved graph', nodes: [
        { ref: 'project', name: 'Project', type: 'project', aliases: [], facts: [], sourceEventIds: [event.id], metadataProvenance: { name: [event.id] } },
        { ref: 'sqlite', name: 'SQLite', type: 'tool', aliases: [], facts: [], sourceEventIds: [event.id], metadataProvenance: { name: [event.id] } },
      ], edges: [{ fromRef: 'project', toRef: 'sqlite', relation: 'uses', sourceEventIds: [event.id] }] });
      await seed.close();
      const db = new DatabaseSync(database);
      const before = db.prepare('SELECT nodes_json, edges_json, jobs_json FROM graph_state').all();
      const eventsBefore = db.prepare('SELECT * FROM events').all();
      const sourcesBefore = db.prepare('SELECT * FROM event_sources').all();
      db.exec('ALTER TABLE memory_spaces DROP COLUMN graph_enabled; ALTER TABLE memory_spaces DROP COLUMN graph_epoch; DROP TABLE stratagate_graph_policy_migrations');
      db.close();
      const migrated = await StrataGate.open({ database, namespace: 'legacy', graphProjector: async () => empty });
      expect(migrated.graphEnabled).toBe(false);
      await migrated.close();
      const verify = new DatabaseSync(database);
      expect(verify.prepare('SELECT nodes_json, edges_json, jobs_json FROM graph_state').all()).toEqual(before);
      expect(verify.prepare('SELECT * FROM events').all()).toEqual(eventsBefore);
      expect(verify.prepare('SELECT * FROM event_sources').all()).toEqual(sourcesBefore);
      expect(verify.prepare('SELECT COUNT(*) AS n FROM stratagate_graph_policy_migrations').get()).toMatchObject({ n: 1 });
      verify.close();
      for (const enabled of [true, false, true]) {
        const writer = await StrataGate.open({ database, namespace: 'legacy' });
        await writer.setGraphEnabled(enabled); await writer.close();
        const reader = await StrataGate.open({ database, namespace: 'legacy' });
        expect(reader.graphEnabled).toBe(enabled); await reader.close();
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('fences a late result in SQLite even if policy changes between validation and save', async () => {
    let policy: GraphRuntimePolicy = { enabled: true, paused: false, epoch: 1, backfillEventIds: [] };
    const storage = new SqliteStorage({ filename: ':memory:', graphPolicy: () => policy });
    const memory = await StrataGate.openWithStorage({ storage, namespace: 'race', blockTurnSize: 1, summarizer, graphPolicy: () => policy, graphProjector: async () => empty });
    await memory.appendTurn({ user: 'source', assistant: 'saved' });
    const block = memory.listBlocks()[0]!;
    await memory.addEvent({ title: 'fact', summary: 'fact', sourceBlockId: block.id, sourceMessageIds: [block.l5Raw[0]!.id] });
    const job = (await memory.claimNextGraphProjection())!;
    const save = storage.save.bind(storage);
    vi.spyOn(storage, 'save').mockImplementationOnce(async (...args) => { policy = { ...policy, enabled: false, epoch: 2 }; return save(...args); });
    await expect(memory.completeGraphProjection(job.jobId, empty)).rejects.toThrow();
    expect((await storage.load('race'))!.snapshot.graphProjectionJobs[0]?.status).toBe('running');
    expect(memory.listGraphNodes()).toEqual([]);
    expect(await memory.claimNextGraphProjection()).toBeNull();
    policy = { ...policy, enabled: true, epoch: 3, backfillEventIds: job.events.map(event => event.id) };
    await expect(memory.completeGraphProjection(job.jobId, empty)).rejects.toThrow(/revoked/);
    const replacement = (await memory.claimNextGraphProjection())!;
    expect(replacement.jobId).not.toBe(job.jobId);
    await memory.completeGraphProjection(replacement.jobId, empty);
    await memory.close();
  });

  it('does not run a legacy pending job for a forgotten Event after an empty re-enable approval', async () => {
    const root = await mkdtemp(join(tmpdir(), 'graph-toggle-forgotten-'));
    const database = join(root, 'memory.db');
    const calls: string[] = [];
    try {
      const seed = await StrataGate.open({ database, namespace: 'forgotten', blockTurnSize: 1, graphEnabled: true,
        summarizer, graphProjector: async ({ events }) => { calls.push(events[0]!.id); return empty; } });
      await seed.appendTurn({ user: 'source', assistant: 'saved' });
      const block = seed.listBlocks()[0]!;
      const event = await seed.addEvent({ id: 'forgotten-before-reopen', title: 'old', summary: 'old', sourceBlockId: block.id, sourceMessageIds: [block.l5Raw[0]!.id] });
      await seed.close();

      // Simulate a pre-toggle persisted job: no creation epoch means it must
      // be covered by the explicit approval set before it can be claimed.
      const storage = new SqliteStorage({ filename: database });
      const loaded = (await storage.load('forgotten'))!;
      delete (loaded.snapshot.graphProjectionJobs[0] as { createdEpoch?: number }).createdEpoch;
      loaded.snapshot.graphEnabled = false;
      loaded.snapshot.graphEpoch = 2;
      await storage.save('forgotten', loaded.snapshot, loaded.revision);
      await storage.close();

      const reopened = await StrataGate.open({ database, namespace: 'forgotten', graphProjector: async ({ events }) => { calls.push(events[0]!.id); return empty; } });
      await reopened.forgetEvent(event.id);
      await reopened.close();
      const enabled = await StrataGate.open({ database, namespace: 'forgotten', graphProjector: async ({ events }) => { calls.push(events[0]!.id); return empty; } });
      await enabled.setGraphEnabled(true, []);
      await enabled.resumePendingWork();
      expect(calls).toEqual([]);
      expect(enabled.listGraphProjectionJobs()).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'pending', sourceEventIds: [event.id] })]));
      await enabled.close();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('does not recreate an exhausted old-epoch Graph job as pending', async () => {
    const root = await mkdtemp(join(tmpdir(), 'graph-toggle-exhausted-'));
    const database = join(root, 'memory.db');
    let reopened: Awaited<ReturnType<typeof StrataGate.open>> | undefined;
    try {
      const seed = await StrataGate.open({ database, namespace: 'exhausted', blockTurnSize: 1, graphEnabled: true,
        summarizer, graphProjector: async () => empty });
      await seed.appendTurn({ user: 'source', assistant: 'saved' });
      const block = seed.listBlocks()[0]!;
      await seed.addEvent({ id: 'exhausted-event', title: 'old', summary: 'old', sourceBlockId: block.id, sourceMessageIds: [block.l5Raw[0]!.id] });
      const claimed = await seed.claimNextGraphProjection();
      expect(claimed).not.toBeNull();
      await seed.close();

      const storage = new SqliteStorage({ filename: database });
      const loaded = (await storage.load('exhausted'))!;
      await storage.close();
      const job = loaded.snapshot.graphProjectionJobs[0]!;
      job.status = 'running'; job.attempts = 3; job.claimEpoch = 1; job.nextRetryAt = null; job.lastError = 'provider failed';
      loaded.snapshot.graphEnabled = false; loaded.snapshot.graphEpoch = 2;
      const db = new DatabaseSync(database);
      db.prepare('UPDATE graph_state SET jobs_json = ? WHERE namespace = ?').run(JSON.stringify(loaded.snapshot.graphProjectionJobs), 'exhausted');
      db.prepare('UPDATE memory_spaces SET graph_enabled = 0, graph_epoch = 2 WHERE namespace = ?').run('exhausted');
      db.close();

      reopened = await StrataGate.open({ database, namespace: 'exhausted', graphProjector: async () => empty });
      await reopened.setGraphEnabled(true, []);
      await reopened.resumePendingWork();
      const jobs = reopened.listGraphProjectionJobs();
      await reopened.close();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({ status: 'failed', attempts: 3, nextRetryAt: null });
    } finally {
      await reopened?.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(['forgotten', 'archived'] as const)('filters %s sources even from incremental work in the current epoch', async (status) => {
    const model = vi.fn(async () => empty);
    const memory = StrataGate.inMemory({ graphEnabled: true, blockTurnSize: 1, summarizer, graphProjector: model });
    await memory.appendTurn({ user: 'source', assistant: 'saved' });
    const block = memory.listBlocks()[0]!;
    const event = await memory.addEvent({ title: 'private', summary: 'private', sourceBlockId: block.id, sourceMessageIds: [block.l5Raw[0]!.id] });
    if (status === 'forgotten') await memory.forgetEvent(event.id);
    else event.status = 'archived';
    await memory.resumePendingWork();
    expect(model).not.toHaveBeenCalled();
    expect(backgroundWorkTimes({ ...memory.exportSnapshot(), sealableTail: false }).core).toBeNull();
    expect(await memory.claimNextGraphProjection()).toBeNull();
  });

  it.each([false, true])('requires approval for pre-disable pending work but allows new incremental Events after an empty approval (legacy=%s)', async (legacy) => {
    const storage = new SqliteStorage({ filename: ':memory:' });
    const model = vi.fn(async (_context: GraphProjectionContext) => empty);
    const options = { storage, namespace: 'approval', blockTurnSize: 1, summarizer, graphProjector: model };
    const memory = await StrataGate.openWithStorage({ ...options, graphEnabled: true });
    await memory.appendTurn({ user: 'source', assistant: 'saved' });
    const block = memory.listBlocks()[0]!;
    const add = (id: string) => memory.addEvent({ id, title: id, summary: id, sourceBlockId: block.id, sourceMessageIds: [block.l5Raw[0]!.id] });
    await add('old-active');
    if (legacy) {
      const loaded = (await storage.load('approval'))!;
      delete loaded.snapshot.graphProjectionJobs[0]!.createdEpoch;
      await storage.save('approval', loaded.snapshot, loaded.revision);
      await memory.reloadFromStorage();
    }
    await memory.setGraphEnabled(false);
    await memory.setGraphEnabled(true, []);
    await memory.resumePendingWork();
    expect(model).not.toHaveBeenCalled();
    expect(memory.graphBackfillEventIds()).toEqual(['old-active']);
    expect(backgroundWorkTimes({ ...memory.exportSnapshot(), sealableTail: false }).core).toBeNull();
    await add('new-active');
    await memory.resumePendingWork();
    expect(model.mock.calls.flatMap(([context]) => context.events.map(event => event.id))).toEqual(['new-active']);
    await memory.setGraphEnabled(false);
    await memory.setGraphEnabled(true, ['old-active']);
    const reopened = await StrataGate.openWithStorage(options);
    expect(reopened.exportSnapshot().graphBackfillEventIds).toEqual(['old-active']);
    await reopened.resumePendingWork();
    expect(model.mock.calls.flatMap(([context]) => context.events.map(event => event.id))).toEqual(['new-active', 'old-active']);
    await reopened.close();
  });

  it('filters partial legacy batches to approved live sources without changing Events or retry backoff', async () => {
    let policy: GraphRuntimePolicy = { enabled: true, paused: false, epoch: 1, backfillEventIds: [] };
    const storage = new SqliteStorage({ filename: ':memory:', graphPolicy: () => policy });
    const model = vi.fn(async (_context: GraphProjectionContext) => empty);
    const options = { storage, namespace: 'partial', blockTurnSize: 1, summarizer, graphPolicy: () => policy, graphProjector: model };
    const seed = await StrataGate.openWithStorage(options);
    await seed.appendTurn({ user: 'source', assistant: 'saved' });
    const block = seed.listBlocks()[0]!;
    for (const id of ['allowed', 'denied', 'forgotten', 'archived']) await seed.addEvent({ id, title: id, summary: id, sourceBlockId: block.id, sourceMessageIds: [block.l5Raw[0]!.id] });
    const loaded = (await storage.load('partial'))!;
    const job = loaded.snapshot.graphProjectionJobs[0]!;
    job.sourceEventIds = ['allowed', 'denied', 'forgotten', 'archived'];
    delete job.createdEpoch;
    job.status = 'failed'; job.attempts = 1; job.lastError = 'provider rate limited'; job.nextRetryAt = '2099-01-01T00:00:00Z';
    loaded.snapshot.graphProjectionJobs = [job];
    loaded.snapshot.events.find(event => event.id === 'forgotten')!.status = 'forgotten';
    loaded.snapshot.events.find(event => event.id === 'archived')!.status = 'archived';
    await storage.save('partial', loaded.snapshot, loaded.revision);
    policy = { ...policy, epoch: 3, backfillEventIds: ['allowed', 'forgotten', 'archived'] };
    const memory = await StrataGate.openWithStorage(options);
    expect(await memory.claimNextGraphProjection()).toBeNull(); // backoff is still authoritative
    job.nextRetryAt = '2000-01-01T00:00:00Z';
    const latest = (await storage.load('partial'))!;
    latest.snapshot.graphProjectionJobs[0]!.nextRetryAt = job.nextRetryAt;
    await storage.save('partial', latest.snapshot, latest.revision);
    await memory.reloadFromStorage();
    await memory.resumePendingWork();
    expect(model.mock.calls.flatMap(([context]) => context.events.map(event => event.id))).toEqual(['allowed']);
    expect(memory.listGraphProjectionJobs()[0]).toMatchObject({ attempts: 2, status: 'completed' });
    expect(memory.listAllEvents()).toHaveLength(4);
    await memory.close();
  });

  it.each(['running', 'failed', 'pending'] as const)('keeps the final attempt terminal after switching epochs (%s), and permits only an explicit manual retry', async (status) => {
    const storage = new SqliteStorage({ filename: ':memory:' });
    let clock = new Date('2026-10-01T00:00:00Z');
    const model = vi.fn(async () => empty);
    const memory = await StrataGate.openWithStorage({ storage, namespace: 'third', graphEnabled: true, blockTurnSize: 1,
      summarizer, graphProjector: model, now: () => clock });
    await memory.appendTurn({ user: 'source', assistant: 'saved' });
    const block = memory.listBlocks()[0]!;
    await memory.addEvent({ id: 'final-event', title: 'final', summary: 'final', sourceBlockId: block.id, sourceMessageIds: [block.l5Raw[0]!.id] });
    let claim: Awaited<ReturnType<typeof memory.claimNextGraphProjection>>;
    for (let index = 0; index < 3; index++) {
      claim = await memory.claimNextGraphProjection();
      expect(claim).not.toBeNull();
      if (index < 2 || status !== 'running') await memory.failGraphProjection(claim!.jobId, new Error('provider final failure'));
      clock = new Date(clock.getTime() + 60_000);
    }
    if (status === 'pending') {
      const current = (await storage.load('third'))!;
      current.snapshot.graphProjectionJobs[0]!.status = 'pending';
      await storage.save('third', current.snapshot, current.revision);
      await memory.reloadFromStorage();
    }
    await memory.setGraphEnabled(false);
    await memory.setGraphEnabled(true, ['final-event']);
    await memory.resumePendingWork();
    expect(model).not.toHaveBeenCalled();
    expect(memory.listGraphProjectionJobs()).toHaveLength(1);
    const terminal = memory.listGraphProjectionJobs()[0]!;
    expect(terminal).toMatchObject({ status: 'failed', attempts: 3, nextRetryAt: null });
    expect(terminal.lastError).toMatch(status === 'running' ? /disabled/ : /provider final failure/);
    expect(backgroundWorkTimes({ ...memory.exportSnapshot(), sealableTail: false }).core).toBeNull();
    await memory.retryGraphProjection(terminal.id);
    expect(model).toHaveBeenCalledTimes(1);
    expect(memory.listGraphProjectionJobs().filter(job => job.status === 'completed')).toHaveLength(1);
    await expect(memory.completeGraphProjection(claim!.jobId, empty)).rejects.toThrow(/revoked|not running/);
    await memory.close();
  });

  it('keeps unapproved siblings available for a later confirmation with their original attempts', async () => {
    const model = vi.fn(async (_context: GraphProjectionContext) => empty);
    const storage = new SqliteStorage({ filename: ':memory:' });
    const options = { storage, namespace: 'later-approval', graphEnabled: true, blockTurnSize: 1, summarizer, graphProjector: model };
    const seed = await StrataGate.openWithStorage(options);
    await seed.appendTurn({ user: 'source', assistant: 'saved' });
    const block = seed.listBlocks()[0]!;
    for (const id of ['first', 'later']) await seed.addEvent({ id, title: id, summary: id, sourceBlockId: block.id, sourceMessageIds: [block.l5Raw[0]!.id] });
    const loaded = (await storage.load(options.namespace))!;
    loaded.snapshot.graphProjectionJobs[0]!.sourceEventIds = ['first', 'later'];
    loaded.snapshot.graphProjectionJobs.splice(1);
    await storage.save(options.namespace, loaded.snapshot, loaded.revision);
    await seed.reloadFromStorage();
    const old = (await seed.claimNextGraphProjection())!;
    await seed.failGraphProjection(old.jobId, new Error('first failure'));
    await seed.setGraphEnabled(false);
    await seed.setGraphEnabled(true, ['first']);
    // The old failure's backoff remains in effect after reopening.
    const current = (await storage.load(options.namespace))!;
    current.snapshot.graphProjectionJobs[0]!.nextRetryAt = '2000-01-01T00:00:00Z';
    await storage.save(options.namespace, current.snapshot, current.revision);
    await seed.reloadFromStorage();
    await seed.resumePendingWork();
    expect(model.mock.calls.flatMap(([context]) => context.events.map(event => event.id))).toEqual(['first']);
    const deferred = seed.listGraphProjectionJobs().find(job => job.sourceEventIds.length === 1 && job.sourceEventIds[0] === 'later')!;
    expect(deferred.attempts).toBe(1);
    expect(await seed.claimNextGraphProjection()).toBeNull();
    await seed.setGraphEnabled(false);
    await seed.setGraphEnabled(true, ['later']);
    await seed.resumePendingWork();
    expect(model.mock.calls.flatMap(([context]) => context.events.map(event => event.id))).toEqual(['first', 'later']);
    expect(seed.listGraphProjectionJobs().find(job => job.id === deferred.id)).toMatchObject({ status: 'completed', attempts: 2 });
    await expect(seed.completeGraphProjection(old.jobId, empty)).rejects.toThrow(/revoked/);
    await seed.close();
  });

  it('rejects a late result when lease expiry starts a new attempt in the same epoch', async () => {
    let clock = new Date('2026-10-10T00:00:00Z');
    const storage = new SqliteStorage({ filename: ':memory:' });
    const options = { storage, namespace: 'same-epoch-fence', graphEnabled: true, blockTurnSize: 1,
      now: () => clock, summarizer, graphProjector: async () => empty };
    const first = await StrataGate.openWithStorage(options);
    await first.appendTurn({ user: 'source', assistant: 'saved' });
    const block = first.listBlocks()[0]!;
    await first.addEvent({ title: 'same epoch', summary: 'lease fence', sourceBlockId: block.id, sourceMessageIds: [block.l5Raw[0]!.id] });
    const oldClaim = (await first.claimNextGraphProjection())!;

    clock = new Date(clock.getTime() + DERIVATION_LEASE_MS + 2_000);
    const second = await StrataGate.openWithStorage(options);
    const loaded = (await storage.load(options.namespace))!;
    loaded.snapshot.graphProjectionJobs[0]!.nextRetryAt = '2000-01-01T00:00:00Z';
    await storage.save(options.namespace, loaded.snapshot, loaded.revision);
    await second.reloadFromStorage();
    const newClaim = (await second.claimNextGraphProjection())!;
    expect(newClaim.jobId).toBe(oldClaim.jobId);
    expect(newClaim.claimToken).not.toBe(oldClaim.claimToken);

    await first.reloadFromStorage();
    await expect(first.completeGraphProjection(oldClaim.jobId, empty, oldClaim.claimToken)).rejects.toThrow(/superseded|late result/);
    await second.failGraphProjection(oldClaim.jobId, new Error('late failure'), oldClaim.claimToken);
    expect(second.listGraphProjectionJobs().find(job => job.id === newClaim.jobId)).toMatchObject({ status: 'running', attempts: 2 });
    expect(first.listGraphNodes()).toHaveLength(0);
    await second.completeGraphProjection(newClaim.jobId, empty, newClaim.claimToken);
    expect(second.listGraphProjectionJobs().find(job => job.id === newClaim.jobId)).toMatchObject({ status: 'completed', attempts: 2 });
    await first.close();
    await second.close();
  });

  it('fences another OS process holding an old lease and preserves a finite approval across process restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'graph-process-policy-'));
    const database = join(root, 'memory.db');
    const options = { database, namespace: 'process', blockTurnSize: 1, summarizer, graphProjector: async () => empty };
    let controller = await StrataGate.open({ ...options, graphEnabled: true });
    const children: ReturnType<typeof fork>[] = [];
    async function worker() {
      const child = fork(fileURLToPath(new URL('./fixtures/graph-policy-worker.cjs', import.meta.url)), [database, 'process', new URL('../src/store.ts', import.meta.url).href], { silent: true });
      children.push(child);
      let stderr = '';
      child.stderr?.on('data', data => { stderr += data; });
      await new Promise<void>((resolve, reject) => {
        child.once('message', message => (message as { ready?: boolean }).ready ? resolve() : reject(new Error(JSON.stringify(message))));
        child.once('error', reject);
        child.once('exit', code => reject(new Error(`worker exited ${code}: ${stderr}`)));
      });
      return async (command: string, jobId?: string): Promise<{ jobId: string | null; ids: string[]; error?: string }> => new Promise((resolve, reject) => {
        child.once('message', message => resolve(message as never));
        child.once('error', reject);
        child.send({ command, jobId });
      });
    }
    try {
      await controller.appendTurn({ user: 'source', assistant: 'saved' });
      const block = controller.listBlocks()[0]!;
      for (const id of ['allowed', 'denied', 'forgotten']) await controller.addEvent({ id, title: id, summary: id, sourceBlockId: block.id, sourceMessageIds: [block.l5Raw[0]!.id] });
      const call = await worker();
      const old = await call('claim');
      expect(old.ids).toEqual(['allowed']);
      await controller.reloadFromStorage();
      await controller.setGraphEnabled(false);
      await controller.forgetEvent('forgotten');
      await controller.setGraphEnabled(true, []);
      expect((await call('complete', old.jobId!)).error).toBeDefined();
      expect((await call('claim')).jobId).toBeNull(); // reload after the rejected save must not grant history
      await controller.reloadFromStorage();
      await controller.setGraphEnabled(false);
      await controller.setGraphEnabled(true, ['allowed']);
      await controller.close();
      controller = await StrataGate.open(options);
      const secondCall = await worker();
      const replacement = await secondCall('claim');
      expect(replacement.error).toBeUndefined();
      expect(replacement.ids).toEqual(['allowed']);
      expect(replacement.jobId).not.toBe(old.jobId);
      expect((await call('complete', old.jobId!)).error).toBeDefined();
      expect((await secondCall('complete', replacement.jobId!)).error).toBeUndefined();
      expect((await secondCall('claim')).jobId).toBeNull();
      await controller.reloadFromStorage();
      expect(controller.listGraphProjectionJobs().filter(job => job.status === 'completed').flatMap(job => job.sourceEventIds)).toEqual(['allowed']);
      expect(controller.listAllEvents().find(event => event.id === 'forgotten')!.status).toBe('forgotten');
    } finally {
      await Promise.all(children.map(child => new Promise<void>(resolve => {
        if (child.exitCode !== null) return resolve();
        child.once('exit', () => resolve()); child.kill();
      })));
      await controller.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);
});
