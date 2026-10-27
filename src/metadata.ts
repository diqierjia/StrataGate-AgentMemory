import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'

export interface GraphSettings {
  enabled: boolean
  paused: boolean
  epoch: number
  legacy: boolean
  noticeSeen: boolean
  everEnabled: boolean
  approved: Record<string, string[]>
}

/** Browsing and tool discovery must not migrate an otherwise read-only database. */
export function readGraphSettings(filename: string): GraphSettings {
  const defaults: GraphSettings = { enabled: false, paused: false, epoch: 0, legacy: false, noticeSeen: false, everEnabled: false, approved: {} }
  if (filename === ':memory:' || !existsSync(filename)) return defaults
  const db = new DatabaseSync(filename, { readOnly: true, timeout: 5000 })
  try {
    const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(row => row.name))
    defaults.legacy = tables.has('memory_spaces') && Boolean(db.prepare('SELECT 1 FROM memory_spaces LIMIT 1').get())
    if (!tables.has('stratagate_dsh_settings')) return defaults
    const settings = new Map((db.prepare("SELECT key, value FROM stratagate_dsh_settings WHERE key IN ('graphEnabled', 'graphControl')").all() as { key: string; value: string }[]).map(row => [row.key, row.value]))
    return { ...defaults, ...JSON.parse(settings.get('graphControl') ?? '{}'), enabled: settings.get('graphEnabled') === 'true' }
  } finally { db.close() }
}

export const TOPIC_BOOTSTRAP_WINDOW_MS = 10 * 60_000
export const TOPIC_BOOTSTRAP_WINDOW_CALLS = 2

const METADATA_SCHEMA = `
CREATE TABLE IF NOT EXISTS stratagate_dsh_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS stratagate_dsh_workspaces (
  namespace TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS stratagate_dsh_feedback_drafts (
  namespace TEXT PRIMARY KEY,
  draft_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
`

/** Removes the orphaned v1 agent-memory side table, if it exists. */
export function dropLegacyAgentMemoriesTable(filename: string): void {
  const database = new DatabaseSync(filename)
  try {
    const legacyTable = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'stratagate_dsh_agent_memories'")
      .get() as { name: string } | undefined
    if (!legacyTable) return
    database.exec('DROP INDEX IF EXISTS stratagate_dsh_agent_memories_session')
    database.exec('DROP TABLE IF EXISTS stratagate_dsh_agent_memories')
  } finally {
    database.close()
  }
}

export class DshMetadataStore {
  private readonly database: DatabaseSync

  constructor(filename: string) {
    this.database = new DatabaseSync(filename, { timeout: 5000 })
    this.database.exec('PRAGMA busy_timeout = 5000')
    this.database.exec(METADATA_SCHEMA)
    this.database.exec('BEGIN IMMEDIATE')
    try {
      if (!this.settingValue('graphPolicyMigration')) {
        const exists = this.database.prepare("SELECT 1 FROM sqlite_master WHERE name = 'memory_spaces'").get()
        const legacy = Boolean(exists && this.database.prepare('SELECT 1 FROM memory_spaces LIMIT 1').get())
        const enabled = this.settingValue('graphEnabled') === 'true'
        if (this.settingValue('graphEnabled') === null) this.setSettingValue('graphEnabled', 'false')
        if (this.settingValue('graphControl') === null) this.setSettingValue('graphControl', JSON.stringify({ paused: false, epoch: 0, legacy, noticeSeen: false, everEnabled: enabled, approved: {} }))
        this.setSettingValue('graphPolicyMigration', '1')
      }
      this.database.exec('COMMIT')
    } catch (error) { this.database.exec('ROLLBACK'); throw error }
  }

