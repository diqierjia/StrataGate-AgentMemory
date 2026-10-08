import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { MemoryTopicDirectory, StrataGate, TOPIC_RECOVERY_VERSION, TopicProjectionError,
  memoryTopicEventFingerprint, safeTopicDiagnostics,
  type EventCard, type LoadedStrataGateState, type TopicProjectionContext, type TopicProjectionJob } from '../src/index.js';
import { SqliteStorage } from '../src/sqlite.js';

const options = { blockTurnSize: 1, disableElementProjection: true,
  summarizer: async () => ({ l0Title: '资料', l0Tags: [], l1Summary: '资料', l2Keypoints: [], shouldExtract: false }) };
const initialClock = Date.parse('2026-10-08T00:00:00Z');
const versions = (events: readonly EventCard[]) => Object.fromEntries(events.map((event) => [event.id, memoryTopicEventFingerprint(event)]));
const result = (context: TopicProjectionContext, text = '完整概要') => ({ topics: [{
  title: '项目', description: '项目资料', sourceEventIds: context.events.map(({ id }) => id),
  overview: [{ kind: 'history' as const, text, sourceEventIds: context.events.map(({ id }) => id) }],
}] });

async function fixture(count = 14, completed = 2) {
  const memory = StrataGate.inMemory(options);
  await memory.appendTurn({ user: 'PRIVATE ORIGINAL CONVERSATION', assistant: '记录' });
  const block = memory.listBlocks()[0]!;
  for (let i = 0; i < count; i++) await memory.addEvent({ id: `event-${i}`, title: `PRIVATE EVENT ${i}`, summary: `PRIVATE SOURCE ${i}`,
    sourceBlockId: block.id, sourceMessageIds: [block.l5Raw[0]!.id] });
  const events = memory.listEvents();
  const directory = new MemoryTopicDirectory(); directory.initializeBootstrap(events, new Date(initialClock).toISOString());
  const state = directory.snapshot();
  state.projectedVersions = versions(events.slice(0, completed));
  if (completed) state.topics = [{ id: 'completed-topic', title: '已完成章节', description: '资料',
    sourceEventIds: events.slice(0, completed).map(({ id }) => id), sourceVersions: versions(events.slice(0, completed)),
    dependencyVersions: versions(events.slice(0, completed)), overview: [], sections: [{ title: '历史', sourceEventIds: events.slice(0, completed).map(({ id }) => id) }],
    projectorVersion: 3, invalidated: false, createdAt: new Date(initialClock).toISOString(), updatedAt: new Date(initialClock).toISOString() }];
  directory.restore(state);
  let clock = initialClock;
  let oldContext!: TopicProjectionContext;
  for (let i = 0; i < 3; i++) {
    oldContext = directory.claim(events, new Date(clock).toISOString(), 'bootstrap')!;
    directory.fail(oldContext.jobId, new Error('PRIVATE MODEL OUTPUT'), new Date(clock).toISOString());
    clock += 120000;
  }
  const legacy = directory.snapshot(events);
  delete legacy.recoveryVersion;
  for (const job of legacy.jobs) delete job.diagnostics; // Older DBs did not have diagnostics.
  const snapshot = memory.exportSnapshot(); snapshot.memoryTopicState = legacy;
  await memory.close();
  return { events, legacy, snapshot, clock, oldContext };
}

