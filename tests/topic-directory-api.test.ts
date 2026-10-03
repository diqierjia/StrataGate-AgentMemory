import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  MemoryTopicDirectory, MEMORY_TOPIC_PROJECTOR_VERSION, memoryTopicEventFingerprint, StrataGate,
  type EventCard, type MemoryTopicState, type StoredMemoryTopic, type StrataGateSnapshot,
  type TopicProjectionJob,
} from '@diqier/stratagate'
import { describe, expect, it, vi } from 'vitest'
import type { ResolvedConfig } from '../src/config.js'
import type { DshModelBridge } from '../src/llm.js'
import { StrataGateRuntime } from '../src/runtime.js'
import { handleAdminRequest, type WebResponse } from '../src/web.js'

const namespace = 'dsh:project:topic-directory'
const now = '2026-10-03T00:00:00.000Z'

function event(id: string): EventCard {
  return {
    id, title: `标题 ${id}`, summary: `内容 ${id}`, tags: [], quotes: [], sourceMessageIds: [],
    sourceBlockId: 'block-source', temporal: {}, scope: 'project', criticality: 'routine', status: 'active',
    supersededBy: null,
    weight: { mentionCount: 1, lastAdoptedTurn: 0, lastRetrievedAt: null, pinned: false, floorWeight: 0, forcedCap: null },
    createdAt: now, updatedAt: now,
  }
}

function emptySnapshot(): StrataGateSnapshot {
  const snapshot = StrataGate.inMemory().exportSnapshot()
  delete snapshot.memoryTopicState
  return snapshot
}

function freeze(events: EventCard[]): MemoryTopicState {
  const directory = new MemoryTopicDirectory()
  directory.initializeBootstrap(events, now)
  return directory.snapshot()
}

function versions(events: EventCard[]): Record<string, string> {
  return Object.fromEntries(events.map((source) => [source.id, memoryTopicEventFingerprint(source)]))
}

function topic(id: string, sources: EventCard[], dependencies = sources): StoredMemoryTopic {
  return {
    id, title: `正式主题 ${id}`, description: `主题说明 ${id}`,
    sourceEventIds: sources.map(({ id }) => id),
    overview: [{ kind: 'history', text: `总览 ${id}`, sourceEventIds: sources.map(({ id }) => id) }],
    createdAt: now, updatedAt: now, sourceVersions: versions(sources), dependencyVersions: versions(dependencies),
    projectorVersion: MEMORY_TOPIC_PROJECTOR_VERSION, invalidated: false,
  }
}

function failedJob(id: string, sources: EventCard[], overrides: Partial<TopicProjectionJob> = {}): TopicProjectionJob {
  return {
    id, sourceEventIds: sources.map(({ id }) => id), sourceVersions: versions(sources),
    dependencyVersions: versions(sources), candidateVersions: {}, context: null,
    projectorVersion: MEMORY_TOPIC_PROJECTOR_VERSION, status: 'failed', attempts: 3,
    topicIds: [], lastError: 'worker-failed', nextRetryAt: null, createdAt: now, updatedAt: now,
    ...overrides,
  }
}

function fakeRuntime(snapshot: StrataGateSnapshot, weight: () => number = () => 1): StrataGateRuntime {
  return {
    adminSnapshot: async (key: string) => key === namespace ? snapshot : null,
    adminNamespaces: async () => [namespace],
    adminSnapshotEntries: async () => [{ namespace, revision: 5, snapshot }],
    adminAgentMemoryRetrievalWeight: weight,
    adminWorkspaceName: () => '测试工作区',
    adminDataDirectory: () => 'C:\\memory',
  } as unknown as StrataGateRuntime
}

async function request(runtime: StrataGateRuntime, path = 'topics', method = 'GET', headers?: Record<string, string>) {
  const [route, ...parameters] = path.split('&')
  let text = ''
  const outputHeaders: Record<string, string> = {}
  const response: WebResponse = {
    statusCode: 0,
    setHeader: (name, value) => { outputHeaders[name] = value },
    end: (body) => { text = body },
  }
  await handleAdminRequest(runtime, {
    method, url: `/api/stratagate/${route}?namespace=${encodeURIComponent(namespace)}${parameters.map((value) => `&${value}`).join('')}`,
    ...(headers ? { headers } : {}),
  }, response)
  return { status: response.statusCode, body: text ? JSON.parse(text) : null, headers: outputHeaders }
}

