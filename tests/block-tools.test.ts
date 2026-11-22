import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { StrataGate } from '@diqier/stratagate'
import { describe, expect, it } from 'vitest'
import type { DshModelBridge } from '../src/llm.js'
import { StrataGateRuntime } from '../src/runtime.js'
import { registerMemoryTools } from '../src/tools.js'

type Page = {
  batchId: string; evidenceRefs: string[]
  results: Array<{ id: string; title: string; turnRange: [number, number]; level: number }>
  scope: string; total: number; blockCount: number; offset: number; limit: number; nextOffset: number | null
  emptyReason: string | null; openTailCount: number
}

async function harness(blockTurnSize = 1, modelOverrides: Partial<DshModelBridge> = {}) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, { mode: 'native' })
  const session = { id: 'block-tools-active', header: { id: 'block-tools-active', version: 0, createdAt: 0 },
    snapshotEvents: () => [], eventAt: () => undefined,
  } as unknown as Session
  const models = {
    run: async <T>(_session: Session, operation: () => Promise<T>): Promise<T> => operation(),
    isReady: () => true, onAdaptersUpdated: () => () => {},
    summarizer: async () => ({ l0Title: 'Test block', l0Tags: [], l1Summary: 'Test summary', l2Keypoints: [], shouldExtract: false }),
    extractor: async () => ({ shouldExtract: false, reason: 'none', events: [] }),
    graphProjector: async () => ({ reason: 'none', nodes: [], edges: [] }),
    ...modelOverrides,
  } as unknown as DshModelBridge
  const runtime = new StrataGateRuntime({ database: ':memory:', namespaceMode: 'global', namespacePrefix: 'test',
    globalNamespace: 'global', blockTurnSize, blockDecayLambda: 0.3, ingestSubagents: false, maxOutputTokens: 2048,
  }, models)
  registerMemoryTools(ctx, runtime)
  const memory = await (runtime as unknown as { space(value: Session): Promise<StrataGate> }).space(session)
  let sequence = 0
  const call = async (name: string, args: unknown) => {
    const outcome = await ctx.tools.execute({ name, arguments: args, agent: { session } as Agent,
      callId: `block-tools-${++sequence}` as never, signal: new AbortController().signal,
    })
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ isError: false })
    if (outcome.isError) throw new Error('DSH rejected the tool output')
    return outcome.value as unknown as Page
  }
  return { ctx, runtime, memory, session, call, close: async () => { await ctx.fiber.dispose(); await runtime.close() } }
}

