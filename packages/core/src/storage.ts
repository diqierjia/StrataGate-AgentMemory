import { BLOCK_DECAY_LAMBDA } from './blocks.js';
import { normalizeStandardEventType } from './events.js';
import type { ElementCard, EventCard, ExternalMemoryImportJob, GraphEdge, GraphNode, MemoryBlock, RawMessage } from './types.js';

export const STRATAGATE_STORAGE_SCHEMA_VERSION = 12;
export const KNOWLEDGE_GRAPH_PROJECTOR_VERSION = 1;
export const DERIVATION_MAX_ATTEMPTS = 3;

/**
 * Thread-id prefixes of synthetic provenance blocks whose turns are not real
 * conversation turns (external memory imports, agent-recorded facts). Events
 * citing these blocks fall back to the current turn for their lifecycle clock.
 */
export const SYNTHETIC_SOURCE_THREAD_PREFIXES = ['external-import:', 'agent-memory:'] as const;

export function isSyntheticSourceThreadId(threadId: string | undefined | null): boolean {
  return !!threadId && SYNTHETIC_SOURCE_THREAD_PREFIXES.some((prefix) => threadId.startsWith(prefix));
}

export type ExtractionJobStatus = 'running' | 'succeeded' | 'skipped' | 'failed';

export interface ExtractionJob {
  blockId: string;
  status: ExtractionJobStatus;
  attempts: number;
  lastError: string | null;
  nextRetryAt: string | null;
  updatedAt: string;
}

export type BlockSummaryJobStatus = 'pending' | 'running' | 'succeeded' | 'failed';

export interface BlockSummaryJob {
  blockId: string;
  status: BlockSummaryJobStatus;
  attempts: number;
  lastError: string | null;
  nextRetryAt: string | null;
  updatedAt: string;
}

export type SuccessfulModelResponseKind = 'summarizer' | 'extractor' | 'projector' | 'graphProjector' | 'externalMemoryExtractor' | 'externalMemoryDecider' | 'profileMaintenance';

export interface SuccessfulModelResponse {
  id: string;
  kind: SuccessfulModelResponseKind;
  response: string;
  createdAt: string;
}

