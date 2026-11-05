import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session } from '@deepseek-ai/dsh-session'
import { estimateTokens, renderBlock } from '@diqier/stratagate'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { surfaceFixture, surfaceRuntime } from './fixtures/surface-maintenance.js'

afterEach(() => vi.restoreAllMocks())

describe('explicit user Block selections', () => {
  it.each([4, 5])('keeps a manual L%s larger than 4096 tokens through request and background maintenance', async (level) => {
    const f = await surfaceFixture(1, undefined, undefined, 420)
    try {
      await f.run()
      expect(f.level()).toBeLessThan(4)
      expect(estimateTokens(renderBlock(f.memory.listBlocks()[0]!, level as 4 | 5))).toBeGreaterThan(4096)
      f.session.append('request/context', { provider: 'test', model: 'large', contextWindow: 128_000 })
      const result = await f.plugin.adminExpandBlock(f.namespace, f.ids[0]!, level)
      expect(result).toMatchObject({ surfaceLevel: level, surfaceSync: { status: 'applied' } })
      const raw = structuredClone(f.memory.listBlocks()[0]!.l5Raw)
      const render = vi.spyOn(f.memory, 'getBlockContext')
      const before = f.session.seq
      await f.plugin.buildAutoContext(f.session)
      await f.plugin.buildAutoContext(f.session)
      expect(render).not.toHaveBeenCalled()
      f.mark()
      await f.run()
      expect(f.level()).toBe(level)
      expect(f.session.seq).toBe(before)
      expect(f.memory.listBlocks()[0]!.l5Raw).toEqual(raw)
    } finally { await f.dispose() }
  })

  it('allows a manual selection above 4% of a small window and below its full capacity', async () => {
    const f = await surfaceFixture(1)
    try {
      await f.run()
      f.session.append('request/context', { provider: 'test', model: 'small', contextWindow: 10_000 })
      await f.plugin.adminExpandBlock(f.namespace, f.ids[0]!, 5)
      expect(estimateTokens(JSON.stringify(f.session.deriveMessages()))).toBeGreaterThan(400)
      await f.plugin.buildAutoContext(f.session)
      f.mark()
      await f.run()
      expect(f.level()).toBe(5)
    } finally { await f.dispose() }
  })

  it('keeps the user selection when the model window has not been advertised', async () => {
    const f = await surfaceFixture(1, undefined, undefined, 420)
    try {
      await f.run()
      await f.plugin.adminExpandBlock(f.namespace, f.ids[0]!, 5)
      expect(f.level()).toBe(5)
      await f.plugin.buildAutoContext(f.session)
      expect(f.level()).toBe(5)
    } finally { await f.dispose() }
  })

  it('counts the rest of the conversation, tools, and output reserve before changing the pointer', async () => {
    const f = await surfaceFixture(1)
    try {
      await f.plugin.adminExpandBlock(f.namespace, f.ids[0]!, 0)
      f.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Unrelated context. '.repeat(120) }], source: { kind: 'user' } }), { surfaceOp: 'append' })
      f.session.append('request/header', {
        reason: 'initial', header: { config: { provider: 'test', model: 'small', maxTokens: 700 }, tools: [{ name: 'inspect', description: 'Tool schema. '.repeat(100), parameters: { type: 'object', properties: {} } }] },
      })
      f.session.append('request/context', { provider: 'test', model: 'small', contextWindow: 1500 })
      const original = structuredClone(f.memory.listBlocks()[0])
      const before = f.session.seq
      await expect(f.plugin.adminExpandBlock(f.namespace, f.ids[0]!, 5)).rejects.toThrow('当前模型预计放不下')
      expect(f.memory.listBlocks()[0]).toEqual(original)
      expect(f.session.seq).toBe(before)
      expect(f.plugin.adminBlockSurfaceSync(f.namespace, f.ids[0]!)).toBeUndefined()
    } finally { await f.dispose() }
  })

  it('applies a later lower selection even when the conversation already exceeds its window', async () => {
    const f = await surfaceFixture(1, undefined, undefined, 420)
    try {
      await f.plugin.adminExpandBlock(f.namespace, f.ids[0]!, 5)
      f.session.append('request/context', { provider: 'test', model: 'tiny', contextWindow: 100 })
      f.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Other context. '.repeat(100) }], source: { kind: 'user' } }), { surfaceOp: 'append' })
      expect(await f.plugin.adminExpandBlock(f.namespace, f.ids[0]!, 0)).toMatchObject({ surfaceLevel: 0, surfaceSync: { status: 'applied' } })
      await f.plugin.buildAutoContext(f.session)
      expect(f.level()).toBe(0)
    } finally { await f.dispose() }
  })

  it('retains an explicit lower selection across restart and protects it from Agent evidence reads', async () => {
    const f = await surfaceFixture(1)
    let restarted: ReturnType<typeof surfaceRuntime> | undefined
    try {
      f.internals.knownSessions.delete(String(f.session.id))
      expect(await f.plugin.adminExpandBlock(f.namespace, f.ids[0]!, 0)).toMatchObject({ surfaceLevel: 5, surfaceSync: { status: 'pending' } })
      const original = structuredClone(f.memory.listBlocks()[0])
      const revision = f.memory.storageRevision
      expect(await f.memory.expandBlock(f.ids[0]!, 5, 'agent')).toMatchObject({ level: 5 })
      expect(f.memory.listBlocks()[0]).toEqual(original)
      expect(f.memory.storageRevision).toBe(revision)
      await f.plugin.close()
      restarted = surfaceRuntime(f.database)
      await restarted.buildAutoContext(f.session)
      expect(f.level()).toBe(0)
    } finally { await restarted?.close(); await f.dispose() }
  })

  it('blocks a deferred capacity failure once, reports it, and retries after a model capacity change', async () => {
    const errors: unknown[] = []
    const f = await surfaceFixture(1, undefined, (error) => errors.push(error))
    try {
      await f.plugin.adminExpandBlock(f.namespace, f.ids[0]!, 0)
      f.internals.knownSessions.delete(String(f.session.id))
      expect(await f.plugin.adminExpandBlock(f.namespace, f.ids[0]!, 5)).toMatchObject({ surfaceSync: { status: 'pending' } })
      f.session.append('request/context', { provider: 'test', model: 'tiny', contextWindow: 100 })
      await f.plugin.buildAutoContext(f.session)
      expect(f.plugin.adminBlockSurfaceSync(f.namespace, f.ids[0]!)).toMatchObject({ status: 'blocked', reason: 'capacity', message: expect.stringContaining('当前模型预计放不下') })
      expect(errors).toHaveLength(1)
      const render = vi.spyOn(f.memory, 'getBlockContext')
      await f.plugin.buildAutoContext(f.session)
      await f.plugin.buildAutoContext(f.session)
      expect(render).not.toHaveBeenCalled()
      expect(errors).toHaveLength(1)
      const event = f.session.append('request/context', { provider: 'test', model: 'large', contextWindow: 128_000 })
      f.plugin.acceptEvent(f.session, event)
      await f.plugin.buildAutoContext(f.session)
      expect(f.level()).toBe(5)
      expect(f.plugin.adminBlockSurfaceSync(f.namespace, f.ids[0]!)).toBeUndefined()
    } finally { await f.dispose() }
  })

  it('reports compaction as pending and applies the selection after it ends', async () => {
    const f = await surfaceFixture(1)
    try {
      await f.plugin.adminExpandBlock(f.namespace, f.ids[0]!, 0)
      f.session.append('compaction/start', { compactionId: 'manual-selection' as never, turn: null })
      expect(await f.plugin.adminExpandBlock(f.namespace, f.ids[0]!, 5)).toMatchObject({ surfaceSync: { status: 'pending', reason: 'compaction', message: expect.stringContaining('正在整理这段对话') } })
      expect(f.level()).toBeLessThan(5)
      const end = f.session.append('compaction/end', { compactionId: 'manual-selection' as never, turn: null, error: 'cancelled' })
      f.plugin.acceptEvent(f.session, end)
      await f.plugin.buildAutoContext(f.session)
      expect(f.level()).toBe(5)
    } finally { await f.dispose() }
  })

  it('rechecks a blocked selection when output reservation changes, but not for an unchanged header', async () => {
    const errors: unknown[] = []
    const f = await surfaceFixture(1, undefined, (error) => errors.push(error))
    try {
      await f.plugin.adminExpandBlock(f.namespace, f.ids[0]!, 0)
      f.internals.knownSessions.delete(String(f.session.id))
      await f.plugin.adminExpandBlock(f.namespace, f.ids[0]!, 5)
      const header = { config: { provider: 'test', model: 'test', maxTokens: 1500 } }
      f.session.append('request/header', { header, reason: 'initial' })
      f.session.append('request/context', { provider: 'test', model: 'test', contextWindow: 1800 })
      await f.plugin.buildAutoContext(f.session)
      expect(f.plugin.adminBlockSurfaceSync(f.namespace, f.ids[0]!)?.status).toBe('blocked')
      const render = vi.spyOn(f.memory, 'getBlockContext')
      f.plugin.acceptEvent(f.session, f.session.append('request/header', { header, reason: 'series' }))
      await f.plugin.buildAutoContext(f.session)
      expect(render).not.toHaveBeenCalled()
      expect(errors).toHaveLength(1)
      f.plugin.acceptEvent(f.session, f.session.append('request/header', { header: { config: { ...header.config, maxTokens: 100 } }, reason: 'change' }))
      await f.plugin.buildAutoContext(f.session)
      expect(f.level()).toBe(5)
      expect(f.plugin.adminBlockSurfaceSync(f.namespace, f.ids[0]!)).toBeUndefined()
    } finally { await f.dispose() }
  })

  it('rejects an unavailable live source before changing the pointer', async () => {
    const f = await surfaceFixture(1)
    try {
      const missing = Session.create(f.session.id)
      f.internals.knownSessions.set(String(f.session.id), new WeakRef(missing))
      const original = structuredClone(f.memory.listBlocks()[0])
      await expect(f.plugin.adminExpandBlock(f.namespace, f.ids[0]!, 4)).rejects.toThrow('这段历史已被整理')
      expect(f.memory.listBlocks()[0]).toEqual(original)
      expect(missing.deriveMessages()).toHaveLength(0)
    } finally { await f.dispose() }
  })

  it('clears pending status when background maintenance recovers a user selection without a surviving queue', async () => {
    const f = await surfaceFixture(1)
    try {
      await f.plugin.adminExpandBlock(f.namespace, f.ids[0]!, 0)
      await f.memory.expandBlock(f.ids[0]!, 5, 'user')
      f.mark()
      await f.run()
      expect(f.level()).toBe(5)
      expect(f.plugin.adminBlockSurfaceSync(f.namespace, f.ids[0]!)).toBeUndefined()
    } finally { await f.dispose() }
  })

  it('allows normal decay after more Blocks are sealed without resetting the manual anchor', async () => {
    const f = await surfaceFixture(1, undefined, undefined, 420)
    try {
      await f.run()
      await f.plugin.adminExpandBlock(f.namespace, f.ids[0]!, 4)
      const anchor = f.memory.listBlocks()[0]!.pointerAnchorBlockPosition
      for (let turn = 2; turn <= 3; turn++) await f.memory.appendTurn({ user: `New item ${turn}`, assistant: 'Saved.', threadId: String(f.session.id) }, { deferDerivation: true })
      f.mark()
      await f.run()
      expect(f.level()).toBeLessThan(4)
      expect(f.memory.listBlocks()[0]!.pointerAnchorBlockPosition).toBe(anchor)
      await f.plugin.buildAutoContext(f.session)
      expect(f.level()).toBeLessThan(4)
    } finally { await f.dispose() }
  })
})
