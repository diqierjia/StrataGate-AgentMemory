import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'node:http'
import { build } from 'esbuild'
import { chromium } from 'playwright-core'

// Isolated host-settings fixture, real production UI, model bridge and admin
// handler. All model responses are local fixtures; no DSH profile or user data.
const root = resolve('.')
const output = resolve('.artifacts/memory-model-browser')
await mkdir(output, { recursive: true })
const directory = await mkdtemp(join(tmpdir(), 'stratagate-model-settings-'))
await build({ stdin: { resolveDir: root, contents: `export { DshModelBridge } from './src/llm.ts'; export { resolveConfig, resolveMemoryModel } from './src/config.ts'; export { handleAdminRequest } from './src/web.ts'` }, outfile: join(output, 'runtime.mjs'), bundle: true, platform: 'node', format: 'esm', packages: 'external', alias: { '@diqier/stratagate/sqlite': join(root, 'packages/core/src/sqlite.ts'), '@diqier/stratagate': join(root, 'packages/core/src/index.ts') } })
const { DshModelBridge, resolveConfig, resolveMemoryModel, handleAdminRequest } = await import(pathToFileURL(join(output, 'runtime.mjs')).href)
const selectionPath = join(directory, 'settings.json')
let selection
let failSave = false, failCatalog = false, failModels = false
const calls = [], errors = [], checks = [], screenshots = []
const providers = [{ id: 'cheap', name: '便宜快速 API' }, { id: 'other', name: '另一个服务商' }]
const bridge = new DshModelBridge({
  llm: {
    listProviders: () => { if (failCatalog) throw new Error('测试：服务商读取失败'); return providers },
    listModels: async provider => { if (failModels) throw new Error('测试：模型列表读取失败'); return [{ id: provider === 'cheap' ? 'fast' : 'other-fast', name: '轻量快速模型' }] },
    stream: async function* (request) {
      calls.push({ provider: request.provider, model: request.model })
      yield { type: 'tool-call-delta', index: 0, id: 'summary', name: request.tools[0].name, argumentsDelta: JSON.stringify({ l0Title: '测试', l0Tags: [], l1Summary: '隔离模型路由验证', l2Keypoints: [], shouldExtract: false }) }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    },
  },
  agentDefaultModel: { currentSelection: () => ({ provider: 'main-api', model: 'main-model' }) },
  logger: { warn: () => {} },
}, resolveConfig({ database: ':memory:', provider: 'cheap', model: 'fast' }), undefined, () => selection)
const runtime = { adminMemoryModelCatalog: provider => bridge.memoryModelCatalog(provider) }
const client = await readFile('dist/client.js', 'utf8')
const marker = /exports\.name\s*=\s*["']stratagate-dsh["']/
assert(marker.test(client))
const instrumented = client.replace(marker, 'exports.__browserTest = { MemoryModelSettings, SettingsPage, css }, exports.name = "stratagate-dsh"')
const reactRoot = resolve('release-candidates/first-login-browser-fixture/node_modules')
const app = await build({ stdin: { resolveDir: root, contents: `
import React from ${JSON.stringify(join(reactRoot, 'react/index.js'))};
import {createRoot} from ${JSON.stringify(join(reactRoot, 'react-dom/client.js'))};
let definition; window.__ModuleLoader__={load(value){definition=value;}};
${instrumented}
const plugin=definition.factory(name=>{if(name!=='react')throw new Error(name);return React;});
function App(){
  const [snapshot, setSnapshot] = React.useState({value:window.fixtureSettings,writable:!location.search.includes('readonly')});
  const save = async value => {
    const res=await fetch('/fixture/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});
    if(!res.ok)return false;
    const selection=await res.json();setSnapshot(current=>({...current,value:{memoryModel:selection}}));return true;
  };
  return React.createElement('div',{className:'sg-memory'},React.createElement('style',null,plugin.__browserTest.css),location.search.includes('full') ? React.createElement(plugin.__browserTest.SettingsPage,{selected:{blockTurnSize:6,blockDecayLambda:0.3,agentMemoryRetrievalWeight:1,schemaVersion:14,currentTurn:18,workspaceName:'当前工作区'},graphSettings:{enabled:false,noticeSeen:true},namespace:'preview-workspace',onBack:()=>{},setView:()=>{},updateSettings:async()=>true,usePluginSettings:selector=>selector(snapshot),setMemoryModel:save}) : React.createElement(plugin.__browserTest.MemoryModelSettings,{usePluginSettings:selector=>selector(snapshot),setMemoryModel:save}));
}
createRoot(document.getElementById('root')).render(React.createElement(App));
` }, bundle: true, write: false, platform: 'browser', format: 'iife', define: { 'process.env.NODE_ENV': '"development"' } })
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://fixture')
  if (url.pathname === '/') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.end('<!doctype html><meta charset="utf-8"><style>html,body{margin:0}html{--dsw-alias-bg-layer-2:#fff;--dsw-specific-input-major:#fff;--dsw-alias-label-primary:#17191d;--dsw-alias-label-secondary:#666;--dsw-alias-border-l2:#ddd;--dsw-alias-state-business-primary:#4176e6}html.dark{--dsw-alias-bg-layer-2:#1f2023;--dsw-specific-input-major:#26282c;--dsw-alias-label-primary:#eceef1;--dsw-alias-label-secondary:#9a9fa6;--dsw-alias-border-l2:#444;--dsw-alias-state-business-primary:#5b8def}body{background:var(--dsw-alias-bg-layer-2)}#root{width:100%;min-width:0}</style><div id="root"></div><script>window.fixtureSettings=' + JSON.stringify(selection ? { memoryModel: selection } : {}) + '</script><script src="/app.js"></script>')
    return
  }
  if (url.pathname === '/app.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(app.outputFiles[0].text); return }
  if (url.pathname === '/favicon.ico') { res.statusCode = 204; res.end(); return }
  if (url.pathname === '/fixture/settings') {
    let text = ''; for await (const chunk of req) text += chunk
    if (failSave) { res.statusCode = 503; res.end('{}'); return }
    selection = resolveMemoryModel(JSON.parse(text))
    await writeFile(selectionPath, JSON.stringify(selection))
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(selection)); return
  }
  await handleAdminRequest(runtime, req, res)
})
await new Promise(done => server.listen(0, '127.0.0.1', done))
const base = `http://127.0.0.1:${server.address().port}`
const browser = await chromium.launch({ channel: 'msedge', headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 640, height: 900 } })
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(base)
  const auto = page.getByRole('radio', { name: '跟随聊天模型' })
  const custom = page.getByRole('radio', { name: '单独指定模型' })
  const provider = page.getByRole('combobox', { name: '记忆处理服务商', exact: true })
  const model = page.getByRole('combobox', { name: '记忆处理具体模型', exact: true })
  const save = page.getByRole('button', { name: '保存', exact: true })
  await provider.waitFor()
  assert.equal(await custom.isChecked(), true)
  assert.equal(await provider.inputValue(), 'cheap')
  assert.equal(await model.inputValue(), 'fast')
  checks.push('existing provider/model preserved')
  await provider.selectOption('other')
  await model.selectOption('other-fast')
  failSave = true
  await save.click()
  await page.getByRole('alert').filter({ hasText: '当前选择已保留' }).waitFor()
  assert.equal(await model.inputValue(), 'other-fast')
  assert.equal(selection, undefined)
  checks.push('failed save keeps draft and previous configuration')
  failSave = false
  await save.click()
  await page.getByRole('status').filter({ hasText: '已保存，对后续' }).waitFor()
  assert.deepEqual(JSON.parse(await readFile(selectionPath, 'utf8')), { mode: 'custom', provider: 'other', model: 'other-fast' })
  const session = { id: 'main-session', requestHeader: () => ({ config: { provider: 'main-api', model: 'main-model' } }) }
  const summarize = () => bridge.summarizer([{ id: 'source', role: 'user', content: '隔离测试', createdAt: '2026-11-01T00:00:00Z' }])
  await bridge.run(session, summarize)
  assert.deepEqual(calls.at(-1), { provider: 'other', model: 'other-fast' })
  assert.deepEqual(session.requestHeader().config, { provider: 'main-api', model: 'main-model' })
  checks.push('saved custom route used by actual summary request; main route unchanged')
  selection = JSON.parse(await readFile(selectionPath, 'utf8'))
  await page.reload()
  await provider.waitFor()
  assert.equal(await provider.inputValue(), 'other')
  assert.equal(await model.inputValue(), 'other-fast')
  checks.push('saved selection restored on reopen')
  await auto.check()
  assert.equal(await provider.count(), 0)
  await page.getByText('→ 跟随聊天模型', { exact: true }).waitFor()
  assert.deepEqual(selection, { mode: 'custom', provider: 'other', model: 'other-fast' })
  await custom.focus(); await page.keyboard.press('Space')
  assert.equal(await provider.inputValue(), 'other')
  assert.equal(await model.inputValue(), 'other-fast')
  checks.push('mode cards support keyboard, preserve custom draft, keep saved route until save')
  for (const theme of ['light', 'dark']) for (const width of [640, 320]) {
    await page.setViewportSize({ width, height: 900 })
    await page.evaluate(dark => document.documentElement.classList.toggle('dark', dark), theme === 'dark')
    const file = join(output, `${theme}-${width}.png`)
    await page.screenshot({ path: file, fullPage: true })
    const layout = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }))
    assert(layout.scrollWidth <= layout.clientWidth, JSON.stringify({ theme, width, layout }))
    screenshots.push({ theme, width, path: file, ...layout })
  }
  checks.push('light/dark themes at 640px and 320px without horizontal overflow')
  await auto.check(); await save.click()
  await page.getByRole('status').filter({ hasText: '已保存，对后续' }).waitFor()
  await bridge.run(session, summarize)
  assert.deepEqual(calls.at(-1), { provider: 'main-api', model: 'main-model' })
  await bridge.runDetached('worker', summarize)
  assert.deepEqual(calls.at(-1), { provider: 'main-api', model: 'main-model' })
  checks.push('explicit follow mode overrides legacy custom route')
  await page.reload()
  await auto.waitFor()
  assert.equal(await provider.count(), 0)
  checks.push('follow mode opens without waiting for model catalog')
  failCatalog = true
  await custom.check()
  await page.getByRole('alert').filter({ hasText: '读取失败' }).waitFor()
  failCatalog = false
  await page.getByRole('button', { name: '重新读取' }).click()
  await model.selectOption('fast')
  checks.push('custom mode loads catalog on demand and supports retry')
  failModels = true
  await provider.selectOption('other')
  await page.getByRole('alert').filter({ hasText: '读取失败' }).waitFor()
  assert.equal(await provider.inputValue(), 'other')
  failModels = false
  await page.getByRole('button', { name: '重新读取' }).click()
  await model.selectOption('other-fast')
  checks.push('model list failure preserves provider and supports retry')
  await page.goto(base + '/?readonly')
  await auto.waitFor()
  assert.equal(await auto.isDisabled(), true)
  assert.equal(await custom.isDisabled(), true)
  assert.equal(await save.isDisabled(), true)
  checks.push('read-only host disables editing')
  await page.goto(base + '/?full')
  await page.getByRole('heading', { name: '高级设置', exact: true }).waitFor()
  await custom.check()
  await model.selectOption('fast')
  for (const theme of ['light', 'dark']) for (const width of [640, 320]) {
    await page.setViewportSize({ width, height: 900 })
    await page.evaluate(dark => document.documentElement.classList.toggle('dark', dark), theme === 'dark')
    await page.screenshot({ path: join(output, `settings-page-${theme}-${width}.png`), fullPage: true })
    await page.locator('.sg-model-settings').screenshot({ path: join(output, `settings-model-${theme}-${width}.png`) })
    const layout = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }))
    assert(layout.scrollWidth <= layout.clientWidth, JSON.stringify({ theme, width, layout }))
  }
  checks.push('production SettingsPage includes model controls; whole page fits both themes at 640px and 320px')
  assert.deepEqual(errors, [])
  await writeFile(join(output, 'results.json'), JSON.stringify({ checks, screenshots, calls, errors }, null, 2))
  console.log(JSON.stringify({ passed: checks.length, evidence: join(output, 'results.json') }))
} finally {
  await browser.close()
  await new Promise(done => server.close(done))
  await rm(directory, { recursive: true, force: true })
}
