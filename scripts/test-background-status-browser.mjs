import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { chromium } from 'playwright-core'
import { SqliteStorage } from '../packages/core/dist/sqlite.js'
import { KNOWLEDGE_GRAPH_PROJECTOR_VERSION } from '../packages/core/dist/index.js'
import { seedTopicBrowserFixtures, topicBrowserFixtures as topics } from './fixtures/topic-directory.mjs'

// Actual DSH Web host and built StrataGate plugin, with a newly created temp
// DSH_HOME, no credentials and no configured model. All faults are synthetic.
const root = resolve('.')
const output = resolve(process.env.STRATAGATE_BACKGROUND_EVIDENCE || '.artifacts/background-status/browser')
mkdirSync(output, { recursive: true })
const home = mkdtempSync(join(tmpdir(), 'stratagate-background-status-'))
const database = join(home, 'stratagate/memory.db')
await seedTopicBrowserFixtures(database)
const store = new SqliteStorage({ filename: database })
const failed = 'browser:background:failed', retrying = 'browser:background:retrying', restored = 'browser:background:restored'
const now = new Date().toISOString()
const base = (await store.load(topics.failed)).snapshot
const event = base.events[0]
for (const [namespace, terminal] of [[failed, true], [retrying, false], [restored, null]]) {
  const state = structuredClone(base)
  const source = state.blocks[0]
  const extraction = structuredClone(source)
  extraction.id = 'browser-extraction-block'; extraction.sequence = 2
  extraction.startTurn = 2; extraction.endTurn = 2; extraction.shouldExtract = true
  extraction.l5Raw = source.l5Raw.map((message) => ({ ...message, id: 'extraction-' + message.id, content: '隔离测试：这一段仅注入提取失败，不代表主动记住失败。' }))
  const absent = structuredClone(source)
  absent.id = 'browser-no-raw'; absent.sequence = 3; absent.startTurn = 3; absent.endTurn = 3; absent.l5Raw = []
  state.blocks.push(extraction, absent)
  const status = terminal === null ? 'succeeded' : 'failed'
  const job = { status, attempts: terminal ? 3 : 1, nextRetryAt: terminal === false ? '2099-01-01T00:00:00Z' : null,
    lastError: terminal === null ? null : 'isolated injected timeout', updatedAt: now }
  state.summaryJobs = [{ ...job, blockId: source.id }, { ...job, blockId: absent.id }]
  state.extractionJobs = [{ ...job, blockId: extraction.id }]
  source.processingStatus = terminal === null ? 'ready' : 'pending'
  absent.processingStatus = source.processingStatus
  state.graphNodes = [{ id: 'browser-node', name: '隔离测试项目', type: 'project', aliases: [], tags: [], facts: [],
    currentState: '已有图谱仍可查看', status: 'active', confidence: 1, sourceEventIds: [event.id], createdAt: now, updatedAt: now }]
  state.graphProjectionJobs = state.events.map((sourceEvent, index) => ({
    ...job, id: 'browser-graph-' + index, sourceEventIds: [sourceEvent.id],
    projectorVersion: KNOWLEDGE_GRAPH_PROJECTOR_VERSION, status: terminal === null || index === 0 ? 'completed' : 'failed',
    priority: 1, nodeIds: index === 0 ? ['browser-node'] : [], edgeIds: [], reason: 'projected', createdAt: now,
  }))
  if (terminal === false) {
    state.memoryTopicState.jobs.filter((item) => item.status === 'failed').forEach((item) => Object.assign(item, job))
  }
  if (terminal === null) {
    // Restore the real coverage, rather than merely deleting failed jobs.
    const normal = (await store.load(topics.ordered)).snapshot
    state.memoryTopicState = normal.memoryTopicState
  }
  await store.save(namespace, state, 0)
}
store.updateProfileField('preferredLanguage', '中文（隔离测试）', 'settings')
const profile = join(home, 'profiles/web')
mkdirSync(join(profile, 'node_modules'), { recursive: true })
symlinkSync(root, join(profile, 'node_modules/stratagate-dsh'), 'junction')
writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'background-status-test', private: true,
  dependencies: { 'stratagate-dsh': 'file:' + root }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'stratagate-dsh'] } } }))
