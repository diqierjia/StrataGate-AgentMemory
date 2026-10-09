import { createHash, randomUUID } from 'node:crypto';
import { bm25Rank, weightedSearchTokens } from './search.js';
import type { EventCard } from './types.js';
import { TopicProjectionError, safeTopicDiagnostics, validateTopicOverviewText, type TopicProjectionDiagnostics } from './topic-diagnostics.js';
import { uniqueTopicOverviewEntries, type TopicOverviewRepairRequirement } from './topic-overview-repair.js';

export const MEMORY_TOPIC_PROJECTOR_VERSION = 3;
export const TOPIC_BATCH_LIMIT = 12;
export const TOPIC_CANDIDATE_LIMIT = 12;
export const TOPIC_MAX_ATTEMPTS = 3;
// One writer-open recovery cycle for Issue #119, independent of prose rebuilds.
export const TOPIC_RECOVERY_VERSION = 2;
export const TOPIC_LEASE_MS = 5 * 60_000;
export type MemoryTopicOverviewKind = 'history' | 'decision' | 'change' | 'open-question' | 'scope';

export interface MemoryTopicOverview {
  kind: MemoryTopicOverviewKind;
  /** Lasting category within a chapter, not a single Event, version or incident. */
  title?: string;
  text: string;
  sourceEventIds: string[];
}

export interface MemoryTopicSection {
  title: string;
  /** Directory membership, independent of overview evidence. */
  sourceEventIds: string[];
}

export interface MemoryTopic {
  id: string;
  title: string;
  description: string;
  sourceEventIds: string[];
  overview: MemoryTopicOverview[];
  /** Absent only in legacy snapshots/proposals; migrate from overview sources. */
  sections?: MemoryTopicSection[];
  createdAt: string;
  updatedAt: string;
  coverage: { totalEvents: number; summarizedEvents: number; omittedEvents: number; unassignedEvents?: number };
  isFallback?: boolean;
}

export interface TopicProjectionCandidate {
  id: string;
  title: string;
  description: string;
  overview: MemoryTopicOverview[];
  /** Lightweight labels, including sections outside overview; repairs report omissions. */
  sectionTitles?: string[];
  sectionTitlesOmitted?: number;
  /** Only sources actually exposed in this bounded candidate, not all members. */
  sourceEventIds: string[];
  totalSourceEvents: number;
}

export interface TopicProjectionContext {
  jobId: string;
  overviewRepairRequirements?: TopicOverviewRepairRequirement[] | undefined;
  events: EventCard[];
  existingTopics: TopicProjectionCandidate[];
  /** Extremely large sources are navigation-only until read in full. */
  truncatedEventIds?: string[];
  /** Upgrade repair: assign this batch within its existing chapter only. */
  sectionBackfillTopicId?: string;
}

export interface TopicProjectionProposal {
  topicId?: string;
  title: string;
  description: string;
  sourceEventIds: string[];
  overview: MemoryTopicOverview[];
  sections?: MemoryTopicSection[];
}

export interface TopicProjectionResult { topics: TopicProjectionProposal[] }
export type TopicProjector = (context: TopicProjectionContext) => Promise<TopicProjectionResult>;

export interface StoredMemoryTopic extends Omit<MemoryTopic, 'coverage' | 'isFallback'> {
  sourceVersions: Record<string, string>;
  /** All inputs read to derive cached language, including uncited background. */
  dependencyVersions?: Record<string, string>;
  projectorVersion: number;
  invalidated: boolean;
}

export interface TopicProjectionJob {
  id: string;
  sourceEventIds: string[];
  sourceVersions: Record<string, string>;
  /** Includes every source behind every supplied topic, even non-displayed members. */
  dependencyVersions: Record<string, string>;
  candidateVersions: Record<string, string>;
  context: TopicProjectionContext | null;
  projectorVersion: number;
  status: 'pending' | 'running' | 'completed' | 'failed';
  attempts: number;
  topicIds: string[];
  lastError: string | null;
  nextRetryAt: string | null;
  createdAt: string;
  updatedAt: string;
  leaseUntil?: string | null;
  superseded?: boolean;
  sectionBackfillTopicId?: string;
  diagnostics?: TopicProjectionDiagnostics | undefined;
  /** Legacy unsaved-draft metadata; ignored by current projection/commit rules. */
  overviewRepairRequirements?: TopicOverviewRepairRequirement[] | undefined;
  /** Bounded binary split ancestry; manual retry starts a fresh cycle. */
  splitDepth?: number;
}

export type TopicProjectionMode = 'all' | 'incremental' | 'bootstrap';

export interface TopicBootstrapState {
  projectorVersion: number;
  /** Frozen at writer open; newly added/changed sources have priority. */
  sourceVersions: Record<string, string>;
  status: 'pending' | 'running' | 'completed' | 'failed';
  startedAt: string;
  completedAt: string | null;
  /** Exhausted inputs remain navigable through fallback, without paid retries. */
  failedEvents: number;
}

