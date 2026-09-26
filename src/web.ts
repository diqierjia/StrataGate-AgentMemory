import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import type { Context } from '@deepseek-ai/cordis'
import {
  DERIVATION_MAX_ATTEMPTS,
  deterministicBlockLayers,
  effectiveGraphNodeView,
  estimateTokens,
  EXTERNAL_MEMORY_EXPORT_PROMPT_ZH_CN,
  formatRawTranscript,
  getDecayedBlockLevel,
  KNOWLEDGE_GRAPH_PROJECTOR_VERSION,
  memoryWeightAt,
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

const LEGACY_THREAD_ID = '__legacy__'
const nodeRequire = createRequire(import.meta.url)

function currentPluginVersion(): string {
  try {
    const value = nodeRequire('../package.json') as { version?: unknown }
    if (typeof value.version === 'string' && value.version.trim()) return value.version
  } catch {}
  return 'unknown'
}

const STRATAGATE_DSH_VERSION = currentPluginVersion()

function graphProjectionIsProcessing(job: {
  status: string
  attempts: number
  nextRetryAt: string | null
}): boolean {
  return derivationJobState(job, false) === 'processing'
    || derivationJobState(job, false) === 'retryable'
}

type DerivationJobState = 'processing' | 'retryable' | 'terminal-failed' | 'completed' | 'blocked'

function derivationJobState(job: {
  status: string
  attempts: number
  nextRetryAt: string | null
}, completed: boolean): DerivationJobState {
  if (completed || job.status === 'succeeded' || job.status === 'skipped' || job.status === 'completed') return 'completed'
  if (job.status === 'running') return 'processing'
  if (job.status === 'pending') return job.attempts < DERIVATION_MAX_ATTEMPTS ? 'processing' : 'blocked'
  if (job.status === 'failed') {
    const retryable = job.attempts < DERIVATION_MAX_ATTEMPTS
      && job.nextRetryAt !== null
      && Number.isFinite(Date.parse(job.nextRetryAt))
    return retryable ? 'retryable' : 'terminal-failed'
  }
  return 'blocked'
}

function summarizeDerivationJobs(jobs: ReadonlyArray<{
  status: string
  attempts: number
  nextRetryAt: string | null
}>, completed: (job: { status: string }) => boolean): {
  processing: number
  retryable: number
  terminalFailed: number
  completed: number
  blocked: number
} {
  const result = { processing: 0, retryable: 0, terminalFailed: 0, completed: 0, blocked: 0 }
  for (const job of jobs) {
    const state = derivationJobState(job, completed(job))
    if (state === 'processing') result.processing += 1
    else if (state === 'retryable') {
      result.retryable += 1
      result.processing += 1
    } else if (state === 'terminal-failed') result.terminalFailed += 1
    else if (state === 'completed') result.completed += 1
    else result.blocked += 1
  }
  return result
}

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

function sendJson(res: WebResponse, status: number, body: unknown, preserveProfileText = false): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(preserveProfileText ? body : redactValue(body)))
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

interface EventWeightTrajectoryPoint {
  turn: number
  weight: number
  kind: 'sample' | 'creation' | 'adoption' | 'current'
  label?: string
  adoptionCount?: number
}

interface EventWeightTrajectorySegment {
  certainty: 'known' | 'incomplete'
  points: EventWeightTrajectoryPoint[]
}

function sampledEventWeight(
  event: EventCard,
  turn: number,
  lastAdoptedTurn: number,
  mentionCount: number,
): number {
  return memoryWeightAt({
    status: event.status,
    weight: { ...event.weight, lastAdoptedTurn, mentionCount },
  }, turn)
}

function appendWeightSegment(
  points: EventWeightTrajectoryPoint[],
  event: EventCard,
  fromTurn: number,
  toTurn: number,
  mentionCount: number,
): void {
  if (toTurn < fromTurn) return
  if (toTurn === fromTurn) return
  const span = toTurn - fromTurn
  const samples = Math.min(256, Math.max(12, Math.ceil(span * 12)))
  const step = span / samples
  for (let turn = fromTurn; turn < toTurn; turn += step) {
    points.push({ turn, weight: sampledEventWeight(event, turn, fromTurn, mentionCount), kind: 'sample' })
  }
  points.push({ turn: toTurn, weight: sampledEventWeight(event, toTurn, fromTurn, mentionCount), kind: 'sample' })
}

