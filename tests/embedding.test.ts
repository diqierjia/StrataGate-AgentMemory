import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../src/config.js'
import { EmbeddingBridge } from '../src/embedding.js'
import type { DshModelBridge } from '../src/llm.js'
import { DshMetadataStore } from '../src/metadata.js'
import { StrataGateRuntime } from '../src/runtime.js'
import { handleAdminRequest, type WebResponse } from '../src/web.js'

const roots: string[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function workspace(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), name))
  roots.push(root)
  return root
}

const models = { isReady: () => false, onAdaptersUpdated: () => () => {} } as unknown as DshModelBridge

function bridge(overrides: Record<string, string | number> = {}): EmbeddingBridge {
  return new EmbeddingBridge(resolveConfig({ database: ':memory:', ...overrides }))
}

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as unknown as Response
}

describe('EmbeddingBridge', () => {
  it('stays completely inert when unconfigured', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const unconfigured = bridge()
    expect(unconfigured.embeddingReady).toBe(false)
    expect(await unconfigured.embedQuery('anything')).toBeNull()
    expect(await unconfigured.embedEvents(['a', 'b'])).toBeNull()
    expect(await unconfigured.listEmbeddingModels()).toEqual([])
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('requires url, key and model together', () => {
    expect(bridge({ embeddingUrl: 'http://x/v1', embeddingKey: 'k' }).embeddingReady).toBe(false)
    expect(bridge({ embeddingUrl: 'http://x/v1', embeddingModel: 'm' }).embeddingReady).toBe(false)
    expect(bridge({ embeddingUrl: 'http://x/v1', embeddingKey: 'k', embeddingModel: 'm' }).embeddingReady).toBe(true)
  })

  it('embeds a query once per distinct text and sends the documented request', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return jsonResponse({ data: [{ embedding: [0.1, 0.2, 0.3] }] })
    }))
    const configured = bridge({ embeddingUrl: 'http://x/v1', embeddingKey: 'k', embeddingModel: 'm' })
    expect(await configured.embedQuery('hello')).toEqual([0.1, 0.2, 0.3])
    expect(await configured.embedQuery('hello')).toEqual([0.1, 0.2, 0.3])
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('http://x/v1/embeddings')
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer k')
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ model: 'm', input: ['hello'] })
  })

  it('embeds a batch in one call and maps vectors by position', async () => {
    const fetchSpy = vi.fn(async () => jsonResponse({ data: [{ embedding: [1] }, { embedding: [2, 3] }] }))
    vi.stubGlobal('fetch', fetchSpy)
    const configured = bridge({ embeddingUrl: 'http://x/v1', embeddingKey: 'k', embeddingModel: 'm' })
    expect(await configured.embedEvents(['a', 'b'])).toEqual([[1], [2, 3]])
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('returns null instead of throwing on HTTP errors, short payloads and network failures', async () => {
    const configured = bridge({ embeddingUrl: 'http://x/v1', embeddingKey: 'k', embeddingModel: 'm' })
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, false)))
    expect(await configured.embedQuery('q')).toBeNull()
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ data: [{ embedding: [1] }, { embedding: [2] }] })))
    expect(await configured.embedQuery('q')).toBeNull()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('boom') }))
    expect(await configured.embedEvents(['a'])).toBeNull()
  })

  it('lists models with optional credential overrides and tolerates failures', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(url)
      return jsonResponse({ data: [{ id: 'model-a' }, { id: 'model-b' }, { id: '' }] })
    }))
    const configured = bridge({ embeddingUrl: 'http://x/v1', embeddingKey: 'k', embeddingModel: 'm' })
    expect(await configured.listEmbeddingModels()).toEqual(['model-a', 'model-b'])
    expect(await configured.listEmbeddingModels({ url: 'http://y/v1', key: 'other' })).toEqual(['model-a', 'model-b'])
    expect(urls).toEqual(['http://x/v1/models', 'http://y/v1/models'])
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, false)))
    expect(await configured.listEmbeddingModels()).toEqual([])
  })

  it('scores cosine similarity and refuses mismatched shapes', () => {
    expect(EmbeddingBridge.cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1)
    expect(EmbeddingBridge.cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0)
    expect(EmbeddingBridge.cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1)
    expect(EmbeddingBridge.cosineSimilarity([1, 0], [1, 0, 0])).toBe(0)
    expect(EmbeddingBridge.cosineSimilarity([], [])).toBe(0)
    expect(EmbeddingBridge.cosineSimilarity([0, 0], [1, 0])).toBe(0)
  })
})

