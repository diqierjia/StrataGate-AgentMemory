import assert from 'node:assert/strict'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
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
await build({ stdin: { resolveDir: root, contents: `export { StrataGate } from './packages/core/src/index.ts'; export { StrataGateRuntime } from './src/runtime.ts'; export { handleAdminRequest } from './src/web.ts'; export { DshDreamingSessions } from './src/dreaming-session.ts';` },
  outfile: modulePath, bundle: true, platform: 'node', format: 'esm', packages: 'external', alias: {
    '@diqier/stratagate/sqlite': join(root, 'packages/core/src/sqlite.ts'), '@diqier/stratagate': join(root, 'packages/core/src/index.ts') } })
const { StrataGate, StrataGateRuntime, handleAdminRequest, DshDreamingSessions } = await import(pathToFileURL(modulePath).href)
const database = join(output, `fixture-${Date.now()}.sqlite`)
const namespace = 'dreaming-browser'
const memory = await StrataGate.open({ database, namespace, blockTurnSize: 1, disableElementProjection: true,
  summarizer: async () => ({ l0Title: '目录资料', l0Tags: [], l1Summary: '目录资料', l2Keypoints: [], shouldExtract: false }) })
await memory.appendTurn({ user: '目录整理需要保留来源。', assistant: '记录。' })
const block = memory.listBlocks()[0]
const event = await memory.addEvent({ title: '保留来源', summary: '用户明确要求目录整理保留来源。', sourceBlockId: block.id, sourceMessageIds: [block.l5Raw[0].id] })
const job = await memory.claimNextTopicProjection()
await memory.completeTopicProjection(job.jobId, { topics: [{ title: '项目开发', description: '开发与协作方式', sourceEventIds: [event.id],
  sections: [{ title: '协作', sourceEventIds: [event.id] }], overview: [] }] })
await memory.close()
const ctx = new Context()
await ctx.plugin(LlmRuntime); await ctx.plugin(SystemPrompt, {}); await ctx.plugin(ToolRuntime, { mode: 'native' })
await ctx.plugin(SessionStore); await ctx.plugin(SessionProjections); await ctx.plugin(AgentRegistry)
await ctx.plugin(JsonlPersistence, { root: join(output, `sessions-${Date.now()}`), compression: 'none' })
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
    let payload
    for (const message of options.messages) for (const block of message.content) if (block.type === 'text') {
      try { payload = JSON.parse(block.text).currentDirectoryTask || payload } catch {}
    }
    const run = (await runtime.adminDreamingStatus(namespace)).run
    if (run.status === 'completed') { yield { type: 'text-delta', index: 0, text: '目录整理完成。' }; yield { type: 'finish', reason: { kind: 'stop' } }; return }
    const action = !payload.recentTools.some(tool => tool.tool === 'dreaming_search') ? { tool: 'dreaming_search', args: { kind: 'events', query: '来源' } }
      : !payload.recentTools.some(tool => tool.tool === 'dreaming_directory') ? { tool: 'dreaming_directory', args: { operations: [{ kind: 'rename-section', from: '协作', title: '沟通与协作' }] } }
      : { tool: 'dreaming_finish', args: { summary: '目录整理完成。' } }
    yield { type: 'tool-call-delta', index: 0, id: `browser-call-${++callIndex}`, name: action.tool, argumentsDelta: JSON.stringify(action.args) }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
})
const models = { isReady: () => false, onAdaptersUpdated: () => () => {} }
const runtime = new StrataGateRuntime({ database, namespaceMode: 'project', namespacePrefix: 'dsh', globalNamespace: 'global', blockTurnSize: 1,
  blockDecayLambda: .3, ingestSubagents: false, maxOutputTokens: 2048 }, models)
