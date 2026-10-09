import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StrataGate, type ExtractionContext, type TopicProjectionContext, type PersistentProfile } from '@diqier/stratagate'
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
function runtimeFor(database: string, overrides = {}) {
  const runtime = new StrataGateRuntime({ database, namespaceMode: 'project', namespacePrefix: 'dsh', globalNamespace: 'global',
    blockTurnSize: 1, blockDecayLambda: 0.3, ingestSubagents: false, maxOutputTokens: 2048 },
  { ...models, ...overrides } as unknown as DshModelBridge)
  return runtime
}
async function poll(runtime: StrataGateRuntime) { await (runtime as unknown as Worker).runBackgroundWorker() }

describe('Issue #128 indexed background discovery', () => {
  it('loads zero full memories over ten polls of 100 idle namespaces, including large raw history', async () => {
    const database = await databasePath()
    for (let index = 0; index < 100; index++) {
      const seed = await StrataGate.open({ database, namespace: `idle:${index}`, blockTurnSize: 1, summarizer: summary })
      await seed.appendTurn({ user: 'raw history '.repeat(index === 99 ? 200_000 : 100), assistant: 'saved' })
      await seed.close()
    }
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

  it('does not enumerate or load 1000 idle namespaces over repeated polls', async () => {
    const database = await databasePath()
    const storage = new SqliteStorage({ filename: database })
    const snapshot = StrataGate.inMemory({ blockTurnSize: 1 }).exportSnapshot()
    try { for (let index = 0; index < 1000; index++) await storage.save(`idle:${index}`, snapshot, 0) }
    finally { await storage.close() }
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
      graphProjector: models.graphProjector })
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
