import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
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
  const legacySettingsModule = (() => {
    const hostRoot = process.env.DSH_ROOT
    if (hostRoot) {
      try { return createRequire(join(hostRoot, 'package.json')).resolve('@deepseek-ai/dsh-settings-file') } catch {}
    }
    try { return createRequire(import.meta.url).resolve('@deepseek-ai/dsh-settings-file') } catch { return undefined }
  })()
  const legacySettingsAvailable = Boolean(legacySettingsModule && existsSync(legacySettingsModule))

  it.skipIf(!legacySettingsAvailable)('persists legacy global chat display preferences across a complete plugin restart', async () => {
    const { default: FileSettingsRuntime } = await import(pathToFileURL(legacySettingsModule!).href)
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-dsh-display-settings-'))
    const settingsPath = join(directory, 'settings.json')
    const database = join(directory, 'memory.db')
    const mount = async () => {
      const ctx = new Context()
      await ctx.plugin(FileSettingsRuntime, { path: settingsPath, watch: false })
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(SystemPrompt, {})
      await ctx.plugin(ToolRuntime, { mode: 'native' })
      await ctx.plugin(AgentDefaultModelConfig, { provider: 'test', model: 'test' })
      ctx.provide('webServer', { host: '127.0.0.1', port: 10259, register: () => () => {} })
      await ctx.plugin(plugin, { database })
      return ctx
    }
    let first: Context | undefined
    let restarted: Context | undefined
    try {
      first = await mount()
      const settings = first.get('settings') as unknown as { update(ns: string, value: object): Promise<void>; get(ns: string): unknown }
      await settings.update(plugin.STRATAGATE_SETTINGS_NAMESPACE, {
        showStrataGateStatus: false,
        showShortTermStatus: false,
        showRetrievalStatus: false,
      })
      expect(settings.get(plugin.STRATAGATE_SETTINGS_NAMESPACE)).toMatchObject({
        showStrataGateStatus: false,
        showShortTermStatus: false,
        showRetrievalStatus: false,
      })
      await first.fiber.dispose()
      first = undefined

      restarted = await mount()
      expect((restarted.get('settings') as unknown as { get(ns: string): unknown }).get(plugin.STRATAGATE_SETTINGS_NAMESPACE)).toMatchObject({
        showStrataGateStatus: false,
        showShortTermStatus: false,
        showRetrievalStatus: false,
      })
      const stored = JSON.parse(await import('node:fs/promises').then(({ readFile }) => readFile(settingsPath, 'utf8')))
      expect(Object.keys(stored)).toEqual([plugin.STRATAGATE_SETTINGS_NAMESPACE])
    } finally {
      await first?.fiber.dispose()
      await restarted?.fiber.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it.each([
    ['auto', undefined],
    ['force-off', 'force-off'],
  ] as const)('registers the plugin settings entry with structured reasoning effort %s', async (expected, configured) => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-dsh-settings-'))
    const ctx = new Context()
    let registration: { namespace: unknown; entry: unknown } | undefined
    try {
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(SystemPrompt, {})
      await ctx.plugin(ToolRuntime, { mode: 'native' })
      await ctx.plugin(AgentDefaultModelConfig, { provider: 'test', model: 'test' })
      ctx.provide('webServer', { host: '127.0.0.1', port: 10259, register: () => () => {} })
      ctx.provide('settings', {
        installSection: (...args: any[]) => {
          const [, namespace, , entry, hooks] = args
          registration = { namespace, entry }
          hooks.setSource(() => entry)
          hooks.onChange()
        },
      })
      await ctx.plugin(plugin, {
        database: join(directory, 'memory.db'),
        ...(configured ? { structuredReasoningEffort: configured } : {}),
      })

      expect(registration).toEqual({
        namespace: plugin.STRATAGATE_SETTINGS_NAMESPACE,
        entry: {
          structuredReasoningEffort: expected,
          showStrataGateStatus: true,
          showShortTermStatus: true,
          showRetrievalStatus: true,
        },
      })
    } finally {
      await ctx.fiber.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('registers a custom settings page policy through DSH 0.1.7 settings forms', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-dsh-config-forms-'))
    const ctx = new Context()
    const presentations: unknown[] = []
    try {
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(SystemPrompt, {})
      await ctx.plugin(ToolRuntime, { mode: 'native' })
      ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'test', model: 'test' }) } as any)
      ctx.provide('webServer', { host: '127.0.0.1', port: 10259, register: () => () => {} })
      ctx.provide('settings', { configure: (policy: unknown) => { presentations.push(policy); return () => {} } })
      await ctx.plugin(plugin, { database: join(directory, 'memory.db') })
      expect(presentations).toEqual([{ auto: false }])
    } finally {
      await ctx.fiber.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  })

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

      const tools = ctx.tools.schemas()
      const names = tools.map(({ name }) => name)
      expect(names).toEqual([
        'memory_profile_update',
        'feedback_prepare',
        'memory_search_events',
        'memory_search_graph',
        'memory_expand_graph_node',
        'memory_search_elements',
        'memory_search_raw',
        'memory_get_blocks',
        'memory_expand_block',
        'memory_expand_event',
        'memory_expand_element',
        'memory_assess',
        'memory_record_use',
        'memory_remember',
      ])
      for (const tool of tools) {
        expect(tool.description, tool.name).toMatch(/^This tool is provided by the StrataGate plugin\./)
      }
      const prompt = await ctx.systemPrompt.assemble()
      expect(prompt.sections).toContainEqual(expect.objectContaining({
        name: 'tool:stratagate-memory',
        text: expect.stringMatching(/StrataGate provides durable, evidence-gated memory[\s\S]*independent batch[\s\S]*batch_id/),
      }))
      expect(prompt.sections).toContainEqual(expect.objectContaining({
        name: 'tool:stratagate-memory',
        text: expect.stringMatching(/memory_remember[\s\S]*long-term memory[\s\S]*conflict-marked/),
      }))
      expect(prompt.sections).toContainEqual(expect.objectContaining({
        name: 'tool:stratagate-feedback',
        text: expect.stringMatching(/clear error signal[\s\S]*at most one proactive feedback suggestion[\s\S]*namespace plus its substantive characteristics[\s\S]*feedback_prepare itself/),
      }))

      const conversationMessages: Array<{ id: string; role: 'user' | 'assistant'; content: Array<{ type: 'text'; text: string }>; source: { kind: 'user' | 'model' } }> = []
      const session = {
        id: 'auto-context-session',
        header: { id: 'auto-context-session', version: 0, createdAt: 0, cwd: directory },
        snapshotEvents: () => [],
        eventAt: () => undefined,
        deriveMessages: () => conversationMessages,
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
      expect(scopedPrompt.contexts.some((item) => item.name === 'stratagate:persistent-profile')).toBe(false)

      const search = ctx.tools.get('memory_search_events')
      const profileUpdate = ctx.tools.get('memory_profile_update')
      const feedbackPrepare = ctx.tools.get('feedback_prepare')
      const recordUse = ctx.tools.get('memory_record_use')
      const remember = ctx.tools.get('memory_remember')
      expect(search).toBeDefined()
      expect(profileUpdate).toBeDefined()
      expect(profileUpdate!.description).toMatch(/explicitly asks[\s\S]*called immediately/)
      expect(profileUpdate!.description).toMatch(/only infers[\s\S]*which field[\s\S]*new value[\s\S]*reply exactly "同意"[\s\S]*Only a directly subsequent "同意"/)
      expect(profileUpdate!.description).toMatch(/refuses[\s\S]*changes the subject[\s\S]*do not perform the update/)
      expect(profileUpdate!.description).toMatch(/belongs in Event memory[\s\S]*separate Event-memory tool/)
      expect(profileUpdate!.description).toMatch(/preferredLanguage sets only the default language of the final\/user-facing answer[\s\S]*reasoningLanguage sets only the desired language of reasoning\/thinking text visible to the user/)
      expect(profileUpdate!.description).toMatch(/以后都用中文回答我[\s\S]*preferredLanguage = 中文; do not change reasoningLanguage/)
      expect(profileUpdate!.description).toMatch(/以后思考过程用中文[\s\S]*思考链用中文[\s\S]*reasoningLanguage = 中文; do not change preferredLanguage/)
      expect(profileUpdate!.description).toMatch(/以后回答和思考过程都用中文[\s\S]*two separate memory_profile_update calls: first preferredLanguage = 中文, then reasoningLanguage = 中文/)
      conversationMessages.push({ id: 'profile-user-1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '以后默认都用中文回复。' }] })
      expect(await profileUpdate!.execute({ field: 'preferredLanguage', value: '中文' }, { agent, callId: 'profile-call' } as never))
        .toEqual({ field: 'preferredLanguage', value: '中文', modified: true })
      expect(await profileUpdate!.execute({ field: 'preferredLanguage', value: '中文' }, { agent, callId: 'profile-call-2' } as never))
        .toEqual({ field: 'preferredLanguage', value: '中文', modified: false })
      const nextPrompt = await ctx.systemPrompt.assemble({ agent })
      expect(nextPrompt.contexts).toContainEqual(expect.objectContaining({ name: 'stratagate:persistent-profile', text: expect.stringContaining('Preferred answer language: 中文') }))
      expect(nextPrompt.contexts.find((item) => item.name === 'stratagate:persistent-profile')?.text).not.toContain('Preferred visible reasoning language:')
      expect(nextPrompt.contexts.find((item) => item.name === 'stratagate:persistent-profile')?.text).not.toContain('User background:')
      conversationMessages.push({ id: 'both-languages', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '以后回答和思考过程都用中文。' }] })
      expect(await profileUpdate!.execute({ field: 'preferredLanguage', value: '简体中文' }, { agent, callId: 'both-answer' } as never)).toMatchObject({ modified: true })
      expect(await profileUpdate!.execute({ field: 'reasoningLanguage', value: '中文' }, { agent, callId: 'both-reasoning' } as never)).toMatchObject({ modified: true })
      const bothPrompt = await ctx.systemPrompt.assemble({ agent })
      const profileContext = bothPrompt.contexts.find((item) => item.name === 'stratagate:persistent-profile')?.text
      expect(profileContext).toContain('Preferred answer language: 简体中文')
      expect(profileContext).toContain('Preferred visible reasoning language: 中文')
      for (const [id, utterance, field, value] of [
        ['chinese-language', '以后都用英文回答我。', 'preferredLanguage', '英文'],
        ['english-language', 'From now on, please answer me in English.', 'preferredLanguage', 'English'],
        ['reasoning-language', '以后思考链用日语。', 'reasoningLanguage', '日语'],
        ['chinese-name', '以后叫我橙子。', 'userPreferredName', '橙子'],
        ['remember-assistant', '记住，你以后叫小橙。', 'assistantPreferredName', '小橙'],
      ] as const) {
        conversationMessages.push({ id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: utterance }] })
        expect(await profileUpdate!.execute({ field, value }, { agent, callId: id } as never))
          .toMatchObject({ field, value, modified: true })
      }
      const independentPrompt = await ctx.systemPrompt.assemble({ agent })
      const independentContext = independentPrompt.contexts.find((item) => item.name === 'stratagate:persistent-profile')?.text
      expect(independentContext).toContain('Preferred answer language: English')
      expect(independentContext).toContain('Preferred visible reasoning language: 日语')
      // The agent applies the description's consent rule; runtime does not parse proposal wording.
      conversationMessages.push({ id: 'profile-proposal', role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: 'I could keep responses concise in future. Reply 同意 to save responsePreferences = concise.' }] })
      conversationMessages.push({ id: 'profile-consent', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '同意' }] })
      expect(await profileUpdate!.execute({ field: 'responsePreferences', value: 'concise' }, { agent, callId: 'profile-consent' } as never))
        .toMatchObject({ modified: true })
      await expect(profileUpdate!.execute({ field: 'notAProfileField', value: 'x' } as never, { agent, callId: 'unknown-field' } as never))
        .rejects.toThrow(/"field" must be one of|Unknown Persistent Profile field/)
      await expect(profileUpdate!.execute({ field: 'preferredLanguage', value: 42 } as never, { agent, callId: 'non-string' } as never))
        .rejects.toThrow(/string/)
      await expect(profileUpdate!.execute({ field: 'preferredLanguage', value: 'x'.repeat(101) }, { agent, callId: 'too-long' } as never))
        .rejects.toThrow(/100 characters/)
      await expect(profileUpdate!.execute({ field: 'preferredLanguage', value: 'English', userPreferredName: 'wrong' } as never, { agent, callId: 'two-fields' } as never))
        .rejects.toThrow(/Unknown Profile update argument/)
      expect(profileUpdate!.parameters).toMatchObject({ required: ['field', 'value'], properties: { field: { type: 'string' }, value: { type: 'string' } } })
      expect(profileUpdate!.parameters).toMatchObject({ properties: { field: { enum: expect.arrayContaining(['reasoningLanguage']) } } })
      expect(feedbackPrepare).toBeDefined()
      expect(recordUse).toBeDefined()
      expect(remember).toBeDefined()
      expect(remember!.description).toMatch(/durable long-term StrataGate memory[\s\S]*conflict-marked/)
      const remembered = await remember!.execute({
        content: '用户偏好 pnpm 作为包管理器。',
        category: 'preference',
      }, {
        agent,
        callId: 'remember-call',
      } as never) as unknown as Record<string, unknown>
      expect(remembered).toMatchObject({
        recorded: true,
        action: 'ADDED',
        gate: 'clear-new',
        namespace: expect.stringContaining('dsh:project:'),
      })
      const autoPrompt = await ctx.systemPrompt.assemble({ agent })
      expect(autoPrompt.contexts).toContainEqual(expect.objectContaining({
        name: 'stratagate:auto-memory',
        text: expect.stringContaining('[Activated long-term memory]'),
      }))
      expect(feedbackPrepare!.description).toMatch(/directly requests it[\s\S]*explicitly agrees/)
      expect(feedbackPrepare!.description).toMatch(/current conversation[\s\S]*Never submit anything to GitHub/)
      expect(feedbackPrepare!.description).toMatch(/draft is local and not submitted[\s\S]*feedbackUrl[\s\S]*打开反馈草稿/)
      expect(feedbackPrepare!.description).toContain('要不要顺便让我尝试修复这个问题，并提交一个 PR？')
      expect(feedbackPrepare!.description).toMatch(/ask exactly once[\s\S]*does not respond or declines, do not ask again/)
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
        source: { kind: 'plugin:stratagate-memory', form: 'instructions' },
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

  it('unregisters memory_remember when agent memory is disabled', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-dsh-agent-disabled-'))
    const ctx = new Context()
    try {
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(SystemPrompt, {})
      await ctx.plugin(ToolRuntime, { mode: 'native' })
      await ctx.plugin(AgentDefaultModelConfig, { provider: 'test', model: 'test' })
      ctx.provide('webServer', { host: '127.0.0.1', port: 10260, register: () => () => {} })
      await ctx.plugin(plugin, { database: join(directory, 'memory.db'), agentMemoryEnabled: false })

      const names = ctx.tools.schemas().map(({ name }) => name)
      expect(names).not.toContain('memory_remember')
      expect(ctx.tools.get('memory_remember')).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
