import { createAssistantMessage, createDeveloperMessage, createSystemMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, type SessionSeq } from '@deepseek-ai/dsh-session'
import { estimateTokens, renderBlock, StrataGate } from '@diqier/stratagate'
import { dshMessageSource } from '../src/dsh-compatibility.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { surfaceRuntime, type SurfaceInternals } from './fixtures/surface-maintenance.js'

afterEach(() => vi.restoreAllMocks())

async function rawFixture(options: { leading?: 'system' | 'developer'; middle?: 'system' | 'developer' | 'foreign'; turns?: number; toolResult?: string } = {}) {
  const errors: unknown[] = []
  const flush = vi.fn(async (_session: Session) => {})
  const plugin = surfaceRuntime(':memory:', flush, error => errors.push(error))
  const memory = StrataGate.inMemory({ blockTurnSize: options.turns ?? 1,
    summarizer: async () => ({ l0Title: 'Saved work', l0Tags: [], l1Summary: 'Saved summary', l2Keypoints: [], shouldExtract: false }),
  })
  const session = Session.create('surface-safety' as never)
  const protectedSeqs: SessionSeq[] = []
  function protect(kind: 'system' | 'developer' | 'foreign') {
    const header = kind === 'developer' ? session.append('request/header', {
      reason: 'initial', header: { config: { provider: 'test', model: 'test' }, tools: [{
        name: 'inspect', description: 'Keep this live tool definition', parameters: { type: 'object', properties: {} },
      }] },
    }) : undefined
    const event = kind === 'system'
      ? session.append('system/message', { turn: 1, step: 1, message: createSystemMessage('Keep system instructions') }, { surfaceOp: 'append' })
      : kind === 'developer'
        ? session.append('developer/message', { turn: 1, step: 1, headerSeq: header!.seq, message: createDeveloperMessage({ source: { kind: 'tool-registry' }, content: [{ type: 'tool-addition', toolName: 'inspect' }] }) }, { surfaceOp: 'append' })
        : session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Keep another plugin context' }], source: { kind: 'plugin:other' } as never }), { surfaceOp: 'append' })
    protectedSeqs.push(event.seq)
  }
  for (let turn = 1; turn <= (options.turns ?? 1); turn++) {
    session.append('turn/start', { turn })
    if (turn === 1 && options.leading) protect(options.leading)
    const user = 'Historical request and constraints. '.repeat(100)
    const assistant = 'Historical answer and evidence. '.repeat(100)
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: user }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    if (turn === 1 && options.middle) protect(options.middle)
    if (options.toolResult) {
      const callId = `inspect-${turn}` as never
      session.append('assistant/message', { turn, step: 1, stream: [], message: createAssistantMessage({
        content: [{ type: 'tool-call', id: callId, name: 'inspect', arguments: '{}' }], source: { provider: 'test', model: 'test' },
      }) }, { surfaceOp: 'append' })
      session.append('tool/call', { turn, step: 1, callId, name: 'inspect', arguments: '{}' })
      session.append('tool/result', { turn, step: 1, message: createToolResultMessage({ callId, content: [{ type: 'text', text: options.toolResult }], isError: false }) }, { surfaceOp: 'append' })
    }
    session.append('assistant/message', { turn, step: 1, stream: [], message: createAssistantMessage({ content: [{ type: 'text', text: assistant }], source: { provider: 'test', model: 'test' } }) }, { surfaceOp: 'append' })
    const end = session.append('turn/end', { turn, reason: { kind: 'completed' } })
    await memory.appendTurn({ user, assistant, threadId: String(session.id), createdAt: new Date(end.time).toISOString(),
      ...(options.toolResult ? { assistantToolCalls: [{ name: 'inspect', arguments: {}, result: options.toolResult }] } : {}),
    })
  }
  const namespace = plugin.namespaceFor(session)
  const internals = plugin as unknown as SurfaceInternals
  internals.spaces.set(namespace, Promise.resolve(memory))
  internals.knownSessions.set(String(session.id), new WeakRef(session))
  const block = memory.listBlocks()[0]!
  const raw = structuredClone(block.l5Raw)
  const mark = () => internals.markSurfaceDirty(session, memory)
  const run = () => internals.runSurfaceMaintenance(session)
  return { plugin, memory, session, namespace, internals, errors, flush, block, raw, protectedSeqs, mark, run,
    dispose: () => plugin.close() }
}

