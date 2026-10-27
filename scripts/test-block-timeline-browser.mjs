import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { chromium } from 'playwright-core'
import { StrataGate, getDecayedBlockLevel } from '../packages/core/dist/index.js'
import { SqliteStorage } from '../packages/core/dist/sqlite.js'
import { DatabaseSync } from 'node:sqlite'

// Real DSH host + built plugin + browser + HTTP + SQLite. Only the provider is
// synthetic. Every database/profile is freshly created under system temp.
const root = resolve('.')
const output = resolve('.artifacts/block-distance-report/browser')
mkdirSync(output, { recursive: true })
const home = mkdtempSync(join(tmpdir(), 'stratagate-timeline-e2e-'))
const database = join(home, 'stratagate/memory.db')
mkdirSync(join(home, 'stratagate'), { recursive: true })
const namespace = 'browser:timeline'
const pending = new Set([1, 6, 13, 22, 31, 40, 49, 58, 67, 75])
const gate = join(home, 'allow-summaries')
const modelLog = join(home, 'synthetic-provider.jsonl')
const checks = [], screenshots = [], requests = [], errors = [], logs = []
const seed = await StrataGate.open({ database, namespace, blockTurnSize: 1, graphEnabled: false,
  summarizer: async messages => {
    const index = Number(messages[0].content.match(/#(\d+)/)?.[1])
    if (pending.has(index)) throw new Error('isolated synthetic summary failure')
    return { l0Title: `隔离块 #${index}`, l0Tags: ['隔离验收'], l1Summary: `第 ${index} 个封存块的摘要`, l2Keypoints: ['原文保留'], shouldExtract: false }
  } })
for (let index = 1; index <= 75; index++) await seed.appendTurn({
  user: `隔离块 #${index} 的原始对话`, assistant: `隔离回复 #${index}`, threadId: 'timeline-a',
})
for (let index = 1; index <= 3; index++) await seed.appendTurn({ user: `其他会话 ${index}`, assistant: '隔离回复', threadId: 'timeline-b' })
const seeded = seed.exportSnapshot()
const rawDigest = snapshot => createHash('sha256').update(JSON.stringify(snapshot.blocks.map(b => b.l5Raw))).digest('hex')
const rawBefore = rawDigest(seeded)
await seed.close()
// Represent schema 13 accurately: ready ranks and terminal pending jobs.
const legacyDb = new DatabaseSync(database)
let rank = 0
for (const block of seeded.blocks.filter(b => b.threadId === 'timeline-a')) {
  if (block.processingStatus === 'ready') {
    const anchor = ++rank, level = getDecayedBlockLevel(5, anchor, 65)
    legacyDb.prepare('UPDATE blocks SET pointer_anchor_block_position = ?, pointer_current_level = ?, surface_current_level = ? WHERE namespace = ? AND id = ?')
      .run(anchor, level, level, namespace, block.id)
  } else {
    legacyDb.prepare("UPDATE block_summary_jobs SET status = 'failed', attempts = 3, next_retry_at = NULL WHERE namespace = ? AND block_id = ?")
      .run(namespace, block.id)
  }
}
legacyDb.prepare('UPDATE memory_spaces SET schema_version = 13').run()
legacyDb.exec('PRAGMA user_version = 13')
legacyDb.close()

const profile = join(home, 'profiles/web')
mkdirSync(join(profile, 'node_modules/stratagate-timeline-e2e'), { recursive: true })
symlinkSync(root, join(profile, 'node_modules/stratagate-dsh'), 'junction')
writeFileSync(join(profile, 'node_modules/stratagate-timeline-e2e/package.json'), JSON.stringify({ name: 'stratagate-timeline-e2e', type: 'module', main: 'index.mjs' }))
writeFileSync(join(profile, 'node_modules/stratagate-timeline-e2e/index.mjs'), `
import { LlmAdapter } from ${JSON.stringify(pathToFileURL(join(root, 'node_modules/@deepseek-ai/dsh-llm/lib/index.js')).href)};
import { existsSync, appendFileSync } from 'node:fs';
export const name = 'stratagate-timeline-e2e';
export const inject = ['llm'];
export function apply(ctx) {
  class FixtureAdapter extends LlmAdapter {
    async *stream(options) {
      appendFileSync(${JSON.stringify(modelLog)}, JSON.stringify({ provider: options.provider, model: options.model, tool: options.tools?.[0]?.name, allowed: existsSync(${JSON.stringify(gate)}) }) + String.fromCharCode(10));
      if (!existsSync(${JSON.stringify(gate)})) throw new Error('synthetic provider gate closed');
      const name = options.tools?.[0]?.name;
      if (name !== 'stratagate_summarize_block') throw new Error('Unexpected synthetic task: ' + name);
      const value = { l0Title: '恢复的隔离块', l0Tags: ['隔离验收'], l1Summary: '模拟摘要恢复成功，原文完整保留', l2Keypoints: ['隔离数据'], shouldExtract: false };
      yield { type: 'tool-call-delta', index: 0, id: 'synthetic-call', name, argumentsDelta: JSON.stringify(value) };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
    }
  }
  ctx.llm.registerAdapter(['timeline-fixture'], new FixtureAdapter());
}
`)
writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'timeline-e2e', private: true,
  dependencies: { 'stratagate-dsh': 'file:' + root },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'stratagate-dsh'] } } }))
