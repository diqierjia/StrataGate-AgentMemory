import assert from 'node:assert/strict'
import { readFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'node:http'
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'

// Synthetic SQLite + real Runtime, HTTP routes, React components and browser.
// No production DSH Home or network model is used.
const root = resolve('.')
const output = resolve('release-candidates/dreaming-development/browser')
const react = resolve('release-candidates/first-login-browser-fixture/node_modules')
mkdirSync(output, { recursive: true })
const modulePath = join(output, 'fixture.mjs')
await build({ stdin: { resolveDir: root, contents: `export { StrataGate } from './packages/core/src/index.ts'; export { SqliteStorage } from './packages/core/src/sqlite.ts'; export { StrataGateRuntime } from './src/runtime.ts'; export { handleAdminRequest } from './src/web.ts'; export { DshDreamingSessions } from './src/dreaming-session.ts';` },
  outfile: modulePath, bundle: true, platform: 'node', format: 'esm', packages: 'external', alias: {
    '@diqier/stratagate/sqlite': join(root, 'packages/core/src/sqlite.ts'), '@diqier/stratagate': join(root, 'packages/core/src/index.ts') } })
const { StrataGate, SqliteStorage, StrataGateRuntime, handleAdminRequest, DshDreamingSessions } = await import(pathToFileURL(modulePath).href)
const fixture = mkdtempSync(join(output, 'fixture-'))
const database = join(fixture, 'memory.sqlite')
const namespace = 'dreaming-browser'
let fixtureDate = '2026-11-18'
const memory = await StrataGate.open({ database, namespace, blockTurnSize: 1, disableElementProjection: true, now: () => new Date(`${fixtureDate}T12:00:00+08:00`),
  summarizer: async () => ({ l0Title: '目录资料', l0Tags: [], l1Summary: '目录资料', l2Keypoints: [], shouldExtract: false }) })
await memory.appendTurn({ user: '重新看了一遍目录纸面的排法。', assistant: '先保留左右两页。' })
fixtureDate = '2026-11-19'
await memory.appendTurn({ user: '目录整理需要保留来源。', assistant: '记录。' })
const block = memory.listBlocks()[0]
const event = await memory.addEvent({ title: '保留来源', summary: '用户明确要求目录整理保留来源。', sourceBlockId: block.id, sourceMessageIds: [block.l5Raw[0].id] })
const job = await memory.claimNextTopicProjection()
await memory.completeTopicProjection(job.jobId, { topics: [{ title: '项目开发', description: '开发与协作方式', sourceEventIds: [event.id],
  sections: [{ title: '协作', sourceEventIds: [event.id] }], overview: [] }] })
const run = await memory.dreaming({ kind: 'start', owner: 'fixture' })
const snapshot = memory.exportSnapshot()
snapshot.memoryTopicState.dreaming = { ...run, status: 'completed', leaseUntil: null, changes: {
  editedEvents: 1, deletedEvents: 1, experiences: 1,
  items: [
    { kind: 'event-edit', id: event.id, label: '目录整理入口', detail: '补上入口放在总览的原因。' },
    { kind: 'event-delete', id: 'old-draft', label: '目录页整理按钮（重复）', detail: '合并到「目录整理入口」。' },
    { kind: 'experience', id: 'source-work', label: '整理目录时保留来源' },
  ],
} }
const storage = new SqliteStorage({ filename: database })
try { await storage.save(namespace, snapshot, memory.storageRevision) } finally { await storage.close() }
await memory.close()
const ctx = new Context()
await ctx.plugin(LlmRuntime); await ctx.plugin(SystemPrompt, {}); await ctx.plugin(ToolRuntime, { mode: 'native' })
await ctx.plugin(SessionStore); await ctx.plugin(SessionProjections); await ctx.plugin(AgentRegistry)
await ctx.plugin(JsonlPersistence, { root: join(fixture, 'sessions'), compression: 'none' })
await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 })
let callIndex = 0
ctx.on('llm/stream', async function* (options) {
    const signal = options.signal
    await new Promise((done, reject) => {
      const timer = setTimeout(done, 800)
      const abort = () => { clearTimeout(timer); reject(new Error('Cancelled')) }
      if (signal?.aborted) abort()
      else signal?.addEventListener('abort', abort, { once: true })
    })
    const run = (await runtime.adminDreamingStatus(namespace)).run
    if (run.status === 'completed') { yield { type: 'text-delta', index: 0, text: '目录整理完成。' }; yield { type: 'finish', reason: { kind: 'stop' } }; return }
    const { trace } = await runtime.dreamingRun(namespace, run.id)
    const action = !trace.some(tool => tool.tool === 'dreaming_search') ? { tool: 'dreaming_search', args: { kind: 'events', query: '来源' } }
      : !trace.some(tool => tool.tool === 'dreaming_directory') ? { tool: 'dreaming_directory', args: { operations: [{ kind: 'rename-section', from: '协作', title: '沟通与协作' }] } }
      : { tool: 'dreaming_finish', args: { summary: '目录整理完成。' } }
    yield { type: 'tool-call-delta', index: 0, id: `browser-call-${++callIndex}`, name: action.tool, argumentsDelta: JSON.stringify(action.args) }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
})
const models = {
  isReady: () => false, onAdaptersUpdated: () => () => {},
  runDetached: (_id, callback) => callback(),
  writeDailyLetter: async ({ date }) => date === '2026-11-19' ? {
    title: '总算给目录腾了个地方', signature: '小墨',
    paragraphs: ['差点把目录挤得连书脊都找不着。你提醒我，整理动的是整个工作区，我才看明白：既然谁都用得上，入口就该放在总览。', '目录还是原来的两页。以后翻回来，也能记得我们为什么舍得把那块面板挪走。'],
  } : { title: '把书页摊开', signature: '小墨', paragraphs: ['今天重新看了目录纸面的排法，最后把左右两页留了下来。'] },
}
const runtime = new StrataGateRuntime({ database, namespaceMode: 'project', namespacePrefix: 'dsh', globalNamespace: 'global', blockTurnSize: 1,
  blockDecayLambda: .3, ingestSubagents: false, maxOutputTokens: 2048 }, models)