export interface MemoryTopicState {
  topics: StoredMemoryTopic[];
  jobs: TopicProjectionJob[];
  projectedVersions: Record<string, string>;
  bootstrap?: TopicBootstrapState;
  /** Unchanged old inputs invalidated by another dependency; share the historical budget. */
  rebuildVersions?: Record<string, string>;
  /** Writer-open upgrade marker, independent of the prose projector version. */
  sectionMembershipVersion?: number;
  /** Durable writer-open marker: never reset retries on reads or restarts. */
  recoveryVersion?: number;
  /** Missing relations, keyed by chapter and immutable Event fingerprint. */
  sectionBackfill?: Record<string, Record<string, string>>;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

/** Adoption and retrieval bookkeeping never change semantic identity. */
export function memoryTopicEventFingerprint(event: EventCard): string {
  const { weight: _weight, updatedAt: _updated, formedTurn: _formed, ...semantic } = event;
  return digest({ ...semantic, temporal: topicTemporal(event) });
}

function topicTemporal(event: EventCard): EventCard['temporal'] {
  // These Graph references are a derived index, never topic evidence.
  const { participantNodeIds: _nodes, ...temporal } = event.temporal;
  return temporal;
}

const visible = (event: EventCard): boolean => event.status === 'active' || event.status === 'superseded';
const unique = (ids: readonly string[]): string[] => [...new Set(ids)];
const bounded = (value: string, size: number): string => [...value].slice(0, size).join('');

const SECTION_TITLES: Record<MemoryTopicOverviewKind, string> = {
  history: '发展脉络', decision: '关键设计决策', change: '重要变化', 'open-question': '尚未解决的问题', scope: '主题范围',
};
/** One display-label rule for model routing and the book view. */
export function memoryTopicSectionTitle(part: MemoryTopicOverview): string {
  return part.title?.trim() || SECTION_TITLES[part.kind] || '主题概览';
}
const normalizedLabel = (value: string): string => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();

/** New prose may attach to a directory section, never create one by itself. */
export function memoryTopicOverviewMatchesSection(part: MemoryTopicOverview, titles: readonly string[]): boolean {
  const display = normalizedLabel(memoryTopicSectionTitle(part));
  return titles.some((title) => normalizedLabel(title) === display);
}

/** Legacy evidence provides known memberships; explicit memberships never
 * depend on whether a summary still cites the Event. */
export function memoryTopicMembershipSections(topic: Pick<MemoryTopic, 'overview' | 'sections'>): MemoryTopicSection[] {
  if (topic.sections !== undefined) return structuredClone(topic.sections);
  const sections = new Map<string, MemoryTopicSection>();
  for (const part of topic.overview) {
    const title = memoryTopicSectionTitle(part);
    const key = normalizedLabel(title);
    const section = sections.get(key) ?? { title, sourceEventIds: [] };
    section.sourceEventIds = unique([...section.sourceEventIds, ...part.sourceEventIds]);
    sections.set(key, section);
  }
  return [...sections.values()];
}

function sectionTitles(topic: Pick<MemoryTopic, 'overview' | 'sections'>): string[] {
  const titles = new Map<string, string>();
  for (const section of memoryTopicMembershipSections(topic)) titles.set(normalizedLabel(section.title), section.title);
  for (const part of topic.overview) {
    const title = memoryTopicSectionTitle(part);
    if (!titles.has(normalizedLabel(title))) titles.set(normalizedLabel(title), title);
  }
  return [...titles.values()];
}

function sourceVersions(sources: ReadonlyMap<string, EventCard>): ReadonlyMap<string, string> {
  return new Map([...sources].map(([id, event]) => [id, memoryTopicEventFingerprint(event)]));
}

function jobInputsCurrent(job: TopicProjectionJob, versions: ReadonlyMap<string, string>): boolean {
  return job.projectorVersion === MEMORY_TOPIC_PROJECTOR_VERSION
    && Object.entries({ ...job.sourceVersions, ...job.dependencyVersions }).every(([id, version]) =>
    versions.get(id) === version);
}

/** Current fault/work classification, independent of frozen Bootstrap history. */
export function memoryTopicUnfinishedJobEventIds(job: TopicProjectionJob, state: MemoryTopicState,
  versions: ReadonlyMap<string, string>): string[] {
  if (job.superseded || job.status === 'completed' || !jobInputsCurrent(job, versions)) return [];
  return job.sourceEventIds.filter((id) => versions.has(id) && job.sourceVersions[id] === versions.get(id)
    && (job.sectionBackfillTopicId
      ? state.sectionBackfill?.[job.sectionBackfillTopicId]?.[id] === versions.get(id)
      : state.projectedVersions[id] !== versions.get(id)));
}

function topicView(topic: StoredMemoryTopic, events: ReadonlyMap<string, EventCard>, versions: ReadonlyMap<string, string>): MemoryTopic | null {
  const ids = topic.sourceEventIds.filter((id) => events.has(id));
  if (ids.length === 0) return null;
  const valid = !topic.invalidated && topic.projectorVersion === MEMORY_TOPIC_PROJECTOR_VERSION
    && ids.length === topic.sourceEventIds.length
    && Object.entries(topic.dependencyVersions ?? topic.sourceVersions).every(([id, version]) => versions.get(id) === version);
  const overview = valid ? structuredClone(topic.overview) : [];
  const summarized = new Set(overview.flatMap((part) => part.sourceEventIds));
  return {
    id: topic.id,
    title: valid ? topic.title : '待更新记忆主题',
    description: valid ? topic.description : '概览等待重新整理，请查看关联事件。',
    sourceEventIds: ids,
    overview,
    sections: valid ? memoryTopicMembershipSections(topic) : [],
    createdAt: topic.createdAt,
    updatedAt: topic.updatedAt,
    coverage: { totalEvents: ids.length, summarizedEvents: summarized.size, omittedEvents: ids.length - summarized.size },
    ...(!valid ? { isFallback: true } : {}),
  };
}

function compactEvent(event: EventCard): EventCard {
  const full = { ...structuredClone(event), temporal: structuredClone(topicTemporal(event)), quotes: [], sourceMessageIds: [] };
  if (JSON.stringify(full).length <= 10_000) return full;
  const temporal = structuredClone(topicTemporal(event));
  for (const [key, value] of Object.entries(temporal)) {
    if (typeof value === 'string') (temporal as Record<string, unknown>)[key] = bounded(value, key === 'originalText' ? 200 : 120);
    if (Array.isArray(value)) (temporal as Record<string, unknown>)[key] = value.slice(0, 12).map((item) => bounded(String(item), 120));
  }
  return { ...structuredClone(event), title: bounded(event.title, 120), summary: bounded(event.summary, 800),
    tags: event.tags.slice(0, 4).map((tag) => bounded(tag, 40)), quotes: [], sourceMessageIds: [], temporal };
}

/** A rebuildable directory: all writes are invoked inside the owner's transaction. */
export class MemoryTopicDirectory {
  private state: MemoryTopicState = { topics: [], jobs: [], projectedVersions: {} };

  restore(state?: MemoryTopicState): void {
    this.state = state ? structuredClone(state) : { topics: [], jobs: [], projectedVersions: {} };
    for (const topic of this.state.topics) if (topic.sections === undefined) {
      topic.sections = memoryTopicMembershipSections(topic);
    }
    // Older prerelease snapshots already cleared their projected ledger on
    // invalidation. Conservatively budget that backlog rather than paying it
    // again as unlimited incremental work after an upgrade/restart.
    if (state && state.rebuildVersions === undefined && state.topics.some((topic) => topic.invalidated)) {
      this.state.rebuildVersions = Object.fromEntries(state.topics.filter((topic) => topic.invalidated)
        .flatMap((topic) => Object.entries(topic.sourceVersions)
          .filter(([id, version]) => state.projectedVersions[id] !== version)));
    }
  }

  snapshot(events?: readonly EventCard[]): MemoryTopicState {
    if (!events) return structuredClone(this.state);
    const directory = new MemoryTopicDirectory();
    directory.restore(this.state);
    directory.synchronize(events, new Date().toISOString());
    return directory.snapshot();
  }

  list(events: readonly EventCard[]): MemoryTopic[] {
    const sources = new Map(events.filter(visible).map((event) => [event.id, event]));
    const versions = sourceVersions(sources);
    const topics = this.state.topics.flatMap((topic) => topicView(topic, sources, versions) ?? []);
    const assigned = new Set(topics.flatMap((topic) => topic.sourceEventIds));
    for (const event of sources.values()) if (!assigned.has(event.id)) topics.push({
      id: `fallback:${event.id}`, title: bounded(event.title, 120),
      description: '尚未归入主题，查看事件获得详情。', sourceEventIds: [event.id], overview: [],
      createdAt: event.createdAt, updatedAt: event.createdAt, isFallback: true,
      coverage: { totalEvents: 1, summarizedEvents: 0, omittedEvents: 1 },
    });
    return topics.sort((a, b) => a.id.localeCompare(b.id));
  }

  jobs(): TopicProjectionJob[] {
    // Internal model inputs are never an admin/read surface for memory content.
    return structuredClone(this.state.jobs.map((job) => ({ ...job, context: null })));
  }

