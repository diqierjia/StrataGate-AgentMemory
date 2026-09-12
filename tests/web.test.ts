import { describe, expect, it } from 'vitest'
import type { StrataGateSnapshot } from '@diqier/stratagate'
import type { StrataGateRuntime } from '../src/runtime.js'
import { handleAdminRequest, type WebResponse } from '../src/web.js'

const fullFailure = 'StrataGate model response was not valid JSON\nRaw response (full):\n' + 'x'.repeat(600)

const snapshot: StrataGateSnapshot = {
  schemaVersion: 10,
  currentTurn: 8,
  blockTurnSize: 4,
  blockDecayLambda: 0.3,
  openTail: [],
  blocks: [{
    id: 'blk_1',
    sequence: 1,
    startTurn: 1,
    endTurn: 4,
    createdAt: '2026-08-18T00:00:00.000Z',
    shouldExtract: true,
    l0Title: 'Package manager',
    l0Tags: ['pnpm'],
    l1Summary: 'Use pnpm for this project.',
    l2Keypoints: ['pnpm'],
    l3Condensed: 'Use pnpm.',
    l4Readable: 'Use pnpm.',
    l5Raw: [{
      id: 'msg_1',
      role: 'user',
      content: 'Use pnpm. api_key=super-secret-value',
      createdAt: '2026-08-18T00:00:00.000Z',
      toolCalls: [{ name: 'fetch', arguments: { authorization: 'Bearer abcdefghijklmnop' } }],
    }],
    pointerCurrentLevel: 5,
    pointerAnchorLevel: 5,
    pointerAnchorBlockPosition: 1,
    lastLiftedAt: null,
    lastLiftedBy: null,
    processingStatus: 'ready',
  }],
  summaryJobs: [],
  events: [{
    id: 'evt_1',
    title: 'Use pnpm',
    summary: 'The project uses pnpm.',
    narrative: 'The user selected pnpm.',
    tags: ['pnpm'],
    quotes: ['Use pnpm.'],
    sourceMessageIds: ['msg_1'],
    sourceBlockId: 'blk_1',
    temporal: {},
    scope: 'project',
    criticality: 'routine',
    confidence: 0.95,
    status: 'active',
    supersededBy: null,
    weight: { mentionCount: 1, lastAdoptedTurn: 8, lastRetrievedAt: null, pinned: false, floorWeight: 0, forcedCap: null },
    createdAt: '2026-08-18T00:00:00.000Z',
    updatedAt: '2026-08-18T00:00:00.000Z',
  }],
  graphNodes: [{
    id: 'node_1', name: 'pnpm', type: 'tool', aliases: [], currentState: '项目包管理器', facts: [],
    status: 'active', confidence: 0.95, sourceEventIds: ['evt_1'],
    createdAt: '2026-08-18T00:00:00.000Z', updatedAt: '2026-08-18T00:00:00.000Z',
  }],
  graphEdges: [],
  graphProjectionJobs: [{
    id: 'gproj_1', sourceEventIds: ['evt_1'], projectorVersion: 1, status: 'completed', attempts: 1,
    priority: 1, nodeIds: ['node_1'], edgeIds: [], reason: 'projected', lastError: null,
    createdAt: '2026-08-18T00:00:00.000Z', updatedAt: '2026-08-18T00:00:00.000Z',
  }],
  elements: [{
    id: 'el_1',
    name: 'pnpm',
    type: 'tool',
    aliases: [],
    currentState: 'The project package manager.',
    facts: [],
    sourceEventIds: ['evt_1'],
    sourceMessageIds: ['msg_1'],
    weight: { mentionCount: 1, lastAdoptedTurn: 8, lastRetrievedAt: null, pinned: false, floorWeight: 0, forcedCap: null },
    createdAt: '2026-08-18T00:00:00.000Z',
    updatedAt: '2026-08-18T00:00:00.000Z',
  }],
  extractionJobs: [{
    blockId: 'blk_1',
    status: 'succeeded',
    attempts: 1,
    lastError: null,
    nextRetryAt: null,
    updatedAt: '2026-08-18T00:01:00.000Z',
  }, {
    blockId: 'blk_failed', status: 'failed', attempts: 2, lastError: fullFailure, nextRetryAt: null, updatedAt: '2026-08-18T00:02:00.000Z',
  }],
  elementProjectionJobs: [],
  usageReceipts: [{
    id: 'dsh:s1:tool:c1',
    eventIds: ['evt_1'],
    elementIds: [],
    audit: {
      sessionId: 's1',
      turn: 8,
      batchId: 'batch_4',
      evidenceRefs: ['event:evt_1'],
      verdict: 'sufficient',
      fit: 'Direct project decision.',
      missing: '',
      nextStrategy: 'answer',
    },
    createdAt: '2026-08-18T00:01:00.000Z',
  }],
  ingestionReceipts: [],
  externalMemoryImportJobs: [],
}

