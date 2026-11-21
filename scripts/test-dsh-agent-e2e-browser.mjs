import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import * as zlib from 'node:zlib'
import { chromium } from 'playwright-core'

const root = resolve('.')
const outputDir = resolve(process.env.STRATAGATE_DSH_E2E_OUTPUT || '.artifacts/dsh-agent-e2e')
mkdirSync(outputDir, { recursive: true })

function fileSha256(p) {
  return createHash('sha256').update(readFileSync(p)).digest('hex')
}
function computeProjectKey(cwd) {
  const canonical = resolve(cwd).split('\\').join('/').toLowerCase()
  return createHash('sha256').update(canonical).digest('hex').slice(0, 20)
}
function resolveBrowserLaunchOptions() {
  const candidates = [
    process.env.STRATAGATE_BROWSER_CHROME,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(Boolean)
  for (const c of candidates) if (existsSync(c)) return { executablePath: c, headless: true }
  return { headless: true }
}
function resolveDshNodeExecPath() {
  if (typeof zlib.createZstdCompress === 'function') return process.execPath
  const candidates = [
    process.env.STRATAGATE_DSH_NODE,
    join(homedir(), 'AppData', 'Local', 'npm-cache', '_npx', '387698761821791d', 'node_modules', 'node', 'bin', 'node.exe'),
    join(homedir(), '.workbuddy', 'binaries', 'node', 'versions', '22.22.2-6', 'node.exe'),
  ].filter(Boolean)
  for (const c of candidates) if (existsSync(c)) return c
  return process.execPath
}

if (!existsSync(join(root, 'dist', 'index.js')) || !existsSync(join(root, 'dist', 'client.js'))) {
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const b = spawnSync(npmCmd, ['run', 'build:dsh'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' })
  assert.equal(b.status, 0, 'npm run build:dsh failed')
}

const defaultRealDb = join(homedir(), '.dsh', 'stratagate', 'memory.db')
const requestedRealDb = process.env.STRATAGATE_REAL_DB ? resolve(process.env.STRATAGATE_REAL_DB) : defaultRealDb
const hasRealDb = existsSync(requestedRealDb)
const forceShadow = process.env.STRATAGATE_E2E_SHADOW === '1' || process.argv.includes('--shadow')

function canWriteDirectory(dirPath) {
  try {
    mkdirSync(dirPath, { recursive: true })
    const probe = join(dirPath, `.e2e-write-probe-${process.pid}`)
    writeFileSync(probe, 'ok')
    rmSync(probe, { force: true })
    return true
  } catch {
    return false
  }
}

const realStratagateDir = dirname(requestedRealDb)
const useLiveDb = !forceShadow && hasRealDb && canWriteDirectory(realStratagateDir)
const dbMode = useLiveDb ? 'live' : 'shadow'

const tempRoot = mkdtempSync(join(tmpdir(), 'stratagate-dsh-agent-e2e-'))
const dshHome = join(tempRoot, 'dsh-home')
mkdirSync(dshHome, { recursive: true })

let activeDbPath
let backupPath = null
if (useLiveDb) {
  activeDbPath = requestedRealDb
  const backupDir = join(homedir(), '.dsh', 'stratagate-backups')
  if (canWriteDirectory(backupDir)) {
    backupPath = join(backupDir, 'memory-pre-e2e-latest.db')
    for (const s of ['', '-wal', '-shm']) {
      if (existsSync(requestedRealDb + s)) cpSync(requestedRealDb + s, backupPath + s)
    }
  }
} else {
  const shadowStratagateDir = join(dshHome, 'stratagate')
  activeDbPath = join(shadowStratagateDir, 'memory.db')
  const shadowDailyDir = join(shadowStratagateDir, 'daily')
  mkdirSync(shadowStratagateDir, { recursive: true })
  if (hasRealDb) {
    for (const s of ['', '-wal', '-shm']) {
      if (existsSync(requestedRealDb + s)) cpSync(requestedRealDb + s, activeDbPath + s)
    }
    const realDailyDir = join(dirname(requestedRealDb), 'daily')
    if (existsSync(realDailyDir)) cpSync(realDailyDir, shadowDailyDir, { recursive: true })
  }
}

let workspacePath = join(tempRoot, 'DH')
let workspaceTitle = 'DH'
const userWorkspaceFile = join(homedir(), '.dsh', 'storages', 'workspace.json')
if (existsSync(userWorkspaceFile)) {
  try {
    const first = Object.values(JSON.parse(readFileSync(userWorkspaceFile, 'utf8'))?.tables?.workspaces ?? {})[0]
    if (first?.path && existsSync(first.path)) {
      workspacePath = first.path
      workspaceTitle = first.title || 'DH'
    }
  } catch {}
}
if (!existsSync(workspacePath)) mkdirSync(workspacePath, { recursive: true })

const targetNamespace = `dsh:project:${computeProjectKey(workspacePath)}`
if (!existsSync(activeDbPath)) {
  const { StrataGate } = await import('../packages/core/dist/index.js')
  const seeded = await StrataGate.open({ database: activeDbPath, namespace: targetNamespace, blockTurnSize: 2 })
  await seeded.appendTurn({ user: '梳理 StrataGate 端到端测试与 Evidence Gate 闭环方案', assistant: '已记录真实 DeepSeek Harness 会话记忆与检索门禁机制', threadId: 'seed-1' })
  await seeded.appendTurn({ user: '确认每日工作笔记与长期事件检索协同', assistant: '支持 memory_search_events 与 memory_daily_write 在同一会话内协同', threadId: 'seed-1' })
  await seeded.close()
}

const E2E_BASELINE_PREFIX = '[E2E测试] 长期记忆与跨轮引用累计基线'
const dbInspect = new DatabaseSync(activeDbPath)
const spaceBefore = dbInspect.prepare(`SELECT current_turn, revision FROM memory_spaces WHERE namespace = ?`).get(targetNamespace) || { current_turn: 0, revision: 0 }
const existingE2eEvents = dbInspect.prepare(`
  SELECT id, title, summary, mention_count, last_adopted_turn, last_retrieved_at, updated_at
  FROM agent_events
  WHERE namespace = ? AND status = 'active' AND title LIKE ?
  UNION ALL
  SELECT id, title, summary, mention_count, last_adopted_turn, last_retrieved_at, updated_at
  FROM events
  WHERE namespace = ? AND status = 'active' AND title LIKE ?
  ORDER BY updated_at DESC
`).all(targetNamespace, `${E2E_BASELINE_PREFIX}%`, targetNamespace, `${E2E_BASELINE_PREFIX}%`)
const existingE2eEvent = existingE2eEvents[0] || null
const duplicateE2eIds = existingE2eEvents.slice(1).map((e) => e.id)

let historicalEvents = dbInspect.prepare(`
  SELECT id, title, summary, mention_count, last_adopted_turn, last_retrieved_at
  FROM events
  WHERE namespace = ? AND status = 'active' AND title NOT LIKE '[E2E测试]%'
  ORDER BY mention_count DESC, updated_at DESC LIMIT 5
`).all(targetNamespace)
if (historicalEvents.length === 0) {
  historicalEvents = dbInspect.prepare(`
    SELECT id, title, summary, mention_count, last_adopted_turn, last_retrieved_at
    FROM events
    WHERE status = 'active' AND title NOT LIKE '[E2E测试]%'
    ORDER BY mention_count DESC, updated_at DESC LIMIT 5
  `).all()
}
const allEventsSnapshotBefore = dbInspect.prepare(`
  SELECT id, title, mention_count, last_adopted_turn, last_retrieved_at FROM events WHERE namespace = ?
  UNION ALL
  SELECT id, title, mention_count, last_adopted_turn, last_retrieved_at FROM agent_events WHERE namespace = ?
`).all(targetNamespace, targetNamespace)
const totalEventsBefore = Number(
  (dbInspect.prepare(`SELECT COUNT(*) AS c FROM events WHERE namespace = ? AND status = 'active'`).get(targetNamespace)?.c ?? 0)
  + (dbInspect.prepare(`SELECT COUNT(*) AS c FROM agent_events WHERE namespace = ? AND status = 'active'`).get(targetNamespace)?.c ?? 0),
)
const totalReceiptsBefore = Number(dbInspect.prepare(`SELECT COUNT(*) AS c FROM usage_receipts WHERE namespace = ?`).get(targetNamespace)?.c ?? 0)
dbInspect.close()

assert.ok(historicalEvents.length >= 1, 'Database must have at least one active historical event')
const primaryHistEvent = historicalEvents[0]
const secondaryHistEvent = historicalEvents[1] || historicalEvents[0]

const prevRunMatch = String(existingE2eEvent?.title || existingE2eEvent?.summary || '').match(/累计第\s*(\d+)\s*次/)
const cumulativeRunNumber = prevRunMatch ? Number(prevRunMatch[1]) + 1 : (existingE2eEvent ? Number(existingE2eEvent.mention_count || 1) + 1 : 1)
const expandTargetEvent = existingE2eEvent || secondaryHistEvent

const searchKeyword = 'StrataGate'
const suffix = Date.now().toString(36)
const e2eBaselineTitle = `${E2E_BASELINE_PREFIX}（累计第 ${cumulativeRunNumber} 次实测）`
const dailyNoteTitle = `[E2E测试] 长期引用与记忆演进实测 #${cumulativeRunNumber} (${suffix})`

const llmTelemetry = {
  requests: 0,
  systemPromptSawStrataGate: false,
  declaredToolNames: [],
  toolCallsIssued: [],
  toolResultsReceived: [],
  batch1Id: null,
  batch2Id: null,
  adoptedBatch1Refs: [],
  adoptedBatch2Refs: [],
  allAdoptedEventIds: [],
  e2eBaselineEventId: existingE2eEvent?.id || null,
  e2eBaselineAction: existingE2eEvent ? 'memory_update_event' : 'memory_remember',
}

function parseToolMessages(messages) {
  const results = []
  for (const msg of messages || []) {
    if (msg.role === 'tool') {
      const raw = typeof msg.content === 'string'
        ? msg.content
        : Array.isArray(msg.content) ? msg.content.map((c) => c?.text || '').join('') : ''
      let parsed = null
      try { parsed = JSON.parse(raw) } catch {}
      results.push({ tool_call_id: msg.tool_call_id, raw, parsed })
    }
  }
  return results
}

function writeSseToolCall(res, model, callId, name, argsObj) {
  const id = `chatcmpl-${randomUUID()}`
  const argsJson = JSON.stringify(argsObj)
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
  const chunks = [
    { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { role: 'assistant', content: null, tool_calls: [{ index: 0, id: callId, type: 'function', function: { name, arguments: '' } }] }, finish_reason: null }] },
    { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: argsJson } }] }, finish_reason: null }] },
    { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 120, completion_tokens: 32, total_tokens: 152 } },
  ]
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`)
  res.write('data: [DONE]\n\n')
  res.end()
}

function writeSseText(res, model, text) {
  const id = `chatcmpl-${randomUUID()}`
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
  const chunks = [
    { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] },
    { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 180, completion_tokens: 48, total_tokens: 228 } },
  ]
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`)
  res.write('data: [DONE]\n\n')
  res.end()
}

