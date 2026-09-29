import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ExtractionContext, MemoryBlock } from '@diqier/stratagate'
import { describe, expect, it, vi } from 'vitest'
import { ModelJsonResponseError, parseJsonResponse } from '../src/json-response.js'
import { DshModelBridge } from '../src/llm.js'
import { emptyProfile } from '@diqier/stratagate'

describe('DeepSeek Harness model JSON parsing', () => {
  it('extracts fenced JSON without being confused by braces in strings', () => {
    expect(parseJsonResponse('Result:\n```json\n{"text":"keep } and { literal","nested":{"ok":true}}\n```'))
      .toEqual({ text: 'keep } and { literal', nested: { ok: true } })
  })

  it('rejects multiple top-level JSON values instead of greedily joining them', () => {
    expect(() => parseJsonResponse('{"first":true}\n{"second":true}'))
      .toThrow('multiple JSON values')
  })

  it('uses the final object when an explanation contains an earlier JSON example', () => {
    expect(parseJsonResponse('Example: {"first":true}\nFinal answer: {"second":true}'))
      .toEqual({ second: true })
  })

  it('skips leading reasoning text and validates the requested response fields', () => {
    const response = 'We need process these events carefully. The entities are clear.\n'
      + '{"reason":"projected","changes":[]}'
    expect(parseJsonResponse(response, ['reason', 'changes']))
      .toEqual({ reason: 'projected', changes: [] })
    expect(() => parseJsonResponse('{"reason":"missing changes"}', ['reason', 'changes']))
      .toThrow('missing required fields')
  })

  it('accepts a BOM-prefixed JSON response', () => {
    expect(parseJsonResponse('\uFEFF{"ok":true}')).toEqual({ ok: true })
  })

  it('rejects truncated JSON', () => {
    expect(() => parseJsonResponse('{"incomplete":'))
      .toThrow('not valid JSON')
  })

  it('includes a bounded raw response preview in parse errors', () => {
    const response = 'not json '.repeat(80)
    let error: unknown
    try {
      parseJsonResponse(response)
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(ModelJsonResponseError)
    expect((error as ModelJsonResponseError).responsePreview).toBe(response.slice(0, 500))
    expect((error as Error).message).toContain('Raw response preview')
    expect((error as Error).message).toContain(response.slice(0, 80))
    expect((error as Error).message).not.toContain(response.slice(0, 501))
    expect((error as ModelJsonResponseError).fullMessage).toContain(response)
  })
})

function modelBridge(responses: Array<{ text?: string; tool?: unknown; toolName?: string; reasoning?: string; finish?: 'stop' | 'max-tokens' }>): {
  bridge: DshModelBridge
  session: Session
  calls: ReturnType<typeof vi.fn>
} {
  const calls = vi.fn()
  const stream = (options: { system?: string; maxTokens?: number; tools?: Array<{ name: string }>; tool_choice?: unknown }) => {
    const response = responses[calls.mock.calls.length]
    calls(options)
    return (async function* () {
      if (response?.reasoning) yield { type: 'reasoning-delta' as const, index: 0, text: response.reasoning }
      if (response?.tool !== undefined) {
        yield {
          type: 'tool-call-delta' as const,
          index: 1,
          id: 'mock-tool-call' as never,
          name: response.toolName ?? options.tools?.[0]?.name,
          argumentsDelta: JSON.stringify(response.tool),
        }
      } else if (response?.text) {
        yield { type: 'text-delta' as const, index: 0, text: response.text }
      }
      yield { type: 'finish' as const, reason: { kind: response?.finish ?? 'stop' } }
    })()
  }
  const ctx = {
    llm: { stream },
    logger: { warn: vi.fn() },
  } as unknown as Context
  const bridge = new DshModelBridge(ctx, {
    database: ':memory:',
    namespaceMode: 'session',
    namespacePrefix: 'test',
    globalNamespace: 'global',
    blockTurnSize: 1,
    blockDecayLambda: 0.3,
    ingestSubagents: false,
    maxOutputTokens: 256,
  })
  const session = {
    id: 'json-test',
    requestHeader: () => ({ config: { provider: 'test', model: 'test', reasoningEffort: 'low' as never } }),
  } as unknown as Session
  return { bridge, session, calls }
}

describe('DeepSeek Harness model JSON retries', () => {
  it('sends maintenance only the current Profile and rejects added facts in protected fields', async () => {
    const input = { ...emptyProfile(), preferredLanguage: '中文', reasoningLanguage: 'English', responsePreferences: '简洁。简洁。' }
    const output = { ...input, responsePreferences: '简洁。' }
    const { bridge, session, calls } = modelBridge([{ tool: output }])
    expect(await bridge.run(session, () => bridge.maintainProfile(input))).toEqual(output)
    const request = calls.mock.calls[0]![0] as { system: string; messages: Array<{ content: Array<{ text: string }> }> }
    expect(request.system).toContain('Never infer or add facts')
    expect(request.system).toContain('all nine string fields')
    expect(request.system).toContain('never infer, copy, or merge either language field into the other')
    expect(JSON.parse(request.messages[0]!.content[0]!.text)).toEqual({ profile: input, fieldDefinitions: expect.any(Object) })
    expect(bridge.takeSuccessfulResponses()).toEqual([])
    const invalid = modelBridge([{ tool: { ...input, userPreferredName: 'invented' } }, { tool: { ...input, userPreferredName: 'invented' } }])
    await expect(invalid.bridge.run(invalid.session, () => invalid.bridge.maintainProfile(input))).rejects.toThrow(/protected short field/)
    const copied = modelBridge([{ tool: { ...input, reasoningLanguage: '中文' } }, { tool: { ...input, reasoningLanguage: '中文' } }])
    await expect(copied.bridge.run(copied.session, () => copied.bridge.maintainProfile(input))).rejects.toThrow(/protected short field reasoningLanguage/)
    const inferred = modelBridge([{ tool: { ...input, preferredLanguage: 'English' } }, { tool: { ...input, preferredLanguage: 'English' } }])
    await expect(inferred.bridge.run(inferred.session, () => inferred.bridge.maintainProfile(input))).rejects.toThrow(/protected short field preferredLanguage/)
  })

  it('reserves enough output for a full Chinese Profile and retries a truncated response', async () => {
    const input = {
      ...emptyProfile(), responsePreferences: '中'.repeat(1000), standingInstructions: '文'.repeat(1000),
      userBackground: '背'.repeat(1500), longTermGoals: '目'.repeat(1000), persistentNotes: '注'.repeat(1200),
    }
    const { bridge, session, calls } = modelBridge([
      { text: '{"partial":', finish: 'max-tokens' }, { tool: input },
    ])
    expect(await bridge.run(session, () => bridge.maintainProfile(input))).toEqual(input)
    expect(calls).toHaveBeenCalledTimes(2)
    expect(calls.mock.calls[0]![0].maxTokens).toBeGreaterThan(2048)
  })

  it('retries NO_ADAPTER once without spending a structured-response retry', async () => {
    const calls = vi.fn()
    const ctx = {
      llm: { stream: (options: { tools: Array<{ name: string }> }) => {
        calls(options)
        if (calls.mock.calls.length === 1) {
          throw Object.assign(new Error('no adapter registered'), { code: 'NO_ADAPTER' })
        }
        return (async function* () {
          yield {
            type: 'tool-call-delta' as const,
            index: 0,
            id: 'call' as never,
            name: options.tools[0]!.name,
            argumentsDelta: JSON.stringify({ l0Title: 'ready', l0Tags: [], l1Summary: 'ready', l2Keypoints: [], shouldExtract: false }),
          }
          yield { type: 'finish' as const, reason: { kind: 'stop' as const } }
        })()
      } },
      logger: { warn: vi.fn() },
    } as unknown as Context
    const bridge = new DshModelBridge(ctx, {
      database: ':memory:', namespaceMode: 'session', namespacePrefix: 'test', globalNamespace: 'global',
      blockTurnSize: 1, blockDecayLambda: 0.3, ingestSubagents: false, maxOutputTokens: 256,
    })
    const session = { id: 'adapter-race', requestHeader: () => ({ config: { provider: 'test', model: 'test' } }) } as unknown as Session

    await expect(bridge.run(session, () => bridge.summarizer([]))).resolves.toMatchObject({ l0Title: 'ready' })
    expect(calls).toHaveBeenCalledTimes(2)
  })

  it('limits the NO_ADAPTER fallback to one retry', async () => {
    const calls = vi.fn(() => {
      throw Object.assign(new Error('no adapter registered'), { code: 'NO_ADAPTER' })
    })
    const ctx = { llm: { stream: calls }, logger: { warn: vi.fn() } } as unknown as Context
    const bridge = new DshModelBridge(ctx, {
      database: ':memory:', namespaceMode: 'session', namespacePrefix: 'test', globalNamespace: 'global',
      blockTurnSize: 1, blockDecayLambda: 0.3, ingestSubagents: false, maxOutputTokens: 256,
    })
    const session = { id: 'adapter-missing', requestHeader: () => ({ config: { provider: 'test', model: 'test' } }) } as unknown as Session

    await expect(bridge.run(session, () => bridge.summarizer([]))).rejects.toMatchObject({ code: 'NO_ADAPTER' })
    expect(calls).toHaveBeenCalledTimes(2)
  })

  it('returns an external-memory action with bounded confidence', async () => {
    const { bridge, session, calls } = modelBridge([{ tool: {
      action: 'SUPERSEDE', existingEventIds: ['evt_old'], reason: '同一事实的新状态', confidence: 1.4,
    } }])
    const decision = await bridge.run(session, () => bridge.externalMemoryDecider({
      candidate: { title: '数据库迁移', summary: '已迁移到 PostgreSQL。' },
      matches: [],
    }))
    expect(decision).toMatchObject({ action: 'SUPERSEDE', existingEventIds: ['evt_old'], confidence: 1 })
    expect(calls.mock.calls[0]?.[0].tools[0].name).toBe('stratagate_decide_external_memory')
  })

  it('retries once with a correction instruction after invalid JSON', async () => {
    const { bridge, session, calls } = modelBridge([
      { text: 'not json' },
      { tool: { l0Title: 'fixed', l0Tags: [], l1Summary: 'ok', l2Keypoints: [], shouldExtract: false } },
    ])

    const result = await bridge.run(session, () => bridge.summarizer([]))

    expect(result.l0Title).toBe('fixed')
    expect(calls).toHaveBeenCalledTimes(2)
    expect(calls.mock.calls[1]?.[0].system).toContain('did not make one valid call to the requested tool')
  })

  it('retries a truncated response and then reports a bounded failure', async () => {
    const { bridge, session, calls } = modelBridge([
      { text: '{"l0Title":', finish: 'max-tokens' },
      { text: 'still not json' },
    ])

    let error: unknown
    try {
      await bridge.run(session, () => bridge.summarizer([]))
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(ModelJsonResponseError)
    expect((error as Error).message).toContain('did not produce a valid stratagate_summarize_block call after 2 attempts')
    expect((error as Error).message).toContain('still not json')
    expect(calls).toHaveBeenCalledTimes(2)
    expect(calls.mock.calls[1]?.[0].maxTokens).toBe(256)
  })

  it('uses tool-call arguments even when the provider also returns reasoning', async () => {
    const calls = vi.fn()
    const ctx = {
      llm: { stream: (options: unknown) => {
        calls(options)
        return (async function* () {
          yield { type: 'reasoning-delta' as const, index: 0, text: 'I will summarize the block.' }
          yield { type: 'tool-call-delta' as const, index: 1, id: 'mock-tool-call' as never, name: 'stratagate_summarize_block', argumentsDelta: JSON.stringify({ l0Title: 'from tool', l0Tags: [], l1Summary: 'ok', l2Keypoints: [], shouldExtract: false }) }
          yield { type: 'finish' as const, reason: { kind: 'stop' as const } }
        })()
      } },
      logger: { warn: vi.fn() },
    } as unknown as Context
    const bridge = new DshModelBridge(ctx, {
      database: ':memory:', namespaceMode: 'session', namespacePrefix: 'test', globalNamespace: 'global',
      blockTurnSize: 1, blockDecayLambda: 0.3, ingestSubagents: false, maxOutputTokens: 256,
    })
    const session = { id: 'reasoning-test', requestHeader: () => ({ config: { provider: 'test', model: 'test' } }) } as unknown as Session

    const result = await bridge.run(session, () => bridge.summarizer([]))

    expect(result.l0Title).toBe('from tool')
    expect(calls).toHaveBeenCalledTimes(1)
  })

  it('accepts JSON text when the adapter exposes tools but drops tool_choice', async () => {
    const { bridge, session, calls } = modelBridge([{
      reasoning: 'I will prepare the structured summary.',
      text: '{"l0Title":"text fallback","l0Tags":[],"l1Summary":"ok","l2Keypoints":[],"shouldExtract":false}',
    }])

    const result = await bridge.run(session, () => bridge.summarizer([]))

    expect(result.l0Title).toBe('text fallback')
    expect(calls.mock.calls[0]?.[0]).not.toHaveProperty('reasoningEffort')
  })

  it('configures the Block Summarizer prompt and five described structured fields', async () => {
    const { bridge, session, calls } = modelBridge([{
      tool: { l0Title: 'Block topic', l0Tags: [], l1Summary: 'Block overview.', l2Keypoints: [], shouldExtract: false },
    }])

    await bridge.run(session, () => bridge.summarizer([]))

    const request = calls.mock.calls[0]![0] as {
      system: string
      tools: Array<{ name: string; description: string; parameters: {
        type: string; required: string[]; properties: Record<string, { type: string; description: string }>
      } }>
      tool_choice: unknown
    }
    expect(request.tools).toHaveLength(1)
    expect(request.tools[0]).toMatchObject({
      name: 'stratagate_summarize_block',
      description: expect.stringContaining('L0-L2 layered compression'),
    })
    expect(request.tools[0]!.description).toContain('Event extraction')
    expect(request.tool_choice).toEqual({ type: 'function', function: { name: 'stratagate_summarize_block' } })
    const schema = request.tools[0]!.parameters
    const fields = ['l0Title', 'l0Tags', 'l1Summary', 'l2Keypoints', 'shouldExtract']
    expect(schema.type).toBe('object')
    expect(Object.keys(schema.properties)).toEqual(fields)
    expect(schema.required).toEqual(fields)
    expect(fields.every((field) => schema.properties[field]!.description.length > 40)).toBe(true)
    expect(schema.properties.l0Title!.type).toBe('string')
    expect(schema.properties.l0Tags!.type).toBe('array')
    expect(schema.properties.l0Tags!.description).toContain('topical labels')
    expect(schema.properties.l0Tags!.description).toContain('rapid recognition')
    expect(schema.properties.l0Tags!.description).not.toContain('retrieval')
    expect(schema.properties.l1Summary!.type).toBe('string')
    expect(schema.properties.l2Keypoints!.type).toBe('array')
    expect(schema.properties.shouldExtract!.type).toBe('boolean')
    expect(schema.properties.shouldExtract!.description).toContain('High-recall pre-screen')
    expect(schema.properties.shouldExtract!.description).toContain('when uncertain, use true')
    expect(schema.properties.shouldExtract!.description).toContain('False only when it clearly lacks lasting value')
    expect(request.system).toContain("Block Summarizer in StrataGate's memory pipeline")
    expect(request.system).toContain('progressively higher-resolution views of the same history')
    expect(request.system).toContain('distinctive topical labels for rapid recognition')
    expect(request.system).toContain('If it is false, Event extraction is skipped entirely')
    expect(request.system).toContain('When uncertain whether a plausible candidate has lasting value, choose true')
    expect(request.system).toContain('Set false only when the Block clearly lacks such value')
    expect(request.system).toContain('what the assistant only proposed or suspected')
    expect(request.system).toContain('never guess omitted payload details')
    expect(request.system).toContain('Do not set true merely because some fact appears')
    expect(request.system).toContain('Call stratagate_summarize_block exactly once')
    expect(request.system).toContain('Do not return the summary as ordinary text')
  })

  it('summarizes from compact derivation messages instead of raw tool traces', async () => {
    const code = 'const expensiveTrace = run();\n'.repeat(300)
    const result = `BEGIN\n${'raw payload line\n'.repeat(500)}FINAL=success`
    const messages = [{
      id: 'msg_summary', role: 'assistant' as const, content: 'Verification completed successfully.',
      createdAt: '2026-09-21T08:00:00.000Z',
      toolCalls: [{ name: 'run_code', arguments: { code, cwd: '/workspace' }, result }],
    }]
    const { bridge, session, calls } = modelBridge([{
      tool: { l0Title: 'verified', l0Tags: [], l1Summary: 'Verification passed.', l2Keypoints: [], shouldExtract: true },
    }])

    await bridge.run(session, () => bridge.summarizer(messages))

    const payload = JSON.parse(String(calls.mock.calls[0]?.[0].messages?.[0]?.content?.[0]?.text)) as Record<string, any>
    expect(payload.messages[0]).toMatchObject({ id: 'msg_summary', content: 'Verification completed successfully.' })
    expect(payload.messages[0].toolCalls[0].name).toBe('run_code')
    expect(payload.messages[0].toolCalls[0].arguments.cwd).toBe('/workspace')
    expect(JSON.stringify(payload)).toContain('FINAL=success')
    expect(JSON.stringify(payload)).not.toContain('expensiveTrace')
    expect(JSON.stringify(payload).length).toBeLessThan(JSON.stringify({ messages }).length * 0.3)
  })

  it('marks the target as the only source and limits neighbors to L2 context', async () => {
    const target = {
      id: 'blk_target', sequence: 2, startTurn: 3, endTurn: 4,
      l0Title: 'target', l0Tags: [], l1Summary: 'target summary', l2Keypoints: ['target point'],
      l3Condensed: 'target condensed', l4Readable: 'target readable',
      l5Raw: [{
        id: 'msg_target', role: 'assistant', content: 'target message', createdAt: '2026-01-01T00:00:00.000Z',
        toolCalls: [{
          name: 'run_code',
          arguments: { code: 'const rawSource = true;\n'.repeat(300), path: '/workspace/result.json' },
          result: `decision evidence\n${'raw log\n'.repeat(500)}completed=true`,
        }],
      }],
      shouldExtract: true, processingStatus: 'ready', pointerCurrentLevel: 5, pointerAnchorLevel: 5,
      pointerAnchorBlockPosition: 1, lastLiftedAt: null, lastLiftedBy: null, createdAt: '2026-01-01T00:00:00.000Z',
    } as MemoryBlock
    const next = {
      ...target, id: 'blk_next', sequence: 3, startTurn: 5, endTurn: 6,
      l2Keypoints: ['next point'],
      l5Raw: [{ id: 'msg_next', role: 'user', content: 'next message', createdAt: '2026-01-01T00:00:00.000Z' }],
    } as MemoryBlock
    const { bridge, session, calls } = modelBridge([{
      tool: { shouldExtract: true, reason: 'event', events: [{
        title: 'Target event', summary: 'From target', sourceMessageIds: ['msg_target'],
      }] },
    }])

    const context: ExtractionContext = { previous: null, target, next, timeline: [] }
    const result = await bridge.run(session, () => bridge.extractor(context))
    const payload = JSON.parse(String(calls.mock.calls[0]?.[0].messages?.[0]?.content?.[0]?.text)) as Record<string, any>
    expect(result.shouldExtract).toBe(true)
    expect(result.events[0]?.sourceMessageIds).toEqual(['msg_target'])
    expect(payload.allowedSourceMessageIds).toEqual(['msg_target'])
    expect(payload.target.messages[0].id).toBe('msg_target')
    expect(payload.target.messages[0].toolCalls[0].name).toBe('run_code')
    expect(payload.target.messages[0].toolCalls[0].arguments.path).toBe('/workspace/result.json')
    expect(JSON.stringify(payload.target)).toContain('completed=true')
    expect(JSON.stringify(payload.target)).not.toContain('rawSource')
    expect(payload.target).not.toHaveProperty('l5Raw')
    expect(payload.target).not.toHaveProperty('l4Readable')
    expect(payload.neighbors.next.l2Keypoints).toEqual(['next point'])
    expect(payload.neighbors.next.l5Raw).toBeUndefined()
    const request = calls.mock.calls[0]![0] as {
      system: string
      tools: Array<{ name: string; description: string; parameters: any }>
    }
    const tool = request.tools[0]!
    expect(tool.name).toBe('stratagate_extract_event_cards')
    expect(tool.description).toContain('final decision')
    expect(tool.description).toContain('target.messages')
    const schema = tool.parameters
    expect(Object.keys(schema.properties)).toEqual(['shouldExtract', 'reason', 'events'])
    expect(schema.properties.shouldExtract.description).toContain('final judgment')
    expect(schema.properties.reason.description).toContain('Briefly explain')
    expect(schema.properties.events.description).toContain('atomic')
    const eventFields = schema.properties.events.items.properties as Record<string, { description: string }>
    expect(Object.keys(eventFields)).toEqual([
      'title', 'summary', 'tags', 'quotes', 'sourceMessageIds', 'temporal', 'scope', 'criticality',
    ])
    expect(Object.values(eventFields).every((field) => field.description.length > 80)).toBe(true)
    expect(eventFields).not.toHaveProperty('narrative')
    expect(eventFields).not.toHaveProperty('confidence')
    for (const phrase of [
      'one atomic fact', 'independently be retrieved', 'self-contained', 'distinct source-supported search entry points',
      'Never invent keywords', 'assistant proposal or hypothesis', 'completed result', 'Only target.messages',
      'allowedSourceMessageIds', 'neighbors.previous', 'timeline', 'shouldExtract=false and events=[]',
    ]) expect(request.system).toContain(phrase)
  })

  it('keeps independent target-supported facts as separate Events without retired fields', async () => {
    const target = {
      id: 'blk_multi', sequence: 1, startTurn: 1, endTurn: 2,
      l0Title: 'decisions', l0Tags: [], l1Summary: '', l2Keypoints: [], l3Condensed: '', l4Readable: '',
      l5Raw: [
        { id: 'msg_a', role: 'user', content: 'Use SQLite.', createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 'msg_b', role: 'user', content: 'Use pnpm.', createdAt: '2026-01-01T00:01:00.000Z' },
      ],
      shouldExtract: true, processingStatus: 'ready', pointerCurrentLevel: 5, pointerAnchorLevel: 5,
      pointerAnchorBlockPosition: 1, lastLiftedAt: null, lastLiftedBy: null, createdAt: '2026-01-01T00:00:00.000Z',
    } as MemoryBlock
    const { bridge, session } = modelBridge([{ tool: {
      shouldExtract: true, reason: 'Two decisions.', events: [
        { title: 'SQLite selected', summary: 'The project selected SQLite.', sourceMessageIds: ['msg_a'] },
        { title: 'pnpm selected', summary: 'The project selected pnpm.', sourceMessageIds: ['msg_b'] },
      ],
    } }])
    const result = await bridge.run(session, () => bridge.extractor({ previous: null, target, next: null, timeline: [] }))
    expect(result.events.map((event) => event.sourceMessageIds)).toEqual([['msg_a'], ['msg_b']])
    expect(result.events[0]).not.toHaveProperty('narrative')
    expect(result.events[0]).not.toHaveProperty('confidence')
  })

  it('uses the final extraction decision for the fallback reason', async () => {
    const target = {
      id: 'blk_final', sequence: 1, startTurn: 1, endTurn: 1,
      l0Title: 'decision', l0Tags: [], l1Summary: '', l2Keypoints: [], l3Condensed: '', l4Readable: '',
      l5Raw: [{ id: 'msg_final', role: 'user', content: 'Use SQLite.', createdAt: '2026-01-01T00:00:00.000Z' }],
      shouldExtract: true, processingStatus: 'ready', pointerCurrentLevel: 5, pointerAnchorLevel: 5,
      pointerAnchorBlockPosition: 1, lastLiftedAt: null, lastLiftedBy: null, createdAt: '2026-01-01T00:00:00.000Z',
    } as MemoryBlock
    const { bridge, session } = modelBridge([{ tool: {
      shouldExtract: false, reason: '', events: [{ title: 'SQLite', summary: 'Use SQLite.', sourceMessageIds: ['msg_final'] }],
    } }])
    const result = await bridge.run(session, () => bridge.extractor({ previous: null, target, next: null, timeline: [] }))
    expect(result).toMatchObject({ shouldExtract: false, reason: 'No durable evidence.', events: [] })
  })

  it('rejects extracted Events whose source ids are invalid for the target', async () => {
    const target = {
      id: 'blk_target', sequence: 1, startTurn: 1, endTurn: 2,
      l0Title: 'target', l0Tags: [], l1Summary: '', l2Keypoints: [], l3Condensed: '', l4Readable: '',
      l5Raw: [{ id: 'msg_target', role: 'user', content: 'target message', createdAt: '2026-01-01T00:00:00.000Z' }],
      shouldExtract: true, processingStatus: 'ready', pointerCurrentLevel: 5, pointerAnchorLevel: 5,
      pointerAnchorBlockPosition: 1, lastLiftedAt: null, lastLiftedBy: null, createdAt: '2026-01-01T00:00:00.000Z',
    } as MemoryBlock
    const { bridge, session } = modelBridge([{
      tool: { shouldExtract: true, reason: 'wrong block', events: [{
        title: 'Wrong source', summary: 'From neighbor', sourceMessageIds: ['msg_target', 'msg_next'],
      }] },
    }])

    const result = await bridge.run(session, () => bridge.extractor({ previous: null, target, next: target, timeline: [] }))
    expect(result.shouldExtract).toBe(false)
    expect(result.events).toHaveLength(0)
  })

  it('exposes only the projector tool to the model', async () => {
    const event = {
      id: 'evt_projector', title: 'Project decision', summary: 'StrataGate uses SQLite',
      tags: [], quotes: [], sourceMessageIds: ['msg_projector'], sourceBlockId: 'blk_projector',
      temporal: {}, scope: 'project' as const, criticality: 'routine' as const,
      status: 'active' as const, supersededBy: null,
      weight: { mentionCount: 1, lastAdoptedTurn: 1, lastRetrievedAt: null, pinned: false, floorWeight: 0, forcedCap: null },
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    }
    const { bridge, session, calls } = modelBridge([{
      tool: { reason: 'projected', changes: [{
        element: { name: 'StrataGate', type: 'project' }, operation: 'set_state', key: 'database', mode: 'state',
        value: 'SQLite', sourceEventIds: [event.id],
      }] },
    }])

    const result = await bridge.run(session, () => bridge.projector({
      jobId: 'proj_1', events: [event], existingElements: [],
    }))

    expect(result.changes).toHaveLength(1)
    expect(calls.mock.calls[0]?.[0].tools?.[0]?.name).toBe('stratagate_project_element_cards')
    expect(calls.mock.calls[0]?.[0].tool_choice).toEqual({
      type: 'function',
      function: { name: 'stratagate_project_element_cards' },
    })
    expect(calls.mock.calls[0]?.[0]).not.toHaveProperty('reasoningEffort')
    expect(calls.mock.calls[0]?.[0].system).toContain('Call stratagate_project_element_cards exactly once')
  })

  it('projects semantic Tags for newly processed Knowledge Graph nodes', async () => {
    const event = {
      id: 'evt_graph', title: 'Evaluate memory', summary: 'LoCoMo evaluates meow-memory',
      tags: ['benchmark'], quotes: [], sourceMessageIds: ['msg_graph'], sourceBlockId: 'blk_graph',
      temporal: {}, scope: 'project' as const, criticality: 'routine' as const,
      status: 'active' as const, supersededBy: null,
      weight: { mentionCount: 1, lastAdoptedTurn: 1, lastRetrievedAt: null, pinned: false, floorWeight: 0, forcedCap: null },
      createdAt: '2026-08-25T00:00:00.000Z', updatedAt: '2026-08-25T00:00:00.000Z',
    }
    const { bridge, session, calls } = modelBridge([{
      tool: { reason: 'projected', nodes: [{
        ref: 'locomo', name: 'LoCoMo', type: 'project', tags: ['benchmark', 'evaluation'],
        metadataProvenance: {
          name: [event.id],
          tags: [
            { value: 'benchmark', sourceEventIds: [event.id] },
            { value: 'evaluation', sourceEventIds: [event.id] },
          ],
        },
        sourceEventIds: [event.id],
      }], edges: [] },
    }])

    const result = await bridge.run(session, () => bridge.graphProjector({
      jobId: 'gproj_1', projectorVersion: 1, events: [event], existingNodes: [], existingEdges: [],
    }))

    expect(result.nodes[0]?.tags).toEqual(['benchmark', 'evaluation'])
    expect(result.nodes[0]?.metadataProvenance?.name).toEqual([event.id])
    expect(calls.mock.calls[0]?.[0].tools?.[0]?.name).toBe('stratagate_project_knowledge_graph')
    expect(calls.mock.calls[0]?.[0].tools?.[0]?.parameters?.properties?.nodes?.items?.required).toContain('tags')
    expect(calls.mock.calls[0]?.[0].tools?.[0]?.parameters?.properties?.nodes?.items?.required).toContain('metadataProvenance')
    expect(calls.mock.calls[0]?.[0].tools?.[0]?.parameters?.properties?.nodes?.items?.properties?.metadataProvenance?.required).toContain('name')
    expect(calls.mock.calls[0]?.[0].system).toContain('tags describe the node')
  })

  it('rejects a structured Graph node that omits canonical-name provenance', async () => {
    const event = {
      id: 'evt_graph_invalid', title: 'Invalid graph', summary: 'The model omitted field provenance.',
      tags: [], quotes: [], sourceMessageIds: ['msg_graph_invalid'], sourceBlockId: 'blk_graph_invalid',
      temporal: {}, scope: 'project' as const, criticality: 'routine' as const,
      status: 'active' as const, supersededBy: null,
      weight: { mentionCount: 1, lastAdoptedTurn: 1, lastRetrievedAt: null, pinned: false, floorWeight: 0, forcedCap: null },
      createdAt: '2026-09-20T00:00:00.000Z', updatedAt: '2026-09-20T00:00:00.000Z',
    }
    const invalid = {
      tool: { reason: 'invalid', nodes: [{ ref: 'invalid', name: 'Invalid', type: 'project', tags: [], sourceEventIds: [event.id] }], edges: [] },
    }
    const { bridge, session } = modelBridge([invalid, invalid])
    await expect(bridge.run(session, () => bridge.graphProjector({
      jobId: 'gproj_invalid', projectorVersion: 1, events: [event], existingNodes: [], existingEdges: [],
    }))).rejects.toThrow(/metadataProvenance/i)
  })

  it('compacts historical Graph context before sending it to the model', async () => {
    const event = {
      id: 'evt_compact', title: 'Compact graph', summary: 'Only touched records should be returned.',
      tags: [], quotes: [], sourceMessageIds: ['msg_compact'], sourceBlockId: 'blk_compact',
      temporal: {}, scope: 'project' as const, criticality: 'routine' as const,
      status: 'active' as const, supersededBy: null,
      weight: { mentionCount: 1, lastAdoptedTurn: 1, lastRetrievedAt: null, pinned: false, floorWeight: 0, forcedCap: null },
      createdAt: '2026-09-14T00:00:00.000Z', updatedAt: '2026-09-14T00:00:00.000Z',
    }
    const existingNodes = Array.from({ length: 38 }, (_, index) => ({
      id: `node_${index}`, name: `Node ${index}`, type: 'project' as const, aliases: [], tags: ['project'],
      currentState: 'state '.repeat(300), status: 'active' as const, confidence: 0.95,
      sourceEventIds: Array.from({ length: 24 }, (__, source) => `evt_${source}`),
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-09-14T00:00:00.000Z',
      facts: Array.from({ length: 20 }, (__, fact) => ({
        id: `fact_${index}_${fact}`, key: `key_${fact}`, value: 'value '.repeat(100), status: 'active' as const,
        confidence: 0.8, sourceEventIds: [event.id], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-09-14T00:00:00.000Z',
      })),
    }))
    const existingEdges = Array.from({ length: 113 }, (_, index) => ({
      id: `edge_${index}`, fromNodeId: `node_${index % 38}`, toNodeId: `node_${(index + 1) % 38}`,
      relation: 'related', status: 'active' as const, confidence: 0.8, sourceEventIds: [event.id],
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-09-14T00:00:00.000Z',
    }))
    const context = { jobId: 'gproj_compact', projectorVersion: 1, events: [event], existingNodes, existingEdges }
    const proposedNodes = [
      ...Array.from({ length: 6 }, (_, index) => ({
        ref: `invalid_${index}`, name: `Invalid ${index}`, type: 'project', tags: [], metadataProvenance: { name: ['evt_unknown'] }, sourceEventIds: ['evt_unknown'],
      })),
      ...Array.from({ length: 30 }, (_, index) => ({
        ref: `proposal_${index}`, name: `Proposal ${index}`, type: 'project', tags: [], metadataProvenance: { name: [event.id] }, sourceEventIds: [event.id],
      })),
    ]
    const proposedEdges = [
      ...Array.from({ length: 6 }, (_, index) => ({
        fromRef: `proposal_${index}`, toRef: `proposal_${index + 1}`,
        relation: 'invalid provenance', sourceEventIds: ['evt_unknown'],
      })),
      ...Array.from({ length: 40 }, (_, index) => ({
        fromRef: `proposal_${index % 24}`, toRef: `proposal_${(index + 1) % 24}`,
        relation: 'related', sourceEventIds: [event.id],
      })),
    ]
    const { bridge, session, calls } = modelBridge([{
      tool: { reason: 'projected', nodes: proposedNodes, edges: proposedEdges },
    }])

    const result = await bridge.run(session, () => bridge.graphProjector(context))

    const request = calls.mock.calls[0]?.[0] as any
    const payload = JSON.parse(request.messages[0].content[0].text)
    expect(payload.existingNodes).toHaveLength(32)
    expect(payload.existingEdges).toHaveLength(60)
    expect(payload.existingNodes[0].currentState).toHaveLength(600)
    expect(payload.existingNodes[0].facts).toHaveLength(12)
    expect(payload.existingNodes[0]).not.toHaveProperty('confidence')
    expect(payload.existingNodes[0]).not.toHaveProperty('createdAt')
    expect(payload.existingNodes[0].facts[0]).not.toHaveProperty('id')
    expect(payload.existingEdges[0]).not.toHaveProperty('id')
    expect(JSON.stringify(payload).length).toBeLessThan(JSON.stringify(context).length * 0.35)
    expect(request.system).toContain('never echo unchanged historical graph records')
    expect(result.nodes).toHaveLength(24)
    expect(result.edges).toHaveLength(32)
    expect(result.nodes[0]?.name).toBe('Proposal 0')
    expect(result.edges[0]?.relation).toBe('related')
  })

  it('does not pay for an identical second Graph call after max-token truncation', async () => {
    const event = {
      id: 'evt_truncated', title: 'Truncated graph', summary: 'Graph output reached its token limit.',
      tags: [], quotes: [], sourceMessageIds: ['msg_truncated'], sourceBlockId: 'blk_truncated',
      temporal: {}, scope: 'project' as const, criticality: 'routine' as const,
      status: 'active' as const, supersededBy: null,
      weight: { mentionCount: 1, lastAdoptedTurn: 1, lastRetrievedAt: null, pinned: false, floorWeight: 0, forcedCap: null },
      createdAt: '2026-09-14T00:00:00.000Z', updatedAt: '2026-09-14T00:00:00.000Z',
    }
    const { bridge, session, calls } = modelBridge([
      { text: '{"reason":"truncated",', finish: 'max-tokens' },
      { tool: { reason: 'must not run', nodes: [], edges: [] } },
    ])

    await expect(bridge.run(session, () => bridge.graphProjector({
      jobId: 'gproj_truncated', projectorVersion: 1, events: [event], existingNodes: [], existingEdges: [],
    }))).rejects.toThrow('after 1 attempt')
    expect(calls).toHaveBeenCalledTimes(1)
  })
})

describe('DeepSeek Harness adapter readiness', () => {
  it('tracks the exact route and publishes adapter-registry updates', () => {
    let providers: Array<{ id: string; name: string }> = []
    let adapterUpdated = () => {}
    const ctx = {
      llm: {
        listProviders: () => providers,
        stream: vi.fn(),
      },
      agentDefaultModel: { currentSelection: () => ({ provider: 'default-provider', model: 'default-model' }) },
      on: (_event: string, listener: () => void) => { adapterUpdated = listener },
      logger: { warn: vi.fn() },
    } as unknown as Context
    const bridge = new DshModelBridge(ctx, {
      database: ':memory:', namespaceMode: 'session', namespacePrefix: 'test', globalNamespace: 'global',
      blockTurnSize: 1, blockDecayLambda: 0.3, ingestSubagents: false, maxOutputTokens: 256,
    })
    const session = { id: 'adapter-ready', requestHeader: () => ({ config: { provider: 'session-provider', model: 'session-model' } }) } as unknown as Session
    const listener = vi.fn()
    const dispose = bridge.onAdaptersUpdated(listener)

    expect(bridge.isReady(session)).toBe(false)
    expect(bridge.isReady()).toBe(false)
    providers = [
      { id: 'session-provider', name: 'Session Provider' },
      { id: 'default-provider', name: 'Default Provider' },
    ]
    adapterUpdated()
    expect(bridge.isReady(session)).toBe(true)
    expect(bridge.isReady()).toBe(true)
    expect(listener).toHaveBeenCalledTimes(1)

    dispose()
    adapterUpdated()
    expect(listener).toHaveBeenCalledTimes(1)
  })
})

describe('reasoningEffort off compatibility', () => {
  const summaryTool = { l0Title: 'ok', l0Tags: [], l1Summary: 'valid', l2Keypoints: [], shouldExtract: false }

  function bridgeWithCapability(
    resolveModelInfo: (...args: any[]) => Promise<any>,
    stream?: (options: any) => AsyncIterable<any>,
    structuredReasoningEffort: 'auto' | 'force-off' = 'auto',
    liveStructuredReasoningEffort?: () => 'auto' | 'force-off',
  ): { bridge: DshModelBridge; session: Session; calls: ReturnType<typeof vi.fn>; warnings: ReturnType<typeof vi.fn>; adapterUpdated: () => void } {
    const calls = vi.fn()
    const warnings = vi.fn()
    let adapterUpdated = () => {}
    const ctx = {
      llm: {
        resolveModelInfo,
        stream: stream ?? ((options: any) => {
          calls(options)
          return (async function* () {
            yield { type: 'tool-call-delta' as const, index: 0, id: 'call' as never, name: options.tools[0].name, argumentsDelta: JSON.stringify(summaryTool) }
            yield { type: 'finish' as const, reason: { kind: 'stop' as const } }
          })()
        }),
      },
      on: (_event: string, listener: () => void) => { adapterUpdated = listener },
      logger: { warn: warnings },
    } as unknown as Context
    const bridge = new DshModelBridge(ctx, {
      database: ':memory:', namespaceMode: 'session', namespacePrefix: 'test', globalNamespace: 'global',
      blockTurnSize: 1, blockDecayLambda: 0.3, ingestSubagents: false, maxOutputTokens: 512,
      structuredTaskTimeoutMs: 50,
      structuredReasoningEffort,
    }, liveStructuredReasoningEffort)
    const session = { id: 'off-test', requestHeader: () => ({ config: { provider: 'provider-a', model: 'model-a' } }) } as unknown as Session
    return { bridge, session, calls, warnings, adapterUpdated: () => adapterUpdated() }
  }

  it('sends off when the exact model explicitly supports it', async () => {
    const { bridge, session, calls } = bridgeWithCapability(async () => ({ reasoning: { efforts: [{ id: 'off', name: 'Off' }] } }))
    await bridge.run(session, () => bridge.summarizer([]))
    expect(calls.mock.calls[0]?.[0].reasoningEffort).toBe('off')
  })

  it('omits off when the exact model explicitly does not support it', async () => {
    const { bridge, session, calls } = bridgeWithCapability(async () => ({ reasoning: { efforts: [{ id: 'low', name: 'Low' }] } }))
    await bridge.run(session, () => bridge.summarizer([]))
    expect(calls.mock.calls[0]?.[0]).not.toHaveProperty('reasoningEffort')
  })

  it('reads a changed DSH 0.1.7 live config before each structured call', async () => {
    let mode: 'auto' | 'force-off' = 'auto'
    const { bridge, session, calls, adapterUpdated } = bridgeWithCapability(async () => ({}), undefined, 'auto', () => mode)
    await bridge.run(session, () => bridge.summarizer([]))
    mode = 'force-off'
    await bridge.run(session, () => bridge.summarizer([]))
    mode = 'auto'
    adapterUpdated()
    await bridge.run(session, () => bridge.summarizer([]))
    expect(calls.mock.calls.map(([request]) => request.reasoningEffort)).toEqual([undefined, 'off', undefined])
  })

  it.each([
    ['unknown capability', async () => ({})],
    ['failed capability lookup', async () => { throw new Error('lookup failed') }],
  ])('omits off in auto mode for %s', async (_label, resolveModelInfo) => {
    const { bridge, session, calls } = bridgeWithCapability(resolveModelInfo)
    await bridge.run(session, () => bridge.summarizer([]))
    expect(calls.mock.calls[0]?.[0]).not.toHaveProperty('reasoningEffort')
  })

  it('degrades conservatively and warns once when force-off capability lookup fails', async () => {
    const lookup = vi.fn(async () => { throw new Error('lookup failed') })
    const { bridge, session, calls, warnings } = bridgeWithCapability(lookup, undefined, 'force-off')
    await bridge.run(session, () => bridge.summarizer([]))
    await bridge.run(session, () => bridge.summarizer([]))
    expect(lookup).toHaveBeenCalledTimes(1)
    expect(calls).toHaveBeenCalledTimes(2)
    expect(calls.mock.calls[0]?.[0]).not.toHaveProperty('reasoningEffort')
    expect(calls.mock.calls[1]?.[0]).not.toHaveProperty('reasoningEffort')
    expect(warnings).toHaveBeenCalledTimes(1)
  })

  it('removes rejected off once and caches the exact route as unsupported', async () => {
    const calls = vi.fn()
    const { bridge, session, warnings } = bridgeWithCapability(async () => ({}), (options: any) => {
      calls(options)
      const index = calls.mock.calls.length
      return (async function* () {
        if (index === 1) {
          yield { type: 'finish' as const, reason: { kind: 'error' as const, failure: { code: 'INVALID_REQUEST', message: 'reasoningEffort off is unsupported' } } }
          return
        }
        yield { type: 'tool-call-delta' as const, index: 0, id: 'call' as never, name: options.tools[0].name, argumentsDelta: JSON.stringify(summaryTool) }
        yield { type: 'finish' as const, reason: { kind: 'stop' as const } }
      })()
    }, 'force-off')

    await bridge.run(session, () => bridge.summarizer([]))
    await bridge.run(session, () => bridge.summarizer([]))
    expect(calls).toHaveBeenCalledTimes(3)
    expect(calls.mock.calls[0]?.[0].reasoningEffort).toBe('off')
    expect(calls.mock.calls[1]?.[0]).not.toHaveProperty('reasoningEffort')
    expect(calls.mock.calls[2]?.[0]).not.toHaveProperty('reasoningEffort')
    expect(warnings).toHaveBeenCalledTimes(1)
  })

  it('aborts an accepted off request that keeps reasoning past the deadline', async () => {
    const { bridge, session } = bridgeWithCapability(async () => ({}), (options: any) => (async function* () {
      yield { type: 'reasoning-delta' as const, index: 0, text: 'Deep diving' }
      await new Promise<void>((resolve) => options.signal.addEventListener('abort', () => resolve(), { once: true }))
      yield { type: 'finish' as const, reason: { kind: 'aborted' as const, failure: { code: 'ABORTED', message: 'aborted' } } }
    })(), 'force-off')
    await expect(bridge.run(session, () => bridge.summarizer([]))).rejects.toThrow('timed out after 50ms')
  })

  it('re-resolves capability after route or adapter changes', async () => {
    const resolved = vi.fn(async (_provider: string, model: string) => ({
      reasoning: { efforts: model === 'model-a' ? [{ id: 'off', name: 'Off' }] : [{ id: 'low', name: 'Low' }] },
    }))
    const { bridge, session, adapterUpdated } = bridgeWithCapability(resolved)
    await bridge.run(session, () => bridge.summarizer([]))
    const changedSession = { id: 'changed', requestHeader: () => ({ config: { provider: 'provider-a', model: 'model-b' } }) } as unknown as Session
    await bridge.run(changedSession, () => bridge.summarizer([]))
    adapterUpdated()
    await bridge.run(session, () => bridge.summarizer([]))
    expect(resolved).toHaveBeenCalledTimes(3)
  })
})
