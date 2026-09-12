import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import type { Context } from '@deepseek-ai/cordis'
import {
  deterministicBlockLayers,
  estimateTokens,
  EXTERNAL_MEMORY_EXPORT_PROMPT_ZH_CN,
  formatRawTranscript,
  getDecayedBlockLevel,
  KNOWLEDGE_GRAPH_PROJECTOR_VERSION,
  type ElementCard,
  type EventCard,
  type ExternalMemoryAction,
  type MemoryBlock,
  type RawMessage,
  type StrataGateSnapshot,
  type UsageReceipt,
} from '@diqier/stratagate'
import type { AdminSnapshotEntry, FeedbackDraftInput, StrataGateRuntime } from './runtime.js'
import { clusterKnowledgeGraph } from './graph-clustering.js'

const STRATAGATE_DSH_VERSION = '0.2.64'
const LEGACY_THREAD_ID = '__legacy__'
const nodeRequire = createRequire(import.meta.url)

function installedPackageVersion(names: readonly string[]): string {
  for (const name of names) {
    try {
      const value = nodeRequire(`${name}/package.json`) as { version?: unknown }
      if (typeof value.version === 'string' && value.version.trim()) return value.version
    } catch {}
  }
  return 'unknown'
}

interface DisplayBlock {
  id: string
  source: MemoryBlock
  threadId: string
  messages: RawMessage[]
  virtual: boolean
  turnRange: [number, number]
}

interface RecoveredSnapshotView {
  blocks: DisplayBlock[]
  openMessages: Array<{ message: RawMessage; threadId: string }>
  receiptThreads: Map<string, string>
  receiptActivity: Map<string, string>
  receiptTurns: Map<string, number>
}

export interface WebResponse {
  statusCode: number
  setHeader(name: string, value: string): void
  end(body: string): void
}

export interface WebRequest {
  method?: string
  url?: string
  headers?: Record<string, string | string[] | undefined>
  /** Parsed JSON body supplied by the host web server (or a JSON string). */
  body?: unknown
  [Symbol.asyncIterator]?: () => AsyncIterator<Uint8Array | string>
}

export interface WebServerLike {
  register(route: {
    readonly kind: 'prefix'
    readonly path: string
    readonly handler: (req: WebRequest, res: WebResponse) => Promise<void>
  }): () => void
}

function sendJson(res: WebResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(redactValue(body)))
}

function numeric(value: string | null, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, Math.floor(parsed))) : fallback
}

function redact(text: string): string {
  return text
    .replace(/\b(?:sk|gh[opasu]|github_pat)_[A-Za-z0-9_-]{12,}\b/g, '[REDACTED_TOKEN]')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]{12,}={0,2}\b/gi, '$1[REDACTED]')
    .replace(/\b(api[_-]?key|token|password|secret)\s*[:=]\s*([^\s,;]+)/gi, '$1=[REDACTED]')
}

function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return redact(value)
  if (Array.isArray(value)) return value.map(redactValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValue(item)]))
  }
  return value
}

function redactedMessage(message: RawMessage, blockId: string | null): RawMessage & { blockId: string | null } {
  const { toolCalls, ...base } = message
  const common = { ...base, content: redact(message.content), blockId }
  return toolCalls
    ? { ...common, toolCalls: redactValue(toolCalls) as NonNullable<RawMessage['toolCalls']> }
    : common
}

function sourceMessages(snapshot: StrataGateSnapshot, ids?: ReadonlySet<string>): Array<RawMessage & { blockId: string | null }> {
  const output: Array<RawMessage & { blockId: string | null }> = []
  for (const block of snapshot.blocks) {
    for (const message of block.l5Raw) {
      if (!ids || ids.has(message.id)) {
        output.push(redactedMessage(message, block.id))
      }
    }
  }
  for (const message of snapshot.openTail) {
    if (!ids || ids.has(message.id)) {
      output.push(redactedMessage(message, null))
    }
  }
  return output
}

interface DisplayLayer {
  level: number
  content: string
  tokens: number
  percentOfL5: number
}

function withLayerMetrics(layers: Array<{ level: number; content: string }>): DisplayLayer[] {
  const tokenCounts = new Map(layers.map(({ level, content }) => [level, estimateTokens(content)]))
  const l5Tokens = tokenCounts.get(5) ?? 0
  return layers.map((layer) => {
    const tokens = tokenCounts.get(layer.level) ?? 0
    const percentOfL5 = layer.level === 5
      ? 100
      : l5Tokens > 0 ? Math.round(tokens / l5Tokens * 100) : 0
    return { ...layer, tokens, percentOfL5 }
  })
}

function blockLayers(block: MemoryBlock): DisplayLayer[] {
  const deterministic = deterministicBlockLayers(block.l5Raw)
  if (block.processingStatus !== 'ready' || !block.l0Title || !block.l0Tags || !block.l1Summary || !block.l2Keypoints) {
    return withLayerMetrics([
      { level: 3, content: deterministic.l3Condensed },
      { level: 4, content: deterministic.l4Readable },
      { level: 5, content: formatRawTranscript(block.l5Raw) },
    ])
  }
  return withLayerMetrics([
    { level: 0, content: `${block.l0Title}\nTags: ${block.l0Tags.join(', ') || 'none'}` },
    { level: 1, content: block.l1Summary || block.l0Title },
    { level: 2, content: block.l2Keypoints.map((point) => `- ${point}`).join('\n') || block.l1Summary || block.l0Title },
    { level: 3, content: deterministic.l3Condensed || block.l2Keypoints.join('\n') || block.l1Summary },
    { level: 4, content: deterministic.l4Readable || deterministic.l3Condensed },
    { level: 5, content: formatRawTranscript(block.l5Raw) },
  ])
}

function eventSummary(event: EventCard): unknown {
  return {
    id: event.id,
    title: event.title,
    summary: event.summary,
    narrative: event.narrative,
    tags: event.tags,
    sourceBlockId: event.sourceBlockId,
    sourceMessageIds: event.sourceMessageIds,
    temporal: event.temporal,
    scope: event.scope,
    criticality: event.criticality,
    confidence: event.confidence,
    status: event.status,
    supersededBy: event.supersededBy,
    weight: event.weight,
    createdAt: event.createdAt,
    updatedAt: event.updatedAt,
  }
}

function elementSummary(element: ElementCard): unknown {
  return {
    id: element.id,
    name: element.name,
    type: element.type,
    aliases: element.aliases,
    currentState: element.currentState,
    facts: element.facts,
    sourceEventIds: element.sourceEventIds,
    sourceMessageIds: element.sourceMessageIds,
    weight: element.weight,
    createdAt: element.createdAt,
    updatedAt: element.updatedAt,
  }
}

