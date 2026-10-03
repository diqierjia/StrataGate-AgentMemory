import { bm25Rank, estimateTokens, weightedSearchTokens, type EventCard, type MemoryTopic } from '@diqier/stratagate'

export const MEMORY_DIRECTORY_TOKEN_BUDGET = 400
export const TOPIC_OVERVIEW_TOKEN_BUDGET = 2_400

const CATEGORIES = [
  { id: 'preferences', label: '偏好与要求' },
  { id: 'decisions', label: '决定与计划' },
  { id: 'work', label: '工作与结果' },
  { id: 'relationships', label: '交流与协作' },
  { id: 'other', label: '其他经历' },
] as const

export type TopicCategory = typeof CATEGORIES[number]['id']
export interface TopicListOptions {
  query?: string
  category?: string
  offset?: number
  limit?: number
}

function eventCategory(event: EventCard): TopicCategory {
  if (event.criticality !== 'routine') return 'preferences'
  if (['decision', 'plan', 'change', 'cancellation'].includes(event.temporal.eventType ?? '')) return 'decisions'
  if (['release', 'task_completed', 'migration', 'incident'].includes(event.temporal.eventType ?? '')) return 'work'
  if (['meeting', 'collaboration'].includes(event.temporal.eventType ?? '')) return 'relationships'
  return 'other'
}

function categoryOf(topic: MemoryTopic, events: ReadonlyMap<string, EventCard>): TopicCategory {
  const counts = new Map<TopicCategory, number>()
  for (const id of topic.sourceEventIds) {
    const event = events.get(id)
    if (event) {
      const category = eventCategory(event)
      counts.set(category, (counts.get(category) ?? 0) + 1)
    }
  }
  // Fixed category order makes ties stable; a topic appears in exactly one branch.
  return [...CATEGORIES].sort((a, b) => (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0))[0]!.id
}

export function topicNavigation(topics: readonly MemoryTopic[], events: readonly EventCard[]) {
  const byId = new Map(events.map((event) => [event.id, event]))
  const entries = topics.map((topic) => ({
    id: topic.id,
    title: topic.title,
    description: topic.description,
    category: categoryOf(topic, byId),
    sourceEventCount: topic.sourceEventIds.length,
    coverage: topic.coverage,
    isFallback: topic.isFallback === true,
  })).sort((a, b) => a.category.localeCompare(b.category) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id))
  const categories = CATEGORIES.map((category) => ({
    ...category,
    count: entries.filter((entry) => entry.category === category.id).length,
  })).filter(({ count }) => count > 0)
  return { entries, categories }
}

export function topicPage(topics: readonly MemoryTopic[], events: readonly EventCard[], options: TopicListOptions = {}) {
  const navigation = topicNavigation(topics, events)
  if (options.category && !CATEGORIES.some(({ id }) => id === options.category)) throw new TypeError('Unknown topic category')
  let entries = options.category ? navigation.entries.filter(({ category }) => category === options.category) : navigation.entries
  const query = options.query?.trim().slice(0, 500)
  if (query) entries = bm25Rank(entries, query, (entry) => weightedSearchTokens([[entry.title, 4], [entry.description, 2]]))
    .map(({ item }) => item)
  const offset = Number.isFinite(options.offset) ? Math.max(0, Math.floor(options.offset!)) : 0
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(20, Math.floor(options.limit!))) : 12
  const page = entries.slice(offset, offset + limit)
  return {
    navigationOnly: true as const,
    total: entries.length,
    offset,
    nextOffset: offset + page.length < entries.length ? offset + page.length : null,
    categories: navigation.categories,
    topics: page,
  }
}

function lineText(value: string, maximum: number): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, maximum)
}

export function renderMemoryDirectory(topics: readonly MemoryTopic[], events: readonly EventCard[]): string {
  const { entries, categories } = topicNavigation(topics, events)
  if (entries.length === 0) return ''
  const header = '[StrataGate 记忆目录]\n仅供导航，概览不是事实证据。先 memory_expand_topic，再 memory_search_events(topic_id) 核实；也可直接搜索事件/图谱。'
  const lines = entries.map((entry) => `- ${entry.id}：${lineText(entry.title, 64)}${entry.description ? `；${lineText(entry.description, 48)}` : ''}`)
  const complete = `${header}\n${lines.join('\n')}`
  if (estimateTokens(complete) <= MEMORY_DIRECTORY_TOKEN_BUDGET) return complete
  // Every branch remains reachable even when a large catalog cannot fit the prompt.
  const branches = categories.map(({ id, label, count }) => `${id}（${label} ${count}）`).join('；')
  const navigation = `${header}\n共 ${entries.length} 项；分类：${branches}。完整目录用 memory_list_topics(category, offset) 分页；query 可查主题。下列为部分入口：`
  const selected: string[] = []
  for (const category of categories) {
    const entry = entries.find((item) => item.category === category.id)!
    const line = `- ${entry.id}：${lineText(entry.title, 40)}`
    if (estimateTokens(`${navigation}\n${[...selected, line].join('\n')}`) <= MEMORY_DIRECTORY_TOKEN_BUDGET) selected.push(line)
  }
  return `${navigation}\n${selected.join('\n')}`.trim()
}

export function boundedTopic(topic: MemoryTopic, envelope: Record<string, unknown> = {}) {
  const overview: MemoryTopic['overview'] = []
  const sourceEventIds = topic.sourceEventIds.slice(0, 12)
  const result = (parts: MemoryTopic['overview']) => ({
    ...topic, sourceEventIds, overview: parts,
    totalSourceEvents: topic.sourceEventIds.length,
    omittedSourceEvents: topic.sourceEventIds.length - sourceEventIds.length,
    omittedOverviewParagraphs: topic.overview.length - parts.length,
  })
  for (const paragraph of topic.overview) {
    if (estimateTokens(JSON.stringify({ ...envelope, topic: result([...overview, paragraph]) })) <= TOPIC_OVERVIEW_TOKEN_BUDGET) overview.push(paragraph)
  }
  return result(overview)
}
