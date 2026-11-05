import { effectiveGraphNodeView, estimateTokens, memoryTopicEventFingerprint, memoryTopicMembershipSections, memoryTopicOverviewMatchesSection, renderBlock,
  dreamingEventContent, dreamingEventContentVersion, dreamingTopicVersion, DREAMING_SOURCE_PAGE_CHARACTERS,
  type BlockLevel, type DreamingRun, type EventCard, type StrataGate } from '@diqier/stratagate'
import { topicPage } from './topics.js'

export interface DreamingAction { tool: string; args: Record<string, unknown> }
/** Shared by native and detached hosts so operation semantics cannot diverge. */
export const DREAMING_DIRECTORY_GUIDANCE = `set-overview {title,entries} replaces ONLY the named section's entire overview, not the chapter. append-overview {title,entries} adds genuinely new facts only. move-events changes Event membership only; it does not move overview prose.
To relocate or consolidate overview facts across sections, use rewrite-overview {titles:[all affected source and destination section names],entries:[{title,kind,text,sourceEventIds}]}. It atomically replaces ALL overview entries in the named sections; include every unique supported fact to retain, including existing destination content. Entries must name one of those sections; other sections remain untouched. Sections must already exist (move-events can create a destination first in the same operations array). For a pure move, keep the original text and citations and change its title; do not leave a duplicate or a cross-reference solely to satisfy source preservation.
Before any replacement, retrieve all existing cited Events not already supplied in full. Preserve the union of their sourceEventIds across the replacement, even when a fact moves to another selected section. When newer evidence corrects old prose, update or consolidate that prose with both old and new citations, retaining its timeline, scope, uncertainty and any still-valid details; do not keep an obsolete claim as a current fact and append another correction. Conflicting evidence is not settled merely because it is newer. Use set-overview for corrections within one section and rewrite-overview across sections. Each overview text is at most 1000 Unicode characters. On rejection, use the named Event and reason: retrieve an unread source; a foreign-chapter source cannot be authorized by reading it. Failed operations save nothing.`
const LIMIT = DREAMING_SOURCE_PAGE_CHARACTERS
function integer(value: unknown, fallback: number, maximum: number): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > maximum) throw new Error(`Invalid page parameter: expected an integer from 0 to ${maximum}`)
  return Number(value)
}
function page<T>(items: T[], args: Record<string, unknown>): unknown {
  const offset = integer(args.offset, 0, Number.MAX_SAFE_INTEGER)
  const limit = Math.max(1, integer(args.limit, 12, 20))
  return { items: items.slice(offset, offset + limit), total: items.length, offset, nextOffset: offset + limit < items.length ? offset + limit : null,
    contentVersion: dreamingTopicVersion(items) }
}
function textPage(value: unknown, args: Record<string, unknown>): { content: string; contentVersion: string; offset: number; totalCharacters: number; nextOffset: number | null } {
  const content = typeof value === 'string' ? value : JSON.stringify(value)
  const offset = integer(args.offset, 0, Number.MAX_SAFE_INTEGER)
  const limit = Math.max(1, integer(args.limit, LIMIT, LIMIT))
  return { content: content.slice(offset, offset + limit), contentVersion: dreamingTopicVersion(content), offset, totalCharacters: content.length, nextOffset: offset + limit < content.length ? offset + limit : null }
}
export function dreamingEvents(memory: StrataGate, run: DreamingRun): EventCard[] {
  return memory.listAllEvents().filter(event => event.status !== 'forgotten' && event.status !== 'archived'
    && run.sourceVersions[event.id] === memoryTopicEventFingerprint(event))
}
/** Deliberately bypasses Runtime's chat evidence batches and record-use hooks. */
export async function dreamingTool(memory: StrataGate, run: DreamingRun, action: DreamingAction): Promise<{ result: unknown; evidenceIds: string[] }> {
  const { tool, args } = action
  const events = dreamingEvents(memory, run)
  const allowed = new Set(events.map(event => event.id))
  const topics = memory.listMemoryTopics([...allowed]).filter(topic => !topic.isFallback)
  const evidenceIds: string[] = []
  if (tool === 'memory_list_topics') {
    return { result: topicPage(topics, events, {
      ...(typeof args.query === 'string' ? { query: args.query } : {}),
      offset: integer(args.offset, 0, Number.MAX_SAFE_INTEGER), limit: Math.max(1, integer(args.limit, 12, 20)),
    }), evidenceIds }
  }
  if (tool === 'memory_expand_topic') {
    const topic = topics.find(t => t.id === args.id)
    if (!topic) throw new Error('Unknown topic')
    return { result: { id: topic.id, title: topic.title, description: topic.description,
      sections: page(memoryTopicMembershipSections(topic), args), overview: page(topic.overview, args), totalEvents: topic.sourceEventIds.length }, evidenceIds }
  }
  if (tool === 'dreaming_search') {
    if (typeof args.query !== 'string') throw new Error('query is required')
    const offset = integer(args.offset, 0, Number.MAX_SAFE_INTEGER)
    const limit = Math.max(1, integer(args.limit, 12, 20))
    if (args.kind === 'events') {
      const topic = args.topicId === undefined ? null : topics.find(t => t.id === args.topicId)
      if (args.topicId !== undefined && !topic) throw new Error('Unknown topic')
      const ids = topic ? topic.sourceEventIds : [...allowed]
      const results = await memory.searchEvents(args.query, { eventIds: ids, offset, limit, trackRetrieval: false })
      const items = results.map(({ event }) => ({ id: event.id, title: event.title, summary: event.summary.slice(0, 1500),
        scope: event.scope, temporal: event.temporal, needsFullRead: event.summary.length > 1500 }))
      // Search hits are navigation; source details are either in the initial batch or read explicitly.
      return { result: { items, offset, nextOffset: items.length === limit ? offset + items.length : null }, evidenceIds }
    }
    if (args.kind === 'raw') {
      // Only expose messages actually cited by surviving frozen Event evidence.
      const messages = new Set(events.flatMap(event => event.sourceMessageIds))
      const hits = memory.searchRawMemory(args.query, limit + 1, { messageIds: [...messages], offset })
      return { result: { items: hits.slice(0, limit).map(hit => ({ blockId: hit.blockId, messageId: hit.message.id,
        text: hit.message.content.slice(0, 1500), needsFullRead: hit.message.content.length > 1500 })), offset,
        nextOffset: hits.length > limit ? offset + limit : null }, evidenceIds }
    }
    if (args.kind === 'graph') {
      const hits = await memory.searchGraphNodes(args.query, Math.max(1, memory.listGraphNodes().length))
      return { result: page(hits.map(hit => {
        const view = effectiveGraphNodeView(hit.node, memory.listGraphEdges(), events)
        return view ? { id: hit.node.id, name: view.node.name, sourceEventIds: view.currentFacts.flatMap(fact => fact.sourceEventIds) } : null
      }).filter(Boolean), args), evidenceIds }
    }
    throw new Error('Unknown search kind')
  }
  if (tool === 'dreaming_read') {
    if (typeof args.id !== 'string') throw new Error('id is required')
    if (args.kind === 'event') {
      const event = events.find(event => event.id === args.id)
      if (!event) throw new Error('Event unavailable or changed')
      const contentVersion = dreamingEventContentVersion(event)
      if (Number(args.offset) > 0 && run.readContentVersions?.[event.id] !== contentVersion) throw new Error('Event page version changed or not started; read from offset 0')
      const result = textPage(dreamingEventContent(event), args)
      if (result.offset === 0 && result.nextOffset === null) evidenceIds.push(event.id)
      // Multi-page reads remain navigable; explicitly acknowledge full coverage in the runner.
      return { result: { id: event.id, ...result, contentVersion }, evidenceIds }
    }
    if (args.kind === 'block') {
      const block = memory.listBlocks().find(block => block.id === args.id)
      const sources = events.filter(event => event.sourceBlockId === args.id || event.sourceMessageIds.some(id => block?.l5Raw.some(message => message.id === id)))
      if (!block || !sources.length) throw new Error('Block has no visible source evidence')
      const level = integer(args.level, 5, 5) as BlockLevel
      // A partial/redacted source block cannot leak forgotten or out-of-run messages.
      const ids = new Set(sources.flatMap(event => event.sourceMessageIds))
      const visibleMessages = block.l5Raw.filter(message => ids.has(message.id))
      const complete = visibleMessages.length === block.l5Raw.length
      const result = textPage(complete ? renderBlock(block, level) : visibleMessages, args)
      return { result: { id: block.id, level: complete ? level : 5, redacted: !complete, ...result }, evidenceIds }
    }
    if (args.kind === 'graph_node') {
      const node = memory.listGraphNodes().find(node => node.id === args.id)
      const view = node && effectiveGraphNodeView(node, memory.listGraphEdges(), events)
      if (!view) throw new Error('Graph node unavailable')
      return { result: { id: view.node.id, ...textPage(view, args) }, evidenceIds }
    }
    throw new Error('Unknown read kind')
  }
  throw new Error('Unknown Dreaming tool')
}