function matchesQuery(value: unknown, query: string): boolean {
  if (!query) return true
  return JSON.stringify(value).toLocaleLowerCase().includes(query.toLocaleLowerCase())
}

async function requiredSnapshot(runtime: StrataGateRuntime, namespace: string): Promise<StrataGateSnapshot> {
  const snapshot = await runtime.adminSnapshot(namespace)
  if (!snapshot) throw new AdminHttpError(404, `Unknown StrataGate namespace: ${namespace}`)
  return snapshot
}

class AdminHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

async function overview(runtime: StrataGateRuntime, cachedEntries?: readonly AdminSnapshotEntry[]): Promise<unknown> {
  const entries = cachedEntries ?? await Promise.all((await runtime.adminNamespaces()).map(async (namespace) => ({
    namespace,
    revision: 0,
    snapshot: await runtime.adminSnapshot(namespace),
  })))
  const rows = []
  for (const { namespace, snapshot } of entries) {
    if (!snapshot) continue
    const failedJobs = snapshot.summaryJobs.filter(({ status }) => status === 'failed').length
      + snapshot.extractionJobs.filter(({ status }) => status === 'failed').length
      + snapshot.graphProjectionJobs.filter(({ status }) => status === 'failed').length
    const processingJobs = snapshot.summaryJobs.filter(({ status, nextRetryAt }) => status === 'pending' || status === 'running' || (status === 'failed' && nextRetryAt !== null)).length
      + snapshot.extractionJobs.filter(({ status, nextRetryAt }) => status === 'running' || (status === 'failed' && nextRetryAt !== null)).length
      + snapshot.graphProjectionJobs.filter(({ status }) => status === 'pending' || status === 'running').length
    const failedJobDetails = [
      ...snapshot.summaryJobs
        .filter(({ status }) => status === 'failed')
        .map((job) => {
          const block = snapshot.blocks.find(({ id }) => id === job.blockId)
          return {
            id: job.blockId,
            kind: 'block-summary',
            attempts: job.attempts,
            nextRetryAt: job.nextRetryAt,
            lastError: job.lastError?.slice(0, 500) ?? null,
            lastErrorFull: job.lastError,
            updatedAt: job.updatedAt,
            threadId: block?.threadId ?? null,
            blockIds: [job.blockId],
            threadIds: block?.threadId ? [block.threadId] : [],
            blockDetails: block ? [{
              id: block.id, sequence: block.sequence, title: block.l0Title ?? null,
              threadId: block.threadId ?? null, turnRange: [block.startTurn, block.endTurn],
            }] : [],
            sequence: block?.sequence ?? null,
            turnRange: block ? [block.startTurn, block.endTurn] : null,
          }
        }),
      ...snapshot.extractionJobs
        .filter(({ status }) => status === 'failed')
        .map((job) => {
          const block = snapshot.blocks.find(({ id }) => id === job.blockId)
          return {
            id: job.blockId,
            kind: 'event-extraction',
            attempts: job.attempts,
            nextRetryAt: job.nextRetryAt,
            lastError: job.lastError?.slice(0, 500) ?? null,
            lastErrorFull: job.lastError,
            updatedAt: job.updatedAt,
            blockIds: [job.blockId],
            threadIds: block?.threadId ? [block.threadId] : [],
            blockDetails: block ? [{
              id: block.id, sequence: block.sequence, title: block.l0Title ?? null,
              threadId: block.threadId ?? null, turnRange: [block.startTurn, block.endTurn],
            }] : [],
            sequence: block?.sequence ?? null,
            turnRange: block ? [block.startTurn, block.endTurn] : null,
          }
        }),
      ...snapshot.graphProjectionJobs
        .filter(({ status }) => status === 'failed')
        .map((job) => {
          const blockIds = [...new Set(job.sourceEventIds.flatMap((eventId) =>
            snapshot.events.find(({ id }) => id === eventId)?.sourceBlockId ?? []))]
          const blocks = blockIds.flatMap((blockId) => snapshot.blocks.find(({ id }) => id === blockId) ?? [])
          return {
            id: job.id,
            kind: 'graph-projection',
            attempts: job.attempts,
            nextRetryAt: null,
            lastError: job.lastError?.slice(0, 500) ?? null,
            lastErrorFull: job.lastError,
            updatedAt: job.updatedAt,
            blockIds,
            threadIds: [...new Set(blocks.flatMap(({ threadId }) => threadId ?? []))],
            blockDetails: blocks.map((block) => ({
              id: block.id, sequence: block.sequence, title: block.l0Title ?? null,
              threadId: block.threadId ?? null, turnRange: [block.startTurn, block.endTurn],
            })),
            sequences: blocks.map(({ sequence }) => sequence),
            sourceEventIds: job.sourceEventIds,
          }
        }),
    ]
    const timestamps = [
      ...snapshot.blocks.map(({ createdAt }) => createdAt),
      ...snapshot.events.map(({ updatedAt }) => updatedAt),
      ...snapshot.elements.map(({ updatedAt }) => updatedAt),
      ...snapshot.graphNodes.map(({ updatedAt }) => updatedAt),
      ...snapshot.usageReceipts.map(({ createdAt }) => createdAt),
    ].sort()
    rows.push({
      namespace,
      workspaceName: runtime.adminWorkspaceName(namespace) ?? '当前工作区',
      schemaVersion: snapshot.schemaVersion,
      currentTurn: snapshot.currentTurn,
      blockTurnSize: snapshot.blockTurnSize,
      blockDecayLambda: snapshot.blockDecayLambda,
      blocks: snapshot.blocks.length,
      openTailMessages: snapshot.openTail.length,
      events: snapshot.events.length,
      activeEvents: snapshot.events.filter(({ status }) => status === 'active').length,
      elements: snapshot.elements.length,
      graphNodes: snapshot.graphNodes.length,
      graphEdges: snapshot.graphEdges.length,
      graphMigration: (() => {
        const projected = new Set(snapshot.graphProjectionJobs
          .filter(({ status, projectorVersion }) => status === 'completed' && projectorVersion === KNOWLEDGE_GRAPH_PROJECTOR_VERSION)
          .flatMap(({ sourceEventIds }) => sourceEventIds)).size
        const failed = snapshot.graphProjectionJobs.filter(({ status }) => status === 'failed').length
        const running = snapshot.graphProjectionJobs.filter(({ status }) => status === 'running').length
        const total = snapshot.events.filter(({ status }) => status !== 'forgotten' && status !== 'archived').length
        return { projected, total, failed, running, complete: projected >= total }
      })(),
      usageReceipts: snapshot.usageReceipts.length,
      memoryUseCount: snapshot.usageReceipts.filter((receipt) =>
        receipt.eventIds.length > 0 || receipt.elementIds.length > 0).length,
      failedJobs,
      processingJobs,
      failedJobDetails,
      successfulModelResponses: snapshot.successfulModelResponses ?? [],
      lastActivityAt: timestamps.at(-1) ?? null,
    })
  }
  return {
    readonly: true,
    settingsWritable: true,
    pluginVersion: STRATAGATE_DSH_VERSION,
    harnessVersion: installedPackageVersion(['@deepseek-ai/dsh', '@deepseek-ai/dsh-session']),
    namespaces: rows,
  }
}

