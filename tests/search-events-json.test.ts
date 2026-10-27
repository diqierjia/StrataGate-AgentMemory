import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { StrataGate, type GraphNode } from '@diqier/stratagate'
import { SqliteStorage } from '@diqier/stratagate/sqlite'
import { describe, expect, it, vi } from 'vitest'
import type { DshModelBridge } from '../src/llm.js'
import { StrataGateRuntime } from '../src/runtime.js'
import { registerMemoryTools } from '../src/tools.js'

type Batch = { batchId: string; evidenceRefs: string[]; results: Array<Record<string, unknown>> }
async function harness(kind: 'ordinary' | 'agent' | 'mixed' | 'empty', agentMemoryRetrievalWeight = 1) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, { mode: 'native' })
  const session = { id: 'json-search', header: { id: 'json-search', version: 0, createdAt: 0 },
    snapshotEvents: () => [], eventAt: () => undefined,
  } as unknown as Session
  const agent = { session } as Agent
  const models = { run: async <T>(_session: Session, operation: () => Promise<T>): Promise<T> => operation(), isReady: () => false, onAdaptersUpdated: () => () => {} } as unknown as DshModelBridge
  const runtime = new StrataGateRuntime({ database: ':memory:', namespaceMode: 'session', namespacePrefix: 'test',
    globalNamespace: 'global', blockTurnSize: 2, blockDecayLambda: 0.3, ingestSubagents: false, maxOutputTokens: 2048,
    agentMemoryRetrievalWeight,
  }, models)
  const graphPreview = await runtime.adminGraphControl('preview') as { token: string }
  await runtime.adminGraphControl('enable', graphPreview.token)
  registerMemoryTools(ctx, runtime)
  const memory = await (runtime as unknown as { space(value: Session): Promise<StrataGate> }).space(session)
  if (kind === 'ordinary' || kind === 'mixed') {
    await memory.appendTurn({ user: 'Select SQLite.', assistant: 'Recorded.', threadId: 'previous' }, { deferDerivation: true })
    const block = (await memory.appendTurn({ user: 'SQLite selected.', assistant: 'Noted.', threadId: 'previous' }, { deferDerivation: true })).sealedBlock!
    await memory.addEvent({ id: 'ordinary-sqlite', title: 'SQLite decision', summary: 'The project selected SQLite.',
      sourceBlockId: block.id, sourceMessageIds: [block.l5Raw[0]!.id] })
  }
  if (kind === 'agent' || kind === 'mixed') {
    await memory.appendTurn({ user: 'I prefer SQLite for local storage.', assistant: 'Noted.', threadId: String(session.id) }, { deferDerivation: true })
    await runtime.recordAgentMemory(session, 'The user prefers SQLite for local durable storage.', 'preference')
    expect(memory.listAgentEvents()).toHaveLength(1)
    expect(memory.listAgentEvents()[0]!.sourceBlockId).toBeUndefined()
  }
  let sequence = 0
  const call = (name: string, args: unknown, targetSession = session) => ctx.tools.execute({ name, arguments: args,
    agent: targetSession === session ? agent : { session: targetSession } as Agent,
    callId: `json-${++sequence}` as never, signal: new AbortController().signal,
  })
  return { ctx, runtime, memory, session, call, close: async () => { await ctx.fiber.dispose(); await runtime.close() } }
}

