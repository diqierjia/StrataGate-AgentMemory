import { createHash, randomUUID } from 'node:crypto';
import { memoryTopicEventFingerprint, memoryTopicMembershipSections, memoryTopicOverviewMatchesSection, type MemoryTopicState, type MemoryTopicOverview } from './topics.js';
import { validateTopicOverviewText } from './topic-diagnostics.js';
import type { EventCard } from './types.js';
import { estimateTokens } from './blocks.js';
import { uniqueTopicOverviewEntries } from './topic-overview-repair.js';

export const DREAMING_POLICY_VERSION = 1;
export const DREAMING_LEASE_MS = 90_000;
/** A context page, never a whole-run model-call allowance. */
export const DREAMING_EVENT_PAGE = 24;
export const DREAMING_SOURCE_PAGE_CHARACTERS = 12_000;
/** A generous per-batch write boundary; explicit resume grants another window. */
export const DREAMING_BATCH_WRITE_LIMIT = 64;
const DREAMING_IDLE_CALL_LIMIT = 12;
export interface DreamingUnit { topicId: string; eventIds: string[] }
export interface DreamingTrace { tool: string; args: Record<string, unknown>; result: unknown }
export interface DreamingRun {
  id: string; policyVersion: number; scope: 'directory';
  status: 'running' | 'pausing' | 'paused' | 'completed' | 'terminated';
  owner: string; epoch: number; leaseUntil: string | null;
  sessionId?: string;
  units: DreamingUnit[]; cursor: number; sourceVersions: Record<string, string>;
  evidenceVersions: Record<string, string>; topicVersion: string | null;
  trace: DreamingTrace[]; calls: number; estimatedTokens: number; changedBatches: number;
  readOffsets: Record<string, number>; idleCalls: number;
  readContentVersions?: Record<string, string>; idleModelSteps?: number; checkpointChanges?: number;
  navigationReads?: Record<string, { contentVersion: string; nextOffset: number }>;
  directoryReads?: Record<string, { contentVersion: string; indices: number[] }>;
  lastWriteFailure?: { args: Record<string, unknown>; error: string };
  contentVersions?: string[];
  batchWriteStart?: number;
  /** Reserve the directory immediately, but let an already-claimed projection drain. */
  waitingForProjection?: boolean;
  pendingAllowedEventIds?: string[];
  replanRequired?: boolean;
  /** Legacy persisted field, cleared on resume; no cumulative token limit. */
  tokenLimit: number | null; activity: string; reason: string | null;
  createdAt: string; updatedAt: string;
}
export type DreamingDirectoryOperation =
  | { kind: 'rename-chapter'; title: string; description?: string }
  | { kind: 'rename-section'; from: string; title: string }
  | { kind: 'merge-sections'; from: string[]; title: string }
  | { kind: 'move-events'; eventIds: string[]; title: string }
  | { kind: 'set-overview' | 'append-overview'; title: string; entries: MemoryTopicOverview[] }
  | { kind: 'rewrite-overview'; titles: string[]; entries: Array<MemoryTopicOverview & { title: string }> };
export type DreamingCommand =
  | { kind: 'start'; owner: string; allowedEventIds?: string[] }
  | { kind: 'resume'; id: string; owner: string }
  | { kind: 'pause'; id: string }
  | { kind: 'terminate'; id: string }
  | { kind: 'heartbeat' | 'prepare' | 'finish-unit'; id: string; owner: string; epoch: number }
  | { kind: 'checkpoint'; id: string; owner: string; epoch: number; trace: DreamingTrace; evidenceIds?: string[]; estimatedTokens: number }
  | { kind: 'bind-session'; id: string; owner: string; epoch: number; sessionId: string }
  | { kind: 'model-step'; id: string; owner: string; epoch: number; estimatedTokens: number }
  | { kind: 'model-usage'; id: string; owner: string; epoch: number; estimatedTokens: number }
  | { kind: 'apply'; id: string; owner: string; epoch: number; operations: DreamingDirectoryOperation[] }
  | { kind: 'suspend'; id: string; owner: string; epoch: number; reason: string; replanRequired?: boolean };