let updatedLambda: number | null = null
let updatedTurnSize: number | null = null
let expandedBlock: { namespace: string; id: string; target: string | number } | null = null
const runtime = {
  adminNamespaces: async () => ['dsh:project:test'],
  adminSnapshot: async (namespace: string) => namespace === 'dsh:project:test' ? snapshot : null,
  adminSnapshotEntries: async () => [{ namespace: 'dsh:project:test', revision: 7, snapshot }],
  adminWorkspaceName: () => 'StrataGate',
  adminSetBlockTurnSize: async (value: number) => {
    updatedTurnSize = value
    return value
  },
  adminSetBlockDecayLambda: async (value: number) => {
    updatedLambda = value
    return value
  },
  adminExpandBlock: async (namespace: string, id: string, target: string | number) => {
    expandedBlock = { namespace, id, target }
    return { id, level: Number(String(target).replace(/^L/i, '')) }
  },
} as unknown as StrataGateRuntime

const waitingRuntime = {
  adminNamespaces: async () => ['dsh:project:waiting'],
  adminSnapshot: async (namespace: string) => namespace === 'dsh:project:waiting'
    ? { ...snapshot, blocks: snapshot.blocks.map((block) => ({ ...block, shouldExtract: true })), extractionJobs: [] }
    : null,
} as unknown as StrataGateRuntime

const skippedRuntime = {
  adminNamespaces: async () => ['dsh:project:skipped'],
  adminSnapshot: async (namespace: string) => namespace === 'dsh:project:skipped'
    ? { ...snapshot, blocks: snapshot.blocks.map((block) => ({ ...block, shouldExtract: false })), extractionJobs: [] }
    : null,
} as unknown as StrataGateRuntime

async function request(url: string, method = 'GET', targetRuntime = runtime, body?: unknown, requestHeaders?: Record<string, string>): Promise<{ status: number; body: any; headers: Record<string, string> }> {
  const headers: Record<string, string> = {}
  let text = ''
  const response: WebResponse = {
    statusCode: 0,
    setHeader: (name, value) => { headers[name] = value },
    end: (body) => { text = body },
  }
  await handleAdminRequest(targetRuntime, { method, url, body, ...(requestHeaders ? { headers: requestHeaders } : {}) }, response)
  return { status: response.statusCode, body: text ? JSON.parse(text) : null, headers }
}

