import { MemoryTopicDirectory, MEMORY_TOPIC_PROJECTOR_VERSION, TOPIC_RECOVERY_VERSION, type MemoryTopicState } from './topics.js';
import { DERIVATION_MAX_ATTEMPTS, KNOWLEDGE_GRAPH_PROJECTOR_VERSION, graphProjectionNeedsRecovery, graphProjectionSourceIds,
  type BlockSummaryJob, type ExtractionJob, type GraphProjectionJob } from './storage.js';
import type { EventCard } from './types.js';

// A persisted derived index must be rebuilt when its eligibility rules change.
export const BACKGROUND_WORK_INDEX_VERSION = JSON.stringify([3, KNOWLEDGE_GRAPH_PROJECTOR_VERSION,
  MEMORY_TOPIC_PROJECTOR_VERSION, TOPIC_RECOVERY_VERSION]);

export interface BackgroundWorkInput {
  graphEnabled?: boolean;
  graphEpoch?: number;
  graphBackfillEventIds?: readonly string[];
  blocks: Array<{ id: string; processingStatus: string; shouldExtract?: boolean }>;
  summaryJobs: readonly BlockSummaryJob[];
  extractionJobs: readonly ExtractionJob[];
  graphProjectionJobs: readonly GraphProjectionJob[];
  events: readonly EventCard[];
  agentEvents: readonly EventCard[];
  memoryTopicState?: MemoryTopicState;
  sealableTail: boolean;
}

export interface BackgroundWorkTimes { core: number | null; incremental: number | null; bootstrap: number | null }

function jobWake(job: { status: string; attempts: number; nextRetryAt: string | null; leaseUntil?: string | null }): number | null {
  // Expired final attempts still need to leave running state, even though no model retry remains.
  if (job.status === 'running') return job.leaseUntil ? Date.parse(job.leaseUntil) : 0;
  if (job.attempts >= DERIVATION_MAX_ATTEMPTS) return null;
  if (job.status === 'pending') return 0;
  return job.status === 'failed' && job.nextRetryAt !== null ? Date.parse(job.nextRetryAt) : null;
}

/** No business state is written here. The persisted Jobs and Topic ledger remain authoritative. */
export function backgroundWorkTimes(input: BackgroundWorkInput, now = Date.now()): BackgroundWorkTimes {
  const due: number[] = input.sealableTail ? [0] : [];
  const summaries = new Map(input.summaryJobs.map((job) => [job.blockId, job]));
  const extractions = new Map(input.extractionJobs.map((job) => [job.blockId, job]));
  for (const block of input.blocks) {
    if (block.processingStatus === 'ready') continue;
    const summary = summaries.get(block.id);
    if (summary?.status === 'succeeded') {
      const extraction = extractions.get(block.id);
      if (block.shouldExtract === false || !extraction) due.push(0);
      else { const time = jobWake(extraction); if (time !== null) due.push(time); }
    } else if (summary) { const time = jobWake(summary); if (time !== null) due.push(time); }
  }
  const events = [...input.events, ...input.agentEvents];
  const eventById = new Map(events.map((event) => [event.id, event]));
  const approved = new Set(input.graphBackfillEventIds ?? []);
  const graphJobCanRun = (job: GraphProjectionJob): boolean =>
    graphProjectionSourceIds(job, eventById, input.graphEpoch ?? 0, approved).length > 0;
  const covered = new Set(input.graphProjectionJobs.filter((job) => job.projectorVersion === KNOWLEDGE_GRAPH_PROJECTOR_VERSION)
    .flatMap((job) => job.sourceEventIds));
  if (input.graphEnabled && events.some((event) => input.graphBackfillEventIds?.includes(event.id) && event.status !== 'forgotten' && event.status !== 'archived' && !covered.has(event.id))) due.push(0);
  for (const job of input.graphEnabled ? input.graphProjectionJobs : []) {
    // Retire spent stale leases even when their sources are no longer approved.
    // This is bookkeeping only and must never schedule another model attempt.
    if (job.attempts >= DERIVATION_MAX_ATTEMPTS && (job.status === 'pending' || job.status === 'running'
      && job.claimEpoch !== undefined && job.claimEpoch !== (input.graphEpoch ?? 0))) { due.push(0); continue; }
    if (!graphJobCanRun(job)) continue;
    if (job.lastError === 'Graph claim revoked') continue;
    if (input.graphEpoch !== undefined && job.claimEpoch !== undefined && job.claimEpoch !== input.graphEpoch
      && job.status !== 'completed' && job.attempts < DERIVATION_MAX_ATTEMPTS) due.push(0);
    const time = jobWake(job);
    if (time !== null) due.push(time);
    if (graphProjectionNeedsRecovery(job, events)) due.push(0);
  }
  const directory = new MemoryTopicDirectory();
  directory.restore(input.memoryTopicState);
  if (directory.needsInitialization()) directory.initializeBootstrap(events, new Date(now).toISOString());
  else directory.synchronize(events, new Date(now).toISOString());
  const finite = due.filter(Number.isFinite);
  return {
    core: finite.length ? Math.min(...finite) : null,
    ...directory.nextWakeTimes(events, now),
  };
}
