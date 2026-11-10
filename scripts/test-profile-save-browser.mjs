import assert from 'node:assert/strict'
import { readFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'node:http'
import { build } from 'esbuild'
import { chromium } from 'playwright-core'

// Real ProfilePage, HTTP handler and SQLite in a newly-created system-temp directory.
// No host profile, production memory database, model or external service is opened.
const root = resolve('.')
const output = resolve(process.env.STRATAGATE_PROFILE_EVIDENCE || '.artifacts/profile-save-feedback/browser')
const dependencies = resolve(process.env.STRATAGATE_TEST_REACT_ROOT || 'release-candidates/first-login-browser-fixture/node_modules')
mkdirSync(output, { recursive: true })
const backend = join(output, 'fixture.mjs')
await build({ stdin: { resolveDir: root, contents: `export { StrataGateRuntime } from './src/runtime.ts'; export { handleAdminRequest } from './src/web.ts';` },
  outfile: backend, bundle: true, platform: 'node', format: 'esm', packages: 'external', alias: {
    '@diqier/stratagate/sqlite': join(root, 'packages/core/src/sqlite.ts'), '@diqier/stratagate': join(root, 'packages/core/src/index.ts') } })
const { StrataGateRuntime, handleAdminRequest } = await import(pathToFileURL(backend).href)
const database = join(mkdtempSync(join(tmpdir(), 'stratagate-profile-save-')), 'memory.sqlite')
const runtime = new StrataGateRuntime({ database, namespaceMode: 'project', namespacePrefix: 'dsh', globalNamespace: 'global',
  blockTurnSize: 6, blockDecayLambda: .3, ingestSubagents: false, maxOutputTokens: 2048 }, { isReady: () => false, onAdaptersUpdated: () => () => {} })
runtime.updatePersistentProfile('preferredLanguage', '中文', 'settings')
runtime.updatePersistentProfile('responsePreferences', '请简洁回答，保留必要解释。', 'settings')
const source = readFileSync(join(root, 'src/client.js'), 'utf8').replace("exports.name = 'stratagate-dsh'", "exports.__browserTest = { ProfilePage, css }; exports.name = 'stratagate-dsh'")
const app = await build({ stdin: { resolveDir: root, contents: `
import React from ${JSON.stringify(join(dependencies, 'react/index.js'))};
import { createRoot } from ${JSON.stringify(join(dependencies, 'react-dom/client.js'))};
let definition; window.__ModuleLoader__ = { load(value) { definition = value; } };
${source}
const { ProfilePage, css } = definition.factory(() => React).__browserTest;
window.mountProfile = () => { window.profileRoot = createRoot(document.getElementById('root')); window.profileRoot.render(React.createElement('main', { className:'sg-memory', style:{ padding:24, maxWidth:960, margin:'auto' } }, React.createElement('style', null, css), React.createElement(ProfilePage))); };
window.unmountProfile = () => window.profileRoot.unmount();
window.mountProfile();
` }, bundle: true, write: false, platform: 'browser', format: 'iife', define: { 'process.env.NODE_ENV': '"development"' } })
let mode = 'normal', failReads = false, holdReads = false
let releaseWrite = null
const pendingReads = [], requests = [], checks = [], errors = []
const server = createServer(async (req, res) => {
  if (req.url === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end('<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#15171b;color:#e8e8eb;font:14px system-ui}button,input,textarea{font:inherit}</style><div id="root"></div><script src="/app.js"></script>'); return }
  if (req.url === '/app.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(app.outputFiles[0].text); return }
  if (req.url === '/favicon.ico') { res.statusCode = 204; res.end(); return }
  const entry = { method: req.method, url: req.url }
  requests.push(entry)
  const json = (status, error) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ error })) }
  try {
    if (req.method === 'GET') {
      if (failReads) { json(503, '读取暂时不可用'); return }
      if (holdReads) await new Promise(done => pendingReads.push(done))
    }
    const writeMode = mode
    let body
    if (req.method === 'PATCH') {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      body = Buffer.concat(chunks).toString('utf8')
      entry.body = JSON.parse(body)
      if (writeMode === 'fail') { json(503, '保存服务暂时不可用'); return }
      if (writeMode === 'invalid') { json(400, 'preferredLanguage exceeds 100 characters'); return }
      if (writeMode === 'drop-before') { res.destroy(); return }
      if (writeMode === 'hold') await new Promise(done => { releaseWrite = done })
    }
    await handleAdminRequest(runtime, { method: req.method, url: req.url, ...(body === undefined ? {} : { body }) }, {
      get statusCode() { return res.statusCode }, set statusCode(value) { res.statusCode = value },
      setHeader: (name, value) => res.setHeader(name, value),
      end: text => {
        entry.status = res.statusCode
        if (req.method === 'PATCH' && writeMode === 'drop-after') res.destroy()
        else res.end(text)
      },
    })
  } catch (error) { errors.push(String(error)); if (!res.destroyed) json(500, String(error)) }
})
await new Promise(done => server.listen(0, '127.0.0.1', done))
const browser = await chromium.launch({ executablePath: process.env.STRATAGATE_TEST_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1120, height: 1000 }, colorScheme: 'dark', locale: 'zh-CN' })
  page.on('pageerror', error => errors.push(error.message))
  let dialogs = 0
  page.on('dialog', dialog => { dialogs++; void dialog.dismiss() })
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  const row = field => page.locator('.sg-profile-row').filter({ has: page.locator(`#sg-profile-${field}`) })
  const language = page.locator('.sg-profile-row').filter({ hasText: '回答用什么语言' })
  const reasoning = page.locator('.sg-profile-row').filter({ hasText: '思考过程用什么语言' })
  const readCount = () => requests.filter(request => request.method === 'GET').length
  const writeCount = () => requests.filter(request => request.method === 'PATCH').length
  const poll = async () => {
    const before = readCount()
    await page.waitForFunction(() => document.querySelector('.sg-profile-sync')?.textContent === '已同步')
    await page.waitForTimeout(5200)
    assert.ok(readCount() > before, 'Expected an actual background read')
  }
  const edit = async (value) => { await language.getByRole('button', { name: '编辑', exact: true }).click(); await language.getByRole('textbox').fill(value) }
  const cancel = async () => language.getByRole('button', { name: '取消编辑', exact: true }).click()
  const saved = async () => { await language.locator('.sg-profile-saved').waitFor(); assert.equal(await language.getByRole('textbox').count(), 0) }
  const failure = () => language.getByText('修改未保存，输入内容已保留。', { exact: true }).waitFor()
  const unknown = () => language.getByText('暂时无法确认是否已保存，输入内容已保留。', { exact: true }).waitFor()

  await language.locator('.sg-profile-value').waitFor()
  const valuePosition = await language.locator('.sg-profile-value').boundingBox()
  await language.locator('.sg-profile-value').click()
  await language.getByRole('textbox').waitFor()
  assert.equal(await language.locator('.sg-profile-summary > .sg-profile-editor').count(), 1)
  assert.equal(await language.locator('.sg-profile-value').count(), 0, 'Editing replaces the saved value instead of duplicating it below')
  assert.equal(await language.getByRole('textbox').evaluate(input => input === document.activeElement), true)
  const inputPosition = await language.getByRole('textbox').boundingBox()
  assert.ok(Math.abs(inputPosition.x - valuePosition.x) < 1, 'Input must start where the field value was')
  await language.getByRole('textbox').fill('中文，保留专业术语')
  await page.locator('.sg-profile-group').first().screenshot({ path: join(output, 'editing-detail.png') })
  checks.push('clicking the value replaces it with a focused input at the same horizontal position; edit button uses the same editor')
  mode = 'hold'
  const before = writeCount()
  await language.getByRole('button', { name: '保存', exact: true }).click()
  await language.getByRole('button', { name: '保存中…', exact: true }).waitFor()
  assert.equal(await language.getByRole('button', { name: '保存中…', exact: true }).isDisabled(), true)
  await page.waitForFunction(() => document.querySelector('.sg-save-button')?.disabled)
  assert.equal(await language.getByRole('textbox').isDisabled(), true)
  await page.waitForTimeout(100)
  assert.equal(writeCount(), before + 1)
  assert.deepEqual(requests.at(-1).body, { field: 'preferredLanguage', value: '中文，保留专业术语', expectedValue: '中文', expectedRevision: 1 })
  mode = 'normal'; releaseWrite(); releaseWrite = null
  await saved()
  assert.equal(runtime.getPersistentProfile().preferredLanguage, '中文，保留专业术语')
  assert.equal(await page.locator('.sg-profile-saved:focus').count(), 0)
  await page.screenshot({ path: join(output, 'saved.png'), fullPage: true })
  await language.locator('.sg-profile-saved').waitFor({ state: 'hidden', timeout: 3500 })
  checks.push('normal save: captured request, one PATCH, real SQLite updated, inline saved ~2s, no focus transfer')

  mode = 'fail'
  await edit('优先用中文解释，保留我的输入')
  await language.getByRole('button', { name: '保存', exact: true }).click()
  await failure()
  assert.equal(await row('preferredLanguage').getByRole('textbox').inputValue(), '优先用中文解释，保留我的输入')
  assert.equal(await language.locator('.sg-profile-editor .sg-profile-save-feedback').count(), 1)
  await page.screenshot({ path: join(output, 'failed.png'), fullPage: true })
  await page.locator('.sg-profile-group').first().screenshot({ path: join(output, 'failed-detail.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: join(output, 'failed-mobile.png'), fullPage: true })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await page.setViewportSize({ width: 1120, height: 1000 })
  await poll(); await failure()
  mode = 'normal'
  await language.getByRole('button', { name: '重新保存', exact: true }).click()
  await saved()
  assert.equal(runtime.getPersistentProfile().preferredLanguage, '优先用中文解释，保留我的输入')
  assert.equal(await language.locator('.sg-profile-save-feedback').count(), 0)
  checks.push('definite failure retains input and field-local error across successful background poll; retry persists and clears error')

  mode = 'invalid'
  await edit('需要修正的输入')
  await language.getByRole('button', { name: '保存', exact: true }).click()
  await failure()
  await language.getByText('此字段不能超过 100 个字符，请缩短内容。', { exact: true }).waitFor()
  assert.equal(await language.getByRole('button', { name: '重新保存', exact: true }).count(), 0)
  await cancel()
  assert.equal(await language.locator('.sg-profile-save-feedback').count(), 0)
  checks.push('validation error shows specific correction; cancel clears save error')

  mode = 'normal'; failReads = true
  await edit('成功保存后模拟读取故障')
  await language.getByRole('button', { name: '保存', exact: true }).click()
  await saved()
  await language.getByText('修改已保存，暂时无法读取最新内容。', { exact: true }).waitFor()
  assert.equal(runtime.getPersistentProfile().preferredLanguage, '成功保存后模拟读取故障')
  await page.waitForTimeout(2200)
  await language.getByText('修改已保存，暂时无法读取最新内容。', { exact: true }).waitFor()
  assert.equal(await language.getByRole('button', { name: '重新保存', exact: true }).count(), 0)
  await page.screenshot({ path: join(output, 'saved-read-failed.png'), fullPage: true })
  failReads = false
  const writesBeforeRead = writeCount()
  await language.getByRole('button', { name: '重新读取', exact: true }).click()
  await language.getByText('修改已保存，暂时无法读取最新内容。', { exact: true }).waitFor({ state: 'hidden' })
  assert.equal(writeCount(), writesBeforeRead)
  checks.push('confirmed save survives follow-up read failure and 2s timer; reread performs no PATCH')

  mode = 'drop-before'
  await edit('连接中断时的草稿')
  await language.getByRole('button', { name: '保存', exact: true }).click()
  await unknown()
  const writesBeforeCheck = writeCount()
  await poll(); await unknown()
  await language.getByRole('button', { name: '检查保存结果', exact: true }).click()
  await language.getByRole('button', { name: '检查保存结果', exact: true }).waitFor()
  await unknown()
  assert.equal(writeCount(), writesBeforeCheck)
  assert.equal(await language.getByRole('textbox').inputValue(), '连接中断时的草稿')
  assert.equal(runtime.getPersistentProfile().preferredLanguage, '成功保存后模拟读取故障')
  await page.screenshot({ path: join(output, 'unknown.png'), fullPage: true })
  await cancel()
  checks.push('connection loss before write stays unknown after polling/check; input retained, no automatic retry')

  mode = 'drop-after'
  await edit('连接中断但已经写入')
  await language.getByRole('button', { name: '保存', exact: true }).click()
  await unknown()
  const written = writeCount()
  await language.getByRole('textbox').fill('检查期间继续修改的草稿')
  await language.getByRole('button', { name: '检查保存结果', exact: true }).click()
  await language.locator('.sg-profile-saved').waitFor()
  assert.equal(await language.locator('.sg-profile-saved').textContent(), '上次提交已保存')
  assert.equal(await language.getByRole('textbox').inputValue(), '检查期间继续修改的草稿')
  assert.equal(runtime.getPersistentProfile().preferredLanguage, '连接中断但已经写入')
  assert.equal(writeCount(), written)
  mode = 'normal'
  await language.getByRole('button', { name: '保存', exact: true }).click(); await saved()
  assert.equal(runtime.getPersistentProfile().preferredLanguage, '检查期间继续修改的草稿')
  checks.push('lost success response: explicit GET confirms persisted value/revision, retains newer draft, next save uses confirmed revision')

  mode = 'drop-before'
  await edit('未确认期间出现冲突')
  await language.getByRole('button', { name: '保存', exact: true }).click(); await unknown()
  runtime.updatePersistentProfile('preferredLanguage', '另一位置的更新', 'agent_tool')
  await language.getByRole('button', { name: '检查保存结果', exact: true }).click()
  await language.getByText('该项刚刚在其他位置更新。').waitFor()
  assert.equal(await language.getByRole('textbox').inputValue(), '未确认期间出现冲突')
  assert.equal(await language.getByRole('button', { name: '保存', exact: true }).isDisabled(), true)
  await cancel()
  mode = 'normal'
  await edit('服务端版本冲突')
  runtime.updatePersistentProfile('preferredLanguage', '服务器的新内容', 'agent_tool')
  await language.getByRole('button', { name: '保存', exact: true }).click()
  await language.getByText('该项刚刚在其他位置更新。').waitFor()
  assert.equal(requests.filter(request => request.method === 'PATCH').at(-1).status, 409)
  assert.equal(runtime.getPersistentProfile().preferredLanguage, '服务器的新内容')
  await language.getByRole('button', { name: '放弃草稿并载入最新内容', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('#sg-profile-preferredLanguage')?.value === '服务器的新内容')
  await cancel()
  checks.push('unknown check and real HTTP 409 retain drafts and existing conflict/reload protection')

  mode = 'drop-after'
  await edit('旧编辑会话')
  await language.getByRole('button', { name: '保存', exact: true }).click(); await unknown()
  holdReads = true
  await language.getByRole('button', { name: '检查保存结果', exact: true }).click()
  await language.getByRole('button', { name: '检查中…', exact: true }).waitFor()
  await cancel()
  await reasoning.getByRole('button', { name: '添加', exact: true }).click()
  await reasoning.getByRole('textbox').fill('新字段草稿')
  holdReads = false; pendingReads.splice(0).forEach(done => done())
  await page.waitForTimeout(150)
  assert.equal(await reasoning.getByRole('textbox').inputValue(), '新字段草稿')
  assert.equal(await reasoning.locator('.sg-profile-save-feedback, .sg-profile-saved').count(), 0)
  await reasoning.getByRole('button', { name: '取消编辑', exact: true }).click()
  checks.push('late manual read after cancel/switch cannot touch new editor or feedback')

  mode = 'normal'
  await edit('旧成功计时器')
  await language.getByRole('button', { name: '保存', exact: true }).click(); await saved()
  mode = 'fail'
  await edit('新编辑的错误')
  await language.getByRole('button', { name: '保存', exact: true }).click(); await failure()
  await page.waitForTimeout(2200); await failure()
  await cancel()
  checks.push('old success timer cannot clear later save error in the same field')

  await page.clock.install()
  mode = 'hold'
  await edit('超时请求')
  await language.getByRole('button', { name: '保存', exact: true }).click()
  await language.getByRole('button', { name: '保存中…', exact: true }).waitFor()
  await page.clock.fastForward(15100); await unknown()
  await cancel()
  await reasoning.getByRole('button', { name: '添加', exact: true }).click()
  await reasoning.getByRole('textbox').fill('超时后新字段草稿')
  releaseWrite(); releaseWrite = null
  await page.waitForTimeout(150)
  assert.equal(await reasoning.getByRole('textbox').inputValue(), '超时后新字段草稿')
  assert.equal(await reasoning.locator('.sg-profile-save-feedback, .sg-profile-saved').count(), 0)
  checks.push('15s timeout is unknown; late response cannot alter the next field')
  await reasoning.getByRole('button', { name: '取消编辑', exact: true }).click()
  mode = 'hold'
  await edit('离开页面时的请求')
  await language.getByRole('button', { name: '保存', exact: true }).click()
  await language.getByRole('button', { name: '保存中…', exact: true }).waitFor()
  await page.evaluate(() => window.unmountProfile())
  releaseWrite(); releaseWrite = null
  await page.clock.fastForward(20000)
  const departed = readCount()
  await page.clock.fastForward(20000)
  assert.equal(readCount(), departed)
  mode = 'normal'
  await page.evaluate(() => window.mountProfile())
  await language.waitFor()
  await unknown()
  assert.equal(await language.getByRole('textbox').inputValue(), '离开页面时的请求')
  await language.getByRole('button', { name: '检查保存结果', exact: true }).click()
  await saved()
  assert.equal(dialogs, 0)
  assert.deepEqual(errors, [])
  checks.push('unmount aborts requests and timers; remount retains unknown draft until explicit result check; no modal dialogs')
  const result = { passed: true, database, node: process.version, browser: browser.version(), checks, requests, screenshots: ['editing-detail.png', 'saved.png', 'failed.png', 'failed-detail.png', 'failed-mobile.png', 'saved-read-failed.png', 'unknown.png'] }
  writeFileSync(join(output, 'result.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify({ passed: true, checks, database, evidence: output }, null, 2))
} finally {
  releaseWrite?.(); pendingReads.splice(0).forEach(done => done())
  await browser.close(); await runtime.close(); await new Promise(done => server.close(done))
}
