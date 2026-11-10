import assert from 'node:assert/strict'
import { readFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'node:http'
import { build } from 'esbuild'
import { chromium } from 'playwright-core'

// Isolated databases, real React/MemoryPage/HTTP/SQLite; no paid model or user data.
const root = resolve('.')
const output = resolve(process.env.STRATAGATE_GRAPH_BROWSER_OUTPUT || '.artifacts/graph-optional/browser')
const viewportWidth = Number(process.env.STRATAGATE_GRAPH_BROWSER_WIDTH || 1280)
const viewportHeight = Number(process.env.STRATAGATE_GRAPH_BROWSER_HEIGHT || 1000)
const mainPanel = process.env.STRATAGATE_GRAPH_BROWSER_SURFACE === 'main'
const settingsPrompt = process.env.STRATAGATE_GRAPH_BROWSER_SURFACE === 'settings'
const dependencies = resolve('release-candidates/first-login-browser-fixture/node_modules')
mkdirSync(output, { recursive: true })
const backend = join(output, 'fixture.mjs')
await build({ stdin: { resolveDir: root, contents: `export { StrataGateRuntime } from './src/runtime.ts'; export { handleAdminRequest } from './src/web.ts'; export { StrataGate } from './packages/core/src/index.ts';` },
  outfile: backend, bundle: true, platform: 'node', format: 'esm', packages: 'external', alias: {
    '@diqier/stratagate/sqlite': join(root, 'packages/core/src/sqlite.ts'), '@diqier/stratagate': join(root, 'packages/core/src/index.ts') } })
const { StrataGateRuntime, handleAdminRequest, StrataGate } = await import(pathToFileURL(backend).href)
const temporary = mkdtempSync(join(tmpdir(), 'stratagate-graph-browser-'))
const createRuntime = database => new StrataGateRuntime({ database, namespaceMode: 'project', namespacePrefix: 'dsh', globalNamespace: 'global',
  blockTurnSize: 1, blockDecayLambda: .3, ingestSubagents: false, maxOutputTokens: 2048 }, { isReady: () => false, onAdaptersUpdated: () => () => {} })
const source = readFileSync(resolve(process.env.STRATAGATE_GRAPH_BROWSER_SOURCE || 'src/client.js'), 'utf8')
  .replace("exports.name = 'stratagate-dsh'", "exports.__browserTest = { MemoryPage, MemoryPanel }; exports.name = 'stratagate-dsh'")
  .replace('exports.name="stratagate-dsh"', 'exports.__browserTest={MemoryPage,MemoryPanel},exports.name="stratagate-dsh"')
const app = await build({ stdin: { resolveDir: root, contents: `
import React from ${JSON.stringify(join(dependencies, 'react/index.js'))};
import { createRoot } from ${JSON.stringify(join(dependencies, 'react-dom/client.js'))};
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots';
let definition; window.__ModuleLoader__ = { load(value) { definition = value; } };
${source}
const plugin = definition.factory(() => React);
const { MemoryPage, MemoryPanel } = plugin.__browserTest;
const workspaces = { items: [] }, sessions = { byId: {} };
const registry = new SlotCore();
registry.register({ name: 'root', children: { 'settings.section': { kind: 'list', scope: 'root' }, main: { kind: 'keyed', scope: 'root' }, 'sidebar.panellist': { kind: 'list', scope: 'root' } } }, () => null);
const settingsListeners = new Set();
let snapshot = { status: 'ready', writable: true, value: { showSidebarEntry: false, ...JSON.parse(localStorage.getItem('stratagate-browser-sidebar-settings') || '{}') } };
const settings = {
  getSnapshot: () => snapshot,
  subscribe: listener => { settingsListeners.add(listener); return () => settingsListeners.delete(listener) },
  set: async (field, value) => {
    if (window.__failSidebarWrite) throw new Error('synthetic transport failure');
    if (window.__refuseSidebarWrite) return false;
    snapshot = { ...snapshot, value: { ...snapshot.value, [field]: value } };
    localStorage.setItem('stratagate-browser-sidebar-settings', JSON.stringify(snapshot.value));
    settingsListeners.forEach(listener => listener());
    return true;
  },
};
const usePluginSettings = select => select(React.useSyncExternalStore(settings.subscribe, settings.getSnapshot));
let activePanelId = ${mainPanel ? "'stratagate-memory'" : 'null'};
const layout = { get activePanelId() { return activePanelId }, selectPanel: id => { activePanelId = id; window.__lastSelectedPanel = id; window.__sidebarChosen = id === 'stratagate-memory' } };
plugin.apply({ get: name => name === 'slots' ? { inject: (_name, callback) => callback(), register: (...args) => registry.register(...args) } : name === 'configForms' ? { get: () => settings } : name === 'layout' ? layout : undefined });
window.__sidebarEntryCount = () => registry.entriesOfSlot('sidebar.panellist').length;
const entry = registry.entriesOfSlot(${mainPanel ? "'main'" : "'settings.section'"})[0];
createRoot(document.getElementById('root')).render(React.createElement(${settingsPrompt ? 'entry.component' : mainPanel ? 'MemoryPanel' : 'MemoryPage'}, { ...entry.inject?.(), usePluginSettings, useWorkspaces: select => select(workspaces), useSessions: select => select(sessions), close: () => { window.__settingsClosed = true } }));
` }, bundle: true, write: false, platform: 'browser', format: 'iife', define: { 'process.env.NODE_ENV': '"development"' } })
let runtime = createRuntime(join(temporary, 'new.sqlite'))
await runtime.adminGraphControl('preview') // first-install policy, before the first ingestion
async function seed(database, legacy) {
  const memory = await StrataGate.open({ database, namespace: 'browser:project', blockTurnSize: 1, graphEnabled: legacy,
    summarizer: async () => ({ l0Title: 'source', l0Tags: [], l1Summary: 'source', l2Keypoints: [], shouldExtract: false }), graphProjector: async () => ({ reason: 'none', nodes: [], edges: [] }) })
  await memory.appendTurn({ user: '测试项目使用 SQLite', assistant: '已记录' })
  const block = memory.listBlocks()[0]
  for (let i = 0; i < (legacy ? 10 : 1); i++) {
    const event = await memory.addEvent({ title: `测试项目 ${i}`, summary: '项目选择 SQLite', sourceBlockId: block.id, sourceMessageIds: [block.l5Raw[0].id] })
    if (legacy && i === 0) {
      const job = await memory.claimNextGraphProjection()
      await memory.completeGraphProjection(job.jobId, { reason: 'retained evidence', nodes: [{ ref: 'project', name: '测试项目', type: 'project', aliases: [], facts: [], sourceEventIds: [event.id], metadataProvenance: { name: [event.id] } }], edges: [] })
    }
  }
  await memory.close()
}
await seed(join(temporary, 'new.sqlite'), false)
const errors = [], checks = [], requests = []
const server = createServer(async (req, res) => {
  if (req.url === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end('<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#15171b;color:#e8e8eb;font:14px system-ui}button,input{font:inherit}' + (mainPanel ? 'html,body{height:100%;overflow:hidden}#root{display:flex;flex-direction:column;height:100%;min-width:0;overflow:hidden}' : '') + '</style><div id="root"></div><script src="/app.js"></script>'); return }
  if (req.url === '/app.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(app.outputFiles[0].text); return }
  if (req.url === '/favicon.ico') { res.statusCode = 204; res.end(); return }
  requests.push({ method: req.method, url: req.url })
  try { await handleAdminRequest(runtime, { method: req.method, url: req.url }, res) }
  catch (error) { errors.push(String(error)); res.statusCode = 500; res.end(JSON.stringify({ error: String(error) })) }
})
await new Promise(done => server.listen(Number(process.env.STRATAGATE_GRAPH_BROWSER_PORT || 0), '127.0.0.1', done))
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true })
const page = await browser.newPage({ viewport: { width: viewportWidth, height: viewportHeight }, colorScheme: 'dark', locale: 'zh-CN' })
page.on('pageerror', error => errors.push(error.message))
page.setDefaultTimeout(10000)
const tab = name => page.locator('.sg-tabs').getByRole('button', { name, exact: true }).click()
const settings = async () => { await tab('更多'); await page.getByRole('button', { name: /高级设置/ }).click() }
const toggle = () => page.getByRole('switch', { name: '启用知识图谱' })
const graphTab = () => page.getByRole('button', { name: '知识图谱', exact: true })
const graphMenu = () => page.getByRole('button', { name: '知识图谱设置' })
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  const sidebarPrompt = page.getByRole('region', { name: 'StrataGate 侧栏入口提示' })
  if (settingsPrompt) {
    await sidebarPrompt.waitFor()
    assert.equal(await page.evaluate(() => window.__sidebarEntryCount()), 0)
    const display = async () => { await tab('更多'); await page.getByRole('button', { name: /界面与显示/ }).click() }
    const sidebarToggle = () => page.getByRole('switch', { name: '在左侧栏显示 StrataGate', exact: true })
    const beforeSidebarWrites = requests.filter(request => request.method !== 'GET').length
    await display()
    assert.equal(await sidebarToggle().getAttribute('aria-checked'), 'false')
    await page.reload(); await sidebarPrompt.waitFor()
    assert.equal(await page.evaluate(() => window.__sidebarEntryCount()), 0)
    assert.equal(await page.locator('.sg-header .sg-brand-copy .sg-sidebar-placement-prompt').count(), 1)
    const placement = await sidebarPrompt.evaluate(prompt => {
      const rect = prompt.getBoundingClientRect(), title = prompt.closest('.sg-brand-copy').querySelector('.sg-brand-title').getBoundingClientRect(), header = prompt.closest('.sg-header').getBoundingClientRect()
      return { belowTitle: rect.top >= title.bottom, insideHeader: rect.left >= header.left && rect.right <= header.right, position: getComputedStyle(prompt).position }
    })
    assert.deepEqual(placement, { belowTitle: true, insideHeader: true, position: 'static' })
    await page.screenshot({ path: join(output, 'settings-header-sidebar-prompt.png'), animations: 'disabled' })
    await sidebarPrompt.getByRole('button', { name: '关闭侧栏入口提示' }).click()
    await page.reload(); assert.equal(await sidebarPrompt.count(), 0)
    assert.equal(await page.evaluate(() => window.__sidebarEntryCount()), 0)
    await page.evaluate(() => localStorage.removeItem('stratagate-dsh.sidebar-prompt.v1'))
    await page.reload(); await sidebarPrompt.waitFor()
    await page.evaluate(() => { window.__refuseSidebarWrite = true })
    await sidebarPrompt.getByRole('button', { name: '放到左侧栏', exact: true }).click()
    await sidebarPrompt.getByRole('alert').waitFor()
    assert.equal(await page.evaluate(() => window.__sidebarEntryCount()), 0)
    assert.equal(await page.evaluate(() => window.__settingsClosed === true), false)
    await page.evaluate(() => { window.__refuseSidebarWrite = false; window.__failSidebarWrite = true })
    await sidebarPrompt.getByRole('button', { name: '放到左侧栏', exact: true }).click()
    await page.getByText('未能保存，请检查连接后重试。', { exact: true }).waitFor()
    assert.equal(await page.evaluate(() => window.__sidebarEntryCount()), 0)
    await page.evaluate(() => { window.__failSidebarWrite = false })
    await sidebarPrompt.getByRole('button', { name: '放到左侧栏', exact: true }).click()
    await page.waitForFunction(() => window.__sidebarEntryCount() === 1 && window.__sidebarChosen && window.__settingsClosed)
    await page.reload(); assert.equal(await sidebarPrompt.count(), 0)
    assert.equal(await page.evaluate(() => window.__sidebarEntryCount()), 1)
    await display()
    await sidebarToggle().click()
    await page.waitForFunction(() => window.__sidebarEntryCount() === 0)
    await sidebarToggle().click()
    await page.waitForFunction(() => window.__sidebarEntryCount() === 1)
    assert.equal(await sidebarPrompt.count(), 0)
    await page.screenshot({ path: join(output, 'settings-sidebar-toggle.png'), animations: 'disabled' })
    assert.equal(requests.filter(request => request.method !== 'GET').length, beforeSidebarWrites)
    checks.push('sidebar preference: fresh install hidden by default with settings reminder; actual slot registry removes/restores entry, persists across reload, suppresses enabled reminder, X persists, failed writes retain prompt, accepted reminder saves before navigation; no backend writes')
  } else {
    assert.equal(await sidebarPrompt.count(), 0)
    checks.push('sidebar prompt absent outside StrataGate settings')
  }
  await tab('长期记忆'); await page.getByRole('navigation', { name: '长期记忆视角' }).waitFor()
  assert.equal(await graphTab().count(), 1)
  await graphTab().click()
  const firstNotice = page.getByRole('dialog', { name: '知识图谱默认关闭说明' }); await firstNotice.waitFor()
  assert.equal(await firstNotice.getByRole('switch', { name: '启用知识图谱' }).getAttribute('aria-checked'), 'false')
  await page.screenshot({ path: join(output, 'new-default-off.png'), fullPage: true, animations: 'disabled' })
  await firstNotice.getByRole('button', { name: '暂时关闭', exact: true }).click()
  await graphTab().waitFor({ state: 'detached' }); await graphMenu().click(); await toggle().waitFor(); assert.equal(await toggle().getAttribute('aria-checked'), 'false')
  await toggle().click(); await page.getByRole('dialog', { name: '确认恢复知识图谱' }).waitFor()
  assert.equal(runtime.graphEnabled, false)
  await page.getByRole('button', { name: '取消', exact: true }).click(); assert.equal(runtime.graphEnabled, false)
  await toggle().click(); await page.getByRole('button', { name: '确认开启并分批处理' }).click()
  await page.waitForFunction(() => document.querySelector('[aria-label="启用知识图谱"]')?.getAttribute('aria-checked') === 'true')
  await tab('长期记忆'); await graphTab().click()
  assert.equal(await page.locator('.sg-long-layout[aria-disabled="false"]').count(), 1)
  checks.push('new user: Graph tab shown initially, one-time choice hides it behind +, plus reopens preview/confirm flow, enabled Graph page')
  await runtime.close()
  const legacyPath = join(temporary, 'legacy.sqlite')
  await seed(legacyPath, true)
  runtime = createRuntime(legacyPath)
  const before = await runtime.adminSnapshot('browser:project')
  await page.reload(); await tab('长期记忆'); await graphTab().click()
  await page.locator('.sg-long-layout[aria-disabled="true"]').waitFor()
  await page.screenshot({ path: join(output, 'legacy-disabled-graph.png'), fullPage: true, animations: 'disabled' })
  const notice = page.getByRole('dialog', { name: '知识图谱默认关闭说明' }); await notice.waitFor()
  for (const phrase of ['事件记录', '主题目录', '额外消耗token', '默认关闭知识图谱功能', '图谱数据会保留', '长期记忆页面', '功能可以正常使用']) assert.ok((await notice.innerText()).includes(phrase))
  await page.screenshot({ path: join(output, 'legacy-once-notice.png'), fullPage: true, animations: 'disabled' })
  await page.getByRole('button', { name: '暂时关闭', exact: true }).click()
  await page.screenshot({ path: join(output, 'legacy-disabled-graph-acknowledged.png'), fullPage: true, animations: 'disabled' })
  await page.reload(); await tab('长期记忆'); assert.equal(await graphTab().count(), 0)
  const tabOrder = await page.locator('.sg-long-tabs').evaluate(nav => [...nav.children].map(node => node.classList.contains('sg-graph-menu') ? 'graph-menu' : node.textContent.trim()))
  assert.deepEqual(tabOrder, ['主题目录', '事件时间线', 'graph-menu'])
  checks.push('hidden Graph state preserves tab order and the trailing plus control')
  const assertPlusCentered = async () => {
    const geometry = await graphMenu().evaluate(button => {
      const icon = button.querySelector('svg').getBoundingClientRect()
      const rect = button.getBoundingClientRect()
      const nav = button.closest('nav').getBoundingClientRect()
      const style = getComputedStyle(button)
      return { dx: Math.abs(icon.x + icon.width / 2 - rect.x - rect.width / 2), dy: Math.abs(icon.y + icon.height / 2 - rect.y - rect.height / 2), navDy: Math.abs(rect.y + rect.height / 2 - nav.y - nav.height / 2), width: rect.width, height: rect.height, padding: style.padding }
    })
    assert.ok(geometry.dx < .5 && geometry.dy < .5 && geometry.navDy < .5, JSON.stringify(geometry))
    assert.equal(geometry.width, 32); assert.equal(geometry.height, 32); assert.equal(geometry.padding, '0px')
  }
  await assertPlusCentered()
  const plusBefore = await graphMenu().boundingBox(); await graphMenu().click(); await page.waitForTimeout(50); const plusAfter = await graphMenu().boundingBox()
  assert.ok(plusBefore && plusAfter)
  assert.ok(Math.abs(plusBefore.x - plusAfter.x) < 0.5 && Math.abs(plusBefore.y - plusAfter.y) < 0.5
    && Math.abs(plusBefore.width - plusAfter.width) < 0.5 && Math.abs(plusBefore.height - plusAfter.height) < 0.5,
  `Graph settings trigger moved or resized: ${JSON.stringify({ plusBefore, plusAfter })}`)
  await assertPlusCentered()
  checks.push('plus SVG stays centered in its 32px button and tab bar before and after opening')
  checks.push('graph settings trigger keeps the same size and position when opened')
  const graphPopover = page.locator('.sg-graph-menu-popover'); await graphPopover.waitFor()
  const popoverVisibility = await graphPopover.evaluate(node => {
    const rect = node.getBoundingClientRect()
    const x = rect.left + Math.min(rect.width / 2, Math.max(1, rect.width - 1))
    const y = rect.top + Math.min(rect.height / 2, Math.max(1, rect.height - 1))
    const top = document.elementFromPoint(x, y)
    const trigger = node.parentElement.querySelector('.sg-graph-menu-trigger').getBoundingClientRect()
    return { visible: rect.width > 0 && rect.height > 0, topInside: top === node || node.contains(top), zIndex: getComputedStyle(node).zIndex,
      tabsZIndex: getComputedStyle(node.closest('.sg-long-tabs')).zIndex, withinViewport: rect.left >= 0 && rect.right <= window.innerWidth,
      centeredOnTrigger: Math.abs((rect.left + rect.width / 2) - (trigger.left + trigger.width / 2)) < 1 }
  })
  assert.deepEqual(popoverVisibility, { visible: true, topInside: true, zIndex: '32', tabsZIndex: '30', withinViewport: true, centeredOnTrigger: true })
  await page.mouse.click(5, page.viewportSize().height - 5)
  await page.waitForFunction(() => !document.querySelector('.sg-graph-menu-popover'))
  checks.push('graph settings popover closes when clicking outside')
  await graphMenu().click(); await graphPopover.waitFor()
  checks.push('graph settings popover stays above the long-memory content layer')
  await page.screenshot({ path: join(output, 'legacy-disabled-graph-no-reminder.png'), fullPage: true, animations: 'disabled' })
  await toggle().click(); const confirmation = page.getByRole('dialog', { name: '确认恢复知识图谱' }); await confirmation.waitFor()
  assert.ok((await confirmation.innerText()).includes('9 条待处理事件'))
  assert.equal(runtime.graphEnabled, false)
  await page.screenshot({ path: join(output, 'legacy-confirm-resume.png'), fullPage: true, animations: 'disabled' })
  await page.getByRole('button', { name: '确认开启并分批处理' }).click()
  await settings(); await page.getByRole('button', { name: '暂停图谱任务', exact: true }).click()
  await page.getByRole('button', { name: '统计并继续图谱任务', exact: true }).waitFor()
  assert.equal(runtime.adminGraphSettings().paused, true)
  await page.getByRole('button', { name: '统计并继续图谱任务', exact: true }).click(); await page.getByRole('dialog', { name: '确认恢复知识图谱' }).waitFor()
  await page.getByRole('button', { name: '取消', exact: true }).click()
  await toggle().click()
  await page.waitForFunction(() => document.querySelector('[aria-label="启用知识图谱"]')?.getAttribute('aria-checked') === 'false')
  assert.deepEqual((await runtime.adminSnapshot('browser:project')).graphNodes, before.graphNodes)
  await runtime.close(); runtime = createRuntime(legacyPath)
  assert.equal(runtime.graphEnabled, false); assert.equal(runtime.adminGraphSettings().noticeSeen, true)
  checks.push('legacy user: one-time choice hides graph behind +, preview before enabling, pause/resume remains in settings, off persists across restart')
  if (mainPanel) {
    await tab('长期记忆')
    await page.getByRole('button', { name: '主题目录', exact: true }).click()
    // Supply long intrinsic directory content without touching persistent data.
    await page.locator('.sg-topic-directory').evaluate(directory => {
      const fixture = document.createElement('div')
      fixture.dataset.testid = 'long-directory-fixture'
      for (let index = 0; index < 60; index++) {
        const row = document.createElement('p')
        row.textContent = `滚动回归目录条目 ${index + 1}`
        fixture.appendChild(row)
      }
      directory.appendChild(fixture)
    })
    const scrollPanel = page.locator('.sg-memory-panel')
    const assertWheelScrolls = async () => {
      await scrollPanel.evaluate(panel => { panel.scrollTop = 0 })
      await page.mouse.move(viewportWidth / 2, viewportHeight / 2)
      await page.mouse.wheel(0, 600)
      await page.waitForFunction(() => document.querySelector('.sg-memory-panel')?.scrollTop > 100)
      const geometry = await scrollPanel.evaluate(panel => ({ height: panel.clientHeight, contentHeight: panel.scrollHeight, overflow: getComputedStyle(panel).overflowY, bodyScrollTop: document.scrollingElement.scrollTop }))
      assert.ok(geometry.height <= viewportHeight && geometry.contentHeight > geometry.height)
      assert.equal(geometry.overflow, 'auto'); assert.equal(geometry.bodyScrollTop, 0)
    }
    await assertWheelScrolls()
    await scrollPanel.evaluate(panel => { panel.scrollTop = 0 })
    await graphMenu().click()
    await page.mouse.click(viewportWidth - 10, viewportHeight / 2)
    await page.waitForFunction(() => !document.querySelector('.sg-graph-menu-popover'))
    await assertWheelScrolls()
    await page.mouse.wheel(0, 10000)
    await page.waitForFunction(() => { const panel = document.querySelector('.sg-memory-panel'); return panel.scrollTop + panel.clientHeight >= panel.scrollHeight - 2 })
    await page.screenshot({ path: join(output, 'main-panel-directory-scrolled.png'), animations: 'disabled' })
    checks.push('bounded DSH main panel: long directory scrolls by wheel to bottom, including after opening and dismissing plus menu')
  }
  assert.deepEqual(errors, [])
  writeFileSync(join(output, 'result.json'), JSON.stringify({ checks, errors, requests, database: temporary }, null, 2))
  console.log(JSON.stringify({ passed: checks, output }, null, 2))
} catch (error) { await page.screenshot({ path: join(output, 'failure.png'), fullPage: true, animations: 'disabled' }); writeFileSync(join(output, 'failure.json'), JSON.stringify({ error: String(error), errors, requests }, null, 2)); throw error }
finally { await browser.close(); await runtime.close(); await new Promise(done => server.close(done)) }