  bootstrap(): TopicBootstrapState | null {
    return this.state.bootstrap ? structuredClone(this.state.bootstrap) : null;
  }

  needsInitialization(): boolean {
    return this.state.bootstrap?.projectorVersion !== MEMORY_TOPIC_PROJECTOR_VERSION
      || this.state.sectionMembershipVersion !== 1
      || (this.state.recoveryVersion ?? 0) < TOPIC_RECOVERY_VERSION;
  }

  initializeBootstrap(events: readonly EventCard[], now: string): void {
    this.synchronize(events, now);
    if (this.state.sectionMembershipVersion !== 1) {
      // Keep the prose generation and its success ledger. Repair missing
      // chapter relations separately so already-completed history stays valid.
      const versions = sourceVersions(new Map(events.filter(visible).map((event) => [event.id, event])));
      const missing: Record<string, Record<string, string>> = {};
      for (const topic of this.state.topics.filter((topic) => !topic.invalidated)) {
        const assigned = new Set(memoryTopicMembershipSections(topic).flatMap((section) => section.sourceEventIds));
        const ids = topic.sourceEventIds.filter((id) => !assigned.has(id) && versions.has(id)
          && this.state.projectedVersions[id] === versions.get(id));
        if (ids.length) missing[topic.id] = Object.fromEntries(ids.map((id) => [id, versions.get(id)!]));
      }
      this.state.sectionBackfill = missing;
      this.state.sectionMembershipVersion = 1;
    }
    this.recoverFailures(events, now);
    if (this.state.bootstrap?.projectorVersion === MEMORY_TOPIC_PROJECTOR_VERSION) return;
    this.state.bootstrap = { projectorVersion: MEMORY_TOPIC_PROJECTOR_VERSION,
      sourceVersions: Object.fromEntries(sourceVersions(new Map(events.filter(visible).map((event) => [event.id, event])))),
      status: 'pending', startedAt: now, completedAt: null, failedEvents: 0 };
    this.synchronize(events, now);
  }

  private recoverFailures(events: readonly EventCard[], now: string): void {
    if ((this.state.recoveryVersion ?? 0) >= TOPIC_RECOVERY_VERSION) return;
    // initializeBootstrap is committed in the owner's mutation transaction.
    // Persist even when no failures exist: failures created by this version
    // never acquire an extra cycle merely because the process restarts.
    this.state.recoveryVersion = TOPIC_RECOVERY_VERSION;
    const versions = sourceVersions(new Map(events.filter(visible).map((event) => [event.id, event])));
    for (const previous of [...this.state.jobs]) {
      if (previous.superseded || previous.status !== 'failed' || previous.attempts < TOPIC_MAX_ATTEMPTS
        || previous.nextRetryAt !== null || !jobInputsCurrent(previous, versions)) continue;
      // Recover only the changed overview/budget paths and the original
      // pre-diagnostics Issue #119 signature, preserving unrelated budgets.
      const diagnostic = safeTopicDiagnostics(previous.diagnostics);
      const affected = !!previous.overviewRepairRequirements?.length
        || diagnostic?.category === 'provider-failed'
        || ((diagnostic?.category === 'validation-failed' || diagnostic?.category === 'schema-invalid')
          && (diagnostic.reason.startsWith('overview.text ')
            || diagnostic.reason === 'Topic retry must replace invalid overview without removing entries.'))
        || previous.lastError === 'invalid-output'
        || /^(?:validation-failed|schema-invalid): (?:overview\.text |Topic retry must replace invalid overview)/.test(previous.lastError ?? '');
      if (!affected) continue;
      const work = memoryTopicUnfinishedJobEventIds(previous, this.state, versions);
      if (!work.length) continue;
      // Other queued/leased/retrying jobs own their work already. Overlapping
      // terminal history must not suppress recovery or duplicate those calls.
      const ids = work.filter((id) => !this.state.jobs.some((job) => job.id !== previous.id && !job.superseded
        && jobInputsCurrent(job, versions) && job.sectionBackfillTopicId === previous.sectionBackfillTopicId
        && job.sourceVersions[id] === versions.get(id)
        && (job.status === 'pending' || job.status === 'running'
          || (job.status === 'failed' && job.attempts < TOPIC_MAX_ATTEMPTS && job.nextRetryAt !== null))));
      if (!ids.length) {
        previous.superseded = true;
        previous.updatedAt = now;
        continue;
      }
      this.requeue(previous, ids, versions, now);
    }
    this.synchronize(events, now);
  }

