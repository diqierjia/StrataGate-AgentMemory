import { dreamingTopicVersion, type DreamingChangeItem, type DreamingCommand, type DreamingPhase, type DreamingRun, type DreamingUnit } from './dreaming.js';
import { legacyMemoryTopicEventFingerprints, memoryTopicEventFingerprint, type MemoryTopicState } from './topics.js';
import type { EventCard, EventTemporal, MemoryBlock, MemoryScope, RawMessage } from './types.js';

export interface DreamingEventEdit {
  kind: 'create' | 'update' | 'delete' | 'merge' | 'supersede';
  id?: string;
  otherIds?: string[];
  title?: string;
  summary?: string;
  scope?: MemoryScope;
  status?: 'active';
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

export function dreamingPhaseActivity(phase: DreamingPhase): string {
  switch (phase) {
    case 'orient': return '阶段 1/4 · 全局定向：浏览主题目录与变动清单';
    case 'gather': return '阶段 2/4 · 按需核实：查阅疑点卡片与局部上下文';
    case 'consolidate': return '阶段 3/4 · 集中整合：修正、合并与固化记忆事实';
    case 'prune': return '阶段 4/4 · 收口索引：微调目录与清理关联索引';
  }
}

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
  const noteDates: string[] = [];
  const unit: DreamingUnit = { topicId: '', eventIds: [], blockIds: [], messageIds: [], noteDates, experienceIds: reviewIds };
  let hasRecentTranscriptChange = false;
  for (const block of blocks) {
    const key = `block:${block.id}`;
    versions[key] = dreamingTopicVersion([block.l0Title, block.l1Summary, block.l2Keypoints, block.processingStatus, block.l5Raw.map(message => message.id)]);
    if (versions[key] !== previous[key]) { unit.blockIds!.push(block.id); hasRecentTranscriptChange = true; }
  }
  for (const message of tail) {
    const key = `message:${message.id}`;
    versions[key] = dreamingTopicVersion(message);
    if (versions[key] !== previous[key]) { unit.messageIds!.push(message.id); hasRecentTranscriptChange = true; }
  }
  for (const event of events) {
    const key = `event:${event.id}`;
    // No weight/lastRetrievedAt fields: reading must not schedule another round.
    versions[key] = dreamingEventVersion(event);
    const prev = previous[key];
    const unchanged = prev === versions[key] || (prev !== undefined && legacyMemoryTopicEventFingerprints(event).includes(prev));
    if (!unchanged) unit.eventIds.push(event.id);
  }
  for (const [date, version] of Object.entries(notes)) {
    versions[`note:${date}`] = version;
    if (version !== previous[`note:${date}`]) noteDates.push(date);
  }
  if (hasRecentTranscriptChange) unit.recentActivity = true;
  return { versions, units: unit.eventIds.length || noteDates.length || reviewIds.length || hasRecentTranscriptChange ? [unit] : [] };
}

/** Common claim/pause/usage handling lives in V1's reducer; V2 only replaces directory batching gates. */
export function updateDreamingMemory(state: MemoryTopicState, run: DreamingRun, command: DreamingCommand, events: readonly EventCard[]): DreamingRun | undefined {
  if (command.kind === 'memory-write') {
    return structuredClone(run);
  } else if (command.kind === 'prepare') {
    // Fold pending work from older persisted runs into a single task.
    const pending = run.units.slice(run.cursor);
    if (pending.length > 1) {
      run.units.splice(run.cursor, pending.length, {
        topicId: '',
        eventIds: [...new Set(pending.flatMap(unit => unit.eventIds))],
        blockIds: [...new Set(pending.flatMap(unit => unit.blockIds ?? []))],
        messageIds: [...new Set(pending.flatMap(unit => unit.messageIds ?? []))],
        noteDates: [...new Set(pending.flatMap(unit => unit.noteDates ?? []))],
        experienceIds: [...new Set(pending.flatMap(unit => unit.experienceIds ?? []))],
        recentActivity: pending.some(unit => unit.recentActivity),
      });
    }
    run.phase ??= 'orient';
    run.activity = dreamingPhaseActivity(run.phase);
  } else if (command.kind === 'checkpoint') {
    const trace = command.trace;
    const result = trace.result as { error?: string; content?: string; contentVersion?: string; offset?: number; nextOffset?: number | null; sourceRefs?: Record<string, string>; date?: string; version?: string };
    run.idleModelSteps = 0;
    if (!result?.error) {
      if (trace.tool === 'dreaming_directory') {
        run.phase = 'prune';
      } else if (trace.tool === 'dreaming_event' || trace.tool === 'dreaming_experience' || trace.tool === 'dreaming_daily_write') {
        if (run.phase !== 'prune') run.phase = 'consolidate';
      } else if (trace.tool === 'dreaming_read' || trace.tool === 'dreaming_search' || trace.tool === 'dreaming_workspace' || trace.tool === 'memory_list_topics' || trace.tool === 'memory_expand_topic') {
        if (!run.phase || run.phase === 'orient') run.phase = 'gather';
      }
      run.activity = dreamingPhaseActivity(run.phase ?? 'orient');
    }
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
    if (run.status === 'pausing') {
      run.status = 'paused'; run.leaseUntil = null; run.activity = '已暂停';
      return structuredClone(run);
    }
    run.cursor++; run.idleCalls = 0; run.idleModelSteps = 0;
    delete run.lastToolSignature;
    if (run.cursor >= run.units.length) {
      run.phase = 'prune';
      run.status = 'completed'; run.leaseUntil = null; run.activity = '本轮整理完成';
      state.dreamingWatermark = { ...run.discoveryVersions };
      if (run.trigger === 'automatic' && command.letterTimeZone) {
        const finishedAt = Date.parse(run.updatedAt);
        const parts = new Intl.DateTimeFormat('en-CA', {
          timeZone: command.letterTimeZone, year: 'numeric', month: '2-digit', day: '2-digit',
        }).formatToParts(finishedAt);
        const date = ['year', 'month', 'day'].map(type => parts.find(part => part.type === type)!.value).join('-');
        run.letterJob = { date, timeZone: command.letterTimeZone, finishedAt };
      }
    } else {
      run.phase = 'orient';
      run.activity = dreamingPhaseActivity('orient');
    }
  } else return undefined;
  return structuredClone(run);
}
