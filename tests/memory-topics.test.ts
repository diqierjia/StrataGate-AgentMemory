import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Session } from '@deepseek-ai/dsh-session'
import {
  estimateTokens, memoryTopicEventFingerprint, StorageConflictError, StrataGate, type MemoryTopic, type StrataGateSnapshot,
  type TopicProjectionContext, type TopicProjectionResult,
} from '@diqier/stratagate'
import { describe, expect, it, vi } from 'vitest'
import type { ResolvedConfig } from '../src/config.js'
import type { DshModelBridge } from '../src/llm.js'
import { StrataGateRuntime } from '../src/runtime.js'
import { DshMetadataStore, TOPIC_BOOTSTRAP_WINDOW_MS, TOPIC_BOOTSTRAP_WINDOW_CALLS } from '../src/metadata.js'

interface SeedEvent {
  id: string
  title: string
  summary: string
  topic: string
}

interface TopicPage {
  namespace: string
  navigationOnly: true
  total: number
  offset: number
  nextOffset: number | null
  categories: Array<{ id: string; label: string; count: number }>
  topics: Array<Pick<MemoryTopic, 'id' | 'title' | 'description' | 'coverage' | 'isFallback'> & {
    category: string
    sourceEventCount: number
  }>
}

interface EventBatch {
  batchId: string
  evidenceRefs: string[]
  results: Array<{ id: string }>
}

interface TopicEventBatch extends EventBatch {
  totalSourceEvents: number | null
  offset: number
  nextOffset: number | null
}

function makeSession(id: string, query = 'pnpm 部署', cwd = 'C:\\work\\memory-topics'): Session {
  return {
    id,
    header: { id, version: 0, createdAt: 0, cwd },
    snapshotEvents: () => [],
    eventAt: () => undefined,
    deriveMessages: () => [{
      id: `${id}-user`, role: 'user', content: [{ type: 'text', text: query }], source: { kind: 'user' },
    }],
  } as unknown as Session
}

function makeModels(): { models: DshModelBridge; topicCalls: ReturnType<typeof vi.fn> } {
  const topicCalls = vi.fn(async () => ({ topics: [] }))
  const models = {
    run: async <T>(_session: Session, operation: () => Promise<T>): Promise<T> => operation(),
    runDetached: async <T>(_sessionId: string, operation: () => Promise<T>): Promise<T> => operation(),
    // Read-path tests control projections explicitly; no background timer calls a real model.
    isReady: () => false,
    onAdaptersUpdated: () => () => {},
    summarizer: async () => ({ l0Title: '资料', l0Tags: [], l1Summary: '资料', l2Keypoints: [], shouldExtract: false }),
    extractor: async () => ({ shouldExtract: false, reason: 'none', events: [] }),
    graphProjector: async () => ({ reason: 'none', nodes: [], edges: [] }),
    topicProjector: topicCalls,
  } as unknown as DshModelBridge
  return { models, topicCalls }
}

function makeConfig(database: string, namespaceMode: 'session' | 'project' = 'session'): ResolvedConfig {
  return {
    database, namespaceMode, namespacePrefix: 'dsh', globalNamespace: 'global',
    blockTurnSize: 1, blockDecayLambda: 0.3, ingestSubagents: false, maxOutputTokens: 2048,
  }
}

async function seed(database: string, namespace: string, events: SeedEvent[], projectTopics = true): Promise<MemoryTopic[]> {
  const memory = await StrataGate.open({ database, namespace, blockTurnSize: 1 })
  try {
    await memory.appendTurn({ user: '历史资料来源', assistant: '已保存', threadId: 'historical-source' }, { deferDerivation: true })
    const block = memory.listBlocks()[0]!
    for (const event of events) await memory.addEvent({
      id: event.id, title: event.title, summary: event.summary,
      sourceBlockId: block.id, sourceMessageIds: [block.l5Raw[0]!.id],
    })
    if (projectTopics) {
      const byId = new Map(events.map((event) => [event.id, event]))
      while (true) {
        const context = await memory.claimNextTopicProjection()
        if (!context) break
        const groups = new Map<string, string[]>()
        for (const event of context.events) {
          const label = byId.get(event.id)!.topic
          groups.set(label, [...(groups.get(label) ?? []), event.id])
        }
        await memory.completeTopicProjection(context.jobId, {
          topics: [...groups].map(([title, sourceEventIds]) => ({
            ...(context.existingTopics.find((topic) => topic.title === title)?.id
              ? { topicId: context.existingTopics.find((topic) => topic.title === title)!.id }
              : {}),
            title, description: `包含${title}的讨论记录，需查看事件核实。`, sourceEventIds,
            overview: [{ kind: 'history' as const, text: `${title}记录过相关选择；当前状态需核实。`, sourceEventIds }],
          })),
        })
      }
    }
    expect(memory.listGraphNodes()).toHaveLength(0)
    return memory.listMemoryTopics()
  } finally {
    await memory.close()
  }
}

/** Simulate a namespace created by the released pre-topic writer. */
function removeLegacyTopicState(database: string, namespace: string): void {
  const legacy = new DatabaseSync(database)
  try { legacy.prepare('DELETE FROM memory_topic_state WHERE namespace = ?').run(namespace) }
  finally { legacy.close() }
}

function topicBudget(database: string): string | undefined {
  const reader = new DatabaseSync(database, { readOnly: true })
  try {
    return (reader.prepare("SELECT value FROM stratagate_dsh_settings WHERE key = 'topicBootstrapBudget'")
      .get() as { value: string } | undefined)?.value
  } finally { reader.close() }
}

function adoption(snapshot: StrataGateSnapshot | null): unknown {
  expect(snapshot).not.toBeNull()
  return {
    events: [...snapshot!.events, ...snapshot!.agentEvents].map((event) => ({
      id: event.id, mentions: event.weight.mentionCount, adoptedAt: event.weight.lastAdoptedTurn,
    })),
    receipts: snapshot!.usageReceipts,
  }
}

function manualWorker(runtime: StrataGateRuntime): { runBackgroundNamespace: (namespace: string) => Promise<void> } {
  const controlled = runtime as unknown as {
    backgroundWorkerTimer: ReturnType<typeof setTimeout> | undefined
    runBackgroundNamespace: (namespace: string) => Promise<void>
  }
  if (controlled.backgroundWorkerTimer) clearTimeout(controlled.backgroundWorkerTimer)
  controlled.backgroundWorkerTimer = undefined
  return controlled
}

