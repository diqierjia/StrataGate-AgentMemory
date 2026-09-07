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
      ctx.provide('webServer', { host: '127.0.0.1', port: 10259, register: () => () => {} })
      await ctx.plugin(plugin, { database: join(directory, 'memory.db') })

      const names = ctx.tools.schemas().map(({ name }) => name)
      expect(names).toEqual(expect.arrayContaining([
        'feedback_prepare',
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
      const scopedPrompt = await ctx.systemPrompt.assemble({
        agent,
      })
      expect(scopedPrompt.contexts).toContainEqual(expect.objectContaining({
        name: 'stratagate:auto-memory',
        text: expect.stringContaining('[Activated long-term memory]'),
      }))

      const search = ctx.tools.get('memory_search_events')
      const feedbackPrepare = ctx.tools.get('feedback_prepare')
      const recordUse = ctx.tools.get('memory_record_use')
      expect(search).toBeDefined()
      expect(feedbackPrepare).toBeDefined()
      expect(recordUse).toBeDefined()
      const feedback = await feedbackPrepare!.execute({
        title: 'Local draft',
        description: 'A real failure from this conversation.',
        reproduction: ['Run the failing StrataGate action.'],
      }, {
        agent,
        callId: 'feedback-call',
      } as never) as unknown as Record<string, unknown>
      expect(feedback).toMatchObject({
        prepared: true,
        draftCreated: true,
        submitted: false,
        feedbackUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:10259\/\?settings=stratagate-memory&stratagateView=feedback/),
      })
      expect(feedback).not.toHaveProperty('draft')
      expect(feedback.feedbackUrl).not.toContain('github.com')
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