const llmServer = createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1')
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'stratagate-e2e-driver', object: 'model' }] }))
    return
  }
  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const model = body.model || 'stratagate-e2e-driver'
    const messages = body.messages || []
    const toolNames = Array.isArray(body.tools) ? body.tools.map((t) => t?.function?.name || t?.name).filter(Boolean) : []
    if (toolNames.includes('stratagate_decide_external_memory')) {
      writeSseToolCall(res, model, 'call_decider_add', 'stratagate_decide_external_memory', {
        action: 'ADD',
        existingEventIds: [],
        reason: '[E2E测试] 新增独立的端到端测试长期基线记忆。',
        confidence: 0.99,
      })
      return
    }
    const hasMemoryTools = Array.isArray(body.tools) && body.tools.some((t) => (t?.function?.name || t?.name) === 'memory_search_events')
    if (!hasMemoryTools) {
      writeSseText(res, model, `[E2E测试] 长期记忆引用演进 #${cumulativeRunNumber}`)
      return
    }
    llmTelemetry.requests += 1
    const sysText = messages.filter((m) => m.role === 'system' || m.role === 'developer')
      .map((m) => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n')
    if (sysText.includes('memory_search_events') || sysText.includes('StrataGate') || sysText.includes('Evidence Gate')) {
      llmTelemetry.systemPromptSawStrataGate = true
    }
    llmTelemetry.declaredToolNames = (body.tools || []).map((t) => t?.function?.name || t?.name).filter(Boolean)
    const toolResults = parseToolMessages(messages)
    llmTelemetry.toolResultsReceived = toolResults.map((r) => ({ tool_call_id: r.tool_call_id, keys: r.parsed ? Object.keys(r.parsed) : [] }))

    if (toolResults.length === 0) {
      llmTelemetry.toolCallsIssued.push('memory_search_events')
      writeSseToolCall(res, model, 'call_search_1', 'memory_search_events', { query: searchKeyword, limit: 6 })
      return
    }
    if (toolResults.length === 1) {
      const s = toolResults[0].parsed || {}
      const batchId = s.batchId
      const items = Array.isArray(s.results) ? s.results : Array.isArray(s.events) ? s.events : Array.isArray(s.items) ? s.items : []
      const picked = items
        .filter((it) => (it?.id || it?.evidenceRef) && String(it?.id || '') !== String(expandTargetEvent.id))
        .slice(0, 2)
      if (picked.length === 0 && items[0]) picked.push(items[0])
      const refs = picked.map((it) => it?.evidenceRef || `event:${it.id}`)
      llmTelemetry.batch1Id = batchId
      llmTelemetry.adoptedBatch1Refs = refs
      llmTelemetry.toolCallsIssued.push('memory_assess')
      writeSseToolCall(res, model, 'call_assess_2', 'memory_assess', {
        batch_id: batchId,
        verdict: 'sufficient',
        evidence_refs: refs,
        fit: '[E2E测试] 第一批检索命中真实历史项目事件，继续展开长期记忆详情以完成跨轮多记忆协同引用。',
        missing: 'none',
        next_strategy: 'answer',
      })
      return
    }
    if (toolResults.length === 2) {
      llmTelemetry.toolCallsIssued.push('memory_record_use')
      writeSseToolCall(res, model, 'call_record_3', 'memory_record_use', {
        batch_id: llmTelemetry.batch1Id,
        evidence_refs: llmTelemetry.adoptedBatch1Refs,
      })
      return
    }
    if (toolResults.length === 3) {
      llmTelemetry.toolCallsIssued.push('memory_expand_event')
      writeSseToolCall(res, model, 'call_expand_4', 'memory_expand_event', {
        id: expandTargetEvent.id,
      })
      return
    }
    if (toolResults.length === 4) {
      const expanded = toolResults[3].parsed || {}
      const batch2Id = expanded.batchId
      const expRefs = Array.isArray(expanded.evidenceRefs) && expanded.evidenceRefs.length > 0
        ? [expanded.evidenceRefs[0]]
        : [`event:${expandTargetEvent.id}`]
      llmTelemetry.batch2Id = batch2Id
      llmTelemetry.adoptedBatch2Refs = expRefs
      llmTelemetry.toolCallsIssued.push('memory_assess')
      writeSseToolCall(res, model, 'call_assess_5', 'memory_assess', {
        batch_id: batch2Id,
        verdict: 'sufficient',
        evidence_refs: expRefs,
        fit: '[E2E测试] 第二批完整展开目标长期事件卡片，与第一批历史记忆共同构成跨轮引用证据。',
        missing: 'none',
        next_strategy: 'answer',
      })
      return
    }
    if (toolResults.length === 5) {
      llmTelemetry.toolCallsIssued.push('memory_record_use')
      writeSseToolCall(res, model, 'call_record_6', 'memory_record_use', {
        batch_id: llmTelemetry.batch2Id,
        evidence_refs: llmTelemetry.adoptedBatch2Refs,
      })
      return
    }
    if (toolResults.length === 6) {
      const allRefs = [...new Set([...llmTelemetry.adoptedBatch1Refs, ...llmTelemetry.adoptedBatch2Refs])]
      llmTelemetry.allAdoptedEventIds = allRefs.map((r) => r.replace(/^event:/, ''))
      const summaryText = `[E2E测试] 长期记忆与跨轮引用累计基线（累计第 ${cumulativeRunNumber} 次实测）：直接在真实 memory.db 上完成 2 轮检索与展开（memory_search_events + memory_expand_event），同时正式引用 ${allRefs.length} 条长期记忆（${allRefs.join('、')}），验证跨会话引用计数（mention_count）持续累加与长期记忆演进。`
      if (existingE2eEvent) {
        llmTelemetry.toolCallsIssued.push('memory_update_event')
        writeSseToolCall(res, model, 'call_evolve_7', 'memory_update_event', {
          id: existingE2eEvent.id,
          title: e2eBaselineTitle,
          summary: summaryText,
          ...(duplicateE2eIds.length > 0 ? { supersedesEventIds: duplicateE2eIds } : {}),
          user_authorized: true,
        })
      } else {
        llmTelemetry.toolCallsIssued.push('memory_remember')
        writeSseToolCall(res, model, 'call_remember_7', 'memory_remember', {
          content: summaryText,
          category: 'fact',
        })
      }
      return
    }
    if (toolResults.length === 7) {
      const memRes = toolResults[6].parsed || {}
      if (memRes?.event?.id || memRes?.id) {
        llmTelemetry.e2eBaselineEventId = memRes?.event?.id || memRes?.id
      }
      const allRefs = [...new Set([...llmTelemetry.adoptedBatch1Refs, ...llmTelemetry.adoptedBatch2Refs])]
      const dailyNoteBody = `[E2E测试] 已在真实 DeepSeek Harness 原生记忆库完成第 ${cumulativeRunNumber} 次跨轮实测：通过 2 个检索批次（搜索 + 详情展开）正式采用 ${allRefs.length} 条长期记忆（${allRefs.join('、')}），各条记忆引用计数（mention_count）均已 +1，并同步演进长期测试基线记忆「${e2eBaselineTitle}」（ID: ${llmTelemetry.e2eBaselineEventId || 'created'}）。`
      llmTelemetry.toolCallsIssued.push('memory_daily_write')
      writeSseToolCall(res, model, 'call_daily_8', 'memory_daily_write', {
        title: dailyNoteTitle,
        content: dailyNoteBody,
      })
      return
    }
    const allRefs = [...new Set([...llmTelemetry.adoptedBatch1Refs, ...llmTelemetry.adoptedBatch2Refs])]
    writeSseText(
      res,
      model,
      `[E2E测试] 已在真实 DeepSeek Harness 原生记忆库上完成第 ${cumulativeRunNumber} 次长期记忆与跨轮引用实测：\n1. 跨 2 轮检索与卡片展开，正式引用了 ${allRefs.length} 条长期记忆（${allRefs.join('、')}），对应记忆的引用次数均已真实累加；\n2. 长期测试基线记忆已演进为「${e2eBaselineTitle}」；\n3. 今日工作笔记已写入「${dailyNoteTitle}」。`,
    )
    return
  }
  res.writeHead(404)
  res.end()
})

