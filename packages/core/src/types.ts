export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

export interface ToolTrace {
  name: string;
  arguments?: Record<string, unknown>;
  result?: unknown;
}

export interface RawMessage {
  id: string;
  role: MessageRole;
  content: string;
  createdAt: string;
  threadId?: string;
  toolCalls?: ToolTrace[];
}

export type BlockLevel = 0 | 1 | 2 | 3 | 4 | 5;
export type BlockLiftSource = 'user' | 'agent';
export type BlockProcessingStatus = 'pending' | 'ready';

export interface BlockLayers {
  l0Title: string;
  l0Tags: string[];
  l1Summary: string;
  l2Keypoints: string[];
  l3Condensed: string;
  l4Readable: string;
  l5Raw: RawMessage[];
}

export interface MemoryBlock extends Omit<BlockLayers, 'l0Title' | 'l0Tags' | 'l1Summary' | 'l2Keypoints'> {
  id: string;
  threadId?: string;
  sequence: number;
  startTurn: number;
  endTurn: number;
  createdAt: string;
  /** Model-generated layers are absent until a validated summarizer result is persisted. */
  l0Title?: string;
  l0Tags?: string[];
  l1Summary?: string;
  l2Keypoints?: string[];
  shouldExtract?: boolean;
  processingStatus: BlockProcessingStatus;
  pointerCurrentLevel: BlockLevel;
  pointerAnchorLevel: BlockLevel;
  pointerAnchorBlockPosition: number;
  lastLiftedAt: string | null;
  lastLiftedBy: BlockLiftSource | null;
}

export interface BlockSummary {
  l0Title: string;
  l0Tags: string[];
  l1Summary: string;
  l2Keypoints: string[];
  shouldExtract: boolean;
}

export type BlockSummarizer = (messages: readonly RawMessage[]) => Promise<BlockSummary>;

export type MemoryScope = 'user' | 'project' | 'session';
export type MemoryCriticality = 'routine' | 'preference' | 'identity' | 'safety';
export type MemoryStatus = 'active' | 'superseded' | 'forgotten' | 'archived';

export interface EventTemporal {
  mentionedAt?: string;
  happenedStart?: string;
  happenedEnd?: string;
  originalText?: string;
  precision?: 'instant' | 'day' | 'month' | 'year' | 'range' | 'unknown';
  basis?: 'explicit' | 'relative' | 'inferred' | 'unknown';
  status?: 'occurred' | 'planned' | 'cancelled' | 'ongoing' | 'unknown';
  participants?: string[];
  /** Stable references into the projected knowledge graph. */
  participantNodeIds?: string[];
  eventType?: string;
  threadId?: string;
  sameEventId?: string;
  beforeEventIds?: string[];
  afterEventIds?: string[];
  supersedesEventIds?: string[];
  conflictsWithEventIds?: string[];
  relatedEventIds?: string[];
}

/** Stable taxonomy used by extraction, filtering, projection, and statistics. */
export type StandardEventType =
  | 'decision'
  | 'release'
  | 'task_completed'
  | 'plan'
  | 'change'
  | 'cancellation'
  | 'incident'
  | 'meeting'
  | 'collaboration'
  | 'migration'
  | 'other';

export interface MemoryWeight {
  mentionCount: number;
  lastAdoptedTurn: number;
  lastRetrievedAt: string | null;
  pinned: boolean;
  floorWeight: number;
  forcedCap: number | null;
}

export interface EventCardInput {
  id?: string;
  title: string;
  summary: string;
  narrative?: string;
  tags?: string[];
  quotes?: string[];
  sourceMessageIds: string[];
  sourceBlockId: string;
  temporal?: EventTemporal;
  scope?: MemoryScope;
  criticality?: MemoryCriticality;
  confidence?: number;
}

export interface EventCard extends Omit<EventCardInput, 'id' | 'sourceBlockId'> {
  id: string;
  /** Conversation turn where this Event entered its long-term-memory lifecycle. */
  formedTurn?: number;
  narrative: string;
  tags: string[];
  quotes: string[];
  /**
   * Provenance block. Always present for conversation-derived and imported
   * Events; agent-recorded Events may omit it when their provenance cites
   * real open-tail conversation messages directly.
   */
  sourceBlockId?: string;
  temporal: EventTemporal;
  scope: MemoryScope;
  criticality: MemoryCriticality;
  confidence: number;
  status: MemoryStatus;
  supersededBy: string | null;
  weight: MemoryWeight;
  createdAt: string;
  updatedAt: string;
}

export interface ExtractionContext {
  previous: MemoryBlock | null;
  target: MemoryBlock;
  next: MemoryBlock | null;
  timeline: Array<Pick<EventCard, 'id' | 'title' | 'temporal'>>;
}

