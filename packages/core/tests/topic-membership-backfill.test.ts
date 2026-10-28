import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { MemoryTopicDirectory, StrataGate, type TopicProjectionContext } from '../src/index.js';
import { SqliteStorage } from '../src/sqlite.js';

const options = { blockTurnSize: 1, disableElementProjection: true,
  summarizer: async () => ({ l0Title: '原文', l0Tags: [], l1Summary: '资料', l2Keypoints: [], shouldExtract: false }) };

async function legacySnapshot(count = 3) {
  const memory = StrataGate.inMemory(options);
  await memory.appendTurn({ user: '学历及研究原文', assistant: '已记录' });
  const block = memory.listBlocks()[0]!;
  for (let i = 0; i < count; i++) await memory.addEvent({ id: `old-${i}`, title: i ? '西电密码学硕士在读' : '研究兴趣 AI4Math',
    summary: '历史用户信息', sourceBlockId: block.id, sourceMessageIds: [block.l5Raw[0]!.id] });
  let first = true;
  while (memory.hasPendingTopicWork()) {
    const context = (await memory.claimNextTopicProjection())!;
    await memory.completeTopicProjection(context.jobId, { topics: [{
      ...(context.existingTopics[0] ? { topicId: context.existingTopics[0].id } : {}),
      title: '个人背景与学术', description: '用户背景资料', sourceEventIds: context.events.map(({ id }) => id),
      overview: first ? [{ kind: 'history', title: '研究方向', text: '研究兴趣 AI4Math', sourceEventIds: ['old-0'] }] : [],
    }] });
    first = false;
  }
  const snapshot = memory.exportSnapshot();
  delete snapshot.memoryTopicState!.sectionMembershipVersion;
  delete snapshot.memoryTopicState!.sectionBackfill;
  delete snapshot.memoryTopicState!.topics[0]!.sections;
  await memory.close();
  return snapshot;
}

function repair(context: TopicProjectionContext) {
  return { topics: [{ topicId: context.sectionBackfillTopicId!, title: '改名不生效', description: '不会覆盖原描述',
    sourceEventIds: context.events.map(({ id }) => id), overview: [],
    sections: [{ title: '教育背景', sourceEventIds: context.events.map(({ id }) => id) }],
  }] };
}

