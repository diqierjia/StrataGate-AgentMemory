import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StrataGate, DERIVATION_LEASE_MS, StorageConflictError, searchTokens, MemoryTopicDirectory,
  TopicProjectionError, TOPIC_RECOVERY_VERSION, type TopicProjectionResult } from '../src/index.js';
import { SqliteStorage } from '../src/sqlite.js';

const roots: string[] = [];
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function filename() { const root = await mkdtemp(join(tmpdir(), 'schedule-128-')); roots.push(root); return join(root, 'memory.db'); }
const summary = async () => ({ l0Title: 'stored', l0Tags: [], l1Summary: 'stored', l2Keypoints: [], shouldExtract: false });

describe('rebuildable SQLite background schedule', () => {
  it.each(['missing', 'outdated'] as const)('invalidates %s index rules once so an idle legacy Topic failure is recovered without loading history', async (version) => {
    const database = await filename();
    const namespace = 'legacy-topic-recovery';
    const memory = StrataGate.inMemory({ blockTurnSize: 1, summarizer: summary });
    const block = (await memory.appendTurn({ user: 'source', assistant: 'saved' })).sealedBlock!;
    await memory.addEvent({ title: 'Decision', summary: 'A durable decision.', sourceBlockId: block.id,
      sourceMessageIds: [block.l5Raw[0]!.id] });
    const events = memory.listEvents();
    const directory = new MemoryTopicDirectory();
    let clock = Date.now();
    directory.initializeBootstrap(events, new Date(clock).toISOString());
    for (let attempt = 0; attempt < 3; attempt++) {
      const claim = directory.claim(events, new Date(clock).toISOString(), 'bootstrap')!;
      directory.fail(claim.jobId, new TopicProjectionError('provider-failed', 'provider or route error'), new Date(clock).toISOString());
      clock += 120_000;
    }
    const state = directory.snapshot();
    expect(state.jobs.at(-1)).toMatchObject({ status: 'failed', attempts: 3, nextRetryAt: null });
    state.recoveryVersion = TOPIC_RECOVERY_VERSION - 1;
    const snapshot = memory.exportSnapshot(); snapshot.memoryTopicState = state;
    const creator = new SqliteStorage({ filename: database });
    await creator.save(namespace, snapshot, 0); await creator.close(); await memory.close();
    const db = new DatabaseSync(database);
    try {
      // The previous recovery rules indexed this terminal failure as idle.
      db.exec('DELETE FROM background_work_schedule; DELETE FROM background_work_dirty');
      if (version === 'missing') db.exec('DROP TABLE background_work_index_meta');
      else db.exec("UPDATE background_work_index_meta SET format_version = 'legacy-rules'");
      const revision = db.prepare('SELECT revision FROM memory_spaces WHERE namespace = ?').get(namespace);
      const loads = vi.spyOn(SqliteStorage.prototype, 'load');
      const upgraded = new SqliteStorage({ filename: database });
      try {
        expect(loads).not.toHaveBeenCalled();
        expect(db.prepare('SELECT revision FROM memory_spaces WHERE namespace = ?').get(namespace)).toEqual(revision);
        expect(db.prepare('SELECT COUNT(*) AS count FROM background_work_dirty').get()).toEqual({ count: 1 });
        while (await upgraded.rebuildBackgroundWorkIndex(1)) { /* bounded rebuild */ }
        expect(loads).not.toHaveBeenCalled();
        expect(db.prepare("SELECT due_at FROM background_work_schedule WHERE namespace = ? AND kind = 'bootstrap'").get(namespace))
          .toEqual({ due_at: 0 });
      } finally { await upgraded.close(); }
      const reopened = new SqliteStorage({ filename: database });
      await reopened.close();
      expect(loads).not.toHaveBeenCalled();
      expect(db.prepare('SELECT COUNT(*) AS count FROM background_work_dirty').get()).toEqual({ count: 0 });
      const recovered = await StrataGate.open({ database, namespace, blockTurnSize: 1, summarizer: summary });
      try {
        const claim = (await recovered.claimNextTopicProjection('bootstrap'))!;
        expect(claim).not.toBeNull();
        expect(recovered.listTopicProjectionJobs().find(({ id }) => id === claim.jobId)!.attempts).toBe(1);
        await recovered.completeTopicProjection(claim.jobId, { topics: [{ title: 'Project', description: 'Decisions',
          sourceEventIds: claim.events.map(({ id }) => id), overview: [],
          sections: [{ title: 'Decisions', sourceEventIds: claim.events.map(({ id }) => id) }] }] });
        expect(recovered.exportSnapshot().memoryTopicState!.recoveryVersion).toBe(TOPIC_RECOVERY_VERSION);
      } finally { await recovered.close(); }
    } finally { db.close(); }
  });

  it('rebuilds legacy keys in resumable batches without loading full memories and preserves a concurrent task write', async () => {
    const database = await filename();
    const seed = StrataGate.inMemory({ blockTurnSize: 1, summarizer: summary });
    await seed.appendTurn({ user: 'history', assistant: 'saved' });
    const creator = new SqliteStorage({ filename: database });
    try { for (let i = 0; i < 11; i++) await creator.save(`ns:${i}`, seed.exportSnapshot(), 0); }
    finally { await creator.close(); await seed.close(); }
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

  it('upgrades the previous derived-index schema and UPDATE triggers without loading raw history', async () => {
    const database = await filename();
    const seed = await StrataGate.open({ database, namespace: 'upgrade', blockTurnSize: 1, summarizer: summary });
    await seed.appendTurn({ user: 'unchanged source', assistant: 'stored' }); await seed.close();
    const db = new DatabaseSync(database);
    try {
      for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name GLOB 'background_dirty_*'").all() as Array<{ name: string }>) db.exec(`DROP TRIGGER "${name}"`);
      db.exec('DROP INDEX background_dirty_due; ALTER TABLE background_work_dirty DROP COLUMN rebuild_after; DROP TRIGGER raw_fts_dirty_UPDATE_v2');
      db.exec(`CREATE TRIGGER raw_fts_dirty_UPDATE AFTER UPDATE ON messages BEGIN
        INSERT OR IGNORE INTO raw_message_fts_dirty(namespace, message_id) VALUES (new.namespace, new.id); END`);
      const loads = vi.spyOn(SqliteStorage.prototype, 'load'); const prepares = vi.spyOn(DatabaseSync.prototype, 'prepare');
      const storage = new SqliteStorage({ filename: database });
      try {
        expect(loads).not.toHaveBeenCalled();
        expect(prepares.mock.calls.map(([sql]) => sql).join('\n')).not.toMatch(/SELECT.*content.*FROM messages/i);
        expect((db.prepare("PRAGMA table_info('background_work_dirty')").all() as Array<{ name: string }>).some(({ name }) => name === 'rebuild_after')).toBe(true);
        db.exec('UPDATE messages SET content = content');
        expect(db.prepare('SELECT COUNT(*) AS count FROM raw_message_fts_dirty').get()).toEqual({ count: 0 });
        db.exec("UPDATE block_summary_jobs SET status = 'pending', attempts = 0; UPDATE blocks SET processing_status = 'pending'");
        expect(await storage.rebuildBackgroundWorkIndex()).toBe(false);
        expect(storage.dueBackgroundNamespaces()).toEqual(['upgrade']);
      } finally { await storage.close(); }
    } finally { db.close(); }
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

  it('backs off eight corrupt keys across restart while the ninth healthy task gets indexed; repairs wake immediately', async () => {
    const database = await filename();
    const seed = StrataGate.inMemory({ blockTurnSize: 1 });
    await seed.appendTurn({ user: 'pending', assistant: 'stored' }, { deferDerivation: true });
    let storage = new SqliteStorage({ filename: database });
    const db = new DatabaseSync(database);
    const errors = vi.fn();
    try {
      for (let index = 0; index < 9; index++) await storage.save(`ns:${index}`, seed.exportSnapshot(), 0);
      db.exec("UPDATE graph_state SET jobs_json = 'invalid' WHERE namespace < 'ns:8'");
      // Keep the previously due schedule: dirty keys must not use stale entries.
      db.exec('INSERT OR IGNORE INTO background_work_dirty(namespace) SELECT namespace FROM memory_spaces');
      expect(await storage.rebuildBackgroundWorkIndex(8, errors)).toBe(true);
      expect(errors).toHaveBeenCalledTimes(8);
      await storage.close(); storage = new SqliteStorage({ filename: database });
      expect(await storage.rebuildBackgroundWorkIndex(8, errors)).toBe(false);
      expect(storage.dueBackgroundNamespaces()).toEqual(['ns:8']);
      for (let round = 0; round < 10; round++) expect(await storage.rebuildBackgroundWorkIndex(8, errors)).toBe(false);
      expect(errors).toHaveBeenCalledTimes(8);
      expect(db.prepare('SELECT COUNT(*) AS count FROM background_work_dirty WHERE rebuild_after > ?').get(Date.now())).toEqual({ count: 8 });
      // Cooldown expires durably, and each failed key is still retried.
      db.exec('UPDATE background_work_dirty SET rebuild_after = 0');
      expect(await storage.rebuildBackgroundWorkIndex(8, errors)).toBe(false);
      expect(errors).toHaveBeenCalledTimes(16);
      // A direct SQL repair invalidates the old generation and resets cooldown.
      db.exec("UPDATE graph_state SET jobs_json = '[]' WHERE namespace = 'ns:0'");
      expect(await storage.rebuildBackgroundWorkIndex(8, errors)).toBe(false);
      expect(storage.dueBackgroundNamespaces()).toEqual(['ns:0', 'ns:8']);
      expect(errors).toHaveBeenCalledTimes(16);
    } finally { db.close(); await storage.close(); await seed.close(); }
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

  it.each(['summary', 'extraction', 'graph', 'topic'] as const)('refreshes cached %s leases renewed by another OS process at the same revision, allowing other work', async (kind) => {
    const database = await filename(); const namespace = 'cached-lease'; let clock = Date.now();
    const seed = await StrataGate.open({ database, namespace, blockTurnSize: 1, summarizer: summary, now: () => new Date(clock),
      ...(kind === 'graph' ? { graphProjector: async () => ({ reason: 'none', nodes: [], edges: [] }) } : {}) });
    const first = (await seed.appendTurn({ user: 'owned by A', assistant: 'stored', threadId: 'owner' })).sealedBlock!;
    if (kind === 'graph' || kind === 'topic') await seed.addEvent({ title: 'decision', summary: 'durable',
      sourceBlockId: first.id, sourceMessageIds: [first.l5Raw[0]!.id] });
    if (kind === 'topic') expect(await seed.claimNextTopicProjection()).not.toBeNull();
    const other = (await seed.appendTurn({ user: 'work for B', assistant: 'stored', threadId: 'other' }, { deferDerivation: true })).sealedBlock!;
    const snapshot = seed.exportSnapshot();
    const jobOf = (state: typeof snapshot) => kind === 'summary' ? state.summaryJobs.find((job) => job.blockId === first.id)!
      : kind === 'extraction' ? state.extractionJobs.find((job) => job.blockId === first.id)!
      : kind === 'graph' ? state.graphProjectionJobs[0]! : state.memoryTopicState!.jobs[0]!;
    const job = jobOf(snapshot);
    Object.assign(job, { status: 'running', attempts: 1, leaseUntil: new Date(clock + DERIVATION_LEASE_MS).toISOString() });
    if (kind === 'summary' || kind === 'extraction') snapshot.blocks[0]!.processingStatus = 'pending';
    if (kind === 'extraction') snapshot.blocks[0]!.shouldExtract = true;
    const storage = new SqliteStorage({ filename: database });
    await storage.save(namespace, snapshot, seed.storageRevision); await storage.close(); await seed.close();
    const model = vi.fn(summary);
    const options = { database, namespace, blockTurnSize: 1, summarizer: model, now: () => new Date(clock) };
    const cached = await StrataGate.open(options); const observer = await StrataGate.open(options);
    const revision = cached.storageRevision; const loads = vi.spyOn(SqliteStorage.prototype, 'load');
    try {
      // A renews after B has loaded the old claim. Use the actual renewal API in
      // a separate OS process; this write intentionally leaves revision unchanged.
      const sqliteUrl = new URL('../src/sqlite.ts', import.meta.url).href;
      const code = `
        const { registerHooks } = require('node:module'); const fs = require('node:fs');
        const { fileURLToPath } = require('node:url'); const ts = require('typescript');
        registerHooks({ resolve(s,c,next) {
          if(s.startsWith('.') && s.endsWith('.js') && c.parentURL?.startsWith('file:')) {
            const u=new URL(s.slice(0,-3)+'.ts',c.parentURL); if(fs.existsSync(fileURLToPath(u))) return {url:u.href,shortCircuit:true};
          } return next(s,c);
        }, load(u,c,next) {
          if(u.endsWith('.ts')) return {format:'module',shortCircuit:true,source:ts.transpileModule(fs.readFileSync(fileURLToPath(u),'utf8'),
            {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText}; return next(u,c);
        }});
        (async()=>{ const {SqliteStorage}=await import(${JSON.stringify(sqliteUrl)});
          const storage=new SqliteStorage({filename:${JSON.stringify(database)}});
          const until=await storage.renewDerivationLease(${JSON.stringify(namespace)},${JSON.stringify(kind)},
            ${JSON.stringify('blockId' in job ? job.blockId : job.id)},1,${JSON.stringify(job.updatedAt)},${clock + 200_000});
          await storage.close(); console.log(JSON.stringify({until}));
        })().catch(e=>{console.error(e);process.exitCode=1});`;
      const output = await new Promise<string>((resolve, reject) => {
        const child = spawn(process.execPath, ['-e', code], { cwd: fileURLToPath(new URL('../../../', import.meta.url)), windowsHide: true });
        let stdout = ''; let stderr = '';
        child.stdout.on('data', (data) => { stdout += data; }); child.stderr.on('data', (data) => { stderr += data; });
        child.on('error', reject); child.on('exit', (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr)));
      });
      const until = (JSON.parse(output) as { until: string }).until;
      expect(until).not.toBeNull();
      clock += DERIVATION_LEASE_MS + 1;
      expect(Date.parse(jobOf(cached.exportSnapshot()).leaseUntil!)).toBeLessThan(clock);
      expect(cached.storageRevision).toBe(revision);
      const refreshed = await observer.reloadFromStorage();
      await observer.refreshFromStorage();
      // B never explicitly reloads. Recovery/Topic claim must first synchronize
      // the cached deadline, rather than fail on A's still-owned durable claim.
      if (kind === 'topic') expect(await cached.claimNextTopicProjection()).toBeNull();
      const resumed = await cached.resumePendingWork({ threadId: 'other' });
      expect(refreshed).toBe(true);
      expect(observer.storageRevision).toBe(revision);
      expect(jobOf(observer.exportSnapshot()).leaseUntil).toBe(until);
      expect(jobOf(cached.exportSnapshot())).toMatchObject({ status: 'running', attempts: 1, leaseUntil: until });
      expect(resumed.readyBlocks.map(({ id }) => id)).toEqual([other.id]);
      expect(model).toHaveBeenCalledTimes(1);
      for (let round = 0; round < 3; round++) await cached.resumePendingWork({ threadId: 'other' });
      expect(model).toHaveBeenCalledTimes(1);
      expect(loads).not.toHaveBeenCalled();
    } finally { await cached.close(); await observer.close(); }
  }, 20_000);

  it.each(['attempt', 'status'] as const)('reloads authoritative business state when a running claim changes %s without a revision', async (change) => {
    const database = await filename(); const namespace = 'identity-change'; const clock = Date.now();
    const seed = await StrataGate.open({ database, namespace, blockTurnSize: 1 });
    const block = (await seed.appendTurn({ user: 'source', assistant: 'stored' }, { deferDerivation: true })).sealedBlock!;
    const state = seed.exportSnapshot();
    Object.assign(state.summaryJobs[0]!, { status: 'running', attempts: 1, leaseUntil: new Date(clock + DERIVATION_LEASE_MS).toISOString() });
    const storage = new SqliteStorage({ filename: database }); await storage.save(namespace, state, seed.storageRevision);
    await storage.close(); await seed.close();
    const memory = await StrataGate.open({ database, namespace, blockTurnSize: 1 });
    const revision = memory.storageRevision; const db = new DatabaseSync(database);
    const loads = vi.spyOn(SqliteStorage.prototype, 'load');
    try {
      db.prepare(`UPDATE block_summary_jobs SET ${change === 'attempt' ? 'attempts = 2' : "status = 'succeeded'"} WHERE namespace = ? AND block_id = ?`).run(namespace, block.id);
      expect(await memory.reloadFromStorage()).toBe(true);
      expect(memory.storageRevision).toBe(revision);
      expect(memory.listSummaryJobs()[0]).toMatchObject(change === 'attempt' ? { status: 'running', attempts: 2 } : { status: 'succeeded', attempts: 1 });
      expect(loads).toHaveBeenCalledTimes(1);
    } finally { db.close(); await memory.close(); }
  });

  it.each(['summary', 'extraction', 'graph'] as const)('merges %s heartbeats on unrelated saves and fences stale recovery and completion', async (kind) => {
    const database = await filename(); const namespace = 'heartbeat-fence'; const clock = Date.now();
    const seed = await StrataGate.open({ database, namespace, blockTurnSize: 1, summarizer: summary,
      ...(kind === 'graph' ? { graphProjector: async () => ({ reason: 'none', nodes: [], edges: [] }) } : {}) });
    const block = (await seed.appendTurn({ user: 'source', assistant: 'stored' })).sealedBlock!;
    if (kind === 'graph') await seed.addEvent({ title: 'decision', summary: 'durable', sourceBlockId: block.id, sourceMessageIds: [block.l5Raw[0]!.id] });
    const initial = seed.exportSnapshot();
    const job = kind === 'summary' ? initial.summaryJobs[0]! : kind === 'extraction' ? initial.extractionJobs[0]! : initial.graphProjectionJobs[0]!;
    Object.assign(job, { status: 'running', attempts: 1, leaseUntil: new Date(clock + DERIVATION_LEASE_MS).toISOString() });
    const id = kind === 'graph' ? initial.graphProjectionJobs[0]!.id : block.id;
    const storage = new SqliteStorage({ filename: database });
    try {
      const revision = await storage.save(namespace, initial, seed.storageRevision);
      await seed.close();
      expect(await storage.renewDerivationLease(namespace, kind, id, 2, job.updatedAt, clock)).toBeNull();
      const until = await storage.renewDerivationLease(namespace, kind, id, 1, job.updatedAt, clock + DERIVATION_LEASE_MS / 3);
      expect(until).toBe(new Date(clock + DERIVATION_LEASE_MS * 4 / 3).toISOString());
      const unrelated = structuredClone(initial);
      await storage.save(namespace, unrelated, revision);
      const current = kind === 'summary' ? unrelated.summaryJobs[0]! : kind === 'extraction' ? unrelated.extractionJobs[0]! : unrelated.graphProjectionJobs[0]!;
      expect(current.leaseUntil).toBe(until);
      for (const status of ['failed', kind === 'summary' ? 'succeeded' : kind === 'extraction' ? 'skipped' : 'completed']) {
        const stale = structuredClone(initial);
        Object.assign(kind === 'summary' ? stale.summaryJobs[0]! : kind === 'extraction' ? stale.extractionJobs[0]! : stale.graphProjectionJobs[0]!, { status });
        await expect(storage.save(namespace, stale, revision + 1)).rejects.toBeInstanceOf(StorageConflictError);
      }
      Object.assign(current, { status: kind === 'summary' ? 'succeeded' : kind === 'extraction' ? 'skipped' : 'completed' });
      await storage.save(namespace, unrelated, revision + 1);
      expect(await storage.renewDerivationLease(namespace, kind, id, 1, job.updatedAt, clock)).toBeNull();
    } finally { await seed.close(); await storage.close(); }
  });

  it('merges Topic heartbeats and fences stale transitions even when terminal jobs clear their lease', async () => {
    const database = await filename(); const namespace = 'topic-fence'; const clock = Date.now();
    const seed = await StrataGate.open({ database, namespace, blockTurnSize: 1, summarizer: summary });
    const block = (await seed.appendTurn({ user: 'source', assistant: 'stored' })).sealedBlock!;
    await seed.addEvent({ title: 'decision', summary: 'durable', sourceBlockId: block.id, sourceMessageIds: [block.l5Raw[0]!.id] });
    const claim = (await seed.claimNextTopicProjection())!;
    const initial = seed.exportSnapshot(); const job = initial.memoryTopicState!.jobs[0]!;
    const revision = seed.storageRevision;
    const storage = new SqliteStorage({ filename: database });
    try {
      const until = await storage.renewDerivationLease(namespace, 'topic', claim.jobId, job.attempts, job.updatedAt, clock + DERIVATION_LEASE_MS / 3);
      expect(until).not.toBeNull();
      const unchanged = structuredClone(initial);
      await storage.save(namespace, unchanged, revision);
      expect(unchanged.memoryTopicState!.jobs[0]!.leaseUntil).toBe(until);
      for (const status of ['failed', 'completed'] as const) {
        const stale = structuredClone(initial);
        Object.assign(stale.memoryTopicState!.jobs[0]!, { status, leaseUntil: null });
        await expect(storage.save(namespace, stale, revision + 1, undefined,
          [{ kind: 'topic', id: job.id, attempts: job.attempts, leaseUntil: job.leaseUntil ?? null }])).rejects.toBeInstanceOf(StorageConflictError);
      }
      // Core supplies the current pre-mutation lease even though completion
      // clears it. A normal caller can finish without weakening the fence.
      await seed.reloadFromStorage();
      await seed.completeTopicProjection(claim.jobId, { topics: [{ title: 'Project', description: 'Decision.',
        sourceEventIds: claim.events.map(({ id }) => id), overview: [] }] });
      expect(seed.listTopicProjectionJobs()[0]).toMatchObject({ status: 'completed', leaseUntil: null });
    } finally { await seed.close(); await storage.close(); }
  });

  it.each(['summary', 'extraction', 'graph', 'topic'] as const)('renews a long-running %s model beyond the initial lease, including across an OS process', async (kind) => {
    const database = await filename(); const namespace = 'long-model'; let clock = Date.now();
    let finish!: (value: never) => void;
    const model = vi.fn(() => new Promise<never>((resolve) => { finish = resolve; }));
    const first = await StrataGate.open({ database, namespace, blockTurnSize: 1, now: () => new Date(clock),
      summarizer: kind === 'summary' ? model : async () => ({ ...(await summary()), shouldExtract: kind === 'extraction' }),
      ...(kind === 'extraction' ? { extractor: model } : {}), ...(kind === 'graph' ? { graphProjector: model } : {}),
      ...(kind === 'topic' ? { graphProjector: async () => ({ reason: 'none', nodes: [], edges: [] }) } : {}) });
    const result = await first.appendTurn({ user: 'one source', assistant: 'stored' }, { deferDerivation: kind === 'summary' || kind === 'extraction' });
    if (kind === 'graph' || kind === 'topic') await first.addEvent({ title: 'decision', summary: 'durable', sourceBlockId: result.sealedBlock!.id,
      sourceMessageIds: [result.sealedBlock!.l5Raw[0]!.id] });
    if (kind === 'topic') {
      const graph = (await first.claimNextGraphProjection())!;
      await first.completeGraphProjection(graph.jobId, { reason: 'none', nodes: [], edges: [] });
    }
    const topic = kind === 'topic' ? (await first.claimNextTopicProjection('incremental'))! : null;
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const running = topic ? first.runTopicProjectionModel(topic.jobId, model) : first.resumePendingWork();
    await vi.waitFor(() => expect(model).toHaveBeenCalledTimes(1));
    const storage = new SqliteStorage({ filename: database });
    const stale = first.exportSnapshot();
    try {
      for (let round = 0; round < 4; round++) {
        clock += DERIVATION_LEASE_MS / 3;
        await vi.advanceTimersByTimeAsync(DERIVATION_LEASE_MS / 3);
      }
      expect(clock).toBeGreaterThan(Date.parse((kind === 'summary' ? stale.summaryJobs[0] : kind === 'extraction'
        ? stale.extractionJobs[0] : kind === 'graph' ? stale.graphProjectionJobs[0] : stale.memoryTopicState!.jobs[0])!.leaseUntil!));
      const loads = vi.spyOn(storage, 'load');
      await storage.rebuildBackgroundWorkIndex();
      expect(storage.dueBackgroundNamespaces(clock, kind === 'topic')).toEqual([]);
      expect(loads).not.toHaveBeenCalled();
      const storeUrl = new URL('../src/store.ts', import.meta.url).href;
      const childCode = `
        const { registerHooks } = require('node:module'); const fs = require('node:fs');
        const { fileURLToPath } = require('node:url'); const ts = require('typescript');
        registerHooks({ resolve(s, c, next) {
          if(s.startsWith('.') && s.endsWith('.js') && c.parentURL?.startsWith('file:')) {
            const u = new URL(s.slice(0,-3)+'.ts',c.parentURL); if(fs.existsSync(fileURLToPath(u))) return {url:u.href,shortCircuit:true};
          } return next(s,c);
        }, load(u,c,next) {
          if(u.endsWith('.ts')) return {format:'module',shortCircuit:true,source:ts.transpileModule(fs.readFileSync(fileURLToPath(u),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText};
          return next(u,c);
        }});
        (async()=> { const { StrataGate } = await import(${JSON.stringify(storeUrl)}); let calls=0;
          const model=async()=>{calls++; throw Error('duplicate model call')};
          const memory=await StrataGate.open({database:${JSON.stringify(database)},namespace:${JSON.stringify(namespace)},
            blockTurnSize:1,now:()=>new Date(${clock}),summarizer:model,extractor:model,graphProjector:model});
          await memory.resumePendingWork();
          ${kind === 'topic' ? 'if(await memory.claimNextTopicProjection()) calls++;' : ''}
          await memory.close(); console.log(JSON.stringify({calls}));
        })().catch(e=>{console.error(e);process.exitCode=1});`;
      const output = await new Promise<string>((resolve, reject) => {
        const child = spawn(process.execPath, ['-e', childCode], { cwd: fileURLToPath(new URL('../../../', import.meta.url)) });
        let stdout = ''; let stderr = '';
        child.stdout.on('data', (data) => { stdout += data; }); child.stderr.on('data', (data) => { stderr += data; });
        child.on('error', reject); child.on('exit', (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr)));
      });
      expect(JSON.parse(output)).toEqual({ calls: 0 });
      finish((kind === 'summary' ? await summary() : kind === 'extraction'
        ? { shouldExtract: false, reason: 'none', events: [] } : kind === 'graph' ? { reason: 'none', nodes: [], edges: [] }
          : { topics: [{ title: 'Project', description: 'A decision.', sourceEventIds: topic!.events.map(({ id }) => id), overview: [] }] }) as never);
      const completed = await running;
      if (topic) await first.completeTopicProjection(topic.jobId, completed as TopicProjectionResult);
      expect(vi.getTimerCount()).toBe(0);
      expect(model).toHaveBeenCalledTimes(1);
      expect(first.listBlocks()[0]!.processingStatus).toBe('ready');
      expect((kind === 'summary' ? first.listSummaryJobs()[0] : kind === 'extraction' ? first.listExtractionJobs()[0]
        : kind === 'graph' ? first.listGraphProjectionJobs()[0] : first.listTopicProjectionJobs()[0])!.status)
        .toBe(kind === 'summary' ? 'succeeded' : kind === 'extraction' ? 'skipped' : 'completed');
    } finally { vi.useRealTimers(); await first.close(); await storage.close(); }
  }, 20_000);

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
    old.exec('DROP TRIGGER raw_fts_dirty_INSERT; DROP TRIGGER raw_fts_dirty_UPDATE_v2; DROP TRIGGER raw_fts_dirty_DELETE; DROP TABLE raw_message_fts_dirty');
    old.exec(`INSERT INTO messages SELECT namespace, 'pre-trigger-row', block_id, thread_id, 99, role,
      'legacy-gap unique source', created_at, tool_calls_json FROM messages WHERE role = 'user' LIMIT 1`);
    old.close();
    const storage = new SqliteStorage({ filename: database });
    try { expect(storage.searchRawMessageIds('legacy', searchTokens('legacy-gap'), 10)).toContain('pre-trigger-row'); }
    finally { await storage.close(); }
  });

  it('leaves large unchanged raw history clean after Event and usage saves; external content and ownership edits remain repairable', async () => {
    const database = await filename(); const namespace = 'fts-history';
    const seed = StrataGate.inMemory({ blockTurnSize: 1, summarizer: summary });
    await seed.appendTurn({ user: 'history unique', assistant: 'saved' });
    const snapshot = seed.exportSnapshot();
    const template = snapshot.blocks[0]!;
    snapshot.blocks = Array.from({ length: 300 }, (_, index) => ({ ...structuredClone(template), id: `block-${index}`, sequence: index + 1,
      startTurn: index + 1, endTurn: index + 1,
      l5Raw: template.l5Raw.map((message, position) => ({ ...message, id: `message-${index}-${position}`,
        content: position === 0 ? `history unique ${index} ` + 'old source '.repeat(100) : 'saved' })) }));
    snapshot.summaryJobs = snapshot.blocks.map(({ id }) => ({ ...snapshot.summaryJobs[0]!, blockId: id }));
    snapshot.extractionJobs = snapshot.blocks.map(({ id }) => ({ ...snapshot.extractionJobs[0]!, blockId: id }));
    snapshot.currentTurn = 300;
    const storage = new SqliteStorage({ filename: database }); const db = new DatabaseSync(database);
    try { await storage.save(namespace, snapshot, 0); } catch (error) { db.close(); await storage.close(); throw error; }
    finally { await seed.close(); }
    const memory = await StrataGate.open({ database, namespace });
    try {
      storage.searchRawMessageIds(namespace, searchTokens('unique'), 400);
      const rowids = db.prepare('SELECT message_id, fts_rowid FROM raw_message_fts_meta ORDER BY message_id').all();
      await memory.addEvent({ title: 'new Event', summary: 'source unchanged', sourceBlockId: 'block-0', sourceMessageIds: ['message-0-0'] });
      await memory.pinEvent(memory.listAllEvents()[0]!.id);
      await memory.recordMemoryUse({ eventIds: [memory.listAllEvents()[0]!.id] }, { receiptId: 'usage-no-message-change' });
      expect(db.prepare('SELECT COUNT(*) AS count FROM raw_message_fts_dirty').get()).toEqual({ count: 0 });
      const repairs = vi.spyOn(storage as unknown as { syncRawSearchIndex: (...args: unknown[]) => void }, 'syncRawSearchIndex');
      storage.searchRawMessageIds(namespace, searchTokens('unique'), 400);
      expect(repairs).not.toHaveBeenCalled();
      expect(db.prepare('SELECT message_id, fts_rowid FROM raw_message_fts_meta ORDER BY message_id').all()).toEqual(rowids);
      db.exec("UPDATE messages SET content = 'external changedtoken' WHERE id = 'message-0-0'");
      expect(db.prepare('SELECT COUNT(*) AS count FROM raw_message_fts_dirty').get()).toEqual({ count: 1 });
      expect(storage.searchRawMessageIds(namespace, searchTokens('changedtoken'), 10)).toEqual(['message-0-0']);
      expect(repairs.mock.calls[0]![1]).toMatchObject({ upsert: [{ id: 'message-0-0', content: 'external changedtoken' }] });
      db.exec("UPDATE messages SET block_id = NULL WHERE id = 'message-0-0'");
      expect(storage.searchRawMessageIds(namespace, searchTokens('changedtoken'), 10)).toEqual([]);
      db.exec("UPDATE messages SET block_id = 'block-0' WHERE id = 'message-0-0'");
      expect(storage.searchRawMessageIds(namespace, searchTokens('changedtoken'), 10)).toEqual(['message-0-0']);
      db.exec("UPDATE messages SET content = 'deleteunique' WHERE id = 'message-299-1'");
      expect(storage.searchRawMessageIds(namespace, searchTokens('deleteunique'), 10)).toEqual(['message-299-1']);
      db.exec("DELETE FROM messages WHERE id = 'message-299-1'");
      expect(storage.searchRawMessageIds(namespace, searchTokens('deleteunique'), 10)).toEqual([]);
    } finally { await memory.close(); db.close(); await storage.close(); }
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