describe('read-only Topic Directory admin data', () => {
  it('exposes every chapter, section and referenced Event beyond the dashboard Event page', async () => {
    const snapshot = emptySnapshot()
    snapshot.events = Array.from({ length: 60 }, (_, index) => event(`event-${String(index).padStart(3, '0')}`))
    const state = freeze(snapshot.events)
    state.topics = [topic('topic-b', snapshot.events.slice(30, 50)), topic('topic-a', snapshot.events.slice(0, 30))]
    state.projectedVersions = versions(snapshot.events.slice(0, 50))
    snapshot.memoryTopicState = state
    const before = JSON.stringify(snapshot)
    const result = await request(fakeRuntime(snapshot), 'dashboard')
    expect(result.status).toBe(200)
    expect(result.body.data.events).toHaveLength(40)
    const directory = result.body.data.topicDirectory
    expect(directory.navigationOnly).toBe(true)
    expect(directory.topics.filter((item: { isFallback?: boolean }) => !item.isFallback)
      .map((item: { id: string }) => item.id)).toEqual(['topic-a', 'topic-b'])
    expect(directory.topics).toHaveLength(12)
    expect(directory.topics.find((item: { id: string }) => item.id === 'topic-b').overview[0].sourceEventIds).toHaveLength(20)
    expect(directory.events).toHaveLength(60)
    expect(directory.events.find((item: { id: string }) => item.id === 'event-059')).toMatchObject({ title: '标题 event-059' })
    expect(directory.context).toContain('StrataGate 记忆目录')
    expect(directory).not.toHaveProperty('batchId')
    expect(directory).not.toHaveProperty('evidenceRefs')
    expect(JSON.stringify(snapshot)).toBe(before)
    const separate = await request(fakeRuntime(snapshot))
    expect(separate.body).toEqual({ namespace, ...directory })
  })

  it('removes all cached language when a cited or uncited dependency changes', async () => {
    const snapshot = emptySnapshot()
    const cited = event('visible-source')
    const background = event('uncited-source')
    snapshot.events = [cited, background]
    snapshot.memoryTopicState = freeze(snapshot.events)
    snapshot.memoryTopicState.topics = [topic('topic-sensitive', [cited], snapshot.events)]
    snapshot.memoryTopicState.projectedVersions = versions(snapshot.events)
    background.summary = '更新后的来源内容'
    const before = JSON.stringify(snapshot)
    const result = await request(fakeRuntime(snapshot))
    const serialized = JSON.stringify(result.body)
    expect(serialized).not.toContain('正式主题 topic-sensitive')
    expect(serialized).not.toContain('总览 topic-sensitive')
    expect(result.body.topics.find((item: { id: string }) => item.id === 'topic-sensitive'))
      .toMatchObject({ isFallback: true, overview: [], sourceEventIds: ['visible-source'] })
    expect(JSON.stringify(snapshot)).toBe(before)
  })

  it('hides forgotten/archived sources and preserves safe fallback entries', async () => {
    const snapshot = emptySnapshot()
    snapshot.events = [event('kept'), { ...event('forgotten'), status: 'forgotten' }, { ...event('archived'), status: 'archived' }]
    const result = await request(fakeRuntime(snapshot))
    expect(result.body.topics).toEqual([expect.objectContaining({ id: 'fallback:kept', isFallback: true })])
    expect(result.body.events).toEqual([expect.objectContaining({ id: 'kept' })])
    expect(result.body.bootstrap).toBeNull()
  })

  it('applies the agent lane control to mixed dependencies, fallback, detail and dashboard caching', async () => {
    const snapshot = emptySnapshot()
    const conversation = event('conversation')
    const agent = event('agent-only')
    snapshot.events = [conversation]
    snapshot.agentEvents = [agent]
    snapshot.memoryTopicState = freeze([conversation, agent])
    snapshot.memoryTopicState.topics = [topic('mixed', [conversation], [conversation, agent])]
    snapshot.memoryTopicState.projectedVersions = versions([conversation, agent])
    let weight = 1
    const runtime = fakeRuntime(snapshot, () => weight)
    const first = await request(runtime, 'dashboard')
    const detail = await request(runtime, 'sources&eventId=agent-only')
    expect(detail.status).toBe(200)
    weight = 0
    const second = await request(runtime, 'dashboard', 'GET', { 'if-none-match': first.headers.ETag! })
    expect(second.status).toBe(200)
    expect(second.headers.ETag).not.toBe(first.headers.ETag)
    const directory = second.body.data.topicDirectory
    expect(directory.topics).toEqual([expect.objectContaining({ id: 'fallback:conversation', isFallback: true })])
    expect(directory.events.map((item: { id: string }) => item.id)).toEqual(['conversation'])
    expect(JSON.stringify(directory)).not.toContain('agent-only')
    expect(JSON.stringify(directory)).not.toContain('正式主题 mixed')
    expect((await request(runtime, 'sources&eventId=agent-only')).status).toBe(404)
    weight = 1
    agent.status = 'forgotten'
    expect((await request(runtime, 'sources&eventId=agent-only')).status).toBe(404)
  })

  it.each(['pending', 'running'] as const)('shows %s Bootstrap progress with only successful completions', async (status) => {
    const snapshot = emptySnapshot()
    snapshot.events = [event('complete'), event('pending')]
    snapshot.memoryTopicState = freeze(snapshot.events)
    snapshot.memoryTopicState.bootstrap!.status = status
    snapshot.memoryTopicState.projectedVersions = versions([snapshot.events[0]!])
    const result = await request(fakeRuntime(snapshot), 'dashboard')
    expect(result.body.processing).toBe(true)
    expect(result.body.data.topicDirectory.bootstrap).toMatchObject({ status, total: 2, completed: 1, failedEvents: 0, failures: [] })
  })

  it('keeps terminal failures visible without exposing model inputs or raw error text', async () => {
    const snapshot = emptySnapshot()
    snapshot.events = [event('complete'), event('failed')]
    snapshot.memoryTopicState = freeze(snapshot.events)
    snapshot.memoryTopicState.projectedVersions = versions([snapshot.events[0]!])
    snapshot.memoryTopicState.jobs = [failedJob('failed-job', [snapshot.events[1]!], {
      lastError: 'RAW SECRET MODEL RESPONSE',
      context: { jobId: 'failed-job', events: snapshot.events, existingTopics: [] },
    })]
    const result = await request(fakeRuntime(snapshot))
    expect(result.body.bootstrap).toMatchObject({
      status: 'completed', total: 2, completed: 1, failedEvents: 1,
      failures: [{ jobId: 'failed-job', eventIds: ['failed'], attempts: 3, lastError: 'worker-failed' }],
    })
    expect(JSON.stringify(result.body)).not.toContain('RAW SECRET MODEL RESPONSE')
    expect(result.body.bootstrap.failures[0]).not.toHaveProperty('context')
  })

  it('does not count changed, forgotten, superseded or retryable inputs as historical failures', async () => {
    const snapshot = emptySnapshot()
    snapshot.events = [event('complete'), event('changed'), event('forgotten'), event('retrying')]
    snapshot.memoryTopicState = freeze(snapshot.events)
    snapshot.memoryTopicState.projectedVersions = versions([snapshot.events[0]!])
    snapshot.memoryTopicState.jobs = [
      failedJob('changed-job', [snapshot.events[1]!]),
      failedJob('forgotten-job', [snapshot.events[2]!]),
      failedJob('retrying-job', [snapshot.events[3]!], { attempts: 1, nextRetryAt: '2026-10-04T00:00:00.000Z' }),
      failedJob('superseded-job', [snapshot.events[3]!], { superseded: true }),
    ]
    snapshot.events[1]!.summary = '来源已更新'
    snapshot.events[2]!.status = 'forgotten'
    const result = await request(fakeRuntime(snapshot))
    expect(result.body.bootstrap).toMatchObject({ status: 'pending', total: 2, completed: 1, failedEvents: 0, failures: [] })
  })

  it('returns a completed empty Bootstrap without an active-processing signal', async () => {
    const snapshot = emptySnapshot()
    snapshot.memoryTopicState = freeze([])
    const result = await request(fakeRuntime(snapshot), 'dashboard')
    expect(result.body.processing).toBe(false)
    expect(result.body.data.topicDirectory).toMatchObject({
      context: '', topics: [], events: [], bootstrap: { status: 'completed', total: 0, completed: 0, failedEvents: 0 },
    })
  })

  it('requires a namespace and rejects writes to the new navigation endpoint', async () => {
    const runtime = fakeRuntime(emptySnapshot())
    expect((await request(runtime, 'topics', 'POST')).status).toBe(405)
    let result = ''
    const response: WebResponse = { statusCode: 0, setHeader: () => {}, end: (body) => { result = body } }
    await handleAdminRequest(runtime, { method: 'GET', url: '/api/stratagate/topics' }, response)
    expect(response.statusCode).toBe(400)
    expect(JSON.parse(result).error).toBe('namespace is required')
  })

  it('browses a legacy database without creating Topic state, writing receipts or calling a model', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-directory-readonly-'))
    const database = join(directory, 'memory.db')
    const memory = await StrataGate.open({ database, namespace, blockTurnSize: 1 })
    await memory.appendTurn({ user: '可追溯的原始消息', assistant: '已保存' }, { deferDerivation: true })
    const block = memory.listBlocks()[0]!
    await memory.addEvent({ id: 'legacy-event', title: '旧记忆', summary: '仍可正常查看', sourceBlockId: block.id, sourceMessageIds: [block.l5Raw[0]!.id] })
    await memory.close()
    const legacy = new DatabaseSync(database)
    legacy.exec('DROP TABLE memory_topic_state')
    legacy.close()
    const beforeBytes = await readFile(database)
    const modelCall = vi.fn(() => { throw new Error('Browsing must not call a model') })
    const runtime = new StrataGateRuntime({
      database, namespaceMode: 'project', namespacePrefix: 'dsh', globalNamespace: 'global',
      blockTurnSize: 1, blockDecayLambda: 0.3, ingestSubagents: false, maxOutputTokens: 2048,
    } satisfies ResolvedConfig, {
      onAdaptersUpdated: () => () => {}, isReady: () => false, topicProjector: modelCall,
    } as unknown as DshModelBridge)
    try {
      const before = await runtime.adminSnapshot(namespace)
      for (const path of ['topics', 'dashboard', 'sources&eventId=legacy-event']) {
        const result = await request(runtime, path)
        expect(result.status).toBe(200)
        if (path === 'topics') expect(result.body).toMatchObject({
          topics: [{ id: 'fallback:legacy-event', isFallback: true }], bootstrap: null,
        })
      }
      expect(await runtime.adminSnapshot(namespace)).toEqual(before)
      expect(modelCall).not.toHaveBeenCalled()
      const internals = runtime as unknown as { spaces: Map<string, unknown>; batches: Map<string, unknown>; latestBatchIds: Map<string, unknown> }
      expect(internals.spaces.size).toBe(0)
      expect(internals.batches.size).toBe(0)
      expect(internals.latestBatchIds.size).toBe(0)
      expect((await readFile(database)).equals(beforeBytes)).toBe(true)
      const reader = new DatabaseSync(database, { readOnly: true })
      try {
        expect(reader.prepare("SELECT name FROM sqlite_master WHERE name IN ('memory_topic_state', 'stratagate_dsh_workspaces', 'stratagate_dsh_settings', 'stratagate_dsh_feedback_drafts')").all()).toEqual([])
      }
      finally { reader.close() }
    } finally {
      await runtime.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
