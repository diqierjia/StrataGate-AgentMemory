import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import {
  EVENT_DUPLICATE_REPAIR_VERSION, EVENT_DUPLICATE_AUTO_CONFIDENCE, eventDuplicateStructuralCompatible, eventDuplicateFingerprint, validEventMergeDraft,
  scanEventDuplicates, type EventCard, type EventDuplicateDecision, type EventDuplicatePair, type StrataGateSnapshot, type DuplicateReviewUndo, type EventMergeDraft,
} from '@diqier/stratagate'

type WorkPair = EventDuplicatePair & { outcome?: 'merged' | 'selected' | 'kept' | 'failed'; keepId?: string; reason?: string; attempts?: number; nextAt?: number;
  action?: EventDuplicateDecision['action']; confidence?: number; userReviewed?: boolean; manualReopened?: boolean; aiResolved?: boolean;
  draft?: EventMergeDraft; draftFingerprints?: string; draftAttempts?: number; draftError?: string;
  manualResolution?: { mode: 'merge' | 'select'; keepId: string; actor?: 'ai' };
  undo?: { id: string; data?: DuplicateReviewUndo; previous: Partial<WorkPair>; pending?: boolean } }
interface RepairState {
  version: number; scannedAt: string; scannedEvents: number; status: 'pending' | 'completed'
  cursor: number; pairs: WorkPair[]
  poolEventCount?: number
  poolEventIds?: string[]
}
const LEASE_MS = 180_000
function repairSummary(state: RepairState | null) {
  if (!state) return null
  return { version: state.version, status: state.status, scannedAt: state.scannedAt, scannedEvents: state.scannedEvents,
    candidates: state.pairs.length, processed: state.cursor,
    merged: state.pairs.filter(({ outcome }) => outcome === 'merged').length,
    selected: state.pairs.filter(({ outcome }) => outcome === 'selected').length,
    retained: state.pairs.filter(({ outcome }) => outcome === 'kept').length,
    needsReview: state.pairs.filter(({ outcome, userReviewed, aiResolved }) => !userReviewed && !aiResolved && (outcome === 'kept' || outcome === 'failed')).length,
    aiHandled: state.pairs.filter(pair => pair.aiResolved).length,
    awaitingAI: state.pairs.filter(pair => !pair.outcome && !pair.userReviewed).length,
    failed: state.pairs.filter(({ outcome }) => outcome === 'failed').length }
}

/** Private repair journal, including inverse records for manual operations. Scanning never changes memory. */
export class EventDuplicateMaintenance {
  private readonly database: DatabaseSync
  constructor(filename: string) {
    this.database = new DatabaseSync(filename)
    this.database.exec(`CREATE TABLE IF NOT EXISTS stratagate_dsh_event_duplicate_repair (
      namespace TEXT PRIMARY KEY, version INTEGER NOT NULL, state_json TEXT NOT NULL,
      lease_owner TEXT, lease_until INTEGER NOT NULL DEFAULT 0
    ) STRICT`)
  }
  close(): void { this.database.close() }

  summary(namespace: string) {
    return repairSummary(this.read(namespace))
  }

  /** Read-only details are separate from the compact overview and paginated by the caller. */
  details(namespace: string) { return structuredClone(this.read(namespace)?.pairs ?? []) }