describe('memory_search_events through the real DSH output boundary', () => {
  it.each(['ordinary', 'agent', 'mixed'] as const)('returns lossless raw %s results with intact evidence and usage', async (kind) => {
    const host = await harness(kind)
    try {
      const before = structuredClone({ events: host.memory.listEvents(), agentEvents: host.memory.listAgentEvents() })
      const expected = await host.memory.searchEvents('SQLite', { limit: 20, agentMemoryWeight: 1, trackRetrieval: false })
      const capture = vi.spyOn(host.runtime, 'searchEvents')
      const outcome = await host.call('memory_search_events', { query: 'SQLite', limit: 20 })
      const raw = await capture.mock.results[0]!.value as Batch
      // No stringify/clone before the actual ToolRuntime receives this value.
      expect(outcome, JSON.stringify(outcome)).toMatchObject({ isError: false })
      if (outcome.isError) throw new Error('DSH rejected the raw retrieval output')
      expect(outcome.value).toEqual(raw)
      expect(raw.results.map(({ id }) => id)).toEqual(expected.map(({ event }) => event.id))
      expect(raw.results.map(({ rankScore }) => rankScore)).toEqual(expected.map(({ score }) => score))
      expect(raw.evidenceRefs).toEqual(expected.map(({ event }) => `event:${event.id}`))
      for (const row of raw.results) {
        const source = expected.find(({ event }) => event.id === row.id)!.event
        if (source.sourceBlockId !== undefined) expect(row.sourceBlockId).toBe(source.sourceBlockId)
        else expect(row).not.toHaveProperty('sourceBlockId')
        expect(Object.values(row)).not.toContain(undefined)
        expect(Object.values(row.temporal as Record<string, unknown>)).not.toContain(undefined)
      }
      if (kind !== 'ordinary') expect(raw.results.some((row) => row.source === 'agent-recorded' && !('sourceBlockId' in row))).toBe(true)
      const stable = (events: typeof before.events) => events.map((event) => ({ ...event, weight: { ...event.weight, lastRetrievedAt: null } }))
      expect(stable(host.memory.listEvents())).toEqual(stable(before.events))
      expect(stable(host.memory.listAgentEvents())).toEqual(stable(before.agentEvents))
      expect(host.runtime.pendingBatchIds(host.session)).toEqual([raw.batchId])
      expect(await host.call('memory_assess', { batch_id: raw.batchId, evidence_refs: raw.evidenceRefs,
        verdict: 'sufficient', fit: 'Direct source Event records.', missing: '', next_strategy: 'answer',
      })).toMatchObject({ isError: false, value: { batchId: raw.batchId, verdict: 'sufficient' } })
      expect(await host.call('memory_record_use', { batch_id: raw.batchId, evidence_refs: raw.evidenceRefs }))
        .toMatchObject({ isError: false, value: { batchId: raw.batchId, incremented: raw.results.length, eventIds: raw.results.map(({ id }) => id) } })
      const after = [...host.memory.listEvents(), ...host.memory.listAgentEvents()]
      for (const event of after) expect(event.weight.mentionCount).toBe([...before.events, ...before.agentEvents].find(({ id }) => id === event.id)!.weight.mentionCount + 1)
      expect(host.runtime.pendingBatchIds(host.session)).toEqual([])
    } finally { await host.close() }
  })

  it('returns and settles three successive source-less agent searches without phantom batches', async () => {
    const host = await harness('agent')
    try {
      const event = host.memory.listAgentEvents()[0]!
      for (let i = 1; i <= 3; i++) {
        const outcome = await host.call('memory_search_events', { query: 'SQLite' })
        expect(outcome).toMatchObject({ isError: false, value: { batchId: `batch_${i}`, evidenceRefs: [`event:${event.id}`] } })
        expect(await host.call('memory_record_use', { batch_id: `batch_${i}`, evidence_refs: [] }))
          .toMatchObject({ isError: false, value: { incremented: 0 } })
        expect(host.runtime.pendingBatchIds(host.session)).toEqual([])
      }
    } finally { await host.close() }
  })

  it('keeps adjacent expand, Graph and Raw tool returns lossless for source-less agent memories', async () => {
    const host = await harness('mixed')
    try {
      const agent = host.memory.listAgentEvents()[0]!
      const expand = await host.call('memory_expand_event', { id: agent.id })
      expect(expand).toMatchObject({ isError: false })
      if (expand.isError) throw new Error('DSH rejected agent expansion')
      expect((expand.value as unknown as Batch).results).toMatchObject({ id: agent.id, sourceMessageIds: agent.sourceMessageIds })
      for (const [name, args] of [
        ['memory_search_graph', { query: 'SQLite' }], ['memory_search_raw', { query: 'SQLite' }], ['memory_list_topics', {}],
      ] as const) expect(await host.call(name, args)).toMatchObject({ isError: false })
    } finally { await host.close() }
  })

  it.each(['nonfinite', 'nested-undefined', 'no-prior-batch'] as const)('does not publish an evidence batch for invalid raw output (%s)', async (mode) => {
    const host = await harness('ordinary')
    try {
      if (mode !== 'no-prior-batch') {
        const existing = await host.call('memory_search_events', { query: 'SQLite' })
        expect(existing.isError).toBe(false)
      }
      const pending = host.runtime.pendingBatchIds(host.session)
      const normal = host.memory.listEvents()[0]!
      const invalid = mode === 'nested-undefined'
        ? { event: { ...normal, temporal: { ...normal.temporal, conflictsWithEventIds: [undefined] as unknown as string[] } }, score: 1 }
        : { event: normal, score: Number.NaN }
      vi.spyOn(host.memory, 'searchEvents').mockResolvedValueOnce([invalid])
      const failed = await host.call('memory_search_events', { query: 'SQLite' })
      expect(failed).toMatchObject({ isError: true, error: { message: 'StrataGate retrieval output is not lossless JSON' } })
      expect(host.runtime.pendingBatchIds(host.session)).toEqual(pending)
      const next = await host.call('memory_search_events', { query: 'SQLite' })
      expect(next).toMatchObject({ isError: false, value: { batchId: `batch_${pending.length + 1}` } })
      if (next.isError) throw new Error('Recovery search failed')
      const nextBatch = next.value as unknown as Batch
      await host.call('memory_record_use', { batch_id: nextBatch.batchId, evidence_refs: [] })
      if (!pending.length) return
      // Explicitly close the new good call; the old pending batch remains valid.
      const assessed = await host.call('memory_assess', { evidence_refs: [], verdict: 'wrong', fit: '', missing: 'unused', next_strategy: 'answer' })
      expect(assessed.isError).toBe(true)
      // A settled latest call stays latest, so use the original ID explicitly.
      expect(await host.call('memory_assess', { batch_id: pending[0], evidence_refs: [], verdict: 'wrong', fit: '', missing: 'unused', next_strategy: 'answer' }))
        .toMatchObject({ isError: false, value: { batchId: pending[0] } })
    } finally { await host.close() }
  })
})

