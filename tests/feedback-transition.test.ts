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
function mountClient(runtime: StrataGateRuntime, fetchOverride?: (...args: any[]) => any, globals: Record<string, unknown> = {}) {
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
  const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8').replace(
    "    exports.name = 'stratagate-dsh'",
    "    exports.__test = { SupportPage, HeaderCommunityLinks, feedbackEmailUrl, GITHUB_FEEDBACK_ENABLED }; exports.name = 'stratagate-dsh'",
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
    [false, false, true],
    [true, true, true],
    [false, true, false],
    [true, false, false],
  ])('checks Agent=%s and UI=%s before allowing the client build', async (agent, client, allowed) => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-feedback-gates-'))
    try {
      await mkdir(join(directory, 'src'))
      await writeFile(join(directory, 'src/feedback-policy.ts'), 'export const AGENT_FEEDBACK_ENABLED = ' + agent)
      await writeFile(join(directory, 'src/client.js'), 'const GITHUB_FEEDBACK_ENABLED = ' + client)
      const result = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/check-feedback-policy.mjs', import.meta.url)), directory], { encoding: 'utf8' })
      expect(result.error).toBeUndefined()
      expect(result.status === 0).toBe(allowed)
      if (!allowed) expect(result.stderr).toContain('Feedback gates must match')
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it.each([
    ['split surrogate boundary', 'a'.repeat(239) + '😀', 'a'.repeat(239)],
    ['complete surrogate boundary', 'a'.repeat(238) + '😀', 'a'.repeat(238) + '😀'],
  ])('saves and restores %s through the real routes and renders usable email links', async (_name, title, expected) => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-feedback-unicode-'))
    let runtime = openRuntime(join(directory, 'memory.db'))
    try {
      const writer = mountClient(runtime)
      let tree = writer.render()
      props(tree).find((value) => value.className === 'sg-support-input').onChange({ target: { value: title } })
      props(tree).find((value) => value['aria-label'] === '问题内容').onChange({ target: { value: '可复现的问题' } })
      tree = writer.render()
      props(tree).find((value) => value.className === 'sg-support-input').onBlur()
      await vi.waitFor(() => expect(writer.states[3]).toBe('反馈草稿已保存在本地。'))
      expect(runtime.adminFeedbackDraft(namespace).draft?.title).toBe(expected)
      await runtime.close()
      runtime = openRuntime(join(directory, 'memory.db'))
      const reader = mountClient(runtime)
      reader.render(); reader.runEffects()
      await vi.waitFor(() => expect(reader.states[7]).toBe(false))
      const restoredTree = reader.render()
      expect(props(restoredTree).find((value) => value.className === 'sg-support-input').value).toBe(expected)
      expect(props(restoredTree).find((value) => value['aria-label'] === '问题内容').value).toBe('可复现的问题')
      for (const value of props(restoredTree).filter((value) => value.href)) {
        expect(new URL(value.href).protocol).toBe('mailto:')
      }
      control(restoredTree, '下一步：检查报告').onClick()
      control(reader.render(), '下一步：邮件发送').onClick()
      await control(reader.render(), '复制报告').onClick()
      control(reader.render(), '尝试打开邮件应用').onClick()
      expect(new URL(reader.composed[0]!).searchParams.get('subject')).toBe('StrataGate 反馈：' + expected)
      expect(reader.copied[0]).toContain('可复现的问题')
    } finally {
      await runtime.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it.each(['old\ud800title', 'old\udc00title'])('restores historical malformed Unicode title %j without crashing', async (title) => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-feedback-history-'))
    const database = join(directory, 'memory.db')
    const store = new DshMetadataStore(database)
    try { store.setFeedbackDraft(namespace, { title, bodyMarkdown: '旧草稿内容' }) } finally { store.close() }
    const runtime = openRuntime(database)
    try {
      const reader = mountClient(runtime)
      reader.render(); reader.runEffects()
      await vi.waitFor(() => expect(reader.states[7]).toBe(false))
      const tree = reader.render()
      expect(props(tree).find((value) => value.className === 'sg-support-input').value).toBe('old\ufffdtitle')
      expect(() => reader.helpers.feedbackEmailUrl(title)).not.toThrow()
      expect(new URL(reader.helpers.feedbackEmailUrl(title)).searchParams.get('subject')).toBe('StrataGate 反馈：old\ufffdtitle')
      expect(props(tree).find((value) => value['aria-label'] === '问题内容').value).toBe('旧草稿内容')
    } finally {
      await runtime.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('bounds long email subjects and removes control characters before encoding', async () => {
    const runtime = openRuntime(':memory:')
    try {
      const { helpers } = mountClient(runtime)
      const title = 'a'.repeat(239) + '😀' + '尾部'.repeat(10_000)
      const url = new URL(helpers.feedbackEmailUrl(title))
      expect(url.searchParams.get('subject')).toBe('StrataGate 反馈：' + 'a'.repeat(239))
      expect(new URL(helpers.feedbackEmailUrl('甲\u0000\r\n\u007f\u0085乙')).searchParams.get('subject')).toBe('StrataGate 反馈：甲 乙')
      expect(() => helpers.feedbackEmailUrl('x\ud800y\udc00z')).not.toThrow()
    } finally { await runtime.close() }
  })

  it('continues copying and composing when draft saving throws synchronously', async () => {
    const runtime = openRuntime(':memory:')
    try {
      const ui = mountClient(runtime, () => { throw new Error('synchronous save failure') })
      const tree = ui.render()
      ui.runEffects()
      await vi.waitFor(() => expect(ui.states[7]).toBe(false))
      props(tree).find((value) => value['aria-label'] === '问题内容').onChange({ target: { value: '报告仍应可复制' } })
      expect(() => control(ui.render(), '下一步：检查报告').onClick()).not.toThrow()
      control(ui.render(), '下一步：邮件发送').onClick()
      await control(ui.render(), '复制报告').onClick()
      control(ui.render(), '尝试打开邮件应用').onClick()
      expect(ui.calls).toEqual(['save', 'copy', 'compose'])
      expect(ui.copied[0]).toContain('报告仍应可复制')
      expect(ui.composed[0]).toMatch(/^mailto:jiahongcheng61@gmail\.com\?/)
      await vi.waitFor(() => expect(ui.states[4]).toContain('保存反馈草稿失败：synchronous save failure'))
      control(ui.render(), '← 上一步').onClick()
      control(ui.render(), '← 上一步').onClick()
      expect(props(ui.render()).find((value) => value['aria-label'] === '问题内容').value).toBe('报告仍应可复制')
    } finally { await runtime.close() }
  })

  it('keeps real production defaults disabled without accumulating pending error suggestions', async () => {
    const runtime = openRuntime(':memory:')
    try {
      expect(AGENT_FEEDBACK_ENABLED).toBe(false)
      const tools: string[] = []
      registerMemoryTools({ tools: { register: (tool: { name: string }) => tools.push(tool.name) } } as never, runtime)
      expect(tools).not.toContain('feedback_prepare')
      for (let index = 0; index < 1_000; index++) runtime.notePluginError({ id: 'failed-' + index } as Session)
      expect((runtime as unknown as { pendingFeedbackSuggestionSessions: Set<string> }).pendingFeedbackSuggestionSessions.size).toBe(0)
      expect(runtime.takeFeedbackSuggestion({ id: 'failed-1' } as Session)).toBe('')
      const ui = mountClient(runtime)
      expect(ui.helpers.GITHUB_FEEDBACK_ENABLED).toBe(false)
      for (const tree of [ui.render(), ui.helpers.HeaderCommunityLinks()]) {
        expect(JSON.stringify(tree)).not.toMatch(/GitHub|Issue \/ PR|AI 帮我填|feedback_prepare/)
        expect(props(tree).filter((value) => value.href).every((value) => value.href.startsWith('mailto:'))).toBe(true)
      }
    } finally { await runtime.close() }
  })

  it('preserves inputs across steps and copies, downloads and mails only the reviewed snapshot after background updates', async () => {
    const runtime = openRuntime(':memory:')
    const downloads: Blob[] = []
    let clicks = 0, revoked = 0
    class FixtureURL extends URL {
      static createObjectURL(blob: Blob) { downloads.push(blob); return 'blob:feedback-fixture' }
      static revokeObjectURL(_value: string) { revoked++ }
    }
    const link = { style: {}, click: () => { clicks++ }, remove: () => {} }
    try {
      const ui = mountClient(runtime, undefined, { URL: FixtureURL, document: { createElement: () => link, body: { appendChild: () => {} } } })
      ui.render({ overview: { pluginVersion: 'review-version' }, recentError: 'reviewed-error' }); ui.runEffects()
      await vi.waitFor(() => expect(ui.states[7]).toBe(false))
      let tree = ui.render()
      expect(control(tree, '下一步：检查报告').disabled).toBe(true)
      expect(control(tree, '复制报告')).toBeUndefined()
      props(tree).find(p => p['aria-label'] === '问题内容').onChange({ target: { value: '需要保留的问题内容' } })
      props(tree).find(p => p.className === 'sg-support-input').onChange({ target: { value: '原邮件主题' } })
      props(tree).find(p => p['aria-label'] === '加入日志').onChange({ target: { checked: true } })
      control(ui.render(), '下一步：检查报告').onClick()
      tree = ui.render()
      const reviewed = props(tree).find(p => p['aria-label'] === '本地反馈报告预览').value
      expect(reviewed).toContain('review-version')
      expect(reviewed).toContain('reviewed-error')
      expect(reviewed).not.toContain('用户主动附加的记忆数据')
      tree = ui.render({ overview: { pluginVersion: 'new-version' }, recentError: 'unreviewed-error', data: { graph: { nodes: [{ id: 'private-node', name: 'private-memory-fixture' }] } } })
      expect(props(tree).find(p => p['aria-label'] === '本地反馈报告预览').value).toBe(reviewed)
      control(tree, '下一步：邮件发送').onClick()
      tree = ui.render()
      expect(JSON.stringify(tree)).toContain('尚未发送')
      expect(ui.calls).toEqual(['save'])
      await control(tree, '复制报告').onClick()
      expect(ui.copied).toEqual([reviewed])
      expect(ui.composed).toEqual([])
      expect(JSON.stringify(ui.render())).toContain('尚未发送')
      control(ui.render(), '下载诊断文件').onClick()
      expect(await downloads[0]!.text()).toBe(reviewed)
      expect(clicks).toBe(1); expect(revoked).toBe(1)
      control(ui.render(), '尝试打开邮件应用').onClick()
      const mail = new URL(ui.composed[0]!)
      expect(mail.searchParams.get('subject')).toBe('StrataGate 反馈：原邮件主题')
      expect(mail.href).not.toMatch(/reviewed-error|unreviewed-error|private-memory-fixture/)
      expect(control(ui.render(), '← 上一步')['aria-label']).toBe('上一步：检查报告')
      control(ui.render(), '← 上一步').onClick()
      expect(props(ui.render()).find(p => p['aria-label'] === '本地反馈报告预览').value).toBe(reviewed)
      expect(control(ui.render(), '← 上一步')['aria-label']).toBe('上一步：描述问题')
      control(ui.render(), '← 上一步').onClick()
      tree = ui.render()
      expect(props(tree).find(p => p['aria-label'] === '问题内容').value).toBe('需要保留的问题内容')
      expect(props(tree).find(p => p.className === 'sg-support-input').value).toBe('原邮件主题')
      expect(props(tree).find(p => p['aria-label'] === '加入日志').checked).toBe(true)
      props(tree).find(p => p['aria-label'] === '加入日志').onChange({ target: { checked: false } })
      props(tree).find(p => p['aria-label'] === '加入记忆内容').onChange({ target: { checked: true } })
      control(ui.render(), '下一步：检查报告').onClick()
      tree = ui.render()
      const changed = props(tree).find(p => p['aria-label'] === '本地反馈报告预览').value
      expect(changed).toContain('new-version')
      expect(changed).toContain('private-memory-fixture')
      expect(changed).not.toContain('## 诊断日志')
      expect(JSON.stringify(tree)).toContain('可能有私人对话')
      await vi.waitFor(() => expect(runtime.adminFeedbackDraft(namespace).draft?.bodyMarkdown).toBe('需要保留的问题内容'))
    } finally { await runtime.close() }
  })

  it.each(['missing', 'rejected', 'synchronous'])('keeps a manually copyable report when clipboard is %s', async (failure) => {
    const runtime = openRuntime(':memory:')
    const clipboard = failure === 'missing' ? undefined : { writeText: () => {
      if (failure === 'synchronous') throw new Error('clipboard failed')
      return Promise.reject(new Error('permission denied'))
    } }
    try {
      const ui = mountClient(runtime, undefined, { navigator: { clipboard } })
      ui.render(); ui.runEffects(); await vi.waitFor(() => expect(ui.states[7]).toBe(false))
      props(ui.render()).find(p => p['aria-label'] === '问题内容').onChange({ target: { value: '手动复制的报告' } })
      control(ui.render(), '下一步：检查报告').onClick()
      const reviewed = props(ui.render()).find(p => p['aria-label'] === '本地反馈报告预览').value
      control(ui.render(), '下一步：邮件发送').onClick()
      await control(ui.render(), '复制报告').onClick()
      const tree = ui.render()
      expect(props(tree).find(p => p['aria-label'] === '本地反馈报告预览').value).toBe(reviewed)
      expect(JSON.stringify(tree)).toContain('尚未发送')
      expect(JSON.stringify(tree)).toContain('可选中手动复制')
      expect(ui.composed).toEqual([])
    } finally { await runtime.close() }
  })

  it('waits for draft loading and keeps edits when a delayed historical draft arrives', async () => {
    const runtime = openRuntime(':memory:')
    let finishGet: (value: any) => void = () => {}
    try {
      const ui = mountClient(runtime, (url, options) => options?.method === 'PUT' ? request(runtime, url, options) : new Promise(resolve => { finishGet = resolve }))
      ui.render(); ui.runEffects(); await Promise.resolve()
      let tree = ui.render()
      props(tree).find(p => p['aria-label'] === '问题内容').onChange({ target: { value: '刚刚输入的内容' } })
      props(tree).find(p => p.className === 'sg-support-input').onChange({ target: { value: '刚刚输入的主题' } })
      tree = ui.render()
      expect(control(tree, '下一步：检查报告').disabled).toBe(true)
      control(tree, '下一步：检查报告').onClick()
      expect(ui.states[10]).toBe(0)
      finishGet({ ok: true, json: async () => ({ draft: { title: '旧主题', bodyMarkdown: '旧内容' } }) })
      await vi.waitFor(() => expect(ui.states[7]).toBe(false))
      tree = ui.render()
      expect(props(tree).find(p => p['aria-label'] === '问题内容').value).toBe('刚刚输入的内容')
      expect(props(tree).find(p => p.className === 'sg-support-input').value).toBe('刚刚输入的主题')
      expect(control(tree, '下一步：检查报告').disabled).toBe(false)
    } finally { await runtime.close() }
  })

  it('offers the email address and keeps the report when mail activation throws', async () => {
    const runtime = openRuntime(':memory:')
    try {
      const ui = mountClient(runtime, undefined, { window: { location: { set href(_value: string) { throw new Error('desktop protocol rejected') } } } })
      ui.render(); ui.runEffects(); await vi.waitFor(() => expect(ui.states[7]).toBe(false))
      props(ui.render()).find(p => p['aria-label'] === '问题内容').onChange({ target: { value: '没有邮件客户端' } })
      control(ui.render(), '下一步：检查报告').onClick()
      control(ui.render(), '下一步：邮件发送').onClick()
      await control(ui.render(), '复制报告').onClick()
      control(ui.render(), '尝试打开邮件应用').onClick()
      expect(JSON.stringify(ui.render())).toContain('未能打开邮件应用，请复制邮箱')
      expect(JSON.stringify(ui.render())).toContain('jiahongcheng61@gmail.com')
      expect(JSON.stringify(ui.render())).toContain('尚未发送')
      expect(ui.copied[0]).toContain('没有邮件客户端')
    } finally { await runtime.close() }
  })
})
