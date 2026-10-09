import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StrataGate, DERIVATION_LEASE_MS, StorageConflictError, searchTokens } from '../src/index.js';
import { SqliteStorage } from '../src/sqlite.js';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function filename() { const root = await mkdtemp(join(tmpdir(), 'schedule-128-')); roots.push(root); return join(root, 'memory.db'); }
const summary = async () => ({ l0Title: 'stored', l0Tags: [], l1Summary: 'stored', l2Keypoints: [], shouldExtract: false });

describe('rebuildable SQLite background schedule', () => {
  it('rebuilds legacy keys in resumable batches without loading full memories and preserves a concurrent task write', async () => {
    const database = await filename();
    for (let i = 0; i < 11; i++) {
      const seed = await StrataGate.open({ database, namespace: `ns:${i}`, blockTurnSize: 1, summarizer: summary });
      await seed.appendTurn({ user: `history ${i}`, assistant: 'saved' }); await seed.close();
    }
    const old = new DatabaseSync(database);
    old.exec('DROP TABLE background_work_schedule; DELETE FROM background_work_dirty'); old.close();
    const loads = vi.spyOn(SqliteStorage.prototype, 'load');
    const storage = new SqliteStorage({ filename: database });
    try {
      expect(await storage.rebuildBackgroundWorkIndex(2)).toBe(true);
      const writer = await StrataGate.open({ database, namespace: 'ns:9', blockTurnSize: 1 });
      await writer.appendTurn({ user: 'new task during upgrade', assistant: 'saved' }, { deferDerivation: true }); await writer.close();
      loads.mockClear();
      while (await storage.rebuildBackgroundWorkIndex(2)) { /* one restart-safe batch */ }
      expect(loads).not.toHaveBeenCalled();
      expect(storage.dueBackgroundNamespaces()).toEqual(['ns:9']);
      storage.rebuildBackgroundWorkSchedule();
      await storage.close();
      const reopened = new SqliteStorage({ filename: database });
      try {
        while (await reopened.rebuildBackgroundWorkIndex(2)) { /* finish after restart */ }
        expect(reopened.dueBackgroundNamespaces()).toEqual(['ns:9']);
      } finally { await reopened.close(); }
    } finally { await storage.close(); }
  });

  it('publishes scheduling state in the task transaction, and a revision conflict leaves both unchanged', async () => {
    const database = await filename();
    const memory = await StrataGate.open({ database, namespace: 'atomic', blockTurnSize: 1 });
    const revision = memory.storageRevision;
    const stale = memory.exportSnapshot();
    await memory.appendTurn({ user: 'queued', assistant: 'saved' }, { deferDerivation: true });
    const storage = new SqliteStorage({ filename: database });
    try {
      expect(storage.dueBackgroundNamespaces()).toEqual(['atomic']);
      await expect(storage.save('atomic', stale, revision)).rejects.toBeInstanceOf(StorageConflictError);
      expect(storage.dueBackgroundNamespaces()).toEqual(['atomic']);
      const db = new DatabaseSync(database);
      try {
        db.exec(`CREATE TRIGGER reject_schedule BEFORE INSERT ON background_work_schedule
          BEGIN SELECT RAISE(ABORT, 'schedule write failed'); END`);
        const changed = memory.exportSnapshot(); changed.currentTurn++;
        await expect(storage.save('atomic', changed, memory.storageRevision)).rejects.toThrow('schedule write failed');
        expect(storage.namespaceRevision('atomic')).toBe(memory.storageRevision);
        expect(storage.dueBackgroundNamespaces()).toEqual(['atomic']);
      } finally { db.close(); }
    } finally { await storage.close(); await memory.close(); }
  });

  it('discards a rebuild when another writer changes its generation during a yield', async () => {
    const database = await filename();
    const seed = await StrataGate.open({ database, namespace: 'changed', blockTurnSize: 1, summarizer: summary });
    await seed.appendTurn({ user: 'source', assistant: 'saved' }); await seed.close();
    const storage = new SqliteStorage({ filename: database });
    try {
      storage.rebuildBackgroundWorkSchedule();
      const rebuilding = storage.rebuildBackgroundWorkIndex();
      const writer = new DatabaseSync(database);
      try { writer.exec("UPDATE blocks SET processing_status = 'pending'; UPDATE block_summary_jobs SET status = 'pending', attempts = 0"); }
      finally { writer.close(); }
      expect(await rebuilding).toBe(true);
      expect(storage.dueBackgroundNamespaces()).toEqual([]);
      expect(await storage.rebuildBackgroundWorkIndex()).toBe(false);
      expect(storage.dueBackgroundNamespaces()).toEqual(['changed']);
    } finally { await storage.close(); }
  });

  it('isolates a corrupt scheduling payload without starving healthy work or spinning on the failed key', async () => {
    const database = await filename();
    for (const namespace of ['bad', 'healthy']) {
      const seed = await StrataGate.open({ database, namespace, blockTurnSize: 1 });
      await seed.appendTurn({ user: 'pending', assistant: 'saved' }, { deferDerivation: true }); await seed.close();
    }
    const db = new DatabaseSync(database);
    db.exec("UPDATE graph_state SET jobs_json = 'invalid' WHERE namespace = 'bad'"); db.close();
    const storage = new SqliteStorage({ filename: database });
    const errors = vi.fn();
    try {
      storage.rebuildBackgroundWorkSchedule();
      expect(await storage.rebuildBackgroundWorkIndex(8, errors)).toBe(false);
      expect(errors).toHaveBeenCalledTimes(1);
      expect(storage.dueBackgroundNamespaces()).toEqual(['healthy']);
    } finally { await storage.close(); }
  });

  it('does not reset another writer\'s live Summary lease or duplicate its model claim', async () => {
    const database = await filename();
    let finish!: (result: Awaited<ReturnType<typeof summary>>) => void;
    const model = vi.fn(() => new Promise<Awaited<ReturnType<typeof summary>>>((resolve) => { finish = resolve; }));
    const first = await StrataGate.open({ database, namespace: 'leased', blockTurnSize: 1, summarizer: model });
    await first.appendTurn({ user: 'one task', assistant: 'saved' }, { deferDerivation: true });
    const running = first.resumePendingWork();
    await vi.waitFor(() => expect(model).toHaveBeenCalledTimes(1));
    const revision = first.storageRevision;
    const second = await StrataGate.open({ database, namespace: 'leased', blockTurnSize: 1, summarizer: model });
    try {
      expect(second.storageRevision).toBe(revision);
      await second.resumePendingWork(); expect(model).toHaveBeenCalledTimes(1);
      expect(second.listSummaryJobs()[0]!.status).toBe('running');
      const storage = new SqliteStorage({ filename: database });
      try {
        expect(storage.dueBackgroundNamespaces(Date.now())).toEqual([]);
        expect(storage.nextBackgroundWorkAt(false)).toBe(Date.parse(first.listSummaryJobs()[0]!.leaseUntil!));
      } finally { await storage.close(); }
      finish(await summary()); await running;
      await second.reloadFromStorage();
      expect(second.listSummaryJobs()[0]!).toMatchObject({ status: 'succeeded', attempts: 1 });
    } finally { await second.close(); await first.close(); }
  });

  it.each(['summary', 'extraction', 'graph'] as const)('discovers interrupted %s work at lease expiry, preserves retries and the attempt limit', async (kind) => {
    const database = await filename(); let clock = Date.now();
    const namespace = `restart:${kind}`;
    const seed = await StrataGate.open({ database, namespace, blockTurnSize: 1, summarizer: summary,
      graphProjector: async () => ({ reason: 'none', nodes: [], edges: [] }), now: () => new Date(clock) });
    const block = (await seed.appendTurn({ user: 'source', assistant: 'saved' })).sealedBlock!;
    if (kind === 'graph') await seed.addEvent({ title: 'Durable event', summary: 'A project choice.', sourceBlockId: block.id,
      sourceMessageIds: [block.l5Raw[0]!.id] });
    const snapshot = seed.exportSnapshot(); const leaseUntil = new Date(clock + DERIVATION_LEASE_MS).toISOString();
    if (kind === 'summary') {
      snapshot.blocks[0]!.processingStatus = 'pending'; snapshot.summaryJobs[0] = { ...snapshot.summaryJobs[0]!, status: 'running', attempts: 1, leaseUntil };
    } else if (kind === 'extraction') {
      snapshot.blocks[0]!.processingStatus = 'pending'; snapshot.blocks[0]!.shouldExtract = true;
      snapshot.extractionJobs[0] = { blockId: block.id, status: 'running', attempts: 1, nextRetryAt: null, lastError: null, updatedAt: new Date(clock).toISOString(), leaseUntil };
    } else Object.assign(snapshot.graphProjectionJobs[0]!, { status: 'running', attempts: 1, leaseUntil });
    const storage = new SqliteStorage({ filename: database });
    try { await storage.save(namespace, snapshot, seed.storageRevision); } finally { await seed.close(); }
    // Topic work is independent; isolate the Core scheduling deadline here.
    expect(storage.dueBackgroundNamespaces(clock, false)).toEqual([]);
    expect(storage.dueBackgroundNamespaces(clock + DERIVATION_LEASE_MS, false)).toEqual([namespace]);
    clock += DERIVATION_LEASE_MS + 1;
    const failing = vi.fn(async () => { throw new Error('transient provider failure'); });
    const resumed = await StrataGate.open({ database, namespace, blockTurnSize: 1, now: () => new Date(clock),
      summarizer: kind === 'summary' ? failing : summary,
      ...(kind === 'extraction' ? { extractor: failing } : {}),
      ...(kind === 'graph' ? { graphProjector: failing } : {}) });
    try {
      if (kind === 'graph') clock += 30_000; // existing Graph interruption recovery backoff
      await resumed.resumePendingWork();
      const job = kind === 'summary' ? resumed.listSummaryJobs()[0]! : kind === 'extraction' ? resumed.listExtractionJobs()[0]! : resumed.listGraphProjectionJobs()[0]!;
      expect(job).toMatchObject({ status: 'failed', attempts: 2 });
      const retry = Date.parse(job.nextRetryAt!);
      expect(storage.dueBackgroundNamespaces(clock, false)).toEqual([]);
      expect(storage.dueBackgroundNamespaces(retry, false)).toEqual([namespace]);
      clock = retry + 1; await resumed.resumePendingWork();
      const terminal = kind === 'summary' ? resumed.listSummaryJobs()[0]! : kind === 'extraction' ? resumed.listExtractionJobs()[0]! : resumed.listGraphProjectionJobs()[0]!;
      expect(terminal).toMatchObject({ status: 'failed', attempts: 3, nextRetryAt: null });
      expect(storage.dueBackgroundNamespaces(clock + 100_000, false)).toEqual([]);
      expect(failing).toHaveBeenCalledTimes(2);
    } finally { await resumed.close(); await storage.close(); }
  });

  it('claims Graph and Topic atomically across simultaneous connections without losing the loser\'s work', async () => {
    const database = await filename();
    const options = { database, namespace: 'race', blockTurnSize: 1, summarizer: summary,
      graphProjector: async () => ({ reason: 'none', nodes: [], edges: [] }) };
    const first = await StrataGate.open(options);
    const block = (await first.appendTurn({ user: 'source', assistant: 'saved' })).sealedBlock!;
    await first.addEvent({ title: 'Decision', summary: 'A lasting decision.', sourceBlockId: block.id, sourceMessageIds: [block.l5Raw[0]!.id] });
    const second = await StrataGate.open(options);
    try {
      const graph = await Promise.allSettled([first.claimNextGraphProjection(), second.claimNextGraphProjection()]);
      expect(graph.filter((result) => result.status === 'fulfilled' && result.value)).toHaveLength(1);
      expect(graph.filter((result) => result.status === 'rejected')).toHaveLength(1);
      await second.reloadFromStorage(); expect(await second.claimNextGraphProjection()).toBeNull();
      await first.reloadFromStorage(); await second.reloadFromStorage();
      const topic = await Promise.allSettled([first.claimNextTopicProjection(), second.claimNextTopicProjection()]);
      expect(topic.filter((result) => result.status === 'fulfilled' && result.value)).toHaveLength(1);
      expect(topic.filter((result) => result.status === 'rejected')).toHaveLength(1);
      await second.reloadFromStorage(); expect(await second.claimNextTopicProjection()).toBeNull();
      const graphWinner = graph.find((result) => result.status === 'fulfilled' && result.value)!;
      const topicWinner = topic.find((result) => result.status === 'fulfilled' && result.value)!;
      expect(graphWinner.status === 'fulfilled' && graphWinner.value!.events).toHaveLength(1);
      expect(topicWinner.status === 'fulfilled' && topicWinner.value!.events).toHaveLength(1);
    } finally { await first.close(); await second.close(); }
  });

  it('allows only one Graph/Topic claimant across two OS processes and keeps the other queued Graph task', async () => {
    const database = await filename();
    const seed = await StrataGate.open({ database, namespace: 'process-race', blockTurnSize: 1, summarizer: summary,
      graphProjector: async () => ({ reason: 'none', nodes: [], edges: [] }) });
    const block = (await seed.appendTurn({ user: 'source', assistant: 'saved' })).sealedBlock!;
    for (const title of ['First decision', 'Second decision']) await seed.addEvent({ title, summary: 'A durable project decision.',
      sourceBlockId: block.id, sourceMessageIds: [block.l5Raw[0]!.id] });
    await seed.close();
    const storeUrl = new URL('../src/store.ts', import.meta.url).href;
    // Load the actual TS sources in separate Node processes. The hook only transpiles
    // modules; all SQLite reads, claims, leases and optimistic writes are production code.
    const childCode = `
      const { registerHooks } = require('node:module'); const fs = require('node:fs');
      const { fileURLToPath, pathToFileURL } = require('node:url'); const ts = require('typescript');
      registerHooks({
        resolve(specifier, context, next) {
          if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.startsWith('file:')) {
            const url = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);
            if (fs.existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
          }
          return next(specifier, context);
        },
        load(url, context, next) {
          if (url.startsWith('file:') && url.endsWith('.ts')) return { format: 'module', shortCircuit: true,
            source: ts.transpileModule(fs.readFileSync(fileURLToPath(url), 'utf8'), { compilerOptions:
              { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText };
          return next(url, context);
        }
      });
      (async () => {
        const { StrataGate } = await import(process.argv[2]);
        const memory = await StrataGate.open({ database: process.argv[1], namespace: 'process-race', blockTurnSize: 1,
          graphProjector: async () => ({ reason: 'none', nodes: [], edges: [] }) });
        process.stdout.write('ready\\n');
        await new Promise(resolve => process.stdin.once('data', resolve));
        let result;
        try { const job = await (process.argv[3] === 'graph' ? memory.claimNextGraphProjection() : memory.claimNextTopicProjection());
          result = { claimed: job?.jobId ?? null }; }
        catch (error) { result = { error: error.name }; }
        await memory.close(); process.stdout.write(JSON.stringify(result) + '\\n'); process.stdin.destroy();
      })().catch(error => { process.stderr.write(String(error)); process.exitCode = 1; process.stdin.destroy(); });
    `;
    async function race(kind: string) {
      const children = [0, 1].map(() => {
        const child = spawn(process.execPath, ['-e', childCode, database, storeUrl, kind],
          { cwd: fileURLToPath(new URL('..', import.meta.url)), windowsHide: true });
        let stdout = '', stderr = ''; let ready!: () => void;
        const readyPromise = new Promise<void>((resolve) => { ready = resolve; });
        child.stdout.on('data', (data) => { stdout += data; if (stdout.includes('ready\n')) ready(); });
        child.stderr.on('data', (data) => { stderr += data; });
        const done = new Promise<{ claimed?: string | null; error?: string }>((resolve, reject) => {
          child.on('error', reject);
          child.on('exit', (code) => code === 0 ? resolve(JSON.parse(stdout.trim().split('\n').at(-1)!)) : reject(new Error(stderr)));
        });
        return { child, readyPromise, done };
      });
      try {
        await Promise.all(children.map(({ readyPromise, done }) => Promise.race([readyPromise, done.then(() => { throw new Error('child exited before barrier'); })])));
        for (const { child } of children) child.stdin.end('claim');
        const results = await Promise.all(children.map(({ done }) => done));
        expect(results.filter(({ claimed }) => claimed)).toHaveLength(1);
        expect(results.filter(({ error }) => error === 'StorageConflictError')).toHaveLength(1);
      } finally { for (const { child } of children) if (child.exitCode === null) child.kill(); }
    }
    await race('graph');
    await race('topic');
    const check = new SqliteStorage({ filename: database, readonly: true });
    try {
      const state = (await check.load('process-race'))!.snapshot;
      expect(state.graphProjectionJobs.filter(({ status }) => status === 'running')).toHaveLength(1);
      expect(state.graphProjectionJobs.filter(({ status }) => status === 'pending')).toHaveLength(1);
      expect(state.memoryTopicState!.jobs.filter(({ status }) => status === 'running')).toHaveLength(1);
    } finally { await check.close(); }
    const writer = new SqliteStorage({ filename: database });
    try { expect(writer.dueBackgroundNamespaces(Date.now(), false)).toEqual(['process-race']); }
    finally { await writer.close(); }
  }, 20_000);

  it('opens FTS without namespace scans and lazily backfills only the searched namespace; supports explicit repair', async () => {
    const database = await filename();
    for (const namespace of ['a', 'b']) {
      const seed = await StrataGate.open({ database, namespace, blockTurnSize: 1, summarizer: summary });
      await seed.appendTurn({ user: `unique ${namespace}`, assistant: 'stored' }); await seed.close();
    }
    const legacy = new DatabaseSync(database);
    legacy.exec('DROP TABLE raw_message_fts; DROP TABLE raw_message_fts_meta; DROP TABLE raw_message_fts_state'); legacy.close();
    const prepares = vi.spyOn(DatabaseSync.prototype, 'prepare');
    const storage = new SqliteStorage({ filename: database });
    try {
      const sql = prepares.mock.calls.map(([query]) => query).join('\n');
      expect(sql).not.toMatch(/SELECT namespace FROM memory_spaces|COUNT\(\*\).*messages|SELECT.*content.*FROM messages/i);
      const db = new DatabaseSync(database);
      try {
        expect(db.prepare('SELECT COUNT(*) AS count FROM raw_message_fts_meta').get()).toEqual({ count: 0 });
        expect(storage.searchRawMessageIds('a', searchTokens('unique'), 10)).toHaveLength(1);
        expect(db.prepare("SELECT COUNT(*) AS count FROM raw_message_fts_meta WHERE namespace = 'b'").get()).toEqual({ count: 0 });
        db.exec("DELETE FROM raw_message_fts WHERE namespace = 'a'");
        storage.rebuildRawSearchIndex('a');
        expect(storage.searchRawMessageIds('a', searchTokens('unique'), 10)).toHaveLength(1);
      } finally { db.close(); }
    } finally { await storage.close(); }
  });

  it('repairs rows written before dirty tracking existed, without trusting the old complete marker', async () => {
    const database = await filename();
    const seed = await StrataGate.open({ database, namespace: 'legacy', blockTurnSize: 1, summarizer: summary });
    await seed.appendTurn({ user: 'old source', assistant: 'saved' }); await seed.close();
    const old = new DatabaseSync(database);
    old.exec('DROP TRIGGER raw_fts_dirty_INSERT; DROP TRIGGER raw_fts_dirty_UPDATE; DROP TRIGGER raw_fts_dirty_DELETE; DROP TABLE raw_message_fts_dirty');
    old.exec(`INSERT INTO messages SELECT namespace, 'pre-trigger-row', block_id, thread_id, 99, role,
      'legacy-gap unique source', created_at, tool_calls_json FROM messages WHERE role = 'user' LIMIT 1`);
    old.close();
    const storage = new SqliteStorage({ filename: database });
    try { expect(storage.searchRawMessageIds('legacy', searchTokens('legacy-gap'), 10)).toContain('pre-trigger-row'); }
    finally { await storage.close(); }
  });

  it('indexes a dynamic Topic failure at its durable retry time and resumes it after restart', async () => {
    const database = await filename(); let clock = Date.now();
    const options = { database, namespace: 'topic-retry', blockTurnSize: 1, summarizer: summary,
      graphProjector: async () => ({ reason: 'none', nodes: [], edges: [] }), now: () => new Date(clock) };
    const memory = await StrataGate.open(options);
    const block = (await memory.appendTurn({ user: 'source', assistant: 'saved' })).sealedBlock!;
    await memory.addEvent({ title: 'A decision', summary: 'A durable decision.', sourceBlockId: block.id, sourceMessageIds: [block.l5Raw[0]!.id] });
    expect(memory.listTopicProjectionJobs()).toEqual([]); // work exists before any Job is created
    const graph = (await memory.claimNextGraphProjection())!;
    await memory.completeGraphProjection(graph.jobId, { reason: 'none', nodes: [], edges: [] });
    const storage = new SqliteStorage({ filename: database });
    try {
      expect(storage.dueBackgroundNamespaces(clock)).toEqual(['topic-retry']);
      const job = (await memory.claimNextTopicProjection('incremental'))!;
      await memory.failTopicProjection(job.jobId, new Error('temporary model failure'));
      const retry = Date.parse(memory.listTopicProjectionJobs()[0]!.nextRetryAt!);
      expect(storage.dueBackgroundNamespaces(clock)).toEqual([]);
      expect(storage.nextBackgroundWorkAt()).toBe(retry);
      await memory.close(); clock = retry + 1;
      const reopened = await StrataGate.open(options);
      try {
        const claimed = (await reopened.claimNextTopicProjection('incremental'))!;
        expect(claimed.jobId).not.toBe(job.jobId);
        expect(reopened.listTopicProjectionJobs().find(({ id }) => id === claimed.jobId)!.attempts).toBe(2);
        await reopened.completeTopicProjection(claimed.jobId, { topics: [{ title: 'Project', description: 'Project decisions.',
          sourceEventIds: claimed.events.map(({ id }) => id), sections: [{ title: 'Decisions', sourceEventIds: claimed.events.map(({ id }) => id) }], overview: [] }] });
        expect(storage.dueBackgroundNamespaces(clock)).toEqual([]);
      } finally { await reopened.close(); }
    } finally { await memory.close(); await storage.close(); }
  });
});
