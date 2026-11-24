import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { checkClient } from './check-client.mjs'

const root = resolve('.')
const outputDir = resolve(process.env.STRATAGATE_REAL_E2E_OUTPUT || '.artifacts/real-memory-e2e')
mkdirSync(outputDir, { recursive: true })

function fileSha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

function resolveBrowserLaunchOptions() {
  if (process.env.STRATAGATE_BROWSER_CHROME && existsSync(process.env.STRATAGATE_BROWSER_CHROME)) {
    return { executablePath: process.env.STRATAGATE_BROWSER_CHROME, headless: true }
  }
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return { executablePath: candidate, headless: true }
  }
  return { headless: true }
}

checkClient(root)

const defaultRealDb = join(homedir(), '.dsh', 'stratagate', 'memory.db')
const requestedRealDb = process.env.STRATAGATE_REAL_DB ? resolve(process.env.STRATAGATE_REAL_DB) : defaultRealDb
const hasRealDb = existsSync(requestedRealDb)
const realDbBeforeHash = hasRealDb ? fileSha256(requestedRealDb) : null
const realDbBeforeMtime = hasRealDb ? statSync(requestedRealDb).mtimeMs : null

const shadowDir = mkdtempSync(join(tmpdir(), 'stratagate-real-memory-shadow-'))
const shadowDb = join(shadowDir, 'memory.db')
const shadowDailyDir = join(shadowDir, 'daily')

if (hasRealDb) {
  for (const suffix of ['', '-wal', '-shm']) {
    const src = requestedRealDb + suffix
    if (existsSync(src)) cpSync(src, shadowDb + suffix)
  }
  const realDailyDir = join(dirname(requestedRealDb), 'daily')
  if (existsSync(realDailyDir)) {
    cpSync(realDailyDir, shadowDailyDir, { recursive: true })
  }
}

const runtimeBundlePath = join(outputDir, 'runtime-bundle.mjs')
await build({
  stdin: {
    resolveDir: root,
    contents: `
      export { StrataGateRuntime } from './src/runtime.ts'
      export { resolveConfig } from './src/config.ts'
      export { handleAdminRequest } from './src/web.ts'
      export { StrataGate } from './packages/core/src/index.ts'
    `,
  },
  outfile: runtimeBundlePath,
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  alias: {
    '@diqier/stratagate/sqlite': join(root, 'packages/core/src/sqlite.ts'),
    '@diqier/stratagate': join(root, 'packages/core/src/index.ts'),
  },
})

const { StrataGateRuntime, resolveConfig, handleAdminRequest, StrataGate } = await import(pathToFileURL(runtimeBundlePath).href)

if (!hasRealDb) {
  const seeded = await StrataGate.open({ database: shadowDb, namespace: 'e2e:seeded:project', blockTurnSize: 2 })
  await seeded.appendTurn({ user: '测试端到端界面渲染与布局检查', assistant: '已记录真实影子数据库回退样本', threadId: 'seed-thread-1' })
  await seeded.appendTurn({ user: '验证多页面切换与长文本折行', assistant: '确保窄屏与宽屏均无横向溢出', threadId: 'seed-thread-1' })
  await seeded.close()
}

const dbInspect = new DatabaseSync(shadowDb)
const spaceRows = dbInspect.prepare(`
  SELECT s.namespace,
         (SELECT COUNT(*) FROM events e WHERE e.namespace = s.namespace) AS eventCount,
         (SELECT COUNT(*) FROM blocks b WHERE b.namespace = s.namespace) AS blockCount,
         (SELECT COUNT(*) FROM elements el WHERE el.namespace = s.namespace) AS elementCount
  FROM memory_spaces s
  ORDER BY (eventCount * 3 + blockCount * 2 + elementCount) DESC
`).all()
dbInspect.close()

const primaryNamespace = spaceRows[0]?.namespace || 'global'
const config = resolveConfig({
  database: shadowDb,
  dailyNotesTimeZone: 'Asia/Shanghai',
  namespaceMode: 'project',
})
const models = { isReady: () => false, onAdaptersUpdated: () => () => {} }
const runtime = new StrataGateRuntime(config, models, () => {}, async () => {}, () => undefined)

const reactRoot = resolve(process.env.STRATAGATE_TEST_REACT_ROOT || 'release-candidates/first-login-browser-fixture/node_modules')
const clientSource = readFileSync(join(root, 'src', 'client.js'), 'utf8')
const instrumentedClient = clientSource.replace(
  "exports.name = 'stratagate-dsh'",
  "exports.__browserTest = { MemoryPage }; exports.name = 'stratagate-dsh'",
)

