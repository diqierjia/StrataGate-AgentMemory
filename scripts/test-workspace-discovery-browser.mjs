import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { build } from 'esbuild'
import { chromium } from 'playwright-core'

const root = resolve('.')
const output = resolve('node_modules/.cache/workspace-discovery-browser/runs')
mkdirSync(output, { recursive: true })
const fixture = mkdtempSync(join(output, 'run-'))
const database = join(fixture, 'memory.db')
const modulePath = join(fixture, 'server.mjs')
await build({ stdin: { resolveDir: root, contents: "export { StrataGate } from './packages/core/src/index.ts'; export { StrataGateRuntime } from './src/runtime.ts'; export { handleAdminRequest } from './src/web.ts'" }, outfile: modulePath, bundle: true, platform: 'node', format: 'esm', packages: 'external', alias: { '@diqier/stratagate/sqlite': join(root, 'packages/core/src/sqlite.ts'), '@diqier/stratagate': join(root, 'packages/core/src/index.ts') } })
const { StrataGate, StrataGateRuntime, handleAdminRequest } = await import(pathToFileURL(modulePath).href)
const models = { isReady: () => false, onAdaptersUpdated: () => () => {}, runDetached: (_id, fn) => fn(), externalMemoryExtractor: async () => ({ candidates: [{ title: '导入的习惯', summary: '喜欢简短回答' }] }), externalMemoryDecider: async () => ({ action: 'ADD', confidence: .99 }) }
const runtime = new StrataGateRuntime({ database, namespaceMode: 'project', namespacePrefix: 'dsh', globalNamespace: 'global', blockTurnSize: 6, blockDecayLambda: .3, ingestSubagents: false, maxOutputTokens: 2048 }, models)
const source = readFileSync(join(root, 'src/client.js'), 'utf8').replace("exports.name = 'stratagate-dsh'", "exports.__browserTest = { MemoryPage }; exports.name = 'stratagate-dsh'")
const react = resolve(process.env.STRATAGATE_TEST_REACT_ROOT || 'node_modules/.cache/workspace-discovery-browser/node_modules')
const app = await build({ stdin: { resolveDir: root, contents: `
import React from ${JSON.stringify(join(react, 'react/index.js'))}; import { createRoot } from ${JSON.stringify(join(react, 'react-dom/client.js'))};
let definition; window.__ModuleLoader__ = { load(value) { definition = value } }; ${source}
const { MemoryPage } = definition.factory(() => React).__browserTest;
function App() { const [items, setItems] = React.useState([]); window.setWorkspaces = setItems; return React.createElement(MemoryPage, { useWorkspaces: select => select({ items }), useSessions: select => select({ byId: {} }) }) }
createRoot(document.getElementById('root')).render(React.createElement(App));
` }, bundle: true, write: false, platform: 'browser', format: 'iife', define: { 'process.env.NODE_ENV': '"development"' } })
const requests = []
const server = createServer(async (req, res) => {
  if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<meta charset="utf-8"><div id="root"></div><script src="/app.js"></script>'); return }
  if (req.url === '/app.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(app.outputFiles[0].text); return }
  if (req.url === '/favicon.ico') { res.statusCode = 204; res.end(); return }
  requests.push(req.url)
  await handleAdminRequest(runtime, req, res)
})
await new Promise(done => server.listen(0, '127.0.0.1', done))
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true })
const key = path => createHash('sha256').update(path).digest('hex').slice(0, 20)
const nsA = 'dsh:project:' + key('c:/first')
const nsB = 'dsh:project:' + key('c:/second')
try {
  const page = await browser.newPage()
  const errors = []; page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(() => { const original = window.setTimeout; window.__fastPoll = true; window.setTimeout = (fn, ms, ...args) => original(fn, ms === 30000 && window.__fastPoll ? 500 : ms, ...args) })
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  await page.waitForFunction(() => typeof window.setWorkspaces === 'function')
  await page.waitForTimeout(1200)
  assert.ok(requests.filter(url => url.startsWith('/api/stratagate/dashboard')).length >= 2, 'empty database must keep polling')
  const memory = await StrataGate.open({ database, namespace: nsA }); await memory.appendTurn({ user: '你好', assistant: '你好' }); await memory.close()
  await page.waitForFunction(ns => document.querySelector('select[aria-label="当前工作区"]')?.value === ns, nsA)
  await page.evaluate(() => { window.__fastPoll = false })
  await page.waitForTimeout(700)
  const before = requests.length
  await page.evaluate(() => window.setWorkspaces([{ path: 'C:\\Second\\', title: '新工作区', sessionIds: [] }]))
  await page.getByRole('option', { name: '新工作区' }).waitFor({ state: 'attached' })
  await page.waitForTimeout(350)
  assert.ok(requests.slice(before).some(url => url.startsWith('/api/stratagate/dashboard')), 'host change triggers dashboard refresh')
  const sessionChange = requests.length
  await page.evaluate(() => window.setWorkspaces([{ path: 'C:\\Second\\', title: '新工作区', sessionIds: ['new-session'] }]))
  await page.waitForTimeout(300)
  assert.ok(requests.slice(sessionChange).some(url => url.startsWith('/api/stratagate/dashboard')), 'session change triggers dashboard refresh')
  const tableCounts = () => {
    const db = new DatabaseSync(database, { readOnly: true })
    try { return Object.fromEntries(['memory_spaces', 'stratagate_dsh_workspaces'].map(table => [table,
      db.prepare('SELECT name FROM sqlite_master WHERE type = ? AND name = ?').get('table', table)
        ? db.prepare('SELECT count(*) AS n FROM ' + table).get().n : 0])) } finally { db.close() }
  }
  const beforeRead = tableCounts()
  await page.getByLabel('当前工作区').selectOption(nsB)
  await page.getByTestId('stratagate-overview').waitFor()
  assert.equal(await page.getByTestId('overview-answer-count').textContent(), '0')
  assert.deepEqual(await runtime.adminNamespaces(), [nsA])
  assert.deepEqual(tableCounts(), beforeRead)
  await page.getByRole('button', { name: '更多', exact: true }).click()
  await page.getByText('新工作区', { exact: true }).last().waitFor()
  await page.getByRole('button', { name: /高级设置/ }).click()
  await page.getByText('新工作区', { exact: true }).last().waitFor()
  const graphNotice = page.getByRole('dialog', { name: '知识图谱默认关闭说明' }); if (await graphNotice.count()) await graphNotice.getByRole('button', { name: '暂时关闭' }).click()
  await page.locator('.sg-back').click()
  await page.getByRole('button', { name: /导入其他 AI 的记忆/ }).click()
  const input = page.getByLabel('外部 AI 记忆 JSON'); await input.waitFor({ state: 'visible' }); await input.fill('{broken')
  assert.deepEqual(await runtime.adminNamespaces(), [nsA])
  assert.deepEqual(tableCounts(), beforeRead)
  await page.getByRole('button', { name: '分析并预览' }).click()
  await page.getByText('导入的习惯', { exact: true }).waitFor({ timeout: 15000 })
  await page.getByRole('button', { name: '确认导入' }).click()
  await page.getByText(/导入完成：新增 1 条记忆/).waitFor({ timeout: 15000 })
  assert.ok((await runtime.adminNamespaces()).includes(nsB))
  assert.deepEqual(errors, [])
  console.log('PASS: empty polling, host refresh, selection without writes, external import')
} finally { await browser.close(); await runtime.close(); await new Promise(done => server.close(done)) }