async function updateSettings(runtime: StrataGateRuntime, url: URL): Promise<unknown> {
  const rawTurnSize = url.searchParams.get('blockTurnSize')?.trim()
  const rawLambda = url.searchParams.get('blockDecayLambda')?.trim()
  if (rawTurnSize === undefined && rawLambda === undefined) {
    throw new AdminHttpError(400, 'blockTurnSize or blockDecayLambda is required')
  }
  let turnSize: number | undefined
  let lambda: number | undefined
  if (rawTurnSize !== undefined) {
    const value = Number(rawTurnSize)
    if (!rawTurnSize || !Number.isSafeInteger(value) || value < 1) {
      throw new AdminHttpError(400, 'blockTurnSize must be a positive integer')
    }
    turnSize = value
  }
  if (rawLambda !== undefined) {
    const value = Number(rawLambda)
    if (!rawLambda || !Number.isFinite(value) || value < 0) {
      throw new AdminHttpError(400, 'blockDecayLambda must be a non-negative finite number')
    }
    lambda = value
  }
  const result: { blockTurnSize?: number; blockDecayLambda?: number } = {}
  if (turnSize !== undefined) result.blockTurnSize = await runtime.adminSetBlockTurnSize(turnSize)
  if (lambda !== undefined) result.blockDecayLambda = await runtime.adminSetBlockDecayLambda(lambda)
  return result
}

async function feedback(runtime: StrataGateRuntime, req: WebRequest, url: URL): Promise<unknown> {
  if (req.method === 'GET') {
    const namespace = url.searchParams.get('namespace')?.trim() ?? ''
    if (!namespace) throw new AdminHttpError(400, 'namespace is required')
    return runtime.adminFeedbackDraft(namespace)
  }
  if (req.method !== 'PUT') throw new AdminHttpError(405, 'StrataGate feedback requires GET or PUT')
  let suppliedBody = req.body
  if (suppliedBody === undefined && typeof req[Symbol.asyncIterator] === 'function') {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req as AsyncIterable<Uint8Array | string>) {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += value.length
      if (size > 128 * 1024) throw new AdminHttpError(413, 'feedback draft cannot exceed 128 KB')
      chunks.push(value)
    }
    suppliedBody = Buffer.concat(chunks).toString('utf8')
  }
  let body: Record<string, unknown>
  if (typeof suppliedBody === 'string') {
    try { body = JSON.parse(suppliedBody) as Record<string, unknown> } catch { throw new AdminHttpError(400, 'feedback draft must be valid JSON') }
  } else if (suppliedBody && typeof suppliedBody === 'object' && !Array.isArray(suppliedBody)) {
    body = suppliedBody as Record<string, unknown>
  } else {
    throw new AdminHttpError(400, 'feedback request requires a JSON body')
  }
  const namespace = typeof body.namespace === 'string' ? body.namespace.trim() : ''
  if (!namespace) throw new AdminHttpError(400, 'namespace is required')
  const draft: FeedbackDraftInput = {}
  if (typeof body.title === 'string') draft.title = body.title
  if (typeof body.description === 'string') draft.description = body.description
  if (Array.isArray(body.reproduction)) draft.reproduction = body.reproduction.filter((value): value is string => typeof value === 'string')
  if (typeof body.expected === 'string') draft.expected = body.expected
  if (typeof body.actual === 'string') draft.actual = body.actual
  if (typeof body.errorContext === 'string') draft.errorContext = body.errorContext
  if (typeof body.bodyMarkdown === 'string') draft.bodyMarkdown = body.bodyMarkdown
  return runtime.adminSaveFeedbackDraft(namespace, draft)
}

async function importExternalMemory(runtime: StrataGateRuntime, req: WebRequest): Promise<unknown> {
  let suppliedBody = req.body
  if (suppliedBody === undefined && typeof req[Symbol.asyncIterator] === 'function') {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req as AsyncIterable<Uint8Array | string>) {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += value.length
      if (size > 4 * 1024 * 1024) throw new AdminHttpError(413, '导入数据不能超过 4 MB')
      chunks.push(value)
    }
    suppliedBody = Buffer.concat(chunks).toString('utf8')
  }
  let body: Record<string, unknown>
  if (typeof suppliedBody === 'string') {
    try { body = JSON.parse(suppliedBody) as Record<string, unknown> } catch { throw new AdminHttpError(400, '导入数据必须是合法 JSON') }
  } else if (suppliedBody && typeof suppliedBody === 'object' && !Array.isArray(suppliedBody)) {
    body = suppliedBody as Record<string, unknown>
  } else {
    throw new AdminHttpError(400, '导入请求缺少 JSON body')
  }
  const namespace = typeof body.namespace === 'string' ? body.namespace.trim() : ''
  if (!namespace) throw new AdminHttpError(400, 'namespace is required')
  const operation = typeof body.operation === 'string' ? body.operation : 'preview'
  if (operation === 'preview') {
    const text = typeof body.text === 'string' ? body.text.trim() : ''
    if (!text) throw new AdminHttpError(400, 'text is required')
    return runtime.adminPreviewExternalMemory(namespace, text)
  }
  if (operation === 'status') {
    const jobId = typeof body.jobId === 'string' ? body.jobId.trim() : undefined
    return runtime.adminExternalMemoryStatus(namespace, jobId)
  }
  if (operation === 'retry') {
    const jobId = typeof body.jobId === 'string' ? body.jobId.trim() : ''
    if (!jobId) throw new AdminHttpError(400, 'jobId is required')
    return runtime.adminRetryExternalMemory(namespace, jobId)
  }
  if (operation === 'commit') {
    const jobId = typeof body.jobId === 'string' ? body.jobId.trim() : ''
    if (!jobId) throw new AdminHttpError(400, 'jobId is required')
    const allowed = new Set<ExternalMemoryAction>(['ADD', 'MERGE', 'SUPERSEDE', 'CONFLICT', 'IGNORE'])
    const choices = Array.isArray(body.choices) ? body.choices.flatMap((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return []
      const item = value as Record<string, unknown>
      const index = item.index
      const action = typeof item.action === 'string' ? item.action.toUpperCase() as ExternalMemoryAction : 'IGNORE'
      return Number.isSafeInteger(index) && allowed.has(action) ? [{ index: index as number, action }] : []
    }) : []
    return runtime.adminCommitExternalMemory(namespace, jobId, choices)
  }
  if (operation === 'undo') {
    const sourceBlockId = typeof body.sourceBlockId === 'string' ? body.sourceBlockId.trim() : ''
    if (!sourceBlockId) throw new AdminHttpError(400, 'sourceBlockId is required')
    return runtime.adminUndoExternalMemory(namespace, sourceBlockId)
  }
  throw new AdminHttpError(400, 'operation must be preview, status, retry, commit, or undo')
}

