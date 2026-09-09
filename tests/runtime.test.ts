import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import { StrataGate } from '@diqier/stratagate'
import { SqliteStorage } from '@diqier/stratagate/sqlite'
import { describe, expect, it, vi } from 'vitest'
import type { DshModelBridge } from '../src/llm.js'
import { feedbackDraftUrl, StrataGateRuntime } from '../src/runtime.js'

const fakeModels = {
  run: async <T>(_session: Session, operation: () => Promise<T>): Promise<T> => operation(),
  summarizer: async () => ({
    l0Title: 'turns', l0Tags: [], l1Summary: 'turns', l2Keypoints: [], shouldExtract: false,
  }),
  extractor: async () => ({ shouldExtract: false, reason: 'none', events: [] }),
  projector: async () => ({ reason: 'none', changes: [] }),
  graphProjector: async () => ({ reason: 'none', nodes: [], edges: [] }),
} as unknown as DshModelBridge

const session = {
  id: 'session-runtime',
  header: { id: 'session-runtime', version: 0, createdAt: 0, cwd: 'C:\\work\\project' },
  snapshotEvents: () => [],
  eventAt: () => undefined,
} as unknown as Session

function turnEvents(turn = 1): SessionEvent[] {
  const offset = (turn - 1) * 4
  const userText = turn === 1 ? 'remember pnpm' : `remember pnpm ${turn}`
  return [
    { type: 'turn/start', seq: offset, time: offset + 1, data: { turn } },
    {
      type: 'user/message', seq: offset + 1, time: offset + 2,
      data: { id: `u${turn}`, role: 'user', content: [{ type: 'text', text: userText }], source: { kind: 'user' } },
    },
    {
      type: 'assistant/message', seq: offset + 2, time: offset + 3,
      data: {
        turn, step: 1,
        message: {
          id: `a${turn}`, role: 'assistant', content: [{ type: 'text', text: 'Understood.' }],
          source: { kind: 'model', provider: 'test', model: 'test' },
        },
      },
    },
    { type: 'turn/end', seq: offset + 3, time: offset + 4, data: { turn, reason: { kind: 'completed' } } },
  ] as SessionEvent[]
}

