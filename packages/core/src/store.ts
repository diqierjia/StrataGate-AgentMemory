import {
  BLOCK_DECAY_LAMBDA,
  DEFAULT_BLOCK_TURN_SIZE,
  blockLevelLabel,
  deterministicBlockLayers,
  formatRawTranscript,
  getDecayedBlockLevel,
  normalizeBlockLevel,
} from './blocks.js';
import { applyElementChanges, elementViewAt } from './elements.js';
import { normalizeStandardEventType } from './events.js';
import { externalMemoryJsonExtractor, parseExternalMemoryExport } from './external-memory.js';
import { GRAPH_PROVENANCE_LIMIT, applyGraphProjection, boundEffectiveGraphNodeView, effectiveGraphNodeView, graphTimeline } from './graph.js';
import { normalizeRetrievalAssessment, type RetrievalAssessment, type RetrievalAssessmentInput } from './retrieval.js';
import { SqliteStorage } from './sqlite.js';
import {
  bm25Rank,
  fuzzySearchMatch,
  normalizeSearchText,
  rrfRank,
  searchTokens,
  weightedSearchTokens,
} from './search.js';
import {
  STRATAGATE_STORAGE_SCHEMA_VERSION,
  KNOWLEDGE_GRAPH_PROJECTOR_VERSION,
  DERIVATION_MAX_ATTEMPTS,
  cloneSnapshot,
  isSyntheticSourceThreadId,
  normalizeSnapshot,
  type ElementProjectionJob,
  type ExtractionJob,
  type BlockSummaryJob,
  type GraphProjectionJob,
  type IngestionReceipt,
  type SuccessfulModelResponse,
  type StorageAdapter,
  type StrataGateSnapshot,
  type UsageAudit,
  type UsageReceipt,
} from './storage.js';
import type {
  AppendTurnResult,
  AgentEventRecordOptions,
  AgentEventRecordResult,
  AgentEventCardInput,
  AgentMemoryCategory,
  BlockLevel,
  BlockLiftSource,
  BlockSummarizer,
  ElementCard,
  MemoryCriticality,
  ElementProjectionContext,
  ElementProjectionResult,
  ElementProjector,
  ElementSearchOptions,
  ElementSearchResult,
  EventCard,
  EventCardInput,
  EventExtractor,
  EventSearchResult,
  ExternalMemoryAction,
  ExternalMemoryCandidate,
  ExternalMemoryCommitOptions,
  ExternalMemoryDecision,
  ExternalMemoryExtractionResult,
  ExternalMemoryImportDecision,
  ExternalMemoryImportJob,
  ExternalMemoryImportOptions,
  ExternalMemoryImportPreview,
  ExternalMemoryImportResult,
  ExternalMemoryImportWorkItem,
  ExternalMemoryMatch,
  ExternalMemoryPreviewDecision,
  ExternalMemoryUndoResult,
  GraphEdge,
  GraphFact,
  GraphNode,
  GraphNodeSearchResult,
  GraphProjectionContext,
  GraphProjectionResult,
  GraphProjector,
  MemoryBlock,
  RawMessage,
  RawSearchOptions,
  RawSearchHit,
  SearchOptions,
  ToolTrace,
} from './types.js';
import { criticalityFloor, memoryWeightAt } from './weights.js';
import { toUtc8Iso } from './time.js';

export interface StrataGateOptions {
  blockTurnSize?: number;
  blockDecayLambda?: number;
  summarizer?: BlockSummarizer;
  extractor?: EventExtractor;
  elementProjector?: ElementProjector;
  /** Prevents creation of legacy Element projection jobs for graph-native hosts. */
  disableElementProjection?: boolean;
  graphProjector?: GraphProjector;
  now?: () => Date;
  idFactory?: (prefix: 'msg' | 'blk' | 'evt') => string;
  elementIdFactory?: (prefix: 'elem' | 'fact' | 'proj') => string;
  graphIdFactory?: (prefix: 'node' | 'edge' | 'gfact' | 'gproj') => string;
}

export interface PersistentStrataGateOptions extends StrataGateOptions {
  storage: StorageAdapter;
  namespace: string;
}

export interface SqliteStrataGateOptions extends StrataGateOptions {
  database: string;
  namespace: string;
  timeoutMs?: number;
}

export interface TurnInput {
  user: string;
  assistant: string;
  createdAt?: string;
  threadId?: string;
  userToolCalls?: ToolTrace[];
  assistantToolCalls?: ToolTrace[];
  receiptId?: string;
}

export interface AppendTurnOptions {
  /**
   * Persist the raw turn and its ingestion receipt without sealing blocks or
   * running model-backed derivation. A separate worker can later call
   * resumePendingWork(). This keeps host lifecycle hooks short and crash-safe.
   */
  deferProcessing?: boolean;
  /** Seal deterministic L3-L5 now, but leave model-backed work to resumePendingWork(). */
  deferDerivation?: boolean;
}

export interface BlockContextEntry {
  id: string;
  threadId?: string;
  turnRange: [number, number];
  age: number;
  level: BlockLevel;
  label: string;
  content: string;
}

export interface RecordMemoryUseOptions {
  receiptId?: string;
  audit?: UsageAudit;
}

export interface MemoryUseRefs {
  eventIds?: readonly string[];
  elementIds?: readonly string[];
}

export interface ResumePendingResult {
  sealedBlocks: MemoryBlock[];
  readyBlocks: MemoryBlock[];
  extractedEvents: EventCard[];
  projectedElements: ElementCard[];
}

export interface ResumePendingOptions {
  /** @deprecated Valid empty extraction is terminal; retained as a no-op for API compatibility. */
  retrySkipped?: boolean;
  /** Bypass a failed job's backoff, while still respecting the hard attempt cap. */
  retryFailed?: boolean;
  /** Limit model-backed work to one host conversation route. */
  threadId?: string;
  /** Seal every complete tail, but do not start model-backed jobs. */
  deferDerivation?: boolean;
}

function defaultIdFactory(prefix: 'msg' | 'blk' | 'evt'): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function defaultElementIdFactory(prefix: 'elem' | 'fact' | 'proj'): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function defaultGraphIdFactory(prefix: 'node' | 'edge' | 'gfact' | 'gproj'): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function renderBlock(block: MemoryBlock, level: BlockLevel): string {
  if (block.processingStatus !== 'ready' || !block.l0Title || !block.l0Tags || !block.l1Summary || !block.l2Keypoints) {
    throw new Error(`Block ${block.id} is not ready for rendering`);
  }
  if (level === 0) return `${block.l0Title}\nTags: ${block.l0Tags.join(', ') || 'none'}`;
  if (level === 1) return block.l1Summary;
  if (level === 2) return block.l2Keypoints.map((point) => `- ${point}`).join('\n') || block.l1Summary;
  const deterministic = deterministicBlockLayers(block.l5Raw);
  if (level === 3) return deterministic.l3Condensed;
  if (level === 4) return deterministic.l4Readable;
  return formatRawTranscript(block.l5Raw);
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function errorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'fullMessage' in error) {
    const fullMessage = (error as { fullMessage?: unknown }).fullMessage;
    if (typeof fullMessage === 'string') return fullMessage;
  }
  return error instanceof Error ? error.message : String(error);
}

const STRATAGATE_CONSTRUCTOR_TOKEN = Symbol('StrataGate constructor');
const EXTERNAL_MEMORY_AUTO_APPLY_CONFIDENCE = 0.85;

function externalMemoryFingerprint(value: Pick<ExternalMemoryCandidate, 'title' | 'summary'>): string {
  return `${normalizeSearchText(value.title)}\u0000${normalizeSearchText(value.summary)}`;
}
const AGENT_EVENT_NEAR_DUPLICATE = 0.85;
const AGENT_EVENT_AMBIGUOUS = 0.35;
const AGENT_EVENT_MIN_SHARED_TOKENS = 2;
/** Cap on real conversation messages cited as agent-event provenance. */
const AGENT_EVENT_PROVENANCE_LIMIT = 6;

/** Phase-1/2 boundary of the recordAgentEvent gate. */
type AgentEventGateOutcome =
  | { phase: 'done'; result: AgentEventRecordResult }
  | {
      phase: 'adjudicate';
      candidate: ExternalMemoryCandidate;
      matches: ExternalMemoryMatch[];
      ambiguous: string[];
      matchedEventIds: string[];
      now: string;
    };

/**
 * Share of the shorter side's unique search tokens contained in the other
 * side. Fewer than `AGENT_EVENT_MIN_SHARED_TOKENS` shared tokens counts as
 * zero so short queries never match everything.
 */
export function tokenContainment(candidateTokens: readonly string[], existingTokens: readonly string[]): number {
  const candidate = new Set(candidateTokens);
  const existing = new Set(existingTokens);
  if (candidate.size === 0 || existing.size === 0) return 0;
  const shared = [...candidate].filter((token) => existing.has(token)).length;
  if (shared < AGENT_EVENT_MIN_SHARED_TOKENS) return 0;
  return shared / Math.min(candidate.size, existing.size);
}

const AGENT_MEMORY_TAG = 'agent-recorded';

function agentEventCandidate(
  content: string,
  category: AgentMemoryCategory | undefined,
  now: string,
  threadId: string | undefined,
): ExternalMemoryCandidate {
  const summary = content.replace(/\s+/gu, ' ').trim().slice(0, 2_000);
  const firstSentence = summary.split(/[。．!！?？;\n]/u).map((part) => part.trim()).find(Boolean);
  const title = (firstSentence ?? summary).slice(0, 80) || 'Agent memory';
  return {
    title,
    summary,
    tags: [AGENT_MEMORY_TAG, ...(category ? [`category:${category}`] : [])],
    scope: 'user',
    confidence: 1,
    memoryKind: category === 'preference' ? 'preference' : category === 'decision' ? 'event' : 'fact',
    ...(category ? { category: category === 'preference' ? 'preference' : 'project' } : {}),
    temporal: {
      mentionedAt: now,
      eventType: category === 'decision' ? 'decision' : category === 'correction' ? 'change' : 'other',
      ...(threadId ? { threadId } : {}),
    },
  };
}

const DERIVATION_BACKOFF_MS = 1_000;

export class StrataGate {
  private blockTurnSizeValue: number;
  private blockDecayLambdaValue: number;
  private readonly summarizer: BlockSummarizer | undefined;
  private readonly extractor: EventExtractor | undefined;
  private readonly elementProjector: ElementProjector | undefined;
  private readonly disableElementProjection: boolean;
  private readonly graphProjector: GraphProjector | undefined;
  private readonly now: () => Date;
  private readonly idFactory: (prefix: 'msg' | 'blk' | 'evt') => string;
  private readonly elementIdFactory: (prefix: 'elem' | 'fact' | 'proj') => string;
  private readonly graphIdFactory: (prefix: 'node' | 'edge' | 'gfact' | 'gproj') => string;
  private readonly openTail: RawMessage[] = [];
  private readonly blocks: MemoryBlock[] = [];
  private readonly events: EventCard[] = [];
  private readonly agentEvents: EventCard[] = [];
  private readonly elements: ElementCard[] = [];
  private readonly graphNodes: GraphNode[] = [];
  private readonly graphEdges: GraphEdge[] = [];
  private readonly extractionJobs = new Map<string, ExtractionJob>();
  private readonly summaryJobs = new Map<string, BlockSummaryJob>();
  private readonly elementProjectionJobs = new Map<string, ElementProjectionJob>();
  private readonly graphProjectionJobs = new Map<string, GraphProjectionJob>();
  private readonly manualRetryRuns = new Map<string, Promise<unknown>>();
  private readonly usageReceipts = new Map<string, UsageReceipt>();
  private readonly successfulModelResponses: SuccessfulModelResponse[] = [];
  private readonly ingestionReceipts = new Map<string, IngestionReceipt>();
  private readonly externalMemoryImportJobs = new Map<string, ExternalMemoryImportJob>();
  private readonly rawMessageLookup = new Map<string, { block: MemoryBlock; index: number; message: RawMessage }>();
  private readonly pendingRawUpserts = new Map<string, RawMessage>();
  private readonly pendingRawDeletes = new Set<string>();
  private currentTurn = 0;
  private storage: StorageAdapter | undefined;
  private namespace: string | undefined;
  private revision = 0;
  private mutationQueue: Promise<void> = Promise.resolve();

  private constructor(options: StrataGateOptions, token: symbol) {
    if (token !== STRATAGATE_CONSTRUCTOR_TOKEN) {
      throw new TypeError('Use StrataGate.open() for SQLite or StrataGate.inMemory() for explicit ephemeral storage');
    }
    this.blockTurnSizeValue = Math.max(1, Math.floor(options.blockTurnSize ?? DEFAULT_BLOCK_TURN_SIZE));
    const blockDecayLambda = options.blockDecayLambda ?? BLOCK_DECAY_LAMBDA;
    if (!Number.isFinite(blockDecayLambda) || blockDecayLambda < 0) {
      throw new TypeError('blockDecayLambda must be a non-negative finite number');
    }
    this.blockDecayLambdaValue = blockDecayLambda;
    this.summarizer = options.summarizer;
    this.extractor = options.extractor;
    this.elementProjector = options.elementProjector;
    this.disableElementProjection = options.disableElementProjection ?? false;
    this.graphProjector = options.graphProjector;
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? defaultIdFactory;
    this.elementIdFactory = options.elementIdFactory ?? defaultElementIdFactory;
    this.graphIdFactory = options.graphIdFactory ?? defaultGraphIdFactory;
  }

  static inMemory(options: StrataGateOptions = {}): StrataGate {
    return new StrataGate(options, STRATAGATE_CONSTRUCTOR_TOKEN);
  }

  static async open(options: SqliteStrataGateOptions): Promise<StrataGate> {
    const database = options.database.trim();
    if (!database) throw new TypeError('SQLite database path must not be empty');
    const storage = new SqliteStorage({
      filename: database,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
    try {
      return await StrataGate.openWithStorage({
        storage,
        namespace: options.namespace,
        ...(options.blockTurnSize !== undefined ? { blockTurnSize: options.blockTurnSize } : {}),
        ...(options.blockDecayLambda !== undefined ? { blockDecayLambda: options.blockDecayLambda } : {}),
        ...(options.summarizer ? { summarizer: options.summarizer } : {}),
        ...(options.extractor ? { extractor: options.extractor } : {}),
        ...(options.elementProjector ? { elementProjector: options.elementProjector } : {}),
        ...(options.disableElementProjection !== undefined ? { disableElementProjection: options.disableElementProjection } : {}),
        ...(options.graphProjector ? { graphProjector: options.graphProjector } : {}),
        ...(options.now ? { now: options.now } : {}),
        ...(options.idFactory ? { idFactory: options.idFactory } : {}),
        ...(options.elementIdFactory ? { elementIdFactory: options.elementIdFactory } : {}),
        ...(options.graphIdFactory ? { graphIdFactory: options.graphIdFactory } : {}),
      });
    } catch (error) {
      await storage.close();
      throw error;
    }
  }

  static async openWithStorage(options: PersistentStrataGateOptions): Promise<StrataGate> {
    const namespace = options.namespace.trim();
    if (!namespace) throw new TypeError('Storage namespace must not be empty');
    const loaded = await options.storage.load(namespace);
    const loadedSnapshot = loaded ? normalizeSnapshot(loaded.snapshot) : null;
    let loadedRevision = loaded?.revision ?? 0;
    if (loaded && loadedSnapshot) {
      let settingsChanged = false;
      if (options.blockTurnSize !== undefined) {
        const requested = Math.max(1, Math.floor(options.blockTurnSize));
        if (requested !== loadedSnapshot.blockTurnSize) {
          loadedSnapshot.blockTurnSize = requested;
          settingsChanged = true;
        }
      }
      if (options.blockDecayLambda !== undefined) {
        const requested = options.blockDecayLambda;
        if (!Number.isFinite(requested) || requested < 0) {
          throw new TypeError('blockDecayLambda must be a non-negative finite number');
        }
        if (requested !== loadedSnapshot.blockDecayLambda) {
          loadedSnapshot.blockDecayLambda = requested;
          settingsChanged = true;
        }
      }
      if (settingsChanged) loadedRevision = await options.storage.save(namespace, loadedSnapshot, loadedRevision);
    }
    const memoryOptions: StrataGateOptions = {};
    if (loadedSnapshot) memoryOptions.blockTurnSize = loadedSnapshot.blockTurnSize;
    else if (options.blockTurnSize !== undefined) memoryOptions.blockTurnSize = options.blockTurnSize;
    if (loadedSnapshot) memoryOptions.blockDecayLambda = loadedSnapshot.blockDecayLambda;
    else if (options.blockDecayLambda !== undefined) memoryOptions.blockDecayLambda = options.blockDecayLambda;
    if (options.summarizer) memoryOptions.summarizer = options.summarizer;
    if (options.extractor) memoryOptions.extractor = options.extractor;
    if (options.elementProjector) memoryOptions.elementProjector = options.elementProjector;
    if (options.disableElementProjection !== undefined) memoryOptions.disableElementProjection = options.disableElementProjection;
    if (options.graphProjector) memoryOptions.graphProjector = options.graphProjector;
    if (options.now) memoryOptions.now = options.now;
    if (options.idFactory) memoryOptions.idFactory = options.idFactory;
    if (options.elementIdFactory) memoryOptions.elementIdFactory = options.elementIdFactory;
    if (options.graphIdFactory) memoryOptions.graphIdFactory = options.graphIdFactory;
    const memory = new StrataGate(memoryOptions, STRATAGATE_CONSTRUCTOR_TOKEN);
    memory.storage = options.storage;
    memory.namespace = namespace;
    if (loaded && loadedSnapshot) {
      memory.restoreSnapshot(loadedSnapshot);
      memory.revision = loadedRevision;
      const interruptedSummaries = [...memory.summaryJobs.values()].filter((job) => job.status === 'running');
      if (interruptedSummaries.length > 0) {
        await memory.commitMutation(() => {
          const now = toUtc8Iso(memory.now());
          for (const job of interruptedSummaries) {
            memory.summaryJobs.set(job.blockId, {
              ...job,
              status: 'failed',
              lastError: 'Block summarization was interrupted before completion.',
              nextRetryAt: now,
              updatedAt: now,
            });
          }
        });
      }
      const interrupted = [...memory.extractionJobs.values()].filter((job) => job.status === 'running');
      if (interrupted.length > 0) {
        await memory.commitMutation(() => {
          const now = toUtc8Iso(memory.now());
          for (const job of interrupted) {
            memory.extractionJobs.set(job.blockId, {
              ...job,
              status: 'failed',
              lastError: 'Extraction was interrupted before completion.',
              nextRetryAt: now,
              updatedAt: now,
            });
          }
        });
      }
      const interruptedProjections = [...memory.elementProjectionJobs.values()]
        .filter((job) => job.status === 'running');
      if (interruptedProjections.length > 0) {
        await memory.commitMutation(() => {
          const now = toUtc8Iso(memory.now());
          for (const job of interruptedProjections) {
            memory.elementProjectionJobs.set(job.id, {
              ...job,
              status: 'failed',
              lastError: 'Element projection was interrupted before completion.',
              updatedAt: now,
            });
          }
        });
      }
      const interruptedGraphProjections = [...memory.graphProjectionJobs.values()]
        .filter((job) => job.status === 'running');
      if (interruptedGraphProjections.length > 0) {
        await memory.commitMutation(() => {
          const now = toUtc8Iso(memory.now());
          for (const job of interruptedGraphProjections) {
            memory.graphProjectionJobs.set(job.id, {
              ...job,
              status: 'failed',
              lastError: 'Graph projection was interrupted before completion.',
              nextRetryAt: memory.retryAt(job.attempts),
              updatedAt: now,
            });
          }
        });
      }
      if (memory.graphProjector) await memory.commitMutation(() => memory.queueMissingGraphProjections());
    } else {
      await memory.persist();
    }
    return memory;
  }

  get turn(): number {
    return this.currentTurn;
  }

  get storageRevision(): number {
    return this.revision;
  }

  /** Replace an out-of-date in-memory view with the latest durable namespace snapshot. */
  async reloadFromStorage(): Promise<boolean> {
    if (!this.storage || !this.namespace) return false;
    const previous = this.mutationQueue;
    let release!: () => void;
    this.mutationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const loaded = await this.storage.load(this.namespace);
      if (!loaded || loaded.revision === this.revision) return false;
      this.restoreSnapshot(loaded.snapshot);
      this.revision = loaded.revision;
      return true;
    } finally {
      release();
    }
  }

  get blockTurnSize(): number {
    return this.blockTurnSizeValue;
  }

  async setBlockTurnSize(value: number): Promise<void> {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TypeError('blockTurnSize must be a positive integer');
    }
    if (value === this.blockTurnSizeValue) return;
    await this.commitMutation(() => {
      this.blockTurnSizeValue = value;
    });
  }

