import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import type { Session } from '@deepseek-ai/dsh-session'
import type { DshModelBridge } from '../src/llm.js'
import { DshMetadataStore } from '../src/metadata.js'
import { StrataGateRuntime } from '../src/runtime.js'
import { AGENT_FEEDBACK_ENABLED, registerMemoryTools } from '../src/tools.js'
import { handleAdminRequest, type WebResponse } from '../src/web.js'

const namespace = 'dsh:project:feedback-transition'
const models = {
  isReady: () => false,
  onAdaptersUpdated: () => () => {},
} as unknown as DshModelBridge

function openRuntime(database: string) {
  return new StrataGateRuntime({
    database, namespaceMode: 'project', namespacePrefix: 'dsh', globalNamespace: 'global',
    blockTurnSize: 6, blockDecayLambda: 0.3, ingestSubagents: false, maxOutputTokens: 2048,
  }, models)
}

async function request(runtime: StrataGateRuntime, url: string, options: { method?: string; body?: string } = {}) {
  let text = ''
  const response: WebResponse = { statusCode: 0, setHeader: () => {}, end: (value) => { text = value } }
  await handleAdminRequest(runtime, { method: options.method || 'GET', url, body: options.body }, response)
  return { ok: response.statusCode === 200, status: response.statusCode, json: async () => JSON.parse(text) }
}

function props(tree: any): any[] {
  if (!Array.isArray(tree)) return []
  return (tree[1] && typeof tree[1] === 'object' ? [tree[1]] : []).concat(tree.slice(2).flatMap(props))
}

function control(tree: any, label: string): any {
  if (!Array.isArray(tree)) return undefined
  if (tree[0] === 'button' && tree.slice(2).includes(label)) return tree[1]
  return tree.slice(2).map((child) => control(child, label)).find(Boolean)
}

// Exercise the actual component effects and state setters with real feedback
// routes and disposable SQLite persistence; do not rewrite the production gate.
function mountClient(runtime: StrataGateRuntime, fetchOverride?: (...args: any[]) => any, globals: Record<string, unknown> = {}, githubGate = false) {
  const states: any[] = []
  const refs: any[] = []
  const effects: Array<() => unknown> = []
  const copied: string[] = []
  const composed: string[] = []
  const calls: string[] = []
  let stateIndex = 0
  let refIndex = 0
  let mounted = false
  const React = {
    createContext: (value: unknown) => ({ value }),
    createElement: (...args: unknown[]) => args,
    Fragment: 'fragment',
    useState: (initial: unknown) => {
      const index = stateIndex++
      if (!mounted) states[index] = initial
      return [states[index], (value: any) => { states[index] = typeof value === 'function' ? value(states[index]) : value }]
    },
    useRef: (initial: unknown) => {
      const index = refIndex++
      if (!mounted) refs[index] = { current: initial }
      return refs[index]
    },
    useEffect: (effect: () => unknown) => { if (!mounted) effects.push(effect) },
  }
  let definition: any
  let source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
  if (!githubGate) source = source.replace(/const GITHUB_FEEDBACK_ENABLED = (?:true|false)/, 'const GITHUB_FEEDBACK_ENABLED = false')
  source = source.replace(
    "    exports.name = 'stratagate-dsh'",
    "    exports.__test = { SupportPage, HeaderStarLink, feedbackEmailUrl, GITHUB_FEEDBACK_ENABLED }; exports.name = 'stratagate-dsh'",
  )
  runInNewContext(source, {
    Blob, URL, URLSearchParams,
    fetch: (url: string, options: { method?: string; body?: string }) => {
      if (options?.method === 'PUT') calls.push('save')
      return fetchOverride ? fetchOverride(url, options) : request(runtime, url, options)
    },
    navigator: { clipboard: { writeText: async (value: string) => { calls.push('copy'); copied.push(value) } } },
    ...globals,
    window: {
      __ModuleLoader__: { load: (value: unknown) => { definition = value } },
      location: (globals.window as any)?.location || { set href(value: string) { calls.push('compose'); composed.push(value) } },
    },
  })
  const helpers = definition.factory(() => React).__test
  let inputs = { namespace, overview: {}, selected: {}, data: {}, recentError: '', onBack: () => {} }
  const render = (updates: Partial<typeof inputs> = {}) => {
    inputs = { ...inputs, ...updates }
    stateIndex = 0; refIndex = 0
    const tree = helpers.SupportPage(inputs)
    mounted = true
    return tree
  }
  return { helpers, render, states, calls, copied, composed, runEffects: () => effects.splice(0).forEach((effect) => effect()) }
}