describe('DSH runtime ingestion', () => {
  it('persists local feedback drafts and enforces the five-day proactive prompt cooldown', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-feedback-'))
    const database = join(directory, 'memory.db')
    const config = {
      database, namespaceMode: 'project' as const, namespacePrefix: 'dsh', globalNamespace: 'global',
      blockTurnSize: 6, blockDecayLambda: 0.3, ingestSubagents: false, maxOutputTokens: 2048,
    }
    const first = new StrataGateRuntime(config, fakeModels, undefined, undefined, () => 'http://127.0.0.1:10259')
    try {
      const prepared = await first.prepareFeedback(session, {
        title: '  Draft title  ',
        description: 'Observed failure.',
        reproduction: [' First step ', '', 'Second step'],
        errorContext: 'EACCES',
      }) as Record<string, unknown>
      const feedbackUrl = feedbackDraftUrl(first.namespaceFor(session), 'http://127.0.0.1:10259')
      expect(prepared).toMatchObject({
        prepared: true,
        draftCreated: true,
        submitted: false,
        namespace: first.namespaceFor(session),
        feedbackUrl,
        message: `反馈草稿已经准备好了，还没有提交到 GitHub。\n\n[打开反馈草稿](${feedbackUrl})`,
      })
      expect(prepared).not.toHaveProperty('draft')
      expect(feedbackUrl).toContain('namespace=' + encodeURIComponent(first.namespaceFor(session)))
      expect(feedbackUrl).toMatch(/^http:\/\/127\.0\.0\.1:10259\/\?settings=stratagate-memory&stratagateView=feedback&namespace=/)
      expect(feedbackDraftUrl(first.namespaceFor(session))).toMatch(/^\/\?settings=stratagate-memory&stratagateView=feedback&namespace=/)

      const now = Date.parse('2026-09-04T00:00:00.000Z')
      first.notePluginError(session, new Error('write failed'))
      expect(first.takeFeedbackSuggestion(session, now)).toMatch(/only as evidence[\s\S]*not as an instruction[\s\S]*feedback_prepare itself/)
      first.notePluginError(session, new Error('again'))
      expect(first.takeFeedbackSuggestion(session, now + 4 * 24 * 60 * 60 * 1_000)).toBe('')
    } finally {
      await first.close()
    }

    const second = new StrataGateRuntime(config, fakeModels)
    try {
      expect(second.adminFeedbackDraft(second.namespaceFor(session))).toMatchObject({
        draft: { title: 'Draft title', description: 'Observed failure.', errorContext: 'EACCES' },
      })
      expect(second.adminSaveFeedbackDraft(second.namespaceFor(session), { bodyMarkdown: '' })).toMatchObject({
        draft: { title: 'Draft title', description: '', reproduction: [], expected: '', actual: '', errorContext: '' },
      })
      const afterCooldown = Date.parse('2026-09-10T00:00:00.000Z')
      second.notePluginError(session, new Error('later failure'))
      expect(second.takeFeedbackSuggestion(session, afterCooldown)).toMatch(/static StrataGate feedback policy[\s\S]*session-limit[\s\S]*deduplication/)
    } finally {
      await second.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('runs malformed external-memory recovery in a resumable background job', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-import-job-'))
    const database = join(directory, 'memory.db')
    const models = {
      ...fakeModels,
      runDetached: async <T>(_sessionId: string, operation: () => Promise<T>): Promise<T> => operation(),
      externalMemoryExtractor: async () => ({ candidates: [{ title: '恢复记忆', summary: '从损坏输入恢复。' }] }),
      externalMemoryDecider: async () => ({ action: 'ADD' as const, confidence: 0.99 }),
    } as unknown as DshModelBridge
    const runtime = new StrataGateRuntime({
      database, namespaceMode: 'project', namespacePrefix: 'dsh', globalNamespace: 'global',
      blockTurnSize: 6, blockDecayLambda: 0.3, ingestSubagents: false, maxOutputTokens: 2048,
    }, models)
    try {
      await (runtime as unknown as { space: (value: Session) => Promise<StrataGate> }).space(session)
      const namespace = (await runtime.adminNamespaces())[0]!
      const started = await runtime.adminPreviewExternalMemory(namespace, '{broken') as { jobId: string; status: string }
      expect(started.status).toBe('extracting')
      await vi.waitFor(async () => {
        const status = await runtime.adminExternalMemoryStatus(namespace, started.jobId) as { status: string; processedCount: number }
        expect(status).toMatchObject({ status: 'awaiting_confirmation', processedCount: 1 })
      })
    } finally {
      await runtime.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('commits an external-memory decision after revisions change during the model call without rerunning it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-import-conflict-'))
    const database = join(directory, 'memory.db')
    let releaseDecision!: (decision: { action: 'ADD'; confidence: number }) => void
    let markDeciderStarted!: () => void
    const decisionPending = new Promise<{ action: 'ADD'; confidence: number }>((resolve) => {
      releaseDecision = resolve
    })
    const deciderStarted = new Promise<void>((resolve) => {
      markDeciderStarted = resolve
    })
    let deciderCalls = 0
    const models = {
      ...fakeModels,
      runDetached: async <T>(_sessionId: string, operation: () => Promise<T>): Promise<T> => operation(),
      externalMemoryDecider: async () => {
        deciderCalls += 1
        markDeciderStarted()
        return decisionPending
      },
    } as unknown as DshModelBridge
    const runtime = new StrataGateRuntime({
      database, namespaceMode: 'project', namespacePrefix: 'dsh', globalNamespace: 'global',
      blockTurnSize: 6, blockDecayLambda: 0.3, ingestSubagents: false, maxOutputTokens: 2048,
    }, models)
    try {
      const memory = await (runtime as unknown as { space: (value: Session) => Promise<StrataGate> }).space(session)
      const namespace = runtime.namespaceFor(session)
      const job = await memory.createExternalMemoryImportJob(JSON.stringify({
        schemaVersion: 'stratagate.external-memory.v2', sourceType: 'external_ai_memory_export',
        candidates: [{ title: '模型等待期间发生写入', summary: '后台任务应复用已经得到的判断。' }],
      }))
      ;(runtime as unknown as { scheduleExternalMemoryImport: (key: string, id: string) => void })
        .scheduleExternalMemoryImport(namespace, job.id)
      await deciderStarted

      const storage = new SqliteStorage({ filename: database })
      try {
        for (let index = 0; index < 2; index += 1) {
          const loaded = await storage.load(namespace)
          expect(loaded).not.toBeNull()
          await storage.save(namespace, loaded!.snapshot, loaded!.revision)
        }
      } finally {
        await storage.close()
      }
      releaseDecision({ action: 'ADD', confidence: 0.99 })

      await vi.waitFor(async () => {
        const status = await runtime.adminExternalMemoryStatus(namespace, job.id) as { status: string }
        expect(status.status).toBe('ready')
      })
      expect(deciderCalls).toBe(1)
    } finally {
      await runtime.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('reloads the latest namespace revision before retrying a failed import', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-import-stale-retry-'))
    const database = join(directory, 'memory.db')
    const models = {
      ...fakeModels,
      runDetached: async <T>(_sessionId: string, operation: () => Promise<T>): Promise<T> => operation(),
      externalMemoryDecider: async () => ({ action: 'ADD' as const, confidence: 0.99 }),
    } as unknown as DshModelBridge
    const runtime = new StrataGateRuntime({
      database, namespaceMode: 'project', namespacePrefix: 'dsh', globalNamespace: 'global',
      blockTurnSize: 6, blockDecayLambda: 0.3, ingestSubagents: false, maxOutputTokens: 2048,
    }, models)
    try {
      const memory = await (runtime as unknown as { space: (value: Session) => Promise<StrataGate> }).space(session)
      const namespace = runtime.namespaceFor(session)
      const job = await memory.createExternalMemoryImportJob(JSON.stringify({
        schemaVersion: 'stratagate.external-memory.v2', sourceType: 'external_ai_memory_export',
        candidates: [{ title: '重试恢复', summary: '使用最新数据库 revision。' }],
      }))
      await memory.failExternalMemoryImportJob(job.id, new Error('temporary failure'))
      const storage = new SqliteStorage({ filename: database })
      try {
        const loaded = await storage.load(namespace)
        await storage.save(namespace, loaded!.snapshot, loaded!.revision)
      } finally {
        await storage.close()
      }
      const retried = await runtime.adminRetryExternalMemory(namespace, job.id) as { status: string }
      expect(retried.status).toBe('processing')
      await vi.waitFor(async () => {
        const status = await runtime.adminExternalMemoryStatus(namespace, job.id) as { status: string }
        expect(status.status).toBe('ready')
      })
    } finally {
      await runtime.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('returns compact event/graph/raw cards while expand preserves full details', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-dsh-compact-search-'))
    const database = join(directory, 'memory.db')
    const runtime = new StrataGateRuntime({
      database, namespaceMode: 'project', namespacePrefix: 'dsh', globalNamespace: 'global',
      blockTurnSize: 1, blockDecayLambda: 0.3, ingestSubagents: false, maxOutputTokens: 2048,
    }, fakeModels)
    const active = { ...session, id: 'compact-session', header: { ...session.header, id: 'compact-session' } } as unknown as Session
    try {
      const memory = await (runtime as unknown as { space: (value: Session) => Promise<StrataGate> }).space(active)
      await memory.appendTurn({ user: 'Remember the memory plugin release.', assistant: 'Saved.', threadId: String(active.id) })
      const block = memory.listBlocks()[0]!
      const event = await memory.addEvent({
        title: 'Memory plugin released',
        summary: 'The memory plugin was released.',
        narrative: 'Full narrative detail.',
        quotes: ['Exact source quote.'],
        sourceMessageIds: [block.l5Raw[0]!.id],
        sourceBlockId: block.id,
        temporal: { happenedStart: '2026-08-20T00:00:00Z', eventType: 'release' },
      })
      const projection = await memory.claimNextGraphProjection()
      expect(projection).not.toBeNull()
      await memory.completeGraphProjection(projection!.jobId, {
        reason: 'graph',
        nodes: [
          { ref: 'project', name: 'StrataGate', type: 'project', tags: ['memory plugin'], state: 'released', sourceEventIds: [event.id] },
          { ref: 'tool', name: 'MCP tool', type: 'tool', sourceEventIds: [event.id] },
          { ref: 'tool-name', name: 'StrataGate', type: 'tool', tags: ['cli'], sourceEventIds: [event.id] },
        ],
        edges: [{ fromRef: 'project', toRef: 'tool', relation: 'memory plugin', sourceEventIds: [event.id] }],
      })

      const eventBatch = await runtime.searchEvents(active, 'memory plugin') as { results: Array<Record<string, unknown>>; evidenceRefs: string[] }
      expect(eventBatch.results[0]).toMatchObject({ id: event.id, title: event.title, summary: event.summary, rankScore: expect.any(Number) })
      expect(eventBatch.results[0]).not.toHaveProperty('narrative')
      expect(eventBatch.results[0]).not.toHaveProperty('quotes')
      expect(eventBatch.results[0]).not.toHaveProperty('sourceMessageIds')
      expect(eventBatch.results[0]).not.toHaveProperty('score')
      expect(eventBatch.results[0]?.scoreMeaning).toContain('not confidence')

      const expandedEvent = await runtime.expandEvent(active, event.id) as { results: { narrative: string; quotes: string[]; sourceMessageIds: string[] } }
      expect(expandedEvent.results.narrative).toBe('Full narrative detail.')
      expect(expandedEvent.results.quotes).toEqual(['Exact source quote.'])

      const graphBatch = await runtime.searchGraph(active, 'memory plugin') as { results: Array<Record<string, unknown>> }
      expect(graphBatch.results.map((item) => item.name)).toEqual(['StrataGate'])
      expect(graphBatch.results[0]).toMatchObject({ type: 'project', matchedFields: expect.arrayContaining(['tags']) })
      expect(graphBatch.results[0]).not.toHaveProperty('facts')
      expect(graphBatch.results[0]).not.toHaveProperty('score')
      const sameName = await runtime.searchGraph(active, 'StrataGate') as { results: Array<{ name: string; type: string }> }
      expect(sameName.results.filter((item) => item.name === 'StrataGate').map((item) => item.type).sort()).toEqual(['project', 'tool'])
      const expandedGraph = await runtime.expandGraphNode(active, String(graphBatch.results[0]!.id)) as { results: { node: { facts: unknown[] }; edges: unknown[] } }
      expect(expandedGraph.results.node.facts).toBeDefined()
      expect(expandedGraph.results.edges).toHaveLength(1)

      const rawBatch = await runtime.searchRaw(active, 'memory plugin', 4, 'namespace') as { results: Array<Record<string, unknown>> }
      expect(rawBatch.results[0]).toMatchObject({ blockId: block.id, message: { id: block.l5Raw[0]!.id } })
      expect(rawBatch.results[0]).not.toHaveProperty('nearby')
    } finally {
      await runtime.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it.each(['project', 'session', 'global'] as const)('reports block query scope and empty reasons in %s namespace mode', async (namespaceMode) => {
    const directory = await mkdtemp(join(tmpdir(), `stratagate-dsh-block-scope-${namespaceMode}-`))
    const database = join(directory, 'memory.db')
    const sessionA = { ...session, id: `scope-a-${namespaceMode}`, header: { ...session.header, id: `scope-a-${namespaceMode}` } } as unknown as Session
    const sessionB = { ...session, id: `scope-b-${namespaceMode}`, header: { ...session.header, id: `scope-b-${namespaceMode}` } } as unknown as Session
    const runtime = new StrataGateRuntime({
      database, namespaceMode, namespacePrefix: 'dsh', globalNamespace: 'global',
      blockTurnSize: 1, blockDecayLambda: 0.3, ingestSubagents: false, maxOutputTokens: 2048,
    }, fakeModels)
    try {
      const memory = await (runtime as unknown as { space: (active: Session) => Promise<StrataGate> }).space(sessionA)
      await memory.appendTurn({ user: 'namespace-visible marker', assistant: 'saved', threadId: String(sessionA.id) })

      const sessionResult = await runtime.blocks(sessionB) as {
        results: unknown[]; scope: string; threadId: string; emptyReason: string | null; namespaceBlockCount: number
      }
      expect(sessionResult.scope).toBe('session')
      expect(sessionResult.threadId).toBe(String(sessionB.id))
      expect(sessionResult.results).toEqual([])
      expect(sessionResult.namespaceBlockCount).toBe(namespaceMode === 'session' ? 0 : 1)
      expect(sessionResult.emptyReason).toBe(namespaceMode === 'session' ? 'no_blocks_in_namespace' : 'blocks_exist_in_other_threads')

      const namespaceResult = await runtime.blocks(sessionB, 'namespace') as { results: Array<{ threadId?: string }>; scope: string }
      expect(namespaceResult.scope).toBe('namespace')
      expect(namespaceResult.results).toHaveLength(namespaceMode === 'session' ? 0 : 1)
      if (namespaceMode !== 'session') expect(namespaceResult.results[0]?.threadId).toBe(String(sessionA.id))

      const raw = await runtime.searchRaw(sessionB, 'namespace-visible') as { results: Array<{ message: { threadId?: string } }> }
      expect(raw.results).toHaveLength(namespaceMode === 'session' ? 0 : 1)
    } finally {
      await runtime.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('distinguishes an unsealed open tail from an empty namespace', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-dsh-block-open-tail-'))
    const database = join(directory, 'memory.db')
    const runtime = new StrataGateRuntime({
      database, namespaceMode: 'project', namespacePrefix: 'dsh', globalNamespace: 'global',
      blockTurnSize: 2, blockDecayLambda: 0.3, ingestSubagents: false, maxOutputTokens: 2048,
    }, fakeModels)
    try {
      const active = { ...session, id: 'open-tail-session', header: { ...session.header, id: 'open-tail-session' } } as unknown as Session
      await (await (runtime as unknown as { space: (value: Session) => Promise<StrataGate> }).space(active))
        .appendTurn({ user: 'not sealed yet', assistant: 'pending', threadId: String(active.id) })
      const result = await runtime.blocks(active) as { results: unknown[]; emptyReason: string; openTailCount: number }
      expect(result.results).toEqual([])
      expect(result.emptyReason).toBe('open_tail_pending')
      expect(result.openTailCount).toBeGreaterThan(0)
    } finally {
      await runtime.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('builds compact automatic context without reinforcing retrieved memories', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-dsh-auto-context-'))
    const database = join(directory, 'memory.db')
    const activeSession = {
      ...session,
      deriveMessages: () => [{
        id: 'current-user',
        role: 'user',
        content: [{ type: 'text', text: 'Continue with that plan.' }],
        source: { kind: 'user' },
      }],
    } as unknown as Session
    const runtime = new StrataGateRuntime({
      database,
      namespaceMode: 'project',
      namespacePrefix: 'dsh',
      globalNamespace: 'global',
      blockTurnSize: 2,
      blockDecayLambda: 0.3,
      ingestSubagents: false,
      maxOutputTokens: 2048,
    }, fakeModels)
    try {
      const memory = await (runtime as unknown as { space: (session: Session) => Promise<StrataGate> })
        .space(activeSession)
      await memory.appendTurn({ user: 'Initial setup.', assistant: 'Ready.', threadId: 'historical-session' })
      await memory.appendTurn({ user: 'Seal this block.', assistant: 'Sealed.', threadId: 'historical-session' })
      const block = memory.listBlocks()[0]
      expect(block).toBeDefined()

      const relevant = await memory.addEvent({
        title: 'Use pnpm',
        summary: 'The project package manager is pnpm.',
        narrative: 'PRIVATE NARRATIVE',
        quotes: ['PRIVATE QUOTE'],
        sourceMessageIds: [block!.l5Raw[0]!.id],
        sourceBlockId: block!.id,
        temporal: {
          happenedStart: '2026-08-20T10:00:00+08:00',
          happenedEnd: '2026-08-20T11:00:00+08:00',
          status: 'ongoing',
        },
      })
      const projection = await memory.claimNextGraphProjection()
      expect(projection).not.toBeNull()
      await memory.completeGraphProjection(projection!.jobId, {
        reason: 'project tool',
        nodes: [{
          ref: 'stratagate', name: 'StrataGate', type: 'project', state: 'packageManager: pnpm',
          facts: [{ key: 'packageManager', value: 'pnpm', sourceEventIds: [relevant.id] }],
          sourceEventIds: [relevant.id],
        }],
        edges: [],
      })
      const irrelevant = await memory.addEvent({
        title: 'Unrelated archive note',
        summary: 'A completely unrelated zebra record.',
        sourceMessageIds: [block!.l5Raw[0]!.id],
        sourceBlockId: block!.id,
      })
      const pinned = await memory.addEvent({
        title: 'Pinned background',
        summary: 'This pinned fact has no lexical overlap.',
        sourceMessageIds: [block!.l5Raw[0]!.id],
        sourceBlockId: block!.id,
      })
      await memory.pinEvent(pinned.id)
      const safety = await memory.addEvent({
        title: 'Safety background',
        summary: 'This safety fact has no lexical overlap.',
        sourceMessageIds: [block!.l5Raw[0]!.id],
        sourceBlockId: block!.id,
        criticality: 'safety',
      })
      await memory.appendTurn({
        user: 'We chose pnpm earlier.',
        assistant: 'I will keep that in mind.',
        threadId: String(activeSession.id),
      })

      const before = new Map(memory.listEvents().map((event) => [
        event.id,
        [event.weight.mentionCount, event.weight.lastAdoptedTurn],
      ]))
      const context = await runtime.buildAutoContext(activeSession)

      expect(context).toContain('[Activated long-term memory]')
      expect(context).toContain('Historical memory context.')
      expect(context).not.toContain('[Current conversation]')
      expect(context).not.toContain('[Decayed memory blocks]')
      expect(context).not.toContain('We chose pnpm earlier.')
      expect(context).not.toContain('toolCalls:')
      expect(context).toContain(relevant.id)
      expect(context).toContain('"temporal":{"status":"ongoing"}')
      expect(context).toContain('"summary":"The project package manager is pnpm."')
      expect(context).toContain(pinned.id)
      expect(context).toContain(safety.id)
      expect(context).not.toContain(irrelevant.id)
      expect(context).not.toContain('PRIVATE NARRATIVE')
      expect(context).not.toContain('PRIVATE QUOTE')
      expect(context).not.toContain('sourceMessageIds')
      expect(context).not.toContain('sourceEventIds')
      expect(context).not.toContain('mentionCount')
      expect((context.match(/^\- \{"id":"evt_/gm) ?? [])).toHaveLength(3)
      expect((context.match(/^\- \{"nodeId":/gm) ?? [])).toHaveLength(1)
      for (const event of memory.listEvents()) {
        expect([event.weight.mentionCount, event.weight.lastAdoptedTurn]).toEqual(before.get(event.id))
      }
    } finally {
      await runtime.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('retrieves automatic context for each current topic instead of reusing the previous turn', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-dsh-auto-context-topic-'))
    const database = join(directory, 'memory.db')
    let currentQuery = 'Which TypeScript compiler target did we choose?'
    const activeSession = {
      ...session,
      id: 'topic-switch-session',
      header: { ...session.header, id: 'topic-switch-session' },
      events: [],
      deriveMessages: () => [{
        id: 'current-topic',
        role: 'user',
        content: [{ type: 'text', text: currentQuery }],
        source: { kind: 'user' },
      }],
    } as unknown as Session
    const runtime = new StrataGateRuntime({
      database,
      namespaceMode: 'project',
      namespacePrefix: 'dsh',
      globalNamespace: 'global',
      blockTurnSize: 2,
      blockDecayLambda: 0.3,
      ingestSubagents: false,
      maxOutputTokens: 2048,
    }, fakeModels)
    try {
      const memory = await (runtime as unknown as { space: (value: Session) => Promise<StrataGate> }).space(activeSession)
      await memory.appendTurn({ user: 'Historical setup.', assistant: 'Ready.', threadId: 'historical-topic' })
      await memory.appendTurn({ user: 'Historical close.', assistant: 'Saved.', threadId: 'historical-topic' })
      const block = memory.listBlocks()[0]!
      const compiler = await memory.addEvent({
        title: 'TypeScript compiler target',
        summary: 'The TypeScript compiler target is ES2022.',
        sourceMessageIds: [block.l5Raw[0]!.id],
        sourceBlockId: block.id,
      })
      const hotel = await memory.addEvent({
        title: 'Kyoto hotel booking',
        summary: 'The Kyoto hotel booking is at Hotel Granvia.',
        sourceMessageIds: [block.l5Raw[0]!.id],
        sourceBlockId: block.id,
      })

      const compilerContext = await runtime.buildAutoContext(activeSession)
      expect(compilerContext).toContain(compiler.id)
      expect(compilerContext).not.toContain(hotel.id)

      currentQuery = 'Which Kyoto hotel did we book?'
      const hotelContext = await runtime.buildAutoContext(activeSession)
      expect(hotelContext).toContain(hotel.id)
      expect(hotelContext).not.toContain(compiler.id)
    } finally {
      await runtime.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('keeps short-term blocks session-local while activating project long-term memory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-dsh-session-scope-'))
    const database = join(directory, 'memory.db')
    const sessionA = {
      ...session,
      id: 'session-a',
      header: { ...session.header, id: 'session-a' },
      deriveMessages: () => [],
    } as unknown as Session
    const sessionB = {
      ...session,
      id: 'session-b',
      header: { ...session.header, id: 'session-b' },
      deriveMessages: () => [{
        id: 'session-b-user',
        role: 'user',
        content: [{ type: 'text', text: 'Which package manager does this project use?' }],
        source: { kind: 'user' },
      }],
    } as unknown as Session
    const runtime = new StrataGateRuntime({
      database,
      namespaceMode: 'project',
      namespacePrefix: 'dsh',
      globalNamespace: 'global',
      blockTurnSize: 2,
      blockDecayLambda: 0.3,
      ingestSubagents: false,
      maxOutputTokens: 2048,
    }, fakeModels)
    try {
      expect(runtime.namespaceFor(sessionA)).toBe(runtime.namespaceFor(sessionB))
      const memory = await (runtime as unknown as { space: (active: Session) => Promise<StrataGate> }).space(sessionA)
      await memory.appendTurn({ user: 'A-only setup.', assistant: 'A reply.', threadId: 'session-a' })
      await memory.appendTurn({ user: 'A-only sealed turn.', assistant: 'A sealed reply.', threadId: 'session-a' })
      const blockA = memory.listBlocks()[0]!
      const event = await memory.addEvent({
        title: 'Project package manager',
        summary: 'The project package manager is pnpm.',
        sourceMessageIds: [blockA.l5Raw[0]!.id],
        sourceBlockId: blockA.id,
      })
      await memory.appendTurn({ user: 'A-only open tail.', assistant: 'A tail reply.', threadId: 'session-a' })
      await memory.appendTurn({ user: 'B-only open tail.', assistant: 'B tail reply.', threadId: 'session-b' })

      const context = await runtime.buildAutoContext(sessionB)
      expect(context).not.toContain('[Current conversation]')
      expect(context).not.toContain('[Decayed memory blocks]')
      expect(context).not.toContain('B-only open tail.')
      expect(context).not.toContain(blockA.id)
      expect(context).not.toContain('A-only')
      expect(context).toContain(event.id)

      const blockBatch = await runtime.blocks(sessionB) as { results: unknown[] }
      expect(blockBatch.results).toEqual([])
      await runtime.recordUse(sessionB, 'session-local-blocks', [])
    } finally {
      await runtime.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('keeps namespace opening usable while a failed background recovery is retried', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-dsh-recovery-'))
    const database = join(directory, 'memory.db')
    let attempts = 0
    const models = {
      ...fakeModels,
      run: async <T>(_session: Session, operation: () => Promise<T>): Promise<T> => {
        if (attempts++ === 0) throw new Error('temporary recovery failure')
        return operation()
      },
    } as unknown as DshModelBridge
    const runtime = new StrataGateRuntime({
      database,
      namespaceMode: 'project',
      namespacePrefix: 'dsh',
      globalNamespace: 'global',
      blockTurnSize: 4,
      blockDecayLambda: 0.3,
      ingestSubagents: false,
      maxOutputTokens: 2048,
    }, models)
    try {
      const seed = await StrataGate.open({
        database,
        namespace: runtime.namespaceFor(session),
        blockTurnSize: 1,
      })
      await seed.appendTurn({ user: 'recover me', assistant: 'stored', threadId: String(session.id) }, { deferDerivation: true })
      await seed.close()
      const space = (runtime as unknown as { space: (session: Session) => Promise<StrataGate> }).space
      const memory = await space.call(runtime, session)
      expect(memory).toBeInstanceOf(StrataGate)
      await vi.waitFor(() => {
        expect(attempts).toBeGreaterThanOrEqual(2)
        expect(memory.listBlocks()[0]?.processingStatus).toBe('ready')
      })
    } finally {
      await runtime.close().catch(() => {})
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('suggests feedback when a background Summary job records a failure without throwing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-dsh-job-failure-'))
    const database = join(directory, 'memory.db')
    const runtime = new StrataGateRuntime({
      database,
      namespaceMode: 'project',
      namespacePrefix: 'dsh',
      globalNamespace: 'global',
      blockTurnSize: 1,
      blockDecayLambda: 0.3,
      ingestSubagents: false,
      maxOutputTokens: 2048,
    }, {
      ...fakeModels,
      summarizer: async () => { throw new Error('summary service unavailable') },
    } as unknown as DshModelBridge)
    try {
      const seed = await StrataGate.open({
        database,
        namespace: runtime.namespaceFor(session),
        blockTurnSize: 1,
      })
      await seed.appendTurn({ user: 'trigger summary', assistant: 'stored', threadId: String(session.id) }, { deferDerivation: true })
      await seed.close()

      const memory = await (runtime as unknown as { space: (active: Session) => Promise<StrataGate> }).space(session)
      await vi.waitFor(() => {
        expect(memory.listSummaryJobs()[0]).toMatchObject({ status: 'failed', attempts: 1 })
        expect(runtime.takeFeedbackSuggestion(session, Date.parse('2026-09-04T00:00:00.000Z'))).toContain('static StrataGate feedback policy')
      }, { timeout: 4_000 })

      expect(runtime.takeFeedbackSuggestion(session, Date.parse('2026-09-10T00:00:00.000Z'))).toBe('')
    } finally {
      await runtime.close().catch(() => {})
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('persists the UI block settings globally for existing and future workspaces', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-dsh-cadence-'))
    const database = join(directory, 'memory.db')
    const namespace = 'dsh:project:cadence'
    const seed = await StrataGate.open({ database, namespace, blockTurnSize: 4, blockDecayLambda: 0.2 })
    await seed.close()
    const runtime = new StrataGateRuntime({
      database,
      namespaceMode: 'project',
      namespacePrefix: 'dsh',
      globalNamespace: 'global',
      blockTurnSize: 6,
      blockDecayLambda: 0.3,
      ingestSubagents: false,
      maxOutputTokens: 2048,
    }, fakeModels)
    let futureNamespace = ''
    try {
      await runtime.syncConfiguredSettings()
      expect((await runtime.adminSnapshot(namespace))?.blockTurnSize).toBe(6)
      expect((await runtime.adminSnapshot(namespace))?.blockDecayLambda).toBe(0.3)

      const futureSession = {
        ...session,
        id: 'future-workspace',
        header: { ...session.header, id: 'future-workspace', cwd: 'C:\\work\\StrataGate' },
      } as unknown as Session
      futureNamespace = runtime.namespaceFor(futureSession)
      const future = await (runtime as unknown as { space: (active: Session) => Promise<StrataGate> })
        .space(futureSession)
      expect(future.blockTurnSize).toBe(6)
      expect(future.blockDecayLambda).toBe(0.3)

      await runtime.adminSetBlockTurnSize(3)
      await runtime.adminSetBlockDecayLambda(0.15)
      expect((await runtime.adminSnapshot(namespace))?.blockTurnSize).toBe(3)
      expect((await runtime.adminSnapshot(namespace))?.blockDecayLambda).toBe(0.15)
      expect(future.blockTurnSize).toBe(3)
      expect(future.blockDecayLambda).toBe(0.15)
      expect(runtime.adminWorkspaceName(futureNamespace)).toBe('StrataGate')
    } finally {
      await runtime.close()
    }

    const restored = new StrataGateRuntime({
      database,
      namespaceMode: 'project',
      namespacePrefix: 'dsh',
      globalNamespace: 'global',
      blockTurnSize: 6,
      blockDecayLambda: 0.3,
      ingestSubagents: false,
      maxOutputTokens: 2048,
    }, fakeModels)
    try {
      await restored.syncConfiguredSettings()
      expect((await restored.adminSnapshot(namespace))?.blockTurnSize).toBe(3)
      expect((await restored.adminSnapshot(namespace))?.blockDecayLambda).toBe(0.15)
      expect((await restored.adminSnapshot(futureNamespace))?.blockTurnSize).toBe(3)
      expect((await restored.adminSnapshot(futureNamespace))?.blockDecayLambda).toBe(0.15)
      expect(restored.adminWorkspaceName(futureNamespace)).toBe('StrataGate')
    } finally {
      await restored.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('persists a folded DSH turn once even if the event bracket is delivered twice', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-dsh-runtime-'))
    const database = join(directory, 'memory.db')
    const runtime = new StrataGateRuntime({
      database,
      namespaceMode: 'project',
      namespacePrefix: 'dsh',
      globalNamespace: 'global',
      blockTurnSize: 4,
      blockDecayLambda: 0.3,
      ingestSubagents: false,
      maxOutputTokens: 2048,
    }, fakeModels)
    const namespace = runtime.namespaceFor(session)
    try {
      for (const event of turnEvents()) runtime.acceptEvent(session, event)
      for (const event of turnEvents()) runtime.acceptEvent(session, event)
      await runtime.close()

      const memory = await StrataGate.open({ database, namespace })
      expect(memory.turn).toBe(1)
      expect(memory.listOpenTail().map(({ content }) => content)).toEqual(['remember pnpm', 'Understood.'])
      expect(memory.hasIngestionReceipt('dsh:session-runtime:turn:1')).toBe(true)
      await memory.close()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('eagerly drains a three-turn burst without waiting for an explicit flush', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-dsh-eager-drain-'))
    const database = join(directory, 'memory.db')
    const runtime = new StrataGateRuntime({
      database,
      namespaceMode: 'project',
      namespacePrefix: 'dsh',
      globalNamespace: 'global',
      blockTurnSize: 6,
      blockDecayLambda: 0.3,
      ingestSubagents: false,
      maxOutputTokens: 2048,
    }, fakeModels)
    try {
      const memory = await (runtime as unknown as { space: (active: Session) => Promise<StrataGate> }).space(session)
      for (let turn = 1; turn <= 3; turn += 1) {
        for (const event of turnEvents(turn)) runtime.acceptEvent(session, event)
      }
      await vi.waitFor(() => expect(memory.turn).toBe(3), { timeout: 2_000 })
      expect(memory.listOpenTail().map(({ content }) => content)).toEqual([
        'remember pnpm', 'Understood.',
        'remember pnpm 2', 'Understood.',
        'remember pnpm 3', 'Understood.',
      ])
    } finally {
      await runtime.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('restores an ingestion batch after failure and lets a later flush recover it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-dsh-drain-recovery-'))
    const database = join(directory, 'memory.db')
    const runtime = new StrataGateRuntime({
      database,
      namespaceMode: 'project',
      namespacePrefix: 'dsh',
      globalNamespace: 'global',
      blockTurnSize: 4,
      blockDecayLambda: 0.3,
      ingestSubagents: false,
      maxOutputTokens: 2048,
    }, fakeModels)
    const access = runtime as unknown as { space: (active: Session) => Promise<StrataGate> }
    const openSpace = access.space.bind(runtime)
    let failOpening = true
    access.space = async (active) => {
      if (failOpening) throw new Error('temporary ingestion failure')
      return openSpace(active)
    }
    try {
      for (const event of turnEvents()) runtime.acceptEvent(session, event)
      await expect(runtime.flush()).rejects.toThrow('temporary ingestion failure')

      failOpening = false
      await expect(runtime.flush()).resolves.toBeUndefined()
      const memory = await openSpace(session)
      expect(memory.turn).toBe(1)
      expect(memory.listOpenTail().map(({ content }) => content)).toEqual(['remember pnpm', 'Understood.'])
      expect(memory.hasIngestionReceipt('dsh:session-runtime:turn:1')).toBe(true)
    } finally {
      failOpening = false
      await runtime.close().catch(() => {})
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('uses native surface replacement for sealed turns and preserves the open-tail tool chain', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-dsh-native-compaction-'))
    const database = join(directory, 'memory.db')
    const activeSession = Session.create('native-compaction-session' as never)
    const runtime = new StrataGateRuntime({
      database,
      namespaceMode: 'session',
      namespacePrefix: 'dsh',
      globalNamespace: 'global',
      blockTurnSize: 2,
      blockDecayLambda: 1,
      ingestSubagents: false,
      maxOutputTokens: 2048,
    }, fakeModels)
    const append = <T extends Parameters<Session['append']>[0]>(
      type: T,
      data: Parameters<Session['append']>[1],
      opts?: { surfaceOp: 'append'; sourceEventSeqs?: number[] },
    ): SessionEvent => {
      const appendEvent = activeSession.append.bind(activeSession) as (...args: unknown[]) => SessionEvent
      const event = opts
        ? appendEvent(type, data, opts)
        : appendEvent(type, data)
      runtime.acceptEvent(activeSession, event)
      return event
    }
    const appendPlainTurn = (turn: number, user: string, assistant: string): void => {
      append('turn/start', { turn })
      append('user/message', createUserMessage({
        content: [{ type: 'text', text: user }], source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      append('step/start', { turn, step: 1 })
      append('assistant/message', {
        turn, step: 1,
        message: createAssistantMessage({
          content: [{ type: 'text', text: assistant }],
          source: { provider: 'test', model: 'test' },
        }),
      }, { surfaceOp: 'append', sourceEventSeqs: [] })
      append('step/end', { turn, step: 1 })
      append('turn/end', { turn, reason: { kind: 'completed' } })
    }

    try {
      appendPlainTurn(1, 'SEALED ORIGINAL ONE', 'SEALED ANSWER ONE')
      appendPlainTurn(2, 'SEALED ORIGINAL TWO', 'SEALED ANSWER TWO')
      await runtime.flush()

      await vi.waitFor(() => {
        expect(activeSession.deriveMessages()).toHaveLength(1)
      })

      let derived = activeSession.deriveMessages()
      expect(derived).toHaveLength(1)
      expect(derived[0]).toMatchObject({
        role: 'user',
        source: { kind: 'plugin', plugin: 'stratagate-memory' },
      })
      expect(JSON.stringify(derived)).toContain('[StrataGate conversation block]')
      expect(JSON.stringify(derived)).toContain('Level: L5 (L5 raw transcript)')
      expect(JSON.stringify(derived)).toContain('SEALED ORIGINAL ONE')
      expect(JSON.stringify(derived)).toContain('SEALED ORIGINAL TWO')
      const nativeMemory = await (runtime as unknown as { space: (active: Session) => Promise<StrataGate> })
        .space(activeSession)
      const currentBlock = nativeMemory.listBlocks()[0]!
      const currentConversationEvent = await nativeMemory.addEvent({
        title: 'CURRENT USER SENTINEL history',
        summary: 'CURRENT USER SENTINEL came from this same conversation.',
        sourceMessageIds: [currentBlock.l5Raw[0]!.id],
        sourceBlockId: currentBlock.id,
      })

      const callId = 'current-tool-call' as never
      append('turn/start', { turn: 3 })
      append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'CURRENT USER SENTINEL' }], source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      append('step/start', { turn: 3, step: 1 })
      append('assistant/message', {
        turn: 3, step: 1,
        message: createAssistantMessage({
          content: [{ type: 'tool-call', id: callId, name: 'inspect_workspace', arguments: '{"path":"CURRENT_TOOL_PATH"}' }],
          source: { provider: 'test', model: 'test' },
        }),
      }, { surfaceOp: 'append', sourceEventSeqs: [] })
      append('tool/call', { turn: 3, step: 1, callId, name: 'inspect_workspace', arguments: '{"path":"CURRENT_TOOL_PATH"}' })
      append('tool/result', {
        turn: 3, step: 1,
        message: createToolResultMessage({
          callId,
          content: [{ type: 'text', text: 'CURRENT TOOL RESULT' }],
          isError: false,
        }),
      }, { surfaceOp: 'append' })
      append('step/end', { turn: 3, step: 1 })
      append('step/start', { turn: 3, step: 2 })
      append('assistant/message', {
        turn: 3, step: 2,
        message: createAssistantMessage({
          content: [{ type: 'text', text: 'CURRENT FINAL ANSWER' }],
          source: { provider: 'test', model: 'test' },
        }),
      }, { surfaceOp: 'append', sourceEventSeqs: [] })
      append('step/end', { turn: 3, step: 2 })
      append('turn/end', { turn: 3, reason: { kind: 'completed' } })
      await runtime.flush()

      derived = activeSession.deriveMessages()
      const nativeRequest = JSON.stringify(derived)
      expect(nativeRequest.match(/CURRENT USER SENTINEL/g)).toHaveLength(1)
      expect(nativeRequest).toContain('CURRENT_TOOL_PATH')
      expect(nativeRequest).toContain('CURRENT TOOL RESULT')
      expect(nativeRequest).toContain('CURRENT FINAL ANSWER')
      expect(derived.some((message) => message.content.some((block) => block.type === 'tool-call' && block.id === callId))).toBe(true)
      expect(derived.some((message) => message.content.some((block) => block.type === 'tool-result' && block.toolCallId === callId))).toBe(true)

      const dynamicContext = await runtime.buildAutoContext(activeSession)
      expect(dynamicContext).toContain('[Activated long-term memory]')
      expect(dynamicContext).not.toContain('CURRENT USER SENTINEL')
      expect(dynamicContext).not.toContain('CURRENT_TOOL_PATH')
      expect(dynamicContext).not.toContain('CURRENT TOOL RESULT')
      expect(dynamicContext).not.toContain(currentConversationEvent.id)
      expect(dynamicContext).not.toContain('[Current conversation]')
      expect(dynamicContext).not.toContain('[Decayed memory blocks]')
      expect(`${nativeRequest}\n${dynamicContext}`.match(/CURRENT USER SENTINEL/g)).toHaveLength(1)

      appendPlainTurn(4, 'SECOND BLOCK CLOSER', 'SECOND BLOCK ANSWER')
      await runtime.flush()
      await vi.waitFor(() => {
        expect(nativeMemory.getBlockContext(String(activeSession.id))).toHaveLength(2)
      })
      const decayed = nativeMemory.getBlockContext(String(activeSession.id))
      expect(decayed.map(({ level }) => level)).toEqual([3, 5])
      derived = activeSession.deriveMessages()
      expect(derived).toHaveLength(2)
      const decayedRequest = JSON.stringify(derived)
      const decayedTexts = derived.flatMap((message) => message.content
        .flatMap((block) => block.type === 'text' ? [block.text] : []))
      expect(decayedRequest).toContain(`Block: ${decayed[0]!.id}`)
      expect(decayedRequest).toContain('Level: L3 (L3 rule-condensed transcript)')
      expect(decayedTexts.find((text) => text.includes(`Block: ${decayed[0]!.id}`))).toContain(decayed[0]!.content)
      expect(decayedRequest).toContain(`Block: ${decayed[1]!.id}`)
      expect(decayedRequest).toContain('Level: L5 (L5 raw transcript)')

      await nativeMemory.expandBlock(decayed[0]!.id, 'L4', 'user')
      await runtime.buildAutoContext(activeSession)
      expect(JSON.stringify(activeSession.deriveMessages())).toContain('Level: L4 (L4 readable near-verbatim transcript)')
    } finally {
      await runtime.close().catch(() => {})
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('persists the retrieval assessment as an answer-to-source usage audit', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-dsh-audit-'))
    const database = join(directory, 'memory.db')
    const runtime = new StrataGateRuntime({
      database,
      namespaceMode: 'project',
      namespacePrefix: 'dsh',
      globalNamespace: 'global',
      blockTurnSize: 1,
      blockDecayLambda: 0.3,
      ingestSubagents: false,
      maxOutputTokens: 2048,
    }, fakeModels)
    const activeSession = {
      ...session,
      snapshotEvents: () => [{ type: 'turn/start', seq: 0, time: 1, data: { turn: 9 } }],
    } as unknown as Session
    const namespace = runtime.namespaceFor(activeSession)
    try {
      const seed = await StrataGate.open({
        database,
        namespace,
        blockTurnSize: 1,
        summarizer: async () => ({
          l0Title: 'package manager', l0Tags: ['pnpm'], l1Summary: 'Use pnpm.', l2Keypoints: ['pnpm'], shouldExtract: true,
        }),
        extractor: async ({ target }) => ({
          shouldExtract: true,
          reason: 'durable project decision',
          events: [{
            title: 'Use pnpm',
            summary: 'The project uses pnpm.',
            sourceMessageIds: [target.l5Raw[0]?.id ?? 'missing'],
            sourceBlockId: target.id,
          }],
        }),
      })
      await seed.appendTurn({ user: 'Use pnpm.', assistant: 'Okay.' })
      await seed.appendTurn({ user: 'Continue.', assistant: 'Okay.' })
      const sourceBlock = seed.listBlocks()[0]!
      await seed.addEvent({
        title: 'pnpm alternative note',
        summary: 'A second pnpm memory that should not be reinforced unless selected.',
        sourceMessageIds: [sourceBlock.l5Raw[0]!.id],
        sourceBlockId: sourceBlock.id,
      })
      await seed.close()

      const batch = await runtime.searchEvents(activeSession, 'pnpm') as { batchId: string; evidenceRefs: string[] }
      expect(batch.evidenceRefs).toHaveLength(3)
      await runtime.assess(activeSession, {
        verdict: 'sufficient',
        evidence_refs: batch.evidenceRefs,
        fit: 'The event records the package-manager decision.',
        missing: '',
        next_strategy: 'answer',
      })
      expect(runtime.needsRecordUse(activeSession)).toBe(true)
      const selectedRefs = [batch.evidenceRefs[0]!]
      await runtime.recordUse(activeSession, 'call-audit-1', selectedRefs)
      expect(runtime.needsRecordUse(activeSession)).toBe(false)

      const audit = (await runtime.adminSnapshot(namespace))?.usageReceipts[0]
      expect(audit).toMatchObject({
        id: 'dsh:session-runtime:tool:call-audit-1',
        audit: {
          sessionId: 'session-runtime',
          turn: 9,
          batchId: batch.batchId,
          evidenceRefs: selectedRefs,
          citations: [expect.objectContaining({
            kind: 'event',
            evidenceRef: selectedRefs[0],
            detailKind: 'eventId',
          })],
          verdict: 'sufficient',
          nextStrategy: 'answer',
        },
      })

      const afterSelected = await runtime.adminSnapshot(namespace)
      const selectedEventId = selectedRefs[0]!.slice('event:'.length)
      expect(afterSelected?.events.find(({ id }) => id === selectedEventId)?.weight.mentionCount).toBe(2)
      expect(afterSelected?.events.find(({ id }) => id !== selectedEventId)?.weight.mentionCount).toBe(1)
      const mentionCounts = new Map(afterSelected?.events.map((event) => [event.id, event.weight.mentionCount]))
      await runtime.searchEvents(activeSession, 'pnpm')
      expect(runtime.needsRecordUse(activeSession)).toBe(true)
      const zeroUse = await runtime.recordUse(activeSession, 'call-audit-zero', []) as {
        retrievalSequence: number
        retrievedCount: number
        retrievedMemories: Array<Record<string, unknown>>
        evidenceRefs: string[]
        citations: Array<Record<string, unknown>>
      }
      expect(zeroUse).toMatchObject({
        retrievalSequence: expect.any(Number),
        retrievedCount: batch.evidenceRefs.length,
        evidenceRefs: [],
        citations: [],
      })
      expect(zeroUse.retrievedMemories).toHaveLength(batch.evidenceRefs.length)
      expect(zeroUse.retrievedMemories).toEqual(expect.arrayContaining([
        expect.objectContaining({ batchId: expect.any(String), evidenceRef: expect.any(String), title: expect.any(String) }),
      ]))
      expect(runtime.needsRecordUse(activeSession)).toBe(false)
      const afterZero = await runtime.adminSnapshot(namespace)
      for (const event of afterZero?.events ?? []) {
        expect(event.weight.mentionCount).toBe(mentionCounts.get(event.id))
      }
      expect(afterZero?.usageReceipts).toContainEqual(expect.objectContaining({
        id: 'dsh:session-runtime:tool:call-audit-zero',
        eventIds: [],
        elementIds: [],
      }))
    } finally {
      await runtime.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('keeps parallel retrieval batches independently assessable and recordable', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-dsh-parallel-batches-'))
    const database = join(directory, 'memory.db')
    const runtime = new StrataGateRuntime({
      database,
      namespaceMode: 'project',
      namespacePrefix: 'dsh',
      globalNamespace: 'global',
      blockTurnSize: 1,
      blockDecayLambda: 0.3,
      ingestSubagents: false,
      maxOutputTokens: 2048,
    }, fakeModels)
    const citationEvents: Array<{ type: string; data: Record<string, unknown> }> = []
    const activeSession = {
      ...session,
      snapshotEvents: () => [{ type: 'turn/start', seq: 0, time: 1, data: { turn: 10 } }],
      append: vi.fn((type: string, data: Record<string, unknown>) => {
        citationEvents.push({ type, data })
        return { type, data, seq: citationEvents.length, time: citationEvents.length + 1 }
      }),
    } as unknown as Session
    const namespace = runtime.namespaceFor(activeSession)

    try {
      const memory = await (runtime as unknown as { space: (active: Session) => Promise<StrataGate> })
        .space(activeSession)
      await memory.appendTurn({
        user: 'Use pnpm for this project.',
        assistant: 'Recorded.',
        threadId: String(activeSession.id),
      })
      const sourceBlock = memory.listBlocks()[0]!
      const event = await memory.addEvent({
        title: 'Use pnpm',
        summary: 'The project package manager is pnpm.',
        sourceMessageIds: [sourceBlock.l5Raw[0]!.id],
        sourceBlockId: sourceBlock.id,
      })
      const projection = await memory.claimNextGraphProjection()
      expect(projection).not.toBeNull()
      await memory.completeGraphProjection(projection!.jobId, {
        reason: 'package manager state',
        nodes: [{
          ref: 'pnpm',
          name: 'pnpm',
          type: 'tool',
          state: 'selected package manager',
          facts: [{ key: 'role', value: 'project package manager', sourceEventIds: [event.id] }],
          sourceEventIds: [event.id],
        }],
        edges: [],
      })
      await memory.addEvent({
        title: 'pnpm compatibility note',
        summary: 'A second pnpm Event should remain unreinforced unless its ref is assessed and used.',
        sourceMessageIds: [sourceBlock.l5Raw[0]!.id],
        sourceBlockId: sourceBlock.id,
      })

      type Batch = { batchId: string; evidenceRefs: string[] }
      const [eventBatch, graphBatch, rawBatch, blockBatch] = await Promise.all([
        runtime.searchEvents(activeSession, 'pnpm') as Promise<Batch>,
        runtime.searchGraph(activeSession, 'pnpm') as Promise<Batch>,
        runtime.searchRaw(activeSession, 'pnpm') as Promise<Batch>,
        runtime.blocks(activeSession) as Promise<Batch>,
      ])
      expect(new Set([eventBatch.batchId, graphBatch.batchId, rawBatch.batchId, blockBatch.batchId]).size).toBe(4)
      expect(eventBatch.evidenceRefs).not.toHaveLength(0)
      expect(graphBatch.evidenceRefs).not.toHaveLength(0)
      expect(rawBatch.evidenceRefs).not.toHaveLength(0)
      expect(blockBatch.evidenceRefs).not.toHaveLength(0)
      const pendingBatchIds = runtime.pendingBatchIds(activeSession)
      expect(new Set(pendingBatchIds)).toEqual(new Set([
        eventBatch.batchId,
        graphBatch.batchId,
        rawBatch.batchId,
        blockBatch.batchId,
      ]))
      const latestBatchId = pendingBatchIds.at(-1)!

      const eventRef = eventBatch.evidenceRefs[0]!
      const graphRef = graphBatch.evidenceRefs[0]!
      const assessment = await runtime.assess(activeSession, {
        verdict: 'sufficient',
        evidence_refs: [eventRef, graphRef, graphRef, 'event:not-real'],
        fit: 'The Event directly records the decision.',
        missing: '',
        next_strategy: 'answer',
      }, eventBatch.batchId) as {
        batchId: string
        evidenceRefs: string[]
        rejectedEvidenceRefs: Array<{ ref: string; reason: string }>
      }
      expect(assessment).toMatchObject({
        batchId: eventBatch.batchId,
        evidenceRefs: [eventRef],
        rejectedEvidenceRefs: [
          { ref: graphRef, reason: 'not_in_batch' },
          { ref: graphRef, reason: 'duplicate' },
          { ref: 'event:not-real', reason: 'not_in_batch' },
        ],
      })

      const invalidRefs = [
        eventRef,
        ...eventBatch.evidenceRefs.slice(1),
        graphRef,
        'event:not-real',
        ' ',
      ]
      await expect(runtime.recordUse(
        activeSession,
        'parallel-invalid',
        invalidRefs,
        eventBatch.batchId,
      )).rejects.toSatisfy((error: Error) => {
        expect(error.message).toContain('memory_record_use rejected invalid evidence refs')
        expect(error.message).toContain(eventBatch.batchId)
        expect(error.message).toContain(graphRef)
        expect(error.message).toContain('event:not-real')
        expect(error.message).toContain('not_adopted')
        expect(error.message).toContain('not_in_batch')
        expect(error.message).toContain('invalid_ref')
        expect(error.message).toContain(`Available refs for ${eventBatch.batchId}`)
        expect(error.message).toContain(`Latest batch: ${latestBatchId}`)
        for (const ref of eventBatch.evidenceRefs.slice(1)) expect(error.message).toContain(ref)
        return true
      })
      expect(runtime.pendingBatchIds(activeSession)).toContain(eventBatch.batchId)

      const recordedEvent = await runtime.recordUse(
        activeSession,
        'parallel-event',
        [eventRef, eventRef],
        eventBatch.batchId,
      ) as { batchId: string; evidenceRefs: string[]; duplicateEvidenceRefs: string[]; citations: Array<Record<string, unknown>> }
      expect(recordedEvent).toMatchObject({
        batchId: eventBatch.batchId,
        evidenceRefs: [eventRef],
        duplicateEvidenceRefs: [eventRef],
        citations: [expect.objectContaining({ kind: 'event', evidenceRef: eventRef, detailKind: 'eventId' })],
      })

      await runtime.assess(activeSession, {
        verdict: 'sufficient',
        evidence_refs: graphBatch.evidenceRefs,
        fit: 'The graph node reflects Event-backed current state.',
        missing: '',
        next_strategy: 'answer',
      }, graphBatch.batchId)
      const recordedGraph = await runtime.recordUse(activeSession, 'parallel-graph', graphBatch.evidenceRefs, graphBatch.batchId) as { citations: Array<Record<string, unknown>> }
      expect(recordedGraph.citations).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'graph', evidenceRef: graphBatch.evidenceRefs[0], detailKind: 'nodeId' }),
      ]))

      // rawBatch is older than blockBatch but remains addressable after newer batches are created.
      await runtime.assess(activeSession, {
        verdict: 'sufficient',
        evidence_refs: rawBatch.evidenceRefs,
        fit: 'The archived source message directly states the choice.',
        missing: '',
        next_strategy: 'answer',
      }, rawBatch.batchId)
      const recordedRaw = await runtime.recordUse(activeSession, 'parallel-raw', rawBatch.evidenceRefs, rawBatch.batchId) as { citations: Array<Record<string, unknown>> }
      expect(recordedRaw.citations).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'block', evidenceRef: rawBatch.evidenceRefs[0], detailKind: 'blockId' }),
      ]))

      const expandedBatch = await runtime.expandBlock(activeSession, sourceBlock.id, 'L5') as Batch
      await runtime.assess(activeSession, {
        verdict: 'sufficient',
        evidence_refs: expandedBatch.evidenceRefs,
        fit: 'The expanded Block contains the exact source wording.',
        missing: '',
        next_strategy: 'answer',
      }, expandedBatch.batchId)
      const recordedExpanded = await runtime.recordUse(activeSession, 'parallel-expanded-block', expandedBatch.evidenceRefs, expandedBatch.batchId) as { citations: Array<Record<string, unknown>> }
      expect(recordedExpanded.citations).toEqual([
        expect.objectContaining({ kind: 'block', id: sourceBlock.id, level: 5, expanded: true, detailKind: 'blockId' }),
      ])
      await runtime.recordUse(activeSession, 'parallel-block-empty', [], blockBatch.batchId)
      expect(runtime.needsRecordUse(activeSession)).toBe(false)
      expect(recordedEvent).toMatchObject({ namespace })
      expect(citationEvents).not.toContainEqual(expect.objectContaining({
        type: 'stratagate/memory-citations',
      }))

      const receipts = (await runtime.adminSnapshot(namespace))?.usageReceipts ?? []
      expect(receipts).toContainEqual(expect.objectContaining({
        id: 'dsh:session-runtime:tool:parallel-event',
        audit: expect.objectContaining({ batchId: eventBatch.batchId, evidenceRefs: [eventRef] }),
      }))
      expect(receipts).toContainEqual(expect.objectContaining({
        id: 'dsh:session-runtime:tool:parallel-graph',
        audit: expect.objectContaining({ batchId: graphBatch.batchId, evidenceRefs: graphBatch.evidenceRefs }),
      }))
      expect(receipts).toContainEqual(expect.objectContaining({
        id: 'dsh:session-runtime:tool:parallel-block-empty',
        audit: expect.objectContaining({ batchId: blockBatch.batchId, evidenceRefs: [] }),
      }))

      // Existing sequential calls remain valid when batch_id is omitted.
      const sequential = await runtime.searchEvents(activeSession, 'pnpm') as Batch
      await runtime.assess(activeSession, {
        verdict: 'sufficient',
        evidence_refs: sequential.evidenceRefs,
        fit: 'Direct Event evidence.',
        missing: '',
        next_strategy: 'answer',
      })
      await runtime.recordUse(activeSession, 'sequential-compatible', sequential.evidenceRefs)
      expect(runtime.needsRecordUse(activeSession)).toBe(false)
    } finally {
      await runtime.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
