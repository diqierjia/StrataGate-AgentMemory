import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ExtractionContext, MemoryBlock } from '@diqier/stratagate'
import { describe, expect, it, vi } from 'vitest'
import { ModelJsonResponseError, parseJsonResponse } from '../src/json-response.js'
import { DshModelBridge } from '../src/llm.js'

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

  it('marks the target as the only source and limits neighbors to L2 context', async () => {
    const target = {
      id: 'blk_target', sequence: 2, startTurn: 3, endTurn: 4,
      l0Title: 'target', l0Tags: [], l1Summary: 'target summary', l2Keypoints: ['target point'],
      l3Condensed: 'target condensed', l4Readable: 'target readable',
      l5Raw: [{ id: 'msg_target', role: 'user', content: 'target message', createdAt: '2026-01-01T00:00:00.000Z' }],
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
    expect(payload.target.l5Raw[0].id).toBe('msg_target')
    expect(payload.neighbors.next.l2Keypoints).toEqual(['next point'])
    expect(payload.neighbors.next.l5Raw).toBeUndefined()
  })

  it('keeps shouldExtract true when all returned source ids are invalid for the target', async () => {
    const target = {
      id: 'blk_target', sequence: 1, startTurn: 1, endTurn: 2,
      l0Title: 'target', l0Tags: [], l1Summary: '', l2Keypoints: [], l3Condensed: '', l4Readable: '',
      l5Raw: [{ id: 'msg_target', role: 'user', content: 'target message', createdAt: '2026-01-01T00:00:00.000Z' }],
      shouldExtract: true, processingStatus: 'ready', pointerCurrentLevel: 5, pointerAnchorLevel: 5,
      pointerAnchorBlockPosition: 1, lastLiftedAt: null, lastLiftedBy: null, createdAt: '2026-01-01T00:00:00.000Z',
    } as MemoryBlock
    const { bridge, session } = modelBridge([{
      tool: { shouldExtract: true, reason: 'wrong block', events: [{
        title: 'Wrong source', summary: 'From neighbor', sourceMessageIds: ['msg_next'],
      }] },
    }])

    const result = await bridge.run(session, () => bridge.extractor({ previous: null, target, next: target, timeline: [] }))
    expect(result.shouldExtract).toBe(true)
    expect(result.events).toHaveLength(0)
  })

  it('exposes only the projector tool to the model', async () => {
    const event = {
      id: 'evt_projector', title: 'Project decision', summary: 'StrataGate uses SQLite',
      narrative: '', tags: [], quotes: [], sourceMessageIds: ['msg_projector'], sourceBlockId: 'blk_projector',
      temporal: {}, scope: 'project' as const, criticality: 'routine' as const, confidence: 0.9,
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
      narrative: '', tags: ['benchmark'], quotes: [], sourceMessageIds: ['msg_graph'], sourceBlockId: 'blk_graph',
      temporal: {}, scope: 'project' as const, criticality: 'routine' as const, confidence: 0.9,
      status: 'active' as const, supersededBy: null,
      weight: { mentionCount: 1, lastAdoptedTurn: 1, lastRetrievedAt: null, pinned: false, floorWeight: 0, forcedCap: null },
      createdAt: '2026-08-25T00:00:00.000Z', updatedAt: '2026-08-25T00:00:00.000Z',
    }
    const { bridge, session, calls } = modelBridge([{
      tool: { reason: 'projected', nodes: [{
        ref: 'locomo', name: 'LoCoMo', type: 'project', tags: ['benchmark', 'evaluation'], sourceEventIds: [event.id],
      }], edges: [] },
    }])

    const result = await bridge.run(session, () => bridge.graphProjector({
      jobId: 'gproj_1', projectorVersion: 1, events: [event], existingNodes: [], existingEdges: [],
    }))

    expect(result.nodes[0]?.tags).toEqual(['benchmark', 'evaluation'])
    expect(calls.mock.calls[0]?.[0].tools?.[0]?.name).toBe('stratagate_project_knowledge_graph')
    expect(calls.mock.calls[0]?.[0].tools?.[0]?.parameters?.properties?.nodes?.items?.required).toContain('tags')
    expect(calls.mock.calls[0]?.[0].system).toContain('tags describe the node')
  })
})

describe('reasoningEffort off compatibility', () => {
  const summaryTool = { l0Title: 'ok', l0Tags: [], l1Summary: 'valid', l2Keypoints: [], shouldExtract: false }

  function bridgeWithCapability(
    resolveModelInfo: (...args: any[]) => Promise<any>,
    stream?: (options: any) => AsyncIterable<any>,
    structuredReasoningEffort: 'auto' | 'force-off' = 'auto',
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
    })
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
