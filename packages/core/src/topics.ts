import { createHash, randomUUID } from 'node:crypto';
import { bm25Rank, weightedSearchTokens } from './search.js';
import type { EventCard } from './types.js';

export const MEMORY_TOPIC_PROJECTOR_VERSION = 1;
export const TOPIC_BATCH_LIMIT = 12;
export const TOPIC_CANDIDATE_LIMIT = 12;
export const TOPIC_MAX_ATTEMPTS = 3;
export const TOPIC_LEASE_MS = 5 * 60_000;
export type MemoryTopicOverviewKind = 'history' | 'decision' | 'change' | 'open-question' | 'scope';

export interface MemoryTopicOverview {
  kind: MemoryTopicOverviewKind;
  text: string;
  sourceEventIds: string[];
}

export interface MemoryTopic {
  id: string;
  title: string;
  description: string;
  sourceEventIds: string[];
  overview: MemoryTopicOverview[];
  createdAt: string;
  updatedAt: string;
  coverage: { totalEvents: number; summarizedEvents: number; omittedEvents: number };
  isFallback?: boolean;
}

export interface TopicProjectionCandidate {
  id: string;
  title: string;
  description: string;
  overview: MemoryTopicOverview[];
  /** Only sources actually exposed in this bounded candidate, not all members. */
  sourceEventIds: string[];
  totalSourceEvents: number;
}

export interface TopicProjectionContext {
  jobId: string;
  events: EventCard[];
  existingTopics: TopicProjectionCandidate[];
  /** Extremely large sources are navigation-only until read in full. */
  truncatedEventIds?: string[];
}

export interface TopicProjectionProposal {
  topicId?: string;
  title: string;
  description: string;
  sourceEventIds: string[];
  overview: MemoryTopicOverview[];
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
}

export type TopicProjectionMode = 'all' | 'incremental' | 'bootstrap';

