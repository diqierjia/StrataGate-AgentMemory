import { dreamingTopicVersion, type DreamingChangeItem, type DreamingCommand, type DreamingRun, type DreamingUnit } from './dreaming.js';
import { legacyMemoryTopicEventFingerprints, memoryTopicEventFingerprint, type MemoryTopicState } from './topics.js';
import type { EventCard, EventTemporal, MemoryBlock, MemoryScope, RawMessage } from './types.js';

export interface DreamingEventEdit {
  kind: 'create' | 'update' | 'delete' | 'merge' | 'supersede';
  id?: string;
  otherIds?: string[];
  title?: string;
  summary?: string;
  scope?: MemoryScope;
  temporal?: EventTemporal;
  sourceMessageIds?: string[];
  reason?: string;
}

export interface DreamingExperienceEdit {
  kind: 'create' | 'update' | 'merge' | 'delete';
  id?: string;
  otherIds?: string[];
  title?: string;
  content?: string;
  scope?: MemoryScope;
  sourceMessageIds?: string[];
  sourceEventIds?: string[];
}

export type DreamingEditResult = {
  id?: string;
  saved: boolean;
  experiencesToReview?: string[];
  unreadSourceMessageIds?: string[];
  warning?: string;
};
export type DreamingClaim = { id: string; owner: string; epoch: number };
export const DREAMING_AUTO_INTERVAL = 24 * 60 * 60_000;
export const DREAMING_IDLE_TIME = 30 * 60_000;

/** Accumulate committed user-visible changes in execution order. */
export function recordDreamingChange(run: DreamingRun, delta: {
  editedEvents?: number;
  deletedEvents?: number;
  experiences?: number;
  items?: DreamingChangeItem[];
}): void {
  const current = (run.changes ??= { editedEvents: 0, deletedEvents: 0, experiences: 0, items: [] });
  current.editedEvents += delta.editedEvents ?? 0;
  current.deletedEvents += delta.deletedEvents ?? 0;
  current.experiences += delta.experiences ?? 0;
  current.items.push(...(delta.items ?? []));
}

export function dreamingEventVersion(event: EventCard): string {
  return memoryTopicEventFingerprint(event);
}

export interface DreamingDiscovery {
  versions: Record<string, string>;
  units: DreamingUnit[];
}

/** Pointer decay, retrieval and maintenance timestamps are not new user content. */
export function discoverDreaming(blocks: readonly MemoryBlock[], tail: readonly RawMessage[], events: readonly EventCard[],
  previous: Record<string, string> = {}, notes: Record<string, string> = {}, reviewIds: string[] = []): DreamingDiscovery {
  const versions: Record<string, string> = {};
  const changes: DreamingDiscovery['units'] = [];
  for (const id of reviewIds) changes.push({ topicId: '', eventIds: [], experienceIds: [id] });
  for (const block of blocks) {
    const key = `block:${block.id}`;
    versions[key] = dreamingTopicVersion([block.l0Title, block.l1Summary, block.l2Keypoints, block.processingStatus, block.l5Raw.map(message => message.id)]);
    if (versions[key] !== previous[key]) changes.push({ topicId: '', eventIds: [], blockIds: [block.id] });
  }
  for (const message of tail) {
    const key = `message:${message.id}`;
    versions[key] = dreamingTopicVersion(message);
    if (versions[key] !== previous[key]) changes.push({ topicId: '', eventIds: [], messageIds: [message.id] });
  }
  for (const event of events) {
    const key = `event:${event.id}`;
    // No weight/lastRetrievedAt fields: reading must not schedule another round.
    versions[key] = dreamingEventVersion(event);
    const prev = previous[key];
    const unchanged = prev === versions[key] || (prev !== undefined && legacyMemoryTopicEventFingerprints(event).includes(prev));
    if (!unchanged) changes.push({ topicId: '', eventIds: [event.id] });
  }
  for (const [date, version] of Object.entries(notes)) {
    versions[`note:${date}`] = version;
    if (version !== previous[`note:${date}`]) changes.push({ topicId: '', eventIds: [], noteDates: [date] });
  }
  const units: DreamingDiscovery['units'] = [];
  // Batching is navigation/context paging, never an evidence or write quota.
  for (let offset = 0; offset < changes.length; offset += 24) {
    const page = changes.slice(offset, offset + 24);
    units.push({ topicId: '', eventIds: page.flatMap(item => item.eventIds), blockIds: page.flatMap(item => item.blockIds ?? []),
      messageIds: page.flatMap(item => item.messageIds ?? []), noteDates: page.flatMap(item => item.noteDates ?? []),
      experienceIds: page.flatMap(item => item.experienceIds ?? []) });
  }
  return { versions, units };
}

