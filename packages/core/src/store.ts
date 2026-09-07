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
import { applyGraphProjection } from './graph.js';
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
  cloneSnapshot,
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
  BlockLevel,
  BlockLiftSource,
  BlockSummarizer,
  ElementCard,
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
  GraphNode,
  GraphNodeSearchResult,
  GraphProjectionContext,
  GraphProjectionResult,
  GraphProjector,
  MemoryBlock,
  RawMessage,
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

function renderBlock(block: MemoryBlock, level: BlockLevel): string {
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
const DERIVATION_MAX_ATTEMPTS = 3;
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
  private readonly elements: ElementCard[] = [];
  private readonly graphNodes: GraphNode[] = [];
  private readonly graphEdges: GraphEdge[] = [];
  private readonly extractionJobs = new Map<string, ExtractionJob>();
  private readonly summaryJobs = new Map<string, BlockSummaryJob>();
  private readonly elementProjectionJobs = new Map<string, ElementProjectionJob>();
  private readonly graphProjectionJobs = new Map<string, GraphProjectionJob>();
  private readonly usageReceipts = new Map<string, UsageReceipt>();
  private readonly successfulModelResponses: SuccessfulModelResponse[] = [];
  private readonly ingestionReceipts = new Map<string, IngestionReceipt>();
  private readonly externalMemoryImportJobs = new Map<string, ExternalMemoryImportJob>();
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
    const exact = this.events.find((event) =>
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
    const exact = this.events.find((event) =>
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
    const exact = this.events.find((event) =>
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
              const existing = this.events.find((event) => event.id === id);
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
      for (const event of this.events) {
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
          const replacement = this.events.find((candidate) =>
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
      return {
        sourceBlockId: id,
        removedEventIds: [...importedEventIds],
        restoredEventIds: [...restoredEventIds],
      };
    });
  }

  async searchEvents(query: string, options: SearchOptions = {}): Promise<EventSearchResult[]> {
    const limit = Math.max(1, Math.min(20, options.limit ?? 6));
    const participants = (options.participants ?? []).map(normalizeSearchText).filter(Boolean);
    const eventType = normalizeSearchText(options.eventType ?? '');
    const from = options.happenedFrom ? Date.parse(options.happenedFrom) : Number.NEGATIVE_INFINITY;
    const to = options.happenedTo ? Date.parse(options.happenedTo) : Number.POSITIVE_INFINITY;
    const hasTimeFilter = Boolean(options.happenedFrom || options.happenedTo);
    const candidates = this.events.filter((event) => event.status === 'active' || event.status === 'superseded');
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
    const ranked = rrfRank(rankings).slice(0, limit).map(({ item: event, score }) => ({ event, score }));
    if (ranked.length > 0 && options.trackRetrieval !== false) {
      const now = toUtc8Iso(this.now());
      await this.commitMutation(() => {
        for (const { event } of ranked) event.weight.lastRetrievedAt = now;
      });
    }
    return ranked;
  }

  async claimNextElementProjection(): Promise<ElementProjectionContext | null> {
    return this.commitMutation(() => {
      const job = [...this.elementProjectionJobs.values()]
        .find((candidate) => candidate.status === 'pending' || candidate.status === 'failed');
      if (!job) return null;
      const events = job.sourceEventIds.flatMap((id) => this.events.find((event) => event.id === id) ?? []);
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
        events: this.events,
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

  async claimNextGraphProjection(): Promise<GraphProjectionContext | null> {
    return this.commitMutation(() => {
      const job = [...this.graphProjectionJobs.values()]
        .filter((candidate) => candidate.status === 'pending' || candidate.status === 'failed')
        .sort((left, right) => right.priority - left.priority || left.createdAt.localeCompare(right.createdAt))[0];
      if (!job) return null;
      const events = job.sourceEventIds.flatMap((id) => this.events.find((event) => event.id === id) ?? []);
      if (events.length === 0) throw new Error(`Graph projection ${job.id} has no available source events`);
      job.status = 'running';
      job.attempts += 1;
      job.lastError = null;
      job.updatedAt = toUtc8Iso(this.now());
      const eventText = normalizeSearchText(events.map((event) => [
        event.title, event.summary, event.tags.join(' '), (event.temporal.participants ?? []).join(' '),
      ].join(' ')).join(' '));
      const relevantNodes = this.graphNodes.filter((node) => [node.name, ...node.aliases]
        .some((name) => eventText.includes(normalizeSearchText(name))))
        .concat([...this.graphNodes].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).slice(0, 24));
      const existingNodes = [...new Map(relevantNodes.map((node) => [node.id, node])).values()].slice(0, 80);
      const nodeIds = new Set(existingNodes.map(({ id }) => id));
      return {
        jobId: job.id,
        projectorVersion: job.projectorVersion,
        events: structuredClone(events),
        existingNodes: structuredClone(existingNodes),
        existingEdges: structuredClone(this.graphEdges.filter(({ fromNodeId, toNodeId }) => nodeIds.has(fromNodeId) && nodeIds.has(toNodeId)).slice(-120)),
      };
    });
  }

  async completeGraphProjection(jobId: string, result: GraphProjectionResult): Promise<{ nodeIds: string[]; edgeIds: string[] }> {
    return this.commitMutation(() => {
      const job = this.requireGraphProjectionJob(jobId);
      if (job.status === 'completed') return { nodeIds: job.nodeIds, edgeIds: job.edgeIds };
      if (job.status !== 'running') throw new Error(`Graph projection ${job.id} is ${job.status}, not running`);
      const touched = applyGraphProjection({
        nodes: this.graphNodes,
        edges: this.graphEdges,
        events: this.events,
        result,
        allowedEventIds: new Set(job.sourceEventIds),
        now: toUtc8Iso(this.now()),
        idFactory: this.graphIdFactory,
      });
      job.status = 'completed';
      job.nodeIds = touched.nodeIds;
      job.edgeIds = touched.edgeIds;
      job.reason = typeof result.reason === 'string' ? result.reason.trim().replace(/\s+/g, ' ').slice(0, 500) || null : null;
      job.lastError = null;
      job.updatedAt = toUtc8Iso(this.now());
      return touched;
    });
  }

  async failGraphProjection(jobId: string, error: unknown): Promise<void> {
    await this.commitMutation(() => {
      const job = this.requireGraphProjectionJob(jobId);
      if (job.status === 'completed') return;
      job.status = 'failed';
      job.lastError = errorMessage(error);
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

  searchRawMemory(query: string, limit = 6): RawSearchHit[] {
    const tokens = searchTokens(query);
    if (tokens.length === 0) return [];
    const hits: RawSearchHit[] = [];
    for (const block of this.blocks) {
      for (const [index, message] of block.l5Raw.entries()) {
        const messageTokens = new Set(searchTokens(message.content));
        if (!tokens.some((token) => messageTokens.has(token))) continue;
        hits.push({
          blockId: block.id,
          turnRange: [block.startTurn, block.endTurn],
          message,
          nearby: block.l5Raw.slice(Math.max(0, index - 1), index + 2),
        });
        if (hits.length >= limit) return hits;
      }
    }
    return hits;
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
        const event = this.events.find((candidate) => candidate.id === id);
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
    return block;
  }

  private addEventInMemory(input: EventCardInput): EventCard {
    const sourceBlock = this.blocks.find((block) => block.id === input.sourceBlockId);
    if (!sourceBlock) throw new Error(`Unknown source block: ${input.sourceBlockId}`);
    const validIds = new Set(sourceBlock.l5Raw.map((message) => message.id));
    const requestedRefs = [...new Set(input.sourceMessageIds.filter((id) => validIds.has(id)))];
    const sourceMessageIds = requestedRefs.length > 0 ? requestedRefs : sourceBlock.l5Raw.map((message) => message.id);
    const now = toUtc8Iso(this.now());
    const criticality = input.criticality ?? 'routine';
    const event: EventCard = {
      id: input.id ?? this.idFactory('evt'),
      title: input.title.trim(),
      summary: input.summary.trim(),
      narrative: input.narrative?.trim() || input.summary.trim(),
      tags: [...new Set(input.tags ?? [])].slice(0, 12),
      quotes: [...new Set(input.quotes ?? [])].slice(0, 12),
      sourceMessageIds,
      sourceBlockId: sourceBlock.id,
      temporal: {
        ...(input.temporal ? { ...input.temporal } : { mentionedAt: now }),
        eventType: normalizeStandardEventType(input.temporal?.eventType),
      },
      scope: input.scope ?? 'user',
      criticality,
      confidence: Math.max(0, Math.min(1, input.confidence ?? 1)),
      status: 'active',
      supersededBy: null,
      weight: {
        mentionCount: 1,
        lastAdoptedTurn: this.currentTurn,
        lastRetrievedAt: null,
        pinned: false,
        floorWeight: criticalityFloor(criticality),
        forcedCap: null,
      },
      createdAt: now,
      updatedAt: now,
    };
    if (this.events.some((candidate) => candidate.id === event.id)) throw new Error(`Duplicate event ID: ${event.id}`);
    this.events.push(event);

    for (const supersededId of event.temporal.supersedesEventIds ?? []) {
      const old = this.events.find((candidate) => candidate.id === supersededId && candidate.id !== event.id);
      if (!old) continue;
      old.status = 'superseded';
      old.supersededBy = event.id;
      old.weight.forcedCap = 0.1;
      old.updatedAt = now;
    }
    return event;
  }

  private requireEvent(id: string): EventCard {
    const event = this.events.find((candidate) => candidate.id === id);
    if (!event) throw new Error(`Unknown event: ${id}`);
    return event;
  }

  private requireElementProjectionJob(id: string): ElementProjectionJob {
    const job = this.elementProjectionJobs.get(id);
    if (!job) throw new Error(`Unknown element projection: ${id}`);
    return job;
  }

  async searchGraphNodes(query: string, limit = 8): Promise<GraphNodeSearchResult[]> {
    const candidates = this.graphNodes.filter((node) => node.status === 'active' || node.status === 'disputed');
    const queryTokens = [...new Set(searchTokens(query))];
    const fieldValues = (node: GraphNode): Array<readonly [string, string]> => [
      ['name', node.name],
      ['aliases', node.aliases.join(' ')],
      ['tags', (node.tags ?? []).join(' ')],
      ['type', node.type],
      ['currentState', node.currentState],
      ['facts', node.facts.map((fact) => `${fact.key} ${Array.isArray(fact.value) ? fact.value.join(' ') : fact.value}`).join(' ')],
      ['relations', this.graphEdges.filter((edge) => edge.fromNodeId === node.id || edge.toNodeId === node.id).map(({ relation }) => relation).join(' ')],
    ];
    const ranked = bm25Rank(candidates, query, (node) => weightedSearchTokens([
      [node.name, 6], [node.aliases.join(' '), 5], [(node.tags ?? []).join(' '), 5], [node.type, 2], [node.currentState, 4],
      [node.facts.map((fact) => `${fact.key} ${Array.isArray(fact.value) ? fact.value.join(' ') : fact.value}`).join(' '), 4],
      [this.graphEdges.filter((edge) => edge.fromNodeId === node.id || edge.toNodeId === node.id).map(({ relation }) => relation).join(' '), 3],
    ])).filter(({ item }) => {
      const fields = fieldValues(item);
      const matches = fields.filter(([, value]) => {
        const haystack = new Set(searchTokens(value));
        return queryTokens.some((token) => haystack.has(token));
      }).map(([field]) => field);
      // Relation text is useful context, but relation-only hits are commonly
      // adjacent/noise nodes. Keep type-only hits so valid project/tool/etc.
      // searches continue to work, while requiring a descriptive field for
      // ordinary lexical queries.
      if (!matches.some((field) => field !== 'relations')) return false;
      return matches.some((field) => field !== 'relations');
    }).slice(0, Math.max(1, Math.min(20, limit)));
    if (searchTokens(query).length > 0 && ranked.length === 0) return [];
    return ranked.map(({ item: node, score }) => {
      const matchedFields = fieldValues(node).filter(([, value]) => {
        const haystack = new Set(searchTokens(value));
        return queryTokens.some((token) => haystack.has(token));
      }).map(([field]) => field);
      return {
        node,
        score,
        matchedFields,
        matchReason: `Lexical match in ${matchedFields.join(', ') || 'indexed fields'}; score is ranking-only.`,
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
    const ids = [...new Set(sourceEventIds.filter((id) => this.events.some((event) => event.id === id)
      && !completed.has(id) && !queued.has(id)))];
    if (ids.length === 0) return null;
    const now = toUtc8Iso(this.now());
    const job: GraphProjectionJob = {
      id: this.graphIdFactory('gproj'), sourceEventIds: ids,
      projectorVersion: KNOWLEDGE_GRAPH_PROJECTOR_VERSION,
      status: 'pending', attempts: 0, priority, nodeIds: [], edgeIds: [],
      reason: null, lastError: null, createdAt: now, updatedAt: now,
    };
    this.graphProjectionJobs.set(job.id, job);
    return job;
  }

  private queueMissingGraphProjections(): void {
    const candidates = [...this.events]
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
    const ids = [...new Set(sourceEventIds.filter((id) => this.events.some((event) => event.id === id)))];
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
      result = await this.extractor({
        previous: threadBlocks.slice(0, targetIndex).reverse().find((block) => block.l2Keypoints !== undefined) ?? null,
        target,
        next,
        timeline: this.events.map((event) => ({ id: event.id, title: event.title, temporal: event.temporal })),
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
    try {
      const result = await mutation();
      await this.persist();
      return result;
    } catch (error) {
      this.restoreSnapshot(before);
      this.revision = beforeRevision;
      throw error;
    } finally {
      release();
    }
  }

  private async persist(): Promise<void> {
    if (!this.storage || !this.namespace) return;
    this.revision = await this.storage.save(this.namespace, this.exportSnapshot(), this.revision);
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
    this.summaryJobs.clear();
    for (const job of copy.summaryJobs) this.summaryJobs.set(job.blockId, job);
    this.events.splice(0, this.events.length, ...copy.events);
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
    for (const event of this.events) {
      if (eventIds.has(event.id)) throw new Error(`Duplicate event ID in snapshot: ${event.id}`);
      eventIds.add(event.id);
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
        this.events.find((event) => event.id === eventId)?.sourceMessageIds ?? []));
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
    for (const event of this.events) for (const nodeId of event.temporal.participantNodeIds ?? []) {
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