function externalMemoryPrompt(): unknown {
  return { prompt: EXTERNAL_MEMORY_EXPORT_PROMPT_ZH_CN, schemaVersion: 'stratagate.external-memory.v2' }
}

function receiptThreadId(id: string): string | null {
  const match = /^dsh:(.+):turn:\d+$/.exec(id)
  return match?.[1]?.trim() || null
}

function receiptTurnNumber(id: string): number | null {
  const match = /^dsh:(.+):turn:(\d+)$/.exec(id)
  if (!match) return null
  const turn = Number(match[2])
  return Number.isSafeInteger(turn) ? turn : null
}

function receiptTurnKey(threadId: string, createdAt: string): string {
  return `${threadId}\u0000${timestampKey(createdAt)}`
}

function timestampKey(value: string): string {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? String(parsed) : value
}

function recoverSnapshotView(snapshot: StrataGateSnapshot): RecoveredSnapshotView {
  const receiptThreads = new Map<string, string>()
  const receiptActivity = new Map<string, string>()
  const receiptTurns = new Map<string, number>()
  const receiptCandidates = new Map<string, Set<string>>()
  for (const receipt of snapshot.ingestionReceipts) {
    const threadId = receiptThreadId(receipt.id)
    if (!threadId) continue
    receiptThreads.set(receipt.id, threadId)
    const turn = receiptTurnNumber(receipt.id)
    if (turn !== null) receiptTurns.set(receiptTurnKey(threadId, receipt.createdAt), turn)
    const currentActivity = receiptActivity.get(threadId)
    if (!currentActivity || receipt.createdAt > currentActivity) receiptActivity.set(threadId, receipt.createdAt)
    const key = timestampKey(receipt.createdAt)
    const candidates = receiptCandidates.get(key) ?? new Set<string>()
    candidates.add(threadId)
    receiptCandidates.set(key, candidates)
  }
  const exactThreadAt = new Map([...receiptCandidates]
    .filter(([, ids]) => ids.size === 1)
    .map(([createdAt, ids]) => [createdAt, [...ids][0]!] as const))

  const recoverMessages = (messages: readonly RawMessage[]): Array<{ message: RawMessage; threadId: string }> => {
    let precedingThreadId: string | null = null
    return messages.map((message) => {
      const explicit = message.threadId?.trim()
      const exact = exactThreadAt.get(timestampKey(message.createdAt))
      const recovered = explicit || exact || (message.role === 'assistant' ? precedingThreadId : null)
      const threadId = recovered || LEGACY_THREAD_ID
      if (message.role === 'user' || explicit || exact) precedingThreadId = threadId
      return { message, threadId }
    })
  }

  const blocks: DisplayBlock[] = []
  for (const source of snapshot.blocks) {
    const recovered = recoverMessages(source.l5Raw)
    const groups = new Map<string, RawMessage[]>()
    for (const item of recovered) {
      const messages = groups.get(item.threadId) ?? []
      messages.push(item.message)
      groups.set(item.threadId, messages)
    }
    const entries = [...groups]
    for (const [threadId, messages] of entries) {
      const virtual = !source.threadId && (entries.length > 1 || threadId !== LEGACY_THREAD_ID)
      blocks.push({
        id: entries.length > 1 ? `virtual:${source.id}:${encodeURIComponent(threadId)}` : source.id,
        source,
        threadId,
        messages,
        virtual,
        turnRange: [0, 0],
      })
    }
  }

  const turnCounters = new Map<string, number>()
  for (const block of blocks) {
    if (block.source.threadId) {
      const turnMessages = block.messages.filter(({ role }) => role === 'user')
      const dshTurns = turnMessages
        .map((message) => receiptTurns.get(receiptTurnKey(block.threadId, message.createdAt)))
      block.turnRange = dshTurns.length > 0 && dshTurns.every((turn): turn is number => turn !== undefined)
        ? [Math.min(...dshTurns), Math.max(...dshTurns)]
        : [block.source.startTurn, block.source.endTurn]
      turnCounters.set(block.threadId, Math.max(turnCounters.get(block.threadId) ?? 0, block.turnRange[1]))
      continue
    }
    const turns = Math.max(1, block.messages.filter(({ role }) => role === 'user').length)
    const start = (turnCounters.get(block.threadId) ?? 0) + 1
    block.turnRange = [start, start + turns - 1]
    turnCounters.set(block.threadId, start + turns - 1)
  }

  return {
    blocks,
    openMessages: recoverMessages(snapshot.openTail),
    receiptThreads,
    receiptActivity,
    receiptTurns,
  }
}

function virtualBlockLayers(block: DisplayBlock): DisplayLayer[] {
  if (!block.virtual || block.messages.length === block.source.l5Raw.length) return blockLayers(block.source)
  const deterministic = deterministicBlockLayers(block.messages)
  const natural = block.messages.filter(({ role }) => role === 'user' || role === 'assistant')
  const firstUser = natural.find(({ role, content }) => role === 'user' && content.trim())
  const title = firstUser?.content.replace(/\s+/g, ' ').trim().slice(0, 80) || '旧会话片段'
  const summary = natural.map(({ content }) => content.replace(/\s+/g, ' ').trim()).filter(Boolean).join(' ').slice(0, 500)
  const keypoints = natural.filter(({ role }) => role === 'user').map(({ content }) => content.replace(/\s+/g, ' ').trim().slice(0, 160))
  return withLayerMetrics([
    { level: 0, content: title },
    { level: 1, content: summary || title },
    { level: 2, content: keypoints.map((point) => `• ${point}`).join('\n') || summary || title },
    { level: 3, content: deterministic.l3Condensed },
    { level: 4, content: deterministic.l4Readable },
    { level: 5, content: formatRawTranscript(block.messages) },
  ])
}

