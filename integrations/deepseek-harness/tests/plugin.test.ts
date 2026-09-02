import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentDefaultModelConfig from '@deepseek-ai/dsh-agent-default-model'
import type { Agent } from '@deepseek-ai/dsh-agent'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import * as plugin from '../src/index.js'

describe('DSH plugin composition', () => {
  it('loads into the official Cordis services and registers the complete memory protocol', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-dsh-plugin-'))
    const ctx = new Context()
    try {
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(SystemPrompt, {})
      await ctx.plugin(ToolRuntime, { mode: 'native' })
      await ctx.plugin(AgentDefaultModelConfig, { provider: 'test', model: 'test' })
      await ctx.plugin(plugin, { database: join(directory, 'memory.db') })

      const names = ctx.tools.schemas().map(({ name }) => name)
      expect(names).toEqual(expect.arrayContaining([
        'memory_search_events',
        'memory_expand_event',
        'memory_search_graph',
        'memory_expand_graph_node',
        'memory_search_elements',
        'memory_expand_element',
        'memory_search_raw',
        'memory_get_blocks',
        'memory_expand_block',
        'memory_assess',
        'memory_record_use',
      ]))
      const prompt = await ctx.systemPrompt.assemble()
      expect(prompt.sections).toContainEqual(expect.objectContaining({
        name: 'tool:stratagate-memory',
        text: expect.stringMatching(/StrataGate provides durable, evidence-gated memory[\s\S]*independent batch[\s\S]*batch_id/),
      }))

      const session = {
        id: 'auto-context-session',
        header: { id: 'auto-context-session', version: 0, createdAt: 0, cwd: directory },
        events: [],
        deriveMessages: () => [],
      } as unknown as Session
      const steered: unknown[] = []
      const agent = {
        session,
        steer: (message: unknown) => steered.push(message),
      } as unknown as Agent
      const emptyPrompt = await ctx.systemPrompt.assemble({
        agent,
      })
      // The assemble hook is a synchronous cache fast path: with no snapshot
      // rendered yet, the memory context is simply skipped.
      expect(emptyPrompt.contexts).not.toContainEqual(expect.objectContaining({
        name: 'stratagate:auto-memory',
      }))

      // The cordis Context serial dispatch is typed against its own event table,
      // which does not declare the dsh-session 'session/event' channel; route
      // through a narrow untyped helper for the test.
      const emitEvent = (type: string, ...args: unknown[]): Promise<unknown> =>
        (ctx.serial as unknown as (type: string, ...args: unknown[]) => Promise<unknown>)(type, ...args)

      // Feed three complete turns so the count-triggered eager drain (150 ms)
      // runs off the hot path and refreshes the auto-context snapshot cache.
      for (let turn = 1; turn <= 3; turn += 1) {
        await emitEvent('session/event', session, { type: 'turn/start', seq: (turn - 1) * 4, time: turn * 10, data: { turn } })
        await emitEvent('session/event', session, {
          type: 'user/message', seq: (turn - 1) * 4 + 1, time: turn * 10 + 1,
          data: { id: `u${turn}`, role: 'user', content: [{ type: 'text', text: `Memory turn ${turn}` }], source: { kind: 'user' } },
        })
        await emitEvent('session/event', session, {
          type: 'assistant/message', seq: (turn - 1) * 4 + 2, time: turn * 10 + 2,
          data: {
            turn, step: 1,
            message: { id: `a${turn}`, role: 'assistant', content: [{ type: 'text', text: 'OK.' }], source: { kind: 'model', provider: 'test', model: 'test' } },
          },
        })
        await emitEvent('session/event', session, { type: 'turn/end', seq: (turn - 1) * 4 + 3, time: turn * 10 + 3, data: { turn, reason: { kind: 'completed' } } })
      }
      // Poll the assemble hook until the background drain refreshes the
      // snapshot cache (eager drain starts at ~150 ms plus the drain itself).
      let scopedPrompt = await ctx.systemPrompt.assemble({ agent })
      for (let attempt = 0; attempt < 30 && !scopedPrompt.contexts.some(({ name }) => name === 'stratagate:auto-memory'); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100))
        scopedPrompt = await ctx.systemPrompt.assemble({ agent })
      }
      expect(scopedPrompt.contexts).toContainEqual(expect.objectContaining({
        name: 'stratagate:auto-memory',
        text: expect.stringContaining('[Activated long-term memory]'),
      }))

      const search = ctx.tools.get('memory_search_events')
      const recordUse = ctx.tools.get('memory_record_use')
      expect(search).toBeDefined()
      expect(recordUse).toBeDefined()
      await search!.execute({ query: 'nothing stored' }, {
        agent,
        callId: 'search-call',
      } as never)
      await ctx.serial('agent/turn-stopping', {
        agent,
        turn: 1,
        signal: new AbortController().signal,
      })
      expect(steered).toHaveLength(1)
      expect(steered[0]).toMatchObject({
        source: { kind: 'plugin', plugin: 'stratagate-memory', form: 'instructions' },
      })

      await recordUse!.execute({ evidence_refs: [] }, {
        agent,
        callId: 'record-use-call',
      } as never)
      await ctx.serial('agent/turn-stopping', {
        agent,
        turn: 1,
        signal: new AbortController().signal,
      })
      expect(steered).toHaveLength(1)
    } finally {
      await ctx.fiber.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