describe('block tools through the real DSH output boundary', () => {
  it('retires deprecated Element search from schemas and assessment strategies', async () => {
    const host = await harness()
    try {
      const tools = host.ctx.tools.schemas()
      expect(tools.map(({ name }) => name)).not.toContain('memory_search_elements')
      expect(tools.find(({ name }) => name === 'memory_assess')!.parameters)
        .toMatchObject({ properties: { next_strategy: { enum: expect.not.arrayContaining(['search_elements']) } } })
      expect(tools.find(({ name }) => name === 'memory_get_blocks')!.parameters.properties)
        .toMatchObject({ offset: { type: 'integer' }, limit: { type: 'integer' } })
    } finally { await host.close() }
  })

  it('paginates compact metadata and expands a large source only on request', async () => {
    const host = await harness()
    try {
      const largeText = 'large-source-body '.repeat(12_000)
      for (let i = 0; i < 25; i++) {
        await host.memory.appendTurn({ user: i === 24 ? largeText : `Current turn ${i}`, assistant: 'Saved.', threadId: String(host.session.id) })
      }
      const pages: Page[] = []
      let offset = 0
      do {
        const page = await host.call('memory_get_blocks', { offset })
        pages.push(page)
        expect(page).toMatchObject({ scope: 'session', total: 25, blockCount: 25, offset, limit: 12, emptyReason: null })
        expect(page.evidenceRefs).toEqual(page.results.map(({ id, level }) => `block:${id}:level:${level}`))
        for (const row of page.results) expect(Object.keys(row).sort()).toEqual(['id', 'level', 'targetLevel', 'title', 'turnRange'])
        expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(12_000)
        expect(JSON.stringify(page)).not.toContain('large-source-body')
        offset = page.nextOffset ?? 0
      } while (offset)
      expect(pages.map(({ results }) => results.length)).toEqual([12, 12, 1])
      const ids = pages.flatMap(({ results }) => results.map(({ id }) => id))
      expect(ids).toEqual(host.memory.listBlocks().map(({ id }) => id))
      expect(new Set(ids).size).toBe(25)
      const expanded = await host.call('memory_expand_block', { id: ids.at(-1), target: 'L5' })
      expect(expanded.results).toMatchObject({ id: ids.at(-1), level: 5, content: expect.stringContaining(largeText) })
      expect(Buffer.byteLength(JSON.stringify(expanded))).toBeGreaterThan(197_000)
      expect(await host.call('memory_get_blocks', { offset: 100, limit: 2 }))
        .toMatchObject({ results: [], total: 25, offset: 100, limit: 2, nextOffset: null, emptyReason: null, evidenceRefs: [] })
      expect(await host.call('memory_get_blocks', { offset: -10, limit: 0 }))
        .toMatchObject({ offset: 0, limit: 1, nextOffset: 1, results: [expect.objectContaining({ id: ids[0] })] })
      expect((await host.call('memory_get_blocks', { limit: 100 })).results).toHaveLength(20)
    } finally { await host.close() }
  })

  it('filters session reads strictly, keeping other, synthetic and unthreaded sources available by namespace', async () => {
    const host = await harness()
    try {
      const own = (await host.memory.appendTurn({ user: 'scope-marker own', assistant: 'Saved.', threadId: String(host.session.id) })).sealedBlock!
      await host.memory.appendTurn({ user: 'scope-marker other', assistant: 'Saved.', threadId: 'other-session' })
      await host.memory.appendTurn({ user: 'scope-marker legacy', assistant: 'Saved.' })
      const recorded = await host.memory.recordAgentEvent({ content: 'scope-marker agent recorded source' })
      const page = await host.call('memory_get_blocks', {})
      expect(page.results.map(({ id }) => id)).toEqual([own.id])
      expect(page).toMatchObject({ total: 1, blockCount: 1 })
      const all = await host.call('memory_get_blocks', { scope: 'namespace' })
      expect(all.results.map(({ id }) => id)).toEqual(host.memory.listBlocks().map(({ id }) => id))
      expect(all.total).toBe(4)
      const raw = await host.call('memory_search_raw', { query: 'scope-marker', scope: 'session', limit: 20 })
      expect(raw.results).toHaveLength(1)
      expect(raw.results[0]).toMatchObject({ blockId: own.id, message: { threadId: String(host.session.id) } })
      const rawAll = await host.call('memory_search_raw', { query: 'scope-marker', scope: 'namespace', limit: 20 })
      expect(rawAll.results).toHaveLength(4)
      const source = host.memory.listBlocks().find(({ id }) => id === recorded.sourceBlockId)!
      const rawBefore = structuredClone(source.l5Raw)
      for (const target of ['L3', 'L4', 'L5']) {
        const expanded = await host.call('memory_expand_block', { id: source.id, target })
        expect(expanded.results).toMatchObject({ content: 'Recorded: scope-marker agent recorded source' })
      }
      expect(host.memory.listBlocks().find(({ id }) => id === source.id)!.l5Raw).toEqual(rawBefore)
    } finally { await host.close() }
  })

  it('does not count legacy or other-thread open tails as pending work for the current session', async () => {
    const host = await harness(2)
    try {
      await host.memory.appendTurn({ user: 'Legacy pending', assistant: 'Saved.' })
      await host.memory.appendTurn({ user: 'Other pending', assistant: 'Saved.', threadId: 'other-session' })
      expect(await host.call('memory_get_blocks', {}))
        .toMatchObject({ results: [], total: 0, openTailCount: 0, emptyReason: 'no_blocks_in_namespace', nextOffset: null })
      expect(await host.call('memory_get_blocks', { scope: 'namespace' }))
        .toMatchObject({ results: [], openTailCount: 4, emptyReason: 'open_tail_pending' })
      await host.memory.appendTurn({ user: 'Own pending', assistant: 'Saved.', threadId: String(host.session.id) })
      expect(await host.call('memory_get_blocks', {}))
        .toMatchObject({ results: [], openTailCount: 2, emptyReason: 'open_tail_pending' })
    } finally { await host.close() }
  })

  it('supports latest-first block directory ordering and documents expand_block target levels', async () => {
    const host = await harness(1)
    try {
      const tools = host.ctx.tools.schemas()
      const blocksTool = tools.find(({ name }) => name === 'memory_get_blocks')!
      expect(blocksTool.parameters.properties).toMatchObject({
        order: { type: 'string', enum: ['oldest', 'latest'] },
      })
      const expandBlockTool = tools.find(({ name }) => name === 'memory_expand_block')!
      const targetDescription = String((expandBlockTool.parameters.properties as Record<string, { description?: string }>).target?.description ?? '')
      expect(targetDescription).toContain('"L0"')
      expect(targetDescription).toContain('"L4"')
      expect(targetDescription).toContain('"L5"')
      expect(targetDescription).toContain('"next"')

      const b1 = (await host.memory.appendTurn({ user: 'First turn', assistant: 'Reply 1', threadId: String(host.session.id) })).sealedBlock!
      const b2 = (await host.memory.appendTurn({ user: 'Second turn', assistant: 'Reply 2', threadId: String(host.session.id) })).sealedBlock!
      const b3 = (await host.memory.appendTurn({ user: 'Third turn', assistant: 'Reply 3', threadId: String(host.session.id) })).sealedBlock!

      const oldest = await host.call('memory_get_blocks', { limit: 2 })
      expect(oldest).toMatchObject({ order: 'oldest', latestBlockId: b3.id, latestBlockTurnRange: [b3.startTurn, b3.endTurn] })
      expect(oldest.results.map(({ id }) => id)).toEqual([b1.id, b2.id])

      const latest = await host.call('memory_get_blocks', { order: 'latest', limit: 2 })
      expect(latest).toMatchObject({ order: 'latest', latestBlockId: b3.id, latestBlockTurnRange: [b3.startTurn, b3.endTurn], nextOffset: 2 })
      expect(latest.results.map(({ id }) => id)).toEqual([b3.id, b2.id])

      const nextPage = await host.call('memory_get_blocks', { order: 'latest', offset: 2, limit: 2 })
      expect(nextPage.results.map(({ id }) => id)).toEqual([b1.id])
      expect(nextPage.nextOffset).toBeNull()
    } finally { await host.close() }
  })

  it('attaches bounded sourceMessages and a sourceHint when expanding an Event', async () => {
    const host = await harness(1, {
      summarizer: async () => ({
        l0Title: 'Route comparison',
        l0Tags: ['route'],
        l1Summary: 'Compared Option 1 and Option 2.',
        l2Keypoints: ['Option 1: Keep Route A.'],
        shouldExtract: true,
      }),
      extractor: async ({ target }) => ({
        shouldExtract: true,
        reason: 'route comparison',
        events: [{
          title: 'Route comparison',
          summary: 'Compared Option 1 and Option 2.',
          tags: ['route'],
          quotes: ['Option 1: Keep Route A.'],
          sourceBlockId: target.id,
          sourceMessageIds: [target.l5Raw[0]!.id, target.l5Raw[1]!.id],
        }],
      }),
    })
    try {
      const longBody = `Option 1: Keep Route A. ${'details '.repeat(300)}`
      const sealed = await host.memory.appendTurn({
        user: 'Please compare Option 1 and Option 2.',
        assistant: longBody,
        threadId: String(host.session.id),
      })
      const block = sealed.sealedBlock!
      const userMsg = block.l5Raw[0]!
      const assistantMsg = block.l5Raw[1]!
      const event = sealed.extractedEvents[0]!
      const expanded = await host.call('memory_expand_event', { id: event.id }) as unknown as {
        results: {
          id: string
          sourceHint?: string
          sourceMessages?: Array<{ id: string; role: string; content: string; truncated?: boolean }>
        }
      }
      expect(expanded.results.id).toBe(event.id)
      expect(expanded.results.sourceHint).toContain(block.id)
      expect(expanded.results.sourceHint).toContain('memory_expand_block')
      expect(expanded.results.sourceHint).toContain('L4')
      expect(expanded.results.sourceHint).toContain('L5')
      expect(expanded.results.sourceMessages).toHaveLength(2)
      expect(expanded.results.sourceMessages?.[0]).toMatchObject({
        id: userMsg.id,
        role: 'user',
        content: 'Please compare Option 1 and Option 2.',
      })
      expect(expanded.results.sourceMessages?.[0]?.truncated).toBeUndefined()
      expect(expanded.results.sourceMessages?.[1]).toMatchObject({
        id: assistantMsg.id,
        role: 'assistant',
        truncated: true,
      })
      expect(expanded.results.sourceMessages?.[1]?.content).toContain('[truncated; expand source block for full text]')
    } finally { await host.close() }
  })
})