writeFileSync(join(profile, 'cordis.yml'), '[]\n')
writeFileSync(join(profile, 'cordis.patch.yml'), '- id: ui-settings-general\n  name: "@deepseek-ai/dsh-client-ui-settings-general"\n  config:\n    welcomeNoticeVersion: 2026-09-28.1\n'
  + ['llm-deepseek', 'llm-deepseek-account', 'llm-pi-ai'].map(id => '- id: ' + id + '\n  disabled: true\n').join(''))
const logs = [], errors = [], requests = [], checks = [], screenshots = []
const child = spawn(process.execPath, [join(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), '--profile', 'web', '--port', '0', '--no-open'], {
  cwd: home, env: { ...process.env, DSH_HOME: home }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
let browser
try {
  const launch = await new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error('DSH startup timeout\n' + logs.join(''))), 90000)
    const inspect = (chunk) => {
      logs.push(chunk.toString())
      const match = logs.join('').match(/https?:\/\/(?:127\.0\.0\.1|localhost):\d+\/?\?token=[A-Za-z0-9_-]+/)
      if (match) { clearTimeout(timer); done(match[0]) }
    }
    child.stdout.on('data', inspect); child.stderr.on('data', inspect)
    child.once('exit', code => { clearTimeout(timer); reject(new Error('DSH exited ' + code + '\n' + logs.join(''))) })
  })
  browser = await chromium.launch({ executablePath: process.env.STRATAGATE_TEST_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true })
  const page = await browser.newPage({ viewport: { width: 1360, height: 1000 }, colorScheme: 'dark', locale: 'zh-CN' })
  page.setDefaultTimeout(15000)
  page.on('pageerror', error => errors.push(error.message))
  page.on('dialog', dialog => { errors.push('Unexpected dialog: ' + dialog.message()); void dialog.dismiss() })
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.pathname.startsWith('/api/stratagate/')) requests.push({ method: request.method(), path: url.pathname, namespace: url.searchParams.get('namespace') })
  })
  await page.goto(launch)
  for (const name of ['继续', '稍后配置']) {
    try { await page.getByRole('button', { name, exact: true }).click({ timeout: 2500 }) } catch {}
  }
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: 'StrataGate-AgentMemory' }).click()
  const memory = page.getByTestId('stratagate-memory-ui')
  await memory.waitFor()
  const select = async (namespace) => {
    await Promise.all([
      page.waitForResponse(response => response.url().includes('/api/stratagate/dashboard?') && new URL(response.url()).searchParams.get('namespace') === namespace && response.ok()),
      memory.getByRole('combobox', { name: '当前工作区' }).selectOption(namespace),
    ])
  }
  const tab = name => memory.locator('.sg-tabs').getByRole('button', { name, exact: true }).click()
  const capture = async (name, injection) => {
    // Evidence annotation exists only in the test browser, never product code.
    await page.evaluate(text => {
      let label = document.getElementById('isolated-test-label')
      if (!label) { label = document.createElement('div'); label.id = 'isolated-test-label'; label.style.cssText = 'position:fixed;bottom:8px;right:12px;z-index:2147483647;background:#17202a;color:#fff;padding:8px 12px;border:1px solid #8795a5;font:12px system-ui;pointer-events:none'; document.body.append(label) }
      label.textContent = '隔离测试注入 · ' + text + ' · 非真实用户故障'
    }, injection)
    const file = join(output, name + '.png')
    await page.screenshot({ path: file, fullPage: true }); screenshots.push({ file, injection })
  }
  const noBanners = async () => assert.equal(await memory.locator('.sg-memory-alerts, .sg-memory-alert, [role="alertdialog"]').count(), 0)
  const summaryCopy = '这段对话的摘要暂不可用。'
  const extractionCopy = '部分对话尚未形成长期记忆，暂不能通过长期记忆检索。'
  const graphCopy = '当前图谱尚未更新完整。'
  await select(retrying); await tab('短期记忆'); await noBanners()
  assert.equal(await memory.getByText(summaryCopy, { exact: true }).count(), 0)
  await capture('retrying', '摘要、提取、图谱、目录处于自动重试等待')
  checks.push('automatic retry has no global alert, terminal summary notice, dialog or failure toast')
  await select(failed); await tab('短期记忆')
  await memory.getByText(summaryCopy, { exact: true }).first().waitFor()
  assert.equal(await memory.getByText(summaryCopy, { exact: true }).count(), 2)
  assert.equal(await memory.getByRole('button', { name: '查看原始对话', exact: true }).count(), 1)
  const initialSnapshot = JSON.stringify((await store.load(failed)).snapshot)
  await page.route('**/api/stratagate/sources?**', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '隔离注入：临时原文读取失败' }) }))
  await memory.getByRole('button', { name: '查看原始对话', exact: true }).click()
  await memory.getByText('暂时无法读取这段对话的原文。', { exact: true }).waitFor()
  await memory.getByRole('button', { name: '重新读取原文', exact: true }).waitFor()
  await capture('raw-read-retry', '临时读取失败后仍可在对应块重新读取；仅执行 GET')
  await page.unroute('**/api/stratagate/sources?**')
  await memory.getByRole('button', { name: '重新读取原文', exact: true }).click()
  await memory.locator('.sg-summary-raw').getByText(topics.raw, { exact: true }).waitFor()
  await noBanners(); await capture('summary-terminal', '摘要重试耗尽；一块有原文，另一块无原文')
  checks.push('terminal summary is block-local; exact source opens inline; missing raw has no entry')
  const sourceReads = () => requests.filter(request => request.path === '/api/stratagate/sources').length
  const loadedReads = sourceReads()
  await memory.getByRole('button', { name: '收起原始对话', exact: true }).press('Enter')
  assert.equal(await memory.locator('.sg-summary-raw').count(), 0)
  assert.equal(await memory.getByText(summaryCopy, { exact: true }).count(), 2)
  assert.equal(await memory.getByRole('button', { name: '查看原始对话', exact: true }).getAttribute('aria-expanded'), 'false')
  await capture('raw-collapsed', '原文可由自己的读取入口收起；摘要说明仍保留')
  await memory.getByRole('button', { name: '查看原始对话', exact: true }).press('Enter')
  await memory.locator('.sg-summary-raw').getByText(topics.raw, { exact: true }).waitFor()
  assert.equal(sourceReads(), loadedReads, 'Opening cached source must not submit another read or task')
  for (const status of [403, 404, 200]) {
    await tab('更多'); await tab('短期记忆')
    await page.route('**/api/stratagate/sources?**', route => route.fulfill({ status, contentType: 'application/json',
      body: JSON.stringify(status === 200 ? { namespace: failed, messages: [] } : { error: '隔离注入：原文不可访问' }) }))
    await memory.getByRole('button', { name: '查看原始对话', exact: true }).click()
    await memory.getByText(status === 200 ? '当前没有可读取的原文。' : '暂时无法读取这段对话的原文。', { exact: true }).waitFor()
    assert.equal(await memory.getByRole('button', { name: '查看原始对话', exact: true }).count(), 0)
    assert.equal(await memory.getByRole('button', { name: '重新读取原文', exact: true }).count(), 0)
    await page.unroute('**/api/stratagate/sources?**')
  }
  await capture('raw-unavailable', '空来源或确定不可访问时不提供无效原文入口')
  assert.equal(JSON.stringify((await store.load(failed)).snapshot), initialSnapshot)
  checks.push('503 can be reread in place; raw can collapse/reopen with keyboard; 403/404/empty have no invalid entry; all source actions leave jobs unchanged')
  await tab('长期记忆')
  await memory.getByText('部分记忆尚未归入主题或小节。', { exact: true }).waitFor()
  assert.equal(await memory.getByRole('button', { name: /重新整理这/ }).count(), 0)
  await capture('directory-terminal', '目录整理停止且有未归类内容')
  await memory.getByRole('button', { name: '事件时间线', exact: true }).click()
  await memory.getByText(extractionCopy, { exact: true }).waitFor()
  assert.ok(await memory.locator('.sg-timeline').count() || (await memory.textContent()).includes(event.title))
  assert.equal(await memory.getByText(graphCopy, { exact: true }).count(), 0)
  await capture('extraction-terminal', '长期记忆提取重试耗尽；已有事件正常展示')
  await memory.getByRole('button', { name: '知识图谱', exact: true }).click()
  await memory.getByText(graphCopy, { exact: true }).waitFor()
  assert.equal(await memory.getByText(extractionCopy, { exact: true }).count(), 0)
  await capture('graph-incomplete', '部分图谱投影未完成，已有图谱仍可用')
  checks.push('extraction gap only near timeline, graph gap only in graph; existing content remains')
  await tab('常驻画像'); await noBanners()
  await memory.getByRole('heading', { name: '常驻用户画像' }).waitFor()
  assert.equal(await memory.getByText(graphCopy, { exact: true }).count(), 0)
  await capture('profile-quiet', '其他后台任务失败，画像页不出现无关提示')
  await tab('更多'); await memory.getByRole('button', { name: /高级设置/ }).click()
  await noBanners()
  const before = JSON.stringify((await store.load(failed)).snapshot)
  const writeStart = requests.filter(item => item.method !== 'GET').length
  await memory.getByRole('button', { name: /后台任务/ }).click()
  await memory.getByRole('heading', { name: '后台任务', exact: true }).waitFor()
  await memory.locator('.sg-process-tech').first().waitFor()
  assert.equal(JSON.stringify((await store.load(failed)).snapshot), before)
  assert.equal(requests.filter(item => item.method !== 'GET').length, writeStart)
  await memory.locator('.sg-process-tech').evaluateAll(items => items.forEach(item => { item.open = true }))
  assert.ok(await memory.getByRole('button', { name: '重试此任务', exact: true }).count() > 0)
  assert.equal(await memory.getByRole('button', { name: /重新整理这/ }).count(), 1)
  await capture('diagnostics', '诊断保留失败原因、尝试次数、各项手动恢复操作；仅打开未重试')
  const noRawCard = memory.locator('.sg-process-card').filter({ hasText: 'browser-no-raw' })
  assert.equal(await noRawCard.getByText('当前无可读取原文', { exact: true }).count(), 1)
  assert.equal(await memory.getByText('当前可读取', { exact: true }).count(), 2)
  assert.equal(await memory.getByText('保存原始对话', { exact: true }).count(), 0)
  const colors = await memory.locator('.sg-process-summary').evaluate(node => ({ notice: getComputedStyle(node).color, normal: getComputedStyle(node.closest('.sg-memory')).color }))
  assert.equal(colors.notice, colors.normal, 'General diagnostic information must use neutral text color')
  await noRawCard.scrollIntoViewIfNeeded()
  await capture('diagnostics-source-state', '诊断按实际来源显示可读取或无原文，不宣称保存完成')
  checks.push('diagnostics uses comprehensive title, neutral notice, and evidence-based raw readability')
  checks.push('opening diagnostics makes no write/model request and does not reset attempts; all recovery controls retained')
  const retry = memory.getByRole('button', { name: /重新整理这/ })
  await Promise.all([
    page.waitForResponse(response => response.url().includes('/api/stratagate/topics/retry?') && response.ok()),
    retry.click(),
  ])
  await memory.getByRole('button', { name: '正在提交…', exact: true }).waitFor({ state: 'hidden' })
  const queued = (await store.load(failed)).snapshot
  assert.ok(queued.memoryTopicState.jobs.some(item => item.status === 'pending'))
  assert.deepEqual(queued.summaryJobs, JSON.parse(before).summaryJobs)
  checks.push('topic recovery works from diagnostics and preserves unrelated retry budgets')
  await tab('长期记忆'); await select(topics.running)
  await memory.getByRole('button', { name: '主题目录', exact: true }).click()
  await memory.getByText(/历史记忆整理中 · 已处理 24 \/ 25 条事件/).waitFor()
  await capture('directory-progress', '历史目录整理中；24 / 25 条事件，不包含失败项')
  await select(restored)
  assert.equal(await memory.getByText('部分记忆尚未归入主题或小节。', { exact: true }).count(), 0)
  await memory.getByRole('button', { name: '事件时间线', exact: true }).click()
  assert.equal(await memory.getByText(extractionCopy, { exact: true }).count(), 0)
  await memory.getByRole('button', { name: '知识图谱', exact: true }).click()
  assert.equal(await memory.getByText(graphCopy, { exact: true }).count(), 0)
  await capture('restored', '另一隔离空间已补齐覆盖，无额外成功通知')
  checks.push('workspace switch has no stale notices; complete coverage removes notices naturally')
  const previous = await store.load(failed)
  await store.save(failed, (await store.load(restored)).snapshot, previous.revision)
  await select(failed)
  await memory.getByRole('button', { name: '事件时间线', exact: true }).click()
  assert.equal(await memory.getByText(extractionCopy, { exact: true }).count(), 0)
  await memory.getByRole('button', { name: '知识图谱', exact: true }).click()
  assert.equal(await memory.getByText(graphCopy, { exact: true }).count(), 0)
  await memory.getByRole('button', { name: '主题目录', exact: true }).click()
  assert.equal(await memory.getByText('部分记忆尚未归入主题或小节。', { exact: true }).count(), 0)
  await capture('same-workspace-restored', '原失败空间补齐实际覆盖后，各说明自然移除')
  checks.push('recovery in the same workspace removes notices; no success popup')
  const diagnostic = await page.evaluate(async namespace => (await fetch('/api/stratagate/diagnostics?namespace=' + encodeURIComponent(namespace))).json(), failed)
  assert.ok(Object.values(diagnostic.stages).every(stage => !stage.modelCalls))
  checks.push('isolated host has disabled model adapters; diagnostics confirms zero model calls')
  // A real read failure in the real application must remain visible.
  await page.route('**/api/stratagate/dashboard*', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '隔离注入：数据库暂不可读取' }) }))
  await memory.getByRole('combobox', { name: '当前工作区' }).selectOption(restored)
  await memory.getByText('暂时无法读取完整记忆', { exact: true }).waitFor()
  await memory.locator('.sg-error details').evaluate(detail => { detail.open = true })
  await memory.getByText(/隔离注入：数据库暂不可读取/).waitFor()
  await capture('core-read-error', 'HTTP 503 核心读取故障，错误仍明确可见')
  checks.push('core database read error remains visible, rather than becoming no-task or complete')
  assert.deepEqual(errors, [])
  writeFileSync(join(output, 'result.json'), JSON.stringify({ passed: true, host: JSON.parse(readFileSync(join(root, 'node_modules/@deepseek-ai/dsh/package.json'))).version,
    node: process.version, browser: browser.version(), database, home, pid: child.pid, syntheticOnly: true, checks, screenshots, requests }, null, 2))
  console.log(JSON.stringify({ passed: true, checks, screenshots }))
} finally {
  writeFileSync(join(output, 'dsh.log'), logs.join(''))
  await browser?.close(); child.kill(); await store.close()
}
