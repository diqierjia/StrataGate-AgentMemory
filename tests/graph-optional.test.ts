import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StrataGate } from '@diqier/stratagate'
import type { DshModelBridge } from '../src/llm.js'
import { StrataGateRuntime } from '../src/runtime.js'
import { DshMetadataStore } from '../src/metadata.js'
import { handleAdminRequest } from '../src/web.js'
import { registerMemoryTools } from '../src/tools.js'

const roots: string[] = []
const runtimes: StrataGateRuntime[] = []
afterEach(async () => { for (const runtime of runtimes.splice(0)) await runtime.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function path() { const root = await mkdtemp(join(tmpdir(), 'optional-graph-host-')); roots.push(root); return join(root, 'memory.db') }
const empty = { reason: 'none', nodes: [], edges: [] }
const summarizer = async () => ({ l0Title: 'source', l0Tags: [], l1Summary: 'source', l2Keypoints: [], shouldExtract: false })
function runtime(database: string, graphProjector = vi.fn(async () => empty)) {
  const value = new StrataGateRuntime({ database, namespaceMode: 'project', namespacePrefix: 'dsh', globalNamespace: 'global', blockTurnSize: 1, blockDecayLambda: .3, ingestSubagents: false, maxOutputTokens: 2048 },
    { isReady: () => true, onAdaptersUpdated: () => () => {}, runDetached: async (_id: string, operation: () => unknown) => operation(), summarizer, extractor: async () => ({ shouldExtract: false, reason: 'none', events: [] }), graphProjector } as unknown as DshModelBridge)
  const worker = value as unknown as { backgroundWorkerTimer?: ReturnType<typeof setTimeout>; scheduleBackgroundWorker(delay: number): void }
  clearTimeout(worker.backgroundWorkerTimer)
  vi.spyOn(worker, 'scheduleBackgroundWorker').mockImplementation(() => {})
  runtimes.push(value); return value
}
async function seed(database: string, count = 17) {
  const memory = await StrataGate.open({ database, namespace: 'project', blockTurnSize: 1, summarizer })
  await memory.appendTurn({ user: 'Project source', assistant: 'stored' })
  const block = memory.listBlocks()[0]!
  for (let i = 0; i < count; i++) await memory.addEvent({ id: `event-${i}`, title: `Project ${i}`, summary: 'project evidence', sourceBlockId: block.id, sourceMessageIds: [block.l5Raw[0]!.id] })
  await memory.close()
}
async function poll(value: StrataGateRuntime) { await (value as unknown as { runBackgroundWorker(): Promise<void> }).runBackgroundWorker() }
async function enable(value: StrataGateRuntime) { const preview = await value.adminGraphControl('preview') as { token: string; pending: number }; await value.adminGraphControl('enable', preview.token); return preview }

describe('installation Graph toggle', () => {
  it('starts approved history in an already-open session without requiring restart or repeating extraction', async () => {
    const database = await path(); const model = vi.fn(async () => empty); const value = runtime(database, model)
    const session = { id: 'live', header: { id: 'live', version: 0, createdAt: 0 }, snapshotEvents: () => [], eventAt: () => undefined } as never
    const memory = await (value as unknown as { space(session: unknown): Promise<StrataGate> }).space(session)
    await memory.appendTurn({ user: 'Project source', assistant: 'saved' })
    const block = memory.listBlocks()[0]!
    await memory.addEvent({ title: 'Project decision', summary: 'saved source', sourceBlockId: block.id, sourceMessageIds: [block.l5Raw[0]!.id] })
    expect(memory.listGraphProjectionJobs()).toHaveLength(0)
    expect((await enable(value)).pending).toBe(1)
    await poll(value)
    expect(model).toHaveBeenCalledTimes(1)
    expect(memory.listGraphProjectionJobs()[0]).toMatchObject({ status: 'completed' })
    expect(memory.listEvents()).toHaveLength(1)
  })

  it('removes Graph tools dynamically, including legacy Element expansion, while preserving ordinary tools', async () => {
    const value = runtime(await path())
    const registered = new Map<string, unknown>()
    registerMemoryTools({ tools: { register: (tool: { name: string }) => { registered.set(tool.name, tool); return () => { registered.delete(tool.name) } } } } as never, value)
    expect([...registered.keys()]).not.toContain('memory_search_graph')
    expect([...registered.keys()]).toEqual(expect.arrayContaining(['memory_search_events', 'memory_list_topics', 'memory_profile_update']))
    await enable(value)
    expect([...registered.keys()]).toEqual(expect.arrayContaining(['memory_search_graph', 'memory_expand_graph_node', 'memory_expand_element']))
    await value.adminGraphControl('disable')
    expect([...registered.keys()].filter(name => /graph|element/.test(name))).toEqual([])
  })

  it('discards a running model result after disable and resumes with a fresh fenced claim after confirmation', async () => {
    const database = await path(); await seed(database, 1)
    let release!: (value: typeof empty) => void
    const model = vi.fn(() => new Promise<typeof empty>(resolve => { release = resolve }))
    const value = runtime(database, model)
    await enable(value)
    const work = poll(value)
    await vi.waitFor(() => expect(model).toHaveBeenCalledTimes(1))
    const before = (await value.adminSnapshot('project'))!
    const claim = before.graphProjectionJobs[0]!
    await value.adminGraphControl('disable')
    release(empty); await work
    const after = (await value.adminSnapshot('project'))!
    expect(after.graphProjectionJobs[0]).toMatchObject({ id: claim.id, status: 'running', attempts: 1 })
    expect(after.graphNodes).toEqual(before.graphNodes)
    await poll(value); expect(model).toHaveBeenCalledTimes(1)
    model.mockImplementation(async () => empty)
    await enable(value); await poll(value)
    expect(model).toHaveBeenCalledTimes(2)
    const jobs = (await value.adminSnapshot('project'))!.graphProjectionJobs
    expect(jobs.find(job => job.status === 'completed')).toMatchObject({ attempts: 2 })
    expect(jobs.find(job => job.status === 'completed')!.id).not.toBe(claim.id)
  })

  it('lets concurrent workers claim each batch once and respects the existing terminal retry limit', async () => {
    const database = await path(); await seed(database, 9)
    const model = vi.fn(async () => empty)
    const a = runtime(database, model), b = runtime(database, model)
    await enable(a)
    await Promise.all([poll(a), poll(b)])
    await poll(a); await poll(b)
    expect(model).toHaveBeenCalledTimes(2)
    expect((await a.adminSnapshot('project'))!.graphProjectionJobs.filter(job => job.status === 'completed')).toHaveLength(2)
  })

  it('defaults off for new installations, initializes migration once and retains explicit choices', async () => {
    const database = await path(); const value = runtime(database)
    expect(value.adminGraphSettings()).toMatchObject({ enabled: false, legacy: false, noticeSeen: false })
    expect((await enable(value)).pending).toBe(0)
    expect(value.graphEnabled).toBe(true)
    await value.close(); runtimes.splice(runtimes.indexOf(value), 1)
    const restored = runtime(database)
    expect(restored.graphEnabled).toBe(true)
    await restored.adminGraphControl('disable')
    const metadata = new DshMetadataStore(database)
    expect(metadata.graphSettings()).toMatchObject({ enabled: false, everEnabled: true }); metadata.close()
  })

  it('preserves a preexisting manual true choice when its migration marker is absent', async () => {
    const database = await path()
    const { DatabaseSync } = await import('node:sqlite')
    const metadata = new DshMetadataStore(database)
    metadata.close()
    const db = new DatabaseSync(database)
    db.exec("DELETE FROM stratagate_dsh_settings WHERE key IN ('graphPolicyMigration', 'graphControl'); UPDATE stratagate_dsh_settings SET value = 'true' WHERE key = 'graphEnabled'")
    db.close()
    const value = runtime(database)
    await value.adminGraphControl('notice')
    expect(value.adminGraphSettings()).toMatchObject({ enabled: true, everEnabled: true, noticeSeen: true })
  })

  it('requires a preview/confirmation, preserves Events and processes only approved history in batches with pause/restart', async () => {
    const database = await path(); await seed(database)
    const model = vi.fn(async () => empty); const value = runtime(database, model)
    const before = (await value.adminSnapshot('project'))!
    expect(value.adminGraphSettings()).toMatchObject({ enabled: false, legacy: true, noticeSeen: false })
    await poll(value); expect(model).not.toHaveBeenCalled()
    await expect(value.adminGraphControl('enable')).rejects.toThrow(/统计/)
    const preview = await enable(value); expect(preview.pending).toBe(17)
    await poll(value); expect(model).toHaveBeenCalledTimes(1)
    const jobs = (await value.adminSnapshot('project'))!.graphProjectionJobs
    expect(jobs.map(job => job.sourceEventIds.length)).toEqual([8, 8, 1])
    await value.adminGraphControl('pause'); await poll(value); expect(model).toHaveBeenCalledTimes(1)
    expect(value.adminGraphSettings()).toMatchObject({ enabled: true, paused: true })
    await value.adminGraphControl('notice')
    const second = runtime(database, model)
    expect(second.adminGraphSettings()).toMatchObject({ enabled: true, paused: true, noticeSeen: true })
    expect((await enable(second)).pending).toBe(9)
    await poll(second); await poll(second); await poll(second)
    expect(model).toHaveBeenCalledTimes(3)
    const after = (await second.adminSnapshot('project'))!
    expect(after.events).toMatchObject(before.events)
    expect(after.blocks).toEqual(before.blocks)
    expect(after.graphProjectionJobs.filter(job => job.status === 'completed')).toHaveLength(3)
    await second.adminGraphControl('disable')
    await expect(second.searchGraph({} as never, 'project')).rejects.toThrow(/disabled/)
    await expect(second.expandGraphNode({} as never, 'any')).rejects.toThrow(/disabled/)
    await expect(second.adminRetryJob('project', 'graph-projection', jobs[0]!.id)).rejects.toThrow(/disabled/)
  })

  it('rejects stale confirmations after another process changes the durable choice', async () => {
    const database = await path(); const a = runtime(database), b = runtime(database)
    const preview = await a.adminGraphControl('preview') as { token: string }
    await b.adminGraphControl('disable')
    await expect(a.adminGraphControl('enable', preview.token)).rejects.toThrow(/统计|changed/)
    expect(a.graphEnabled).toBe(false)
  })

  it('exposes preview and persistent notice acknowledgement through the real HTTP handler', async () => {
    const database = await path(); await seed(database, 1); const value = runtime(database)
    const request = async (action: string) => {
      let status = 0, body = ''
      await handleAdminRequest(value, { method: 'POST', url: `/api/stratagate/graph/control?action=${action}` }, { get statusCode() { return status }, set statusCode(v) { status = v }, setHeader() {}, end(text) { body = text ?? '' } })
      return { status, body: JSON.parse(body) }
    }
    expect(await request('preview')).toMatchObject({ status: 200, body: { pending: 1, batches: 1 } })
    await request('notice'); expect(value.adminGraphSettings().noticeSeen).toBe(true)
  })

  it('reports the replacement job when an admin Graph retry succeeds', async () => {
    const database = await path(); await seed(database, 1)
    let calls = 0
    const model = vi.fn(async () => { calls += 1; if (calls === 1) throw new Error('first graph failure'); return empty })
    const value = runtime(database, model)
    await enable(value); await poll(value)
    const failed = (await value.adminSnapshot('project'))!.graphProjectionJobs.find(job => job.status === 'failed')!
    const result = await value.adminRetryJob('project', 'graph-projection', failed.id) as {
      jobId: string; status: string; job: { id: string; status: string }
    }
    expect(result).toMatchObject({ status: 'completed', job: { status: 'completed' } })
    expect(result.jobId).toBe(result.job.id)
    expect(result.jobId).not.toBe(failed.id)
    expect(calls).toBe(2)
  })
})