/** Common claim/pause/usage handling lives in V1's reducer; V2 only replaces directory batching gates. */
export function updateDreamingMemory(state: MemoryTopicState, run: DreamingRun, command: DreamingCommand, events: readonly EventCard[]): DreamingRun | undefined {
  if (command.kind === 'memory-write') {
    return structuredClone(run);
  } else if (command.kind === 'prepare') {
    run.activity = '正在调查和整理记忆';
  } else if (command.kind === 'checkpoint') {
    const trace = command.trace;
    const result = trace.result as { error?: string; content?: string; contentVersion?: string; offset?: number; nextOffset?: number | null; sourceRefs?: Record<string, string>; date?: string; version?: string };
    run.idleModelSteps = 0;
    if (trace.tool === 'dreaming_search' && trace.args.kind === 'experiences' && !result?.error) run.searchedExperiences = true;
    if (trace.tool === 'dreaming_daily_write' && result.date && result.version) {
      (run.discoveryVersions ??= {})[`note:${result.date}`] = result.version;
      run.changedBatches++;
      recordDreamingChange(run, { items: [{ kind: 'daily-note', id: result.date, label: `${result.date} 每日笔记`, date: result.date }] });
    }
    if (trace.tool === 'dreaming_read' && typeof result?.content === 'string' && result.contentVersion && result.offset !== undefined) {
      const key = JSON.stringify([trace.args.kind, trace.args.id, trace.args.level ?? null]);
      const previous = run.navigationReads?.[key];
      const next = previous?.contentVersion === result.contentVersion ? previous.nextOffset : 0;
      if (result.offset === next) {
        (run.navigationReads ??= {})[key] = { contentVersion: result.contentVersion, nextOffset: result.nextOffset ?? -1 };
        if (result.nextOffset === null) Object.assign(run.readVersions ??= {}, result.sourceRefs);
      }
    }
    for (const id of command.evidenceIds ?? []) {
      const event = events.find(event => event.id === id);
      if (event) (run.readVersions ??= {})[`event:${id}`] = dreamingEventVersion(event);
    }
    // Only identical consecutive calls with identical results count as a loop.
    // Different exploratory queries (even empty ones) are legitimate investigation.
    const signature = dreamingTopicVersion(trace);
    const same = run.lastToolSignature === signature;
    run.lastToolSignature = signature;
    run.idleCalls = same ? run.idleCalls + 1 : 0;
    run.trace.push({ tool: trace.tool, args: { kind: trace.args.kind, id: trace.args.id, offset: trace.args.offset },
      result: result?.error ? { error: result.error.slice(0, 500) } : { ok: true } });
    if (run.trace.length > 12) run.trace.shift();
    if (result?.error && ['dreaming_directory', 'dreaming_event', 'dreaming_experience', 'dreaming_daily_write'].includes(trace.tool)) {
      run.lastWriteFailure = { args: { tool: trace.tool, kind: trace.args.kind, id: trace.args.id }, error: result.error.slice(0, 500) };
    }
    if (run.status === 'pausing' || run.idleCalls >= 11) {
      run.status = 'paused'; run.leaseUntil = null; run.activity = '已暂停';
      if (run.idleCalls >= 11) run.reason = '相同工具及结果连续重复，没有有效进展；已保存断点';
    }
  } else if (command.kind === 'finish-unit') {
    run.cursor++; run.idleCalls = 0; run.idleModelSteps = 0;
    delete run.lastToolSignature;
    if (run.cursor >= run.units.length) {
      run.status = 'completed'; run.leaseUntil = null; run.activity = '本轮整理完成';
      state.dreamingWatermark = { ...run.discoveryVersions };
    }
  } else return undefined;
  return structuredClone(run);
}
