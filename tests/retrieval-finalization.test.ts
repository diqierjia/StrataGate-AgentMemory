import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { LlmAdapter, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { StrataGate } from '@diqier/stratagate'
import { describe, expect, it } from 'vitest'
import { dshMessageSource } from '../src/dsh-compatibility.js'
import type { DshModelBridge } from '../src/llm.js'
import { installRetrievalFinalization } from '../src/retrieval-finalization.js'
import { StrataGateRuntime } from '../src/runtime.js'
import { registerMemoryTools } from '../src/tools.js'

type Call = { name: string; args: unknown }
interface Reply {
  text?: string
  calls?: Call[]
  reasoning?: string
  finish?: 'stop' | 'max-tokens'
}
type Batch = { batchId: string; evidenceRefs: string[] }

class ScriptedModel extends LlmAdapter {
  requests: GenerateOptions[] = []
  constructor(readonly replies: Array<(request: GenerateOptions) => Reply>) { super() }
  async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request)
    const next = this.replies.shift()
    if (!next) throw new Error('Unexpected extra model step')
    const reply = next(request)
    if (reply.reasoning !== undefined) yield { type: 'reasoning-delta', index: 0, text: reply.reasoning }
    if (reply.text !== undefined) yield { type: 'text-delta', index: reply.reasoning === undefined ? 0 : 1, text: reply.text }
    for (const [index, call] of (reply.calls ?? []).entries()) {
      yield { type: 'tool-call-delta', index, id: `call-${this.requests.length}-${index}` as never, name: call.name, argumentsDelta: JSON.stringify(call.args) }
    }
    yield { type: 'finish', reason: { kind: reply.finish ?? 'stop' } }
  }
}

function batches(request: GenerateOptions): Batch[] {
  return request.messages.flatMap((message) => {
    if (message.role !== 'tool') return []
    const text = message.content.flatMap((block) => block.type === 'text' ? [block.text] : []).join('')
    const result = JSON.parse(text)
    return result.batchId && result.evidenceRefs && !result.recorded && !result.verdict ? [result as Batch] : []
  })
}

async function harness(replies: Array<(request: GenerateOptions) => Reply>) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjections)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, { mode: 'native' })
  const adapter = new ScriptedModel(replies)
  ctx.llm.registerAdapter(['test'], adapter)
  await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 })
  const models = { isReady: () => false, onAdaptersUpdated: () => () => {} } as unknown as DshModelBridge
  const runtime = new StrataGateRuntime({
    database: ':memory:', namespaceMode: 'session', namespacePrefix: 'test', globalNamespace: 'global',
    blockTurnSize: 1, blockDecayLambda: 0.3, ingestSubagents: false, maxOutputTokens: 2048,
  }, models)
  registerMemoryTools(ctx, runtime)
  installRetrievalFinalization(ctx, runtime)
  const agent = await ctx.agentLoop.create('retrieval-finalization' as never, { provider: 'test', model: 'test' })
  const memory = await (runtime as unknown as { space(session: typeof agent.session): Promise<StrataGate> }).space(agent.session)
  const block = (await memory.appendTurn({ user: 'Select SQLite.', assistant: 'SQLite selected.', threadId: 'old-session' })).sealedBlock!
  const event = await memory.addEvent({ title: 'SQLite decision', summary: 'The project selected SQLite.', sourceBlockId: block.id, sourceMessageIds: [block.l5Raw[0]!.id] })
  return { ctx, adapter, runtime, agent, memory, event, close: async () => { await ctx.fiber.dispose(); await runtime.close() } }
}

const retrieve = (): Reply => ({ calls: [{ name: 'memory_search_events', args: { query: 'SQLite' } }] })
const assess = (request: GenerateOptions): Reply => ({ calls: batches(request).map((batch) => ({
  name: 'memory_assess', args: { batch_id: batch.batchId, evidence_refs: batch.evidenceRefs, verdict: 'sufficient', fit: 'Directly records the database decision.', missing: '', next_strategy: 'answer' },
})) })
const record = (used: boolean) => (request: GenerateOptions): Reply => ({ calls: batches(request).map((batch) => ({
  name: 'memory_record_use', args: { batch_id: batch.batchId, evidence_refs: used ? batch.evidenceRefs : [] },
})) })

