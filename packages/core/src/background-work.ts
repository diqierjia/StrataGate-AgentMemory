import { MemoryTopicDirectory, type MemoryTopicState } from './topics.js';
import { DERIVATION_MAX_ATTEMPTS, KNOWLEDGE_GRAPH_PROJECTOR_VERSION, graphProjectionNeedsRecovery,
  type BlockSummaryJob, type ExtractionJob, type GraphProjectionJob } from './storage.js';
import type { EventCard } from './types.js';

export interface BackgroundWorkInput {
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
  const covered = new Set(input.graphProjectionJobs.filter((job) => job.projectorVersion === KNOWLEDGE_GRAPH_PROJECTOR_VERSION)
    .flatMap((job) => job.sourceEventIds));
  if (events.some((event) => event.status !== 'forgotten' && event.status !== 'archived' && !covered.has(event.id))) due.push(0);
  for (const job of input.graphProjectionJobs) {
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