export type ElementProjectionJobStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface ElementProjectionJob {
  id: string;
  sourceEventIds: string[];
  status: ElementProjectionJobStatus;
  attempts: number;
  elementIds: string[];
  reason: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export type GraphProjectionJobStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface GraphProjectionJob {
  id: string;
  sourceEventIds: string[];
  projectorVersion: number;
  status: GraphProjectionJobStatus;
  attempts: number;
  priority: number;
  nodeIds: string[];
  edgeIds: string[];
  reason: string | null;
  lastError: string | null;
  nextRetryAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UsageReceipt {
  id: string;
  eventIds: string[];
  elementIds: string[];
  audit?: UsageAudit;
  createdAt: string;
}

export interface UsageAudit {
  sessionId?: string;
  turn?: number;
  batchId?: string;
  evidenceRefs?: string[];
  citations?: MemoryCitation[];
  verdict?: 'sufficient' | 'partial' | 'wrong';
  fit?: string;
  missing?: string;
  nextStrategy?: string;
}

export interface MemoryCitation {
  kind: 'event' | 'graph' | 'block';
  id: string;
  title: string;
  evidenceRef: string;
  batchId: string;
  detailKind: 'eventId' | 'nodeId' | 'elementId' | 'blockId';
  level?: number;
  expanded?: boolean;
}

export interface IngestionReceipt {
  id: string;
  createdAt: string;
}

export interface StrataGateSnapshot {
  schemaVersion: typeof STRATAGATE_STORAGE_SCHEMA_VERSION;
  currentTurn: number;
  blockTurnSize: number;
  blockDecayLambda: number;
  openTail: RawMessage[];
  blocks: MemoryBlock[];
  summaryJobs: BlockSummaryJob[];
  events: EventCard[];
  agentEvents: EventCard[];
  graphNodes: GraphNode[];
  graphEdges: GraphEdge[];
  graphProjectionJobs: GraphProjectionJob[];
  elements: ElementCard[];
  extractionJobs: ExtractionJob[];
  elementProjectionJobs: ElementProjectionJob[];
  usageReceipts: UsageReceipt[];
  ingestionReceipts: IngestionReceipt[];
  externalMemoryImportJobs: ExternalMemoryImportJob[];
  successfulModelResponses?: SuccessfulModelResponse[];
}

export interface LoadedStrataGateState {
  snapshot: StrataGateSnapshot;
  revision: number;
}

export interface RawMessageIndexDelta {
  upsert: Array<Pick<RawMessage, 'id' | 'content'>>;
  deleteIds: string[];
}

export interface StorageAdapter {
  load(namespace: string): Promise<LoadedStrataGateState | null>;
  save(
    namespace: string,
    snapshot: StrataGateSnapshot,
    expectedRevision: number,
    rawMessageIndexDelta?: RawMessageIndexDelta,
  ): Promise<number>;
  /**
   * Return a bounded set of raw-message ids for lexical candidate recall.
   * Implementations may return null when an index is unavailable; callers
   * must then use their exhaustive in-memory ranking path.
   */
  searchRawMessageIds?(
    namespace: string,
    tokens: readonly string[],
    limit: number,
    threadId?: string,
    includeUnthreaded?: boolean,
  ): string[] | null;
  close?(): Promise<void>;
}

export class StorageConflictError extends Error {
  constructor(
    readonly namespace: string,
    readonly expectedRevision: number,
    readonly actualRevision: number | null,
  ) {
    super(`Storage revision conflict for ${namespace}: expected ${expectedRevision}, found ${actualRevision ?? 'missing'}`);
    this.name = 'StorageConflictError';
  }
}

export function cloneSnapshot(snapshot: StrataGateSnapshot): StrataGateSnapshot {
  return structuredClone(snapshot);
}

type LegacyMemoryBlock = Omit<MemoryBlock, 'pointerAnchorBlockPosition' | 'lastLiftedBy'> & { pointerAnchorTurn: number };
type LegacySnapshotBase = Omit<StrataGateSnapshot, 'schemaVersion' | 'blockDecayLambda' | 'blocks'> & {
  blocks: LegacyMemoryBlock[];
};

interface LegacySnapshotV1 extends Omit<LegacySnapshotBase, 'elements' | 'elementProjectionJobs' | 'usageReceipts' | 'ingestionReceipts'> {
  schemaVersion: 1;
  usageReceipts: Array<Omit<UsageReceipt, 'elementIds'>>;
}

interface LegacySnapshotV2 extends Omit<LegacySnapshotBase, 'ingestionReceipts'> {
  schemaVersion: 2;
}

interface LegacySnapshotV3 extends Omit<LegacySnapshotBase, 'usageReceipts'> {
  schemaVersion: 3;
  usageReceipts: Array<Omit<UsageReceipt, 'audit'>>;
}

interface LegacySnapshotV4 extends LegacySnapshotBase {
  schemaVersion: 4;
}

interface LegacySnapshotV5 extends LegacySnapshotBase {
  schemaVersion: 5;
}

interface LegacySnapshotV6 extends Omit<StrataGateSnapshot, 'schemaVersion' | 'blocks'> {
  schemaVersion: 6;
  blocks: Array<Omit<MemoryBlock, 'lastLiftedBy'>>;
}

interface LegacySnapshotV7 extends Omit<StrataGateSnapshot, 'schemaVersion' | 'graphNodes' | 'graphEdges' | 'graphProjectionJobs'> {
  schemaVersion: 7;
}

interface LegacySnapshotV8 extends Omit<StrataGateSnapshot, 'schemaVersion' | 'summaryJobs' | 'blocks' | 'extractionJobs'> {
  schemaVersion: 8;
  blocks: Array<Omit<MemoryBlock, 'processingStatus'>>;
  extractionJobs: Array<Omit<ExtractionJob, 'nextRetryAt'>>;
}

interface LegacySnapshotV9 extends Omit<StrataGateSnapshot, 'schemaVersion' | 'externalMemoryImportJobs'> {
  schemaVersion: 9;
}

interface LegacySnapshotV10 extends Omit<StrataGateSnapshot, 'schemaVersion' | 'agentEvents'> {
  schemaVersion: 10;
}

interface LegacySnapshotV11 extends Omit<StrataGateSnapshot, 'schemaVersion' | 'agentEvents'> {
  schemaVersion: 11;
}

function readyLegacyBlocks<T extends Omit<MemoryBlock, 'processingStatus'>>(blocks: readonly T[]): MemoryBlock[] {
  return blocks.map((block) => ({ ...structuredClone(block), processingStatus: 'ready' }));
}

function legacyExtractionJobs<T extends Omit<ExtractionJob, 'nextRetryAt'>>(jobs: readonly T[]): ExtractionJob[] {
  return jobs.map((job) => ({ ...structuredClone(job), nextRetryAt: null }));
}

function emptyGraph(): { graphNodes: GraphNode[]; graphEdges: GraphEdge[]; graphProjectionJobs: GraphProjectionJob[] } {
  return { graphNodes: [], graphEdges: [], graphProjectionJobs: [] };
}

function migrateLegacyBlocks(blocks: readonly LegacyMemoryBlock[]): MemoryBlock[] {
  return blocks.map((block) => {
    const { pointerAnchorTurn, ...current } = block;
    const position = blocks.filter((candidate) =>
      candidate.threadId === block.threadId && candidate.endTurn <= pointerAnchorTurn).length;
    return { ...current, processingStatus: 'ready', pointerAnchorBlockPosition: Math.max(1, position), lastLiftedBy: null };
  });
}

export function normalizeSnapshot(value: unknown): StrataGateSnapshot {
  if (!value || typeof value !== 'object') throw new TypeError('Invalid StrataGate snapshot: expected an object');
  const schemaVersion = (value as { schemaVersion?: unknown }).schemaVersion;
  let snapshot: StrataGateSnapshot;
  if (schemaVersion === 1) {
    const legacy = value as LegacySnapshotV1;
    snapshot = {
      ...structuredClone(legacy),
      schemaVersion: STRATAGATE_STORAGE_SCHEMA_VERSION,
      blockDecayLambda: BLOCK_DECAY_LAMBDA,
      blocks: migrateLegacyBlocks(legacy.blocks),
      summaryJobs: [],
      extractionJobs: legacyExtractionJobs(legacy.extractionJobs),
      elements: [],
      elementProjectionJobs: [],
      usageReceipts: Array.isArray(legacy.usageReceipts)
        ? legacy.usageReceipts.map((receipt) => ({ ...receipt, elementIds: [] }))
        : [],
      ingestionReceipts: [],
      ...emptyGraph(),
    };
  } else if (schemaVersion === 2) {
    const legacy = value as LegacySnapshotV2;
    snapshot = {
      ...structuredClone(legacy),
      schemaVersion: STRATAGATE_STORAGE_SCHEMA_VERSION,
      blockDecayLambda: BLOCK_DECAY_LAMBDA,
      blocks: migrateLegacyBlocks(legacy.blocks),
      summaryJobs: [],
      extractionJobs: legacyExtractionJobs(legacy.extractionJobs),
      ingestionReceipts: [],
      ...emptyGraph(),
    };
  } else if (schemaVersion === 3) {
    const legacy = value as LegacySnapshotV3;
    snapshot = {
      ...structuredClone(legacy),
      schemaVersion: STRATAGATE_STORAGE_SCHEMA_VERSION,
      blockDecayLambda: BLOCK_DECAY_LAMBDA,
      blocks: migrateLegacyBlocks(legacy.blocks),
      summaryJobs: [],
      extractionJobs: legacyExtractionJobs(legacy.extractionJobs),
      ...emptyGraph(),
    };
  } else if (schemaVersion === 4) {
    const legacy = value as LegacySnapshotV4;
    snapshot = {
      ...structuredClone(legacy),
      schemaVersion: STRATAGATE_STORAGE_SCHEMA_VERSION,
      blockDecayLambda: BLOCK_DECAY_LAMBDA,
      blocks: migrateLegacyBlocks(legacy.blocks),
      summaryJobs: [],
      extractionJobs: legacyExtractionJobs(legacy.extractionJobs),
      ...emptyGraph(),
    };
  } else if (schemaVersion === 5) {
    const legacy = value as LegacySnapshotV5;
    snapshot = {
      ...structuredClone(legacy),
      schemaVersion: STRATAGATE_STORAGE_SCHEMA_VERSION,
      blockDecayLambda: BLOCK_DECAY_LAMBDA,
      blocks: migrateLegacyBlocks(legacy.blocks),
      summaryJobs: [],
      extractionJobs: legacyExtractionJobs(legacy.extractionJobs),
      ...emptyGraph(),
    };
  } else if (schemaVersion === 6) {
    const legacy = value as LegacySnapshotV6;
    snapshot = {
      ...structuredClone(legacy),
      schemaVersion: STRATAGATE_STORAGE_SCHEMA_VERSION,
      blocks: readyLegacyBlocks(legacy.blocks.map((block) => ({ ...structuredClone(block), lastLiftedBy: null }))),
      summaryJobs: [],
      extractionJobs: legacyExtractionJobs(legacy.extractionJobs),
      ...emptyGraph(),
    };
  } else if (schemaVersion === 7) {
    const legacy = value as LegacySnapshotV7;
    snapshot = {
      ...structuredClone(legacy),
      schemaVersion: STRATAGATE_STORAGE_SCHEMA_VERSION,
      blocks: readyLegacyBlocks(legacy.blocks),
      summaryJobs: [],
      extractionJobs: legacyExtractionJobs(legacy.extractionJobs),
      ...emptyGraph(),
    };
  } else if (schemaVersion === 8) {
    const legacy = value as LegacySnapshotV8;
    snapshot = {
      ...structuredClone(legacy),
      schemaVersion: STRATAGATE_STORAGE_SCHEMA_VERSION,
      blocks: readyLegacyBlocks(legacy.blocks),
      summaryJobs: [],
      extractionJobs: legacyExtractionJobs(legacy.extractionJobs),
      externalMemoryImportJobs: [],
    };
  } else if (schemaVersion === 9) {
    const legacy = value as LegacySnapshotV9;
    snapshot = {
      ...structuredClone(legacy),
      schemaVersion: STRATAGATE_STORAGE_SCHEMA_VERSION,
      externalMemoryImportJobs: [],
    };
  } else if (schemaVersion === 10) {
    snapshot = {
      ...structuredClone(value as LegacySnapshotV10),
      schemaVersion: STRATAGATE_STORAGE_SCHEMA_VERSION,
      agentEvents: [],
    };
  } else if (schemaVersion === 11) {
    snapshot = {
      ...structuredClone(value as LegacySnapshotV11),
      schemaVersion: STRATAGATE_STORAGE_SCHEMA_VERSION,
      agentEvents: [],
    };
  } else if (schemaVersion === 11) {
    snapshot = { ...structuredClone(value as StrataGateSnapshot), schemaVersion: STRATAGATE_STORAGE_SCHEMA_VERSION };
  } else if (schemaVersion === STRATAGATE_STORAGE_SCHEMA_VERSION) {
    snapshot = structuredClone(value) as StrataGateSnapshot;
  } else {
    throw new TypeError(`Unsupported StrataGate snapshot schema: ${String(schemaVersion)}`);
  }
  if (!Number.isSafeInteger(snapshot.currentTurn) || (snapshot.currentTurn ?? -1) < 0) {
    throw new TypeError('Invalid StrataGate snapshot: currentTurn must be a non-negative integer');
  }
  if (!Number.isSafeInteger(snapshot.blockTurnSize) || (snapshot.blockTurnSize ?? 0) < 1) {
    throw new TypeError('Invalid StrataGate snapshot: blockTurnSize must be a positive integer');
  }
  if (!Number.isFinite(snapshot.blockDecayLambda) || snapshot.blockDecayLambda < 0) {
    throw new TypeError('Invalid StrataGate snapshot: blockDecayLambda must be a non-negative finite number');
  }
  if (!Array.isArray(snapshot.externalMemoryImportJobs)) snapshot.externalMemoryImportJobs = [];
  for (const key of ['openTail', 'blocks', 'summaryJobs', 'events', 'agentEvents', 'graphNodes', 'graphEdges', 'graphProjectionJobs', 'elements', 'extractionJobs', 'elementProjectionJobs', 'usageReceipts', 'ingestionReceipts', 'externalMemoryImportJobs'] as const) {
    if (!Array.isArray(snapshot[key])) throw new TypeError(`Invalid StrataGate snapshot: ${key} must be an array`);
  }
  if (!Array.isArray(snapshot.successfulModelResponses)) snapshot.successfulModelResponses = [];
  for (const job of snapshot.graphProjectionJobs) {
    // Schema 10 stored Graph jobs as JSON. Treat legacy failures without an
    // explicit retry time as terminal so upgrading cannot restart a cost loop.
    if (job.nextRetryAt === undefined) job.nextRetryAt = null;
  }
  const sourceBlockMap = new Map(snapshot.blocks.map((block) => [block.id, block]));
  for (const event of [...snapshot.events, ...snapshot.agentEvents]) {
    event.temporal = { ...event.temporal, eventType: normalizeStandardEventType(event.temporal.eventType) };
    if (event.formedTurn === undefined) {
      const sourceBlock = event.sourceBlockId !== undefined ? sourceBlockMap.get(event.sourceBlockId) : undefined;
      const reliableSource = sourceBlock && !isSyntheticSourceThreadId(sourceBlock.threadId)
        && Number.isSafeInteger(sourceBlock.endTurn) && sourceBlock.endTurn >= 0;
      if (reliableSource) event.formedTurn = sourceBlock.endTurn;
    } else if (!Number.isSafeInteger(event.formedTurn) || event.formedTurn < 0) {
      throw new TypeError('Invalid StrataGate snapshot: Event formedTurn must be a non-negative integer');
    }
  }
  for (const block of snapshot.blocks) {
    if (block.processingStatus !== 'pending' && block.processingStatus !== 'ready') {
      throw new TypeError('Invalid StrataGate snapshot: Block processingStatus must be pending or ready');
    }
    if (block.processingStatus === 'ready'
      && (!block.l0Title || !block.l1Summary || !Array.isArray(block.l0Tags) || !Array.isArray(block.l2Keypoints)
        || typeof block.shouldExtract !== 'boolean')) {
      throw new TypeError('Invalid StrataGate snapshot: ready Block must contain validated L0-L2 layers');
    }
    if (!Number.isSafeInteger(block.pointerAnchorBlockPosition) || block.pointerAnchorBlockPosition < 1) {
      throw new TypeError('Invalid StrataGate snapshot: pointerAnchorBlockPosition must be a positive integer');
    }
    if (block.lastLiftedBy !== null && block.lastLiftedBy !== 'user' && block.lastLiftedBy !== 'agent') {
      throw new TypeError('Invalid StrataGate snapshot: lastLiftedBy must be user, agent, or null');
    }
  }
  if (snapshot.successfulModelResponses.length > 5) {
    snapshot.successfulModelResponses = snapshot.successfulModelResponses.slice(-5);
  }
  return snapshot;
}

export function assertValidSnapshot(value: unknown): asserts value is StrataGateSnapshot {
  normalizeSnapshot(value);
}