describe('semantic recall settings', () => {
  it('round-trips through the settings API, survives a fresh runtime, and clears cleanly', async () => {
    const root = await workspace('stratagate-vector-settings-')
    const database = join(root, 'memory.db')
    const first = new StrataGateRuntime(resolveConfig({ database }), models)
    try {
      expect((first.adminVectorSettings() as { embeddingReady: boolean }).embeddingReady).toBe(false)
      const saved = first.adminSetVectorSettings({
        embeddingUrl: 'http://embed.example/v1',
        embeddingKey: 'secret-key',
        embeddingModel: 'bge-m3',
        vectorWeight: 1.5,
        embeddingMinScore: 0.42,
      })
      expect(saved).toMatchObject({
        embeddingUrl: 'http://embed.example/v1', embeddingKey: 'secret-key', embeddingModel: 'bge-m3',
        vectorWeight: 1.5, embeddingMinScore: 0.42, embeddingReady: true,
      })
    } finally {
      await first.close()
    }

    // Written, then read back through a brand-new store and a brand-new runtime.
    const metadata = new DshMetadataStore(database)
    try {
      expect(metadata.vectorSetting('embeddingUrl')).toBe('http://embed.example/v1')
      expect(metadata.vectorSetting('embeddingModel')).toBe('bge-m3')
      expect(metadata.vectorSetting('vectorWeight')).toBe('1.5')
    } finally {
      metadata.close()
    }
    const reopened = new StrataGateRuntime(resolveConfig({ database }), models)
    try {
      await reopened.syncConfiguredSettings()
      expect(reopened.adminVectorSettings()).toMatchObject({
        embeddingUrl: 'http://embed.example/v1', embeddingKey: 'secret-key', embeddingModel: 'bge-m3',
        vectorWeight: 1.5, embeddingMinScore: 0.42, embeddingReady: true,
      })
      // Clearing a field is a real write, not a no-op.
      reopened.adminSetVectorSettings({ embeddingModel: '' })
      expect(reopened.adminVectorSettings()).toMatchObject({ embeddingUrl: 'http://embed.example/v1', embeddingModel: '', embeddingReady: false })
    } finally {
      await reopened.close()
    }
    const afterClear = new StrataGateRuntime(resolveConfig({ database }), models)
    try {
      await afterClear.syncConfiguredSettings()
      expect(afterClear.adminVectorSettings()).toMatchObject({ embeddingModel: '', embeddingReady: false })
    } finally {
      await afterClear.close()
    }
  })

  it('rejects out-of-range weights and scores without writing anything', async () => {
    const root = await workspace('stratagate-vector-settings-invalid-')
    const runtime = new StrataGateRuntime(resolveConfig({ database: join(root, 'memory.db') }), models)
    try {
      expect(() => runtime.adminSetVectorSettings({ vectorWeight: 9 })).toThrow(/vectorWeight/)
      expect(() => runtime.adminSetVectorSettings({ embeddingMinScore: -0.1 })).toThrow(/embeddingMinScore/)
      expect(() => runtime.adminSetVectorSettings({})).toThrow(/required/)
      expect((runtime.adminVectorSettings() as { embeddingReady: boolean }).embeddingReady).toBe(false)
    } finally {
      await runtime.close()
    }
  })

  it('leaves retrieval untouched when nothing is configured', async () => {
    const root = await workspace('stratagate-vector-off-')
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const runtime = new StrataGateRuntime(resolveConfig({ database: join(root, 'memory.db'), embeddingUrl: '', embeddingKey: '', embeddingModel: '' }), models)
    try {
      await runtime.syncConfiguredSettings()
      expect((runtime.adminVectorSettings() as { embeddingReady: boolean }).embeddingReady).toBe(false)
      expect(await runtime.adminListEmbeddingModels()).toEqual([])
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      await runtime.close()
    }
  })
})

describe('settings API and model listing routes', () => {
  async function request(runtime: StrataGateRuntime, url: string, method = 'GET'): Promise<{ status: number; body: any }> {
    const headers: Record<string, string> = {}
    let text = ''
    const response: WebResponse = {
      statusCode: 0,
      setHeader: (name, value) => { headers[name] = value },
      end: (body) => { text = body },
    }
    await handleAdminRequest(runtime, { method, url }, response)
    return { status: response.statusCode, body: text ? JSON.parse(text) : null }
  }

  it('writes embedding settings over PATCH and reads them back', async () => {
    const root = await workspace('stratagate-vector-api-')
    const runtime = new StrataGateRuntime(resolveConfig({ database: join(root, 'memory.db') }), models)
    try {
      const saved = await request(runtime,
        '/api/stratagate/settings?embeddingUrl=http%3A%2F%2Fembed.example%2Fv1&embeddingKey=k&embeddingModel=bge-m3&vectorWeight=1.2&embeddingMinScore=0.35',
        'PATCH')
      expect(saved.status).toBe(200)
      expect(saved.body.vectorSettings).toMatchObject({
        embeddingUrl: 'http://embed.example/v1', embeddingKey: 'k', embeddingModel: 'bge-m3',
        vectorWeight: 1.2, embeddingMinScore: 0.35, embeddingReady: true,
      })
      const read = await request(runtime, '/api/stratagate/settings?embeddingUrl=')
      expect(read.status).toBe(405)
      expect((await request(runtime, '/api/stratagate/settings', 'PATCH')).status).toBe(400)
      expect((await request(runtime, '/api/stratagate/settings?vectorWeight=9', 'PATCH')).status).toBe(400)
      expect((await request(runtime, '/api/stratagate/settings?embeddingMinScore=2', 'PATCH')).status).toBe(400)
    } finally {
      await runtime.close()
    }
  })

  it('lists embedding models from the configured endpoint', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ data: [{ id: 'bge-m3' }, { id: 'bge-large' }] })))
    const root = await workspace('stratagate-vector-models-')
    const runtime = new StrataGateRuntime(resolveConfig({ database: join(root, 'memory.db') }), models)
    try {
      runtime.adminSetVectorSettings({ embeddingUrl: 'http://embed.example/v1', embeddingKey: 'k', embeddingModel: 'bge-m3' })
      const listed = await request(runtime, '/api/stratagate/models?kind=embedding')
      expect(listed.status).toBe(200)
      expect(listed.body).toEqual({ kind: 'embedding', models: ['bge-m3', 'bge-large'] })
      expect((await request(runtime, '/api/stratagate/models?kind=nope')).status).toBe(400)
      expect((await request(runtime, '/api/stratagate/models', 'POST')).status).toBe(405)
    } finally {
      await runtime.close()
    }
  })
})
