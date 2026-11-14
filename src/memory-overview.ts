import { MemoryTopicDirectory, type AdminReadModel, type UsageReceipt } from '@diqier/stratagate'

/** 总览页固定看最近 7 天；热力格 4 周（窄屏前端只显示后 2 周）。 */
export const MEMORY_USAGE_WINDOW_DAYS = 7
export const MEMORY_HEATMAP_DAYS = 28
const TIME_ZONE = 'Asia/Shanghai'
const DAY_MS = 86_400_000

export interface AnswerAdoption {
  /** 一次回答的唯一标识；同一回答的多个批次在这里合并。 */
  key: string
  at: number
  eventIds: string[]
  elementIds: string[]
}

function dayKey(time: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(time))
}

function dayStart(day: string): number {
  return Date.parse(`${day}T00:00:00+08:00`)
}

function shiftDay(day: string, offset: number): string {
  return dayKey(dayStart(day) + offset * DAY_MS)
}

function timestamp(value: string | undefined): number | null {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function latestTimestamp(values: Array<string | null | undefined>): number | null {
  let latest: number | null = null
  for (const value of values) {
    const parsed = timestamp(value ?? undefined)
    if (parsed !== null && (latest === null || parsed > latest)) latest = parsed
  }
  return latest
}

const iso = (value: number | null): string | null => value === null ? null : new Date(value).toISOString()

/**
 * 一条 usage_receipts 记录对应一次 memory_record_use 工具调用，也就是一个检索批次；
 * 同一轮回答可能有多个批次，所以“帮到几次回答”按 sessionId + turn 去重。
 * 缺少会话或轮次信息的历史记录退回按 receipt_id 计数，绝不臆造合并。
 */
export function answerAdoptionKey(receipt: UsageReceipt): string {
  const sessionId = receipt.audit?.sessionId?.trim()
  const turn = receipt.audit?.turn
  if (sessionId && Number.isSafeInteger(turn) && turn! >= 0) return `answer:${sessionId}#${turn}`
  return `receipt:${receipt.id}`
}

/** 把 usage_receipts 折叠成按回答去重的采用记录，最新的在前。 */
export function answerAdoptions(receipts: readonly UsageReceipt[]): AnswerAdoption[] {
  const byAnswer = new Map<string, AnswerAdoption>()
  for (const receipt of receipts) {
    if (receipt.eventIds.length === 0 && receipt.elementIds.length === 0) continue
    const at = timestamp(receipt.createdAt)
    if (at === null) continue
    const key = answerAdoptionKey(receipt)
    const existing = byAnswer.get(key)
    if (!existing) {
      byAnswer.set(key, { key, at, eventIds: [...new Set(receipt.eventIds)], elementIds: [...new Set(receipt.elementIds)] })
      continue
    }
    existing.at = Math.max(existing.at, at)
    for (const id of receipt.eventIds) if (!existing.eventIds.includes(id)) existing.eventIds.push(id)
    for (const id of receipt.elementIds) if (!existing.elementIds.includes(id)) existing.elementIds.push(id)
  }
  return [...byAnswer.values()].sort((left, right) => right.at - left.at || left.key.localeCompare(right.key))
}

export interface MemoryOverviewExtras {
  profile?: { characters: number; updatedAt: string | null } | null
  shortTerm?: { enabled: boolean; items: number; updatedAt: string | null } | null
  /** 调用方已经读过目录时传入，避免再读一次可能有副作用的投影。 */
  directory?: { chapters: number; updatedAt: string | null }
}

export interface MemoryOverviewStats {
  windowDays: number
  heatmapDays: number
  /** 最近 7 天里，长期记忆真正被用到的回答次数（按回答去重）。 */
  answeredLast7Days: number
  lastRecall: { title: string; at: string } | null
  heatmap: Array<{ day: string; answers: number }>
  /** 各层只给原始数字；单位词和千分位由界面决定，概览记忆柱只显示数字。 */
  layers: {
    profile: { characters: number; updatedAt: string | null } | null
    directory: { chapters: number; updatedAt: string | null }
    session: { blocks: number; updatedAt: string | null }
    shortTerm: { enabled: boolean; items: number; updatedAt: string | null } | null
    longTerm: { events: number; answers: number; updatedAt: string | null }
  }
}

/** 长期记忆口径：目录里可见的 Event（含被替代的），以及开启时才计入的 Agent Event。 */
function visibleEvents(snapshot: AdminReadModel, agentMemoryWeight: number) {
  return [...snapshot.events, ...(agentMemoryWeight > 0 ? snapshot.agentEvents : [])]
    .filter((event) => event.status === 'active' || event.status === 'superseded')
}

function directoryChapters(snapshot: AdminReadModel, events: ReturnType<typeof visibleEvents>) {
  try {
    const directory = new MemoryTopicDirectory()
    directory.restore(snapshot.memoryTopicState)
    const state = directory.snapshot(events)
    directory.restore(state)
    return directory.list(events).filter((topic) => !topic.isFallback)
  } catch {
    // 投影读不出来时只隐藏这一层，不影响其他统计。
    return []
  }
}

export function memoryOverview(
  snapshot: AdminReadModel,
  extras: MemoryOverviewExtras = {},
  options: { now?: number; agentMemoryWeight?: number } = {},
): MemoryOverviewStats {
  const now = options.now ?? Date.now()
  const agentMemoryWeight = options.agentMemoryWeight ?? 1
  const events = visibleEvents(snapshot, agentMemoryWeight)
  const titles = new Map<string, string>()
  for (const event of [...snapshot.events, ...snapshot.agentEvents]) {
    const title = event.title?.trim()
    if (title) titles.set(event.id, title)
  }
  // 空 refs 的记录表示“本轮没采用任何记忆”，不算帮到回答。
  const longTerm = answerAdoptions(snapshot.usageReceipts)
  const today = dayKey(now)
  const heatmap = Array.from({ length: MEMORY_HEATMAP_DAYS }, (_, index) =>
    shiftDay(today, index - (MEMORY_HEATMAP_DAYS - 1)))
  const counts = new Map<string, number>(heatmap.map((day) => [day, 0]))
  for (const adoption of longTerm) {
    const day = dayKey(adoption.at)
    if (counts.has(day)) counts.set(day, counts.get(day)! + 1)
  }
  const elementNames = new Map(snapshot.elements.map((element) => [element.id, element.name]))
  // “最近一次”优先用 Event 标题；只有图谱实体被采用时退回实体名称。
  const recallTitle = (adoption: AnswerAdoption): string | null => {
    const eventId = adoption.eventIds.find((id) => titles.has(id))
    if (eventId) return titles.get(eventId)!
    const elementId = adoption.elementIds.find((id) => elementNames.has(id))
    return elementId ? elementNames.get(elementId)! : null
  }
  const latest = longTerm.find((adoption) => recallTitle(adoption) !== null)
  const chapters = extras.directory !== undefined ? null : directoryChapters(snapshot, events)
  return {
    windowDays: MEMORY_USAGE_WINDOW_DAYS,
    heatmapDays: MEMORY_HEATMAP_DAYS,
    answeredLast7Days: heatmap.slice(-MEMORY_USAGE_WINDOW_DAYS).reduce((sum, day) => sum + counts.get(day)!, 0),
    lastRecall: latest ? { title: recallTitle(latest)!, at: new Date(latest.at).toISOString() } : null,
    heatmap: heatmap.map((day) => ({ day, answers: counts.get(day)! })),
    layers: {
      profile: extras.profile ?? null,
      directory: extras.directory !== undefined
        ? extras.directory
        : { chapters: chapters!.length, updatedAt: iso(latestTimestamp(chapters!.map((chapter) => chapter.updatedAt))) },
      session: { blocks: snapshot.blocks.length, updatedAt: iso(latestTimestamp(snapshot.blocks.map((block) => block.createdAt))) },
      shortTerm: extras.shortTerm ?? null,
      longTerm: { events: events.length, answers: longTerm.length, updatedAt: iso(latestTimestamp(events.map((event) => event.updatedAt))) },
    },
  }
}
