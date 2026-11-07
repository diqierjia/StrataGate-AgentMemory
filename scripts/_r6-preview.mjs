// Static visual-check harness for the round-6 UI. Renders the real components
// with a fake API so the screenshots can be regenerated without a DSH profile.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { chromium } from 'playwright-core'

const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8').replace(
  "    exports.name = 'stratagate-dsh'",
  "    exports.__r6 = { TimelineList, SettingsPage, ProfilePage, ShortTermPage, DailyNotesPage, LongTermPage, MoreHome, SettingsPage, ProfilePageTest: ProfilePage }; exports.name = 'stratagate-dsh'",
)

const hooks = new Map()
const positions = new Map()
let currentPath = 'root'
const pending = []
function nextSlot(kind) {
  const key = currentPath + ':' + kind
  const index = positions.get(key) || 0
  positions.set(key, index + 1)
  const slots = hooks.get(key) || []
  hooks.set(key, slots)
  return { slots, index }
}
const React = {
  createContext: (value) => ({ Provider: 'provider', value }),
  createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
  Fragment: 'fragment',
  useState(initial) {
    const { slots, index } = nextSlot('state')
    if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
    return [slots[index], (next) => { slots[index] = typeof next === 'function' ? next(slots[index]) : next }]
  },
  useRef(initial) {
    const { slots, index } = nextSlot('ref')
    return (slots[index] ||= { current: initial })
  },
  useEffect(effect, deps) {
    const { slots, index } = nextSlot('effect')
    const previous = slots[index]
    if (!previous || !deps || deps.some((value, key) => value !== previous.deps[key])) {
      slots[index] = { deps }
      pending.push(effect)
    }
  },
  useMemo: (compute) => compute(),
  useCallback: (callback) => callback,
}

const profile = {
  userPreferredName: '佳洪', assistantPreferredName: '小层', preferredLanguage: '中文', reasoningLanguage: '中文',
  defaultLocation: '上海', homeCity: '', currentCity: '', responsePreferences: '先说结论，再补细节；方案先给对比',
  standingInstructions: '未经确认不提交、不发布', userBackground: '后端工程师，在做 Agent 评测和记忆系统',
  longTermGoals: '把 StrataGate 做成好用的开源记忆层', persistentNotes: '', _revisions: { userPreferredName: 1, assistantPreferredName: 1, preferredLanguage: 1, reasoningLanguage: 1, defaultLocation: 1, homeCity: 0, currentCity: 0, responsePreferences: 1, standingInstructions: 1, userBackground: 1, longTermGoals: 1, persistentNotes: 1 },
}

const section = (title, count, paragraphs, key) => ({ key, title, sourceEventCount: count, paragraphs })
const fixtureDirectory = {
  revision: 'r1', pending: { total: 3 },
  dreaming: { id: 'd1', status: 'completed', completed: 4, total: 4, updatedAt: new Date().toISOString(), sessionId: 's' },
  context: '[StrataGate 记忆目录]',
  topics: [
    { id: 't1', title: 'StrataGate', description: '产品与视觉', coverage: { unassignedEvents: 0 }, sections: [
      section('前端与视觉', 6, [{ kind: 'history', text: '界面要安静、可读：不用发光和渐变；宋体标题；红色只用于出错。' }], 's1'),
      section('发布流程', 5, [{ kind: 'change', text: 'npm 与 GitHub 同步发布。' }], 's2'),
      section('记忆分层设计', 7, [{ kind: 'history', text: '六层记忆按时间衰减。' }], 's3')] },
    { id: 't2', title: '评测', description: 'JobBench', coverage: { unassignedEvents: 2 }, sections: [
      section('JobBench 运行', 9, [{ kind: 'history', text: '固定基线跑批。' }], 's4'),
      section('结论与下一步', 4, [{ kind: 'decision', text: '先做消融。' }], 's5')] },
    { id: 't3', title: '工作方式', description: '', coverage: { unassignedEvents: 1 }, sections: [
      section('沟通偏好', 8, [{ kind: 'scope', text: '中文、先结论。' }], 's6')] },
  ],
}

