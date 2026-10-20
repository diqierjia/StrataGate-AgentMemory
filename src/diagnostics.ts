import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import type { GenerateOptions, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'

const DAY = 86_400_000
const VERSION = (() => { try { return String(createRequire(import.meta.url)('../package.json').version) } catch { return 'unknown' } })()
export const DIAGNOSTIC_STAGES = ['summarizer', 'extractor', 'projector', 'graphProjector', 'topicProjector', 'externalMemoryExtractor', 'externalMemoryDecider', 'profileMaintenance', 'dreamingStep', 'eventDuplicateDecider', 'chat', 'ingestion', 'autoContext', 'directory', 'tools', 'frontend', 'retrieval'] as const
export type DiagnosticStage = typeof DIAGNOSTIC_STAGES[number]
type Counters = Record<string, number>
export interface DiagnosticScope { namespace: string; stage: DiagnosticStage; taskId?: string; calls?: number; memoryInputEstimate?: number }
interface Observation {
  id: string; at: string; namespace: string; stage: DiagnosticStage; model: string; version: string
  counters: Counters; category?: string; detail?: string; taskId?: string
}

/** Redact before persistence as well as before rendering. Reports default to categories. */
export function diagnosticText(value: unknown, limit = 1500): string {
  return String(value instanceof Error ? value.message : value ?? '').slice(0, 8000)
    .split(/\nRaw response(?: preview| \(full\))/i)[0]!
    .replace(/\b(?:sk[-_]|gh[opasu]_|github_pat_)[A-Za-z0-9_-]{8,}\b/g, '[credential]')
    .replace(/(["']?\b(?:api[_-]?key|token|password|passwd|secret|authorization|access[_-]?token|refresh[_-]?token)["']?\s*[:=]\s*)(["'])([\s\S]*?)\2/gi, '$1[credential]')
    .replace(/\b(?:Bearer|Basic|Token)\s+[^\s,;}]+/gi, '[credential]')
    .replace(/\b(?:api[_-]?key|token|password|passwd|secret|authorization)\s*[:=]\s*[^\s,;}]+/gi, '[credential]')
    .replace(/https?:\/\/[^\s<>"']+/gi, '[url]')
    .replace(/[A-Z]:[\\/][^\s"'<>]+/gi, '[path]')
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '[email]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .slice(0, limit).replace(/[\uD800-\uDBFF]$/, '')
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && ((error as { name?: unknown }).name === 'AbortError' || (error as { code?: unknown }).code === 'ABORT_ERR')
}

export function diagnosticCategory(error: unknown): string {
  if (isAbortError(error)) return 'cancelled'
  const text = String(error instanceof Error ? error.message : error ?? '')
  if (/timeout|timed out|超时/i.test(text)) return 'timeout'
  if (/429|rate.?limit/i.test(text)) return 'rate-limit'
  if (/401|403|unauthori|forbidden|credential/i.test(text)) return 'authentication'
  if (/token.*limit|truncat|max-tokens|context.*(window|length|limit)/i.test(text)) return 'token-limit'
  if (/json|schema|invalid|validation/i.test(text)) return 'validation'
  if (/sqlite|database|storage|EACCES|ENOSPC|write failed/i.test(text)) return 'storage'
  if (/abort|cancel/i.test(text)) return 'cancelled'
  if (/network|fetch|ECONN|ENOTFOUND/i.test(text)) return 'network'
  return 'internal'
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS stratagate_dsh_diagnostic_records (
 id TEXT PRIMARY KEY, at TEXT NOT NULL, namespace TEXT NOT NULL, record_json TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS stratagate_dsh_diagnostic_scope ON stratagate_dsh_diagnostic_records(namespace, at);
CREATE TABLE IF NOT EXISTS stratagate_dsh_diagnostic_daily (
 namespace TEXT NOT NULL, day TEXT NOT NULL, stage TEXT NOT NULL, model TEXT NOT NULL,
 version TEXT NOT NULL, counters_json TEXT NOT NULL,
 PRIMARY KEY(namespace, day, stage, model, version)
) STRICT;
CREATE TABLE IF NOT EXISTS stratagate_dsh_diagnostic_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
`

/** Bounded local operational data, separate from semantic memories and snapshot saves. */
export class DiagnosticsRecorder {
  private database: DatabaseSync | undefined
  private pending: Observation[] = []
  private timer: ReturnType<typeof setTimeout> | undefined
  private closed = false
  private dropped = 0
  private writeFailures = 0
  private readonly startedAt = new Date().toISOString()
  constructor(private readonly filename: string) {}

  record(scope: DiagnosticScope, counters: Counters, options: { model?: string; error?: unknown } = {}): void {
    if (this.closed) return
    const bounded = Object.fromEntries(Object.entries(counters).filter(([, n]) => Number.isFinite(n) && n >= 0))
    this.pending.push({ id: `diag_${randomUUID()}`, at: new Date().toISOString(), namespace: scope.namespace,
      stage: scope.stage, model: diagnosticText(options.model ?? '', 160), version: VERSION,
      counters: bounded, ...(scope.taskId ? { taskId: scope.taskId } : {}),
      ...(options.error !== undefined ? { category: diagnosticCategory(options.error), detail: diagnosticText(options.error) } : {}) })
    if (this.pending.length > 256) { this.pending.shift(); this.dropped++ }
    if (!this.timer) {
      this.timer = setTimeout(() => { this.timer = undefined; this.flush() }, 5000)
      this.timer.unref?.()
    }
  }

  private open(): DatabaseSync {
    if (this.database) return this.database
    const db = new DatabaseSync(this.filename)
    try {
      // Never wait for a contending writer on the user-facing path.
      db.exec('PRAGMA busy_timeout=0')
      db.exec(SCHEMA)
      db.prepare("INSERT OR IGNORE INTO stratagate_dsh_diagnostic_meta VALUES ('startedAt', ?)").run(this.startedAt)
      this.database = db
      return db
    } catch (error) { db.close(); throw error }
  }

  flush(): void {
    if (!this.pending.length) return
    try {
      const db = this.open()
      db.exec('BEGIN IMMEDIATE')
      try {
        const get = db.prepare('SELECT counters_json FROM stratagate_dsh_diagnostic_daily WHERE namespace=? AND day=? AND stage=? AND model=? AND version=?')
        const put = db.prepare('INSERT OR REPLACE INTO stratagate_dsh_diagnostic_daily VALUES (?, ?, ?, ?, ?, ?)')
        const insert = db.prepare('INSERT INTO stratagate_dsh_diagnostic_records VALUES (?, ?, ?, ?)')
        for (const item of this.pending) {
          const keys = [item.namespace, item.at.slice(0, 10), item.stage, item.model, item.version]
          const row = get.get(...keys) as { counters_json: string } | undefined
          const counters = row ? JSON.parse(row.counters_json) as Counters : {}
          for (const [key, value] of Object.entries(item.counters)) counters[key] = (counters[key] ?? 0) + value
          put.run(...keys, JSON.stringify(counters))
          insert.run(item.id, item.at, item.namespace, JSON.stringify(item))
        }
        db.prepare('DELETE FROM stratagate_dsh_diagnostic_records WHERE at < ? OR id NOT IN (SELECT id FROM stratagate_dsh_diagnostic_records ORDER BY at DESC, id DESC LIMIT 2000)').run(new Date(Date.now() - 7 * DAY).toISOString())
        db.prepare('DELETE FROM stratagate_dsh_diagnostic_daily WHERE day < ?').run(new Date(Date.now() - 90 * DAY).toISOString().slice(0, 10))
        db.exec('DELETE FROM stratagate_dsh_diagnostic_daily WHERE rowid NOT IN (SELECT rowid FROM stratagate_dsh_diagnostic_daily ORDER BY day DESC LIMIT 10000)')
        db.exec('COMMIT')
        this.pending = []
      } catch (error) { db.exec('ROLLBACK'); throw error }
    } catch { this.writeFailures++ /* Collection must never fail a chat or memory task. */ }
  }

  snapshot(namespace: string, options: { id?: string; offset?: number; details?: boolean } = {}) {
    this.flush()
    const today = new Date().toISOString().slice(0, 10)
    // Seven UTC calendar days, including today. Daily rollups use the same bounds.
    const since = new Date(Date.parse(today) - 6 * DAY).toISOString().slice(0, 10)
    const totals: Counters = {}
    const stages: Record<string, Counters> = {}
    let startedAt = this.startedAt
    let available = false
    let rows: Array<{ day: string; stage: string; model: string; version: string; counters_json: string }> = []
    let records: Observation[] = []
    let totalRecords = 0
    let corruptRollups = 0
    let corruptRecords = 0
    let scannedRecords = 0
    const offset = Math.max(0, Math.min(2000, Math.floor(options.offset ?? 0)))
    const readCounters = (text: string): Counters => {
      try {
        const value: unknown = JSON.parse(text)
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid counters')
        const entries = Object.entries(value)
        if (entries.some(([, n]) => typeof n !== 'number' || !Number.isFinite(n) || n < 0)) throw new Error('Invalid counter value')
        return Object.fromEntries(entries) as Counters
      } catch { corruptRollups++; return {} }
    }
    try {
      const db = this.open()
      available = true
      startedAt = (db.prepare("SELECT value FROM stratagate_dsh_diagnostic_meta WHERE key='startedAt'").get() as { value: string }).value
      rows = db.prepare('SELECT day, stage, model, version, counters_json FROM stratagate_dsh_diagnostic_daily WHERE namespace=? AND day>=? ORDER BY day, stage, model, version LIMIT 2001').all(namespace, since) as typeof rows
      const where = options.id ? 'namespace=? AND id=?' : "namespace=? AND at>=? AND json_extract(record_json, '$.category') IS NOT NULL"
      const values = options.id ? [namespace, options.id] : [namespace, since]
      totalRecords = Number((db.prepare(`SELECT count(*) AS count FROM stratagate_dsh_diagnostic_records WHERE ${where}`).get(...values) as { count: number }).count)
      const raw = db.prepare(`SELECT record_json FROM stratagate_dsh_diagnostic_records WHERE ${where} ORDER BY at DESC, id DESC LIMIT 20 OFFSET ?`).all(...values, offset) as Array<{ record_json: string }>
      scannedRecords = raw.length
      for (const row of raw) {
        try {
          const item = JSON.parse(row.record_json) as Observation | null
          if (!item || item.namespace !== namespace || !DIAGNOSTIC_STAGES.includes(item.stage)
            || ['id', 'at', 'model', 'version'].some(key => typeof item[key as keyof Observation] !== 'string')
            || !item.counters || typeof item.counters !== 'object' || Array.isArray(item.counters)
            || Object.values(item.counters).some(n => typeof n !== 'number' || !Number.isFinite(n) || n < 0)) throw new Error('Invalid diagnostic record')
          records.push({ id: item.id, at: item.at, namespace, stage: item.stage, model: diagnosticText(item.model, 160), version: item.version,
            counters: item.counters, ...(typeof item.taskId === 'string' ? { taskId: item.taskId } : {}),
            ...(typeof item.category === 'string' ? { category: diagnosticText(item.category, 80) } : {}),
            ...(typeof item.detail === 'string' ? { detail: diagnosticText(item.detail) } : {}) })
        } catch { corruptRecords++ }
      }
    } catch { available = false }
    const parsedRows = rows.slice(0, 2000).map(row => ({ ...row, counters: readCounters(row.counters_json) }))
    for (const row of parsedRows) {
      const counters = row.counters
      const stage = stages[row.stage] ??= {}
      for (const [key, value] of Object.entries(counters)) {
        totals[key] = (totals[key] ?? 0) + value
        stage[key] = (stage[key] ?? 0) + value
      }
    }
    const routes = new Map<string, { stage: string; model: string; version: string; counters: Counters }>()
    for (const row of parsedRows) {
      const key = JSON.stringify([row.stage, row.model, row.version])
      const route = routes.get(key) ?? { stage: row.stage, model: row.model, version: row.version, counters: {} }
      for (const [name, n] of Object.entries(row.counters)) route.counters[name] = (route.counters[name] ?? 0) + n
      routes.set(key, route)
    }
    const rates = Object.fromEntries(Object.entries(stages).map(([stage, counts]) => [stage, {
      sampledOperations: counts.operations ?? 0,
      operationFailureRate: counts.operations ? (counts.operationsFailed ?? 0) / counts.operations : null,
      firstAttemptSuccessRate: counts.operations ? (counts.firstAttemptSucceeded ?? 0) / counts.operations : null,
      recoveredOperationRate: counts.operations ? (counts.operationsRecovered ?? 0) / counts.operations : null,
      meanOperationMs: counts.operations ? (counts.operationMs ?? 0) / counts.operations : null,
      meanModelMs: counts.modelCalls ? (counts.modelMs ?? 0) / counts.modelCalls : null,
    }]))
    const chatTokens = stages.chat?.totalTokens ?? 0
    const backgroundTokens = (totals.totalTokens ?? 0) - chatTokens
    const totalsComplete = available && !corruptRollups && !this.dropped && totals.modelCalls && totals.totalTokenCalls === totals.modelCalls && !this.pending.length && rows.length <= 2000
    return { schemaVersion: 1, generatedAt: new Date().toISOString(), since, through: today, timezone: 'UTC', startedAt,
      coverage: { available, corruptRollups, corruptRecords, processStartedAt: this.startedAt, pendingRecords: this.pending.length, droppedRecords: this.dropped, writeFailures: this.writeFailures,
        rollupTruncated: rows.length > 2000, historicalBackfill: false, rawRetentionDays: 7, rollupRetentionDays: 90,
        totalChatCostRatio: null, netSavings: null,
        note: '统计从采集启用后开始；Token 为适配器报告值，缺失另计；memoryInputEstimate 仅估算常驻规则、工具定义、画像和自动上下文，尚未完整归因历史工具结果及分层对话。净收益与费用占比待测。主聊天覆盖已观测请求，无法证明账单完整。' },
      totals, stages, rates,
      observedBackgroundTokenShare: totalsComplete && totals.totalTokens ? backgroundTokens / totals.totalTokens : null,
      definitions: 'operations=一次记忆模型操作（含内部重试）；modelCalls=流式请求尝试；pipeline=现存持久任务状态。后台Token占比仅针对当前空间已观测请求，常驻输入估算单列，费用与净收益未测。',
      routes: [...routes.values()].slice(0, 40), omittedRoutes: Math.max(0, routes.size - 40),
      totalRecords, nextOffset: offset + scannedRecords < totalRecords ? offset + scannedRecords : null,
      records: records.map(({ namespace: _namespace, detail, ...record }) => ({ ...record, ...(options.details && detail ? { detail } : {}) })),
    }
  }

  close(): void {
    if (this.closed) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.flush()
    this.closed = true
    try { this.database?.close() } catch { /* Best effort during shutdown. */ }
    this.database = undefined
  }
}

/** Pass every chunk through unchanged; only final usage counters are retained. */
export async function* observeModelStream(recorder: DiagnosticsRecorder, scope: DiagnosticScope,
  options: Pick<GenerateOptions, 'provider' | 'model'>, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> {
  const start = Date.now()
  let usage: TokenUsage | undefined
  let finished = false
  let failure: unknown
  let cancelled = false
  scope.calls = (scope.calls ?? 0) + 1
  try {
    for await (const chunk of next()) {
      if (chunk.type === 'usage') usage = chunk.usage
      if (chunk.type === 'finish') {
        finished = true
        if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') {
          cancelled = chunk.reason.kind === 'aborted'
          failure = cancelled ? Object.assign(new Error(chunk.reason.failure?.message ?? 'aborted'), { name: 'AbortError' }) : chunk.reason.failure.message
        } else if (chunk.reason.kind === 'max-tokens') failure = 'max-tokens'
      }
      yield chunk
    }
  } catch (error) { failure = error; cancelled = isAbortError(error); throw error }
  finally {
    const valid = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0
    const known = usage && valid(usage.inputTokens) && valid(usage.outputTokens)
    const counters: Counters = { modelCalls: 1, modelFailed: failure !== undefined && !cancelled ? 1 : 0,
      modelCancelled: cancelled || !finished && failure === undefined ? 1 : 0,
      modelMs: Date.now() - start, usageCalls: known ? 1 : 0, missingUsageCalls: known ? 0 : 1 }
    if (scope.stage === 'chat' && scope.memoryInputEstimate !== undefined) {
      counters.memoryInputEstimate = scope.memoryInputEstimate
      counters.memoryInputEstimateCalls = 1
    }
    if (known && usage) {
      // DSH input/cache fields are disjoint; reasoning is a subset of output.
      counters.inputTokens = usage.inputTokens
      counters.outputTokens = usage.outputTokens
      if (valid(usage.cacheReadTokens)) { counters.cacheReadTokens = usage.cacheReadTokens; counters.cacheReadKnownCalls = 1 }
      if (valid(usage.cacheWriteTokens)) { counters.cacheWriteTokens = usage.cacheWriteTokens; counters.cacheWriteKnownCalls = 1 }
      if (valid(usage.reasoningTokens)) counters.reasoningTokens = usage.reasoningTokens
      if (valid(usage.totalTokens) || valid(usage.cacheReadTokens) && valid(usage.cacheWriteTokens)) {
        counters.totalTokens = valid(usage.totalTokens) ? usage.totalTokens
          : counters.inputTokens! + counters.outputTokens! + counters.cacheReadTokens! + counters.cacheWriteTokens!
        counters.totalTokenCalls = 1
      }
    }
    recorder.record(scope, counters, { model: `${options.provider}/${options.model}`, ...(failure !== undefined ? { error: failure } : {}) })
  }
}