  get blockDecayLambda(): number {
    return this.blockDecayLambdaValue;
  }

  async setBlockDecayLambda(value: number): Promise<void> {
    if (!Number.isFinite(value) || value < 0) {
      throw new TypeError('blockDecayLambda must be a non-negative finite number');
    }
    if (value === this.blockDecayLambdaValue) return;
    await this.commitMutation(() => {
      this.blockDecayLambdaValue = value;
    });
  }

  listBlocks(): readonly MemoryBlock[] {
    return this.blocks;
  }

  listEvents(): readonly EventCard[] {
    return this.events;
  }

  /** Agent-recorded memories (isolated pool; see recordAgentEvent). */
  listAgentEvents(): readonly EventCard[] {
    return this.agentEvents;
  }

  /** Both pools in one read-only view — the merge point for retrieval and graph work. */
  listAllEvents(): readonly EventCard[] {
    return [...this.events, ...this.agentEvents];
  }

  private findEvent(id: string): EventCard | undefined {
    return this.events.find((event) => event.id === id) ?? this.agentEvents.find((event) => event.id === id);
  }

  listElements(): readonly ElementCard[] {
    return this.elements;
  }

  listGraphNodes(): readonly GraphNode[] {
    return this.graphNodes;
  }

  listGraphEdges(): readonly GraphEdge[] {
    return this.graphEdges;
  }

  listOpenTail(threadId?: string): readonly RawMessage[] {
    if (threadId === undefined) return this.openTail;
    return this.openTail.filter((message) => message.threadId === threadId);
  }

  listExtractionJobs(): readonly ExtractionJob[] {
    return [...this.extractionJobs.values()];
  }

  listSummaryJobs(): readonly BlockSummaryJob[] {
    return [...this.summaryJobs.values()];
  }

