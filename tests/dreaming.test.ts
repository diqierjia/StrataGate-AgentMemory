import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StrataGate, estimateTokens, dreamingEventContent, dreamingEventContentVersion, memoryTopicEventFingerprint, DREAMING_BATCH_WRITE_LIMIT, type DreamingRun } from '@diqier/stratagate'
import { memoryTopicSectionNavigation } from '../src/topics.js'
import { StrataGateRuntime } from '../src/runtime.js'
import { dreamingPayload, dreamingTool } from '../src/dreaming.js'
import type { DshModelBridge } from '../src/llm.js'
import { handleAdminRequest } from '../src/web.js'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { DshDreamingSessions } from '../src/dreaming-session.js'
import * as JsonlPersistenceModule from '@deepseek-ai/dsh-session-persistence-jsonl'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionQuery from '@deepseek-ai/dsh-session-query-sqlite'
import AgentDefaultModelConfig from '@deepseek-ai/dsh-agent-default-model'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import BasicCompaction from '@deepseek-ai/dsh-compaction-basic'
import * as StrataGatePlugin from '../src/index.js'

const cleanups: Array<() => Promise<void>> = []
// DSH 0.2.1 exposes the plugin as named exports; earlier hosts use a default class.
const JsonlPersistence = (JsonlPersistenceModule as any).default ?? JsonlPersistenceModule
afterEach(async () => { while (cleanups.length) await cleanups.pop()!() })
async function fixture(count = 2, userMessage = '用户明确要求保留来源，优化目录。', namespace = 'dreaming-test', now?: () => Date) {
  const directory = await mkdtemp(join(tmpdir(), 'stratagate-dreaming-'))
  const database = join(directory, 'memory.sqlite')
  const options = { database, namespace, blockTurnSize: 1, disableElementProjection: true, ...(now ? { now } : {}),
    summarizer: async () => ({ l0Title: '项目', l0Tags: [], l1Summary: '项目资料', l2Keypoints: [], shouldExtract: false }) }
  const memory = await StrataGate.open(options)
  const opened = [memory]
  cleanups.push(async () => {
    await Promise.all(opened.map(item => item.close()))
    if (!resolve(directory).startsWith(resolve(tmpdir()) + '\\') && !resolve(directory).startsWith(resolve(tmpdir()) + '/')) throw new Error('Unsafe fixture cleanup')
    await rm(directory, { recursive: true, force: true })
  })
  await memory.appendTurn({ user: userMessage, assistant: '记录。' })
  const block = memory.listBlocks()[0]!
  const events = []
  for (let i = 0; i < count; i++) events.push(await memory.addEvent({ title: `项目事件 ${i}`, summary: `用户第 ${i} 次明确要求目录保留来源。`,
    sourceBlockId: block.id, sourceMessageIds: [block.l5Raw[0]!.id] }))
  let topicId = ''
  for (;;) {
    const job = await memory.claimNextTopicProjection()
    if (!job) break
    const ids = job.events.map(event => event.id)
    const result = await memory.completeTopicProjection(job.jobId, { topics: [{ ...(topicId ? { topicId } : {}), title: '项目', description: '项目资料',
      sourceEventIds: ids, sections: [{ title: '开发', sourceEventIds: ids }], overview: [] }] })
    topicId = result.topicIds[0]!
  }
  return { memory, database, directory, namespace: options.namespace, block, events, topicId,
    reopen: async () => { const next = await StrataGate.open(options); opened.push(next); return next } }
}
const claim = (run: DreamingRun) => ({ id: run.id, owner: run.owner, epoch: run.epoch })

