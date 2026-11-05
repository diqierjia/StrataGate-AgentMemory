import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StrataGate, DERIVATION_LEASE_MS, DERIVATION_MAX_ATTEMPTS, type ExtractionContext, type TopicProjectionContext, type PersistentProfile } from '@diqier/stratagate'
import type { Session } from '@deepseek-ai/dsh-session'
import { SqliteStorage } from '@diqier/stratagate/sqlite'
import type { DshModelBridge } from '../src/llm.js'
import { StrataGateRuntime } from '../src/runtime.js'
import { DshMetadataStore, TOPIC_BOOTSTRAP_WINDOW_CALLS } from '../src/metadata.js'

const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
async function databasePath() {
  const root = await mkdtemp(join(tmpdir(), 'worker-128-')); roots.push(root)
  return join(root, 'memory.db')
}
const summary = async () => ({ l0Title: 'saved', l0Tags: [], l1Summary: 'saved', l2Keypoints: [], shouldExtract: false })
const models = {
  isReady: () => true, onAdaptersUpdated: () => () => {},
  runDetached: async <T>(_id: string, operation: () => Promise<T>) => operation(),
  summarizer: summary, extractor: async () => ({ shouldExtract: false, reason: 'none', events: [] }),
  graphProjector: async () => ({ reason: 'none', nodes: [], edges: [] }),
}
interface Worker { runBackgroundWorker(): Promise<void>; scheduleBackgroundWorker(delay: number): void }
function runtimeFor(database: string, overrides = {}, onError?: (error: unknown) => void) {
  const runtime = new StrataGateRuntime({ database, namespaceMode: 'project', namespacePrefix: 'dsh', globalNamespace: 'global',
    blockTurnSize: 1, blockDecayLambda: 0.3, ingestSubagents: false, maxOutputTokens: 2048 },
  { ...models, ...overrides } as unknown as DshModelBridge, onError)
  return runtime
}
async function poll(runtime: StrataGateRuntime) { await (runtime as unknown as Worker).runBackgroundWorker() }