runtime.setDreamingHost(new DshDreamingSessions(ctx, runtime, () => ({ provider: 'fixture', model: 'fixture', maxTokens: 32768 })), 'directory')
runtime.applyLiveDailyNotes(undefined, 'Asia/Shanghai', undefined)
await runtime.dailyNotes.write(namespace, { date: fixtureDate, title: '目录工作记录', content: '保留目录的双页排版。' })
await runtime.writeClosedDayLetters(Date.parse('2026-11-19T00:05:00+08:00'))
await runtime.writeClosedDayLetters(Date.parse('2026-11-20T00:05:00+08:00'))
const source = readFileSync(join(root, 'src/client.js'), 'utf8').replace("exports.name = 'stratagate-dsh'", "exports.__browserTest = { MemoryPage }; exports.name = 'stratagate-dsh'")
const app = await build({ stdin: { resolveDir: root, contents: `
import React from ${JSON.stringify(join(react, 'react/index.js'))};
import { createRoot } from ${JSON.stringify(join(react, 'react-dom/client.js'))};
let definition; window.__ModuleLoader__ = { load(value) { definition = value; } };
${source}
const { MemoryPage } = definition.factory(() => React).__browserTest;
const workspaces = { items: [] };
const sessions = { byId: {} };
createRoot(document.getElementById('root')).render(React.createElement(MemoryPage, {
  useWorkspaces: select => select(workspaces), useSessions: select => select(sessions), onOpenDreamingSession: id => { window.__openedSession = id }
}));
` }, bundle: true, write: false, platform: 'browser', format: 'iife', define: { 'process.env.NODE_ENV': '"development"' } })
const requests = [], errors = [], checks = []
const server = createServer(async (req, res) => {
  if (req.url === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script src="/app.js"></script>'); return }
  if (req.url === '/app.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(app.outputFiles[0].text); return }
  if (req.url === '/favicon.ico') { res.statusCode = 204; res.end(); return }
  requests.push({ method: req.method, url: req.url })
  await handleAdminRequest(runtime, { method: req.method, url: req.url }, res)
})
await new Promise(done => server.listen(0, '127.0.0.1', done))
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1360, height: 960 } })
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  const panel = page.getByTestId('overview-dreaming')
  const start = panel.getByRole('button', { name: '整理记忆', exact: true })
  await start.waitFor()
  assert.equal(await page.getByTestId('overview-runtime-status').count(), 0)
  await page.getByTestId('overview-workspace-dot').waitFor()
  await page.screenshot({ path: join(output, 'overview.png') })
  await panel.getByRole('button', { name: '读来信', exact: true }).click()
  const letter = page.getByRole('dialog')
  await letter.getByText('总算给目录腾了个地方', { exact: true }).waitFor()
  await page.screenshot({ path: join(output, 'letter-paper.png'), animations: 'disabled' })
  await letter.getByText('修改 1 个事件 · 删除 1 个事件 · 提取 1 条经验').click()
  await letter.getByText('合并到「目录整理入口」。', { exact: true }).waitFor()
  await page.screenshot({ path: join(output, 'letter.png') })
  await letter.getByText('往期来信', { exact: true }).click()
  await letter.getByRole('button', { name: '2026.11.18', exact: true }).click()
  await letter.getByText('把书页摊开', { exact: true }).waitFor()
  await page.keyboard.press('Escape')
  await letter.waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: '短期记忆', exact: true }).click()
  await page.getByText('目录工作记录', { exact: true }).first().waitFor()
  assert.equal(await page.getByText('总算给目录腾了个地方', { exact: true }).count(), 0)
  checks.push('archive renders persisted letters, changes and older dates; daily notes retain independent content')
  await page.getByRole('button', { name: '长期记忆', exact: true }).click()
  await page.getByRole('button', { name: 'AI 会看到的目录' }).click()
  const preview = page.getByRole('dialog', { name: 'AI 会看到的目录' })
  await preview.waitFor()
  const injection = await page.evaluate(async () => (await (await fetch('/api/stratagate/topics?namespace=dreaming-browser')).json()).context)
  assert.equal(await preview.locator('pre').textContent(), injection)
  await page.screenshot({ path: join(output, 'context-desktop.png') })
  await page.keyboard.press('Escape')
  await preview.waitFor({ state: 'hidden' })
  assert.equal(await page.getByRole('button', { name: '整理记忆', exact: true }).count(), 0)
  await page.getByRole('button', { name: '总览', exact: true }).click()
  await start.click()
  await panel.getByText('正在整理', { exact: true }).waitFor()
  assert.equal(await panel.locator('progress').count(), 0)
  await page.screenshot({ path: join(output, 'running-desktop.png') })
  await panel.getByRole('button', { name: '暂停整理', exact: true }).click()
  await panel.getByText('已暂停', { exact: true }).waitFor()
  await panel.getByRole('button', { name: '已暂停', exact: true }).click()
  await page.waitForFunction(() => typeof window.__openedSession === 'string')
  const opened = await page.evaluate(() => window.__openedSession)
  assert.ok(ctx.agents.get(opened))
  assert.equal(opened, (await runtime.adminDreamingStatus(namespace)).run.sessionId)
  await page.screenshot({ path: join(output, 'paused-desktop.png') })
  checks.push('native DSH Agent -> real progress -> pause; open-session returns its real session ID')
  await page.reload()
  await panel.getByText('已暂停', { exact: true }).waitFor()
  await page.setViewportSize({ width: 360, height: 800 })
  assert.equal(await panel.evaluate(element => element.scrollWidth <= element.clientWidth), true)
  await page.screenshot({ path: join(output, 'paused-mobile.png') })
  await panel.getByRole('button', { name: '继续整理', exact: true }).click()
  await start.waitFor()
  assert.equal(await page.locator('dialog[open]').count(), 0)
  assert.equal((await runtime.adminDreamingStatus(namespace)).run.status, 'completed')
  await page.setViewportSize({ width: 1360, height: 960 })
  await page.getByRole('button', { name: '长期记忆', exact: true }).click()
  const section = page.getByRole('button', { name: /沟通与协作/ })
  await section.waitFor()
  if (await section.getAttribute('aria-expanded') === 'false') await section.click()
  await page.locator('.sg-topic-event-title').filter({ hasText: /^保留来源$/ }).waitFor()
  await page.screenshot({ path: join(output, 'directory.png'), animations: 'disabled' })
  await page.setViewportSize({ width: 360, height: 800 })
  checks.push('reload retains checkpoint; resume commits directory; completion refreshes view')
  await page.getByRole('button', { name: '总览', exact: true }).click()
  await start.click()
  await panel.getByRole('button', { name: '终止整理', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: '终止', exact: true }).click()
  await start.waitFor()
  assert.equal(await panel.getByRole('button', { name: '继续整理', exact: true }).count(), 0)
  await page.screenshot({ path: join(output, 'terminated-mobile.png') })
  checks.push('terminate cancels outstanding call and mobile controls fit')
  await page.getByRole('button', { name: '长期记忆', exact: true }).click()
  await page.getByRole('button', { name: 'AI 会看到的目录' }).click()
  await preview.waitFor()
  assert.equal(await preview.evaluate(element => element.scrollWidth <= element.clientWidth), true)
  assert.equal(await preview.locator('pre').textContent(), (await page.evaluate(async () => (await (await fetch('/api/stratagate/topics?namespace=dreaming-browser')).json()).context)))
  await page.screenshot({ path: join(output, 'context-mobile.png') })
  await page.getByRole('button', { name: '关闭目录预览' }).click()
  checks.push('desktop/mobile popup shows exact full injected text; Escape closes; focus returns')
  assert.deepEqual(errors, [])
  console.log(`Dreaming browser checks passed: ${checks.length}`)
} finally {
  writeFileSync(join(output, 'results.json'), JSON.stringify({ browser: browser.version(), database, checks, requests, errors }, null, 2))
  await browser.close(); await runtime.close(); await ctx.fiber.dispose(); await new Promise(done => server.close(done))
}
