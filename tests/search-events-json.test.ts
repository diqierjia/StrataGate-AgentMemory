import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { StrataGate } from '@diqier/stratagate'
import { describe, expect, it, vi } from 'vitest'
import type { DshModelBridge } from '../src/llm.js'
import { StrataGateRuntime } from '../src/runtime.js'
import { registerMemoryTools } from '../src/tools.js'

type Batch = { batchId: string; evidenceRefs: string[]; results: Array<Record<string, unknown>> }
async function harness(kind: 'ordinary' | 'agent' | 'mixed') {
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
  }, models)
  registerMemoryTools(ctx, runtime)
  const memory = await (runtime as unknown as { space(value: Session): Promise<StrataGate> }).space(session)
  if (kind !== 'agent') {
    await memory.appendTurn({ user: 'Select SQLite.', assistant: 'Recorded.', threadId: 'previous' }, { deferDerivation: true })
    const block = (await memory.appendTurn({ user: 'SQLite selected.', assistant: 'Noted.', threadId: 'previous' }, { deferDerivation: true })).sealedBlock!
    await memory.addEvent({ id: 'ordinary-sqlite', title: 'SQLite decision', summary: 'The project selected SQLite.',
      sourceBlockId: block.id, sourceMessageIds: [block.l5Raw[0]!.id] })
  }
  if (kind !== 'ordinary') {
    await memory.appendTurn({ user: 'I prefer SQLite for local storage.', assistant: 'Noted.', threadId: String(session.id) }, { deferDerivation: true })
    await runtime.recordAgentMemory(session, 'The user prefers SQLite for local durable storage.', 'preference')
    expect(memory.listAgentEvents()).toHaveLength(1)
    expect(memory.listAgentEvents()[0]!.sourceBlockId).toBeUndefined()
  }
  let sequence = 0
  const call = (name: string, args: unknown) => ctx.tools.execute({ name, arguments: args, agent,
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