describe('Issue #128 indexed background discovery', () => {
  it.each(['summary', 'extraction'] as const)('does not schedule an exhausted %s after its final interrupted lease was recovered', async (kind) => {
    const database = await databasePath(); const clock = Date.now()
    const session = { id: 'final-attempt', header: { cwd: 'C:\\final-attempt' }, snapshotEvents: () => [] } as unknown as Session
    const model = vi.fn(summary)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const runtime = runtimeFor(database, { run: async (_session: Session, operation: () => Promise<unknown>) => operation(), summarizer: model })
    const worker = runtime as unknown as { backgroundWorkerTimer: ReturnType<typeof setTimeout> | undefined; scheduleBlockDerivation(session: Session, memory: StrataGate): void }
    clearTimeout(worker.backgroundWorkerTimer); worker.backgroundWorkerTimer = undefined
    vi.spyOn(runtime as unknown as Worker, 'scheduleBackgroundWorker').mockImplementation(() => {})
    const namespace = runtime.namespaceFor(session)
    const seed = StrataGate.inMemory({ blockTurnSize: 1, summarizer: summary })
    const block = (await seed.appendTurn({ user: 'final interrupted attempt', assistant: 'stored', threadId: String(session.id) })).sealedBlock!
    const snapshot = seed.exportSnapshot(); snapshot.blocks[0]!.processingStatus = 'pending'
    if (kind === 'extraction') snapshot.blocks[0]!.shouldExtract = true
    const job = { blockId: block.id, status: 'running' as const, attempts: DERIVATION_MAX_ATTEMPTS, lastError: null,
      nextRetryAt: null, updatedAt: new Date(clock - DERIVATION_LEASE_MS).toISOString(), leaseUntil: new Date(clock - 1).toISOString() }
    if (kind === 'summary') snapshot.summaryJobs = [job]
    else snapshot.extractionJobs = [job]
    const storage = new SqliteStorage({ filename: database })
    await storage.save(namespace, snapshot, 0); await storage.close(); await seed.close()
    const memory = await StrataGate.open({ database, namespace, blockTurnSize: 1, summarizer: model })
    try {
      const jobs = kind === 'summary' ? memory.listSummaryJobs() : memory.listExtractionJobs()
      expect(jobs[0]).toMatchObject({ status: 'failed', attempts: DERIVATION_MAX_ATTEMPTS })
      for (let round = 0; round < 4; round++) worker.scheduleBlockDerivation(session, memory)
      expect(vi.getTimerCount()).toBe(0)
      expect(model).not.toHaveBeenCalled()
    } finally { await runtime.close(); await memory.close(); vi.useRealTimers() }
  })

  it('refreshes a same-revision heartbeat racing recovery and backs off the foreground retry before completing other work', async () => {
    const database = await databasePath(); const began = Date.now(); let clock = began
    const session = { id: 'other', header: { cwd: 'C:\\lease-cache' }, snapshotEvents: () => [] } as unknown as Session
    const model = vi.fn(summary); const errors = vi.fn()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const runtime = runtimeFor(database, { run: async (_session: Session, operation: () => Promise<unknown>) => operation(), summarizer: model }, errors)
    const worker = runtime as unknown as { backgroundWorkerTimer: ReturnType<typeof setTimeout> | undefined; scheduleBlockDerivation(session: Session, memory: StrataGate): void }
    clearTimeout(worker.backgroundWorkerTimer); worker.backgroundWorkerTimer = undefined
    vi.spyOn(runtime as unknown as Worker, 'scheduleBackgroundWorker').mockImplementation(() => {})
    const namespace = runtime.namespaceFor(session)
    const memory = await StrataGate.open({ database, namespace, blockTurnSize: 1, summarizer: model, now: () => new Date(clock) })
    const writer = new SqliteStorage({ filename: database })
    try {
      const owner = (await memory.appendTurn({ user: 'owned by A', assistant: 'stored', threadId: 'owner' }, { deferDerivation: true })).sealedBlock!
      const other = (await memory.appendTurn({ user: 'work for B', assistant: 'stored', threadId: 'other' }, { deferDerivation: true })).sealedBlock!
      const state = memory.exportSnapshot(); const claim = state.summaryJobs.find(({ blockId }) => blockId === owner.id)!
      Object.assign(claim, { status: 'running', attempts: 1, leaseUntil: new Date(began + DERIVATION_LEASE_MS).toISOString() })
      await writer.save(namespace, state, memory.storageRevision); await memory.reloadFromStorage()
      await writer.renewDerivationLease(namespace, 'summary', owner.id, 1, claim.updatedAt, began + 100_000)
      clock = began + 399_999
      const read = SqliteStorage.prototype.loadDerivationLeases
      vi.spyOn(SqliteStorage.prototype, 'loadDerivationLeases').mockImplementationOnce(async function (this: SqliteStorage, namespace) {
        const old = await read.call(this, namespace)
        // The metadata snapshot was live at read time. A renews before its
        // deadline, then B's clock passes that deadline before recovery writes.
        await writer.renewDerivationLease(namespace, 'summary', owner.id, 1, claim.updatedAt, clock)
        clock += 2
        return old
      })
      const loads = vi.spyOn(SqliteStorage.prototype, 'load')
      const runs = vi.spyOn(memory, 'resumePendingWork')
      worker.scheduleBlockDerivation(session, memory)
      await vi.advanceTimersByTimeAsync(0)
      expect(runs).toHaveBeenCalledTimes(1)
      expect(model).not.toHaveBeenCalled()
      expect(errors).not.toHaveBeenCalled()
      expect(memory.listSummaryJobs().find(({ blockId }) => blockId === owner.id)).toMatchObject({ status: 'running', attempts: 1,
        leaseUntil: new Date(began + 699_999).toISOString() })
      await vi.advanceTimersByTimeAsync(2_999)
      expect(runs).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(runs).toHaveBeenCalledTimes(2)
      expect(model).toHaveBeenCalledTimes(1)
      expect(memory.listBlocks().find(({ id }) => id === other.id)?.processingStatus).toBe('ready')
      expect(errors).not.toHaveBeenCalled()
      expect(loads).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(10_000)
      expect(runs).toHaveBeenCalledTimes(2)
    } finally { vi.useRealTimers(); await runtime.close(); await memory.close(); await writer.close() }
  })

  it('loads zero full memories over ten polls of 100 idle namespaces, including large raw history', async () => {
    const database = await databasePath()
    // Prepare representative persisted history through one writer. Opening 100
    // separate connections tested migration/fixture cost, not idle discovery.
    const seed = StrataGate.inMemory({ blockTurnSize: 1, summarizer: summary })
    await seed.appendTurn({ user: 'raw history '.repeat(100), assistant: 'saved' })
    const storage = new SqliteStorage({ filename: database })
    try {
      for (let index = 0; index < 100; index++) {
        const snapshot = seed.exportSnapshot()
        if (index === 99) snapshot.blocks[0]!.l5Raw[0]!.content = 'raw history '.repeat(200_000)
        await storage.save(`idle:${index}`, snapshot, 0)
      }
    } finally { await seed.close(); await storage.close() }
    const loads = vi.spyOn(SqliteStorage.prototype, 'load')
    const opens = vi.spyOn(StrataGate, 'open')
    const runtime = runtimeFor(database)
    try {
      for (let round = 0; round < 10; round++) await poll(runtime)
      expect(loads).not.toHaveBeenCalled()
      expect(opens).not.toHaveBeenCalled()
      const db = new DatabaseSync(database)
      try {
        expect(db.prepare('SELECT COUNT(*) AS count FROM background_work_schedule').get()).toEqual({ count: 0 })
        const plans = db.prepare("EXPLAIN QUERY PLAN SELECT namespace FROM background_work_schedule WHERE kind = 'core' AND due_at <= ?").all(Date.now())
        expect(JSON.stringify(plans)).toContain('background_work_due')
      } finally { db.close() }
    } finally { await runtime.close() }
  }, 30_000)

  it('recovers a sealable open tail after restart before any Job exists, then stays idle', async () => {
    const database = await databasePath()
    const seed = await StrataGate.open({ database, namespace: 'tail-only', blockTurnSize: 1 })
    await seed.appendTurn({ user: 'raw-only source', assistant: 'stored' }, { deferProcessing: true })
    expect(seed.listBlocks()).toHaveLength(0)
    expect(seed.listSummaryJobs()).toHaveLength(0)
    expect(seed.hasSealableTail()).toBe(true)
    await seed.close()
    const summarize = vi.fn(summary)
    const opens = vi.spyOn(StrataGate, 'open')
    const runtime = runtimeFor(database, { summarizer: summarize })
    try {
      await poll(runtime)
      expect(summarize).toHaveBeenCalledTimes(1)
      expect(opens).toHaveBeenCalledTimes(1)
      for (let round = 0; round < 5; round++) await poll(runtime)
      expect(opens).toHaveBeenCalledTimes(1)
      const storage = new SqliteStorage({ filename: database, readonly: true })
      try {
        const snapshot = (await storage.load('tail-only'))!.snapshot
        expect(snapshot.openTail).toHaveLength(0)
        expect(snapshot.blocks[0]!.processingStatus).toBe('ready')
      } finally { await storage.close() }
    } finally { await runtime.close() }
  })

  it('does not enumerate or load 1000 idle namespaces over repeated polls', async () => {
    const database = await databasePath()
    const storage = new SqliteStorage({ filename: database })
    const snapshot = StrataGate.inMemory({ blockTurnSize: 1 }).exportSnapshot()
    try { await storage.save('idle:0', snapshot, 0) }
    finally { await storage.close() }
    // Empty namespaces need only the persisted space header. Clone the real
    // saved header in one transaction instead of timing 1000 durable commits.
    const db = new DatabaseSync(database)
    try {
      const columns = (db.prepare("PRAGMA table_info('memory_spaces')").all() as Array<{ name: string }>)
        .map(row => row.name).filter(name => name !== 'namespace')
      const names = columns.map(name => `"${name}"`).join(', ')
      const insert = db.prepare(`INSERT INTO memory_spaces (namespace, ${names}) SELECT ?, ${names} FROM memory_spaces WHERE namespace = 'idle:0'`)
      db.exec('BEGIN IMMEDIATE')
      for (let index = 1; index < 1000; index++) insert.run(`idle:${index}`)
      // Each clone has the seed's empty job/event state, so its prepared
      // derived index is empty too. Index rebuilding has separate regressions.
      db.exec("DELETE FROM background_work_dirty WHERE namespace LIKE 'idle:%'")
      db.exec('COMMIT')
      expect(db.prepare('SELECT COUNT(*) AS count FROM memory_spaces').get()).toEqual({ count: 1000 })
    } finally { db.close() }
    const loads = vi.spyOn(SqliteStorage.prototype, 'load')
    const namespaces = vi.spyOn(SqliteStorage.prototype, 'listNamespaces')
    const runtime = runtimeFor(database)
    try {
      for (let round = 0; round < 10; round++) await poll(runtime)
      expect(loads).not.toHaveBeenCalled()
      expect(namespaces).not.toHaveBeenCalled()
    } finally { await runtime.close() }
  }, 30_000)

  it('opens only the namespace with work and schedules Summary, Extraction, Graph and dynamic Topic without a Job', async () => {
    const database = await databasePath()
    for (const namespace of ['idle:a', 'idle:b', 'busy']) {
      const seed = await StrataGate.open({ database, namespace, blockTurnSize: 1, summarizer: summary })
      if (namespace === 'busy') await seed.appendTurn({ user: 'use SQLite', assistant: 'saved' }, { deferDerivation: true })
      else await seed.appendTurn({ user: 'idle', assistant: 'saved' })
      await seed.close()
    }
    const calls = { summary: vi.fn(), extraction: vi.fn(), graph: vi.fn(), topic: vi.fn() }
    const opens = vi.spyOn(StrataGate, 'open')
    const runtime = runtimeFor(database, {
      summarizer: async () => { calls.summary(); return { ...(await summary()), shouldExtract: true } },
      extractor: async ({ target }: ExtractionContext) => {
        calls.extraction(); return { shouldExtract: true, reason: 'durable', events: [{ title: 'SQLite decision',
          summary: 'The project uses SQLite.', sourceMessageIds: [target.l5Raw[0]!.id] }] }
      },
      graphProjector: async () => { calls.graph(); return { reason: 'none', nodes: [], edges: [] } },
      topicProjector: async (context: TopicProjectionContext) => {
        calls.topic(); return { topics: [{ title: 'Project', description: 'Project decisions.',
          sourceEventIds: context.events.map(({ id }) => id), sections: [{ title: 'Decisions', sourceEventIds: context.events.map(({ id }) => id) }],
          overview: [] }] }
      },
    })
    try {
      const preview = await runtime.adminGraphControl('preview') as { token: string }
      await runtime.adminGraphControl('enable', preview.token)
      opens.mockClear()
      await poll(runtime)
      for (const call of Object.values(calls)) expect(call).toHaveBeenCalledTimes(1)
      expect(opens.mock.calls.every(([options]) => options.namespace === 'busy')).toBe(true)
      expect(opens).toHaveBeenCalledTimes(1)
      await poll(runtime)
      expect(opens).toHaveBeenCalledTimes(1)
    } finally { await runtime.close() }
  })

  it('discovers a new task written by a separate OS process without a local wake hint', async () => {
    const database = await databasePath()
    const seed = await StrataGate.open({ database, namespace: 'seed', blockTurnSize: 1, summarizer: summary })
    await seed.appendTurn({ user: 'old raw source', assistant: 'saved' }); await seed.close()
    const runtime = runtimeFor(database)
    try {
      await poll(runtime)
      await promisify(execFile)(process.execPath, ['-e', `
        const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(process.argv[1]);
        db.exec('BEGIN IMMEDIATE');
        for (const table of ['memory_spaces','blocks','messages','block_summary_jobs']) {
          const cols = db.prepare('PRAGMA table_info(' + table + ')').all().map(row => row.name);
          db.exec('INSERT INTO ' + table + ' (' + cols.join(',') + ') SELECT ' + cols.map(col => col === 'namespace' ? "'external'" : col).join(',') + " FROM " + table + " WHERE namespace = 'seed'");
        }
        db.exec("UPDATE blocks SET processing_status = 'pending' WHERE namespace = 'external'; UPDATE block_summary_jobs SET status = 'pending', attempts = 0 WHERE namespace = 'external'; COMMIT"); db.close();
      `, database])
      const loads = vi.spyOn(SqliteStorage.prototype, 'load')
      await poll(runtime)
      expect(loads.mock.calls.map(([namespace]) => namespace)).toEqual(['external'])
      const check = new SqliteStorage({ filename: database, readonly: true })
      try { expect((await check.load('external'))!.snapshot.summaryJobs[0]!.status).toBe('succeeded') }
      finally { await check.close() }
    } finally { await runtime.close() }
  })

  it('wakes for a same-process committed task, and keeps model-unready jobs unclaimed', async () => {
    const database = await databasePath()
    let ready = false; let updated = () => {}
    const summarizer = vi.fn(summary)
    const runtime = runtimeFor(database, { isReady: () => ready, summarizer,
      onAdaptersUpdated: (listener: () => void) => { updated = listener; return () => {} } })
    const schedule = vi.spyOn(runtime as unknown as Worker, 'scheduleBackgroundWorker')
    try {
      const seed = await StrataGate.open({ database, namespace: 'new', blockTurnSize: 1 })
      await seed.appendTurn({ user: 'new task', assistant: 'saved' }, { deferDerivation: true }); await seed.close()
      expect(schedule).toHaveBeenCalledWith(0)
      await poll(runtime); expect(summarizer).not.toHaveBeenCalled()
      ready = true; updated()
      await vi.waitFor(() => expect(summarizer).toHaveBeenCalledTimes(1), { timeout: 2_000 })
    } finally { await runtime.close() }
  })

  it('skips full loading while historical Topic allowance is exhausted, then resumes at reset', async () => {
    const database = await databasePath()
    const seed = await StrataGate.open({ database, namespace: 'history', blockTurnSize: 1, summarizer: summary,
      graphEnabled: true, graphProjector: models.graphProjector })
    const block = (await seed.appendTurn({ user: 'historical decision', assistant: 'saved' })).sealedBlock!
    await seed.addEvent({ title: 'Historical decision', summary: 'An old project decision.',
      sourceBlockId: block.id, sourceMessageIds: [block.l5Raw[0]!.id] })
    const graph = (await seed.claimNextGraphProjection())!; await seed.completeGraphProjection(graph.jobId, { reason: 'none', nodes: [], edges: [] })
    const snapshot = seed.exportSnapshot(); delete snapshot.memoryTopicState
    const storage = new SqliteStorage({ filename: database }); await storage.save('history', snapshot, seed.storageRevision); await storage.close(); await seed.close()
    const metadata = new DshMetadataStore(database)
    for (let call = 0; call < TOPIC_BOOTSTRAP_WINDOW_CALLS; call++) expect(metadata.reserveTopicBootstrapCall()).toBe(true)
    metadata.close()
    const topic = vi.fn(async (context: TopicProjectionContext) => ({ topics: [{ title: 'History', description: 'Historical project.',
      sourceEventIds: context.events.map(({ id }) => id), sections: [{ title: 'Decisions', sourceEventIds: context.events.map(({ id }) => id) }], overview: [] }] }))
    const loads = vi.spyOn(SqliteStorage.prototype, 'load')
    const runtime = runtimeFor(database, { topicProjector: topic })
    try {
      await poll(runtime); await poll(runtime)
      expect(loads).not.toHaveBeenCalled(); expect(topic).not.toHaveBeenCalled()
      const db = new DatabaseSync(database)
      db.prepare("UPDATE stratagate_dsh_settings SET value = ? WHERE key = 'topicBootstrapBudget'").run(JSON.stringify({ used: 2, resetAt: Date.now() - 1 }))
      db.close()
      // Reading the clock twice across a millisecond boundary must not make
      // an available allowance look like a future deadline.
      let clock = Date.now()
      vi.spyOn(Date, 'now').mockImplementation(() => ++clock)
      await poll(runtime)
      expect(topic).toHaveBeenCalledTimes(1)
      expect(loads.mock.calls.map(([namespace]) => namespace)).toEqual(['history'])
    } finally { await runtime.close() }
  })

  it('runs due Profile maintenance even with an empty task index and no namespaces', async () => {
    const database = await databasePath()
    const maintainProfile = vi.fn(async (profile: PersistentProfile) => ({ ...profile, responsePreferences: '简洁。' }))
    const runtime = runtimeFor(database, { maintainProfile })
    try {
      runtime.updatePersistentProfile('responsePreferences', '简洁。简洁。', 'user_explicit')
      const db = new DatabaseSync(database)
      db.prepare('UPDATE persistent_profile_maintenance_baseline SET started_at = ?').run(new Date(Date.now() - 25 * 60 * 60_000).toISOString())
      db.close()
      const loads = vi.spyOn(SqliteStorage.prototype, 'load')
      await poll(runtime)
      await vi.waitFor(() => expect(runtime.getPersistentProfile().responsePreferences).toBe('简洁。'))
      expect(maintainProfile).toHaveBeenCalledTimes(1)
      expect(loads).not.toHaveBeenCalled()
    } finally { await runtime.close() }
  })
})
