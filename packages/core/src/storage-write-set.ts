import { isDeepStrictEqual } from 'node:util';
import type { MemoryBlock, RawMessage } from './types.js';
import type { RawMessageIndexDelta, StrataGateSnapshot } from './storage.js';

/** Business-unit change set. SQLite still owns transactions and rollback. */
export const RECORD_COLLECTIONS = ['blocks', 'summaryJobs', 'events', 'agentEvents', 'elements',
  'extractionJobs', 'elementProjectionJobs', 'usageReceipts', 'ingestionReceipts',
  'externalMemoryImportJobs', 'successfulModelResponses'] as const;
export type RecordCollection = typeof RECORD_COLLECTIONS[number];
export const recordId = (record: { id?: string; blockId?: string }): string => record.id ?? record.blockId!;

/** Tool payloads are immutable owned values; freezing happens once per payload.
 * Message scalars remain editable for legacy integrations, and are compared
 * independently of the potentially large tool graph.
 */
const ownedToolRoots = new WeakSet<object>();
function freezeToolValue(value: unknown, seen = new WeakSet<object>()): void {
  if (!value || typeof value !== 'object' || Object.isFrozen(value) || seen.has(value)) return;
  seen.add(value);
  if (ArrayBuffer.isView(value)) return;
  for (const child of Object.values(value)) freezeToolValue(child, seen);
  Object.freeze(value);
}
export function captureRawMessage(message: RawMessage): RawMessage {
  if (message.toolCalls && !ownedToolRoots.has(message.toolCalls)) {
    // Use the exact JSON representation stored by SQLite (including Date and
    // typed-array inputs). Never freeze or retain the caller's object graph.
    message.toolCalls = JSON.parse(JSON.stringify(message.toolCalls)) as NonNullable<RawMessage['toolCalls']>;
    freezeToolValue(message.toolCalls);
    ownedToolRoots.add(message.toolCalls);
  }
  return { ...message };
}

/** Copy message scalars and containers for undo, without cloning historical tool payloads.
 * Public export/import continues to use detached, fully cloned snapshots.
 */
export function captureMutationState(state: StrataGateSnapshot): StrataGateSnapshot {
  const copy: StrataGateSnapshot = structuredClone({ ...state, openTail: [], blocks: state.blocks.map(({ l5Raw: _raw, ...block }) => ({ ...block, l5Raw: [] })) });
  copy.openTail = state.openTail.map(captureRawMessage);
  copy.blocks.forEach((block, index) => { block.l5Raw = state.blocks[index]!.l5Raw.map(captureRawMessage); });
  return copy;
}

function metadata(record: unknown, collection: RecordCollection): unknown {
  if (collection !== 'blocks') return record;
  const { l5Raw: _raw, ...block } = record as MemoryBlock;
  return block;
}

export interface MessageWrite { message: RawMessage; blockId: string | null; position: number }
function messageLocations(state: StrataGateSnapshot): Map<string, MessageWrite> {
  const rows = new Map<string, MessageWrite>();
  const add = (messages: readonly RawMessage[], blockId: string | null): void => {
    messages.forEach((message, position) => rows.set(message.id, { message, blockId, position }));
  };
  add(state.openTail, null);
  for (const block of state.blocks) add(block.l5Raw, block.id);
  return rows;
}

export function snapshotWriteSet(before: StrataGateSnapshot, after: StrataGateSnapshot, rawDelta?: RawMessageIndexDelta) {
  const changed = new Map<RecordCollection, Set<string>>();
  const removed = new Map<RecordCollection, Set<string>>();
  for (const collection of RECORD_COLLECTIONS) {
    const previous = new Map((before[collection] ?? []).map((record, position) => [recordId(record), { record, position }]));
    const ids = new Set<string>();
    (after[collection] ?? []).forEach((record, position) => {
      const id = recordId(record);
      const old = previous.get(id);
      if (!old || old.position !== position || !isDeepStrictEqual(metadata(old.record, collection), metadata(record, collection))) ids.add(id);
      previous.delete(id);
    });
    changed.set(collection, ids);
    removed.set(collection, new Set(previous.keys()));
  }
  const previous = messageLocations(before);
  const forced = new Set(rawDelta?.upsert.map(message => message.id));
  const messages: MessageWrite[] = [];
  for (const [id, row] of messageLocations(after)) {
    const old = previous.get(id);
    if (!old || forced.has(id) || old.blockId !== row.blockId || old.position !== row.position
      || old.message.content !== row.message.content || old.message.role !== row.message.role
      || old.message.createdAt !== row.message.createdAt || old.message.threadId !== row.message.threadId
      || (old.message.toolCalls !== row.message.toolCalls && !isDeepStrictEqual(old.message.toolCalls, row.message.toolCalls))) messages.push(row);
    previous.delete(id);
  }
  return { changed, removed, messages, deletedMessages: new Set([...previous.keys(), ...(rawDelta?.deleteIds ?? [])]),
    graph: !isDeepStrictEqual([before.graphNodes, before.graphEdges, before.graphProjectionJobs], [after.graphNodes, after.graphEdges, after.graphProjectionJobs]),
    topics: !isDeepStrictEqual(before.memoryTopicState, after.memoryTopicState) };
}

export function hasRecordChanges(before: StrataGateSnapshot, after: StrataGateSnapshot): boolean {
  const changes = snapshotWriteSet(before, after);
  return changes.graph || [...changes.changed.values(), ...changes.removed.values()].some(ids => ids.size > 0)
    || changes.messages.length > 0 || changes.deletedMessages.size > 0;
}