describe('retrieval finalization through the real DSH agent loop', () => {
  it('answers after wrong + null assessment and null receipt without retrying or reinforcing evidence', async () => {
    const answer = '这条历史记录不适用于当前问题。'
    const host = await harness([retrieve, (request) => ({ calls: batches(request).map((batch) => ({
      name: 'memory_assess', args: { batch_id: batch.batchId, verdict: 'wrong', evidence_refs: null,
        fit: '', missing: 'The retrieved fact does not apply.', next_strategy: 'answer' },
    })) }), (request) => ({ calls: batches(request).map((batch) => ({
      name: 'memory_record_use', args: { batch_id: batch.batchId, evidence_refs: null },
    })) }), () => ({ text: answer })])
    try {
      host.agent.followup(createUserMessage({ content: [{ type: 'text', text: '这个方案适合当前问题吗？' }], source: { kind: 'user' } }))
      await host.agent.whenIdle()
      const events = host.agent.session.snapshotEvents()
      const answers = events.filter((event) => event.type === 'assistant/message' && event.data.message.content.some((block) => block.type === 'text'))
      expect(answers).toHaveLength(1)
      expect(JSON.stringify(answers[0])).toContain(answer)
      const receipt = [...events].reverse().find((event) => event.type === 'tool/result')!
      expect(answers[0]!.seq).toBeGreaterThan(receipt.seq)
      expect(host.runtime.pendingBatchIds(host.agent.session)).toEqual([])
      expect(host.memory.listEvents().find(({ id }) => id === host.event.id)?.weight.mentionCount).toBe(1)
      expect(host.memory.exportSnapshot().usageReceipts).toMatchObject([{ eventIds: [], audit: { evidenceRefs: [], verdict: 'wrong' } }])
      expect(host.adapter.requests).toHaveLength(4)
    } finally { await host.close() }
  })

  it('retrieves, assesses, records, then answers exactly once without recovery', async () => {
    const answer = '本项目选择 SQLite。'
    const host = await harness([retrieve, assess, record(true), (request) => {
      expect(request.tools?.some((tool) => tool.name === 'memory_search_events')).toBe(true)
      expect(JSON.stringify(request.messages)).not.toContain('stratagate:final-answer-recovery')
      return { text: answer }
    }])
    try {
      host.agent.followup(createUserMessage({ content: [{ type: 'text', text: '项目选择了什么数据库？' }], source: { kind: 'user' } }))
      await host.agent.whenIdle()
      const events = host.agent.session.snapshotEvents()
      const answers = events.filter((event) => event.type === 'assistant/message' && event.data.message.content.some((block) => block.type === 'text'))
      expect(answers).toHaveLength(1)
      expect(JSON.stringify(answers[0])).toContain(answer)
      const receipt = [...events].reverse().find((event) => event.type === 'tool/result')!
      expect(answers[0]!.seq).toBeGreaterThan(receipt.seq)
      expect(host.runtime.pendingBatchIds(host.agent.session)).toEqual([])
      expect(host.memory.listEvents().find(({ id }) => id === host.event.id)?.weight.mentionCount).toBe(2)
      expect(host.adapter.requests).toHaveLength(4)
    } finally { await host.close() }
  })

  it.each([
    { count: 1, used: true, answer: '项目此前决定采用 SQLite。' },
    { count: 1, used: false, answer: '请提供当前项目配置，我会检查数据库选择是否符合要求。' },
    { count: 3, used: true, answer: '数据库方案是 SQLite，部署前请核对当前配置。' },
    { count: 2, used: false, answer: '请先提供当前项目配置，我会据此检查。' },
  ])('closes $count omitted batches (used=$used) before the final real answer', async ({ count, used, answer }) => {
    const replies = [...Array.from({ length: count }, () => retrieve), ...(used ? [assess] : []), () => ({ text: answer }), record(used), (request: GenerateOptions): Reply => {
      // Without recovery this scripted model would emit the reported bad tail.
      // No semantic classifier or canned production answer is used by the plugin.
      const recovery = JSON.stringify(request.messages).includes('complete final user-facing answer')
      expect(recovery).toBe(true)
      expect(request.tools ?? []).toEqual([])
      return { text: recovery ? answer : '两个检索批次已关闭' }
    }]
    const host = await harness(replies)
    try {
      host.agent.followup(createUserMessage({ content: [{ type: 'text', text: '帮我检查数据库选择。' }], source: { kind: 'user' } }))
      await host.agent.whenIdle()
      const events = host.agent.session.snapshotEvents()
      expect(JSON.stringify([...events].reverse().find((event) => event.type === 'turn/end'))).toContain('"kind":"completed"')
      const receipts = events.filter((event) => event.type === 'tool/result' && event.data.message.content.some((block) => block.type === 'text' && block.text.includes('"recorded": true')))
      expect(receipts).toHaveLength(count)
      const lastResult = receipts.at(-1)!
      const result = JSON.parse(lastResult.type === 'tool/result' ? lastResult.data.message.content.flatMap((block) => block.type === 'text' ? [block.text] : []).join('') : '')
      expect(result.unresolvedBatchIds).toEqual([])
      expect(host.runtime.pendingBatchIds(host.agent.session)).toEqual([])
      const lastAssistant = [...events].reverse().find((event) => event.type === 'assistant/message')!
      expect(lastAssistant.seq).toBeGreaterThan(lastResult.seq)
      expect(lastAssistant.type === 'assistant/message' && lastAssistant.data.message.content).toEqual([{ type: 'text', text: answer }])
      expect(host.memory.listEvents().find(({ id }) => id === host.event.id)?.weight.mentionCount).toBe(used ? count + 1 : 1)
      expect(host.adapter.replies).toHaveLength(0)

      // Recovery is turn-local: the next turn has tools and no duplicated answer.
      host.adapter.replies.push((request) => {
        expect(request.tools?.some((tool) => tool.name === 'memory_search_events')).toBe(true)
        return { text: '下一轮独立回复。' }
      })
      host.agent.followup(createUserMessage({ content: [{ type: 'text', text: '谢谢' }], source: { kind: 'user' } }))
      await host.agent.whenIdle()
      expect(host.adapter.replies).toHaveLength(0)
    } finally { await host.close() }
  })

  it('fails without looping if a model ignores cleanup and preserves unresolved batches', async () => {
    const host = await harness([retrieve, () => ({ text: '回答。' }), () => ({ text: '仍然没有调用工具。' })])
    try {
      host.agent.followup(createUserMessage({ content: [{ type: 'text', text: '检查项目' }], source: { kind: 'user' } }))
      await host.agent.whenIdle()
      expect(host.adapter.requests).toHaveLength(3)
      expect(host.runtime.pendingBatchIds(host.agent.session)).toHaveLength(1)
      const end = [...host.agent.session.snapshotEvents()].reverse().find((event) => event.type === 'turn/end')
      expect(end).toMatchObject({ data: { reason: { kind: 'error', error: { message: expect.stringContaining('cleanup made no progress') } } } })
    } finally { await host.close() }
  })

  it('waits for a later retrieval in the cleanup tool step and records mixed used/unused evidence', async () => {
    const answer = '此前选择 SQLite；请以当前配置为准。'
    const host = await harness([retrieve, assess, () => ({ text: answer }), (request) => ({ calls: [
      { name: 'memory_record_use', args: { batch_id: batches(request)[0]!.batchId, evidence_refs: batches(request)[0]!.evidenceRefs } },
      { name: 'memory_search_events', args: { query: 'SQLite' } },
    ] }), (request) => {
      expect(request.tools?.some((tool) => tool.name === 'memory_record_use')).toBe(true)
      expect(JSON.stringify(request.messages)).not.toContain('stratagate:final-answer-recovery')
      return { text: '遗漏的第二个批次尚未处理。' }
    }, (request) => ({ calls: [{ name: 'memory_record_use', args: { batch_id: batches(request).at(-1)!.batchId, evidence_refs: [] } }] }), (request) => {
      expect(request.tools ?? []).toEqual([])
      expect(JSON.stringify(request.messages)).toContain('complete final user-facing answer')
      return { text: answer }
    }])
    try {
      host.agent.followup(createUserMessage({ content: [{ type: 'text', text: '核对项目数据库' }], source: { kind: 'user' } }))
      await host.agent.whenIdle()
      expect(host.runtime.pendingBatchIds(host.agent.session)).toEqual([])
      expect(host.adapter.replies).toHaveLength(0)
      const lastAssistant = [...host.agent.session.snapshotEvents()].reverse().find((event) => event.type === 'assistant/message')!
      expect(lastAssistant.type === 'assistant/message' && lastAssistant.data.message.content).toEqual([{ type: 'text', text: answer }])
      expect(host.memory.listEvents().find(({ id }) => id === host.event.id)?.weight.mentionCount).toBe(2)
    } finally { await host.close() }
  })

  const incompleteAnswers: Array<{ name: string; reply: Reply }> = [
    { name: 'empty content', reply: {} },
    { name: 'empty text', reply: { text: '' } },
    { name: 'whitespace-only text', reply: { text: ' \n\t' } },
    { name: 'reasoning-only content', reply: { reasoning: 'I should restate the database decision.' } },
    { name: 'max-tokens with visible text', reply: { text: '本项目选择了', finish: 'max-tokens' } },
  ]

  it.each(incompleteAnswers)('retries $name and ends with a confirmed complete user answer', async ({ reply }) => {
    const answer = '请提供当前项目配置，我会检查数据库选择是否符合要求。'
    const host = await harness([retrieve, () => ({ text: answer }), record(false), (request) => {
      expect(request.tools ?? []).toEqual([])
      return reply
    }, (request) => {
      expect(request.tools ?? []).toEqual([])
      expect(JSON.stringify(request.messages)).toContain('complete final user-facing answer')
      return { text: answer }
    }])
    try {
      host.agent.followup(createUserMessage({ content: [{ type: 'text', text: '检查项目数据库' }], source: { kind: 'user' } }))
      await host.agent.whenIdle()
      expect(host.adapter.requests).toHaveLength(5)
      expect(host.adapter.replies).toHaveLength(0)
      expect(host.runtime.pendingBatchIds(host.agent.session)).toEqual([])
      const events = host.agent.session.snapshotEvents()
      const messages = events.filter((event) => event.type === 'assistant/message')
      const lastAssistant = messages.at(-1)!
      expect(lastAssistant.type === 'assistant/message' && lastAssistant.data.message.content).toEqual([{ type: 'text', text: answer }])
      const end = [...events].reverse().find((event) => event.type === 'turn/end')!
      // DSH retains max-tokens as the overall turn diagnostic even after a later
      // successful step. Do not rewrite the host's turn-end semantics.
      expect(end).toMatchObject({ data: { reason: { kind: reply.finish === 'max-tokens' ? 'max-tokens' : 'completed' } } })
      expect(messages).toHaveLength(5)
      const invalidAssistant = messages.at(-2)!
      expect(invalidAssistant.type === 'assistant/message' && invalidAssistant.data.step).toBe(4)
      expect(lastAssistant.seq).toBeGreaterThan(invalidAssistant.seq)

      host.adapter.replies.push((request) => {
        expect(request.tools?.some((tool) => tool.name === 'memory_search_events')).toBe(true)
        return { text: '下一轮正常回复。' }
      })
      host.agent.followup(createUserMessage({ content: [{ type: 'text', text: '谢谢' }], source: { kind: 'user' } }))
      await host.agent.whenIdle()
      expect(host.adapter.requests).toHaveLength(6)
      expect(host.adapter.replies).toHaveLength(0)
    } finally { await host.close() }
  })

  it.each(incompleteAnswers)('fails explicitly after three $name attempts without an infinite steer', async ({ reply }) => {
    const host = await harness([retrieve, () => ({ text: '请提供项目配置。' }), record(false), ...Array.from({ length: 3 }, () => (request: GenerateOptions): Reply => {
      expect(request.tools ?? []).toEqual([])
      return reply
    })])
    try {
      host.agent.followup(createUserMessage({ content: [{ type: 'text', text: '检查项目数据库' }], source: { kind: 'user' } }))
      await host.agent.whenIdle()
      expect(host.adapter.requests).toHaveLength(6)
      expect(host.adapter.replies).toHaveLength(0)
      expect(host.runtime.pendingBatchIds(host.agent.session)).toEqual([])
      const end = [...host.agent.session.snapshotEvents()].reverse().find((event) => event.type === 'turn/end')!
      expect(end).toMatchObject({ data: { reason: { kind: 'error', error: { message: expect.stringContaining('final answer recovery failed after 3 attempts') } } } })
      host.adapter.replies.push((request) => {
        expect(request.tools?.some((tool) => tool.name === 'memory_search_events')).toBe(true)
        return { text: '失败后的下一轮正常回复。' }
      })
      host.agent.followup(createUserMessage({ content: [{ type: 'text', text: '继续' }], source: { kind: 'user' } }))
      await host.agent.whenIdle()
      expect(host.adapter.requests).toHaveLength(7)
      expect(host.adapter.replies).toHaveLength(0)
    } finally { await host.close() }
  })

  it.each([{ turn: 0, step: 4 }, { turn: 1, step: 3 }])('ignores a stale assistant message from turn $turn step $step', async (position) => {
    const answer = '请提供项目配置，我会核对数据库方案。'
    const host = await harness([retrieve, () => ({ text: answer }), record(false), () => ({}), (request) => {
      expect(request.tools ?? []).toEqual([])
      return { text: answer }
    }])
    host.ctx.on('session/event', (session, event) => {
      if (event.type !== 'assistant/message' || event.data.step !== 4 || event.data.message.content.length > 0) return
      // A stale success must not confirm the empty recovery response from step 4.
      host.ctx.emit('session/event', session, { ...event, data: {
        ...event.data, ...position,
        message: { ...event.data.message, content: [{ type: 'text', text: 'An old answer.' }] },
      } } as never)
    })
    try {
      host.agent.followup(createUserMessage({ content: [{ type: 'text', text: '核对数据库' }], source: { kind: 'user' } }))
      await host.agent.whenIdle()
      expect(host.adapter.requests).toHaveLength(5)
      expect(host.adapter.replies).toHaveLength(0)
      const lastAssistant = [...host.agent.session.snapshotEvents()].reverse().find((event) => event.type === 'assistant/message')!
      expect(lastAssistant.type === 'assistant/message' && lastAssistant.data.message.content).toEqual([{ type: 'text', text: answer }])
    } finally { await host.close() }
  })

  it('invalidates an earlier confirmed answer if fresh steering admits a later empty step', async () => {
    const answer = '请提供当前配置，我会检查数据库选择。'
    const host = await harness([retrieve, () => ({ text: answer }), record(false), () => ({ text: answer }), () => ({}), (request) => {
      expect(request.tools ?? []).toEqual([])
      return { text: answer }
    }])
    let steered = false
    host.ctx.on('agent/turn-stopping', () => {
      if (steered || host.adapter.requests.length !== 4) return
      steered = true
      host.agent.steer(createUserMessage({ source: dshMessageSource('instructions'), content: [{ type: 'text', text: 'Check the requested answer format once more.' }] }))
    })
    try {
      host.agent.followup(createUserMessage({ content: [{ type: 'text', text: '核对数据库' }], source: { kind: 'user' } }))
      await host.agent.whenIdle()
      expect(host.adapter.requests).toHaveLength(6)
      expect(host.adapter.replies).toHaveLength(0)
      const lastAssistant = [...host.agent.session.snapshotEvents()].reverse().find((event) => event.type === 'assistant/message')!
      expect(lastAssistant.type === 'assistant/message' && lastAssistant.data.message.content).toEqual([{ type: 'text', text: answer }])
    } finally { await host.close() }
  })
})