  async rescan(namespace: string, snapshot: StrataGateSnapshot, preserveReviewed = false): Promise<void> {
    const initial: RepairState = { version: EVENT_DUPLICATE_REPAIR_VERSION, scannedAt: new Date().toISOString(),
      scannedEvents: 0, status: 'pending', cursor: 0, pairs: [] }
    this.database.prepare(`INSERT OR IGNORE INTO stratagate_dsh_event_duplicate_repair (namespace, version, state_json) VALUES (?, ?, ?)`)
      .run(namespace, initial.version, JSON.stringify(initial))
    const owner = this.claim(namespace)
    if (!owner) throw new Error('重复记忆整理正在执行，请稍后重试')
    try {
      const events = [...snapshot.events, ...snapshot.agentEvents]
      initial.poolEventCount = events.length
      initial.poolEventIds = events.map(event => event.id)
      initial.pairs = await scanEventDuplicates(events)
      const previous = this.read(namespace)?.pairs ?? []
      if (preserveReviewed) initial.pairs = initial.pairs.map(pair => previous.find(old => old.userReviewed
        && old.leftId === pair.leftId && old.rightId === pair.rightId && old.leftFingerprint === pair.leftFingerprint && old.rightFingerprint === pair.rightFingerprint) ?? pair)
      // A fresh scan must not erase the user's ability to undo a recent manual operation.
      initial.pairs.push(...previous.filter(pair => pair.undo
        && !initial.pairs.some(next => next.leftId === pair.leftId && next.rightId === pair.rightId)))
      initial.scannedEvents = events.filter(event => event.status === 'active' || event.status === 'superseded').length
      if (!initial.pairs.length) initial.status = 'completed'
      this.database.prepare('UPDATE stratagate_dsh_event_duplicate_repair SET version = ? WHERE namespace = ? AND lease_owner = ?')
        .run(initial.version, namespace, owner)
      this.save(namespace, owner, initial)
    } finally { this.release(namespace, owner) }
  }