const events = Array.from({ length: 6 }, (_, index) => ({
  id: 'e' + index, title: ['前端不要 AI 味', '总览改用记忆柱', 'GitHub 链接改回 GitHub', '标题用宋体，数字用等宽', '前端打包 0.3.42', '旧配色方案'][index],
  summary: '示例摘要', status: index === 5 ? 'archived' : 'active', createdAt: new Date(Date.now() - index * 86400000).toISOString(),
  temporal: { happenedStart: new Date(Date.now() - index * 86400000).toISOString(), eventType: 'change', status: 'occurred' },
  weight: { mentionCount: index % 3 === 0 ? 3 : 1, lastAdoptedTurn: 3, floorWeight: 0.2, pinned: false, forcedCap: null, lastRetrievedAt: null },
}))

const blocks = Array.from({ length: 9 }, (_, index) => ({
  id: 'b' + index, sequence: index + 1, title: ['搭建项目与仓库', '确定评测指标', '补充 rerank', '语义向量检索设计', '修复作用域内排序', '审查 PR', '发布 0.3.42', '前端交接文档', '总览改成记忆柱'][index],
  turnRange: [index * 6 + 1, index * 6 + 6], currentLevel: Math.min(5, Math.floor(index / 2) + 1), surfaceLevelKnown: true, targetLevel: 3,
  summary: '总览从卡片流向图改成上下叠放的记忆柱；去掉花纹；常驻画像数字改为实时读取。', keypoints: ['改为记忆柱'], distanceFromLatest: 9 - index, createdAt: new Date().toISOString(),
}))

const dailyIndex = {
  enabled: true, today: new Date().toISOString().slice(0, 10), injectionDays: 3,
  dates: [0, 1, 2, 3, 4].map((offset) => new Date(Date.now() - offset * 86400000).toISOString().slice(0, 10)),
  injectedDates: [0, 1, 2].map((offset) => new Date(Date.now() - offset * 86400000).toISOString().slice(0, 10)),
}

const markdownFor = (date) => `# ${date}\n\n## 长期记忆做成书的样子\n16:40 完成目录排版\n- 细节\n\n## 红色只用于出错\n11:20 检查配色\n`

const fetchMock = async (url) => {
  const parsed = new URL(url, 'http://localhost')
  const path = parsed.pathname
  const ok = (value) => ({ ok: true, status: 200, json: async () => value })
  if (path === '/api/stratagate/profile') return ok(profile)
  if (path === '/api/stratagate/daily') return ok(dailyIndex)
  if (path === '/api/stratagate/daily/note') return ok({ date: parsed.searchParams.get('date'), markdown: markdownFor(parsed.searchParams.get('date')) })
  if (path === '/api/stratagate/topic-events') {
    const offset = Number(parsed.searchParams.get('offset'))
    const items = events.slice(offset, offset + 9)
    return ok({ namespace: 'n', topicId: parsed.searchParams.get('topicId'), sectionKey: parsed.searchParams.get('sectionKey'), revision: 'r1', items, total: events.length, offset, limit: 9, nextOffset: offset + items.length < events.length ? offset + items.length : null })
  }
  return ok({})
}

let definition
runInNewContext(source, {
  Blob, URL, URLSearchParams, AbortController, fetch: fetchMock,
  document: { body: { style: {} }, hidden: false, activeElement: null, querySelector: () => null, addEventListener: () => {}, removeEventListener: () => {}, querySelectorAll: () => [] },
  window: { __ModuleLoader__: { load: (value) => { definition = value } }, setTimeout: () => 0, clearTimeout: () => {}, addEventListener: () => {}, removeEventListener: () => {}, matchMedia: () => ({ matches: false }) },
  navigator: { clipboard: { writeText: async () => {} } },
})
const ui = definition.factory(() => React).__r6

const escapeHtml = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const voidTags = new Set(['img', 'input', 'br', 'hr', 'meta', 'link'])
const styleText = (style) => Object.entries(style || {}).filter(([, value]) => value !== undefined && value !== null).map(([key, value]) => key.replace(/[A-Z]/g, (letter) => '-' + letter.toLowerCase()) + ':' + value).join(';')
function toHtml(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return escapeHtml(node)
  if (Array.isArray(node)) return node.map(toHtml).join('')
  if (typeof node === 'function') {
    const previous = currentPath
    currentPath = previous + '/' + (node.name || 'fn')
    const rendered = node(node.props || {})
    currentPath = previous
    return toHtml(rendered)
  }
  const { type, props = {}, children = [] } = node
  if (type === 'fragment') return children.map(toHtml).join('')
  if (typeof type === 'function') {
    const previous = currentPath
    currentPath = previous + '/' + (type.name || 'fn')
    const rendered = type({ ...props, children })
    currentPath = previous
    return toHtml(rendered)
  }
  const attrs = []
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue
    if (/^(on|key$|ref$|children$)/.test(key)) continue
    if (key === 'style') { attrs.push('style="' + escapeHtml(styleText(value)) + '"'); continue }
    if (key === 'className') { attrs.push('class="' + escapeHtml(value) + '"'); continue }
    if (value === true) { attrs.push(key); continue }
    attrs.push(key + '="' + escapeHtml(value) + '"')
  }
  const open = '<' + type + (attrs.length ? ' ' + attrs.join(' ') : '') + '>'
  if (voidTags.has(type)) return open
  return open + children.map(toHtml).join('') + '</' + type + '>'
}