describe('Issue #119 writer-open recovery', () => {
  it.each(['', ' \t\n', '字'.repeat(601), '𠮷'.repeat(601)])('rejects invalid overview text atomically at the core commit gate (%s)', async (text) => {
    const { events } = await fixture(1, 0);
    const directory = new MemoryTopicDirectory(); directory.initializeBootstrap(events, new Date(initialClock).toISOString());
    const claim = directory.claim(events, new Date(initialClock).toISOString())!;
    const before = directory.snapshot();
    let error!: TopicProjectionError;
    try { directory.complete(claim.jobId, result(claim, text), events, new Date(initialClock).toISOString()); }
    catch (caught) { error = caught as TopicProjectionError; }
    expect(error).toBeInstanceOf(TopicProjectionError);
    expect(error.diagnostics).toMatchObject({ category: 'validation-failed', fieldPath: 'topics[0].overview[0].text',
      actualCharacters: Array.from(text).length, minCharacters: 1, maxCharacters: 600 });
    expect(error.diagnostics.reason).toBe(!text ? 'overview.text is empty' : !text.trim() ? 'overview.text contains only whitespace' : 'overview.text exceeds the character limit');
    expect(directory.snapshot()).toEqual(before);
    expect(JSON.stringify(error)).not.toContain('PRIVATE');
  });

  it.each(['字'.repeat(600), '𠮷'.repeat(600)])('commits a complete 600-character overview verbatim', async (text) => {
    const { events } = await fixture(1, 0);
    const directory = new MemoryTopicDirectory(); directory.initializeBootstrap(events, new Date(initialClock).toISOString());
    const claim = directory.claim(events, new Date(initialClock).toISOString())!;
    directory.complete(claim.jobId, result(claim, text), events, new Date(initialClock).toISOString());
    expect(directory.snapshot().topics[0]!.overview[0]!.text).toBe(text);
  });

  it.each(['success', 'failed'] as const)('persists one fresh three-attempt cycle across SQLite reopen (%s)', async (outcome) => {
    const folder = await mkdtemp(join(tmpdir(), 'stratagate-issue119-'));
    const database = join(folder, 'fixture.sqlite'), namespace = 'issue119';
    const old = await fixture(86, 74);
    let clock = old.clock;
    const storage = new SqliteStorage({ filename: database });
    await storage.save(namespace, old.snapshot, 0); await storage.close();
    const open = () => StrataGate.open({ ...options, database, namespace, now: () => new Date(clock) });
    let memory = await open();
    const calls = vi.fn(async (context: TopicProjectionContext, attempt: number) => {
      if (outcome === 'success' && attempt === 3) return result(context);
      throw new TopicProjectionError('validation-failed', 'overview.text exceeds the character limit', {
        fieldPath: 'topics[0].overview[0].text', actualCharacters: 601, maxCharacters: 600, minCharacters: 1 });
    });
    try {
      expect(memory.exportSnapshot().memoryTopicState!.recoveryVersion).toBe(TOPIC_RECOVERY_VERSION);
      expect(memory.listTopicProjectionJobs().filter(({ status }) => status === 'pending')).toHaveLength(1);
      expect(memory.listTopicProjectionJobs().at(-1)).toMatchObject({ attempts: 0, splitDepth: 0 });
      expect(memory.getTopicBootstrapState()).toMatchObject({ status: 'pending', failedEvents: 0 });
      expect(memory.listEvents()).toEqual(old.events);
      expect(memory.exportSnapshot().blocks).toEqual(old.snapshot.blocks);
      expect(memory.exportSnapshot().graphNodes).toEqual(old.snapshot.graphNodes);
      expect(memory.exportSnapshot().graphEdges).toEqual(old.snapshot.graphEdges);
      const completedTopic = memory.exportSnapshot().memoryTopicState!.topics[0]!;
      const requeuedId = memory.listTopicProjectionJobs().at(-1)!.id;
      const revision = memory.storageRevision;
      for (let i = 0; i < 3; i++) {
        await memory.close(); memory = await open();
        expect(memory.storageRevision).toBe(revision);
        expect(memory.listTopicProjectionJobs().at(-1)!.id).toBe(requeuedId);
        expect(calls).not.toHaveBeenCalled();
      }
      for (let attempt = 1; attempt <= 3; attempt++) {
        const claim = (await memory.claimNextTopicProjection('bootstrap'))!;
        expect(claim.events.map(({ id }) => id)).toEqual(old.events.slice(74).map(({ id }) => id));
        expect(memory.listTopicProjectionJobs().at(-1)!.attempts).toBe(attempt);
        expect(await memory.claimNextTopicProjection()).toBeNull(); // one in-flight call
        await expect(memory.completeTopicProjection(old.oldContext.jobId, result(claim))).rejects.toThrow(/not running/);
        try { await memory.completeTopicProjection(claim.jobId, await calls(claim, attempt)); }
        catch (error) { await memory.failTopicProjection(claim.jobId, error); }
        clock += 120000;
        await memory.close(); memory = await open();
      }
      expect(calls).toHaveBeenCalledTimes(3);
      expect(await memory.claimNextTopicProjection()).toBeNull();
      const settled = memory.listTopicProjectionJobs();
      expect(settled.at(-1)!.status).toBe(outcome === 'success' ? 'completed' : 'failed');
      expect(memory.exportSnapshot().memoryTopicState!.topics[0]).toEqual(completedTopic);
      for (let i = 0; i < 3; i++) {
        await memory.close(); memory = await open();
        expect(memory.listTopicProjectionJobs()).toEqual(settled);
        expect(await memory.claimNextTopicProjection()).toBeNull();
      }
      expect(calls).toHaveBeenCalledTimes(3);
      if (outcome === 'failed') {
        expect(memory.getTopicBootstrapState()!.failedEvents).toBe(12);
        expect(JSON.stringify(settled)).not.toContain('PRIVATE');
        const retry = await memory.retryTopicProjection(settled.at(-1)!.id);
        await memory.close(); memory = await open();
        const claim = (await memory.claimNextTopicProjection('bootstrap'))!;
        expect(claim.jobId).toBe(retry.jobId);
        expect(memory.listTopicProjectionJobs().at(-1)!.attempts).toBe(1);
        await memory.completeTopicProjection(claim.jobId, result(claim));
      }
    } finally { await memory.close(); await rm(folder, { recursive: true, force: true }); }
  });

  it('requires a real replacement when upgrading a legacy field failure without saved paragraph identities', async () => {
    const { events, legacy, clock } = await fixture(2, 0);
    legacy.jobs.at(-1)!.diagnostics = new TopicProjectionError('validation-failed',
      'overview.text must be nonempty and at most 600 characters').diagnostics;
    const directory = new MemoryTopicDirectory(); directory.restore(legacy);
    directory.initializeBootstrap(events, new Date(clock).toISOString());
    const claim = directory.claim(events, new Date(clock).toISOString())!;
    expect(claim.overviewRepairRequirements).toEqual([{ sourceEventIds: [], minimumEntries: 1 }]);
    const empty = result(claim); empty.topics[0]!.overview = [];
    expect(() => directory.complete(claim.jobId, empty, events, new Date(clock).toISOString())).toThrow('must replace invalid overview');
    expect(directory.snapshot().projectedVersions).toEqual({});
    directory.complete(claim.jobId, result(claim), events, new Date(clock).toISOString());
    expect(Object.keys(directory.snapshot().projectedVersions)).toHaveLength(2);
  });

  it('persists overview repair obligations across attempts/restarts and manual retry without fake completion', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'stratagate-overview-integrity-'));
    const database = join(folder, 'fixture.sqlite'), namespace = 'overview-integrity';
    const old = await fixture(1, 0);
    const setup = new SqliteStorage({ filename: database }); await setup.save(namespace, old.snapshot, 0); await setup.close();
    let clock = old.clock;
    const open = () => StrataGate.open({ ...options, database, namespace, now: () => new Date(clock) });
    let memory = await open();
    try {
      for (let attempt = 1; attempt <= 3; attempt++) {
        const claim = (await memory.claimNextTopicProjection('bootstrap'))!;
        const output = result(claim, '敏'.repeat(601));
        if (attempt > 1) output.topics[0]!.overview = [];
        const before = memory.exportSnapshot().memoryTopicState!.projectedVersions;
        const error = await memory.completeTopicProjection(claim.jobId, output).catch((error) => error);
        expect(error).toBeInstanceOf(TopicProjectionError);
        expect(error.diagnostics.reason).toBe(attempt === 1 ? 'overview.text exceeds the character limit' : 'Topic retry must replace invalid overview without removing entries.');
        expect(memory.exportSnapshot().memoryTopicState!.projectedVersions).toEqual(before);
        await memory.failTopicProjection(claim.jobId, error);
        expect(memory.listTopicProjectionJobs().at(-1)!.overviewRepairRequirements).toEqual([
          { kind: 'history', sourceEventIds: ['event-0'], minimumEntries: 1 },
        ]);
        expect(JSON.stringify(error)).not.toMatch(/敏|PRIVATE|event-0/);
        expect(JSON.stringify(memory.listTopicProjectionJobs())).not.toMatch(/敏|PRIVATE/);
        clock += 120000; await memory.close(); memory = await open();
      }
      expect(await memory.claimNextTopicProjection()).toBeNull();
      expect(memory.getTopicBootstrapState()).toMatchObject({ status: 'failed', failedEvents: 1 });
      const failed = memory.listTopicProjectionJobs().at(-1)!;
      const retry = await memory.retryTopicProjection(failed.id);
      await memory.close(); memory = await open();
      const claim = (await memory.claimNextTopicProjection())!;
      expect(claim.jobId).toBe(retry.jobId);
      expect(claim.overviewRepairRequirements).toEqual(failed.overviewRepairRequirements);
      const empty = result(claim); empty.topics[0]!.overview = [];
      await expect(memory.completeTopicProjection(claim.jobId, empty)).rejects.toThrow('must replace invalid overview');
      await memory.completeTopicProjection(claim.jobId, result(claim));
      expect(memory.getTopicBootstrapState()).toMatchObject({ status: 'completed', failedEvents: 0 });
      expect(memory.listEvents()).toEqual(old.events);
      expect(memory.listTopicProjectionJobs().at(-1)!.overviewRepairRequirements).toBeUndefined();
    } finally { await memory.close(); await rm(folder, { recursive: true, force: true }); }
  });

  it('rejects copied replacements atomically and persists genuinely different reordered replacements', async () => {
    const { events, legacy, clock } = await fixture(1, 0);
    legacy.jobs.at(-1)!.overviewRepairRequirements = [{ kind: 'history', sourceEventIds: [events[0]!.id], minimumEntries: 2 }];
    const directory = new MemoryTopicDirectory(); directory.restore(legacy);
    directory.initializeBootstrap(events, new Date(clock).toISOString());
    const claim = directory.claim(events, new Date(clock).toISOString())!;
    const copied = result(claim); copied.topics[0]!.overview.push(structuredClone(copied.topics[0]!.overview[0]!));
    const before = directory.snapshot();
    expect(() => directory.complete(claim.jobId, copied, events, new Date(clock).toISOString())).toThrow('must replace invalid overview');
    expect(directory.snapshot()).toEqual(before);
    copied.topics[0]!.overview[1]!.text = '另一个有来源的历史进展。'; copied.topics[0]!.overview.reverse();
    directory.complete(claim.jobId, copied, events, new Date(clock).toISOString());
    expect(directory.snapshot().topics[0]!.overview).toEqual(copied.topics[0]!.overview);
    expect(directory.snapshot(events).bootstrap).toMatchObject({ status: 'completed', failedEvents: 0 });
  });

  it('checks repair integrity after obsolete inherited sections are filtered from persisted overview', async () => {
    const { events, legacy, clock } = await fixture(2, 1);
    const old = { kind: 'history' as const, title: '旧节', text: '以前的记录。', sourceEventIds: [events[1]!.id] };
    legacy.topics[0]!.sourceEventIds = events.map(({ id }) => id); legacy.topics[0]!.sourceVersions = versions(events);
    legacy.topics[0]!.overview = [old]; legacy.topics[0]!.sections = [
      { title: '旧节', sourceEventIds: [events[1]!.id] }, { title: '历史', sourceEventIds: [events[0]!.id] },
    ];
    legacy.jobs.at(-1)!.overviewRepairRequirements = [{ kind: 'history', sourceEventIds: [events[1]!.id], minimumEntries: 1 }];
    const directory = new MemoryTopicDirectory(); directory.restore(legacy);
    directory.initializeBootstrap(events, new Date(clock).toISOString());
    const claim = directory.claim(events, new Date(clock).toISOString())!;
    const output = { topics: [{ ...result(claim).topics[0]!, topicId: legacy.topics[0]!.id, overview: [structuredClone(old)],
      sections: [{ title: '历史', sourceEventIds: [events[1]!.id] }],
    }] };
    const before = directory.snapshot();
    expect(() => directory.complete(claim.jobId, output, events, new Date(clock).toISOString())).toThrow('must replace invalid overview');
    expect(directory.snapshot()).toEqual(before);
  });

  it('preserves repair obligations when max-tokens splits a later attempt', async () => {
    const { events, clock } = await fixture(2, 0);
    const directory = new MemoryTopicDirectory(); directory.initializeBootstrap(events, new Date(clock).toISOString());
    let claim = directory.claim(events, new Date(clock).toISOString())!;
    try { directory.complete(claim.jobId, result(claim, '字'.repeat(601)), events, new Date(clock).toISOString()); }
    catch (error) { directory.fail(claim.jobId, error, new Date(clock).toISOString()); }
    claim = directory.claim(events, new Date(clock + 120000).toISOString())!;
    directory.fail(claim.jobId, new TopicProjectionError('max-tokens', 'output token limit reached', { finishReason: 'max-tokens' }), new Date(clock + 120000).toISOString());
    const children = directory.jobs().filter(({ status }) => status === 'pending');
    expect(children).toHaveLength(2);
    for (const child of children) expect(child.overviewRepairRequirements).toEqual([{ kind: 'history', sourceEventIds: child.sourceEventIds, minimumEntries: 1 }]);
    for (let i = 0; i < 2; i++) {
      const child = directory.claim(events, new Date(clock + 240000).toISOString())!;
      const empty = result(child); empty.topics[0]!.overview = [];
      expect(() => directory.complete(child.jobId, empty, events, new Date(clock + 240000).toISOString())).toThrow('must replace invalid overview');
      directory.complete(child.jobId, result(child), events, new Date(clock + 240000).toISOString());
    }
    expect(Object.keys(directory.snapshot().projectedVersions)).toHaveLength(2);
  });

  it.each([true, false])('retires settled failures without changing their historical status (upgrade=%s)', async (upgrade) => {
    const { events, legacy, clock } = await fixture();
    legacy.projectedVersions = versions(events);
    if (!upgrade) legacy.recoveryVersion = TOPIC_RECOVERY_VERSION;
    const oldFailure = legacy.jobs.at(-1)!;
    const directory = new MemoryTopicDirectory(); directory.restore(legacy);
    directory.initializeBootstrap(events, new Date(clock).toISOString());
    expect(directory.jobs().find(({ id }) => id === oldFailure.id)).toMatchObject({ status: 'failed', superseded: true, attempts: 3, nextRetryAt: null });
    expect(directory.jobs().filter(({ status }) => status === 'pending')).toEqual([]);
    expect(directory.bootstrap()).toMatchObject({ status: 'completed', failedEvents: 0 });
    expect(() => directory.retry(oldFailure.id, events, new Date(clock).toISOString())).toThrow(/conflict/);
    expect(directory.snapshot().projectedVersions).toEqual(legacy.projectedVersions);
  });

  it('manually retries only the remaining work of a partially resolved failure', async () => {
    const { events, legacy, clock } = await fixture(3, 0);
    legacy.recoveryVersion = TOPIC_RECOVERY_VERSION;
    legacy.projectedVersions = versions(events.slice(0, 2));
    const oldId = legacy.jobs.at(-1)!.id;
    const directory = new MemoryTopicDirectory(); directory.restore(legacy); directory.synchronize(events, new Date(clock).toISOString());
    const retry = directory.retry(oldId, events, new Date(clock).toISOString());
    const claim = directory.claim(events, new Date(clock).toISOString())!;
    expect(claim.jobId).toBe(retry.jobId);
    expect(claim.events.map(({ id }) => id)).toEqual([events[2]!.id]);
    expect(directory.jobs().at(-1)!.attempts).toBe(1);
    directory.complete(claim.jobId, result(claim), events, new Date(clock).toISOString());
    expect(Object.keys(directory.snapshot().projectedVersions)).toHaveLength(3);
  });

  it('recovers only unfinished current work, including partial batches and valid section backfill', async () => {
    const { events, legacy, clock } = await fixture(6, 2);
    const template = legacy.jobs.at(-1)!;
    const job = (id: string, sources: EventCard[], overrides: Partial<TopicProjectionJob> = {}): TopicProjectionJob => ({ ...structuredClone(template),
      id, sourceEventIds: sources.map(({ id }) => id), sourceVersions: versions(sources), dependencyVersions: {}, superseded: false, ...overrides });
    legacy.jobs = [job('partial', [events[0]!, events[2]!], { overviewRepairRequirements: [
      { kind: 'history', sourceEventIds: [events[0]!.id], minimumEntries: 1 },
      { kind: 'history', sourceEventIds: [events[0]!.id, events[2]!.id], minimumEntries: 1 },
    ] }), job('successful', [events[1]!]),
      job('expired', [events[3]!], { dependencyVersions: { [events[3]!.id]: 'outdated' } }),
      job('retired', [events[4]!], { superseded: true }), job('completed', [events[4]!], { status: 'completed' }),
      job('irrelevant-backfill', [events[5]!], { sectionBackfillTopicId: 'missing-topic' }),
      job('valid-backfill', [events[0]!], { sectionBackfillTopicId: 'completed-topic' })];
    legacy.topics[0]!.sections = [{ title: '历史', sourceEventIds: [events[1]!.id] }];
    legacy.sectionBackfill = { 'completed-topic': versions([events[0]!]) };
    const directory = new MemoryTopicDirectory(); directory.restore(legacy);
    directory.initializeBootstrap(events, new Date(clock).toISOString());
    const queued = directory.jobs().filter(({ status }) => status === 'pending');
    expect(queued).toHaveLength(2);
    expect(queued.map(({ sourceEventIds }) => sourceEventIds)).toEqual([[events[2]!.id], [events[0]!.id]]);
    expect(queued[0]!.overviewRepairRequirements).toEqual([{ kind: 'history', sourceEventIds: [events[2]!.id], minimumEntries: 1 }]);
    expect(queued[1]!.sectionBackfillTopicId).toBe('completed-topic');
    directory.initializeBootstrap(events, new Date(clock + 1).toISOString());
    expect(directory.jobs().filter(({ status }) => status === 'pending')).toEqual(queued);
    expect(directory.snapshot().projectedVersions).toEqual(legacy.projectedVersions);
  });

  it('recovers overlapping terminal ledgers once without duplicating already queued work', async () => {
    const { events, legacy, clock } = await fixture(3, 0);
    const terminal = legacy.jobs.at(-1)!;
    legacy.jobs = [structuredClone(terminal), { ...structuredClone(terminal), id: 'duplicate' },
      { ...structuredClone(terminal), id: 'queued', status: 'pending', attempts: 0,
        sourceEventIds: [events[0]!.id], sourceVersions: versions([events[0]!]) }];
    const directory = new MemoryTopicDirectory(); directory.restore(legacy);
    directory.initializeBootstrap(events, new Date(clock).toISOString());
    const queued = directory.jobs().filter(({ status }) => status === 'pending');
    expect(queued).toHaveLength(2);
    expect(queued.flatMap(({ sourceEventIds }) => sourceEventIds).sort()).toEqual(events.map(({ id }) => id).sort());
    expect(directory.jobs().filter((job) => !job.superseded && job.status === 'failed')).toEqual([]);
  });

  it('honors newer recovery markers rather than resetting cycles after a downgrade', async () => {
    const { events, legacy, clock } = await fixture();
    legacy.recoveryVersion = TOPIC_RECOVERY_VERSION + 1;
    const directory = new MemoryTopicDirectory(); directory.restore(legacy);
    expect(directory.needsInitialization()).toBe(false);
    directory.initializeBootstrap(events, new Date(clock).toISOString());
    expect(directory.snapshot().recoveryVersion).toBe(TOPIC_RECOVERY_VERSION + 1);
    expect(directory.jobs().filter(({ status }) => status === 'pending')).toEqual([]);
  });

  it('commits a single recovery when two old-database writers initialize concurrently', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'stratagate-recovery-race-'));
    const database = join(folder, 'fixture.sqlite'), namespace = 'recovery-race';
    const old = await fixture();
    const setup = new SqliteStorage({ filename: database }); await setup.save(namespace, old.snapshot, 0); await setup.close();
    let release!: () => void, loads = 0;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    class RacingStorage extends SqliteStorage {
      private initial = true;
      override async load(key: string): Promise<LoadedStrataGateState | null> {
        const value = await super.load(key);
        if (this.initial) { this.initial = false; if (++loads === 2) release(); await barrier; }
        return value;
      }
    }
    const stores = [new RacingStorage({ filename: database }), new RacingStorage({ filename: database })];
    let memories: StrataGate[] = [];
    try {
      memories = await Promise.all(stores.map((storage) => StrataGate.openWithStorage({ ...options, storage, namespace, now: () => new Date(old.clock) })));
      expect(memories[0]!.storageRevision).toBe(2);
      expect(memories[1]!.storageRevision).toBe(2);
      expect(memories[0]!.listTopicProjectionJobs()).toEqual(memories[1]!.listTopicProjectionJobs());
      expect(memories[0]!.listTopicProjectionJobs().filter(({ status }) => status === 'pending')).toHaveLength(1);
    } finally {
      release(); await Promise.all(memories.map((memory) => memory.close()));
      await Promise.all(stores.map((storage) => storage.close())); await rm(folder, { recursive: true, force: true });
    }
  });

  it('allowlists field positions and numeric limits without retaining arbitrary diagnostic data', () => {
    expect(safeTopicDiagnostics({ category: 'validation-failed', reason: 'overview.text is empty',
      fieldPath: 'PRIVATE EVENT TEXT', actualCharacters: -1, maxCharacters: 'PRIVATE', response: 'PRIVATE', event: {} }))
      .toEqual({ category: 'validation-failed', reason: 'overview.text is empty' });
  });
});
