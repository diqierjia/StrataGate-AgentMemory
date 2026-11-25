import { effectiveGraphNodeView, estimateTokens, dreamingEventVersion, memoryTopicEventFingerprint, memoryTopicMembershipSections, memoryTopicOverviewMatchesSection, renderBlock,
  dreamingEventContent, dreamingEventContentVersion, dreamingTopicVersion, DREAMING_SOURCE_PAGE_CHARACTERS,
  toUtc8Iso,
  normalizeMemoryTopicLabel,
  type BlockLevel, type DreamingRun, type EventCard, type MemoryTopic, type StrataGate } from '@diqier/stratagate'
import { memoryTopicSections, sortMemoryTopics, topicPage } from './topics.js'
import type { DailyNotes } from './daily-notes.js'

export interface DreamingAction { tool: string; args: Record<string, unknown> }
/** Shared by native and detached hosts so operation semantics cannot diverge. */
export const DREAMING_DIRECTORY_GUIDANCE = `set-overview {title,entries} replaces ONLY the named section's entire overview, not the chapter. append-overview {title,entries} adds genuinely new facts only. move-events changes Event membership. After all operations, sections with no Events and their remaining overview prose are removed. Use rewrite-overview in the same operations array to retain supported facts when emptying a section.
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

const DREAMING_DIRECTORY_OVERVIEW_MAX_CHAPTERS = 25
const DREAMING_DIRECTORY_OVERVIEW_MAX_CHARS = 4500
const DREAMING_SECTION_EVENTS_PREVIEW_LIMIT = 40
const DREAMING_BLOATED_OVERVIEW_COUNT = 5
const DREAMING_BLOATED_OVERVIEW_CHARS = 1500

function isBloatedSectionOverview(overviewCount: number, overviewChars: number): boolean {
  return overviewCount >= DREAMING_BLOATED_OVERVIEW_COUNT || overviewChars >= DREAMING_BLOATED_OVERVIEW_CHARS
}

function safeSlice(value: string, maxUnits: number): string {
  const maybeWellFormed = (value as string & { toWellFormed?: () => string }).toWellFormed
  const wellFormed = typeof maybeWellFormed === 'function' ? maybeWellFormed.call(value) : value
  if (wellFormed.length <= maxUnits) return wellFormed
  let end = maxUnits
  const last = wellFormed.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) end -= 1
  return wellFormed.slice(0, end)
}

function resolveEventByIdOrPrefix(events: readonly EventCard[], rawId: string): EventCard | undefined {
  const trimmed = rawId.trim()
  if (!trimmed) return undefined
  const exact = events.find(event => event.id === trimmed)
  if (exact) return exact
  if (trimmed.length < 8) return undefined
  const matches = events.filter(event => event.id.startsWith(trimmed))
  if (matches.length === 1) return matches[0]
  if (matches.length > 1) throw new Error(`Ambiguous event id prefix ${JSON.stringify(trimmed)} (${matches.length} matches); use the full event id`)
  return undefined
}

function topicSectionHealth(topic: MemoryTopic) {
  const sections = memoryTopicSections(topic)
  const assigned = new Set(sections.flatMap(section => section.sourceEventIds))
  const unassignedCount = topic.sourceEventIds.filter(id => !assigned.has(id)).length
  return {
    unassignedCount,
    sections: sections.map(section => {
      const overviewCount = section.paragraphs.length
      const overviewChars = section.paragraphs.reduce((sum, part) => sum + Array.from(part.text).length, 0)
      return {
        title: section.title,
        eventCount: section.sourceEventIds.length,
        overviewCount,
        overviewChars,
        ...(isBloatedSectionOverview(overviewCount, overviewChars) ? { needsOverviewCondense: true } : {}),
      }
    }),
  }
}

export function buildDreamingDirectoryOverview(topics: readonly MemoryTopic[]) {
  const ordered = sortMemoryTopics(topics).map(topic => {
    const health = topicSectionHealth(topic)
    return {
      id: topic.id,
      title: topic.title,
      eventCount: topic.sourceEventIds.length,
      ...(health.unassignedCount > 0 ? { unassignedCount: health.unassignedCount } : {}),
      sections: health.sections,
    }
  })
  const version = dreamingTopicVersion(ordered)
  if (ordered.length <= DREAMING_DIRECTORY_OVERVIEW_MAX_CHAPTERS
    && JSON.stringify(ordered).length <= DREAMING_DIRECTORY_OVERVIEW_MAX_CHARS) {
    return { version, totalChapters: ordered.length, chapters: ordered }
  }
  const needsAttention = (entry: typeof ordered[number]) =>
    (entry.unassignedCount ?? 0) > 0
    || entry.sections.some(sec => sec.needsOverviewCondense === true)
  const prioritized = [
    ...ordered.filter(needsAttention),
    ...ordered.filter(entry => !needsAttention(entry)),
  ]
  const selected: typeof ordered = []
  let usedChars = 2
  for (const entry of prioritized) {
    if (selected.length >= DREAMING_DIRECTORY_OVERVIEW_MAX_CHAPTERS) break
    const size = JSON.stringify(entry).length + (selected.length ? 1 : 0)
    if (selected.length > 0 && usedChars + size > DREAMING_DIRECTORY_OVERVIEW_MAX_CHARS) break
    selected.push(entry)
    usedChars += size
  }
  const omittedChapters = ordered.length - selected.length
  return {
    version,
    totalChapters: ordered.length,
    chapters: selected,
    ...(omittedChapters > 0 ? { omittedChapters, hint: '部分章节未展示，可用 memory_list_topics(offset) 翻看其余章节。' } : {}),
  }
}

function textPage(value: unknown, args: Record<string, unknown>): { content: string; contentVersion: string; offset: number; totalCharacters: number; nextOffset: number | null } {
  const content = typeof value === 'string' ? value : JSON.stringify(value)
  const offset = integer(args.offset, 0, Number.MAX_SAFE_INTEGER)
  const limit = Math.max(1, integer(args.limit, LIMIT, LIMIT))
  return { content: content.slice(offset, offset + limit), contentVersion: dreamingTopicVersion(content), offset, totalCharacters: content.length, nextOffset: offset + limit < content.length ? offset + limit : null }
}
export function dreamingEvents(memory: StrataGate, run: DreamingRun): EventCard[] {
  if (run.scope === 'memory') return (run.includeAgentEvents === false ? memory.listEvents() : memory.listAllEvents())
    .filter(event => event.status !== 'forgotten' && event.status !== 'archived')
  return memory.listAllEvents().filter(event => event.status !== 'forgotten' && event.status !== 'archived'
    && run.sourceVersions[event.id] === memoryTopicEventFingerprint(event))
}
/** Deliberately bypasses Runtime's chat evidence batches and record-use hooks. */
export async function dreamingTool(memory: StrataGate, run: DreamingRun, action: DreamingAction,
  notes?: { store: DailyNotes; namespace: string }): Promise<{ result: unknown; evidenceIds: string[] }> {
  const { tool, args } = action
  const events = dreamingEvents(memory, run)
  const allowed = new Set(events.map(event => event.id))
  const topics = memory.listMemoryTopics([...allowed]).filter(topic => !topic.isFallback)
  const evidenceIds: string[] = []
  if (tool === 'memory_list_topics') {
    const listed = topicPage(topics, events, {
      ...(typeof args.query === 'string' ? { query: args.query } : {}),
      offset: integer(args.offset, 0, Number.MAX_SAFE_INTEGER), limit: Math.max(1, integer(args.limit, 12, 20)),
    })
    if (run.scope === 'memory') {
      const byId = new Map(topics.map(t => [t.id, t]))
      return {
        result: {
          ...listed,
          topics: listed.topics.map(entry => {
            const full = byId.get(entry.id)
            if (!full) return entry
            const health = topicSectionHealth(full)
            return {
              ...entry,
              ...(health.unassignedCount > 0 ? { unassignedEventCount: health.unassignedCount } : {}),
              sections: health.sections,
            }
          }),
        },
        evidenceIds,
      }
    }
    return { result: listed, evidenceIds }
  }
  if (tool === 'memory_expand_topic') {
    const topic = topics.find(t => t.id === args.id)
    if (!topic) throw new Error('Unknown topic')
    const membershipSections = memoryTopicMembershipSections(topic)
    if (run.scope === 'memory') {
      const eventMap = new Map(events.map(e => [e.id, e]))
      const groupedSections = memoryTopicSections(topic)
      const assigned = new Set(groupedSections.flatMap(sec => sec.sourceEventIds))
      const unassignedEvents = topic.sourceEventIds
        .filter(id => !assigned.has(id))
        .map(id => {
          const card = eventMap.get(id)
          return card
            ? { id: card.id, title: card.title, status: card.status, ...(card.supersededBy ? { supersededBy: card.supersededBy } : {}), summary: safeSlice(card.summary, 260) }
            : { id }
        })
      const requestedSection = typeof args.section === 'string' && args.section.trim() ? args.section.trim() : null
      const filteredSections = requestedSection
        ? groupedSections.filter(sec => normalizeMemoryTopicLabel(sec.title) === normalizeMemoryTopicLabel(requestedSection))
        : groupedSections
      if (requestedSection && !filteredSections.length) {
        throw new Error(`Unknown section ${JSON.stringify(requestedSection)}; available sections: ${groupedSections.map(s => s.title).join(', ') || '(none)'}`)
      }
      const offset = integer(args.offset, 0, Number.MAX_SAFE_INTEGER)
      const limit = Math.max(1, integer(args.limit, 8, 20))
      const pageSlice = filteredSections.slice(offset, offset + limit).map(sec => {
        const overviewCount = sec.paragraphs.length
        const overviewChars = sec.paragraphs.reduce((sum, part) => sum + Array.from(part.text).length, 0)
        return {
          title: sec.title,
          eventCount: sec.sourceEventIds.length,
          overviewCount,
          overviewChars,
          ...(isBloatedSectionOverview(overviewCount, overviewChars) ? { needsOverviewCondense: true } : {}),
          overview: sec.paragraphs.map(part => ({ kind: part.kind, text: part.text, sourceEventIds: part.sourceEventIds })),
          events: sec.sourceEventIds.slice(0, DREAMING_SECTION_EVENTS_PREVIEW_LIMIT).map(id => {
            const card = eventMap.get(id)
            return card
              ? { id: card.id, title: card.title, status: card.status, ...(card.supersededBy ? { supersededBy: card.supersededBy } : {}), summary: safeSlice(card.summary, 220) }
              : { id }
          }),
          ...(sec.sourceEventIds.length > DREAMING_SECTION_EVENTS_PREVIEW_LIMIT
            ? { omittedEvents: sec.sourceEventIds.length - DREAMING_SECTION_EVENTS_PREVIEW_LIMIT }
            : {}),
        }
      })
      return {
        result: {
          id: topic.id,
          title: topic.title,
          description: topic.description,
          version: memory.getDreamingTopicVersion(topic.id),
          totalEvents: topic.sourceEventIds.length,
          totalSections: groupedSections.length,
          sections: {
            items: pageSlice,
            total: filteredSections.length,
            offset,
            nextOffset: offset + pageSlice.length < filteredSections.length ? offset + pageSlice.length : null,
            contentVersion: dreamingTopicVersion(groupedSections),
          },
          ...(unassignedEvents.length ? { unassignedEvents } : {}),
        },
        evidenceIds,
      }
    }
    return { result: { id: topic.id, title: topic.title, description: topic.description,
      sections: page(membershipSections, args), overview: page(topic.overview, args), totalEvents: topic.sourceEventIds.length }, evidenceIds }
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
      const items = results.map(({ event }) => ({
        id: event.id, title: event.title, status: event.status,
        ...(event.supersededBy ? { supersededBy: event.supersededBy } : {}),
        summary: safeSlice(event.summary, 1500), scope: event.scope, temporal: event.temporal, needsFullRead: event.summary.length > 1500,
      }))
      // Search hits are navigation; source details are either in the initial batch or read explicitly.
      return { result: { items, offset, nextOffset: items.length === limit ? offset + items.length : null }, evidenceIds }
    }
    if (args.kind === 'raw') {
      // Only expose messages actually cited by surviving frozen Event evidence.
      const hits = run.scope === 'memory'
        ? memory.searchDreamingMessages(args.query, limit + 1, offset, typeof args.threadId === 'string' ? args.threadId : undefined)
        : memory.searchRawMemory(args.query, limit + 1, { messageIds: [...new Set(events.flatMap(event => event.sourceMessageIds))], offset })
      return { result: { items: hits.slice(0, limit).map(hit => ({ blockId: hit.blockId ?? null, messageId: hit.message.id,
        threadId: hit.message.threadId ?? null, createdAt: hit.message.createdAt,
        text: safeSlice(hit.message.content, 1500), needsFullRead: hit.message.content.length > 1500 })), offset,
        nextOffset: hits.length > limit ? offset + limit : null }, evidenceIds }
    }
    if (args.kind === 'graph') {
      if (run.scope === 'memory' && !memory.graphEnabled) return { result: { items: [], note: 'Graph is disabled' }, evidenceIds }
      const hits = await memory.searchGraphNodes(args.query, Math.max(1, memory.listGraphNodes().length))
      return { result: page(hits.map(hit => {
        const view = effectiveGraphNodeView(hit.node, memory.listGraphEdges(), events)
        return view ? { id: hit.node.id, name: view.node.name, sourceEventIds: view.currentFacts.flatMap(fact => fact.sourceEventIds) } : null
      }).filter(Boolean), args), evidenceIds }
    }
    if (run.scope === 'memory' && args.kind === 'experiences') {
      const items = memory.searchExperiences(args.query, limit + 1, offset, true)
      return { result: { items: items.slice(0, limit).map(item => ({ id: item.id, title: item.title, scope: item.scope, status: item.status, preview: safeSlice(item.content, 500) })),
        nextOffset: items.length > limit ? offset + limit : null }, evidenceIds }
    }
    if (run.scope === 'memory' && args.kind === 'daily') {
      if (!notes) throw new Error('Daily notes are disabled')
      return { result: await notes.store.read(notes.namespace, { ...(args.query ? { query: args.query } : {}), offset }), evidenceIds }
    }
    throw new Error('Unknown search kind')
  }
  if (tool === 'dreaming_read') {
    if (typeof args.id !== 'string') throw new Error('id is required')
    if (args.kind === 'event') {
      const event = resolveEventByIdOrPrefix(events, args.id)
      if (!event) throw new Error('Event unavailable or changed')
      if (run.scope === 'memory') return { result: { id: event.id, ...textPage(dreamingEventContent(event), args),
        sourceRefs: { [`event:${event.id}`]: dreamingEventVersion(event) } }, evidenceIds }
      const contentVersion = dreamingEventContentVersion(event)
      if (Number(args.offset) > 0 && run.readContentVersions?.[event.id] !== contentVersion) throw new Error('Event page version changed or not started; read from offset 0')
      const result = textPage(dreamingEventContent(event), args)
      if (result.offset === 0 && result.nextOffset === null) evidenceIds.push(event.id)
      // Multi-page reads remain navigable; explicitly acknowledge full coverage in the runner.
      return { result: { id: event.id, ...result, contentVersion }, evidenceIds }
    }
    if (args.kind === 'block') {
      const block = memory.listBlocks().find(block => block.id === args.id)
      if (run.scope === 'memory') {
        if (!block) throw new Error('Unknown Block')
        const visible = new Set(memory.dreamingMessages().map(message => message.id))
        const messages = block.l5Raw.filter(message => visible.has(message.id))
        if (!messages.length) throw new Error('Block has no visible messages')
        const requested = integer(args.level, 5, 5) as BlockLevel
        const level = messages.length === block.l5Raw.length ? requested : 5
        return { result: { id: block.id, level, ...textPage(level === 5 ? messages : renderBlock(block, level), args),
          ...(level === 5 ? { sourceRefs: Object.fromEntries(messages.map(message => [`message:${message.id}`, dreamingTopicVersion(message)])) } : {}) }, evidenceIds }
      }
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
      if (run.scope === 'memory' && !memory.graphEnabled) throw new Error('Graph is disabled')
      const node = memory.listGraphNodes().find(node => node.id === args.id)
      const view = node && effectiveGraphNodeView(node, memory.listGraphEdges(), events)
      if (!view) throw new Error('Graph node unavailable')
      return { result: { id: view.node.id, ...textPage(view, args) }, evidenceIds }
    }
    if (run.scope === 'memory' && args.kind === 'message') {
      const message = memory.dreamingMessages().find(item => item.id === args.id)
      if (!message) throw new Error('Message unavailable')
      return { result: { id: message.id, ...textPage(message, args),
        sourceRefs: { [`message:${message.id}`]: dreamingTopicVersion(message) } }, evidenceIds }
    }
    if (run.scope === 'memory' && args.kind === 'experience') {
      const item = memory.listExperiences(true).find(item => item.id === args.id)
      if (!item) throw new Error('Experience unavailable')
      return { result: { id: item.id, ...textPage(item, args),
        sourceRefs: { [`experience:${item.id}`]: dreamingTopicVersion(item) } }, evidenceIds }
    }
    if (run.scope === 'memory' && args.kind === 'daily') {
      if (!notes) throw new Error('Daily notes are disabled')
      const note = await notes.store.read(notes.namespace, { date: args.id })
      return { result: { id: args.id, ...textPage(note.content ?? '', args) }, evidenceIds }
    }
    throw new Error('Unknown read kind')
  }
  throw new Error('Unknown Dreaming tool')
}

export function dreamingPayload(memory: StrataGate, run: DreamingRun): unknown {
  const unit = run.units[run.cursor]!
  if (run.scope === 'memory') {
    const visible = new Set(memory.dreamingMessages().map(message => message.id))
    const today = toUtc8Iso(memory.currentTime()).slice(0, 10)
    const batchBlockIds = new Set(unit.blockIds ?? [])
    const batchMessageIds = new Set(unit.messageIds ?? [])
    const batchEventIds = new Set(unit.eventIds)
    const batchNoteDates = new Set(unit.noteDates ?? [])
    const runBlockIds = new Set(run.units.flatMap(item => item.blockIds ?? []))
    const runMessageIds = new Set(run.units.flatMap(item => item.messageIds ?? []))
    const runEventIds = new Set(run.units.flatMap(item => item.eventIds))
    const runNoteDates = new Set(run.units.flatMap(item => item.noteDates ?? []))
    const eventPath = (event: EventCard) => ({
      id: event.id,
      title: event.title,
      status: event.status,
      createdAt: event.createdAt,
      updatedAt: event.updatedAt,
      ...(event.tags.includes('agent-recorded') ? { source: 'agent-recorded' as const } : {}),
      ...(event.sourceBlockId ? { sourceBlockId: event.sourceBlockId } : {}),
    })
    const blockPath = (block: ReturnType<StrataGate['listBlocks']>[number]) => ({
      id: block.id,
      threadId: block.threadId,
      createdAt: block.createdAt,
      turns: [block.startTurn, block.endTurn] as const,
      ...(block.l5Raw.every(message => visible.has(message.id)) ? { title: block.l0Title } : {}),
    })
    const visibleEvents = dreamingEvents(memory, run)
    const sameDay = (iso: string) => {
      const time = Date.parse(iso)
      return Number.isFinite(time) && toUtc8Iso(time).slice(0, 10) === today
    }
    const otherEvents = visibleEvents
      .filter(event => !batchEventIds.has(event.id) && (
        runEventIds.has(event.id)
        || sameDay(event.createdAt)
        || sameDay(event.updatedAt)
        || (event.sourceBlockId !== undefined && batchBlockIds.has(event.sourceBlockId))
        || event.sourceMessageIds.some(id => batchMessageIds.has(id))
      ))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id))
      .slice(0, 100)
      .map(eventPath)
    const otherBlocks = memory.listBlocks()
      .filter(block => !batchBlockIds.has(block.id)
        && block.l5Raw.some(message => visible.has(message.id))
        && (runBlockIds.has(block.id) || sameDay(block.createdAt)))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
      .slice(0, 60)
      .map(blockPath)
    const otherOpenMessages = memory.listOpenTail()
      .filter(message => !batchMessageIds.has(message.id)
        && visible.has(message.id)
        && (runMessageIds.has(message.id) || sameDay(message.createdAt)))
      .slice(0, 60)
      .map(({ id, threadId, createdAt, role }) => ({ id, threadId, createdAt, role }))
    const otherNoteDates = [...runNoteDates].filter(date => !batchNoteDates.has(date))
    const todayAndChanged = {
      ...(otherEvents.length ? { events: otherEvents } : {}),
      ...(otherBlocks.length ? { blocks: otherBlocks } : {}),
      ...(otherOpenMessages.length ? { openMessages: otherOpenMessages } : {}),
      ...(otherNoteDates.length ? { noteDates: otherNoteDates } : {}),
    }
    const visibleTopics = memory.listMemoryTopics(visibleEvents.map(event => event.id)).filter(topic => !topic.isFallback)
    const directoryOverview = visibleTopics.length ? buildDreamingDirectoryOverview(visibleTopics) : null
    return {
      scope: 'memory', completedBatches: run.cursor, totalBatches: run.units.length, trigger: run.trigger,
      blocks: memory.listBlocks().filter(block => unit.blockIds?.includes(block.id) && block.l5Raw.some(message => visible.has(message.id))).map(block => ({
        id: block.id, threadId: block.threadId, createdAt: block.createdAt, turns: [block.startTurn, block.endTurn],
        ...(block.l5Raw.every(message => visible.has(message.id)) ? { title: block.l0Title, summary: block.l1Summary?.slice(0, 400) } : {}),
      })),
      openMessages: memory.listOpenTail().filter(message => visible.has(message.id) && unit.messageIds?.includes(message.id))
        .map(({ id, threadId, createdAt, role }) => ({ id, threadId, createdAt, role })),
      events: visibleEvents.filter(event => batchEventIds.has(event.id)).map(eventPath),
      experiencesToReview: unit.experienceIds?.length ? memory.listExperiences(true)
        .filter(item => item.status === 'needs-review' && unit.experienceIds?.includes(item.id)).map(({ id, title }) => ({ id, title })) : [],
      noteDates: unit.noteDates ?? [], graphEnabled: memory.graphEnabled,
      ...(directoryOverview ? { directoryOverview } : {}),
      ...(Object.keys(todayAndChanged).length ? { todayAndChanged } : {}),
      lastWriteFailure: run.lastWriteFailure ? { error: run.lastWriteFailure.error } : null,
      savedChanges: run.changedBatches,
    }
  }
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
      ? run.scope === 'memory' ? '已暂停，进度已保存'
        : run.replanRequired ? '需要重新开始；后台目录整理等待本轮终止' : '已暂停；后台目录整理等待本轮继续或终止'
      : run.activity,
    reason: interrupted ? '上次运行已中断，可以继续' : legacyBoundary ? '上次整理已暂停，可以继续；已完成的修改已保存。' : run.reason,
    waitingForProjection: !!run.waitingForProjection, replanRequired: !!run.replanRequired,
    completed: run.cursor, total: run.units.length, changedBatches: run.changedBatches, calls: run.calls,
    estimatedTokens: run.estimatedTokens,
    changes: run.changes ?? { editedEvents: 0, deletedEvents: 0, experiences: 0, items: [] },
    letter: run.letter ?? null,
    updatedAt: run.updatedAt }
}