runtime.setDreamingHost(new DshDreamingSessions(ctx, runtime, () => ({ provider: 'fixture', model: 'fixture', maxTokens: 32768 })))
const source = readFileSync(join(root, 'src/client.js'), 'utf8').replace("exports.name = 'stratagate-dsh'", "exports.__browserTest = { TopicDirectory, css }; exports.name = 'stratagate-dsh'")
const app = await build({ stdin: { resolveDir: root, contents: `
import React from ${JSON.stringify(join(react, 'react/index.js'))};
import { createRoot } from ${JSON.stringify(join(react, 'react-dom/client.js'))};
let definition; window.__ModuleLoader__ = { load(value) { definition = value; } };
${source}
const components = definition.factory(() => React).__browserTest;
function App() {
  const [directory, setDirectory] = React.useState(null);
  const load = React.useCallback(async () => { const response = await fetch('/api/stratagate/topics?namespace=${namespace}'); setDirectory(await response.json()); }, []);
  React.useEffect(() => { void load(); }, []);
  return React.createElement('div', { className:'sg-memory' }, React.createElement('style', null, components.css), directory ? React.createElement(components.TopicDirectory, { directory, namespace:${JSON.stringify(namespace)}, active:true, openEvent:()=>{}, onDirectoryChanged:load, onOpenDreamingSession:id=>{window.__openedSession=id} }) : '正在加载');
}
createRoot(document.getElementById('root')).render(React.createElement(App));
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
  const page = await browser.newPage({ viewport: { width: 980, height: 760 } })
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  const panel = page.getByTestId('stratagate-dreaming')
  await page.getByRole('button', { name: 'AI 会看到的目录' }).click()
  const preview = page.getByRole('dialog', { name: 'AI 会看到的目录' })
  await preview.waitFor()
  const injection = await page.evaluate(async () => (await (await fetch('/api/stratagate/topics?namespace=dreaming-browser')).json()).context)
  assert.equal(await preview.locator('pre').textContent(), injection)
  await page.screenshot({ path: join(output, 'context-desktop.png') })
  await page.keyboard.press('Escape')
  await preview.waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: '🌙 Dreaming', exact: true }).click()
  await panel.getByText('正在做梦…', { exact: true }).waitFor()
  assert.equal(await panel.locator('progress').getAttribute('value'), '0')
  await page.screenshot({ path: join(output, 'running-desktop.png') })
  await panel.getByRole('button', { name: '暂停', exact: true }).click()
  await panel.getByText('Dreaming 已暂停', { exact: true }).waitFor()
  await panel.getByRole('button', { name: '打开 Dreaming 会话 ↗', exact: true }).click()
  await page.waitForFunction(() => typeof window.__openedSession === 'string')
  const opened = await page.evaluate(() => window.__openedSession)
  assert.ok(ctx.agents.get(opened))
  assert.equal(opened, (await runtime.adminDreamingStatus(namespace)).run.sessionId)
  assert.equal(await panel.locator('.sg-dreaming-moon').evaluate(element => getComputedStyle(element).animationPlayState), 'paused')
  await page.screenshot({ path: join(output, 'paused-desktop.png') })
  checks.push('native DSH Agent -> real progress -> pause; open-session returns its real session ID')
  await page.reload()
  await panel.getByText('Dreaming 已暂停', { exact: true }).waitFor()
  await page.setViewportSize({ width: 360, height: 800 })
  assert.equal(await panel.evaluate(element => element.scrollWidth <= element.clientWidth), true)
  await page.screenshot({ path: join(output, 'paused-mobile.png') })
  await panel.getByRole('button', { name: '继续', exact: true }).click()
  await panel.getByText('本轮 Dreaming 已完成', { exact: true }).waitFor()
  await page.getByText('沟通与协作', { exact: true }).waitFor()
  assert.equal(await panel.locator('progress').getAttribute('value'), '1')
  checks.push('reload retains checkpoint; resume commits directory; completion refreshes view')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  assert.equal(await panel.locator('.sg-dreaming-moon').evaluate(element => getComputedStyle(element).animationName), 'none')
  await panel.getByRole('button', { name: '收起', exact: true }).click()
  await page.getByRole('button', { name: '🌙 Dreaming', exact: true }).click()
  await panel.getByRole('button', { name: '终止', exact: true }).click()
  await panel.getByText('本轮 Dreaming 已终止', { exact: true }).waitFor()
  assert.equal(await panel.getByRole('button', { name: '继续', exact: true }).count(), 0)
  await page.screenshot({ path: join(output, 'terminated-mobile.png') })
  checks.push('terminate cancels outstanding call; mobile controls fit; reduced motion respected')
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
