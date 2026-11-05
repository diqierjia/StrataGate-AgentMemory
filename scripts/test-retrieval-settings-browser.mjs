import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'node:http'
import { build } from 'esbuild'
import { chromium } from 'playwright-core'

// Real bundled settings UI, admin routes and SQLite persistence. All provider
// calls go to this loopback fixture; no user profile, data or credentials.
const root = resolve('.')
const output = resolve('.artifacts/retrieval-settings-browser')
await mkdir(output, { recursive: true })
const directory = await mkdtemp(join(tmpdir(), 'stratagate-retrieval-settings-'))
await build({ stdin: { resolveDir: root, contents: `export { StrataGateRuntime } from './src/runtime.ts'; export { resolveConfig } from './src/config.ts'; export { handleAdminRequest } from './src/web.ts'` }, outfile: join(output, 'runtime.mjs'), bundle: true, platform: 'node', format: 'esm', packages: 'external', alias: { '@diqier/stratagate/sqlite': join(root, 'packages/core/src/sqlite.ts'), '@diqier/stratagate': join(root, 'packages/core/src/index.ts') } })
const { StrataGateRuntime, resolveConfig, handleAdminRequest } = await import(pathToFileURL(join(output, 'runtime.mjs')).href)
const database = join(directory, 'memory.db')
const models = { isReady: () => false, onAdaptersUpdated: () => () => {} }
let runtime = new StrataGateRuntime(resolveConfig({ database }), models)
await runtime.syncConfiguredSettings()
let failSave = '', failModels = false, failRefresh = false, slowResolve
const providerCalls = [], patches = [], requestUrls = [], checks = [], errors = []
const client = await readFile('dist/client.js', 'utf8')
const marker = /exports\.name\s*=\s*["']stratagate-dsh["']/
assert(marker.test(client))
const instrumented = client.replace(marker, 'exports.__browserTest = { SettingsPage, MemoryPage, css }, exports.name = "stratagate-dsh"')
const reactRoot = resolve('release-candidates/first-login-browser-fixture/node_modules')
const app = await build({ stdin: { resolveDir: root, contents: `
import React from ${JSON.stringify(join(reactRoot, 'react/index.js'))};
import {createRoot} from ${JSON.stringify(join(reactRoot, 'react-dom/client.js'))};
let definition; window.__ModuleLoader__={load(value){definition=value;}};
${instrumented}
const plugin=definition.factory(name=>{if(name!=='react')throw new Error(name);return React;});
function App(){
  const [settings,setSettings]=React.useState(null);
  const refresh=async()=>{const response=await fetch('/fixture/settings');if(!response.ok)throw new Error('fixture refresh');setSettings(await response.json());};
  React.useEffect(()=>{void refresh();},[]);
  return React.createElement('div',{className:'sg-memory'},React.createElement('style',null,plugin.__browserTest.css),
    location.search.includes('memory') ? React.createElement(plugin.__browserTest.MemoryPage,{usePluginSettings:selector=>selector({value:{memoryModel:{mode:'auto'}},writable:false})}) :
    React.createElement(plugin.__browserTest.SettingsPage,{selected:{blockTurnSize:6,blockDecayLambda:0.3,agentMemoryRetrievalWeight:1,schemaVersion:14,currentTurn:0},graphSettings:{enabled:false,noticeSeen:true},vectorSettings:settings,retrievalSettingsWritable:!location.search.includes('readonly'),onRetrievalSettingsSaved:setSettings,refresh,namespace:'isolated-settings',onBack:()=>{},setView:()=>{},updateSettings:async()=>{},usePluginSettings:selector=>selector({value:{memoryModel:{mode:'auto'}},writable:false})}));
}
createRoot(document.getElementById('root')).render(React.createElement(App));
` }, bundle: true, write: false, platform: 'browser', format: 'iife', define: { 'process.env.NODE_ENV': '"development"' } })
const json = (res, body, status = 200) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)) }
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://fixture')
    requestUrls.push(req.url)
    if (url.pathname === '/') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.end('<!doctype html><meta charset="utf-8"><style>html,body{margin:0}html{--dsw-alias-bg-layer-2:#fff;--dsw-specific-input-major:#fff;--dsw-alias-label-primary:#17191d;--dsw-alias-label-secondary:#666;--dsw-alias-border-l2:#ddd;--dsw-alias-state-business-primary:#4176e6}html.dark{--dsw-alias-bg-layer-2:#1f2023;--dsw-specific-input-major:#26282c;--dsw-alias-label-primary:#eceef1;--dsw-alias-label-secondary:#9a9fa6;--dsw-alias-border-l2:#444;--dsw-alias-state-business-primary:#5b8def}body{background:var(--dsw-alias-bg-layer-2)}#root{width:100%;min-width:0}</style><div id="root"></div><script src="/app.js"></script>')
      return
    }
    if (url.pathname === '/app.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(app.outputFiles[0].text); return }
    if (url.pathname === '/favicon.ico') { res.statusCode = 204; res.end(); return }
    if (url.pathname === '/fixture/settings') { json(res, runtime.adminVectorSettings(), failRefresh ? 503 : 200); return }
    if (url.pathname === '/api/stratagate/overview' && failRefresh) { json(res, {}, 503); return }
    if (url.pathname.endsWith('/models') && url.pathname.startsWith('/provider')) {
      providerCalls.push({ path: url.pathname, authorization: req.headers.authorization })
      if (url.pathname.includes('slow')) await new Promise(done => { slowResolve = done })
      json(res, { data: [{ id: url.pathname.includes('slow') ? 'stale-model' : 'fixture-embedding' }, { id: 'fixture-rerank' }] }, failModels ? 503 : 200)
      return
    }
    if (url.pathname === '/api/stratagate/settings') {
      let body = ''; for await (const chunk of req) body += chunk
      patches.push(JSON.parse(body))
      if (failSave === 'before') { json(res, {}, 503); return }
      const forwarded = { method: req.method, url: req.url, body }
      if (failSave === 'after') {
        await handleAdminRequest(runtime, forwarded, { statusCode: 0, setHeader() {}, end() {} })
        json(res, {}, 503); return
      }
      await handleAdminRequest(runtime, forwarded, res); return
    }
    await handleAdminRequest(runtime, req, res)
  } catch { json(res, { error: 'Local fixture failure' }, 500) }
})
await new Promise(done => server.listen(0, '127.0.0.1', done))
const base = `http://127.0.0.1:${server.address().port}`
const browser = await chromium.launch({ channel: 'msedge', headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 640, height: 1000 } })
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(base)
  const embedding = page.locator('.sg-retrieval-settings[data-kind=embedding]')
  const rerank = page.locator('.sg-retrieval-settings[data-kind=rerank]')
  const field = (panel, suffix) => panel.locator('input[aria-label$="' + suffix + '"]')
  const save = panel => panel.getByRole('button', { name: /^保存.*设置$/ })
  await field(embedding, ' API 地址').waitFor()
  await page.waitForFunction(() => !document.querySelector('[data-kind=embedding] input').disabled)
  assert.equal(await rerank.count(), 1)
  assert.equal(providerCalls.length, 0)
  assert.equal(await page.getByText('跟随聊天模型', { exact: true }).count(), 2)
  checks.push('production advanced settings exposes both panels without contacting a provider; existing memory model UI remains')

  await field(embedding, ' API 地址').fill(base + '/provider-a/v1/')
  await field(embedding, ' API Key').fill('fixture-key-a')
  await field(embedding, '模型名称').fill('manual-model')
  await field(rerank, '模型名称').fill('unsaved-rerank-draft')
  await embedding.getByRole('button', { name: '读取模型列表' }).click()
  await embedding.getByText('已读取模型列表。', { exact: false }).waitFor()
  assert.equal(providerCalls.at(-1).path, '/provider-a/v1/models')
  assert.equal(providerCalls.at(-1).authorization, 'Bearer fixture-key-a')
  assert.equal(runtime.adminVectorSettings().embeddingReady, false)
  assert.equal(await field(embedding, '模型名称').inputValue(), 'manual-model')
  checks.push('model listing uses unsaved address/key in JSON body and keeps manually entered model and saved config')

  failSave = 'before'
  await save(embedding).click()
  await embedding.getByRole('alert').filter({ hasText: '未能确认保存' }).waitFor()
  assert.equal(await field(embedding, ' API Key').inputValue(), 'fixture-key-a')
  assert.equal(runtime.adminVectorSettings().embeddingReady, false)
  failSave = ''; failRefresh = true
  await save(embedding).click()
  await embedding.getByText('配置已保存。', { exact: true }).waitFor()
  assert.equal(runtime.adminVectorSettings().embeddingReady, true)
  assert.equal(runtime.adminVectorSettings().embeddingUrl, base + '/provider-a/v1')
  assert.equal(await field(embedding, ' API Key').inputValue(), '')
  assert.equal(await field(rerank, '模型名称').inputValue(), 'unsaved-rerank-draft')
  checks.push('failed save retains draft; confirmed PATCH updates parent without another read, clears secret input and preserves other panel draft')
  failRefresh = false

  await embedding.getByRole('button', { name: '读取模型列表' }).click()
  await embedding.getByText('已读取模型列表。', { exact: false }).waitFor()
  assert.equal(providerCalls.at(-1).authorization, 'Bearer fixture-key-a')
  await embedding.getByText('检索参数', { exact: true }).click()
  await page.getByRole('spinbutton', { name: '向量检索占比', exact: true }).fill('6')
  assert.equal(await save(embedding).isDisabled(), true)
  await page.getByRole('spinbutton', { name: '向量检索占比', exact: true }).fill('0')
  await save(embedding).click()
  await embedding.getByText('已停用（向量检索占比为 0）', { exact: true }).waitFor()
  assert.equal(Object.hasOwn(patches.at(-1), 'embeddingKey'), false)
  checks.push('saved key reused without echo or overwrite; invalid numeric input blocked and zero weight disables semantic lane')

  await field(rerank, ' API 地址').fill(base + '/provider-b/v1')
  await field(rerank, ' API Key').fill('fixture-key-b')
  await field(rerank, '模型名称').fill('manual-reranker')
  failModels = true
  await rerank.getByRole('button', { name: '读取模型列表' }).click()
  await rerank.getByText('未能读取模型列表，可重试或手动填写模型名称。').waitFor()
  failModels = false
  await save(rerank).click()
  await rerank.getByText('已配置 · manual-reranker', { exact: true }).waitFor()
  assert.equal(runtime.adminVectorSettings().rerankReady, true)
  assert.equal(runtime.adminVectorSettings().vectorWeight, 0)
  checks.push('rerank saves independently with vector retrieval off; manual model works when provider list fails')

  await field(embedding, ' API 地址').fill(base + '/provider-slow/v1')
  await embedding.getByRole('button', { name: '读取模型列表' }).click()
  for (let i = 0; i < 100 && !slowResolve; i++) await new Promise(done => setTimeout(done, 10))
  assert(slowResolve)
  await field(embedding, ' API 地址').fill(base + '/provider-new/v1')
  slowResolve()
  await page.waitForResponse(response => response.url().endsWith('/api/stratagate/models'))
  assert.equal(await embedding.locator('datalist option').count(), 0)
  checks.push('late model response discarded after endpoint draft changes')

  failSave = 'after'
  await field(embedding, '模型名称').fill('saved-response-lost')
  await save(embedding).click()
  await embedding.getByRole('alert').filter({ hasText: '未能确认保存' }).waitFor()
  assert.equal(runtime.adminVectorSettings().embeddingModel, 'saved-response-lost')
  assert.equal(await field(embedding, '模型名称').inputValue(), 'saved-response-lost')
  failSave = ''
  failRefresh = true
  await embedding.getByRole('button', { name: '重新读取配置' }).click()
  await embedding.getByRole('alert').filter({ hasText: '未能读取保存的配置' }).waitFor()
  assert.equal(await field(embedding, '模型名称').inputValue(), 'saved-response-lost')
  failRefresh = false
  await embedding.getByRole('button', { name: '重新读取配置' }).click()
  await embedding.getByText('已重新读取保存的配置；未保存输入已保留。', { exact: true }).waitFor()
  await page.reload()
  await field(embedding, '模型名称').waitFor()
  await page.waitForFunction(() => document.querySelector('[data-kind=embedding] input[aria-label$="模型名称"]').value === 'saved-response-lost')
  assert.equal(await field(embedding, ' API Key').inputValue(), '')
  assert.equal(await field(rerank, '模型名称').inputValue(), 'manual-reranker')
  checks.push('lost save response stays uncertain until readback; reopen restores saved settings without exposing key')

  await runtime.close()
  runtime = new StrataGateRuntime(resolveConfig({ database }), models)
  await runtime.syncConfiguredSettings()
  assert.equal(runtime.adminVectorSettings().embeddingModel, 'saved-response-lost')
  assert.equal(runtime.adminVectorSettings().rerankReady, true)
  checks.push('both configurations survive real runtime restart through isolated SQLite')

  await embedding.getByRole('button', { name: '清除已保存密钥' }).click()
  assert.equal(runtime.adminVectorSettings().embeddingReady, true)
  await embedding.getByRole('button', { name: '撤销密钥修改' }).click()
  assert.equal(await save(embedding).isDisabled(), true)
  await embedding.getByRole('button', { name: '清除已保存密钥' }).click()
  await save(embedding).click()
  await embedding.getByText('配置未完整，暂未启用', { exact: true }).waitFor()
  assert.equal(runtime.adminVectorSettings().embeddingKeyConfigured, false)
  assert.equal(runtime.adminVectorSettings().rerankReady, true)
  await field(rerank, ' API 地址').fill('')
  await save(rerank).click()
  await rerank.getByText('未启用', { exact: true }).waitFor()
  assert.equal(runtime.adminVectorSettings().rerankKeyConfigured, true)
  checks.push('clear-key action can be undone and only applies on save; clearing rerank URL disables it while retaining its key')

  await page.goto(base + '/?readonly')
  await field(embedding, '模型名称').waitFor()
  assert.equal(await field(embedding, '模型名称').isDisabled(), true)
  assert.equal(await save(rerank).isDisabled(), true)
  checks.push('read-only backend settings disable edits and saves')
  await page.goto(base)
  await field(embedding, '模型名称').waitFor()
  for (const theme of ['light', 'dark']) for (const width of [640, 320]) {
    await page.setViewportSize({ width, height: 1000 })
    await page.evaluate(dark => document.documentElement.classList.toggle('dark', dark), theme === 'dark')
    await page.screenshot({ path: join(output, `${theme}-${width}.png`), fullPage: true })
    const layout = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }))
    assert(layout.scrollWidth <= layout.clientWidth, JSON.stringify({ theme, width, layout }))
  }
  checks.push('full settings page fits 640px and 320px in both themes')
  assert(!requestUrls.some(url => /fixture-key|embeddingKey|rerankKey/.test(url)))
  assert.deepEqual(errors, [])
  checks.push('no secrets in request URLs and no browser runtime errors')
  await writeFile(join(output, 'results.json'), JSON.stringify({ checks, errors, providerRequests: providerCalls.length, patchFields: patches.map(patch => Object.keys(patch)), database, screenshots: ['light-640.png', 'light-320.png', 'dark-640.png', 'dark-320.png'] }, null, 2))
  console.log(JSON.stringify({ passed: checks.length, evidence: join(output, 'results.json') }))
} finally {
  slowResolve?.()
  await browser.close()
  await runtime.close()
  await new Promise(done => server.close(done))
}
