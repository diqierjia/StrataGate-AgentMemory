import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'node:http'
import { build } from 'esbuild'
import { chromium } from 'playwright-core'

// Real React mount and HTTP routes with synthetic in-memory snapshots only.
// React dependencies are supplied from a disposable fixture, never added to
// production dependencies. This does not launch or mutate a real DSH profile.
const sourceRoot = resolve(process.env.STRATAGATE_TEST_SOURCE_ROOT || '.')
const fixture = resolve(process.env.STRATAGATE_TEST_REACT_ROOT || 'release-candidates/first-login-browser-fixture')
const output = resolve(process.env.STRATAGATE_TEST_BROWSER_OUTPUT || 'release-candidates/first-login-browser-evidence')
mkdirSync(output, { recursive: true })
const webModule = join(output, 'fixture-web.mjs')
await build({ entryPoints: [join(sourceRoot, 'src/web.ts')], outfile: webModule, bundle: true, platform: 'node', format: 'esm',
  packages: 'external', alias: { '@diqier/stratagate': join(sourceRoot, 'packages/core/src/index.ts') } })
const { handleAdminRequest } = await import(pathToFileURL(webModule).href)
const client = readFileSync(join(sourceRoot, 'src/client.js'), 'utf8')
assert.equal(client.split("exports.name = 'stratagate-dsh'").length, 2)
const instrumented = client.replace("exports.name = 'stratagate-dsh'", "exports.__browserTest = { MemoryPage }; exports.name = 'stratagate-dsh'")
const app = await build({ stdin: { resolveDir: sourceRoot, contents: `
import React from ${JSON.stringify(join(fixture, 'node_modules/react/index.js'))};
import { createRoot } from ${JSON.stringify(join(fixture, 'node_modules/react-dom/client.js'))};
let definition;
window.__ModuleLoader__ = { load(value) { definition = value; } };
${instrumented}
const plugin = definition.factory(name => { if (name !== 'react') throw new Error(name); return React; });
const workspaces = { items: [] }, sessions = { byId: {} };
createRoot(document.getElementById('root')).render(React.createElement(plugin.__browserTest.MemoryPage, {
  useWorkspaces: selector => selector(workspaces), useSessions: selector => selector(sessions)
}));
` }, bundle: true, write: false, platform: 'browser', format: 'iife', define: { 'process.env.NODE_ENV': '"development"' } })
const date = '2026-10-13T00:00:00.000Z'
const event = (id, status = 'active') => ({ id, formedTurn: 0, title: id, summary: 'Synthetic source', tags: [], quotes: [],
  sourceMessageIds: [], sourceBlockId: 'fixture-block', temporal: {}, scope: 'project', criticality: 'routine', status, supersededBy: null,
  weight: { mentionCount: 1, lastAdoptedTurn: null, lastRetrievedAt: null, pinned: false, floorWeight: 0, forcedCap: null }, createdAt: date, updatedAt: date })
const job = (id, sourceEventIds, status) => ({ id, sourceEventIds, status, projectorVersion: 1, attempts: status === 'failed' ? 3 : 1,
  priority: 1, nodeIds: [], edgeIds: [], reason: null, lastError: status === 'failed' ? 'Synthetic failure' : null,
  nextRetryAt: null, createdAt: date, updatedAt: date })
const empty = { schemaVersion: 12, currentTurn: 0, blockTurnSize: 4, blockDecayLambda: 0.3, openTail: [], blocks: [],
  summaryJobs: [], events: [], agentEvents: [], graphNodes: [], graphEdges: [], graphProjectionJobs: [], elements: [], extractionJobs: [],
  elementProjectionJobs: [], usageReceipts: [], ingestionReceipts: [], externalMemoryImportJobs: [] }