const appBundle = await build({
  stdin: {
    resolveDir: root,
    contents: `
      import React from ${JSON.stringify(join(reactRoot, 'react/index.js'))};
      import { createRoot } from ${JSON.stringify(join(reactRoot, 'react-dom/client.js'))};
      let definition;
      window.__ModuleLoader__ = { load(value) { definition = value; } };
      ${instrumentedClient}
      const plugin = definition.factory(name => {
        if (name !== 'react') throw new Error('Unexpected require: ' + name);
        return React;
      });
      const workspaces = { items: [] };
      const sessions = { byId: {} };
      createRoot(document.getElementById('root')).render(
        React.createElement(plugin.__browserTest.MemoryPage, {
          useWorkspaces: selector => selector(workspaces),
          useSessions: selector => selector(sessions),
          usePluginSettings: selector => selector({ value: { memoryModel: { mode: 'auto' } }, writable: true }),
          setDailyInjectionDays: async () => true,
        })
      );
    `,
  },
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'iife',
  define: { 'process.env.NODE_ENV': '"development"' },
})

const themes = {
  light: '--dsw-alias-bg-layer-2:#fff;--dsw-specific-input-major:#fff;--dsw-alias-interactive-bg-hover-solid:#f1f3f5;--dsw-alias-label-primary:#0f1115;--dsw-alias-label-secondary:#61666b;--dsw-alias-border-l2:rgba(0,0,0,.1);--dsw-alias-state-business-primary:#4176e6;--dsw-alias-state-business-tertiary:#e8effd;--dsw-alias-state-success-primary:#1f9d55;--dsw-alias-state-success-tertiary:#e6f7ed;',
  dark: '--dsw-alias-bg-layer-2:#1f2023;--dsw-specific-input-major:#26282c;--dsw-alias-interactive-bg-hover-solid:#2d3035;--dsw-alias-label-primary:#eceef1;--dsw-alias-label-secondary:#9a9fa6;--dsw-alias-border-l2:rgba(255,255,255,.09);--dsw-alias-state-business-primary:#5b8def;--dsw-alias-state-business-tertiary:rgba(91,141,239,.14);--dsw-alias-state-success-primary:#3ccf7a;--dsw-alias-state-success-tertiary:rgba(60,207,122,.13);',
}

const apiRequests = []
const pageErrors = []
const screenshots = []

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  if (url.pathname === '/') {
    const theme = url.searchParams.get('theme') === 'dark' ? 'dark' : 'light'
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.end(`<!doctype html><meta charset="utf-8"><style>html,body{margin:0}html{${themes[theme]}}#root{width:100%;min-width:0}body{background:var(--dsw-alias-bg-layer-2)}</style><div id="root"></div><script src="/app.js"></script>`)
    return
  }
  if (url.pathname === '/app.js') {
    res.setHeader('Content-Type', 'text/javascript; charset=utf-8')
    res.end(appBundle.outputFiles[0].text)
    return
  }
  if (url.pathname === '/favicon.ico') {
    res.statusCode = 204
    res.end()
    return
  }
  await handleAdminRequest(runtime, req, {
    get statusCode() { return res.statusCode },
    set statusCode(val) { res.statusCode = val },
    setHeader: (k, v) => res.setHeader(k, v),
    end: (body) => {
      apiRequests.push({ path: url.pathname, status: res.statusCode })
      res.end(body)
    },
  })
})

await new Promise((done) => server.listen(0, '127.0.0.1', done))
const port = server.address().port
const browser = await chromium.launch(resolveBrowserLaunchOptions())