  private hasNewStoredEvents(namespace: string, state: RepairState): boolean {
    if (state.poolEventCount === undefined || !this.database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='events'").get()) return false
    const row = this.database.prepare(`SELECT (SELECT count(*) FROM events WHERE namespace=?)
      + (SELECT count(*) FROM agent_events WHERE namespace=?) AS total`).get(namespace, namespace) as { total: number }
    if (row.total > state.poolEventCount) return true
    if (!state.poolEventIds) return false
    return !!this.database.prepare(`SELECT 1 FROM (
      SELECT id FROM events WHERE namespace=? UNION ALL SELECT id FROM agent_events WHERE namespace=?
    ) WHERE id NOT IN (SELECT value FROM json_each(?)) LIMIT 1`).get(namespace, namespace, JSON.stringify(state.poolEventIds))
  }

  async prepareDraft(namespace: string, expected: EventDuplicatePair, generate: () => Promise<EventDuplicateDecision>, regenerate = false) {
    const owner = this.claim(namespace)
    if (!owner) throw new Error('AI 正在处理这组记忆，请稍后重试')
    let renewal: ReturnType<typeof setInterval> | undefined
    try {
      const state = this.read(namespace)!
      const pair = state?.pairs.find(pair => pair.leftId === expected.leftId && pair.rightId === expected.rightId)
      if (!pair) throw new Error('候选已变化，请刷新')
      const fingerprints = expected.leftFingerprint + expected.rightFingerprint
      if (!regenerate && pair.draftFingerprints === fingerprints && validEventMergeDraft(pair.draft)) return { draft: pair.draft, reason: pair.reason }
      if (pair.draftFingerprints !== fingerprints) delete pair.draft
      pair.draftFingerprints = fingerprints
      // Each manual request dispatches once. Only the background worker has a retry budget.
      // Retire the old draft cap without resetting automatic attempts or reopening terminal work.
      delete pair.draftAttempts
      this.save(namespace, owner, state)
      // A manually configured model timeout can outlast the worker lease. Keep only
      // this request's lease alive; this timer never dispatches or retries a model.
      renewal = setInterval(() => {
        try {
          this.database.prepare(`UPDATE stratagate_dsh_event_duplicate_repair SET lease_until = ?
            WHERE namespace = ? AND lease_owner = ? AND lease_until > ?`)
            .run(Date.now() + LEASE_MS, namespace, owner, Date.now())
        } catch { /* Ownership is checked before accepting the result. */ }
      }, LEASE_MS / 3)
      renewal.unref?.()
      try {
        const decision = await generate()
        if (!this.owns(namespace, owner)) throw new Error('AI 结果已过期，请刷新')
        if (!validEventMergeDraft(decision.draft)) throw new Error(decision.reason || 'AI 无法形成可靠的合并稿，可手动编辑或保留两张。')
        pair.draft = decision.draft
        delete pair.draftError
        this.save(namespace, owner, state)
        return { draft: pair.draft, reason: decision.reason }
      } catch (error) {
        pair.draftError = error instanceof Error ? error.message : String(error)
        this.save(namespace, owner, state)
        throw error
      }
    } finally { if (renewal) clearInterval(renewal); this.release(namespace, owner) }
  }

  takeOver(namespace: string, expected: EventDuplicatePair): void {
    const owner = this.claim(namespace)
    if (!owner) throw new Error('AI 正在处理这组记忆，请稍后接管')
    try {
      const state = this.read(namespace)!
      const pair = state?.pairs.find(pair => pair.leftId === expected.leftId && pair.rightId === expected.rightId)
      if (!pair || pair.outcome === 'merged' || pair.outcome === 'selected') throw new Error('这组记忆已处理，请刷新查看结果')
      Object.assign(pair, { outcome: 'kept', aiResolved: false, userReviewed: false, manualReopened: true,
        leftFingerprint: expected.leftFingerprint, rightFingerprint: expected.rightFingerprint, reason: '已由你接管，AI 不再自动处理这组；双方原卡均保留。' })
      this.save(namespace, owner, state)
    } finally { this.release(namespace, owner) }
  }

  async resolve(namespace: string, expected: EventDuplicatePair, keepId: string | null,
    archive: (pair: EventDuplicatePair, keepId: string, prepareUndo: (undo: DuplicateReviewUndo) => void) => Promise<boolean>, mode: 'merge' | 'select' = 'merge'): Promise<boolean> {
    const owner = this.claim(namespace)
    if (!owner) throw new Error('重复记忆整理正在执行，请稍后重试')
    try {
      const state = this.read(namespace)
      const pair = state?.pairs.find(pair => pair.leftId === expected.leftId && pair.rightId === expected.rightId)
      if (!state || !pair) throw new Error('候选已变化，请刷新后重试')
      if (keepId && keepId !== pair.leftId && keepId !== pair.rightId) throw new Error('保留卡不属于当前候选')
      if (!keepId) {
        const { undo: _undo, manualResolution: _intent, ...original } = structuredClone(pair)
        pair.undo = { id: randomUUID(), previous: original }
      } else {
        const previous = structuredClone(state)
        // Reserve human intent before the independent core transaction. A crash must not leave a
        // completed KEEP_BOTH journal permanently claiming that the committed choice is unhandled.
        pair.manualResolution = { mode, keepId }
        state.status = 'pending'
        this.save(namespace, owner, state)
        if (!await archive(expected, keepId, data => {
          const { undo: _undo, manualResolution: _intent, ...original } = previous.pairs.find(value => value.leftId === pair.leftId && value.rightId === pair.rightId)!
          pair.undo = { id: randomUUID(), data, previous: original }
          this.save(namespace, owner, state)
        })) { this.save(namespace, owner, previous); return false }
      }
      delete pair.manualResolution
      Object.assign(pair, { leftFingerprint: expected.leftFingerprint, rightFingerprint: expected.rightFingerprint }, { outcome: keepId ? mode === 'select' ? 'selected' : 'merged' : 'kept', keepId: keepId ?? undefined, userReviewed: true, manualReopened: false, aiResolved: false,
        reason: keepId ? mode === 'select' ? '用户选择仅保留一张，另一张已归档，内容未混合；原始来源与历史关联保留' : '用户确认合并，双方内容、来源和安全关联已保留' : '用户确认保留两张', nextAt: 0 })
      while (state.pairs[state.cursor]?.userReviewed || state.pairs[state.cursor]?.outcome === 'merged') state.cursor++
      if (state.cursor === state.pairs.length) state.status = 'completed'
      this.save(namespace, owner, state)
      return true
    } finally { this.release(namespace, owner) }
  }

  async undo(namespace: string, expected: EventDuplicatePair, undoId: string,
    restore: (data: DuplicateReviewUndo) => Promise<boolean>): Promise<boolean> {
    const owner = this.claim(namespace)
    if (!owner) throw new Error('重复记忆整理正在执行，请稍后重试')
    try {
      const state = this.read(namespace)!
      const pair = state?.pairs.find(pair => pair.leftId === expected.leftId && pair.rightId === expected.rightId)
      if (!pair?.undo || pair.undo.id !== undoId) throw new Error('撤销记录已失效，请刷新查看')
      const undo = pair.undo
      undo.pending = true
      this.save(namespace, owner, state)
      try { if (undo.data && !await restore(undo.data)) return false }
      catch (error) { delete undo.pending; this.save(namespace, owner, state); throw error }
      // Reopen for the user, without spending another automatic model attempt.
      for (const key of Object.keys(pair)) delete (pair as unknown as Record<string, unknown>)[key]
      Object.assign(pair, undo.previous, { outcome: 'kept', userReviewed: false, aiResolved: false, manualReopened: true, reason: '已撤销上次处理，恢复处理前的内容、状态和关联；请重新确认。' })
      this.save(namespace, owner, state)
      return true
    } finally { this.release(namespace, owner) }
  }

  /** Checkpoint an interrupted human action without rerunning a model or applying a new choice. */
  recoverManualChoices(namespace: string, snapshot: StrataGateSnapshot): boolean {
    if (!this.read(namespace)?.pairs.some(pair => pair.manualResolution)) return false
    const owner = this.claim(namespace)
    if (!owner) return false
    try {
      const state = this.read(namespace)!
      const cards = new Map([...snapshot.events, ...snapshot.agentEvents].map(card => [card.id, card]))
      for (const pair of state.pairs) {
        if (!pair.manualResolution) continue
        const { mode, keepId, actor } = pair.manualResolution
        const kept = cards.get(keepId); const other = cards.get(keepId === pair.leftId ? pair.rightId : pair.leftId)
        // A selected historical original may still point to its third successor.
        // The existing durable inverse records the actual committed choice without rewriting that link.
        const selectedChange = pair.undo?.data?.changes.find(change =>
          (change.collection === 'events' || change.collection === 'agentEvents') && change.id === other?.id)
        const selectedAfter = selectedChange?.after as EventCard | undefined
        const selectedOriginal = mode === 'select' && other && selectedAfter
          && eventDuplicateFingerprint(other) === eventDuplicateFingerprint(selectedAfter)
        const committed = kept?.status === 'active' && other?.status === 'archived'
          && (other.supersededBy === kept.id || selectedOriginal || mode === 'merge' && kept.mergedFromEventIds?.includes(other.id))
          && (mode === 'merge' ? kept.mergedFromEventIds?.includes(other.id) : !kept.mergedFromEventIds?.includes(other.id))
        delete pair.manualResolution
        pair.outcome = committed ? mode === 'merge' ? 'merged' : 'selected' : 'kept'
        pair.userReviewed = Boolean(committed) && actor !== 'ai'
        pair.aiResolved = Boolean(committed) && actor === 'ai'
        if (committed) pair.keepId = keepId
        else { delete pair.keepId; delete pair.undo }
        pair.reason = committed ? mode === 'merge' ? '已恢复人工合并记录，双方内容与来源已保留' : '已恢复人工选择记录，另一张已归档，双方内容未混合'
          : '上次人工处理未完成，未继续执行；请重新对比并确认'
        pair.nextAt = 0
      }
      const next = state.pairs.findIndex(pair => !pair.outcome && !pair.userReviewed)
      state.cursor = next < 0 ? state.pairs.length : next
      state.status = next < 0 ? 'completed' : 'pending'
      this.save(namespace, owner, state)
      return true
    } finally { this.release(namespace, owner) }
  }

  private claim(namespace: string): string | null {
    const owner = randomUUID()
    return this.database.prepare(`UPDATE stratagate_dsh_event_duplicate_repair SET lease_owner = ?, lease_until = ?
      WHERE namespace = ? AND lease_until <= ?`).run(owner, Date.now() + LEASE_MS, namespace, Date.now()).changes ? owner : null
  }
  private release(namespace: string, owner: string) {
    this.database.prepare('UPDATE stratagate_dsh_event_duplicate_repair SET lease_owner = NULL, lease_until = 0 WHERE namespace = ? AND lease_owner = ?')
      .run(namespace, owner)
  }
  static readSummary(filename: string, namespace: string) {
    const database = new DatabaseSync(filename, { readOnly: true })
    try {
      if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'stratagate_dsh_event_duplicate_repair'").get()) return null
      const row = database.prepare('SELECT state_json FROM stratagate_dsh_event_duplicate_repair WHERE namespace = ? AND version <= ?')
        .get(namespace, EVENT_DUPLICATE_REPAIR_VERSION) as { state_json: string } | undefined
      return repairSummary(row ? JSON.parse(row.state_json) as RepairState : null)
    } finally { database.close() }
  }
  /** Offline startup only needs unfinished human transactions, not every memory namespace. */
  static pendingManualNamespaces(filename: string): string[] {
    const database = new DatabaseSync(filename, { readOnly: true })
    try {
      if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'stratagate_dsh_event_duplicate_repair'").get()) return []
      return (database.prepare(`SELECT namespace FROM stratagate_dsh_event_duplicate_repair
        WHERE version <= ? AND EXISTS (SELECT 1 FROM json_each(state_json, '$.pairs') AS pair
          WHERE json_extract(pair.value, '$.manualResolution') IS NOT NULL OR json_extract(pair.value, '$.undo.pending') = 1)`)
        .all(EVENT_DUPLICATE_REPAIR_VERSION) as Array<{ namespace: string }>).map(row => row.namespace)
    } finally { database.close() }
  }
  static readDetails(filename: string, namespace: string): WorkPair[] {
    const database = new DatabaseSync(filename, { readOnly: true })
    try {
      if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'stratagate_dsh_event_duplicate_repair'").get()) return []
      const row = database.prepare('SELECT state_json FROM stratagate_dsh_event_duplicate_repair WHERE namespace = ? AND version <= ?')
        .get(namespace, EVENT_DUPLICATE_REPAIR_VERSION) as { state_json: string } | undefined
      return row ? (JSON.parse(row.state_json) as RepairState).pairs : []
    } finally { database.close() }
  }
  private read(namespace: string): RepairState | null {
    const row = this.database.prepare('SELECT state_json FROM stratagate_dsh_event_duplicate_repair WHERE namespace = ? AND version <= ?')
      .get(namespace, EVENT_DUPLICATE_REPAIR_VERSION) as { state_json: string } | undefined
    return row ? JSON.parse(row.state_json) as RepairState : null
  }

  async tick(namespace: string, operations: {
    snapshot: () => Promise<StrataGateSnapshot | null>
    decide: (context: unknown) => Promise<EventDuplicateDecision>
    archive: (pair: EventDuplicatePair, keepId: string, draft?: EventMergeDraft, prepareUndo?: (undo: DuplicateReviewUndo) => void) => Promise<boolean>
  }): Promise<boolean> {
    let state = this.read(namespace)
    if (state?.pairs.some(pair => pair.manualResolution)) {
      const snapshot = await operations.snapshot()
      return snapshot ? this.recoverManualChoices(namespace, snapshot) : false
    }
    if (state && state.version < EVENT_DUPLICATE_REPAIR_VERSION) {
      const snapshot = await operations.snapshot()
      if (!snapshot) return false
      await this.rescan(namespace, snapshot, true)
      state = this.read(namespace)
    }
    if (state?.status === 'completed') {
      if (!this.hasNewStoredEvents(namespace, state)) return false
      const snapshot = await operations.snapshot()
      if (!snapshot) return false
      const owner = this.claim(namespace)
      if (!owner) return false
      try {
        state = this.read(namespace)!
        const events = [...snapshot.events, ...snapshot.agentEvents]
        const known = new Set(state.pairs.map(pair => pair.leftId + ':' + pair.rightId))
        const additions = (await scanEventDuplicates(events)).filter(pair => !known.has(pair.leftId + ':' + pair.rightId))
        state.pairs.push(...additions)
        state.poolEventCount = events.length
        state.poolEventIds = events.map(event => event.id)
        if (additions.length) state.status = 'pending'
        this.save(namespace, owner, state)
      } finally { this.release(namespace, owner) }
      if (state.status === 'completed') return false
    }
    if (!state) {
      const snapshot = await operations.snapshot()
      if (!snapshot) return false
      const events = [...snapshot.events, ...snapshot.agentEvents]
      state = { version: EVENT_DUPLICATE_REPAIR_VERSION, scannedAt: new Date().toISOString(),
        poolEventCount: events.length, poolEventIds: events.map(event => event.id),
        scannedEvents: events.filter(({ status }) => status === 'active' || status === 'superseded').length,
        status: 'pending', cursor: 0, pairs: await scanEventDuplicates(events) }
      this.database.prepare(`INSERT INTO stratagate_dsh_event_duplicate_repair (namespace, version, state_json)
        VALUES (?, ?, ?) ON CONFLICT(namespace) DO UPDATE SET version = excluded.version, state_json = excluded.state_json,
        lease_owner = NULL, lease_until = 0 WHERE stratagate_dsh_event_duplicate_repair.version < excluded.version`)
        .run(namespace, state.version, JSON.stringify(state))
    }
    const owner = randomUUID()
    const claim = this.database.prepare(`UPDATE stratagate_dsh_event_duplicate_repair SET lease_owner = ?, lease_until = ?
      WHERE namespace = ? AND version = ? AND lease_until <= ?`)
      .run(owner, Date.now() + LEASE_MS, namespace, EVENT_DUPLICATE_REPAIR_VERSION, Date.now())
    if (!claim.changes) return false
    try {
      state = this.read(namespace)!
      // Four comparisons per tick, at most one model call. No model runs with a SQLite transaction held.
      for (let step = 0; step < 4 && state.cursor < state.pairs.length; step++) {
        const pair = state.pairs[state.cursor]!
        if (pair.userReviewed || pair.aiResolved || pair.manualReopened || pair.outcome === 'merged') {
          state.cursor++; this.save(namespace, owner, state); continue
        }
        if ((pair.nextAt ?? 0) > Date.now()) return false
        const snapshot = await operations.snapshot()
        if (!snapshot) return false
        const events = [...snapshot.events, ...snapshot.agentEvents]
        const left = events.find(({ id }) => id === pair.leftId); const right = events.find(({ id }) => id === pair.rightId)
        const joined = (original: EventCard | undefined, kept: EventCard | undefined) => original?.status === 'archived' && kept
          && (kept.mergedFromEventIds?.includes(original.id) || original.supersededBy === kept.id
            && !events.some(card => card.id !== kept.id && card.mergedFromEventIds?.includes(original.id)))
        let modelCalled = false
        if (joined(left, right) || joined(right, left)) {
          const kept = left!.status === 'archived' ? right! : left!
          const archived = kept === left ? right! : left!
          pair.outcome = kept.mergedFromEventIds?.includes(archived.id) ? 'merged' : 'selected'
          pair.keepId = kept.id
          if (pair.outcome === 'selected') pair.userReviewed = true
          pair.reason = pair.outcome === 'merged' ? '已归并，恢复检查点' : '已选择保留一张，另一张已归档；恢复检查点'
        } else if (!left || !right || ![left, right].every(card => card.status === 'active')
          || eventDuplicateFingerprint(left) !== pair.leftFingerprint || eventDuplicateFingerprint(right) !== pair.rightFingerprint
          || !eventDuplicateStructuralCompatible(left, right) || left.weight.pinned && right.weight.pinned) {
          pair.outcome = 'kept'
          pair.reason = !left || !right ? '原卡已不可用，未执行合并'
            : left.status !== 'active' || right.status !== 'active' ? '其中一张是历史版本，AI 不会自动合并。你可以核对后把有效信息补入当前卡，或选择只保留一张。'
              : eventDuplicateFingerprint(left) !== pair.leftFingerprint || eventDuplicateFingerprint(right) !== pair.rightFingerprint ? '卡片证据已变化，请重新扫描后判断'
                : left.weight.pinned && right.weight.pinned ? '两张卡都已置顶，保留原卡'
                  : '范围、发生时间、事实状态或版本存在差异，保留原卡'
        } else {
          let keepId: string | null = null
          {
            const context = { left: sourceContext(left, snapshot), right: sourceContext(right, snapshot) }
            if (JSON.stringify(context).length > 16_000) {
              pair.outcome = 'kept'; pair.reason = '证据超过本轮裁决上限，保留原卡'
            } else if ((pair.attempts ?? 0) >= 2) {
              pair.outcome = 'failed'; pair.reason = '裁决尝试已用尽，保留原卡'
            } else {
              try {
                modelCalled = true
                pair.attempts = (pair.attempts ?? 0) + 1
                // Reserve the paid attempt durably before dispatch, including across crashes.
                this.save(namespace, owner, state)
                const decision = await operations.decide(structuredClone(context))
                pair.action = decision.action; pair.confidence = decision.confidence
                pair.reason = decision.reason.slice(0, 500)
                if (validEventMergeDraft(decision.draft)) {
                  pair.draft = decision.draft
                  pair.draftFingerprints = pair.leftFingerprint + pair.rightFingerprint
                }
                if (Number.isFinite(decision.confidence) && decision.confidence >= EVENT_DUPLICATE_AUTO_CONFIDENCE && decision.confidence <= 1) {
                  if (decision.action === 'KEEP_BOTH') { pair.aiResolved = true; pair.outcome = 'kept' }
                  if (validEventMergeDraft(decision.draft)) {
                    if (decision.action === 'KEEP_LEFT') keepId = left.id
                    if (decision.action === 'KEEP_RIGHT') keepId = right.id
                  } else if (decision.action === 'KEEP_LEFT' || decision.action === 'KEEP_RIGHT') pair.reason += '；AI 未提供完整合并稿，交由人工处理。'
                }
              } catch {
                pair.reason = '模型裁决失败，原卡未改动'
                if (pair.attempts! < 2) { pair.nextAt = Date.now() + 60_000; this.save(namespace, owner, state); return true }
                pair.outcome = 'failed'
              }
            }
          }
          if (!this.owns(namespace, owner)) return false
          if (keepId) {
            const { undo: _undo, manualResolution: _intent, ...previous } = structuredClone(pair)
            pair.manualResolution = { mode: 'merge', keepId, actor: 'ai' }
            this.save(namespace, owner, state)
            pair.outcome = await operations.archive(pair, keepId, pair.draft, data => {
              pair.undo = { id: randomUUID(), data, previous }
              this.save(namespace, owner, state!)
            }) ? 'merged' : 'kept'
            delete pair.manualResolution
            if (pair.outcome === 'merged') { pair.aiResolved = true; pair.keepId = keepId }
            if (pair.outcome === 'kept') pair.reason = '合并受到保护：卡片已变化、置顶或存在不能折叠的时间/冲突关系。' + (pair.reason ?? '')
          } else pair.outcome ??= 'kept'
        }
        state.cursor++
        state.status = state.cursor === state.pairs.length ? 'completed' : 'pending'
        this.save(namespace, owner, state)
        if (modelCalled) return true
      }
      if (state.cursor === state.pairs.length) { state.status = 'completed'; this.save(namespace, owner, state) }
      return true
    } finally {
      this.database.prepare('UPDATE stratagate_dsh_event_duplicate_repair SET lease_owner = NULL, lease_until = 0 WHERE namespace = ? AND lease_owner = ?')
        .run(namespace, owner)
    }
  }
  private owns(namespace: string, owner: string): boolean {
    return Boolean(this.database.prepare('SELECT 1 FROM stratagate_dsh_event_duplicate_repair WHERE namespace = ? AND lease_owner = ? AND lease_until > ?')
      .get(namespace, owner, Date.now()))
  }
  private save(namespace: string, owner: string, state: RepairState): void {
    const result = this.database.prepare(`UPDATE stratagate_dsh_event_duplicate_repair SET state_json = ?, lease_until = ?
      WHERE namespace = ? AND lease_owner = ? AND lease_until > ?`)
      .run(JSON.stringify(state), Date.now() + LEASE_MS, namespace, owner, Date.now())
    if (!result.changes) throw new Error('Duplicate repair lease expired')
  }
}

export function sourceContext(event: EventCard, snapshot: StrataGateSnapshot) {
  const ids = new Set(event.sourceMessageIds)
  const messages = [...snapshot.blocks.flatMap(({ l5Raw }) => l5Raw), ...snapshot.openTail].filter(({ id }) => ids.has(id))
  // No factual truncation: if evidence is too large the caller keeps both cards.
  const { weight: _weight, ...card } = event
  return { card, messages: messages.map(({ id, role, content, createdAt }) => ({ id, role, content, createdAt })) }
}