await new Promise((r) => llmServer.listen(0, '127.0.0.1', r))
const llmPort = llmServer.address().port

const webProfileDir = join(dshHome, 'profiles', 'web')
const webProfileModules = join(webProfileDir, 'node_modules')
mkdirSync(webProfileModules, { recursive: true })
symlinkSync(root, join(webProfileModules, 'stratagate-dsh'), process.platform === 'win32' ? 'junction' : 'dir')

writeFileSync(
  join(webProfileDir, 'package.json'),
  JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dependencies: { 'stratagate-dsh': `file:${root.replaceAll('\\', '/')}` },
    dsh: {
      profile: {
        patchReload: 'startup',
        bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'stratagate-dsh'],
      },
    },
  }, null, 2),
)
writeFileSync(join(webProfileDir, 'cordis.yml'), '[]\n')
writeFileSync(
  join(webProfileDir, 'cordis.patch.yml'),
  [
    '- id: ui-settings-account',
    '  name: "@deepseek-ai/dsh-client-ui-settings-account"',
    '  config:',
    '    version: 1',
    '    step: done',
    '    purpose: development',
    '    process: standard',
    '    completion: completed',
    '    usage: detailed',
    '    developerTools: true',
    '- id: stratagate-memory',
    '  name: stratagate-dsh',
    '  config:',
    `    database: ${JSON.stringify(activeDbPath.replaceAll('\\', '/'))}`,
    "    sessionRoot: !!js dshHomePath('sessions')",
    '    namespaceMode: project',
    '    blockTurnSize: 6',
    '    agentMemoryEnabled: true',
    '    dailyNotesInjectionDays: 3',
    '    showShortTermStatus: true',
    '    showSidebarEntry: true',
    '- id: llm-pi-ai',
    '  name: "@deepseek-ai/dsh-llm-pi-ai"',
    '  config:',
    '    providers:',
    '      e2e-driver:',
    '        displayName: StrataGate E2E Driver',
    '        apiKeyEnv: STRATAGATE_E2E_LLM_KEY',
    '        api: openai-completions',
    `        baseURL: http://127.0.0.1:${llmPort}/v1`,
    '        models:',
    '          - id: stratagate-e2e-driver',
    '            name: StrataGate E2E Driver',
    '            contextWindow: 200000',
    '            maxTokens: 32000',
    '            input: [text]',
    '- id: agent-default-model',
    '  config:',
    '    provider: e2e-driver',
    '    model: stratagate-e2e-driver',
    '',
  ].join('\n'),
)