describe('StrataGate admin routes', () => {
  it('reads and saves local feedback drafts through the feedback route', async () => {
    const calls: unknown[] = []
    const feedbackRuntime = {
      adminFeedbackDraft: (namespace: string) => ({ namespace, draft: { title: 'Existing', description: 'Saved locally.' } }),
      adminSaveFeedbackDraft: (namespace: string, draft: unknown) => {
        calls.push({ namespace, draft })
        return { namespace, draft }
      },
    } as unknown as StrataGateRuntime
    const read = await request('/api/stratagate/feedback?namespace=dsh%3Aproject%3Atest', 'GET', feedbackRuntime)
    expect(read).toMatchObject({ status: 200, body: { namespace: 'dsh:project:test', draft: { title: 'Existing' } } })

    const saved = await request('/api/stratagate/feedback', 'PUT', feedbackRuntime, {
      namespace: 'dsh:project:test',
      title: 'Edited title',
      bodyMarkdown: '## 问题描述\n\nEdited locally.',
      unrelated: 'ignored',
    })
    expect(saved.status).toBe(200)
    expect(calls).toEqual([{ namespace: 'dsh:project:test', draft: {
      title: 'Edited title',
      bodyMarkdown: '## 问题描述\n\nEdited locally.',
    } }])
  })

  it('supports preview, commit, and undo through the import route', async () => {
    const received: unknown[] = []
    const importRuntime = {
      adminPreviewExternalMemory: async (namespace: string, text: string) => {
        received.push({ operation: 'preview', namespace, text }); return { jobId: 'job-1', status: 'processing' }
      },
      adminExternalMemoryStatus: async (namespace: string, jobId?: string) => {
        received.push({ operation: 'status', namespace, jobId }); return { jobId: 'job-1', status: 'processing' }
      },
      adminRetryExternalMemory: async (namespace: string, jobId: string) => {
        received.push({ operation: 'retry', namespace, jobId }); return { jobId, status: 'processing' }
      },
      adminCommitExternalMemory: async (namespace: string, jobId: string, choices: Array<{ index: number; action: string }>) => {
        received.push({ operation: 'commit', namespace, jobId, choices }); return { importedCount: 2, sourceBlockId: 'blk_import' }
      },
      adminUndoExternalMemory: async (namespace: string, sourceBlockId: string) => {
        received.push({ operation: 'undo', namespace, sourceBlockId }); return { removedEventIds: ['evt_1'] }
      },
    } as unknown as StrataGateRuntime
    const preview = await request('/api/stratagate/import', 'POST', importRuntime, {
      operation: 'preview', namespace: 'dsh:project:test',
      text: '{"schemaVersion":"stratagate.external-memory.v2","candidates":[]}',
    })
    const status = await request('/api/stratagate/import', 'POST', importRuntime, {
      operation: 'status', namespace: 'dsh:project:test', jobId: 'job-1',
    })
    const getStatus = await request('/api/stratagate/import?operation=status&namespace=dsh%3Aproject%3Atest&jobId=job-1', 'GET', importRuntime)
    const commit = await request('/api/stratagate/import', 'POST', importRuntime, {
      operation: 'commit', namespace: 'dsh:project:test', jobId: 'job-1', choices: [{ index: 1, action: 'CONFLICT' }],
    })
    const undo = await request('/api/stratagate/import', 'POST', importRuntime, {
      operation: 'undo', namespace: 'dsh:project:test', sourceBlockId: 'blk_import',
    })
    expect(preview).toMatchObject({ status: 200, body: { jobId: 'job-1', status: 'processing' } })
    expect(status).toMatchObject({ status: 200, body: { jobId: 'job-1', status: 'processing' } })
    expect(getStatus).toMatchObject({ status: 200, body: { jobId: 'job-1', status: 'processing' } })
    expect(commit).toMatchObject({ status: 200, body: { importedCount: 2 } })
    expect(undo).toMatchObject({ status: 200, body: { removedEventIds: ['evt_1'] } })
    expect(received).toHaveLength(5)
  })

  it('serves the complete external memory export prompt', async () => {
    const result = await request('/api/stratagate/import')
    expect(result).toMatchObject({ status: 200, body: { schemaVersion: 'stratagate.external-memory.v2' } })
    expect(result.body.prompt).toContain('一、记忆类型')
    expect(result.body.prompt).toContain('sourceType')
    expect(result.body.prompt).toContain('如果没有符合条件的长期记忆，请输出')
  })

  it('does not label a block without an extraction job as actively processing', async () => {
    const result = await request('/api/stratagate/memories?namespace=dsh%3Aproject%3Awaiting&kind=blocks', 'GET', waitingRuntime)
    expect(result.body.items[0]).toMatchObject({ status: 'waiting', eventExtraction: null })
    const skipped = await request('/api/stratagate/memories?namespace=dsh%3Aproject%3Askipped&kind=blocks', 'GET', skippedRuntime)
    expect(skipped.body.items[0]).toMatchObject({ status: 'organized', eventExtraction: null })
  })

  it('reports Summary jobs in overview and Block processing state', async () => {
    const pendingBlock = {
      ...snapshot.blocks[0]!,
      processingStatus: 'pending' as const,
      shouldExtract: undefined,
      l0Title: undefined,
      l0Tags: undefined,
      l1Summary: undefined,
      l2Keypoints: undefined,
    }
    const summaryFailure = 'Summary model timed out'
    let retriedBlock: { namespace: string; blockId: string } | null = null
    const summaryRuntime = {
      adminNamespaces: async () => ['dsh:project:summary'],
      adminSnapshot: async () => ({
        ...snapshot,
        blocks: [pendingBlock],
        summaryJobs: [{
          blockId: 'blk_1', status: 'failed' as const, attempts: 3, lastError: summaryFailure,
          nextRetryAt: null, updatedAt: '2026-08-18T00:03:00.000Z',
        }],
        extractionJobs: [],
        graphProjectionJobs: [],
      }),
      adminWorkspaceName: () => 'Summary workspace',
      adminRetryBlockSummary: async (namespace: string, blockId: string) => {
        retriedBlock = { namespace, blockId }
        return { blockId, ready: true, processingStatus: 'ready', summaryJob: { status: 'succeeded' } }
      },
    } as unknown as StrataGateRuntime

    const overview = await request('/api/stratagate/overview', 'GET', summaryRuntime)
    expect(overview.body.namespaces[0]).toMatchObject({
      failedJobs: 1,
      processingJobs: 0,
      failedJobDetails: [{
        id: 'blk_1', kind: 'block-summary', attempts: 3,
        lastError: summaryFailure, lastErrorFull: summaryFailure,
      }],
    })

    const failed = await request('/api/stratagate/memories?namespace=dsh%3Aproject%3Asummary&kind=blocks', 'GET', summaryRuntime)
    expect(failed.body.items[0]).toMatchObject({ status: 'failed', processingStatus: 'pending', summaryJob: { status: 'failed' } })

    const retried = await request('/api/stratagate/blocks/retry-summary?namespace=dsh%3Aproject%3Asummary&blockId=blk_1', 'POST', summaryRuntime)
    expect(retried).toMatchObject({ status: 200, body: { blockId: 'blk_1', ready: true, summaryJob: { status: 'succeeded' } } })
    expect(retriedBlock).toEqual({ namespace: 'dsh:project:summary', blockId: 'blk_1' })

    const runningRuntime = {
      ...summaryRuntime,
      adminSnapshot: async () => ({
        ...snapshot,
        blocks: [pendingBlock],
        summaryJobs: [{
          blockId: 'blk_1', status: 'running' as const, attempts: 1, lastError: null,
          nextRetryAt: null, updatedAt: '2026-08-18T00:03:00.000Z',
        }],
        extractionJobs: [],
        graphProjectionJobs: [],
      }),
    } as unknown as StrataGateRuntime
    const running = await request('/api/stratagate/memories?namespace=dsh%3Aproject%3Asummary&kind=blocks', 'GET', runningRuntime)
    expect(running.body.items[0]).toMatchObject({ status: 'processing', processingStatus: 'pending', summaryJob: { status: 'running' } })

    const extractionFailureRuntime = {
      ...summaryRuntime,
      adminSnapshot: async () => ({
        ...snapshot,
        blocks: [{ ...pendingBlock, shouldExtract: true }],
        summaryJobs: [{
          blockId: 'blk_1', status: 'succeeded' as const, attempts: 1, lastError: null,
          nextRetryAt: null, updatedAt: '2026-08-18T00:03:00.000Z',
        }],
        extractionJobs: [{
          blockId: 'blk_1', status: 'failed' as const, attempts: 3, lastError: 'Extraction failed',
          nextRetryAt: null, updatedAt: '2026-08-18T00:04:00.000Z',
        }],
        graphProjectionJobs: [],
      }),
    } as unknown as StrataGateRuntime
    const extractionFailure = await request('/api/stratagate/memories?namespace=dsh%3Aproject%3Asummary&kind=blocks', 'GET', extractionFailureRuntime)
    expect(extractionFailure.body.items[0]).toMatchObject({ status: 'failed', processingStatus: 'pending', summaryJob: { status: 'succeeded' } })
  })

  it('rejects Block Summary retries while the job is not failed', async () => {
    const retryingRuntime = {
      adminSnapshot: async () => ({
        ...snapshot,
        summaryJobs: [{
          blockId: 'blk_1', status: 'running' as const, attempts: 1, lastError: null,
          nextRetryAt: null, updatedAt: '2026-08-18T00:04:00.000Z',
        }],
      }),
    } as unknown as StrataGateRuntime
    const result = await request('/api/stratagate/blocks/retry-summary?namespace=dsh%3Aproject%3Asummary&blockId=blk_1', 'POST', retryingRuntime)
    expect(result).toMatchObject({ status: 409, body: { error: 'Block Summary is running, not failed' } })
  })

  it('retries a specific failed job through the unified endpoint and reports model failures', async () => {
    const calls: Array<{ namespace: string; kind: string; jobId: string }> = []
    const failedSnapshot = {
      ...snapshot,
      blocks: [{ ...snapshot.blocks[0]!, processingStatus: 'pending' as const, threadId: 'thread-retry' }],
      summaryJobs: [],
      extractionJobs: [{
        blockId: 'blk_1', status: 'failed' as const, attempts: 3,
        lastError: 'StrataGate structured model task timed out after 45000ms', nextRetryAt: null,
        updatedAt: '2026-08-18T00:04:00.000Z',
      }],
      graphProjectionJobs: [{
        ...snapshot.graphProjectionJobs[0]!, id: 'gproj_failed', status: 'failed' as const,
        attempts: 2, lastError: 'graph failed', nodeIds: [],
      }],
    }
    const retryRuntime = {
      adminSnapshot: async () => failedSnapshot,
      adminRetryJob: async (namespace: string, kind: string, jobId: string) => {
        calls.push({ namespace, kind, jobId })
        if (kind === 'graph-projection') throw new Error('graph timed out again')
        return { kind, jobId, status: 'succeeded' }
      },
    } as unknown as StrataGateRuntime

    const extraction = await request('/api/stratagate/jobs/retry?namespace=dsh%3Aproject%3Atest&kind=event-extraction&jobId=blk_1', 'POST', retryRuntime)
    expect(extraction).toMatchObject({ status: 200, body: { kind: 'event-extraction', jobId: 'blk_1', status: 'succeeded' } })
    const graph = await request('/api/stratagate/jobs/retry?namespace=dsh%3Aproject%3Atest&kind=graph-projection&jobId=gproj_failed', 'POST', retryRuntime)
    expect(graph).toMatchObject({ status: 422, body: { error: 'graph timed out again' } })
    expect(calls).toEqual([
      { namespace: 'dsh:project:test', kind: 'event-extraction', jobId: 'blk_1' },
      { namespace: 'dsh:project:test', kind: 'graph-projection', jobId: 'gproj_failed' },
    ])

    const running = await request('/api/stratagate/jobs/retry?namespace=dsh%3Aproject%3Atest&kind=event-extraction&jobId=blk_1', 'POST', {
      adminSnapshot: async () => ({
        ...failedSnapshot,
        extractionJobs: [{ ...failedSnapshot.extractionJobs[0]!, status: 'running' as const }],
      }),
    } as unknown as StrataGateRuntime)
    expect(running).toMatchObject({ status: 409, body: { error: 'event-extraction job is running, not failed' } })

    const overview = await request('/api/stratagate/overview', 'GET', {
      adminNamespaces: async () => ['dsh:project:test'],
      adminSnapshot: async () => failedSnapshot,
      adminWorkspaceName: () => 'Retry workspace',
    } as unknown as StrataGateRuntime)
    expect(overview.body.namespaces[0].failedJobDetails).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'event-extraction', id: 'blk_1', nextRetryAt: null,
        blockIds: ['blk_1'], threadIds: ['thread-retry'], turnRange: [1, 4],
      }),
      expect.objectContaining({
        kind: 'graph-projection', id: 'gproj_failed', nextRetryAt: null,
        blockIds: ['blk_1'], threadIds: ['thread-retry'], sourceEventIds: ['evt_1'],
      }),
    ]))
  })

  it('summarizes namespaces and returns paginated memories', async () => {
    const overview = await request('/api/stratagate/overview')
    expect(overview.status).toBe(200)
    expect(overview.body).toMatchObject({
      readonly: true,
      settingsWritable: true,
      namespaces: [{
        workspaceName: 'StrataGate',
        blockTurnSize: 4,
        blockDecayLambda: 0.3,
        events: 1,
        usageReceipts: 1,
        memoryUseCount: 1,
        failedJobs: 1,
        processingJobs: 0,
        failedJobDetails: [{
          kind: 'event-extraction',
          attempts: 2,
          lastError: fullFailure.slice(0, 500),
          lastErrorFull: fullFailure,
        }],
      }],
    })
    expect(overview.headers['Cache-Control']).toBe('no-store')

    const memories = await request('/api/stratagate/memories?namespace=dsh%3Aproject%3Atest&kind=events&q=pnpm')
    expect(memories.body).toMatchObject({ total: 1, items: [{ id: 'evt_1', title: 'Use pnpm', relatedElements: [{ id: 'el_1', name: 'pnpm' }] }] })

    const graph = await request('/api/stratagate/memories?namespace=dsh%3Aproject%3Atest&kind=graph')
    expect(graph.body).toMatchObject({
      projectorVersion: 1,
      migration: { projected: 1, total: 1, complete: true },
      nodes: [{ id: 'node_1', name: 'pnpm', supportingEvents: [{ id: 'evt_1' }] }],
      edges: [],
      clusters: [{ label: '未连接节点', nodeIds: ['node_1'] }],
    })

    const blocks = await request('/api/stratagate/memories?namespace=dsh%3Aproject%3Atest&kind=blocks')
    expect(blocks.body).toMatchObject({
      activeThreadId: '__legacy__',
      conversations: [{ id: '__legacy__', label: '历史对话', blocks: 1 }],
      openBlock: { turnRange: null, status: 'open' },
      items: [{
        id: 'blk_1',
        blockIndex: 1,
        currentLevel: 5,
        compressionPercent: 100,
        distanceFromLatest: 0,
        expansionSource: null,
        processingStatus: 'ready',
        status: 'organized',
        eventExtraction: { status: 'succeeded' },
        relatedEvents: [{ id: 'evt_1' }],
        relatedNodes: [{ id: 'node_1' }],
      }],
    })
    expect(blocks.body.blockTurnSize).toBe(4)
    expect(blocks.body.items[0].currentTokens).toBe(blocks.body.items[0].l5Tokens)
    expect(blocks.body.items[0].layerTokens).toHaveLength(6)
    expect(blocks.body.items[0].layerTokens.find(({ level }: { level: number }) => level === 5)).toMatchObject({ percentOfL5: 100 })
  })

  it('serves one revision-aware dashboard snapshot and returns 304 when unchanged', async () => {
    const first = await request('/api/stratagate/dashboard?namespace=dsh%3Aproject%3Atest')
    expect(first).toMatchObject({
      status: 200,
      body: {
        namespace: 'dsh:project:test',
        revision: 7,
        processing: false,
        data: {
          events: [{ id: 'evt_1' }],
          graph: { nodes: [{ id: 'node_1' }] },
          blocks: [{ id: 'blk_1' }],
          audit: [{ id: 'dsh:s1:tool:c1' }],
          pagination: {
            events: { total: 1, offset: 0, limit: 40 },
            blocks: { total: 1, offset: 0, limit: 40 },
            audit: { total: 1, offset: 0, limit: 100 },
          },
        },
      },
    })
    expect(first.headers.ETag).toMatch(/^"[A-Za-z0-9_-]+"$/)
    expect(first.headers['Cache-Control']).toBe('private, no-cache')

    const unchanged = await request(
      '/api/stratagate/dashboard?namespace=dsh%3Aproject%3Atest',
      'GET',
      runtime,
      undefined,
      { 'if-none-match': first.headers.ETag! },
    )
    expect(unchanged).toMatchObject({ status: 304, body: null, headers: { ETag: first.headers.ETag } })
  })

  it('filters short-term Blocks and the open tail by the selected conversation', async () => {
    const first = {
      ...snapshot.blocks[0]!,
      threadId: 'thread-a',
      l5Raw: snapshot.blocks[0]!.l5Raw.map((message) => ({ ...message, threadId: 'thread-a' })),
    }
    const second = {
      ...snapshot.blocks[0]!,
      id: 'blk_2',
      threadId: 'thread-b',
      sequence: 2,
      l0Title: 'Second conversation',
      l5Raw: [{ ...snapshot.blocks[0]!.l5Raw[0]!, id: 'msg_2', threadId: 'thread-b', content: 'Second conversation prompt' }],
    }
    const threadedRuntime = {
      adminSnapshot: async () => ({
        ...snapshot,
        blocks: [first, second],
        openTail: [{ id: 'open_1', threadId: 'thread-b', role: 'user' as const, content: 'Continue second conversation', createdAt: '2026-08-19T00:00:00.000Z' }],
      }),
    } as unknown as StrataGateRuntime

    const firstResult = await request('/api/stratagate/memories?namespace=threaded&kind=blocks&threadId=thread-a', 'GET', threadedRuntime)
    expect(firstResult.body).toMatchObject({ activeThreadId: 'thread-a', items: [{ id: 'blk_1' }], openBlock: { turnRange: null } })
    expect(firstResult.body.items).toHaveLength(1)

    const secondResult = await request('/api/stratagate/memories?namespace=threaded&kind=blocks&threadId=thread-b', 'GET', threadedRuntime)
    expect(secondResult.body).toMatchObject({ activeThreadId: 'thread-b', items: [{ id: 'blk_2' }], openBlock: { turnRange: [5, 5] } })
    expect(secondResult.body.conversations.map(({ id }: { id: string }) => id)).toEqual(['thread-b', 'thread-a'])
  })

  it('maps Block and open progress to receipt-backed DSH Turn numbers when turns have gaps', async () => {
    const messages = [
      { id: 'gap-u1', role: 'user' as const, content: 'First remembered turn', threadId: 'thread-gap', createdAt: '2026-08-20T00:00:00.000Z' },
      { id: 'gap-a1', role: 'assistant' as const, content: 'First answer', threadId: 'thread-gap', createdAt: '2026-08-20T00:00:00.000Z' },
      { id: 'gap-u2', role: 'user' as const, content: 'Second remembered turn', threadId: 'thread-gap', createdAt: '2026-08-20T00:02:00.000Z' },
      { id: 'gap-a2', role: 'assistant' as const, content: 'Second answer', threadId: 'thread-gap', createdAt: '2026-08-20T00:02:00.000Z' },
    ]
    const gapRuntime = {
      adminSnapshot: async () => ({
        ...snapshot,
        blockTurnSize: 2,
        blocks: [{ ...snapshot.blocks[0]!, threadId: 'thread-gap', startTurn: 1, endTurn: 2, l5Raw: messages }],
        openTail: [
          { id: 'gap-u3', role: 'user' as const, content: 'Open remembered turn', threadId: 'thread-gap', createdAt: '2026-08-20T00:04:00.000Z' },
          { id: 'gap-a3', role: 'assistant' as const, content: 'Open answer', threadId: 'thread-gap', createdAt: '2026-08-20T00:04:00.000Z' },
        ],
        ingestionReceipts: [
          { id: 'dsh:thread-gap:turn:3', createdAt: '2026-08-20T00:00:00.000Z' },
          { id: 'dsh:thread-gap:turn:5', createdAt: '2026-08-20T00:02:00.000Z' },
          { id: 'dsh:thread-gap:turn:7', createdAt: '2026-08-20T00:04:00.000Z' },
        ],
      }),
    } as unknown as StrataGateRuntime
    const result = await request('/api/stratagate/memories?namespace=gaps&kind=blocks&threadId=thread-gap', 'GET', gapRuntime)
    expect(result.body).toMatchObject({
      items: [{ id: 'blk_1', turnRange: [3, 5] }],
      openBlock: { turnRange: [7, 7], turns: 1, capacity: 2 },
    })
  })

  it('recovers legacy conversation boundaries from ingestion receipts without rewriting mixed Blocks', async () => {
    const mixed = {
      ...snapshot.blocks[0]!,
      l5Raw: [
        { id: 'a-user', role: 'user' as const, content: 'Alpha question', createdAt: '2026-08-18T00:00:00.000Z' },
        { id: 'a-assistant', role: 'assistant' as const, content: 'Alpha answer', createdAt: '2026-08-18T00:00:00.000Z' },
        { id: 'b-user', role: 'user' as const, content: 'Beta question', createdAt: '2026-08-18T01:00:00.000Z' },
        { id: 'b-assistant', role: 'assistant' as const, content: 'Beta answer', createdAt: '2026-08-18T01:00:00.000Z' },
      ],
    }
    const recoveredRuntime = {
      adminSnapshot: async () => ({
        ...snapshot,
        blocks: [mixed],
        openTail: [],
        ingestionReceipts: [
          { id: 'dsh:session-alpha:turn:1', createdAt: '2026-08-18T00:00:00.000Z' },
          { id: 'dsh:session-beta:turn:1', createdAt: '2026-08-18T01:00:00.000Z' },
        ],
      }),
    } as unknown as StrataGateRuntime

    const alpha = await request('/api/stratagate/memories?namespace=recovered&kind=blocks&threadId=session-alpha', 'GET', recoveredRuntime)
    expect(alpha.body).toMatchObject({
      activeThreadId: 'session-alpha',
      items: [{ id: expect.stringContaining('virtual:blk_1:'), threadId: 'session-alpha', virtual: true, turnRange: [1, 1] }],
    })
    expect(alpha.body.conversations.map(({ id }: { id: string }) => id)).toEqual(['session-beta', 'session-alpha'])
    expect(alpha.body.conversations.some(({ id }: { id: string }) => id === '__legacy__')).toBe(false)

    const detail = await request(`/api/stratagate/sources?namespace=recovered&blockId=${encodeURIComponent(alpha.body.items[0].id)}`, 'GET', recoveredRuntime)
    expect(detail.body).toMatchObject({ virtual: true, messages: [{ id: 'a-user' }, { id: 'a-assistant' }] })
    expect(detail.body.layers[5].content).toContain('Alpha question')
    expect(detail.body.layers[5].content).not.toContain('Beta question')

    const emptyHostSession = await request('/api/stratagate/memories?namespace=recovered&kind=blocks&threadId=session-without-memory', 'GET', recoveredRuntime)
    expect(emptyHostSession.body).toMatchObject({ activeThreadId: 'session-without-memory', items: [], openBlock: { messages: 0 } })
  })

  it('expands source evidence with server-side secret redaction', async () => {
    const result = await request('/api/stratagate/sources?namespace=dsh%3Aproject%3Atest&eventId=evt_1')
    expect(result.status).toBe(200)
    expect(result.body.messages[0].content).toBe('Use pnpm. api_key=[REDACTED]')
    expect(result.body.messages[0].toolCalls[0].arguments.authorization).toBe('Bearer [REDACTED]')
  })

  it('reports the actual decayed layer and its size relative to L5', async () => {
    const layerRuntime = {
      adminSnapshot: async () => ({
        ...snapshot,
        blocks: [{
          ...snapshot.blocks[0]!,
          threadId: 'thread-layer',
          pointerAnchorLevel: 4 as const,
          l5Raw: snapshot.blocks[0]!.l5Raw.map((message) => ({ ...message, threadId: 'thread-layer' })),
        }],
      }),
    } as unknown as StrataGateRuntime
    const result = await request('/api/stratagate/memories?namespace=layers&kind=blocks&threadId=thread-layer', 'GET', layerRuntime)
    const block = result.body.items[0]
    const l4 = block.layerTokens.find(({ level }: { level: number }) => level === 4)
    expect(block).toMatchObject({ currentLevel: 4, currentTokens: l4.tokens, compressionPercent: l4.percentOfL5 })
    expect(block.compressionPercent).toBe(Math.round(block.currentTokens / block.l5Tokens * 100))
  })

  it('rebuilds deterministic preview layers for Blocks stored by older versions', async () => {
    const legacyRuntime = {
      adminSnapshot: async () => ({
        ...snapshot,
        blocks: [{
          ...snapshot.blocks[0]!,
          threadId: 'thread-legacy-layers',
          l3Condensed: 'stale oversized L3 '.repeat(1_000),
          l4Readable: 'stale oversized L4 '.repeat(1_000),
          l5Raw: snapshot.blocks[0]!.l5Raw.map((message) => ({ ...message, threadId: 'thread-legacy-layers' })),
        }],
      }),
    } as unknown as StrataGateRuntime
    const result = await request('/api/stratagate/memories?namespace=legacy-layers&kind=blocks&threadId=thread-legacy-layers', 'GET', legacyRuntime)
    const layers = result.body.items[0].layerTokens
    const tokens = Object.fromEntries(layers.map(({ level, tokens }: { level: number; tokens: number }) => [level, tokens]))
    expect(tokens[3]).toBeLessThanOrEqual(tokens[4])
    expect(tokens[4]).toBeLessThanOrEqual(tokens[5])
    expect(tokens[3]).toBeLessThan(1_000)
  })

  it('exposes sealed-but-pending Block compression state separately from long-term processing', async () => {
    const pendingRuntime = {
      adminSnapshot: async () => ({
        ...snapshot,
        blocks: [{
          ...snapshot.blocks[0]!,
          threadId: 'thread-pending',
          processingStatus: 'pending' as const,
          l0Title: undefined,
          l0Tags: undefined,
          l1Summary: undefined,
          l2Keypoints: undefined,
          l5Raw: snapshot.blocks[0]!.l5Raw.map((message) => ({ ...message, threadId: 'thread-pending' })),
        }],
        summaryJobs: [{
          blockId: 'blk_1', status: 'running' as const, attempts: 1, lastError: null, nextRetryAt: null,
          updatedAt: '2026-08-18T00:00:01.000Z',
        }],
      }),
    } as unknown as StrataGateRuntime
    const result = await request('/api/stratagate/memories?namespace=pending&kind=blocks&threadId=thread-pending', 'GET', pendingRuntime)
    expect(result.body.items[0]).toMatchObject({
      processingStatus: 'pending',
      summaryJob: { status: 'running' },
      layerTokens: [{ level: 3 }, { level: 4 }, { level: 5, percentOfL5: 100 }],
    })
  })

  it('returns the adopted graph node with its directly related graph neighborhood', async () => {
    const relatedRuntime = {
      adminSnapshot: async () => ({
        ...snapshot,
        graphNodes: [
          ...snapshot.graphNodes,
          {
            ...snapshot.graphNodes[0]!,
            id: 'node_2',
            name: 'StrataGate',
            type: 'project' as const,
          },
        ],
        graphEdges: [{
          id: 'edge_1',
          fromNodeId: 'node_2',
          toNodeId: 'node_1',
          relation: '使用',
          status: 'active' as const,
          confidence: 0.93,
          sourceEventIds: ['evt_1'],
          createdAt: '2026-08-18T00:00:00.000Z',
          updatedAt: '2026-08-18T00:00:00.000Z',
        }],
      }),
    } as unknown as StrataGateRuntime
    const result = await request('/api/stratagate/sources?namespace=graph&nodeId=node_1', 'GET', relatedRuntime)
    expect(result.body).toMatchObject({
      node: { id: 'node_1' },
      nodes: [{ id: 'node_1' }, { id: 'node_2' }],
      edges: [{ id: 'edge_1', fromNodeId: 'node_2', toNodeId: 'node_1', relation: '使用' }],
    })
  })

  it('expands a block into its organized events and elements', async () => {
    const result = await request('/api/stratagate/sources?namespace=dsh%3Aproject%3Atest&blockId=blk_1')
    expect(result.body).toMatchObject({
      events: [{ id: 'evt_1' }],
      elements: [{ id: 'el_1' }],
      messages: [{ id: 'msg_1' }],
      layers: [
        { level: 0, content: expect.stringContaining('Package manager'), tokens: expect.any(Number), percentOfL5: expect.any(Number) },
        { level: 1, content: 'Use pnpm for this project.', tokens: expect.any(Number), percentOfL5: expect.any(Number) },
        { level: 2, content: '- pnpm', tokens: expect.any(Number), percentOfL5: expect.any(Number) },
        { level: 3, content: 'User: Use pnpm. api_key=[REDACTED]\n\nTool call: fetch' },
        { level: 4, content: 'User: Use pnpm. api_key=[REDACTED]\n\nTool call: fetch' },
        { level: 5, content: 'user: Use pnpm. api_key=[REDACTED]\n\nTool call (raw): {"name":"fetch","arguments":{"authorization":"Bearer [REDACTED]"}}' },
      ],
    })
  })

  it('actively lifts a Block to one requested layer', async () => {
    expandedBlock = null
    const result = await request('/api/stratagate/blocks/expand?namespace=dsh%3Aproject%3Atest&blockId=blk_1&level=L4', 'PATCH')
    expect(result).toMatchObject({ status: 200, body: { id: 'blk_1', level: 4 } })
    expect(expandedBlock).toEqual({ namespace: 'dsh:project:test', id: 'blk_1', target: 'L4' })

    const invalid = await request('/api/stratagate/blocks/expand?namespace=dsh%3Aproject%3Atest&blockId=blk_1&level=L9', 'PATCH')
    expect(invalid).toMatchObject({ status: 400, body: { error: expect.stringContaining('L0 through L5') } })
  })

  it('links answer audit records to events and original messages', async () => {
    const result = await request('/api/stratagate/audit?namespace=dsh%3Aproject%3Atest')
    expect(result.body.items[0]).toMatchObject({
      audit: { sessionId: 's1', turn: 8, batchId: 'batch_4', evidenceRefs: ['event:evt_1'] },
      events: [{ id: 'evt_1' }],
      sourceMessages: [{ id: 'msg_1' }],
    })
  })

  it('keeps per-request caps while allowing later memory and audit pages', async () => {
    const events = await request('/api/stratagate/memories?namespace=dsh%3Aproject%3Atest&kind=events&offset=1&limit=200')
    const blocks = await request('/api/stratagate/memories?namespace=dsh%3Aproject%3Atest&kind=blocks&offset=1&limit=200')
    const audits = await request('/api/stratagate/audit?namespace=dsh%3Aproject%3Atest&offset=1&limit=100')
    expect(events.body).toMatchObject({ total: 1, offset: 1, limit: 200, items: [] })
    expect(blocks.body).toMatchObject({ total: 1, offset: 1, limit: 200, items: [] })
    expect(audits.body).toMatchObject({ total: 1, offset: 1, limit: 100, items: [] })
  })

  it('updates the global Block settings while memory routes remain read-only', async () => {
    updatedLambda = null
    updatedTurnSize = null
    const settings = await request('/api/stratagate/settings?blockTurnSize=3&blockDecayLambda=0.15', 'PATCH')
    expect(settings).toMatchObject({ status: 200, body: { blockTurnSize: 3, blockDecayLambda: 0.15 } })
    expect(updatedTurnSize).toBe(3)
    expect(updatedLambda).toBe(0.15)

    const invalid = await request('/api/stratagate/settings?blockDecayLambda=nope', 'PATCH')
    expect(invalid).toMatchObject({ status: 400, body: { error: expect.stringContaining('blockDecayLambda') } })
    const invalidTurnSize = await request('/api/stratagate/settings?blockTurnSize=2.5', 'PATCH')
    expect(invalidTurnSize).toMatchObject({ status: 400, body: { error: expect.stringContaining('blockTurnSize') } })

    const result = await request('/api/stratagate/memories', 'POST')
    expect(result).toMatchObject({ status: 405, body: { error: expect.stringContaining('read-only') } })
  })
})