function conversationRows(snapshot: StrataGateSnapshot, view = recoverSnapshotView(snapshot)): Array<{ id: string; label: string; blocks: number; lastActivityAt: string | null }> {
  const ids = new Set([
    ...view.blocks.map((block) => block.threadId),
    ...view.openMessages.map(({ threadId }) => threadId),
    ...view.receiptThreads.values(),
  ])
  return [...ids].map((id) => {
    const blocks = view.blocks.filter((block) => block.threadId === id)
    const messages = [
      ...blocks.flatMap((block) => block.messages),
      ...view.openMessages.filter((message) => message.threadId === id).map(({ message }) => message),
    ]
    const firstUser = messages.find(({ role, content }) => role === 'user' && content.trim())
    const title = firstUser?.content.replace(/\s+/g, ' ').trim().slice(0, 28)
    const timestamps = [
      ...blocks.map(({ source }) => source.createdAt),
      ...messages.map(({ createdAt }) => createdAt),
      ...(view.receiptActivity.get(id) ? [view.receiptActivity.get(id)!] : []),
    ].sort()
    return {
      id,
      label: id === LEGACY_THREAD_ID ? '历史对话' : title || `对话 ${id.slice(0, 8)}`,
      blocks: blocks.length,
      lastActivityAt: timestamps.at(-1) ?? null,
    }
  }).sort((left, right) => String(right.lastActivityAt).localeCompare(String(left.lastActivityAt)))
}

async function memories(runtime: StrataGateRuntime, url: URL): Promise<unknown> {
  const namespace = url.searchParams.get('namespace')?.trim() ?? ''
  if (!namespace) throw new AdminHttpError(400, 'namespace is required')
  const snapshot = await requiredSnapshot(runtime, namespace)
  const kind = url.searchParams.get('kind') ?? 'events'
  const query = url.searchParams.get('q')?.trim() ?? ''
  const offset = numeric(url.searchParams.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER)
  const limit = numeric(url.searchParams.get('limit'), 100, 1, 200)
  let values: unknown[]
  if (kind === 'events') values = [...snapshot.events].sort((left, right) => {
    const time = (event: EventCard): string => event.temporal.happenedStart ?? event.temporal.happenedEnd
      ?? event.temporal.mentionedAt ?? event.createdAt
    return time(right).localeCompare(time(left))
  }).map((event) => ({
    ...(eventSummary(event) as object),
    relatedNodes: snapshot.graphNodes
      .filter(({ id, sourceEventIds }) => sourceEventIds.includes(event.id)
        || (event.temporal.participantNodeIds ?? []).includes(id))
      .map(({ id, name, type }) => ({ id, name, type })),
    relatedElements: snapshot.elements
      .filter(({ sourceEventIds }) => sourceEventIds.includes(event.id))
      .map(({ id, name }) => ({ id, name })),
  }))
  else if (kind === 'graph') {
    const eventMap = new Map(snapshot.events.map((event) => [event.id, event]))
    return {
      namespace,
      kind,
      projectorVersion: KNOWLEDGE_GRAPH_PROJECTOR_VERSION,
      nodes: snapshot.graphNodes.map((node) => ({
        ...node,
        supportingEvents: node.sourceEventIds.flatMap((id) => eventMap.get(id) ?? []).map(eventSummary),
      })),
      edges: snapshot.graphEdges,
      clusters: clusterKnowledgeGraph(snapshot.graphNodes, snapshot.graphEdges),
      migration: (() => {
        const projected = new Set(snapshot.graphProjectionJobs
          .filter(({ status, projectorVersion }) => status === 'completed' && projectorVersion === KNOWLEDGE_GRAPH_PROJECTOR_VERSION)
          .flatMap(({ sourceEventIds }) => sourceEventIds)).size
        return {
          projected,
          total: snapshot.events.filter(({ status }) => status !== 'forgotten' && status !== 'archived').length,
          pending: snapshot.graphProjectionJobs.filter(({ status }) => status === 'pending').length,
          running: snapshot.graphProjectionJobs.filter(({ status }) => status === 'running').length,
          failed: snapshot.graphProjectionJobs.filter(({ status }) => status === 'failed').length,
          complete: projected >= snapshot.events.filter(({ status }) => status !== 'forgotten' && status !== 'archived').length,
        }
      })(),
    }
  }
  else if (kind === 'elements') values = snapshot.elements.map(elementSummary)
  else if (kind === 'blocks') {
    const recovered = recoverSnapshotView(snapshot)
    const conversations = conversationRows(snapshot, recovered)
    const requestedThreadId = url.searchParams.get('threadId')?.trim() ?? ''
    const activeThreadId = requestedThreadId || conversations[0]?.id || null
    const scopedBlocks = activeThreadId
      ? recovered.blocks.filter((block) => block.threadId === activeThreadId)
      : []
    values = scopedBlocks.map((block) => {
      const source = block.source
      const layers = virtualBlockLayers(block)
      const layerTokens = layers.map(({ level, tokens, percentOfL5 }) => ({ level, tokens, percentOfL5 }))
      const extraction = snapshot.extractionJobs.find(({ blockId }) => blockId === source.id)
      const summary = snapshot.summaryJobs.find(({ blockId }) => blockId === source.id)
      const blockMessageIds = new Set(block.messages.map(({ id }) => id))
      const relatedEvents = snapshot.events.filter((event) => event.sourceBlockId === source.id
        && (!block.virtual || event.sourceMessageIds.some((id) => blockMessageIds.has(id))))
      const eventIds = new Set(relatedEvents.map(({ id }) => id))
      const projections = snapshot.graphProjectionJobs
        .filter(({ sourceEventIds }) => sourceEventIds.some((id) => eventIds.has(id)))
      const relatedNodes = snapshot.graphNodes
        .filter(({ sourceEventIds }) => sourceEventIds.some((id) => eventIds.has(id)))
        .map(({ id, name, type }) => ({ id, name, type }))
      const failedProjection = projections.find(({ status }) => status === 'failed')
      const pendingProjection = projections.some(({ status }) => status === 'pending' || status === 'running')
      const needsExtraction = source.shouldExtract === true
      const status = summary?.status === 'failed'
        ? 'failed'
        : summary?.status === 'pending' || summary?.status === 'running' || (!summary && source.processingStatus === 'pending')
          ? 'processing'
          : extraction?.status === 'failed' || failedProjection
            ? 'failed'
            : extraction?.status === 'succeeded' || extraction?.status === 'skipped'
              ? pendingProjection ? 'processing' : 'organized'
              : needsExtraction ? 'waiting' : 'organized'
      const blockPosition = scopedBlocks.findIndex(({ id }) => id === block.id) + 1
      const latestBlockPosition = scopedBlocks.length
      const currentLevel = getDecayedBlockLevel(
        source.pointerAnchorLevel,
        source.threadId ? source.pointerAnchorBlockPosition : Math.min(source.pointerAnchorBlockPosition, blockPosition),
        latestBlockPosition,
        snapshot.blockDecayLambda,
      )
      const currentMetrics = layerTokens.find(({ level }) => level === currentLevel)
      const l5Tokens = layerTokens.find(({ level }) => level === 5)?.tokens ?? 0
      return {
        id: block.id,
        sourceBlockId: source.id,
        threadId: block.threadId,
        sequence: source.sequence,
        blockIndex: blockPosition,
        turnRange: block.turnRange,
        title: block.virtual && block.messages.length !== source.l5Raw.length
          ? block.messages.find(({ role }) => role === 'user')?.content.replace(/\s+/g, ' ').trim().slice(0, 80) || '旧会话片段'
          : source.l0Title,
        tags: source.l0Tags,
        summary: source.l1Summary,
        keypoints: source.l2Keypoints,
        currentLevel,
        currentTokens: currentMetrics?.tokens ?? 0,
        l5Tokens,
        compressionPercent: currentMetrics?.percentOfL5 ?? (currentLevel === 5 ? 100 : 0),
        layerTokens,
        distanceFromLatest: Math.max(0, latestBlockPosition - blockPosition),
        expansionSource: source.lastLiftedAt ? source.lastLiftedBy ?? 'legacy' : null,
        lastLiftedAt: source.lastLiftedAt,
        sourceMessages: block.messages.length,
        createdAt: source.createdAt,
        virtual: block.virtual,
        processingStatus: source.processingStatus,
        summaryJob: summary ? {
          status: summary.status,
          attempts: summary.attempts,
          nextRetryAt: summary.nextRetryAt,
          updatedAt: summary.updatedAt,
        } : null,
        status,
        eventExtraction: extraction ? {
          status: extraction.status,
          attempts: extraction.attempts,
          updatedAt: extraction.updatedAt,
          lastError: extraction.lastError,
        } : null,
        graphProjection: projections.length ? {
          status: failedProjection ? 'failed' : pendingProjection ? 'processing' : 'completed',
          jobs: projections.length,
          lastError: failedProjection?.lastError ?? null,
        } : null,
        relatedEvents: relatedEvents.map(eventSummary),
        relatedNodes,
      }
    })
    const filtered = values.filter((value) => matchesQuery(value, query))
    const latestSealedTurn = scopedBlocks.reduce((latest, block) => Math.max(latest, block.turnRange[1]), 0)
    const openMessages = activeThreadId
      ? recovered.openMessages.filter((message) => message.threadId === activeThreadId).map(({ message }) => message)
      : []
    const openTurns = openMessages.filter(({ role }) => role === 'user').length
    const openDshTurns = activeThreadId
      ? openMessages.filter(({ role }) => role === 'user')
        .map((message) => recovered.receiptTurns.get(receiptTurnKey(activeThreadId, message.createdAt)))
      : []
    return {
      namespace,
      kind,
      total: filtered.length,
      offset,
      limit,
      items: filtered.slice(offset, offset + limit),
      openBlock: {
        turnRange: openTurns > 0
          ? openDshTurns.length > 0 && openDshTurns.every((turn): turn is number => turn !== undefined)
            ? [Math.min(...openDshTurns), Math.max(...openDshTurns)]
            : [latestSealedTurn + 1, latestSealedTurn + openTurns]
          : null,
        messages: openMessages.length,
        turns: openTurns,
        capacity: snapshot.blockTurnSize,
        status: 'open',
      },
      blockTurnSize: snapshot.blockTurnSize,
      conversations,
      activeThreadId,
    }
  }
  else throw new AdminHttpError(400, `Unsupported memory kind: ${kind}`)
  const filtered = values.filter((value) => matchesQuery(value, query))
  return { namespace, kind, total: filtered.length, offset, limit, items: filtered.slice(offset, offset + limit) }
}