function eventWeightTrajectory(snapshot: StrataGateSnapshot, event: EventCard): unknown {
  const currentTurn = snapshot.currentTurn
  const formedTurn = Number.isSafeInteger(event.formedTurn) && event.formedTurn! >= 0
    ? event.formedTurn!
    : null
  const sourceBlock = snapshot.blocks.find(({ id }) => id === event.sourceBlockId)
  const sourceBlockEndTurn = Number.isSafeInteger(sourceBlock?.endTurn) && sourceBlock!.endTurn >= 0
    ? sourceBlock!.endTurn
    : null
  const effectiveAdoptions = Math.max(0, event.weight.mentionCount - 1)
  const adoptionReceipts = snapshot.usageReceipts.filter(({ eventIds }) => eventIds.includes(event.id))
  const adoptionTurns = adoptionReceipts
    .map(({ audit }) => audit?.turn)
    .filter((turn): turn is number => Number.isSafeInteger(turn) && turn! >= 0)
    .sort((left, right) => left - right)
  const confirmedAdoptionTurns = [...adoptionTurns]
  if (effectiveAdoptions > 0 && Number.isSafeInteger(event.weight.lastAdoptedTurn) && event.weight.lastAdoptedTurn >= 0) {
    confirmedAdoptionTurns.push(event.weight.lastAdoptedTurn)
  }
  confirmedAdoptionTurns.sort((left, right) => left - right)
  const groupedAdoptions = [...new Set(confirmedAdoptionTurns)].map((turn) => ({
    turn,
    adoptionCount: Math.max(1, adoptionTurns.filter((value) => value === turn).length),
  }))
  const earliestKnownAdoptionTurn = groupedAdoptions[0]?.turn ?? null
  const trajectoryStartTurn = formedTurn ?? sourceBlockEndTurn ?? earliestKnownAdoptionTurn ?? currentTurn
  const formationTurnSource = formedTurn !== null ? 'formedTurn' : sourceBlockEndTurn !== null ? 'sourceBlock' : null
  const historyComplete = adoptionReceipts.length === effectiveAdoptions
    && adoptionTurns.length === adoptionReceipts.length
    && (effectiveAdoptions === 0 || adoptionTurns.at(-1) === event.weight.lastAdoptedTurn)
    && adoptionTurns.every((turn) => turn >= trajectoryStartTurn)
    && (effectiveAdoptions > 0 || event.weight.lastAdoptedTurn === trajectoryStartTurn)
  const adoptionHistoryComplete = adoptionReceipts.length === effectiveAdoptions
    && adoptionReceipts.every((receipt) => Boolean(receipt.createdAt)
      && Number.isFinite(Date.parse(receipt.createdAt))
      && Boolean(receipt.audit?.sessionId?.trim())
      && Number.isSafeInteger(receipt.audit?.turn)
      && receipt.audit!.turn! >= 0)
    && (formedTurn === null || adoptionReceipts.every((receipt) => receipt.audit!.turn! >= formedTurn))
  const adoptionHistory = adoptionReceipts
      .filter((receipt) => Boolean(receipt.createdAt)
        && Number.isFinite(Date.parse(receipt.createdAt))
        && Boolean(receipt.audit?.sessionId?.trim())
        && Number.isSafeInteger(receipt.audit?.turn)
        && receipt.audit!.turn! >= 0
        && (formedTurn === null || receipt.audit!.turn! >= formedTurn))
      .map((receipt) => ({
        receiptId: receipt.id,
        createdAt: receipt.createdAt,
        sessionId: receipt.audit!.sessionId!,
        turn: receipt.audit!.turn!,
        ...(formedTurn === null ? {} : { relativeTurn: receipt.audit!.turn! - formedTurn }),
        evidenceRefs: receipt.audit?.evidenceRefs ?? [],
      }))
      .sort((left, right) => left.turn - right.turn || left.createdAt.localeCompare(right.createdAt))
  const canInterpolate = event.status !== 'forgotten' && event.status !== 'archived'
    && event.weight.forcedCap === null && !event.weight.pinned
  const segments: EventWeightTrajectorySegment[] = []
  const originPoint: EventWeightTrajectoryPoint | null = formationTurnSource
    ? { turn: trajectoryStartTurn, weight: 1, kind: 'creation', label: formationTurnSource === 'formedTurn' ? '形成' : '来源' }
    : null

  if (canInterpolate && historyComplete && originPoint) {
    const lifecycle: EventWeightTrajectoryPoint[] = [originPoint]
    let anchorTurn = trajectoryStartTurn
    let mentionCount = 1
    for (const { turn, adoptionCount } of groupedAdoptions) {
      if (turn < trajectoryStartTurn || turn > currentTurn) continue
      appendWeightSegment(lifecycle, event, anchorTurn, turn, mentionCount)
      lifecycle.push({ turn, weight: 1, kind: 'adoption', adoptionCount, label: adoptionCount > 1 ? `采纳 ×${adoptionCount}` : '采纳' })
      anchorTurn = turn
      mentionCount += adoptionCount
    }
    appendWeightSegment(lifecycle, event, anchorTurn, currentTurn, mentionCount)
    segments.push({ certainty: 'known', points: lifecycle })
  } else if (canInterpolate) {
    let anchorPoint = originPoint
    let mentionCount = 1
    const visibleAdoptions = groupedAdoptions.filter(({ turn }) => turn >= trajectoryStartTurn && turn <= currentTurn)
    for (const { turn, adoptionCount } of visibleAdoptions) {
      if (anchorPoint && turn > anchorPoint.turn) {
        const incomplete: EventWeightTrajectoryPoint[] = [anchorPoint]
        appendWeightSegment(incomplete, event, anchorPoint.turn, turn, mentionCount)
        incomplete.push({ turn, weight: 1, kind: 'adoption', adoptionCount, label: adoptionCount > 1 ? `采纳 ×${adoptionCount}` : '采纳' })
        segments.push({ certainty: 'incomplete', points: incomplete })
      } else {
        segments.push({ certainty: 'known', points: [{ turn, weight: 1, kind: 'adoption', adoptionCount, label: adoptionCount > 1 ? `采纳 ×${adoptionCount}` : '采纳' }] })
      }
      anchorPoint = { turn, weight: 1, kind: 'adoption', adoptionCount, label: adoptionCount > 1 ? `采纳 ×${adoptionCount}` : '采纳' }
      mentionCount += adoptionCount
    }
    if (anchorPoint && anchorPoint.turn <= currentTurn) {
      const latestIsReliable = effectiveAdoptions > 0
        && anchorPoint.turn === event.weight.lastAdoptedTurn
        && visibleAdoptions.at(-1)?.turn === event.weight.lastAdoptedTurn
      const tail: EventWeightTrajectoryPoint[] = [anchorPoint]
      appendWeightSegment(tail, event, anchorPoint.turn, currentTurn, latestIsReliable ? event.weight.mentionCount : mentionCount)
      if (tail.length > 1) segments.push({ certainty: latestIsReliable ? 'known' : 'incomplete', points: tail })
    } else if (originPoint && originPoint.turn <= currentTurn) {
      const tail: EventWeightTrajectoryPoint[] = [originPoint]
      appendWeightSegment(tail, event, originPoint.turn, currentTurn, 1)
      if (tail.length > 1) segments.push({ certainty: historyComplete ? 'known' : 'incomplete', points: tail })
      else segments.push({ certainty: 'known', points: [originPoint] })
    }
  } else if (originPoint) {
    segments.push({ certainty: 'known', points: [originPoint] })
  }

  const currentWeight = memoryWeightAt(event, currentTurn)
  const lastSegment = segments.at(-1)
  if (!lastSegment || lastSegment.points.at(-1)?.turn !== currentTurn) {
    segments.push({ certainty: 'known', points: [{ turn: currentTurn, weight: currentWeight, kind: 'current', label: '当前' }] })
  } else if (lastSegment.points.at(-1)?.kind === 'sample') {
    lastSegment.points[lastSegment.points.length - 1] = { ...lastSegment.points[lastSegment.points.length - 1]!, weight: currentWeight, kind: 'current', label: '当前' }
  } else {
    segments.push({ certainty: 'known', points: [{ turn: currentTurn, weight: currentWeight, kind: 'current', label: '当前' }] })
  }
  const points = segments.flatMap(({ points: segmentPoints }) => segmentPoints)

  return {
    scale: 'conversation_turn',
    formedTurn,
    trajectoryStartTurn,
    formationTurnSource,
    currentTurn,
    currentWeight,
    effectiveAdoptions,
    floorWeight: event.weight.floorWeight,
    criticality: event.criticality,
    latestAdoptionTurn: effectiveAdoptions > 0 ? event.weight.lastAdoptedTurn : null,
    turnsSinceLatestAdoption: effectiveAdoptions > 0
      ? Math.max(0, currentTurn - event.weight.lastAdoptedTurn)
      : null,
    lastRetrievedAt: event.weight.lastRetrievedAt,
    recordedAdoptionTurns: adoptionTurns,
    historyComplete,
    adoptionHistoryComplete,
    adoptionHistory,
    segments,
    points,
    note: !canInterpolate
      ? '固定、封存或状态上限的变更轮次没有历史记录，因此仅显示当前真实权重。'
      : !historyComplete
        ? '旧版本未记录部分采纳的具体轮次；确定节点与区间照常显示，缺失区间仅作趋势连接。'
        : effectiveAdoptions > 0
          ? '采纳轮次来自真实使用回执。'
          : '尚未被 Agent 采纳。',
  }
}