  synchronize(events: readonly EventCard[], now: string): void {
    const sources = new Map(events.filter(visible).map((event) => [event.id, event]));
    const versions = sourceVersions(sources);
    if ((this.state.bootstrap && this.state.bootstrap.projectorVersion !== MEMORY_TOPIC_PROJECTOR_VERSION)
      || this.state.topics.some((topic) => topic.projectorVersion !== MEMORY_TOPIC_PROJECTOR_VERSION)
      || this.state.jobs.some((job) => job.projectorVersion !== MEMORY_TOPIC_PROJECTOR_VERSION)) {
      // V2 already established broad chapters. Rebuild only their section prose
      // under V3, preserving fresh chapter identities and member order. V1 and
      // mixed/unknown generations still retire their fragmented derived tree.
      const fromV2 = (!this.state.bootstrap || this.state.bootstrap.projectorVersion === 2)
        && this.state.topics.every((topic) => topic.projectorVersion === 2)
        && this.state.jobs.every((job) => job.projectorVersion === 2);
      const chapters = fromV2 ? this.state.topics.filter((topic) => !topic.invalidated
        && topic.title.trim() && topic.description.trim()
        && topic.sourceEventIds.length > 0
        && topic.sourceEventIds.every((id) => sources.has(id) && topic.sourceVersions[id] === versions.get(id))
        && Object.entries(topic.dependencyVersions ?? topic.sourceVersions).every(([id, version]) => versions.get(id) === version))
        .map((topic) => ({ ...topic, overview: [], sections: [], projectorVersion: MEMORY_TOPIC_PROJECTOR_VERSION, updatedAt: now })) : [];
      // Writer-open Bootstrap freezes visible inputs again. No old projected
      // success or retry context can bypass its durable database-wide budget.
      this.state = { topics: chapters, jobs: [], projectedVersions: {} };
    }
    for (const topic of this.state.topics) {
      if (topic.projectorVersion !== MEMORY_TOPIC_PROJECTOR_VERSION
        || Object.entries(topic.dependencyVersions ?? topic.sourceVersions).some(([id, version]) => versions.get(id) !== version)) {
        // Clear cached language itself, not only its evidence pointers.
        topic.invalidated = true;
        topic.title = '';
        topic.description = '';
        topic.overview = [];
        topic.sections = [];
        for (const id of topic.sourceEventIds) if (sources.has(id)) {
          const version = versions.get(id)!;
          // Only genuinely changed/new versions bypass the historical allowance.
          // Keep this ledger separate from the immutable writer-open Bootstrap.
          if (topic.sourceVersions[id] === version && this.state.projectedVersions[id] === version) {
            (this.state.rebuildVersions ??= {})[id] = version;
          }
          delete this.state.projectedVersions[id];
        }
        // Record the invalidation once. A later successful batch must not be
        // dirtied again merely because this old, redacted topic still exists.
        topic.sourceVersions = Object.fromEntries(topic.sourceEventIds.filter((id) => sources.has(id))
          .map((id) => [id, versions.get(id)!]));
        topic.dependencyVersions = Object.fromEntries(unique([...Object.keys(topic.dependencyVersions ?? {}),
          ...topic.sourceEventIds]).filter((id) => sources.has(id)).map((id) => [id, versions.get(id)!]));
        topic.projectorVersion = MEMORY_TOPIC_PROJECTOR_VERSION;
      }
    }
    for (const job of this.state.jobs) if (job.status !== 'completed' && !job.superseded
      && !jobInputsCurrent(job, versions)) {
      job.status = 'failed'; job.context = null; job.nextRetryAt = null; job.leaseUntil = null;
      job.superseded = true;
      job.lastError = 'source-changed'; job.updatedAt = now;
      job.diagnostics = safeTopicDiagnostics({ ...job.diagnostics, category: 'source-changed',
        reason: 'source version changed; stale result rejected', eventCount: job.sourceEventIds.length, attempt: job.attempts });
    }
    const finished = this.state.jobs.filter((job) => job.status === 'completed'
      || (job.status === 'failed' && job.nextRetryAt === null));
    // A failed current input version is also the durable retry ledger. It
    // must outlive the bounded display history, or old failures become new
    // payable work again. Changed dependencies are superseded above.
    const retain = new Set([...finished.slice(-64), ...finished.filter((job) =>
      job.status === 'failed' && !job.superseded && job.attempts >= TOPIC_MAX_ATTEMPTS)]
      .map((job) => job.id));
    this.state.jobs = this.state.jobs.filter((job) => !finished.includes(job) || retain.has(job.id));
    for (const [id, version] of Object.entries(this.state.rebuildVersions ?? {})) {
      if (versions.get(id) !== version || this.state.projectedVersions[id] === version) delete this.state.rebuildVersions![id];
    }
    for (const [topicId, pending] of Object.entries(this.state.sectionBackfill ?? {})) {
      const topic = this.state.topics.find((topic) => topic.id === topicId && !topic.invalidated);
      const assigned = new Set(topic ? memoryTopicMembershipSections(topic).flatMap((section) => section.sourceEventIds) : []);
      for (const [id, version] of Object.entries(pending)) if (!topic || !topic.sourceEventIds.includes(id)
        || versions.get(id) !== version || assigned.has(id)) delete pending[id];
      if (!Object.keys(pending).length) delete this.state.sectionBackfill![topicId];
    }
    for (const job of this.state.jobs) if (job.status === 'failed' && !job.superseded
      && jobInputsCurrent(job, versions) && !memoryTopicUnfinishedJobEventIds(job, this.state, versions).length) {
      // Keep the original failure as history; never pretend it succeeded.
      job.superseded = true; job.context = null; job.nextRetryAt = null; job.leaseUntil = null; job.updatedAt = now;
    }
    const bootstrap = this.state.bootstrap;
    if (bootstrap && bootstrap.projectorVersion === MEMORY_TOPIC_PROJECTOR_VERSION) {
      const outstanding = Object.entries(bootstrap.sourceVersions).filter(([id, version]) =>
        versions.get(id) === version && this.state.projectedVersions[id] !== version);
      bootstrap.failedEvents = outstanding.filter(([id, version]) => this.state.jobs.some((job) =>
        !job.superseded && job.sectionBackfillTopicId === undefined && job.status === 'failed' && job.attempts >= TOPIC_MAX_ATTEMPTS
        && job.sourceVersions[id] === version && jobInputsCurrent(job, versions))).length;
      if (outstanding.length === 0) {
        if (bootstrap.status !== 'completed') bootstrap.completedAt = now;
        bootstrap.status = 'completed';
      } else {
        bootstrap.completedAt = null;
        if (outstanding.length === bootstrap.failedEvents) bootstrap.status = 'failed';
        else if (bootstrap.status === 'completed' || bootstrap.status === 'failed') bootstrap.status = 'running';
      }
    }
  }

  recover(now: string): void {
    for (const job of this.state.jobs) if (job.status === 'running'
      && Date.parse(job.leaseUntil ?? job.updatedAt) <= Date.parse(now)) {
      job.diagnostics = safeTopicDiagnostics({ category: 'timeout', reason: 'topic projection lease expired',
        eventCount: job.sourceEventIds.length, candidateTopicCount: job.context?.existingTopics.length,
        attempt: job.attempts, splitDepth: job.splitDepth ?? 0 });
      job.status = 'failed'; job.lastError = 'timeout'; job.context = null;
      job.nextRetryAt = job.attempts < TOPIC_MAX_ATTEMPTS ? now : null;
      job.leaseUntil = null;
      job.updatedAt = now;
    }
  }

  private pendingWork(events: readonly EventCard[]): Array<{ event: EventCard; sectionBackfillTopicId?: string }> {
    const sources = new Map(events.filter(visible).map((event) => [event.id, event]));
    const versions = sourceVersions(sources);
    const dirtyIds = new Set(this.state.topics.filter((topic) => topic.projectorVersion !== MEMORY_TOPIC_PROJECTOR_VERSION
      || Object.entries(topic.dependencyVersions ?? topic.sourceVersions).some(([id, version]) => versions.get(id) !== version))
      .flatMap((topic) => topic.sourceEventIds));
    const blocked = (id: string, version: string, topicId?: string): boolean => this.state.jobs.some((job) =>
      !job.superseded && job.projectorVersion === MEMORY_TOPIC_PROJECTOR_VERSION
      && job.sectionBackfillTopicId === topicId && job.sourceVersions[id] === version
      && jobInputsCurrent(job, versions)
      && (job.status === 'running' || job.status === 'pending'
        || (job.status === 'failed' && (job.attempts >= TOPIC_MAX_ATTEMPTS || job.nextRetryAt !== null))));
    return events.filter(visible).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).flatMap((event) => {
      const version = versions.get(event.id)!;
      const work: Array<{ event: EventCard; sectionBackfillTopicId?: string }> = [];
      if ((this.state.projectedVersions[event.id] !== version || dirtyIds.has(event.id)) && !blocked(event.id, version)) {
        work.push({ event });
      }
      // A retry ledger settles one chapter relation, never the entire Event.
      for (const [topicId, pending] of Object.entries(this.state.sectionBackfill ?? {})) {
        if (pending[event.id] === version && !blocked(event.id, version, topicId)) work.push({ event, sectionBackfillTopicId: topicId });
      }
      return work;
    });
  }

  private isBootstrap(id: string, version: string, sectionBackfillTopicId?: string): boolean {
    const bootstrap = this.state.bootstrap;
    return sectionBackfillTopicId !== undefined || this.state.rebuildVersions?.[id] === version
      || !bootstrap || bootstrap.projectorVersion !== MEMORY_TOPIC_PROJECTOR_VERSION
      || (bootstrap.status !== 'completed' && bootstrap.sourceVersions[id] === version);
  }