export interface ExtractionResult {
  shouldExtract: boolean;
  reason: string;
  events: EventCardInput[];
}

export type EventExtractor = (context: ExtractionContext) => Promise<ExtractionResult>;

/** Memory kinds emitted by the v2 external AI export format. */
export type ExternalMemoryKind = 'instruction' | 'preference' | 'fact' | 'event';

/** A candidate memory produced by an external AI memory export. */
export type ExternalMemoryCandidate = Omit<EventCardInput, 'id' | 'sourceMessageIds' | 'sourceBlockId'> & {
  memoryKind?: ExternalMemoryKind;
  category?: 'instruction' | 'identity' | 'career' | 'project' | 'preference';
};

export type ExternalMemoryAction = 'ADD' | 'MERGE' | 'SUPERSEDE' | 'CONFLICT' | 'IGNORE';

export interface ExternalMemoryExtractionContext {
  text: string;
  importedAt: string;
}

export interface ExternalMemoryExtractionResult {
  candidates: ExternalMemoryCandidate[];
  reason?: string;
}

export interface ExternalMemoryMatch {
  event: EventCard;
  score: number;
}

export interface ExternalMemoryDecisionContext {
  candidate: ExternalMemoryCandidate;
  matches: ExternalMemoryMatch[];
}

export interface ExternalMemoryDecision {
  action: ExternalMemoryAction;
  /** Existing event IDs this decision refers to. */
  existingEventIds?: string[];
  /** Optional consolidated candidate used by MERGE. */
  mergedCandidate?: ExternalMemoryCandidate;
  reason?: string;
  /** Calibrated adjudication confidence. Missing confidence requires review. */
  confidence?: number;
}

export type ExternalMemoryExtractor = (
  context: ExternalMemoryExtractionContext,
) => Promise<ExternalMemoryExtractionResult>;

export type ExternalMemoryDecider = (
  context: ExternalMemoryDecisionContext,
) => Promise<ExternalMemoryDecision>;

export interface ExternalMemoryImportOptions {
  text: string;
  /** Optional when `text` is the JSON format produced by the built-in prompt. */
  extractor?: ExternalMemoryExtractor;
  decider: ExternalMemoryDecider;
  topK?: number;
  importedAt?: string;
}

export interface ExternalMemoryImportDecision {
  candidate: ExternalMemoryCandidate;
  action: ExternalMemoryAction;
  existingEventIds: string[];
  createdEventId?: string;
  reason?: string;
  confidence?: number;
}

export interface ExternalMemoryPreviewDecision extends ExternalMemoryImportDecision {
  matches: ExternalMemoryMatch[];
  requiresConfirmation: boolean;
  mergedCandidate?: ExternalMemoryCandidate;
}

export interface ExternalMemoryImportPreview {
  importedAt: string;
  baseRevision: number;
  decisions: ExternalMemoryPreviewDecision[];
}

export type ExternalMemoryImportJobStatus =
  | 'extracting'
  | 'processing'
  | 'awaiting_confirmation'
  | 'ready'
  | 'failed'
  | 'committed'
  | 'undone';

/** Crash-safe progress for one external-memory import analysis. */
export interface ExternalMemoryImportJob {
  id: string;
  text: string;
  importedAt: string;
  status: ExternalMemoryImportJobStatus;
  candidates: ExternalMemoryCandidate[];
  decisions: ExternalMemoryPreviewDecision[];
  processedCount: number;
  totalCount: number;
  recoveredFromInvalidJson: boolean;
  parseError: string | null;
  lastError: string | null;
  sourceBlockId: string | null;
  importedCount: number;
  createdAt: string;
  updatedAt: string;
}

/** Read-only work prepared before a model call; it holds no storage revision. */
export interface ExternalMemoryImportWorkItem {
  jobId: string;
  index: number;
  candidate: ExternalMemoryCandidate;
  matches: ExternalMemoryMatch[];
  forceConfirmation: boolean;
  deterministicDecision?: ExternalMemoryDecision;
}

export interface ExternalMemoryCommitOptions {
  text: string;
  importedAt: string;
  baseRevision: number;
  decisions: ExternalMemoryPreviewDecision[];
  candidates: ExternalMemoryCandidate[];
}

export interface ExternalMemoryImportResult {
  sourceBlockId: string;
  decisions: ExternalMemoryImportDecision[];
  addedEvents: EventCard[];
  changedEventIds: string[];
}

export interface ExternalMemoryUndoResult {
  sourceBlockId: string;
  removedEventIds: string[];
  restoredEventIds: string[];
}