async function sources(runtime: StrataGateRuntime, url: URL): Promise<unknown> {
  const namespace = url.searchParams.get('namespace')?.trim() ?? ''
  if (!namespace) throw new AdminHttpError(400, 'namespace is required')
  const snapshot = await requiredSnapshot(runtime, namespace)
  const eventId = url.searchParams.get('eventId')
  const nodeId = url.searchParams.get('nodeId')
  const elementId = url.searchParams.get('elementId')
  const blockId = url.searchParams.get('blockId')
  let events: EventCard[] = []
  let elements: ElementCard[] = []
  let ids = new Set<string>()
  if (eventId) {
    const event = snapshot.events.find(({ id }) => id === eventId)
    if (!event) throw new AdminHttpError(404, `Unknown event: ${eventId}`)
    events = [event]
    ids = new Set(event.sourceMessageIds)
  } else if (nodeId) {
    const node = snapshot.graphNodes.find(({ id }) => id === nodeId)
    if (!node) throw new AdminHttpError(404, `Unknown graph node: ${nodeId}`)
    events = snapshot.events.filter(({ id }) => node.sourceEventIds.includes(id))
    ids = new Set(events.flatMap(({ sourceMessageIds }) => sourceMessageIds))
    const edges = snapshot.graphEdges.filter(({ fromNodeId, toNodeId }) => fromNodeId === node.id || toNodeId === node.id)
    const relatedNodeIds = new Set([node.id, ...edges.flatMap(({ fromNodeId, toNodeId }) => [fromNodeId, toNodeId])])
    return {
      namespace,
      node,
      nodes: snapshot.graphNodes.filter(({ id }) => relatedNodeIds.has(id)),
      edges,
      events: events.map(eventSummary),
      messages: sourceMessages(snapshot, ids),
    }
  } else if (elementId) {
    const element = snapshot.elements.find(({ id }) => id === elementId)
    if (!element) throw new AdminHttpError(404, `Unknown element: ${elementId}`)
    elements = [element]
    events = snapshot.events.filter(({ id }) => element.sourceEventIds.includes(id))
    ids = new Set(events.flatMap(({ sourceMessageIds }) => sourceMessageIds))
  } else if (blockId) {
    const displayBlock = recoverSnapshotView(snapshot).blocks.find(({ id }) => id === blockId)
    const block = displayBlock?.source ?? snapshot.blocks.find(({ id }) => id === blockId)
    if (!block) throw new AdminHttpError(404, `Unknown block: ${blockId}`)
    const messages = displayBlock?.messages ?? block.l5Raw
    ids = new Set(messages.map(({ id }) => id))
    events = snapshot.events.filter((event) => event.sourceBlockId === block.id
      && (!displayBlock?.virtual || event.sourceMessageIds.some((id) => ids.has(id))))
    const eventIds = new Set(events.map(({ id }) => id))
    elements = snapshot.elements.filter(({ sourceEventIds }) => sourceEventIds.some((id) => eventIds.has(id)))
    return {
      namespace,
      events: events.map(eventSummary),
      elements: elements.map(elementSummary),
      messages: sourceMessages(snapshot, ids),
      layers: displayBlock ? virtualBlockLayers(displayBlock) : blockLayers(block),
      virtual: displayBlock?.virtual ?? false,
    }
  } else {
    throw new AdminHttpError(400, 'eventId, nodeId, elementId, or blockId is required')
  }
  return {
    namespace,
    events: events.map(eventSummary),
    elements: elements.map(elementSummary),
    blocks: events.map((event) => snapshot.blocks.find(({ id }) => id === event.sourceBlockId))
      .filter((block): block is MemoryBlock => Boolean(block))
      .map((block) => ({ id: block.id, title: block.l0Title, createdAt: block.createdAt })),
    messages: sourceMessages(snapshot, ids),
  }
}

