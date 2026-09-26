import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import { StrataGate, type ExtractionContext, type GraphNode } from '@diqier/stratagate'
import { SqliteStorage } from '@diqier/stratagate/sqlite'
import { describe, expect, it, vi } from 'vitest'
import type { ResolvedConfig } from '../src/config.js'
import type { DshModelBridge } from '../src/llm.js'
import { feedbackDraftUrl, StrataGateRuntime } from '../src/runtime.js'

const fakeModels = {
  run: async <T>(_session: Session, operation: () => Promise<T>): Promise<T> => operation(),
  runDetached: async <T>(_sessionId: string, operation: () => Promise<T>): Promise<T> => operation(),
  isReady: () => true,
  onAdaptersUpdated: () => () => {},
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
  it('derives the displayed data directory from the resolved database path and opens that exact directory', async () => {
    const database = join('relative-stratagate-data', 'memory.db')
    const opened: string[] = []
    const runtime = new StrataGateRuntime({
      database, namespaceMode: 'project', namespacePrefix: 'dsh', globalNamespace: 'global',
      blockTurnSize: 6, blockDecayLambda: 0.3, ingestSubagents: false, maxOutputTokens: 2048,
    }, fakeModels, undefined, undefined, undefined, async (path) => { opened.push(path) })
    try {
      const expected = resolve('relative-stratagate-data')
      expect(runtime.adminDataDirectory()).toBe(expected)
      await expect(runtime.adminOpenDataDirectory(new AbortController().signal)).resolves.toEqual({ opened: true, path: expected })
      expect(opened).toEqual([expected])
    } finally {
      await runtime.close()
    }
  })

  it('consumes persisted graph jobs without a new host session event', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-background-worker-'))
    const database = join(directory, 'memory.db')
    const namespace = 'dsh:project:background-worker'
    const summarizer = async () => ({
      l0Title: 'worker', l0Tags: [], l1Summary: 'worker', l2Keypoints: [], shouldExtract: true,
    })
    try {
      const seed = await StrataGate.open({
        database, namespace, blockTurnSize: 1,
        graphProjector: async () => ({ reason: 'projected', nodes: [], edges: [] }),
      })
      await seed.appendTurn({ user: 'seed event', assistant: 'saved', threadId: 'seed-session' }, { deferDerivation: true })
      const block = seed.listBlocks()[0]!
      await seed.addEvent({
        title: 'Background worker event', summary: 'A durable event for worker recovery.',
        sourceBlockId: block.id, sourceMessageIds: [block.l5Raw[0]!.id],
      })
      expect(seed.listGraphProjectionJobs()).toHaveLength(1)
      await seed.close()

      const runtime = new StrataGateRuntime({
        database, namespaceMode: 'project', namespacePrefix: 'dsh', globalNamespace: 'global',
        blockTurnSize: 1, blockDecayLambda: 0.3, ingestSubagents: false, maxOutputTokens: 2048,
      }, {
        ...fakeModels,
        graphProjector: async () => ({ reason: 'projected', nodes: [], edges: [] }),
      } as unknown as DshModelBridge)
      try {
        await vi.waitFor(async () => {
          const snapshot = await runtime.adminSnapshot(namespace)
          expect(snapshot?.graphProjectionJobs).toEqual([
            expect.objectContaining({ status: 'completed', attempts: 1 }),
          ])
          expect(snapshot?.blocks).toEqual([
            expect.objectContaining({ id: block.id, processingStatus: 'ready' }),
          ])
          expect(snapshot?.summaryJobs).toEqual([
            expect.objectContaining({ blockId: block.id, status: 'succeeded', attempts: 1 }),
          ])
        }, { timeout: 5_000, interval: 100 })
      } finally {
        await runtime.close()
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('keeps model jobs unclaimed until an adapter update wakes the worker', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-adapter-ready-'))
    const database = join(directory, 'memory.db')
    const namespace = 'dsh:project:adapter-ready'
    let ready = false
    let adapterUpdated = () => {}
    const disposeAdaptersUpdated = vi.fn()
    const summaryCalls = vi.fn()
    const extractionCalls = vi.fn()
    const graphCalls = vi.fn()
    const runDetached = vi.fn(async <T>(_sessionId: string, operation: () => Promise<T>): Promise<T> => operation())
    try {
      const seed = await StrataGate.open({ database, namespace, blockTurnSize: 1 })
      await seed.appendTurn(
        { user: 'remember the adapter startup race', assistant: 'saved', threadId: 'seed-session' },
        { deferDerivation: true },
      )
      const blockId = seed.listBlocks()[0]!.id
      await seed.close()

      const runtime = new StrataGateRuntime({
        database, namespaceMode: 'project', namespacePrefix: 'dsh', globalNamespace: 'global',
        blockTurnSize: 1, blockDecayLambda: 0.3, ingestSubagents: false, maxOutputTokens: 2048,
      }, {
        ...fakeModels,
        isReady: () => ready,
        onAdaptersUpdated: (listener: () => void) => {
          adapterUpdated = listener
          return disposeAdaptersUpdated
        },
        runDetached,
        summarizer: async () => {
          summaryCalls()
          return { l0Title: 'ready', l0Tags: [], l1Summary: 'ready', l2Keypoints: [], shouldExtract: true }
        },
        extractor: async ({ target }: ExtractionContext) => {
          extractionCalls()
          return {
            shouldExtract: true,
            reason: 'durable event',
            events: [{
              title: 'Adapter became ready', summary: 'Pending work resumed automatically.',
              sourceMessageIds: [target.l5Raw[0]!.id],
            }],
          }
        },
        graphProjector: async () => {
          graphCalls()
          return { reason: 'projected', nodes: [], edges: [] }
        },
      } as unknown as DshModelBridge)
      try {
        await (runtime as unknown as { runBackgroundNamespace: (value: string) => Promise<void> })
          .runBackgroundNamespace(namespace)
        await new Promise((resolve) => setTimeout(resolve, 350))
        const waiting = await runtime.adminSnapshot(namespace)
        expect(waiting?.summaryJobs).toEqual([
          expect.objectContaining({ blockId, status: 'pending', attempts: 0 }),
        ])
        expect(waiting?.extractionJobs).toEqual([])
        expect(waiting?.graphProjectionJobs).toEqual([])
        expect(runDetached).not.toHaveBeenCalled()
        expect(summaryCalls).not.toHaveBeenCalled()

        ready = true
        adapterUpdated()
        await vi.waitFor(async () => {
          const resumed = await runtime.adminSnapshot(namespace)
          expect(resumed?.summaryJobs).toEqual([
            expect.objectContaining({ status: 'succeeded', attempts: 1 }),
          ])
          expect(resumed?.extractionJobs).toEqual([
            expect.objectContaining({ status: 'succeeded', attempts: 1 }),
          ])
          expect(resumed?.graphProjectionJobs).toEqual([
            expect.objectContaining({ status: 'completed', attempts: 1 }),
          ])
        }, { timeout: 2_000, interval: 25 })
        expect(runDetached).toHaveBeenCalledTimes(1)
        expect(summaryCalls).toHaveBeenCalledTimes(1)
        expect(extractionCalls).toHaveBeenCalledTimes(1)
        expect(graphCalls).toHaveBeenCalledTimes(1)

        adapterUpdated()
        await new Promise((resolve) => setTimeout(resolve, 50))
        expect(runDetached).toHaveBeenCalledTimes(1)
      } finally {
        await runtime.close()
      }
      expect(disposeAdaptersUpdated).toHaveBeenCalledTimes(1)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('keeps genuine model failures on the existing three-attempt Core budget', async () => {
    const summaryCalls = vi.fn(async () => {
      throw new Error('provider request failed')
    })
    const runtime = new StrataGateRuntime({
      database: ':memory:', namespaceMode: 'session', namespacePrefix: 'dsh', globalNamespace: 'global',
      blockTurnSize: 1, blockDecayLambda: 0.3, ingestSubagents: false, maxOutputTokens: 2048,
    }, { ...fakeModels, summarizer: summaryCalls } as unknown as DshModelBridge)
    try {
      const memory = await (runtime as unknown as { space: (value: Session) => Promise<StrataGate> }).space(session)
      await memory.appendTurn(
        { user: 'this is a real model failure', assistant: 'saved', threadId: String(session.id) },
        { deferDerivation: true },
      )
      for (let attempt = 0; attempt < 4; attempt += 1) {
        await memory.resumePendingWork({ retryFailed: true, threadId: String(session.id) })
      }
      expect(summaryCalls).toHaveBeenCalledTimes(3)
      expect(memory.listSummaryJobs()).toEqual([
        expect.objectContaining({ status: 'failed', attempts: 3, nextRetryAt: null }),
      ])
    } finally {
      await runtime.close()
    }
  })

  it('does not wake the detached model runner for a terminal Graph failure', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-terminal-graph-'))
    const database = join(directory, 'memory.db')
    const namespace = 'dsh:project:terminal-graph'
    try {
      const seed = await StrataGate.open({
        database, namespace, blockTurnSize: 1,
        summarizer: async () => ({ l0Title: 'ready', l0Tags: [], l1Summary: 'ready', l2Keypoints: [], shouldExtract: false }),
        graphProjector: async () => ({ reason: 'unused', nodes: [], edges: [] }),
      })
      await seed.appendTurn({ user: 'source', assistant: 'stored' })
      const block = seed.listBlocks()[0]!
      await seed.addEvent({
        title: 'Terminal Graph failure', summary: 'Must never wake the worker again.',
        sourceBlockId: block.id, sourceMessageIds: [block.l5Raw[0]!.id],
      })
      const claim = await seed.claimNextGraphProjection()
      await seed.failGraphProjection(claim!.jobId, new Error('permanent failure'))
      await seed.close()

      const sqlite = new DatabaseSync(database)
      const row = sqlite.prepare('SELECT jobs_json FROM graph_state WHERE namespace = ?')
        .get(namespace) as { jobs_json: string }
      const jobs = JSON.parse(row.jobs_json) as Array<{ attempts: number; nextRetryAt: string | null }>
      jobs[0]!.attempts = 125
      jobs[0]!.nextRetryAt = '2020-01-01T00:00:00.000Z'
      sqlite.prepare('UPDATE graph_state SET jobs_json = ? WHERE namespace = ?')
        .run(JSON.stringify(jobs), namespace)
      sqlite.close()

      const runDetached = vi.fn(async <T>(_sessionId: string, operation: () => Promise<T>): Promise<T> => operation())
      const runtime = new StrataGateRuntime({
        database, namespaceMode: 'project', namespacePrefix: 'dsh', globalNamespace: 'global',
        blockTurnSize: 1, blockDecayLambda: 0.3, ingestSubagents: false, maxOutputTokens: 2048,
      }, { ...fakeModels, runDetached } as unknown as DshModelBridge)
      try {
        await (runtime as unknown as { runBackgroundNamespace: (value: string) => Promise<void> })
          .runBackgroundNamespace(namespace)
        expect(runDetached).not.toHaveBeenCalled()
      } finally {
        await runtime.close()
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

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

  it('patches feedback drafts without dropping omitted fields or losing manual bodyMarkdown', async () => {
    const runtime = new StrataGateRuntime({
      database: ':memory:', namespaceMode: 'project', namespacePrefix: 'dsh', globalNamespace: 'global',
      blockTurnSize: 6, blockDecayLambda: 0.3, ingestSubagents: false, maxOutputTokens: 2048,
    }, fakeModels)
    try {
      const namespace = runtime.namespaceFor(session)
      await runtime.prepareFeedback(session, {
        title: 'Original title', description: 'Original description', reproduction: ['step one', 'step two'],
        expected: 'Original expected', actual: 'Original actual', errorContext: 'Original error',
      })
      await runtime.prepareFeedback(session, { title: 'New title' })
      expect(runtime.adminFeedbackDraft(namespace).draft).toMatchObject({
        title: 'New title', description: 'Original description', reproduction: ['step one', 'step two'],
        expected: 'Original expected', actual: 'Original actual', errorContext: 'Original error',
      })
      await runtime.prepareFeedback(session, { expected: 'New expected' })
      expect(runtime.adminFeedbackDraft(namespace).draft).toMatchObject({
        title: 'New title', description: 'Original description', reproduction: ['step one', 'step two'],
        expected: 'New expected', actual: 'Original actual', errorContext: 'Original error',
      })
      await runtime.prepareFeedback(session, { reproduction: ['new step'] })
      expect(runtime.adminFeedbackDraft(namespace).draft).toMatchObject({
        title: 'New title', description: 'Original description', reproduction: ['new step'],
        expected: 'New expected', actual: 'Original actual', errorContext: 'Original error',
      })
      const withBody = runtime.adminSaveFeedbackDraft(namespace, { bodyMarkdown: '## 问题描述\n\nManual body.\n\n## 自定义备注\n\nKeep this custom section.' }).draft
      expect(withBody.bodyMarkdown).toContain('Manual body.')
      await runtime.prepareFeedback(session, { title: 'Manual body title patch' })
      expect(runtime.adminFeedbackDraft(namespace).draft?.bodyMarkdown).toContain('Keep this custom section.')
      await runtime.prepareFeedback(session, { reproduction: ['repro step after manual edit'] })
      expect(runtime.adminFeedbackDraft(namespace).draft?.bodyMarkdown).toContain('1. repro step after manual edit')
      await runtime.prepareFeedback(session, { expected: 'Latest expected' })
      const afterStructuredUpdate = runtime.adminFeedbackDraft(namespace).draft!
      expect(afterStructuredUpdate).toMatchObject({
        title: 'Manual body title patch', description: '', reproduction: ['repro step after manual edit'],
        expected: 'Latest expected', actual: '', errorContext: '',
      })
      expect(afterStructuredUpdate.bodyMarkdown).toContain('Manual body.')
      expect(afterStructuredUpdate.bodyMarkdown).toContain('## 自定义备注')
      expect(afterStructuredUpdate.bodyMarkdown).toContain('Keep this custom section.')
      expect(afterStructuredUpdate.bodyMarkdown).toContain('Latest expected')
      const afterBodyClear = runtime.adminSaveFeedbackDraft(namespace, { bodyMarkdown: '' }).draft
      expect(afterBodyClear).toMatchObject({
        title: 'Manual body title patch', description: '', reproduction: [], expected: '', actual: '', errorContext: '',
      })
      expect(afterBodyClear.bodyMarkdown).toBeUndefined()
      await runtime.prepareFeedback(session, { actual: 'Actual after explicit body clear' })
      expect(runtime.adminFeedbackDraft(namespace).draft).toMatchObject({
        title: 'Manual body title patch', description: '', reproduction: [], expected: '',
        actual: 'Actual after explicit body clear', errorContext: '',
      })
      expect(runtime.adminFeedbackDraft(namespace).draft?.bodyMarkdown).toBeUndefined()
    } finally {
      await runtime.close()
    }
  })

  it('patches only a real top-level Markdown section and preserves lookalikes in text and fences', async () => {
    const runtime = new StrataGateRuntime({
      database: ':memory:', namespaceMode: 'project', namespacePrefix: 'dsh', globalNamespace: 'global',
      blockTurnSize: 6, blockDecayLambda: 0.3, ingestSubagents: false, maxOutputTokens: 2048,
    }, fakeModels)
    try {
      const namespace = runtime.namespaceFor(session)
      const bodyMarkdown = [
        'Intro with literal ## 预期行为 text.',
        '',
        '### 预期行为',
        '',
        'Keep the custom level-three section.',
        '',
        '```md',
        '## 预期行为',
        'code sample must remain untouched',
        '~~~',
        'mixed fence must remain inside the backtick fence',
        '```',
        '',
        '~~~~md',
        '```',
        'long fence content must remain inside',
        '~~~~',
        '',
        '    ## 预期行为',
        '    indented code must remain untouched',
        '',
        '## 预期行为',
        '',
        'Old expected content.',
        '',
        '## 自定义备注',
        '',
        'Keep this custom section.',
      ].join('\n')
      runtime.adminSaveFeedbackDraft(namespace, { bodyMarkdown })
      await runtime.prepareFeedback(session, { expected: 'New expected content.' })
      const updated = runtime.adminFeedbackDraft(namespace).draft?.bodyMarkdown || ''
      expect(updated).toContain('Intro with literal ## 预期行为 text.')
      expect(updated).toContain('### 预期行为')
      expect(updated).toContain('Keep the custom level-three section.')
      expect(updated).toContain('```md\n## 预期行为\ncode sample must remain untouched')
      expect(updated).toContain('mixed fence must remain inside the backtick fence\n```')
      expect(updated).toContain('~~~\nmixed fence must remain inside the backtick fence\n```')
      expect(updated).toContain('~~~~md\n```\nlong fence content must remain inside\n~~~~')
      expect(updated).toContain('    ## 预期行为\n    indented code must remain untouched')
      expect(updated).toContain('## 预期行为\n\nNew expected content.')
      expect(updated).not.toContain('## 预期行为\n\nOld expected content.')
      expect(updated).toContain('## 自定义备注\n\nKeep this custom section.')
    } finally {
      await runtime.close()
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

  it('retries one terminally failed Block Summary from the admin surface', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-summary-retry-'))
    const database = join(directory, 'memory.db')
    let shouldFail = true
    let summaryCalls = 0
    const models = {
      ...fakeModels,
      summarizer: async () => {
        summaryCalls += 1
        if (shouldFail) throw new Error('invalid API key')
        return { l0Title: 'retried', l0Tags: [], l1Summary: 'retried', l2Keypoints: [], shouldExtract: false }
      },
    } as unknown as DshModelBridge
    const runtime = new StrataGateRuntime({
      database, namespaceMode: 'project', namespacePrefix: 'dsh', globalNamespace: 'global',
      blockTurnSize: 1, blockDecayLambda: 0.3, ingestSubagents: false, maxOutputTokens: 2048,
    }, models)
    try {
      const memory = await (runtime as unknown as { space: (value: Session) => Promise<StrataGate> }).space(session)
      await memory.appendTurn({ user: 'retry this summary', assistant: 'saved', threadId: String(session.id) })
      await memory.resumePendingWork({ retryFailed: true })
      await memory.resumePendingWork({ retryFailed: true })
      const block = memory.listBlocks()[0]!
      expect(memory.listSummaryJobs()[0]).toMatchObject({ status: 'failed', attempts: 3, nextRetryAt: null })

      shouldFail = false
      const [result, duplicate] = await Promise.all([
        runtime.adminRetryBlockSummary(runtime.namespaceFor(session), block.id),
        runtime.adminRetryBlockSummary(runtime.namespaceFor(session), block.id),
      ]) as Array<{
        ready: boolean; processingStatus: string; summaryJob: { status: string; attempts: number }
      }>
      expect(result).toMatchObject({
        ready: true,
        processingStatus: 'ready',
        summaryJob: { status: 'succeeded', attempts: 1 },
      })
      expect(duplicate).toEqual(result)
      expect(summaryCalls).toBe(4)
      expect(memory.listExtractionJobs()[0]).toMatchObject({ blockId: block.id, status: 'skipped' })
    } finally {
      await runtime.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('retries Event extraction without rerunning a successful Summary', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-extraction-retry-'))
    const database = join(directory, 'memory.db')
    let shouldFail = true
    let summaryCalls = 0
    let extractionCalls = 0
    const models = {
      ...fakeModels,
      summarizer: async () => {
        summaryCalls += 1
        return { l0Title: 'event', l0Tags: [], l1Summary: 'event', l2Keypoints: [], shouldExtract: true }
      },
      extractor: async () => {
        extractionCalls += 1
        if (shouldFail) throw new Error('StrataGate structured model task timed out after 45000ms')
        return { shouldExtract: false, reason: 'nothing durable', events: [] }
      },
    } as unknown as DshModelBridge
    const runtime = new StrataGateRuntime({
      database, namespaceMode: 'project', namespacePrefix: 'dsh', globalNamespace: 'global',
      blockTurnSize: 1, blockDecayLambda: 0.3, ingestSubagents: false, maxOutputTokens: 2048,
    }, models)
    try {
      const memory = await (runtime as unknown as { space: (value: Session) => Promise<StrataGate> }).space(session)
      await memory.appendTurn({ user: 'retry extraction', assistant: 'saved', threadId: String(session.id) })
      await memory.resumePendingWork({ retryFailed: true })
      await memory.resumePendingWork({ retryFailed: true })
      const block = memory.listBlocks()[0]!
      expect(memory.listExtractionJobs()[0]).toMatchObject({ status: 'failed', attempts: 3, nextRetryAt: null })

      shouldFail = false
      const result = await runtime.adminRetryJob(runtime.namespaceFor(session), 'event-extraction', block.id) as {
        kind: string; status: string; ready: boolean
      }
      expect(result).toMatchObject({ kind: 'event-extraction', status: 'skipped', ready: true })
      expect(summaryCalls).toBe(1)
      expect(extractionCalls).toBe(4)
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
          { ref: 'project', name: 'StrataGate', type: 'project', tags: ['memory plugin'], metadataProvenance: {
            name: [event.id], tags: [{ value: 'memory plugin', sourceEventIds: [event.id] }],
          }, state: 'released', sourceEventIds: [event.id] },
          { ref: 'tool', name: 'MCP tool', type: 'tool', metadataProvenance: { name: [event.id] }, sourceEventIds: [event.id] },
          { ref: 'tool-name', name: 'StrataGate', type: 'tool', tags: ['cli'], metadataProvenance: {
            name: [event.id], tags: [{ value: 'cli', sourceEventIds: [event.id] }],
          }, sourceEventIds: [event.id] },
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

  it('keeps search, expand, auto context, and reinforcement on the same bounded effective Graph evidence', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-dsh-effective-graph-'))
    const database = join(directory, 'memory.db')
    const active = {
      ...session,
      id: 'effective-graph-session',
      header: { ...session.header, id: 'effective-graph-session' },
      deriveMessages: () => [{
        id: 'current-user', role: 'user', content: [{ type: 'text', text: '黄方以前在 B公司 吗？' }], source: { kind: 'user' },
      }],
    } as unknown as Session
    const runtime = new StrataGateRuntime({
      database, namespaceMode: 'project', namespacePrefix: 'dsh', globalNamespace: 'global',
      blockTurnSize: 1, blockDecayLambda: 0.3, ingestSubagents: false, maxOutputTokens: 2048,
    }, fakeModels)
    try {
      const memory = await (runtime as unknown as { space: (value: Session) => Promise<StrataGate> }).space(active)
      await memory.appendTurn({ user: 'Historical source block.', assistant: 'Stored.', threadId: 'older-session' })
      const block = memory.listBlocks()[0]!
      const add = (id: string, summary: string) => memory.addEvent({
        id, title: id, summary, sourceBlockId: block.id, sourceMessageIds: [block.l5Raw[0]!.id],
      })
      const currentA = await add('evt_runtime_current_a', '黄方目前在 A公司。')
      const historicalB = await add('evt_runtime_historical_b', '黄方曾经在 B公司。')
      historicalB.status = 'superseded'
      const unrelated = await add('evt_runtime_unrelated', '与查询无关的更新。')
      const forgotten = await add('evt_runtime_forgotten', 'secret-forgotten')
      await memory.forgetEvent(forgotten.id)
      const now = '2026-09-20T00:00:00.000Z'
      const nodes = memory.listGraphNodes() as GraphNode[]
      nodes.push({
        id: 'node_runtime_person', name: '黄方', type: 'person', aliases: ['HF'], currentState: 'company: B公司 stale',
        status: 'active', confidence: 0.9, sourceEventIds: [currentA.id, historicalB.id, unrelated.id, forgotten.id],
        facts: [{
          id: 'fact_runtime_a', key: '公司', value: 'A公司', status: 'active', confidence: 0.9,
          sourceEventIds: [currentA.id], createdAt: now, updatedAt: now,
        }, {
          id: 'fact_runtime_b', key: '公司', value: 'B公司', status: 'superseded', confidence: 0.9,
          sourceEventIds: [historicalB.id], createdAt: now, updatedAt: now,
        }, {
          id: 'fact_runtime_hidden', key: 'secret', value: 'secret-forgotten', status: 'active', confidence: 0.9,
          sourceEventIds: [forgotten.id], createdAt: now, updatedAt: now,
        }],
        createdAt: now, updatedAt: now,
      }, {
        id: 'node_runtime_hidden', name: 'Forgotten Node', type: 'project', aliases: [], currentState: 'secret-forgotten',
        status: 'active', confidence: 0.9, sourceEventIds: [forgotten.id], facts: [{
          id: 'fact_runtime_hidden_node', key: 'state', value: 'secret-forgotten', status: 'active', confidence: 0.9,
          sourceEventIds: [forgotten.id], createdAt: now, updatedAt: now,
        }], createdAt: now, updatedAt: now,
      }, {
        id: 'node_runtime_metadata', name: 'Metadata Entity', type: 'project', aliases: ['saferuntimealias', 'forbiddenruntime'],
        tags: ['saferuntimetag', 'forbiddenruntimetag'], currentState: '', status: 'active', confidence: 0.9,
        sourceEventIds: [currentA.id, forgotten.id], metadataProvenance: {
          name: [currentA.id],
          aliases: [
            { value: 'saferuntimealias', sourceEventIds: [currentA.id] },
            { value: 'forbiddenruntime', sourceEventIds: [forgotten.id] },
          ],
          tags: [
            { value: 'saferuntimetag', sourceEventIds: [currentA.id] },
            { value: 'forbiddenruntimetag', sourceEventIds: [forgotten.id] },
          ],
        }, facts: [], createdAt: now, updatedAt: now,
      })

      const batch = await runtime.searchGraph(active, 'B公司') as {
        batchId: string; evidenceRefs: string[]; results: Array<Record<string, unknown>>
      }
      const result = batch.results.find(({ id }) => id === 'node_runtime_person')!
      expect(result).toMatchObject({ matchType: 'historical', currentState: expect.stringContaining('A公司') })
      expect(String(result.currentState)).not.toContain('stale')
      expect(result.historicalMatches).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'fact_runtime_b' })]))
      expect(result.timeline).toEqual([
        expect.objectContaining({ id: historicalB.id, status: 'superseded' }),
        expect.objectContaining({ id: currentA.id, status: 'active' }),
      ])

      const expanded = await runtime.expandGraphNode(active, 'node_runtime_person') as {
        results: { node: { currentState: string; facts: Array<{ id: string }> }; historicalFacts: Array<{ id: string }>; provenanceEventIds: string[] }
      }
      expect(expanded.results.node.currentState).toContain('A公司')
      expect(expanded.results.node.currentState).not.toContain('stale')
      expect(expanded.results.node.facts.map(({ id }) => id)).toEqual(['fact_runtime_a'])
      expect(expanded.results.historicalFacts.map(({ id }) => id)).toEqual(['fact_runtime_b'])
      expect(expanded.results.provenanceEventIds).not.toContain(forgotten.id)
      await expect(runtime.expandGraphNode(active, 'node_runtime_hidden')).rejects.toThrow('no retrievable Event evidence')

      const context = await runtime.buildAutoContext(active)
      expect(context).toContain('"matchType":"historical"')
      expect(context).toContain('"currentState":"公司: A公司"')
      expect(context).toContain('"historicalMatches":[{"key":"公司","value":"B公司"')
      expect(context).not.toContain('stale')
      expect(context).not.toContain('secret-forgotten')

      const before = new Map(memory.listEvents().map((event) => [event.id, event.weight.mentionCount]))
      const graphRef = batch.evidenceRefs.find((ref) => ref === 'graph-node:node_runtime_person')!
      await runtime.assess(active, {
        verdict: 'sufficient', evidence_refs: [graphRef], fit: 'The matched historical fact answers the question.',
        missing: '', next_strategy: 'answer',
      }, batch.batchId)
      const recorded = await runtime.recordUse(active, 'effective-graph-use', [graphRef], batch.batchId) as { eventIds: string[] }
      expect(recorded.eventIds).toEqual([historicalB.id, currentA.id])
      expect(memory.listEvents().find(({ id }) => id === historicalB.id)?.weight.mentionCount).toBe(before.get(historicalB.id)! + 1)
      expect(memory.listEvents().find(({ id }) => id === currentA.id)?.weight.mentionCount).toBe(before.get(currentA.id)! + 1)
      expect(memory.listEvents().find(({ id }) => id === unrelated.id)?.weight.mentionCount).toBe(before.get(unrelated.id))
      expect(memory.listEvents().find(({ id }) => id === forgotten.id)?.weight.mentionCount).toBe(before.get(forgotten.id))

      const metadataSession = {
        ...active,
        id: 'effective-graph-metadata-session',
        header: { ...active.header, id: 'effective-graph-metadata-session' },
        deriveMessages: () => [{
          id: 'metadata-user', role: 'user', content: [{ type: 'text', text: 'forbiddenruntime' }], source: { kind: 'user' },
        }],
      } as unknown as Session
      const hiddenMetadata = await runtime.searchGraph(metadataSession, 'forbiddenruntime') as { results: unknown[] }
      expect(hiddenMetadata.results).toEqual([])
      const safeMetadata = await runtime.searchGraph(metadataSession, 'saferuntimealias') as { results: Array<Record<string, unknown>> }
      expect(safeMetadata.results[0]).toMatchObject({ name: 'Metadata Entity', aliases: ['saferuntimealias'], tags: ['saferuntimetag'] })
      const expandedMetadata = await runtime.expandGraphNode(metadataSession, 'node_runtime_metadata') as { results: { node: { aliases: string[]; tags?: string[] } } }
      expect(expandedMetadata.results.node.aliases).toEqual(['saferuntimealias'])
      expect(expandedMetadata.results.node.tags).toEqual(['saferuntimetag'])
      const metadataContext = await runtime.buildAutoContext(metadataSession)
      expect(metadataContext).not.toContain('forbiddenruntime')
      expect(metadataContext).not.toContain('forbiddenruntimetag')
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
          metadataProvenance: { name: [relevant.id] },
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
      append('step/start', { turn, step: 1 })
      append('user/message', createUserMessage({
        content: [{ type: 'text', text: user }], source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      append('assistant/message', {
        turn, step: 1,
        message: createAssistantMessage({
          content: [{ type: 'text', text: assistant }],
          source: { provider: 'test', model: 'test' },
        }),
      }, { surfaceOp: 'append' })
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
        source: { kind: 'plugin:stratagate-memory' },
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
      append('step/start', { turn: 3, step: 1 })
      append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'CURRENT USER SENTINEL' }], source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      append('assistant/message', {
        turn: 3, step: 1,
        message: createAssistantMessage({
          content: [{ type: 'tool-call', id: callId, name: 'inspect_workspace', arguments: '{"path":"CURRENT_TOOL_PATH"}' }],
          source: { provider: 'test', model: 'test' },
        }),
      }, { surfaceOp: 'append' })
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
      }, { surfaceOp: 'append' })
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
      expect(derived.some((message) => message.role === 'tool' && message.toolCallId === callId)).toBe(true)

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
      expect(decayedRequest).toContain('Level: L5 (L5 raw transcript)')
      expect(decayedTexts.find((text) => text.includes(`Block: ${decayed[0]!.id}`))).toContain('SEALED ORIGINAL ONE')
      expect(decayedRequest).toContain(`Block: ${decayed[1]!.id}`)
      expect(decayedRequest).toContain('Level: L5 (L5 raw transcript)')

      await nativeMemory.expandBlock(decayed[0]!.id, 'L4', 'user')
      await runtime.buildAutoContext(activeSession)
      expect(nativeMemory.getBlockContext(String(activeSession.id))[0]?.level).toBe(4)
      expect(JSON.stringify(activeSession.deriveMessages())).toContain('Level: L5 (L5 raw transcript)')
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
      const recorded = await runtime.recordUse(activeSession, 'call-audit-1', selectedRefs) as Record<string, unknown>
      expect(recorded).toMatchObject({ verdict: 'sufficient', missing: '', nextStrategy: 'answer' })
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
          metadataProvenance: { name: [event.id] },
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

function agentRuntimeConfig(database: string, extra: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    database,
    namespaceMode: 'project',
    namespacePrefix: 'dsh',
    globalNamespace: 'global',
    blockTurnSize: 1,
    blockDecayLambda: 0.3,
    ingestSubagents: false,
    maxOutputTokens: 2048,
    ...extra,
  }
}

function sessionWithId(id: string): Session {
  return {
    id,
    header: { id, version: 0, createdAt: 0, cwd: 'C:\\work\\project' },
    snapshotEvents: () => [],
    eventAt: () => undefined,
  } as unknown as Session
}

describe('DSH runtime agent memory', () => {
  it('records a long-term agent event, merges it into searchEvents, and reinforces it on use', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-agent-runtime-'))
    const runtime = new StrataGateRuntime(agentRuntimeConfig(join(directory, 'memory.db')), fakeModels)
    try {
      const recorded = await runtime.recordAgentMemory(session, '用户偏好 pnpm 作为包管理器。', 'preference') as Record<string, unknown>
      expect(recorded).toMatchObject({
        recorded: true,
        action: 'ADDED',
        gate: 'clear-new',
        namespace: expect.stringContaining('dsh:project:'),
      })
      expect(recorded.eventId).toBeDefined()

      const batch = await runtime.searchEvents(session, 'pnpm 包管理器') as {
        batchId: string
        evidenceRefs: string[]
        results: Array<Record<string, unknown>>
      }
      const eventRef = `event:${String(recorded.eventId)}`
      expect(batch.evidenceRefs).toContain(eventRef)
      expect(batch.results).toContainEqual(expect.objectContaining({
        id: recorded.eventId,
        source: 'agent-recorded',
        criticality: 'preference',
      }))

      await runtime.assess(session, {
        verdict: 'sufficient',
        evidence_refs: batch.evidenceRefs,
        fit: 'The event records the package-manager preference.',
        missing: '',
        next_strategy: 'answer',
      })
      const recordedUse = await runtime.recordUse(session, 'agent-use-1', [eventRef]) as Record<string, unknown>
      expect(recordedUse).toMatchObject({ incremented: 1 })

      const dashboard = await runtime.adminAgentMemories({ sessionId: 'session-runtime' }) as {
        items: Array<Record<string, unknown>>
      }
      expect(dashboard.items).toHaveLength(1)
      expect(dashboard.items[0]).toMatchObject({
        id: recorded.eventId,
        status: 'active',
        category: 'preference',
        content: '用户偏好 pnpm 作为包管理器。',
        sessionId: 'session-runtime',
      })
    } finally {
      await runtime.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('reinforces the existing memory instead of writing an exact duplicate', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-agent-duplicate-'))
    const runtime = new StrataGateRuntime(agentRuntimeConfig(join(directory, 'memory.db')), fakeModels)
    try {
      const first = await runtime.recordAgentMemory(session, '用户偏好 pnpm 作为包管理器。', 'preference') as Record<string, unknown>
      expect(first.action).toBe('ADDED')
      const second = await runtime.recordAgentMemory(session, '用户偏好 pnpm 作为包管理器。', 'preference') as Record<string, unknown>
      expect(second).toMatchObject({
        recorded: false,
        action: 'REINFORCED',
        gate: 'exact-duplicate',
        reinforcedEventId: first.eventId,
      })
      const dashboard = await runtime.adminAgentMemories({}) as { items: unknown[] }
      expect(dashboard.items).toHaveLength(1)
    } finally {
      await runtime.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('conflict-marks ambiguous recordings when no decider is available', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-agent-heuristic-'))
    const runtime = new StrataGateRuntime(agentRuntimeConfig(join(directory, 'memory.db')), fakeModels)
    try {
      const memory = await (runtime as unknown as { space(s: Session): Promise<StrataGate> }).space(session)
      await memory.appendTurn(
        { user: 'The deployment pipeline uses GitHub Actions.', assistant: 'Noted.' },
        { deferDerivation: true },
      )
      const block = memory.listBlocks().at(-1)!
      const passive = await memory.addEvent({
        title: 'Deployment pipeline uses GitHub Actions',
        summary: 'The deployment pipeline uses GitHub Actions for every release.',
        sourceBlockId: block.id,
        sourceMessageIds: [block.l5Raw[0]!.id],
      })

      const result = await runtime.recordAgentMemory(session, 'The deployment pipeline switched to GitLab.') as Record<string, unknown>
      expect(result).toMatchObject({
        recorded: true,
        action: 'CONFLICT_MARKED',
        gate: 'heuristic-conflict',
        existingEventIds: [passive.id],
      })
      const agentEvent = memory.listAgentEvents()[0]!
      expect(agentEvent.temporal.conflictsWithEventIds).toEqual([passive.id])
      const passiveAfter = memory.listEvents().find(({ id }) => id === passive.id)!
      expect(passiveAfter.temporal.conflictsWithEventIds).toEqual([agentEvent.id])
      expect(passiveAfter.status).toBe('active')
    } finally {
      await runtime.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('runs the external-memory decider once for ambiguous facts and supersedes across pools', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-agent-decider-'))
    const decider = vi.fn(async ({ matches }: { matches: Array<{ event: { id: string } }> }) => ({
      action: 'SUPERSEDE',
      existingEventIds: [matches[0]!.event.id],
      confidence: 0.92,
      reason: '明确的新状态',
    }))
    const models = { ...fakeModels, externalMemoryDecider: decider } as unknown as DshModelBridge
    const runtime = new StrataGateRuntime(agentRuntimeConfig(join(directory, 'memory.db')), models)
    try {
      const memory = await (runtime as unknown as { space(s: Session): Promise<StrataGate> }).space(session)
      await memory.appendTurn(
        { user: 'The deployment pipeline uses GitHub Actions.', assistant: 'Noted.' },
        { deferDerivation: true },
      )
      const block = memory.listBlocks().at(-1)!
      const passive = await memory.addEvent({
        title: 'Deployment pipeline uses GitHub Actions',
        summary: 'The deployment pipeline uses GitHub Actions for every release.',
        sourceBlockId: block.id,
        sourceMessageIds: [block.l5Raw[0]!.id],
      })

      const result = await runtime.recordAgentMemory(session, 'The deployment pipeline switched to GitLab.') as Record<string, unknown>
      expect(decider).toHaveBeenCalledTimes(1)
      expect(result).toMatchObject({
        action: 'SUPERSEDED',
        gate: 'decider',
        confidence: 0.92,
        reason: '明确的新状态',
        existingEventIds: [passive.id],
      })
      const passiveAfter = memory.listEvents().find(({ id }) => id === passive.id)!
      expect(passiveAfter.status).toBe('superseded')
      expect(passiveAfter.supersededBy).toBe(result.eventId)
      expect(passiveAfter.weight.forcedCap).toBe(0.1)
    } finally {
      await runtime.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('keeps recorded memories across restarts and available to later sessions', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-agent-persist-'))
    const database = join(directory, 'memory.db')
    const first = new StrataGateRuntime(agentRuntimeConfig(database), fakeModels)
    const recorded = await first.recordAgentMemory(session, '用户偏好 pnpm 作为包管理器。', 'preference') as Record<string, unknown>
    await first.close()

    const second = new StrataGateRuntime(agentRuntimeConfig(database), fakeModels)
    try {
      // Long-term memory: another session finds the recorded event.
      const otherBatch = await second.searchEvents(sessionWithId('session-other'), 'pnpm') as {
        evidenceRefs: string[]
      }
      expect(otherBatch.evidenceRefs).toContain(`event:${String(recorded.eventId)}`)
      const dashboard = await second.adminAgentMemories({}) as {
        items: Array<Record<string, unknown>>
      }
      expect(dashboard.items).toHaveLength(1)
      expect(dashboard.items[0]).toMatchObject({ sessionId: 'session-runtime' })
    } finally {
      await second.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects recording and surfacing when the feature is disabled', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-agent-disabled-'))
    const runtime = new StrataGateRuntime(agentRuntimeConfig(join(directory, 'memory.db'), { agentMemoryEnabled: false }), fakeModels)
    try {
      expect(runtime.agentMemoryEnabled).toBe(false)
      await expect(runtime.recordAgentMemory(session, '用户偏好 pnpm。')).rejects.toThrow('agentMemoryEnabled=false')
      const dashboard = await runtime.adminAgentMemories({ includeArchived: true }) as { items: unknown[] }
      expect(dashboard.items).toEqual([])
    } finally {
      await runtime.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('applies the configured agent memory retrieval weight to merged search', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-agent-weight-'))
    const runtime = new StrataGateRuntime(
      agentRuntimeConfig(join(directory, 'memory.db'), { agentMemoryRetrievalWeight: 0 }),
      fakeModels,
    )
    try {
      const recorded = await runtime.recordAgentMemory(session, '用户偏好 pnpm 作为包管理器。', 'preference') as Record<string, unknown>
      expect(recorded.action).toBe('ADDED')
      // Weight 0 keeps the recording stored but never surfaced through search.
      const batch = await runtime.searchEvents(session, 'pnpm 包管理器') as { evidenceRefs: string[] }
      expect(batch.evidenceRefs).not.toContain(`event:${String(recorded.eventId)}`)
      const dashboard = await runtime.adminAgentMemories({}) as { items: unknown[] }
      expect(dashboard.items).toHaveLength(1)
    } finally {
      await runtime.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('tunes the agent retrieval weight at runtime and restores it after a restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-agent-weight-knob-'))
    const database = join(directory, 'memory.db')
    const first = new StrataGateRuntime(agentRuntimeConfig(database), fakeModels)
    try {
      const recorded = await first.recordAgentMemory(session, '用户偏好 pnpm 作为包管理器。', 'preference') as Record<string, unknown>
      const eventRef = `event:${String(recorded.eventId)}`
      expect((await first.searchEvents(session, 'pnpm 包管理器') as { evidenceRefs: string[] }).evidenceRefs).toContain(eventRef)
      expect(await first.adminSetAgentMemoryRetrievalWeight(0)).toBe(0)
      expect((await first.searchEvents(session, 'pnpm 包管理器') as { evidenceRefs: string[] }).evidenceRefs).not.toContain(eventRef)
      expect(() => first.adminSetAgentMemoryRetrievalWeight(9)).toThrow('between 0 and 5')
      await first.close()

      // The knob is persisted next to the Block settings and restored on startup.
      const second = new StrataGateRuntime(agentRuntimeConfig(database), fakeModels)
      try {
        await second.syncConfiguredSettings()
        expect(second.adminAgentMemoryRetrievalWeight()).toBe(0)
        expect((await second.searchEvents(session, 'pnpm 包管理器') as { evidenceRefs: string[] }).evidenceRefs).not.toContain(eventRef)
      } finally {
        await second.close()
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