  private runManualRetry<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const existing = this.manualRetryRuns.get(key) as Promise<T> | undefined;
    if (existing) return existing;
    const run = operation().finally(() => {
      if (this.manualRetryRuns.get(key) === run) this.manualRetryRuns.delete(key);
    });
    this.manualRetryRuns.set(key, run);
    return run;
  }

  /** Give one failed Block Summary job a fresh, user-requested retry budget. */
  async retryBlockSummary(id: string): Promise<ResumePendingResult> {
    const blockId = id.trim();
    if (!blockId) throw new TypeError('Block id must not be empty');
    return this.runManualRetry(`summary:${blockId}`, async () => {
      const block = this.blocks.find((candidate) => candidate.id === blockId);
      if (!block) throw new Error(`Unknown block: ${blockId}`);
      if (block.processingStatus !== 'pending') throw new Error(`Block ${blockId} is already ready`);
      await this.commitMutation(() => {
        const job = this.summaryJobs.get(blockId);
        if (!job) throw new Error(`Missing summary job for block: ${blockId}`);
        if (job.status !== 'failed') throw new Error(`Block ${blockId} Summary is ${job.status}, not failed`);
        this.summaryJobs.set(blockId, {
          ...job,
          status: 'pending',
          attempts: 0,
          lastError: null,
          nextRetryAt: null,
          updatedAt: toUtc8Iso(this.now()),
        });
      });
      const extractedEvents = await this.processBlock(block, { retryFailed: false });
      const processed = this.blocks.find((candidate) => candidate.id === blockId);
      const readyBlocks = processed?.processingStatus === 'ready' ? [processed] : [];
      return { sealedBlocks: [], readyBlocks, extractedEvents, projectedElements: [] };
    });
  }

  /** Retry only Event extraction for one failed Block without rerunning its Summary. */
  async retryEventExtraction(id: string): Promise<EventCard[]> {
    const blockId = id.trim();
    if (!blockId) throw new TypeError('Block id must not be empty');
    return this.runManualRetry(`extraction:${blockId}`, async () => {
      const block = this.blocks.find((candidate) => candidate.id === blockId);
      if (!block) throw new Error(`Unknown block: ${blockId}`);
      if (block.processingStatus !== 'pending' || block.shouldExtract !== true) {
        throw new Error(`Block ${blockId} is not waiting for Event extraction`);
      }
      await this.commitMutation(() => {
        const job = this.extractionJobs.get(blockId);
        if (!job) throw new Error(`Missing extraction job for block: ${blockId}`);
        if (job.status !== 'failed') throw new Error(`Event extraction ${blockId} is ${job.status}, not failed`);
        this.extractionJobs.set(blockId, {
          ...job,
          attempts: 0,
          lastError: null,
          nextRetryAt: null,
          updatedAt: toUtc8Iso(this.now()),
        });
      });
      return await this.extractEligibleBlock({ blockId, retryFailed: true }) ?? [];
    });
  }

  /** Retry exactly one failed Graph projection batch. */
  async retryGraphProjection(id: string): Promise<{ nodeIds: string[]; edgeIds: string[] }> {
    const jobId = id.trim();
    if (!jobId) throw new TypeError('Graph projection id must not be empty');
    return this.runManualRetry(`graph:${jobId}`, async () => {
      if (!this.graphProjector) throw new Error('Graph projector is not configured');
      await this.commitMutation(() => {
        const job = this.requireGraphProjectionJob(jobId);
        if (job.status !== 'failed') throw new Error(`Graph projection ${jobId} is ${job.status}, not failed`);
        job.status = 'pending';
        job.attempts = 0;
        job.lastError = null;
        job.nextRetryAt = null;
        job.updatedAt = toUtc8Iso(this.now());
      });
      const batch = await this.claimGraphProjection(jobId);
      if (!batch) throw new Error(`Graph projection ${jobId} could not be claimed`);
      try {
        return await this.completeGraphProjection(jobId, await this.graphProjector(batch));
      } catch (error) {
        await this.failGraphProjection(jobId, error);
        throw error;
      }
    });
  }

  listElementProjectionJobs(): readonly ElementProjectionJob[] {
    return [...this.elementProjectionJobs.values()];
  }

  listGraphProjectionJobs(): readonly GraphProjectionJob[] {
    return [...this.graphProjectionJobs.values()];
  }

  listUsageReceipts(): readonly UsageReceipt[] {
    return [...this.usageReceipts.values()];
  }

  listSuccessfulModelResponses(): readonly SuccessfulModelResponse[] {
    return this.successfulModelResponses;
  }

  listExternalMemoryImportJobs(): readonly ExternalMemoryImportJob[] {
    return [...this.externalMemoryImportJobs.values()].map((job) => structuredClone(job));
  }

  async recordSuccessfulModelResponses(responses: readonly SuccessfulModelResponse[]): Promise<void> {
    if (responses.length === 0) return;
    await this.commitMutation(() => {
      for (const response of responses) {
        if (this.successfulModelResponses.some(({ id }) => id === response.id)) continue;
        this.successfulModelResponses.push(structuredClone(response));
      }
      if (this.successfulModelResponses.length > 5) {
        this.successfulModelResponses.splice(0, this.successfulModelResponses.length - 5);
      }
    });
  }

  exportSnapshot(): StrataGateSnapshot {
    return cloneSnapshot({
      schemaVersion: STRATAGATE_STORAGE_SCHEMA_VERSION,
      currentTurn: this.currentTurn,
      blockTurnSize: this.blockTurnSize,
      blockDecayLambda: this.blockDecayLambda,
      openTail: this.openTail,
      blocks: this.blocks,
      summaryJobs: [...this.summaryJobs.values()],
      events: this.events,
      agentEvents: this.agentEvents,
      graphNodes: this.graphNodes,
      graphEdges: this.graphEdges,
      graphProjectionJobs: [...this.graphProjectionJobs.values()],
      elements: this.elements,
      extractionJobs: [...this.extractionJobs.values()],
      elementProjectionJobs: [...this.elementProjectionJobs.values()],
      usageReceipts: [...this.usageReceipts.values()],
      ingestionReceipts: [...this.ingestionReceipts.values()],
      externalMemoryImportJobs: [...this.externalMemoryImportJobs.values()],
      successfulModelResponses: this.successfulModelResponses,
    });
  }

  hasIngestionReceipt(receiptId: string): boolean {
    return this.ingestionReceipts.has(receiptId.trim());
  }

  async appendTurn(input: TurnInput, options: AppendTurnOptions = {}): Promise<AppendTurnResult> {
    const receiptId = input.receiptId?.trim();
    if (input.receiptId !== undefined && !receiptId) {
      throw new TypeError('Turn receiptId must not be empty');
    }
    const threadId = input.threadId?.trim();
    if (input.threadId !== undefined && !threadId) {
      throw new TypeError('Turn threadId must not be empty');
    }
    const createdAt = toUtc8Iso(input.createdAt ?? this.now());
    const userMessage: RawMessage = {
      id: this.idFactory('msg'),
      role: 'user',
      content: input.user,
      createdAt,
      ...(threadId ? { threadId } : {}),
      ...(input.userToolCalls ? { toolCalls: input.userToolCalls } : {}),
    };
    const assistantMessage: RawMessage = {
      id: this.idFactory('msg'),
      role: 'assistant',
      content: input.assistant,
      createdAt,
      ...(threadId ? { threadId } : {}),
      ...(input.assistantToolCalls ? { toolCalls: input.assistantToolCalls } : {}),
    };
    const appended = await this.commitMutation(() => {
      if (receiptId && this.ingestionReceipts.has(receiptId)) return false;
      this.currentTurn += 1;
      this.openTail.push(userMessage, assistantMessage);
      if (receiptId) this.ingestionReceipts.set(receiptId, { id: receiptId, createdAt });
      return true;
    });
    if (!appended) return { sealedBlock: null, readyBlocks: [], extractedEvents: [], projectedElements: [] };
    if (options.deferProcessing === true) {
      return { sealedBlock: null, readyBlocks: [], extractedEvents: [], projectedElements: [] };
    }

    if (this.threadOpenTail(threadId).filter((message) => message.role === 'user').length < this.blockTurnSize) {
      const projectedElements = await this.projectEligibleElements() ?? [];
      await this.projectEligibleGraph();
      return { sealedBlock: null, readyBlocks: [], extractedEvents: [], projectedElements };
    }

    const sealedBlock = await this.sealOpenTail(threadId);
    if (options.deferDerivation === true) {
      return { sealedBlock, readyBlocks: [], extractedEvents: [], projectedElements: [] };
    }
    const beforeReady = sealedBlock.processingStatus === 'ready';
    const extractedEvents = await this.processBlock(sealedBlock, { retryFailed: false });
    const readyBlocks = !beforeReady && sealedBlock.processingStatus === 'ready' ? [sealedBlock] : [];
    const projectedElements = await this.projectEligibleElements() ?? [];
    await this.projectEligibleGraph();
    return { sealedBlock, readyBlocks, extractedEvents, projectedElements };
  }

  async resumePendingWork(options: ResumePendingOptions = {}): Promise<ResumePendingResult> {
    const sealedBlocks: MemoryBlock[] = [];
    const readyBlocks: MemoryBlock[] = [];
    const extractedEvents: EventCard[] = [];
    const projectedElements: ElementCard[] = [];
    while (true) {
      const sealable = this.nextSealableThread();
      if (sealable === null) break;
      sealedBlocks.push(await this.sealOpenTail(sealable.threadId));
    }
    if (options.deferDerivation === true) {
      return { sealedBlocks, readyBlocks, extractedEvents, projectedElements };
    }
    for (const block of this.blocks) {
      if (options.threadId !== undefined && block.threadId !== options.threadId) continue;
      if (block.processingStatus === 'ready') continue;
      const extracted = await this.processBlock(block, { retryFailed: options.retryFailed === true });
      extractedEvents.push(...extracted);
      if (this.blocks.find((candidate) => candidate.id === block.id)?.processingStatus === 'ready') readyBlocks.push(block);
      projectedElements.push(...(await this.projectEligibleElements() ?? []));
      await this.projectEligibleGraph();
    }
    while (true) {
      const projected = await this.projectEligibleElements();
      if (projected === null) break;
      projectedElements.push(...projected);
    }
    // Historical graph rebuild is deliberately bounded: one persisted batch per
    // worker pass keeps startup responsive and avoids burst token consumption.
    await this.projectEligibleGraph();
    return { sealedBlocks, readyBlocks, extractedEvents, projectedElements };
  }

  async addEvent(input: EventCardInput): Promise<EventCard> {
    return this.commitMutation(() => {
      const event = this.addEventInMemory(input);
      this.queueElementProjection([event.id]);
      this.queueGraphProjection([event.id], 1_000);
      return event;
    });
  }

  /**
   * Import a memory summary produced by another AI.
   *
   * The extractor turns prose into candidate Events. Each candidate is then
   * matched against the local Event index (bounded by topK) and passed to the
   * decider. Only ADD/MERGE/SUPERSEDE/CONFLICT decisions write Events; IGNORE
   * is recorded in the returned audit result. Existing Events are never
   * overwritten: MERGE and SUPERSEDE create a new canonical Event that points
   * back to the older Events.
   */
  private normalizeExternalMemoryDecision(
    candidate: ExternalMemoryCandidate,
    matches: readonly ExternalMemoryMatch[],
    decision: ExternalMemoryDecision,
    forceConfirmation = false,
  ): ExternalMemoryPreviewDecision {
    const allowed = new Set(matches.map(({ event }) => event.id));
    const exact = this.listAllEvents().find((event) =>
      event.status !== 'forgotten'
      && event.status !== 'archived'
      && externalMemoryFingerprint(event) === externalMemoryFingerprint(candidate));
    if (exact) allowed.add(exact.id);
    const existingEventIds = [...new Set((decision.existingEventIds ?? []).filter((id) => allowed.has(id)))];
    const requestedAction = this.normalizeExternalAction(decision.action);
    const missingTarget = requestedAction !== 'ADD' && requestedAction !== 'IGNORE' && existingEventIds.length === 0;
    const action = missingTarget ? 'IGNORE' : requestedAction;
    const confidence = missingTarget ? 0.5 : Number.isFinite(decision.confidence)
      ? Math.max(0, Math.min(1, decision.confidence!))
      : 0.5;
    return {
      candidate: structuredClone(candidate),
      action,
      existingEventIds,
      matches: structuredClone([...matches]),
      confidence,
      requiresConfirmation: forceConfirmation || confidence < EXTERNAL_MEMORY_AUTO_APPLY_CONFIDENCE,
      ...(decision.mergedCandidate ? { mergedCandidate: structuredClone(decision.mergedCandidate) } : {}),
      ...(missingTarget
        ? { reason: '模型未关联到允许范围内的现有记忆，已安全降级为忽略' }
        : typeof decision.reason === 'string' && decision.reason.trim()
        ? { reason: decision.reason.trim().slice(0, 500) }
        : {}),
    };
  }

  private async decideExternalMemoryCandidate(
    candidate: ExternalMemoryCandidate,
    priorFingerprints: ReadonlySet<string>,
    decider: NonNullable<ExternalMemoryImportOptions['decider']>,
    topK: number,
    forceConfirmation = false,
  ): Promise<ExternalMemoryPreviewDecision> {
    const fingerprint = externalMemoryFingerprint(candidate);
    const exact = this.listAllEvents().find((event) =>
      event.status !== 'forgotten'
      && event.status !== 'archived'
      && externalMemoryFingerprint(event) === fingerprint);
    const duplicateInImport = priorFingerprints.has(fingerprint);
    const query = `${candidate.title} ${candidate.summary} ${(candidate.tags ?? []).join(' ')}`.trim();
    const matches = await this.searchEvents(query, { limit: topK, trackRetrieval: false });
    const decision: ExternalMemoryDecision = exact || duplicateInImport
      ? {
          action: 'IGNORE',
          existingEventIds: exact ? [exact.id] : [],
          reason: exact ? '与现有记忆完全重复' : '与本批次中的候选完全重复',
          confidence: 1,
        }
      : await decider({ candidate: structuredClone(candidate), matches: structuredClone(matches) });
    return this.normalizeExternalMemoryDecision(candidate, matches, decision, forceConfirmation);
  }

  async previewExternalMemoryImport(options: ExternalMemoryImportOptions): Promise<ExternalMemoryImportPreview> {
    const text = options.text.trim();
    if (!text) throw new TypeError('External memory text must not be empty');
    if (typeof options.decider !== 'function') {
      throw new TypeError('External memory decider is required');
    }
    const importedAt = toUtc8Iso(options.importedAt ?? this.now());
    const extractor = options.extractor ?? externalMemoryJsonExtractor;
    const extracted: ExternalMemoryExtractionResult = await extractor({ text, importedAt });
    const candidates = Array.isArray(extracted?.candidates) ? extracted.candidates.slice(0, 200) : [];
    const topK = Math.max(1, Math.min(20, Math.floor(options.topK ?? 5)));
    const seenFingerprints = new Set<string>();
    const decisions: ExternalMemoryPreviewDecision[] = [];
    for (const candidate of candidates) {
      if (!candidate || typeof candidate.title !== 'string' || typeof candidate.summary !== 'string') continue;
      const fingerprint = externalMemoryFingerprint(candidate);
      const preview = await this.decideExternalMemoryCandidate(candidate, seenFingerprints, options.decider, topK);
      seenFingerprints.add(fingerprint);
      decisions.push(preview);
    }
    return { importedAt, baseRevision: this.revision, decisions };
  }

  getExternalMemoryImportJob(jobId: string): ExternalMemoryImportJob | null {
    const job = this.externalMemoryImportJobs.get(jobId.trim());
    return job ? structuredClone(job) : null;
  }

  async createExternalMemoryImportJob(text: string): Promise<ExternalMemoryImportJob> {
    const normalized = text.trim();
    if (!normalized) throw new TypeError('External memory text must not be empty');
    const now = toUtc8Iso(this.now());
    let candidates: ExternalMemoryCandidate[] = [];
    let parseError: string | null = null;
    try {
      candidates = parseExternalMemoryExport(normalized).candidates;
    } catch (error) {
      parseError = errorMessage(error).slice(0, 2_000);
    }
    const job: ExternalMemoryImportJob = {
      id: `import_${crypto.randomUUID()}`,
      text: normalized,
      importedAt: now,
      status: parseError ? 'extracting' : candidates.length > 0 ? 'processing' : 'ready',
      candidates: structuredClone(candidates),
      decisions: [],
      processedCount: 0,
      totalCount: candidates.length,
      recoveredFromInvalidJson: false,
      parseError,
      lastError: null,
      sourceBlockId: null,
      importedCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    await this.commitMutation(() => this.externalMemoryImportJobs.set(job.id, structuredClone(job)));
    return structuredClone(job);
  }

  async completeExternalMemoryFallback(
    jobId: string,
    result: ExternalMemoryExtractionResult,
  ): Promise<ExternalMemoryImportJob> {
    const candidates = (Array.isArray(result.candidates) ? result.candidates : [])
      .filter((candidate) => candidate && typeof candidate.title === 'string' && typeof candidate.summary === 'string')
      .slice(0, 200);
    return this.commitMutation(() => {
      const job = this.requireExternalMemoryImportJob(jobId);
      if (job.status !== 'extracting') return structuredClone(job);
      job.candidates = structuredClone(candidates);
      job.decisions = [];
      job.processedCount = 0;
      job.totalCount = candidates.length;
      job.recoveredFromInvalidJson = true;
      job.status = candidates.length > 0 ? 'processing' : 'failed';
      job.lastError = candidates.length > 0 ? null : '模型未能从不合格内容中恢复出任何候选记忆';
      job.updatedAt = toUtc8Iso(this.now());
      return structuredClone(job);
    });
  }

  async processNextExternalMemoryImport(
    jobId: string,
    decider: ExternalMemoryImportOptions['decider'],
    topK = 5,
  ): Promise<ExternalMemoryImportJob> {
    if (typeof decider !== 'function') throw new TypeError('External memory decider is required');
    const work = await this.prepareNextExternalMemoryImport(jobId, topK);
    if (!work) {
      const current = this.requireExternalMemoryImportJob(jobId);
      return structuredClone(current);
    }
    const decision = work.deterministicDecision ?? await decider({
      candidate: structuredClone(work.candidate),
      matches: structuredClone(work.matches),
    });
    return this.completeNextExternalMemoryImport(
      work.jobId,
      work.index,
      decision,
      work.matches,
      work.forceConfirmation,
    );
  }

  async prepareNextExternalMemoryImport(
    jobId: string,
    topK = 5,
  ): Promise<ExternalMemoryImportWorkItem | null> {
    const current = this.requireExternalMemoryImportJob(jobId);
    if (current.status !== 'processing') return null;
    const index = current.processedCount;
    const candidate = current.candidates[index];
    if (!candidate) return null;
    const priorFingerprints = new Set(current.candidates.slice(0, index).map(externalMemoryFingerprint));
    const fingerprint = externalMemoryFingerprint(candidate);
    const exact = this.listAllEvents().find((event) =>
      event.status !== 'forgotten'
      && event.status !== 'archived'
      && externalMemoryFingerprint(event) === fingerprint);
    const duplicateInImport = priorFingerprints.has(fingerprint);
    const query = `${candidate.title} ${candidate.summary} ${(candidate.tags ?? []).join(' ')}`.trim();
    const matches = await this.searchEvents(query, {
      limit: Math.max(1, Math.min(20, Math.floor(topK))),
      trackRetrieval: false,
    });
    const deterministicDecision: ExternalMemoryDecision | undefined = exact || duplicateInImport
      ? {
          action: 'IGNORE',
          existingEventIds: exact ? [exact.id] : [],
          reason: exact ? '与现有记忆完全重复' : '与本批次中的候选完全重复',
          confidence: 1,
        }
      : undefined;
    return {
      jobId: current.id,
      index,
      candidate: structuredClone(candidate),
      matches: structuredClone(matches),
      forceConfirmation: current.recoveredFromInvalidJson,
      ...(deterministicDecision ? { deterministicDecision } : {}),
    };
  }

  async completeNextExternalMemoryImport(
    jobId: string,
    index: number,
    decision: ExternalMemoryDecision,
    matches: readonly ExternalMemoryMatch[],
    forceConfirmation = false,
  ): Promise<ExternalMemoryImportJob> {
    return this.commitMutation(() => {
      const job = this.requireExternalMemoryImportJob(jobId);
      if (job.processedCount > index) return structuredClone(job);
      if (job.status !== 'processing' || job.processedCount !== index) {
        throw new Error(`External memory import ${jobId} is no longer at candidate ${index}`);
      }
      const candidate = job.candidates[index];
      if (!candidate) throw new Error(`External memory import ${jobId} has no candidate ${index}`);
      const normalized = this.normalizeExternalMemoryDecision(candidate, matches, decision, forceConfirmation);
      job.decisions.push(structuredClone(normalized));
      job.processedCount += 1;
      if (job.processedCount >= job.totalCount) {
        job.status = job.decisions.some(({ requiresConfirmation }) => requiresConfirmation)
          ? 'awaiting_confirmation'
          : 'ready';
      }
      job.lastError = null;
      job.updatedAt = toUtc8Iso(this.now());
      return structuredClone(job);
    });
  }

  async failExternalMemoryImportJob(jobId: string, error: unknown): Promise<ExternalMemoryImportJob> {
    return this.commitMutation(() => {
      const job = this.requireExternalMemoryImportJob(jobId);
      job.status = 'failed';
      job.lastError = errorMessage(error).slice(0, 2_000);
      job.updatedAt = toUtc8Iso(this.now());
      return structuredClone(job);
    });
  }

  async retryExternalMemoryImportJob(jobId: string): Promise<ExternalMemoryImportJob> {
    return this.commitMutation(() => {
      const job = this.requireExternalMemoryImportJob(jobId);
      if (job.status !== 'failed') return structuredClone(job);
      job.status = job.candidates.length === 0 && job.parseError ? 'extracting' : 'processing';
      job.lastError = null;
      job.updatedAt = toUtc8Iso(this.now());
      return structuredClone(job);
    });
  }

  async completeExternalMemoryImportJob(
    jobId: string,
    result: Pick<ExternalMemoryImportResult, 'sourceBlockId' | 'addedEvents'>,
  ): Promise<ExternalMemoryImportJob> {
    return this.commitMutation(() => {
      const job = this.requireExternalMemoryImportJob(jobId);
      job.status = 'committed';
      job.sourceBlockId = result.sourceBlockId;
      job.importedCount = result.addedEvents.length;
      job.updatedAt = toUtc8Iso(this.now());
      return structuredClone(job);
    });
  }

  async markExternalMemoryImportUndone(jobId: string): Promise<ExternalMemoryImportJob> {
    return this.commitMutation(() => {
      const job = this.requireExternalMemoryImportJob(jobId);
      job.status = 'undone';
      job.updatedAt = toUtc8Iso(this.now());
      return structuredClone(job);
    });
  }

  async commitExternalMemoryImport(options: ExternalMemoryCommitOptions): Promise<ExternalMemoryImportResult> {
    const text = options.text.trim();
    if (!text) throw new TypeError('External memory text must not be empty');
    if (options.candidates.length !== options.decisions.length) {
      throw new TypeError('External memory candidates and decisions must have the same length');
    }
    return this.commitMutation(() => {
      if (this.revision !== options.baseRevision) {
        throw new Error(`External memory preview is stale: expected revision ${options.baseRevision}, found ${this.revision}`);
      }
      const importedAt = toUtc8Iso(options.importedAt);
      const source = this.createExternalSourceBlock(text, importedAt);
      const addedEvents: EventCard[] = [];
      const changedEventIds = new Set<string>();
      const decisions: ExternalMemoryImportDecision[] = [];
      for (const [index, item] of options.decisions.entries()) {
        const action = this.normalizeExternalAction(item.action);
        const allowed = new Set(item.matches.map(({ event }) => event.id));
        const targets = [...new Set(item.existingEventIds.filter((id) => allowed.has(id)))];
        const reason = typeof item.reason === 'string' ? item.reason.trim().slice(0, 500) : undefined;
        let createdEvent: EventCard | undefined;
        const proposed = item.mergedCandidate;
        const original = options.candidates[index]!;
        const candidate = proposed && typeof proposed.title === 'string' && typeof proposed.summary === 'string'
          ? proposed : original;
        if ((action === 'ADD' || action === 'MERGE' || action === 'SUPERSEDE' || action === 'CONFLICT')
          && (action === 'ADD' || targets.length > 0)) {
          const temporal = {
            ...(candidate.temporal ?? {}),
            ...(action === 'MERGE' || action === 'SUPERSEDE' ? { supersedesEventIds: targets } : {}),
            ...(action === 'CONFLICT' ? { conflictsWithEventIds: targets } : {}),
          };
          createdEvent = this.addEventInMemory({
            ...candidate,
            sourceBlockId: source.id,
            sourceMessageIds: [source.l5Raw[0]!.id],
            temporal,
          });
          addedEvents.push(createdEvent);
          changedEventIds.add(createdEvent.id);
          if (action === 'CONFLICT') {
            for (const id of targets) {
              const existing = this.findEvent(id);
              if (!existing) continue;
              existing.temporal.conflictsWithEventIds = [...new Set([...(existing.temporal.conflictsWithEventIds ?? []), createdEvent.id])];
              existing.updatedAt = importedAt;
              changedEventIds.add(existing.id);
            }
          }
        }
        const audit: ExternalMemoryImportDecision = {
          candidate: structuredClone(original), action, existingEventIds: targets,
          ...(createdEvent ? { createdEventId: createdEvent.id } : {}),
          ...(reason ? { reason } : {}),
          ...(typeof item.confidence === 'number' ? { confidence: item.confidence } : {}),
        };
        decisions.push(audit);
      }
      if (addedEvents.length > 0) {
        const ids = addedEvents.map(({ id }) => id);
        this.queueElementProjection(ids);
        this.queueGraphProjection(ids, 2_000);
      }
      return {
        sourceBlockId: source.id,
        decisions,
        addedEvents,
        changedEventIds: [...changedEventIds],
      };
    });
  }

  async importExternalMemory(options: ExternalMemoryImportOptions): Promise<ExternalMemoryImportResult> {
    const preview = await this.previewExternalMemoryImport(options);
    return this.commitExternalMemoryImport({
      text: options.text,
      importedAt: preview.importedAt,
      baseRevision: preview.baseRevision,
      candidates: preview.decisions.map(({ candidate }) => candidate),
      decisions: preview.decisions,
    });
  }

  async undoExternalMemoryImport(sourceBlockId: string): Promise<ExternalMemoryUndoResult> {
    const id = sourceBlockId.trim();
    if (!id) throw new TypeError('External memory source block ID must not be empty');
    return this.commitMutation(() => {
      const sourceIndex = this.blocks.findIndex((block) => block.id === id && block.l0Tags?.includes('external-memory-import'));
      if (sourceIndex < 0) throw new Error(`Unknown external memory import: ${id}`);
      const source = this.blocks[sourceIndex]!;
      const sourceMessageIds = new Set(source.l5Raw.map(({ id }) => id));
      const importedEventIds = new Set(this.events.filter((event) => event.sourceBlockId === id).map(({ id }) => id));
      const restoredEventIds = new Set<string>();
      const now = toUtc8Iso(this.now());

      this.events.splice(0, this.events.length, ...this.events.filter((event) => !importedEventIds.has(event.id)));
      // Reference scrubbing spans both pools: an agent-recorded event may link
      // to (or supersede) an imported event that is being undone here.
      for (const event of this.listAllEvents()) {
        for (const field of ['conflictsWithEventIds', 'supersedesEventIds', 'beforeEventIds', 'afterEventIds', 'relatedEventIds'] as const) {
          const previous = event.temporal[field] ?? [];
          const filtered = previous.filter((target) => !importedEventIds.has(target));
          if (filtered.length !== previous.length) {
            event.temporal[field] = filtered;
            restoredEventIds.add(event.id);
          }
        }
        if (event.temporal.sameEventId && importedEventIds.has(event.temporal.sameEventId)) {
          delete event.temporal.sameEventId;
          restoredEventIds.add(event.id);
        }
        if (event.supersededBy && importedEventIds.has(event.supersededBy)) {
          const replacement = this.listAllEvents().find((candidate) =>
            candidate.id !== event.id && (candidate.temporal.supersedesEventIds ?? []).includes(event.id));
          event.status = replacement ? 'superseded' : 'active';
          event.supersededBy = replacement?.id ?? null;
          if (!replacement && event.weight.forcedCap === 0.1) event.weight.forcedCap = null;
          restoredEventIds.add(event.id);
        }
        if (restoredEventIds.has(event.id)) event.updatedAt = now;
      }

      for (const [jobId, job] of this.elementProjectionJobs) {
        if (job.sourceEventIds.some((eventId) => importedEventIds.has(eventId))) this.elementProjectionJobs.delete(jobId);
      }
      for (const [jobId, job] of this.graphProjectionJobs) {
        if (job.sourceEventIds.some((eventId) => importedEventIds.has(eventId))) this.graphProjectionJobs.delete(jobId);
      }
      for (const element of this.elements) {
        element.sourceEventIds = element.sourceEventIds.filter((eventId) => !importedEventIds.has(eventId));
        element.sourceMessageIds = element.sourceMessageIds.filter((messageId) => !sourceMessageIds.has(messageId));
        element.facts = element.facts.flatMap((fact) => {
          fact.sourceEventIds = fact.sourceEventIds.filter((eventId) => !importedEventIds.has(eventId));
          return fact.sourceEventIds.length > 0 ? [fact] : [];
        });
        const current = [...element.facts].reverse().find((fact) => fact.status === 'active' && fact.mode === 'state');
        element.currentState = current
          ? (Array.isArray(current.value) ? current.value.join('、') : current.value)
          : '';
      }
      this.elements.splice(0, this.elements.length, ...this.elements.filter((element) =>
        element.sourceEventIds.length > 0 || element.facts.length > 0));
      for (const node of this.graphNodes) {
        node.sourceEventIds = node.sourceEventIds.filter((eventId) => !importedEventIds.has(eventId));
        node.facts = node.facts.flatMap((fact) => {
          fact.sourceEventIds = fact.sourceEventIds.filter((eventId) => !importedEventIds.has(eventId));
          return fact.sourceEventIds.length > 0 ? [fact] : [];
        });
      }
      const removedNodeIds = new Set(this.graphNodes
        .filter((node) => node.sourceEventIds.length === 0 && node.facts.length === 0)
        .map(({ id }) => id));
      this.graphNodes.splice(0, this.graphNodes.length, ...this.graphNodes.filter((node) => !removedNodeIds.has(node.id)));
      for (const edge of this.graphEdges) {
        edge.sourceEventIds = edge.sourceEventIds.filter((eventId) => !importedEventIds.has(eventId));
      }
      this.graphEdges.splice(0, this.graphEdges.length, ...this.graphEdges.filter((edge) =>
        edge.sourceEventIds.length > 0 && !removedNodeIds.has(edge.fromNodeId) && !removedNodeIds.has(edge.toNodeId)));
      for (const [receiptId, receipt] of this.usageReceipts) {
        receipt.eventIds = receipt.eventIds.filter((eventId) => !importedEventIds.has(eventId));
        if (receipt.eventIds.length === 0 && receipt.elementIds.length === 0) this.usageReceipts.delete(receiptId);
      }
      this.blocks.splice(sourceIndex, 1);
      this.markRawMessagesDeleted(sourceMessageIds);
      return {
        sourceBlockId: id,
        removedEventIds: [...importedEventIds],
        restoredEventIds: [...restoredEventIds],
      };
    });
  }

  async searchEvents(query: string, options: SearchOptions = {}): Promise<EventSearchResult[]> {
    const limit = Math.max(1, Math.min(20, options.limit ?? 6));
    const agentWeight = Math.max(0, options.agentMemoryWeight ?? 1);
    // Per-pool top-k: each pool produces its own ranking over its own lane so
    // a large pool cannot crowd the other one out of the result window, then
    // the two rankings fuse through weighted RRF (the agent pool's share is
    // the caller-configurable weight; passive events always weigh 1).
    const rankings: EventCard[][] = [];
    const weights: number[] = [];
    const passive = this.rankEventPool(
      this.events.filter((event) => event.status === 'active' || event.status === 'superseded'),
      query, options, limit,
    );
    if (passive.length > 0) {
      rankings.push(passive);
      weights.push(1);
    }
    if (agentWeight > 0) {
      const agent = this.rankEventPool(
        this.agentEvents.filter((event) => event.status === 'active' || event.status === 'superseded'),
        query, options, limit,
      );
      if (agent.length > 0) {
        rankings.push(agent);
        weights.push(agentWeight);
      }
    }
    if (rankings.length === 0) return [];
    const ranked = rrfRank(rankings, weights).slice(0, limit).map(({ item: event, score }) => ({ event, score }));
    if (ranked.length > 0 && options.trackRetrieval !== false) {
      const now = toUtc8Iso(this.now());
      await this.commitMutation(() => {
        for (const { event } of ranked) event.weight.lastRetrievedAt = now;
      });
    }
    return ranked;
  }

  /** Rank one event pool (BM25 + structured filters fused by RRF), sliced to `limit`. */
  private rankEventPool(
    candidates: readonly EventCard[],
    query: string,
    options: SearchOptions,
    limit: number,
  ): EventCard[] {
    const participants = (options.participants ?? []).map(normalizeSearchText).filter(Boolean);
    const eventType = normalizeSearchText(options.eventType ?? '');
    const from = options.happenedFrom ? Date.parse(options.happenedFrom) : Number.NEGATIVE_INFINITY;
    const to = options.happenedTo ? Date.parse(options.happenedTo) : Number.POSITIVE_INFINITY;
    const hasTimeFilter = Boolean(options.happenedFrom || options.happenedTo);
    const participantMatches = candidates.filter((event) => participants.length > 0 && participants.every((person) =>
      (event.temporal.participants ?? []).some((candidate) => fuzzySearchMatch(candidate, person))));
    const typeMatches = eventType ? candidates.filter((event) =>
      fuzzySearchMatch(event.temporal.eventType ?? '', eventType)
      || fuzzySearchMatch(`${event.title} ${event.summary} ${event.tags.join(' ')}`, eventType)) : [];
    const timeMatches = hasTimeFilter ? candidates.filter((event) => {
      const start = Date.parse(event.temporal.happenedStart ?? event.temporal.happenedEnd ?? '');
      const end = Date.parse(event.temporal.happenedEnd ?? event.temporal.happenedStart ?? '');
      return Number.isFinite(start) && Number.isFinite(end) && start <= to && end >= from;
    }) : [];
    const bm25 = bm25Rank(candidates, query, (event) => weightedSearchTokens([
      [event.title, 4],
      [event.summary, 3],
      [event.tags.join(' '), 2],
      [event.quotes.join(' '), 2],
      [event.narrative, 1],
      [(event.temporal.participants ?? []).join(' '), 5],
      [event.temporal.eventType ?? '', 5],
      [event.temporal.originalText ?? '', 4],
      [`${event.temporal.happenedStart ?? ''} ${event.temporal.happenedEnd ?? ''}`, 4],
    ])).map(({ item }) => item);
    const chronology = (event: EventCard): string => event.temporal.happenedStart
      ?? event.temporal.happenedEnd
      ?? event.temporal.mentionedAt
      ?? event.createdAt;
    const structured = (items: readonly EventCard[]): EventCard[] => [...items].sort((left, right) => {
      if (options.temporalIntent === 'first') return chronology(left).localeCompare(chronology(right));
      if (options.temporalIntent === 'latest') return chronology(right).localeCompare(chronology(left));
      return memoryWeightAt(right, this.currentTurn) - memoryWeightAt(left, this.currentTurn)
        || right.updatedAt.localeCompare(left.updatedAt);
    });
    const participantIds = new Set(participantMatches.map(({ id }) => id));
    const typeIds = new Set(typeMatches.map(({ id }) => id));
    const timeIds = new Set(timeMatches.map(({ id }) => id));
    const hasStructuredFilter = participants.length > 0 || Boolean(eventType) || hasTimeFilter;
    const exactStructuredMatches = hasStructuredFilter ? candidates.filter((event) =>
      (participants.length === 0 || participantIds.has(event.id))
      && (!eventType || typeIds.has(event.id))
      && (!hasTimeFilter || timeIds.has(event.id))) : [];
    const rankings: EventCard[][] = [];
    if (exactStructuredMatches.length > 0) {
      const exactIds = new Set(exactStructuredMatches.map(({ id }) => id));
      rankings.push(bm25.filter(({ id }) => exactIds.has(id)), structured(exactStructuredMatches));
    } else {
      rankings.push(bm25);
      if (participantMatches.length > 0) rankings.push(structured(participantMatches));
      if (typeMatches.length > 0) rankings.push(structured(typeMatches));
      if (timeMatches.length > 0) rankings.push(structured(timeMatches));
    }
    if (searchTokens(query).length > 0 && bm25.length === 0 && !hasStructuredFilter) return [];
    if (!rankings.some((ranking) => ranking.length > 0)) {
      if (searchTokens(query).length > 0) return [];
      rankings.push(structured(candidates));
    }
    return rrfRank(rankings).slice(0, limit).map(({ item }) => item);
  }

  async claimNextElementProjection(): Promise<ElementProjectionContext | null> {
    return this.commitMutation(() => {
      const job = [...this.elementProjectionJobs.values()]
        .filter((candidate) => candidate.attempts < DERIVATION_MAX_ATTEMPTS
          && (candidate.status === 'pending' || candidate.status === 'failed'))
        .sort((left, right) => Number(left.status !== 'pending') - Number(right.status !== 'pending')
          || left.createdAt.localeCompare(right.createdAt))[0];
      if (!job) return null;
      const events = job.sourceEventIds.flatMap((id) => {
        const event = this.findEvent(id);
        return event ? [event] : [];
      });
      if (events.length === 0) {
        throw new Error(`Element projection ${job.id} has no available source events`);
      }
      job.status = 'running';
      job.attempts += 1;
      job.lastError = null;
      job.updatedAt = toUtc8Iso(this.now());
      return {
        jobId: job.id,
        events: structuredClone(events),
        existingElements: structuredClone(this.elements),
      };
    });
  }

  async completeElementProjection(jobId: string, result: ElementProjectionResult): Promise<ElementCard[]> {
    return this.commitMutation(() => {
      const job = this.requireElementProjectionJob(jobId);
      if (job.status === 'completed') {
        return job.elementIds.flatMap((id) => this.elements.find((element) => element.id === id) ?? []);
      }
      if (job.status !== 'running') throw new Error(`Element projection ${job.id} is ${job.status}, not running`);
      const touched = applyElementChanges({
        elements: this.elements,
        events: this.listAllEvents().slice(),
        changes: Array.isArray(result.changes) ? result.changes : [],
        allowedEventIds: new Set(job.sourceEventIds),
        now: toUtc8Iso(this.now()),
        currentTurn: this.currentTurn,
        idFactory: this.elementIdFactory,
      });
      const normalizedReason = typeof result.reason === 'string'
        ? result.reason.trim().replace(/\s+/g, ' ').slice(0, 500)
        : '';
      const warning = touched.length === 0 && job.sourceEventIds.length > 0
        ? `0 changes projected from ${job.sourceEventIds.length} events${normalizedReason ? `: ${normalizedReason}` : '.'}`
        : normalizedReason;
      job.status = 'completed';
      job.elementIds = touched.map(({ id }) => id);
      job.reason = warning.slice(0, 500) || null;
      job.lastError = null;
      job.updatedAt = toUtc8Iso(this.now());
      return touched;
    });
  }

  async failElementProjection(jobId: string, error: unknown): Promise<void> {
    await this.commitMutation(() => {
      const job = this.requireElementProjectionJob(jobId);
      if (job.status === 'completed') return;
      job.status = 'failed';
      job.lastError = errorMessage(error);
      job.updatedAt = toUtc8Iso(this.now());
    });
  }

  private async claimGraphProjection(jobId?: string): Promise<GraphProjectionContext | null> {
    return this.commitMutation(() => {
      const now = this.now().getTime();
      const job = [...this.graphProjectionJobs.values()]
        .filter((candidate) => (jobId === undefined || candidate.id === jobId)
          && candidate.attempts < DERIVATION_MAX_ATTEMPTS
          && (candidate.status === 'pending'
            || (candidate.status === 'failed' && candidate.nextRetryAt !== null
              && Date.parse(candidate.nextRetryAt) <= now)))
        .sort((left, right) => Number(left.status !== 'pending') - Number(right.status !== 'pending')
          || right.priority - left.priority || left.createdAt.localeCompare(right.createdAt))[0];
      if (!job) return null;
      const events = job.sourceEventIds.flatMap((id) => {
        const event = this.findEvent(id);
        return event ? [event] : [];
      });
      if (events.length === 0) throw new Error(`Graph projection ${job.id} has no available source events`);
      job.status = 'running';
      job.attempts += 1;
      job.lastError = null;
      job.updatedAt = toUtc8Iso(this.now());
      const eventText = normalizeSearchText(events.map((event) => [
        event.title, event.summary, event.tags.join(' '), (event.temporal.participants ?? []).join(' '),
      ].join(' ')).join(' '));
      const effectiveViews = this.graphNodes.flatMap((node) => effectiveGraphNodeView(node, this.graphEdges, this.listAllEvents()) ?? []);
      const effectiveNodes = effectiveViews.map(({ node }) => node);
      const relevantNodes = effectiveNodes.filter((node) => [node.name, ...node.aliases]
        .some((name) => name && eventText.includes(normalizeSearchText(name))))
        .concat([...effectiveNodes].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).slice(0, 24));
      const existingNodes = [...new Map(relevantNodes.map((node) => [node.id, node])).values()].slice(0, 32);
      const nodeIds = new Set(existingNodes.map(({ id }) => id));
      const visibleEdgeIds = new Set(effectiveViews.flatMap(({ currentEdges, historicalEdges }) => [
        ...currentEdges,
        ...historicalEdges,
      ]).map(({ id }) => id));
      return {
        jobId: job.id,
        projectorVersion: job.projectorVersion,
        events: structuredClone(events),
        existingNodes: structuredClone(existingNodes),
        existingEdges: structuredClone(this.graphEdges.filter(({ id, fromNodeId, toNodeId }) => visibleEdgeIds.has(id)
          && nodeIds.has(fromNodeId) && nodeIds.has(toNodeId)).slice(-60)),
      };
    });
  }

  async claimNextGraphProjection(): Promise<GraphProjectionContext | null> {
    return this.claimGraphProjection();
  }

  async completeGraphProjection(jobId: string, result: GraphProjectionResult): Promise<{ nodeIds: string[]; edgeIds: string[] }> {
    return this.commitMutation(() => {
      const job = this.requireGraphProjectionJob(jobId);
      if (job.status === 'completed') return { nodeIds: job.nodeIds, edgeIds: job.edgeIds };
      if (job.status !== 'running') throw new Error(`Graph projection ${job.id} is ${job.status}, not running`);
      const touched = applyGraphProjection({
        nodes: this.graphNodes,
        edges: this.graphEdges,
        events: this.listAllEvents().slice(),
        result,
        allowedEventIds: new Set(job.sourceEventIds),
        now: toUtc8Iso(this.now()),
        idFactory: this.graphIdFactory,
      });
      job.status = 'completed';
      job.nodeIds = touched.nodeIds;
      job.edgeIds = touched.edgeIds;
      const normalizedReason = typeof result.reason === 'string' ? result.reason.trim().replace(/\s+/g, ' ') : '';
      const warning = touched.warnings.length > 0 ? `Validation: ${touched.warnings.join(' ')}` : '';
      job.reason = [warning, normalizedReason].filter(Boolean).join(' ').slice(0, 500) || null;
      job.lastError = null;
      job.nextRetryAt = null;
      job.updatedAt = toUtc8Iso(this.now());
      return { nodeIds: touched.nodeIds, edgeIds: touched.edgeIds };
    });
  }

  async failGraphProjection(jobId: string, error: unknown): Promise<void> {
    await this.commitMutation(() => {
      const job = this.requireGraphProjectionJob(jobId);
      if (job.status === 'completed') return;
      job.status = 'failed';
      job.lastError = errorMessage(error);
      job.nextRetryAt = this.retryAt(job.attempts);
      job.updatedAt = toUtc8Iso(this.now());
    });
  }

  async searchElements(query: string, options: ElementSearchOptions = {}): Promise<ElementSearchResult[]> {
    const normalizedName = normalizeSearchText(options.name ?? '');
    const candidates = this.elements.flatMap((element) => element.facts.map((fact) => ({
      id: fact.id,
      elementId: element.id,
      name: element.name,
      aliases: element.aliases,
      type: element.type,
      fact,
      updatedAt: element.updatedAt,
    })));
    const bm25 = bm25Rank(candidates, query, (hit) => weightedSearchTokens([
      [hit.name, 5],
      [hit.aliases.join(' '), 4],
      [hit.type, 2],
      [hit.fact.key, 4],
      [Array.isArray(hit.fact.value) ? hit.fact.value.join(' ') : hit.fact.value, 5],
    ])).map(({ item }) => item);
    const nameMatches = normalizedName ? candidates.filter((hit) =>
      fuzzySearchMatch(hit.name, normalizedName)
      || hit.aliases.some((alias) => fuzzySearchMatch(alias, normalizedName))) : [];
    const typeMatches = options.type ? candidates.filter((hit) => hit.type === options.type) : [];
    const recent = (items: typeof candidates): typeof candidates => [...items]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id));
    const hasStructuredFilter = Boolean(normalizedName || options.type);
    const nameIds = new Set(nameMatches.map(({ id }) => id));
    const typeIds = new Set(typeMatches.map(({ id }) => id));
    const exactStructuredMatches = hasStructuredFilter ? candidates.filter((hit) =>
      (!normalizedName || nameIds.has(hit.id)) && (!options.type || typeIds.has(hit.id))) : [];
    const rankings: typeof candidates[] = [];
    if (exactStructuredMatches.length > 0) {
      const exactIds = new Set(exactStructuredMatches.map(({ id }) => id));
      rankings.push(bm25.filter(({ id }) => exactIds.has(id)), recent(exactStructuredMatches));
    } else {
      rankings.push(bm25);
      if (nameMatches.length > 0) rankings.push(recent(nameMatches));
      if (typeMatches.length > 0) rankings.push(recent(typeMatches));
    }
    if (searchTokens(query).length > 0 && bm25.length === 0 && !hasStructuredFilter) return [];
    if (!rankings.some((ranking) => ranking.length > 0)) {
      if (searchTokens(query).length > 0) return [];
      rankings.push(recent(candidates));
    }
    const ranked = rrfRank(rankings).slice(0, Math.max(1, Math.min(12, options.limit ?? 8)));
    if (ranked.length > 0) {
      const now = toUtc8Iso(this.now());
      await this.commitMutation(() => {
        for (const elementId of new Set(ranked.map(({ item }) => item.elementId))) {
          const element = this.elements.find(({ id }) => id === elementId);
          if (element) element.weight.lastRetrievedAt = now;
        }
      });
    }
    return ranked.map(({ item, score }) => ({
      id: item.id,
      elementId: item.elementId,
      name: item.name,
      type: item.type,
      fact: item.fact,
      score,
    }));
  }

  expandElement(id: string, at?: string): ElementCard {
    const element = this.elements.find((candidate) => candidate.id === id);
    if (!element) throw new Error(`Unknown element: ${id}`);
    return elementViewAt(element, at);
  }

  searchRawMemory(query: string, limit = 6, options: RawSearchOptions = {}): RawSearchHit[] {
    const tokens = searchTokens(query);
    if (tokens.length === 0) return [];
    const boundedLimit = Math.max(1, Math.floor(limit));
    let candidateIds: string[] | null | undefined;
    try {
      candidateIds = this.storage?.searchRawMessageIds?.(
        this.namespace ?? '',
        tokens,
        Math.min(5_000, Math.max(100, boundedLimit * 20)),
        options.threadId,
        options.includeUnthreaded,
      );
    } catch {
      candidateIds = null;
    }
    const candidates = candidateIds === null || candidateIds === undefined
      ? this.blocks.flatMap((block) => block.l5Raw.map((message, index) => ({
        id: message.id,
        block,
        index,
        message,
      }))).filter(({ message }) => options.threadId === undefined
        || message.threadId === options.threadId
        || (options.includeUnthreaded === true && message.threadId === undefined))
      : [...new Set(candidateIds)].flatMap((id) => {
        const item = this.rawMessageLookup.get(id);
        if (!item) return [];
        if (options.threadId !== undefined
          && item.message.threadId !== options.threadId
          && !(options.includeUnthreaded === true && item.message.threadId === undefined)) return [];
        return [{ id, ...item }];
      });
    const ranked = bm25Rank(candidates, query, ({ message }) => searchTokens(message.content)).sort((left, right) =>
      right.score - left.score
      || right.item.message.createdAt.localeCompare(left.item.message.createdAt)
      || right.item.block.sequence - left.item.block.sequence
      || right.item.index - left.item.index
      || left.item.id.localeCompare(right.item.id));
    return ranked.slice(0, boundedLimit).map(({ item }) => ({
      blockId: item.block.id,
      turnRange: [item.block.startTurn, item.block.endTurn],
      message: item.message,
      nearby: item.block.l5Raw.slice(Math.max(0, item.index - 1), item.index + 2),
    }));
  }

  /**
   * Return decayed block views. Passing a threadId limits the result to that
   * conversation; omitting it intentionally returns every thread in this
   * StrataGate namespace (never another namespace).
   */
  getBlockContext(threadId?: string): BlockContextEntry[] {
    const blocks = threadId === undefined
      ? this.blocks.filter((block) => block.processingStatus === 'ready')
      : this.blocks.filter((block) => block.threadId === threadId && block.processingStatus === 'ready');
    return blocks.map((block) => {
      const threadBlocks = this.threadBlocks(block.threadId).filter((candidate) => candidate.processingStatus === 'ready');
      const latestBlockPosition = threadBlocks.length;
      const blockPosition = threadBlocks.indexOf(block) + 1;
      const age = Math.max(0, latestBlockPosition - blockPosition);
      const level = getDecayedBlockLevel(
        block.pointerAnchorLevel,
        block.pointerAnchorBlockPosition,
        latestBlockPosition,
        this.blockDecayLambda,
      );
      block.pointerCurrentLevel = level;
      return {
        id: block.id,
        ...(block.threadId ? { threadId: block.threadId } : {}),
        turnRange: [block.startTurn, block.endTurn],
        age,
        level,
        label: blockLevelLabel(level),
        content: renderBlock(block, level),
      };
    });
  }

  async expandBlock(id: string, target: unknown = 'next', source: BlockLiftSource = 'agent'): Promise<BlockContextEntry> {
    return this.commitMutation(() => {
      const block = this.blocks.find((candidate) => candidate.id === id);
      if (!block) throw new Error(`Unknown block: ${id}`);
      if (block.processingStatus !== 'ready') throw new Error(`Block ${id} is not ready for decay or expansion`);
      const readyBlocks = this.threadBlocks(block.threadId).filter((candidate) => candidate.processingStatus === 'ready');
      const latestBlockPosition = readyBlocks.length;
      const blockPosition = readyBlocks.indexOf(block) + 1;
      const current = getDecayedBlockLevel(
        block.pointerAnchorLevel,
        block.pointerAnchorBlockPosition,
        latestBlockPosition,
        this.blockDecayLambda,
      );
      const level = normalizeBlockLevel(target, current);
      block.pointerCurrentLevel = level;
      block.pointerAnchorLevel = level;
      block.pointerAnchorBlockPosition = latestBlockPosition;
      block.lastLiftedAt = toUtc8Iso(this.now());
      block.lastLiftedBy = source;
      return {
        id: block.id,
        ...(block.threadId ? { threadId: block.threadId } : {}),
        turnRange: [block.startTurn, block.endTurn] as [number, number],
        age: Math.max(0, latestBlockPosition - blockPosition),
        level,
        label: blockLevelLabel(level),
        content: renderBlock(block, level),
      };
    });
  }

  assessRetrieval(input: RetrievalAssessmentInput, batchEvidenceRefs: ReadonlySet<string>): RetrievalAssessment {
    return normalizeRetrievalAssessment(input, batchEvidenceRefs);
  }

  async recordMemoryUse(refs: readonly string[] | MemoryUseRefs, options: RecordMemoryUseOptions = {}): Promise<void> {
    const receiptId = options.receiptId?.trim();
    if (this.storage && !receiptId) throw new TypeError('Persistent recordMemoryUse requires a non-empty receiptId');
    const normalizedRefs: MemoryUseRefs = Array.isArray(refs)
      ? { eventIds: refs as readonly string[] }
      : refs as MemoryUseRefs;
    const requestedEventIds = [...new Set(normalizedRefs.eventIds ?? [])];
    const requestedElementIds = [...new Set(normalizedRefs.elementIds ?? [])];
    const audit = options.audit === undefined ? undefined : structuredClone(options.audit);
    if (receiptId) {
      const existing = this.usageReceipts.get(receiptId);
      if (existing) {
        if (!sameIds(existing.eventIds, requestedEventIds)
          || !sameIds(existing.elementIds, requestedElementIds)
          || JSON.stringify(existing.audit ?? null) !== JSON.stringify(audit ?? null)) {
          throw new Error(`Usage receipt ${receiptId} was already recorded with different memory IDs or audit metadata`);
        }
        return;
      }
    }

    await this.commitMutation(() => {
      const now = toUtc8Iso(this.now());
      for (const id of requestedEventIds) {
        const event = this.findEvent(id);
        if (!event || event.status === 'forgotten' || event.status === 'archived') continue;
        event.weight.mentionCount += 1;
        event.weight.lastAdoptedTurn = this.currentTurn;
        event.updatedAt = now;
      }
      for (const id of requestedElementIds) {
        const element = this.elements.find((candidate) => candidate.id === id);
        if (!element) continue;
        element.weight.mentionCount += 1;
        element.weight.lastAdoptedTurn = this.currentTurn;
        element.updatedAt = now;
      }
      if (receiptId) this.usageReceipts.set(receiptId, {
        id: receiptId,
        eventIds: requestedEventIds,
        elementIds: requestedElementIds,
        ...(audit === undefined ? {} : { audit }),
        createdAt: now,
      });
    });
  }

  async pinEvent(id: string, pinned = true): Promise<void> {
    await this.commitMutation(() => {
      const event = this.requireEvent(id);
      event.weight.pinned = pinned;
      event.updatedAt = toUtc8Iso(this.now());
    });
  }

  async forgetEvent(id: string): Promise<void> {
    await this.commitMutation(() => {
      const event = this.requireEvent(id);
      event.status = 'forgotten';
      event.updatedAt = toUtc8Iso(this.now());
    });
  }

  async restoreEvent(id: string): Promise<void> {
    await this.commitMutation(() => {
      const event = this.requireEvent(id);
      event.status = 'active';
      event.updatedAt = toUtc8Iso(this.now());
    });
  }

  async close(): Promise<void> {
    await this.storage?.close?.();
  }

  private normalizeExternalAction(value: unknown): ExternalMemoryAction {
    const action = typeof value === 'string' ? value.trim().toUpperCase() : '';
    return action === 'ADD' || action === 'MERGE' || action === 'SUPERSEDE'
      || action === 'CONFLICT' || action === 'IGNORE' ? action : 'IGNORE';
  }

  private requireExternalMemoryImportJob(id: string): ExternalMemoryImportJob {
    const job = this.externalMemoryImportJobs.get(id.trim());
    if (!job) throw new Error(`Unknown external memory import job: ${id}`);
    return job;
  }

  private createExternalSourceBlock(text: string, importedAt: string): MemoryBlock {
    const blockId = this.idFactory('blk');
    const threadId = `external-import:${blockId}`;
    const message: RawMessage = {
      id: this.idFactory('msg'),
      role: 'user',
      content: text,
      createdAt: importedAt,
      threadId,
    };
    const firstLine = text.split(/\r?\n/u).map((line) => line.trim()).find(Boolean) ?? 'External AI memory import';
    const block: MemoryBlock = {
      id: blockId,
      threadId,
      sequence: Math.max(0, ...this.blocks.map(({ sequence }) => sequence)) + 1,
      startTurn: 1,
      endTurn: 1,
      createdAt: importedAt,
      l0Title: firstLine.slice(0, 80),
      l0Tags: ['external-memory-import'],
      l1Summary: text.replace(/\s+/gu, ' ').trim().slice(0, 500),
      l2Keypoints: text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).slice(0, 8),
      shouldExtract: false,
      processingStatus: 'ready',
      ...deterministicBlockLayers([message]),
      pointerCurrentLevel: 5,
      pointerAnchorLevel: 5,
      pointerAnchorBlockPosition: 1,
      lastLiftedAt: null,
      lastLiftedBy: null,
    };
    this.blocks.push(block);
    this.indexRawBlock(block);
    this.markRawMessagesForUpsert(block.l5Raw);
    return block;
  }

  /** Synthetic provenance block for one agent-recorded fact (see recordAgentEvent). */
  private createAgentSourceBlock(text: string, recordedAt: string, tags: readonly string[]): MemoryBlock {
    const blockId = this.idFactory('blk');
    const threadId = `agent-memory:${blockId}`;
    const message: RawMessage = {
      id: this.idFactory('msg'),
      role: 'user',
      content: text,
      createdAt: recordedAt,
      threadId,
    };
    const firstLine = text.split(/\r?\n/u).map((line) => line.trim()).find(Boolean) ?? 'Agent-recorded memory';
    const block: MemoryBlock = {
      id: blockId,
      threadId,
      sequence: Math.max(0, ...this.blocks.map(({ sequence }) => sequence)) + 1,
      startTurn: 1,
      endTurn: 1,
      createdAt: recordedAt,
      l0Title: firstLine.slice(0, 80),
      l0Tags: ['agent-memory', ...tags],
      l1Summary: text.replace(/\s+/gu, ' ').trim().slice(0, 500),
      l2Keypoints: text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).slice(0, 8),
      shouldExtract: false,
      processingStatus: 'ready',
      ...deterministicBlockLayers([message]),
      pointerCurrentLevel: 5,
      pointerAnchorLevel: 5,
      pointerAnchorBlockPosition: 1,
      lastLiftedAt: null,
      lastLiftedBy: null,
    };
    this.blocks.push(block);
    this.indexRawBlock(block);
    this.markRawMessagesForUpsert(block.l5Raw);
    return block;
  }

  /**
   * Record one agent-authored fact as a long-term Event in the isolated
   * agent-events pool, after a pre-write duplicate/conflict gate:
   * exact and near duplicates reinforce the existing card instead of writing;
   * ambiguous overlap gets one model adjudication reusing the external-memory
   * decision contract; clear-new facts write directly.
   *
   * The gate follows the same claim → model → commit shape as the Block
   * summarizer/extractor: phase 1 (mutation) runs the deterministic gate,
   * phase 2 runs the decider WITHOUT holding the mutation queue so concurrent
   * writes are never blocked, phase 3 (mutation) re-checks duplicates and
   * applies the decision. Reinforcement is applied inline inside a mutation
   * (recordMemoryUse would nest commitMutation and deadlock) and the pre-write
   * search MUST pass trackRetrieval:false for the same reason.
   */
  async recordAgentEvent(options: AgentEventRecordOptions): Promise<AgentEventRecordResult> {
    const content = options.content.trim();
    if (!content) throw new TypeError('Agent memory content must not be empty');
    if (options.category !== undefined && !['preference', 'decision', 'correction', 'fact'].includes(options.category)) {
      throw new TypeError(`Unknown agent memory category: ${String(options.category)}`);
    }
    const topK = Math.max(1, Math.min(20, Math.floor(options.topK ?? 5)));
    const decider = options.decider;

    // Phase 1 (mutation held): deterministic gate. Duplicates reinforce,
    // clear-new facts write, no-decider ambiguity conflict-marks — none of
    // these need a model. Only an ambiguous fact WITH an adjudicator defers.
    const gate = await this.commitMutation(async (): Promise<AgentEventGateOutcome> => {
      const now = toUtc8Iso(options.importedAt ?? this.now());
      const candidate = agentEventCandidate(content, options.category, now, options.threadId?.trim() || undefined);
      const candidateTokens = searchTokens(`${candidate.title} ${candidate.summary}`);
      const reinforced = this.scanAgentEventDuplicates(candidate, candidateTokens, now);
      if (reinforced) return { phase: 'done', result: reinforced };

      const query = `${candidate.title} ${candidate.summary}`.trim();
      const matches = await this.searchEvents(query, { limit: topK, trackRetrieval: false });
      const matchedEventIds = matches.map(({ event }) => event.id);
      const ambiguous = matches
        .filter(({ event }) => tokenContainment(candidateTokens, searchTokens(`${event.title} ${event.summary}`)) >= AGENT_EVENT_AMBIGUOUS)
        .map(({ event }) => event.id);

      if (ambiguous.length === 0) {
        return { phase: 'done', result: this.writeAgentEvent(candidate, 'ADDED', 'clear-new', [], { now, matchedEventIds }) };
      }
      if (!decider) {
        return { phase: 'done', result: this.writeAgentEvent(candidate, 'CONFLICT_MARKED', 'heuristic-conflict', ambiguous, {
          now,
          matchedEventIds,
          conflicts: true,
          reason: '存在语义相关的既有记忆且当前没有可用的仲裁器，已标记冲突',
        }) };
      }
      return { phase: 'adjudicate', candidate, matches, ambiguous, matchedEventIds, now };
    });
    if (gate.phase === 'done') return gate.result;
    // Unreachable: the adjudicate branch requires a decider.
    if (!decider) throw new Error('StrataGate agent memory adjudicator is missing');

    // Phase 2 (no mutation held): the model call. Concurrent writes in this
    // namespace proceed while the adjudication is in flight.
    let decision: ExternalMemoryDecision | undefined;
    try {
      decision = await decider({
        candidate: structuredClone(gate.candidate),
        matches: structuredClone(gate.matches),
      });
    } catch {
      decision = undefined;
    }

    // Phase 3 (mutation held): apply with fresh duplicate re-checks — another
    // write may have landed the same fact while the adjudication ran.
    return this.commitMutation(() => {
      const now = toUtc8Iso(this.now());
      const candidateTokens = searchTokens(`${gate.candidate.title} ${gate.candidate.summary}`);
      const reinforced = this.scanAgentEventDuplicates(gate.candidate, candidateTokens, now);
      if (reinforced) return reinforced;
      if (!decision) {
        return this.writeAgentEvent(gate.candidate, 'CONFLICT_MARKED', 'decider-error', gate.ambiguous, {
          now,
          matchedEventIds: gate.matchedEventIds,
          conflicts: true,
          reason: '仲裁器调用失败，已按冲突标记写入',
        });
      }
      return this.applyAgentEventDecision(gate, decision, now);
    });
  }

  /** Exact-fingerprint and near-duplicate sweep over the merged live pool. */
  private scanAgentEventDuplicates(
    candidate: ExternalMemoryCandidate,
    candidateTokens: readonly string[],
    now: string,
  ): AgentEventRecordResult | null {
    const live = this.listAllEvents()
      .filter((event) => event.status !== 'forgotten' && event.status !== 'archived');
    const candidateFingerprint = externalMemoryFingerprint(candidate);
    const exact = live.find((event) => externalMemoryFingerprint(event) === candidateFingerprint);
    if (exact) return this.reinforceAgentEvent(exact, 'exact-duplicate', now);
    let best: { event: EventCard; score: number } | null = null;
    for (const event of live) {
      const score = tokenContainment(candidateTokens, searchTokens(`${event.title} ${event.summary}`));
      if (score > (best?.score ?? 0)) best = { event, score };
    }
    if (best && best.score >= AGENT_EVENT_NEAR_DUPLICATE) {
      return this.reinforceAgentEvent(best.event, 'near-duplicate', now);
    }
    return null;
  }

  private applyAgentEventDecision(
    gate: { candidate: ExternalMemoryCandidate; ambiguous: readonly string[]; matchedEventIds: readonly string[] },
    decision: ExternalMemoryDecision,
    now: string,
  ): AgentEventRecordResult {
    const allowed = new Set(gate.matchedEventIds);
    const existingEventIds = [...new Set((decision.existingEventIds ?? []).filter((id) => allowed.has(id)))];
    const requestedAction = this.normalizeExternalAction(decision.action);
    const confidence = Number.isFinite(decision.confidence)
      ? Math.max(0, Math.min(1, decision.confidence!))
      : 0.5;
    const reason = typeof decision.reason === 'string' && decision.reason.trim()
      ? decision.reason.trim().slice(0, 500)
      : undefined;
    const mergedCandidate = decision.mergedCandidate
      && typeof decision.mergedCandidate.title === 'string' && decision.mergedCandidate.title.trim()
      && typeof decision.mergedCandidate.summary === 'string' && decision.mergedCandidate.summary.trim()
      ? decision.mergedCandidate
      : undefined;

    if (requestedAction === 'IGNORE') {
      return {
        action: 'IGNORED', gate: 'decider', recorded: false,
        existingEventIds, matchedEventIds: [...gate.matchedEventIds], confidence,
        ...(reason ? { reason } : {}),
      };
    }
    if ((requestedAction === 'MERGE' || requestedAction === 'SUPERSEDE')
      && (existingEventIds.length === 0 || confidence < EXTERNAL_MEMORY_AUTO_APPLY_CONFIDENCE)) {
      // Never silently supersede on a low-confidence or target-less decision:
      // write non-destructively and mark the conflict instead.
      return this.writeAgentEvent(mergedCandidate ?? gate.candidate, 'CONFLICT_MARKED', 'decider', existingEventIds, {
        now,
        matchedEventIds: gate.matchedEventIds,
        confidence,
        conflicts: true,
        downgradedFrom: requestedAction as 'MERGE' | 'SUPERSEDE',
        ...(reason ? { reason } : {}),
      });
    }
    switch (requestedAction) {
      case 'ADD':
        return this.writeAgentEvent(mergedCandidate ?? gate.candidate, 'ADDED', 'decider', [], {
          now, matchedEventIds: gate.matchedEventIds, confidence, ...(reason ? { reason } : {}),
        });
      case 'MERGE':
      case 'SUPERSEDE':
        return this.writeAgentEvent(mergedCandidate ?? gate.candidate, requestedAction === 'MERGE' ? 'MERGED' : 'SUPERSEDED', 'decider', existingEventIds, {
          now, matchedEventIds: gate.matchedEventIds, confidence, supersedes: true, ...(reason ? { reason } : {}),
        });
      default:
        return this.writeAgentEvent(gate.candidate, 'CONFLICT_MARKED', 'decider', existingEventIds, {
          now, matchedEventIds: gate.matchedEventIds, confidence, conflicts: true, ...(reason ? { reason } : {}),
        });
    }
  }

  private reinforceAgentEvent(
    event: EventCard,
    gate: AgentEventRecordResult['gate'],
    now: string,
  ): AgentEventRecordResult {
    // Inline mutation only: recordMemoryUse would await commitMutation and
    // deadlock the queue this gate already holds.
    event.weight.mentionCount += 1;
    event.weight.lastAdoptedTurn = this.currentTurn;
    event.updatedAt = now;
    return {
      action: 'REINFORCED',
      gate,
      recorded: false,
      reinforcedEventId: event.id,
      existingEventIds: [event.id],
      matchedEventIds: [event.id],
      confidence: 1,
      weight: Number(memoryWeightAt(event, this.currentTurn).toFixed(3)),
    };
  }

  /**
   * Provenance for one agent recording: cite the real conversation messages of
   * the recording session — the most recent open-tail user/assistant messages
   * when available, otherwise the latest sealed block of that thread. Only
   * when the session has no ingested messages at all does a synthetic
   * provenance block get created (mirroring the external-import fallback).
   */
  private resolveAgentEventProvenance(
    candidate: ExternalMemoryCandidate,
    threadId: string | undefined,
    now: string,
  ): { messageIds: string[]; sourceBlockId?: string; synthetic: boolean } {
    const real = threadId
      ? this.listOpenTail(threadId).filter((message) => message.role === 'user' || message.role === 'assistant')
      : [];
    if (real.length > 0) {
      return { messageIds: real.slice(-AGENT_EVENT_PROVENANCE_LIMIT).map(({ id }) => id), synthetic: false };
    }
    const sealed = threadId
      ? this.blocks.filter((block) => block.threadId === threadId && block.l5Raw.length > 0)
      : [];
    const last = sealed.at(-1);
    if (last) {
      return {
        messageIds: last.l5Raw.slice(-AGENT_EVENT_PROVENANCE_LIMIT).map(({ id }) => id),
        sourceBlockId: last.id,
        synthetic: false,
      };
    }
    const source = this.createAgentSourceBlock(candidate.summary, now, candidate.tags ?? []);
    return { messageIds: [source.l5Raw[0]!.id], sourceBlockId: source.id, synthetic: true };
  }

  private writeAgentEvent(
    candidate: ExternalMemoryCandidate,
    action: AgentEventRecordResult['action'],
    gate: AgentEventRecordResult['gate'],
    targetIds: readonly string[],
    opts: {
      now: string
      matchedEventIds: readonly string[]
      confidence?: number
      reason?: string
      downgradedFrom?: 'MERGE' | 'SUPERSEDE'
      supersedes?: boolean
      conflicts?: boolean
    },
  ): AgentEventRecordResult {
    const criticality: MemoryCriticality = candidate.memoryKind === 'preference' ? 'preference' : 'routine';
    const threadId = typeof candidate.temporal?.threadId === 'string' && candidate.temporal.threadId.trim()
      ? candidate.temporal.threadId
      : undefined;
    const provenance = this.resolveAgentEventProvenance(candidate, threadId, opts.now);
    const input: AgentEventCardInput = {
      ...candidate,
      sourceMessageIds: provenance.messageIds,
      ...(provenance.sourceBlockId !== undefined ? { sourceBlockId: provenance.sourceBlockId } : {}),
      scope: 'user',
      criticality,
      temporal: {
        ...(candidate.temporal ?? {}),
        ...(opts.supersedes ? { supersedesEventIds: [...targetIds] } : {}),
        ...(opts.conflicts ? { conflictsWithEventIds: [...targetIds] } : {}),
      },
    };
    const event = provenance.synthetic
      ? this.addEventInMemory(input as EventCardInput, this.agentEvents)
      : this.addAgentEventInMemory(input, this.agentEvents);
    if (targetIds.length > 0) {
      for (const id of targetIds) {
        const existing = this.findEvent(id);
        if (!existing || existing.id === event.id) continue;
        existing.temporal.conflictsWithEventIds = [...new Set([...(existing.temporal.conflictsWithEventIds ?? []), event.id])];
        existing.updatedAt = opts.now;
      }
    }
    this.queueElementProjection([event.id]);
    this.queueGraphProjection([event.id], 2_000);
    return {
      action,
      gate,
      recorded: true,
      eventId: event.id,
      existingEventIds: [...targetIds],
      matchedEventIds: [...opts.matchedEventIds],
      ...(opts.confidence !== undefined ? { confidence: opts.confidence } : {}),
      ...(opts.downgradedFrom !== undefined ? { downgradedFrom: opts.downgradedFrom } : {}),
      ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
      ...(provenance.sourceBlockId !== undefined ? { sourceBlockId: provenance.sourceBlockId } : {}),
      sourceMessageIds: provenance.messageIds,
      weight: Number(memoryWeightAt(event, this.currentTurn).toFixed(3)),
    };
  }

  private addEventInMemory(input: EventCardInput, pool: EventCard[] = this.events): EventCard {
    const sourceBlock = this.blocks.find((block) => block.id === input.sourceBlockId);
    if (!sourceBlock) throw new Error(`Unknown source block: ${input.sourceBlockId}`);
    const validIds = new Set(sourceBlock.l5Raw.map((message) => message.id));
    const requestedRefs = [...new Set(input.sourceMessageIds.filter((id) => validIds.has(id)))];
    const sourceMessageIds = requestedRefs.length > 0 ? requestedRefs : sourceBlock.l5Raw.map((message) => message.id);
    const now = toUtc8Iso(this.now());
    const criticality = input.criticality ?? 'routine';
    const formedTurn = isSyntheticSourceThreadId(sourceBlock.threadId)
      ? this.currentTurn
      : sourceBlock.endTurn;
    return this.storeEventCard(input, pool, {
      sourceMessageIds,
      sourceBlockId: sourceBlock.id,
      formedTurn,
      now,
      criticality,
    });
  }

  /**
   * Agent-recorded variant: provenance may cite real conversation messages
   * (open tail or sealed blocks) directly, with no source block. Every cited
   * message must exist in the store; the lifecycle clock starts at the
   * current turn.
   */
  private addAgentEventInMemory(input: AgentEventCardInput, pool: EventCard[]): EventCard {
    const known = new Set([...this.openTail.map((message) => message.id), ...this.rawMessageLookup.keys()]);
    const unknown = input.sourceMessageIds.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw new Error(`Agent event cites unknown source messages: ${unknown.join(', ')}`);
    }
    const now = toUtc8Iso(this.now());
    const criticality = input.criticality ?? 'routine';
    return this.storeEventCard(input, pool, {
      sourceMessageIds: [...new Set(input.sourceMessageIds)],
      ...(input.sourceBlockId !== undefined ? { sourceBlockId: input.sourceBlockId } : {}),
      formedTurn: input.formedTurn ?? this.currentTurn,
      now,
      criticality,
    });
  }

  private storeEventCard(
    input: EventCardInput | AgentEventCardInput,
    pool: EventCard[],
    parts: {
      sourceMessageIds: string[]
      sourceBlockId?: string
      formedTurn: number
      now: string
      criticality: MemoryCriticality
    },
  ): EventCard {
    const event: EventCard = {
      id: input.id ?? this.idFactory('evt'),
      formedTurn: parts.formedTurn,
      title: input.title.trim(),
      summary: input.summary.trim(),
      narrative: input.narrative?.trim() || input.summary.trim(),
      tags: [...new Set(input.tags ?? [])].slice(0, 12),
      quotes: [...new Set(input.quotes ?? [])].slice(0, 12),
      sourceMessageIds: parts.sourceMessageIds,
      ...(parts.sourceBlockId !== undefined ? { sourceBlockId: parts.sourceBlockId } : {}),
      temporal: {
        ...(input.temporal ? { ...input.temporal } : { mentionedAt: parts.now }),
        eventType: normalizeStandardEventType(input.temporal?.eventType),
      },
      scope: input.scope ?? 'user',
      criticality: parts.criticality,
      confidence: Math.max(0, Math.min(1, input.confidence ?? 1)),
      status: 'active',
      supersededBy: null,
      weight: {
        mentionCount: 1,
        lastAdoptedTurn: parts.formedTurn,
        lastRetrievedAt: null,
        pinned: false,
        floorWeight: criticalityFloor(parts.criticality),
        forcedCap: null,
      },
      createdAt: parts.now,
      updatedAt: parts.now,
    };
    if (this.listAllEvents().some((candidate) => candidate.id === event.id)) throw new Error(`Duplicate event ID: ${event.id}`);
    pool.push(event);

    for (const supersededId of event.temporal.supersedesEventIds ?? []) {
      const old = this.findEvent(supersededId);
      if (!old || old.id === event.id) continue;
      old.status = 'superseded';
      old.supersededBy = event.id;
      old.weight.forcedCap = 0.1;
      old.updatedAt = parts.now;
    }
    return event;
  }

  private requireEvent(id: string): EventCard {
    const event = this.findEvent(id);
    if (!event) throw new Error(`Unknown event: ${id}`);
    return event;
  }

  private requireElementProjectionJob(id: string): ElementProjectionJob {
    const job = this.elementProjectionJobs.get(id);
    if (!job) throw new Error(`Unknown element projection: ${id}`);
    return job;
  }

  async searchGraphNodes(query: string, limit = 8): Promise<GraphNodeSearchResult[]> {
    const queryTokens = [...new Set(searchTokens(query))];
    if (queryTokens.length === 0) return [];
    const views = this.graphNodes.flatMap((node) => effectiveGraphNodeView(node, this.graphEdges, this.listAllEvents()) ?? []);
    const viewById = new Map(views.map((view) => [view.node.id, view]));
    const dedupe = <T>(values: readonly T[]): T[] => [...new Set(values)];
    const factValue = (fact: GraphNode['facts'][number]): string =>
      Array.isArray(fact.value) ? fact.value.join(' ') : fact.value;
    const endpoint = (nodeId: string, edge: GraphEdge): string => {
      const otherId = edge.fromNodeId === nodeId ? edge.toNodeId : edge.fromNodeId;
      const other = viewById.get(otherId)?.node;
      return other ? `${other.name} ${other.aliases.join(' ')}` : '';
    };
    const tokenSet = (value: string): Set<string> => new Set(searchTokens(value));
    const hasAny = (value: string, tokens: readonly string[]): boolean => {
      const available = tokenSet(value);
      return tokens.some((token) => available.has(token));
    };
    const matchDetails = (node: GraphNode) => {
      const view = viewById.get(node.id)!;
      const queryParts = normalizeSearchText(query).split(/[^\p{Letter}\p{Number}_]+/gu).filter(Boolean);
      const explicitFactKeys = dedupe([...view.currentFacts, ...view.historicalFacts].map(({ key }) => key))
        .filter((key) => queryParts.includes(normalizeSearchText(key)));
      const knownFactKeyTokens = new Set(explicitFactKeys.flatMap((key) => [...tokenSet(key)]));
      const queryKeyTokens = queryTokens.filter((token) => knownFactKeyTokens.has(token));
      const valueQueryTokens = queryTokens.filter((token) => !queryKeyTokens.includes(token));
      const meaningfulTokens = queryTokens;
      const factMatchesFor = (facts: readonly GraphNode['facts'][number][]): GraphNode['facts'][number][] => {
        if (queryKeyTokens.length === 0) return facts.filter((fact) => hasAny(`${fact.key} ${factValue(fact)}`, meaningfulTokens));
        const keyFacts = facts.filter((fact) => queryKeyTokens.some((token) => tokenSet(fact.key).has(token)));
        const directMatches = keyFacts.filter((fact) => valueQueryTokens.length === 0
          || valueQueryTokens.some((token) => tokenSet(factValue(fact)).has(token)));
        return directMatches;
      };
      let currentFacts = factMatchesFor(view.currentFacts);
      let historicalFacts = factMatchesFor(view.historicalFacts);
      const edgeMatches = (edge: GraphEdge, supportingFacts: readonly GraphNode['facts'][number][]): boolean => {
        if (queryKeyTokens.length === 0) return hasAny(endpoint(node.id, edge), meaningfulTokens);
        return supportingFacts.length > 0
          && hasAny(endpoint(node.id, edge), valueQueryTokens.length > 0 ? valueQueryTokens : queryTokens);
      };
      let currentEdges = view.currentEdges.filter((edge) => edgeMatches(edge, currentFacts));
      let historicalEdges = view.historicalEdges.filter((edge) => edgeMatches(edge, historicalFacts));
      if (queryKeyTokens.length === 0) {
        const overlap = (value: string): number => {
          const available = tokenSet(value);
          return meaningfulTokens.filter((token) => available.has(token)).length;
        };
        const scoredFacts = [...currentFacts, ...historicalFacts].map((fact) => [fact.id, overlap(`${fact.key} ${factValue(fact)}`)] as const);
        const scoredEdges = [...currentEdges, ...historicalEdges].map((edge) => [edge.id, overlap(endpoint(node.id, edge))] as const);
        const best = Math.max(0, ...scoredFacts.map(([, score]) => score), ...scoredEdges.map(([, score]) => score));
        const bestFacts = new Set(scoredFacts.filter(([, score]) => score === best).map(([id]) => id));
        const bestEdges = new Set(scoredEdges.filter(([, score]) => score === best).map(([id]) => id));
        currentFacts = currentFacts.filter(({ id }) => bestFacts.has(id));
        historicalFacts = historicalFacts.filter(({ id }) => bestFacts.has(id));
        currentEdges = currentEdges.filter(({ id }) => bestEdges.has(id));
        historicalEdges = historicalEdges.filter(({ id }) => bestEdges.has(id));
      }
      const metadataFields: Array<readonly [string, string]> = [
        ['name', node.name],
        ['aliases', node.aliases.join(' ')],
        ['tags', (node.tags ?? []).join(' ')],
        ['type', node.type],
      ];
      const metadataMatches = metadataFields.filter(([, value]) => hasAny(value, queryTokens)).map(([field]) => field);
      const matchedMetadataEventIds = node.metadataProvenance
        ? dedupe([
          ...(metadataMatches.includes('name') ? (node.metadataProvenance.name ?? []) : []),
          ...(node.metadataProvenance.aliases ?? []).filter(({ value }) => hasAny(value, queryTokens)).flatMap(({ sourceEventIds }) => sourceEventIds),
          ...(node.metadataProvenance.tags ?? []).filter(({ value }) => hasAny(value, queryTokens)).flatMap(({ sourceEventIds }) => sourceEventIds),
          ...(metadataMatches.includes('type') ? [...view.currentNodeEventIds, ...view.historicalNodeEventIds] : []),
        ])
        : metadataMatches.length > 0 ? dedupe([...view.currentNodeEventIds, ...view.historicalNodeEventIds]) : [];
      const eventStatus = new Map(this.listAllEvents().map((event) => [event.id, event.status]));
      const metadataCurrentHit = matchedMetadataEventIds.some((id) => eventStatus.get(id) === 'active');
      const metadataHistoricalHit = matchedMetadataEventIds.some((id) => eventStatus.get(id) === 'superseded');
      const currentRecordHit = currentFacts.length > 0 || currentEdges.length > 0;
      const historicalRecordHit = historicalFacts.length > 0 || historicalEdges.length > 0;
      const hasRecordHit = currentRecordHit || historicalRecordHit;
      // Entity metadata selects the node, but once a fact/endpoint provides the
      // semantic match it must not manufacture a second temporal-state hit.
      const currentHit = currentRecordHit || (!hasRecordHit && metadataMatches.length > 0 && metadataCurrentHit);
      const historicalHit = historicalRecordHit || (!hasRecordHit && metadataMatches.length > 0 && metadataHistoricalHit);
      const relationMatches = [...view.currentEdges, ...view.historicalEdges]
        .some((edge) => hasAny(edge.relation, queryTokens));
      const matchedFields = [
        ...metadataMatches,
        ...(currentFacts.length > 0 ? ['currentFacts'] : []),
        ...(historicalFacts.length > 0 ? ['historicalFacts'] : []),
        ...(currentEdges.length > 0 ? ['currentEdgeEndpoints'] : []),
        ...(historicalEdges.length > 0 ? ['historicalEdgeEndpoints'] : []),
        ...(relationMatches ? ['relations'] : []),
      ];
      return {
        view, currentFacts, historicalFacts, currentEdges, historicalEdges,
        metadataMatches, matchedMetadataEventIds, currentHit, historicalHit, matchedFields,
      };
    };
    const candidates = views.map(({ node }) => node);
    const ranked = bm25Rank(candidates, query, (node) => {
      const view = viewById.get(node.id)!;
      return weightedSearchTokens([
        [node.name, 6],
        [node.aliases.join(' '), 5],
        [(node.tags ?? []).join(' '), 5],
        [node.type, 2],
        [view.currentFacts.map((fact) => `${fact.key} ${factValue(fact)}`).join(' '), 4],
        [view.historicalFacts.map((fact) => `${fact.key} ${factValue(fact)}`).join(' '), 2],
        [view.currentEdges.map((edge) => endpoint(node.id, edge)).join(' '), 4],
        [view.historicalEdges.map((edge) => endpoint(node.id, edge)).join(' '), 2],
        [[...view.currentEdges, ...view.historicalEdges].map(({ relation }) => relation).join(' '), 1],
      ]);
    }).filter(({ item }) => {
      const details = matchDetails(item);
      return details.currentHit || details.historicalHit;
    }).slice(0, Math.max(1, Math.min(20, limit)));
    return ranked.map(({ item: node, score }) => {
      const details = matchDetails(node);
      const matchedEventIds = dedupe([
        ...details.currentFacts.flatMap(({ sourceEventIds }) => sourceEventIds),
        ...details.historicalFacts.flatMap(({ sourceEventIds }) => sourceEventIds),
        ...details.currentEdges.flatMap(({ sourceEventIds }) => sourceEventIds),
        ...details.historicalEdges.flatMap(({ sourceEventIds }) => sourceEventIds),
      ]);
      const historicalKeys = new Set(details.historicalFacts.map(({ key }) => key));
      const historicalRelations = new Set(details.historicalEdges.map(({ relation }) => relation));
      const currentContextEventIds = dedupe([
        ...details.view.currentFacts.filter(({ key }) => historicalKeys.has(key)).flatMap(({ sourceEventIds }) => sourceEventIds),
        ...details.view.currentEdges.filter(({ relation }) => historicalRelations.has(relation)).flatMap(({ sourceEventIds }) => sourceEventIds),
      ]);
      const currentContextFacts = details.view.currentFacts.filter(({ key }) => historicalKeys.has(key));
      const currentContextEdges = details.view.currentEdges.filter(({ relation }) => historicalRelations.has(relation));
      const nameEventIds = node.metadataProvenance?.name ?? [];
      const metadataCandidates = dedupe([...details.matchedMetadataEventIds, ...nameEventIds]);
      const metadataOnly = matchedEventIds.length === 0 && details.metadataMatches.length > 0;
      const hasVisibleLegacyMetadata = !node.metadataProvenance
        && Boolean(node.name || node.aliases.length > 0 || (node.tags?.length ?? 0) > 0);
      const legacyMetadataEventIds = hasVisibleLegacyMetadata
        ? dedupe([...details.view.currentNodeEventIds, ...details.view.historicalNodeEventIds])
        : [];
      const recordPriority = dedupe([
        ...matchedEventIds,
        ...currentContextEventIds,
      ]);
      const legacyMetadataFits = node.metadataProvenance !== undefined || !hasVisibleLegacyMetadata
        || dedupe([...recordPriority, ...legacyMetadataEventIds]).length <= GRAPH_PROVENANCE_LIMIT;
      const legacyMetadataNotExpanded = hasVisibleLegacyMetadata && !legacyMetadataFits;
      const prioritized = node.metadataProvenance
        ? dedupe([
          ...matchedEventIds,
          ...(metadataOnly ? metadataCandidates : []),
          ...currentContextEventIds,
          ...(!metadataOnly ? metadataCandidates : []),
        ])
        : recordPriority;
      const provenanceEventIds = dedupe([
        ...prioritized,
        ...(legacyMetadataFits ? legacyMetadataEventIds : []),
      ]).slice(0, GRAPH_PROVENANCE_LIMIT);
      const evidenceIds = new Set(provenanceEventIds);
      const boundedView = boundEffectiveGraphNodeView(details.view, evidenceIds, {
        preserveLegacyMetadata: legacyMetadataNotExpanded,
      });
      const bounded = <T extends GraphFact | GraphEdge>(record: T): T | null => {
        const sourceEventIds = record.sourceEventIds.filter((id) => evidenceIds.has(id));
        return sourceEventIds.length > 0 ? { ...record, sourceEventIds } : null;
      };
      const matchType = details.currentHit && details.historicalHit
        ? 'both' as const
        : details.historicalHit ? 'historical' as const : 'current' as const;
      return {
        node: boundedView.node,
        score,
        matchedFields: details.matchedFields,
        matchReason: `Meaningful ${matchType} match in ${details.matchedFields.join(', ')}; relation text is ranking-only.`,
        matchType,
        currentFacts: dedupe([...details.currentFacts, ...currentContextFacts]).flatMap((record) => bounded(record) ?? []),
        historicalFacts: details.historicalFacts.flatMap((record) => bounded(record) ?? []),
        currentEdges: dedupe([...details.currentEdges, ...currentContextEdges]).flatMap((record) => bounded(record) ?? []),
        historicalEdges: details.historicalEdges.flatMap((record) => bounded(record) ?? []),
        provenanceEventIds,
        ...(legacyMetadataNotExpanded ? { metadataEvidenceStatus: 'not_expanded' as const } : {}),
        timeline: graphTimeline(provenanceEventIds, this.listAllEvents()),
      };
    });
  }

  private requireGraphProjectionJob(id: string): GraphProjectionJob {
    const job = this.graphProjectionJobs.get(id);
    if (!job) throw new Error(`Unknown graph projection: ${id}`);
    return job;
  }

  private queueGraphProjection(sourceEventIds: readonly string[], priority: number): GraphProjectionJob | null {
    if (!this.graphProjector) return null;
    const completed = new Set([...this.graphProjectionJobs.values()]
      .filter((job) => job.projectorVersion === KNOWLEDGE_GRAPH_PROJECTOR_VERSION && job.status === 'completed')
      .flatMap((job) => job.sourceEventIds));
    const queued = new Set([...this.graphProjectionJobs.values()]
      .filter((job) => job.projectorVersion === KNOWLEDGE_GRAPH_PROJECTOR_VERSION && job.status !== 'completed')
      .flatMap((job) => job.sourceEventIds));
    const ids = [...new Set(sourceEventIds.filter((id) => this.findEvent(id)
      && !completed.has(id) && !queued.has(id)))];
    if (ids.length === 0) return null;
    const now = toUtc8Iso(this.now());
    const job: GraphProjectionJob = {
      id: this.graphIdFactory('gproj'), sourceEventIds: ids,
      projectorVersion: KNOWLEDGE_GRAPH_PROJECTOR_VERSION,
      status: 'pending', attempts: 0, priority, nodeIds: [], edgeIds: [],
      reason: null, lastError: null, nextRetryAt: null, createdAt: now, updatedAt: now,
    };
    this.graphProjectionJobs.set(job.id, job);
    return job;
  }

  private queueMissingGraphProjections(): void {
    const candidates = this.listAllEvents()
      .filter((event) => event.status !== 'forgotten' && event.status !== 'archived')
      .sort((left, right) => {
        const score = (event: EventCard): number => (event.status === 'active' ? 10_000 : 0)
          + event.weight.mentionCount * 100 + (event.scope === 'project' ? 500 : 0)
          + (Date.parse(event.temporal.happenedStart ?? event.temporal.mentionedAt ?? event.updatedAt) || 0) / 1e12;
        return score(right) - score(left);
      });
    for (let index = 0; index < candidates.length; index += 8) {
      this.queueGraphProjection(candidates.slice(index, index + 8).map(({ id }) => id), candidates.length - index);
    }
  }

  private queueElementProjection(sourceEventIds: readonly string[]): ElementProjectionJob | null {
    if (this.disableElementProjection) return null;
    const ids = [...new Set(sourceEventIds.filter((id) => Boolean(this.findEvent(id))))];
    if (ids.length === 0) return null;
    const now = toUtc8Iso(this.now());
    const job: ElementProjectionJob = {
      id: this.elementIdFactory('proj'),
      sourceEventIds: ids,
      status: 'pending',
      attempts: 0,
      elementIds: [],
      reason: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    };
    this.elementProjectionJobs.set(job.id, job);
    return job;
  }

  private indexRawBlock(block: MemoryBlock): void {
    for (const [index, message] of block.l5Raw.entries()) {
      this.rawMessageLookup.set(message.id, { block, index, message });
    }
  }

  private markRawMessagesForUpsert(messages: readonly RawMessage[]): void {
    for (const message of messages) {
      this.pendingRawDeletes.delete(message.id);
      this.pendingRawUpserts.set(message.id, structuredClone(message));
    }
  }

  private markRawMessagesDeleted(ids: ReadonlySet<string>): void {
    for (const id of ids) {
      this.pendingRawUpserts.delete(id);
      this.pendingRawDeletes.add(id);
      this.rawMessageLookup.delete(id);
    }
  }

  private rebuildRawMessageLookup(): void {
    this.rawMessageLookup.clear();
    for (const block of this.blocks) this.indexRawBlock(block);
  }

  private threadOpenTail(threadId: string | undefined): RawMessage[] {
    return this.openTail.filter((message) => message.threadId === threadId);
  }

  private threadBlocks(threadId: string | undefined): MemoryBlock[] {
    return this.blocks.filter((block) => block.threadId === threadId);
  }

  private threadTurn(threadId: string): number {
    const sealedTurns = this.threadBlocks(threadId)
      .reduce((total, block) => total + block.l5Raw.filter((message) => message.role === 'user').length, 0);
    return sealedTurns + this.threadOpenTail(threadId).filter((message) => message.role === 'user').length;
  }

  private nextSealableThread(): { threadId: string | undefined } | null {
    const counts: Array<{ threadId: string | undefined; users: number }> = [];
    for (const message of this.openTail) {
      if (message.role !== 'user') continue;
      let entry = counts.find((candidate) => candidate.threadId === message.threadId);
      if (!entry) {
        entry = { threadId: message.threadId, users: 0 };
        counts.push(entry);
      }
      entry.users += 1;
      if (entry.users >= this.blockTurnSize) return { threadId: entry.threadId };
    }
    return null;
  }

  private nextBlockInThread(block: MemoryBlock): MemoryBlock | null {
    const index = this.blocks.indexOf(block);
    return this.blocks.slice(index + 1).find((candidate) => candidate.threadId === block.threadId) ?? null;
  }

  private pendingBlockMessages(threadId: string | undefined): RawMessage[] {
    const messages = this.threadOpenTail(threadId);
    let users = 0;
    let end = messages.length;
    for (const [index, message] of messages.entries()) {
      if (message.role !== 'user') continue;
      users += 1;
      if (users !== this.blockTurnSize) continue;
      const nextUserOffset = messages.slice(index + 1).findIndex((candidate) => candidate.role === 'user');
      end = nextUserOffset === -1 ? messages.length : index + 1 + nextUserOffset;
      break;
    }
    return messages.slice(0, end);
  }

  private async sealOpenTail(threadId: string | undefined): Promise<MemoryBlock> {
    const raw = this.pendingBlockMessages(threadId);
    if (raw.filter((message) => message.role === 'user').length < this.blockTurnSize) {
      throw new Error('Open tail does not contain enough turns to seal a block');
    }
    const deterministic = deterministicBlockLayers(raw);
    const sequence = this.blocks.length + 1;
    const threadBlocks = this.threadBlocks(threadId);
    const previous = threadBlocks.at(-1);
    const blockPosition = threadBlocks.length + 1;
    const startTurn = previous ? previous.endTurn + 1 : 1;
    const endTurn = startTurn + this.blockTurnSize - 1;
    return this.commitMutation(() => {
      const currentRaw = this.pendingBlockMessages(threadId);
      if (!sameIds(currentRaw.map((message) => message.id), raw.map((message) => message.id))) {
        throw new Error('Open tail changed while the block summary was being prepared');
      }
      const block: MemoryBlock = {
        id: this.idFactory('blk'),
        ...(threadId ? { threadId } : {}),
        sequence,
        startTurn,
        endTurn,
        createdAt: raw.at(-1)?.createdAt ?? toUtc8Iso(this.now()),
        processingStatus: 'pending',
        ...deterministic,
        pointerCurrentLevel: 5,
        pointerAnchorLevel: 5,
        pointerAnchorBlockPosition: blockPosition,
        lastLiftedAt: null,
        lastLiftedBy: null,
      };
      const sealedIds = new Set(raw.map((message) => message.id));
      const remaining = this.openTail.filter((message) => !sealedIds.has(message.id));
      this.openTail.splice(0, this.openTail.length, ...remaining);
      this.blocks.push(block);
      this.indexRawBlock(block);
      this.markRawMessagesForUpsert(block.l5Raw);
      const updatedAt = toUtc8Iso(this.now());
      this.summaryJobs.set(block.id, {
        blockId: block.id,
        status: 'pending',
        attempts: 0,
        lastError: null,
        nextRetryAt: null,
        updatedAt,
      });
      return block;
    });
  }

  private async processBlock(block: MemoryBlock, options: { retryFailed: boolean }): Promise<EventCard[]> {
    if (block.processingStatus === 'ready') return [];
    const summary = this.summaryJobs.get(block.id);
    if (!summary || summary.status !== 'succeeded') {
      if (!this.summarizer || !this.jobCanRun(summary, options.retryFailed)) return [];
      const claimed = await this.commitMutation(() => {
        const current = this.summaryJobs.get(block.id);
        if (!current || !this.jobCanRun(current, options.retryFailed)) return false;
        this.summaryJobs.set(block.id, {
          ...current,
          status: 'running',
          attempts: current.attempts + 1,
          lastError: null,
          nextRetryAt: null,
          updatedAt: toUtc8Iso(this.now()),
        });
        return true;
      });
      if (!claimed) return [];
      try {
        const generated = await this.summarizer(block.l5Raw);
        if (!generated.l0Title.trim() || !generated.l1Summary.trim()
          || !Array.isArray(generated.l0Tags) || !Array.isArray(generated.l2Keypoints)
          || typeof generated.shouldExtract !== 'boolean') {
          throw new Error('Block summarizer returned invalid L0-L2 layers');
        }
        await this.commitMutation(() => {
          block.l0Title = generated.l0Title;
          block.l0Tags = [...generated.l0Tags];
          block.l1Summary = generated.l1Summary;
          block.l2Keypoints = [...generated.l2Keypoints];
          block.shouldExtract = generated.shouldExtract;
          const current = this.summaryJobs.get(block.id);
          if (!current) throw new Error(`Missing summary job for block: ${block.id}`);
          this.summaryJobs.set(block.id, {
            ...current,
            status: 'succeeded',
            lastError: null,
            nextRetryAt: null,
            updatedAt: toUtc8Iso(this.now()),
          });
        });
      } catch (error) {
        await this.failSummary(block.id, error);
        return [];
      }
    }
    if (block.shouldExtract === false) {
      await this.commitMutation(() => {
        const now = toUtc8Iso(this.now());
        this.extractionJobs.set(block.id, {
          blockId: block.id,
          status: 'skipped',
          attempts: this.extractionJobs.get(block.id)?.attempts ?? 0,
          lastError: null,
          nextRetryAt: null,
          updatedAt: now,
        });
        this.markBlockReady(block);
      });
      return [];
    }
    try {
      const extracted = await this.extractEligibleBlock({ blockId: block.id, retryFailed: options.retryFailed });
      return extracted ?? [];
    } catch {
      // The job contains the full observable failure. A derived-task failure
      // must never roll back sealing or reject turn ingestion.
      return [];
    }
  }

  private jobCanRun(job: { status: string; attempts: number; nextRetryAt: string | null } | undefined, force: boolean): boolean {
    if (!job || job.attempts >= DERIVATION_MAX_ATTEMPTS || job.status === 'running' || job.status === 'succeeded') return false;
    return force || job.nextRetryAt === null || Date.parse(job.nextRetryAt) <= this.now().getTime();
  }

  private async failSummary(blockId: string, error: unknown): Promise<void> {
    await this.commitMutation(() => {
      const job = this.summaryJobs.get(blockId);
      if (!job) return;
      this.summaryJobs.set(blockId, {
        ...job,
        status: 'failed',
        lastError: errorMessage(error),
        nextRetryAt: this.retryAt(job.attempts),
        updatedAt: toUtc8Iso(this.now()),
      });
    });
  }

  private retryAt(attempts: number): string | null {
    if (attempts >= DERIVATION_MAX_ATTEMPTS) return null;
    return toUtc8Iso(new Date(this.now().getTime() + DERIVATION_BACKOFF_MS * (2 ** Math.max(0, attempts - 1))));
  }

  private markBlockReady(block: MemoryBlock): void {
    if (!block.l0Title || !block.l0Tags || !block.l1Summary || !block.l2Keypoints || typeof block.shouldExtract !== 'boolean') {
      throw new Error(`Block ${block.id} cannot become ready without validated L0-L2 layers`);
    }
    const ready = this.threadBlocks(block.threadId).filter((candidate) => candidate.processingStatus === 'ready');
    block.processingStatus = 'ready';
    block.pointerCurrentLevel = 5;
    block.pointerAnchorLevel = 5;
    block.pointerAnchorBlockPosition = ready.length + 1;
  }

  private async extractEligibleBlock(options: { blockId?: string; retryFailed?: boolean } = {}): Promise<EventCard[] | null> {
    if (!this.extractor) return null;
    const target = this.blocks.find((block) => {
      if (block.processingStatus === 'ready' || block.shouldExtract !== true) return false;
      if (options.blockId !== undefined && block.id !== options.blockId) return false;
      const job = this.extractionJobs.get(block.id);
      return job === undefined || this.jobCanRun(job, options.retryFailed === true);
    });
    if (!target) return null;
    const threadBlocks = this.threadBlocks(target.threadId);
    const targetIndex = threadBlocks.indexOf(target);
    const next = threadBlocks.slice(targetIndex + 1).find((block) => block.l2Keypoints !== undefined) ?? null;
    const existing = this.extractionJobs.get(target.id);
    await this.commitMutation(() => {
      const currentStatus = this.extractionJobs.get(target.id)?.status;
      if (currentStatus !== undefined && currentStatus !== 'failed') {
        throw new Error(`Extraction block ${target.id} is already ${currentStatus}`);
      }
      this.extractionJobs.set(target.id, {
        blockId: target.id,
        status: 'running',
        attempts: (existing?.attempts ?? 0) + 1,
        lastError: null,
        nextRetryAt: null,
        updatedAt: toUtc8Iso(this.now()),
      });
    });

    let result: Awaited<ReturnType<EventExtractor>>;
    try {
      const query = [target.l0Title, target.l1Summary, ...(target.l2Keypoints ?? [])]
        .filter(Boolean).join(' ');
      const relevant = query
        ? (await this.searchEvents(query, { limit: 8, trackRetrieval: false })).map(({ event }) => event)
        : [];
      // formedTurn is thread-local; Block sequence preserves order across threads.
      const sourceSequence = new Map(this.blocks.map((block) => [block.id, block.sequence]));
      const recent = this.events
        .filter((event) => event.status === 'active' || event.status === 'superseded')
        .sort((left, right) => (sourceSequence.get(right.sourceBlockId ?? '') ?? -1)
          - (sourceSequence.get(left.sourceBlockId ?? '') ?? -1)
          || (right.formedTurn ?? -1) - (left.formedTurn ?? -1)
          || right.createdAt.localeCompare(left.createdAt)
          || right.id.localeCompare(left.id))
        .slice(0, 4);
      const timelineEvents = new Map(relevant.map((event) => [event.id, event]));
      for (const event of recent) {
        if (!timelineEvents.has(event.id)) timelineEvents.set(event.id, event);
      }
      result = await this.extractor({
        previous: threadBlocks.slice(0, targetIndex).reverse().find((block) => block.l2Keypoints !== undefined) ?? null,
        target,
        next,
        timeline: [...timelineEvents.values()].map((event) => ({ id: event.id, title: event.title, temporal: event.temporal })),
      });
    } catch (error) {
      await this.commitMutation(() => {
        const job = this.extractionJobs.get(target.id);
        if (!job) return;
        this.extractionJobs.set(target.id, {
          ...job,
          status: 'failed',
          lastError: errorMessage(error),
          nextRetryAt: this.retryAt(job.attempts),
          updatedAt: toUtc8Iso(this.now()),
        });
      });
      throw error;
    }

    if (result.shouldExtract && result.events.length === 0) {
      const reason = `Extractor requested extraction but returned no valid events${result.reason.trim() ? `: ${result.reason.trim()}` : '.'}`;
      await this.commitMutation(() => {
        const job = this.extractionJobs.get(target.id);
        if (!job) return;
        this.extractionJobs.set(target.id, {
          ...job,
          status: 'failed',
          lastError: reason,
          nextRetryAt: this.retryAt(job.attempts),
          updatedAt: toUtc8Iso(this.now()),
        });
      });
      throw new Error(reason);
    }

    return this.commitMutation(() => {
      const extracted = result.shouldExtract
        ? result.events.map((event) => this.addEventInMemory({ ...event, sourceBlockId: target.id }))
        : [];
      if (extracted.length > 0) {
        const ids = extracted.map(({ id }) => id);
        this.queueElementProjection(ids);
        this.queueGraphProjection(ids, 1_000);
      }
      const job = this.extractionJobs.get(target.id);
      if (!job) throw new Error(`Missing extraction job for block: ${target.id}`);
      this.extractionJobs.set(target.id, {
        ...job,
        status: result.shouldExtract ? 'succeeded' : 'skipped',
        lastError: null,
        nextRetryAt: null,
        updatedAt: toUtc8Iso(this.now()),
      });
      this.markBlockReady(target);
      return extracted;
    });
  }

  private async projectEligibleElements(): Promise<ElementCard[] | null> {
    if (!this.elementProjector) return null;
    const batch = await this.claimNextElementProjection();
    if (!batch) return null;
    try {
      const result = await this.elementProjector(batch);
      return await this.completeElementProjection(batch.jobId, result);
    } catch (error) {
      await this.failElementProjection(batch.jobId, error);
      throw error;
    }
  }

  private async projectEligibleGraph(): Promise<{ nodeIds: string[]; edgeIds: string[] } | null> {
    if (!this.graphProjector) return null;
    const batch = await this.claimNextGraphProjection();
    if (!batch) return null;
    try {
      return await this.completeGraphProjection(batch.jobId, await this.graphProjector(batch));
    } catch (error) {
      await this.failGraphProjection(batch.jobId, error);
      return null;
    }
  }

  private async commitMutation<T>(mutation: () => T | Promise<T>): Promise<T> {
    const previous = this.mutationQueue;
    let release!: () => void;
    this.mutationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    if (!this.storage) {
      try {
        return await mutation();
      } finally {
        release();
      }
    }

    const before = this.exportSnapshot();
    const beforeRevision = this.revision;
    const beforeRawUpserts = new Map(this.pendingRawUpserts);
    const beforeRawDeletes = new Set(this.pendingRawDeletes);
    try {
      const result = await mutation();
      await this.persist();
      return result;
    } catch (error) {
      this.restoreSnapshot(before);
      this.revision = beforeRevision;
      this.pendingRawUpserts.clear();
      for (const [id, message] of beforeRawUpserts) this.pendingRawUpserts.set(id, message);
      this.pendingRawDeletes.clear();
      for (const id of beforeRawDeletes) this.pendingRawDeletes.add(id);
      throw error;
    } finally {
      release();
    }
  }

  private async persist(): Promise<void> {
    if (!this.storage || !this.namespace) return;
    const delta = {
      upsert: [...this.pendingRawUpserts.values()],
      deleteIds: [...this.pendingRawDeletes],
    };
    this.revision = await this.storage.save(this.namespace, this.exportSnapshot(), this.revision, delta);
    this.pendingRawUpserts.clear();
    this.pendingRawDeletes.clear();
  }

  private restoreSnapshot(snapshot: StrataGateSnapshot): void {
    const normalized = normalizeSnapshot(snapshot);
    if (normalized.blockTurnSize !== this.blockTurnSize) {
      throw new Error(`Snapshot blockTurnSize ${normalized.blockTurnSize} does not match ${this.blockTurnSize}`);
    }
    const copy = cloneSnapshot(normalized);
    this.blockDecayLambdaValue = copy.blockDecayLambda;
    this.currentTurn = copy.currentTurn;
    this.openTail.splice(0, this.openTail.length, ...copy.openTail);
    this.blocks.splice(0, this.blocks.length, ...copy.blocks);
    this.rebuildRawMessageLookup();
    this.pendingRawUpserts.clear();
    this.pendingRawDeletes.clear();
    this.summaryJobs.clear();
    for (const job of copy.summaryJobs) this.summaryJobs.set(job.blockId, job);
    this.events.splice(0, this.events.length, ...copy.events);
    this.agentEvents.splice(0, this.agentEvents.length, ...copy.agentEvents);
    this.graphNodes.splice(0, this.graphNodes.length, ...copy.graphNodes);
    this.graphEdges.splice(0, this.graphEdges.length, ...copy.graphEdges);
    this.elements.splice(0, this.elements.length, ...copy.elements);
    this.extractionJobs.clear();
    for (const job of copy.extractionJobs) this.extractionJobs.set(job.blockId, job);
    this.elementProjectionJobs.clear();
    for (const job of copy.elementProjectionJobs) this.elementProjectionJobs.set(job.id, job);
    this.graphProjectionJobs.clear();
    for (const job of copy.graphProjectionJobs) this.graphProjectionJobs.set(job.id, job);
    this.usageReceipts.clear();
    for (const receipt of copy.usageReceipts) this.usageReceipts.set(receipt.id, receipt);
    this.ingestionReceipts.clear();
    for (const receipt of copy.ingestionReceipts) this.ingestionReceipts.set(receipt.id, receipt);
    this.externalMemoryImportJobs.clear();
    for (const job of copy.externalMemoryImportJobs) this.externalMemoryImportJobs.set(job.id, job);
    this.successfulModelResponses.splice(0, this.successfulModelResponses.length, ...(copy.successfulModelResponses ?? []));
    this.validateReferences();
  }

  private validateReferences(): void {
    const blockIds = new Set<string>();
    const messageBlockIds = new Map<string, string>();
    for (const block of this.blocks) {
      if (blockIds.has(block.id)) throw new Error(`Duplicate block ID in snapshot: ${block.id}`);
      blockIds.add(block.id);
      for (const message of block.l5Raw) {
        if (messageBlockIds.has(message.id)) throw new Error(`Duplicate message ID in snapshot: ${message.id}`);
        messageBlockIds.set(message.id, block.id);
      }
    }
    for (const message of this.openTail) {
      if (messageBlockIds.has(message.id)) throw new Error(`Duplicate message ID in snapshot: ${message.id}`);
      messageBlockIds.set(message.id, 'open-tail');
    }
    const eventIds = new Set<string>();
    for (const event of this.listAllEvents()) {
      if (eventIds.has(event.id)) throw new Error(`Duplicate event ID in snapshot: ${event.id}`);
      eventIds.add(event.id);
      if (event.sourceBlockId === undefined) {
        // Agent-recorded events may cite real conversation messages directly
        // (open tail or any sealed block) without a provenance block.
        for (const messageId of event.sourceMessageIds) {
          if (!messageBlockIds.has(messageId)) {
            throw new Error(`Event ${event.id} references unknown source message ${messageId}`);
          }
        }
        continue;
      }
      if (!blockIds.has(event.sourceBlockId)) throw new Error(`Unknown event source block in snapshot: ${event.sourceBlockId}`);
      for (const messageId of event.sourceMessageIds) {
        if (messageBlockIds.get(messageId) !== event.sourceBlockId) {
          throw new Error(`Event ${event.id} references a message outside source block ${event.sourceBlockId}`);
        }
      }
    }
    for (const job of this.extractionJobs.values()) {
      if (!blockIds.has(job.blockId)) throw new Error(`Unknown extraction job block in snapshot: ${job.blockId}`);
    }
    for (const job of this.summaryJobs.values()) {
      if (!blockIds.has(job.blockId)) throw new Error(`Unknown summary job block in snapshot: ${job.blockId}`);
    }
    const elementIds = new Set<string>();
    for (const element of this.elements) {
      if (elementIds.has(element.id)) throw new Error(`Duplicate element ID in snapshot: ${element.id}`);
      elementIds.add(element.id);
      for (const eventId of element.sourceEventIds) {
        if (!eventIds.has(eventId)) throw new Error(`Element ${element.id} references unknown event ${eventId}`);
      }
      const sourceMessageIds = new Set(element.sourceEventIds.flatMap((eventId) =>
        this.findEvent(eventId)?.sourceMessageIds ?? []));
      for (const messageId of element.sourceMessageIds) {
        if (!sourceMessageIds.has(messageId)) {
          throw new Error(`Element ${element.id} references message ${messageId} outside its source events`);
        }
      }
      for (const fact of element.facts) {
        for (const eventId of fact.sourceEventIds) {
          if (!eventIds.has(eventId)) throw new Error(`Element fact ${fact.id} references unknown event ${eventId}`);
        }
      }
    }
    for (const job of this.elementProjectionJobs.values()) {
      for (const eventId of job.sourceEventIds) {
        if (!eventIds.has(eventId)) throw new Error(`Element projection ${job.id} references unknown event ${eventId}`);
      }
      for (const elementId of job.elementIds) {
        if (!elementIds.has(elementId)) throw new Error(`Element projection ${job.id} references unknown element ${elementId}`);
      }
    }
    const graphNodeIds = new Set<string>();
    for (const node of this.graphNodes) {
      if (graphNodeIds.has(node.id)) throw new Error(`Duplicate graph node ID in snapshot: ${node.id}`);
      graphNodeIds.add(node.id);
      for (const eventId of node.sourceEventIds) {
        if (!eventIds.has(eventId)) throw new Error(`Graph node ${node.id} references unknown event ${eventId}`);
      }
      for (const fact of node.facts) for (const eventId of fact.sourceEventIds) {
        if (!eventIds.has(eventId)) throw new Error(`Graph fact ${fact.id} references unknown event ${eventId}`);
      }
    }
    const graphEdgeIds = new Set<string>();
    for (const edge of this.graphEdges) {
      if (graphEdgeIds.has(edge.id)) throw new Error(`Duplicate graph edge ID in snapshot: ${edge.id}`);
      graphEdgeIds.add(edge.id);
      if (!graphNodeIds.has(edge.fromNodeId) || !graphNodeIds.has(edge.toNodeId)) {
        throw new Error(`Graph edge ${edge.id} references an unknown node`);
      }
      for (const eventId of edge.sourceEventIds) {
        if (!eventIds.has(eventId)) throw new Error(`Graph edge ${edge.id} references unknown event ${eventId}`);
      }
    }
    for (const event of this.listAllEvents()) for (const nodeId of event.temporal.participantNodeIds ?? []) {
      if (!graphNodeIds.has(nodeId)) throw new Error(`Event ${event.id} references unknown graph node ${nodeId}`);
    }
    for (const job of this.graphProjectionJobs.values()) {
      for (const eventId of job.sourceEventIds) if (!eventIds.has(eventId)) {
        throw new Error(`Graph projection ${job.id} references unknown event ${eventId}`);
      }
      for (const nodeId of job.nodeIds) if (!graphNodeIds.has(nodeId)) {
        throw new Error(`Graph projection ${job.id} references unknown node ${nodeId}`);
      }
      for (const edgeId of job.edgeIds) if (!graphEdgeIds.has(edgeId)) {
        throw new Error(`Graph projection ${job.id} references unknown edge ${edgeId}`);
      }
    }
  }
}