async function expandBlock(runtime: StrataGateRuntime, url: URL): Promise<unknown> {
  const namespace = url.searchParams.get('namespace')?.trim() ?? ''
  const blockId = url.searchParams.get('blockId')?.trim() ?? ''
  const target = url.searchParams.get('level')?.trim() ?? ''
  if (!namespace) throw new AdminHttpError(400, 'namespace is required')
  if (!blockId) throw new AdminHttpError(400, 'blockId is required')
  if (blockId.startsWith('virtual:')) throw new AdminHttpError(409, 'Recovered legacy fragments are read-only display data')
  if (!/^L?[0-5]$/i.test(target)) throw new AdminHttpError(400, 'level must be L0 through L5')
  return runtime.adminExpandBlock(namespace, blockId, target)
}

async function retryBlockSummary(runtime: StrataGateRuntime, url: URL): Promise<unknown> {
  const namespace = url.searchParams.get('namespace')?.trim() ?? ''
  const blockId = url.searchParams.get('blockId')?.trim() ?? ''
  if (!namespace) throw new AdminHttpError(400, 'namespace is required')
  if (!blockId) throw new AdminHttpError(400, 'blockId is required')
  if (blockId.startsWith('virtual:')) throw new AdminHttpError(409, 'Recovered legacy fragments cannot be retried')
  const snapshot = await requiredSnapshot(runtime, namespace)
  const job = snapshot.summaryJobs.find(({ blockId: candidateId }) => candidateId === blockId)
  if (!job) throw new AdminHttpError(404, `Unknown Block Summary job: ${blockId}`)
  if (job.status !== 'failed') throw new AdminHttpError(409, `Block Summary is ${job.status}, not failed`)
  return runtime.adminRetryBlockSummary(namespace, blockId)
}

async function retryJob(runtime: StrataGateRuntime, url: URL): Promise<unknown> {
  const namespace = url.searchParams.get('namespace')?.trim() ?? ''
  const kind = url.searchParams.get('kind')?.trim() ?? ''
  const jobId = url.searchParams.get('jobId')?.trim() ?? ''
  if (!namespace) throw new AdminHttpError(400, 'namespace is required')
  if (!['block-summary', 'event-extraction', 'graph-projection'].includes(kind)) {
    throw new AdminHttpError(400, 'kind must be block-summary, event-extraction, or graph-projection')
  }
  if (!jobId) throw new AdminHttpError(400, 'jobId is required')
  if (jobId.startsWith('virtual:')) throw new AdminHttpError(409, 'Recovered legacy fragments cannot be retried')
  const snapshot = await requiredSnapshot(runtime, namespace)
  const job = kind === 'block-summary'
    ? snapshot.summaryJobs.find(({ blockId }) => blockId === jobId)
    : kind === 'event-extraction'
      ? snapshot.extractionJobs.find(({ blockId }) => blockId === jobId)
      : snapshot.graphProjectionJobs.find(({ id }) => id === jobId)
  if (!job) throw new AdminHttpError(404, `Unknown ${kind} job: ${jobId}`)
  if (job.status !== 'failed') throw new AdminHttpError(409, `${kind} job is ${job.status}, not failed`)
  try {
    return await runtime.adminRetryJob(
      namespace,
      kind as 'block-summary' | 'event-extraction' | 'graph-projection',
      jobId,
    )
  } catch (error) {
    throw new AdminHttpError(422, error instanceof Error ? error.message : String(error))
  }
}

function receiptSources(snapshot: StrataGateSnapshot, receipt: UsageReceipt): unknown {
  const events = snapshot.events.filter(({ id }) => receipt.eventIds.includes(id))
  const elements = snapshot.elements.filter(({ id }) => receipt.elementIds.includes(id))
  const eventIds = new Set([...receipt.eventIds, ...elements.flatMap(({ sourceEventIds }) => sourceEventIds)])
  const supportingEvents = snapshot.events.filter(({ id }) => eventIds.has(id))
  const messageIds = new Set(supportingEvents.flatMap(({ sourceMessageIds }) => sourceMessageIds))
  return {
    ...receipt,
    events: events.map(eventSummary),
    elements: elements.map(elementSummary),
    sourceMessages: sourceMessages(snapshot, messageIds),
  }
}

async function audit(runtime: StrataGateRuntime, url: URL): Promise<unknown> {
  const namespace = url.searchParams.get('namespace')?.trim() ?? ''
  if (!namespace) throw new AdminHttpError(400, 'namespace is required')
  const snapshot = await requiredSnapshot(runtime, namespace)
  const offset = numeric(url.searchParams.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER)
  const limit = numeric(url.searchParams.get('limit'), 50, 1, 100)
  const receipts = [...snapshot.usageReceipts].reverse()
  return {
    namespace,
    total: receipts.length,
    offset,
    limit,
    items: receipts.slice(offset, offset + limit).map((receipt) => receiptSources(snapshot, receipt)),
  }
}

interface DashboardResult {
  etag: string
  notModified: boolean
  body?: unknown
}

function requestHeader(req: WebRequest, name: string): string {
  const headers = req.headers ?? {}
  const key = Object.keys(headers).find((candidate) => candidate.toLocaleLowerCase() === name.toLocaleLowerCase())
  const value = key ? headers[key] : undefined
  return Array.isArray(value) ? value.join(', ') : value ?? ''
}

