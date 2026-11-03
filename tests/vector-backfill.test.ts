import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '@deepseek-ai/dsh-session'
import type { StrataGate } from '@diqier/stratagate'
import { resolveConfig } from '../src/config.js'
import type { DshModelBridge } from '../src/llm.js'
import { StrataGateRuntime } from '../src/runtime.js'

const roots: string[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

const MODEL = 'test-embed'

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
  id: 'vector-session',
  header: { id: 'vector-session', version: 0, createdAt: 0, cwd: 'C:\\work\\project' },
  snapshotEvents: () => [],
  eventAt: () => undefined,
} as unknown as Session

const embeddingConfig = { embeddingUrl: 'http://embed.example/v1', embeddingKey: 'ek', embeddingModel: MODEL }

/** Deterministic pseudo-vectors: the same meaning always maps to the same pole. */
function embeddingFor(text: string): number[] {
  return text.includes('pnpm') || text.includes('包管理器') ? [1, 0, 0] : [0, 1, 0]
}

function stubEmbeddings() {
  const calls: string[][] = []
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { input: string[] }
    calls.push(body.input)
    return { ok: true, json: async () => ({ data: body.input.map((text) => ({ embedding: embeddingFor(text) })) }) } as unknown as Response
  }))
  return calls
}

async function fixture(extra: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'stratagate-vector-write-'))
  roots.push(root)
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
      id: 'current-user', role: 'user', content: [{ type: 'text', text: 'package manager' }], source: { kind: 'user' },
    }],
  } as unknown as Session
  const memory = await (runtime as unknown as { space: (value: Session) => Promise<StrataGate> }).space(active)
  return { runtime, active, memory }
}

/** Fire-and-forget vectorization needs the microtask queue to drain. */
const settle = async (): Promise<void> => {
  for (let index = 0; index < 5; index++) await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('vector write path', () => {
  it('writes a vector as soon as an agent memory is recorded', async () => {
    const calls = stubEmbeddings()
    const { runtime, memory } = await fixture(embeddingConfig)
    try {
      const recorded = await runtime.recordAgentMemory?.(
        { ...session, id: 'vector-session', header: session.header } as unknown as Session,
        'Preference: the team uses pnpm as its package manager.', 'preference',
      ) as { recorded?: boolean; eventId?: string } | undefined
      expect(recorded?.recorded).toBe(true)
      await settle()
      expect(calls.length).toBeGreaterThan(0)
      // The card was embedded at write time, not on a later sweep.
      const vectors = memory.listEventVectors(MODEL)
      expect(vectors.get(recorded!.eventId!)).toEqual([1, 0, 0])
    } finally {
      await runtime.close()
    }
  })

  it('backfills stored events that predate the configuration, then recalls them semantically', async () => {
    const { runtime, active, memory } = await fixture()
    try {
      const history = await runtime.recordAgentMemory?.(
        { ...session, id: 'vector-session', header: session.header } as unknown as Session,
        'Preference: the team uses pnpm as its package manager.', 'preference',
      ) as { recorded?: boolean; eventId?: string } | undefined
      expect(history?.recorded).toBe(true)
      expect(memory.listEventVectors(MODEL).size).toBe(0)

      // Configure embedding afterwards: the existing Event has no vector yet.
      stubEmbeddings()
      runtime.adminSetVectorSettings({ ...embeddingConfig, embeddingMinScore: 0 })
      await runtime.buildAutoContext(active)
      await settle()
      expect(memory.listEventVectors(MODEL).get(history!.eventId!)).toEqual([1, 0, 0])

      // And the recall pipeline now finds it through the semantic lane only:
      // the Chinese query shares no token with the English card.
      const semantic = { ...active, deriveMessages: () => [{
        id: 'current-user', role: 'user', content: [{ type: 'text', text: '包管理器' }], source: { kind: 'user' },
      }] } as unknown as Session
      const context = await runtime.buildAutoContext(semantic)
      expect(context).toContain(history!.eventId!)
    } finally {
      await runtime.close()
    }
  })

  it('does not re-arm the backfill cooldown after a failed embedding call', async () => {
    const failing = vi.fn(async () => { throw new Error('embedding down') })
    vi.stubGlobal('fetch', failing)
    const { runtime, active, memory } = await fixture(embeddingConfig)
    try {
      const recorded = await runtime.recordAgentMemory?.(
        { ...session, id: 'vector-session', header: session.header } as unknown as Session,
        'Preference: the team uses pnpm as its package manager.', 'preference',
      ) as { recorded?: boolean; eventId?: string } | undefined
      await settle()
      expect(memory.listEventVectors(MODEL).size).toBe(0)

      // A failure must not start a 30 s window: the next retrieval retries now.
      const attemptsBefore = failing.mock.calls.length
      stubEmbeddings()
      await runtime.buildAutoContext(active)
      await settle()
      expect(memory.listEventVectors(MODEL).get(recorded!.eventId!)).toEqual([1, 0, 0])
      expect(failing.mock.calls.length).toBeGreaterThanOrEqual(attemptsBefore)
    } finally {
      await runtime.close()
    }
  })
})