const deploymentEvents: SeedEvent[] = [
  { id: 'event-pnpm', title: 'pnpm 部署决定', summary: '历史部署采用 pnpm。', topic: '部署与迁移' },
  { id: 'event-migration', title: 'pnpm 迁移计划', summary: 'pnpm 迁移只是计划，尚未确认完成。', topic: '部署与迁移' },
  { id: 'event-other', title: 'pnpm 另一个项目', summary: '另一个项目也讨论过 pnpm。', topic: '其他项目资料' },
]

describe('memory topic runtime boundaries', () => {
  it('discovers events without graph nodes and reads navigation without model calls or adoption', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-topic-navigation-'))
    const database = join(directory, 'memory.db')
    const session = makeSession('topic-navigation')
    const { models, topicCalls } = makeModels()
    const runtime = new StrataGateRuntime(makeConfig(database), models)
    try {
      const namespace = runtime.namespaceFor(session)
      const topics = await seed(database, namespace, deploymentEvents)
      const before = adoption(await runtime.adminSnapshot(namespace))
      const rendered = await runtime.buildMemoryDirectory(session)
      expect(rendered).toContain('部署与迁移')
      expect(rendered).toMatch(/导航|navigation/iu)
      const page = await runtime.listTopics(session) as TopicPage
      expect(page).toMatchObject({ namespace, navigationOnly: true, total: topics.length })
      expect(page.topics.map((topic) => topic.title)).toContain('部署与迁移')
      expect(page).not.toHaveProperty('batchId')
      expect(page).not.toHaveProperty('evidenceRefs')
      const topic = page.topics.find((item) => item.title === '部署与迁移')!
      const expanded = await runtime.expandTopic(session, topic.id)
      expect(expanded).toMatchObject({
        namespace, navigationOnly: true,
        topic: { id: topic.id, sourceEventIds: expect.arrayContaining(['event-pnpm', 'event-migration']) },
        eventRetrieval: { tool: 'memory_search_events', topic_id: topic.id },
      })
      expect(expanded).not.toHaveProperty('batchId')
      expect(expanded).not.toHaveProperty('evidenceRefs')
      // The existing automatic Event retrieval remains available beside the directory.
      expect(await runtime.buildAutoContext(session)).toContain('pnpm')
      expect(adoption(await runtime.adminSnapshot(namespace))).toEqual(before)
      expect(topicCalls).not.toHaveBeenCalled()
    } finally {
      await runtime.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('limits topic retrieval to its Event sources and retains the existing assessment/adoption gate', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-topic-evidence-'))
    const database = join(directory, 'memory.db')
    const session = makeSession('topic-evidence')
    const runtime = new StrataGateRuntime(makeConfig(database), makeModels().models)
    try {
      const namespace = runtime.namespaceFor(session)
      const topics = await seed(database, namespace, deploymentEvents)
      const topic = topics.find((item) => item.title === '部署与迁移')!
      const before = (await runtime.adminSnapshot(namespace))!
      const batch = await runtime.searchEvents(session, 'pnpm', { topicId: topic.id }) as EventBatch
      expect(new Set(batch.results.map(({ id }) => id))).toEqual(new Set(['event-pnpm', 'event-migration']))
      expect(batch.evidenceRefs.every((ref) => ref.startsWith('event:'))).toBe(true)
      expect(batch.evidenceRefs).not.toContain(`topic:${topic.id}`)
      await expect(runtime.recordUse(session, 'premature', batch.evidenceRefs, batch.batchId)).rejects.toThrow()
      await runtime.assess(session, {
        verdict: 'sufficient', evidence_refs: ['event:event-pnpm'],
        fit: '原事件记录了选择。', missing: '', next_strategy: 'answer',
      }, batch.batchId)
      await runtime.recordUse(session, 'selected-event', ['event:event-pnpm'], batch.batchId)
      const after = (await runtime.adminSnapshot(namespace))!
      const mentions = (snapshot: StrataGateSnapshot, id: string) => snapshot.events.find((event) => event.id === id)!.weight.mentionCount
      expect(mentions(after, 'event-pnpm')).toBe(mentions(before, 'event-pnpm') + 1)
      expect(mentions(after, 'event-migration')).toBe(mentions(before, 'event-migration'))
      expect(mentions(after, 'event-other')).toBe(mentions(before, 'event-other'))
      await expect(runtime.searchEvents(session, 'pnpm', { topicId: 'missing-topic' })).rejects.toThrow()
    } finally {
      await runtime.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('refreshes another connection\'s forgotten source before exposing directory titles, descriptions or overviews', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-topic-forgetting-'))
    const database = join(directory, 'memory.db')
    const session = makeSession('topic-forgetting', '普通资料')
    const runtime = new StrataGateRuntime(makeConfig(database), makeModels().models)
    try {
      const namespace = runtime.namespaceFor(session)
      const topics = await seed(database, namespace, [
        { id: 'secret', title: '私密代号海棠', summary: '海棠是私密来源。', topic: '海棠私密资料' },
        { id: 'public', title: '普通部署资料', summary: '普通部署资料仍可查看。', topic: '海棠私密资料' },
      ])
      const id = topics[0]!.id
      expect(await runtime.buildMemoryDirectory(session)).toContain('海棠')
      await runtime.expandTopic(session, id)
      const other = await StrataGate.open({ database, namespace })
      try { await other.forgetEvent('secret') } finally { await other.close() }
      expect(JSON.stringify((await runtime.adminSnapshot(namespace))!.memoryTopicState)).not.toContain('海棠')
      const adminEntries = await runtime.adminSnapshotEntries()
      expect(JSON.stringify(adminEntries.find((entry) => entry.namespace === namespace)!.snapshot.memoryTopicState)).not.toContain('海棠')
      expect(await runtime.buildMemoryDirectory(session)).not.toContain('海棠')
      const page = await runtime.listTopics(session) as TopicPage
      expect(JSON.stringify(page)).not.toContain('海棠')
      const expanded = await runtime.expandTopic(session, id)
      expect(JSON.stringify(expanded)).not.toContain('海棠')
      expect(expanded).toMatchObject({ topic: { sourceEventIds: ['public'], overview: [], isFallback: true } })
      expect((await runtime.listTopics(session, { query: '海棠' }) as TopicPage).topics).toEqual([])
      const forgottenAll = await StrataGate.open({ database, namespace })
      try { await forgottenAll.forgetEvent('public') } finally { await forgottenAll.close() }
      expect((await runtime.listTopics(session) as TopicPage).topics).toEqual([])
      await expect(runtime.expandTopic(session, id)).rejects.toThrow()
    } finally {
      await runtime.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('isolates equal Event ids and cached topics between project namespaces', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-topic-isolation-'))
    const database = join(directory, 'memory.db')
    const runtime = new StrataGateRuntime(makeConfig(database, 'project'), makeModels().models)
    const first = makeSession('first', '项目资料', 'C:\\work\\project-a')
    const second = makeSession('second', '项目资料', 'C:\\work\\project-b')
    try {
      const firstNamespace = runtime.namespaceFor(first)
      const secondNamespace = runtime.namespaceFor(second)
      expect(firstNamespace).not.toBe(secondNamespace)
      const firstTopics = await seed(database, firstNamespace, [
        { id: 'same-id', title: '甲项目资料', summary: '甲项目私有内容。', topic: '甲项目主题' },
      ])
      await seed(database, secondNamespace, [
        { id: 'same-id', title: '乙项目资料', summary: '乙项目私有内容。', topic: '乙项目主题' },
      ])
      expect(await runtime.buildMemoryDirectory(first)).toContain('甲项目主题')
      expect(await runtime.buildMemoryDirectory(second)).not.toContain('甲项目主题')
      expect(JSON.stringify(await runtime.listTopics(second))).toContain('乙项目主题')
      await expect(runtime.expandTopic(second, firstTopics[0]!.id)).rejects.toThrow()
      await expect(runtime.searchEvents(second, '项目', { topicId: firstTopics[0]!.id })).rejects.toThrow()
    } finally {
      await runtime.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('bounds the default directory and exposes every omitted topic through pagination', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-topic-pagination-'))
    const database = join(directory, 'memory.db')
    const session = makeSession('topic-pagination', '目录')
    const runtime = new StrataGateRuntime(makeConfig(database), makeModels().models)
    try {
      const namespace = runtime.namespaceFor(session)
      const events = Array.from({ length: 35 }, (_, index) => ({
        id: `entry-${index}`, title: `资料 ${index}`, summary: `讨论资料 ${index} 的历史选择。`,
        topic: `主题 ${index} ${'有来源的资料覆盖说明'.repeat(5)}`,
      }))
      await seed(database, namespace, events)
      const rendered = await runtime.buildMemoryDirectory(session)
      expect(estimateTokens(rendered)).toBeLessThanOrEqual(400)
      expect(rendered).toMatch(/memory_list_topics|分页/u)
      const collected = new Set<string>()
      let offset = 0
      for (let pages = 0; pages < 10; pages += 1) {
        const page = await runtime.listTopics(session, { offset, limit: 7 }) as TopicPage
        expect(page.total).toBe(events.length)
        expect(page.topics.length).toBeLessThanOrEqual(7)
        for (const topic of page.topics) {
          expect(collected.has(topic.id)).toBe(false)
          collected.add(topic.id)
        }
        if (page.nextOffset === null) break
        expect(page.nextOffset).toBeGreaterThan(offset)
        offset = page.nextOffset
      }
      expect(collected.size).toBe(events.length)
    } finally {
      await runtime.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('paginates every source of a large topic and keeps later pages stable after adoption', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-topic-event-pages-'))
    const database = join(directory, 'memory.db')
    const session = makeSession('topic-event-pages', '查看主题')
    const runtime = new StrataGateRuntime(makeConfig(database), makeModels().models)
    try {
      const namespace = runtime.namespaceFor(session)
      const events = Array.from({ length: 25 }, (_, index) => ({
        id: `topic-source-${index}`, title: `部署记录 ${index}`, summary: `部署历史记录 ${index}。`, topic: '完整部署历史',
      }))
      const [topic] = await seed(database, namespace, events)
      const first = await runtime.searchEvents(session, '', { topicId: topic!.id, offset: 0, limit: 20 }) as TopicEventBatch
      expect(first).toMatchObject({ totalSourceEvents: 25, offset: 0, nextOffset: 20 })
      expect(first.results).toHaveLength(20)
      const secondBefore = await runtime.searchEvents(session, '', { topicId: topic!.id, offset: 20, limit: 20 }) as TopicEventBatch
      expect(secondBefore).toMatchObject({ totalSourceEvents: 25, offset: 20, nextOffset: null })
      expect(secondBefore.results).toHaveLength(5)
      expect(new Set([...first.results, ...secondBefore.results].map(({ id }) => id)).size).toBe(25)
      await runtime.assess(session, {
        verdict: 'sufficient', evidence_refs: [first.evidenceRefs[0]!],
        fit: '采用这一原始事件。', missing: '', next_strategy: 'answer',
      }, first.batchId)
      await runtime.recordUse(session, 'first-page-adoption', [first.evidenceRefs[0]!], first.batchId)
      const secondAfter = await runtime.searchEvents(session, '', { topicId: topic!.id, offset: 20, limit: 20 }) as TopicEventBatch
      expect(secondAfter.results.map(({ id }) => id)).toEqual(secondBefore.results.map(({ id }) => id))
      const firstAfter = await runtime.searchEvents(session, '', { topicId: topic!.id, offset: 0, limit: 20 }) as TopicEventBatch
      expect(firstAfter.results.map(({ id }) => id)).toEqual(first.results.map(({ id }) => id))
    } finally {
      await runtime.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('bounds the whole expanded response and reports omitted overview paragraphs', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-topic-expanded-budget-'))
    const database = join(directory, 'memory.db')
    const session = makeSession('topic-expanded-budget')
    const runtime = new StrataGateRuntime(makeConfig(database), makeModels().models)
    try {
      const namespace = runtime.namespaceFor(session)
      await seed(database, namespace, [deploymentEvents[0]!], false)
      const writer = await StrataGate.open({ database, namespace })
      let topicId: string
      try {
        const context = (await writer.claimNextTopicProjection())!
        const sourceEventIds = context.events.map(({ id }) => id)
        const result = await writer.completeTopicProjection(context.jobId, {
          topics: [{
            title: '主题'.repeat(60), description: '范围'.repeat(200), sourceEventIds,
            overview: Array.from({ length: 8 }, (_, index) => ({
              kind: 'scope' as const, text: `${index} ${'资料覆盖'.repeat(149)}`, sourceEventIds,
            })),
          }],
        })
        topicId = result.topicIds[0]!
      } finally { await writer.close() }
      const expanded = await runtime.expandTopic(session, topicId) as {
        topic: { overview: unknown[]; omittedOverviewParagraphs: number }
      }
      expect(estimateTokens(JSON.stringify(expanded))).toBeLessThanOrEqual(2_400)
      expect(expanded.topic.omittedOverviewParagraphs).toBeGreaterThan(0)
      expect(expanded.topic.overview.length + expanded.topic.omittedOverviewParagraphs).toBe(8)
    } finally {
      await runtime.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('hides agent-dependent topic prose even when the model claims only passive sources', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-topic-disabled-agent-'))
    const database = join(directory, 'memory.db')
    const session = makeSession('topic-disabled-agent')
    const runtime = new StrataGateRuntime({ ...makeConfig(database), agentMemoryRetrievalWeight: 0 }, makeModels().models)
    try {
      const namespace = runtime.namespaceFor(session)
      await seed(database, namespace, [deploymentEvents[0]!], false)
      const worker = await StrataGate.open({ database, namespace })
      try {
        const recorded = await worker.recordAgentEvent({
          content: '个人特别偏好海棠编辑器', category: 'preference', threadId: 'historical-source',
        })
        expect(recorded.eventId).toBeDefined()
        const context = await worker.claimNextTopicProjection()
        expect(context).not.toBeNull()
        expect(context!.events.map(({ id }) => id)).toContain(recorded.eventId)
        const sourceEventIds = ['event-pnpm']
        await worker.completeTopicProjection(context!.jobId, {
          topics: [{
            title: '海棠与部署混合资料', description: '海棠编辑器偏好及部署记录。', sourceEventIds,
            overview: [{ kind: 'history', text: '曾记录海棠偏好和 pnpm 部署。', sourceEventIds }],
          }, {
            title: '海棠偏好', description: '包含编辑器偏好。', sourceEventIds: [recorded.eventId!],
            overview: [{ kind: 'history', text: '曾记录海棠编辑器偏好。', sourceEventIds: [recorded.eventId!] }],
          }],
        })
      } finally { await worker.close() }
      const before = adoption(await runtime.adminSnapshot(namespace))
      expect(await runtime.buildMemoryDirectory(session)).not.toContain('海棠')
      const page = await runtime.listTopics(session) as TopicPage
      expect(JSON.stringify(page)).not.toContain('海棠')
      expect(page.topics).toEqual([expect.objectContaining({ isFallback: true, sourceEventCount: 1 })])
      const expanded = await runtime.expandTopic(session, page.topics[0]!.id)
      expect(expanded).toMatchObject({ topic: { sourceEventIds: ['event-pnpm'], overview: [], isFallback: true } })
      expect(JSON.stringify(expanded)).not.toContain('海棠')
      expect(adoption(await runtime.adminSnapshot(namespace))).toEqual(before)
    } finally {
      await runtime.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('keeps pending and failed projections discoverable through fallback entries and ordinary Event search', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-topic-fallback-'))
    const database = join(directory, 'memory.db')
    const session = makeSession('topic-fallback')
    const { models, topicCalls } = makeModels()
    const runtime = new StrataGateRuntime(makeConfig(database), models)
    try {
      const namespace = runtime.namespaceFor(session)
      await seed(database, namespace, [deploymentEvents[0]!], false)
      const worker = await StrataGate.open({ database, namespace })
      try {
        const context = await worker.claimNextTopicProjection()
        expect(context).not.toBeNull()
        await worker.failTopicProjection(context!.jobId, new Error('模拟模型失败'))
      } finally { await worker.close() }
      const before = adoption(await runtime.adminSnapshot(namespace))
      const page = await runtime.listTopics(session) as TopicPage
      expect(page.topics).toEqual([expect.objectContaining({ isFallback: true, sourceEventCount: 1 })])
      expect(await runtime.buildMemoryDirectory(session)).toContain('pnpm 部署决定')
      const batch = await runtime.searchEvents(session, 'pnpm') as EventBatch
      expect(batch.results.map(({ id }) => id)).toEqual(['event-pnpm'])
      expect(adoption(await runtime.adminSnapshot(namespace))).toEqual(before)
      expect(topicCalls).not.toHaveBeenCalled()
    } finally {
      await runtime.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('reads a pre-topic schema-12 database before any writer migration and keeps its original Events', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-topic-old-schema-'))
    const database = join(directory, 'memory.db')
    const session = makeSession('topic-old-schema')
    const runtime = new StrataGateRuntime(makeConfig(database), makeModels().models)
    try {
      const namespace = runtime.namespaceFor(session)
      await seed(database, namespace, [deploymentEvents[0]!], false)
      const legacy = new DatabaseSync(database)
      try {
        // This table did not exist in the previously released schema 12.
        legacy.exec('DROP TABLE memory_topic_state')
      } finally { legacy.close() }
      const before = (await runtime.adminSnapshot(namespace))!
      expect(before.events.map(({ id }) => id)).toEqual(['event-pnpm'])
      expect((await runtime.adminSnapshotEntries()).find((entry) => entry.namespace === namespace)?.snapshot.events)
        .toEqual(before.events)
      expect(await runtime.buildMemoryDirectory(session)).toContain('pnpm 部署决定')
      const after = (await runtime.adminSnapshot(namespace))!
      expect(after.events).toEqual(before.events)
      expect(after.blocks.flatMap(({ l5Raw }) => l5Raw)).toEqual(before.blocks.flatMap(({ l5Raw }) => l5Raw))
    } finally {
      await runtime.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('processes one bounded topic batch per offline namespace round and reuses the topic id on the next round', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-topic-background-batch-'))
    const database = join(directory, 'memory.db')
    const namespace = 'dsh:project:offline-topic-history'
    const topicProjector = vi.fn(async (context: TopicProjectionContext): Promise<TopicProjectionResult> => ({
      topics: [{
        ...(context.existingTopics[0] ? { topicId: context.existingTopics[0].id } : {}),
        title: '长期部署主题', description: '记录部署选择和迁移经过。',
        sourceEventIds: context.events.map(({ id }) => id),
        overview: [{ kind: 'history', text: '本批记录讨论过部署选择。', sourceEventIds: context.events.map(({ id }) => id) }],
      }],
    }))
    const errors: unknown[] = []
    const runtime = new StrataGateRuntime(makeConfig(database), {
      ...makeModels().models, isReady: () => true, topicProjector,
    } as unknown as DshModelBridge, (error) => errors.push(error))
    const worker = manualWorker(runtime)
    try {
      await seed(database, namespace, Array.from({ length: 25 }, (_, index) => ({
        id: `offline-${index}`, title: `pnpm 部署记录 ${index}`, summary: `部署选择记录 ${index}。`, topic: '长期部署主题',
      })), false)
      await worker.runBackgroundNamespace(namespace)
      expect(topicProjector).toHaveBeenCalledTimes(1)
      expect(topicProjector.mock.calls[0]![0].events).toHaveLength(12)
      const first = (await runtime.adminSnapshot(namespace))!
      expect(first.memoryTopicState!.topics).toHaveLength(1)
      const firstTopicId = first.memoryTopicState!.topics[0]!.id
      expect(first.memoryTopicState!.topics[0]!.sourceEventIds).toHaveLength(12)
      await worker.runBackgroundNamespace(namespace)
      expect(topicProjector).toHaveBeenCalledTimes(2)
      expect(errors).toEqual([])
      expect(topicProjector.mock.calls[1]![0].events).toHaveLength(12)
      expect(topicProjector.mock.calls[1]![0].existingTopics.map(({ id }) => id)).toContain(firstTopicId)
      const second = (await runtime.adminSnapshot(namespace))!
      expect(second.memoryTopicState!.topics).toHaveLength(1)
      expect(second.memoryTopicState!.topics[0]!).toMatchObject({ id: firstTopicId })
      expect(second.memoryTopicState!.topics[0]!.sourceEventIds).toHaveLength(24)
      expect(new Set(topicProjector.mock.calls.flatMap(([context]) => context.events.map(({ id }) => id))).size).toBe(24)
    } finally {
      await runtime.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('retries a transient topic commit conflict without repeating the model or changing source semantics', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-topic-background-conflict-'))
    const database = join(directory, 'memory.db')
    const namespace = 'dsh:project:topic-storage-conflict'
    const topicProjector = vi.fn(async (context: TopicProjectionContext): Promise<TopicProjectionResult> => ({
      topics: [{
        title: '部署选择', description: '记录历史部署选择，需查看事件核实。',
        sourceEventIds: context.events.map(({ id }) => id),
        overview: [{ kind: 'history', text: '历史部署采用 pnpm。', sourceEventIds: context.events.map(({ id }) => id) }],
      }],
    }))
    const errors: unknown[] = []
    const runtime = new StrataGateRuntime(makeConfig(database), {
      ...makeModels().models, isReady: () => true, topicProjector,
    } as unknown as DshModelBridge, (error) => errors.push(error))
    const worker = manualWorker(runtime)
    const originalComplete = StrataGate.prototype.completeTopicProjection
    let conflictInjected = false
    const complete = vi.spyOn(StrataGate.prototype, 'completeTopicProjection')
      .mockImplementation(async function (this: StrataGate, jobId, result) {
        if (!conflictInjected) {
          conflictInjected = true
          throw new StorageConflictError(namespace, this.storageRevision, this.storageRevision + 1)
        }
        return originalComplete.call(this, jobId, result)
      })
    try {
      await seed(database, namespace, [deploymentEvents[0]!], false)
      const before = (await runtime.adminSnapshot(namespace))!
      const fingerprint = memoryTopicEventFingerprint(before.events[0]!)
      await worker.runBackgroundNamespace(namespace)
      expect(topicProjector).toHaveBeenCalledTimes(1)
      expect(complete).toHaveBeenCalledTimes(2)
      expect(complete.mock.calls[1]![0]).toBe(complete.mock.calls[0]![0])
      expect(complete.mock.calls[1]![1]).toBe(complete.mock.calls[0]![1])
      expect(errors).toEqual([])
      const after = (await runtime.adminSnapshot(namespace))!
      expect(after.memoryTopicState!.jobs).toHaveLength(1)
      expect(after.memoryTopicState!.jobs[0]).toMatchObject({
        status: 'completed', attempts: 1, lastError: null, nextRetryAt: null,
      })
      expect(after.memoryTopicState!.topics).toHaveLength(1)
      expect(after.memoryTopicState!.topics[0]).toMatchObject({
        title: '部署选择', sourceEventIds: ['event-pnpm'],
      })
      expect(memoryTopicEventFingerprint(after.events[0]!)).toBe(fingerprint)
    } finally {
      complete.mockRestore()
      await runtime.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('persists a database-wide backfill budget across restarts, prioritizes new Events and resumes in later windows', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-topic-budget-'))
    const database = join(directory, 'memory.db')
    const namespace = 'dsh:project:large-history'
    let now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    const topicProjector = vi.fn(async (context: TopicProjectionContext): Promise<TopicProjectionResult> => ({
      topics: [{ ...(context.existingTopics[0] ? { topicId: context.existingTopics[0].id } : {}),
        title: '部署历史', description: '按来源查看部署经过', sourceEventIds: context.events.map(({ id }) => id), overview: [] }],
    }))
    const createRuntime = () => new StrataGateRuntime(makeConfig(database), {
      ...makeModels().models, isReady: () => true, topicProjector,
    } as unknown as DshModelBridge)
    let runtime = createRuntime()
    let worker = manualWorker(runtime)
    try {
      const history = Array.from({ length: 61 }, (_, index) => ({
        id: `history-${index}`, title: `部署记录 ${index}`, summary: `历史部署 ${index}`, topic: '部署历史',
      }))
      await seed(database, namespace, history, false)
      removeLegacyTopicState(database, namespace)
      for (let round = 0; round < 6; round += 1) await worker.runBackgroundNamespace(namespace)
      expect(topicProjector).toHaveBeenCalledTimes(TOPIC_BOOTSTRAP_WINDOW_CALLS)
      const first = (await runtime.adminSnapshot(namespace))!
      const topicId = first.memoryTopicState!.topics[0]!.id
      expect(Object.keys(first.memoryTopicState!.projectedVersions)).toHaveLength(24)
      expect(first.memoryTopicState!.bootstrap?.status).toBe('running')
      const paidIds = new Set(topicProjector.mock.calls.flatMap(([context]) => context.events.map(({ id }) => id)))
      await runtime.close()
      runtime = createRuntime(); worker = manualWorker(runtime)
      await worker.runBackgroundNamespace(namespace)
      expect(topicProjector).toHaveBeenCalledTimes(2)
      expect((await runtime.adminSnapshot(namespace))!.memoryTopicState!.topics[0]!.id).toBe(topicId)
      await seed(database, namespace, [{ id: 'new-incremental', title: '新的部署决定', summary: '新增资料', topic: '部署历史' }], false)
      await worker.runBackgroundNamespace(namespace)
      expect(topicProjector).toHaveBeenCalledTimes(3)
      expect(topicProjector.mock.calls[2]![0].events.map(({ id }) => id)).toEqual(['new-incremental'])
      await seed(database, 'dsh:project:other-history', history.slice(0, 3), false)
      removeLegacyTopicState(database, 'dsh:project:other-history')
      await worker.runBackgroundNamespace('dsh:project:other-history')
      expect(topicProjector).toHaveBeenCalledTimes(3) // Other namespaces share the same allowance.
      const frozen = (await runtime.adminSnapshot(namespace))!.memoryTopicState!.bootstrap!
      expect(Object.keys(frozen.sourceVersions)).toHaveLength(61)
      expect(frozen.sourceVersions['new-incremental']).toBeUndefined()
      for (let window = 0; window < 2; window += 1) {
        now += TOPIC_BOOTSTRAP_WINDOW_MS
        for (let round = 0; round < 4; round += 1) await worker.runBackgroundNamespace(namespace)
      }
      expect(topicProjector).toHaveBeenCalledTimes(7) // Six historical batches + one incremental batch.
      const allIds = topicProjector.mock.calls.flatMap(([context]) => context.events.map(({ id }) => id))
      expect(allIds).toHaveLength(62)
      expect(new Set(allIds).size).toBe(62)
      expect(topicProjector.mock.calls.slice(3).some(([context]) => context.events.some(({ id }) => paidIds.has(id)))).toBe(false)
      expect(topicProjector.mock.calls.every(([context]) => context.events.length <= 12)).toBe(true)
      const finished = (await runtime.adminSnapshot(namespace))!
      expect(finished.memoryTopicState!.bootstrap).toMatchObject({ status: 'completed', failedEvents: 0 })
      expect(finished.memoryTopicState!.topics[0]!.id).toBe(topicId)
      expect(new Set(finished.memoryTopicState!.topics.flatMap((topic) => topic.sourceEventIds)).size).toBe(62)
      await worker.runBackgroundNamespace(namespace)
      expect(topicProjector).toHaveBeenCalledTimes(7)
    } finally {
      clock.mockRestore()
      await runtime.close()
      await rm(directory, { recursive: true, force: true })
    }
  }, 15_000)

  it('keeps an incremental claim returned after a competing writer completes earlier work during a refresh race', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-topic-initialize-race-'))
    const database = join(directory, 'memory.db')
    const namespace = 'dsh:project:initialize-race'
    const topicProjector = vi.fn(async (context: TopicProjectionContext): Promise<TopicProjectionResult> => ({
      topics: [{ topicId: context.existingTopics[0]!.id, title: '部署记录', description: '查看来源核实',
        sourceEventIds: context.events.map(({ id }) => id), overview: [] }],
    }))
    const runtime = new StrataGateRuntime(makeConfig(database), {
      ...makeModels().models, isReady: () => true, topicProjector,
    } as unknown as DshModelBridge)
    const worker = manualWorker(runtime)
    await seed(database, namespace, [deploymentEvents[0]!], false)
    const originalClaim = StrataGate.prototype.claimNextTopicProjection
    let oldId: string | undefined
    const claim = vi.spyOn(StrataGate.prototype, 'claimNextTopicProjection')
      .mockImplementationOnce(async function (this: StrataGate, mode) {
        const other = await StrataGate.open({ database, namespace })
        try {
          const batch = (await originalClaim.call(other))!
          oldId = (await other.completeTopicProjection(batch.jobId, { topics: [{
            title: '部署记录', description: '查看来源核实', sourceEventIds: batch.events.map(({ id }) => id), overview: [],
          }] })).topicIds[0]
          const block = other.listBlocks()[0]!
          await other.addEvent({ id: 'incremental-race', title: '新的部署记录', summary: '新的决定',
            sourceBlockId: block.id, sourceMessageIds: [block.l5Raw[0]!.id] })
        } finally { await other.close() }
        // Real durable revision conflict: runtime must refresh and retain the
        // returned incremental job instead of dropping it after the refresh.
        return originalClaim.call(this, mode)
      })
    try {
      await worker.runBackgroundNamespace(namespace)
      expect(topicProjector).toHaveBeenCalledTimes(1)
      expect(topicProjector.mock.calls[0]![0].events.map(({ id }) => id)).toEqual(['incremental-race'])
      const state = (await runtime.adminSnapshot(namespace))!.memoryTopicState!
      expect(state.jobs.every((job) => job.status === 'completed')).toBe(true)
      expect(state.topics[0]!.id).toBe(oldId)
      expect(new Set(state.topics[0]!.sourceEventIds)).toEqual(new Set(['event-pnpm', 'incremental-race']))
    } finally {
      claim.mockRestore()
      await runtime.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('atomically reserves historical slots across connections and does not reset the budget when reopened', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-topic-reservation-'))
    const database = join(directory, 'memory.db')
    const first = new DshMetadataStore(database)
    const second = new DshMetadataStore(database)
    const now = Date.now()
    try {
      expect(first.reserveTopicBootstrapCall(now)).toBe(true)
      expect(second.reserveTopicBootstrapCall(now)).toBe(true)
      expect(first.reserveTopicBootstrapCall(now)).toBe(false)
      first.close()
      const reopened = new DshMetadataStore(database)
      try {
        expect(reopened.reserveTopicBootstrapCall(now)).toBe(false)
        expect(reopened.reserveTopicBootstrapCall(now + TOPIC_BOOTSTRAP_WINDOW_MS)).toBe(true)
      } finally { reopened.close() }
    } finally {
      // first was already closed after persisting its reservation.
      second.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('projects the first Event of a fresh namespace immediately despite an exhausted historical budget', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-topic-fresh-incremental-'))
    const database = join(directory, 'memory.db')
    const namespace = 'dsh:project:fresh-incremental'
    const topicProjector = vi.fn(async (context: TopicProjectionContext): Promise<TopicProjectionResult> => ({
      topics: [{ title: '新的部署决定', description: '查看事件核实',
        sourceEventIds: context.events.map(({ id }) => id), overview: [] }],
    }))
    const runtime = new StrataGateRuntime(makeConfig(database), {
      ...makeModels().models, isReady: () => true, topicProjector,
    } as unknown as DshModelBridge)
    const worker = manualWorker(runtime)
    try {
      const metadata = new DshMetadataStore(database)
      try {
        for (let slot = 0; slot < TOPIC_BOOTSTRAP_WINDOW_CALLS; slot += 1) expect(metadata.reserveTopicBootstrapCall()).toBe(true)
        expect(metadata.reserveTopicBootstrapCall()).toBe(false)
      } finally { metadata.close() }
      const budgetBefore = topicBudget(database)
      await seed(database, namespace, [{ id: 'fresh-first', title: '第一条部署记录', summary: '刚刚新增的决定', topic: '部署记录' }], false)
      const before = (await runtime.adminSnapshot(namespace))!.memoryTopicState!
      expect(before.bootstrap).toMatchObject({ status: 'completed', sourceVersions: {} })
      expect(before.jobs).toEqual([])
      await worker.runBackgroundNamespace(namespace)
      expect(topicProjector).toHaveBeenCalledTimes(1)
      expect(topicProjector.mock.calls[0]![0].events.map(({ id }) => id)).toEqual(['fresh-first'])
      expect(topicBudget(database)).toBe(budgetBefore)
      const after = (await runtime.adminSnapshot(namespace))!.memoryTopicState!
      expect(after.bootstrap).toEqual(before.bootstrap)
      expect(after.projectedVersions['fresh-first']).toBeDefined()
      expect(after.jobs[0]?.status).toBe('completed')
    } finally {
      await runtime.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('freezes old Events at writer open and leaves a pre-worker new Event incremental without spending history allowance', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-topic-upgrade-boundary-'))
    const database = join(directory, 'memory.db')
    const namespace = 'dsh:project:upgrade-boundary'
    const topicProjector = vi.fn(async (context: TopicProjectionContext): Promise<TopicProjectionResult> => ({
      topics: [{ title: '升级后新增决定', description: '查看来源核实',
        sourceEventIds: context.events.map(({ id }) => id), overview: [] }],
    }))
    const runtime = new StrataGateRuntime(makeConfig(database), {
      ...makeModels().models, isReady: () => true, topicProjector,
    } as unknown as DshModelBridge)
    const worker = manualWorker(runtime)
    try {
      const oldEvents = Array.from({ length: 3 }, (_, index) => ({
        id: `old-boundary-${index}`, title: '原有历史记忆', summary: '升级前已有来源', topic: '历史主题',
      }))
      await seed(database, namespace, oldEvents, false)
      removeLegacyTopicState(database, namespace)
      const upgraded = await StrataGate.open({ database, namespace })
      let frozen: ReturnType<StrataGate['getTopicBootstrapState']>
      try {
        frozen = upgraded.getTopicBootstrapState()
        expect(frozen).toMatchObject({ status: 'pending' })
        expect(Object.keys(frozen!.sourceVersions)).toEqual(oldEvents.map(({ id }) => id))
        expect(upgraded.listTopicProjectionJobs()).toEqual([]) // No claim or model call initialized it.
        const block = upgraded.listBlocks()[0]!
        await upgraded.addEvent({ id: 'post-open-new', title: '刚产生的新决定', summary: '打开写连接后才产生',
          sourceBlockId: block.id, sourceMessageIds: [block.l5Raw[0]!.id] })
        expect(upgraded.getTopicBootstrapState()).toEqual(frozen)
      } finally { await upgraded.close() }
      const metadata = new DshMetadataStore(database)
      try {
        for (let slot = 0; slot < TOPIC_BOOTSTRAP_WINDOW_CALLS; slot += 1) expect(metadata.reserveTopicBootstrapCall()).toBe(true)
      } finally { metadata.close() }
      const budgetBefore = topicBudget(database)
      await worker.runBackgroundNamespace(namespace)
      expect(topicProjector).toHaveBeenCalledTimes(1)
      expect(topicProjector.mock.calls[0]![0].events.map(({ id }) => id)).toEqual(['post-open-new'])
      expect(topicBudget(database)).toBe(budgetBefore)
      const after = (await runtime.adminSnapshot(namespace))!.memoryTopicState!
      expect(after.bootstrap!.sourceVersions).toEqual(frozen!.sourceVersions)
      expect(Object.keys(after.bootstrap!.sourceVersions)).toHaveLength(3)
      expect(after.projectedVersions['post-open-new']).toBeDefined()
      expect(after.bootstrap!.status).toBe('pending') // Historical work has not started while its allowance is paused.
      expect(oldEvents.every(({ id }) => after.projectedVersions[id] === undefined)).toBe(true)
      await worker.runBackgroundNamespace(namespace)
      expect(topicProjector).toHaveBeenCalledTimes(1)
    } finally {
      await runtime.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('charges retries to the same backfill budget and permanently settles exhausted inputs with fallback', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-topic-budget-retry-'))
    const database = join(directory, 'memory.db')
    const namespace = 'dsh:project:history-retry'
    vi.useFakeTimers({ toFake: ['Date'] })
    let now = Date.now()
    vi.setSystemTime(now)
    const topicProjector = vi.fn(async (context: TopicProjectionContext): Promise<TopicProjectionResult> => {
      if (topicProjector.mock.calls.length <= 3) throw new Error('模型暂时失败，含海棠敏感响应')
      return { topics: [{ title: '其余部署记录', description: '查看来源核实',
        sourceEventIds: context.events.map(({ id }) => id), overview: [] }] }
    })
    const runtime = new StrataGateRuntime(makeConfig(database), {
      ...makeModels().models, isReady: () => true, topicProjector,
    } as unknown as DshModelBridge)
    const worker = manualWorker(runtime)
    try {
      await seed(database, namespace, Array.from({ length: 14 }, (_, index) => ({
        id: `retry-history-${index}`, title: '部署历史', summary: '历史来源', topic: '部署历史',
      })), false)
      removeLegacyTopicState(database, namespace)
      await worker.runBackgroundNamespace(namespace)
      now += 30_000; vi.setSystemTime(now)
      await worker.runBackgroundNamespace(namespace)
      expect(topicProjector).toHaveBeenCalledTimes(2)
      now += 60_000; vi.setSystemTime(now)
      await worker.runBackgroundNamespace(namespace)
      expect(topicProjector).toHaveBeenCalledTimes(2) // Retry due, but this window is exhausted.
      now += TOPIC_BOOTSTRAP_WINDOW_MS; vi.setSystemTime(now)
      await worker.runBackgroundNamespace(namespace)
      expect(topicProjector).toHaveBeenCalledTimes(3)
      await worker.runBackgroundNamespace(namespace)
      expect(topicProjector).toHaveBeenCalledTimes(4)
      const failedIds = topicProjector.mock.calls[0]![0].events.map(({ id }) => id)
      expect(topicProjector.mock.calls[1]![0].events.map(({ id }) => id)).toEqual(failedIds)
      expect(topicProjector.mock.calls[2]![0].events.map(({ id }) => id)).toEqual(failedIds)
      const state = (await runtime.adminSnapshot(namespace))!.memoryTopicState!
      expect(state.bootstrap).toMatchObject({ status: 'completed', failedEvents: 12 })
      expect(state.jobs.find((job) => !job.superseded && job.status === 'failed'))
        .toMatchObject({ attempts: 3, nextRetryAt: null, lastError: 'worker-failed', context: null })
      expect(JSON.stringify(state)).not.toContain('海棠')
      now += TOPIC_BOOTSTRAP_WINDOW_MS; vi.setSystemTime(now)
      await worker.runBackgroundNamespace(namespace)
      expect(topicProjector).toHaveBeenCalledTimes(4)
      const reader = await StrataGate.open({ database, namespace })
      try {
        expect(reader.hasPendingTopicWork()).toBe(false)
        expect(await reader.claimNextTopicProjection()).toBeNull()
        expect(new Set(reader.listMemoryTopics().flatMap((topic) => topic.sourceEventIds)).size).toBe(14)
      } finally { await reader.close() }
    } finally {
      await runtime.close()
      vi.useRealTimers()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects an in-flight forgotten source and backs off a later model failure while Event search remains usable', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-topic-background-stale-'))
    const database = join(directory, 'memory.db')
    const session = makeSession('topic-background-stale', '普通资料')
    let ready = true
    let started!: (context: TopicProjectionContext) => void
    const entered = new Promise<TopicProjectionContext>((resolve) => { started = resolve })
    let settle!: (result: TopicProjectionResult) => void
    const output = new Promise<TopicProjectionResult>((resolve) => { settle = resolve })
    const topicProjector = vi.fn(async (context: TopicProjectionContext) => {
      if (topicProjector.mock.calls.length > 1) throw new Error('模拟主题模型暂时不可用')
      started(context)
      return output
    })
    const errors: unknown[] = []
    const runtime = new StrataGateRuntime(makeConfig(database), {
      ...makeModels().models, isReady: () => ready, topicProjector,
    } as unknown as DshModelBridge, (error) => errors.push(error))
    const worker = manualWorker(runtime)
    let running: Promise<void> | undefined
    try {
      const namespace = runtime.namespaceFor(session)
      await seed(database, namespace, [
        { id: 'secret', title: '海棠私密原文', summary: '海棠私密内容。', topic: '海棠主题' },
        { id: 'public', title: '普通资料', summary: '普通资料可继续检索。', topic: '普通主题' },
      ], false)
      running = worker.runBackgroundNamespace(namespace)
      const context = await entered
      const other = await StrataGate.open({ database, namespace })
      try { await other.forgetEvent('secret') } finally { await other.close() }
      settle({ topics: [{
        title: '海棠旧结果', description: '海棠来源被忘记后不能继续展示。',
        sourceEventIds: context.events.map(({ id }) => id),
        overview: [{ kind: 'history', text: '海棠旧内容。', sourceEventIds: context.events.map(({ id }) => id) }],
      }] })
      await running
      ready = false
      const invalidated = (await runtime.adminSnapshot(namespace))!
      expect(invalidated.memoryTopicState!.topics).toHaveLength(0)
      expect(await runtime.buildMemoryDirectory(session)).not.toContain('海棠')
      expect(JSON.stringify(await runtime.listTopics(session))).not.toContain('海棠')
      const before = adoption(await runtime.adminSnapshot(namespace))
      const batch = await runtime.searchEvents(session, '普通资料') as EventBatch
      expect(batch.results.map(({ id }) => id)).toEqual(['public'])
      expect(adoption(await runtime.adminSnapshot(namespace))).toEqual(before)
      ready = true
      await worker.runBackgroundNamespace(namespace)
      expect(topicProjector).toHaveBeenCalledTimes(2)
      const failed = (await runtime.adminSnapshot(namespace))!.memoryTopicState!.jobs
        .find((job) => job.lastError === 'worker-failed')!
      expect(failed).toMatchObject({ status: 'failed', attempts: 1, lastError: 'worker-failed' })
      expect(Date.parse(failed.nextRetryAt!)).toBeGreaterThan(Date.now())
      await worker.runBackgroundNamespace(namespace)
      expect(topicProjector).toHaveBeenCalledTimes(2)
      expect(errors.length).toBeGreaterThanOrEqual(1)
      ready = false
      expect((await runtime.searchEvents(session, '普通资料') as EventBatch).results.map(({ id }) => id)).toEqual(['public'])
    } finally {
      settle({ topics: [] })
      await running?.catch(() => {})
      await runtime.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