describe('Dreaming trace regressions: completion and overview maintenance', () => {
  it('lets a final native summary finish after heartbeat ticks without renewing the completed claim', async () => {
    const f = await fixture(1)
    const runtime = runtimeFor(f.database, async () => { throw new Error('No live model calls') })
    let requests = 0, finalStarted = false, cancelled = false, release!: () => void
    const ctx = await nativeHost(runtime, f.directory, async function* (options) {
      if (++requests === 1) { yield* nativeCall('dreaming_finish', {}); return }
      yield { type: 'text-delta', index: 0, text: '开始总结。' }
      await new Promise<void>(resolve => {
        release = resolve; finalStarted = true
        options.signal.addEventListener('abort', () => { cancelled = true; resolve() }, { once: true })
      })
      yield { type: 'text-delta', index: 0, text: '总结完整结束。' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      await runtime.adminDreamingControl(f.namespace, 'start')
      await vi.waitFor(() => expect(finalStarted).toBe(true))
      const status = (await runtime.adminDreamingStatus(f.namespace) as any).run
      expect(status).toMatchObject({ status: 'completed', completed: 1 })
      const finished = (await f.reopen()).exportSnapshot().memoryTopicState!.dreaming!
      await vi.advanceTimersByTimeAsync(60_000)
      expect(cancelled).toBe(false)
      expect((await f.reopen()).exportSnapshot().memoryTopicState!.dreaming).toEqual(finished)
      release()
      const agent = ctx.agents.get(status.sessionId)!
      await agent.whenIdle()
      const events = agent.session.snapshotEvents()
      expect(JSON.stringify(agent.session.deriveMessages())).toContain('总结完整结束。')
      expect(JSON.stringify(events.find(event => event.type === 'turn/end'))).not.toContain('aborted')
      expect(events.some(event => event.type === 'turn/end')).toBe(true)
      expect(requests).toBe(2)
    } finally { release?.(); vi.useRealTimers() }
  })

  it('accepts only the same completed heartbeat, leaving timestamps and lease untouched', async () => {
    const f = await fixture(1)
    let run = await f.memory.dreaming({ kind: 'start', owner: 'owner' })
    run = await f.memory.dreaming({ kind: 'prepare', ...claim(run) })
    run = await f.memory.dreaming({ kind: 'finish-unit', ...claim(run) })
    expect(await f.memory.dreaming({ kind: 'heartbeat', ...claim(run) })).toEqual(run)
    expect(run.leaseUntil).toBeNull()
    await expect(f.memory.dreaming({ kind: 'heartbeat', ...claim(run), owner: 'foreign' })).rejects.toThrow('claim changed')
    await expect(f.memory.dreaming({ kind: 'heartbeat', ...claim(run), epoch: run.epoch + 1 })).rejects.toThrow('claim changed')
    await expect(f.memory.dreaming({ kind: 'apply', ...claim(run), operations: [{ kind: 'rename-chapter', title: '迟到写入' }] })).rejects.toThrow('claim changed')
    await f.memory.dreaming({ kind: 'start', owner: 'new-owner' })
    await expect(f.memory.dreaming({ kind: 'heartbeat', ...claim(run) })).rejects.toThrow('Unknown Dreaming run')
  })

  it('relocates overview prose with Event membership atomically without duplicates or cross-index workarounds', async () => {
    const f = await fixture(3)
    let run = await f.memory.dreaming({ kind: 'start', owner: 'a' })
    run = await f.memory.dreaming({ kind: 'prepare', ...claim(run) })
    const facts = f.events.map((event, index) => ({ kind: 'history' as const, text: `独有事实 ${index}`, sourceEventIds: [event.id] }))
    run = await f.memory.dreaming({ kind: 'apply', ...claim(run), operations: [
      { kind: 'move-events', eventIds: [f.events[2]!.id], title: '无关小节' },
      { kind: 'set-overview', title: '开发', entries: facts.slice(0, 2) },
      { kind: 'set-overview', title: '无关小节', entries: [facts[2]!] },
    ] })
    const untouched = structuredClone(f.memory.getMemoryTopic(f.topicId)!.overview.find(part => part.title === '无关小节'))
    const beforeEvents = structuredClone(f.memory.listAllEvents())
    run = await f.memory.dreaming({ kind: 'apply', ...claim(run), operations: [
      { kind: 'move-events', eventIds: [f.events[1]!.id], title: '新分类' },
      { kind: 'rewrite-overview', titles: ['开发', '新分类'], entries: [
        { ...facts[0]!, title: '开发' }, { ...facts[1]!, title: '新分类' },
      ] },
    ] })
    const reopened = await f.reopen()
    expect(reopened.getMemoryTopic(f.topicId)!.overview).toHaveLength(3)
    expect(reopened.getMemoryTopic(f.topicId)!.overview).toEqual(expect.arrayContaining([
      untouched, { ...facts[0]!, title: '开发' }, { ...facts[1]!, title: '新分类' },
    ]))
    expect(reopened.getMemoryTopic(f.topicId)!.sections!.find(section => section.title === '新分类')!.sourceEventIds).toEqual([f.events[1]!.id])
    expect(reopened.listAllEvents()).toEqual(beforeEvents)
    expect(run.changedBatches).toBe(2)
  })

  it('merges into an existing destination while preserving its content and leaving no source duplicate', async () => {
    const f = await fixture(2)
    let run = await f.memory.dreaming({ kind: 'start', owner: 'a' })
    run = await f.memory.dreaming({ kind: 'prepare', ...claim(run) })
    run = await f.memory.dreaming({ kind: 'apply', ...claim(run), operations: [
      { kind: 'move-events', eventIds: [f.events[1]!.id], title: '目标' },
      { kind: 'set-overview', title: '开发', entries: [{ kind: 'history', text: '来源事实', sourceEventIds: [f.events[0]!.id] }] },
      { kind: 'set-overview', title: '目标', entries: [{ kind: 'history', text: '目标原有事实', sourceEventIds: [f.events[1]!.id] }] },
    ] })
    await f.memory.dreaming({ kind: 'apply', ...claim(run), operations: [{ kind: 'rewrite-overview', titles: ['开发', '目标'], entries: [
      { kind: 'history', title: '目标', text: '来源事实；目标原有事实。', sourceEventIds: f.events.map(event => event.id) },
    ] }] })
    const topic = (await f.reopen()).getMemoryTopic(f.topicId)!
    expect(topic.overview).toEqual([{ kind: 'history', title: '目标', text: '来源事实；目标原有事实。', sourceEventIds: f.events.map(event => event.id) }])
    // Overview routing and Event membership are deliberately independent.
    expect(topic.sections!.find(section => section.title === '开发')!.sourceEventIds).toEqual([f.events[0]!.id])
  })

  it('leaves unselected legacy overview entries byte-for-byte intact', async () => {
    const f = await fixture(2)
    const { SqliteStorage } = await import('@diqier/stratagate/sqlite')
    const snapshot = f.memory.exportSnapshot()
    const topic = snapshot.memoryTopicState!.topics.find(item => item.id === f.topicId)!
    topic.sections = [{ title: '开发', sourceEventIds: [f.events[0]!.id] }, { title: '旧资料', sourceEventIds: [f.events[1]!.id] }]
    const legacy = { kind: 'history' as const, title: '旧资料', text: '与本次整理无关的遗留段落', sourceEventIds: [f.events[1]!.id] }
    topic.overview = [legacy, structuredClone(legacy)]
    const storage = new SqliteStorage({ filename: f.database })
    try { await storage.save(f.namespace, snapshot, f.memory.storageRevision) } finally { storage.close() }
    await f.memory.reloadFromStorage()
    const before = JSON.stringify(f.memory.getMemoryTopic(f.topicId)!.overview)
    let run = await f.memory.dreaming({ kind: 'start', owner: 'a' })
    run = await f.memory.dreaming({ kind: 'prepare', ...claim(run) })
    await f.memory.dreaming({ kind: 'apply', ...claim(run), operations: [{ kind: 'rewrite-overview', titles: ['开发'], entries: [
      { kind: 'history', title: '开发', text: '本次有证据的新概要', sourceEventIds: [f.events[0]!.id] },
    ] }] })
    const unrelated = (await f.reopen()).getMemoryTopic(f.topicId)!.overview.filter(part => part.title === '旧资料')
    expect(JSON.stringify(unrelated)).toBe(before)
    expect(unrelated).toHaveLength(2)
  })

  it('rejects duplicate appends without reordering interleaved overview entries into fake progress', async () => {
    const f = await fixture(2)
    const { SqliteStorage } = await import('@diqier/stratagate/sqlite')
    const snapshot = f.memory.exportSnapshot()
    const topic = snapshot.memoryTopicState!.topics.find(item => item.id === f.topicId)!
    topic.sections = [{ title: '开发', sourceEventIds: [f.events[0]!.id] }, { title: '其他', sourceEventIds: [f.events[1]!.id] }]
    const entry = { kind: 'history' as const, title: '开发', text: '开发事实一', sourceEventIds: [f.events[0]!.id] }
    topic.overview = [entry, { kind: 'history', title: '其他', text: '其他事实', sourceEventIds: [f.events[1]!.id] }, { ...entry, text: '开发事实二' }]
    const storage = new SqliteStorage({ filename: f.database })
    try { await storage.save(f.namespace, snapshot, f.memory.storageRevision) } finally { storage.close() }
    await f.memory.reloadFromStorage()
    const before = structuredClone(f.memory.getMemoryTopic(f.topicId))
    let run = await f.memory.dreaming({ kind: 'start', owner: 'a' })
    run = await f.memory.dreaming({ kind: 'prepare', ...claim(run) })
    await expect(f.memory.dreaming({ kind: 'apply', ...claim(run), operations: [{ kind: 'append-overview', title: '开发', entries: [entry] }] })).rejects.toThrow('unchanged or previous state')
    expect((await f.reopen()).getMemoryTopic(f.topicId)).toEqual(before)
  })

  it('consolidates obsolete prose and repeated corrections into one sourced entry through native tools', async () => {
    const f = await fixture(3)
    let run = await f.memory.dreaming({ kind: 'start', owner: 'old' })
    run = await f.memory.dreaming({ kind: 'prepare', ...claim(run) })
    run = await f.memory.dreaming({ kind: 'apply', ...claim(run), operations: [{ kind: 'set-overview', title: '开发', entries: [
      { kind: 'open-question', text: '当前状态待确认。', sourceEventIds: [f.events[0]!.id] },
      { kind: 'change', text: '补充：后续已确认。', sourceEventIds: [f.events[1]!.id] },
    ] }] })
    await f.memory.dreaming({ kind: 'suspend', ...claim(run), reason: 'fixture' })
    const runtime = runtimeFor(f.database, async () => { throw new Error('No legacy model') })
    let requests = 0
    const ctx = await nativeHost(runtime, f.directory, async function* (options) {
      if (++requests === 1) {
        expect(JSON.stringify(options.tools)).toContain('rewrite-overview')
        expect(JSON.stringify(options.messages)).toContain('do not keep an obsolete claim as a current fact')
        yield* nativeCall('dreaming_directory', { operations: [{ kind: 'rewrite-overview', titles: ['开发'], entries: [
          { kind: 'change', title: '开发', text: '早期未确认，后续已明确；原先的待确认说法已过时。', sourceEventIds: f.events.map(event => event.id) },
        ] }] })
      } else if (requests === 2) yield* nativeCall('dreaming_finish', {})
      else { yield { type: 'text-delta', index: 0, text: '已合并更正。' }; yield { type: 'finish', reason: { kind: 'stop' } } }
    })
    await runtime.adminDreamingControl(f.namespace, 'resume', run.id)
    await vi.waitFor(async () => expect(await runtime.adminDreamingStatus(f.namespace)).toMatchObject({ run: { status: 'completed', changedBatches: 2 } }))
    const status = (await runtime.adminDreamingStatus(f.namespace) as any).run
    await ctx.agents.get(status.sessionId)!.whenIdle()
    const overview = (await f.reopen()).getMemoryTopic(f.topicId)!.overview
    expect(overview).toHaveLength(1)
    expect(overview[0]).toMatchObject({ text: '早期未确认，后续已明确；原先的待确认说法已过时。', sourceEventIds: f.events.map(event => event.id) })
  })

  it.each(['source', 'destination'] as const)('rejects losing %s citations and rolls back every operation', async missing => {
    const f = await fixture(2)
    let run = await f.memory.dreaming({ kind: 'start', owner: 'a' })
    run = await f.memory.dreaming({ kind: 'prepare', ...claim(run) })
    run = await f.memory.dreaming({ kind: 'apply', ...claim(run), operations: [
      { kind: 'move-events', eventIds: [f.events[1]!.id], title: '目标' },
      { kind: 'set-overview', title: '开发', entries: [{ kind: 'history', text: '来源内容', sourceEventIds: [f.events[0]!.id] }] },
      { kind: 'set-overview', title: '目标', entries: [{ kind: 'history', text: '目标原有内容', sourceEventIds: [f.events[1]!.id] }] },
    ] })
    const before = structuredClone(f.memory.getMemoryTopic(f.topicId))
    const missingId = f.events[missing === 'source' ? 0 : 1]!.id
    await expect(f.memory.dreaming({ kind: 'apply', ...claim(run), operations: [
      { kind: 'rename-chapter', title: '不应保存' },
      { kind: 'rewrite-overview', titles: ['开发', '目标'], entries: [
        { kind: 'history', title: '目标', text: '不完整替换', sourceEventIds: f.events.filter(event => event.id !== missingId).map(event => event.id) },
      ] },
    ] })).rejects.toThrow(`overview-source-reference-missing: preserve existing overview evidence for Event ${JSON.stringify(missingId)}`)
    expect(f.memory.getMemoryTopic(f.topicId)).toEqual(before)
    expect((await f.reopen()).getMemoryTopic(f.topicId)).toEqual(before)
  })

  it('identifies unread, foreign and unavailable sources precisely; retrieval repairs only unread citations', async () => {
    const f = await fixture(25)
    const foreign = await f.memory.addEvent({ title: '别章事实', summary: '不属于当前章节', sourceBlockId: f.block.id, sourceMessageIds: [f.block.l5Raw[0]!.id] })
    const job = (await f.memory.claimNextTopicProjection())!
    await f.memory.completeTopicProjection(job.jobId, { topics: [{ title: '另一个章节', description: '其他主题', sourceEventIds: [foreign.id], sections: [{ title: '其他', sourceEventIds: [foreign.id] }], overview: [] }] })
    let run = await f.memory.dreaming({ kind: 'start', owner: 'a' })
    run = await f.memory.dreaming({ kind: 'prepare', ...claim(run) })
    const unread = f.events.find(event => !run.units[0]!.eventIds.includes(event.id))!
    const write = (ids: string[]) => f.memory.dreaming({ kind: 'apply', ...claim(run), operations: [{ kind: 'set-overview', title: '开发', entries: [{ kind: 'history', text: '有来源事实', sourceEventIds: ids }] }] })
    await expect(write([unread.id])).rejects.toThrow(`overview-source-not-retrieved: Event ${JSON.stringify(unread.id)}`)
    await expect(write([unread.id, foreign.id])).rejects.toThrow(`overview-source-not-in-chapter: Event ${JSON.stringify(foreign.id)}`)
    await expect(write(['fabricated'])).rejects.toThrow('overview-source-unavailable: Event "fabricated"')
    for (const event of [unread, foreign]) {
      const action = { tool: 'dreaming_read', args: { kind: 'event', id: event.id } }
      const read = await dreamingTool(f.memory, run, action)
      run = await f.memory.dreaming({ kind: 'checkpoint', ...claim(run), trace: { ...action, result: read.result }, evidenceIds: read.evidenceIds, estimatedTokens: 0 })
    }
    await expect(write([foreign.id])).rejects.toThrow('overview-source-not-in-chapter')
    await write([unread.id])
    expect((await f.reopen()).getMemoryTopic(f.topicId)!.overview[0]!.sourceEventIds).toEqual([unread.id])
  })

  it.each(['unknown-section', 'duplicate-section', 'missing-title', 'outside-title', 'blank-text', 'empty-citations', 'null-entry'] as const)('rejects malformed overview rewrites atomically: %s', async mode => {
    const f = await fixture(1)
    let run = await f.memory.dreaming({ kind: 'start', owner: 'a' })
    run = await f.memory.dreaming({ kind: 'prepare', ...claim(run) })
    const before = structuredClone(f.memory.getMemoryTopic(f.topicId))
    const operation: any = { kind: 'rewrite-overview', titles: ['开发'], entries: [{ title: '开发', kind: 'history', text: '内容', sourceEventIds: [f.events[0]!.id] }] }
    if (mode === 'unknown-section') operation.titles = ['不存在']
    if (mode === 'duplicate-section') operation.titles = ['开发', '开发']
    if (mode === 'missing-title') delete operation.entries[0].title
    if (mode === 'outside-title') operation.entries[0].title = '未选中的小节'
    if (mode === 'blank-text') operation.entries[0].text = '  '
    if (mode === 'empty-citations') operation.entries[0].sourceEventIds = []
    if (mode === 'null-entry') operation.entries = [null]
    await expect(f.memory.dreaming({ kind: 'apply', ...claim(run), operations: [{ kind: 'rename-chapter', title: '不能保存' }, operation] })).rejects.toThrow()
    expect((await f.reopen()).getMemoryTopic(f.topicId)).toEqual(before)
  })
})

async function seedQuotes(f: Awaited<ReturnType<typeof fixture>>, quotes: string) {
  const { SqliteStorage } = await import('@diqier/stratagate/sqlite')
  const snapshot = f.memory.exportSnapshot()
  snapshot.events[0]!.quotes = [quotes]
  const fingerprint = memoryTopicEventFingerprint(snapshot.events[0]!)
  snapshot.memoryTopicState!.topics[0]!.sourceVersions[snapshot.events[0]!.id] = fingerprint
  snapshot.memoryTopicState!.topics[0]!.dependencyVersions![snapshot.events[0]!.id] = fingerprint
  snapshot.memoryTopicState!.projectedVersions[snapshot.events[0]!.id] = fingerprint
  const db = new SqliteStorage({ filename: f.database })
  try { await db.save(f.namespace, snapshot, f.memory.storageRevision) } finally { db.close() }
  await f.memory.reloadFromStorage()
  return fingerprint
}
async function seedOverview(f: Awaited<ReturnType<typeof fixture>>, count: number, detail = '') {
  const { SqliteStorage } = await import('@diqier/stratagate/sqlite')
  const snapshot = f.memory.exportSnapshot()
  snapshot.memoryTopicState!.topics.find(t => t.id === f.topicId)!.overview = Array.from({ length: count }, (_, i) => ({
    kind: 'history', title: '开发', text: `有来源的总览 ${i}。${detail}`, sourceEventIds: [f.events[0]!.id],
  }))
  const db = new SqliteStorage({ filename: f.database })
  try { await db.save(f.namespace, snapshot, f.memory.storageRevision) } finally { db.close() }
  await f.memory.reloadFromStorage()
}
async function pendingProjection(f: Awaited<ReturnType<typeof fixture>>) {
  const event = await f.memory.addEvent({ title: '等待目录投影的新事件', summary: '已有队列，与新对话无关。',
    sourceBlockId: f.block.id, sourceMessageIds: [f.block.l5Raw[0]!.id] })
  return { event, job: (await f.memory.claimNextTopicProjection())! }
}

describe('r3 Dreaming projection wait regressions', () => {
  it('polls a draining projection for two minutes without saving per poll, while heartbeat renews the claim', async () => {
    let now = Date.now()
    const f = await fixture(1, undefined, undefined, () => new Date(now))
    const { job } = await pendingProjection(f)
    let run = await f.memory.dreaming({ kind: 'start', owner: 'r3' })
    const { SqliteStorage } = await import('@diqier/stratagate/sqlite')
    const saves = vi.spyOn(SqliteStorage.prototype, 'save')
    try {
      for (let poll = 1; poll <= 600; poll++) {
        now += 200
        if (poll % 100 === 0) await f.memory.dreaming({ kind: 'heartbeat', ...claim(run) })
        run = await f.memory.dreaming({ kind: 'prepare', ...claim(run) })
        expect(run).toMatchObject({ status: 'running', waitingForProjection: true, calls: 0 })
      }
      expect(saves).toHaveBeenCalledTimes(6)
      expect(Date.parse(run.leaseUntil!)).toBeGreaterThan(now)
      const other = await f.reopen()
      expect(other.exportSnapshot().memoryTopicState!.dreaming).toMatchObject({ id: run.id, waitingForProjection: true })
      await other.failTopicProjection(job.jobId, new Error('projection failed on another connection'))
      run = await f.memory.dreaming({ kind: 'prepare', ...claim(run) })
      expect(run.waitingForProjection).not.toBe(true)
      expect(run.status).toBe('running')
    } finally { saves.mockRestore() }
  })

  it.each(['complete', 'fail', 'expire'] as const)('waits for the first directory projection and handles %s without an initial chapter', async end => {
    let now = Date.now()
    const f = await fixture(0, undefined, undefined, () => new Date(now))
    await expect(f.memory.dreaming({ kind: 'start', owner: 'r3' })).rejects.toThrow('尚无可整理')
    const { job, event } = await pendingProjection(f)
    let run = await f.memory.dreaming({ kind: 'start', owner: 'r3' })
    expect(run).toMatchObject({ status: 'running', waitingForProjection: true, units: [] })
    expect(await f.memory.claimNextTopicProjection()).toBeNull()
    await f.memory.dreaming({ kind: 'pause', id: run.id })
    run = await f.memory.dreaming({ kind: 'prepare', ...claim(run) })
    expect(run.status).toBe('paused')
    const other = await f.reopen()
    expect(await other.claimNextTopicProjection()).toBeNull()
    run = await other.dreaming({ kind: 'resume', id: run.id, owner: 'r3-restarted' })
    if (end === 'complete') await other.completeTopicProjection(job.jobId, { topics: [{ title: '首次章节', description: '新生成', sourceEventIds: [event.id], overview: [] }] })
    else if (end === 'fail') await other.failTopicProjection(job.jobId, new Error('first projection failed'))
    else now += 6 * 60_000
    if (end === 'expire') {
      // Restart can reclaim the expired Dreaming lease while retaining the wait and exclusive reservation.
      await other.reloadFromStorage()
      run = await other.dreaming({ kind: 'resume', id: run.id, owner: 'after-expiry' })
    }
    run = await other.dreaming({ kind: 'prepare', ...claim(run) })
    expect(run.waitingForProjection).not.toBe(true)
    expect(run.calls).toBe(0)
    expect(run.status).toBe(end === 'complete' ? 'running' : 'completed')
    if (end === 'complete') expect(run.units[0]!.eventIds).toEqual([event.id])
    else {
      now += 60_001 // A failed projection retains its ordinary retry backoff.
      expect(other.hasPendingTopicWork()).toBe(true)
    }
  })
})

async function editTopicOutsideDreaming(f: Awaited<ReturnType<typeof fixture>>) {
  const other = await f.reopen()
  const snapshot = other.exportSnapshot()
  snapshot.memoryTopicState!.topics[0]!.title = '并发改名'
  const { SqliteStorage } = await import('@diqier/stratagate/sqlite')
  const db = new SqliteStorage({ filename: f.database })
  try { await db.save(f.namespace, snapshot, other.storageRevision) } finally { db.close() }
}
async function seedLegacyTokenLimit(f: Awaited<ReturnType<typeof fixture>>) {
  const { SqliteStorage } = await import('@diqier/stratagate/sqlite')
  await f.memory.reloadFromStorage()
  const snapshot = f.memory.exportSnapshot()
  Object.assign(snapshot.memoryTopicState!.dreaming!, { tokenLimit: 1000, estimatedTokens: 17769 })
  const storage = new SqliteStorage({ filename: f.database })
  try { await storage.save(f.namespace, snapshot, f.memory.storageRevision) } finally { storage.close() }
}
function directoryTask(options: any) {
  const tasks = options.messages.flatMap((message: any) => message.role === 'user' ? message.content.flatMap((block: any) => {
    if (block.type !== 'text') return []
    try { const value = JSON.parse(block.text); return value.currentDirectoryTask ? [value.currentDirectoryTask] : [] } catch { return [] }
  }) : [])
  expect(tasks.length).toBeGreaterThan(0)
  return tasks.at(-1)
}
async function nativeHost(runtime: StrataGateRuntime, directory: string, stream: (options: any) => AsyncIterable<any>, mountDreamingHost = true) {
  const ctx = new Context()
  cleanups.push(async () => { await runtime.close(); await ctx.fiber.dispose() })
  await ctx.plugin(LlmRuntime); await ctx.plugin(SystemPrompt, {}); await ctx.plugin(ToolRuntime, { mode: 'native' })
  await ctx.plugin(SessionStore); await ctx.plugin(SessionProjections); await ctx.plugin(AgentRegistry)
  await ctx.plugin(JsonlPersistence, { root: join(directory, 'sessions'), compression: 'none' })
  await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 })
  ctx.on('llm/stream', stream)
  if (mountDreamingHost) runtime.setDreamingHost(new DshDreamingSessions(ctx, runtime, () => ({ provider: 'fixture', model: 'fixture' })))
  return ctx
}
function* nativeCall(name: string, args: unknown, id = 'call', index = 0) {
  yield { type: 'tool-call-delta', index, id, name, argumentsDelta: JSON.stringify(args) }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}
async function historyController(ctx: Context) {
  await ctx.plugin(SessionQuery, { path: ':memory:', openAt: 'never' })
  // Exercise the host's actual history implementation, not a navigation stub.
  const entry = createRequire(import.meta.url).resolve('@deepseek-ai/dsh-api-session-controller/package.json')
  const { SessionHistoryController } = await import(pathToFileURL(join(dirname(entry), 'lib/types/history.js')).href)
  return new SessionHistoryController(ctx, () => {})
}