const cases = {
  'no-workspace': null,
  'empty-workspace': empty,
  'agent-running': { ...empty, agentEvents: [event('agent-1'), event('agent-2')], graphProjectionJobs: [job('done', ['agent-1'], 'completed'), job('work', ['agent-2'], 'running')] },
  'agent-failed': { ...empty, agentEvents: [event('agent-1'), event('agent-2')], graphProjectionJobs: [job('done', ['agent-1'], 'completed'), job('work', ['agent-2'], 'failed')] },
  'history-failed': { ...empty, events: [event('old', 'forgotten')], agentEvents: [event('agent-old', 'archived')], graphProjectionJobs: [job('history', ['old', 'agent-old'], 'failed')] },
  'legacy-invalid-progress': empty,
}
const requests = []
const errors = []
const results = []
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://fixture')
  if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end('<!doctype html><meta charset="utf-8"><div id="root"></div><script src="/app.js"></script>'); return }
  if (url.pathname === '/app.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(app.outputFiles[0].text); return }
  if (url.pathname === '/favicon.ico') { res.statusCode = 204; res.end(); return }
  const key = String(req.headers['x-stratagate-fixture'] || '')
  const snapshot = cases[key]
  const namespace = 'dsh:project:fixture'
  const runtime = {
    adminNamespaces: async () => snapshot ? [namespace] : [], adminSnapshot: async () => snapshot,
    adminSnapshotEntries: async () => snapshot ? [{ namespace, revision: 1, snapshot }] : [],
    adminDataDirectory: () => 'synthetic-fixture', adminWorkspaceName: () => 'Browser fixture', adminAgentMemoryRetrievalWeight: () => 1,
    getProfileSnapshot: () => ({ profile: { userPreferredName: '', assistantPreferredName: '橙子', preferredLanguage: '中文' }, revisions: {} }),
  }
  try {
    await handleAdminRequest(runtime, { method: req.method, url: req.url, headers: req.headers }, {
      get statusCode() { return res.statusCode }, set statusCode(value) { res.statusCode = value },
      setHeader: (name, value) => res.setHeader(name, value),
      end: text => {
        let body = text ? JSON.parse(text) : null
        if (key === 'legacy-invalid-progress' && body) {
          const migration = { projected: 1, total: 0, processing: 1, failed: 0, complete: true, state: 'complete' }
          if (body.overview?.namespaces?.[0]) {
            body.overview.namespaces[0].graphMigration = migration
            body.overview.namespaces[0].taskStatus.graphProjection.processing = 1
          }
          if (body.data?.graph) body.data.graph.migration = migration
        }
        requests.push({ case: key, path: url.pathname, query: url.search, status: res.statusCode, ...(url.pathname.endsWith('/dashboard') ? { body } : {}) })
        res.end(body ? JSON.stringify(body) : '')
      },
    })
  } catch (error) { errors.push(String(error)); res.statusCode = 500; res.end(JSON.stringify({ error: String(error) })) }
})
await new Promise(resolveReady => server.listen(0, '127.0.0.1', resolveReady))
const port = server.address().port
const browser = await chromium.launch({ executablePath: process.env.STRATAGATE_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true })
try {
  for (const key of Object.keys(cases)) {
    const context = await browser.newContext({ viewport: { width: 1100, height: 1000 }, extraHTTPHeaders: { 'X-StrataGate-Fixture': key } })
    const page = await context.newPage()
    page.on('pageerror', error => errors.push(key + ': ' + error.message))
    const response = page.waitForResponse(value => value.url().includes('/api/stratagate/dashboard'))
    await page.goto(`http://127.0.0.1:${port}/`)
    assert.equal((await response).status(), 200)
    await page.getByRole('button', { name: '常驻画像', exact: true }).click()
    await page.getByRole('heading', { name: '常驻用户画像' }).waitFor()
    await page.getByText('已同步', { exact: true }).waitFor()
    assert.equal(await page.locator('.sg-error').count(), 0)
    const quiet = ['no-workspace', 'empty-workspace', 'history-failed'].includes(key)
    assert.equal(await page.locator('.sg-memory-alert').count(), quiet ? 0 : 1, key)
    const notices = {}
    if (key !== 'no-workspace') {
      await page.getByRole('button', { name: '长期记忆', exact: true }).click()
      for (const [mode, label] of [['graph', '知识图谱'], ['timeline', '事件时间线']]) {
        await page.getByRole('button', { name: label, exact: true }).click()
        const notice = page.locator('.sg-migration')
        assert.equal(await notice.count(), quiet ? 0 : 1, key + '/' + mode)
        notices[mode] = await notice.count() ? await notice.innerText() : ''
        if (key.startsWith('agent-')) assert.match(notices[mode], /1\/2 Events/)
        if (key === 'legacy-invalid-progress') { assert.match(notices[mode], /正在更新知识图谱/); assert.doesNotMatch(notices[mode], /\d+\/\d+ Events/) }
        if (mode === 'timeline' && key === 'agent-running') {
          const search = page.getByRole('textbox', { name: '搜索长期记忆' })
          const searchResponse = page.waitForResponse(value => value.url().includes('kind=events') && value.url().includes('q=no-match'))
          await search.fill('no-match')
          await searchResponse
          assert.match(await notice.innerText(), /1\/2 Events/)
        }
      }
    }
    await page.screenshot({ path: join(output, key + '.png'), fullPage: true })
    results.push({ case: key, profileMounted: true, profileSynchronized: true, expectedAlerts: quiet ? 0 : 1, notices, passed: true })
    await context.close()
  }
  assert.deepEqual(errors, [])
  console.log(`Browser regression passed: ${results.length} scenarios, real React + MemoryPage + HTTP Dashboard/Graph routes.`)
} finally {
  writeFileSync(join(output, 'browser-results.json'), JSON.stringify({ sourceRoot, reactVersion: '18.3.1', browserVersion: browser.version(), results, requests, errors }, null, 2) + '\n')
  await browser.close()
  await new Promise(done => server.close(done))
}
