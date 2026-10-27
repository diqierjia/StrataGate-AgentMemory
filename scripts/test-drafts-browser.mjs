import assert from 'node:assert/strict'
import { readFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'node:http'
import { build } from 'esbuild'
import { chromium } from 'playwright-core'

// Real MemoryPage navigation, HTTP handlers and SQLite. Only a fresh system-temp
// database is opened; no host settings, credentials, model or paid API is used.
const root = resolve('.')
const output = resolve(process.env.STRATAGATE_DRAFT_EVIDENCE || '.artifacts/page-drafts/browser')
const dependencies = resolve(process.env.STRATAGATE_TEST_REACT_ROOT || 'release-candidates/first-login-browser-fixture/node_modules')
mkdirSync(output, { recursive: true })
const backend = join(output, 'fixture.mjs')
await build({ stdin: { resolveDir: root, contents: `export { StrataGateRuntime } from './src/runtime.ts'; export { handleAdminRequest } from './src/web.ts'; export { StrataGate } from './packages/core/src/index.ts'; export { SqliteStorage } from './packages/core/src/sqlite.ts';` },
  outfile: backend, bundle: true, platform: 'node', format: 'esm', packages: 'external', alias: {
    '@diqier/stratagate/sqlite': join(root, 'packages/core/src/sqlite.ts'), '@diqier/stratagate': join(root, 'packages/core/src/index.ts') } })
const { StrataGateRuntime, handleAdminRequest, StrataGate, SqliteStorage } = await import(pathToFileURL(backend).href)
const database = join(mkdtempSync(join(tmpdir(), 'stratagate-page-drafts-')), 'memory.sqlite')
const a = 'browser:draft:a', b = 'browser:draft:b'
for (const namespace of [a, b]) {
  const memory = await StrataGate.open({ database, namespace })
  await memory.appendTurn({ user: '隔离草稿交互验证', assistant: '仅使用示例数据。' })
  await memory.close()
}
const runtime = new StrataGateRuntime({ database, namespaceMode: 'project', namespacePrefix: 'dsh', globalNamespace: 'global',
  blockTurnSize: 6, blockDecayLambda: .3, ingestSubagents: false, maxOutputTokens: 2048 }, { isReady: () => false, onAdaptersUpdated: () => () => {} })
runtime.updatePersistentProfile('preferredLanguage', '中文', 'settings')
const source = readFileSync(join(root, 'src/client.js'), 'utf8')
  .replace("exports.name = 'stratagate-dsh'", "exports.__browserTest = { MemoryPage }; exports.name = 'stratagate-dsh'")
  .replace('__STRATAGATE_MASCOT_DATA_URL__', 'data:image/png;base64,' + readFileSync(join(root, 'docs/assets/stratagate-avatar.png')).toString('base64'))
const app = await build({ stdin: { resolveDir: root, contents: `
import React from ${JSON.stringify(join(dependencies, 'react/index.js'))};
import { createRoot } from ${JSON.stringify(join(dependencies, 'react-dom/client.js'))};
let definition; window.__ModuleLoader__ = { load(value) { definition = value; } };
${source}
const { MemoryPage } = definition.factory(() => React).__browserTest;
const workspaces = { items: [] }, sessions = { byId: {} };
createRoot(document.getElementById('root')).render(React.createElement(MemoryPage, { useWorkspaces: select => select(workspaces), useSessions: select => select(sessions) }));
` }, bundle: true, write: false, platform: 'browser', format: 'iife', define: { 'process.env.NODE_ENV': '"development"' } })
let profileMode = 'normal', importMode = 'normal', holdStatus = false
let releaseWrite = null, releaseImport = null
const pendingStatuses = [], requests = [], checks = [], errors = []
const server = createServer(async (req, res) => {
  if (req.url === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end('<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#15171b;color:#e8e8eb;font:14px system-ui}button,input,textarea{font:inherit}</style><div id="root"></div><script src="/app.js"></script>'); return }
  if (req.url === '/app.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(app.outputFiles[0].text); return }
  if (req.url === '/favicon.ico') { res.statusCode = 204; res.end(); return }
  const url = new URL(req.url, 'http://localhost')
  const entry = { method: req.method, path: url.pathname, namespace: url.searchParams.get('namespace'), operation: url.searchParams.get('operation') }
  requests.push(entry)
  const jsonError = (status, error) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ error })) }
  try {
    const mode = req.method === 'PATCH' ? profileMode : importMode
    if (holdStatus && entry.path.endsWith('/import') && entry.operation === 'status') await new Promise(done => pendingStatuses.push(done))
    let body
    if (['POST', 'PATCH'].includes(req.method)) {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      body = Buffer.concat(chunks).toString('utf8')
      entry.body = JSON.parse(body)
      if (mode === 'fail') { jsonError(503, '隔离注入的保存失败'); return }
      if (mode === 'drop-before') { res.destroy(); return }
      if (mode === 'hold') await new Promise(done => { if (req.method === 'PATCH') releaseWrite = done; else releaseImport = done })
    }
    await handleAdminRequest(runtime, { method: req.method, url: req.url, ...(body === undefined ? {} : { body }) }, {
      get statusCode() { return res.statusCode }, set statusCode(value) { res.statusCode = value },
      setHeader: (name, value) => res.setHeader(name, value),
      end: text => { entry.status = res.statusCode; if (body !== undefined && mode === 'drop-after') res.destroy(); else res.end(text) },
    })
  } catch (error) { errors.push(String(error)); if (!res.destroyed) jsonError(500, String(error)) }
})
await new Promise(done => server.listen(0, '127.0.0.1', done))
const browser = await chromium.launch({ executablePath: process.env.STRATAGATE_TEST_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true })
let page
try {
  page = await browser.newPage({ viewport: { width: 1280, height: 1100 }, colorScheme: 'dark', locale: 'zh-CN' })
  page.setDefaultTimeout(10000)
  page.on('pageerror', error => errors.push(error.message))
  page.on('dialog', dialog => { errors.push('Unexpected dialog: ' + dialog.message()); void dialog.dismiss() })
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  const tab = name => page.locator('.sg-tabs').getByRole('button', { name, exact: true }).click()
  const cycle = async () => { await tab('短期记忆'); await tab('常驻画像') }
  const workspace = namespace => page.getByRole('combobox', { name: '当前工作区' }).selectOption(namespace)
  const language = page.locator('.sg-profile-row').filter({ hasText: '默认回答语言' })
  const reasoning = page.locator('.sg-profile-row').filter({ hasText: '思考过程语言' })
  const editor = row => row.getByRole('textbox')
  const cancel = row => row.getByRole('button', { name: '取消编辑', exact: true }).click()
  const edit = async value => { await language.locator('.sg-profile-value').click(); await editor(language).fill(value) }
  const save = () => language.getByRole('button', { name: '保存', exact: true }).click()
  const unknown = () => language.getByText('暂时无法确认是否已保存，输入内容已保留。', { exact: true }).waitFor()
  const writeCount = () => requests.filter(request => request.method === 'PATCH').length
  const importCount = () => requests.filter(request => request.body?.operation === 'preview').length
  await page.getByRole('combobox', { name: '当前工作区' }).waitFor()
  await workspace(a); await tab('常驻画像'); await language.waitFor()
  await edit('跨页签未保存画像')
  await cycle()
  assert.equal(await editor(language).inputValue(), '跨页签未保存画像')
  await workspace(b)
  assert.equal(await editor(language).inputValue(), '跨页签未保存画像')
  await workspace(a)
  checks.push('profile draft survives actual tab and workspace navigation; installation-wide scope')

  await reasoning.locator('.sg-profile-value').click(); await editor(reasoning).fill('字段独立草稿')
  await language.getByRole('button', { name: '继续编辑', exact: true }).click()
  assert.equal(await editor(language).inputValue(), '跨页签未保存画像')
  await save(); await language.locator('.sg-profile-saved').waitFor()
  await cycle(); assert.equal(await editor(language).count(), 0)
  await reasoning.getByRole('button', { name: '继续编辑', exact: true }).click()
  assert.equal(await editor(reasoning).inputValue(), '字段独立草稿')
  await cancel(reasoning); await cycle()
  await reasoning.locator('.sg-profile-value').click()
  assert.equal(await editor(reasoning).inputValue(), '')
  await cancel(reasoning)
  checks.push('per-field drafts: saving one field preserves another; explicit cancel and confirmed save do not restore old input')

  profileMode = 'fail'; await edit('保存失败仍保留'); await save()
  await language.getByText('修改未保存，输入内容已保留。', { exact: true }).waitFor()
  await cycle()
  assert.equal(await editor(language).inputValue(), '保存失败仍保留')
  await language.getByRole('button', { name: '重新保存', exact: true }).waitFor()
  await page.screenshot({ path: join(output, 'profile-failed-return.png'), fullPage: true, animations: 'disabled' })
  profileMode = 'normal'; await language.getByRole('button', { name: '重新保存', exact: true }).click()
  await language.locator('.sg-profile-saved').waitFor()
  checks.push('definite profile failure retains both input and retry state after leaving and returning')

  profileMode = 'drop-before'; await edit('保存结果未知'); await save(); await unknown(); await cycle(); await unknown()
  assert.equal(await editor(language).inputValue(), '保存结果未知')
  const unknownWrites = writeCount()
  await language.getByRole('button', { name: '检查保存结果', exact: true }).click(); await unknown()
  assert.equal(writeCount(), unknownWrites)
  assert.equal(await language.getByRole('button', { name: '保存', exact: true }).isDisabled(), true)
  runtime.updatePersistentProfile('preferredLanguage', '未知结果期间后台更新', 'agent_tool')
  await language.getByRole('button', { name: '检查保存结果', exact: true }).click()
  await language.getByText('该项刚刚在其他位置更新。').waitFor()
  await language.getByRole('button', { name: '放弃草稿并载入最新内容', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('#sg-profile-preferredLanguage')?.value === '未知结果期间后台更新')
  assert.equal(await language.getByRole('button', { name: '检查保存结果', exact: true }).count(), 0)
  profileMode = 'normal'; await editor(language).fill('显式放弃后新编辑'); await save()
  await language.locator('.sg-profile-saved').waitFor()
  checks.push('unknown profile result survives navigation, blocks repeat save and checks via GET only')

  profileMode = 'drop-after'; await edit('写入成功但响应丢失'); await save(); await unknown()
  await editor(language).fill('响应丢失后继续修改'); await cycle(); await unknown()
  await language.getByRole('button', { name: '检查保存结果', exact: true }).click()
  await language.getByText('上次提交已保存', { exact: true }).waitFor()
  assert.equal(await editor(language).inputValue(), '响应丢失后继续修改')
  profileMode = 'normal'; await save(); await language.locator('.sg-profile-saved').waitFor(); await cycle()
  assert.equal(await editor(language).count(), 0)
  assert.equal(runtime.getPersistentProfile().preferredLanguage, '响应丢失后继续修改')
  checks.push('confirmation of a lost success response clears only the submitted draft and retains newer edits')

  profileMode = 'hold'; await edit('离开时仍在提交'); await save()
  await language.getByRole('button', { name: '保存中…', exact: true }).waitFor()
  await cycle(); await unknown()
  assert.equal(await editor(language).inputValue(), '离开时仍在提交')
  releaseWrite(); releaseWrite = null; profileMode = 'normal'
  await page.waitForTimeout(150); await unknown()
  await language.getByRole('button', { name: '检查保存结果', exact: true }).click()
  await language.locator('.sg-profile-saved').waitFor(); await cycle()
  assert.equal(await editor(language).count(), 0)
  checks.push('navigation aborts pending profile request, restores unknown state and ignores its late response; explicit check confirms SQLite')

  await edit('冲突时保留本地草稿')
  const serverValue = runtime.getPersistentProfile().preferredLanguage
  runtime.updatePersistentProfile('preferredLanguage', '后台更新的新值', 'agent_tool')
  runtime.updatePersistentProfile('preferredLanguage', serverValue, 'agent_tool')
  await cycle()
  await language.getByText('该项刚刚在其他位置更新。').waitFor()
  assert.equal(await editor(language).inputValue(), '冲突时保留本地草稿')
  assert.equal(await language.getByRole('button', { name: '保存', exact: true }).isDisabled(), true)
  await page.screenshot({ path: join(output, 'profile-conflict-return.png'), fullPage: true, animations: 'disabled' })
  await cancel(language)
  await edit('服务端冲突草稿')
  runtime.updatePersistentProfile('preferredLanguage', '服务器最新值', 'agent_tool')
  await save(); await language.getByText('该项刚刚在其他位置更新。').waitFor()
  assert.equal(requests.filter(request => request.method === 'PATCH').at(-1).status, 409)
  await cycle(); assert.equal(await editor(language).inputValue(), '服务端冲突草稿')
  assert.equal(runtime.getPersistentProfile().preferredLanguage, '服务器最新值')
  await cancel(language)
  checks.push('background updates including ABA revisions and actual HTTP 409 cannot overwrite newer server data after draft restoration')

  const openImport = async () => {
    await tab('更多')
    await page.getByRole('button', { name: /导入其他 AI 的记忆/ }).click()
    await page.getByRole('dialog').waitFor()
  }
  const input = page.getByRole('textbox', { name: '外部 AI 记忆 JSON' })
  const close = async kind => {
    if (kind === 'escape') await page.keyboard.press('Escape')
    else if (kind === 'mask') await page.locator('.sg-import-overlay').click({ position: { x: 4, y: 4 } })
    else await page.locator('.sg-import-dialog-head').getByRole('button', { name: '关闭', exact: true }).click()
    await page.getByRole('dialog').waitFor({ state: 'hidden' })
  }
  await workspace(a)
  for (const kind of ['escape', 'button', 'mask']) {
    await openImport(); await input.fill('待分析草稿-' + kind); await close(kind)
    await openImport(); assert.equal(await input.inputValue(), '待分析草稿-' + kind); await close('button')
  }
  assert.equal(importCount(), 0)
  checks.push('import paste survives Esc, X button and overlay click; reopening never starts analysis')
  await workspace(b); await openImport(); await input.fill('工作区 B 草稿'); await close('button')
  await workspace(a); await openImport(); assert.equal(await input.inputValue(), '待分析草稿-mask')
  await page.getByRole('button', { name: '放弃草稿', exact: true }).click(); await close('button')
  await openImport(); assert.equal(await input.inputValue(), ''); await close('button')
  await workspace(b); await openImport(); assert.equal(await input.inputValue(), '工作区 B 草稿')
  await page.screenshot({ path: join(output, 'import-workspace-b.png'), fullPage: true, animations: 'disabled' }); await close('button')
  checks.push('workspace A/B import drafts never mix; explicit discard clears A only')

  await workspace(a); holdStatus = true; await openImport()
  await page.getByText('正在检查已有导入任务…', { exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: '分析并预览', exact: true }).isDisabled(), true)
  holdStatus = false; pendingStatuses.splice(0).forEach(done => done())
  const emptyExport = JSON.stringify({ schemaVersion: 'stratagate.external-memory.v2', sourceType: 'external_ai_memory_export', candidates: [] })
  await input.fill(emptyExport)
  importMode = 'hold'
  await page.getByRole('button', { name: '分析并预览', exact: true }).click()
  await page.getByRole('button', { name: '正在创建任务…', exact: true }).waitFor()
  await close('escape'); await openImport()
  await page.getByText('正在检查已有导入任务…', { exact: true }).waitFor()
  assert.equal(importCount(), 1)
  await close('button'); await workspace(b); await openImport()
  assert.equal(await input.inputValue(), '工作区 B 草稿')
  const createdResponse = page.waitForResponse(response => response.request().method() === 'POST' && response.url().includes('/import'))
  releaseImport(); releaseImport = null; importMode = 'normal'
  await createdResponse
  assert.equal(await input.inputValue(), '工作区 B 草稿')
  assert.equal(await page.getByRole('button', { name: '分析并预览', exact: true }).isEnabled(), true)
  await close('button'); await workspace(a); await openImport()
  await page.getByText('没有发现可导入的长期记忆。', { exact: true }).waitFor()
  const emptyJob = await runtime.adminExternalMemoryStatus(a)
  await close('button'); await openImport()
  await page.getByText('没有发现可导入的长期记忆。', { exact: true }).waitFor()
  assert.equal((await runtime.adminExternalMemoryStatus(a)).jobId, emptyJob.jobId)
  assert.equal(importCount(), 1)
  checks.push('restore waits for status and original pending create; late response from A cannot change B; one real SQLite job restored without duplicate preview')
  await close('button'); await runtime.adminAbandonExternalMemory(a, emptyJob.jobId)

  const readyText = JSON.stringify({ schemaVersion: 'stratagate.external-memory.v2', sourceType: 'external_ai_memory_export', candidates: [{ title: '示例偏好', summary: '隔离测试偏好' }] })
  const pastedText = '\n  ' + readyText + '\n'
  await openImport(); await input.fill(pastedText); await close('button')
  const memory = await StrataGate.open({ database, namespace: a })
  const seeded = await memory.createExternalMemoryImportJob(readyText)
  await memory.processNextExternalMemoryImport(seeded.id, async () => ({ action: 'ADD', confidence: .99 }))
  await memory.close()
  await openImport(); await page.getByRole('button', { name: '确认导入', exact: true }).waitFor()
  assert.equal(await input.isDisabled(), true)
  assert.equal((await runtime.adminExternalMemoryStatus(a)).jobId, seeded.id)
  assert.equal(importCount(), 1)
  importMode = 'fail'; await page.getByRole('button', { name: '确认导入', exact: true }).click()
  await page.getByText('隔离注入的保存失败', { exact: false }).waitFor()
  await close('button'); await openImport()
  assert.equal(await input.inputValue(), pastedText)
  importMode = 'drop-after'; await page.getByRole('button', { name: '确认导入', exact: true }).click()
  await page.locator('.sg-import-error').waitFor()
  await close('button'); importMode = 'normal'; await openImport()
  await page.locator('.sg-import-result').waitFor()
  assert.equal(await input.inputValue(), '')
  assert.equal((await runtime.adminExternalMemoryStatus(a)).status, 'committed')
  const storage = new SqliteStorage({ filename: database })
  assert.equal((await storage.load(a)).snapshot.externalMemoryImportJobs.length, 2)
  await storage.close()
  await page.screenshot({ path: join(output, 'import-committed-restored.png'), fullPage: true, animations: 'disabled' })
  await close('button')
  checks.push('SQLite ready/committed state wins over restored text; failed/unknown commit keeps input until confirmed, then clears it; no duplicate task')

  await openImport(); await page.getByRole('button', { name: '导入另一批', exact: true }).click()
  const normalText = readyText.replace('示例偏好', '另一批示例偏好')
  await input.fill(normalText); await close('button')
  const nextMemory = await StrataGate.open({ database, namespace: a })
  const nextJob = await nextMemory.createExternalMemoryImportJob(normalText)
  await nextMemory.processNextExternalMemoryImport(nextJob.id, async () => ({ action: 'ADD', confidence: .99 }))
  await nextMemory.close()
  await openImport(); await page.getByRole('button', { name: '确认导入', exact: true }).click()
  await page.locator('.sg-import-result').waitFor()
  assert.equal(await input.inputValue(), '')
  await close('button'); await openImport(); await page.locator('.sg-import-result').waitFor()
  assert.equal(await input.inputValue(), '')
  await page.getByRole('button', { name: '导入另一批', exact: true }).click()
  await input.fill(normalText); await close('button'); await openImport()
  await page.locator('.sg-import-result').waitFor()
  assert.equal(await input.inputValue(), normalText, 'Identical newly pasted text is not the already committed draft')
  await page.getByRole('button', { name: '导入另一批', exact: true }).click()
  assert.equal(await input.inputValue(), normalText)
  await page.getByRole('button', { name: '放弃草稿', exact: true }).click(); await close('button')
  checks.push('normal successful import clears only its submitted draft; identical newly pasted input survives old committed status and starting another batch')

  await tab('常驻画像'); await edit('刷新应清空的草稿')
  await page.reload(); await tab('常驻画像'); await language.waitFor()
  assert.equal(await editor(language).count(), 0)
  await workspace(b); await openImport(); assert.equal(await input.inputValue(), '')
  assert.equal(await page.evaluate(() => localStorage.length), 0)
  await close('button')
  checks.push('browser refresh clears page-memory profile/import drafts; no localStorage writes')

  await tab('常驻画像'); await page.clock.install()
  profileMode = 'hold'; await edit('超时草稿'); await save()
  await language.getByRole('button', { name: '保存中…', exact: true }).waitFor()
  await page.clock.fastForward(15100); await unknown(); await cycle(); await unknown()
  assert.equal(await editor(language).inputValue(), '超时草稿')
  await cancel(language); await reasoning.locator('.sg-profile-value').click(); await editor(reasoning).fill('超时后新字段')
  releaseWrite(); releaseWrite = null; profileMode = 'normal'
  await page.waitForTimeout(150)
  assert.equal(await editor(reasoning).inputValue(), '超时后新字段')
  checks.push('15-second timeout, request cancellation and late-response isolation remain intact after restoration')
  assert.deepEqual(errors, [])
  const result = { passed: true, database, node: process.version, browser: browser.version(), checks, requests, errors }
  writeFileSync(join(output, 'result.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify({ passed: true, database, checks, evidence: output }, null, 2))
} catch (error) {
  await page?.screenshot({ path: join(output, 'failure.png'), fullPage: true, animations: 'disabled' })
  writeFileSync(join(output, 'failure.html'), await page?.content() || '')
  writeFileSync(join(output, 'failure.json'), JSON.stringify({ error: String(error), checks, requests, errors }, null, 2))
  throw error
} finally {
  releaseWrite?.(); releaseImport?.(); pendingStatuses.splice(0).forEach(done => done())
  await browser.close(); await runtime.close(); await new Promise(done => server.close(done))
}