describe('directory Dreaming persistence and source-only tools', () => {
  it('starts, pauses, opens history, resumes and disposes through the actually mounted plugin scope', async () => {
    const cwd = resolve('release-candidates', 'dreaming-mounted-workspace')
    const namespace = 'dsh:project:' + createHash('sha256').update(cwd.replaceAll('\\', '/').toLowerCase()).digest('hex').slice(0, 20)
    const f = await fixture(1, undefined, namespace)
    const unused = runtimeFor(f.database, async () => { throw new Error('not used') })
    let release!: () => void, requests = 0, finished = false
    const ctx = await nativeHost(unused, f.directory, async function* (options) {
      requests++
      if (!finished) {
        await new Promise<void>(done => { release = done; options.signal.addEventListener('abort', done, { once: true }) })
        yield { type: 'finish', reason: { kind: options.signal.aborted ? 'aborted' : 'stop' } }
      } else if (requests === 2) yield* nativeCall('dreaming_finish', {})
      else { yield { type: 'text-delta', index: 0, text: '已完成。' }; yield { type: 'finish', reason: { kind: 'stop' } } }
    }, false)
    await ctx.plugin(AgentDefaultModelConfig, { provider: 'fixture', model: 'fixture' })
    const owner = await ctx.agents.create({ sessionId: 'mounted-owner' as any, meta: { cwd } })
    const history = await historyController(ctx)
    let route!: (req: any, res: any) => Promise<void>
    ctx.provide('webServer', { host: '127.0.0.1', port: 10259, register: (definition: any) => { route = definition.handler; return () => {} } })
    const mounted = await ctx.plugin(StrataGatePlugin, { database: f.database, namespaceMode: 'project', provider: 'fixture', model: 'fixture', blockTurnSize: 1 })
    expect(() => mounted.ctx.sessions).toThrow('without inject')
    expect(mounted.ctx.get('sessions')).toBeDefined()
    const request = async (action?: string, id?: string) => {
      let body = ''
      const res = { statusCode: 0, setHeader: () => {}, end: (text: string) => { body = text } }
      const url = `/api/stratagate/dreaming?namespace=${encodeURIComponent(namespace)}${action ? `&action=${action}` : ''}${id ? `&id=${id}` : ''}`
      await route({ method: action ? 'POST' : 'GET', url }, res)
      expect(res.statusCode).toBe(200)
      return JSON.parse(body)
    }
    await request('start')
    await vi.waitFor(async () => {
      const status = await request()
      if (status.run.status === 'paused') throw new Error(`Plugin-scoped Dreaming paused before dispatch: ${status.run.reason}`)
      expect(requests).toBe(1)
    })
    const { run } = await request()
    expect(run.status).toBe('running')
    await request('pause', run.id); release()
    await vi.waitFor(async () => expect((await request()).run.status).toBe('paused'))
    expect(await request('open-session', run.id)).toEqual({ sessionId: run.sessionId })
    const agent = ctx.agents.get(run.sessionId)!
    expect(agent.session.header.cwd).toBe(cwd)
    expect((await history.page({ address: { kind: 'session', sessionId: run.sessionId }, throughSeq: agent.session.seq - 1 }, new AbortController().signal)).records.length).toBeGreaterThan(0)
    finished = true
    await request('resume', run.id)
    await vi.waitFor(async () => expect((await request()).run.status).toBe('completed'))
    await ctx.agents.get(run.sessionId)!.whenIdle()
    await mounted.dispose()
    expect(ctx.agents.get(run.sessionId)).toBeUndefined()
    expect((await ctx.sessionPersistence.stat(run.sessionId))?.header.cwd).toBe(cwd)
    await owner.dispose()
  }, 20_000)

  it('reproduces session/not-found for a real stored Session without cwd', async () => {
    const f = await fixture()
    const runtime = runtimeFor(f.database, async () => { throw new Error('legacy') })
    const ctx = await nativeHost(runtime, f.directory, async function* () { yield* nativeCall('dreaming_finish', {}) })
    const history = await historyController(ctx)
    const handle = await ctx.agents.create({ sessionId: 'history-without-cwd' as any })
    expect(handle.agent.session.header.cwd).toBeUndefined()
    await ctx.sessions.flush(handle.agent.session)
    await expect(history.page({ address: { kind: 'session', sessionId: handle.agent.id }, throughSeq: -1 }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'session/not-found' })
    await handle.dispose()
  })

  it.each(['live', 'stored'] as const)('uses the correct %s project cwd and serves real Dreaming history while running and after shutdown', async mode => {
    const cwd = resolve('release-candidates', 'dreaming-history-workspace')
    const namespace = 'dsh:project:' + createHash('sha256').update(cwd.replaceAll('\\', '/').toLowerCase()).digest('hex').slice(0, 20)
    const f = await fixture(1, undefined, namespace)
    const runtime = runtimeFor(f.database, async () => { throw new Error('legacy') })
    const requestStarted = vi.fn()
    const ctx = await nativeHost(runtime, f.directory, async function* (options) {
      requestStarted()
      await new Promise<void>(done => { if (options.signal.aborted) done(); else options.signal.addEventListener('abort', done, { once: true }) })
      yield { type: 'finish', reason: { kind: 'aborted' } }
    })
    const history = await historyController(ctx)
    ctx.sessions.create('unrelated-project' as any, { meta: { cwd: resolve('release-candidates', 'different-workspace') } })
    const source = await ctx.agents.create({ sessionId: 'project-owner' as any, meta: { cwd } })
    await ctx.sessions.flush(source.agent.session)
    if (mode === 'stored') await source.dispose()
    await runtime.adminDreamingControl(namespace, 'start')
    await vi.waitFor(() => expect(requestStarted).toHaveBeenCalled())
    const run = (await runtime.adminDreamingStatus(namespace) as any).run
    const agent = ctx.agents.get(run.sessionId)!
    expect(agent.session.header.cwd).toBe(cwd)
    expect(await runtime.adminDreamingSession(namespace, run.id)).toEqual({ sessionId: run.sessionId })
    const page = await history.page({ address: { kind: 'session', sessionId: run.sessionId }, throughSeq: agent.session.seq - 1 }, new AbortController().signal)
    expect(JSON.stringify(page.records)).toContain('currentDirectoryTask')
    await runtime.close()
    expect(ctx.agents.get(run.sessionId)).toBeUndefined()
    const cold = await history.page({ address: { kind: 'session', sessionId: run.sessionId }, throughSeq: -1 }, new AbortController().signal)
    expect(cold).toHaveProperty('records')
    expect((await ctx.sessionPersistence.stat(run.sessionId))?.header.cwd).toBe(cwd)
    if (mode === 'live') await source.dispose()
  })

  it('blocks a project run whose cwd cannot be resolved instead of creating an invisible Session', async () => {
    const f = await fixture(1, undefined, 'dsh:project:orphan-workspace')
    const runtime = runtimeFor(f.database, async () => { throw new Error('legacy') })
    const stream = vi.fn(async function* () { yield* nativeCall('dreaming_finish', {}) })
    const ctx = await nativeHost(runtime, f.directory, stream)
    await runtime.adminDreamingControl(f.namespace, 'start')
    await vi.waitFor(async () => expect(await runtime.adminDreamingStatus(f.namespace)).toMatchObject({ run: { status: 'paused', reason: expect.stringContaining('工作区路径') } }))
    expect(stream).not.toHaveBeenCalled()
    expect(ctx.agents.list().filter(agent => String(agent.id).startsWith('stratagate-dreaming:'))).toHaveLength(0)
  })

  it('explains why an old cwd-less Dreaming cannot be opened without rewriting its immutable history', async () => {
    const f = await fixture()
    const runtime = runtimeFor(f.database, async () => { throw new Error('legacy') })
    const ctx = await nativeHost(runtime, f.directory, async function* () { yield* nativeCall('dreaming_finish', {}) })
    let run = await f.memory.dreaming({ kind: 'start', owner: 'old-host' })
    const sessionId = `stratagate-dreaming:${run.id}`
    run = await f.memory.dreaming({ kind: 'bind-session', ...claim(run), sessionId })
    const old = await ctx.agents.create({ sessionId: sessionId as any })
    await ctx.sessions.flush(old.agent.session)
    const before = old.agent.session.snapshotEvents()
    const host = new DshDreamingSessions(ctx, runtime, () => ({ provider: 'fixture', model: 'fixture', maxTokens: 32768 }))
    cleanups.push(() => host.close())
    await expect(host.open(f.namespace, run)).rejects.toThrow('旧 Dreaming 会话缺少工作区路径')
    await expect(host.run(f.namespace, run, new AbortController().signal)).rejects.toThrow('旧 Dreaming 会话缺少工作区路径')
    expect(old.agent.session.snapshotEvents()).toEqual(before)
    expect((await ctx.sessionPersistence.stat(sessionId as any))?.header.cwd).toBeUndefined()
    await old.dispose()
  })

  it('bounds native searches even when every query differs and succeeds without new evidence', async () => {
    const f = await fixture()
    const runtime = runtimeFor(f.database, async () => { throw new Error('legacy') })
    let calls = 0
    await nativeHost(runtime, f.directory, async function* () {
      yield* nativeCall('dreaming_search', { kind: 'events', query: `never-matches-${++calls}` }, `call-${calls}`)
    })
    await runtime.adminDreamingControl(f.namespace, 'start')
    await vi.waitFor(async () => expect(await runtime.adminDreamingStatus(f.namespace)).toMatchObject({ run: { status: 'paused', completed: 0, calls: 12 } }), { timeout: 3000 })
    expect(calls).toBe(12)
    await runtime.close()
    const reopened = await f.reopen()
    expect(reopened.exportSnapshot().memoryTopicState?.dreaming).toMatchObject({ status: 'paused', idleCalls: 12 })
  })

  it('accounts actual native request input including task, system prompt and JSON tool schemas', async () => {
    const f = await fixture(1)
    await seedQuotes(f, '证据'.repeat(4000))
    const runtime = runtimeFor(f.database, async () => { throw new Error('legacy') })
    runtime.updatePersistentProfile('preferredLanguage', '简体中文', 'user_explicit')
    runtime.updatePersistentProfile('standingInstructions', '整理目录时保留来源和不确定性。', 'user_explicit')
    const observed: Array<{ expected: number; consumed: number; hasTask: boolean; hasPolicy: boolean; hasProfile: boolean }> = []
    const ctx = await nativeHost(runtime, f.directory, async function* (options) {
      const status = await runtime.adminDreamingStatus(f.namespace) as any
      const text = JSON.stringify(options.messages)
      observed.push({ expected: estimateTokens(JSON.stringify({ messages: options.messages, tools: options.tools ?? [] })),
        consumed: status.run.estimatedTokens, hasTask: text.includes('currentDirectoryTask'), hasPolicy: text.includes('directory-maintenance Agent'),
        hasProfile: text.includes('Preferred answer language: 简体中文') && text.includes('整理目录时保留来源和不确定性。') })
      if (observed.length === 1) yield* nativeCall('dreaming_finish', {})
      else { yield { type: 'text-delta', index: 0, text: '完成。' }; yield { type: 'finish', reason: { kind: 'stop' } } }
    })
    await runtime.adminDreamingControl(f.namespace, 'start')
    await vi.waitFor(() => expect(observed).toHaveLength(2))
    await ctx.agents.get((await runtime.adminDreamingStatus(f.namespace) as any).run.sessionId)!.whenIdle()
    expect(observed[0]).toMatchObject({ hasTask: true, hasPolicy: true, hasProfile: true })
    expect(observed[0]!.consumed).toBe(observed[0]!.expected)
    expect(observed[0]!.expected).toBeGreaterThan(8000)
    const final = (await runtime.adminDreamingStatus(f.namespace) as any).run
    expect(final.estimatedTokens).toBeGreaterThanOrEqual(observed.reduce((sum, entry) => sum + entry.expected, 0))
    expect(final.status).toBe('completed')
    expect((await f.reopen()).exportSnapshot().memoryTopicState?.dreaming?.leaseUntil).toBeNull()
  })

  it.each(['empty', 'placeholder', 'text'] as const)('bounds consecutive %s continuations using the persisted counter', async mode => {
    const f = await fixture()
    const runtime = runtimeFor(f.database, async () => { throw new Error('legacy') })
    let dispatched = 0
    let expectedTokens = 0
    const ctx = await nativeHost(runtime, f.directory, async function* (options) {
      dispatched++
      expectedTokens += estimateTokens(JSON.stringify({ messages: options.messages, tools: options.tools ?? [] }))
      const text = mode === 'empty' ? '' : mode === 'placeholder' ? '(empty)' : `继续思考 ${dispatched}`
      expectedTokens += estimateTokens(text)
      if (text) yield { type: 'text-delta', index: 0, text }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })
    const errors: string[] = []
    ctx.on('agent/error', ({ error }) => { errors.push(String(error)) })
    await runtime.adminDreamingControl(f.namespace, 'start')
    await vi.waitFor(async () => expect(await runtime.adminDreamingStatus(f.namespace)).toMatchObject({ run: { status: 'paused', completed: 0 } }))
    await ctx.agents.get((await runtime.adminDreamingStatus(f.namespace) as any).run.sessionId)!.whenIdle()
    expect(errors).toEqual([])
    expect((await runtime.adminDreamingStatus(f.namespace) as any).run.calls).toBe(3)
    expect((await runtime.adminDreamingStatus(f.namespace) as any).run.estimatedTokens).toBe(expectedTokens)
    expect(dispatched).toBe(3)
    expect((await f.reopen()).exportSnapshot().memoryTopicState?.dreaming).toMatchObject({ idleCalls: 0, idleModelSteps: 3, reason: expect.stringContaining('连续 3 次') })
    const stopped = (await runtime.adminDreamingStatus(f.namespace) as any).run
    await vi.waitFor(() => expect(ctx.agents.get(stopped.sessionId)?.session.snapshotEvents()
      .some(e => e.type === 'user/message' && JSON.stringify(e.data).includes('Dreaming 已暂停'))).toBe(true))
  })

  it('recovers empty and short replies across batches and runs through all pending work in one turn', async () => {
    const f = await fixture(80)
    const runtime = runtimeFor(f.database, async () => { throw new Error('legacy') })
    const attempts = new Map<number, number>()
    let summaries = 0
    const ctx = await nativeHost(runtime, f.directory, async function* (options) {
      const status = (await runtime.adminDreamingStatus(f.namespace) as any).run
      if (status.status === 'completed') {
        summaries++
        yield { type: 'text-delta', index: 0, text: '整轮已完成。' }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      const task = directoryTask(options)
      const batch = task.completedBatches
      expect(batch).toBe(status.completed)
      const attempt = (attempts.get(batch) ?? 0) + 1
      attempts.set(batch, attempt)
      if (batch > 0 && attempt === 1) expect(JSON.stringify(options.messages)).toContain(`待处理的第 ${batch + 1}/`)
      if (attempt <= 2) {
        // Both the provider placeholder seen in production and a valid short
        // explanation may precede actual action. Neither completes a batch.
        if (attempt === 1) yield { type: 'text-delta', index: 0, text: '(empty)' }
        else yield { type: 'text-delta', index: 0, text: '继续检查当前批次。' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      } else if (batch === 1 && attempt === 3) {
        yield* nativeCall('dreaming_directory', { operations: [{ kind: 'append-overview', title: '开发', entries: [
          { kind: 'experience', text: '检查完来源后保留这条经验。', sourceEventIds: [task.events[0].id] },
        ] }] }, 'saved-once')
      } else if (batch === 1 && attempt === 4) {
        expect(options.messages.some((message: any) => message.role === 'tool' && message.content.some((block: any) => {
          try { return JSON.parse(block.text).saved === true } catch { return false }
        }))).toBe(true)
        yield { type: 'finish', reason: { kind: 'stop' } }
      } else yield* nativeCall('dreaming_finish', { summary: '本批已检查完毕。' }, `finish-${batch}`)
    })
    await runtime.adminDreamingControl(f.namespace, 'start')
    await vi.waitFor(async () => expect(await runtime.adminDreamingStatus(f.namespace)).toMatchObject({ run: { status: 'completed', completed: 4, total: 4 } }), { timeout: 7000 })
    const run = (await runtime.adminDreamingStatus(f.namespace) as any).run
    const agent = ctx.agents.get(run.sessionId)!
    await agent.whenIdle()
    expect([...attempts.values()]).toEqual([3, 5, 3, 3])
    expect(summaries).toBe(1)
    expect(agent.session.snapshotEvents().filter(e => e.type === 'turn/start')).toHaveLength(1)
    expect(agent.session.snapshotEvents().some(e => e.type === 'user/message' && JSON.stringify(e.data).includes('Dreaming 已暂停'))).toBe(false)
    const persisted = await f.reopen()
    expect(persisted.exportSnapshot().memoryTopicState?.dreaming).toMatchObject({ cursor: 4, status: 'completed', changedBatches: 1 })
    expect(persisted.getMemoryTopic(f.topicId)?.overview.filter(entry => entry.text === '检查完来源后保留这条经验。')).toHaveLength(1)
  })

  it('does not send a recovery request when the user pauses after an empty response', async () => {
    const f = await fixture(1)
    const runtime = runtimeFor(f.database, async () => { throw new Error('legacy') })
    let requests = 0
    const ctx = await nativeHost(runtime, f.directory, async function* () {
      requests++
      yield { type: 'text-delta', index: 0, text: '(empty)' }
      const status = (await runtime.adminDreamingStatus(f.namespace) as any).run
      await runtime.adminDreamingControl(f.namespace, 'pause', status.id)
      yield { type: 'finish', reason: { kind: 'stop' } }
    })
    await runtime.adminDreamingControl(f.namespace, 'start')
    await vi.waitFor(async () => expect(await runtime.adminDreamingStatus(f.namespace)).toMatchObject({ run: { status: 'paused' } }))
    await ctx.agents.get((await runtime.adminDreamingStatus(f.namespace) as any).run.sessionId)!.whenIdle()
    expect(requests).toBe(1)
  })

  it('uses the host output setting and allows long output to reach a native tool call', async () => {
    const f = await fixture()
    const runtime = runtimeFor(f.database, async () => { throw new Error('legacy') })
    let dispatched = 0, aborted = false
    const ctx = await nativeHost(runtime, f.directory, async function* (options) {
      dispatched++
      expect(options.maxTokens).toBe(65_536)
      if (dispatched === 1) {
        const text = '核对后的整理说明。'.repeat(4000)
        expect(estimateTokens(text)).toBeGreaterThan(32_768)
        yield { type: 'text-delta', index: 0, text }
        aborted = options.signal.aborted
        for (const chunk of nativeCall('dreaming_finish', {})) yield chunk.type === 'tool-call-delta' ? { ...chunk, index: 1 } : chunk
      } else {
        yield { type: 'text-delta', index: 0, text: '已检查完毕，无需修改。' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    })
    ctx.on('agent/request', async (_payload, next) => ({ ...await next(), maxTokens: 65_536 }))
    await runtime.adminDreamingControl(f.namespace, 'start')
    await vi.waitFor(async () => {
      const status = await runtime.adminDreamingStatus(f.namespace)
      expect(status, JSON.stringify(status)).toMatchObject({ run: { status: 'completed', completed: 1 } })
    })
    const run = (await runtime.adminDreamingStatus(f.namespace) as any).run
    await ctx.agents.get(run.sessionId)!.whenIdle()
    expect(dispatched).toBe(2)
    expect(aborted).toBe(false)
    expect(run.calls).toBe(2)
    expect((await f.reopen()).exportSnapshot().memoryTopicState?.dreaming).toMatchObject({ status: 'completed', cursor: 1, changedBatches: 0 })
  })

  it('reads more than six directory pages, persists coverage across resume, and completes in the same session', async () => {
    const f = await fixture(1)
    await seedOverview(f, 52)
    const runtime = runtimeFor(f.database, async () => { throw new Error('legacy') })
    let requests = 0, finished = false
    const seen: number[] = []
    const ctx = await nativeHost(runtime, f.directory, async function* (options) {
      requests++
      if (finished) { yield { type: 'text-delta', index: 0, text: '全部检查完毕，无需修改。' }; yield { type: 'finish', reason: { kind: 'stop' } }; return }
      const task = directoryTask(options)
      const pages = options.messages.filter((m: any) => m.role === 'tool').flatMap((m: any) => m.content.flatMap((b: any) => {
        try { const result = JSON.parse(b.text); return result.overview ? [result.overview] : [] } catch { return [] }
      }))
      const offset = pages.length ? pages.at(-1).nextOffset : task.directoryReadProgress.overview.nextUnreadOffset
      if (offset === null) { finished = true; yield* nativeCall('dreaming_finish', {}); return }
      seen.push(offset)
      if (seen.length === 4) {
        const status = (await runtime.adminDreamingStatus(f.namespace) as any).run
        await runtime.adminDreamingControl(f.namespace, 'pause', status.id)
        yield { type: 'text-delta', index: 0, text: '先暂停，等待继续。' }
      }
      else yield* nativeCall('memory_expand_topic', { id: f.topicId, offset, limit: 5 })
      if (seen.length === 4) yield { type: 'finish', reason: { kind: 'stop' } }
    })
    await runtime.adminDreamingControl(f.namespace, 'start')
    await vi.waitFor(async () => expect(await runtime.adminDreamingStatus(f.namespace)).toMatchObject({ run: { status: 'paused', completed: 0 } }))
    const first = (await runtime.adminDreamingStatus(f.namespace) as any).run
    const persisted = (await f.reopen()).exportSnapshot().memoryTopicState!.dreaming!
    const progress = (dreamingPayload(await f.reopen(), persisted) as any).directoryReadProgress.overview
    expect(progress).toMatchObject({ readCount: 15, nextUnreadOffset: 15 })
    await ctx.agents.get(first.sessionId)!.whenIdle()
    await seedLegacyTokenLimit(f)
    await runtime.adminDreamingControl(f.namespace, 'resume', first.id)
    await vi.waitFor(async () => expect(await runtime.adminDreamingStatus(f.namespace)).toMatchObject({ run: { status: 'completed', completed: 1, sessionId: first.sessionId } }), { timeout: 7000 })
    await ctx.agents.get(first.sessionId)!.whenIdle()
    expect(seen).toEqual([0, 5, 10, 15, 15, 20, 25, 30, 35, 40, 45, 50])
    const agent = ctx.agents.get(first.sessionId)!
    expect(agent.session.snapshotEvents().filter(e => e.type === 'user/message' && JSON.stringify(e.data).includes('currentDirectoryTask'))).toHaveLength(2)
    expect(agent.session.snapshotEvents().some(e => typeof e.surfaceOp === 'object' && e.surfaceOp.op === 'replace')).toBe(false)
    const final = (await f.reopen()).exportSnapshot().memoryTopicState!.dreaming!
    expect(final.status).toBe('completed')
    expect(final.tokenLimit).toBeNull()
    expect(final.idleCalls).toBe(0)
    expect(final.directoryReads?.[JSON.stringify([f.topicId, 'overview'])]?.indices).toHaveLength(52)
  })

  it('allows eleven unproductive reads across reopen, resets on fresh content and pauses on the twelfth', async () => {
    const f = await fixture(1)
    await seedOverview(f, 52)
    let memory = f.memory
    let run = await memory.dreaming({ kind: 'start', owner: 'idle-limit' })
    run = await memory.dreaming({ kind: 'prepare', ...claim(run) })
    const readPage = async (offset: number) => {
      const action = { tool: 'memory_expand_topic', args: { id: f.topicId, offset, limit: 20 } }
      const read = await dreamingTool(memory, run, action)
      run = await memory.dreaming({ kind: 'checkpoint', ...claim(run), trace: { ...action, result: read.result }, estimatedTokens: 0 })
    }
    await readPage(0)
    for (let count = 1; count <= 11; count++) {
      await readPage(0)
      expect(run).toMatchObject({ status: 'running', idleCalls: count })
      if (count === 6) memory = await f.reopen()
    }
    await readPage(20)
    expect(run).toMatchObject({ status: 'running', idleCalls: 0 })
    for (let count = 1; count <= 11; count++) {
      await readPage(20)
      expect(run).toMatchObject({ status: 'running', idleCalls: count })
    }
    await readPage(20)
    expect(run).toMatchObject({ status: 'paused', idleCalls: 12, reason: '连续调用没有有效进展，断点已保存' })
    expect((await f.reopen()).exportSnapshot().memoryTopicState?.dreaming).toMatchObject({ status: 'paused', idleCalls: 12 })
  })

  it('retains all relevant overview, earlier source pages and working conclusions in the native conversation', async () => {
    const f = await fixture(1, '早期来源标记。' + '原始来源正文。'.repeat(4000))
    await seedOverview(f, 84, '这是已有事实的来源说明。'.repeat(12))
    const runtime = runtimeFor(f.database, async () => { throw new Error('legacy') })
    let requests = 0
    const conclusion = '已核对旧总览第83条，本批事实已有覆盖，无需重复追加。'
    const ctx = await nativeHost(runtime, f.directory, async function* (options) {
      requests++
      const task = directoryTask(options)
      expect(task.currentTopic.existingOverview.items).toHaveLength(84)
      expect(task.currentTopic.existingOverview.omittedOffsets).toEqual([])
      expect(estimateTokens(JSON.stringify(task.currentTopic.existingOverview.items))).toBeGreaterThan(4000)
      if (requests === 1) {
        yield { type: 'text-delta', index: 0, text: conclusion }
        for (const chunk of nativeCall('dreaming_read', { kind: 'block', id: f.block.id, level: 5, offset: 0, limit: 12000 })) yield chunk.type === 'tool-call-delta' ? { ...chunk, index: 1 } : chunk
      } else if (requests === 2) {
        expect(JSON.stringify(options.messages)).toContain(conclusion)
        yield* nativeCall('dreaming_read', { kind: 'block', id: f.block.id, level: 5, offset: 12000, limit: 12000 }, 'next-source-page')
      } else if (requests === 3) {
        const text = JSON.stringify(options.messages)
        expect(text).toContain(conclusion)
        expect(text).toContain('早期来源标记')
        const results = options.messages.filter((m: any) => m.role === 'tool')
        expect(results).toHaveLength(2)
        expect(estimateTokens(JSON.stringify(results))).toBeGreaterThan(6000)
        expect(text).not.toContain('checkpointed')
        yield* nativeCall('dreaming_finish', { summary: '已有总览覆盖，无需重复追加。' })
      } else {
        yield { type: 'text-delta', index: 0, text: '检查完毕，无需修改。' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    })
    await runtime.adminDreamingControl(f.namespace, 'start')
    await vi.waitFor(async () => expect(await runtime.adminDreamingStatus(f.namespace)).toMatchObject({ run: { status: 'completed', changedBatches: 0 } }), { timeout: 5000 })
    const status = (await runtime.adminDreamingStatus(f.namespace) as any).run
    const agent = ctx.agents.get(status.sessionId)!
    await agent.whenIdle()
    const events = agent.session.snapshotEvents()
    expect(events.filter(e => e.type === 'user/message' && JSON.stringify(e.data).includes('currentDirectoryTask'))).toHaveLength(1)
    expect(events.some(e => typeof e.surfaceOp === 'object' && e.surfaceOp.op === 'replace')).toBe(false)
    expect((await f.reopen()).getMemoryTopic(f.topicId)?.overview).toHaveLength(84)
  })

  it.each(['pressure', 'overflow'] as const)('lets native Harness compaction preserve findings and resume after %s', async mode => {
    const f = await fixture(1, '供宿主压缩的来源正文。'.repeat(1800))
    await seedOverview(f, 84, '已有来源与待核对内容。'.repeat(20))
    const runtime = runtimeFor(f.database, async () => { throw new Error('legacy') })
    let requests = 0, summaries = 0
    const errors: string[] = [], summaryObservations: unknown[] = []
    const checkpoint = '宿主摘要：目录开发小节已有84条总览，当前批待完成；核对结论沿用最近对话。'
    const ctx = await nativeHost(runtime, f.directory, async function* (options) {
      if (options.purpose === 'compaction') {
        summaries++
        const before = (await runtime.adminDreamingStatus(f.namespace) as any).run
        summaryObservations.push({ calls: before.calls, hasConclusion: JSON.stringify(options.messages).includes('当前批次已核对，不应重复写入。') })
        expect(before.calls).toBe(mode === 'pressure' ? 1 : 2)
        // The host summarizes the older task while retaining the recent
        // assistant/tool pair verbatim. Its prefix need not contain that pair.
        expect(JSON.stringify(options.messages)).toContain('currentDirectoryTask')
        expect(JSON.stringify(options.messages)).toContain('有来源的总览 83')
        yield { type: 'text-delta', index: 0, text: checkpoint }
        yield { type: 'finish', reason: { kind: 'stop' } }
        expect((await runtime.adminDreamingStatus(f.namespace) as any).run.calls).toBe(before.calls)
        return
      }
      requests++
      if (requests === 1) {
        yield { type: 'text-delta', index: 0, text: '当前批次已核对，不应重复写入。' }
        for (const chunk of nativeCall('dreaming_read', { kind: 'block', id: f.block.id, level: 5, offset: 0, limit: 12000 })) yield chunk.type === 'tool-call-delta' ? { ...chunk, index: 1 } : chunk
      } else if (mode === 'overflow' && requests === 2) {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'fixture context overflow' } } }
      } else if (requests === (mode === 'pressure' ? 2 : 3)) {
        expect(summaries).toBe(1)
        expect(JSON.stringify(options.messages)).toContain(checkpoint)
        expect(JSON.stringify(options.messages)).toContain('当前批次已核对，不应重复写入。')
        yield* nativeCall('dreaming_finish', { summary: '沿用宿主摘要中的覆盖判断，无需修改。' })
      } else {
        yield { type: 'text-delta', index: 0, text: '整理检查完成。' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    })
    ctx.on('agent/error', ({ error }) => { errors.push(String(error)) })
    await ctx.plugin(TokenMeter)
    vi.spyOn(ctx.llm, 'resolveModelInfo').mockResolvedValue({ context: { contextWindow: mode === 'pressure' ? 30000 : 256000 }, defaultMaxTokens: 2048 } as any)
    await ctx.plugin(BasicCompaction, { thresholdRatio: .4, headroomTokens: 1024, maxTokens: 2048, retainTokens: 1024 })
    await runtime.adminDreamingControl(f.namespace, 'start')
    await vi.waitFor(async () => {
      const status = await runtime.adminDreamingStatus(f.namespace)
      expect(status, JSON.stringify({ status, requests, summaries, errors, summaryObservations })).toMatchObject({ run: { status: 'completed', changedBatches: 0 } })
    }, { timeout: 7000 })
    const status = (await runtime.adminDreamingStatus(f.namespace) as any).run
    const agent = ctx.agents.get(status.sessionId)!
    await agent.whenIdle()
    expect(summaries).toBe(1)
    expect(status.calls).toBe(requests)
    expect(agent.session.snapshotEvents().filter(e => e.type === 'compaction/summary')).toHaveLength(1)
    expect(agent.session.snapshotEvents().filter(e => typeof e.surfaceOp === 'object' && e.surfaceOp.op === 'replace').every(e => e.type === 'user/message' && !JSON.stringify(e.data).includes('plugin:stratagate-memory'))).toBe(true)
    expect((await f.reopen()).exportSnapshot().memoryTopicState?.dreaming).toMatchObject({ status: 'completed', cursor: 1, changedBatches: 0 })
  })

  it('rejects forged directory progress and repeated or overlapping pages after a SQLite reopen', async () => {
    const f = await fixture(1)
    await seedOverview(f, 52)
    let run = await f.memory.dreaming({ kind: 'start', owner: 'a' })
    run = await f.memory.dreaming({ kind: 'prepare', ...claim(run) })
    const action = { tool: 'memory_expand_topic', args: { id: f.topicId, offset: 0, limit: 20 } }
    const read = await dreamingTool(f.memory, run, action)
    run = await f.memory.dreaming({ kind: 'checkpoint', ...claim(run), trace: { ...action, result: read.result }, estimatedTokens: 0 })
    expect(run.idleCalls).toBe(0)
    const reopened = await f.reopen()
    const overlap = { tool: action.tool, args: { id: f.topicId, offset: 10, limit: 20 } }
    const overlapped = await dreamingTool(reopened, run, overlap)
    run = await reopened.dreaming({ kind: 'checkpoint', ...claim(run), trace: { ...overlap, result: overlapped.result }, estimatedTokens: 0 })
    expect(run.directoryReads?.[JSON.stringify([f.topicId, 'overview'])]?.indices).toHaveLength(30)
    const forged = structuredClone(read.result) as any
    forged.overview.items[0].text = '伪造的内容'
    run = await reopened.dreaming({ kind: 'checkpoint', ...claim(run), trace: { ...action, result: forged }, estimatedTokens: 0 })
    expect(run.idleCalls).toBe(1)
    for (let i = 0; i < 11; i++) run = await reopened.dreaming({ kind: 'checkpoint', ...claim(run), trace: { ...action, result: read.result }, estimatedTokens: 0 })
    expect(run).toMatchObject({ status: 'paused', idleCalls: 12 })
  })

  it('counts new topic-list pages as progress across reopen, but not changed queries that repeat known items', async () => {
    const f = await fixture(1)
    const { SqliteStorage } = await import('@diqier/stratagate/sqlite')
    const snapshot = f.memory.exportSnapshot()
    const base = snapshot.memoryTopicState!.topics[0]!
    snapshot.memoryTopicState!.topics = Array.from({ length: 8 }, (_, i) => ({ ...structuredClone(base), id: `${base.id}-${i}`, title: `项目 ${i}` }))
    const db = new SqliteStorage({ filename: f.database })
    try { await db.save(f.namespace, snapshot, f.memory.storageRevision) } finally { db.close() }
    await f.memory.reloadFromStorage()
    let memory = f.memory
    let run = await memory.dreaming({ kind: 'start', owner: 'a' })
    run = await memory.dreaming({ kind: 'prepare', ...claim(run) })
    for (let offset = 0; offset < 8; offset++) {
      const action = { tool: 'memory_list_topics', args: { offset, limit: 1 } }
      const read = await dreamingTool(memory, run, action)
      run = await memory.dreaming({ kind: 'checkpoint', ...claim(run), trace: { ...action, result: read.result }, estimatedTokens: 0 })
      expect(run).toMatchObject({ status: 'running', idleCalls: 0 })
      memory = await f.reopen()
    }
    expect(Object.keys(run.directoryReads!)).toHaveLength(8)
    const forged = { tool: 'memory_list_topics', args: { offset: 0 }, result: { offset: 0,
      topics: [{ id: base.id + '-0', title: '伪造新标题', description: base.description, sourceEventCount: 1 }] } }
    run = await memory.dreaming({ kind: 'checkpoint', ...claim(run), trace: forged, estimatedTokens: 0 })
    expect(run.idleCalls).toBe(1)
    for (let i = 0; i < 11; i++) {
      const action = { tool: 'memory_list_topics', args: { query: `项目 ${i}`, offset: 0, limit: 20 } }
      const read = await dreamingTool(memory, run, action)
      run = await memory.dreaming({ kind: 'checkpoint', ...claim(run), trace: { ...action, result: read.result }, estimatedTokens: 0 })
    }
    expect(run).toMatchObject({ status: 'paused', idleCalls: 12 })
    expect((await f.reopen()).exportSnapshot().memoryTopicState?.dreaming).toMatchObject({ status: 'paused', idleCalls: 12 })
  })

  it('rejects the real malformed nested write through native schemas and lets the Agent correct it', async () => {
    const f = await fixture(1)
    const runtime = runtimeFor(f.database, async () => { throw new Error('legacy') })
    let requests = 0
    const ctx = await nativeHost(runtime, f.directory, async function* (options) {
      requests++
      if (requests === 1) {
        const schema = options.tools.find((t: any) => t.name === 'dreaming_directory').parameters.properties.operations.items
        expect(schema.oneOf.every((branch: any) => branch.required.includes('kind'))).toBe(true)
        yield* nativeCall('dreaming_directory', { operations: [{ operations: [{ title: '开发', entries: [] }] }] }, 'malformed')
      } else if (requests === 2) {
        expect(options.messages.some((m: any) => m.role === 'tool' && m.isError && JSON.stringify(m.content).match(/kind|operations/))).toBe(true)
        yield* nativeCall('memory_expand_topic', { id: f.topicId })
      } else if (requests === 3) {
        expect(options.messages.filter((m: any) => m.role === 'tool' && m.isError)).toHaveLength(1)
        expect(JSON.stringify(options.messages)).not.toContain('validationErrors')
        yield* nativeCall('dreaming_directory', { operations: [{ kind: 'append-overview', title: '开发', entries: [{ kind: 'experience', text: '保留明确来源。', sourceEventIds: [f.events[0]!.id] }] }] }, 'corrected')
      } else if (requests === 4) yield* nativeCall('dreaming_finish', {})
      else { yield { type: 'text-delta', index: 0, text: '已补充一段有来源的经验。' }; yield { type: 'finish', reason: { kind: 'stop' } } }
    })
    await runtime.adminDreamingControl(f.namespace, 'start')
    await vi.waitFor(async () => expect(await runtime.adminDreamingStatus(f.namespace)).toMatchObject({ run: { status: 'completed', changedBatches: 1 } }))
    await ctx.agents.get((await runtime.adminDreamingStatus(f.namespace) as any).run.sessionId)!.whenIdle()
    expect(requests).toBe(5)
    expect((await f.reopen()).getMemoryTopic(f.topicId)?.overview.some(entry => entry.kind === 'experience')).toBe(true)
  })

  it('preserves a failed write proposal beyond the recent tool window', async () => {
    const f = await fixture(1)
    let run = await f.memory.dreaming({ kind: 'start', owner: 'fixture' })
    const bad = { tool: 'dreaming_directory', args: { operations: [{ operations: [] }] } }
    run = await f.memory.dreaming({ kind: 'prepare', ...claim(run) })
    run = await f.memory.dreaming({ kind: 'checkpoint', ...claim(run), trace: { ...bad, result: { error: 'Each operations item must directly contain kind' } }, estimatedTokens: 0 })
    for (let offset = 0; offset < 13; offset++) {
      // Genuine new source pages keep the run live while older trace rows drop.
      const action = { tool: 'dreaming_read', args: { kind: 'block', id: f.block.id, offset, limit: 1 } }
      const read = await dreamingTool(f.memory, run, action)
      run = await f.memory.dreaming({ kind: 'checkpoint', ...claim(run), trace: { ...action, result: read.result }, estimatedTokens: 0 })
    }
    expect(run.trace.every(t => t.tool !== 'dreaming_directory')).toBe(true)
    expect((dreamingPayload(f.memory, run) as any).lastWriteFailure).toMatchObject({ args: bad.args, error: expect.stringContaining('kind') })
  })

  for (const mode of ['long-text', 'textual-tool'] as const) it(`allows ${mode} before a native tool call`, async () => {
    const f = await fixture(1)
    const runtime = runtimeFor(f.database, async () => { throw new Error('legacy') })
    let requests = 0, aborted = false
    const ctx = await nativeHost(runtime, f.directory, async function* (options) {
      requests++
      if (requests === 1) {
        const text = mode === 'long-text' ? '整理说明。'.repeat(700) : '\n<invoke name="dreaming_directory">' + '整理说明。'.repeat(700)
        expect(estimateTokens(text)).toBeGreaterThan(2048)
        yield { type: 'text-delta', index: 0, text }
        aborted = options.signal.aborted
        if (aborted) return
        yield* nativeCall('dreaming_directory', { operations: [{ kind: 'append-overview', title: '开发', entries: [{ kind: 'experience', text: '保留有来源的经验。', sourceEventIds: [f.events[0]!.id] }] }] }, 'call', 1)
      } else if (requests === 2) yield* nativeCall('dreaming_finish', {})
      else { yield { type: 'text-delta', index: 0, text: '整理完成。' }; yield { type: 'finish', reason: { kind: 'stop' } } }
    })
    await runtime.adminDreamingControl(f.namespace, 'start')
    await vi.waitFor(async () => expect(await runtime.adminDreamingStatus(f.namespace)).toMatchObject({ run: { status: 'completed', changedBatches: 1 } }))
    await ctx.agents.get((await runtime.adminDreamingStatus(f.namespace) as any).run.sessionId)!.whenIdle()
    expect(requests).toBe(3)
    expect(aborted).toBe(false)
    expect((await f.reopen()).getMemoryTopic(f.topicId)?.overview.some(entry => entry.text === '保留有来源的经验。')).toBe(true)
  })

  it('allows a bounded host retry and pauses after the host declines further recovery', async () => {
    const f = await fixture(1)
    const runtime = runtimeFor(f.database, async () => { throw new Error('legacy') })
    let requests = 0
    const ctx = await nativeHost(runtime, f.directory, async function* () {
      requests++
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMITED', message: 'fixture error' } } }
    })
    let recoveries = 0
    ctx.on('agent/request-error', async () => ++recoveries === 1 ? { kind: 'retry' } : undefined)
    await runtime.adminDreamingControl(f.namespace, 'start')
    await vi.waitFor(async () => expect(await runtime.adminDreamingStatus(f.namespace)).toMatchObject({ run: { status: 'paused', reason: expect.stringContaining('宿主未能恢复') } }))
    expect(requests).toBe(2)
    expect(recoveries).toBe(2)
  })

  it('allows reasoning and genuine directory arguments larger than the ordinary explanation boundary', async () => {
    const f = await fixture(1)
    const runtime = runtimeFor(f.database, async () => { throw new Error('legacy') })
    let requests = 0
    const ctx = await nativeHost(runtime, f.directory, async function* () {
      requests++
      if (requests === 1) {
        const reasoning = '内部模型数据。'.repeat(1600)
        expect(estimateTokens(reasoning)).toBeGreaterThan(8192)
        yield { type: 'reasoning-delta', index: 0, text: reasoning }
        const entries = Array.from({ length: 4 }, (_, i) => ({ kind: 'experience', text: `经验 ${i}：` + '有来源的说明。'.repeat(100), sourceEventIds: [f.events[0]!.id] }))
        const args = { operations: [{ kind: 'append-overview', title: '开发', entries }] }
        expect(estimateTokens(JSON.stringify(args))).toBeGreaterThan(2048)
        for (const chunk of nativeCall('dreaming_directory', args)) yield chunk.type === 'tool-call-delta' ? { ...chunk, index: 1 } : chunk
      } else if (requests === 2) yield* nativeCall('dreaming_finish', {})
      else { yield { type: 'text-delta', index: 0, text: '已保存并完成。' }; yield { type: 'finish', reason: { kind: 'stop' } } }
    })
    await runtime.adminDreamingControl(f.namespace, 'start')
    await vi.waitFor(async () => expect(await runtime.adminDreamingStatus(f.namespace)).toMatchObject({ run: { status: 'completed', changedBatches: 1 } }))
    await ctx.agents.get((await runtime.adminDreamingStatus(f.namespace) as any).run.sessionId)!.whenIdle()
    expect((await f.reopen()).getMemoryTopic(f.topicId)?.overview).toHaveLength(4)
    expect(requests).toBe(3)
  })

  it('creates a fresh conversation for the next new Dreaming instead of carrying the prior transcript', async () => {
    const f = await fixture(1)
    const runtime = runtimeFor(f.database, async () => { throw new Error('legacy') })
    const counts = new Map<string, number>()
    const ctx = await nativeHost(runtime, f.directory, async function* (options) {
      const id = String(options.sessionId), count = (counts.get(id) ?? 0) + 1
      counts.set(id, count)
      if (count === 1) { directoryTask(options); yield* nativeCall('dreaming_finish', {}) }
      else { yield { type: 'text-delta', index: 0, text: '本轮已完成。' }; yield { type: 'finish', reason: { kind: 'stop' } } }
    })
    await runtime.adminDreamingControl(f.namespace, 'start')
    await vi.waitFor(async () => expect(await runtime.adminDreamingStatus(f.namespace)).toMatchObject({ run: { status: 'completed' } }))
    const first = (await runtime.adminDreamingStatus(f.namespace) as any).run
    await ctx.agents.get(first.sessionId)!.whenIdle()
    const events = ctx.agents.get(first.sessionId)!.session.snapshotEvents()
    await runtime.adminDreamingControl(f.namespace, 'start')
    await vi.waitFor(async () => expect(await runtime.adminDreamingStatus(f.namespace)).toMatchObject({ run: { status: 'completed' } }))
    const second = (await runtime.adminDreamingStatus(f.namespace) as any).run
    await ctx.agents.get(second.sessionId)!.whenIdle()
    expect(second.sessionId).not.toBe(first.sessionId)
    expect(second.id).not.toBe(first.id)
    expect(counts.size).toBe(2)
    expect(ctx.agents.get(first.sessionId)!.session.snapshotEvents()).toEqual(events)
  })

  it('dispatches a large injected batch and keeps usage accounting without a cumulative cap', async () => {
    const f = await fixture(1)
    await seedQuotes(f, '证据'.repeat(4000))
    const runtime = runtimeFor(f.database, async () => { throw new Error('legacy') })
    const stream = vi.fn(async function* () { yield { type: 'text-delta', index: 0, text: '继续思考。' }; yield { type: 'finish', reason: { kind: 'stop' } } })
    await nativeHost(runtime, f.directory, stream)
    await runtime.adminDreamingControl(f.namespace, 'start')
    await vi.waitFor(async () => expect(await runtime.adminDreamingStatus(f.namespace)).toMatchObject({ run: { status: 'paused', completed: 0, calls: 3 } }))
    expect(stream).toHaveBeenCalledTimes(3)
    expect((await runtime.adminDreamingStatus(f.namespace) as any).run.estimatedTokens).toBeGreaterThan(5000)
  })

  it('allows long contiguous Block reads but does not count rereading a page as new progress', async () => {
    const f = await fixture(1, '原始来源'.repeat(4000))
    let run = await f.memory.dreaming({ kind: 'start', owner: 'a' })
    run = await f.memory.dreaming({ kind: 'prepare', ...claim(run) })
    let offset = 0, pages = 0
    for (;;) {
      const action = { tool: 'dreaming_read', args: { kind: 'block', id: f.block.id, level: 5, offset, limit: 1000 } }
      const read = await dreamingTool(f.memory, run, action)
      run = await f.memory.dreaming({ kind: 'checkpoint', ...claim(run), trace: { ...action, result: read.result }, estimatedTokens: 0 })
      expect(run.idleCalls).toBe(0)
      pages++
      const page = read.result as { nextOffset: number | null }
      if (page.nextOffset === null) break
      offset = page.nextOffset
    }
    expect(pages).toBeGreaterThan(12)
    const action = { tool: 'dreaming_read', args: { kind: 'block', id: f.block.id, level: 5 } }
    for (let i = 0; i < 12; i++) {
      const read = await dreamingTool(f.memory, run, action)
      run = await f.memory.dreaming({ kind: 'checkpoint', ...claim(run), trace: { ...action, result: read.result }, estimatedTokens: 0 })
    }
    expect(run).toMatchObject({ status: 'paused', idleCalls: 12 })
  })

  it('reconstructs the same large Event across reordered fields and a SQLite restart', async () => {
    const f = await fixture(1)
    await seedQuotes(f, '分页证据'.repeat(6000))
    const event = f.memory.listAllEvents()[0]!
    const reordered = Object.fromEntries(Object.entries(event).reverse()) as typeof event
    reordered.temporal = Object.fromEntries(Object.entries(event.temporal).reverse()) as typeof event.temporal
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(event))
    expect(dreamingEventContent(reordered)).toBe(dreamingEventContent(event))
    expect(dreamingEventContentVersion(reordered)).toBe(dreamingEventContentVersion(event))
    let memory = f.memory
    let run = await memory.dreaming({ kind: 'start', owner: 'a' })
    run = await memory.dreaming({ kind: 'prepare', ...claim(run) })
    let offset = 0, stitched = ''
    for (;;) {
      const action = { tool: 'dreaming_read', args: { kind: 'event', id: event.id, offset, limit: 1000 } }
      const read = await dreamingTool(memory, run, action)
      const page = read.result as { content: string; nextOffset: number | null }
      stitched += page.content
      run = await memory.dreaming({ kind: 'checkpoint', ...claim(run), trace: { ...action, result: read.result }, estimatedTokens: 0 })
      expect(run.idleCalls).toBe(0)
      if (offset === 0) { await memory.close(); memory = await f.reopen(); run = await memory.dreaming({ kind: 'prepare', ...claim(run) }) }
      if (page.nextOffset === null) break
      offset = page.nextOffset
    }
    expect(stitched).toBe(dreamingEventContent(event))
    expect(run.trace).toHaveLength(12)
    expect((await memory.dreaming({ kind: 'finish-unit', ...claim(run) })).status).toBe('completed')
  })

  it.each(['legacy-offset', 'content-changed'] as const)('restarts partial coverage when a %s checkpoint cannot identify the same content', async mode => {
    const f = await fixture(1)
    await seedQuotes(f, '来源'.repeat(10_000))
    let run = await f.memory.dreaming({ kind: 'start', owner: 'a' })
    run = await f.memory.dreaming({ kind: 'prepare', ...claim(run) })
    const action = { tool: 'dreaming_read', args: { kind: 'event', id: f.events[0]!.id } }
    const read = await dreamingTool(f.memory, run, action)
    run = await f.memory.dreaming({ kind: 'checkpoint', ...claim(run), trace: { ...action, result: read.result }, estimatedTokens: 0 })
    const snapshot = f.memory.exportSnapshot()
    if (mode === 'legacy-offset') delete snapshot.memoryTopicState!.dreaming!.readContentVersions
    else snapshot.events[0]!.updatedAt = '2026-10-14T12:00:00.000+08:00' // bookkeeping changes without changing semantic fingerprint
    const { SqliteStorage } = await import('@diqier/stratagate/sqlite')
    const db = new SqliteStorage({ filename: f.database })
    try { await db.save(f.namespace, snapshot, f.memory.storageRevision) } finally { db.close() }
    await f.memory.reloadFromStorage()
    run = await f.memory.dreaming({ kind: 'prepare', ...claim(run) })
    expect(run.readOffsets[f.events[0]!.id]).toBe(0)
    expect(run.evidenceVersions).not.toHaveProperty(f.events[0]!.id)
    const payload = dreamingPayload(f.memory, run) as any
    expect(payload.events[0]).toMatchObject({ needsFullRead: true, nextReadOffset: 0, readComplete: false })
    await expect(f.memory.dreaming({ kind: 'finish-unit', ...claim(run) })).rejects.toThrow('Read all')
  })

  it('rejects finishing unread or partially read large Events, including a forged last page', async () => {
    const f = await fixture(1)
    await seedQuotes(f, '证据'.repeat(15_000))
    let run = await f.memory.dreaming({ kind: 'start', owner: 'a' })
    run = await f.memory.dreaming({ kind: 'prepare', ...claim(run) })
    await expect(f.memory.dreaming({ kind: 'finish-unit', ...claim(run) })).rejects.toThrow('Read all')
    run = await f.memory.dreaming({ kind: 'checkpoint', ...claim(run), evidenceIds: [f.events[0]!.id], estimatedTokens: 0,
      trace: { tool: 'dreaming_read', args: { kind: 'event', id: f.events[0]!.id }, result: { id: f.events[0]!.id, offset: 0, nextOffset: null } } })
    expect(run.evidenceVersions).not.toHaveProperty(f.events[0]!.id)
    let offset = 0
    for (;;) {
      const action = { tool: 'dreaming_read', args: { kind: 'event', id: f.events[0]!.id, offset } }
      const read = await dreamingTool(f.memory, run, action)
      const page = read.result as { nextOffset: number | null }
      run = await f.memory.dreaming({ kind: 'checkpoint', ...claim(run), trace: { ...action, result: read.result }, estimatedTokens: 0 })
      if (page.nextOffset === null) break
      await expect(f.memory.dreaming({ kind: 'finish-unit', ...claim(run) })).rejects.toThrow('Read all')
      offset = page.nextOffset
    }
    expect((await f.memory.dreaming({ kind: 'finish-unit', ...claim(run) })).status).toBe('completed')
  })

  it('can create an intended but not-yet-materialized session after an interrupted first startup', async () => {
    const f = await fixture()
    const runtime = runtimeFor(f.database, async () => { throw new Error('legacy') })
    const run = await f.memory.dreaming({ kind: 'start', owner: 'old-host' })
    await f.memory.dreaming({ kind: 'bind-session', ...claim(run), sessionId: `stratagate-dreaming:${run.id}` })
    await f.memory.dreaming({ kind: 'suspend', ...claim(run), reason: 'interrupted before native create' })
    let calls = 0
    await nativeHost(runtime, f.directory, async function* () {
      if (++calls === 1) yield* nativeCall('dreaming_finish', {})
      else { yield { type: 'text-delta', index: 0, text: '完成。' }; yield { type: 'finish', reason: { kind: 'stop' } } }
    })
    await runtime.adminDreamingControl(f.namespace, 'resume', run.id)
    await vi.waitFor(async () => expect(await runtime.adminDreamingStatus(f.namespace)).toMatchObject({ run: { status: 'completed', sessionId: `stratagate-dreaming:${run.id}` } }))
  })

  it('reports missing host Agent capability as paused without falling back to an ordinary chat', async () => {
    const f = await fixture()
    const runtime = runtimeFor(f.database, async () => { throw new Error('legacy') })
    const ctx = new Context()
    cleanups.push(async () => { await ctx.fiber.dispose() })
    runtime.setDreamingHost(new DshDreamingSessions(ctx, runtime, () => ({ provider: 'fixture', model: 'fixture', maxTokens: 32768 })))
    await runtime.adminDreamingControl(f.namespace, 'start')
    await vi.waitFor(async () => expect(await runtime.adminDreamingStatus(f.namespace)).toMatchObject({ run: { status: 'paused', reason: expect.stringContaining('专属 Agent 会话接口') } }))
  })
  it('persists the real native conversation, preserves user directions, and resumes after host shutdown', async () => {
    const f = await fixture()
    const runtime = runtimeFor(f.database, async () => { throw new Error('legacy') })
    let calls = 0, entered = false
    const ctx = await nativeHost(runtime, f.directory, async function* (options) {
      if (++calls === 1) { yield* nativeCall('dreaming_directory', { operations: [{ kind: 'rename-section', from: '开发', title: '协作' }] }); return }
      entered = true
      await new Promise<void>(resolve => options.signal.addEventListener('abort', () => resolve(), { once: true }))
      yield { type: 'finish', reason: { kind: 'aborted' } }
    })
    await runtime.adminDreamingControl(f.namespace, 'start')
    await vi.waitFor(() => expect(entered).toBe(true))
    const status = await runtime.adminDreamingStatus(f.namespace) as any
    const agent = ctx.agents.get(status.run.sessionId)!
    agent.steer(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '只整理协作相关内容。' }] }))
    await runtime.close(); await ctx.fiber.dispose()
    await f.memory.reloadFromStorage()
    expect(f.memory.getMemoryTopic(f.topicId)?.sections?.[0]?.title).toBe('协作')
    expect(f.memory.exportSnapshot().memoryTopicState?.dreaming?.status).toBe('paused')
    const next = runtimeFor(f.database, async () => { throw new Error('legacy') })
    const requests: any[] = []
    const nextCtx = await nativeHost(next, f.directory, async function* (options) {
      requests.push(options)
      if (requests.length === 1) yield* nativeCall('dreaming_finish', { summary: '协作整理完成' })
      else { yield { type: 'text-delta', index: 0, text: '已完成。' }; yield { type: 'finish', reason: { kind: 'stop' } } }
    })
    await next.adminDreamingControl(f.namespace, 'resume', status.run.id)
    await vi.waitFor(async () => expect(await next.adminDreamingStatus(f.namespace)).toMatchObject({ run: { status: 'completed', sessionId: status.run.sessionId } }), { timeout: 4000 })
    expect(JSON.stringify(requests[0].messages)).toContain('只整理协作相关内容')
    expect(nextCtx.agents.get(status.run.sessionId)).toBeDefined()
  })

  it('pauses a native step safely, resumes, then aborts an active native request on termination', async () => {
    const f = await fixture()
    const runtime = runtimeFor(f.database, async () => { throw new Error('legacy') })
    let entered = false, release!: () => void, aborted = false
    await nativeHost(runtime, f.directory, async function* (options) {
      entered = true
      await new Promise<void>(resolve => { release = resolve; options.signal.addEventListener('abort', () => { aborted = true; resolve() }, { once: true }) })
      if (!options.signal.aborted) yield* nativeCall('dreaming_directory', { operations: [{ kind: 'rename-chapter', title: '迟到改名' }] })
      else yield { type: 'finish', reason: { kind: 'aborted' } }
    })
    await runtime.adminDreamingControl(f.namespace, 'start')
    await vi.waitFor(() => expect(entered).toBe(true))
    const status = await runtime.adminDreamingStatus(f.namespace) as any
    await runtime.adminDreamingControl(f.namespace, 'pause', status.run.id)
    release()
    await vi.waitFor(async () => expect(await runtime.adminDreamingStatus(f.namespace)).toMatchObject({ run: { status: 'paused', completed: 0 } }))
    await f.memory.reloadFromStorage()
    expect(f.memory.getMemoryTopic(f.topicId)?.title).toBe('项目')
    entered = false
    await runtime.adminDreamingControl(f.namespace, 'resume', status.run.id)
    await vi.waitFor(() => expect(entered).toBe(true))
    await runtime.adminDreamingControl(f.namespace, 'terminate', status.run.id)
    await vi.waitFor(() => expect(aborted).toBe(true))
    await f.memory.reloadFromStorage()
    expect(f.memory.getMemoryTopic(f.topicId)?.title).toBe('项目')
    expect(f.memory.exportSnapshot().memoryTopicState?.dreaming?.status).toBe('terminated')
  })
  it('runs scoped native DSH tools in a real session, completes pages, and fences ordinary tools', async () => {
    const f = await fixture(26)
    const ctx = new Context()
    cleanups.push(async () => { await ctx.fiber.dispose() })
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime, { mode: 'native' })
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjections)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 })
    const ordinary = vi.fn(async () => 'must not run')
    ctx.tools.register(defineTool({ name: 'shell', description: 'unrelated host tool', parameters: {}, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: ordinary }))
    const requests: any[] = [], events: any[] = []
    ctx.on('session/event', (_session, event) => { events.push(event) })
    ctx.on('llm/stream', async function* (options) {
      requests.push(options)
      const call = requests.length
      if (call === 1) {
        yield* nativeCall('shell', {}, 'denied-call')
      } else if (call <= 3) {
        yield { type: 'tool-call-delta', index: 0, id: `call-${call}`, name: 'dreaming_finish', argumentsDelta: '{"summary":"本批无需修改"}' } as any
        yield { type: 'finish', reason: { kind: 'tool-calls' } } as any
      } else {
        yield { type: 'text-delta', index: 0, text: '目录整理完成。' } as any
        yield { type: 'finish', reason: { kind: 'stop' } } as any
      }
    })
    const runtime = runtimeFor(f.database, async () => { throw new Error('legacy loop must not run') })
    runtime.setDreamingHost(new DshDreamingSessions(ctx, runtime, () => ({ provider: 'fixture', model: 'fixture', maxTokens: 32768 })))
    cleanups.push(async () => { await runtime.close() })
    await runtime.adminDreamingControl(f.namespace, 'start')
    await vi.waitFor(async () => expect(await runtime.adminDreamingStatus(f.namespace)).toMatchObject({ run: { status: 'completed', completed: 2 } }), { timeout: 4000 })
    await vi.waitFor(() => expect(requests).toHaveLength(4))
    const status = await runtime.adminDreamingStatus(f.namespace) as any
    expect(status.run.sessionId).toMatch(/^stratagate-dreaming:/)
    expect(await runtime.adminDreamingSession(f.namespace, status.run.id)).toEqual({ sessionId: status.run.sessionId })
    expect(requests.every(request => request.tools.every((tool: any) => tool.name !== 'shell'))).toBe(true)
    expect(events.filter(event => event.type === 'tool/result')).toHaveLength(3)
    expect(JSON.stringify(events.filter(event => event.type === 'tool/result')[0])).toMatch(/denied|授权|restricted|not available|not found|unknown|不存在/i)
    expect(ordinary).not.toHaveBeenCalled()
    expect(runtime.isDreamingSession(ctx.agents.get(status.run.sessionId)!.session)).toBe(true)
  })
  it('reuses search/read without changing retrieval weight or Block decay state', async () => {
    const f = await fixture()
    const run = await f.memory.dreaming({ kind: 'start', owner: 'a' })
    const before = f.memory.exportSnapshot()
    const search = await dreamingTool(f.memory, run, { tool: 'dreaming_search', args: { kind: 'events', query: '目录' } })
    expect(search.result).not.toHaveProperty('batchId')
    const read = await dreamingTool(f.memory, run, { tool: 'dreaming_read', args: { kind: 'block', id: f.block.id, level: 5 } })
    expect(read.result).toMatchObject({ id: f.block.id })
    expect(f.memory.exportSnapshot()).toEqual(before)
  })

  it('commits a sourced experience and keeps all original Events unchanged after reopen', async () => {
    const f = await fixture()
    let run = await f.memory.dreaming({ kind: 'start', owner: 'a' })
    run = await f.memory.dreaming({ kind: 'prepare', ...claim(run) })
    const before = structuredClone(f.memory.listAllEvents())
    const oldKey = memoryTopicSectionNavigation(f.memory.getMemoryTopic(f.topicId)!)[0]!.key
    await f.memory.dreaming({ kind: 'apply', ...claim(run), operations: [
      { kind: 'rename-section', from: '开发', title: '协作方式' },
      { kind: 'set-overview', title: '协作方式', entries: [{ kind: 'experience', text: '整理目录时保留可追溯来源。', sourceEventIds: f.events.map(event => event.id) }] },
    ] })
    const reopened = await f.reopen()
    expect(reopened.getMemoryTopic(f.topicId)?.overview[0]).toMatchObject({ kind: 'experience', title: '协作方式' })
    expect(reopened.listAllEvents()).toEqual(before)
    expect(reopened.exportSnapshot().memoryTopicState?.dreaming?.changedBatches).toBe(1)
    expect(memoryTopicSectionNavigation(reopened.getMemoryTopic(f.topicId)!)[0]!.key).toBe(oldKey)
  })

  it('rejects a whole batch atomically when one operation uses unknown sources', async () => {
    const f = await fixture()
    let run = await f.memory.dreaming({ kind: 'start', owner: 'a' })
    run = await f.memory.dreaming({ kind: 'prepare', ...claim(run) })
    const before = f.memory.getMemoryTopic(f.topicId)
    await expect(f.memory.dreaming({ kind: 'apply', ...claim(run), operations: [
      { kind: 'rename-chapter', title: '不应保存' },
      { kind: 'move-events', eventIds: ['fabricated'], title: '新小节' },
    ] })).rejects.toThrow('current batch')
    expect(f.memory.getMemoryTopic(f.topicId)).toEqual(before)
  })

  it('rejects no-op edits and title cycles instead of counting them as progress', async () => {
    const f = await fixture()
    let run = await f.memory.dreaming({ kind: 'start', owner: 'a' })
    run = await f.memory.dreaming({ kind: 'prepare', ...claim(run) })
    await expect(f.memory.dreaming({ kind: 'apply', ...claim(run), operations: [{ kind: 'rename-chapter', title: '项目' }] })).rejects.toThrow('previous state')
    await f.memory.dreaming({ kind: 'apply', ...claim(run), operations: [{ kind: 'rename-chapter', title: '项目开发' }] })
    await expect(f.memory.dreaming({ kind: 'apply', ...claim(run), operations: [{ kind: 'rename-chapter', title: '项目' }] })).rejects.toThrow('previous state')
    expect(f.memory.getMemoryTopic(f.topicId)?.title).toBe('项目开发')
  })

  it('pauses a persisted batch after 64 successful writes and resets its window on resume and next batch', async () => {
    const f = await fixture(25)
    let memory = f.memory
    let run = await memory.dreaming({ kind: 'start', owner: 'a' })
    run = await memory.dreaming({ kind: 'prepare', ...claim(run) })
    for (let i = 1; i <= DREAMING_BATCH_WRITE_LIMIT; i++) {
      run = await memory.dreaming({ kind: 'apply', ...claim(run), operations: [{ kind: 'rename-chapter', title: `成功改名 ${i}` }] })
      expect(run.status).toBe(i === DREAMING_BATCH_WRITE_LIMIT ? 'pausing' : 'running')
      run = await memory.dreaming({ kind: 'checkpoint', ...claim(run), trace: { tool: 'dreaming_directory', args: {}, result: { saved: true } }, estimatedTokens: 0 })
    }
    expect(run).toMatchObject({ status: 'paused', cursor: 0, changedBatches: 64 })
    expect(run.reason).toContain('64')
    await expect(memory.dreaming({ kind: 'apply', ...claim(run), operations: [{ kind: 'rename-chapter', title: '越过边界' }] })).rejects.toThrow('claim changed')
    await memory.close(); memory = await f.reopen()
    expect(memory.getMemoryTopic(f.topicId)?.title).toBe('成功改名 64')
    expect(memory.exportSnapshot().memoryTopicState?.dreaming?.status).toBe('paused')
    run = await memory.dreaming({ kind: 'resume', id: run.id, owner: 'b' })
    expect(run.batchWriteStart).toBe(64)
    run = await memory.dreaming({ kind: 'apply', ...claim(run), operations: [{ kind: 'rename-chapter', title: '用户继续后的改名' }] })
    expect(run).toMatchObject({ status: 'running', changedBatches: 65 })
    run = await memory.dreaming({ kind: 'finish-unit', ...claim(run) })
    run = await memory.dreaming({ kind: 'prepare', ...claim(run) })
    expect(run).toMatchObject({ status: 'running', cursor: 1, batchWriteStart: 65 })
    run = await memory.dreaming({ kind: 'apply', ...claim(run), operations: [{ kind: 'rename-chapter', title: '下一批改名' }] })
    expect(run).toMatchObject({ status: 'running', changedBatches: 66 })
    expect((await memory.dreaming({ kind: 'finish-unit', ...claim(run) })).status).toBe('completed')
  })

  it('reports the boundary write as saved and stops native model calls until explicit resume', async () => {
    const f = await fixture(1)
    const runtime = runtimeFor(f.database, async () => { throw new Error('legacy') })
    let dispatched = 0
    const ctx = await nativeHost(runtime, f.directory, async function* () {
      yield* nativeCall('dreaming_directory', { operations: [{ kind: 'rename-chapter', title: `目录版本 ${++dispatched}` }] }, `write-${dispatched}`)
    })
    const results: any[] = []
    ctx.on('session/event', (_session, event) => { if (event.type === 'tool/result') results.push(event.data) })
    await runtime.adminDreamingControl(f.namespace, 'start')
    await vi.waitFor(async () => expect(await runtime.adminDreamingStatus(f.namespace)).toMatchObject({ run: { status: 'paused', changedBatches: 64, calls: 64 } }), { timeout: 15000 })
    await ctx.agents.get((await runtime.adminDreamingStatus(f.namespace) as any).run.sessionId)!.whenIdle()
    expect(dispatched).toBe(DREAMING_BATCH_WRITE_LIMIT)
    const last = results.at(-1).message
    expect(last.isError).not.toBe(true)
    expect(JSON.parse(last.content.find((block: any) => block.type === 'text').text)).toEqual({ saved: true, changedBatches: 64 })
    expect((await f.reopen()).getMemoryTopic(f.topicId)?.title).toBe('目录版本 64')
  }, 20_000)

  it('preserves merged section aliases and sourced experience through subsequent ordinary projection', async () => {
    const f = await fixture()
    let run = await f.memory.dreaming({ kind: 'start', owner: 'a' })
    run = await f.memory.dreaming({ kind: 'prepare', ...claim(run) })
    const oldKey = memoryTopicSectionNavigation(f.memory.getMemoryTopic(f.topicId)!)[0]!.key
    await f.memory.dreaming({ kind: 'apply', ...claim(run), operations: [{ kind: 'move-events', eventIds: [f.events[1]!.id], title: '约定' }] })
    const secondKey = memoryTopicSectionNavigation(f.memory.getMemoryTopic(f.topicId)!).find(section => section.title === '约定')!.key
    await f.memory.dreaming({ kind: 'apply', ...claim(run), operations: [
      { kind: 'merge-sections', from: ['开发', '约定'], title: '协作' },
      { kind: 'set-overview', title: '协作', entries: [{ kind: 'experience', text: '目录整理保留来源。', sourceEventIds: f.events.map(event => event.id) }] },
    ] })
    const merged = f.memory.getMemoryTopic(f.topicId)!
    expect(merged.sectionAliases?.[secondKey]).toBe(oldKey)
    await f.memory.dreaming({ kind: 'finish-unit', ...claim(run) })
    const extra = await f.memory.addEvent({ title: '新增协作', summary: '用户确认继续保留来源。', sourceBlockId: f.block.id, sourceMessageIds: [f.block.l5Raw[0]!.id] })
    const job = (await f.memory.claimNextTopicProjection())!
    await f.memory.completeTopicProjection(job.jobId, { topics: [{ topicId: f.topicId, title: '项目', description: '项目资料', sourceEventIds: [extra.id], sections: [{ title: '协作', sourceEventIds: [extra.id] }], overview: [] }] })
    const after = f.memory.getMemoryTopic(f.topicId)!
    expect(after.overview[0]).toMatchObject({ kind: 'experience', text: '目录整理保留来源。' })
    expect(after.sectionAliases).toEqual(merged.sectionAliases)
    expect(memoryTopicSectionNavigation(after)[0]!.key).toBe(oldKey)
  })

  it('pauses at a checkpoint, resumes with a new epoch and rejects stale writes', async () => {
    const f = await fixture()
    let run = await f.memory.dreaming({ kind: 'start', owner: 'a' })
    run = await f.memory.dreaming({ kind: 'prepare', ...claim(run) })
    await f.memory.dreaming({ kind: 'pause', id: run.id })
    const paused = await f.memory.dreaming({ kind: 'checkpoint', ...claim(run), trace: { tool: 'dreaming_read', args: {}, result: {} }, estimatedTokens: 10 })
    expect(paused.status).toBe('paused')
    expect(paused.trace).toHaveLength(1)
    const next = await f.memory.dreaming({ kind: 'resume', id: run.id, owner: 'b' })
    expect(next.epoch).toBeGreaterThan(run.epoch)
    await expect(f.memory.dreaming({ kind: 'apply', ...claim(run), operations: [{ kind: 'rename-chapter', title: '旧结果' }] })).rejects.toThrow('claim changed')
  })

  it('termination fences another SQLite connection and preserves completed changes', async () => {
    const f = await fixture()
    let run = await f.memory.dreaming({ kind: 'start', owner: 'a' })
    run = await f.memory.dreaming({ kind: 'prepare', ...claim(run) })
    await f.memory.dreaming({ kind: 'apply', ...claim(run), operations: [{ kind: 'rename-chapter', title: '已完成修改' }] })
    const other = await f.reopen()
    await other.dreaming({ kind: 'terminate', id: run.id })
    await f.memory.reloadFromStorage()
    await expect(f.memory.dreaming({ kind: 'apply', ...claim(run), operations: [{ kind: 'rename-chapter', title: '迟到结果' }] })).rejects.toThrow('claim changed')
    expect(f.memory.getMemoryTopic(f.topicId)?.title).toBe('已完成修改')
  })

  it('detects a concurrent directory edit and does not overwrite it', async () => {
    const f = await fixture()
    let run = await f.memory.dreaming({ kind: 'start', owner: 'a' })
    run = await f.memory.dreaming({ kind: 'prepare', ...claim(run) })
    const other = await f.reopen()
    // A native projection modifies the same chapter while Dreaming is outside a transaction.
    const storage = other.exportSnapshot()
    storage.memoryTopicState!.topics[0]!.title = '并发改名'
    const { SqliteStorage } = await import('@diqier/stratagate/sqlite')
    const db = new SqliteStorage({ filename: f.database })
    try { await db.save(f.namespace, storage, other.storageRevision) } finally { db.close() }
    await f.memory.reloadFromStorage()
    await expect(f.memory.dreaming({ kind: 'apply', ...claim(run), operations: [{ kind: 'rename-chapter', title: '覆盖' }] })).rejects.toThrow('Directory changed')
    expect(f.memory.getMemoryTopic(f.topicId)?.title).toBe('并发改名')
  })

  it('splits growing history into context pages without a total model-call allowance', async () => {
    const f = await fixture(55)
    const run = await f.memory.dreaming({ kind: 'start', owner: 'a' })
    expect(run.units.length).toBeGreaterThan(2)
    expect(run.units.flatMap(unit => unit.eventIds)).toHaveLength(55)
    expect(run.tokenLimit).toBeNull()
    expect(dreamingPayload(f.memory, run)).toHaveProperty('totalBatches', run.units.length)
  })

  it('protects existing overview evidence from an empty or incomplete replacement', async () => {
    const f = await fixture()
    let run = await f.memory.dreaming({ kind: 'start', owner: 'a' })
    run = await f.memory.dreaming({ kind: 'prepare', ...claim(run) })
    await f.memory.dreaming({ kind: 'apply', ...claim(run), operations: [{ kind: 'set-overview', title: '开发', entries: [{ kind: 'history', text: '目录保留来源。', sourceEventIds: f.events.map(event => event.id) }] }] })
    await expect(f.memory.dreaming({ kind: 'apply', ...claim(run), operations: [{ kind: 'set-overview', title: '开发', entries: [] }] })).rejects.toThrow('preserve existing overview evidence')
    expect(f.memory.getMemoryTopic(f.topicId)?.overview).toHaveLength(1)
    await f.memory.dreaming({ kind: 'apply', ...claim(run), operations: [{ kind: 'append-overview', title: '开发', entries: [{ kind: 'experience', text: '可以分批补充有来源的新经验。', sourceEventIds: [f.events[0]!.id] }] }] })
    expect(f.memory.getMemoryTopic(f.topicId)?.overview).toHaveLength(2)
    expect(f.memory.getMemoryTopic(f.topicId)?.overview[0]?.kind).toBe('history')
  })

  it('accepts a large source only after contiguous read pages and persists that checkpoint', async () => {
    const f = await fixture(1)
    const { SqliteStorage } = await import('@diqier/stratagate/sqlite')
    const db = new SqliteStorage({ filename: f.database })
    const snapshot = f.memory.exportSnapshot()
    snapshot.events[0]!.quotes = ['证据'.repeat(15_000)]
    // Changing the source invalidates derived language; seed a current valid directory for the page test.
    const { memoryTopicEventFingerprint } = await import('@diqier/stratagate')
    const fingerprint = memoryTopicEventFingerprint(snapshot.events[0]!)
    snapshot.memoryTopicState!.topics[0]!.sourceVersions[snapshot.events[0]!.id] = fingerprint
    snapshot.memoryTopicState!.topics[0]!.dependencyVersions![snapshot.events[0]!.id] = fingerprint
    snapshot.memoryTopicState!.projectedVersions[snapshot.events[0]!.id] = fingerprint
    try { await db.save(f.namespace, snapshot, f.memory.storageRevision) } finally { db.close() }
    await f.memory.reloadFromStorage()
    let run = await f.memory.dreaming({ kind: 'start', owner: 'a' })
    run = await f.memory.dreaming({ kind: 'prepare', ...claim(run) })
    expect(run.evidenceVersions).not.toHaveProperty(f.events[0]!.id)
    let offset = 0
    for (;;) {
      const action = { tool: 'dreaming_read', args: { kind: 'event', id: f.events[0]!.id, offset } }
      const read = await dreamingTool(f.memory, run, action)
      const result = read.result as { nextOffset: number | null }
      run = await f.memory.dreaming({ kind: 'checkpoint', ...claim(run), trace: { ...action, result: read.result }, estimatedTokens: 100 })
      if (result.nextOffset === null) break
      offset = result.nextOffset
    }
    expect(run.evidenceVersions[f.events[0]!.id]).toBe(fingerprint)
    expect((await f.reopen()).exportSnapshot().memoryTopicState?.dreaming?.readOffsets[f.events[0]!.id]).toBe(-1)
  })
})

