import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import { estimateTokens, StrataGate, type ExtractionContext, type MemoryBlock, type RawMessage } from '@diqier/stratagate'
import { describe, expect, it, vi } from 'vitest'
import { DshModelBridge } from '../src/llm.js'
import { splitExtractionSlice, type ExtractionSlice } from '../src/extraction-batches.js'

const stamp = '2026-10-29T20:00:00+08:00'
const message = (content: string, id = 'source'): RawMessage => ({ id, role: 'user', content, createdAt: stamp })
function context(messages: RawMessage[]): ExtractionContext {
  return { previous: null, next: null, timeline: [], target: {
    id: 'block', sequence: 1, startTurn: 1, endTurn: 1, createdAt: stamp,
    l3Condensed: '', l4Readable: '', l5Raw: messages, shouldExtract: true, processingStatus: 'pending',
    pointerCurrentLevel: 5, pointerAnchorLevel: 5, pointerAnchorBlockPosition: 1, lastLiftedAt: null, lastLiftedBy: null,
  } as MemoryBlock }
}
function output(messages: RawMessage[]) {
  return { shouldExtract: true, reason: 'fixture facts', events: messages.map(source => ({
    title: source.content, summary: source.content, scope: 'project', sourceMessageIds: [source.id],
  })) }
}
function fixture(respond: (request: any, index: number) => { value?: unknown; finish?: 'max-tokens'; error?: string }, window?: number) {
  const calls: any[] = []
  const ctx = { logger: { warn: vi.fn() }, llm: {
    resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'off' }] }, ...(window ? { context: { contextWindow: window } } : {}) }),
    stream: (request: any) => (async function* () {
      calls.push(request)
      const response = respond(request, calls.length)
      if (response.error) throw new Error(response.error)
      yield { type: 'tool-call-delta', index: 0, id: 'mock', name: 'stratagate_extract_event_cards', argumentsDelta: JSON.stringify(response.value) }
      yield { type: 'finish', reason: { kind: response.finish ?? 'stop' } }
    })(),
  } } as unknown as Context
  const bridge = new DshModelBridge(ctx, { database: ':memory:', namespaceMode: 'session', namespacePrefix: 'test',
    globalNamespace: 'global', blockTurnSize: 1, blockDecayLambda: .3, ingestSubagents: false, maxOutputTokens: 2_048 })
  const session = { id: 'reliability', requestHeader: () => ({ config: { provider: 'mock', model: 'mock' } }) } as unknown as Session
  return { bridge, calls, extract: (source: ExtractionContext) => bridge.run(session, () => bridge.extractor(source)) }
}
const payload = (request: any) => JSON.parse(request.messages[0].content[0].text)
const empty = { shouldExtract: false, reason: 'No facts in this fixture.', events: [] }

