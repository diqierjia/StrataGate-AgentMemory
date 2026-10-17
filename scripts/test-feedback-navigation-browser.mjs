// Real React click propagation and the installed DSH settings shell, using
// synthetic dashboard/draft responses. No live profile, database or model calls.
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { build } from 'esbuild'
import { chromium, _electron } from 'playwright-core'

const root = fileURLToPath(new URL('../', import.meta.url))
const desktop = process.env.STRATAGATE_NAVIGATION_SURFACE === 'desktop'
const primitivePath = join(root, 'node_modules/@deepseek-ai/dsh-client-ui-primitives/lib/index.js')
const hostVersion = JSON.parse(await readFile(join(root, 'node_modules/@deepseek-ai/dsh-client-ui-settings-general/package.json'), 'utf8')).version
const hostSource = (await readFile(join(root, 'node_modules/@deepseek-ai/dsh-client-ui-settings-general/lib/client.js'), 'utf8'))
  .replace('exports.SettingsDocumentStore =', 'exports.__review = { SettingsRoot, createSettingsShellStore }; exports.SettingsDocumentStore =')
const exposeClient = source => {
  const exposed = source.replace(/exports\.name\s*=\s*['"]stratagate-dsh['"]/, "exports.__review = { installFeedbackLinkNavigation, FeedbackSettingsPage: typeof FeedbackSettingsPage === 'function' ? FeedbackSettingsPage : MemoryPage }, exports.name = 'stratagate-dsh'")
  assert.notEqual(exposed, source, 'Client review export marker was not found')
  return exposed
}
const clientPath = process.env.STRATAGATE_NAVIGATION_CLIENT_SOURCE || join(root, 'src/client.js')
const clientSource = exposeClient(await readFile(clientPath, 'utf8'))
const baselineSource = process.env.STRATAGATE_NAVIGATION_BASELINE_SOURCE
  ? exposeClient(await readFile(process.env.STRATAGATE_NAVIGATION_BASELINE_SOURCE, 'utf8')) : null
const bootstrap = `
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import * as ReactDOM from 'react-dom';
import * as JSX from 'react/jsx-runtime';
import * as Primitives from 'review-primitives';
import * as Store from '@deepseek-ai/dsh-client-store';
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots';
window.reviewModules = { React, createRoot, ReactDOM, JSX, Primitives, Store, SlotCore };
`
const bundle = await build({ stdin: { contents: bootstrap, resolveDir: root }, bundle: true, write: false, platform: 'browser', format: 'iife', nodePaths: process.env.STRATAGATE_BROWSER_NODE_MODULES ? [process.env.STRATAGATE_BROWSER_NODE_MODULES] : [], plugins: [{
  name: 'review-primitives', setup(builder) {
    builder.onResolve({ filter: /\.css$/ }, args => ({ path: args.path, namespace: 'empty-css' }))
    builder.onLoad({ filter: /.*/, namespace: 'empty-css' }, () => ({ contents: 'export default {};', loader: 'js' }))
    builder.onResolve({ filter: /^review-primitives$/ }, () => ({ path: primitivePath, namespace: 'review' }))
    builder.onLoad({ filter: /.*/, namespace: 'review' }, async () => ({ contents: await readFile(primitivePath, 'utf8') + '\nexport { MarkdownAnchor };', resolveDir: join(root, 'node_modules/@deepseek-ai/dsh-client-ui-primitives/lib'), loader: 'js' }))
  },
}] })
const server = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<html><head></head><body><div id="root"></div></body></html>') })
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const backendOrigin = 'http://127.0.0.1:' + server.address().port
const otherFeedback = 'http://127.0.0.1:1/?settings=stratagate-memory&stratagateView=feedback&namespace=dsh%3Aproject%3Aother'
const directory = await mkdtemp(join(tmpdir(), 'stratagate-navigation-electron-'))
const mainPath = join(directory, 'main.cjs')
const preload = join(directory, 'preload.cjs')
if (desktop) {
  await writeFile(preload, `const { contextBridge, ipcRenderer } = require('electron'); contextBridge.exposeInMainWorld('dshDesktopBoot', { ready: () => ipcRenderer.invoke('fixture-boot') });`)
  await writeFile(mainPath, `
const { app, BrowserWindow, protocol, ipcMain } = require('electron');
process.on('uncaughtException', error => { console.error(error); app.exit(1); });
const userData = ${JSON.stringify(join(directory, 'user-data'))};
require('node:fs').mkdirSync(userData, { recursive: true });
app.setPath('userData', userData);
protocol.registerSchemesAsPrivileged([{ scheme: 'dsh-app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
app.whenReady().then(async () => {
  protocol.handle('dsh-app', () => new Response('<html><head></head><body><div id="root"></div></body></html>', { headers: { 'content-type': 'text/html' } }));
  ipcMain.handle('fixture-boot', () => ({ streamBaseUrl: ${JSON.stringify(backendOrigin)} }));
  const window = new BrowserWindow({ show: false, webPreferences: { preload: ${JSON.stringify(preload)}, contextIsolation: true, nodeIntegration: false } });
  await window.loadURL('dsh-app://app/');
}).catch(error => { console.error(error); app.exit(1); });
`)
}
const browser = desktop ? null : await chromium.launch({ executablePath: process.env.STRATAGATE_BROWSER_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true })
let desktopApp
const electronEnv = { ...process.env }
delete electronEnv.ELECTRON_RUN_AS_NODE
try {
  for (const patched of baselineSource ? [false, true] : [true]) {
    if (desktop) desktopApp = await _electron.launch({ executablePath: process.env.STRATAGATE_BROWSER_ELECTRON || join(root, 'release-candidates/feedback-desktop-test-deps/node_modules/electron/dist/electron.exe'), args: [mainPath], env: electronEnv })
    const page = desktop ? await desktopApp.firstWindow() : await browser.newPage()
    page.setDefaultTimeout(10_000)
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    if (desktop) await page.waitForURL('dsh-app://app/', { waitUntil: 'load' })
    else await page.goto(backendOrigin)
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    await page.evaluate(() => { window.__ModuleLoader__ = { load: definition => { window.reviewDefinition = definition } } })
    await page.addScriptTag({ content: hostSource })
    await page.evaluate(() => {
      const m = window.reviewModules
      window.reviewHost = window.reviewDefinition.factory(name => ({ react: m.React, 'react-dom': m.ReactDOM, 'react/jsx-runtime': m.JSX, '@deepseek-ai/dsh-client-ui-primitives': m.Primitives, '@deepseek-ai/dsh-client-store': m.Store, '@deepseek-ai/dsh-client-ui-slots': {} })[name]).__review
    })
    // Export-only instrumentation; a supplied baseline remains otherwise exact.
    await page.addScriptTag({ content: patched ? clientSource : baselineSource })
    await page.evaluate(({ backendOrigin, otherFeedback }) => {
      const { React: R, createRoot, Primitives: P } = window.reviewModules
      const h = R.createElement
      const plugin = window.reviewDefinition.factory(() => R)
      const { SettingsRoot, createSettingsShellStore } = window.reviewHost
      const instance = createSettingsShellStore().create()
      const sharedHandle = { create: () => instance }
      window.review = { browserLinks: [], httpNavigations: [], dashboards: [], instance }
      const registry = new window.reviewModules.SlotCore()
      registry.register({ name: 'root', children: { 'sidebar.settings': { kind: 'single', scope: 'root' } } }, () => null)
      registry.register({ name: 'sidebar.settings', store: sharedHandle, children: { 'settings.section': { kind: 'list', scope: 'root' } } }, SettingsRoot)
      const slots = { entries: name => registry.entries(name), inject: (_name, register) => register(), register: (...args) => registry.register(...args) }
      const ctx = { get: name => name === 'slots' ? slots : undefined }
      plugin.apply(ctx)
      const spaces = ['A', 'B'].map(n => ({ namespace: 'dsh:project:' + n, blockCount: 0, eventCount: 0, memoryUseCount: 0 }))
      window.fetch = async url => {
        const parsed = new URL(url, location.href)
        const namespace = parsed.searchParams.get('namespace') || spaces[0].namespace
        let value
        if (parsed.pathname.endsWith('/dashboard')) {
          window.review.dashboards.push(namespace)
          value = { namespace, overview: { pluginVersion: 'fixture', namespaces: spaces }, data: { blocks: [], events: [], graph: { nodes: [], edges: [] }, conversations: [], audit: [] } }
        } else if (parsed.pathname.endsWith('/feedback')) value = { draft: { title: 'Draft ' + namespace, description: 'Synthetic feedback', reproduction: [], aiPrepared: true, updatedAt: new Date().toISOString() } }
        else value = {}
        return { ok: true, status: 200, headers: new Headers(), json: async () => value }
      }
      const rows = [{ id: 'stratagate-memory', label: 'StrataGate-AgentMemory' }]
      const sessions = { phase: 'ready', byId: { fixture: { blank: false, retainedBy: { mainView: 1 } } } }
      const workspaces = { items: [] }
      const update = { phase: 'idle' }
      const empty = []
      const renderSlot = (name, props) => {
        if (name === 'settings.header') return '设置'
        if (name === 'settings.close') return '关闭'
        if (name === 'settings.section') {
          const entry = registry.entries(name).find(entry => entry.options.id === 'stratagate-memory')
          return h(entry.component, { ...props, ...entry.inject?.(), useWorkspaces: select => select(workspaces), useSessions: select => select(sessions) })
        }
        return null
      }
      const labels = { code: {}, footnotes: '注释' }
      const markdown = ['A', 'B'].map(n => '[打开草稿 ' + n + '](' + backendOrigin + '/?settings=stratagate-memory&stratagateView=feedback&namespace=dsh%3Aproject%3A' + n + ')').join('\n\n') + '\n\n[普通外链](https://example.com/)\n\n[其他实例反馈](' + otherFeedback + ')'
      function App() {
        const store = R.useSyncExternalStore(instance.subscribe, instance.getSnapshot)
        return h(R.Fragment, null,
          h(P.MarkdownDelegateProvider, { openExternalLink: url => window.review.browserLinks.push(url) },
            h(P.MarkdownText, { text: markdown, labels })),
          h(SettingsRoot, { wide: true, useStore: select => select(store), actions: instance.actions, useShortcuts: select => select(empty), useSections: select => select(rows), useOnboardingSteps: select => select(empty), useSessions: select => select(sessions), useDesktopUpdate: select => select(update), useConnectionState: select => select('connected'), renderSlot, t: key => key }))
      }
      createRoot(document.getElementById('root')).render(h(App))
    }, { backendOrigin, otherFeedback })
    await page.getByRole('link', { name: '打开草稿 A', exact: true }).click()
    if (!patched) {
      assert.equal(await page.evaluate(() => window.review.browserLinks.length), 1)
      assert.equal(await page.getByRole('dialog').count(), 0)
    } else {
      await page.getByRole('dialog').waitFor()
      await page.waitForFunction(() => document.body.textContent.includes('Draft dsh:project:A'), undefined, { timeout: 10_000 })
      if (process.env.STRATAGATE_NAVIGATION_SCREENSHOT) await page.screenshot({ path: process.env.STRATAGATE_NAVIGATION_SCREENSHOT })
      assert.equal(await page.evaluate(() => window.review.browserLinks.length), 0)
      assert.equal(await page.evaluate(() => window.review.httpNavigations.length), 0)
      // Dispatch another chat-link activation while settings remains mounted.
      await page.evaluate(() => [...document.querySelectorAll('a')].find(a => a.href.includes('namespace=dsh%3Aproject%3AB')).click())
      await page.waitForFunction(() => document.body.textContent.includes('Draft dsh:project:B'))
      assert.equal(await page.locator('.sg-project-select').inputValue(), 'dsh:project:B')
      assert.equal(await page.evaluate(() => window.review.dashboards.filter(n => n === 'dsh:project:B').length), 1)
      // Close, then open A: exercises unmount/remount and pending route handoff.
      await page.getByRole('button', { name: '关闭', exact: true }).click()
      await page.getByRole('link', { name: '打开草稿 A', exact: true }).click()
      await page.waitForFunction(() => document.body.textContent.includes('Draft dsh:project:A'))
      await page.getByRole('button', { name: '关闭', exact: true }).click()
      await page.getByRole('link', { name: '其他实例反馈', exact: true }).click()
      await page.getByRole('link', { name: '普通外链', exact: true }).click()
      assert.deepEqual(await page.evaluate(() => window.review.browserLinks), [otherFeedback, 'https://example.com/'])
      assert.equal(await page.evaluate(() => window.review.httpNavigations.length), 0)
    }
    assert.deepEqual(errors, [])
    assert.equal(page.url(), desktop ? 'dsh-app://app/' : backendOrigin + '/')
    await page.close()
    if (desktopApp) { await desktopApp.close(); desktopApp = null }
  }
  const result = { hostVersion, clientPath, surface: desktop ? 'Electron 44 with dsh-app://app/ and HTTP backend' : 'Chromium same-origin Web', backendOrigin, passed: true, originalBugReproduced: baselineSource ? true : null, baselineSource: process.env.STRATAGATE_NAVIGATION_BASELINE_SOURCE || null, scope: 'Real host MarkdownText, SettingsRoot and SlotCore/shared shell store; actual plugin.apply registration; synthetic API responses; isolated profile, no live DSH data.', checks: ['fixed click opens settings and correct draft', 'mounted A to B opens correct namespace with one dashboard request', 'close and reopen preserves requested draft', 'ordinary external links and other-server feedback links retain host behavior', 'main document URL is unchanged'] }
  if (process.env.STRATAGATE_NAVIGATION_EVIDENCE) await writeFile(process.env.STRATAGATE_NAVIGATION_EVIDENCE, JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result, null, 2))
} finally {
  if (desktopApp) await desktopApp.close()
  if (browser) await browser.close()
  await new Promise(resolve => server.close(resolve))
  await rm(directory, { recursive: true, force: true })
}