function runtimeFor(database: string, step: (payload: any) => Promise<any>, abortable = false) {
  const models = { isReady: () => false, onAdaptersUpdated: () => () => {}, dreamingStep: step,
    runDetached: (_id: string, operation: () => Promise<unknown>, signal?: AbortSignal) => abortable
      ? Promise.race([operation(), new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(new Error('Interrupted')), { once: true }))]) : operation() } as unknown as DshModelBridge
  const runtime = new StrataGateRuntime({ database, namespaceMode: 'project', namespacePrefix: 'dsh', globalNamespace: 'global', blockTurnSize: 1,
    blockDecayLambda: .3, ingestSubagents: false, maxOutputTokens: 2048 }, models)
  cleanups.push(() => runtime.close())
  return runtime
}

describe('Dreaming Agent orchestration and admin API', () => {
  it.each(['native', 'detached'] as const)('starts the %s runner while the first chapter is still being projected', async mode => {
    const f = await fixture(0)
    const { job, event } = await pendingProjection(f)
    const step = vi.fn(async () => ({ tool: 'finish', args: {} }))
    const hostCalls = vi.fn()
    const runtime = runtimeFor(f.database, step)
    if (mode === 'native') await nativeHost(runtime, f.directory, async function* () {
      hostCalls()
      if (hostCalls.mock.calls.length === 1) yield* nativeCall('dreaming_finish', {})
      else { yield { type: 'text-delta', index: 0, text: '完成。' }; yield { type: 'finish', reason: { kind: 'stop' } } }
    })
    expect(await runtime.adminDreamingControl(f.namespace, 'start')).toMatchObject({ run: {
      status: 'running', waitingForProjection: true, total: 0, calls: 0 } })
    expect(step).not.toHaveBeenCalled(); expect(hostCalls).not.toHaveBeenCalled()
    const other = await f.reopen()
    await other.completeTopicProjection(job.jobId, { topics: [{ title: '首次章节', description: '等待后生成', sourceEventIds: [event.id], overview: [] }] })
    await vi.waitFor(async () => expect(await runtime.adminDreamingStatus(f.namespace)).toMatchObject({ run: {
      status: 'completed', total: 1, completed: 1, waitingForProjection: false } }), { timeout: 4000 })
    expect(mode === 'native' ? hostCalls : step).toHaveBeenCalled()
  })
  it.each(['native', 'detached'] as const)('drains a preclaimed projection before the %s runner spends a model call and plans the resulting chapters', async mode => {
    const f = await fixture(1)
    const { job, event } = await pendingProjection(f)
    const step = vi.fn(async () => ({ tool: 'finish', args: {} }))
    const runtime = runtimeFor(f.database, step)
    const hostCalls = vi.fn()
    if (mode === 'native') await nativeHost(runtime, f.directory, async function* (options) {
      hostCalls()
      if (hostCalls.mock.calls.length <= 2) {
        const task = directoryTask(options)
        expect(task.totalBatches).toBe(2)
        yield* nativeCall('dreaming_finish', {})
      } else { yield { type: 'text-delta', index: 0, text: '完成。' }; yield { type: 'finish', reason: { kind: 'stop' } } }
    })
    await runtime.adminDreamingControl(f.namespace, 'start')
    await vi.waitFor(async () => expect(await runtime.adminDreamingStatus(f.namespace)).toMatchObject({ run: {
      status: 'running', waitingForProjection: true, calls: 0, activity: expect.stringContaining('等待当前后台目录整理') } }))
    expect(step).not.toHaveBeenCalled()
    expect(hostCalls).not.toHaveBeenCalled()
    const other = await f.reopen()
    expect(other.hasPendingTopicWork()).toBe(false)
    expect(await other.claimNextTopicProjection()).toBeNull()
    await (runtime as any).retryTopicWrite(f.namespace, other, () => other.completeTopicProjection(job.jobId, { topics: [{ title: '投影新增章节', description: '等待期间由既有投影生成',
      sourceEventIds: [event.id], sections: [{ title: '新小节', sourceEventIds: [event.id] }], overview: [] }] }))
    await vi.waitFor(async () => expect(await runtime.adminDreamingStatus(f.namespace)).toMatchObject({ run: {
      status: 'completed', waitingForProjection: false, completed: 2, total: 2 } }), { timeout: 4000 })
    const saved = (await f.reopen()).exportSnapshot().memoryTopicState!.dreaming!
    expect(saved.units.flatMap(unit => unit.eventIds)).toContain(event.id)
    expect(mode === 'native' ? hostCalls : step).toHaveBeenCalled()
  })

  it('lets a user pause and terminate while waiting without issuing a model request', async () => {
    const f = await fixture(1)
    const { job, event } = await pendingProjection(f)
    const step = vi.fn(async () => ({ tool: 'finish', args: {} }))
    const runtime = runtimeFor(f.database, step)
    const started = await runtime.adminDreamingControl(f.namespace, 'start') as any
    await runtime.adminDreamingControl(f.namespace, 'pause', started.run.id)
    await vi.waitFor(async () => expect(await runtime.adminDreamingStatus(f.namespace)).toMatchObject({ run: { status: 'paused', calls: 0 } }))
    const other = await f.reopen()
    await other.completeTopicProjection(job.jobId, { topics: [{ title: '收尾章节', description: '暂停仍允许既有投影收尾',
      sourceEventIds: [event.id], sections: [{ title: '新小节', sourceEventIds: [event.id] }], overview: [] }] })
    expect(await other.claimNextTopicProjection()).toBeNull()
    await runtime.adminDreamingControl(f.namespace, 'terminate', started.run.id)
    expect(step).not.toHaveBeenCalled()
    expect(await runtime.adminDreamingStatus(f.namespace)).toMatchObject({ run: { status: 'terminated' } })
  })

  it.each(['finish', 'terminate'] as const)('reserves only the selected namespace across connections and pause, and releases it on %s', async end => {
    const f = await fixture(1)
    let run = await f.memory.dreaming({ kind: 'start', owner: 'a' })
    run = await f.memory.dreaming({ kind: 'prepare', ...claim(run) })
    const other = await f.reopen()
    await other.addEvent({ title: '之后的投影待办', summary: '不能抢占 Dreaming 的目录', sourceBlockId: f.block.id, sourceMessageIds: [f.block.l5Raw[0]!.id] })
    expect(other.hasPendingTopicWork()).toBe(false)
    expect(await other.claimNextTopicProjection()).toBeNull()
    await f.memory.reloadFromStorage()
    await f.memory.dreaming({ kind: 'suspend', ...claim(run), reason: '用户暂停' })
    const cold = await f.reopen()
    expect(cold.hasPendingTopicWork()).toBe(false)
    expect(await cold.claimNextTopicProjection()).toBeNull()
    const different = await StrataGate.open({ database: f.database, namespace: 'independent-namespace', blockTurnSize: 1, disableElementProjection: true,
      summarizer: async () => ({ l0Title: '独立空间', l0Tags: [], l1Summary: '独立空间', l2Keypoints: [], shouldExtract: false }) })
    try {
      await different.appendTurn({ user: '另一个空间', assistant: '记录' })
      const block = different.listBlocks()[0]!
      await different.addEvent({ title: '其他空间待办', summary: '不被这个 Dreaming 阻挡', sourceBlockId: block.id, sourceMessageIds: [block.l5Raw[0]!.id] })
      expect(await different.claimNextTopicProjection()).not.toBeNull()
    } finally { await different.close() }
    await f.memory.reloadFromStorage()
    if (end === 'finish') {
      run = await f.memory.dreaming({ kind: 'resume', id: run.id, owner: 'a' })
      await f.memory.dreaming({ kind: 'finish-unit', ...claim(run) })
    } else await f.memory.dreaming({ kind: 'terminate', id: run.id })
    await cold.reloadFromStorage()
    expect(cold.hasPendingTopicWork()).toBe(true)
    expect(await cold.claimNextTopicProjection()).not.toBeNull()
  })

  it('finishes waiting after a projection lease expires and rejects its late result without overwriting Dreaming', async () => {
    let now = Date.now()
    const f = await fixture(1, undefined, undefined, () => new Date(now))
    const { job, event } = await pendingProjection(f)
    let run = await f.memory.dreaming({ kind: 'start', owner: 'a' })
    expect(run.waitingForProjection).toBe(true)
    // Advance the fixture clock while renewing only Dreaming, as if the
    // projection's owning process crashed and stopped renewing its own lease.
    for (let minute = 0; minute < 6; minute++) {
      now += 60_000
      await f.memory.dreaming({ kind: 'heartbeat', ...claim(run) })
    }
    run = await f.memory.dreaming({ kind: 'prepare', ...claim(run) })
    expect(run.waitingForProjection).not.toBe(true)
    await f.memory.dreaming({ kind: 'apply', ...claim(run), operations: [{ kind: 'rename-chapter', title: 'Dreaming 已整理' }] })
    await expect(f.memory.completeTopicProjection(job.jobId, { topics: [{ title: '过期投影', description: '迟到结果',
      sourceEventIds: [event.id], overview: [] }] })).rejects.toThrow('source-changed')
    expect(f.memory.getMemoryTopic(f.topicId)?.title).toBe('Dreaming 已整理')
    await f.memory.dreaming({ kind: 'finish-unit', ...claim(run) })
    expect(await f.memory.claimNextTopicProjection()).not.toBeNull()
  })

  it('resumes waiting after a host restart and handles a failed draining projection without spending Dreaming calls early', async () => {
    const f = await fixture(1)
    const { job } = await pendingProjection(f)
    const step = vi.fn(async () => ({ tool: 'finish', args: {} }))
    const first = runtimeFor(f.database, step)
    const status = await first.adminDreamingControl(f.namespace, 'start') as any
    await first.close()
    expect(step).not.toHaveBeenCalled()
    const next = runtimeFor(f.database, step)
    await next.adminDreamingControl(f.namespace, 'resume', status.run.id)
    expect(step).not.toHaveBeenCalled()
    const other = await f.reopen()
    await (next as any).retryTopicWrite(f.namespace, other, () => other.failTopicProjection(job.jobId, new Error('test provider failure')))
    await vi.waitFor(async () => expect(await next.adminDreamingStatus(f.namespace)).toMatchObject({ run: { status: 'completed', completed: 1 } }))
    expect(step).toHaveBeenCalledTimes(1)
  })

  it('stops a changed-directory proposal immediately in the native runner without another model request', async () => {
    const f = await fixture(1)
    const runtime = runtimeFor(f.database, async () => { throw new Error('legacy must not run') })
    const requests = vi.fn()
    const ctx = await nativeHost(runtime, f.directory, async function* () {
      requests()
      await editTopicOutsideDreaming(f)
      yield* nativeCall('dreaming_directory', { operations: [{ kind: 'rename-chapter', title: '过期提案' }] })
    })
    await runtime.adminDreamingControl(f.namespace, 'start')
    await vi.waitFor(async () => expect(await runtime.adminDreamingStatus(f.namespace)).toMatchObject({ run: {
      status: 'paused', replanRequired: true, calls: 1, reason: expect.stringContaining('终止本轮后重新开始') } }))
    const status = (await runtime.adminDreamingStatus(f.namespace) as any).run
    await ctx.agents.get(status.sessionId)!.whenIdle()
    expect(requests).toHaveBeenCalledTimes(1)
    const history = JSON.stringify(ctx.agents.get(status.sessionId)!.session.deriveMessages())
    expect(history).toContain('请从目录页终止本轮后重新开始')
    expect(await runtime.adminDreamingControl(f.namespace, 'terminate', status.id)).toMatchObject({ run: { status: 'terminated' } })
    expect((await f.reopen()).getMemoryTopic(f.topicId)?.title).toBe('并发改名')
  })

  it('marks an old paused directory conflict as requiring replan on resume without spending a model call', async () => {
    const f = await fixture(1)
    let run = await f.memory.dreaming({ kind: 'start', owner: 'old' })
    run = await f.memory.dreaming({ kind: 'prepare', ...claim(run) })
    await f.memory.dreaming({ kind: 'suspend', ...claim(run), reason: '连续调用没有有效进展，断点已保存' })
    await editTopicOutsideDreaming(f)
    const step = vi.fn(async () => ({ tool: 'finish', args: {} }))
    const runtime = runtimeFor(f.database, step)
    expect(await runtime.adminDreamingControl(f.namespace, 'resume', run.id)).toMatchObject({ run: {
      status: 'paused', replanRequired: true, calls: 0, reason: expect.stringContaining('继续本轮无法解除冲突') } })
    expect(step).not.toHaveBeenCalled()
    await expect(runtime.adminDreamingControl(f.namespace, 'resume', run.id)).rejects.toThrow('终止本轮后重新开始')
  })

  it('lets the Agent retrieve, modify and finish through the real persistent runner', async () => {
    const f = await fixture()
    const actions = [
      { tool: 'dreaming_search', args: { kind: 'events', query: '目录' } },
      { tool: 'dreaming_directory', args: { operations: [{ kind: 'rename-section', from: '开发', title: '协作' }] } },
      { tool: 'finish', args: {} },
    ]
    const step = vi.fn(async () => actions.shift()!)
    const runtime = runtimeFor(f.database, step)
    await runtime.adminDreamingControl(f.namespace, 'start')
    await vi.waitFor(async () => expect(await runtime.adminDreamingStatus(f.namespace)).toMatchObject({ run: { status: 'completed', completed: 1, changedBatches: 1 } }), { timeout: 3000 })
    await f.memory.reloadFromStorage()
    expect(f.memory.getMemoryTopic(f.topicId)?.sections?.[0]?.title).toBe('协作')
    expect(step).toHaveBeenCalledTimes(3)
    expect((step.mock.calls[1] as any[])[0].recentTools[0].result).not.toHaveProperty('batchId')
  })

  it('terminates an outstanding model call and discards its late directory proposal', async () => {
    const f = await fixture()
    let release!: (value: any) => void
    const step = vi.fn(() => new Promise(resolve => { release = resolve }))
    const runtime = runtimeFor(f.database, step)
    await runtime.adminDreamingControl(f.namespace, 'start')
    await vi.waitFor(() => expect(step).toHaveBeenCalled())
    const status = await runtime.adminDreamingStatus(f.namespace) as { run: { id: string } }
    await runtime.adminDreamingControl(f.namespace, 'terminate', status.run.id)
    release({ tool: 'dreaming_directory', args: { operations: [{ kind: 'rename-chapter', title: '迟到' }] } })
    await runtime.close()
    await f.memory.reloadFromStorage()
    expect(f.memory.getMemoryTopic(f.topicId)?.title).toBe('项目')
    expect(f.memory.exportSnapshot().memoryTopicState?.dreaming?.status).toBe('terminated')
  })

  it.each(['detached', 'native'] as const)('resumes a persisted legacy token limit through the %s runner without losing progress', async mode => {
    const f = await fixture(25)
    let run = await f.memory.dreaming({ kind: 'start', owner: 'old' })
    run = await f.memory.dreaming({ kind: 'prepare', ...claim(run) })
    run = await f.memory.dreaming({ kind: 'apply', ...claim(run), operations: [{ kind: 'rename-chapter', title: '已保存的整理' }] })
    run = await f.memory.dreaming({ kind: 'finish-unit', ...claim(run) })
    run = await f.memory.dreaming({ kind: 'prepare', ...claim(run) })
    run = await f.memory.dreaming({ kind: 'suspend', ...claim(run), reason: '已达到本轮消耗边界' })
    // Seed the old on-disk format, rather than create a cap via the new API.
    await seedLegacyTokenLimit(f)
    const before = (await f.reopen()).exportSnapshot().memoryTopicState!.dreaming!
    expect(before).toMatchObject({ status: 'paused', cursor: 1, changedBatches: 1, tokenLimit: 1000, estimatedTokens: 17769 })
    const step = vi.fn(async (payload: any) => {
      expect(payload.completedBatches).toBe(1)
      expect(payload).not.toHaveProperty('tokenBoundary')
      expect(payload).not.toHaveProperty('estimatedTokensConsumed')
      expect(payload.retrievedEvidenceIds).toEqual(Object.keys(before.evidenceVersions))
      expect(payload.currentTopic.title).toBe('已保存的整理')
      return { tool: 'finish', args: {} }
    })
    const runtime = runtimeFor(f.database, step)
    expect((await runtime.adminDreamingStatus(f.namespace) as any).run.reason).toBe('上次整理已暂停，可以继续；已完成的修改已保存。')
    let ctx: Context | undefined
    let finished = false
    if (mode === 'native') ctx = await nativeHost(runtime, f.directory, async function* (options) {
      expect(options.maxTokens).toBeUndefined()
      if (finished) {
        yield { type: 'text-delta', index: 0, text: '完成。' }; yield { type: 'finish', reason: { kind: 'stop' } }
      } else {
        const action = await step(directoryTask(options))
        finished = true
        yield* nativeCall(action.tool === 'finish' ? 'dreaming_finish' : action.tool, action.args)
      }
    })
    await runtime.adminDreamingControl(f.namespace, 'resume', run.id)
    await vi.waitFor(async () => expect(await runtime.adminDreamingStatus(f.namespace)).toMatchObject({ run: { id: run.id, status: 'completed', completed: before.units.length, changedBatches: 1 } }))
    const status = (await runtime.adminDreamingStatus(f.namespace) as any).run
    if (ctx) await ctx.agents.get(status.sessionId)!.whenIdle()
    await f.memory.reloadFromStorage()
    const saved = f.memory.exportSnapshot().memoryTopicState!.dreaming!
    expect(saved).toMatchObject({ id: run.id, tokenLimit: null, reason: null, changedBatches: 1 })
    expect(saved.estimatedTokens).toBeGreaterThan(17769)
    expect(saved.epoch).toBeGreaterThan(before.epoch)
    expect(f.memory.getMemoryTopic(f.topicId)?.title).toBe('已保存的整理')
    expect(status).not.toHaveProperty('tokenLimit')
    expect(step).toHaveBeenCalledTimes(1)
  })

  it('ignores a legacy tokenLimit query when starting from the admin API', async () => {
    const f = await fixture(1)
    const runtime = runtimeFor(f.database, async () => ({ tool: 'finish', args: {} }))
    const response = { statusCode: 0, setHeader: () => {}, end: () => {} }
    await handleAdminRequest(runtime, { method: 'POST', url: `/api/stratagate/dreaming?namespace=${f.namespace}&action=start&tokenLimit=1` }, response)
    expect(response.statusCode).toBe(200)
    await vi.waitFor(async () => expect(await runtime.adminDreamingStatus(f.namespace)).toMatchObject({ run: { status: 'completed' } }))
    const saved = (await f.reopen()).exportSnapshot().memoryTopicState!.dreaming!
    expect(saved.tokenLimit).toBeNull()
    expect(saved.estimatedTokens).toBeGreaterThan(1)
  })

  it('pauses a repeated unproductive tool loop and retains the checkpoint', async () => {
    const f = await fixture()
    const runtime = runtimeFor(f.database, async () => ({ tool: 'dreaming_search', args: { kind: 'events', query: '目录' } }))
    await runtime.adminDreamingControl(f.namespace, 'start')
    await vi.waitFor(async () => expect(await runtime.adminDreamingStatus(f.namespace)).toMatchObject({ run: { status: 'paused', completed: 0, calls: 3 } }), { timeout: 3000 })
  })

  it('persists graceful shutdown as paused and resumes from a new Runtime', async () => {
    const f = await fixture()
    const step = vi.fn(() => new Promise(() => {}))
    const runtime = runtimeFor(f.database, step, true)
    await runtime.adminDreamingControl(f.namespace, 'start')
    await vi.waitFor(() => expect(step).toHaveBeenCalled())
    await runtime.close()
    const next = runtimeFor(f.database, async () => ({ tool: 'finish', args: {} }))
    const status = await next.adminDreamingStatus(f.namespace) as { run: { id: string; status: string } }
    expect(status.run.status).toBe('paused')
    await next.adminDreamingControl(f.namespace, 'resume', status.run.id)
    await vi.waitFor(async () => expect(await next.adminDreamingStatus(f.namespace)).toMatchObject({ run: { status: 'completed' } }))
  })

  it('validates admin methods and arguments before any write', async () => {
    const f = await fixture()
    const runtime = runtimeFor(f.database, async () => ({ tool: 'finish', args: {} }))
    for (const [method, url, expected] of [
      ['GET', '/api/stratagate/dreaming', 400],
      ['DELETE', `/api/stratagate/dreaming?namespace=${f.namespace}`, 405],
      ['POST', `/api/stratagate/dreaming?namespace=${f.namespace}&action=terminate`, 400],
    ] as const) {
      const response = { statusCode: 0, setHeader: () => {}, end: () => {} }
      await handleAdminRequest(runtime, { method, url }, response)
      expect(response.statusCode).toBe(expected)
    }
    expect(f.memory.exportSnapshot().memoryTopicState?.dreaming).toBeUndefined()
  })
})
