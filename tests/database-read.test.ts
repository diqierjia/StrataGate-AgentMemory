import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StrataGate } from '@diqier/stratagate'
import { SqliteStorage } from '@diqier/stratagate/sqlite'
import type { StrataGateRuntime } from '../src/runtime.js'
import { handleAdminRequest, type WebResponse } from '../src/web.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function request(runtime: StrataGateRuntime, url: string) {
  let text = ''
  const response: WebResponse = { statusCode: 0, setHeader() {}, end(body) { text = body } }
  await handleAdminRequest(runtime, { method: 'GET', url }, response)
  expect(response.statusCode, `${url}: ${text}`).toBe(200)
  return JSON.parse(text)
}
async function fixture(legacy = false, count = 12) {
  const root = await mkdtemp(join(tmpdir(), 'stratagate-read-')); roots.push(root)
  const storage = new SqliteStorage({ filename: join(root, 'memory.db') })
  // This suite checks persisted read projections, not per-turn write costs.
  // Build the same history in memory and persist it once before querying SQLite.
  const memory = StrataGate.inMemory({ blockTurnSize: 1, disableElementProjection: true,
    summarizer: async messages => ({ l0Title: messages[0]!.content.slice(0, 32), l0Tags: [], l1Summary: 'Summary', l2Keypoints: [], shouldExtract: false }) })
  for (let index = 0; index < count; index++) {
    await memory.appendTurn({ user: `message ${index}`, assistant: `answer ${index}`, ...(legacy ? {} : { threadId: index < 9 ? 'a' : 'b' }),
      assistantToolCalls: [{ name: 'tool', arguments: { text: `payload ${index}` }, result: { data: 'z'.repeat(500) } }] })
  }
  await memory.appendTurn({ user: '\n\t', assistant: 'open tail', ...(legacy ? {} : { threadId: 'c' }) }, { deferProcessing: true })
  const block = memory.listBlocks()[3]!
  const event = await memory.addEvent({ title: 'associated result', summary: 'match beyond first page', sourceBlockId: block.id,
    sourceMessageIds: [block.l5Raw[0]!.id], tags: [], quotes: [], temporal: {}, criticality: 'routine' })
  await memory.recordMemoryUse({ eventIds: [event.id] }, { receiptId: 'receipt' })
  const revision = await storage.save('test', memory.exportSnapshot(), 0)
  const snapshot = (await storage.load('test'))!.snapshot
  const base = { adminSnapshot: async () => snapshot, adminNamespaces: async () => ['test'],
    adminSnapshotEntries: async () => [{ namespace: 'test', revision, snapshot }],
    adminAgentMemoryRetrievalWeight: () => 1, adminWorkspaceName: () => 'Test' }
  const full = base as unknown as StrataGateRuntime
  const projected = { ...base,
    adminReadBlockPage: (_namespace: string, options: any, choose: any) => storage.readBlockPage('test', options, choose),
    adminReadEventModel: () => storage.readEventModel('test'),
    adminReadNamespaceRevisions: () => storage.listNamespaceRevisions(),
    adminReadDashboardEntries: (options: any, choose: any) => storage.readDashboardEntries(options, choose),
  } as unknown as StrataGateRuntime
  return { storage, memory, full, projected }
}

describe('database-backed admin reads', () => {
  it.each([false, true])('preserves list, search and dashboard JSON (legacy=%s)', async legacy => {
    const f = await fixture(legacy)
    try {
      for (const suffix of ['', '&threadId=a', '&threadId=b', '&threadId=missing', '&threadId=a&offset=3', '&offset=999', '&q=associated']) {
        const url = `/api/stratagate/memories?namespace=test&kind=blocks&limit=3${suffix}`
        expect(await request(f.projected, url)).toEqual(await request(f.full, url))
      }
      for (const suffix of ['', '&threadId=a', '&threadId=b', '&threadId=missing', '&offset=3', '&offset=999', '&q=associated']) {
        const url = `/api/stratagate/dashboard?namespace=test${suffix}`
        expect(await request(f.projected, url)).toEqual(await request(f.full, url))
      }
      for (const suffix of ['', '&offset=3', '&q=associated', '&timeline=true', '&time=unknown']) {
        const url = `/api/stratagate/memories?namespace=test&kind=events&limit=3${suffix}`
        expect(await request(f.projected, url)).toEqual(await request(f.full, url))
      }
    } finally { await f.storage.close() }
  })

  it('does not load a full snapshot or hydrate tool payloads outside the selected page', async () => {
    const f = await fixture()
    try {
      const load = vi.spyOn(f.storage, 'load')
      const page = f.storage.readBlockPage('test', { threadId: 'a', offset: 3, limit: 2 }, () => 'a')!
      expect(load).not.toHaveBeenCalled()
      expect(page.blockIds).toEqual(f.memory.listBlocks().slice(3, 5).map(block => block.id))
      expect(page.total).toBe(9)
      expect(page.model.blocks[0]!.l5Raw[1]!.toolCalls).toBeUndefined()
      expect(page.model.blocks[3]!.l5Raw[1]!.toolCalls).toEqual(f.memory.listBlocks()[3]!.l5Raw[1]!.toolCalls)
      expect('schemaVersion' in page.model).toBe(false)
    } finally { await f.storage.close() }
  })

  it('hydrates a dashboard page beyond the first forty blocks and keeps audit provenance complete', async () => {
    const f = await fixture(false, 64)
    try {
      const url = '/api/stratagate/dashboard?namespace=test&threadId=b&offset=40'
      expect(await request(f.projected, url)).toEqual(await request(f.full, url))
    } finally { await f.storage.close() }
  })

  it('returns unchanged dashboards before hydrating data, and separates page and search cache keys', async () => {
    const f = await fixture()
    try {
      const read = vi.spyOn(f.storage, 'readDashboardEntries')
      const url = '/api/stratagate/dashboard?namespace=test&threadId=a'
      const invoke = async (target: string, etag?: string) => {
        let currentEtag = '', text = ''
        const response: WebResponse = { statusCode: 0, setHeader(name, value) { if (name === 'ETag') currentEtag = String(value) }, end(body) { text = body } }
        await handleAdminRequest(f.projected, { method: 'GET', url: target, ...(etag ? { headers: { 'if-none-match': etag } } : {}) }, response)
        return { status: response.statusCode, etag: currentEtag, text }
      }
      const first = await invoke(url)
      expect(first.status).toBe(200)
      read.mockClear()
      expect((await invoke(url, first.etag)).status).toBe(304)
      expect(read).not.toHaveBeenCalled()
      expect((await invoke(url + '&offset=3', first.etag)).status).toBe(200)
      expect((await invoke(url + '&q=associated', first.etag)).status).toBe(200)
    } finally { await f.storage.close() }
  })
})