describe('one-time section membership backfill', () => {
  it.each([false, true])('repairs missing old relations with explicit sections=%s, preserving SQLite facts and read-only state', async (explicit) => {
    const root = await mkdtemp(join(tmpdir(), 'topic-membership-backfill-'));
    const database = join(root, 'memory.db'), namespace = 'project:old-membership';
    let memory: StrataGate | undefined;
    try {
      const baseline = await legacySnapshot();
      if (explicit) baseline.memoryTopicState!.topics[0]!.sections = [{ title: '研究方向', sourceEventIds: ['old-0'] }];
      const writer = new SqliteStorage({ filename: database });
      await writer.save(namespace, baseline, 0); await writer.close();
      const readonly = new SqliteStorage({ filename: database, readonly: true });
      const beforeRead = await readonly.load(namespace), save = vi.spyOn(readonly, 'save');
      const reader = await StrataGate.openWithStorage({ ...options, storage: readonly, namespace });
      expect(reader.hasPendingTopicWork()).toBe(false);
      expect(await readonly.load(namespace)).toEqual(beforeRead);
      expect(save).not.toHaveBeenCalled(); await reader.close();

      const [opened, competing] = await Promise.all([
        StrataGate.open({ ...options, database, namespace }), StrataGate.open({ ...options, database, namespace }),
      ]);
      memory = opened;
      expect(competing.exportSnapshot().memoryTopicState).toEqual(memory.exportSnapshot().memoryTopicState);
      await competing.close();
      const initial = memory.exportSnapshot().memoryTopicState!;
      expect(initial.sectionMembershipVersion).toBe(1);
      expect(Object.keys(initial.sectionBackfill![initial.topics[0]!.id]!)).toEqual(['old-1', 'old-2']);
      expect(memory.hasPendingTopicWork('incremental')).toBe(false);
      expect(memory.hasPendingTopicWork('bootstrap')).toBe(true);
      expect(initial.bootstrap).toEqual(baseline.memoryTopicState!.bootstrap);
      const revision = memory.storageRevision;
      await memory.close(); memory = await StrataGate.open({ ...options, database, namespace });
      expect(memory.storageRevision).toBe(revision);
      const context = (await memory.claimNextTopicProjection('bootstrap'))!;
      expect(context.events.map(({ id }) => id)).toEqual(['old-1', 'old-2']);
      expect(context.existingTopics).toHaveLength(1);
      expect(context.existingTopics[0]!.sectionTitles).toEqual(['研究方向']);
      await memory.completeTopicProjection(context.jobId, repair(context));
      expect(memory.hasPendingTopicWork()).toBe(false);
      const finished = memory.exportSnapshot();
      expect(finished.memoryTopicState!.sectionBackfill).toEqual({});
      expect(finished.memoryTopicState!.topics[0]).toMatchObject({
        id: initial.topics[0]!.id, title: '个人背景与学术', description: '用户背景资料',
        overview: baseline.memoryTopicState!.topics[0]!.overview,
        sourceEventIds: ['old-0', 'old-1', 'old-2'], sections: [
          { title: '研究方向', sourceEventIds: ['old-0'] }, { title: '教育背景', sourceEventIds: ['old-1', 'old-2'] },
        ],
      });
      for (const key of ['events', 'blocks', 'graphNodes', 'graphEdges', 'agentEvents', 'usageReceipts'] as const) {
        expect(finished[key]).toEqual(baseline[key]);
      }
      await memory.close(); memory = await StrataGate.open({ ...options, database, namespace });
      expect(memory.hasPendingTopicWork()).toBe(false);
      expect(memory.listTopicProjectionJobs()).toHaveLength(initial.jobs.length + 1);
    } finally { await memory?.close(); await rm(root, { recursive: true, force: true }); }
  });

  it('fills every missing chapter relation for a multiply-owned Event, without changing known memberships', async () => {
    const snapshot = await legacySnapshot(2), state = snapshot.memoryTopicState!;
    const first = state.topics[0]!;
    state.topics.push({ ...structuredClone(first), id: 'second-chapter', title: '教育与职业',
      sourceEventIds: ['old-1'], overview: [], sections: [] });
    state.topics.push({ ...structuredClone(first), id: 'known-chapter', title: '其他资料',
      sourceEventIds: ['old-1'], overview: [], sections: [{ title: '已知归属', sourceEventIds: ['old-1'] }] });
    const directory = new MemoryTopicDirectory(); directory.restore(state);
    const now = new Date().toISOString(); directory.initializeBootstrap(snapshot.events, now);
    for (let i = 0; i < 2; i++) {
      const context = directory.claim(snapshot.events, now, 'bootstrap')!;
      expect(context.events.map(({ id }) => id)).toEqual(['old-1']);
      directory.complete(context.jobId, repair(context), snapshot.events, now);
    }
    expect(directory.hasPending(snapshot.events, Date.parse(now))).toBe(false);
    expect(directory.snapshot().topics.map(({ sections }) => sections!.flatMap(({ sourceEventIds }) => sourceEventIds)))
      .toEqual([['old-0', 'old-1'], ['old-1'], ['old-1']]);
    expect(directory.snapshot().topics[2]!.sections).toEqual([{ title: '已知归属', sourceEventIds: ['old-1'] }]);
  });

  it('bounds large chapter section hints while retaining the mandatory repair chapter', async () => {
    const snapshot = await legacySnapshot(), directory = new MemoryTopicDirectory();
    const topic = snapshot.memoryTopicState!.topics[0]!;
    topic.overview = [];
    topic.sections = Array.from({ length: 300 }, (_, i) => ({ title: '学术研究分类'.repeat(10) + i, sourceEventIds: ['old-0'] }));
    directory.restore(snapshot.memoryTopicState); const now = new Date().toISOString();
    directory.initializeBootstrap(snapshot.events, now);
    const context = directory.claim(snapshot.events, now)!;
    expect(context.existingTopics).toHaveLength(1);
    const candidate = context.existingTopics[0]!;
    expect(candidate.id).toBe(context.sectionBackfillTopicId);
    expect(candidate.sectionTitles!.length).toBeLessThanOrEqual(120);
    expect(candidate.sectionTitles!.reduce((total, title) => total + JSON.stringify(title).length, 0)).toBeLessThanOrEqual(4_000);
    expect(candidate.sectionTitles!.length + candidate.sectionTitlesOmitted!).toBe(300);
    expect(JSON.stringify(context).length).toBeLessThan(30_000);
  });

  it('isolates an exhausted A relation from B for the same Event, persists restart and manually repairs A', async () => {
    const root = await mkdtemp(join(tmpdir(), 'topic-relation-failure-'));
    const database = join(root, 'memory.db'), namespace = 'project:relation-failure';
    const snapshot = await legacySnapshot(2), state = snapshot.memoryTopicState!, chapterA = state.topics[0]!;
    state.topics.push({ ...structuredClone(chapterA), id: 'chapter-b', title: '学术资料',
      sourceEventIds: ['old-1'], overview: [], sections: [] });
    let clock = Date.now();
    const open = () => StrataGate.open({ ...options, database, namespace, now: () => new Date(clock) });
    let memory: StrataGate | undefined;
    try {
      const storage = new SqliteStorage({ filename: database });
      await storage.save(namespace, snapshot, 0); await storage.close();
      memory = await open(); let failedJob = '';
      for (let i = 0; i < 3; i++) {
        const context = (await memory.claimNextTopicProjection('bootstrap'))!;
        expect(context.sectionBackfillTopicId).toBe(chapterA.id);
        failedJob = context.jobId; await memory.failTopicProjection(failedJob, new Error('invalid sections'));
        clock += 120_000;
      }
      await memory.close(); memory = await open();
      expect(memory.hasPendingTopicWork('bootstrap')).toBe(true);
      expect(memory.hasPendingTopicWork('incremental')).toBe(false);
      const contextB = (await memory.claimNextTopicProjection('bootstrap'))!;
      expect(contextB.sectionBackfillTopicId).toBe('chapter-b');
      expect(contextB.events.map(({ id }) => id)).toEqual(['old-1']);
      await memory.completeTopicProjection(contextB.jobId, repair(contextB));
      expect(memory.hasPendingTopicWork()).toBe(false);
      expect(await memory.claimNextTopicProjection('bootstrap')).toBeNull();
      expect(memory.exportSnapshot().memoryTopicState!.sectionBackfill).toEqual({
        [chapterA.id]: { 'old-1': state.projectedVersions['old-1']! },
      });
      const beforeRestart = memory.exportSnapshot().memoryTopicState;
      await memory.close(); memory = await open();
      expect(memory.exportSnapshot().memoryTopicState).toEqual(beforeRestart);
      expect(memory.hasPendingTopicWork()).toBe(false);
      expect(memory.listTopicProjectionJobs().find(({ id }) => id === failedJob)).toMatchObject({ attempts: 3, status: 'failed', nextRetryAt: null });
      const retry = await memory.retryTopicProjection(failedJob);
      await expect(memory.retryTopicProjection(failedJob)).rejects.toThrow(/retry conflict/);
      const contextA = (await memory.claimNextTopicProjection('incremental'))!;
      expect(contextA.jobId).toBe(retry.jobId); expect(contextA.sectionBackfillTopicId).toBe(chapterA.id);
      await memory.completeTopicProjection(contextA.jobId, repair(contextA));
      expect(memory.exportSnapshot().memoryTopicState!.sectionBackfill).toEqual({});
      expect(Object.fromEntries(memory.listMemoryTopics().filter(({ isFallback }) => !isFallback).map(({ id, sections }) =>
        [id, sections!.flatMap(({ sourceEventIds }) => sourceEventIds)]))).toEqual({ [chapterA.id]: ['old-0', 'old-1'], 'chapter-b': ['old-1'] });
      expect(memory.exportSnapshot().events).toEqual(snapshot.events);
    } finally { await memory?.close(); await rm(root, { recursive: true, force: true }); }
  });

  it('lets B run while A is awaiting retry, without bypassing A backoff', async () => {
    const snapshot = await legacySnapshot(2), state = snapshot.memoryTopicState!, chapterA = state.topics[0]!;
    state.topics.push({ ...structuredClone(chapterA), id: 'chapter-b', title: '学术资料',
      sourceEventIds: ['old-1'], overview: [], sections: [] });
    const directory = new MemoryTopicDirectory(); directory.restore(state); const now = new Date().toISOString();
    directory.initializeBootstrap(snapshot.events, now);
    const first = directory.claim(snapshot.events, now, 'bootstrap')!;
    directory.fail(first.jobId, new Error('invalid sections'), now);
    const next = directory.claim(snapshot.events, now, 'bootstrap')!;
    expect(next.sectionBackfillTopicId).toBe('chapter-b');
    directory.complete(next.jobId, repair(next), snapshot.events, now);
    expect(directory.claim(snapshot.events, now, 'bootstrap')).toBeNull();
    expect(directory.hasPending(snapshot.events, Date.parse(now), 'bootstrap')).toBe(false);
    expect(directory.hasPending(snapshot.events, Date.parse(now) + 30_000, 'bootstrap')).toBe(true);
  });

  it('rejects chapter moves and legacy empty-overview completions atomically', async () => {
    const snapshot = await legacySnapshot(), directory = new MemoryTopicDirectory();
    directory.restore(snapshot.memoryTopicState); const now = new Date().toISOString();
    directory.initializeBootstrap(snapshot.events, now);
    const context = directory.claim(snapshot.events, now)!;
    for (const kind of ['move', 'legacy'] as const) {
      const result = repair(context);
      if (kind === 'move') result.topics[0]!.topicId = 'unknown-chapter';
      else delete (result.topics[0] as { sections?: unknown }).sections;
      const before = directory.snapshot();
      expect(() => directory.complete(context.jobId, result, snapshot.events, now)).toThrow(/backfill/);
      expect(directory.snapshot()).toEqual(before);
    }
  });

  it('persists exhausted retries across restart and allows an explicit finite retry', async () => {
    const snapshot = await legacySnapshot(); let directory = new MemoryTopicDirectory();
    directory.restore(snapshot.memoryTopicState); let clock = Date.now();
    directory.initializeBootstrap(snapshot.events, new Date(clock).toISOString());
    let last = '';
    for (let i = 0; i < 3; i++) {
      const context = directory.claim(snapshot.events, new Date(clock).toISOString(), 'bootstrap')!;
      last = context.jobId; directory.fail(last, new Error('invalid assignment'), new Date(clock).toISOString());
      clock += 120_000;
      const persisted = directory.snapshot(); directory = new MemoryTopicDirectory(); directory.restore(persisted);
      directory.initializeBootstrap(snapshot.events, new Date(clock).toISOString());
    }
    expect(directory.hasPending(snapshot.events, clock)).toBe(false);
    expect(directory.claim(snapshot.events, new Date(clock).toISOString())).toBeNull();
    directory.retry(last, snapshot.events, new Date(clock).toISOString());
    const context = directory.claim(snapshot.events, new Date(clock).toISOString(), 'incremental')!;
    directory.complete(context.jobId, repair(context), snapshot.events, new Date(clock).toISOString());
    expect(directory.hasPending(snapshot.events, clock)).toBe(false);
  });

  it.each(['forgotten', 'archived', 'changed'] as const)('drops %s repair inputs instead of restoring old facts', async (change) => {
    const snapshot = await legacySnapshot(), directory = new MemoryTopicDirectory();
    directory.restore(snapshot.memoryTopicState); const now = new Date().toISOString();
    directory.initializeBootstrap(snapshot.events, now);
    const context = directory.claim(snapshot.events, now)!;
    const event = snapshot.events.find(({ id }) => id === 'old-1')!;
    if (change === 'changed') event.summary = '新的学历资料';
    else event.status = change;
    directory.synchronize(snapshot.events, now);
    expect(directory.snapshot().sectionBackfill).toEqual({});
    expect(() => directory.complete(context.jobId, repair(context), snapshot.events, now)).toThrow(/not running|stale/);
    expect(directory.list(snapshot.events).every(({ overview }) => overview.length === 0)).toBe(true);
    if (change === 'changed') expect(directory.hasPending(snapshot.events, Date.parse(now), 'incremental')).toBe(true);
  });
});
