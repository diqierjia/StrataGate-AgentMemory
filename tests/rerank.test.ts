import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '@deepseek-ai/dsh-session'
import type { StrataGate } from '@diqier/stratagate'
import { resolveConfig } from '../src/config.js'
import { EmbeddingBridge } from '../src/embedding.js'
import type { DshModelBridge } from '../src/llm.js'
import { StrataGateRuntime } from '../src/runtime.js'

const roots: string[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'stratagate-rerank-'))
  roots.push(root)
  return root
}

const fakeModels = {
  isReady: () => false,
  onAdaptersUpdated: () => () => {},
  summarizer: async () => ({ l0Title: 'turns', l0Tags: [], l1Summary: 'turns', l2Keypoints: [], shouldExtract: false }),
  extractor: async () => ({ shouldExtract: false, reason: 'none', events: [] }),
  projector: async () => ({ reason: 'none', changes: [] }),
  graphProjector: async () => ({ reason: 'none', nodes: [], edges: [] }),
  run: async <T>(_session: unknown, task: () => Promise<T>): Promise<T> => task(),
} as unknown as DshModelBridge

const session = {
  id: 'rerank-session',
  header: { id: 'rerank-session', version: 0, createdAt: 0, cwd: 'C:\\work\\project' },
  snapshotEvents: () => [],
  eventAt: () => undefined,
} as unknown as Session

function bridge(overrides: Record<string, string> = {}): EmbeddingBridge {
  return new EmbeddingBridge(resolveConfig({ database: ':memory:', ...overrides }))
}

const rerankConfig = { rerankUrl: 'http://rerank.example/v1', rerankKey: 'rk', rerankModel: 'bge-reranker' }

describe('EmbeddingBridge.rerank', () => {
  it('stays inert and never calls the network when unconfigured', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const off = bridge()
    expect(off.rerankReady).toBe(false)
    expect(await off.rerank('q', ['a', 'b'])).toBeNull()
    expect(await off.listRerankModels()).toEqual([])
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('posts the documented payload and returns scores in input order', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      // Deliberately out of order: the bridge maps by reported index.
      return { ok: true, json: async () => ({ results: [{ index: 1, relevance_score: 0.9 }, { index: 0, relevance_score: 0.2 }] }) } as unknown as Response
    }))
    const configured = bridge(rerankConfig)
    expect(await configured.rerank('deployment', ['first', 'second'])).toEqual([0.2, 0.9])
    expect(calls[0]!.url).toBe('http://rerank.example/v1/rerank')
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer rk')
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      model: 'bge-reranker', query: 'deployment', documents: ['first', 'second'],
    })
  })

  it('falls back to null on HTTP errors, wrong result counts and thrown requests', async () => {
    const configured = bridge(rerankConfig)
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) }) as unknown as Response))
    expect(await configured.rerank('q', ['a', 'b'])).toBeNull()
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ results: [{ index: 0, relevance_score: 1 }] }) }) as unknown as Response))
    expect(await configured.rerank('q', ['a', 'b'])).toBeNull()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down') }))
    expect(await configured.rerank('q', ['a', 'b'])).toBeNull()
  })

  it('aborts after five seconds and returns null instead of blocking recall', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    })))
    const configured = bridge(rerankConfig)
    const pending = configured.rerank('q', ['a', 'b'])
    await vi.advanceTimersByTimeAsync(5_000)
    expect(await pending).toBeNull()
  })
})

describe('passive-recall rerank', () => {
  async function fixture(extra: Record<string, unknown> = {}) {
    const root = await workspace()
    const runtime = new StrataGateRuntime(resolveConfig({
      database: join(root, 'memory.db'),
      namespaceMode: 'project',
      namespacePrefix: 'dsh',
      globalNamespace: 'global',
      blockTurnSize: 2,
      ...extra,
    }), fakeModels)
    const active = {
      ...session,
      deriveMessages: () => [{
        id: 'current-user',
        role: 'user',
        content: [{ type: 'text', text: 'deployment pipeline' }],
        source: { kind: 'user' },
      }],
    } as unknown as Session
    const memory = await (runtime as unknown as { space: (value: Session) => Promise<StrataGate> }).space(active)
    // Recall ignores Events that belong to the current thread's own blocks, so
    // the seeded history must come from a different thread.
    for (let index = 0; index < 2; index++) {
      await memory.appendTurn({ user: `seeded turn ${index}`, assistant: 'ok', threadId: 'history-thread' })
    }
    const block = memory.listBlocks().at(-1)!
    const first = await memory.addEvent({
      title: 'Deployment pipeline uses GitHub Actions',
      summary: 'The deployment pipeline runs on GitHub Actions for every release.',
      sourceBlockId: block.id,
      sourceMessageIds: [block.l5Raw[0]!.id],
    })
    const second = await memory.addEvent({
      title: 'Deployment pipeline rollback plan',
      summary: 'The deployment pipeline rollback is a manual decision.',
      sourceBlockId: block.id,
      sourceMessageIds: [block.l5Raw[0]!.id],
    })
    return { runtime, active, first, second }
  }

  const idsOf = (context: string): string[] => [...context.matchAll(/- \{"id":"(evt_[^"]+)"/g)].map((match) => match[1]!)

  it('leaves recall completely untouched when rerank is unconfigured', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const { runtime, active, first, second } = await fixture()
    try {
      const context = await runtime.buildAutoContext(active)
      expect(idsOf(context).sort()).toEqual([first.id, second.id].sort())
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      await runtime.close()
    }
  })

  it('reorders recall candidates by rerank score after a live settings change', async () => {
    const requests: string[] = []
    const { runtime, active } = await fixture()
    try {
      const before = idsOf(await runtime.buildAutoContext(active))
      expect(before).toHaveLength(2)
      // Hot swap through the settings API, exactly like the panel does.
      runtime.adminSetVectorSettings({ rerankUrl: 'http://rerank.example/v1', rerankKey: 'rk', rerankModel: 'bge-reranker' })
      vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        requests.push(url)
        // Invert the candidate order recall produced.
        return { ok: true, json: async () => ({ results: [{ index: 0, relevance_score: 0.1 }, { index: 1, relevance_score: 0.9 }] }) } as unknown as Response
      }))
      const after = idsOf(await runtime.buildAutoContext(active))
      expect(requests).toEqual(['http://rerank.example/v1/rerank'])
      expect(after).toEqual([...before].reverse())
    } finally {
      await runtime.close()
    }
  })

  it('silently keeps the fused order when the rerank service fails', async () => {
    const { runtime, active } = await fixture()
    try {
      const baseline = idsOf(await runtime.buildAutoContext(active))
      expect(baseline).toHaveLength(2)
      runtime.adminSetVectorSettings({ rerankUrl: 'http://rerank.example/v1', rerankKey: 'rk', rerankModel: 'bge-reranker' })
      vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('rerank down') }))
      expect(idsOf(await runtime.buildAutoContext(active))).toEqual(baseline)
      // An HTTP-level failure is equally silent.
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) }) as unknown as Response))
      expect(idsOf(await runtime.buildAutoContext(active))).toEqual(baseline)
    } finally {
      await runtime.close()
    }
  })

  it('does not call the rerank service for a single candidate', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const { runtime, active } = await fixture({ ...rerankConfig })
    try {
      // "rollback" recalls one Event only, so there is nothing to rerank.
      const single = { ...active, deriveMessages: () => [{
        id: 'current-user', role: 'user', content: [{ type: 'text', text: 'rollback' }], source: { kind: 'user' },
      }] } as unknown as Session
      await runtime.buildAutoContext(single)
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      await runtime.close()
    }
  })
})