  private settingValue(key: string): string | null {
    return (this.database.prepare('SELECT value FROM stratagate_dsh_settings WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null
  }

  graphSettings(): GraphSettings {
    const control = JSON.parse(this.settingValue('graphControl') ?? '{}') as Omit<GraphSettings, 'enabled'>
    return { ...control, enabled: this.settingValue('graphEnabled') === 'true' }
  }

  updateGraphSettings(expectedEpoch: number, update: Partial<GraphSettings>): GraphSettings {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const current = this.graphSettings()
      if (current.epoch !== expectedEpoch) throw new Error('Graph settings changed; refresh and confirm again')
      const next = { ...current, ...update }
      this.setSettingValue('graphEnabled', String(next.enabled))
      const { enabled: _enabled, ...control } = next
      this.setSettingValue('graphControl', JSON.stringify(control))
      this.database.exec('COMMIT')
      return next
    } catch (error) { this.database.exec('ROLLBACK'); throw error }
  }

  /** Database-wide, durable reservation before any historical model attempt.
   * Crashes or claim conflicts can waste a slot, but never refund a paid call.
   */
  reserveTopicBootstrapCall(now = Date.now()): boolean {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const row = this.database.prepare("SELECT value FROM stratagate_dsh_settings WHERE key = 'topicBootstrapBudget'")
        .get() as { value: string } | undefined
      let budget: { resetAt: number; used: number } = { resetAt: now + TOPIC_BOOTSTRAP_WINDOW_MS, used: 0 }
      if (row) {
        try {
          const parsed = JSON.parse(row.value) as typeof budget
          if (!Number.isFinite(parsed.resetAt) || !Number.isSafeInteger(parsed.used) || parsed.used < 0) throw new Error('Invalid budget')
          budget = parsed.resetAt <= now ? budget : parsed
        } catch {
          // Corrupt bookkeeping must not silently give another paid allowance.
          budget.used = TOPIC_BOOTSTRAP_WINDOW_CALLS
          this.setSettingValue('topicBootstrapBudget', JSON.stringify(budget))
        }
      }
      const permitted = budget.used < TOPIC_BOOTSTRAP_WINDOW_CALLS
      if (permitted) {
        budget.used += 1
        this.setSettingValue('topicBootstrapBudget', JSON.stringify(budget))
      }
      this.database.exec('COMMIT')
      return permitted
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  /** Read-only scheduling gate; reservations still happen immediately before a claim. */
  topicBootstrapNotBefore(now = Date.now()): number {
    const row = this.database.prepare("SELECT value FROM stratagate_dsh_settings WHERE key = 'topicBootstrapBudget'")
      .get() as { value: string } | undefined
    if (!row) return now
    try {
      const budget = JSON.parse(row.value) as { used: number; resetAt: number }
      if (!Number.isFinite(budget.resetAt) || !Number.isSafeInteger(budget.used) || budget.used < 0) return now
      return budget.used >= TOPIC_BOOTSTRAP_WINDOW_CALLS && budget.resetAt > now ? budget.resetAt : now
    } catch { return now }
  }

  blockTurnSize(): number | null {
    const row = this.database.prepare("SELECT value FROM stratagate_dsh_settings WHERE key = 'blockTurnSize'")
      .get() as { value: string } | undefined
    const value = Number(row?.value)
    return Number.isSafeInteger(value) && value >= 1 ? value : null
  }

  setBlockTurnSize(value: number): void {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TypeError('blockTurnSize must be a positive integer')
    }
    this.setSetting('blockTurnSize', value)
  }

  blockDecayLambda(): number | null {
    const row = this.database.prepare("SELECT value FROM stratagate_dsh_settings WHERE key = 'blockDecayLambda'")
      .get() as { value: string } | undefined
    const value = Number(row?.value)
    return Number.isFinite(value) && value >= 0 ? value : null
  }

  setBlockDecayLambda(value: number): void {
    if (!Number.isFinite(value) || value < 0) {
      throw new TypeError('blockDecayLambda must be a non-negative finite number')
    }
    this.setSetting('blockDecayLambda', value)
  }

  agentMemoryRetrievalWeight(): number | null {
    const row = this.database.prepare("SELECT value FROM stratagate_dsh_settings WHERE key = 'agentMemoryRetrievalWeight'")
      .get() as { value: string } | undefined
    const value = Number(row?.value)
    return Number.isFinite(value) && value >= 0 && value <= 5 ? value : null
  }

  setAgentMemoryRetrievalWeight(value: number): void {
    if (!Number.isFinite(value) || value < 0 || value > 5) {
      throw new TypeError('agentMemoryRetrievalWeight must be a finite number between 0 and 5')
    }
    this.setSetting('agentMemoryRetrievalWeight', value)
  }

  lastFeedbackPromptAt(): string | null {
    const row = this.database.prepare("SELECT value FROM stratagate_dsh_settings WHERE key = 'lastFeedbackPromptAt'")
      .get() as { value: string } | undefined
    return row?.value ?? null
  }

  setLastFeedbackPromptAt(value: string): void {
    this.setSettingValue('lastFeedbackPromptAt', value)
  }

  private setSetting(key: string, value: number): void {
    this.setSettingValue(key, String(value))
  }

  private setSettingValue(key: string, value: string): void {
    this.database.prepare(`
      INSERT INTO stratagate_dsh_settings (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, value, new Date().toISOString())
  }

  workspaceName(namespace: string): string | null {
    const row = this.database.prepare('SELECT display_name FROM stratagate_dsh_workspaces WHERE namespace = ?')
      .get(namespace) as { display_name: string } | undefined
    return row?.display_name ?? null
  }

  rememberWorkspace(namespace: string, displayName: string): void {
    const name = displayName.trim()
    if (!namespace.trim() || !name) return
    this.database.prepare(`
      INSERT INTO stratagate_dsh_workspaces (namespace, display_name, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT (namespace) DO UPDATE SET display_name = excluded.display_name, updated_at = excluded.updated_at
    `).run(namespace, name, new Date().toISOString())
  }

  feedbackDraft(namespace: string): unknown | null {
    const row = this.database.prepare('SELECT draft_json FROM stratagate_dsh_feedback_drafts WHERE namespace = ?')
      .get(namespace) as { draft_json: string } | undefined
    if (!row) return null
    try {
      return JSON.parse(row.draft_json)
    } catch {
      return null
    }
  }

  setFeedbackDraft(namespace: string, draft: unknown): void {
    this.database.prepare(`
      INSERT INTO stratagate_dsh_feedback_drafts (namespace, draft_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT (namespace) DO UPDATE SET draft_json = excluded.draft_json, updated_at = excluded.updated_at
    `).run(namespace, JSON.stringify(draft), new Date().toISOString())
  }

  close(): void {
    this.database.close()
  }
}