const dshLogs = []
const dshNodeExecPath = resolveDshNodeExecPath()
const dshChild = spawn(
  dshNodeExecPath,
  [
    '--input-type=module',
    '-e',
    "import { runCli } from './node_modules/@deepseek-ai/dsh/lib/bin.js'; await runCli();",
    'dsh',
    '--profile',
    'web',
    '--port',
    '0',
    '--no-open',
  ],
  {
  cwd: root,
  env: {
    ...process.env,
    DSH_HOME: dshHome,
    DSH_TELEMETRY_DISABLED: '1',
    STRATAGATE_E2E_LLM_KEY: 'e2e-local-driver-key',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  },
)

let browser
let startupTimer
try {
  const launchUrl = await new Promise((resolveReady, rejectReady) => {
    const onChunk = (chunk) => {
      dshLogs.push(chunk.toString())
      const match = dshLogs.join('').match(/https?:\/\/(?:127\.0\.0\.1|localhost):\d+\/?\?token=[A-Za-z0-9_-]+/)
      if (match) resolveReady(match[0])
    }
    dshChild.stdout.on('data', onChunk)
    dshChild.stderr.on('data', onChunk)
    dshChild.once('exit', (code) => rejectReady(new Error(`DSH Web exited ${code}\n${dshLogs.join('')}`)))
    startupTimer = setTimeout(() => rejectReady(new Error(`DSH Web startup timed out\n${dshLogs.join('')}`)), 90_000)
  })
  clearTimeout(startupTimer)

  browser = await chromium.launch(resolveBrowserLaunchOptions())
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, locale: 'zh-CN', colorScheme: 'light' })
  const page = await context.newPage()
  const pageErrors = []
  page.on('pageerror', (err) => pageErrors.push(String(err?.message || err)))
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') dshLogs.push(`[browser:${msg.type()}] ${msg.text()}\n`)
  })

  await page.goto(launchUrl, { waitUntil: 'domcontentloaded' })
  const clickIfShown = async (locator, timeout = 2500) => {
    try { await locator.waitFor({ state: 'visible', timeout }); await locator.click() } catch {}
  }
  await clickIfShown(page.getByRole('button', { name: '继续', exact: true }))
  await clickIfShown(page.getByRole('button', { name: '稍后配置' }))

  const wsCreated = await page.evaluate(async (path) => {
    const rpcId = crypto.randomUUID()
    const r = await fetch('/api/workspace/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method: 'workspace/create', payload: { args: { request: { path } } } }),
    })
    return await r.json()
  }, workspacePath)
  assert.equal(wsCreated?.result?.ok, true, `workspace/create failed: ${JSON.stringify(wsCreated)}`)

  const chooseWsBtn = page.getByRole('button', { name: /选择工作区|Choose workspace/ }).first()
  await chooseWsBtn.waitFor({ state: 'visible', timeout: 15_000 })
  await page.waitForTimeout(500)
  if (((await chooseWsBtn.textContent()) || '').trim() !== workspaceTitle) {
    await chooseWsBtn.click()
    await page.waitForTimeout(500)
    const menuChoice = page.locator('button').filter({ hasText: new RegExp(`^\\s*${workspaceTitle}\\s*$`) }).first()
    await menuChoice.waitFor({ state: 'visible', timeout: 10_000 })
    await menuChoice.click()
  }

  const editor = page.locator('[data-composer-card] [contenteditable="true"]').first()
  await editor.waitFor({ state: 'visible', timeout: 20_000 })
  await editor.click()
  const userPrompt = `[E2E测试] 请执行第 ${cumulativeRunNumber} 次长期记忆与跨轮引用实测：检索关于 ${searchKeyword} 的历史事件记忆并展开目标记忆卡（${expandTargetEvent.id}），按 Evidence Gate 正式引用多条记忆后，授权更新长期测试基线记忆「${e2eBaselineTitle}」并写入今日工作笔记「${dailyNoteTitle}」。`
  await page.keyboard.insertText(userPrompt)
  const sendBtn = page.getByRole('button', { name: /发送消息|Send message/ }).first()
  await sendBtn.waitFor({ state: 'visible', timeout: 10_000 })
  await sendBtn.click()

  await page.getByText(`完成第 ${cumulativeRunNumber} 次长期记忆与跨轮引用实测`).first().waitFor({ state: 'visible', timeout: 45_000 })
  const citationBar = page.locator('[data-testid="stratagate-answer-citations"]')
  await citationBar.waitFor({ state: 'visible', timeout: 45_000 })
  const citationText = (await citationBar.textContent()) || ''
  const expectedCitationCount = new Set([...llmTelemetry.adoptedBatch1Refs, ...llmTelemetry.adoptedBatch2Refs]).size
  assert.ok(
    citationText.includes(`本回答采用了 ${expectedCitationCount} 条记忆`),
    `Expected citation bar to show ${expectedCitationCount} adopted memories, got: ${citationText}`,
  )

  const processLink = citationBar.locator('.sg-answer-process-link')
  if ((await processLink.count()) > 0) {
    await processLink.click()
    await citationBar.locator('.sg-retrieved-panel').waitFor({ state: 'visible', timeout: 10_000 })
  }
  const chatScreenshot = join(outputDir, '01-dsh-chat-answer-citations.png')
  await page.screenshot({ path: chatScreenshot, fullPage: true })

  const firstCitationChip = citationBar.locator('.sg-answer-citation').first()
  await firstCitationChip.click()
  const citationDialog = page.locator('.sg-citation-dialog')
  await citationDialog.waitFor({ state: 'visible', timeout: 10_000 })
  const dialogScreenshot = join(outputDir, '02-dsh-chat-citation-dialog.png')
  await page.screenshot({ path: dialogScreenshot, fullPage: true })
  await page.keyboard.press('Escape')

  const sidebarEntry = page.getByRole('button', { name: /StrataGate 记忆|StrataGate-AgentMemory/ }).first()
  if (await sidebarEntry.isVisible().catch(() => false)) {
    await sidebarEntry.click()
  } else {
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('button', { name: 'StrataGate-AgentMemory' }).first().click()
  }
  const sgTabs = page.locator('.sg-tabs').first()
  await sgTabs.waitFor({ state: 'visible', timeout: 15_000 })

  await sgTabs.locator('button').filter({ hasText: '长期记忆' }).click()
  const sgView = page.locator('.sg-view').first()
  await sgView.locator('[data-testid="stratagate-topic-directory"]').waitFor({ state: 'visible', timeout: 15_000 })
  let foundBaselineInBook = false
  const candidateSections = sgView.locator('button.sg-topic-section-toggle[title="功能实测与实验设计"]')
  const candidateCount = await candidateSections.count()
  for (let i = candidateCount - 1; i >= 0; i--) {
    const sec = candidateSections.nth(i)
    if (await sec.isVisible().catch(() => false)) {
      await sec.click()
      try {
        await sgView.getByText(e2eBaselineTitle).first().waitFor({ state: 'visible', timeout: 5000 })
        foundBaselineInBook = true
        break
      } catch {}
    }
  }
  if (!foundBaselineInBook) {
    const pendingToggle = sgView.locator('.sg-topic-pending-toggle').first()
    if (await pendingToggle.isVisible().catch(() => false)) {
      if ((await pendingToggle.getAttribute('aria-expanded')) !== 'true') {
        await pendingToggle.click()
      }
      try {
        await sgView.getByText(e2eBaselineTitle).first().waitFor({ state: 'visible', timeout: 4000 })
        foundBaselineInBook = true
      } catch {
        const showAllPending = sgView.locator('.sg-topic-pending .sg-topic-show-all').first()
        if (await showAllPending.isVisible().catch(() => false)) {
          await showAllPending.click()
          try {
            await sgView.getByText(e2eBaselineTitle).first().waitFor({ state: 'visible', timeout: 6000 })
            foundBaselineInBook = true
          } catch {}
        }
      }
    }
  }
  if (!foundBaselineInBook) {
    const sections = sgView.locator('button.sg-topic-section-toggle')
    const count = await sections.count()
    for (let i = count - 1; i >= 0; i--) {
      await sections.nth(i).click()
      try {
        await sgView.getByText(e2eBaselineTitle).first().waitFor({ state: 'visible', timeout: 2500 })
        foundBaselineInBook = true
        break
      } catch {}
    }
  }
  const baselineLocator = sgView.getByText(e2eBaselineTitle).first()
  await baselineLocator.waitFor({ state: 'visible', timeout: 15_000 })
  await baselineLocator.scrollIntoViewIfNeeded()
  await page.waitForTimeout(300)
  const bookLayout = await sgView.evaluate((rootEl) => {
    const openBodies = [...rootEl.querySelectorAll('.sg-topic-directory .sg-directory-fold.open > .sg-directory-fold-inner > .sg-topic-section-body')]
    const visibleBodies = openBodies.filter((el) => el.getBoundingClientRect().height > 0 && el.getBoundingClientRect().width > 0)
    const chapterRows = [...rootEl.querySelectorAll('.sg-topic-directory .sg-topic-chapter-toggle')]
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
  assert.ok(bookLayout.visibleBodyCount <= 1, `Expected at most 1 open topic section body, got ${bookLayout.visibleBodyCount}`)
  assert.deepEqual(bookLayout.overlaps, [], `Book layout overlap detected: ${JSON.stringify(bookLayout.overlaps)}`)
  const longTermScreenshot = join(outputDir, '03-dsh-long-term-memory-verified.png')
  await page.screenshot({ path: longTermScreenshot, fullPage: true })

  await sgTabs.locator('button').filter({ hasText: '短期记忆' }).click()
  const todayDayButton = sgView.locator('.sg-day-d').first()
  await todayDayButton.waitFor({ state: 'visible', timeout: 15_000 })
  await todayDayButton.click()
  await sgView.locator('#sg-day-note').waitFor({ state: 'visible', timeout: 15_000 })
  const dailyNoteLocator = sgView.getByText(dailyNoteTitle).first()
  await dailyNoteLocator.waitFor({ state: 'visible', timeout: 20_000 })
  await dailyNoteLocator.scrollIntoViewIfNeeded()
  await page.waitForTimeout(300)
  const dailyScreenshot = join(outputDir, '04-dsh-settings-daily-note-verified.png')
  await page.screenshot({ path: dailyScreenshot, fullPage: true })

  const dbAfter = new DatabaseSync(activeDbPath)
  const spaceAfter = dbAfter.prepare(`SELECT current_turn, revision FROM memory_spaces WHERE namespace = ?`).get(targetNamespace) || { current_turn: 0, revision: 0 }
  const totalEventsAfter = Number(
    (dbAfter.prepare(`SELECT COUNT(*) AS c FROM events WHERE namespace = ? AND status = 'active'`).get(targetNamespace)?.c ?? 0)
    + (dbAfter.prepare(`SELECT COUNT(*) AS c FROM agent_events WHERE namespace = ? AND status = 'active'`).get(targetNamespace)?.c ?? 0),
  )
  const totalReceiptsAfter = Number(dbAfter.prepare(`SELECT COUNT(*) AS c FROM usage_receipts WHERE namespace = ?`).get(targetNamespace)?.c ?? 0)
  const queryEventById = dbAfter.prepare(`
    SELECT id, title, mention_count, last_adopted_turn, last_retrieved_at FROM events WHERE id = ?
    UNION ALL
    SELECT id, title, mention_count, last_adopted_turn, last_retrieved_at FROM agent_events WHERE id = ?
    LIMIT 1
  `)
  const beforeById = new Map(allEventsSnapshotBefore.map((e) => [e.id, e]))
  const citationGrowth = []
  for (const eventId of llmTelemetry.allAdoptedEventIds) {
    const afterRow = queryEventById.get(eventId, eventId)
    const beforeRow = beforeById.get(eventId)
    if (afterRow) {
      if (beforeRow) {
        assert.ok(
          Number(afterRow.mention_count) >= Number(beforeRow.mention_count) + 1,
          `Expected mention_count for ${eventId} to increase from ${beforeRow.mention_count}, got ${afterRow.mention_count}`,
        )
      }
      citationGrowth.push({
        id: afterRow.id,
        title: afterRow.title,
        mentionCountBefore: beforeRow ? Number(beforeRow.mention_count) : null,
        mentionCountAfter: Number(afterRow.mention_count),
        lastAdoptedTurnBefore: beforeRow ? beforeRow.last_adopted_turn : null,
        lastAdoptedTurnAfter: afterRow.last_adopted_turn,
        lastRetrievedAt: afterRow.last_retrieved_at,
      })
    }
  }
  const latestE2eBaseline = dbAfter.prepare(`
    SELECT id, title, summary, mention_count, last_adopted_turn, updated_at, status
    FROM agent_events
    WHERE namespace = ? AND status = 'active' AND title LIKE ?
    UNION ALL
    SELECT id, title, summary, mention_count, last_adopted_turn, updated_at, status
    FROM events
    WHERE namespace = ? AND status = 'active' AND title LIKE ?
    ORDER BY updated_at DESC LIMIT 1
  `).get(targetNamespace, `${E2E_BASELINE_PREFIX}%`, targetNamespace, `${E2E_BASELINE_PREFIX}%`)
  dbAfter.close()

  assert.ok(latestE2eBaseline, 'Expected [E2E测试] baseline event to exist in database')
  assert.ok(totalReceiptsAfter >= totalReceiptsBefore + 2, `Expected at least 2 new usage_receipts rows (${totalReceiptsBefore} -> ${totalReceiptsAfter})`)
  assert.equal(pageErrors.length, 0, `Page errors occurred: ${pageErrors.join('; ')}`)
  assert.equal(llmTelemetry.systemPromptSawStrataGate, true, 'System prompt did not include StrataGate memory instructions')

  const syncedSessions = []
  const archivedSessions = []
  if (dbMode === 'live') {
    try {
      const realDshHome = join(homedir(), '.dsh')
      const tempSessionsRoot = join(dshHome, 'sessions')
      const realSessionsRoot = join(realDshHome, 'sessions')
      const tempProjCacheDir = join(dshHome, 'storages', 'session_projcache', 'sessions')
      const realProjCacheDir = join(realDshHome, 'storages', 'session_projcache', 'sessions')
      const normWorkspacePath = resolve(workspacePath).replace(/\\/g, '/').toLowerCase()
      const readCacheMeta = (cacheDir, sid) => {
        const file = join(cacheDir, `${sid}.json`)
        if (!existsSync(file)) return null
        try {
          const data = JSON.parse(readFileSync(file, 'utf8'))
          return {
            cwd: data?.record?.identity?.cwd ? resolve(data.record.identity.cwd).replace(/\\/g, '/').toLowerCase() : '',
            title: data?.record?.rows?.title?.val ?? null,
          }
        } catch {
          return null
        }
      }
      if (existsSync(tempSessionsRoot) && existsSync(realSessionsRoot)) {
        for (const cwdBucket of readdirSync(tempSessionsRoot)) {
          if (cwdBucket === '_no-cwd') continue
          const srcBucket = join(tempSessionsRoot, cwdBucket)
          const dstBucket = join(realSessionsRoot, cwdBucket)
          for (const sessionEntry of readdirSync(srcBucket)) {
            if (!sessionEntry.startsWith('session-')) continue
            const meta = existsSync(tempProjCacheDir) ? readCacheMeta(tempProjCacheDir, sessionEntry) : null
            if (!meta || meta.cwd !== normWorkspacePath || !meta.title) continue
            mkdirSync(dstBucket, { recursive: true })
            cpSync(join(srcBucket, sessionEntry), join(dstBucket, sessionEntry), { recursive: true, force: true })
            if (existsSync(tempProjCacheDir) && existsSync(realProjCacheDir)) {
              const cacheFile = `${sessionEntry}.json`
              if (existsSync(join(tempProjCacheDir, cacheFile))) {
                cpSync(join(tempProjCacheDir, cacheFile), join(realProjCacheDir, cacheFile), { force: true })
              }
            }
            syncedSessions.push(sessionEntry)
          }
        }
      }
      const realWorkspaceJsonPath = join(realDshHome, 'storages', 'workspace.json')
      if (existsSync(realWorkspaceJsonPath)) {
        const wsData = JSON.parse(readFileSync(realWorkspaceJsonPath, 'utf8'))
        wsData.global = wsData.global && typeof wsData.global === 'object' ? wsData.global : {}
        const existingArchived = Array.isArray(wsData.global.archivedSessionIds) ? wsData.global.archivedSessionIds : []
        const pinnedSet = new Set(Array.isArray(wsData.global.pinnedSessionIds) ? wsData.global.pinnedSessionIds : [])
        const e2eToArchive = new Set([...existingArchived, ...syncedSessions])
        const workspaces = wsData?.tables?.workspaces || {}
        for (const ws of Object.values(workspaces)) {
          if (ws && (ws.path === workspacePath || ws.title === workspaceTitle) && Array.isArray(ws.sessionIds)) {
            const cleanedIds = ws.sessionIds.filter((sid) => {
              const meta = existsSync(realProjCacheDir) ? readCacheMeta(realProjCacheDir, sid) : null
              if (meta && meta.cwd && meta.cwd !== normWorkspacePath && !meta.title) return false
              if (meta && typeof meta.title === 'string' && meta.title.startsWith('[E2E测试]')) {
                e2eToArchive.add(sid)
              }
              return true
            })
            ws.sessionIds = [...new Set([...syncedSessions, ...cleanedIds])]
            ws.updatedAt = new Date().toISOString()
          }
        }
        wsData.global.archivedSessionIds = [...e2eToArchive].filter((sid) => !pinnedSet.has(sid))
        archivedSessions.push(...syncedSessions.filter((sid) => !pinnedSet.has(sid)))
        writeFileSync(realWorkspaceJsonPath, JSON.stringify(wsData, null, 2))
      }
    } catch (err) {
      dshLogs.push(`[session-sync-warn] ${String(err?.message || err)}\n`)
    }
  }

  const report = {
    status: 'passed',
    dbMode,
    activeDbPath,
    backupPath,
    hasRealDb,
    workspacePath,
    targetNamespace,
    cumulativeRunNumber,
    syncedSessions,
    archivedSessions,
    turns: { before: spaceBefore.current_turn, after: spaceAfter.current_turn },
    activeEventsCount: { before: totalEventsBefore, after: totalEventsAfter },
    usageReceiptsCount: { before: totalReceiptsBefore, after: totalReceiptsAfter },
    citationGrowth,
    e2eBaselineEvent: latestE2eBaseline,
    dailyNoteTitle,
    llmTelemetry,
    screenshots: [chatScreenshot, dialogScreenshot, longTermScreenshot, dailyScreenshot],
  }
  writeFileSync(join(outputDir, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
} finally {
  clearTimeout(startupTimer)
  if (browser) await browser.close().catch(() => {})
  llmServer.close()
  if (dshChild.exitCode === null && dshChild.signalCode === null) {
    dshChild.kill()
    await Promise.race([once(dshChild, 'exit'), new Promise((r) => setTimeout(r, 4000))])
  }
  try { rmSync(tempRoot, { recursive: true, force: true }) } catch {}
}