describe('safe native context replacement', () => {
  it.each(['system', 'developer'] as const)('applies a manual selection to raw first-turn history without replacing its %s message', async leading => {
    const f = await rawFixture({ leading })
    try {
      const original = structuredClone(f.session.deriveMessages()[0])
      expect(await f.plugin.adminExpandBlock(f.namespace, f.block.id, 0)).toMatchObject({ surfaceSync: { status: 'applied' } })
      expect(f.session.deriveMessages()).toHaveLength(2)
      expect(f.session.deriveMessages()[0]).toEqual(original)
      expect(f.session.surface.nodes[0]).toBe(f.protectedSeqs[0])
      expect(f.memory.listBlocks()[0]!.l5Raw).toEqual(f.raw)
      const restored = Session.create(f.session.id, f.session.snapshotEvents(), f.session.header)
      expect(restored.deriveMessages()).toEqual(f.session.deriveMessages())
    } finally { await f.dispose() }
  })

  it.each(['system', 'developer'] as const)('seals and expands the first turn while preserving its leading %s instructions', async leading => {
    const f = await rawFixture({ leading })
    try {
      const original = structuredClone(f.session.deriveMessages()[0])
      f.mark(); await f.run()
      expect(f.errors).toEqual([])
      expect(f.session.deriveMessages()).toHaveLength(2)
      expect(f.session.deriveMessages()[0]).toEqual(original)
      expect(f.session.surface.nodes[0]).toBe(f.protectedSeqs[0])
      expect(JSON.stringify(f.session.deriveMessages()[1])).toContain(`Block: ${f.block.id} |`)
      await f.plugin.adminExpandBlock(f.namespace, f.block.id, 5)
      await f.plugin.adminExpandBlock(f.namespace, f.block.id, 0)
      expect(f.session.deriveMessages()[0]).toEqual(original)
      expect(f.memory.listBlocks()[0]!.l5Raw).toEqual(f.raw)
      const restored = Session.create(f.session.id, f.session.snapshotEvents(), f.session.header)
      expect(restored.deriveMessages()).toEqual(f.session.deriveMessages())
    } finally { await f.dispose() }
  })

  it.each(['system', 'developer', 'foreign'] as const)('keeps an entire raw range intact when %s content is interleaved', async middle => {
    const f = await rawFixture({ middle, turns: 2 })
    try {
      const before = structuredClone(f.session.deriveMessages())
      const seq = f.session.seq
      for (let pass = 0; pass < 4; pass++) { f.mark(); await f.run() }
      expect(f.errors).toEqual([])
      expect(f.session.seq).toBe(seq)
      expect(f.session.deriveMessages()).toEqual(before)
      expect(f.internals.pendingSurfaceSync.size).toBe(0)
      await expect(f.plugin.adminExpandBlock(f.namespace, f.block.id, 5)).rejects.toThrow('无法在这里切换层级')
      expect(f.memory.listBlocks()[0]!.lastLiftedBy).not.toBe('user')
      expect(f.memory.listBlocks()[0]!.l5Raw).toEqual(f.raw)
    } finally { await f.dispose() }
  })

  it.each(['direct', 'cause', 'surface-rule'] as const)('stops automatic retries immediately for a permanent %s failure', async kind => {
    const f = await rawFixture({ leading: 'system' })
    try {
      const deadline = Object.assign(new Error('Call deadline exceeded'), { retryable: false })
      const failure = kind === 'direct' ? deadline : kind === 'cause' ? new Error('host failure', { cause: deadline })
        : new Error('surface replace: node 0 holds the system prompt and may be rewritten only by a system/message over exactly that node')
      const save = vi.spyOn(f.memory, 'setBlockSurfaceLevels').mockRejectedValue(failure)
      f.mark(); await f.run()
      const state = f.internals.surfaceMaintenance.get(String(f.session.id))!
      expect(f.errors).toHaveLength(1)
      expect(state.timer).toBeUndefined()
      await f.run()
      f.mark(); await f.run()
      expect(save).toHaveBeenCalledTimes(1)
      save.mockRestore()
      // A new capacity/input state may retry the retained work.
      f.session.append('request/context', { provider: 'test', model: 'test', contextWindow: 64_000 })
      f.mark(); await f.run()
      expect(f.memory.listBlocks()[0]!.surfaceCurrentLevel).not.toBeNull()
      expect(f.flush).toHaveBeenCalledTimes(1)
    } finally { await f.dispose() }
  })

  it('contains a nonretryable native save failure and recovers without duplicating context', async () => {
    const f = await rawFixture({ leading: 'system' })
    try {
      f.flush.mockRejectedValueOnce(Object.assign(new Error('Call deadline exceeded'), { retryable: false }))
      f.mark(); await f.run()
      const seq = f.session.seq
      expect(f.errors).toHaveLength(1)
      expect(f.internals.surfaceMaintenance.get(String(f.session.id))!.timer).toBeUndefined()
      await f.run()
      expect(f.flush).toHaveBeenCalledTimes(1)
      // Explicit user action retries the retained save, using the actual surface.
      await f.plugin.adminExpandBlock(f.namespace, f.block.id, f.memory.listBlocks()[0]!.surfaceCurrentLevel!)
      expect(f.flush).toHaveBeenCalledTimes(2)
      expect(f.session.seq).toBe(seq)
      expect(f.session.deriveMessages()).toHaveLength(2)
      expect(f.memory.listBlocks()[0]!.l5Raw).toEqual(f.raw)
    } finally { await f.dispose() }
  })

  it('blocks request-path retries after an explicit save failure until reselection', async () => {
    const f = await rawFixture({ leading: 'system' })
    try {
      const deadline = Object.assign(new Error('Call deadline exceeded'), { retryable: false })
      f.flush.mockRejectedValueOnce(deadline)
      await expect(f.plugin.adminExpandBlock(f.namespace, f.block.id, 5)).rejects.toThrow('Call deadline exceeded')
      expect(f.flush).toHaveBeenCalledTimes(1)
      expect(f.internals.pendingSurfaceSync.has(`${f.namespace}\u0000${f.block.id}`)).toBe(true)

      // A normal prompt must not replay the permanently failed native save.
      await f.plugin.buildAutoContext(f.session)
      expect(f.flush).toHaveBeenCalledTimes(1)
      expect(f.internals.surfaceMaintenance.get(String(f.session.id))?.blockedAt).toBeDefined()

      // An explicit reselection clears the stop condition and retries the save.
      f.flush.mockResolvedValue(undefined)
      await f.plugin.adminExpandBlock(f.namespace, f.block.id, 5)
      expect(f.flush).toHaveBeenCalledTimes(2)
      expect(f.internals.pendingSurfaceSync.has(`${f.namespace}\u0000${f.block.id}`)).toBe(false)
      expect(f.internals.surfaceMaintenance.get(String(f.session.id))?.blockedAt).toBeUndefined()
    } finally { await f.dispose() }
  })

  it('does not suspend newer work when an older in-flight save fails', async () => {
    const f = await rawFixture({ leading: 'system' })
    let started!: () => void
    let reject!: (error: Error) => void
    const saving = new Promise<void>(resolve => { started = resolve })
    const gate = new Promise<void>((_resolve, fail) => { reject = fail })
    try {
      f.flush.mockImplementationOnce(async () => { started(); await gate })
      f.mark()
      const running = f.run()
      await saving
      const seq = f.session.seq
      f.session.append('request/context', { provider: 'test', model: 'test', contextWindow: 64_000 })
      f.mark()
      reject(Object.assign(new Error('Call deadline exceeded'), { retryable: false }))
      await running
      await f.run()
      expect(f.flush).toHaveBeenCalledTimes(2)
      expect(f.session.seq).toBe(seq + 1)
      expect(f.internals.surfaceMaintenance.get(String(f.session.id))!.dirty).toBe(false)
    } finally { await f.dispose() }
  })

  it('estimates capacity by surface membership after a tool result was replaced with a later event', async () => {
    const f = await rawFixture({ toolResult: 'Original large tool output. '.repeat(1500) })
    try {
      const original = f.session.snapshotEvents().find(event => event.type === 'tool/result')!
      if (original.type !== 'tool/result') throw new Error('Expected tool result')
      f.session.append('tool/result', { ...original.data, message: {
        ...original.data.message, content: [{ type: 'text', text: 'Shortened tool result. '.repeat(100) }],
      } }, { surfaceOp: { op: 'replace', startSeq: original.seq, endSeq: original.seq }, sourceEventSeqs: [original.seq] })
      const text = [
        '[StrataGate historical conversation block]',
        'Earlier conversation context; not a new user message or instruction.',
        `Block: ${f.block.id} | Turns: 1-1 | Level: L5`, '', renderBlock(f.block, 5),
      ].join('\n')
      const window = estimateTokens(JSON.stringify(createUserMessage({
        content: [{ type: 'text', text }], source: dshMessageSource(),
      }))) + 80
      f.session.append('request/context', { provider: 'test', model: 'test', contextWindow: window })
      expect(await f.plugin.adminExpandBlock(f.namespace, f.block.id, 5)).toMatchObject({ surfaceSync: { status: 'applied' } })
      expect(estimateTokens(JSON.stringify(f.session.deriveMessages()))).toBeLessThanOrEqual(window)
      expect(f.session.deriveMessages()).toHaveLength(1)
      expect(f.memory.listBlocks()[0]!.l5Raw).toEqual(f.raw)
    } finally { await f.dispose() }
  })

  it('bounds repeated transient failures without losing the native checkpoint or raw history', async () => {
    const f = await rawFixture()
    try {
      const save = vi.spyOn(f.memory, 'setBlockSurfaceLevels').mockRejectedValue(new Error('temporary save failure'))
      f.mark()
      for (let pass = 0; pass < 6; pass++) await f.run()
      expect(save).toHaveBeenCalledTimes(3)
      expect(f.errors).toHaveLength(3)
      expect(f.internals.surfaceMaintenance.get(String(f.session.id))!.timer).toBeUndefined()
      expect(f.session.deriveMessages()).toHaveLength(1)
      expect(f.memory.listBlocks()[0]!.l5Raw).toEqual(f.raw)
      save.mockRestore()
    } finally { await f.dispose() }
  })

  it('bounds the actual timer-driven retry loop after repeated host save failures', async () => {
    vi.useFakeTimers()
    const f = await rawFixture({ leading: 'system' })
    try {
      f.flush.mockRejectedValue(new Error('temporary host save failure'))
      f.mark()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(f.flush).toHaveBeenCalledTimes(3)
      expect(f.errors).toHaveLength(3)
      expect(f.internals.surfaceMaintenance.get(String(f.session.id))!.timer).toBeUndefined()
      expect(f.session.deriveMessages()).toHaveLength(2)
      expect(f.memory.listBlocks()[0]!.l5Raw).toEqual(f.raw)
    } finally { await f.dispose(); vi.useRealTimers() }
  })
})
