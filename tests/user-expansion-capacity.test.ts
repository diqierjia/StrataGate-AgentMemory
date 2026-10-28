import { createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { estimateTokens } from '@diqier/stratagate'
import { describe, expect, it, vi } from 'vitest'
import { surfaceFixture, surfaceRuntime } from './fixtures/surface-maintenance.js'

describe('capacity for explicit user selections', () => {
  it('simplifies the oldest automatic checkpoint only as far as needed, preserving raw history and recovery', async () => {
    const f = await surfaceFixture(3)
    try {
      await f.plugin.adminExpandBlock(f.namespace, f.ids[2]!, 0)
      const raw = structuredClone(f.memory.listBlocks().map(block => block.l5Raw))
      const limit = estimateTokens(JSON.stringify(f.session.deriveMessages())) + 80
      f.session.append('request/context', { provider: 'test', model: 'small', contextWindow: limit })
      expect(await f.plugin.adminExpandBlock(f.namespace, f.ids[2]!, 5)).toMatchObject({ surfaceSync: { status: 'applied' } })
      expect(f.level(0)).toBeLessThan(5)
      expect(f.level(1)).toBe(5)
      expect(f.level(2)).toBe(5)
      expect(estimateTokens(JSON.stringify(f.session.deriveMessages()))).toBeLessThanOrEqual(limit)
      expect(f.memory.listBlocks().map(block => block.l5Raw)).toEqual(raw)
      expect(f.memory.listBlocks()[0]!.surfaceCurrentLevel).toBe(f.level(0))
      const reduced = f.level(0)
      await f.plugin.buildAutoContext(f.session)
      expect(f.level(0)).toBeLessThanOrEqual(reduced)
      expect(f.level(2)).toBe(5)
      // The original full layer remains available, including after simplification.
      f.session.append('request/context', { provider: 'test', model: 'large', contextWindow: 128_000 })
      await f.plugin.adminExpandBlock(f.namespace, f.ids[0]!, 5)
      expect(f.level(0)).toBe(5)
      expect(f.memory.listBlocks().map(block => block.l5Raw)).toEqual(raw)
    } finally { await f.dispose() }
  })

  it('protects other manual choices, the current input, and complete tool calls', async () => {
    const f = await surfaceFixture(3)
    try {
      await f.plugin.adminExpandBlock(f.namespace, f.ids[0]!, 4)
      await f.plugin.adminExpandBlock(f.namespace, f.ids[2]!, 0)
      const manual = structuredClone(f.memory.listBlocks()[0])
      f.session.append('turn/start', { turn: 4 })
      const user = f.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Current request must remain intact.' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
      const callId = 'keep-call' as never
      const call = f.session.append('assistant/message', { turn: 4, step: 1, stream: [], message: createAssistantMessage({
        content: [{ type: 'tool-call', id: callId, name: 'inspect', arguments: '{"path":"keep"}' }], source: { provider: 'test', model: 'test' },
      }) }, { surfaceOp: 'append' })
      f.session.append('tool/call', { turn: 4, step: 1, callId, name: 'inspect', arguments: '{"path":"keep"}' })
      const result = f.session.append('tool/result', { turn: 4, step: 1, message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'Complete tool result.' }], isError: false }) }, { surfaceOp: 'append' })
      const preserved = [user, call, result].map(event => structuredClone(f.session.deriveEventMessage(event)))
      f.session.append('request/context', { provider: 'test', model: 'small', contextWindow: estimateTokens(JSON.stringify(f.session.deriveMessages())) + 80 })
      await f.plugin.adminExpandBlock(f.namespace, f.ids[2]!, 5)
      expect(f.level(0)).toBe(4)
      expect(f.level(1)).toBeLessThan(5)
      expect(f.level(2)).toBe(5)
      expect(f.memory.listBlocks()[0]).toEqual(manual)
      expect(f.session.deriveMessages().slice(-3)).toEqual(preserved)
      expect([user, call, result].every(event => f.session.surface.nodes.includes(event.seq))).toBe(true)
    } finally { await f.dispose() }
  })

  it('can simplify several automatic blocks, stopping once sufficient room exists', async () => {
    const f = await surfaceFixture(4, undefined, undefined, 60)
    try {
      await f.plugin.adminExpandBlock(f.namespace, f.ids[3]!, 0)
      const limit = estimateTokens(JSON.stringify(f.session.deriveMessages())) - 500
      f.session.append('request/context', { provider: 'test', model: 'small', contextWindow: limit })
      await f.plugin.adminExpandBlock(f.namespace, f.ids[3]!, 5)
      expect(f.level(0)).toBeLessThan(5)
      expect(f.level(1)).toBeLessThan(5)
      expect(f.level(2)).toBe(5)
      expect(f.level(3)).toBe(5)
      expect(estimateTokens(JSON.stringify(f.session.deriveMessages()))).toBeLessThanOrEqual(limit)
    } finally { await f.dispose() }
  })

  it('leaves every surface and pointer unchanged if all available relief is insufficient', async () => {
    const f = await surfaceFixture(3)
    try {
      await f.plugin.adminExpandBlock(f.namespace, f.ids[2]!, 0)
      f.session.append('request/context', { provider: 'test', model: 'tiny', contextWindow: 100 })
      const blocks = structuredClone(f.memory.listBlocks())
      const before = f.session.seq
      const messages = structuredClone(f.session.deriveMessages())
      await expect(f.plugin.adminExpandBlock(f.namespace, f.ids[2]!, 5)).rejects.toThrow('其他可简略的历史也不足以腾出空间')
      expect(f.memory.listBlocks()).toEqual(blocks)
      expect(f.session.seq).toBe(before)
      expect(f.session.deriveMessages()).toEqual(messages)
    } finally { await f.dispose() }
  })

  it('never sacrifices another manual selection when there are no automatic candidates', async () => {
    const f = await surfaceFixture(2)
    try {
      await f.plugin.adminExpandBlock(f.namespace, f.ids[0]!, 5)
      await f.plugin.adminExpandBlock(f.namespace, f.ids[1]!, 0)
      f.session.append('request/context', { provider: 'test', model: 'small', contextWindow: estimateTokens(JSON.stringify(f.session.deriveMessages())) + 80 })
      await expect(f.plugin.adminExpandBlock(f.namespace, f.ids[1]!, 5)).rejects.toThrow('当前模型预计放不下')
      expect(f.level(0)).toBe(5)
      expect(f.level(1)).toBe(0)
    } finally { await f.dispose() }
  })

  it('does not replace stale checkpoint ranges while a full decay pass also applies an earlier manual selection', async () => {
    const f = await surfaceFixture(3)
    try {
      await f.plugin.adminExpandBlock(f.namespace, f.ids[0]!, 0)
      f.session.append('request/context', { provider: 'test', model: 'small', contextWindow: estimateTokens(JSON.stringify(f.session.deriveMessages())) + 80 })
      await f.memory.expandBlock(f.ids[0]!, 5, 'user')
      await f.internals.syncDecayedBlockSurface(f.session, f.memory, f.memory.getBlockContext(String(f.session.id)))
      expect(f.level(0)).toBe(5)
      expect(f.level(1)).toBeLessThan(5)
      const messages = JSON.stringify(f.session.deriveMessages())
      for (const [index, id] of f.ids.entries()) {
        expect(messages.split(`Block: ${id} |`)).toHaveLength(2)
        expect(f.memory.listBlocks()[index]!.surfaceCurrentLevel).toBe(f.level(index))
      }
    } finally { await f.dispose() }
  })

  it('repairs all relief metadata after a failed transaction without inserting duplicate checkpoints', async () => {
    const f = await surfaceFixture(3)
    try {
      await f.plugin.adminExpandBlock(f.namespace, f.ids[2]!, 0)
      f.session.append('request/context', { provider: 'test', model: 'small', contextWindow: estimateTokens(JSON.stringify(f.session.deriveMessages())) + 80 })
      vi.spyOn(f.memory, 'setBlockSurfaceLevels').mockRejectedValueOnce(new Error('metadata save failed'))
      await expect(f.plugin.adminExpandBlock(f.namespace, f.ids[2]!, 5)).rejects.toThrow('metadata save failed')
      const reduced = f.level(0)
      expect(reduced).toBeLessThan(5)
      const before = f.session.seq
      await f.plugin.buildAutoContext(f.session)
      expect(f.session.seq).toBe(before)
      expect(f.memory.listBlocks()[0]!.surfaceCurrentLevel).toBe(reduced)
      expect(f.memory.listBlocks()[2]!.surfaceCurrentLevel).toBe(5)
      expect(f.plugin.adminBlockSurfaceSync(f.namespace, f.ids[2]!)).toBeUndefined()
    } finally { await f.dispose() }
  })

  it('recovers a failed native save without repeating replacements and persists relief metadata across restart', async () => {
    let fail = false
    const save = vi.fn(async () => { if (fail) throw new Error('native save failed') })
    const f = await surfaceFixture(3, save)
    let restarted: ReturnType<typeof surfaceRuntime> | undefined
    try {
      await f.plugin.adminExpandBlock(f.namespace, f.ids[2]!, 0)
      f.session.append('request/context', { provider: 'test', model: 'small', contextWindow: estimateTokens(JSON.stringify(f.session.deriveMessages())) + 80 })
      fail = true
      await expect(f.plugin.adminExpandBlock(f.namespace, f.ids[2]!, 5)).rejects.toThrow('native save failed')
      expect(f.plugin.adminBlockSurfaceSync(f.namespace, f.ids[2]!)).toMatchObject({ status: 'pending', reason: 'saving' })
      const seq = f.session.seq
      const reduced = f.level(0)
      expect(reduced).toBeLessThan(5)
      fail = false
      await f.plugin.buildAutoContext(f.session)
      expect(f.session.seq).toBe(seq)
      expect(f.plugin.adminBlockSurfaceSync(f.namespace, f.ids[2]!)).toBeUndefined()
      await f.plugin.close()
      restarted = surfaceRuntime(f.database)
      const snapshot = await restarted.adminSnapshot(f.namespace)
      expect(snapshot?.blocks.find(block => block.id === f.ids[0])?.surfaceCurrentLevel).toBe(reduced)
    } finally { await restarted?.close(); await f.dispose() }
  })
})