  private matchesMode(ids: readonly string[], versions: ReadonlyMap<string, string>, mode: TopicProjectionMode, sectionBackfillTopicId?: string): boolean {
    return mode === 'all' || ids.some((id) => this.isBootstrap(id, versions.get(id)!, sectionBackfillTopicId) === (mode === 'bootstrap'));
  }

  hasPending(events: readonly EventCard[], now: number, mode: TopicProjectionMode = 'all'): boolean {
    const sources = new Map(events.filter(visible).map((event) => [event.id, event]));
    const versions = sourceVersions(sources);
    const running = this.state.jobs.find((job) => job.status === 'running');
    if (running) return Date.parse(running.leaseUntil ?? running.updatedAt) <= now
      || !jobInputsCurrent(running, versions);
    return this.pendingWork(events).some(({ event, sectionBackfillTopicId }) => this.matchesMode([event.id], versions, mode, sectionBackfillTopicId)) || this.state.jobs.some((job) =>
      !job.superseded && job.projectorVersion === MEMORY_TOPIC_PROJECTOR_VERSION && job.attempts < TOPIC_MAX_ATTEMPTS
      && ((job.status === 'pending' && (job.nextRetryAt === null || Date.parse(job.nextRetryAt) <= now)) || (job.status === 'failed'
        && job.nextRetryAt !== null && Date.parse(job.nextRetryAt) <= now))
      && jobInputsCurrent(job, versions) && this.matchesMode(job.sourceEventIds, versions, mode, job.sectionBackfillTopicId));
  }