async function renderOnce(component, props) {
  hooks.clear(); positions.clear(); pending.length = 0; currentPath = 'root'
  let html = ''
  for (let round = 0; round < 30; round += 1) {
    positions.clear(); pending.length = 0
    html = toHtml(component(props))
    const effects = pending.splice(0)
    for (const effect of effects) { try { effect() } catch {} }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return html
}

const styles = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
const sliceConst = (name, nextName) => {
  const start = styles.indexOf('    const ' + name + ' = `') + ('    const ' + name + ' = `').length
  const next = styles.indexOf('    const ' + nextName, start)
  return styles.slice(start, styles.lastIndexOf('`', next))
}
const css = [
  sliceConst('css', 'citationCss'),
  sliceConst('eventDetailCss', 'topicDirectoryCss'),
  sliceConst('topicDirectoryCss', 'DAILY_NOTES_CSS'),
  sliceConst('DAILY_NOTES_CSS', 'R6_STYLES'),
  sliceConst('R6_STYLES', 'function api'),
].join('\n')

async function renderBook(props) {
  // The section body only renders once a toggle is open; the screenshots open
  // the first section on the page itself (see the book-open step below).
  return renderOnce(ui.LongTermPage, props)
}

const pages = []
pages.push({ name: 'profile', html: await renderOnce(ui.ProfilePage, {}), tab: 'profile' })
pages.push({ name: 'short', html: await renderOnce(ui.ShortTermPage, { blocks, blockPage: { total: blocks.length, offset: 0, limit: 40 }, openBlock: { turnRange: [55, 57], messages: 4, turns: 3, status: 'open' }, conversations: [{ id: 'c1', label: '当前对话' }], activeThreadId: 'c1', namespace: 'n', onConversationChange: () => {}, refresh: async () => {} }), tab: 'short' })
pages.push({ name: 'daily', html: await renderOnce(ui.DailyNotesPage, { namespace: 'n', setDailyInjectionDays: async () => true }), tab: 'daily' })
const bookProps = { events, eventPage: { total: events.length, offset: 0, limit: 40 }, graph: { nodes: [], edges: [], clusters: [] }, graphSettings: { enabled: false, noticeSeen: true }, project: '当前工作区', query: '', setQuery: () => {}, openEvent: () => {}, namespace: 'n', topicDirectory: fixtureDirectory, onDirectoryChanged: () => {}, active: true, refresh: async () => {} }
const bookHtml = await renderBook(bookProps)
pages.push({ name: 'book', html: bookHtml, tab: 'long' })
pages.push({ name: 'book-open', html: bookHtml, tab: 'long' })
pages.push({ name: 'settings', html: await renderOnce(ui.SettingsPage, { selected: { schemaVersion: 12, blockTurnSize: 6, blockDecayLambda: 0.3, agentMemoryRetrievalWeight: 1, currentTurn: 8, workspaceName: 'StrataGate' }, graphSettings: { enabled: false, noticeSeen: true }, vectorSettings: {}, retrievalSettingsWritable: true, onRetrievalSettingsSaved: () => {}, refresh: async () => {}, namespace: 'n', dataDirectory: '~/.dsh/stratagate', onBack: () => {}, setView: () => {}, updateSettings: async () => {}, savingSettings: false, usePluginSettings: null, setMemoryModel: null, setEffort: null, resetEffort: null }), tab: 'more' })
pages.push({ name: 'timeline', html: await renderOnce(ui.TimelineList, { events, nodes: [], onSelect: () => {}, selectedId: 'e1', floating: false, onNode: () => {}, openSource: () => {}, dreaming: fixtureDirectory.dreaming }), tab: 'long' })
pages.push({ name: 'more', html: await renderOnce(ui.MoreHome, { setView: () => {} }), tab: 'more' })

const head = (theme) => `<!doctype html><html lang="zh-CN" data-theme="${theme}"><head><meta charset="utf-8"><style>
html[data-theme=dark]{--dsw-alias-bg-layer-1:#1d1e21;--dsw-alias-bg-layer-2:#25262a;--dsw-alias-label-primary:#ecebe6;--dsw-alias-label-secondary:#b3b1aa;--dsw-alias-label-tertiary:#8d8b84;--dsw-alias-border-l2:#3a3a3d;--dsw-alias-state-business-primary:#5b8def;--dsw-alias-state-error-primary:#e5604d;--dsw-alias-state-success-primary:#4cae74;--dsw-alias-state-warn-label:#d3a24d}
html[data-theme=light]{--dsw-alias-bg-layer-1:#ffffff;--dsw-alias-bg-layer-2:#f6f6f4;--dsw-alias-label-primary:#1d1d1b;--dsw-alias-label-secondary:#55534d;--dsw-alias-label-tertiary:#7a776f;--dsw-alias-border-l2:#e3e1da;--dsw-alias-state-business-primary:#2f6bdc;--dsw-alias-state-error-primary:#c8402c;--dsw-alias-state-success-primary:#2f8a55;--dsw-alias-state-warn-label:#a9822f}
body{margin:0;background:var(--dsw-alias-bg-layer-1);font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
${css}
</style></head><body>`

const tabs = [['profile', '常驻画像', 'ink'], ['short', '会话记忆', 'water'], ['daily', '短期记忆', 'sand'], ['long', '长期记忆', 'lib'], ['more', '更多', '']]
const frame = (page) => `<main class="sg-memory" data-testid="stratagate-memory-ui">
<header class="sg-header"><div class="sg-header-row sg-header-row-primary"><div class="sg-brand"><span class="sg-logo" style="width:28px;height:28px;background:var(--sg-soft);border-radius:8px"></span><span class="sg-brand-copy"><span class="sg-brand-title"><span class="sg-brand-name">StrataGate</span><span class="sg-brand-version">v0.3.42</span></span></span></div><span class="sg-usage-count"><strong class="sg-usage-number">12</strong><span>次记忆被用到</span></span></div><div class="sg-header-row sg-header-row-secondary"><div class="sg-project"><span class="sg-project-label">当前工作区：</span><span class="sg-project-select">默认工作区</span></div></div></header>
<nav class="sg-tabs" aria-label="记忆视图">${tabs.map(([id, label, swatch]) => `<button type="button" class="sg-tab ${page.tab === id ? 'active' : ''}">${swatch ? `<i class="sg-tab-swatch ${swatch}"></i>` : ''}${label}</button>`).join('')}</nav>
<section class="sg-view">${page.html}</section>
<footer class="sg-footer"><span>StrataGate-AgentMemory · MIT</span><span>GitHub 仓库 · 提 Issue · 更新记录</span></footer></main>`

const output = new URL('../docs/ui-r6-screenshots/', import.meta.url)
mkdirSync(output, { recursive: true })
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
for (const theme of ['light', 'dark']) {
  for (const width of [1180, 420]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 2 })
    const page = await context.newPage()
    for (const item of pages) {
      const file = new URL(`${item.name}-${theme}-${width}.html`, output)
      writeFileSync(file, head(theme) + frame(item) + '</body></html>')
      await page.goto(file.href)
      if (item.name === 'book-open') {
        await page.evaluate(() => {
          const section = document.querySelector('.sg-topic-section')
          const fold = section?.querySelector('.sg-directory-fold')
          const toggle = section?.querySelector('.sg-topic-section-toggle')
          if (fold) { fold.classList.add('open'); fold.removeAttribute('aria-hidden') }
          if (toggle) { toggle.setAttribute('aria-expanded', 'true'); toggle.classList.add('cur') }
        })
      }
      await page.waitForTimeout(120)
      const overflow = await page.evaluate(() => { const root = document.querySelector('.sg-memory'); return root ? root.scrollWidth - root.clientWidth : 0 })
      const target = new URL(`${item.name}-${theme}-${width >= 900 ? 'wide' : 'narrow'}.png`, output)
      await page.screenshot({ path: target.pathname, fullPage: true })
      console.log(item.name, theme, width, 'overflow', overflow)
    }
    await context.close()
  }
}
await browser.close()