async function dashboard(runtime: StrataGateRuntime, url: URL, ifNoneMatch: string): Promise<DashboardResult> {
  const entries = await runtime.adminSnapshotEntries()
  const requestedNamespace = url.searchParams.get('namespace')?.trim() ?? ''
  const selected = entries.find(({ namespace }) => namespace === requestedNamespace) ?? entries[0]
  const threadId = url.searchParams.get('threadId')?.trim() ?? ''
  const revisionKey = entries.map(({ namespace, revision }) => `${namespace}:${revision}`).join('|')
  const etag = `"${createHash('sha256').update(`${revisionKey}\0${selected?.namespace ?? ''}\0${threadId}`).digest('base64url').slice(0, 24)}"`
  if (ifNoneMatch.split(',').map((value) => value.trim()).includes(etag)) return { etag, notModified: true }

  const overviewValue = await overview(runtime, entries)
  if (!selected) {
    return { etag, notModified: false, body: { namespace: null, overview: overviewValue, data: null, processing: false } }
  }

  const snapshotRuntime = {
    adminSnapshot: async (namespace: string) => namespace === selected.namespace ? selected.snapshot : null,
  } as unknown as StrataGateRuntime
  const memoryUrl = (kind: string, limit?: string): URL => {
    const target = new URL(url)
    target.searchParams.set('namespace', selected.namespace)
    target.searchParams.set('kind', kind)
    if (limit) target.searchParams.set('limit', limit)
    return target
  }
  const [eventResult, graphResult, blockResult, auditResult] = await Promise.all([
    memories(snapshotRuntime, memoryUrl('events', '40')),
    memories(snapshotRuntime, memoryUrl('graph')),
    memories(snapshotRuntime, memoryUrl('blocks', '40')),
    audit(snapshotRuntime, memoryUrl('audit', '100')),
  ]) as [any, any, any, any]
  const selectedOverview = (overviewValue as { namespaces?: Array<{ namespace: string; processingJobs?: number }> })
    .namespaces?.find(({ namespace }) => namespace === selected.namespace)
  return {
    etag,
    notModified: false,
    body: {
      namespace: selected.namespace,
      revision: selected.revision,
      overview: overviewValue,
      processing: Number(selectedOverview?.processingJobs ?? 0) > 0,
      data: {
        events: eventResult.items ?? [],
        graph: graphResult,
        blocks: blockResult.items ?? [],
        openBlock: blockResult.openBlock ?? null,
        conversations: blockResult.conversations ?? [],
        activeThreadId: blockResult.activeThreadId ?? null,
        audit: auditResult.items ?? [],
        pagination: {
          events: { total: eventResult.total ?? 0, offset: eventResult.offset ?? 0, limit: eventResult.limit ?? 40 },
          blocks: { total: blockResult.total ?? 0, offset: blockResult.offset ?? 0, limit: blockResult.limit ?? 40 },
          audit: { total: auditResult.total ?? 0, offset: auditResult.offset ?? 0, limit: auditResult.limit ?? 100 },
        },
      },
    },
  }
}

function sendDashboard(res: WebResponse, result: DashboardResult): void {
  res.setHeader('ETag', result.etag)
  res.setHeader('Cache-Control', 'private, no-cache')
  if (result.notModified) {
    res.statusCode = 304
    res.end('')
    return
  }
  res.statusCode = 200
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(redactValue(result.body)))
}

export async function handleAdminRequest(runtime: StrataGateRuntime, req: WebRequest, res: WebResponse): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname.replace(/\/$/, '')
    if (path === '/api/stratagate/feedback') {
      sendJson(res, 200, await feedback(runtime, req, url))
    } else if (path === '/api/stratagate/settings') {
      if (req.method !== 'PATCH') throw new AdminHttpError(405, 'StrataGate settings require PATCH')
      sendJson(res, 200, await updateSettings(runtime, url))
    } else if (path === '/api/stratagate/blocks/expand') {
      if (req.method !== 'PATCH') throw new AdminHttpError(405, 'StrataGate Block expansion requires PATCH')
      sendJson(res, 200, await expandBlock(runtime, url))
    } else if (path === '/api/stratagate/blocks/retry-summary') {
      if (req.method !== 'POST') throw new AdminHttpError(405, 'StrataGate Block Summary retry requires POST')
      sendJson(res, 200, await retryBlockSummary(runtime, url))
    } else if (path === '/api/stratagate/jobs/retry') {
      if (req.method !== 'POST') throw new AdminHttpError(405, 'StrataGate job retry requires POST')
      sendJson(res, 200, await retryJob(runtime, url))
    } else if (path === '/api/stratagate/import') {
      if (req.method === 'GET') {
        const operation = url.searchParams.get('operation')
        if (operation === 'status') {
          const namespace = url.searchParams.get('namespace')?.trim() ?? ''
          if (!namespace) throw new AdminHttpError(400, 'namespace is required')
          const jobId = url.searchParams.get('jobId')?.trim() || undefined
          sendJson(res, 200, await runtime.adminExternalMemoryStatus(namespace, jobId))
        } else {
          sendJson(res, 200, externalMemoryPrompt())
        }
      }
      else if (req.method === 'POST') sendJson(res, 200, await importExternalMemory(runtime, req))
      else throw new AdminHttpError(405, 'External memory import requires GET or POST')
    } else if (req.method !== 'GET') throw new AdminHttpError(405, 'StrataGate memory data is read-only')
    else if (path === '/api/stratagate/dashboard') sendDashboard(res, await dashboard(runtime, url, requestHeader(req, 'if-none-match')))
    else if (path === '/api/stratagate/overview') sendJson(res, 200, await overview(runtime))
    else if (path === '/api/stratagate/memories') sendJson(res, 200, await memories(runtime, url))
    else if (path === '/api/stratagate/sources') sendJson(res, 200, await sources(runtime, url))
    else if (path === '/api/stratagate/audit') sendJson(res, 200, await audit(runtime, url))
    else throw new AdminHttpError(404, 'Unknown StrataGate admin route')
  } catch (error) {
    const status = error instanceof AdminHttpError ? error.status : 500
    const message = error instanceof Error ? error.message : String(error)
    sendJson(res, status, { error: message })
  }
}

export function registerAdminRoutes(ctx: Context, runtime: StrataGateRuntime): (() => void) | undefined {
  const webServer = ctx.get('webServer') as WebServerLike | undefined
  if (!webServer) return undefined
  return webServer.register({
    kind: 'prefix',
    path: '/api/stratagate',
    handler: (req, res) => handleAdminRequest(runtime, req, res),
  })
}