describe('email feedback review regressions', () => {
  it.each([
    [true, true, true, true], [false, false, false, false],
    [true, false, true, false], [true, true, false, false],
  ])('checks Agent=%s client=%s GitHub=%s', async (agent, client, github, allowed) => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-feedback-gates-'))
    try {
      await mkdir(join(directory, 'src'))
      await writeFile(join(directory, 'src/feedback-policy.ts'), 'export const AGENT_FEEDBACK_ENABLED = ' + agent)
      await writeFile(join(directory, 'src/client.js'), 'const AGENT_FEEDBACK_ENABLED = ' + client + '\nconst GITHUB_FEEDBACK_ENABLED = ' + github)
      const result = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/check-feedback-policy.mjs', import.meta.url)), directory], { encoding: 'utf8' })
      expect(result.error).toBeUndefined()
      expect(result.status === 0).toBe(allowed)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('opens a persisted AI draft directly for review with local statistics and no external navigation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-feedback-ai-'))
    const filename = join(directory, 'memory.db')
    let runtime = openRuntime(filename)
    const session = { id: 'feedback-session', header: { cwd: directory } } as Session
    try {
      const actualNamespace = runtime.namespaceFor(session)
      runtime.diagnostics.record({ namespace: actualNamespace, stage: 'extractor' }, { tasks: 3, tasksSucceeded: 2, tasksFailed: 1, totalTokens: 120 })
      runtime.notePluginError(session, new Error('timeout token=private-secret'))
      await runtime.prepareFeedback(session, { newDraft: true, title: '提取异常', description: '用户已观察到的问题' })
      await runtime.close(); runtime = openRuntime(filename)
      const ui = mountClient(runtime)
      ui.render({ namespace: actualNamespace }); ui.runEffects()
      await vi.waitFor(() => expect(ui.states[7]).toBe(false))
      const tree = ui.render()
      const report = props(tree).find(p => p['aria-label'] === '本地反馈报告预览').value
      expect(report).toContain('用户已观察到的问题')
      expect(report).toContain('120')
      expect(report).toContain('extractor')
      expect(report).not.toContain('private-secret')
      expect(report).not.toContain('用户主动附加的记忆数据')
      expect(control(tree, '复制报告')).toBeDefined()
      expect(control(tree, '尝试打开邮件应用')).toBeUndefined()
      await control(tree, '复制报告').onClick()
      expect(ui.copied).toEqual([report])
      expect(ui.composed).toEqual([])
      expect(JSON.stringify(ui.render())).toContain('尚未发送')
    } finally { await runtime.close(); await rm(directory, { recursive: true, force: true }) }
  })

  it('keeps the reviewed report frozen until editing and preserves manual changes across AI updates', async () => {
    const runtime = openRuntime(':memory:')
    try {
      const ui = mountClient(runtime)
      ui.render({ overview: { pluginVersion: 'review-version' }, recentError: 'reviewed-error' }); ui.runEffects()
      await vi.waitFor(() => expect(ui.states[7]).toBe(false))
      props(ui.render()).find(p => p['aria-label'] === '问题内容').onChange({ target: { value: '用户补充内容' } })
      control(ui.render(), '检查报告').onClick()
      const report = props(ui.render()).find(p => p['aria-label'] === '本地反馈报告预览').value
      const updated = ui.render({ overview: { pluginVersion: 'new-version' }, recentError: 'unreviewed-error' })
      await control(updated, '复制报告').onClick()
      expect(ui.copied).toEqual([report])
      expect(report).toContain('review-version')
      expect(report).not.toContain('unreviewed-error')
      control(ui.render(), '修改或补充').onClick()
      expect(props(ui.render()).find(p => p['aria-label'] === '问题内容').value).toBe('用户补充内容')
      props(ui.render()).find(p => p['aria-label'] === '加入记忆内容').onChange({ target: { checked: true } })
      control(ui.render({ data: { events: [{ id: 'private-id', title: 'private-memory' }] } }), '检查报告').onClick()
      expect(props(ui.render()).find(p => p['aria-label'] === '本地反馈报告预览').value).toContain('private-memory')
      await vi.waitFor(() => expect(runtime.adminFeedbackDraft(namespace).draft?.bodyMarkdown).toBe('用户补充内容'))
      const activeSession = { id: 'current', header: { cwd: '.' } } as Session
      runtime.adminSaveFeedbackDraft(runtime.namespaceFor(activeSession), { title: '保留标题', bodyMarkdown: '## 问题描述\n\n人工描述\n\n## 自定义\n\n人工补充' })
      await runtime.prepareFeedback(activeSession, { actual: '新增现象' })
      expect(runtime.adminFeedbackDraft(runtime.namespaceFor(activeSession)).draft?.bodyMarkdown).toContain('人工补充')
      await runtime.prepareFeedback(activeSession, { newDraft: true, description: '全新问题' })
      expect(runtime.adminFeedbackDraft(runtime.namespaceFor(activeSession)).draft).toMatchObject({ title: '', description: '全新问题', actual: '' })
    } finally { await runtime.close() }
  })

  it.each(['missing', 'rejected', 'synchronous'])('keeps full manual-copy fallback when clipboard is %s', async failure => {
    const runtime = openRuntime(':memory:')
    const clipboard = failure === 'missing' ? undefined : { writeText: () => { if (failure === 'synchronous') throw new Error('denied'); return Promise.reject(new Error('denied')) } }
    try {
      const ui = mountClient(runtime, undefined, { navigator: { clipboard } })
      ui.render(); ui.runEffects(); await vi.waitFor(() => expect(ui.states[7]).toBe(false))
      props(ui.render()).find(p => p['aria-label'] === '问题内容').onChange({ target: { value: '手动复制报告' } })
      control(ui.render(), '检查报告').onClick()
      const report = props(ui.render()).find(p => p['aria-label'] === '本地反馈报告预览').value
      await control(ui.render(), '复制报告').onClick()
      expect(props(ui.render()).find(p => p['aria-label'] === '本地反馈报告预览').value).toBe(report)
      expect(JSON.stringify(ui.render())).toContain('可选中手动复制')
      expect(ui.composed).toEqual([])
    } finally { await runtime.close() }
  })

  it('keeps copying available when saving fails and offers the AI prompt for manual entry', async () => {
    const runtime = openRuntime(':memory:')
    try {
      const ui = mountClient(runtime, () => { throw new Error('save failure') })
      ui.render(); ui.runEffects(); await vi.waitFor(() => expect(ui.states[7]).toBe(false))
      expect(control(ui.render(), '让 AI 整理反馈')).toBeDefined()
      props(ui.render()).find(p => p['aria-label'] === '问题内容').onChange({ target: { value: '报告仍可复制' } })
      control(ui.render(), '检查报告').onClick()
      await control(ui.render(), '复制报告').onClick()
      expect(ui.copied[0]).toContain('报告仍可复制')
      await vi.waitFor(() => expect(ui.states[4]).toContain('保存反馈草稿失败'))
    } finally { await runtime.close() }
  })

  it('waits for loading and protects edits made while a historical AI draft is arriving', async () => {
    const runtime = openRuntime(':memory:')
    let finishGet: (value: unknown) => void = () => {}
    try {
      const ui = mountClient(runtime, (_url, options) => options?.method === 'PUT' ? request(runtime, _url, options) : new Promise(resolve => { finishGet = resolve }))
      ui.render(); ui.runEffects(); await Promise.resolve()
      props(ui.render()).find(p => p['aria-label'] === '问题内容').onChange({ target: { value: '刚刚输入' } })
      expect(control(ui.render(), '检查报告').disabled).toBe(true)
      finishGet({ ok: true, json: async () => ({ draft: { title: '旧标题', bodyMarkdown: '旧内容', aiPrepared: true } }) })
      await vi.waitFor(() => expect(ui.states[7]).toBe(false))
      expect(props(ui.render()).find(p => p['aria-label'] === '问题内容').value).toBe('刚刚输入')
      expect(control(ui.render(), '复制报告')).toBeUndefined()
    } finally { await runtime.close() }
  })

  it('restores malformed historical text safely and exposes diagnostics only in the current namespace', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-feedback-history-'))
    const filename = join(directory, 'memory.db')
    const store = new DshMetadataStore(filename)
    store.setFeedbackDraft(namespace, { title: 'old\ud800title', bodyMarkdown: '旧内容' }); store.close()
    const runtime = openRuntime(filename)
    try {
      const ui = mountClient(runtime)
      ui.render(); ui.runEffects(); await vi.waitFor(() => expect(ui.states[7]).toBe(false))
      expect(props(ui.render()).find(p => p.className === 'sg-support-input').value).toBe('old\ufffdtitle')
      runtime.diagnostics.record({ namespace, stage: 'extractor' }, { tasksFailed: 1 }, { error: 'timeout' })
      const all = await request(runtime, '/api/stratagate/diagnostics?namespace=' + encodeURIComponent(namespace))
      const diagnostics = await all.json()
      expect(diagnostics.records[0].category).toBe('timeout')
      expect(diagnostics.records[0]).not.toHaveProperty('detail')
      const other = await request(runtime, '/api/stratagate/diagnostics?namespace=other&id=' + diagnostics.records[0].id)
      expect((await other.json()).records).toEqual([])
      expect((await request(runtime, '/api/stratagate/diagnostics')).status).toBe(400)
    } finally { await runtime.close(); await rm(directory, { recursive: true, force: true }) }
  })

  it('registers scoped email tools while background failures remain quiet', async () => {
    const runtime = openRuntime(':memory:')
    try {
      expect(AGENT_FEEDBACK_ENABLED).toBe(true)
      const tools: string[] = []
      registerMemoryTools({ tools: { register: (tool: { name: string }) => tools.push(tool.name) } } as never, runtime)
      expect(tools).toContain('feedback_prepare')
      expect(tools).toContain('stratagate_diagnostics')
      const session = { id: 'quiet', header: { cwd: '.' } } as Session
      runtime.notePluginError(session, new Error('timeout'))
      expect(runtime.takeFeedbackSuggestion(session)).toBe('')
      expect(runtime.diagnostics.snapshot(runtime.namespaceFor(session)).records[0]?.category).toBe('timeout')
      expect(mountClient(runtime, undefined, {}, true).helpers.GITHUB_FEEDBACK_ENABLED).toBe(true)
    } finally { await runtime.close() }
  })
})