/** Taxonomy the agent picks from when recording a memory through memory_remember. */
export type AgentMemoryCategory = 'preference' | 'decision' | 'correction' | 'fact';

/** How the pre-write gate reached its verdict. */
/**
 * Input for agent-recorded events: provenance may cite real conversation
 * messages directly (no source block) — `sourceMessageIds` must then exist in
 * the store's open tail or blocks at validation time.
 */
export type AgentEventCardInput = Omit<EventCardInput, 'sourceBlockId'> & {
  sourceBlockId?: string;
  formedTurn?: number;
};

export type AgentEventGatePath =
  | 'exact-duplicate'
  | 'near-duplicate'
  | 'clear-new'
  | 'decider'
  | 'heuristic-conflict'
  | 'decider-error';

/** Outcome of the gate; agent events are ordinary Events once recorded. */
export type AgentEventGateAction =
  | 'ADDED'
  | 'REINFORCED'
  | 'MERGED'
  | 'SUPERSEDED'
  | 'CONFLICT_MARKED'
  | 'IGNORED';

export interface AgentEventRecordOptions {
  content: string;
  category?: AgentMemoryCategory;
  /**
   * Optional synchronous adjudicator reusing the external-memory decision
   * contract. Omitted → deterministic/heuristic policy only.
   */
  decider?: ExternalMemoryDecider;
  /** Top-K search width for the pre-write lookup. Default 5, clamped 1..20. */
  topK?: number;
  /** Recording session id, stored as temporal.threadId for dashboard grouping. */
  threadId?: string;
  importedAt?: string;
}

export interface AgentEventRecordResult {
  action: AgentEventGateAction;
  gate: AgentEventGatePath;
  recorded: boolean;
  /** Created event (ADDED/MERGED/SUPERSEDED/CONFLICT_MARKED). */
  eventId?: string;
  /** Existing event reinforced instead of writing (REINFORCED). */
  reinforcedEventId?: string;
  existingEventIds: string[];
  matchedEventIds: string[];
  /** Gate confidence; not the stored event confidence. */
  confidence?: number;
  downgradedFrom?: 'MERGE' | 'SUPERSEDE';
  reason?: string;
  sourceBlockId?: string;
  /** Real conversation messages cited as provenance (open tail or blocks). */
  sourceMessageIds?: string[];
  /** memoryWeightAt(event, currentTurn) at write time. */
  weight?: number;
}

export type MemoryElementType = 'person' | 'project' | 'organization' | 'tool' | 'place';
export type ElementFactMode = 'state' | 'set' | 'relation';
export type ElementFactStatus = 'active' | 'superseded' | 'disputed';
export type ElementProjectionOperation = 'set_state' | 'add_set_item' | 'set_relation';