writeFileSync(join(profile, 'cordis.yml'), '[]\n')
writeFileSync(join(profile, 'cordis.patch.yml'),
  '- id: ui-settings-general\n  name: "@deepseek-ai/dsh-client-ui-settings-general"\n  config:\n    welcomeNoticeVersion: 2026-09-28.1\n'
  + ['llm-deepseek', 'llm-deepseek-account', 'llm-pi-ai'].map(id => '- id: ' + id + '\n  disabled: true\n').join('')
  + '- id: stratagate-memory\n  config:\n    database: ' + JSON.stringify(database.replaceAll('\\', '/')) + '\n    blockTurnSize: 1\n    provider: timeline-fixture\n    model: fixture\n'
  + '- insert:\n    - id: stratagate-timeline-e2e\n      name: stratagate-timeline-e2e\n      inject: [llm]\n')

let child, browser, page
const stopHost = async () => {
  if (!child || child.exitCode !== null) return
  const exit = new Promise(done => child.once('exit', done))
  child.kill()
  await exit
}
const startHost = async () => {
  child = spawn(process.execPath, [join(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), '--profile', 'web', '--port', '0', '--no-open'], {
    cwd: home, env: { ...process.env, DSH_HOME: home }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  const url = await new Promise((done, reject) => {
    let current = ''
    const timer = setTimeout(() => reject(new Error('DSH startup timeout')), 60000)
    const inspect = chunk => {
      const text = chunk.toString(); logs.push(text.replace(/token=[A-Za-z0-9_-]+/g, 'token=[redacted]')); current += text
      const match = current.match(/https?:\/\/(?:127\.0\.0\.1|localhost):\d+\/?\?token=[A-Za-z0-9_-]+/)
      if (match) { clearTimeout(timer); done(match[0]) }
    }
    child.stdout.on('data', inspect); child.stderr.on('data', inspect)
    child.once('exit', code => { clearTimeout(timer); reject(new Error('DSH exited ' + code)) })
  })
  // The shell may reject plain HTTP without the browser's auth bootstrap.
  // Readiness is verified by navigating this URL and reading the real UI/API.
  return url
}
const api = async (path, params = {}, method = 'GET') => page.evaluate(async ({ path, params, method }) => {
  const response = await fetch('/api/stratagate/' + path + '?' + new URLSearchParams(params), { method })
  const value = await response.json()
  if (!response.ok) throw new Error(JSON.stringify({ status: response.status, value }))
  return value
}, { path, params: { namespace, ...params }, method })
const inspect = async () => {
  const storage = new SqliteStorage({ filename: database, readonly: true })
  const memory = await StrataGate.openWithStorage({ storage, namespace })
  try { return { snapshot: memory.exportSnapshot(), core: memory.getBlockContext('timeline-a') } }
  finally { await memory.close() }
}
const readBlocks = () => api('memories', { kind: 'blocks', threadId: 'timeline-a', limit: '100' })
const compare = async label => {
  const panel = await readBlocks(), state = await inspect()
  assert.equal(panel.items.length, 75)
  assert.equal(panel.items.filter(b => b.distanceFromLatest === 0).length, 1)
  assert.equal(rawDigest(state.snapshot), rawBefore)
  const core = new Map(state.core.map(b => [b.id, b]))
  for (const block of panel.items) {
    assert.equal(block.distanceFromLatest, 75 - block.blockIndex)
    if (block.processingStatus === 'ready') {
      assert.equal(block.targetLevel, core.get(block.id).level)
      assert.equal(block.distanceFromLatest, core.get(block.id).age)
    }
  }
  writeFileSync(join(output, label + '.json'), JSON.stringify({ panel, ...state }, null, 2))
  return { panel, ...state }
}
const openUI = async url => {
  await page.goto(url)
  for (const name of ['继续', '稍后配置']) {
    try { await page.getByRole('button', { name, exact: true }).click({ timeout: 1500 }) } catch {}
  }
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: 'StrataGate-AgentMemory' }).click()
  const memory = page.getByTestId('stratagate-memory-ui')
  await memory.waitFor()
  const workspace = memory.getByRole('combobox', { name: '当前工作区' })
  await workspace.selectOption(namespace)
  await memory.locator('.sg-tabs').getByRole('button', { name: '短期记忆', exact: true }).click()
  await memory.getByRole('combobox', { name: '当前对话', exact: true }).selectOption('timeline-a')
  await memory.locator('.sg-block-name').filter({ hasText: /^Block #1$/ }).waitFor()
  return memory
}
const capture = async name => {
  const path = join(output, name + '.png')
  await page.screenshot({ path, fullPage: true }); screenshots.push(path)
}
try {
  const url = await startHost()
  browser = await chromium.launch({ executablePath: process.env.STRATAGATE_TEST_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true })
  page = await browser.newPage({ viewport: { width: 1360, height: 1000 }, colorScheme: 'dark', locale: 'zh-CN' })
  page.setDefaultTimeout(15000)
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.pathname.startsWith('/api/stratagate/')) requests.push({ method: request.method(), path: url.pathname })
  })
  let memoryUI = await openUI(url)
  const before = await compare('before-recovery')
  assert.equal(before.snapshot.schemaVersion, 14)
  assert.equal(before.snapshot.blocks.filter(b => b.processingStatus === 'pending').length, 10)
  let legacyRank = 0
  for (const block of before.snapshot.blocks.filter(b => b.threadId === 'timeline-a')) {
    if (block.processingStatus === 'ready') {
      legacyRank++
      assert.equal(block.pointerAnchorBlockPosition, legacyRank + 10)
      assert.equal(before.core.find(b => b.id === block.id).level, getDecayedBlockLevel(5, legacyRank, 65))
    }
  }
  checks.push('Real DSH writer migrates schema 13 to 14; panel and core agree for 75 blocks / 10 pending; raw digest unchanged')
  const row = index => memoryUI.locator('.sg-block-unit').filter({ has: page.locator('.sg-block-name').filter({ hasText: new RegExp('^Block #' + index + '$') }) })
  assert.equal(await row(2).locator('.sg-block-distance').innerText(), '73 个 Block')
  await capture('01-legacy-migrated')
  await memoryUI.getByRole('button', { name: '下一页', exact: true }).click()
  await row(75).waitFor()
  assert.equal(await row(65).locator('.sg-block-distance').innerText(), '10 个 Block')
  assert.equal(await row(74).locator('.sg-block-distance').innerText(), '1 个 Block')
  assert.equal(await row(75).locator('.sg-block-distance').innerText(), '0（最新）')
  assert.equal(await memoryUI.locator('.sg-block-distance').filter({ hasText: /^0（最新）$/ }).count(), 1)
  await row(75).scrollIntoViewIfNeeded(); await capture('02-tail-single-latest')
  checks.push('Actual paginated DOM shows block 65 = 10, 74 = 1, 75 = 0; exactly one latest')
  await memoryUI.getByRole('button', { name: '上一页', exact: true }).click()
  await row(2).locator('button.sg-block-toggle').click()
  await row(2).getByRole('button', { name: 'L3 操作', exact: true }).click()
  await capture('03-menu-above-layers')
  await row(2).getByRole('button', { name: '展开到这一层', exact: true }).click()
  const expanded = await compare('after-expansion')
  assert.equal(expanded.core.find(b => b.id === seeded.blocks[1].id).level, 3)
  assert.equal(expanded.snapshot.blocks[1].pointerAnchorBlockPosition, 75)
  assert.equal(expanded.snapshot.blocks[1].lastLiftedBy, 'user')
  await row(2).scrollIntoViewIfNeeded(); await capture('03-user-expansion')
  checks.push('UI layer menu invokes real PATCH expansion and persists L3 anchor at sealed position 75')
  writeFileSync(gate, 'synthetic model enabled')
  for (const index of [...pending].reverse()) await api('blocks/retry-summary', { blockId: seeded.blocks[index - 1].id }, 'POST')
  const recovered = await compare('after-recovery')
  assert.equal(recovered.snapshot.blocks.filter(b => b.processingStatus === 'pending').length, 0)
  for (const block of expanded.core) assert.deepEqual(recovered.core.find(b => b.id === block.id), block)
  assert.deepEqual(recovered.snapshot.blocks.map(b => b.pointerAnchorBlockPosition), expanded.snapshot.blocks.map(b => b.pointerAnchorBlockPosition))
  checks.push('Browser POST -> real runtime/worker/model bridge -> synthetic DSH provider -> SQLite recovers all 10 pending in reverse order without aging other blocks')
  await page.reload(); memoryUI = await openUI(url)
  await row(2).scrollIntoViewIfNeeded(); await capture('04-recovered-dark')
  const anchors = recovered.snapshot.blocks.map(b => b.pointerAnchorBlockPosition)
  await stopHost()
  const restartedUrl = await startHost()
  memoryUI = await openUI(restartedUrl)
  const restarted = await compare('after-restart')
  assert.deepEqual(restarted.core, recovered.core)
  assert.deepEqual(restarted.snapshot.blocks.map(b => b.pointerAnchorBlockPosition), anchors)
  await memoryUI.getByRole('combobox', { name: '当前对话', exact: true }).selectOption('timeline-b')
  await memoryUI.locator('.sg-block-name').filter({ hasText: /^Block #76$/ }).waitFor()
  assert.equal(await memoryUI.locator('.sg-block-distance').filter({ hasText: /^0（最新）$/ }).count(), 1)
  checks.push('Process restart preserves decay/lift/anchors, migration does not repeat; conversation switch stays isolated')
  await capture('05-restarted-other-thread')
  const calls = existsSync(modelLog) ? readFileSync(modelLog, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
  assert.equal(calls.length, 10)
  assert.ok(calls.every(call => call.provider === 'timeline-fixture' && call.allowed))
  assert.deepEqual(errors, [])
  checks.push('All 10 model calls went only to in-process synthetic provider; no real credentials or model billing')
  const verify = new DatabaseSync(database, { readOnly: true })
  assert.equal(verify.prepare('PRAGMA user_version').get().user_version, 14)
  assert.equal(verify.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
  assert.deepEqual(verify.prepare('PRAGMA foreign_key_check').all(), [])
  verify.close()
  const result = { passed: true, host: JSON.parse(readFileSync(join(root, 'node_modules/@deepseek-ai/dsh/package.json'))).version,
    browser: browser.version(), home, database, syntheticOnly: true, checks, screenshots, requests, errors, modelCalls: calls.length }
  writeFileSync(join(output, 'result.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify({ passed: true, checks, screenshots }, null, 2))
} catch (error) {
  await capture('failure').catch(() => {})
  writeFileSync(join(output, 'failure.json'), JSON.stringify({ message: String(error), stack: error.stack, home, checks, errors, logs }, null, 2))
  throw error
} finally {
  writeFileSync(join(output, 'dsh.log'), logs.join(''))
  await browser?.close(); await stopHost()
}