export function dreamingTopicVersion(topic: unknown): string {
  return createHash('sha256').update(JSON.stringify(topic)).digest('hex');
}
/** Persisted offsets address this canonical byte-independent character sequence. */
export function dreamingEventContent(event: EventCard): string {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)])) : value;
  return JSON.stringify(canonical(event));
}
export function dreamingEventContentVersion(event: EventCard): string {
  return createHash('sha256').update(dreamingEventContent(event)).digest('hex');
}
function label(value: unknown, maximum = 80): string {
  if (typeof value !== 'string' || !value.trim() || Array.from(value.trim()).length > maximum) throw new Error('Invalid directory label');
  return value.trim();
}
export function memoryTopicSectionIdentity(title: string): string {
  return 'section:' + createHash('sha256').update(title.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase()).digest('hex');
}
function live(event: EventCard): boolean { return event.status !== 'forgotten' && event.status !== 'archived'; }
function directoryContent(topic: MemoryTopicState['topics'][number]): string {
  return dreamingTopicVersion({ title: topic.title, description: topic.description, overview: topic.overview,
    sections: memoryTopicMembershipSections(topic).map(section => ({ title: section.title, sourceEventIds: section.sourceEventIds })) });
}

function planUnits(state: MemoryTopicState, sources: Map<string, EventCard>): DreamingUnit[] {
  return state.topics.filter(t => !t.invalidated && t.sourceEventIds.length && t.sourceEventIds.every(id => sources.has(id))).flatMap(topic => {
    const pages: DreamingUnit[] = [];
    let batch: string[] = [], tokens = 0;
    for (const id of topic.sourceEventIds) {
      const size = Math.min(4000, estimateTokens(JSON.stringify(sources.get(id))));
      if (batch.length && (batch.length >= DREAMING_EVENT_PAGE || tokens + size > 10_000)) { pages.push({ topicId: topic.id, eventIds: batch }); batch = []; tokens = 0; }
      batch.push(id); tokens += size;
    }
    if (batch.length) pages.push({ topicId: topic.id, eventIds: batch });
    return pages;
  });
}

function requireReplan(run: DreamingRun): DreamingRun {
  run.status = 'paused'; run.leaseUntil = null; run.activity = '需要重新开始'; run.replanRequired = true;
  run.reason = '目录或来源在整理期间发生变化，请终止本轮后重新开始；已保存的修改会保留，继续本轮无法解除冲突';
  return structuredClone(run);
}