function eventSummary(event: EventCard, snapshot?: StrataGateSnapshot): unknown {
  return {
    id: event.id,
    formedTurn: event.formedTurn,
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
    ...(snapshot ? { weightTrajectory: eventWeightTrajectory(snapshot, event) } : {}),
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
    const recovered = recoverSnapshotView(snapshot)
    const blockDetails = (blockIds: string[]) => [...new Set(blockIds)].flatMap((blockId) => {
      const displayBlocks = recovered.blocks.filter(({ source, threadId }) => source.id === blockId && threadId !== LEGACY_THREAD_ID)
      if (displayBlocks.length > 0) {
        return displayBlocks.map((block) => ({
          id: block.id,
          sourceId: block.source.id,
          sequence: block.source.sequence,
          title: block.source.l0Title ?? null,
          threadId: block.threadId,
          turnRange: block.turnRange,
          shouldExtract: block.source.shouldExtract ?? null,
        }))
      }
      const block = snapshot.blocks.find(({ id }) => id === blockId)
      return block ? [{
        id: block.id,
        sourceId: block.id,
        sequence: block.sequence,
        title: block.l0Title ?? null,
        threadId: block.threadId ?? null,
        turnRange: [block.startTurn, block.endTurn] as [number, number],
        shouldExtract: block.shouldExtract ?? null,
      }] : []
    })
    const describeBlockJob = (kind: 'block-summary' | 'event-extraction', job: {
      blockId: string
      status: string
      attempts: number
      nextRetryAt: string | null
      lastError: string | null
      updatedAt: string
    }) => {
      const state = derivationJobState(job, kind === 'block-summary'
        ? job.status === 'succeeded'
        : job.status === 'succeeded' || job.status === 'skipped')
      const details = blockDetails([job.blockId])
      return {
        id: job.blockId,
        kind,
        state,
        status: job.status,
        attempts: job.attempts,
        nextRetryAt: job.nextRetryAt,
        lastError: job.lastError?.slice(0, 500) ?? null,
        lastErrorFull: job.lastError,
        updatedAt: job.updatedAt,
        threadId: details[0]?.threadId ?? null,
        blockIds: [job.blockId],
        threadIds: [...new Set(details.flatMap(({ threadId }) => threadId ?? []))],
        blockDetails: details,
        sequence: details[0]?.sequence ?? null,
        turnRange: details[0]?.turnRange ?? null,
      }
    }
    const describeGraphJob = (job: (typeof snapshot.graphProjectionJobs)[number]) => {
      const state = derivationJobState(job, job.status === 'completed')
      const blockIds = [...new Set(job.sourceEventIds.flatMap((eventId) =>
        snapshot.events.find(({ id }) => id === eventId)?.sourceBlockId ?? []))]
      const details = blockDetails(blockIds)
      return {
        id: job.id,
        kind: 'graph-projection' as const,
        state,
        status: job.status,
        attempts: job.attempts,
        nextRetryAt: job.nextRetryAt,
        lastError: job.lastError?.slice(0, 500) ?? null,
        lastErrorFull: job.lastError,
        updatedAt: job.updatedAt,
        blockIds,
        threadIds: [...new Set(details.flatMap(({ threadId }) => threadId ?? []))],
        blockDetails: details,
        sequences: details.map(({ sequence }) => sequence),
        sourceEventIds: job.sourceEventIds,
      }
    }
    const summaryStatus = summarizeDerivationJobs(snapshot.summaryJobs, (job) => job.status === 'succeeded')
    const extractionStatus = summarizeDerivationJobs(snapshot.extractionJobs, (job) => job.status === 'succeeded' || job.status === 'skipped')
    const graphStatus = summarizeDerivationJobs(snapshot.graphProjectionJobs, (job) => job.status === 'completed')
    const failedJobs = summaryStatus.terminalFailed + extractionStatus.terminalFailed + graphStatus.terminalFailed
    const processingJobs = summaryStatus.processing + extractionStatus.processing + graphStatus.processing
    const failedJobDetails = [
      ...snapshot.summaryJobs
        .filter(({ status }) => status === 'failed')
        .map((job) => describeBlockJob('block-summary', job)),
      ...snapshot.extractionJobs
        .filter(({ status }) => status === 'failed')
        .map((job) => describeBlockJob('event-extraction', job)),
      ...snapshot.graphProjectionJobs
        .filter(({ status }) => status === 'failed')
        .map(describeGraphJob),
    ]
    const processingJobDetails = [
      ...snapshot.summaryJobs
        .filter((job) => derivationJobState(job, job.status === 'succeeded') === 'processing'
          || derivationJobState(job, job.status === 'succeeded') === 'retryable')
        .map((job) => describeBlockJob('block-summary', job)),
      ...snapshot.extractionJobs
        .filter((job) => derivationJobState(job, job.status === 'succeeded' || job.status === 'skipped') === 'processing'
          || derivationJobState(job, job.status === 'succeeded' || job.status === 'skipped') === 'retryable')
        .map((job) => describeBlockJob('event-extraction', job)),
      ...snapshot.graphProjectionJobs
        .filter(graphProjectionIsProcessing)
        .map(describeGraphJob),
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
      agentMemoryRetrievalWeight: runtime.adminAgentMemoryRetrievalWeight?.() ?? 1,
      blocks: snapshot.blocks.length,
      openTailMessages: snapshot.openTail.length,
      events: snapshot.events.length,
      activeEvents: snapshot.events.filter(({ status }) => status === 'active').length,
      elements: snapshot.elements.length,
      graphNodes: snapshot.graphNodes.length,
      graphEdges: snapshot.graphEdges.length,
      taskStatus: {
        blockSummary: summaryStatus,
        eventExtraction: extractionStatus,
        graphProjection: graphStatus,
      },
      graphMigration: (() => {
        const projected = new Set(snapshot.graphProjectionJobs
          .filter(({ status, projectorVersion }) => status === 'completed' && projectorVersion === KNOWLEDGE_GRAPH_PROJECTOR_VERSION)
          .flatMap(({ sourceEventIds }) => sourceEventIds)).size
        const total = snapshot.events.filter(({ status }) => status !== 'forgotten' && status !== 'archived').length
        const complete = projected >= total
        const state = complete
          ? 'complete'
          : graphStatus.processing > 0
            ? 'processing'
            : graphStatus.terminalFailed > 0
              ? 'failed'
              : 'incomplete'
        return {
          projected,
          total,
          pending: snapshot.graphProjectionJobs.filter(({ status }) => status === 'pending').length,
          running: snapshot.graphProjectionJobs.filter(({ status }) => status === 'running').length,
          failed: graphStatus.terminalFailed,
          retryable: graphStatus.retryable,
          processing: graphStatus.processing,
          state,
          complete,
        }
      })(),
      usageReceipts: snapshot.usageReceipts.length,
      memoryUseCount: snapshot.usageReceipts.filter((receipt) =>
        receipt.eventIds.length > 0 || receipt.elementIds.length > 0).length,
      failedJobs,
      processingJobs,
      failedJobDetails,
      processingJobDetails,
      successfulModelResponses: snapshot.successfulModelResponses ?? [],
      lastActivityAt: timestamps.at(-1) ?? null,
    })
  }
  return {
    readonly: true,
    settingsWritable: true,
    dataDirectory: runtime.adminDataDirectory?.() ?? null,
    pluginVersion: STRATAGATE_DSH_VERSION,
    harnessVersion: installedPackageVersion(['@deepseek-ai/dsh', '@deepseek-ai/dsh-session']),
    namespaces: rows,
  }
}

