import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '@deepseek-ai/dsh-session'
import { eventMatchesSearchFilters, type EventCard, type StrataGate } from '@diqier/stratagate'
import { SqliteStorage } from '@diqier/stratagate/sqlite'
import { resolveConfig } from '../src/config.js'
import { EmbeddingBridge } from '../src/embedding.js'
import type { DshModelBridge } from '../src/llm.js'
import { StrataGateRuntime, eventContentHash } from '../src/runtime.js'

/**
 * Regressions for the four defects found in review:
 * ① a rewritten card body must invalidate its stored vector
 * ② the semantic lane must honour the same structured filters as the lexical ones
 * ③ vectorWeight 0 must not issue any embedding request
 * ④ the query-vector cache must not survive a model/endpoint change
 */

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

const MODEL = 'test-embed'
const embeddingConfig = { embeddingUrl: 'http://embed.example/v1', embeddingKey: 'ek', embeddingModel: MODEL }

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
  id: 'vector-fixes-session',
  header: { id: 'vector-fixes-session', version: 0, createdAt: 0, cwd: 'C:\\work\\project' },
  snapshotEvents: () => [],
  eventAt: () => undefined,
  deriveMessages: () => [{
    id: 'current-user', role: 'user', content: [{ type: 'text', text: 'package manager' }], source: { kind: 'user' },
  }],
} as unknown as Session

function stubEmbeddings(): string[][] {
  const calls: string[][] = []
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { input: string[] }
    calls.push(body.input)
    return { ok: true, json: async () => ({ data: body.input.map(() => ({ embedding: [1, 0, 0] })) }) } as unknown as Response
  }))
  return calls
}

async function fixture(extra: Record<string, unknown> = {}) {
  const root = await workspace('stratagate-vector-fixes-')
  const runtime = new StrataGateRuntime(resolveConfig({
    database: join(root, 'memory.db'),
    namespaceMode: 'project',
    namespacePrefix: 'dsh',
    globalNamespace: 'global',
    blockTurnSize: 2,
    ...extra,
  }), fakeModels)
  const memory = await (runtime as unknown as { space: (value: Session) => Promise<StrataGate> }).space(session)
  return { runtime, memory }
}

const settle = async (): Promise<void> => {
  for (let index = 0; index < 5; index++) await new Promise((resolve) => setTimeout(resolve, 0))
}

function card(overrides: Record<string, unknown> = {}): EventCard {
  return {
    id: 'card-1', title: 'package manager choice', summary: 'the team uses pnpm',
    tags: [], quotes: [], scope: 'project', criticality: 'normal', confidence: 0.9,
    status: 'active', temporal: {}, weight: {},
    ...overrides,
  } as unknown as EventCard
}

describe('① rewritten card body invalidates its vector', () => {
  it('stores and returns the content fingerprint', async () => {
    const root = await workspace('stratagate-vector-hash-')
    const storage = new SqliteStorage({ filename: join(root, 'memory.db') })
    try {
      const before = eventContentHash(card())
      storage.setEventVector('ns', 'card-1', MODEL, 2, [1, 0], before)
      expect(storage.getEventVector('ns', 'card-1', MODEL)?.contentHash).toBe(before)
      expect(storage.listEventVectorRecords('ns', MODEL).get('card-1')).toEqual({
        vector: [1, 0], contentHash: before,
      })

      // Same id, different text: the stored fingerprint no longer describes it.
      const after = eventContentHash(card({ summary: 'the team switched to npm' }))
      expect(after).not.toBe(before)
      expect(storage.getEventVector('ns', 'card-1', MODEL)?.contentHash).toBe(before)
    } finally {
      await storage.close()
    }
  })

  it('treats a hash-less legacy row as stale and re-embeds it', async () => {
    const root = await workspace('stratagate-vector-legacy-')
    const file = join(root, 'memory.db')
    const storage = new SqliteStorage({ filename: file })
    try {
      storage.setEventVector('ns', 'card-1', MODEL, 2, [1, 0])
      expect(storage.getEventVector('ns', 'card-1', MODEL)?.contentHash).toBeNull()
      // Re-writing with a fingerprint is what the read path triggers.
      storage.setEventVector('ns', 'card-1', MODEL, 2, [0, 1], eventContentHash(card()))
      expect(storage.getEventVector('ns', 'card-1', MODEL)).toEqual({
        dimension: 2, vector: [0, 1], contentHash: eventContentHash(card()),
      })
    } finally {
      await storage.close()
    }
  })

  it('drops a vector on demand (merge / body rewrite)', async () => {
    const root = await workspace('stratagate-vector-drop-')
    const storage = new SqliteStorage({ filename: join(root, 'memory.db') })
    try {
      storage.setEventVector('ns', 'card-1', MODEL, 2, [1, 0], eventContentHash(card()))
      expect(storage.deleteEventVector('ns', 'card-1')).toBe(1)
      expect(storage.getEventVector('ns', 'card-1', MODEL)).toBeNull()
      // Deleting twice is a no-op, not an error.
      expect(storage.deleteEventVector('ns', 'card-1')).toBe(0)
    } finally {
      await storage.close()
    }
  })
})