  claim(events: readonly EventCard[], now: string, mode: TopicProjectionMode = 'all'): TopicProjectionContext | null {
    if (this.state.bootstrap?.projectorVersion !== MEMORY_TOPIC_PROJECTOR_VERSION) {
      throw new Error('Topic Bootstrap must be initialized at writer open before claiming work.');
    }
    this.synchronize(events, now);
    this.recover(now);
    // One in-flight model call per namespace avoids two summaries overwriting each other.
    if (this.state.jobs.some((job) => job.status === 'running')) return null;
    const sources = new Map(events.filter(visible).map((event) => [event.id, event]));
    const versions = sourceVersions(sources);
    const eligible = this.state.jobs.filter((job) => !job.superseded && job.attempts < TOPIC_MAX_ATTEMPTS
      && ((job.status === 'pending' && (job.nextRetryAt === null || Date.parse(job.nextRetryAt) <= Date.parse(now))) || (job.status === 'failed' && job.nextRetryAt !== null
        && Date.parse(job.nextRetryAt) <= Date.parse(now)))
      && jobInputsCurrent(job, versions) && this.matchesMode(job.sourceEventIds, versions, mode, job.sectionBackfillTopicId))
      .sort((a, b) => Number(this.isBootstrap(a.sourceEventIds[0]!, versions.get(a.sourceEventIds[0]!)!, a.sectionBackfillTopicId))
        - Number(this.isBootstrap(b.sourceEventIds[0]!, versions.get(b.sourceEventIds[0]!)!, b.sectionBackfillTopicId)))[0];
    let job = eligible;
    if (job && this.isBootstrap(job.sourceEventIds[0]!, versions.get(job.sourceEventIds[0]!)!, job.sectionBackfillTopicId)
      && mode === 'all' && this.pendingWork(events).some(({ event, sectionBackfillTopicId }) =>
        !this.isBootstrap(event.id, versions.get(event.id)!, sectionBackfillTopicId))) job = undefined;
    if (job?.status === 'failed') {
      // Each attempt owns a new id, so a delayed reply from an expired lease
      // cannot complete a later claimant's job.
      const previous = job;
      previous.nextRetryAt = null;
      previous.superseded = true;
      job = { ...structuredClone(previous), id: `tproj_${randomUUID()}`, status: 'pending',
        superseded: false,
        context: null, dependencyVersions: {}, candidateVersions: {}, topicIds: [],
        createdAt: now, updatedAt: now };
      this.state.jobs.push(job);
    }
    if (!job) {
      const pending = this.pendingWork(events).filter(({ event, sectionBackfillTopicId }) =>
        this.matchesMode([event.id], versions, mode, sectionBackfillTopicId))
        .sort((a, b) => Number(this.isBootstrap(a.event.id, versions.get(a.event.id)!, a.sectionBackfillTopicId))
          - Number(this.isBootstrap(b.event.id, versions.get(b.event.id)!, b.sectionBackfillTopicId)));
      // Never mix a new incremental source into a historical budgeted batch.
      const first = pending[0];
      const backfillTopicId = first?.sectionBackfillTopicId;
      const sameKind = pending.filter(({ event, sectionBackfillTopicId }) => first
        && sectionBackfillTopicId === backfillTopicId
        && this.isBootstrap(event.id, versions.get(event.id)!, sectionBackfillTopicId)
          === this.isBootstrap(first.event.id, versions.get(first.event.id)!, backfillTopicId))
        .slice(0, TOPIC_BATCH_LIMIT).map(({ event }) => event);
      const batch: EventCard[] = [];
      let eventBudget = 16_000;
      for (const event of sameKind) {
        const cost = JSON.stringify(compactEvent(event)).length;
        if (cost > eventBudget) break;
        eventBudget -= cost; batch.push(event);
      }
      if (batch.length === 0) return null;
      job = { id: `tproj_${randomUUID()}`, sourceEventIds: batch.map(({ id }) => id),
        sourceVersions: Object.fromEntries(batch.map((event) => [event.id, versions.get(event.id)!])),
        dependencyVersions: {}, candidateVersions: {}, context: null,
        projectorVersion: MEMORY_TOPIC_PROJECTOR_VERSION, status: 'pending', attempts: 0, topicIds: [],
        leaseUntil: null,
        lastError: null, nextRetryAt: null, createdAt: now, updatedAt: now };
      if (backfillTopicId) job.sectionBackfillTopicId = backfillTopicId;
      this.state.jobs.push(job);
    }
    const batch = job.sourceEventIds.map((id) => sources.get(id)!);
    const batchIds = new Set(job.sourceEventIds);
    const query = batch.map(compactEvent).map((event) => `${event.title} ${event.summary} ${event.tags.join(' ')}`).join(' ');
    const eligibleTopics = this.list(events).filter((topic) => !topic.id.startsWith('fallback:'));
    const lexicalScores = new Map(bm25Rank(eligibleTopics, query, (topic) => weightedSearchTokens([
      [topic.title, 8], [topic.description, 2], [sectionTitles(topic).join(' '), 6],
      // Route broad chapters by bounded member hints as well. These hints
      // select candidates locally; they are never new factual model evidence.
      [topic.sourceEventIds.slice(0, 3).concat(topic.sourceEventIds.slice(-3))
        .flatMap((id) => { const event = sources.get(id); return event ? [bounded(event.title, 120), ...event.tags.slice(0, 4).map((tag) => bounded(tag, 40))] : []; }).join(' '), 4],
    ])).map(({ item, score }) => [item.id, score]));
    const overlap = (topic: MemoryTopic): number => topic.sourceEventIds.filter((id) => batchIds.has(id)).length;
    const candidates = eligibleTopics.filter((topic) => !job.sectionBackfillTopicId || topic.id === job.sectionBackfillTopicId)
      .sort((a, b) => overlap(b) - overlap(a)
      || (lexicalScores.get(b.id) ?? 0) - (lexicalScores.get(a.id) ?? 0)
      || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)).slice(0, TOPIC_CANDIDATE_LIMIT);
    const existingTopics: TopicProjectionCandidate[] = [];
    // Conservative character budget remains bounded for CJK without a tokenizer dependency.
    let remaining = 30_000 - JSON.stringify(batch.map(compactEvent)).length;
    for (const topic of candidates) {
      const overview = job.sectionBackfillTopicId ? [] : topic.overview.slice(0, 4);
      const exposed = unique([...overview.flatMap((part) => part.sourceEventIds),
        ...topic.sourceEventIds.filter((id) => batchIds.has(id))]);
      const allTitles = sectionTitles(topic);
      let titleBudget = 4_000;
      const shownTitles = job.sectionBackfillTopicId ? allTitles.filter((title, index) => {
        const cost = JSON.stringify(title).length;
        if (index >= 120 || cost > titleBudget) return false;
        titleBudget -= cost; return true;
      }) : allTitles;
      const candidate = { id: topic.id, title: topic.title, description: topic.description,
        overview, sectionTitles: shownTitles,
        ...(shownTitles.length < allTitles.length ? { sectionTitlesOmitted: allTitles.length - shownTitles.length } : {}),
        sourceEventIds: exposed, totalSourceEvents: topic.sourceEventIds.length };
      const cost = JSON.stringify(candidate).length;
      if (cost > remaining) continue;
      remaining -= cost; existingTopics.push(candidate);
    }
    const truncatedEventIds = batch.filter((event) => {
      const compact = compactEvent(event);
      return compact.title !== event.title || compact.summary !== event.summary
        || JSON.stringify(compact.temporal) !== JSON.stringify(topicTemporal(event))
        || JSON.stringify(compact.tags) !== JSON.stringify(event.tags);
    }).map((event) => event.id);
    if (job.sectionBackfillTopicId && !existingTopics.some((topic) => topic.id === job.sectionBackfillTopicId)) {
      throw new Error('Section backfill chapter cannot fit the projection input budget.');
    }
    job.context = { jobId: job.id,
      events: batch.map(compactEvent), existingTopics, truncatedEventIds,
      ...(job.sectionBackfillTopicId ? { sectionBackfillTopicId: job.sectionBackfillTopicId } : {}) };
    const storedById = new Map(this.state.topics.map((topic) => [topic.id, topic]));
    job.candidateVersions = Object.fromEntries(existingTopics.map((topic) => [topic.id, digest(storedById.get(topic.id))]));
    const dependencyIds = unique([...job.sourceEventIds, ...existingTopics.flatMap((topic) =>
      [
        ...storedById.get(topic.id)!.sourceEventIds.filter((id) => sources.has(id)),
        ...(!storedById.get(topic.id)!.invalidated
          ? Object.keys(storedById.get(topic.id)!.dependencyVersions ?? {}).filter((id) => sources.has(id)) : []),
      ])]);
    job.dependencyVersions = Object.fromEntries(dependencyIds.map((id) => [id, versions.get(id)!]));
    job.diagnostics = undefined;
    job.status = 'running'; job.attempts += 1; job.lastError = null; job.nextRetryAt = null; job.updatedAt = now;
    if (this.state.bootstrap.status === 'pending' && this.matchesMode(job.sourceEventIds, versions, 'bootstrap', job.sectionBackfillTopicId)) {
      this.state.bootstrap.status = 'running';
    }
    job.leaseUntil = new Date(Date.parse(now) + TOPIC_LEASE_MS).toISOString();
    return structuredClone(job.context);
  }

  complete(id: string, result: TopicProjectionResult, events: readonly EventCard[], now: string): { topicIds: string[] } {
    const job = this.requireJob(id);
    if (job.status === 'completed') return { topicIds: [...job.topicIds] };
    if (job.status !== 'running' || !job.context) throw new Error(`Topic projection ${id} is not running`);
    if (Date.parse(job.leaseUntil ?? job.updatedAt) <= Date.parse(now)) throw new TopicProjectionError('source-changed', 'Topic projection lease expired; stale result rejected.');
    const sources = new Map(events.filter(visible).map((event) => [event.id, event]));
    const versions = sourceVersions(sources);
    if (!jobInputsCurrent(job, versions)
      || Object.entries(job.candidateVersions).some(([topicId, version]) =>
        digest(this.state.topics.find((topic) => topic.id === topicId)) !== version)) {
      throw new TopicProjectionError('source-changed', 'Topic projection source version changed; stale result rejected.');
    }
    if (!Array.isArray(result?.topics) || result.topics.length < 1 || result.topics.length > 12) throw new TopicProjectionError('validation-failed', 'Topic projection must return 1-12 topics.');
    if (job.sectionBackfillTopicId && (result.topics.length !== 1
      || result.topics[0]!.topicId !== job.sectionBackfillTopicId || result.topics[0]!.sections === undefined)) {
      throw new TopicProjectionError('validation-failed', 'Invalid section backfill: explicit sections must cover the existing chapter.');
    }
    const candidates = new Map(job.context.existingTopics.map((topic) => [topic.id, topic]));
    const allowed = new Set([...job.sourceEventIds, ...job.context.existingTopics.flatMap((topic) => topic.sourceEventIds)]);
    const batchIds = new Set(job.sourceEventIds);
    const covered = new Set<string>();
    const touched = new Set<string>();
    const labels = new Set<string>();
    const proposals: StoredMemoryTopic[] = [];
    const checkIds = (ids: string[], label: string): string[] => {
      if (!Array.isArray(ids) || ids.length === 0 || unique(ids).length !== ids.length
        || ids.some((eventId) => typeof eventId !== 'string' || !allowed.has(eventId))) throw new TopicProjectionError('validation-failed', `Invalid topic ${label} source events.`);
      return ids;
    };
    for (const [topicIndex, proposal] of result.topics.entries()) {
      const ids = checkIds(proposal.sourceEventIds, 'membership');
      // An unambiguous membership continuation keeps its storage identity even
      // when the model omits topicId. Ambiguous regrouping is not inferred.
      const matching = this.state.topics.filter((topic) => candidates.has(topic.id)
        && topic.sourceEventIds.some((eventId) => ids.includes(eventId)));
      const inferred = matching.length === 1 && result.topics.filter((other) =>
        Array.isArray(other.sourceEventIds) && matching[0]!.sourceEventIds.some((eventId) => other.sourceEventIds.includes(eventId))).length === 1
        ? matching[0] : undefined;
      const label = normalizedLabel;
      const sameLabel = typeof proposal.title === 'string' ? this.state.topics.filter((topic) =>
        !topic.invalidated && label(topic.title) === label(proposal.title)) : [];
      // A bounded shortlist is not the global chapter namespace. Never create
      // a duplicate just because the matching chapter was not exposed.
      if (sameLabel.some((topic) => !candidates.has(topic.id))) {
        throw new TopicProjectionError('validation-failed', 'Invalid duplicate chapter label matches an unexposed existing topic.');
      }
      const existing = proposal.topicId ? this.state.topics.find((topic) => topic.id === proposal.topicId)
        : inferred ?? (sameLabel.length === 1 ? sameLabel[0] : undefined);
      if (sameLabel.some((topic) => topic.id !== existing?.id)) {
        throw new TopicProjectionError('validation-failed', 'Invalid duplicate chapter label conflicts with an existing topic.');
      }
      if (typeof proposal.title === 'string') {
        const key = label(proposal.title);
        if (labels.has(key)) throw new TopicProjectionError('validation-failed', 'Invalid duplicate chapter label in one projection.');
        labels.add(key);
      }
      if (proposal.topicId && (!existing || !candidates.has(proposal.topicId))) throw new TopicProjectionError('validation-failed', 'Unknown or unexposed topic id.');
      const topicId = existing?.id ?? `topic_${randomUUID()}`;
      if (touched.has(topicId)) throw new TopicProjectionError('validation-failed', 'A topic may be updated only once per projection.');
      touched.add(topicId);
      if (typeof proposal.title !== 'string' || !proposal.title.trim() || [...proposal.title].length > 120
        || typeof proposal.description !== 'string' || !proposal.description.trim() || [...proposal.description].length > 400) throw new TopicProjectionError('validation-failed', 'Invalid topic title or description.');
      for (const eventId of ids) if (batchIds.has(eventId)) covered.add(eventId);
      if (!Array.isArray(proposal.overview) || proposal.overview.length > 8) throw new TopicProjectionError('validation-failed', 'Topic projection must contain at most 8 overview paragraphs per chapter per batch.');
      for (const [overviewIndex, part] of proposal.overview.entries()) {
        if (part.title !== undefined && (typeof part.title !== 'string' || !part.title.trim()
          || [...part.title].length > 80)) throw new TopicProjectionError('validation-failed', 'Invalid topic overview title.');
        if (!['history', 'decision', 'change', 'open-question', 'scope'].includes(part.kind)) throw new TopicProjectionError('validation-failed', 'Invalid topic overview section.');
        validateTopicOverviewText(part.text, `topics[${topicIndex}].overview[${overviewIndex}].text`);
        checkIds(part.sourceEventIds, 'overview');
        if (part.kind !== 'scope' && part.sourceEventIds.some((eventId) => job.context!.truncatedEventIds?.includes(eventId))) {
          throw new TopicProjectionError('validation-failed', 'Truncated topic sources permit navigation scope only, not factual overview.');
        }
        if (part.sourceEventIds.length > 12 || part.sourceEventIds.some((eventId) => !ids.includes(eventId))) throw new TopicProjectionError('validation-failed', 'Overview references must belong to returned topic membership.');
        if (part.sourceEventIds.some((eventId) => !batchIds.has(eventId))
          && !candidates.get(topicId)?.overview.some((old) => digest(old) === digest(part))) throw new TopicProjectionError('validation-failed', 'Old overview evidence must be preserved verbatim; new sections need batch events.');
      }
      if (proposal.sections !== undefined && !Array.isArray(proposal.sections)) throw new TopicProjectionError('validation-failed', 'Invalid topic sections.');
      const assignments = memoryTopicMembershipSections(proposal);
      const sectionLabels = new Set<string>();
      for (const section of assignments) {
        if (!section || typeof section.title !== 'string' || !section.title.trim() || [...section.title].length > 80
          || sectionLabels.has(label(section.title))) throw new TopicProjectionError('validation-failed', 'Invalid or duplicate topic section title.');
        sectionLabels.add(label(section.title));
        checkIds(section.sourceEventIds, 'section');
        if (section.sourceEventIds.some((eventId) => !ids.includes(eventId))) throw new TopicProjectionError('validation-failed', 'Section references must belong to returned topic membership.');
        if (section.sourceEventIds.some((eventId) => !batchIds.has(eventId))
          && !memoryTopicMembershipSections(existing ?? { overview: [] }).some((old) =>
            label(old.title) === label(section.title) && section.sourceEventIds.filter((eventId) => !batchIds.has(eventId))
              .every((eventId) => old.sourceEventIds.includes(eventId)))) throw new TopicProjectionError('validation-failed', 'Old section membership must be preserved; reassignment needs batch events.');
      }
      if (proposal.sections !== undefined && ids.some((eventId) => batchIds.has(eventId)
        && !assignments.some((section) => section.sourceEventIds.includes(eventId)))) throw new TopicProjectionError('validation-failed', 'Topic sections omitted batch events.');
      const membership = unique([...(existing?.sourceEventIds ?? []).filter((eventId) => sources.has(eventId)), ...ids]);
      // Only batch Events can be reclassified. Confirming one old relation
      // cannot erase that Event's other memberships; legacy callers only append.
      const assignedIds = new Set(proposal.sections === undefined ? [] : assignments
        .flatMap((section) => section.sourceEventIds).filter((eventId) => batchIds.has(eventId)));
      const sections = existing && !existing.invalidated ? memoryTopicMembershipSections(existing) : [];
      const memberIds = new Set(membership);
      for (const section of sections) section.sourceEventIds = section.sourceEventIds.filter((eventId) =>
        memberIds.has(eventId) && !assignedIds.has(eventId));
      for (const assignment of assignments) {
        const section = sections.find((current) => label(current.title) === label(assignment.title));
        if (section) section.sourceEventIds = unique([...section.sourceEventIds, ...assignment.sourceEventIds]);
        else sections.push({ title: assignment.title.trim(), sourceEventIds: [...assignment.sourceEventIds] });
      }
      const finalSections = sections.filter((section) => section.sourceEventIds.length > 0);
      const titles = finalSections.map((section) => section.title);
      const inherited = existing && !existing.invalidated ? existing.overview : [];
      // Validate against the final directory: reclassification can remove an
      // inherited title. Copied old prose is still inherited, not a new summary.
      if (proposal.sections !== undefined) for (const part of proposal.overview) {
        if (!inherited.some((old) => digest(old) === digest(part)) && !memoryTopicOverviewMatchesSection(part, titles)) {
          throw new TopicProjectionError('validation-failed', 'New topic overview must match a final topic section.');
        }
      }
      const overview = uniqueTopicOverviewEntries(proposal.overview.filter((part) => memoryTopicOverviewMatchesSection(part, titles))).map((part) => structuredClone(part));
      // Eight limits one model response, not accumulated prose. Keep old prose
      // only while its section exists; never restore membership to save prose.
      for (const part of inherited) if (memoryTopicOverviewMatchesSection(part, titles)
        && !overview.some((current) => digest(current) === digest(part))) overview.push(structuredClone(part));
      proposals.push({ id: topicId, title: job.sectionBackfillTopicId ? existing!.title : proposal.title.trim(),
        description: job.sectionBackfillTopicId ? existing!.description : proposal.description.trim(),
        sourceEventIds: membership, overview, sections: finalSections,
        sourceVersions: Object.fromEntries(membership.map((eventId) => [eventId, versions.get(eventId)!])),
        dependencyVersions: { ...(!existing?.invalidated ? existing?.dependencyVersions ?? {} : {}), ...job.dependencyVersions },
        projectorVersion: MEMORY_TOPIC_PROJECTOR_VERSION, invalidated: false,
        createdAt: existing?.createdAt ?? now, updatedAt: now });
    }
    if (job.sourceEventIds.some((eventId) => !covered.has(eventId))) throw new TopicProjectionError('validation-failed', 'every supplied batch Event must be assigned to a topic');
    for (const topic of proposals) {
      const index = this.state.topics.findIndex((current) => current.id === topic.id);
      if (index < 0) this.state.topics.push(topic); else this.state.topics[index] = topic;
      const pending = this.state.sectionBackfill?.[topic.id];
      if (pending) {
        for (const eventId of memoryTopicMembershipSections(topic).flatMap((section) => section.sourceEventIds)) delete pending[eventId];
        if (!Object.keys(pending).length) delete this.state.sectionBackfill![topic.id];
      }
    }
    Object.assign(this.state.projectedVersions, job.sourceVersions);
    for (const [eventId, version] of Object.entries(job.sourceVersions)) {
      if (this.state.rebuildVersions?.[eventId] === version) delete this.state.rebuildVersions[eventId];
    }
    // A redacted predecessor may span several batches or an ambiguous result.
    // Retire it only once every surviving member has actually been projected.
    this.state.topics = this.state.topics.filter((topic) => !topic.invalidated
      || topic.sourceEventIds.some((eventId) => sources.has(eventId)
        && this.state.projectedVersions[eventId] !== versions.get(eventId)));
    job.overviewRepairRequirements = undefined;
    job.status = 'completed'; job.topicIds = proposals.map((topic) => topic.id); job.context = null;
    job.leaseUntil = null; job.dependencyVersions = {}; job.candidateVersions = {};
    job.lastError = null; job.nextRetryAt = null; job.updatedAt = now;
    return { topicIds: [...job.topicIds] };
  }

  fail(id: string, error: unknown, now: string): void {
    const job = this.state.jobs.find((candidate) => candidate.id === id);
    if (!job || job.status !== 'running') return;
    const diagnostic = error instanceof TopicProjectionError ? safeTopicDiagnostics(error.diagnostics) : undefined;
    job.overviewRepairRequirements = undefined;
    const message = error instanceof Error ? error.message : String(error);
    const category = diagnostic?.category ?? (/timeout|timed out/i.test(message) ? 'timeout'
      : /source.*changed|stale|not running/i.test(message) ? 'source-changed' : 'worker-failed');
    job.diagnostics = safeTopicDiagnostics({ ...diagnostic, category,
      reason: diagnostic?.reason ?? (category === 'timeout' ? 'structured model task timed out'
        : category === 'source-changed' ? 'source version changed; stale result rejected' : 'topic worker failed'),
      eventCount: job.sourceEventIds.length, candidateTopicCount: diagnostic?.candidateTopicCount ?? job.context?.existingTopics.length,
      attempt: job.attempts, splitDepth: job.splitDepth ?? 0 });
    job.status = 'failed'; job.context = null; job.leaseUntil = null;
    job.lastError = category === 'validation-failed' ? `${category}: ${job.diagnostics!.reason}` : category;
    job.nextRetryAt = job.attempts < TOPIC_MAX_ATTEMPTS
      ? new Date(Date.parse(now) + 30_000 * 2 ** Math.max(0, job.attempts - 1)).toISOString() : null;
    job.updatedAt = now;
    // Only the bridge's explicit finish=max-tokens signal authorizes splitting.
    // At most four binary levels (12 -> 6 -> 3 -> 2 -> 1), then three
    // ordinary attempts. Every child retains the immutable source versions.
    if (category === 'max-tokens' && diagnostic?.finishReason === 'max-tokens'
      && job.sourceEventIds.length > 1 && (job.splitDepth ?? 0) < 4) {
      const middle = Math.ceil(job.sourceEventIds.length / 2);
      for (const ids of [job.sourceEventIds.slice(0, middle), job.sourceEventIds.slice(middle)]) {
        this.state.jobs.push({ ...structuredClone(job), id: `tproj_${randomUUID()}`,
          sourceEventIds: ids, sourceVersions: Object.fromEntries(ids.map((id) => [id, job.sourceVersions[id]!])),
          overviewRepairRequirements: undefined,
          dependencyVersions: {}, candidateVersions: {}, status: 'pending', attempts: 0,
          diagnostics: undefined, splitDepth: (job.splitDepth ?? 0) + 1,
          topicIds: [], superseded: false, lastError: null, nextRetryAt: job.nextRetryAt,
          createdAt: now, updatedAt: now });
      }
      job.superseded = true; job.nextRetryAt = null;
    }
  }

  private requireJob(id: string): TopicProjectionJob {
    const job = this.state.jobs.find((candidate) => candidate.id === id);
    if (!job) throw new Error(`Unknown topic projection: ${id}`);
    return job;
  }

  private requeue(previous: TopicProjectionJob, ids: readonly string[], versions: ReadonlyMap<string, string>, now: string): TopicProjectionJob {
    const job: TopicProjectionJob = {
      ...structuredClone(previous), sourceEventIds: [...ids],
      overviewRepairRequirements: undefined,
      sourceVersions: Object.fromEntries(ids.map((id) => [id, previous.sourceVersions[id]!])),
      id: `tproj_${randomUUID()}`, status: 'pending', attempts: 0,
      superseded: false, context: null, dependencyVersions: {}, candidateVersions: {}, topicIds: [],
      diagnostics: undefined, splitDepth: 0,
      lastError: null, nextRetryAt: null, leaseUntil: null, createdAt: now, updatedAt: now,
    };
    previous.superseded = true;
    previous.updatedAt = now;
    this.state.jobs.push(job);
    const bootstrap = this.state.bootstrap;
    if (bootstrap && job.sourceEventIds.some((eventId) => bootstrap.sourceVersions[eventId] === versions.get(eventId))) {
      bootstrap.status = 'pending';
      bootstrap.completedAt = null;
    }
    return job;
  }

  retry(id: string, events: readonly EventCard[], now: string): { jobId: string; status: 'pending' } {
    const previous = this.requireJob(id);
    const sources = new Map(events.filter(visible).map((event) => [event.id, event]));
    const versions = sourceVersions(sources);
    const ids = memoryTopicUnfinishedJobEventIds(previous, this.state, versions);
    if (previous.superseded || previous.status !== 'failed' || previous.attempts < TOPIC_MAX_ATTEMPTS
      || previous.nextRetryAt !== null || !jobInputsCurrent(previous, versions) || !ids.length) {
      throw new Error('Topic retry conflict: failure is no longer current or retryable.');
    }
    const job = this.requeue(previous, ids, versions, now);
    this.synchronize(events, now);
    return { jobId: job.id, status: 'pending' };
  }
}