export interface TopicBootstrapState {
  projectorVersion: number;
  /** Frozen at writer open; newly added/changed sources have priority. */
  sourceVersions: Record<string, string>;
  status: 'pending' | 'running' | 'completed';
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

function sourceVersions(sources: ReadonlyMap<string, EventCard>): ReadonlyMap<string, string> {
  return new Map([...sources].map(([id, event]) => [id, memoryTopicEventFingerprint(event)]));
}

function jobInputsCurrent(job: TopicProjectionJob, versions: ReadonlyMap<string, string>): boolean {
  return job.projectorVersion === MEMORY_TOPIC_PROJECTOR_VERSION
    && Object.entries({ ...job.sourceVersions, ...job.dependencyVersions }).every(([id, version]) =>
    versions.get(id) === version);
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

  initializeBootstrap(events: readonly EventCard[], now: string): void {
    if (this.state.bootstrap?.projectorVersion === MEMORY_TOPIC_PROJECTOR_VERSION) return;
    this.synchronize(events, now);
    this.state.bootstrap = { projectorVersion: MEMORY_TOPIC_PROJECTOR_VERSION,
      sourceVersions: Object.fromEntries(sourceVersions(new Map(events.filter(visible).map((event) => [event.id, event])))),
      status: 'pending', startedAt: now, completedAt: null, failedEvents: 0 };
    this.synchronize(events, now);
  }

  synchronize(events: readonly EventCard[], now: string): void {
    const sources = new Map(events.filter(visible).map((event) => [event.id, event]));
    const versions = sourceVersions(sources);
    for (const topic of this.state.topics) {
      if (topic.projectorVersion !== MEMORY_TOPIC_PROJECTOR_VERSION
        || Object.entries(topic.dependencyVersions ?? topic.sourceVersions).some(([id, version]) => versions.get(id) !== version)) {
        // Clear cached language itself, not only its evidence pointers.
        topic.invalidated = true;
        topic.title = '';
        topic.description = '';
        topic.overview = [];
        for (const id of topic.sourceEventIds) if (sources.has(id)) delete this.state.projectedVersions[id];
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
    const bootstrap = this.state.bootstrap;
    if (bootstrap && bootstrap.projectorVersion === MEMORY_TOPIC_PROJECTOR_VERSION && bootstrap.status !== 'completed') {
      const outstanding = Object.entries(bootstrap.sourceVersions).filter(([id, version]) =>
        versions.get(id) === version && this.state.projectedVersions[id] !== version);
      bootstrap.failedEvents = outstanding.filter(([id, version]) => this.state.jobs.some((job) =>
        !job.superseded && job.status === 'failed' && job.attempts >= TOPIC_MAX_ATTEMPTS
        && job.sourceVersions[id] === version && jobInputsCurrent(job, versions))).length;
      if (outstanding.length === bootstrap.failedEvents) {
        bootstrap.status = 'completed'; bootstrap.completedAt = now;
      }
    }
  }

  recover(now: string): void {
    for (const job of this.state.jobs) if (job.status === 'running'
      && Date.parse(job.leaseUntil ?? job.updatedAt) <= Date.parse(now)) {
      job.status = 'failed'; job.lastError = 'timeout'; job.context = null;
      job.nextRetryAt = job.attempts < TOPIC_MAX_ATTEMPTS ? now : null;
      job.leaseUntil = null;
      job.updatedAt = now;
    }
  }

  private pendingEvents(events: readonly EventCard[]): EventCard[] {
    const sources = new Map(events.filter(visible).map((event) => [event.id, event]));
    const versions = sourceVersions(sources);
    const dirtyIds = new Set(this.state.topics.filter((topic) => topic.projectorVersion !== MEMORY_TOPIC_PROJECTOR_VERSION
      || Object.entries(topic.dependencyVersions ?? topic.sourceVersions).some(([id, version]) => versions.get(id) !== version))
      .flatMap((topic) => topic.sourceEventIds));
    return events.filter(visible).filter((event) => {
      const version = versions.get(event.id)!;
      if (this.state.projectedVersions[event.id] === version && !dirtyIds.has(event.id)) return false;
      return !this.state.jobs.some((job) => !job.superseded && job.projectorVersion === MEMORY_TOPIC_PROJECTOR_VERSION
        && job.sourceVersions[event.id] === version
        && jobInputsCurrent(job, versions)
        && (job.status === 'running' || job.status === 'pending'
          || (job.status === 'failed' && (job.attempts >= TOPIC_MAX_ATTEMPTS || job.nextRetryAt !== null))));
    }).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  private isBootstrap(id: string, version: string): boolean {
    const bootstrap = this.state.bootstrap;
    return !bootstrap || bootstrap.projectorVersion !== MEMORY_TOPIC_PROJECTOR_VERSION
      || (bootstrap.status !== 'completed' && bootstrap.sourceVersions[id] === version);
  }

  private matchesMode(ids: readonly string[], versions: ReadonlyMap<string, string>, mode: TopicProjectionMode): boolean {
    return mode === 'all' || ids.some((id) => this.isBootstrap(id, versions.get(id)!) === (mode === 'bootstrap'));
  }

  hasPending(events: readonly EventCard[], now: number, mode: TopicProjectionMode = 'all'): boolean {
    const sources = new Map(events.filter(visible).map((event) => [event.id, event]));
    const versions = sourceVersions(sources);
    const running = this.state.jobs.find((job) => job.status === 'running');
    if (running) return Date.parse(running.leaseUntil ?? running.updatedAt) <= now
      || !jobInputsCurrent(running, versions);
    return this.pendingEvents(events).some((event) => this.matchesMode([event.id], versions, mode)) || this.state.jobs.some((job) =>
      !job.superseded && job.projectorVersion === MEMORY_TOPIC_PROJECTOR_VERSION && job.attempts < TOPIC_MAX_ATTEMPTS
      && (job.status === 'pending' || (job.status === 'failed'
        && job.nextRetryAt !== null && Date.parse(job.nextRetryAt) <= now))
      && jobInputsCurrent(job, versions) && this.matchesMode(job.sourceEventIds, versions, mode));
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
      && (job.status === 'pending' || (job.status === 'failed' && job.nextRetryAt !== null
        && Date.parse(job.nextRetryAt) <= Date.parse(now)))
      && jobInputsCurrent(job, versions) && this.matchesMode(job.sourceEventIds, versions, mode))
      .sort((a, b) => Number(this.isBootstrap(a.sourceEventIds[0]!, versions.get(a.sourceEventIds[0]!)!))
        - Number(this.isBootstrap(b.sourceEventIds[0]!, versions.get(b.sourceEventIds[0]!)!)))[0];
    let job = eligible;
    if (job && this.isBootstrap(job.sourceEventIds[0]!, versions.get(job.sourceEventIds[0]!)!)
      && mode === 'all' && this.pendingEvents(events).some((event) => !this.isBootstrap(event.id, versions.get(event.id)!))) job = undefined;
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
      const pending = this.pendingEvents(events).filter((event) => this.matchesMode([event.id], versions, mode))
        .sort((a, b) => Number(this.isBootstrap(a.id, versions.get(a.id)!)) - Number(this.isBootstrap(b.id, versions.get(b.id)!)))
        .filter((event) => !this.state.jobs.some((candidate) =>
        candidate.status === 'failed' && candidate.attempts < TOPIC_MAX_ATTEMPTS
        && candidate.nextRetryAt !== null && candidate.sourceVersions[event.id] === versions.get(event.id)));
      // Never mix a new incremental source into a historical budgeted batch.
      const first = pending[0];
      const sameKind = pending.filter((event) => first && this.isBootstrap(event.id, versions.get(event.id)!)
        === this.isBootstrap(first.id, versions.get(first.id)!)).slice(0, TOPIC_BATCH_LIMIT);
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
      this.state.jobs.push(job);
    }
    const batch = job.sourceEventIds.map((id) => sources.get(id)!);
    const batchIds = new Set(job.sourceEventIds);
    const query = batch.map(compactEvent).map((event) => `${event.title} ${event.summary} ${event.tags.join(' ')}`).join(' ');
    const eligibleTopics = this.list(events).filter((topic) => !topic.id.startsWith('fallback:'));
    const lexicalScores = new Map(bm25Rank(eligibleTopics, query, (topic) => weightedSearchTokens([
      [topic.title, 4], [topic.description, 2],
    ])).map(({ item, score }) => [item.id, score]));
    const overlap = (topic: MemoryTopic): number => topic.sourceEventIds.filter((id) => batchIds.has(id)).length;
    const candidates = eligibleTopics.sort((a, b) => overlap(b) - overlap(a)
      || (lexicalScores.get(b.id) ?? 0) - (lexicalScores.get(a.id) ?? 0)
      || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)).slice(0, TOPIC_CANDIDATE_LIMIT);
    const existingTopics: TopicProjectionCandidate[] = [];
    // Conservative character budget remains bounded for CJK without a tokenizer dependency.
    let remaining = 30_000 - JSON.stringify(batch.map(compactEvent)).length;
    for (const topic of candidates) {
      const overview = topic.overview.slice(0, 4);
      const exposed = unique([...overview.flatMap((part) => part.sourceEventIds),
        ...topic.sourceEventIds.filter((id) => batchIds.has(id))]);
      const candidate = { id: topic.id, title: topic.title, description: topic.description,
        overview, sourceEventIds: exposed, totalSourceEvents: topic.sourceEventIds.length };
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
    job.context = { jobId: job.id, events: batch.map(compactEvent), existingTopics, truncatedEventIds };
    const storedById = new Map(this.state.topics.map((topic) => [topic.id, topic]));
    job.candidateVersions = Object.fromEntries(existingTopics.map((topic) => [topic.id, digest(storedById.get(topic.id))]));
    const dependencyIds = unique([...job.sourceEventIds, ...existingTopics.flatMap((topic) =>
      [
        ...storedById.get(topic.id)!.sourceEventIds.filter((id) => sources.has(id)),
        ...(!storedById.get(topic.id)!.invalidated
          ? Object.keys(storedById.get(topic.id)!.dependencyVersions ?? {}).filter((id) => sources.has(id)) : []),
      ])]);
    job.dependencyVersions = Object.fromEntries(dependencyIds.map((id) => [id, versions.get(id)!]));
    job.status = 'running'; job.attempts += 1; job.lastError = null; job.nextRetryAt = null; job.updatedAt = now;
    if (this.state.bootstrap.status === 'pending' && this.matchesMode(job.sourceEventIds, versions, 'bootstrap')) {
      this.state.bootstrap.status = 'running';
    }
    job.leaseUntil = new Date(Date.parse(now) + TOPIC_LEASE_MS).toISOString();
    return structuredClone(job.context);
  }

  complete(id: string, result: TopicProjectionResult, events: readonly EventCard[], now: string): { topicIds: string[] } {
    const job = this.requireJob(id);
    if (job.status === 'completed') return { topicIds: [...job.topicIds] };
    if (job.status !== 'running' || !job.context) throw new Error(`Topic projection ${id} is not running`);
    if (Date.parse(job.leaseUntil ?? job.updatedAt) <= Date.parse(now)) throw new Error('Topic projection lease expired; stale result rejected.');
    const sources = new Map(events.filter(visible).map((event) => [event.id, event]));
    const versions = sourceVersions(sources);
    if (!jobInputsCurrent(job, versions)
      || Object.entries(job.candidateVersions).some(([topicId, version]) =>
        digest(this.state.topics.find((topic) => topic.id === topicId)) !== version)) {
      throw new Error('Topic projection source version changed; stale result rejected.');
    }
    if (!Array.isArray(result?.topics) || result.topics.length < 1 || result.topics.length > 12) throw new Error('Topic projection must return 1-12 topics.');
    const candidates = new Map(job.context.existingTopics.map((topic) => [topic.id, topic]));
    const allowed = new Set([...job.sourceEventIds, ...job.context.existingTopics.flatMap((topic) => topic.sourceEventIds)]);
    const batchIds = new Set(job.sourceEventIds);
    const covered = new Set<string>();
    const touched = new Set<string>();
    const proposals: StoredMemoryTopic[] = [];
    const checkIds = (ids: string[], label: string): string[] => {
      if (!Array.isArray(ids) || ids.length === 0 || unique(ids).length !== ids.length
        || ids.some((eventId) => typeof eventId !== 'string' || !allowed.has(eventId))) throw new Error(`Invalid topic ${label} source events.`);
      return ids;
    };
    for (const proposal of result.topics) {
      const ids = checkIds(proposal.sourceEventIds, 'membership');
      // An unambiguous membership continuation keeps its storage identity even
      // when the model omits topicId. Ambiguous regrouping is not inferred.
      const matching = this.state.topics.filter((topic) => candidates.has(topic.id)
        && topic.sourceEventIds.some((eventId) => ids.includes(eventId)));
      const inferred = matching.length === 1 && result.topics.filter((other) =>
        Array.isArray(other.sourceEventIds) && matching[0]!.sourceEventIds.some((eventId) => other.sourceEventIds.includes(eventId))).length === 1
        ? matching[0] : undefined;
      const existing = proposal.topicId ? this.state.topics.find((topic) => topic.id === proposal.topicId) : inferred;
      if (proposal.topicId && (!existing || !candidates.has(proposal.topicId))) throw new Error('Unknown or unexposed topic id.');
      const topicId = existing?.id ?? `topic_${randomUUID()}`;
      if (touched.has(topicId)) throw new Error('A topic may be updated only once per projection.');
      touched.add(topicId);
      if (typeof proposal.title !== 'string' || !proposal.title.trim() || [...proposal.title].length > 120
        || typeof proposal.description !== 'string' || !proposal.description.trim() || [...proposal.description].length > 400) throw new Error('Invalid topic title or description.');
      for (const eventId of ids) if (batchIds.has(eventId)) covered.add(eventId);
      if (!Array.isArray(proposal.overview) || proposal.overview.length > 8) throw new Error('Topic overview must contain at most 8 sections.');
      for (const part of proposal.overview) {
        if (!['history', 'decision', 'change', 'open-question', 'scope'].includes(part.kind)
          || typeof part.text !== 'string' || !part.text.trim() || [...part.text].length > 600) throw new Error('Invalid topic overview section.');
        checkIds(part.sourceEventIds, 'overview');
        if (part.kind !== 'scope' && part.sourceEventIds.some((eventId) => job.context!.truncatedEventIds?.includes(eventId))) {
          throw new Error('Truncated topic sources permit navigation scope only, not factual overview.');
        }
        if (part.sourceEventIds.length > 12 || part.sourceEventIds.some((eventId) => !ids.includes(eventId))) throw new Error('Overview references must belong to returned topic membership.');
        if (part.sourceEventIds.some((eventId) => !batchIds.has(eventId))
          && !candidates.get(topicId)?.overview.some((old) => digest(old) === digest(part))) throw new Error('Old overview evidence must be preserved verbatim; new sections need batch events.');
      }
      const membership = unique([...(existing?.sourceEventIds ?? []).filter((eventId) => sources.has(eventId)), ...ids]);
      const inherited = existing && !existing.invalidated ? existing.overview : [];
      const overview = unique(proposal.overview.map((part) => JSON.stringify(part))).map((part) => JSON.parse(part) as MemoryTopicOverview);
      // Retain old sections when room permits; every member remains indexed even beyond this overview cap.
      for (const part of inherited) if (overview.length < 8 && !overview.some((current) => digest(current) === digest(part))) overview.push(structuredClone(part));
      proposals.push({ id: topicId, title: proposal.title.trim(), description: proposal.description.trim(),
        sourceEventIds: membership, overview, sourceVersions: Object.fromEntries(membership.map((eventId) => [eventId, versions.get(eventId)!])),
        dependencyVersions: { ...(!existing?.invalidated ? existing?.dependencyVersions ?? {} : {}), ...job.dependencyVersions },
        projectorVersion: MEMORY_TOPIC_PROJECTOR_VERSION, invalidated: false,
        createdAt: existing?.createdAt ?? now, updatedAt: now });
    }
    if (job.sourceEventIds.some((eventId) => !covered.has(eventId))) throw new Error('Topic projection omitted batch events.');
    for (const topic of proposals) {
      const index = this.state.topics.findIndex((current) => current.id === topic.id);
      if (index < 0) this.state.topics.push(topic); else this.state.topics[index] = topic;
    }
    Object.assign(this.state.projectedVersions, job.sourceVersions);
    // A redacted predecessor may span several batches or an ambiguous result.
    // Retire it only once every surviving member has actually been projected.
    this.state.topics = this.state.topics.filter((topic) => !topic.invalidated
      || topic.sourceEventIds.some((eventId) => sources.has(eventId)
        && this.state.projectedVersions[eventId] !== versions.get(eventId)));
    job.status = 'completed'; job.topicIds = proposals.map((topic) => topic.id); job.context = null;
    job.leaseUntil = null; job.dependencyVersions = {}; job.candidateVersions = {};
    job.lastError = null; job.nextRetryAt = null; job.updatedAt = now;
    return { topicIds: [...job.topicIds] };
  }

  fail(id: string, error: unknown, now: string): void {
    const job = this.state.jobs.find((candidate) => candidate.id === id);
    if (!job || job.status !== 'running') return;
    job.status = 'failed'; job.context = null;
    job.leaseUntil = null;
    const message = error instanceof Error ? error.message : String(error);
    job.lastError = /timeout|timed out/i.test(message) ? 'timeout'
      : /source.*changed|stale|not running/i.test(message) ? 'source-changed'
        : /invalid|omitted|unknown|overview|projection must|truncat/i.test(message) ? 'invalid-output' : 'worker-failed';
    job.nextRetryAt = job.attempts < TOPIC_MAX_ATTEMPTS
      ? new Date(Date.parse(now) + 30_000 * 2 ** Math.max(0, job.attempts - 1)).toISOString() : null;
    job.updatedAt = now;
  }

  private requireJob(id: string): TopicProjectionJob {
    const job = this.state.jobs.find((candidate) => candidate.id === id);
    if (!job) throw new Error(`Unknown topic projection: ${id}`);
    return job;
  }
}
