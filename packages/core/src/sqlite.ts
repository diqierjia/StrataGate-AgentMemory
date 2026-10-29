import { DatabaseSync } from 'node:sqlite';
import { snapshotWriteSet, type RecordCollection } from './storage-write-set.js';
import { resolve } from 'node:path';
import { BACKGROUND_WORK_INDEX_VERSION, backgroundWorkTimes, type BackgroundWorkTimes } from './background-work.js';
import { TOPIC_LEASE_MS, type MemoryTopicState } from './topics.js';
import {
  STRATAGATE_STORAGE_SCHEMA_VERSION,
  DERIVATION_LEASE_MS,
  StorageConflictError,
  assertValidSnapshot,
  cloneSnapshot,
  normalizeSnapshot,
  type ElementProjectionJob,
  type DerivationLeaseGuard,
  type ExtractionJob,
  type BlockSummaryJob,
  type GraphProjectionJob,
  type GraphRuntimePolicy,
  type IngestionReceipt,
  type LoadedStrataGateState,
  type LoadedDerivationLeases,
  type RawMessageIndexDelta,
  type SuccessfulModelResponse,
  type StorageAdapter,
  type StrataGateSnapshot,
  type UsageAudit,
  type UsageReceipt,
  type AdminReadModel,
  type AdminBlockPage,
  type AdminReadEntry,
  type RecordMutation,
  type RecordMutationResult,
} from './storage.js';
import type {
  BlockLevel,
  ElementCard,
  ElementFact,
  ElementFactMode,
  ElementFactStatus,
  EventCard,
  ExternalMemoryImportJob,
  GraphEdge,
  GraphNode,
  MemoryBlock,
  MemoryCriticality,
  MemoryScope,
  MemoryStatus,
  MemoryElementType,
  RawMessage,
  ToolTrace,
} from './types.js';
import { nowUtc8 } from './time.js';
import { normalizeEventMetadata, normalizeEventTemporal, normalizeStandardEventType } from './events.js';
import { emptyProfile, isProfileField, PROFILE_FIELDS, PROFILE_MAINTAINABLE_FIELDS, PROFILE_PROTECTED_SHORT_FIELDS, profileMaintenanceDue, validateProfile,
  type PersistentProfile, type ProfileChange, type ProfileChangeSource, type ProfileField } from './profile.js';
import { searchTokens } from './search.js';

export interface SqliteStorageOptions {
  filename: string;
  readonly?: boolean;
  timeoutMs?: number;
  graphPolicy?: (namespace: string) => GraphRuntimePolicy;
}

export interface NamespaceRevision {
  namespace: string;
  revision: number;
}

interface SpaceRow {
  schema_version: number;
  revision: number;
  current_turn: number;
  block_turn_size: number;
  block_decay_lambda: number;
  graph_enabled?: number;
  graph_epoch?: number;
  graph_approved_event_ids_json?: string;
}

interface MessageRow {
  id: string;
  block_id: string | null;
  thread_id: string | null;
  position: number;
  role: RawMessage['role'];
  content: string;
  created_at: string;
  tool_calls_json: string | null;
}

interface BlockRow {
  id: string;
  thread_id: string | null;
  sequence: number;
  start_turn: number;
  end_turn: number;
  created_at: string;
  should_extract: number;
  l0_title: string;
  l0_tags_json: string;
  l1_summary: string;
  l2_keypoints_json: string;
  l3_condensed: string;
  l4_readable: string;
  pointer_current_level: number;
  surface_current_level?: number;
  pointer_anchor_level: number;
  pointer_anchor_block_position: number;
  last_lifted_at: string | null;
  last_lifted_by: 'user' | 'agent' | null;
  processing_status: MemoryBlock['processingStatus'];
}

interface EventRow {
  id: string;
  position: number;
  title: string;
  summary: string;
  narrative: string;
  tags_json: string;
  quotes_json: string;
  source_block_id: string | null;
  formed_turn: number | null;
  temporal_json: string;
  scope: MemoryScope;
  criticality: MemoryCriticality;
  confidence: number;
  status: MemoryStatus;
  superseded_by: string | null;
  mention_count: number;
  last_adopted_turn: number;
  last_retrieved_at: string | null;
  pinned: number;
  floor_weight: number;
  forced_cap: number | null;
  created_at: string;
  updated_at: string;
}

interface EventSourceRow {
  event_id: string;
  message_id: string;
  position: number;
}

interface ExtractionJobRow {
  block_id: string;
  status: ExtractionJob['status'];
  attempts: number;
  last_error: string | null;
  next_retry_at: string | null;
  updated_at: string;
  lease_until?: string | null;
}

interface ExternalMemoryImportJobRow {
  id: string;
  payload_json: string;
}

interface BlockSummaryJobRow {
  block_id: string;
  status: BlockSummaryJob['status'];
  attempts: number;
  last_error: string | null;
  next_retry_at: string | null;
  updated_at: string;
  lease_until?: string | null;
}

interface SuccessfulModelResponseRow {
  id: string;
  kind: SuccessfulModelResponse['kind'];
  response: string;
  created_at: string;
}

interface UsageReceiptRow {
  receipt_id: string;
  event_ids_json: string;
  element_ids_json: string;
  audit_json: string;
  created_at: string;
}

interface IngestionReceiptRow {
  receipt_id: string;
  created_at: string;
}

interface ElementRow {
  id: string;
  position: number;
  name: string;
  type: MemoryElementType;
  aliases_json: string;
  current_state: string;
  mention_count: number;
  last_adopted_turn: number;
  last_retrieved_at: string | null;
  pinned: number;
  floor_weight: number;
  forced_cap: number | null;
  created_at: string;
  updated_at: string;
}

interface ElementFactRow {
  id: string;
  element_id: string;
  position: number;
  key: string;
  mode: ElementFactMode;
  value_json: string;
  valid_from: string | null;
  valid_to: string | null;
  confidence: number | null;
  status: ElementFactStatus;
  created_at: string;
  updated_at: string;
}

interface ElementSourceRow {
  element_id: string;
  event_id: string;
  position: number;
}

interface ElementFactSourceRow {
  fact_id: string;
  event_id: string;
  position: number;
}