export function dreamingPayload(memory: StrataGate, run: DreamingRun): unknown {
  const unit = run.units[run.cursor]!
  const topic = memory.getMemoryTopic(unit.topicId)
  const events = dreamingEvents(memory, run).filter(event => unit.eventIds.includes(event.id)).map(event =>
    dreamingEventContent(event).length <= LIMIT ? event : { id: event.id, title: event.title, needsFullRead: true,
      nextReadOffset: Math.max(0, run.readOffsets[event.id] ?? 0), readComplete: run.readOffsets[event.id] === -1 })
  const sections = topic ? memoryTopicMembershipSections(topic) : []
  const relevantTitles = sections.filter(section => section.sourceEventIds.some(id => unit.eventIds.includes(id))).map(section => section.title)
  const relevantOverview = (topic?.overview ?? []).map((entry, offset) => ({ ...entry, offset }))
    .filter(entry => memoryTopicOverviewMatchesSection(entry, relevantTitles))
  const directoryReadProgress = topic ? Object.fromEntries(([['sections', sections], ['overview', topic.overview]] as const).map(([field, items]) => {
    const saved = run.directoryReads?.[JSON.stringify([topic.id, field])]
    const indices = saved?.contentVersion === dreamingTopicVersion(items) ? saved.indices : []
    const seen = new Set(indices)
    return [field, { total: items.length, readCount: indices.length, complete: indices.length === items.length,
      readRanges: indices.reduce<Array<[number, number]>>((ranges, index) => {
        const last = ranges.at(-1)
        if (last && last[1] === index) last[1]++
        else ranges.push([index, index + 1])
        return ranges
      }, []), nextUnreadOffset: items.findIndex((_, index) => !seen.has(index)) < 0 ? null : items.findIndex((_, index) => !seen.has(index)) }]
  })) : {}
  return { scope: run.scope, policyVersion: run.policyVersion, completedBatches: run.cursor, totalBatches: run.units.length,
    currentTopic: topic ? { id: topic.id, title: topic.title, description: topic.description,
      sections: sections.slice(0, 20).map(section => ({ title: section.title, totalEvents: section.sourceEventIds.length,
        batchEventIds: section.sourceEventIds.filter(id => unit.eventIds.includes(id)) })), totalSections: sections.length,
      existingOverview: { items: relevantOverview, totalRelevant: relevantOverview.length, omittedOffsets: [] } } : null,
    events, directoryReadProgress, lastWriteFailure: run.lastWriteFailure ?? null,
    retrievedEvidenceIds: Object.keys(run.evidenceVersions).slice(-100), totalRetrievedEvidence: Object.keys(run.evidenceVersions).length,
    recentTools: run.trace }
}
export function dreamingEstimatedTokens(payload: unknown, action: DreamingAction): number {
  // Explicitly an estimate, not provider billing or a monetary price.
  return estimateTokens(JSON.stringify(payload)) + estimateTokens(JSON.stringify(action))
}

export function dreamingStatus(run?: DreamingRun): unknown {
  if (!run) return null
  const interrupted = ['running', 'pausing'].includes(run.status) && !!run.leaseUntil && Date.parse(run.leaseUntil) <= Date.now()
  const legacyBoundary = run.status === 'paused' && run.tokenLimit != null && /消耗边界/.test(run.reason ?? '')
  return { id: run.id, sessionId: run.sessionId ?? null, status: interrupted ? 'paused' : run.status, scope: run.scope,
    activity: interrupted || run.status === 'paused'
      ? run.replanRequired ? '需要重新开始；后台目录整理等待本轮终止' : '已暂停；后台目录整理等待本轮继续或终止'
      : run.activity,
    reason: interrupted ? '上次运行已中断，可以继续' : legacyBoundary ? '上次整理已暂停，可以继续；已完成的修改已保存。' : run.reason,
    waitingForProjection: !!run.waitingForProjection, replanRequired: !!run.replanRequired,
    completed: run.cursor, total: run.units.length, changedBatches: run.changedBatches, calls: run.calls,
    estimatedTokens: run.estimatedTokens, updatedAt: run.updatedAt }
}