/** Called exclusively inside the existing Core commit transaction. */
export function updateDreaming(state: MemoryTopicState, events: readonly EventCard[], command: DreamingCommand, now: string): DreamingRun {
  const allowed = command.kind === 'start' && command.allowedEventIds ? new Set(command.allowedEventIds) : null;
  const sources = new Map(events.filter(event => live(event) && (!allowed || allowed.has(event.id))).map(event => [event.id, event]));
  let run = state.dreaming;
  if (command.kind === 'start') {
    if (run && ['running', 'pausing', 'paused'].includes(run.status)) throw new Error('A Dreaming run already exists; resume or terminate it');
    const units = planUnits(state, sources);
    const waitingForProjection = state.jobs.some(job => job.status === 'running' && Date.parse(job.leaseUntil ?? job.updatedAt) > Date.parse(now));
    if (!units.length && !waitingForProjection) throw new Error('尚无可整理的目录章节');
    run = { id: `dream_${randomUUID()}`, policyVersion: DREAMING_POLICY_VERSION, scope: 'directory', status: 'running', owner: command.owner,
      epoch: 1, leaseUntil: new Date(Date.parse(now) + DREAMING_LEASE_MS).toISOString(), units, cursor: 0,
      sourceVersions: Object.fromEntries([...sources].map(([id, event]) => [id, memoryTopicEventFingerprint(event)])),
      evidenceVersions: {}, topicVersion: null, trace: [], calls: 0, estimatedTokens: 0, changedBatches: 0, readOffsets: {}, idleCalls: 0,
      tokenLimit: null, activity: '正在读取目录', reason: null, createdAt: now, updatedAt: now };
    if (waitingForProjection) {
      run.waitingForProjection = true;
      if (command.allowedEventIds) run.pendingAllowedEventIds = [...command.allowedEventIds];
      run.activity = '等待当前后台目录整理完成，随后开始 Dreaming';
    }
    state.dreaming = run;
    return structuredClone(run);
  }
  if (!run || run.id !== command.id) throw new Error('Unknown Dreaming run');
  if (command.kind === 'terminate') {
    if (run.status === 'completed' || run.status === 'terminated') return structuredClone(run);
    run.status = 'terminated'; run.epoch++; run.leaseUntil = null; run.activity = '已终止'; run.updatedAt = now;
    return structuredClone(run);
  }
  if (command.kind === 'pause') {
    if (run.status === 'running') { run.status = 'pausing'; run.activity = '正在暂停，等待当前步骤结束'; run.updatedAt = now; }
    return structuredClone(run);
  }
  if (command.kind === 'resume') {
    const expired = !!run.leaseUntil && Date.parse(run.leaseUntil) <= Date.parse(now);
    if (run.status !== 'paused' && !(expired && ['running', 'pausing'].includes(run.status))) throw new Error('Dreaming is not paused');
    if (run.policyVersion !== DREAMING_POLICY_VERSION) throw new Error('Dreaming policy changed; terminate this run and start again');
    if (run.replanRequired) throw new Error(run.reason ?? '请终止本轮后重新开始；已保存的修改会保留');
    if (!run.waitingForProjection && run.topicVersion) {
      const unit = run.units[run.cursor];
      const topic = state.topics.find(t => t.id === unit?.topicId && !t.invalidated);
      if (!topic || dreamingTopicVersion(topic) !== run.topicVersion
        || unit?.eventIds.some(id => !sources.has(id) || memoryTopicEventFingerprint(sources.get(id)!) !== run.sourceVersions[id])) {
        run.updatedAt = now;
        return requireReplan(run);
      }
    }
    run.tokenLimit = null;
    run.status = 'running'; run.owner = command.owner; run.epoch++; run.reason = null;
    run.idleCalls = 0; run.idleModelSteps = 0;
    run.batchWriteStart = run.changedBatches;
    run.activity = '正在继续'; run.leaseUntil = new Date(Date.parse(now) + DREAMING_LEASE_MS).toISOString(); run.updatedAt = now;
    return structuredClone(run);
  }
  const finalUsage = run.status === 'completed' && (command.kind === 'model-step' || command.kind === 'model-usage');
  // A renewal already queued when finish-unit commits must not kill the final
  // response. A completed claim is read-only here: never renew its lease.
  const finalHeartbeat = run.status === 'completed' && command.kind === 'heartbeat';
  if (run.owner !== command.owner || run.epoch !== command.epoch || (!finalUsage && !finalHeartbeat && (!['running', 'pausing'].includes(run.status)
    || !run.leaseUntil || Date.parse(run.leaseUntil) <= Date.parse(now)))) throw new Error('Dreaming claim changed or expired');
  if (finalHeartbeat) return structuredClone(run);
  run.updatedAt = now;
  if (!finalUsage) run.leaseUntil = new Date(Date.parse(now) + DREAMING_LEASE_MS).toISOString();
  if (command.kind === 'heartbeat') return structuredClone(run);
  if (command.kind === 'bind-session') {
    if (run.sessionId && run.sessionId !== command.sessionId) throw new Error('Dreaming session identity changed');
    run.sessionId = command.sessionId; return structuredClone(run);
  }
  if (command.kind === 'suspend' || (run.status === 'pausing' && command.kind !== 'checkpoint')) {
    run.status = 'paused'; run.leaseUntil = null; run.activity = '已暂停';
    run.reason = command.kind === 'suspend' ? command.reason : null;
    if (command.kind === 'suspend' && command.replanRequired) run.replanRequired = true;
    return structuredClone(run);
  }
  if (command.kind === 'model-step' || command.kind === 'model-usage') {
    if (!Number.isSafeInteger(command.estimatedTokens) || command.estimatedTokens < 0) throw new Error('Invalid consumption estimate');
    if (command.kind === 'model-step') {
      if (!finalUsage) {
        run.idleModelSteps = (run.idleModelSteps ?? 0) + 1;
        if (run.idleModelSteps >= 8) {
          run.status = 'paused'; run.leaseUntil = null; run.activity = '已暂停'; run.reason = '连续模型步骤没有有效工具进展，断点已保存';
          return structuredClone(run);
        }
      }
      run.calls++;
    }
    run.estimatedTokens += command.estimatedTokens;
    return structuredClone(run);
  }
  if (command.kind === 'prepare' && run.waitingForProjection) {
    if (state.jobs.some(job => job.status === 'running' && Date.parse(job.leaseUntil ?? job.updatedAt) > Date.parse(now))) {
      run.activity = '等待当前后台目录整理完成，随后开始 Dreaming';
      return structuredClone(run);
    }
    // No work has been sent to the model yet. Freeze the post-drain directory,
    // including new chapters from the pre-existing projection, exactly once.
    const pendingAllowed = run.pendingAllowedEventIds && new Set(run.pendingAllowedEventIds);
    const freshSources = new Map(events.filter(event => live(event) && (!pendingAllowed || pendingAllowed.has(event.id))).map(event => [event.id, event]));
    run.units = planUnits(state, freshSources);
    run.sourceVersions = Object.fromEntries([...freshSources].map(([id, event]) => [id, memoryTopicEventFingerprint(event)]));
    delete run.waitingForProjection; delete run.pendingAllowedEventIds;
    if (!run.units.length) {
      run.status = 'completed'; run.leaseUntil = null; run.activity = '暂无可整理的目录章节';
      return structuredClone(run);
    }
  }
  if (run.waitingForProjection) throw new Error('Dreaming is waiting for the current directory projection');
  const unit = run.units[run.cursor];
  if (!unit) throw new Error('No remaining Dreaming unit');
  const topic = state.topics.find(t => t.id === unit.topicId && !t.invalidated);
  if (!topic || unit.eventIds.some(id => !sources.has(id) || memoryTopicEventFingerprint(sources.get(id)!) !== run.sourceVersions[id])) {
    if (command.kind === 'prepare') return requireReplan(run);
    throw new Error('Dreaming sources changed; terminate and replan');
  }
  if (command.kind === 'prepare') {
    if (run.topicVersion && dreamingTopicVersion(topic) !== run.topicVersion) return requireReplan(run);
    run.batchWriteStart ??= run.changedBatches;
    if (!run.topicVersion) {
      run.batchWriteStart = run.changedBatches;
      run.topicVersion = dreamingTopicVersion(topic);
      run.evidenceVersions = Object.fromEntries(unit.eventIds.filter(id => dreamingEventContent(sources.get(id)!).length <= DREAMING_SOURCE_PAGE_CHARACTERS).map(id => [id, run.sourceVersions[id]!]));
      run.trace = [];
      run.readOffsets = {}; run.readContentVersions = {}; run.navigationReads = {}; run.idleCalls = 0; run.idleModelSteps = 0;
      run.directoryReads ??= {};
      delete run.lastWriteFailure;
      run.contentVersions = [directoryContent(topic)];
    }
    // Older checkpoints used insertion-order JSON. Never continue those offsets.
    run.readContentVersions ??= {};
    for (const id of Object.keys(run.readOffsets)) {
      const event = sources.get(id);
      if (!event) continue;
      const version = dreamingEventContentVersion(event);
      if (run.readContentVersions[id] !== version) {
        run.readOffsets[id] = 0; run.readContentVersions[id] = version;
        delete run.evidenceVersions[id];
      }
    }
    for (const id of unit.eventIds) if (dreamingEventContent(sources.get(id)!).length <= DREAMING_SOURCE_PAGE_CHARACTERS) run.evidenceVersions[id] = run.sourceVersions[id]!;
    run.activity = `正在整理「${topic.title}」`;
  } else if (command.kind === 'checkpoint') {
    const previousEvidence = Object.keys(run.evidenceVersions).length;
    let pageProgress = false;
    for (const id of command.evidenceIds ?? []) {
      const event = sources.get(id);
      if (!event || run.sourceVersions[id] !== memoryTopicEventFingerprint(event)) throw new Error('Dreaming evidence changed or is outside the frozen run');
      if (dreamingEventContent(event).length <= DREAMING_SOURCE_PAGE_CHARACTERS
        || (run.readOffsets[id] === -1 && run.readContentVersions?.[id] === dreamingEventContentVersion(event))) run.evidenceVersions[id] = run.sourceVersions[id]!;
    }
    if (command.trace.tool === 'dreaming_read' && command.trace.args.kind === 'event') {
      const result = command.trace.result as { id?: string; content?: string; contentVersion?: string; totalCharacters?: number; offset?: number; nextOffset?: number | null; level?: number };
      const event = result?.id && sources.get(result.id);
      const content = event ? dreamingEventContent(event) : '';
      const version = event ? dreamingEventContentVersion(event) : '';
      if (event && result.id === command.trace.args.id && result.contentVersion === version && typeof result.content === 'string'
        && result.content.length > 0 && result.totalCharacters === content.length
        && result.offset === (run.readOffsets[result.id!] ?? 0) && result.offset >= 0
        && result.content === content.slice(result.offset, result.offset + result.content.length)
        && result.nextOffset === (result.offset + result.content.length < content.length ? result.offset + result.content.length : null)
        && (result.offset === 0 || run.readContentVersions?.[result.id!] === version)) {
        run.readContentVersions ??= {}; run.readContentVersions[result.id!] = version;
        pageProgress = true;
        if (result.nextOffset === null) {
          if (run.sourceVersions[event.id] === memoryTopicEventFingerprint(event)) run.evidenceVersions[event.id] = run.sourceVersions[event.id]!;
          run.readOffsets[event.id] = -1;
        } else if (typeof result.nextOffset === 'number' && result.nextOffset > result.offset) run.readOffsets[event.id] = result.nextOffset;
      }
    }
    if (command.trace.tool === 'dreaming_read' && ['block', 'graph_node'].includes(String(command.trace.args.kind))) {
      const result = command.trace.result as { id?: string; content?: string; contentVersion?: string; totalCharacters?: number; offset?: number; nextOffset?: number | null; level?: number };
      const key = JSON.stringify([command.trace.args.kind, command.trace.args.id, result?.level ?? command.trace.args.level ?? null]);
      const prior = run.navigationReads?.[key];
      if (result?.id === command.trace.args.id && typeof result.contentVersion === 'string' && typeof result.content === 'string'
        && result.content.length > 0 && typeof result.offset === 'number' && result.offset >= 0
        && result.offset === (prior?.nextOffset ?? 0) && (!prior || prior.contentVersion === result.contentVersion)
        && typeof result.totalCharacters === 'number' && result.offset + result.content.length <= result.totalCharacters
        && result.nextOffset === (result.offset + result.content.length < result.totalCharacters ? result.offset + result.content.length : null)) {
        run.navigationReads ??= {};
        run.navigationReads[key] = { contentVersion: result.contentVersion, nextOffset: result.nextOffset ?? -1 };
        pageProgress = true;
      }
    }
    if (command.trace.tool === 'memory_list_topics') {
      const result = command.trace.result as { offset?: number; topics?: Array<{ id: string; title: string; description: string; sourceEventCount: number }> };
      if (result?.offset === (command.trace.args.offset ?? 0) && Array.isArray(result.topics)) {
        for (const item of result.topics) {
          const listed: MemoryTopicState['topics'][number] | undefined = state.topics.find(t => !t.invalidated && t.id === item.id && t.title === item.title
            && t.description === item.description && t.sourceEventIds.length === item.sourceEventCount
            && t.sourceEventIds.every(id => sources.has(id) && run.sourceVersions[id] === memoryTopicEventFingerprint(sources.get(id)!)));
          if (!listed) continue;
          // Track the actual navigation item across queries/pages, so changing
          // keywords or page size cannot turn a reread into fresh progress.
          const key = JSON.stringify([listed.id, 'listing']);
          const version = dreamingTopicVersion({ id: listed.id, title: listed.title, description: listed.description });
          run.directoryReads ??= {};
          if (run.directoryReads[key]?.contentVersion !== version) {
            run.directoryReads[key] = { contentVersion: version, indices: [0] };
            pageProgress = true;
          }
        }
      }
    }
    if (command.trace.tool === 'memory_expand_topic') {
      const readTopic = state.topics.find(t => t.id === command.trace.args.id && !t.invalidated
        && t.sourceEventIds.every(id => sources.has(id) && run.sourceVersions[id] === memoryTopicEventFingerprint(sources.get(id)!)));
      const result = command.trace.result as { id?: string; sections?: unknown; overview?: unknown };
      if (readTopic && result?.id === readTopic.id) {
        for (const [field, items] of [['sections', memoryTopicMembershipSections(readTopic)], ['overview', readTopic.overview]] as const) {
          const page = result[field] as { contentVersion?: string; items?: unknown[]; offset?: number; total?: number; nextOffset?: number | null } | undefined;
          if (!page || !Number.isSafeInteger(page.offset) || page.offset! < 0 || !Array.isArray(page.items) || !page.items.length
            || page.total !== items.length || page.offset! + page.items.length > items.length
            || page.contentVersion !== dreamingTopicVersion(items)
            || JSON.stringify(page.items) !== JSON.stringify(items.slice(page.offset, page.offset! + page.items.length))
            || page.nextOffset !== (page.offset! + page.items.length < items.length ? page.offset! + page.items.length : null)) continue;
          const key = JSON.stringify([readTopic.id, field]);
          run.directoryReads ??= {};
          const previous = run.directoryReads[key];
          const seen = new Set(previous?.contentVersion === page.contentVersion ? previous.indices : []);
          for (let i = page.offset!; i < page.offset! + page.items.length; i++) {
            if (!seen.has(i)) pageProgress = true;
            seen.add(i);
          }
          run.directoryReads[key] = { contentVersion: page.contentVersion, indices: [...seen].sort((a, b) => a - b) };
        }
      }
    }
    if (command.trace.tool === 'dreaming_directory') {
      const result = command.trace.result as { error?: string; saved?: boolean };
      if (typeof result?.error === 'string') run.lastWriteFailure = { args: structuredClone(command.trace.args), error: result.error };
      else if (result?.saved) delete run.lastWriteFailure;
    }
    const progress = pageProgress || Object.keys(run.evidenceVersions).length > previousEvidence || run.changedBatches > (run.checkpointChanges ?? 0);
    run.idleCalls = progress ? 0 : run.idleCalls + 1;
    run.idleModelSteps = 0; run.checkpointChanges = run.changedBatches;
    run.trace.push(structuredClone(command.trace));
    // Persist all facts separately; the model transcript is a working window.
    if (run.trace.length > 12) run.trace.shift();
    if (!run.sessionId) run.calls++;
    run.estimatedTokens += command.estimatedTokens;
    run.activity = command.trace.tool === 'dreaming_search' ? '正在检索记忆' : command.trace.tool === 'dreaming_read' ? '正在查阅来源' : '正在整理目录';
    if (run.status === 'pausing' || run.idleCalls >= DREAMING_IDLE_CALL_LIMIT) {
      run.status = 'paused'; run.leaseUntil = null; run.activity = '已暂停';
      if (run.idleCalls >= DREAMING_IDLE_CALL_LIMIT) run.reason = '连续调用没有有效进展，断点已保存';
    }
  } else if (command.kind === 'apply') {
    if (dreamingTopicVersion(topic) !== run.topicVersion) throw new Error('Directory changed during Dreaming');
    for (const [id, version] of Object.entries(run.evidenceVersions)) {
      if (!sources.has(id) || memoryTopicEventFingerprint(sources.get(id)!) !== version) throw new Error('Dreaming evidence changed');
    }
    const updated = structuredClone(topic);
    const sections = updated.sections = memoryTopicMembershipSections(updated);
    for (const section of sections) section.id ??= memoryTopicSectionIdentity(section.title);
    const members = new Set(updated.sourceEventIds);
    if (!Array.isArray(command.operations) || !command.operations.length) throw new Error('Directory operations are required');
    for (const op of command.operations) {
      if (!op || typeof op !== 'object' || typeof op.kind !== 'string') throw new Error('Each operations item must directly contain kind; do not nest another operations array. Example: {kind:"append-overview",title:"section",entries:[{kind:"experience",text:"source-backed fact",sourceEventIds:["event-id"]}]}');
      if (op.kind === 'rename-chapter') {
        updated.title = label(op.title, 120);
        if (state.topics.some(t => t.id !== topic.id && !t.invalidated && t.title.trim().toLowerCase() === updated.title.toLowerCase())) throw new Error('Duplicate chapter title');
        if (op.description !== undefined) {
          if (typeof op.description !== 'string' || !op.description.trim() || Array.from(op.description).length > 400) throw new Error('Invalid chapter description');
          updated.description = op.description;
        }
      } else if (op.kind === 'rename-section') {
        const section = sections.find(s => s.title === op.from);
        if (!section) throw new Error('Unknown section');
        const title = label(op.title);
        if (sections.some(s => s !== section && s.title.toLowerCase() === title.toLowerCase())) throw new Error('Duplicate section');
        section.title = title;
        for (const part of updated.overview) if (memoryTopicOverviewMatchesSection(part, [op.from])) part.title = title;
      } else if (op.kind === 'merge-sections') {
        if (!Array.isArray(op.from) || op.from.length < 2 || new Set(op.from).size !== op.from.length || op.from.some(t => !sections.some(s => s.title === t))) throw new Error('Invalid merge sources');
        const title = label(op.title);
        if (sections.some(s => !op.from.includes(s.title) && s.title.toLowerCase() === title.toLowerCase())) throw new Error('Duplicate section');
        const ids = [...new Set(sections.filter(s => op.from.includes(s.title)).flatMap(s => s.sourceEventIds))];
        const merged = sections.filter(s => op.from.includes(s.title));
        const stableId = merged[0]!.id!;
        updated.sectionAliases ??= {};
        for (const section of merged) if (section.id !== stableId) updated.sectionAliases[section.id!] = stableId;
        for (const [old, target] of Object.entries(updated.sectionAliases)) if (merged.some(section => section.id === target)) updated.sectionAliases[old] = stableId;
        for (let i = sections.length - 1; i >= 0; i--) if (op.from.includes(sections[i]!.title)) sections.splice(i, 1);
        sections.push({ id: stableId, title, sourceEventIds: ids });
        for (const part of updated.overview) if (memoryTopicOverviewMatchesSection(part, op.from)) part.title = title;
      } else if (op.kind === 'move-events') {
        const title = label(op.title);
        if (!Array.isArray(op.eventIds) || !op.eventIds.length || op.eventIds.some(id => !unit.eventIds.includes(id) || !members.has(id))) throw new Error('Membership changes must belong to the current batch');
        let target = sections.find(s => s.title === title);
        if (!target) { target = { id: `section:${randomUUID()}`, title, sourceEventIds: [] }; sections.push(target); }
        for (const section of sections) section.sourceEventIds = section.sourceEventIds.filter(id => !op.eventIds.includes(id));
        target.sourceEventIds.push(...new Set(op.eventIds));
      } else if (op.kind === 'set-overview' || op.kind === 'append-overview' || op.kind === 'rewrite-overview') {
        const titles = op.kind === 'rewrite-overview' ? op.titles : [op.title];
        if (!Array.isArray(titles) || !titles.length || titles.some(title => label(title) !== title)
          || new Set(titles).size !== titles.length) throw new Error('overview-sections-invalid: titles must be distinct existing section names');
        for (const title of titles) if (!sections.some(s => s.title === title)) throw new Error(`overview-section-unknown: ${JSON.stringify(title)}; create it with move-events before writing its overview`);
        if (!Array.isArray(op.entries)) throw new Error('overview-entries-invalid: entries must be an array');
        const requireEvidence = (id: string): void => {
          if (typeof id !== 'string' || !sources.has(id)) throw new Error(`overview-source-unavailable: Event ${JSON.stringify(id)} is unknown, changed or outside the frozen run; use an available current-chapter Event`);
          if (!members.has(id)) throw new Error(`overview-source-not-in-chapter: Event ${JSON.stringify(id)} does not belong to current chapter ${JSON.stringify(topic.id)}; reading it will not authorize this citation`);
          if (!run.evidenceVersions[id]) throw new Error(`overview-source-not-retrieved: Event ${JSON.stringify(id)} needs a complete dreaming_read {kind:"event",id:${JSON.stringify(id)}}; follow nextOffset until null`);
        };
        const entries = op.entries.map((part, index) => {
          if (!part || !['history', 'decision', 'change', 'open-question', 'scope', 'experience'].includes(part.kind)) throw new Error(`overview-kind-invalid: entries[${index}] needs a supported kind`);
          if (!Array.isArray(part.sourceEventIds) || !part.sourceEventIds.length) throw new Error(`overview-sources-empty: entries[${index}] needs sourceEventIds`);
          // Report a foreign citation before asking to retrieve any other source.
          for (const id of part.sourceEventIds) if (!members.has(id)) requireEvidence(id);
          for (const id of part.sourceEventIds) requireEvidence(id);
          validateTopicOverviewText(part.text, `entries[${index}].text`);
          const title = op.kind === 'rewrite-overview' ? part.title : titles[0]!;
          if (typeof title !== 'string' || !titles.includes(title)
            || (part.title !== undefined && part.title !== title)) throw new Error(`overview-entry-section-invalid: entries[${index}].title must name one of ${JSON.stringify(titles)}; set-overview affects only its named section`);
          return { ...part, title };
        });
        const replaced = op.kind === 'append-overview' ? [] : updated.overview.filter(part => memoryTopicOverviewMatchesSection(part, titles));
        const newSources = new Set(entries.flatMap(part => part.sourceEventIds));
        for (const id of new Set(replaced.flatMap(part => part.sourceEventIds))) {
          requireEvidence(id);
          if (!newSources.has(id)) throw new Error(`overview-source-reference-missing: preserve existing overview evidence for Event ${JSON.stringify(id)} across ${JSON.stringify(titles)}; use rewrite-overview to relocate or consolidate facts and references atomically`);
        }
        if (op.kind !== 'append-overview') updated.overview = updated.overview.filter(part => !memoryTopicOverviewMatchesSection(part, titles));
        // Deduplicate only the edited sections; a local rewrite must not clean
        // up unrelated legacy entries elsewhere in the chapter as a side effect.
        const selected = updated.overview.filter(part => memoryTopicOverviewMatchesSection(part, titles));
        const additions = uniqueTopicOverviewEntries([...selected, ...entries]).filter(part => !selected.includes(part));
        updated.overview.push(...additions);
      } else throw new Error('Unsupported directory operation');
    }
    // No Event or chapter membership is deleted by this adapter.
    const contentVersion = directoryContent(updated);
    if (contentVersion === directoryContent(topic) || run.contentVersions?.includes(contentVersion)) throw new Error('Directory operation repeats an unchanged or previous state');
    run.contentVersions = [...(run.contentVersions ?? []), contentVersion].slice(-128);
    updated.updatedAt = now;
    updated.dependencyVersions = { ...updated.dependencyVersions, ...run.evidenceVersions };
    state.topics[state.topics.indexOf(topic)] = updated;
    run.topicVersion = dreamingTopicVersion(updated); run.changedBatches++; run.idleCalls = 0; run.idleModelSteps = 0;
    if (run.changedBatches - (run.batchWriteStart ?? 0) >= DREAMING_BATCH_WRITE_LIMIT) {
      run.status = 'pausing'; run.activity = '正在暂停，保存本批目录修改';
      run.reason = `本批已成功写入 ${DREAMING_BATCH_WRITE_LIMIT} 次，已达到本批写入边界；检查后可以继续`;
    }
  } else if (command.kind === 'finish-unit') {
    if (dreamingTopicVersion(topic) !== run.topicVersion) throw new Error('Directory changed during Dreaming');
    if (unit.eventIds.some(id => run.evidenceVersions[id] !== run.sourceVersions[id]
      || (dreamingEventContent(sources.get(id)!).length > DREAMING_SOURCE_PAGE_CHARACTERS
        && (run.readOffsets[id] !== -1 || run.readContentVersions?.[id] !== dreamingEventContentVersion(sources.get(id)!))))) {
      throw new Error('Read all current-batch Events completely before finishing; use dreaming_read from the saved offset');
    }
    run.cursor++; run.topicVersion = null; run.evidenceVersions = {}; run.trace = [];
    run.idleCalls = 0; run.idleModelSteps = 0;
    run.batchWriteStart = run.changedBatches;
    if (run.cursor === run.units.length) { run.status = 'completed'; run.leaseUntil = null; run.activity = '本轮整理完成'; }
  }
  return structuredClone(run);
}