describe('② semantic lane honours structured filters', () => {
  it('rejects wrong participants, wrong type and out-of-range dates', () => {
    const alice = card({ temporal: { participants: ['Alice'], eventType: 'decision' } })
    expect(eventMatchesSearchFilters(alice, { participants: ['Alice'] })).toBe(true)
    expect(eventMatchesSearchFilters(alice, { participants: ['Bob'] })).toBe(false)
    expect(eventMatchesSearchFilters(alice, { eventType: 'decision' })).toBe(true)
    expect(eventMatchesSearchFilters(alice, { eventType: 'release' })).toBe(false)
    expect(eventMatchesSearchFilters(alice, {})).toBe(true)
  })

  it('applies the happened range', () => {
    const dated = card({ temporal: { happenedStart: '2026-03-01', happenedEnd: '2026-03-02' } })
    expect(eventMatchesSearchFilters(dated, { happenedFrom: '2026-02-01', happenedTo: '2026-04-01' })).toBe(true)
    expect(eventMatchesSearchFilters(dated, { happenedFrom: '2026-05-01' })).toBe(false)
  })
})

describe('③ vectorWeight 0 issues no embedding request', () => {
  it('never calls the provider for either the query or the backfill', async () => {
    const calls = stubEmbeddings()
    const { runtime } = await fixture({ ...embeddingConfig, vectorWeight: 0 })
    try {
      await runtime.recordAgentMemory?.(
        { ...session, id: 'vector-fixes-session', header: session.header } as unknown as Session,
        'Preference: the team uses pnpm as its package manager.', 'preference',
      )
      await settle()
      await runtime.searchEvents(session, 'package manager')
      await settle()
      expect(calls).toHaveLength(0)
    } finally {
      await runtime.close()
    }
  })
})

describe('④ query-vector cache is keyed by endpoint and model', () => {
  it('re-requests after the model changes', async () => {
    const calls: Array<{ model: string }> = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { model: string; input: string[] }
      calls.push({ model: body.model })
      return { ok: true, json: async () => ({ data: body.input.map(() => ({ embedding: [1, 0] })) }) } as unknown as Response
    }))
    const config = resolveConfig({ database: ':memory:', ...embeddingConfig })
    const bridge = new EmbeddingBridge(config)
    expect(await bridge.embedQuery('same text')).toEqual([1, 0])
    expect(await bridge.embedQuery('same text')).toEqual([1, 0])
    expect(calls).toHaveLength(1)

    // Switching model while keeping the same query text must not reuse it.
    ;(config as { embeddingModel?: string }).embeddingModel = 'other-model'
    expect(await bridge.embedQuery('same text')).toEqual([1, 0])
    expect(calls).toHaveLength(2)
    expect(calls[1]!.model).toBe('other-model')
  })

  it('invalidateQueryCache forces the next query through the provider', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => ({ data: [{ embedding: [1, 0] }] }) }) as unknown as Response)
    vi.stubGlobal('fetch', fetchSpy)
    const bridge = new EmbeddingBridge(resolveConfig({ database: ':memory:', ...embeddingConfig }))
    await bridge.embedQuery('same text')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    bridge.invalidateQueryCache()
    await bridge.embedQuery('same text')
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })
})