interface ElementProjectionJobRow {
  id: string;
  source_event_ids_json: string;
  status: ElementProjectionJob['status'];
  attempts: number;
  element_ids_json: string;
  reason: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

interface GraphStateRow {
  nodes_json: string;
  edges_json: string;
  jobs_json: string;
}

interface RawSearchIndexRow {
  message_id: string;
  tokens: string;
  fts_rowid: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS persistent_profile (
  field TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS persistent_profile_changes (
  id INTEGER PRIMARY KEY,
  field TEXT NOT NULL,
  old_value TEXT NOT NULL,
  new_value TEXT NOT NULL,
  source TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  source_message_id TEXT
) STRICT;
CREATE TABLE IF NOT EXISTS persistent_profile_maintenance (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_succeeded_at TEXT NOT NULL,
  input_json TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS persistent_profile_maintenance_baseline (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  started_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS persistent_profile_maintenance_failures (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  input_json TEXT NOT NULL,
  failure_count INTEGER NOT NULL,
  next_retry_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS memory_spaces (
  namespace TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  current_turn INTEGER NOT NULL,
  block_turn_size INTEGER NOT NULL,
  block_decay_lambda REAL NOT NULL,
  graph_enabled INTEGER NOT NULL DEFAULT 0 CHECK (graph_enabled IN (0, 1)),
  graph_epoch INTEGER NOT NULL DEFAULT 0,
  graph_approved_event_ids_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS blocks (
  namespace TEXT NOT NULL,
  id TEXT NOT NULL,
  thread_id TEXT,
  sequence INTEGER NOT NULL,
  start_turn INTEGER NOT NULL,
  end_turn INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  should_extract INTEGER NOT NULL,
  l0_title TEXT NOT NULL,
  l0_tags_json TEXT NOT NULL,
  l1_summary TEXT NOT NULL,
  l2_keypoints_json TEXT NOT NULL,
  l3_condensed TEXT NOT NULL,
  l4_readable TEXT NOT NULL,
  pointer_current_level INTEGER NOT NULL,
  surface_current_level INTEGER NOT NULL DEFAULT 5,
  pointer_anchor_level INTEGER NOT NULL,
  pointer_anchor_block_position INTEGER NOT NULL,
  last_lifted_at TEXT,
  last_lifted_by TEXT CHECK (last_lifted_by IS NULL OR last_lifted_by IN ('user', 'agent')),
  processing_status TEXT NOT NULL CHECK (processing_status IN ('pending', 'ready')),
  PRIMARY KEY (namespace, id),
  UNIQUE (namespace, sequence),
  FOREIGN KEY (namespace) REFERENCES memory_spaces(namespace) ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS messages (
  namespace TEXT NOT NULL,
  id TEXT NOT NULL,
  block_id TEXT,
  thread_id TEXT,
  position INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  tool_calls_json TEXT,
  PRIMARY KEY (namespace, id),
  FOREIGN KEY (namespace) REFERENCES memory_spaces(namespace) ON DELETE CASCADE,
  FOREIGN KEY (namespace, block_id) REFERENCES blocks(namespace, id) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS messages_container_idx ON messages(namespace, block_id, position);

-- Optional metadata shared by both Event pools. No historical backfill.
CREATE TABLE IF NOT EXISTS event_merge_sources (
  namespace TEXT NOT NULL,
  event_id TEXT NOT NULL,
  source_ids_json TEXT NOT NULL,
  PRIMARY KEY (namespace, event_id),
  FOREIGN KEY (namespace) REFERENCES memory_spaces(namespace) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS event_metadata (
  namespace TEXT NOT NULL,
  event_id TEXT NOT NULL,
  catalog_hints_json TEXT,
  extractor_version INTEGER,
  PRIMARY KEY (namespace, event_id),
  FOREIGN KEY (namespace) REFERENCES memory_spaces(namespace) ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS events (
  namespace TEXT NOT NULL,
  id TEXT NOT NULL,
  position INTEGER NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  narrative TEXT NOT NULL,
  tags_json TEXT NOT NULL,
  quotes_json TEXT NOT NULL,
  source_block_id TEXT NOT NULL,
  formed_turn INTEGER,
  temporal_json TEXT NOT NULL,
  scope TEXT NOT NULL,
  criticality TEXT NOT NULL,
  confidence REAL NOT NULL,
  status TEXT NOT NULL,
  superseded_by TEXT,
  mention_count INTEGER NOT NULL,
  last_adopted_turn INTEGER NOT NULL,
  last_retrieved_at TEXT,
  pinned INTEGER NOT NULL,
  floor_weight REAL NOT NULL,
  forced_cap REAL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (namespace, id),
  FOREIGN KEY (namespace, source_block_id) REFERENCES blocks(namespace, id)
) STRICT;

CREATE TABLE IF NOT EXISTS event_sources (
  namespace TEXT NOT NULL,
  event_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (namespace, event_id, message_id),
  FOREIGN KEY (namespace, event_id) REFERENCES events(namespace, id) ON DELETE CASCADE,
  FOREIGN KEY (namespace, message_id) REFERENCES messages(namespace, id)
) STRICT;

-- Agent-recorded memories live in isolated tables that mirror the Event model.
-- They cite the same provenance blocks but never join the passive events table.
-- source_block_id is nullable: agent events may cite real open-tail conversation
-- messages directly, in which case provenance is message-level only.
CREATE TABLE IF NOT EXISTS agent_events (
  namespace TEXT NOT NULL,
  id TEXT NOT NULL,
  position INTEGER NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  narrative TEXT NOT NULL,
  tags_json TEXT NOT NULL,
  quotes_json TEXT NOT NULL,
  source_block_id TEXT,
  formed_turn INTEGER,
  temporal_json TEXT NOT NULL,
  scope TEXT NOT NULL,
  criticality TEXT NOT NULL,
  confidence REAL NOT NULL,
  status TEXT NOT NULL,
  superseded_by TEXT,
  mention_count INTEGER NOT NULL,
  last_adopted_turn INTEGER NOT NULL,
  last_retrieved_at TEXT,
  pinned INTEGER NOT NULL,
  floor_weight REAL NOT NULL,
  forced_cap REAL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (namespace, id),
  FOREIGN KEY (namespace, source_block_id) REFERENCES blocks(namespace, id)
) STRICT;

CREATE TABLE IF NOT EXISTS agent_event_sources (
  namespace TEXT NOT NULL,
  event_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (namespace, event_id, message_id),
  FOREIGN KEY (namespace, event_id) REFERENCES agent_events(namespace, id) ON DELETE CASCADE,
  FOREIGN KEY (namespace, message_id) REFERENCES messages(namespace, id)
) STRICT;

CREATE TABLE IF NOT EXISTS elements (
  namespace TEXT NOT NULL,
  id TEXT NOT NULL,
  position INTEGER NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  aliases_json TEXT NOT NULL,
  current_state TEXT NOT NULL,
  mention_count INTEGER NOT NULL,
  last_adopted_turn INTEGER NOT NULL,
  last_retrieved_at TEXT,
  pinned INTEGER NOT NULL,
  floor_weight REAL NOT NULL,
  forced_cap REAL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (namespace, id),
  FOREIGN KEY (namespace) REFERENCES memory_spaces(namespace) ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS element_sources (
  namespace TEXT NOT NULL,
  element_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (namespace, element_id, event_id),
  FOREIGN KEY (namespace, element_id) REFERENCES elements(namespace, id) ON DELETE CASCADE
) STRICT;
-- element_sources.event_id and element_fact_sources.event_id deliberately carry
-- no FOREIGN KEY: provenance may cite the passive events table or the isolated
-- agent_events table, and SQLite cannot retarget one constraint across both.
-- Integrity is enforced by StrataGate.validateReferences on every snapshot load.

CREATE TABLE IF NOT EXISTS element_facts (
  namespace TEXT NOT NULL,
  id TEXT NOT NULL,
  element_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  key TEXT NOT NULL,
  mode TEXT NOT NULL,
  value_json TEXT NOT NULL,
  valid_from TEXT,
  valid_to TEXT,
  confidence REAL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (namespace, id),
  FOREIGN KEY (namespace, element_id) REFERENCES elements(namespace, id) ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS element_fact_sources (
  namespace TEXT NOT NULL,
  fact_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (namespace, fact_id, event_id),
  FOREIGN KEY (namespace, fact_id) REFERENCES element_facts(namespace, id) ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS extraction_jobs (
  namespace TEXT NOT NULL,
  block_id TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  last_error TEXT,
  next_retry_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (namespace, block_id),
  FOREIGN KEY (namespace, block_id) REFERENCES blocks(namespace, id) ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS block_summary_jobs (
  namespace TEXT NOT NULL,
  block_id TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  last_error TEXT,
  next_retry_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (namespace, block_id),
  FOREIGN KEY (namespace, block_id) REFERENCES blocks(namespace, id) ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS model_response_history (
  namespace TEXT NOT NULL,
  id TEXT NOT NULL,
  kind TEXT NOT NULL,
  response TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (namespace, id),
  FOREIGN KEY (namespace) REFERENCES memory_spaces(namespace) ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS element_projection_jobs (
  namespace TEXT NOT NULL,
  id TEXT NOT NULL,
  source_event_ids_json TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  element_ids_json TEXT NOT NULL,
  reason TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (namespace, id),
  FOREIGN KEY (namespace) REFERENCES memory_spaces(namespace) ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS graph_state (
  namespace TEXT PRIMARY KEY,
  nodes_json TEXT NOT NULL DEFAULT '[]',
  edges_json TEXT NOT NULL DEFAULT '[]',
  jobs_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL,
  FOREIGN KEY (namespace) REFERENCES memory_spaces(namespace) ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS memory_topic_state (
  namespace TEXT PRIMARY KEY,
  state_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (namespace) REFERENCES memory_spaces(namespace) ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS usage_receipts (
  namespace TEXT NOT NULL,
  receipt_id TEXT NOT NULL,
  event_ids_json TEXT NOT NULL,
  element_ids_json TEXT NOT NULL,
  audit_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  PRIMARY KEY (namespace, receipt_id),
  FOREIGN KEY (namespace) REFERENCES memory_spaces(namespace) ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS ingestion_receipts (
  namespace TEXT NOT NULL,
  receipt_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (namespace, receipt_id),
  FOREIGN KEY (namespace) REFERENCES memory_spaces(namespace) ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS external_memory_import_jobs (
  namespace TEXT NOT NULL,
  id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (namespace, id),
  FOREIGN KEY (namespace) REFERENCES memory_spaces(namespace) ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS raw_message_fts_meta (
  namespace TEXT NOT NULL,
  message_id TEXT NOT NULL,
  tokens TEXT NOT NULL,
  fts_rowid INTEGER NOT NULL,
  PRIMARY KEY (namespace, message_id),
  FOREIGN KEY (namespace, message_id) REFERENCES messages(namespace, id) ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS raw_message_fts_state (
  namespace TEXT PRIMARY KEY,
  backfill_complete INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (namespace) REFERENCES memory_spaces(namespace) ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS stratagate_graph_policy_migrations (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  completed_at TEXT NOT NULL
) STRICT;
`;

const RAW_MESSAGE_FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS raw_message_fts USING fts5(
  namespace UNINDEXED,
  message_id UNINDEXED,
  tokens,
  tokenize = 'unicode61'
);
`;

const THREAD_INDEXES = `
CREATE INDEX IF NOT EXISTS messages_thread_idx ON messages(namespace, thread_id, position);
CREATE INDEX IF NOT EXISTS blocks_thread_idx ON blocks(namespace, thread_id, sequence);
`;

function parseJson<T>(value: string, label: string): T {
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    throw new Error(`Invalid JSON in SQLite column ${label}`, { cause: error });
  }
}

/** Shared row mapper for the passive `events` and isolated `agent_events` tables. */
function mapEventRows(rows: EventRow[], sourcesByEvent: Map<string, string[]>, table: 'events' | 'agent_events'): EventCard[] {
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    summary: row.summary,
    tags: parseJson<string[]>(row.tags_json, `${table}.tags_json`),
    quotes: parseJson<string[]>(row.quotes_json, `${table}.quotes_json`),
    sourceMessageIds: sourcesByEvent.get(row.id) ?? [],
    ...(row.source_block_id === null ? {} : { sourceBlockId: row.source_block_id }),
    ...(row.formed_turn === null ? {} : { formedTurn: row.formed_turn }),
    temporal: (() => {
      const temporal = normalizeEventTemporal(parseJson<unknown>(row.temporal_json, `${table}.temporal_json`));
      return { ...temporal, eventType: normalizeStandardEventType(temporal.eventType) };
    })(),
    scope: row.scope,
    criticality: row.criticality,
    status: row.status,
    supersededBy: row.superseded_by,
    weight: {
      mentionCount: row.mention_count,
      lastAdoptedTurn: row.last_adopted_turn,
      lastRetrievedAt: row.last_retrieved_at,
      pinned: Boolean(row.pinned),
      floorWeight: row.floor_weight,
      forcedCap: row.forced_cap,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

function nonEmptyNamespace(namespace: string): string {
  const normalized = namespace.trim();
  if (!normalized) throw new TypeError('Storage namespace must not be empty');
  return normalized;
}

function encodeRawSearchToken(token: string): string {
  return `t${Buffer.from(token, 'utf8').toString('hex')}`;
}

function encodedRawSearchTokens(content: string): string {
  return searchTokens(content).map(encodeRawSearchToken).join(' ');
}

export class SqliteStorage implements StorageAdapter {
  private readonly graphPolicy: ((namespace: string) => GraphRuntimePolicy) | undefined;
  private static readonly workListeners = new Map<string, Set<() => void>>();
  private readonly filename: string;
  readonly readonly: boolean;
  private readonly database: DatabaseSync;
  private rawSearchFtsAvailable = false;
  private closed = false;

  constructor(options: SqliteStorageOptions) {
    this.graphPolicy = options.graphPolicy;
    if (!options.filename.trim()) throw new TypeError('SQLite filename must not be empty');
    this.readonly = options.readonly ?? false;
    this.filename = options.filename === ':memory:' ? ':memory:' : resolve(options.filename);
    if (process.platform === 'win32') this.filename = this.filename.toLowerCase();
    this.database = new DatabaseSync(options.filename, {
      readOnly: this.readonly,
      timeout: Math.max(0, Math.floor(options.timeoutMs ?? 5_000)),
    });
    try {
      this.database.exec('PRAGMA foreign_keys = ON');
      if (!this.readonly) {
        this.database.exec('PRAGMA journal_mode = WAL');
        this.migrate();
        this.initializeBackgroundWorkIndex();
      } else {
        this.assertSchemaVersion();
      }
    } catch (error) {
      this.database.close();
      this.closed = true;
      throw error;
    }
  }

  async load(namespace: string): Promise<LoadedStrataGateState | null> {
    return this.readState(namespace);
  }

  readEventModel(namespace: string): AdminReadModel | null {
    this.assertOpen();
    const key = nonEmptyNamespace(namespace);
    this.database.exec('BEGIN');
    try {
      const head = this.database.prepare('SELECT schema_version FROM memory_spaces WHERE namespace = ?').get(key) as { schema_version: number } | undefined;
      const state = head?.schema_version === STRATAGATE_STORAGE_SCHEMA_VERSION ? this.readState(key, true) : null;
      this.database.exec('COMMIT');
      if (!state) return null;
      const { schemaVersion: storedSchemaVersion, ...model } = state.snapshot;
      return { ...model, storedSchemaVersion };
    } catch (error) {
      try { this.database.exec('ROLLBACK'); } catch { /* preserve read error */ }
      throw error;
    }
  }

  /** Dashboard read model: keep metadata for navigation and hydrate only the
   * displayed blocks and the provenance explicitly returned by its audit page.
   */
  readDashboardEntries(options: { namespace?: string; threadId?: string; offset?: number; limit: number },
    chooseThread: (model: AdminReadModel) => string | null): AdminReadEntry[] {
    this.assertOpen();
    this.database.exec('BEGIN');
    try {
      const entries: AdminReadEntry[] = [];
      const namespaces = this.listNamespaces();
      const selected = namespaces.includes(options.namespace ?? '') ? options.namespace : namespaces[0];
      for (const namespace of namespaces) {
        const legacy = this.database.prepare(`SELECT 1 FROM blocks WHERE namespace = ? AND (thread_id IS NULL OR trim(thread_id) = '')
          UNION ALL SELECT 1 FROM messages m LEFT JOIN blocks b ON b.namespace = m.namespace AND b.id = m.block_id
          WHERE m.namespace = ? AND (m.thread_id IS NULL OR trim(m.thread_id) = '' OR (m.block_id IS NOT NULL AND m.thread_id IS NOT b.thread_id)) LIMIT 1`).get(namespace, namespace);
        const head = this.database.prepare('SELECT schema_version FROM memory_spaces WHERE namespace = ?').get(namespace) as { schema_version: number };
        const projected = !legacy && head.schema_version === STRATAGATE_STORAGE_SCHEMA_VERSION;
        const state = this.readState(namespace, projected);
        if (!state) continue;
        const { schemaVersion: storedSchemaVersion, ...data } = state.snapshot;
        const model = { ...data, storedSchemaVersion };
        if (namespace === selected && projected) {
          const threadId = options.threadId?.trim() || chooseThread(model);
          const ids = threadId ? (this.database.prepare(`SELECT id FROM blocks WHERE namespace = ? AND thread_id = ?
            AND (EXISTS (SELECT 1 FROM messages WHERE namespace = blocks.namespace AND block_id = blocks.id)
              OR EXISTS (SELECT 1 FROM block_summary_jobs j WHERE j.namespace = blocks.namespace AND j.block_id = blocks.id
                AND j.status = 'failed' AND (j.attempts >= 3 OR j.next_retry_at IS NULL)))
            ORDER BY sequence LIMIT ? OFFSET ?`).all(namespace, threadId, options.limit, options.offset ?? 0) as Array<{ id: string }>).map(row => row.id) : [];
          this.hydrateReadBlocks(namespace, model, ids);
          const receipts = [...model.usageReceipts].reverse().slice(options.offset ?? 0, (options.offset ?? 0) + 100);
          const elementIds = new Set(receipts.flatMap(receipt => receipt.elementIds));
          const eventIds = new Set([...receipts.flatMap(receipt => receipt.eventIds),
            ...model.elements.filter(element => elementIds.has(element.id)).flatMap(element => element.sourceEventIds)]);
          const messageIds = model.events.filter(event => eventIds.has(event.id)).flatMap(event => event.sourceMessageIds);
          this.hydrateReadMessages(namespace, model, messageIds);
        }
        entries.push({ namespace, revision: state.revision, snapshot: model });
      }
      this.database.exec('COMMIT');
      return entries;
    } catch (error) {
      try { this.database.exec('ROLLBACK'); } catch { /* preserve read error */ }
      throw error;
    }
  }

  private hydrateReadMessages(namespace: string, model: AdminReadModel, ids: readonly string[]): void {
    if (!ids.length) return;
    const rows = this.database.prepare(`SELECT id, thread_id, role, content, created_at, tool_calls_json
      FROM messages WHERE namespace = ? AND id IN (SELECT value FROM json_each(?))`).all(namespace, JSON.stringify([...new Set(ids)])) as unknown as MessageRow[];
    const messages = new Map(rows.map(row => [row.id, { id: row.id, role: row.role, content: row.content, createdAt: row.created_at,
      ...(row.thread_id ? { threadId: row.thread_id } : {}),
      ...(row.tool_calls_json ? { toolCalls: parseJson<ToolTrace[]>(row.tool_calls_json, 'messages.tool_calls_json') } : {}) }]));
    model.openTail = model.openTail.map(message => messages.get(message.id) ?? message);
    for (const block of model.blocks) block.l5Raw = block.l5Raw.map(message => messages.get(message.id) ?? message);
  }

  private hydrateReadBlocks(namespace: string, model: AdminReadModel, ids: readonly string[]): void {
    if (!ids.length) return;
    const byId = new Map(model.blocks.map(block => [block.id, block]));
    for (const row of this.database.prepare('SELECT id, l3_condensed, l4_readable FROM blocks WHERE namespace = ? AND id IN (SELECT value FROM json_each(?))').all(namespace, JSON.stringify(ids)) as Array<{ id: string; l3_condensed: string; l4_readable: string }>) {
      const block = byId.get(row.id)!;
      block.l3Condensed = row.l3_condensed; block.l4Readable = row.l4_readable;
    }
    this.hydrateReadMessages(namespace, model, ids.flatMap(id => byId.get(id)?.l5Raw.map(message => message.id) ?? []));
  }

  /** A single read transaction keeps navigation, page and associations at the same revision.
   * Legacy mixed-thread records use the existing recovery path, never guessed SQL scopes.
   */
  readBlockPage(namespace: string, options: { threadId?: string; offset: number; limit: number },
    chooseThread: (model: AdminReadModel) => string | null): AdminBlockPage | null {
    this.assertOpen();
    const key = nonEmptyNamespace(namespace);
    if (!Number.isSafeInteger(options.offset) || options.offset < 0 || !Number.isSafeInteger(options.limit)
      || options.limit < 1 || options.limit > 200) throw new TypeError('Invalid block page');
    this.database.exec('BEGIN');
    try {
      const head = this.database.prepare('SELECT schema_version FROM memory_spaces WHERE namespace = ?').get(key) as { schema_version: number } | undefined;
      if (!head || head.schema_version !== STRATAGATE_STORAGE_SCHEMA_VERSION) { this.database.exec('COMMIT'); return null; }
      const legacy = this.database.prepare(`SELECT 1 FROM blocks WHERE namespace = ? AND (thread_id IS NULL OR trim(thread_id) = '')
        UNION ALL SELECT 1 FROM messages m LEFT JOIN blocks b ON b.namespace = m.namespace AND b.id = m.block_id
        WHERE m.namespace = ? AND (m.thread_id IS NULL OR trim(m.thread_id) = '' OR (m.block_id IS NOT NULL AND m.thread_id IS NOT b.thread_id)) LIMIT 1`).get(key, key);
      if (legacy) { this.database.exec('COMMIT'); return null; }
      const loaded = this.readState(key, true);
      if (!loaded) { this.database.exec('COMMIT'); return null; }
      const { schemaVersion: storedSchemaVersion, ...data } = loaded.snapshot;
      const model = { ...data, storedSchemaVersion };
      const threadId = options.threadId?.trim() || chooseThread(model);
      const blockIds = threadId ? (this.database.prepare(`SELECT id FROM blocks WHERE namespace = ? AND thread_id = ?
        AND (EXISTS (SELECT 1 FROM messages WHERE namespace = blocks.namespace AND block_id = blocks.id)
          OR EXISTS (SELECT 1 FROM block_summary_jobs j WHERE j.namespace = blocks.namespace AND j.block_id = blocks.id
            AND j.status = 'failed' AND (j.attempts >= ? OR j.next_retry_at IS NULL)))
        ORDER BY sequence LIMIT ? OFFSET ?`).all(key, threadId, 3, options.limit, options.offset) as Array<{ id: string }>).map(row => row.id) : [];
      const failedSummaries = new Set(model.summaryJobs.filter(job => job.status === 'failed' && (job.attempts >= 3 || job.nextRetryAt === null)).map(job => job.blockId));
      const total = threadId ? model.blocks.filter(block => block.threadId === threadId && (block.l5Raw.length || failedSummaries.has(block.id))).length : 0;
      const byId = new Map(model.blocks.map(block => [block.id, block]));
      for (const row of this.database.prepare(`SELECT * FROM blocks WHERE namespace = ? AND id IN (SELECT value FROM json_each(?))`).all(key, JSON.stringify(blockIds)) as unknown as BlockRow[]) {
        const block = byId.get(row.id)!;
        if (row.l0_title) {
          block.shouldExtract = Boolean(row.should_extract);
          block.l0Title = row.l0_title;
          block.l0Tags = parseJson<string[]>(row.l0_tags_json, 'blocks.l0_tags_json');
          block.l1Summary = row.l1_summary;
          block.l2Keypoints = parseJson<string[]>(row.l2_keypoints_json, 'blocks.l2_keypoints_json');
        }
        block.l3Condensed = row.l3_condensed; block.l4Readable = row.l4_readable;
        block.l5Raw = [];
      }
      for (const row of this.database.prepare(`SELECT id, block_id, thread_id, position, role, content, created_at, tool_calls_json
        FROM messages WHERE namespace = ? AND block_id IN (SELECT value FROM json_each(?)) ORDER BY block_id, position`).all(key, JSON.stringify(blockIds)) as unknown as MessageRow[]) {
        byId.get(row.block_id!)!.l5Raw.push({ id: row.id, role: row.role, content: row.content, createdAt: row.created_at,
          ...(row.thread_id ? { threadId: row.thread_id } : {}),
          ...(row.tool_calls_json ? { toolCalls: parseJson<ToolTrace[]>(row.tool_calls_json, 'messages.tool_calls_json') } : {}) });
      }
      this.database.exec('COMMIT');
      return { model, revision: loaded.revision, threadId, blockIds, total };
    } catch (error) {
      try { this.database.exec('ROLLBACK'); } catch { /* preserve read error */ }
      throw error;
    }
  }

  private readState(namespace: string, navigation = false): LoadedStrataGateState | null {
    this.assertOpen();
    const key = nonEmptyNamespace(namespace);
    const hasGraphEnabled = this.hasColumn('memory_spaces', 'graph_enabled');
    const space = this.database.prepare(`
      SELECT schema_version, revision, current_turn, block_turn_size, block_decay_lambda${hasGraphEnabled ? ', graph_enabled, graph_epoch' : ''}${this.hasColumn('memory_spaces', 'graph_approved_event_ids_json') ? ', graph_approved_event_ids_json' : ''}
      FROM memory_spaces WHERE namespace = ?
    `).get(key) as SpaceRow | undefined;
    if (!space) return null;
    if (space.schema_version !== STRATAGATE_STORAGE_SCHEMA_VERSION && !(this.readonly && [12, 13].includes(space.schema_version))) {
      throw new Error(`Unsupported stored StrataGate schema: ${space.schema_version}`);
    }

    const messageRows = navigation ? this.database.prepare(`
      WITH first_users AS (
        SELECT m.id, row_number() OVER (PARTITION BY m.thread_id ORDER BY b.sequence IS NULL, b.sequence, m.position) AS rank
        FROM messages m LEFT JOIN blocks b ON b.namespace = m.namespace AND b.id = m.block_id
        WHERE m.namespace = ? AND m.role = 'user' AND length(trim(m.content, char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279))) > 0
      ) SELECT id, block_id, thread_id, position, role, created_at,
        CASE WHEN id IN (SELECT id FROM first_users WHERE rank = 1) THEN content
          WHEN length(trim(content, char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279))) > 0 THEN '…' ELSE '' END AS content,
        NULL AS tool_calls_json FROM messages WHERE namespace = ? ORDER BY block_id, position
    `).all(key, key) as unknown as MessageRow[] : this.database.prepare(`
      SELECT id, block_id, thread_id, position, role, content, created_at, tool_calls_json
      FROM messages WHERE namespace = ? ORDER BY block_id, position
    `).all(key) as unknown as MessageRow[];
    const openTail: RawMessage[] = [];
    const messagesByBlock = new Map<string, RawMessage[]>();
    for (const row of messageRows) {
      const message: RawMessage = {
        id: row.id,
        role: row.role,
        content: row.content,
        createdAt: row.created_at,
        ...(row.thread_id ? { threadId: row.thread_id } : {}),
        ...(row.tool_calls_json ? { toolCalls: parseJson<ToolTrace[]>(row.tool_calls_json, 'messages.tool_calls_json') } : {}),
      };
      if (row.block_id === null) openTail.push(message);
      else {
        const messages = messagesByBlock.get(row.block_id) ?? [];
        messages.push(message);
        messagesByBlock.set(row.block_id, messages);
      }
    }

    const blockRows = this.database.prepare(navigation ? `
      SELECT id, thread_id, sequence, start_turn, end_turn, created_at, processing_status, should_extract,
        l0_title, l0_tags_json, l1_summary, l2_keypoints_json,
        '' AS l3_condensed, '' AS l4_readable, pointer_current_level, surface_current_level,
        pointer_anchor_level, pointer_anchor_block_position, last_lifted_at, last_lifted_by
      FROM blocks WHERE namespace = ? ORDER BY sequence` : `
      SELECT * FROM blocks WHERE namespace = ? ORDER BY sequence
    `).all(key) as unknown as BlockRow[];
    const blocks: MemoryBlock[] = blockRows.map((row) => ({
      id: row.id,
      ...(row.thread_id ? { threadId: row.thread_id } : {}),
      sequence: row.sequence,
      startTurn: row.start_turn,
      endTurn: row.end_turn,
      createdAt: row.created_at,
      processingStatus: row.processing_status,
      ...(row.l0_title ? {
        shouldExtract: Boolean(row.should_extract),
        l0Title: row.l0_title,
        l0Tags: parseJson<string[]>(row.l0_tags_json, 'blocks.l0_tags_json'),
        l1Summary: row.l1_summary,
        l2Keypoints: parseJson<string[]>(row.l2_keypoints_json, 'blocks.l2_keypoints_json'),
      } : {}),
      l3Condensed: row.l3_condensed,
      l4Readable: row.l4_readable,
      l5Raw: messagesByBlock.get(row.id) ?? [],
      pointerCurrentLevel: row.pointer_current_level as BlockLevel,
      surfaceCurrentLevel: (row.surface_current_level ?? row.pointer_current_level) as BlockLevel,
      pointerAnchorLevel: row.pointer_anchor_level as BlockLevel,
      pointerAnchorBlockPosition: row.pointer_anchor_block_position,
      lastLiftedAt: row.last_lifted_at,
      lastLiftedBy: row.last_lifted_by,
    }));

    const summaryJobs = (this.database.prepare(`
      SELECT *
      FROM block_summary_jobs WHERE namespace = ? ORDER BY block_id
    `).all(key) as unknown as BlockSummaryJobRow[]).map<BlockSummaryJob>((row) => ({
      blockId: row.block_id,
      status: row.status,
      attempts: row.attempts,
      lastError: row.last_error,
      nextRetryAt: row.next_retry_at,
      updatedAt: row.updated_at,
      ...(row.lease_until == null ? {} : { leaseUntil: row.lease_until }),
    }));

    const sourceRows = this.database.prepare(`
      SELECT event_id, message_id, position FROM event_sources
      WHERE namespace = ? ORDER BY event_id, position
    `).all(key) as unknown as EventSourceRow[];
    const sourcesByEvent = new Map<string, string[]>();
    for (const row of sourceRows) {
      const ids = sourcesByEvent.get(row.event_id) ?? [];
      ids.push(row.message_id);
      sourcesByEvent.set(row.event_id, ids);
    }

    const eventRows = this.database.prepare(`
      SELECT * FROM events WHERE namespace = ? ORDER BY position
    `).all(key) as unknown as EventRow[];
    const events: EventCard[] = mapEventRows(eventRows, sourcesByEvent, 'events');

    const agentSourceRows = this.database.prepare(`
      SELECT event_id, message_id, position FROM agent_event_sources
      WHERE namespace = ? ORDER BY event_id, position
    `).all(key) as unknown as EventSourceRow[];
    const agentSourcesByEvent = new Map<string, string[]>();
    for (const row of agentSourceRows) {
      const ids = agentSourcesByEvent.get(row.event_id) ?? [];
      ids.push(row.message_id);
      agentSourcesByEvent.set(row.event_id, ids);
    }

    const agentEventRows = this.database.prepare(`
      SELECT * FROM agent_events WHERE namespace = ? ORDER BY position
    `).all(key) as unknown as EventRow[];
    const agentEvents: EventCard[] = mapEventRows(agentEventRows, agentSourcesByEvent, 'agent_events');
    this.loadMergedSources(key, [...events, ...agentEvents]);
    // Read-only schema-12 databases may predate this additive optional table.
    const hasEventMetadata = this.database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'event_metadata'").get();
    if (hasEventMetadata) {
      const metadataRows = this.database.prepare('SELECT event_id, catalog_hints_json, extractor_version FROM event_metadata WHERE namespace = ?')
        .all(key) as Array<{ event_id: string; catalog_hints_json: string | null; extractor_version: number | null }>;
      const byId = new Map([...events, ...agentEvents].map((event) => [event.id, event]));
      for (const row of metadataRows) {
        const event = byId.get(row.event_id);
        if (event) Object.assign(event, normalizeEventMetadata({
          ...(row.catalog_hints_json === null ? {} : { catalogHints: parseJson<unknown>(row.catalog_hints_json, 'event_metadata.catalog_hints_json') }),
          extractorVersion: row.extractor_version,
        }));
      }
    }

    const elementSourceRows = this.database.prepare(`
      SELECT element_id, event_id, position FROM element_sources
      WHERE namespace = ? ORDER BY element_id, position
    `).all(key) as unknown as ElementSourceRow[];
    const sourcesByElement = new Map<string, string[]>();
    for (const row of elementSourceRows) {
      const ids = sourcesByElement.get(row.element_id) ?? [];
      ids.push(row.event_id);
      sourcesByElement.set(row.element_id, ids);
    }

    const elementFactSourceRows = this.database.prepare(`
      SELECT fact_id, event_id, position FROM element_fact_sources
      WHERE namespace = ? ORDER BY fact_id, position
    `).all(key) as unknown as ElementFactSourceRow[];
    const sourcesByFact = new Map<string, string[]>();
    for (const row of elementFactSourceRows) {
      const ids = sourcesByFact.get(row.fact_id) ?? [];
      ids.push(row.event_id);
      sourcesByFact.set(row.fact_id, ids);
    }

    const elementFactRows = this.database.prepare(`
      SELECT * FROM element_facts WHERE namespace = ? ORDER BY element_id, position
    `).all(key) as unknown as ElementFactRow[];
    const factsByElement = new Map<string, ElementFact[]>();
    for (const row of elementFactRows) {
      const facts = factsByElement.get(row.element_id) ?? [];
      facts.push({
        id: row.id,
        key: row.key,
        mode: row.mode,
        value: parseJson<string | string[]>(row.value_json, 'element_facts.value_json'),
        ...(row.valid_from ? { validFrom: row.valid_from } : {}),
        ...(row.valid_to ? { validTo: row.valid_to } : {}),
        sourceEventIds: sourcesByFact.get(row.id) ?? [],
        ...(row.confidence === null ? {} : { confidence: row.confidence }),
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      });
      factsByElement.set(row.element_id, facts);
    }

    const elementRows = this.database.prepare(`
      SELECT * FROM elements WHERE namespace = ? ORDER BY position
    `).all(key) as unknown as ElementRow[];
    const messagesByEvent = new Map(events.map((event) => [event.id, event.sourceMessageIds]));
    const elements: ElementCard[] = elementRows.map((row) => {
      const sourceEventIds = sourcesByElement.get(row.id) ?? [];
      return {
        id: row.id,
        name: row.name,
        type: row.type,
        aliases: parseJson<string[]>(row.aliases_json, 'elements.aliases_json'),
        currentState: row.current_state,
        facts: factsByElement.get(row.id) ?? [],
        sourceEventIds,
        sourceMessageIds: [...new Set(sourceEventIds.flatMap((id) => messagesByEvent.get(id) ?? []))],
        weight: {
          mentionCount: row.mention_count,
          lastAdoptedTurn: row.last_adopted_turn,
          lastRetrievedAt: row.last_retrieved_at,
          pinned: Boolean(row.pinned),
          floorWeight: row.floor_weight,
          forcedCap: row.forced_cap,
        },
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    });

    const extractionJobs = (this.database.prepare(`
      SELECT *
      FROM extraction_jobs WHERE namespace = ? ORDER BY block_id
    `).all(key) as unknown as ExtractionJobRow[]).map<ExtractionJob>((row) => ({
      blockId: row.block_id,
      status: row.status,
      attempts: row.attempts,
      lastError: row.last_error,
      nextRetryAt: row.next_retry_at,
      updatedAt: row.updated_at,
      ...(row.lease_until == null ? {} : { leaseUntil: row.lease_until }),
    }));

    const elementProjectionJobs = (this.database.prepare(`
      SELECT id, source_event_ids_json, status, attempts, element_ids_json, reason, last_error, created_at, updated_at
      FROM element_projection_jobs WHERE namespace = ? ORDER BY created_at, id
    `).all(key) as unknown as ElementProjectionJobRow[]).map<ElementProjectionJob>((row) => ({
      id: row.id,
      sourceEventIds: parseJson<string[]>(row.source_event_ids_json, 'element_projection_jobs.source_event_ids_json'),
      status: row.status,
      attempts: row.attempts,
      elementIds: parseJson<string[]>(row.element_ids_json, 'element_projection_jobs.element_ids_json'),
      reason: row.reason,
      lastError: row.last_error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));

    const successfulModelResponses = (this.database.prepare(`
      SELECT id, kind, response, created_at
      FROM model_response_history WHERE namespace = ? ORDER BY created_at, id
    `).all(key) as unknown as SuccessfulModelResponseRow[]).map<SuccessfulModelResponse>((row) => ({
      id: row.id,
      kind: row.kind,
      response: row.response,
      createdAt: row.created_at,
    }));

    const usageReceipts = (this.database.prepare(`
      SELECT receipt_id, event_ids_json, element_ids_json, audit_json, created_at
      FROM usage_receipts WHERE namespace = ? ORDER BY created_at, receipt_id
    `).all(key) as unknown as UsageReceiptRow[]).map<UsageReceipt>((row) => {
      const audit = parseJson<UsageAudit>(row.audit_json, 'usage_receipts.audit_json');
      return {
        id: row.receipt_id,
        eventIds: parseJson<string[]>(row.event_ids_json, 'usage_receipts.event_ids_json'),
        elementIds: parseJson<string[]>(row.element_ids_json, 'usage_receipts.element_ids_json'),
        ...(Object.keys(audit).length === 0 ? {} : { audit }),
        createdAt: row.created_at,
      };
    });

    const ingestionReceipts = (this.database.prepare(`
      SELECT receipt_id, created_at
      FROM ingestion_receipts WHERE namespace = ? ORDER BY created_at, receipt_id
    `).all(key) as unknown as IngestionReceiptRow[]).map<IngestionReceipt>((row) => ({
      id: row.receipt_id,
      createdAt: row.created_at,
    }));

    const externalMemoryImportJobs = (this.database.prepare(`
      SELECT id, payload_json FROM external_memory_import_jobs
      WHERE namespace = ? ORDER BY created_at, id
    `).all(key) as unknown as ExternalMemoryImportJobRow[])
      .map((row) => parseJson<ExternalMemoryImportJob>(row.payload_json, 'external_memory_import_jobs.payload_json'));

    const graphState = this.database.prepare(`
      SELECT nodes_json, edges_json, jobs_json FROM graph_state WHERE namespace = ?
    `).get(key) as GraphStateRow | undefined;
    const graphNodes = graphState ? parseJson<GraphNode[]>(graphState.nodes_json, 'graph_state.nodes_json') : [];
    const graphEdges = graphState ? parseJson<GraphEdge[]>(graphState.edges_json, 'graph_state.edges_json') : [];
    const graphProjectionJobs = graphState
      ? parseJson<GraphProjectionJob[]>(graphState.jobs_json, 'graph_state.jobs_json') : [];
    // Existing schema-12 databases remain readable before a writer creates
    // this optional, rebuildable table. A read-only admin must never migrate.
    const hasTopics = this.database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memory_topic_state'").get();
    const topicState = hasTopics ? this.database.prepare('SELECT state_json FROM memory_topic_state WHERE namespace = ?')
      .get(key) as { state_json: string } | undefined : undefined;

    const snapshot: StrataGateSnapshot = {
      schemaVersion: space.schema_version as StrataGateSnapshot['schemaVersion'],
      currentTurn: space.current_turn,
      blockTurnSize: space.block_turn_size,
      blockDecayLambda: space.block_decay_lambda,
      graphEnabled: Boolean(space.graph_enabled),
      graphEpoch: space.graph_epoch ?? 0,
      graphBackfillEventIds: parseJson<string[]>(space.graph_approved_event_ids_json ?? '[]', 'memory_spaces.graph_approved_event_ids_json'),
      openTail,
      blocks,
      summaryJobs,
      events,
      agentEvents,
      graphNodes,
      graphEdges,
      graphProjectionJobs,
      elements,
      extractionJobs,
      elementProjectionJobs,
      usageReceipts,
      ingestionReceipts,
      externalMemoryImportJobs,
      successfulModelResponses,
      ...(topicState ? { memoryTopicState: parseJson<MemoryTopicState>(topicState.state_json, 'memory_topic_state.state_json') } : {}),
    };
    if (navigation) {
      // Keep exactly the normal reader's migration/validation semantics, while
      // normalizing metadata only. The projected raw containers are not exports.
      const normalized = normalizeSnapshot({ ...snapshot, openTail: [], blocks: snapshot.blocks.map(block => ({ ...block, l5Raw: [] })) });
      normalized.openTail = snapshot.openTail;
      normalized.blocks.forEach((block, index) => { block.l5Raw = snapshot.blocks[index]!.l5Raw; });
      return { snapshot: normalized, revision: space.revision };
    }
    return { snapshot: cloneSnapshot(normalizeSnapshot(snapshot)), revision: space.revision };
  }

  async save(
    namespace: string,
    snapshot: StrataGateSnapshot,
    expectedRevision: number,
    rawMessageIndexDelta?: RawMessageIndexDelta,
    leaseGuards?: readonly DerivationLeaseGuard[],
    graphEpoch?: number,
    before?: StrataGateSnapshot,
  ): Promise<number> {
    return this.saveUnit(namespace, snapshot, expectedRevision, rawMessageIndexDelta, leaseGuards, graphEpoch, before);
  }

  async saveChanges(namespace: string, before: StrataGateSnapshot, snapshot: StrataGateSnapshot,
    expectedRevision: number, rawMessageIndexDelta?: RawMessageIndexDelta,
    leaseGuards?: readonly DerivationLeaseGuard[], graphEpoch?: number): Promise<number> {
    return this.save(namespace, snapshot, expectedRevision, rawMessageIndexDelta, leaseGuards, graphEpoch, before);
  }

  async commitRecords(namespace: string, expectedRevision: number, mutation: RecordMutation): Promise<RecordMutationResult> {
    this.assertOpen();
    const key = nonEmptyNamespace(namespace);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new TypeError('Invalid revision');
    const result = this.immediateTransaction(() => {
      const space = this.database.prepare('SELECT revision, current_turn FROM memory_spaces WHERE namespace = ?').get(key) as { revision: number; current_turn: number } | undefined;
      if (!space || space.revision !== expectedRevision) throw new StorageConflictError(key, expectedRevision, space?.revision ?? null);
      if (mutation.kind === 'append') {
        if (mutation.receipt && this.database.prepare('SELECT 1 FROM ingestion_receipts WHERE namespace = ? AND receipt_id = ?').get(key, mutation.receipt.id)) {
          return { revision: space.revision, changed: false };
        }
        const start = this.database.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS position FROM messages WHERE namespace = ? AND block_id IS NULL').get(key) as { position: number };
        const insert = this.database.prepare('INSERT INTO messages(namespace, id, block_id, thread_id, position, role, content, created_at, tool_calls_json) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)');
        mutation.messages.forEach((message, index) => insert.run(key, message.id, message.threadId ?? null, start.position + index,
          message.role, message.content, message.createdAt, message.toolCalls ? JSON.stringify(message.toolCalls) : null));
        if (mutation.receipt) this.database.prepare('INSERT INTO ingestion_receipts(namespace, receipt_id, created_at) VALUES (?, ?, ?)').run(key, mutation.receipt.id, mutation.receipt.createdAt);
        this.syncRawSearchIndex(key, { upsert: mutation.messages, deleteIds: [] });
      } else if (mutation.kind === 'block-pointers') {
        for (const block of mutation.blocks) {
          const fields = Object.entries(block).filter(([field]) => field !== 'id');
          const columns = { surfaceCurrentLevel: 'surface_current_level', pointerCurrentLevel: 'pointer_current_level',
            pointerAnchorLevel: 'pointer_anchor_level', pointerAnchorBlockPosition: 'pointer_anchor_block_position',
            lastLiftedAt: 'last_lifted_at', lastLiftedBy: 'last_lifted_by' } as const;
          if (!fields.length) continue;
          for (const [field, value] of fields) {
            if (!Object.hasOwn(columns, field)) throw new TypeError('Invalid block pointer field');
            if (field.endsWith('Level') && (!Number.isInteger(value) || Number(value) < 0 || Number(value) > 5)) throw new TypeError('Invalid block level');
            if (field === 'pointerAnchorBlockPosition' && (!Number.isSafeInteger(value) || Number(value) < 1)) throw new TypeError('Invalid block anchor');
            if (field === 'lastLiftedBy' && value !== null && value !== 'user' && value !== 'agent') throw new TypeError('Invalid block lift source');
          }
          const update = this.database.prepare(`UPDATE blocks SET ${fields.map(([field]) => `${columns[field as keyof typeof columns]} = ?`).join(', ')} WHERE namespace = ? AND id = ? AND processing_status = 'ready'`)
            .run(...fields.map(([, value]) => value as string | number | null), key, block.id);
          if (Number(update.changes) !== 1) throw new Error(`Block ${block.id} is not ready or missing`);
        }
      } else if (mutation.kind === 'pin-event') {
        const table = mutation.agent ? 'agent_events' : 'events';
        if (Number(this.database.prepare(`UPDATE ${table} SET pinned = ?, updated_at = ? WHERE namespace = ? AND id = ?`)
          .run(Number(mutation.pinned), mutation.updatedAt, key, mutation.id).changes) !== 1) throw new Error(`Unknown event ${mutation.id}`);
      } else {
        if (mutation.receipt) {
          const existing = this.database.prepare('SELECT event_ids_json, element_ids_json, audit_json FROM usage_receipts WHERE namespace = ? AND receipt_id = ?').get(key, mutation.receipt.id) as { event_ids_json: string; element_ids_json: string; audit_json: string } | undefined;
          if (existing) {
            if (existing.event_ids_json !== JSON.stringify(mutation.receipt.eventIds) || existing.element_ids_json !== JSON.stringify(mutation.receipt.elementIds)
              || existing.audit_json !== JSON.stringify(mutation.receipt.audit ?? {})) throw new Error(`Usage receipt ${mutation.receipt.id} has different content`);
            return { revision: space.revision, changed: false };
          }
        }
        for (const [table, ids] of [['events', mutation.eventIds], ['agent_events', mutation.agentEventIds], ['elements', mutation.elementIds]] as const) {
          const update = this.database.prepare(`UPDATE ${table} SET mention_count = mention_count + 1, last_adopted_turn = ?, updated_at = ?
            WHERE namespace = ? AND id = ?${table === 'elements' ? '' : " AND status NOT IN ('forgotten', 'archived')"}`);
          for (const id of new Set(ids)) update.run(space.current_turn, mutation.updatedAt, key, id);
        }
        if (mutation.receipt) this.database.prepare('INSERT INTO usage_receipts(namespace, receipt_id, event_ids_json, element_ids_json, audit_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(key, mutation.receipt.id, JSON.stringify(mutation.receipt.eventIds), JSON.stringify(mutation.receipt.elementIds), JSON.stringify(mutation.receipt.audit ?? {}), mutation.receipt.createdAt);
      }
      const revision = expectedRevision + 1;
      this.database.prepare('UPDATE memory_spaces SET revision = ?, current_turn = ?, updated_at = ? WHERE namespace = ?')
        .run(revision, space.current_turn + Number(mutation.kind === 'append'), mutation.updatedAt, key);
      return { revision, changed: true };
    });
    if (result.changed) this.notifyWorkChanged();
    return result;
  }

  private notifyWorkChanged(): void {
    for (const listener of SqliteStorage.workListeners.get(this.filename) ?? []) {
      try { listener(); } catch { /* observers cannot reject a committed write */ }
    }
  }

  private saveUnit(namespace: string, snapshot: StrataGateSnapshot, expectedRevision: number,
    rawMessageIndexDelta?: RawMessageIndexDelta, leaseGuards?: readonly DerivationLeaseGuard[],
    graphEpoch?: number, before?: StrataGateSnapshot): number {
    this.assertOpen();
    // Validation normalizes a detached copy. Historical raw values are not part
    // of normalization; omit them on the internal Unit of Work path.
    assertValidSnapshot(before ? { ...snapshot, openTail: [],
      blocks: snapshot.blocks.map(({ l5Raw: _raw, ...block }) => ({ ...block, l5Raw: [] })) } : snapshot);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new TypeError('expectedRevision must be a non-negative integer');
    }
    const key = nonEmptyNamespace(namespace);
    const revision = this.immediateTransaction(() => {
      // Event ingestion must still commit if the user disables Graph while it
      // is awaiting extraction. Suppress only newly queued Graph work.
      const storedPolicy = this.database.prepare('SELECT graph_enabled, graph_epoch FROM memory_spaces WHERE namespace = ?').get(key) as SpaceRow | undefined;
      const policy = this.graphPolicy?.(key) ?? { enabled: storedPolicy ? Boolean(storedPolicy.graph_enabled) : snapshot.graphEnabled === true, paused: false, epoch: storedPolicy?.graph_epoch ?? snapshot.graphEpoch ?? 0 };
      if (graphEpoch !== undefined) {
        if (!policy.enabled || policy.paused || policy.epoch !== graphEpoch) {
          throw new StorageConflictError(key, expectedRevision, expectedRevision);
        }
      } else if ((!policy.enabled || policy.paused) && snapshot.graphProjectionJobs.length
        && (this.graphPolicy || snapshot.graphEpoch === storedPolicy?.graph_epoch)) {
        const row = this.database.prepare('SELECT jobs_json FROM graph_state WHERE namespace = ?').get(key) as { jobs_json: string } | undefined;
        const retained = new Set((JSON.parse(row?.jobs_json ?? '[]') as GraphProjectionJob[]).map(job => job.id));
        snapshot.graphProjectionJobs = snapshot.graphProjectionJobs.filter(job => retained.has(job.id));
      }
      return this.persistSnapshot(key, snapshot, expectedRevision, rawMessageIndexDelta, leaseGuards, before);
    });
    this.notifyWorkChanged();
    return revision;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.database.close();
    this.closed = true;
  }

  /** Installation-wide state; intentionally has no namespace column. */
  getPersistentProfile(): PersistentProfile {
    this.assertOpen();
    const profile = emptyProfile();
    const rows = this.database.prepare('SELECT field, value FROM persistent_profile').all() as Array<{ field: string; value: string }>;
    for (const row of rows) if (isProfileField(row.field)) profile[row.field] = row.value;
    return profile;
  }

  getProfileSnapshot(): { profile: PersistentProfile; revisions: Record<ProfileField, number> } {
    this.assertOpen();
    const profile = emptyProfile();
    const revisions = Object.fromEntries((Object.keys(PROFILE_FIELDS) as ProfileField[]).map((field) => [field, 0])) as Record<ProfileField, number>;
    const rows = this.database.prepare('SELECT p.field, p.value, COALESCE(r.revision, 0) AS revision FROM persistent_profile p LEFT JOIN (SELECT field, MAX(id) AS revision FROM persistent_profile_changes GROUP BY field) r ON r.field = p.field').all() as Array<{ field: string; value: string; revision: number }>;
    for (const row of rows) if (isProfileField(row.field)) { profile[row.field] = row.value; revisions[row.field] = row.revision; }
    return { profile, revisions };
  }

  getProfileChanges(): ProfileChange[] {
    this.assertOpen();
    const rows = this.database.prepare('SELECT field, old_value, new_value, source, updated_at, source_message_id FROM persistent_profile_changes ORDER BY id').all() as Array<{
      field: ProfileField; old_value: string; new_value: string; source: ProfileChangeSource; updated_at: string; source_message_id: string | null;
    }>;
    return rows.map((row) => ({ field: row.field, oldValue: row.old_value, newValue: row.new_value,
      source: row.source, updatedAt: row.updated_at, sourceMessageId: row.source_message_id }));
  }

  getProfileMaintenanceStartedAt(): string | null {
    this.assertOpen();
    const row = this.database.prepare('SELECT started_at FROM persistent_profile_maintenance_baseline WHERE id = 1').get() as { started_at: string } | undefined;
    return row?.started_at ?? null;
  }

  getProfileMaintenanceState(): { lastSucceededAt: string; inputJson: string } | null {
    this.assertOpen();
    const row = this.database.prepare('SELECT last_succeeded_at, input_json FROM persistent_profile_maintenance WHERE id = 1').get() as { last_succeeded_at: string; input_json: string } | undefined;
    return row ? { lastSucceededAt: row.last_succeeded_at, inputJson: row.input_json } : null;
  }

  recordProfileMaintenanceFailure(profile: PersistentProfile, now = Date.now()): void {
    this.assertOpen();
    const inputJson = JSON.stringify(profile);
    const previous = this.database.prepare('SELECT input_json, failure_count, next_retry_at FROM persistent_profile_maintenance_failures WHERE id = 1').get() as { input_json: string; failure_count: number; next_retry_at: string } | undefined;
    const sameWindow = previous?.input_json === inputJson
      && !(previous.failure_count >= 3 && now >= Date.parse(previous.next_retry_at));
    const count = sameWindow ? previous!.failure_count + 1 : 1;
    const nextRetryAt = new Date(now + (count >= 3 ? 24 * 60 : count * 5) * 60 * 1000).toISOString();
    this.database.prepare('INSERT INTO persistent_profile_maintenance_failures (id, input_json, failure_count, next_retry_at) VALUES (1, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET input_json = excluded.input_json, failure_count = excluded.failure_count, next_retry_at = excluded.next_retry_at').run(inputJson, count, nextRetryAt);
  }

  updateProfileField(field: string, value: string, source: ProfileChangeSource, sourceMessageId?: string | null, expectedValue?: string, expectedRevision?: number): { field: ProfileField; value: string; modified: boolean; conflict?: boolean } {
    this.assertOpen();
    if (!isProfileField(field)) throw new TypeError(`Unknown Persistent Profile field: ${field}`);
    if (typeof value !== 'string') throw new TypeError('Persistent Profile value must be a string');
    if (!['settings', 'user_explicit', 'agent_tool', 'maintenance'].includes(source)) throw new TypeError('Invalid Profile change source');
    return this.immediateTransaction(() => {
      const profile = this.getPersistentProfile();
      const wasNonempty = Object.values(profile).some((entry) => entry.length > 0);
      const oldValue = profile[field];
      if (expectedRevision !== undefined) {
        const row = this.database.prepare('SELECT COALESCE(MAX(id), 0) AS revision FROM persistent_profile_changes WHERE field = ?').get(field) as { revision: number };
        if (row.revision !== expectedRevision) return { field, value: oldValue, modified: false, conflict: true };
      }
      if (expectedValue !== undefined && oldValue !== expectedValue) return { field, value: oldValue, modified: false, conflict: true };
      if (oldValue === value) return { field, value, modified: false };
      profile[field] = value;
      validateProfile(profile);
      const now = new Date().toISOString();
      this.writeProfileField(field, oldValue, value, source, sourceMessageId ?? null, now);
      const isNonempty = Object.values(profile).some((entry) => entry.length > 0);
      if (!wasNonempty && isNonempty) {
        this.database.prepare('INSERT INTO persistent_profile_maintenance_baseline (id, started_at) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET started_at = excluded.started_at').run(now);
        this.database.prepare('DELETE FROM persistent_profile_maintenance WHERE id = 1').run();
        this.database.prepare('DELETE FROM persistent_profile_maintenance_failures WHERE id = 1').run();
      } else if (!isNonempty) {
        this.database.prepare('DELETE FROM persistent_profile_maintenance_baseline WHERE id = 1').run();
      }
      return { field, value, modified: true };
    });
  }

  /** Compare the complete input snapshot before writing a model result. */
  applyProfileMaintenance(expected: PersistentProfile, proposed: PersistentProfile, now = new Date().toISOString()): boolean {
    this.assertOpen();
    validateProfile(proposed);
    if (Object.keys(proposed).length !== Object.keys(PROFILE_FIELDS).length
      || Object.keys(proposed).some((field) => !isProfileField(field))) throw new TypeError('Maintenance returned unknown or missing Profile fields');
    for (const field of PROFILE_PROTECTED_SHORT_FIELDS) {
      if (proposed[field].trim() !== expected[field].trim()) throw new Error(`Profile maintenance changed protected short field ${field}`);
    }
    return this.immediateTransaction(() => {
      const current = this.getPersistentProfile();
      if (JSON.stringify(current) !== JSON.stringify(expected)) return false;
      for (const field of Object.keys(PROFILE_FIELDS) as ProfileField[]) {
        if (current[field] !== proposed[field]) this.writeProfileField(field, current[field], proposed[field], 'maintenance', null, now);
      }
      this.database.prepare('INSERT INTO persistent_profile_maintenance (id, last_succeeded_at, input_json) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET last_succeeded_at = excluded.last_succeeded_at, input_json = excluded.input_json').run(now, JSON.stringify(proposed));
      this.database.prepare('DELETE FROM persistent_profile_maintenance_failures WHERE id = 1').run();
      return true;
    });
  }

  profileMaintenanceDue(now = Date.now()): boolean {
    const profile = this.getPersistentProfile();
    const failed = this.database.prepare('SELECT input_json, failure_count, next_retry_at FROM persistent_profile_maintenance_failures WHERE id = 1').get() as { input_json: string; failure_count: number; next_retry_at: string } | undefined;
    if (failed?.input_json === JSON.stringify(profile)
      && now < Date.parse(failed.next_retry_at)) return false;
    const state = this.getProfileMaintenanceState();
    if (!profileMaintenanceDue(profile, state?.lastSucceededAt ?? this.getProfileMaintenanceStartedAt(), now)) return false;
    // input_json stores the last successful result. Only edits to maintainable
    // fields make that content eligible again, even after multiple intervals.
    if (!state) return true;
    const maintained = JSON.parse(state.inputJson) as PersistentProfile;
    return PROFILE_MAINTAINABLE_FIELDS.some((field) => maintained[field] !== profile[field]);
  }

  private writeProfileField(field: ProfileField, oldValue: string, newValue: string, source: ProfileChangeSource, sourceMessageId: string | null, now = new Date().toISOString()): void {
    this.database.prepare('INSERT INTO persistent_profile (field, value) VALUES (?, ?) ON CONFLICT (field) DO UPDATE SET value = excluded.value').run(field, newValue);
    this.database.prepare('INSERT INTO persistent_profile_changes (field, old_value, new_value, source, updated_at, source_message_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run(field, oldValue, newValue, source, now, sourceMessageId);
  }

  searchRawMessageIds(
    namespace: string,
    tokens: readonly string[],
    limit: number,
    threadId?: string,
    includeUnthreaded = false,
  ): string[] | null {
    this.assertOpen();
    if (!this.rawSearchFtsAvailable || tokens.length === 0) return null;
    const key = nonEmptyNamespace(namespace);
    const boundedLimit = Math.max(1, Math.min(5_000, Math.floor(limit)));
    const match = tokens.map(encodeRawSearchToken).filter(Boolean).map((token) => `"${token}"`).join(' OR ');
    if (!match) return [];
    try {
      if (!this.readonly) this.immediateTransaction(() => this.ensureRawSearchIndex(key));
      const rows = this.database.prepare(`
        SELECT f.message_id
        FROM raw_message_fts AS f
        INNER JOIN messages AS m
          ON m.namespace = f.namespace AND m.id = f.message_id
        WHERE raw_message_fts MATCH ?
          AND f.namespace = ?
          ${threadId === undefined ? '' : includeUnthreaded ? 'AND (m.thread_id = ? OR m.thread_id IS NULL)' : 'AND m.thread_id = ?'}
        ORDER BY rank
        LIMIT ?
      `).all(...(threadId === undefined
        ? [match, key, boundedLimit]
        : [match, key, threadId, boundedLimit])) as unknown as Array<{ message_id: string }>;
      return rows.map(({ message_id }) => message_id);
    } catch {
      // A damaged or unavailable FTS module must never make raw search fail.
      this.rawSearchFtsAvailable = false;
      return null;
    }
  }

  private persistSnapshot(
    namespace: string,
    snapshot: StrataGateSnapshot,
    expectedRevision: number,
    rawMessageIndexDelta?: RawMessageIndexDelta,
    leaseGuards?: readonly DerivationLeaseGuard[],
    before?: StrataGateSnapshot,
  ): number {
    const current = this.database.prepare('SELECT revision FROM memory_spaces WHERE namespace = ?')
      .get(namespace) as { revision: number } | undefined;
    const actualRevision = current?.revision ?? null;
    if ((actualRevision ?? 0) !== expectedRevision || (actualRevision === null && expectedRevision !== 0)) {
      throw new StorageConflictError(namespace, expectedRevision, actualRevision);
    }

    const nextRevision = expectedRevision + 1;
    // Lease heartbeats deliberately do not change the business revision. Merge
    // them into unchanged running attempts; fence stale recovery/completion.
    this.mergeDerivationLeases(namespace, snapshot, expectedRevision, leaseGuards);
    // Compute after merging live leases: an unversioned heartbeat must never be
    // overwritten or mistaken for an unchanged task.
    const changes = before && current ? snapshotWriteSet(before, snapshot, rawMessageIndexDelta) : undefined;
    const includes = (collection: RecordCollection, id: string): boolean => !changes || changes.changed.get(collection)!.has(id);
    const updatedAt = nowUtc8();
    if (current) {
      this.database.prepare(`
        UPDATE memory_spaces
        SET schema_version = ?, revision = ?, current_turn = ?, block_turn_size = ?, block_decay_lambda = ?, graph_enabled = ?, graph_epoch = ?, graph_approved_event_ids_json = ?, updated_at = ?
        WHERE namespace = ?
      `).run(
        snapshot.schemaVersion,
        nextRevision,
        snapshot.currentTurn,
        snapshot.blockTurnSize,
        snapshot.blockDecayLambda,
        snapshot.graphEnabled === true ? 1 : 0,
        snapshot.graphEpoch ?? 0,
        JSON.stringify(snapshot.graphBackfillEventIds ?? []),
        updatedAt,
        namespace,
      );
    } else {
      this.database.prepare(`
        INSERT INTO memory_spaces (
          namespace, schema_version, revision, current_turn, block_turn_size, block_decay_lambda, graph_enabled, graph_epoch, graph_approved_event_ids_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        namespace,
        snapshot.schemaVersion,
        nextRevision,
        snapshot.currentTurn,
        snapshot.blockTurnSize,
        snapshot.blockDecayLambda,
        snapshot.graphEnabled === true ? 1 : 0,
        snapshot.graphEpoch ?? 0,
        JSON.stringify(snapshot.graphBackfillEventIds ?? []),
        updatedAt,
        updatedAt,
      );
    }

    const insertBlock = this.database.prepare(`
      INSERT INTO blocks (
        namespace, id, thread_id, sequence, start_turn, end_turn, created_at, should_extract,
        l0_title, l0_tags_json, l1_summary, l2_keypoints_json, l3_condensed, l4_readable,
        pointer_current_level, surface_current_level, pointer_anchor_level, pointer_anchor_block_position, last_lifted_at, last_lifted_by,
        processing_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (namespace, id) DO UPDATE SET
        thread_id = excluded.thread_id,
        sequence = excluded.sequence,
        start_turn = excluded.start_turn,
        end_turn = excluded.end_turn,
        created_at = excluded.created_at,
        should_extract = excluded.should_extract,
        l0_title = excluded.l0_title,
        l0_tags_json = excluded.l0_tags_json,
        l1_summary = excluded.l1_summary,
        l2_keypoints_json = excluded.l2_keypoints_json,
        l3_condensed = excluded.l3_condensed,
        l4_readable = excluded.l4_readable,
        pointer_current_level = excluded.pointer_current_level,
        surface_current_level = excluded.surface_current_level,
        pointer_anchor_level = excluded.pointer_anchor_level,
        pointer_anchor_block_position = excluded.pointer_anchor_block_position,
        last_lifted_at = excluded.last_lifted_at,
        last_lifted_by = excluded.last_lifted_by,
        processing_status = excluded.processing_status
    `);
    for (const block of snapshot.blocks) {
      if (!includes('blocks', block.id)) continue;
      insertBlock.run(
        namespace,
        block.id,
        block.threadId ?? null,
        block.sequence,
        block.startTurn,
        block.endTurn,
        block.createdAt,
        Number(block.shouldExtract ?? false),
        block.l0Title ?? '',
        JSON.stringify(block.l0Tags ?? []),
        block.l1Summary ?? '',
        JSON.stringify(block.l2Keypoints ?? []),
        block.l3Condensed,
        block.l4Readable,
        block.pointerCurrentLevel,
        block.surfaceCurrentLevel ?? block.pointerCurrentLevel,
        block.pointerAnchorLevel,
        block.pointerAnchorBlockPosition,
        block.lastLiftedAt,
        block.lastLiftedBy,
        block.processingStatus,
      );
    }

    const insertMessage = this.database.prepare(`
      INSERT INTO messages (
        namespace, id, block_id, thread_id, position, role, content, created_at, tool_calls_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (namespace, id) DO UPDATE SET
        block_id = excluded.block_id,
        thread_id = excluded.thread_id,
        position = excluded.position,
        role = excluded.role,
        content = excluded.content,
        created_at = excluded.created_at,
        tool_calls_json = excluded.tool_calls_json
      WHERE messages.block_id IS NOT excluded.block_id
        OR messages.thread_id IS NOT excluded.thread_id
        OR messages.position IS NOT excluded.position
        OR messages.role IS NOT excluded.role
        OR messages.content IS NOT excluded.content
        OR messages.created_at IS NOT excluded.created_at
        OR messages.tool_calls_json IS NOT excluded.tool_calls_json
    `);
    const insertMessages = (messages: readonly RawMessage[], blockId: string | null): void => {
      for (const [position, message] of messages.entries()) {
        insertMessage.run(
          namespace,
          message.id,
          blockId,
          message.threadId ?? null,
          position,
          message.role,
          message.content,
          message.createdAt,
          message.toolCalls ? JSON.stringify(message.toolCalls) : null,
        );
      }
    };
    if (changes) {
      for (const { message, blockId, position } of changes.messages) {
        insertMessage.run(namespace, message.id, blockId, message.threadId ?? null, position,
          message.role, message.content, message.createdAt, message.toolCalls ? JSON.stringify(message.toolCalls) : null);
      }
    } else {
      insertMessages(snapshot.openTail, null);
      for (const block of snapshot.blocks) insertMessages(block.l5Raw, block.id);
    }
    this.syncRawSearchIndex(namespace, changes ? {
      upsert: changes.messages.map(({ message }) => message), deleteIds: [...changes.deletedMessages],
    } : rawMessageIndexDelta ?? {
      upsert: snapshot.blocks.flatMap(({ l5Raw }) => l5Raw),
      deleteIds: [],
    });
    const insertEvent = this.database.prepare(`
      INSERT INTO events (
        namespace, id, position, title, summary, narrative, tags_json, quotes_json, source_block_id,
        formed_turn, temporal_json, scope, criticality, confidence, status, superseded_by,
        mention_count, last_adopted_turn, last_retrieved_at, pinned, floor_weight, forced_cap,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (namespace, id) DO UPDATE SET
        position = excluded.position,
        title = excluded.title,
        summary = excluded.summary,
        narrative = excluded.narrative,
        tags_json = excluded.tags_json,
        quotes_json = excluded.quotes_json,
        source_block_id = excluded.source_block_id,
        formed_turn = excluded.formed_turn,
        temporal_json = excluded.temporal_json,
        scope = excluded.scope,
        criticality = excluded.criticality,
        confidence = excluded.confidence,
        status = excluded.status,
        superseded_by = excluded.superseded_by,
        mention_count = excluded.mention_count,
        last_adopted_turn = excluded.last_adopted_turn,
        last_retrieved_at = excluded.last_retrieved_at,
        pinned = excluded.pinned,
        floor_weight = excluded.floor_weight,
        forced_cap = excluded.forced_cap,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `);
    // Upsert alone leaves merged-in message IDs behind after an undo. Remove only
    // stale links, without rewriting every unchanged provenance row on each turn.
    const deleteStaleEventSources = this.database.prepare(`DELETE FROM event_sources
      WHERE namespace = ? AND event_id = ? AND message_id NOT IN (SELECT value FROM json_each(?))`);
    const insertEventSource = this.database.prepare(`
      INSERT INTO event_sources (namespace, event_id, message_id, position) VALUES (?, ?, ?, ?)
      ON CONFLICT (namespace, event_id, message_id) DO UPDATE SET position = excluded.position
    `);
    for (const [eventPosition, event] of snapshot.events.entries()) {
      if (!includes('events', event.id)) continue;
      // Passive events always carry a provenance block (enforced by
      // addEventInMemory); only agent events may omit sourceBlockId.
      // Legacy NOT NULL columns stay as storage placeholders. Event readers
      // discard them; no live Event behavior uses their values.
      insertEvent.run(
        namespace,
        event.id,
        eventPosition,
        event.title,
        event.summary,
        event.summary,
        JSON.stringify(event.tags),
        JSON.stringify(event.quotes),
        event.sourceBlockId as string,
        event.formedTurn ?? null,
        JSON.stringify(event.temporal),
        event.scope,
        event.criticality,
        1,
        event.status,
        event.supersededBy,
        event.weight.mentionCount,
        event.weight.lastAdoptedTurn,
        event.weight.lastRetrievedAt,
        Number(event.weight.pinned),
        event.weight.floorWeight,
        event.weight.forcedCap,
        event.createdAt,
        event.updatedAt,
      );
      deleteStaleEventSources.run(namespace, event.id, JSON.stringify(event.sourceMessageIds));
      for (const [position, messageId] of event.sourceMessageIds.entries()) {
        insertEventSource.run(namespace, event.id, messageId, position);
      }
    }

    // Agent-recorded events use delete-then-reinsert so removals are reflected
    // immediately; the pool is low-volume and FK-ordering is already satisfied
    // because this runs after the messages upsert.
    if (!changes) {
      this.database.prepare('DELETE FROM agent_event_sources WHERE namespace = ?').run(namespace);
      this.database.prepare('DELETE FROM agent_events WHERE namespace = ?').run(namespace);
    } else for (const id of new Set([...changes.changed.get('agentEvents')!, ...changes.removed.get('agentEvents')!])) {
      this.database.prepare('DELETE FROM agent_events WHERE namespace = ? AND id = ?').run(namespace, id);
    }
    const insertAgentEvent = this.database.prepare(`
      INSERT INTO agent_events (
        namespace, id, position, title, summary, narrative, tags_json, quotes_json, source_block_id,
        formed_turn, temporal_json, scope, criticality, confidence, status, superseded_by,
        mention_count, last_adopted_turn, last_retrieved_at, pinned, floor_weight, forced_cap,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertAgentEventSource = this.database.prepare(`
      INSERT INTO agent_event_sources (namespace, event_id, message_id, position) VALUES (?, ?, ?, ?)
    `);
    for (const [eventPosition, event] of snapshot.agentEvents.entries()) {
      if (!includes('agentEvents', event.id)) continue;
      // Keep the same legacy-column placeholders in the agent Event table.
      insertAgentEvent.run(
        namespace,
        event.id,
        eventPosition,
        event.title,
        event.summary,
        event.summary,
        JSON.stringify(event.tags),
        JSON.stringify(event.quotes),
        event.sourceBlockId ?? null,
        event.formedTurn ?? null,
        JSON.stringify(event.temporal),
        event.scope,
        event.criticality,
        1,
        event.status,
        event.supersededBy,
        event.weight.mentionCount,
        event.weight.lastAdoptedTurn,
        event.weight.lastRetrievedAt,
        Number(event.weight.pinned),
        event.weight.floorWeight,
        event.weight.forcedCap,
        event.createdAt,
        event.updatedAt,
      );
      for (const [position, messageId] of event.sourceMessageIds.entries()) {
        insertAgentEventSource.run(namespace, event.id, messageId, position);
      }
    }

    const changedEvent = (id: string): boolean => includes('events', id) || includes('agentEvents', id);
    const clearEventAuxiliary = (table: 'event_merge_sources' | 'event_metadata'): void => {
      if (!changes) this.database.prepare(`DELETE FROM ${table} WHERE namespace = ?`).run(namespace);
      else for (const id of new Set([...changes.changed.get('events')!, ...changes.changed.get('agentEvents')!,
        ...changes.removed.get('events')!, ...changes.removed.get('agentEvents')!])) {
        this.database.prepare(`DELETE FROM ${table} WHERE namespace = ? AND event_id = ?`).run(namespace, id);
      }
    };
    clearEventAuxiliary('event_merge_sources');
    const insertMergedSources = this.database.prepare('INSERT INTO event_merge_sources (namespace, event_id, source_ids_json) VALUES (?, ?, ?)');
    for (const event of [...snapshot.events, ...snapshot.agentEvents]) {
      if (!changedEvent(event.id)) continue;
      if (event.mergedFromEventIds?.length) insertMergedSources.run(namespace, event.id, JSON.stringify(event.mergedFromEventIds));
    }
    clearEventAuxiliary('event_metadata');
    const insertEventMetadata = this.database.prepare(`
      INSERT INTO event_metadata (namespace, event_id, catalog_hints_json, extractor_version) VALUES (?, ?, ?, ?)
    `);
    for (const event of [...snapshot.events, ...snapshot.agentEvents]) {
      if (!changedEvent(event.id)) continue;
      const metadata = normalizeEventMetadata(event);
      if (metadata.catalogHints === undefined && metadata.extractorVersion === undefined) continue;
      insertEventMetadata.run(namespace, event.id,
        metadata.catalogHints === undefined ? null : JSON.stringify(metadata.catalogHints), metadata.extractorVersion ?? null);
    }

    const insertElement = this.database.prepare(`
      INSERT INTO elements (
        namespace, id, position, name, type, aliases_json, current_state,
        mention_count, last_adopted_turn, last_retrieved_at, pinned, floor_weight, forced_cap,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (namespace, id) DO UPDATE SET
        position = excluded.position,
        name = excluded.name,
        type = excluded.type,
        aliases_json = excluded.aliases_json,
        current_state = excluded.current_state,
        mention_count = excluded.mention_count,
        last_adopted_turn = excluded.last_adopted_turn,
        last_retrieved_at = excluded.last_retrieved_at,
        pinned = excluded.pinned,
        floor_weight = excluded.floor_weight,
        forced_cap = excluded.forced_cap,
        updated_at = excluded.updated_at
    `);
    const insertElementSource = this.database.prepare(`
      INSERT INTO element_sources (namespace, element_id, event_id, position) VALUES (?, ?, ?, ?)
      ON CONFLICT (namespace, element_id, event_id) DO UPDATE SET position = excluded.position
    `);
    const insertElementFact = this.database.prepare(`
      INSERT INTO element_facts (
        namespace, id, element_id, position, key, mode, value_json, valid_from, valid_to,
        confidence, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (namespace, id) DO UPDATE SET
        element_id = excluded.element_id,
        position = excluded.position,
        key = excluded.key,
        mode = excluded.mode,
        value_json = excluded.value_json,
        valid_from = excluded.valid_from,
        valid_to = excluded.valid_to,
        confidence = excluded.confidence,
        status = excluded.status,
        updated_at = excluded.updated_at
    `);
    const insertElementFactSource = this.database.prepare(`
      INSERT INTO element_fact_sources (namespace, fact_id, event_id, position) VALUES (?, ?, ?, ?)
      ON CONFLICT (namespace, fact_id, event_id) DO UPDATE SET position = excluded.position
    `);
    for (const [elementPosition, element] of snapshot.elements.entries()) {
      if (!includes('elements', element.id)) continue;
      if (changes || rawMessageIndexDelta?.deleteIds.length) {
        this.database.prepare('DELETE FROM element_sources WHERE namespace = ? AND element_id = ?').run(namespace, element.id);
        this.database.prepare('DELETE FROM element_facts WHERE namespace = ? AND element_id = ?').run(namespace, element.id);
      }
      insertElement.run(
        namespace,
        element.id,
        elementPosition,
        element.name,
        element.type,
        JSON.stringify(element.aliases),
        element.currentState,
        element.weight.mentionCount,
        element.weight.lastAdoptedTurn,
        element.weight.lastRetrievedAt,
        Number(element.weight.pinned),
        element.weight.floorWeight,
        element.weight.forcedCap,
        element.createdAt,
        element.updatedAt,
      );
      for (const [position, eventId] of element.sourceEventIds.entries()) {
        insertElementSource.run(namespace, element.id, eventId, position);
      }
      for (const [factPosition, fact] of element.facts.entries()) {
        insertElementFact.run(
          namespace,
          fact.id,
          element.id,
          factPosition,
          fact.key,
          fact.mode,
          JSON.stringify(fact.value),
          fact.validFrom ?? null,
          fact.validTo ?? null,
          fact.confidence ?? null,
          fact.status,
          fact.createdAt,
          fact.updatedAt,
        );
        for (const [position, eventId] of fact.sourceEventIds.entries()) {
          insertElementFactSource.run(namespace, fact.id, eventId, position);
        }
      }
    }

    const insertJob = this.database.prepare(`
      INSERT INTO extraction_jobs (
        namespace, block_id, status, attempts, last_error, next_retry_at, updated_at, lease_until
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (namespace, block_id) DO UPDATE SET
        status = excluded.status,
        attempts = excluded.attempts,
        last_error = excluded.last_error,
        next_retry_at = excluded.next_retry_at,
        updated_at = excluded.updated_at,
        lease_until = excluded.lease_until
    `);
    for (const job of snapshot.extractionJobs) {
      if (!includes('extractionJobs', job.blockId)) continue;
      insertJob.run(namespace, job.blockId, job.status, job.attempts, job.lastError, job.nextRetryAt, job.updatedAt, job.leaseUntil ?? null);
    }

    const insertSummaryJob = this.database.prepare(`
      INSERT INTO block_summary_jobs (
        namespace, block_id, status, attempts, last_error, next_retry_at, updated_at, lease_until
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (namespace, block_id) DO UPDATE SET
        status = excluded.status,
        attempts = excluded.attempts,
        last_error = excluded.last_error,
        next_retry_at = excluded.next_retry_at,
        updated_at = excluded.updated_at,
        lease_until = excluded.lease_until
    `);
    for (const job of snapshot.summaryJobs) {
      if (!includes('summaryJobs', job.blockId)) continue;
      insertSummaryJob.run(namespace, job.blockId, job.status, job.attempts, job.lastError, job.nextRetryAt, job.updatedAt, job.leaseUntil ?? null);
    }

    const insertElementProjectionJob = this.database.prepare(`
      INSERT INTO element_projection_jobs (
        namespace, id, source_event_ids_json, status, attempts, element_ids_json,
        reason, last_error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (namespace, id) DO UPDATE SET
        source_event_ids_json = excluded.source_event_ids_json,
        status = excluded.status,
        attempts = excluded.attempts,
        element_ids_json = excluded.element_ids_json,
        reason = excluded.reason,
        last_error = excluded.last_error,
        updated_at = excluded.updated_at
    `);
    for (const job of snapshot.elementProjectionJobs) {
      if (!includes('elementProjectionJobs', job.id)) continue;
      insertElementProjectionJob.run(
        namespace,
        job.id,
        JSON.stringify(job.sourceEventIds),
        job.status,
        job.attempts,
        JSON.stringify(job.elementIds),
        job.reason,
        job.lastError,
        job.createdAt,
        job.updatedAt,
      );
    }

    if (!changes || changes.graph) this.database.prepare(`
      INSERT INTO graph_state (namespace, nodes_json, edges_json, jobs_json, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (namespace) DO UPDATE SET
        nodes_json = excluded.nodes_json,
        edges_json = excluded.edges_json,
        jobs_json = excluded.jobs_json,
        updated_at = excluded.updated_at
    `).run(
      namespace,
      JSON.stringify(snapshot.graphNodes),
      JSON.stringify(snapshot.graphEdges),
      JSON.stringify(snapshot.graphProjectionJobs),
      updatedAt,
    );

    if (!changes || changes.topics) this.database.prepare(`
      INSERT INTO memory_topic_state (namespace, state_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT (namespace) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at
    `).run(namespace, JSON.stringify(snapshot.memoryTopicState ?? { topics: [], jobs: [], projectedVersions: {} }), updatedAt);

    const insertReceipt = this.database.prepare(`
      INSERT INTO usage_receipts (namespace, receipt_id, event_ids_json, element_ids_json, audit_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (namespace, receipt_id) DO NOTHING
    `);
    for (const receipt of snapshot.usageReceipts) {
      if (!includes('usageReceipts', receipt.id)) continue;
      insertReceipt.run(
        namespace,
        receipt.id,
        JSON.stringify(receipt.eventIds),
        JSON.stringify(receipt.elementIds),
        JSON.stringify(receipt.audit ?? {}),
        receipt.createdAt,
      );
    }

    const insertIngestionReceipt = this.database.prepare(`
      INSERT INTO ingestion_receipts (namespace, receipt_id, created_at)
      VALUES (?, ?, ?)
      ON CONFLICT (namespace, receipt_id) DO NOTHING
    `);
    for (const receipt of snapshot.ingestionReceipts) {
      if (!includes('ingestionReceipts', receipt.id)) continue;
      insertIngestionReceipt.run(namespace, receipt.id, receipt.createdAt);
    }

    if (!changes) this.database.prepare('DELETE FROM external_memory_import_jobs WHERE namespace = ?').run(namespace);
    else for (const id of new Set([...changes.changed.get('externalMemoryImportJobs')!, ...changes.removed.get('externalMemoryImportJobs')!])) {
      this.database.prepare('DELETE FROM external_memory_import_jobs WHERE namespace = ? AND id = ?').run(namespace, id);
    }
    const insertExternalMemoryImportJob = this.database.prepare(`
      INSERT INTO external_memory_import_jobs (namespace, id, payload_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const job of snapshot.externalMemoryImportJobs) {
      if (!includes('externalMemoryImportJobs', job.id)) continue;
      insertExternalMemoryImportJob.run(namespace, job.id, JSON.stringify(job), job.createdAt, job.updatedAt);
    }

    if (!changes) this.database.prepare('DELETE FROM model_response_history WHERE namespace = ?').run(namespace);
    else for (const id of new Set([...changes.changed.get('successfulModelResponses')!, ...changes.removed.get('successfulModelResponses')!])) {
      this.database.prepare('DELETE FROM model_response_history WHERE namespace = ? AND id = ?').run(namespace, id);
    }
    const insertSuccessfulModelResponse = this.database.prepare(`
      INSERT INTO model_response_history (namespace, id, kind, response, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const response of snapshot.successfulModelResponses ?? []) {
      if (!includes('successfulModelResponses', response.id)) continue;
      insertSuccessfulModelResponse.run(namespace, response.id, response.kind, response.response, response.createdAt);
    }

    if (!current && this.rawSearchFtsAvailable) this.database.prepare(
      'INSERT INTO raw_message_fts_state (namespace, backfill_complete) VALUES (?, 1) ON CONFLICT (namespace) DO NOTHING',
    ).run(namespace);
    if (changes || rawMessageIndexDelta?.deleteIds.length) {
      // First reconcile surviving provenance and remove absent child records,
      // then remove Events and Blocks. Full-save adapters have no write set:
      // an explicit raw deletion must also remove records absent from the
      // supplied snapshot (not leave their old source links in SQLite).
      const tables = [
        ['elements', 'elements', 'id'], ['elementProjectionJobs', 'element_projection_jobs', 'id'],
        ['summaryJobs', 'block_summary_jobs', 'block_id'], ['extractionJobs', 'extraction_jobs', 'block_id'],
        ['events', 'events', 'id'], ['usageReceipts', 'usage_receipts', 'receipt_id'],
        ['ingestionReceipts', 'ingestion_receipts', 'receipt_id'], ['blocks', 'blocks', 'id'],
      ] as const;
      for (const [collection, table, column] of tables) {
        if (changes) for (const id of changes.removed.get(collection)!) {
          this.database.prepare(`DELETE FROM ${table} WHERE namespace = ? AND ${column} = ?`).run(namespace, id);
        } else {
          const ids = snapshot[collection].map(record => 'blockId' in record ? record.blockId : record.id);
          this.database.prepare(`DELETE FROM ${table} WHERE namespace = ? AND ${column} NOT IN (SELECT value FROM json_each(?))`).run(namespace, JSON.stringify(ids));
        }
      }
    }
    // message_id foreign keys are immediate. Surviving Event links have now
    // been updated and removed Event/Block links have been cleaned by cascades.
    // A reference still present in the final snapshot must keep rejecting the
    // deletion, rolling back rows, revision and FTS together.
    if (changes || rawMessageIndexDelta) {
      const deleteMessage = this.database.prepare('DELETE FROM messages WHERE namespace = ? AND id = ?');
      for (const messageId of changes?.deletedMessages ?? rawMessageIndexDelta!.deleteIds) deleteMessage.run(namespace, messageId);
    }
    const tails = new Map<string | undefined, number>();
    for (const message of snapshot.openTail) if (message.role === 'user') tails.set(message.threadId, (tails.get(message.threadId) ?? 0) + 1);
    this.writeBackgroundWorkTimes(namespace, backgroundWorkTimes({
      ...snapshot, sealableTail: [...tails.values()].some((count) => count >= snapshot.blockTurnSize),
      ...this.graphSchedulingPolicy(namespace),
    }));
    return nextRevision;
  }

  /** Process-local hint only; the SQLite index is always the discovery authority. */
  static onBackgroundWorkChanged(filename: string, listener: () => void): () => void {
    const path = filename === ':memory:' ? filename : resolve(filename);
    const key = process.platform === 'win32' ? path.toLowerCase() : path;
    const listeners = this.workListeners.get(key) ?? new Set<() => void>();
    listeners.add(listener);
    this.workListeners.set(key, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.workListeners.delete(key);
    };
  }

  private mergeDerivationLeases(namespace: string, snapshot: StrataGateSnapshot, revision: number, guards: readonly DerivationLeaseGuard[] = []): void {
    const expected = new Map(guards.map((guard) => [`${guard.kind}\u0000${guard.id}`, guard]));
    const merge = (incoming: { status: string; attempts: number; updatedAt: string; leaseUntil?: string | null },
      durable: { status: string; attempts: number; updatedAt: string; leaseUntil?: string | null } | undefined, key: string) => {
      if (durable?.status !== 'running') return;
      const guard = expected.get(key);
      if (incoming.attempts !== durable.attempts || (incoming.status === 'running' && incoming.updatedAt !== durable.updatedAt)
        || (incoming.status !== 'running' && ((guard && guard.attempts !== durable.attempts)
          || (guard ? guard.leaseUntil : incoming.leaseUntil ?? null) !== (durable.leaseUntil ?? null)))) {
        const error = new StorageConflictError(namespace, revision, revision);
        error.message = `Storage lease conflict for ${namespace}: ${key.replace('\u0000', ':')} no longer owns the current lease`;
        throw error;
      }
      const deadline = Date.parse(durable.leaseUntil ?? '');
      if (incoming.status === 'running' && Number.isFinite(deadline)
        && (!Number.isFinite(Date.parse(incoming.leaseUntil ?? '')) || deadline > Date.parse(incoming.leaseUntil!))) incoming.leaseUntil = durable.leaseUntil ?? null;
    };
    for (const [table, jobs] of [['block_summary_jobs', snapshot.summaryJobs], ['extraction_jobs', snapshot.extractionJobs]] as const) {
      const rows = this.database.prepare(`SELECT * FROM ${table} WHERE namespace = ? AND status = 'running'`).all(namespace) as unknown as BlockSummaryJobRow[];
      const byId = new Map(rows.map((row) => [row.block_id, row]));
      for (const job of jobs) {
        const row = byId.get(job.blockId);
        merge(job, row ? { status: row.status, attempts: row.attempts, updatedAt: row.updated_at, leaseUntil: row.lease_until ?? null } : undefined,
          `${table === 'block_summary_jobs' ? 'summary' : 'extraction'}\u0000${job.blockId}`);
      }
    }
    const row = this.database.prepare('SELECT jobs_json FROM graph_state WHERE namespace = ?').get(namespace) as { jobs_json: string } | undefined;
    const byId = new Map((row ? parseJson<GraphProjectionJob[]>(row.jobs_json, 'graph_state.jobs_json') : []).map((job) => [job.id, job]));
    for (const job of snapshot.graphProjectionJobs) merge(job, byId.get(job.id), `graph\u0000${job.id}`);
    if (snapshot.memoryTopicState?.jobs.length) {
      const row = this.database.prepare("SELECT json_extract(state_json, '$.jobs') AS jobs_json FROM memory_topic_state WHERE namespace = ?").get(namespace) as { jobs_json: string | null } | undefined;
      const byId = new Map((row?.jobs_json ? parseJson<MemoryTopicState['jobs']>(row.jobs_json, 'memory_topic_state.jobs') : []).map((job) => [job.id, job]));
      for (const job of snapshot.memoryTopicState.jobs) merge(job, byId.get(job.id), `topic\u0000${job.id}`);
    }
  }

  async loadDerivationLeases(namespace: string): Promise<LoadedDerivationLeases | null> {
    this.assertOpen();
    const key = nonEmptyNamespace(namespace);
    // A read transaction keeps the revision and claims from different writers
    // in one snapshot. Heartbeats themselves never change business revision.
    this.database.exec('BEGIN');
    try {
      const space = this.database.prepare('SELECT revision FROM memory_spaces WHERE namespace = ?').get(key) as { revision: number } | undefined;
      const jobs: LoadedDerivationLeases['jobs'] = [];
      if (space) {
        for (const [kind, table] of [['summary', 'block_summary_jobs'], ['extraction', 'extraction_jobs']] as const) {
          // SELECT * also accepts old read-only databases without lease_until.
          const rows = this.database.prepare(`SELECT * FROM ${table} WHERE namespace = ? AND status = 'running'`).all(key) as unknown as BlockSummaryJobRow[];
          for (const row of rows) jobs.push({ kind, id: row.block_id, attempts: row.attempts, updatedAt: row.updated_at, leaseUntil: row.lease_until ?? null });
        }
        for (const [kind, table, expression] of [['graph', 'graph_state', 'state.jobs_json'],
          ['topic', 'memory_topic_state', "state.state_json, '$.jobs'"]] as const) {
          if (!this.database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) continue;
          const rows = this.database.prepare(`SELECT json_extract(j.value, '$.id') AS id,
            json_extract(j.value, '$.attempts') AS attempts, json_extract(j.value, '$.updatedAt') AS updatedAt,
            json_extract(j.value, '$.leaseUntil') AS leaseUntil
            FROM ${table} AS state, json_each(${expression}) AS j
            WHERE state.namespace = ? AND json_extract(j.value, '$.status') = 'running'`).all(key) as unknown as Array<Omit<LoadedDerivationLeases['jobs'][number], 'kind'>>;
          for (const row of rows) jobs.push({ ...row, kind });
        }
      }
      this.database.exec('COMMIT');
      return space ? { revision: space.revision, jobs } : null;
    } catch (error) {
      try { this.database.exec('ROLLBACK'); } catch { /* preserve the read error */ }
      throw error;
    }
  }

  async renewDerivationLease(namespace: string, kind: 'summary' | 'extraction' | 'graph' | 'topic', id: string,
    attempts: number, claimedAt: string, now: number): Promise<string | null> {
    this.assertOpen();
    if (this.readonly) throw new Error('Cannot renew a read-only derivation');
    return this.immediateTransaction(() => {
      const until = new Date(now + (kind === 'topic' ? TOPIC_LEASE_MS : DERIVATION_LEASE_MS)).toISOString();
      if (kind === 'graph' || kind === 'topic') {
        const sql = kind === 'graph' ? 'SELECT jobs_json FROM graph_state WHERE namespace = ?'
          : "SELECT json_extract(state_json, '$.jobs') AS jobs_json FROM memory_topic_state WHERE namespace = ?";
        const row = this.database.prepare(sql).get(namespace) as { jobs_json: string | null } | undefined;
        const jobs = row?.jobs_json ? parseJson<Array<GraphProjectionJob | MemoryTopicState['jobs'][number]>>(row.jobs_json, `${kind}.jobs`) : [];
        const job = jobs.find((job) => job.id === id);
        if (!job || job.status !== 'running' || job.attempts !== attempts || job.updatedAt !== claimedAt || !(Date.parse(job.leaseUntil ?? '') > now)) return null;
        if (kind === 'graph') {
          const row = this.database.prepare('SELECT graph_enabled, graph_epoch FROM memory_spaces WHERE namespace = ?').get(namespace) as SpaceRow | undefined;
          const policy = this.graphPolicy?.(namespace) ?? { enabled: Boolean(row?.graph_enabled), paused: false, epoch: row?.graph_epoch ?? 0 };
          if (!policy.enabled || policy.paused || ('claimEpoch' in job && job.claimEpoch !== undefined && job.claimEpoch !== policy.epoch)) return null;
        }
        job.leaseUntil = until;
        const update = kind === 'graph' ? 'UPDATE graph_state SET jobs_json = ? WHERE namespace = ?'
          : "UPDATE memory_topic_state SET state_json = json_set(state_json, '$.jobs', json(?)) WHERE namespace = ?";
        this.database.prepare(update).run(JSON.stringify(jobs), namespace);
      } else {
        const table = kind === 'summary' ? 'block_summary_jobs' : 'extraction_jobs';
        const row = this.database.prepare(`SELECT * FROM ${table} WHERE namespace = ? AND block_id = ?`).get(namespace, id) as BlockSummaryJobRow | undefined;
        if (!row || row.status !== 'running' || row.attempts !== attempts || row.updated_at !== claimedAt || !(Date.parse(row.lease_until ?? '') > now)) return null;
        this.database.prepare(`UPDATE ${table} SET lease_until = ? WHERE namespace = ? AND block_id = ?`).run(until, namespace, id);
      }
      return until;
    });
  }

  private initializeBackgroundWorkIndex(): void {
    this.immediateTransaction(() => {
      const exists = this.database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'background_work_schedule'").get();
      for (const table of ['block_summary_jobs', 'extraction_jobs']) {
        const columns = this.database.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>;
        if (!columns.some(({ name }) => name === 'lease_until')) this.database.exec(`ALTER TABLE ${table} ADD COLUMN lease_until TEXT`);
      }
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS background_work_schedule (
          namespace TEXT NOT NULL REFERENCES memory_spaces(namespace) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK (kind IN ('core', 'incremental', 'bootstrap')),
          due_at REAL NOT NULL,
          PRIMARY KEY (namespace, kind)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS background_work_due ON background_work_schedule(kind, due_at, namespace);
        CREATE TABLE IF NOT EXISTS background_work_index_meta (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          format_version TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS background_work_dirty (
          namespace TEXT PRIMARY KEY REFERENCES memory_spaces(namespace) ON DELETE CASCADE,
          generation TEXT NOT NULL DEFAULT (hex(randomblob(16)))
        ) STRICT;
      `);
      const dirtyColumns = this.database.prepare("PRAGMA table_info('background_work_dirty')").all() as Array<{ name: string }>;
      if (!dirtyColumns.some(({ name }) => name === 'rebuild_after')) {
        this.database.exec('ALTER TABLE background_work_dirty ADD COLUMN rebuild_after REAL NOT NULL DEFAULT 0');
        // Replace the previous triggers once; subsequent opens only check schema metadata.
        for (const { name } of this.database.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name GLOB 'background_dirty_*'").all() as Array<{ name: string }>) {
          this.database.exec(`DROP TRIGGER "${name.replaceAll('"', '""')}"`);
        }
      }
      this.database.exec('CREATE INDEX IF NOT EXISTS background_dirty_due ON background_work_dirty(rebuild_after, namespace)');
      const indexedVersion = this.database.prepare('SELECT format_version FROM background_work_index_meta WHERE singleton = 1')
        .get() as { format_version: string } | undefined;
      // Cheap, restart-safe upgrade: queue keys, never deserialize history here.
      // Existing idle schedules may predate a new versioned recovery cycle.
      if (!exists || indexedVersion?.format_version !== BACKGROUND_WORK_INDEX_VERSION) {
        this.database.exec('DELETE FROM background_work_schedule; UPDATE background_work_dirty SET rebuild_after = 0, generation = hex(randomblob(16)); INSERT OR IGNORE INTO background_work_dirty(namespace) SELECT namespace FROM memory_spaces');
        this.database.prepare('INSERT OR REPLACE INTO background_work_index_meta(singleton, format_version) VALUES (1, ?)')
          .run(BACKGROUND_WORK_INDEX_VERSION);
      }
      for (const table of ['memory_spaces', 'blocks', 'block_summary_jobs', 'extraction_jobs', 'graph_state',
        'memory_topic_state', 'events', 'agent_events', 'event_sources', 'agent_event_sources', 'event_metadata', 'event_merge_sources']) {
        for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
          if (table === 'memory_spaces' && operation === 'DELETE') continue;
          const row = operation === 'DELETE' ? 'old' : 'new';
          if (operation === 'UPDATE') this.database.exec(`DROP TRIGGER IF EXISTS background_dirty_${table}_UPDATE`);
          const trigger = `background_dirty_${table}_${operation}${operation === 'UPDATE' ? '_v2' : ''}`;
          const rows = operation === 'UPDATE' ? ['old', 'new'] : [row];
          this.database.exec(`CREATE TRIGGER IF NOT EXISTS ${trigger}
            AFTER ${operation} ON ${table} BEGIN
            ${rows.map((row) => `
              UPDATE background_work_dirty SET generation = hex(randomblob(16)), rebuild_after = 0 WHERE namespace = ${row}.namespace${row === 'old' && operation === 'UPDATE' ? ' AND old.namespace IS NOT new.namespace' : ''};
              INSERT OR IGNORE INTO background_work_dirty(namespace)
              SELECT ${row}.namespace WHERE EXISTS (SELECT 1 FROM memory_spaces WHERE namespace = ${row}.namespace)
                AND NOT EXISTS (SELECT 1 FROM background_work_dirty WHERE namespace = ${row}.namespace)
                ${row === 'old' && operation === 'UPDATE' ? 'AND old.namespace IS NOT new.namespace' : ''};`).join('\n')}
            END`);
        }
      }
      // Old clients and direct SQL can seal an open tail without creating a Job yet.
      for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
        const row = operation === 'DELETE' ? 'old' : 'new';
        if (operation === 'UPDATE') this.database.exec('DROP TRIGGER IF EXISTS background_dirty_tail_UPDATE');
        const trigger = `background_dirty_tail_${operation}${operation === 'UPDATE' ? '_v2' : ''}`;
        const rows = operation === 'UPDATE' ? ['old', 'new'] : [row];
        this.database.exec(`CREATE TRIGGER IF NOT EXISTS ${trigger}
          AFTER ${operation} ON messages WHEN ${rows.map((row) => `${row}.block_id IS NULL`).join(' OR ')} BEGIN
          ${rows.map((row) => `
            UPDATE background_work_dirty SET generation = hex(randomblob(16)), rebuild_after = 0 WHERE namespace = ${row}.namespace AND ${row}.block_id IS NULL;
            INSERT OR IGNORE INTO background_work_dirty(namespace)
            SELECT ${row}.namespace WHERE EXISTS (SELECT 1 FROM memory_spaces WHERE namespace = ${row}.namespace)
              AND NOT EXISTS (SELECT 1 FROM background_work_dirty WHERE namespace = ${row}.namespace) AND ${row}.block_id IS NULL;`).join('\n')}
          END`);
      }
    });
  }

  private writeBackgroundWorkTimes(namespace: string, times: BackgroundWorkTimes): void {
    this.database.prepare('DELETE FROM background_work_schedule WHERE namespace = ?').run(namespace);
    const insert = this.database.prepare('INSERT INTO background_work_schedule(namespace, kind, due_at) VALUES (?, ?, ?)');
    for (const [kind, time] of Object.entries(times)) if (time !== null && Number.isFinite(time)) insert.run(namespace, kind, time);
    this.database.prepare('DELETE FROM background_work_dirty WHERE namespace = ?').run(namespace);
  }

  /** Bounded, resumable rebuild of derived keys; no messages, graph nodes or memory snapshots are loaded. */
  async rebuildBackgroundWorkIndex(limit = 8, onError?: (error: unknown, namespace: string) => void): Promise<boolean> {
    this.assertOpen();
    if (this.readonly) throw new Error('Cannot rebuild a read-only scheduling index');
    const keys = this.database.prepare('SELECT namespace, generation FROM background_work_dirty WHERE rebuild_after <= ? ORDER BY rebuild_after, namespace LIMIT ?')
      .all(Date.now(), Math.max(1, Math.min(64, Math.floor(limit)))) as Array<{ namespace: string; generation: string }>;
    for (const { namespace, generation } of keys) {
      try {
        if (!this.database.prepare('SELECT 1 FROM background_work_dirty WHERE namespace = ?').get(namespace)) continue;
        const blocks = this.database.prepare('SELECT id, processing_status, should_extract FROM blocks WHERE namespace = ?')
          .all(namespace) as Array<{ id: string; processing_status: string; should_extract: number | null }>;
        const mapJobs = (table: string) => (this.database.prepare(`SELECT * FROM ${table} WHERE namespace = ?`)
          .all(namespace) as unknown as BlockSummaryJobRow[]).map((row) => ({ blockId: row.block_id, status: row.status,
            attempts: row.attempts, lastError: row.last_error, nextRetryAt: row.next_retry_at,
            updatedAt: row.updated_at, ...(row.lease_until == null ? {} : { leaseUntil: row.lease_until }) }));
        const graph = this.database.prepare('SELECT jobs_json FROM graph_state WHERE namespace = ?').get(namespace) as { jobs_json: string } | undefined;
        const topics = this.database.prepare('SELECT state_json FROM memory_topic_state WHERE namespace = ?').get(namespace) as { state_json: string } | undefined;
        const space = this.database.prepare('SELECT block_turn_size FROM memory_spaces WHERE namespace = ?').get(namespace) as { block_turn_size: number };
        if (!space) continue;
        const tail = this.database.prepare(`SELECT 1 FROM messages WHERE namespace = ? AND block_id IS NULL AND role = 'user'
          GROUP BY thread_id HAVING COUNT(*) >= ? LIMIT 1`).get(namespace, space.block_turn_size);
        // Yield between Event batches without holding a writer transaction. A changed
        // generation below discards mixed reads and leaves durable work discoverable.
        const events = await this.loadSchedulingEvents(namespace, 'events');
        const agentEvents = await this.loadSchedulingEvents(namespace, 'agent_events');
        if (this.closed) return false;
        const times = backgroundWorkTimes({
          ...this.graphSchedulingPolicy(namespace),
          blocks: blocks.map((block) => ({ id: block.id, processingStatus: block.processing_status,
            ...(block.should_extract === null ? {} : { shouldExtract: Boolean(block.should_extract) }) })),
          summaryJobs: mapJobs('block_summary_jobs'),
          extractionJobs: mapJobs('extraction_jobs') as ExtractionJob[],
          graphProjectionJobs: graph ? parseJson<GraphProjectionJob[]>(graph.jobs_json, 'graph_state.jobs_json') : [],
          events,
          agentEvents,
          ...(topics ? { memoryTopicState: parseJson<MemoryTopicState>(topics.state_json, 'memory_topic_state.state_json') } : {}),
          sealableTail: Boolean(tail),
        });
        this.immediateTransaction(() => {
          const current = this.database.prepare('SELECT generation FROM background_work_dirty WHERE namespace = ?')
            .get(namespace) as { generation: string } | undefined;
          if (current?.generation === generation) this.writeBackgroundWorkTimes(namespace, times);
        });
      } catch (error) {
        // Derived-index repair failures get a durable cooldown, not a business Job
        // retry. A newer write resets it; the generation guard preserves that wake.
        this.database.prepare('UPDATE background_work_dirty SET rebuild_after = ? WHERE namespace = ? AND generation = ?')
          .run(Date.now() + 60_000, namespace, generation);
        if (!onError) throw error;
        onError(error, namespace);
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (this.closed) return false;
    }
    return Boolean(this.database.prepare('SELECT 1 FROM background_work_dirty WHERE rebuild_after <= ? LIMIT 1').get(Date.now()));
  }

  private graphSchedulingPolicy(namespace: string): { graphEnabled: boolean; graphEpoch?: number; graphBackfillEventIds?: readonly string[] } {
    const policy = this.graphPolicy?.(namespace);
    if (policy) return { graphEnabled: policy.enabled && !policy.paused, graphEpoch: policy.epoch,
      ...(policy.backfillEventIds ? { graphBackfillEventIds: policy.backfillEventIds } : {}) };
    const row = this.database.prepare('SELECT graph_enabled, graph_epoch, graph_approved_event_ids_json FROM memory_spaces WHERE namespace = ?').get(namespace) as SpaceRow | undefined;
    return { graphEnabled: Boolean(row?.graph_enabled), graphEpoch: row?.graph_epoch ?? 0,
      graphBackfillEventIds: parseJson<string[]>(row?.graph_approved_event_ids_json ?? '[]', 'memory_spaces.graph_approved_event_ids_json') };
  }

  private async loadSchedulingEvents(namespace: string, table: 'events' | 'agent_events'): Promise<EventCard[]> {
    const sourceTable = table === 'events' ? 'event_sources' : 'agent_event_sources';
    const events: EventCard[] = [];
    let cursor: string | null = null;
    while (!this.closed) {
      const rows = this.database.prepare(`SELECT * FROM ${table} WHERE namespace = ? ${cursor === null ? '' : 'AND id > ?'}
        AND status IN ('active', 'superseded') ORDER BY id LIMIT 128`)
        .all(...(cursor === null ? [namespace] : [namespace, cursor])) as unknown as EventRow[];
      if (!rows.length) break;
      const placeholders = rows.map(() => '?').join(',');
      const ids = rows.map((row) => row.id);
      const sources = new Map<string, string[]>();
      for (const row of this.database.prepare(`SELECT event_id, message_id FROM ${sourceTable}
        WHERE namespace = ? AND event_id IN (${placeholders}) ORDER BY event_id, position`)
        .all(namespace, ...ids) as unknown as EventSourceRow[]) {
        const values = sources.get(row.event_id) ?? [];
        values.push(row.message_id); sources.set(row.event_id, values);
      }
      const batch = mapEventRows(rows, sources, table);
      this.loadMergedSources(namespace, batch);
      const byId = new Map(batch.map((event) => [event.id, event]));
      for (const row of this.database.prepare(`SELECT event_id, catalog_hints_json, extractor_version FROM event_metadata
        WHERE namespace = ? AND event_id IN (${placeholders})`)
        .all(namespace, ...ids) as Array<{ event_id: string; catalog_hints_json: string | null; extractor_version: number | null }>) {
        const event = byId.get(row.event_id);
        if (event) Object.assign(event, normalizeEventMetadata({
          ...(row.catalog_hints_json === null ? {} : { catalogHints: parseJson<unknown>(row.catalog_hints_json, 'event_metadata.catalog_hints_json') }),
          extractorVersion: row.extractor_version,
        }));
      }
      events.push(...batch); cursor = rows.at(-1)!.id;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return events;
  }

  dueBackgroundNamespaces(now = Date.now(), includeTopics = true, bootstrapNotBefore = now): string[] {
    this.assertOpen();
    const rows = this.database.prepare(`
      SELECT namespace FROM (
      SELECT namespace FROM background_work_schedule WHERE kind = 'core' AND due_at <= ?
      UNION SELECT namespace FROM background_work_schedule WHERE kind = 'incremental' AND due_at <= ?
      UNION SELECT namespace FROM background_work_schedule WHERE kind = 'bootstrap' AND due_at <= ?
      ) AS due WHERE NOT EXISTS (SELECT 1 FROM background_work_dirty WHERE namespace = due.namespace)
    `).all(now, includeTopics ? now : -1, includeTopics && bootstrapNotBefore <= now ? now : -1) as Array<{ namespace: string }>;
    return rows.map(({ namespace }) => namespace);
  }

  nextBackgroundWorkAt(includeTopics = true, bootstrapNotBefore = Date.now()): number | null {
    const row = this.database.prepare(`SELECT MIN(time) AS time FROM (
      SELECT MIN(due_at) AS time FROM background_work_schedule AS s WHERE kind = 'core' AND NOT EXISTS (SELECT 1 FROM background_work_dirty WHERE namespace = s.namespace)
      UNION ALL SELECT MIN(due_at) FROM background_work_schedule AS s WHERE kind = 'incremental' AND ? AND NOT EXISTS (SELECT 1 FROM background_work_dirty WHERE namespace = s.namespace)
      UNION ALL SELECT MAX(MIN(due_at), ?) FROM background_work_schedule AS s WHERE kind = 'bootstrap' AND ? AND NOT EXISTS (SELECT 1 FROM background_work_dirty WHERE namespace = s.namespace)
    )`).get(Number(includeTopics), bootstrapNotBefore, Number(includeTopics)) as { time: number | null };
    return row.time;
  }

  /** Explicit repair: persisted Jobs/Topic state are untouched. Discovery resumes in bounded batches. */
  rebuildBackgroundWorkSchedule(): void {
    this.immediateTransaction(() => {
      this.database.exec('DELETE FROM background_work_schedule; UPDATE background_work_dirty SET rebuild_after = 0, generation = hex(randomblob(16)); INSERT OR IGNORE INTO background_work_dirty(namespace) SELECT namespace FROM memory_spaces');
    });
  }

  namespaceRevision(namespace: string): number | null {
    const row = this.database.prepare('SELECT revision FROM memory_spaces WHERE namespace = ?').get(namespace) as { revision: number } | undefined;
    return row?.revision ?? null;
  }

  private loadMergedSources(namespace: string, events: EventCard[]): void {
    if (!this.database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'event_merge_sources'").get()) return;
    const byId = new Map(events.map(event => [event.id, event]));
    const rows = this.database.prepare('SELECT event_id, source_ids_json FROM event_merge_sources WHERE namespace = ?').all(namespace) as Array<{ event_id: string; source_ids_json: string }>;
    for (const row of rows) {
      const event = byId.get(row.event_id);
      if (event) event.mergedFromEventIds = parseJson<string[]>(row.source_ids_json, 'event_merge_sources.source_ids_json');
    }
  }

  private migrate(): void {
    const version = this.userVersion();
    if (version > STRATAGATE_STORAGE_SCHEMA_VERSION) {
      throw new Error(`SQLite schema ${version} is newer than supported schema ${STRATAGATE_STORAGE_SCHEMA_VERSION}`);
    }
    if (version === 0) {
      this.immediateTransaction(() => {
        this.database.exec(SCHEMA);
        this.database.exec(THREAD_INDEXES);
        this.enableRawSearchFts();
        this.database.exec(`PRAGMA user_version = ${STRATAGATE_STORAGE_SCHEMA_VERSION}`);
      });
    } else if (version >= 1 && version < STRATAGATE_STORAGE_SCHEMA_VERSION) {
      this.immediateTransaction(() => {
        this.database.exec(SCHEMA);
        if (version === 1) {
          const receiptColumns = this.database.prepare("PRAGMA table_info('usage_receipts')").all() as unknown as Array<{ name: string }>;
          if (!receiptColumns.some(({ name }) => name === 'element_ids_json')) {
            this.database.exec("ALTER TABLE usage_receipts ADD COLUMN element_ids_json TEXT NOT NULL DEFAULT '[]'");
          }
        }
        const receiptColumns = this.database.prepare("PRAGMA table_info('usage_receipts')").all() as unknown as Array<{ name: string }>;
        if (!receiptColumns.some(({ name }) => name === 'audit_json')) {
          this.database.exec("ALTER TABLE usage_receipts ADD COLUMN audit_json TEXT NOT NULL DEFAULT '{}'");
        }
        const spaceColumns = this.database.prepare("PRAGMA table_info('memory_spaces')").all() as unknown as Array<{ name: string }>;
        if (!spaceColumns.some(({ name }) => name === 'block_decay_lambda')) {
          this.database.exec('ALTER TABLE memory_spaces ADD COLUMN block_decay_lambda REAL NOT NULL DEFAULT 0.3');
        }
        if (!spaceColumns.some(({ name }) => name === 'graph_enabled')) {
          this.database.exec('ALTER TABLE memory_spaces ADD COLUMN graph_enabled INTEGER NOT NULL DEFAULT 0 CHECK (graph_enabled IN (0, 1))');
        }
        if (!spaceColumns.some(({ name }) => name === 'graph_epoch')) this.database.exec('ALTER TABLE memory_spaces ADD COLUMN graph_epoch INTEGER NOT NULL DEFAULT 0');
        if (!spaceColumns.some(({ name }) => name === 'graph_approved_event_ids_json')) this.database.exec("ALTER TABLE memory_spaces ADD COLUMN graph_approved_event_ids_json TEXT NOT NULL DEFAULT '[]'");
        const blockColumns = this.database.prepare("PRAGMA table_info('blocks')").all() as unknown as Array<{ name: string }>;
        if (!blockColumns.some(({ name }) => name === 'thread_id')) {
          this.database.exec('ALTER TABLE blocks ADD COLUMN thread_id TEXT');
        }
        if (!blockColumns.some(({ name }) => name === 'pointer_anchor_block_position')) {
          this.database.exec('ALTER TABLE blocks RENAME COLUMN pointer_anchor_turn TO pointer_anchor_block_position');
          this.database.exec(`
            UPDATE blocks AS target
            SET pointer_anchor_block_position = MAX(1, (
              SELECT COUNT(*) FROM blocks AS candidate
              WHERE candidate.namespace = target.namespace
                AND candidate.thread_id IS target.thread_id
                AND candidate.end_turn <= target.pointer_anchor_block_position
            ))
          `);
        }
        if (!blockColumns.some(({ name }) => name === 'last_lifted_by')) {
          this.database.exec("ALTER TABLE blocks ADD COLUMN last_lifted_by TEXT CHECK (last_lifted_by IS NULL OR last_lifted_by IN ('user', 'agent'))");
        }
        if (!blockColumns.some(({ name }) => name === 'processing_status')) {
          this.database.exec("ALTER TABLE blocks ADD COLUMN processing_status TEXT NOT NULL DEFAULT 'ready' CHECK (processing_status IN ('pending', 'ready'))");
        }
        if (!blockColumns.some(({ name }) => name === 'surface_current_level')) {
          this.database.exec('ALTER TABLE blocks ADD COLUMN surface_current_level INTEGER NOT NULL DEFAULT 5');
          this.database.exec('UPDATE blocks SET surface_current_level = pointer_current_level');
        }
        const eventColumns = this.database.prepare("PRAGMA table_info('events')").all() as unknown as Array<{ name: string }>;
        if (!eventColumns.some(({ name }) => name === 'formed_turn')) {
          this.database.exec('ALTER TABLE events ADD COLUMN formed_turn INTEGER');
        }
        this.database.exec(`
          UPDATE events
          SET formed_turn = (
            SELECT blocks.end_turn FROM blocks
            WHERE blocks.namespace = events.namespace AND blocks.id = events.source_block_id
          )
          WHERE formed_turn IS NULL AND EXISTS (
            SELECT 1 FROM blocks
            WHERE blocks.namespace = events.namespace
              AND blocks.id = events.source_block_id
              AND (blocks.thread_id IS NULL OR (
                blocks.thread_id NOT LIKE 'external-import:%'
                AND blocks.thread_id NOT LIKE 'agent-memory:%'
              ))
          )
        `);
        const extractionColumns = this.database.prepare("PRAGMA table_info('extraction_jobs')").all() as unknown as Array<{ name: string }>;
        if (!extractionColumns.some(({ name }) => name === 'next_retry_at')) {
          this.database.exec('ALTER TABLE extraction_jobs ADD COLUMN next_retry_at TEXT');
        }
        const messageColumns = this.database.prepare("PRAGMA table_info('messages')").all() as unknown as Array<{ name: string }>;
        if (!messageColumns.some(({ name }) => name === 'thread_id')) {
          this.database.exec('ALTER TABLE messages ADD COLUMN thread_id TEXT');
        }
        this.database.exec(THREAD_INDEXES);
        this.rebuildLegacyElementSourceForeignKeys();
        this.enableRawSearchFts();
        this.database.prepare("INSERT INTO stratagate_graph_policy_migrations (id, completed_at) VALUES (1, ?) ON CONFLICT (id) DO NOTHING").run(nowUtc8());
        // Match normalizeSnapshot's ready-clock -> sealed-clock cutover. Keep
        // elapsed decay unchanged, including explicitly lifted anchors. This
        // runs once, in the same transaction as both schema-version markers.
        this.database.exec(`
          WITH pending_counts AS MATERIALIZED (
            SELECT namespace, thread_id, COUNT(*) AS count FROM blocks
            WHERE processing_status = 'pending' GROUP BY namespace, thread_id
          )
          UPDATE blocks AS target
          SET pointer_anchor_block_position = pointer_anchor_block_position + (
            SELECT pending.count FROM pending_counts AS pending
            WHERE pending.namespace = target.namespace
              AND pending.thread_id IS target.thread_id
          )
          WHERE target.processing_status = 'ready'
            AND EXISTS (
              SELECT 1 FROM pending_counts AS pending
              WHERE pending.namespace = target.namespace AND pending.thread_id IS target.thread_id
            )
            AND EXISTS (
              SELECT 1 FROM memory_spaces AS space
              WHERE space.namespace = target.namespace AND space.schema_version < 14
            )
        `);
        this.database.prepare('UPDATE memory_spaces SET schema_version = ? WHERE schema_version < ?')
          .run(STRATAGATE_STORAGE_SCHEMA_VERSION, STRATAGATE_STORAGE_SCHEMA_VERSION);
        this.database.exec(`PRAGMA user_version = ${STRATAGATE_STORAGE_SCHEMA_VERSION}`);
      });
    } else if (version === STRATAGATE_STORAGE_SCHEMA_VERSION) {
      this.immediateTransaction(() => {
        this.database.exec(SCHEMA);
        if (!this.hasColumn('memory_spaces', 'graph_enabled')) {
          this.database.exec('ALTER TABLE memory_spaces ADD COLUMN graph_enabled INTEGER NOT NULL DEFAULT 0 CHECK (graph_enabled IN (0, 1))');
        }
        if (!this.hasColumn('memory_spaces', 'graph_epoch')) this.database.exec('ALTER TABLE memory_spaces ADD COLUMN graph_epoch INTEGER NOT NULL DEFAULT 0');
        if (!this.hasColumn('memory_spaces', 'graph_approved_event_ids_json')) this.database.exec("ALTER TABLE memory_spaces ADD COLUMN graph_approved_event_ids_json TEXT NOT NULL DEFAULT '[]'");
        if (!this.hasColumn('blocks', 'surface_current_level')) {
          this.database.exec('ALTER TABLE blocks ADD COLUMN surface_current_level INTEGER NOT NULL DEFAULT 5');
          this.database.exec('UPDATE blocks SET surface_current_level = pointer_current_level');
        }
        this.database.prepare("INSERT INTO stratagate_graph_policy_migrations (id, completed_at) VALUES (1, ?) ON CONFLICT (id) DO NOTHING").run(nowUtc8());
        this.database.exec(THREAD_INDEXES);
        this.rebuildLegacyElementSourceForeignKeys();
        this.enableRawSearchFts();
      });
    }
    this.immediateTransaction(() => {
      this.database.exec('DROP INDEX IF EXISTS persistent_profile_single_consent');
      this.database.exec(`
        INSERT INTO persistent_profile_maintenance_baseline (id, started_at)
        SELECT 1, COALESCE(
          (SELECT MIN(updated_at) FROM persistent_profile_changes WHERE new_value <> ''),
          strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        )
        WHERE EXISTS (SELECT 1 FROM persistent_profile WHERE value <> '')
        ON CONFLICT (id) DO NOTHING
      `);
      this.database.exec("DELETE FROM persistent_profile_maintenance_baseline WHERE NOT EXISTS (SELECT 1 FROM persistent_profile WHERE value <> '')");
    });
    this.assertSchemaVersion();
  }

  private hasColumn(table: string, column: string): boolean {
    return (this.database.prepare(`PRAGMA table_info('${table}')`).all() as unknown as Array<{ name: string }>).some(row => row.name === column);
  }

  /**
   * v12 widened element provenance to the agent_events pool, but SQLite cannot
   * retarget an existing FOREIGN KEY. Tables still carrying the legacy
   * events-only constraint on event_id are rebuilt in place (same columns,
   * same rows) without it; integrity is enforced by validateReferences.
   */
  private rebuildLegacyElementSourceForeignKeys(): void {
    const legacyTables = (this.database.prepare(`
      SELECT name, sql FROM sqlite_master
      WHERE type = 'table' AND name IN ('element_sources', 'element_fact_sources')
    `).all() as Array<{ name: string; sql: string }>)
      .filter(({ sql }) => typeof sql === 'string' && sql.includes('REFERENCES events'));
    if (legacyTables.length === 0) return;
    // The rebuild runs inside migrate()'s immediate transaction; deferred
    // enforcement lets the create/copy/drop/rename sequence pass as long as
    // the final state is consistent, which it is because rows are unchanged.
    this.database.exec('PRAGMA defer_foreign_keys = ON');
    if (legacyTables.some(({ name }) => name === 'element_sources')) {
      this.database.exec(`
        CREATE TABLE element_sources_rebuild (
          namespace TEXT NOT NULL,
          element_id TEXT NOT NULL,
          event_id TEXT NOT NULL,
          position INTEGER NOT NULL,
          PRIMARY KEY (namespace, element_id, event_id),
          FOREIGN KEY (namespace, element_id) REFERENCES elements(namespace, id) ON DELETE CASCADE
        ) STRICT;
        INSERT INTO element_sources_rebuild (namespace, element_id, event_id, position)
          SELECT namespace, element_id, event_id, position FROM element_sources;
        DROP TABLE element_sources;
        ALTER TABLE element_sources_rebuild RENAME TO element_sources;
      `);
    }
    if (legacyTables.some(({ name }) => name === 'element_fact_sources')) {
      this.database.exec(`
        CREATE TABLE element_fact_sources_rebuild (
          namespace TEXT NOT NULL,
          fact_id TEXT NOT NULL,
          event_id TEXT NOT NULL,
          position INTEGER NOT NULL,
          PRIMARY KEY (namespace, fact_id, event_id),
          FOREIGN KEY (namespace, fact_id) REFERENCES element_facts(namespace, id) ON DELETE CASCADE
        ) STRICT;
        INSERT INTO element_fact_sources_rebuild (namespace, fact_id, event_id, position)
          SELECT namespace, fact_id, event_id, position FROM element_fact_sources;
        DROP TABLE element_fact_sources;
        ALTER TABLE element_fact_sources_rebuild RENAME TO element_fact_sources;
      `);
    }
    // Interim v12 builds declared agent_events.source_block_id NOT NULL; real
    // open-tail provenance requires a nullable column.
    const agentColumns = this.database.prepare("PRAGMA table_info('agent_events')").all() as unknown as Array<{ name: string; notnull: number }>;
    const sourceColumn = agentColumns.find(({ name }) => name === 'source_block_id');
    if (sourceColumn?.notnull) {
      this.database.exec(`
        CREATE TABLE agent_events_rebuild (
          namespace TEXT NOT NULL,
          id TEXT NOT NULL,
          position INTEGER NOT NULL,
          title TEXT NOT NULL,
          summary TEXT NOT NULL,
          narrative TEXT NOT NULL,
          tags_json TEXT NOT NULL,
          quotes_json TEXT NOT NULL,
          source_block_id TEXT,
          formed_turn INTEGER,
          temporal_json TEXT NOT NULL,
          scope TEXT NOT NULL,
          criticality TEXT NOT NULL,
          confidence REAL NOT NULL,
          status TEXT NOT NULL,
          superseded_by TEXT,
          mention_count INTEGER NOT NULL,
          last_adopted_turn INTEGER NOT NULL,
          last_retrieved_at TEXT,
          pinned INTEGER NOT NULL,
          floor_weight REAL NOT NULL,
          forced_cap REAL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (namespace, id),
          FOREIGN KEY (namespace, source_block_id) REFERENCES blocks(namespace, id)
        ) STRICT;
        INSERT INTO agent_events_rebuild SELECT * FROM agent_events;
        DROP TABLE agent_events;
        ALTER TABLE agent_events_rebuild RENAME TO agent_events;
      `);
    }
  }

  private enableRawSearchFts(): void {
    try {
      const hadFts = this.database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'raw_message_fts'").get();
      const hadDirtyTracking = this.database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'raw_message_fts_dirty'").get();
      this.database.exec(RAW_MESSAGE_FTS_SCHEMA);
      this.rawSearchFtsAvailable = true;
      this.database.exec(`CREATE TABLE IF NOT EXISTS raw_message_fts_dirty (
        namespace TEXT NOT NULL REFERENCES memory_spaces(namespace) ON DELETE CASCADE,
        message_id TEXT NOT NULL, PRIMARY KEY (namespace, message_id)
      ) STRICT`);
      // One cheap upgrade marker invalidation. Pre-upgrade writers could have
      // added rows without our dirty triggers; repair remains lazy per search.
      if (!hadFts || !hadDirtyTracking) this.database.exec('UPDATE raw_message_fts_state SET backfill_complete = 0');
      this.database.exec('DROP TRIGGER IF EXISTS raw_fts_dirty_UPDATE');
      for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
        const row = operation === 'DELETE' ? 'old' : 'new';
        const trigger = operation === 'UPDATE' ? 'raw_fts_dirty_UPDATE_v2' : `raw_fts_dirty_${operation}`;
        const changed = operation === 'UPDATE' ? 'WHEN old.content IS NOT new.content OR old.block_id IS NOT new.block_id OR old.namespace IS NOT new.namespace OR old.id IS NOT new.id' : '';
        const rows = operation === 'UPDATE' ? ['old', 'new'] : [row];
        this.database.exec(`CREATE TRIGGER IF NOT EXISTS ${trigger}
          AFTER ${operation} ON messages ${changed} BEGIN
          ${rows.map((row) => `
            INSERT OR IGNORE INTO raw_message_fts_dirty(namespace, message_id)
            SELECT ${row}.namespace, ${row}.id WHERE NOT EXISTS (
              SELECT 1 FROM raw_message_fts_dirty WHERE namespace = ${row}.namespace AND message_id = ${row}.id)
              AND EXISTS (SELECT 1 FROM memory_spaces WHERE namespace = ${row}.namespace);`).join('\n')}
          END`);
      }
    } catch {
      // FTS5 is optional across the supported SQLite runtimes. The caller
      // will continue with exhaustive BM25 when it is unavailable.
      this.rawSearchFtsAvailable = false;
    }
  }

  /** Lazy legacy backfill or bounded changed-row repair, only for a namespace being searched. */
  private ensureRawSearchIndex(namespace: string): void {
    const state = this.database.prepare('SELECT backfill_complete FROM raw_message_fts_state WHERE namespace = ?')
      .get(namespace) as { backfill_complete: number } | undefined;
    if (state?.backfill_complete !== 1) {
      this.database.prepare('DELETE FROM raw_message_fts WHERE namespace = ?').run(namespace);
      this.database.prepare('DELETE FROM raw_message_fts_meta WHERE namespace = ?').run(namespace);
      const messages = this.database.prepare('SELECT id, content FROM messages WHERE namespace = ? AND block_id IS NOT NULL')
        .all(namespace) as Array<{ id: string; content: string }>;
      this.syncRawSearchIndex(namespace, { upsert: messages, deleteIds: [] });
      this.database.prepare(`INSERT INTO raw_message_fts_state(namespace, backfill_complete) VALUES (?, 1)
        ON CONFLICT(namespace) DO UPDATE SET backfill_complete = 1`).run(namespace);
      this.database.prepare('DELETE FROM raw_message_fts_dirty WHERE namespace = ?').run(namespace);
      return;
    }
    const dirty = this.database.prepare(`SELECT d.message_id, m.content, m.block_id
      FROM raw_message_fts_dirty AS d LEFT JOIN messages AS m ON m.namespace = d.namespace AND m.id = d.message_id
      WHERE d.namespace = ?`).all(namespace) as Array<{ message_id: string; content: string | null; block_id: string | null }>;
    if (dirty.length) this.syncRawSearchIndex(namespace, {
      upsert: dirty.filter((row) => row.block_id !== null && row.content !== null).map((row) => ({ id: row.message_id, content: row.content! })),
      deleteIds: dirty.filter((row) => row.block_id === null || row.content === null).map((row) => row.message_id),
    });
  }

  /** Explicit namespace repair, with no global integrity scans on ordinary opens. */
  rebuildRawSearchIndex(namespace: string): void {
    this.assertOpen();
    if (this.readonly) throw new Error('Cannot repair a read-only raw search index');
    if (!this.rawSearchFtsAvailable) return;
    const key = nonEmptyNamespace(namespace);
    this.immediateTransaction(() => {
      this.database.prepare('DELETE FROM raw_message_fts WHERE namespace = ?').run(key);
      this.database.prepare('DELETE FROM raw_message_fts_meta WHERE namespace = ?').run(key);
      this.database.prepare('DELETE FROM raw_message_fts_state WHERE namespace = ?').run(key);
      this.ensureRawSearchIndex(key);
    });
  }

  private syncRawSearchIndex(namespace: string, delta: RawMessageIndexDelta): void {
    if (!this.rawSearchFtsAvailable) return;
    const findMeta = this.database.prepare(`
      SELECT message_id, tokens, fts_rowid
      FROM raw_message_fts_meta WHERE namespace = ? AND message_id = ?
    `);
    const deleteFts = this.database.prepare('DELETE FROM raw_message_fts WHERE rowid = ?');
    const clearDirty = this.database.prepare('DELETE FROM raw_message_fts_dirty WHERE namespace = ? AND message_id = ?');
    const deleteMeta = this.database.prepare('DELETE FROM raw_message_fts_meta WHERE namespace = ? AND message_id = ?');
    for (const messageId of delta.deleteIds) {
      const row = findMeta.get(namespace, messageId) as RawSearchIndexRow | undefined;
      clearDirty.run(namespace, messageId);
      // Cascading source deletion can already have removed the meta row.
      if (row) deleteFts.run(row.fts_rowid);
      else this.database.prepare('DELETE FROM raw_message_fts WHERE namespace = ? AND message_id = ?').run(namespace, messageId);
      deleteMeta.run(namespace, messageId);
    }
    const insertFts = this.database.prepare(
      'INSERT INTO raw_message_fts (namespace, message_id, tokens) VALUES (?, ?, ?)',
    );
    const insertMeta = this.database.prepare(`
      INSERT INTO raw_message_fts_meta (namespace, message_id, tokens, fts_rowid)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (namespace, message_id) DO UPDATE SET tokens = excluded.tokens, fts_rowid = excluded.fts_rowid
    `);
    for (const message of delta.upsert) {
      const messageId = message.id;
      clearDirty.run(namespace, messageId);
      const tokens = encodedRawSearchTokens(message.content);
      const previous = findMeta.get(namespace, messageId) as RawSearchIndexRow | undefined;
      if (previous?.tokens === tokens) continue;
      if (previous) deleteFts.run(previous.fts_rowid);
      if (!tokens) {
        if (previous) deleteMeta.run(namespace, messageId);
        continue;
      }
      insertFts.run(namespace, messageId, tokens);
      const row = this.database.prepare('SELECT last_insert_rowid() AS rowid').get() as { rowid: number };
      insertMeta.run(namespace, messageId, tokens, row.rowid);
    }
  }

  private assertSchemaVersion(): void {
    const version = this.userVersion();
    if (version !== STRATAGATE_STORAGE_SCHEMA_VERSION && !(this.readonly && [12, 13].includes(version))) {
      throw new Error(`Unsupported SQLite schema version: ${version}`);
    }
  }

  private userVersion(): number {
    const row = this.database.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
    return row?.user_version ?? 0;
  }

  private immediateTransaction<T>(operation: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.database.exec('ROLLBACK');
      } catch {
        // Preserve the operation error if SQLite already rolled the transaction back.
      }
      throw error;
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('SQLite storage is closed');
  }

  listNamespaces(): string[] {
    this.assertOpen();
    return (this.database.prepare('SELECT namespace FROM memory_spaces ORDER BY namespace').all() as Array<{ namespace: string }>)
      .map(({ namespace }) => namespace);
  }

  listNamespaceRevisions(): NamespaceRevision[] {
    this.assertOpen();
    return this.database.prepare('SELECT namespace, revision FROM memory_spaces ORDER BY namespace')
      .all() as unknown as NamespaceRevision[];
  }
}