export interface ElementFact {
  id: string;
  key: string;
  mode: ElementFactMode;
  value: string | string[];
  validFrom?: string;
  validTo?: string;
  sourceEventIds: string[];
  confidence?: number;
  status: ElementFactStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ElementCard {
  id: string;
  name: string;
  type: MemoryElementType;
  aliases: string[];
  currentState: string;
  facts: ElementFact[];
  sourceEventIds: string[];
  sourceMessageIds: string[];
  weight: MemoryWeight;
  createdAt: string;
  updatedAt: string;
}

export interface ElementProjectionChange {
  element: {
    name: string;
    type: MemoryElementType;
    aliases?: string[];
  };
  operation: ElementProjectionOperation;
  key: string;
  mode: ElementFactMode;
  value: string | string[];
  validFrom?: string;
  validTo?: string;
  sourceEventIds: string[];
  confidence?: number;
}

export interface ElementProjectionResult {
  reason: string;
  changes: ElementProjectionChange[];
}

export interface ElementProjectionContext {
  jobId: string;
  events: EventCard[];
  existingElements: ElementCard[];
}

export type ElementProjector = (context: ElementProjectionContext) => Promise<ElementProjectionResult>;

export type GraphNodeType = 'person' | 'project' | 'organization' | 'tool' | 'place';
export type GraphRecordStatus = 'active' | 'superseded' | 'disputed' | 'archived';

export interface GraphFact {
  id: string;
  key: string;
  value: string | string[];
  status: GraphRecordStatus;
  validFrom?: string;
  validTo?: string;
  confidence: number;
  sourceEventIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface GraphMetadataProvenanceEntry {
  value: string;
  sourceEventIds: string[];
}

export interface GraphNodeMetadataProvenance {
  name?: string[];
  aliases?: GraphMetadataProvenanceEntry[];
  tags?: GraphMetadataProvenanceEntry[];
}

export interface GraphNode {
  id: string;
  name: string;
  type: GraphNodeType;
  aliases: string[];
  /** Optional semantic roles used for discovery and dynamic graph presentation. */
  tags?: string[];
  /** Optional field-level Event provenance; absent on legacy nodes. */
  metadataProvenance?: GraphNodeMetadataProvenance;
  currentState: string;
  facts: GraphFact[];
  status: GraphRecordStatus;
  confidence: number;
  sourceEventIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface GraphEdge {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  relation: string;
  status: GraphRecordStatus;
  validFrom?: string;
  validTo?: string;
  confidence: number;
  sourceEventIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface GraphNodeProjection {
  ref: string;
  name: string;
  type: GraphNodeType;
  aliases?: string[];
  /** Semantic roles are additive metadata and never replace the stable node type. */
  tags?: string[];
  /** New projectors should cite the exact Events for each metadata value. */
  metadataProvenance?: GraphNodeMetadataProvenance;
  state?: string;
  facts?: Array<{ key: string; value: string | string[]; sourceEventIds: string[] }>;
  status?: GraphRecordStatus;
  validFrom?: string;
  validTo?: string;
  confidence?: number;
  sourceEventIds: string[];
}

export interface GraphEdgeProjection {
  fromRef: string;
  toRef: string;
  relation: string;
  status?: GraphRecordStatus;
  validFrom?: string;
  validTo?: string;
  confidence?: number;
  sourceEventIds: string[];
}

export interface GraphProjectionResult {
  reason: string;
  nodes: GraphNodeProjection[];
  edges: GraphEdgeProjection[];
}

export interface GraphProjectionContext {
  jobId: string;
  projectorVersion: number;
  events: EventCard[];
  existingNodes: GraphNode[];
  existingEdges: GraphEdge[];
}

export type GraphProjector = (context: GraphProjectionContext) => Promise<GraphProjectionResult>;

export interface SearchOptions {
  limit?: number;
  temporalIntent?: boolean | 'first' | 'latest';
  participants?: string[];
  eventType?: string;
  happenedFrom?: string;
  happenedTo?: string;
  /**
   * Relative weight of the agent-recorded pool when its ranking fuses with
   * the conversation-derived pool (1 = equal footing, 0 = never surfaced).
   */
  agentMemoryWeight?: number;
  /** Disable retrieval bookkeeping for read-only previews. */
  trackRetrieval?: boolean;
}

export interface EventSearchResult {
  event: EventCard;
  /** BM25/RRF ordering score; never a probability, confidence, or accuracy. */
  score: number;
}

export interface ElementSearchOptions {
  limit?: number;
  name?: string;
  type?: MemoryElementType;
}

export interface ElementSearchResult {
  id: string;
  elementId: string;
  name: string;
  type: MemoryElementType;
  fact: ElementFact;
  /** BM25/RRF ordering score; never a probability, confidence, or accuracy. */
  score: number;
}

export interface GraphNodeSearchResult {
  node: GraphNode;
  /** BM25/RRF ordering score; never a probability, confidence, or accuracy. */
  score: number;
  /** Fields that contained a lexical query-term match (for explainability). */
  matchedFields?: string[];
  /** Human-readable explanation of why this node passed the lexical filter. */
  matchReason?: string;
  /** Whether the query meaningfully matched current evidence, historical evidence, or both. */
  matchType?: 'current' | 'historical' | 'both';
  /** Query-matched effective records. The node itself still carries the complete effective current state. */
  currentFacts?: GraphFact[];
  historicalFacts?: GraphFact[];
  currentEdges?: GraphEdge[];
  historicalEdges?: GraphEdge[];
  /** Bounded Event evidence selected for this specific result. */
  provenanceEventIds?: string[];
  /** Legacy metadata was trusted but could not be fully expanded within the evidence budget. */
  metadataEvidenceStatus?: 'not_expanded';
  timeline?: GraphTimelineEvent[];
}

export interface GraphTimelineEvent {
  id: string;
  title: string;
  summary: string;
  status: MemoryStatus;
  time?: string;
}

export interface RawSearchHit {
  blockId: string;
  turnRange: [number, number];
  message: RawMessage;
  nearby: RawMessage[];
}

export interface RawSearchOptions {
  /** Limit raw-message candidates to one conversation thread. */
  threadId?: string;
  /** Preserve the legacy session behavior that includes namespace-level messages. */
  includeUnthreaded?: boolean;
}

export interface AppendTurnResult {
  sealedBlock: MemoryBlock | null;
  readyBlocks: MemoryBlock[];
  extractedEvents: EventCard[];
  projectedElements: ElementCard[];
}