try {
  const context = await browser.newContext({ viewport: { width: 960, height: 900 }, colorScheme: 'light' })
  const page = await context.newPage()
  page.on('pageerror', (err) => pageErrors.push(String(err?.message || err)))

  await page.goto(`http://127.0.0.1:${port}/?theme=light`)
  await page.locator('.sg-tabs button').first().waitFor({ timeout: 15000 })

  const tabLabels = await page.locator('.sg-tabs button').allTextContents()
  assert.deepEqual(tabLabels, ['总览', '常驻画像', '会话记忆', '短期记忆', '长期记忆', '更多'])

  const workspaceSelect = page.getByRole('combobox', { name: '当前工作区' })
  if (await workspaceSelect.count() > 0 && primaryNamespace) {
    const options = await workspaceSelect.locator('option').evaluateAll((els) => els.map((e) => e.value))
    if (options.includes(primaryNamespace)) {
      await workspaceSelect.selectOption(primaryNamespace)
    }
  }

  async function inspectAndCapture(stepName, tabText) {
    if (tabText) {
      await page.locator('.sg-tabs button').filter({ hasText: new RegExp(`^${tabText}$`) }).click()
    }
    await page.waitForTimeout(250)
    const loadingLocator = page.locator('.sg-loading')
    if (await loadingLocator.count() > 0) {
      await loadingLocator.first().waitFor({ state: 'detached', timeout: 10000 }).catch(() => {})
    }
    const screenshotPath = join(outputDir, `${stepName}.png`)
    await page.screenshot({ path: screenshotPath, fullPage: true, animations: 'disabled' })
    const layout = await page.evaluate(() => {
      const panel = document.querySelector('.sg-memory')
      if (!panel) return { missingPanel: true }
      return {
        scrollWidth: panel.scrollWidth,
        clientWidth: panel.clientWidth,
        horizontalOverflow: panel.scrollWidth > panel.clientWidth + 1,
        tabsClipped: [...document.querySelectorAll('.sg-tabs button')].some((b) => b.scrollWidth > b.clientWidth + 1),
      }
    })
    assert.equal(layout.missingPanel, undefined, `Missing .sg-memory on ${stepName}`)
    assert.equal(layout.horizontalOverflow, false, `Horizontal overflow on ${stepName}: ${JSON.stringify(layout)}`)
    assert.equal(layout.tabsClipped, false, `Clipped tabs on ${stepName}: ${JSON.stringify(layout)}`)
    screenshots.push({ stepName, tab: tabText || '总览', screenshotPath, ...layout })
  }

  await inspectAndCapture('01-overview', '总览')
  await inspectAndCapture('02-profile', '常驻画像')
  await inspectAndCapture('03-session-blocks', '会话记忆')
  await inspectAndCapture('04-daily-notes', '短期记忆')

  const dayTab = page.locator('.sg-day-d').first()
  if (await dayTab.count() > 0) {
    await dayTab.click()
    await inspectAndCapture('04b-daily-note-open', null)
  }

  await inspectAndCapture('05-long-term', '长期记忆')
  const longTermChecks = await (async () => {
    const toggles = page.locator('button.sg-topic-section-toggle')
    const toggleCount = await toggles.count()
    assert.ok(toggleCount >= 2, `Expected at least 2 topic sections on 05-long-term, got ${toggleCount}`)
    const titleBuckets = new Map()
    for (let i = 0; i < toggleCount; i += 1) {
      const t = ((await toggles.nth(i).getAttribute('title')) || '').trim()
      if (!t) continue
      const list = titleBuckets.get(t) || []
      list.push(i)
      titleBuckets.set(t, list)
    }
    const sharedIndices = [...titleBuckets.values()].find((arr) => arr.length >= 2) || [0, 1]
    await toggles.nth(sharedIndices[0]).click()
    await page.waitForTimeout(200)
    const checkBookGeometry = async (label) => {
      const geo = await page.evaluate(() => {
        const openBodies = [...document.querySelectorAll('.sg-topic-directory .sg-directory-fold.open > .sg-directory-fold-inner > .sg-topic-section-body')]
        const visibleBodies = openBodies.filter((el) => el.getBoundingClientRect().height > 0 && el.getBoundingClientRect().width > 0)
        const chapterRows = [...document.querySelectorAll('.sg-topic-directory .sg-topic-chapter-toggle')]
        const overlaps = []
        for (const body of visibleBodies) {
          const b = body.getBoundingClientRect()
          for (const row of chapterRows) {
            const r = row.getBoundingClientRect()
            if (r.height <= 0 || r.width <= 0) continue
            const xOverlap = Math.min(b.right, r.right) - Math.max(b.left, r.left)
            const yOverlap = Math.min(b.bottom, r.bottom) - Math.max(b.top, r.top)
            if (xOverlap > 2 && yOverlap > 2) {
              overlaps.push({ row: row.textContent?.trim(), xOverlap, yOverlap })
            }
          }
        }
        return { visibleBodyCount: visibleBodies.length, overlaps }
      })
      assert.equal(geo.visibleBodyCount, 1, `${label}: expected exactly 1 visible section body, got ${geo.visibleBodyCount}`)
      assert.deepEqual(geo.overlaps, [], `${label}: section body overlaps chapter TOC: ${JSON.stringify(geo.overlaps)}`)
      return geo
    }
    await checkBookGeometry('desktop-wide-first-section')
    await toggles.nth(sharedIndices[1]).click()
    await page.waitForTimeout(200)
    await checkBookGeometry('desktop-wide-shared-title-second-section')
    await page.evaluate(() => {
      const rootEl = document.getElementById('root')
      if (rootEl) rootEl.style.width = '720px'
    })
    await page.waitForTimeout(200)
    await checkBookGeometry('desktop-viewport-720px-container')
    await inspectAndCapture('05b-long-term-narrow-container', null)
    await page.evaluate(() => {
      const rootEl = document.getElementById('root')
      if (rootEl) rootEl.style.width = '100%'
    })
    return { sharedTitleTested: sharedIndices.length >= 2, checkedIndices: sharedIndices }
  })()
  await inspectAndCapture('06-more', '更多')
  const advancedSettingsBtn = page.locator('button.sg-more-go', { hasText: '高级设置' }).first()
  if (await advancedSettingsBtn.count() > 0) {
    await advancedSettingsBtn.click()
    await page.locator('.sg-dreaming-setting').waitFor({ timeout: 10000 })
    await page.waitForTimeout(300)
    await inspectAndCapture('06b-advanced-settings', null)
  }

  await page.setViewportSize({ width: 360, height: 840 })
  await page.goto(`http://127.0.0.1:${port}/?theme=dark`)
  await page.locator('.sg-tabs button').first().waitFor({ timeout: 15000 })
  if (await workspaceSelect.count() > 0 && primaryNamespace) {
    const options = await workspaceSelect.locator('option').evaluateAll((els) => els.map((e) => e.value))
    if (options.includes(primaryNamespace)) {
      await workspaceSelect.selectOption(primaryNamespace)
    }
  }
  await inspectAndCapture('07-overview-dark-narrow', '总览')
  await inspectAndCapture('08-daily-notes-dark-narrow', '短期记忆')
  const darkDayTab = page.locator('.sg-day-d').first()
  if (await darkDayTab.count() > 0) {
    await darkDayTab.click()
    await inspectAndCapture('08b-daily-note-open-dark-narrow', null)
  }
  await inspectAndCapture('09-more-dark-narrow', '更多')
  const darkAdvancedBtn = page.locator('button.sg-more-go', { hasText: '高级设置' }).first()
  if (await darkAdvancedBtn.count() > 0) {
    await darkAdvancedBtn.click()
    await page.locator('.sg-dreaming-setting').waitFor({ timeout: 10000 })
    await page.waitForTimeout(300)
    await inspectAndCapture('09b-advanced-settings-dark-narrow', null)
  }

  await context.close()

  assert.deepEqual(pageErrors, [], `Uncaught browser page errors: ${pageErrors.join('; ')}`)
  const serverErrors = apiRequests.filter((r) => r.status >= 500)
  assert.deepEqual(serverErrors, [], `HTTP 500 responses: ${JSON.stringify(serverErrors)}`)

  if (hasRealDb) {
    assert.equal(fileSha256(requestedRealDb), realDbBeforeHash, 'Real memory.db SHA-256 must remain untouched')
    assert.equal(statSync(requestedRealDb).mtimeMs, realDbBeforeMtime, 'Real memory.db mtime must remain untouched')
  }

  const report = {
    sourceMode: hasRealDb ? 'real-dsh-memory-shadow-copy' : 'seeded-fallback',
    sourceDatabase: hasRealDb ? requestedRealDb : 'synthetic-seed',
    realDbUntouchedVerified: hasRealDb,
    primaryNamespace,
    namespaceStats: spaceRows.slice(0, 5),
    screenshotsCount: screenshots.length,
    screenshots,
    longTermChecks,
    apiRequestCount: apiRequests.length,
    pageErrors,
  }
  writeFileSync(join(outputDir, 'e2e-report.json'), JSON.stringify(report, null, 2), 'utf8')
  console.log(`[real-memory-e2e] Passed (${report.sourceMode}, namespace="${primaryNamespace}", ${screenshots.length} screenshots saved to ${outputDir})`)
} finally {
  await browser.close()
  await new Promise((done) => server.close(done))
  await runtime.close()
  rmSync(shadowDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