describe('bounded Event extraction (mock provider, not live semantic accuracy)', () => {
  it('uses one larger-output request for an ordinary Block', async () => {
    const model = fixture(request => ({ value: output(payload(request).target.messages) }))
    expect((await model.extract(context([message('Use SQLite.')]))).events).toHaveLength(1)
    expect(model.calls).toHaveLength(1)
    expect(model.calls[0].maxTokens).toBe(8_192)
  })

  it('rejects complete but token-limited JSON, splits, and retains every independent fact', async () => {
    const sources = Array.from({ length: 4 }, (_, i) => message(`fact ${i}`, `source_${i}`))
    const model = fixture((request, index) => index === 1
      ? { value: output([message('incomplete result')]), finish: 'max-tokens' }
      : { value: output(payload(request).target.messages) })
    const result = await model.extract(context(sources))
    expect(result.events.map(event => event.summary)).toEqual(sources.map(source => source.content))
    expect(result.events.map(event => event.sourceMessageIds)).toEqual(sources.map(source => [source.id]))
    expect(model.calls).toHaveLength(3)
    expect(model.bridge.takeSuccessfulResponses()).toHaveLength(2)
    expect(payload(model.calls[1]).target.fragment.afterContextOnly).toContain('fact 2')
    expect(payload(model.calls[2]).allowedSourceMessageIds).toEqual(['source_2', 'source_3'])
  })

  it('splits huge Chinese text before sending, without losing or changing any source character', async () => {
    const source = '保留全部原文，包含更正和取消。😀\n'.repeat(3_000)
    const model = fixture(() => ({ value: empty }), 16_000)
    expect(await model.extract(context([message(source)]))).toMatchObject({ shouldExtract: false, events: [] })
    expect(model.calls.length).toBeGreaterThan(1)
    expect(model.calls.map(request => payload(request).target.messages[0].content).join('')).toBe(source)
    for (const request of model.calls) {
      const input = estimateTokens(JSON.stringify({ system: request.system, tools: request.tools, messages: request.messages }))
      expect(input).toBeLessThanOrEqual(12_000)
      expect(input + request.maxTokens + 1_024).toBeLessThanOrEqual(16_000)
    }
  })

  it('preserves tool evidence and surrogate pairs when splitting a single large message', () => {
    const source = { ...message('😀'.repeat(500)), toolCalls: [{ name: 'test', result: { finalFact: '工具已验证' } }] }
    const slice: ExtractionSlice = { messages: [source], before: '', after: '', depth: 0 }
    const [left, right] = splitExtractionSlice(slice)
    expect([...left.messages, ...right.messages].map(item => item.content).join(''))
      .toBe(source.content + '\n[Tool evidence, JSON]\n' + JSON.stringify(source.toolCalls))
    expect(left.messages[0]!.id).toBe(source.id)
    expect(right.messages[0]!.id).toBe(source.id)
    expect(left.messages[0]!.content).not.toMatch(/[\uD800-\uDBFF]$/)
  })

  it.each(['HTTP 429', 'authentication failed', 'socket closed'])('does not fan out a provider failure: %s', async error => {
    const model = fixture(() => ({ error }))
    await expect(model.extract(context([message('fact 1'), message('fact 2', 'second')]))).rejects.toThrow(error)
    expect(model.calls).toHaveLength(1)
  })

  it.each([8_000, 32_768])('bounds aggregate calls and reserved tokens across all children (window %i)', async window => {
    const model = fixture(request => {
      const sources = payload(request).target.messages
      return sources.length > 1 ? { value: empty, finish: 'max-tokens' } : { value: output(sources) }
    }, window)
    await expect(model.extract(context(Array.from({ length: 64 }, (_, i) => message(`fact ${i}`, `id_${i}`)))))
      .rejects.toThrow(/shared (call\/time|token) budget exhausted/)
    expect(model.calls.length).toBeLessThanOrEqual(32)
    expect(model.calls.length).toBeGreaterThan(1)
    const reserved = model.calls.reduce((total, request) => total + request.maxTokens
      + estimateTokens(JSON.stringify({ system: request.system, tools: request.tools, messages: request.messages })), 0)
    expect(reserved).toBeLessThanOrEqual(262_144)
    if (window === 8_000) expect(model.calls).toHaveLength(32)
  })

  it('shares one elapsed-time budget across slices', async () => {
    const start = Date.now()
    const time = vi.spyOn(Date, 'now').mockReturnValue(start)
    try {
      const model = fixture(() => { time.mockReturnValue(start + 360_001); return { value: empty, finish: 'max-tokens' } })
      await expect(model.extract(context([message('fact 1'), message('fact 2', 'second')]))).rejects.toThrow('shared call/time budget')
      expect(model.calls).toHaveLength(1)
    } finally { time.mockRestore() }
  })

  it('fails without a provider call when even fixed instructions exceed the model window', async () => {
    const model = fixture(() => ({ value: empty }), 1_024)
    await expect(model.extract(context([message('x')]))).rejects.toThrow('cannot split')
    expect(model.calls).toHaveLength(0)
  })

  it('does not convert invalid source IDs to a successful empty result', async () => {
    const model = fixture(() => ({ value: output([message('wrong source', 'neighbor')]) }))
    await expect(model.extract(context([message('fact')]))).rejects.toThrow('invalid evidence or source IDs')
    expect(model.calls).toHaveLength(2)
  })

  it('keeps the whole Block pending and writes no partial Events if a later slice fails', async () => {
    let fail = true
    const model = fixture((request, index) => index === 1 ? { value: empty, finish: 'max-tokens' }
      : index === 2 || !fail ? { value: output(payload(request).target.messages) } : { error: 'socket closed' })
    const memory = StrataGate.inMemory({ blockTurnSize: 1, disableElementProjection: true,
      summarizer: async () => ({ l0Title: 'facts', l0Tags: [], l1Summary: 'facts', l2Keypoints: [], shouldExtract: true }),
      extractor: model.extract })
    await memory.appendTurn({ user: 'fact one', assistant: 'fact two' }, { deferDerivation: true })
    await memory.resumePendingWork()
    expect(model.calls).toHaveLength(3)
    expect(memory.listEvents()).toEqual([])
    expect(memory.listBlocks()[0]).toMatchObject({ processingStatus: 'pending' })
    expect(memory.listBlocks()[0]!.l5Raw.map(item => item.content)).toEqual(['fact one', 'fact two'])
    expect(memory.listExtractionJobs()[0]).toMatchObject({ status: 'failed', attempts: 1, lastError: expect.stringContaining('socket closed') })
    expect(memory.listExtractionJobs()[0]!.nextRetryAt).not.toBeNull()
    fail = false
    await memory.retryEventExtraction(memory.listBlocks()[0]!.id)
    expect(memory.listEvents()).toHaveLength(2)
    expect(memory.listBlocks()[0]!.processingStatus).toBe('ready')
    expect(memory.listExtractionJobs()[0]!.status).toBe('succeeded')
    await memory.close()
  })
})