async function updateSettings(runtime: StrataGateRuntime, url: URL): Promise<unknown> {
  const rawTurnSize = url.searchParams.get('blockTurnSize')?.trim()
  const rawLambda = url.searchParams.get('blockDecayLambda')?.trim()
  const rawAgentWeight = url.searchParams.get('agentMemoryRetrievalWeight')?.trim()
  if (rawTurnSize === undefined && rawLambda === undefined && rawAgentWeight === undefined) {
    throw new AdminHttpError(400, 'blockTurnSize, blockDecayLambda, or agentMemoryRetrievalWeight is required')
  }
  let turnSize: number | undefined
  let lambda: number | undefined
  let agentWeight: number | undefined
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
  if (rawAgentWeight !== undefined) {
    const value = Number(rawAgentWeight)
    if (rawAgentWeight === '' || !Number.isFinite(value) || value < 0 || value > 5) {
      throw new AdminHttpError(400, 'agentMemoryRetrievalWeight must be a finite number between 0 and 5')
    }
    agentWeight = value
  }
  const result: { blockTurnSize?: number; blockDecayLambda?: number; agentMemoryRetrievalWeight?: number } = {}
  if (turnSize !== undefined) result.blockTurnSize = await runtime.adminSetBlockTurnSize(turnSize)
  if (lambda !== undefined) result.blockDecayLambda = await runtime.adminSetBlockDecayLambda(lambda)
  if (agentWeight !== undefined) result.agentMemoryRetrievalWeight = runtime.adminSetAgentMemoryRetrievalWeight(agentWeight)
  return result
}