const searchTools = ['memory_search_events', 'memory_search_graph', 'memory_search_raw'] as const
const noMatchHint = '本次检索未找到匹配，不能据此断言相关记忆不存在。'

function seedGraph(memory: StrataGate): GraphNode {
  const event = memory.listAllEvents()[0]!
  const node: GraphNode = {
    id: 'sqlite-node', name: 'SQLite', type: 'tool', aliases: [], currentState: '', facts: [],
    status: 'active', confidence: 0.9, sourceEventIds: [event.id],
    createdAt: event.createdAt, updatedAt: event.updatedAt,
  }
  ;(memory.listGraphNodes() as GraphNode[]).push(node)
  return node
}

describe('search scope status through the real DSH output boundary', () => {
  it.each(searchTools)('%s distinguishes matched and no_match without altering evidence or rank', async (name) => {
    const host = await harness('ordinary')
    try {
      seedGraph(host.memory)
      const before = structuredClone(host.memory.listAllEvents())
      expect(await host.call(name, { query: 'SQLite' })).toMatchObject({
        isError: false, value: { retrievalStatus: 'matched', results: expect.arrayContaining([expect.any(Object)]) },
      })
      const outcome = await host.call(name, { query: 'watermelon' })
      expect(outcome).toMatchObject({ isError: false, value: {
        retrievalStatus: 'no_match', retrievalHint: noMatchHint, results: [], evidenceRefs: [],
      } })
      if (outcome.isError) throw outcome.error
      const batch = outcome.value as unknown as Batch
      // A hint cannot be selected as evidence, even on an empty batch.
      expect(await host.call('memory_assess', { batch_id: batch.batchId, evidence_refs: ['retrievalHint'],
        verdict: 'sufficient', fit: 'status', missing: '', next_strategy: 'answer',
      })).toMatchObject({ isError: false, value: {
        verdict: 'partial', evidenceRefs: [], rejectedEvidenceRefs: [{ ref: 'retrievalHint', reason: 'not_in_batch' }],
      } })
      expect(await host.call('memory_record_use', { batch_id: batch.batchId, evidence_refs: ['retrievalHint'] }))
        .toMatchObject({ isError: true })
      expect(await host.call('memory_assess', { batch_id: batch.batchId, evidence_refs: [],
        verdict: 'wrong', fit: '', missing: 'No match', next_strategy: 'answer',
      })).toMatchObject({ isError: false })
      expect(await host.call('memory_record_use', { batch_id: batch.batchId, evidence_refs: [] }))
        .toMatchObject({ isError: false, value: { incremented: 0, evidenceRefs: [], citations: [] } })
      expect(host.memory.listAllEvents().map(({ weight }) => weight.mentionCount))
        .toEqual(before.map(({ weight }) => weight.mentionCount))
    } finally { await host.close() }
  })

  it.each(searchTools)('%s reports scope_empty only for its searchable corpus, ignoring open tails', async (name) => {
    const host = await harness('empty')
    try {
      await host.memory.appendTurn({ user: 'SQLite', assistant: 'Noted.', threadId: String(host.session.id) }, { deferDerivation: true })
      expect(host.memory.listOpenTail()).not.toHaveLength(0)
      expect(await host.call(name, { query: 'SQLite' })).toMatchObject({ isError: false, value: {
        retrievalStatus: 'scope_empty', retrievalHint: expect.stringContaining('当前搜索范围'), results: [], evidenceRefs: [],
      } })
    } finally { await host.close() }
  })

  it('treats query filters, topic restrictions and exhausted pages as no_match in a populated namespace', async () => {
    const host = await harness('ordinary')
    try {
      const topic = host.memory.listMemoryTopics()[0]!
      for (const args of [
        { query: 'watermelon', participants: ['Unknown Person'], eventType: 'unknown-type' },
        { query: 'SQLite', offset: 100 },
        { query: 'watermelon', topic_id: topic.id },
        { query: '', topic_id: topic.id, offset: 100 },
      ]) expect(await host.call('memory_search_events', args)).toMatchObject({ isError: false, value: {
        retrievalStatus: 'no_match', retrievalHint: noMatchHint, results: [], evidenceRefs: [],
      } })
      expect(await host.runtime.searchEvents(host.session, 'SQLite', { eventIds: [] })).toMatchObject({
        retrievalStatus: 'no_match', results: [],
      })
      // A zero-length presentation window must not turn an existing corpus into scope_empty.
      expect(await host.call('memory_search_raw', { query: 'SQLite', limit: 0 })).toMatchObject({
        isError: false, value: { retrievalStatus: 'no_match', results: [] },
      })
    } finally { await host.close() }
  })

  it('uses strict raw session boundaries, excluding other threads and unthreaded messages', async () => {
    const host = await harness('ordinary')
    try {
      for (let i = 0; i < 2; i++) await host.memory.appendTurn({ user: 'SQLite legacy', assistant: 'Saved.' }, { deferDerivation: true })
      expect(await host.call('memory_search_raw', { query: 'SQLite', scope: 'session' })).toMatchObject({
        isError: false, value: { retrievalStatus: 'scope_empty', results: [] },
      })
      expect(await host.call('memory_search_raw', { query: 'SQLite' })).toMatchObject({
        isError: false, value: { retrievalStatus: 'matched' },
      })
      for (let i = 0; i < 2; i++) await host.memory.appendTurn({ user: 'Banana', assistant: 'Saved.', threadId: String(host.session.id) }, { deferDerivation: true })
      const outcome = await host.call('memory_search_raw', { query: 'SQLite', scope: 'session' })
      expect(outcome).toMatchObject({ isError: false, value: { retrievalStatus: 'no_match', results: [] } })
      expect(JSON.stringify(outcome)).not.toContain('previous')
      expect(JSON.stringify(outcome)).not.toContain('legacy')
    } finally { await host.close() }
  })

  it.each(searchTools)('%s does not inspect or disclose a different namespace', async (name) => {
    const host = await harness('ordinary')
    try {
      seedGraph(host.memory)
      const otherSession = { ...host.session, id: 'empty-other-namespace', header: { ...host.session.header, id: 'empty-other-namespace' } } as Session
      const outcome = await host.call(name, { query: 'SQLite' }, otherSession)
      expect(outcome).toMatchObject({ isError: false, value: { retrievalStatus: 'scope_empty', results: [] } })
      expect(JSON.stringify(outcome)).not.toContain('ordinary-sqlite')
      expect(JSON.stringify(outcome)).not.toContain('sqlite-node')
    } finally { await host.close() }
  })

  it.each(['forgotten', 'archived', 'superseded'] as const)('respects %s Event visibility in both Event and Graph scope probes', async (status) => {
    const host = await harness('ordinary')
    try {
      seedGraph(host.memory)
      host.memory.listAllEvents()[0]!.status = status
      for (const name of ['memory_search_events', 'memory_search_graph']) {
        expect(await host.call(name, { query: 'watermelon' })).toMatchObject({ isError: false, value: {
          retrievalStatus: status === 'superseded' ? 'no_match' : 'scope_empty', results: [],
        } })
        expect(await host.call(name, { query: 'SQLite' })).toMatchObject({ isError: false, value: {
          retrievalStatus: status === 'superseded' ? 'matched' : 'scope_empty',
        } })
      }
    } finally { await host.close() }
  })

  it('does not count invisible or ungrounded Graph nodes as searchable', async () => {
    const host = await harness('ordinary')
    try {
      const node = seedGraph(host.memory)
      node.sourceEventIds = ['missing-event']
      expect(await host.call('memory_search_graph', { query: 'SQLite' })).toMatchObject({
        isError: false, value: { retrievalStatus: 'scope_empty', results: [] },
      })
      node.sourceEventIds = [host.memory.listAllEvents()[0]!.id]
      node.status = 'archived'
      expect(await host.call('memory_search_graph', { query: 'SQLite' })).toMatchObject({
        isError: false, value: { retrievalStatus: 'scope_empty', results: [] },
      })
    } finally { await host.close() }
  })

  it('includes the agent pool only when enabled for Event retrieval', async () => {
    for (const weight of [0, 1]) {
      const host = await harness('agent', weight)
      try {
        expect(await host.call('memory_search_events', { query: 'watermelon' })).toMatchObject({
          isError: false, value: { retrievalStatus: weight === 0 ? 'scope_empty' : 'no_match', results: [] },
        })
      } finally { await host.close() }
    }
  })

  it.each([
    ['memory_search_events', 'hasSearchableEvents'],
    ['memory_search_graph', 'hasSearchableGraphNodes'],
    ['memory_search_raw', 'hasSearchableRawMessages'],
  ] as const)('%s explicitly reports unknown with an older core lacking scope metadata', async (name, probe) => {
    const host = await harness('ordinary')
    try {
      Object.defineProperty(host.memory, probe, { value: undefined, configurable: true })
      expect(await host.call(name, { query: 'watermelon' })).toMatchObject({ isError: false, value: {
        retrievalStatus: 'unknown', retrievalHint: expect.stringContaining('无法可靠判断'), results: [], evidenceRefs: [],
      } })
    } finally { await host.close() }
  })

  it.each([
    ['memory_search_events', 'searchEvents', 'hasSearchableEvents'],
    ['memory_search_graph', 'searchGraphNodes', 'hasSearchableGraphNodes'],
    ['memory_search_raw', 'searchRawMemory', 'hasSearchableRawMessages'],
  ] as const)('%s preserves errors from both retrieval and scope inspection, with no phantom batch', async (name, search, probe) => {
    const host = await harness('ordinary')
    try {
      const pending = host.runtime.pendingBatchIds(host.session)
      for (const method of [search, probe]) {
        const spy = vi.spyOn(host.memory, method).mockImplementationOnce(() => { throw new Error('retrieval failed') })
        expect(await host.call(name, { query: 'watermelon' })).toMatchObject({
          isError: true, error: { message: 'retrieval failed' },
        })
        expect(host.runtime.pendingBatchIds(host.session)).toEqual(pending)
        spy.mockRestore()
      }
    } finally { await host.close() }
  })

  it('preserves the tool error protocol when Graph retrieval capability is unavailable', async () => {
    const host = await harness('ordinary')
    try {
      Object.defineProperty(host.memory, 'searchGraphNodes', { value: undefined, configurable: true })
      const outcome = await host.call('memory_search_graph', { query: 'SQLite' })
      expect(outcome).toMatchObject({ isError: true })
      expect(outcome).not.toHaveProperty('value')
      expect(host.runtime.pendingBatchIds(host.session)).toEqual([])
    } finally { await host.close() }
  })

  it('keeps the existing raw scan fallback working after an index-query failure', async () => {
    const host = await harness('ordinary')
    const index = vi.spyOn(SqliteStorage.prototype, 'searchRawMessageIds').mockImplementation(() => { throw new Error('index query failed') })
    try {
      expect(await host.call('memory_search_raw', { query: 'SQLite' })).toMatchObject({
        isError: false, value: { retrievalStatus: 'matched' },
      })
      expect(await host.call('memory_search_raw', { query: 'watermelon' })).toMatchObject({
        isError: false, value: { retrievalStatus: 'no_match', retrievalHint: noMatchHint, results: [] },
      })
      expect(index).toHaveBeenCalledTimes(2)
    } finally { index.mockRestore(); await host.close() }
  })

  it.each(['no_query', 'no_match', 'current_session_excluded'] as const)('keeps automatic empty selections short, neutral, batch-free and unreinforced (%s)', async (mode) => {
    const host = await harness('ordinary')
    try {
      if (mode === 'current_session_excluded') {
        for (const block of host.memory.listBlocks()) block.threadId = String(host.session.id)
      }
      Object.assign(host.session, { deriveMessages: () => [{ role: 'user', source: { kind: 'user' }, content: [{
        type: 'text', text: mode === 'no_query' ? '' : mode === 'no_match' ? 'watermelon' : 'SQLite',
      }] }] })
      const before = host.memory.listAllEvents().map(({ weight }) => [weight.mentionCount, weight.lastAdoptedTurn])
      for (let i = 0; i < 3; i++) {
        const context = await host.runtime.buildAutoContext(host.session)
        expect(context).toContain('(no memory selected for automatic context)')
        expect(context).not.toContain('scope_empty')
        expect(context).not.toContain(noMatchHint)
      }
      expect(host.runtime.pendingBatchIds(host.session)).toEqual([])
      expect(host.memory.listAllEvents().map(({ weight }) => [weight.mentionCount, weight.lastAdoptedTurn])).toEqual(before)
      const failed = vi.spyOn(host.memory, 'searchEvents').mockRejectedValueOnce(new Error('auto retrieval failed'))
      Object.assign(host.session, { deriveMessages: () => [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'watermelon' }] }] })
      await expect(host.runtime.buildAutoContext(host.session)).rejects.toThrow('auto retrieval failed')
      failed.mockRestore()
    } finally { await host.close() }
  })
})