async function persistentProfile(runtime: StrataGateRuntime, req: WebRequest): Promise<unknown> {
  if (req.method === 'GET') {
    const snapshot = runtime.getProfileSnapshot()
    return { ...snapshot.profile, _revisions: snapshot.revisions }
  }
  if (req.method !== 'PATCH') throw new AdminHttpError(405, 'Persistent Profile requires GET or PATCH')
  let suppliedBody = req.body
  if (suppliedBody === undefined && typeof req[Symbol.asyncIterator] === 'function') {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req as AsyncIterable<Uint8Array | string>) {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += value.length
      if (size > 16 * 1024) throw new AdminHttpError(413, 'Profile update exceeds 16 KB')
      chunks.push(value)
    }
    suppliedBody = Buffer.concat(chunks).toString('utf8')
  }
  let body: unknown = suppliedBody
  if (typeof body === 'string') {
    try { body = JSON.parse(body) } catch { throw new AdminHttpError(400, 'Profile update must be valid JSON') }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AdminHttpError(400, 'Profile update must be an object')
  const input = body as Record<string, unknown>
  if (Object.keys(input).length !== 4 || !Object.hasOwn(input, 'field') || !Object.hasOwn(input, 'value') || !Object.hasOwn(input, 'expectedValue') || !Object.hasOwn(input, 'expectedRevision')
    || typeof input.field !== 'string' || typeof input.value !== 'string' || typeof input.expectedValue !== 'string'
    || !Number.isSafeInteger(input.expectedRevision) || (input.expectedRevision as number) < 0) {
    throw new AdminHttpError(400, 'Profile update requires field, value, expectedValue strings and expectedRevision number')
  }
  try {
    const result = runtime.updatePersistentProfile(input.field, input.value, 'settings', null, input.expectedValue, input.expectedRevision as number)
    if (result.conflict) throw new AdminHttpError(409, '该项刚刚在其他位置更新')
    const snapshot = runtime.getProfileSnapshot()
    return { ...result, snapshot: { ...snapshot.profile, _revisions: snapshot.revisions } }
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) throw new AdminHttpError(400, error.message)
    throw error
  }
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
  if (kind === 'events') {
    const timeline = url.searchParams.get('timeline') === 'true'
    const timeFilter = url.searchParams.get('time')?.trim() ?? ''
    const participant = url.searchParams.get('participant')?.trim() ?? ''
    const eventType = url.searchParams.get('eventType')?.trim() ?? ''
    const eventStatus = url.searchParams.get('eventStatus')?.trim() ?? ''
    const now = new Date()
    const weekAgo = now.getTime() - 7 * 86_400_000
    const occurrence = (event: EventCard): { value: string; known: boolean } => {
      const happened = event.temporal.happenedStart ?? event.temporal.happenedEnd
      return { value: happened ?? event.temporal.mentionedAt ?? event.createdAt, known: Boolean(happened) }
    }
    values = [...snapshot.events]
      .sort((left, right) => occurrence(right).value.localeCompare(occurrence(left).value))
      .filter((event) => !timeline || (event.status !== 'forgotten' && event.status !== 'archived'))
      .filter((event) => !eventType || event.temporal.eventType === eventType)
      .filter((event) => !eventStatus || event.temporal.status === eventStatus)
      .filter((event) => !participant || (event.temporal.participantNodeIds ?? []).includes(participant))
      .filter((event) => {
        if (!timeFilter) return true
        const info = occurrence(event)
        if (timeFilter === 'unknown') return !info.known
        const time = Date.parse(info.value)
        if (timeFilter === 'today') return Number.isFinite(time) && new Date(time).toDateString() === now.toDateString()
        if (timeFilter === 'week') return Number.isFinite(time) && time >= weekAgo
        return true
      })
      .map((event) => ({
        ...(eventSummary(event, snapshot) as object),
        relatedNodes: snapshot.graphNodes
          .filter(({ id }) => (event.temporal.participantNodeIds ?? []).includes(id))
          .map(({ id, name, type, aliases }) => ({ id, name, type, aliases })),
        relatedElements: snapshot.elements
          .filter(({ sourceEventIds }) => sourceEventIds.includes(event.id))
          .map(({ id, name }) => ({ id, name })),
      }))
  }
  else if (kind === 'graph') {
    const eventMap = new Map(snapshot.events.map((event) => [event.id, event]))
    return {
      namespace,
      kind,
      projectorVersion: KNOWLEDGE_GRAPH_PROJECTOR_VERSION,
      nodes: snapshot.graphNodes.map((node) => ({
        ...node,
        supportingEvents: node.sourceEventIds.flatMap((id) => eventMap.get(id) ?? []).map((event) => eventSummary(event)),
      })),
      edges: snapshot.graphEdges,
      clusters: clusterKnowledgeGraph(snapshot.graphNodes, snapshot.graphEdges),
      migration: (() => {
        const projected = new Set(snapshot.graphProjectionJobs
          .filter(({ status, projectorVersion }) => status === 'completed' && projectorVersion === KNOWLEDGE_GRAPH_PROJECTOR_VERSION)
          .flatMap(({ sourceEventIds }) => sourceEventIds)).size
        const graphStatus = summarizeDerivationJobs(snapshot.graphProjectionJobs, (job) => job.status === 'completed')
        const total = snapshot.events.filter(({ status }) => status !== 'forgotten' && status !== 'archived').length
        const complete = projected >= total
        return {
          projected,
          total,
          pending: snapshot.graphProjectionJobs.filter(({ status }) => status === 'pending').length,
          running: snapshot.graphProjectionJobs.filter(({ status }) => status === 'running').length,
          failed: graphStatus.terminalFailed,
          retryable: graphStatus.retryable,
          processing: graphStatus.processing,
          state: complete
            ? 'complete'
            : graphStatus.processing > 0
              ? 'processing'
              : graphStatus.terminalFailed > 0
                ? 'failed'
                : 'incomplete',
          complete,
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
        relatedEvents: relatedEvents.map((event) => eventSummary(event)),
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
    const rawNode = snapshot.graphNodes.find(({ id }) => id === nodeId)
    if (!rawNode) throw new AdminHttpError(404, `Unknown graph node: ${nodeId}`)
    const view = effectiveGraphNodeView(rawNode, snapshot.graphEdges, snapshot.events)
    if (!view) throw new AdminHttpError(404, `Graph node has no retrievable Event evidence: ${nodeId}`)
    const edges = [...view.currentEdges, ...view.historicalEdges]
    const relatedNodeIds = new Set([rawNode.id, ...edges.flatMap(({ fromNodeId, toNodeId }) => [fromNodeId, toNodeId])])
    const nodes = snapshot.graphNodes
      .filter(({ id }) => relatedNodeIds.has(id))
      .flatMap((candidate) => effectiveGraphNodeView(candidate, snapshot.graphEdges, snapshot.events)?.node ?? [])
    const metadataEventIds = [
      ...(view.node.metadataProvenance?.name ?? []),
      ...(view.node.metadataProvenance?.aliases ?? []).flatMap(({ sourceEventIds }) => sourceEventIds),
      ...(view.node.metadataProvenance?.tags ?? []).flatMap(({ sourceEventIds }) => sourceEventIds),
    ]
    const eventIds = new Set([
      ...view.node.sourceEventIds,
      ...metadataEventIds,
      ...view.currentFacts.flatMap(({ sourceEventIds }) => sourceEventIds),
      ...view.historicalFacts.flatMap(({ sourceEventIds }) => sourceEventIds),
      ...edges.flatMap(({ sourceEventIds }) => sourceEventIds),
    ])
    events = snapshot.events.filter(({ id }) => eventIds.has(id))
    ids = new Set(events.flatMap(({ sourceMessageIds }) => sourceMessageIds))
    return {
      namespace,
      node: view.node,
      nodes,
      edges,
      currentFacts: view.currentFacts,
      historicalFacts: view.historicalFacts,
      currentEdges: view.currentEdges,
      historicalEdges: view.historicalEdges,
      events: events.map((event) => eventSummary(event)),
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
      events: events.map((event) => eventSummary(event)),
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
    events: events.map((event) => eventSummary(event, eventId ? snapshot : undefined)),
    ...(eventId ? {
      relatedNodes: snapshot.graphNodes
        .filter(({ id }) => events[0]?.temporal.participantNodeIds?.includes(id))
        .flatMap((candidate) => effectiveGraphNodeView(candidate, snapshot.graphEdges, snapshot.events)?.node ?? [])
        .map(({ id, name, type, aliases }) => ({ id, name, type, aliases })),
    } : {}),
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
    events: events.map((event) => eventSummary(event)),
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
  // Include the plugin version so an upgraded server cannot validate an ETag
  // generated by the previous UI/server pair when the memory revision is unchanged.
  const etag = `"${createHash('sha256').update(`${STRATAGATE_DSH_VERSION}\0${revisionKey}\0${selected?.namespace ?? ''}\0${threadId}`).digest('base64url').slice(0, 24)}"`
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
    } else if (path === '/api/stratagate/profile') {
      // This is the authenticated Settings editor. Redacting its editable values
      // would replace user data with placeholders on the next save.
      sendJson(res, 200, await persistentProfile(runtime, req), true)
    } else if (path === '/api/stratagate/settings') {
      if (req.method !== 'PATCH') throw new AdminHttpError(405, 'StrataGate settings require PATCH')
      sendJson(res, 200, await updateSettings(runtime, url))
    } else if (path === '/api/stratagate/storage/open-directory') {
      if (req.method !== 'POST') throw new AdminHttpError(405, 'StrataGate data directory open requires POST')
      sendJson(res, 200, await runtime.adminOpenDataDirectory(AbortSignal.timeout(15_000)))
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
    else if (path === '/api/stratagate/agent-memories') {
      const sessionId = url.searchParams.get('session')?.trim() ?? ''
      sendJson(res, 200, await runtime.adminAgentMemories({
        ...(sessionId ? { sessionId } : {}),
        ...(url.searchParams.get('includeArchived') === 'true' ? { includeArchived: true } : {}),
      }))
    }
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
