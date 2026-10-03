import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { StrataGate, MemoryTopicDirectory, MEMORY_TOPIC_PROJECTOR_VERSION, TOPIC_LEASE_MS, normalizeSnapshot, type TopicProjectionContext, type TopicProjectionResult } from '../src/index.js';
import { SqliteStorage } from '../src/sqlite.js';

const summarizer = async () => ({ l0Title: '对话', l0Tags: [], l1Summary: '对话', l2Keypoints: [], shouldExtract: false });
const options = { blockTurnSize: 1, summarizer, disableElementProjection: true };

async function seed(memory: StrataGate, count = 1) {
  await memory.appendTurn({ user: '项目原文', assistant: '记录' });
  const block = memory.listBlocks()[0]!;
  return Promise.all(Array.from({ length: count }, (_, index) => memory.addEvent({
    title: `部署项目事件 ${index}`, summary: `部署项目的第 ${index} 次历史变更。`,
    sourceBlockId: block.id, sourceMessageIds: [block.l5Raw[0]!.id],
    temporal: { status: 'occurred', eventType: 'change' },
  })));
}

function projection(context: TopicProjectionContext, topicId?: string): TopicProjectionResult {
  const sourceEventIds = context.events.map(({ id }) => id);
  return { topics: [{ ...(topicId ? { topicId } : {}), title: '部署项目',
    description: '涵盖部署历史和项目决定。', sourceEventIds,
    overview: [{ kind: 'history', text: '这里保留部署项目的历史变更。', sourceEventIds }],
  }] };
}

describe('rebuildable Event-backed topic directory', () => {
  it('covers graphless passive and agent memories immediately, without read reinforcement', async () => {
    const memory = StrataGate.inMemory(options);
    const [passive] = await seed(memory);
    const agent = await memory.recordAgentEvent({ content: '用户倾向简洁的中文说明。', category: 'preference' });
    const before = memory.exportSnapshot();
    const topics = memory.listMemoryTopics();
    expect(new Set(topics.flatMap((topic) => topic.sourceEventIds))).toEqual(new Set([passive!.id, agent.eventId]));
    expect(topics.every((topic) => topic.isFallback)).toBe(true);
    expect(memory.getMemoryTopic(topics[0]!.id)).toEqual(topics[0]);
    expect(memory.exportSnapshot()).toEqual(before);
    const context = (await memory.claimNextTopicProjection())!;
    expect(new Set(context.events.map(({ id }) => id))).toEqual(new Set([passive!.id, agent.eventId]));
    await memory.completeTopicProjection(context.jobId, projection(context));
    expect(memory.listMemoryTopics()).toHaveLength(1);
    expect(memory.listMemoryTopics()[0]?.coverage).toEqual({ totalEvents: 2, summarizedEvents: 2, omittedEvents: 0 });
    expect(memory.hasPendingTopicWork()).toBe(false);
  });

  it('preserves stable topic ids and all members as a topic grows beyond a model batch', async () => {
    const memory = StrataGate.inMemory(options);
    await seed(memory, 29);
    let id: string | undefined;
    let batches = 0;
    while (memory.hasPendingTopicWork()) {
      const context = (await memory.claimNextTopicProjection())!;
      expect(context.events.length).toBeLessThanOrEqual(12);
      expect(context.existingTopics.length).toBeLessThanOrEqual(12);
      const result = await memory.completeTopicProjection(context.jobId, projection(context, id));
      id ??= result.topicIds[0];
      expect(result.topicIds).toEqual([id]);
      batches += 1;
    }
    expect(batches).toBe(3);
    expect(memory.getMemoryTopic(id!)?.sourceEventIds).toHaveLength(29);
    expect(memory.getMemoryTopic(id!)?.coverage.totalEvents).toBe(29);
    expect(memory.getMemoryTopic(id!)?.coverage.omittedEvents).toBeGreaterThanOrEqual(0);
  });

  it('does not regenerate on search, adoption, or pin bookkeeping; event semantic changes do', async () => {
    const memory = StrataGate.inMemory(options);
    const [event] = await seed(memory);
    const context = (await memory.claimNextTopicProjection())!;
    const { topicIds } = await memory.completeTopicProjection(context.jobId, projection(context));
    await memory.searchEvents('部署项目');
    await memory.recordMemoryUse({ eventIds: [event!.id], elementIds: [] });
    await memory.pinEvent(event!.id);
    event!.weight.floorWeight *= 0.5;
    event!.updatedAt = '2026-10-03T00:00:00Z';
    expect(memory.hasPendingTopicWork()).toBe(false);
    expect(memory.getTopicBootstrapState()?.status).toBe('completed');
    expect(await memory.claimNextTopicProjection()).toBeNull();
    expect(memory.getMemoryTopic(topicIds[0]!)?.isFallback).toBeUndefined();
    event!.temporal.status = 'cancelled';
    expect(memory.hasPendingTopicWork()).toBe(true);
    expect(memory.getMemoryTopic(topicIds[0]!)?.isFallback).toBe(true);
    expect(JSON.stringify(memory.exportSnapshot().memoryTopicState)).not.toContain('涵盖部署历史');
  });

  it('clears title, description and overview on partial forgetting and rebuilds surviving sources', async () => {
    const memory = StrataGate.inMemory(options);
    const [removed, survivor] = await seed(memory, 2);
    const context = (await memory.claimNextTopicProjection())!;
    const result = projection(context);
    result.topics[0]!.title = '不可再暴露的旧标题';
    result.topics[0]!.description = '不可再暴露的旧简介';
    result.topics[0]!.overview[0]!.text = '不可再暴露的旧概要';
    const { topicIds } = await memory.completeTopicProjection(context.jobId, result);
    await memory.forgetEvent(removed!.id);
    const fallback = memory.getMemoryTopic(topicIds[0]!);
    expect(fallback).toMatchObject({ isFallback: true, sourceEventIds: [survivor!.id], overview: [] });
    expect(JSON.stringify(memory.exportSnapshot().memoryTopicState)).not.toContain('不可再暴露');
    expect(memory.hasPendingTopicWork()).toBe(true);
    const rebuild = (await memory.claimNextTopicProjection())!;
    expect(rebuild.events.map(({ id }) => id)).toEqual([survivor!.id]);
    expect(rebuild.existingTopics[0]?.id).toBe(topicIds[0]);
    await memory.completeTopicProjection(rebuild.jobId, projection(rebuild, topicIds[0]));
    expect(memory.getMemoryTopic(topicIds[0]!)?.isFallback).toBeUndefined();
    expect(memory.hasPendingTopicWork()).toBe(false);
    await memory.forgetEvent(survivor!.id);
    expect(memory.getMemoryTopic(topicIds[0]!)).toBeNull();
    expect(memory.hasPendingTopicWork()).toBe(false);
  });

  it('rejects stale model results when any non-displayed candidate source changes', async () => {
    const memory = StrataGate.inMemory(options);
    const old = await seed(memory, 13);
    let context = (await memory.claimNextTopicProjection())!;
    const { topicIds } = await memory.completeTopicProjection(context.jobId, projection(context));
    context = (await memory.claimNextTopicProjection())!;
    await memory.completeTopicProjection(context.jobId, projection(context, topicIds[0]));
    const block = memory.listBlocks()[0]!;
    await memory.addEvent({ title: '新的部署决定', summary: '新的项目变更', sourceBlockId: block.id, sourceMessageIds: [block.l5Raw[0]!.id] });
    const pending = (await memory.claimNextTopicProjection())!;
    // The 13th source is outside the first retained overview segment, but is still a dependency.
    await memory.forgetEvent(old[12]!.id);
    await expect(memory.completeTopicProjection(pending.jobId, projection(pending, topicIds[0]))).rejects.toThrow(/not running|source version/);
    await memory.failTopicProjection(pending.jobId, new Error('late failure'));
    expect(memory.listTopicProjectionJobs().find((job) => job.id === pending.jobId)?.nextRetryAt).toBeNull();
    expect(memory.hasPendingTopicWork()).toBe(true);
  });

  it('keeps the old id across multiple rebuild batches when the model omits topicId, then stops permanently', async () => {
    const memory = StrataGate.inMemory(options);
    const events = await seed(memory, 29);
    let id: string | undefined;
    while (memory.hasPendingTopicWork()) {
      const batch = (await memory.claimNextTopicProjection())!;
      id = (await memory.completeTopicProjection(batch.jobId, projection(batch, id))).topicIds[0];
    }
    await memory.forgetEvent(events[0]!.id);
    let calls = 0;
    while (memory.hasPendingTopicWork() && calls < 5) {
      const batch = (await memory.claimNextTopicProjection())!;
      expect(projection(batch).topics[0]!.topicId).toBeUndefined();
      expect((await memory.completeTopicProjection(batch.jobId, projection(batch))).topicIds).toEqual([id]);
      calls += 1;
    }
    expect(calls).toBe(3);
    expect(memory.exportSnapshot().memoryTopicState!.topics).toHaveLength(1);
    expect(memory.getMemoryTopic(id!)?.sourceEventIds).toHaveLength(28);
    expect(memory.hasPendingTopicWork()).toBe(false);
    expect(await memory.claimNextTopicProjection()).toBeNull();
    expect((await memory.searchEvents('', { eventIds: memory.getMemoryTopic(id!)!.sourceEventIds,
      limit: 50, trackRetrieval: false })).map(({ event }) => event.id)).not.toContain(events[0]!.id);
  });

  it('retires an invalidated predecessor when omitted ids cannot be matched unambiguously', async () => {
    const memory = StrataGate.inMemory(options);
    const events = await seed(memory, 4);
    const initial = (await memory.claimNextTopicProjection())!;
    const oldId = (await memory.completeTopicProjection(initial.jobId, projection(initial))).topicIds[0]!;
    await memory.forgetEvent(events[0]!.id);
    const batch = (await memory.claimNextTopicProjection())!;
    const result: TopicProjectionResult = { topics: batch.events.map((event) => ({
      title: event.title, description: '可验证的来源入口', sourceEventIds: [event.id], overview: [],
    })) };
    await memory.completeTopicProjection(batch.jobId, result);
    expect(memory.getMemoryTopic(oldId)).toBeNull();
    expect(memory.exportSnapshot().memoryTopicState!.topics.every((topic) => !topic.invalidated)).toBe(true);
    expect(new Set(memory.listMemoryTopics().flatMap((topic) => topic.sourceEventIds)))
      .toEqual(new Set(events.slice(1).map(({ id }) => id)));
    expect(memory.hasPendingTopicWork()).toBe(false);
    expect(await memory.claimNextTopicProjection()).toBeNull();
  });

  it('rejects a rebuild after another connection forgets a source, then rebuilds only the survivor', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-topic-rebuild-stale-'));
    const database = join(directory, 'memory.sqlite');
    const open = () => StrataGate.open({ ...options, database, namespace: 'project' });
    let writer: StrataGate | undefined;
    let other: StrataGate | undefined;
    try {
      writer = await open();
      const events = await seed(writer, 3);
      const initial = (await writer.claimNextTopicProjection())!;
      const result = projection(initial);
      result.topics[0]!.title = '海棠旧标题';
      result.topics[0]!.overview[0]!.text = '海棠旧概要';
      const oldId = (await writer.completeTopicProjection(initial.jobId, result)).topicIds[0]!;
      await writer.forgetEvent(events[0]!.id);
      const inFlight = (await writer.claimNextTopicProjection())!;
      other = await open();
      await other.forgetEvent(events[1]!.id);
      await writer.refreshFromStorage();
      await expect(writer.completeTopicProjection(inFlight.jobId, projection(inFlight, oldId))).rejects.toThrow(/not running|stale/);
      expect(JSON.stringify(writer.listMemoryTopics())).not.toContain('海棠');
      expect(JSON.stringify(writer.listTopicProjectionJobs())).not.toContain('海棠');
      expect(JSON.stringify(writer.exportSnapshot().memoryTopicState)).not.toContain('海棠');
      const surviving = (await writer.claimNextTopicProjection())!;
      expect(surviving.events.map(({ id }) => id)).toEqual([events[2]!.id]);
      expect(JSON.stringify(surviving.existingTopics)).not.toContain('海棠');
      expect((await writer.completeTopicProjection(surviving.jobId, projection(surviving))).topicIds).toEqual([oldId]);
      expect(writer.hasPendingTopicWork()).toBe(false);
    } finally {
      await writer?.close(); await other?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('starts a new frozen generation only when the projector version changes', async () => {
    const memory = StrataGate.inMemory(options);
    const events = await seed(memory, 2);
    const batch = (await memory.claimNextTopicProjection())!;
    const oldId = (await memory.completeTopicProjection(batch.jobId, projection(batch))).topicIds[0]!;
    const oldState = memory.exportSnapshot().memoryTopicState!;
    oldState.bootstrap!.projectorVersion = MEMORY_TOPIC_PROJECTOR_VERSION - 1;
    oldState.topics[0]!.projectorVersion = MEMORY_TOPIC_PROJECTOR_VERSION - 1;
    const directory = new MemoryTopicDirectory();
    directory.restore(oldState);
    const now = new Date().toISOString();
    expect(directory.hasPending(events, Date.parse(now))).toBe(true);
    directory.initializeBootstrap(events, now);
    expect(directory.claim(events, now, 'incremental')).toBeNull();
    expect(directory.bootstrap()?.status).toBe('pending');
    const rebuild = directory.claim(events, now, 'bootstrap')!;
    expect(directory.complete(rebuild.jobId, projection(rebuild), events, now).topicIds).toEqual([oldId]);
    directory.synchronize(events, now);
    expect(directory.bootstrap()).toMatchObject({ status: 'completed', projectorVersion: MEMORY_TOPIC_PROJECTOR_VERSION });
    expect(directory.hasPending(events, Date.parse(now))).toBe(false);
  });

  it('validates evidence, complete batch coverage, reused ids and overview kinds atomically', async () => {
    const memory = StrataGate.inMemory(options);
    await seed(memory, 2);
    const context = (await memory.claimNextTopicProjection())!;
    const invalid = projection(context);
    invalid.topics[0]!.sourceEventIds.push('outside_namespace');
    await expect(memory.completeTopicProjection(context.jobId, invalid)).rejects.toThrow(/Invalid topic/);
    const omitted = projection(context);
    omitted.topics[0]!.sourceEventIds.pop(); omitted.topics[0]!.overview = [];
    await expect(memory.completeTopicProjection(context.jobId, omitted)).rejects.toThrow(/omitted batch/);
    await expect(memory.completeTopicProjection(context.jobId, projection(context, 'cluster_dynamic_hash'))).rejects.toThrow(/Unknown/);
    const wrongKind = projection(context);
    wrongKind.topics[0]!.overview[0]!.kind = 'current' as never;
    await expect(memory.completeTopicProjection(context.jobId, wrongKind)).rejects.toThrow(/Invalid topic overview/);
    expect(memory.listMemoryTopics().every((topic) => topic.isFallback)).toBe(true);
    await memory.completeTopicProjection(context.jobId, projection(context));
  });

  it('invalidates cached language when any read input is forgotten, even if it was not cited', async () => {
    const memory = StrataGate.inMemory(options);
    const [background, survivor] = await seed(memory, 2);
    const context = (await memory.claimNextTopicProjection())!;
    const { topicIds } = await memory.completeTopicProjection(context.jobId, { topics: context.events.map((event) => ({
      title: event.id === survivor!.id ? '受背景来源影响的旧标题' : '背景事件',
      description: '受背景来源影响的旧简介', sourceEventIds: [event.id],
      overview: [{ kind: 'history', text: '受背景来源影响的旧概要', sourceEventIds: [event.id] }],
    })) });
    const survivorId = topicIds[context.events.findIndex(({ id }) => id === survivor!.id)]!;
    const stored = memory.exportSnapshot().memoryTopicState!.topics.find(({ id }) => id === survivorId)!;
    expect(stored.dependencyVersions).toHaveProperty(background!.id);
    await memory.forgetEvent(background!.id);
    expect(memory.getMemoryTopic(survivorId)).toMatchObject({ isFallback: true, overview: [], sourceEventIds: [survivor!.id] });
    expect(JSON.stringify(memory.exportSnapshot().memoryTopicState)).not.toContain('受背景来源影响');
    expect(memory.hasPendingTopicWork()).toBe(true);
    const rebuild = (await memory.claimNextTopicProjection())!;
    expect(rebuild.events.map(({ id }) => id)).toEqual([survivor!.id]);
    await memory.completeTopicProjection(rebuild.jobId, projection(rebuild, survivorId));
    expect(memory.getMemoryTopic(survivorId)?.isFallback).toBeUndefined();
  });

  it('does not treat derived Graph participant ids as new topic evidence', async () => {
    const memory = StrataGate.inMemory(options);
    const [event] = await seed(memory);
    const context = (await memory.claimNextTopicProjection())!;
    event!.temporal.participantNodeIds = ['node_derived'];
    await memory.completeTopicProjection(context.jobId, projection(context));
    event!.temporal.participantNodeIds = [];
    expect(memory.hasPendingTopicWork()).toBe(false);
    expect(await memory.claimNextTopicProjection()).toBeNull();
    event!.temporal.participants = ['真正的参与人变化'];
    const changed = (await memory.claimNextTopicProjection())!;
    expect(changed.events[0]!.temporal.participants).toEqual(['真正的参与人变化']);
    expect(changed.events[0]!.temporal.participantNodeIds).toBeUndefined();
    expect(changed.truncatedEventIds).toEqual([]);
  });

  it('hides cached language that depended on an excluded memory pool', async () => {
    const memory = StrataGate.inMemory(options);
    const [passive] = await seed(memory);
    const agent = await memory.recordAgentEvent({ content: '代理记忆中的隐藏偏好', category: 'preference' });
    const context = (await memory.claimNextTopicProjection())!;
    const { topicIds } = await memory.completeTopicProjection(context.jobId, { topics: context.events.map((event) => ({
      title: '受隐藏偏好影响的主题', description: '受隐藏偏好影响的简介',
      sourceEventIds: [event.id], overview: [],
    })) });
    const passiveTopicId = topicIds[context.events.findIndex(({ id }) => id === passive!.id)]!;
    const filtered = memory.listMemoryTopics([passive!.id]);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]).toMatchObject({ id: passiveTopicId, isFallback: true, overview: [], sourceEventIds: [passive!.id] });
    expect(JSON.stringify(filtered)).not.toContain('受隐藏偏好影响');
    expect(filtered.flatMap(({ sourceEventIds }) => sourceEventIds)).not.toContain(agent.eventId);
    // Changing visibility for this read does not invalidate the durable topic.
    expect(memory.getMemoryTopic(passiveTopicId)?.isFallback).toBeUndefined();
  });

  it('finds an older related Chinese topic ahead of recently updated unrelated topics', async () => {
    let now = Date.parse('2026-10-02T00:00:00Z');
    const memory = StrataGate.inMemory({ ...options, now: () => new Date(now) });
    const [event] = await seed(memory);
    event!.title = '量子芯片流片'; event!.summary = '确认芯片制造的版图与流片时间安排';
    const first = (await memory.claimNextTopicProjection())!;
    const result = projection(first);
    result.topics[0]!.title = '量子芯片流片'; result.topics[0]!.description = '芯片制造的版图与流片时间安排';
    const { topicIds } = await memory.completeTopicProjection(first.jobId, result);
    const block = memory.listBlocks()[0]!;
    for (let index = 0; index < 15; index++) {
      now += 1_000;
      await memory.addEvent({ title: `羽毛球赛程 ${index}`, summary: `体育训练计划 ${index}`,
        sourceBlockId: block.id, sourceMessageIds: [] });
      const context = (await memory.claimNextTopicProjection())!;
      await memory.completeTopicProjection(context.jobId, { topics: [{ title: `羽毛球训练 ${index}`,
        description: '体育与锻炼资料', sourceEventIds: context.events.map(({ id }) => id), overview: [] }] });
    }
    await memory.addEvent({ title: '量子芯片完成第二版流片', summary: '确认芯片封装与版图安排',
      sourceBlockId: block.id, sourceMessageIds: [] });
    const context = (await memory.claimNextTopicProjection())!;
    expect(context.existingTopics).toHaveLength(12);
    expect(context.existingTopics[0]!.id).toBe(topicIds[0]);
  });

  it('bounds retries with real backoff and never keeps superseded failed work pending', async () => {
    let now = Date.parse('2026-10-02T00:00:00Z');
    const memory = StrataGate.inMemory({ ...options, now: () => new Date(now) });
    const [event] = await seed(memory);
    let context = (await memory.claimNextTopicProjection())!;
    expect(memory.hasPendingTopicWork()).toBe(false);
    for (let attempt = 1; attempt <= 3; attempt++) {
      await memory.failTopicProjection(context.jobId, new Error('model failed'));
      expect(memory.hasPendingTopicWork()).toBe(false);
      expect(await memory.claimNextTopicProjection()).toBeNull();
      if (attempt < 3) {
        now += 120_000;
        expect(memory.hasPendingTopicWork()).toBe(true);
        const oldId = context.jobId;
        context = (await memory.claimNextTopicProjection())!;
        expect(context.jobId).not.toBe(oldId);
        await expect(memory.completeTopicProjection(oldId, projection(context))).rejects.toThrow(/not running/);
      }
    }
    now += 24 * 60 * 60_000;
    expect(memory.hasPendingTopicWork()).toBe(false);
    expect(await memory.claimNextTopicProjection()).toBeNull();
    event!.summary = '新的语义版本允许独立生成。';
    expect(memory.hasPendingTopicWork()).toBe(true);
    context = (await memory.claimNextTopicProjection())!;
    await memory.forgetEvent(event!.id);
    expect(memory.hasPendingTopicWork()).toBe(false);
    expect(await memory.claimNextTopicProjection()).toBeNull();
  });

  it('retains the terminal retry ledger after more than 64 newer completed jobs', async () => {
    let now = Date.parse('2026-10-02T00:00:00Z');
    const memory = StrataGate.inMemory({ ...options, now: () => new Date(now) });
    const [failed] = await seed(memory);
    let context = (await memory.claimNextTopicProjection())!;
    for (let attempt = 1; attempt <= 3; attempt++) {
      await memory.failTopicProjection(context.jobId, new Error('worker failed'));
      if (attempt < 3) { now += 120_000; context = (await memory.claimNextTopicProjection())!; }
    }
    const terminalId = context.jobId;
    const block = memory.listBlocks()[0]!;
    for (let index = 0; index < 65; index++) {
      now += 1_000;
      const added = await memory.addEvent({ title: `后续事件 ${index}`, summary: '可以正常建立目录',
        sourceBlockId: block.id, sourceMessageIds: [] });
      context = (await memory.claimNextTopicProjection())!;
      expect(context.events.map(({ id }) => id)).toEqual([added.id]);
      const result = projection(context); result.topics[0]!.overview = [];
      await memory.completeTopicProjection(context.jobId, result);
    }
    expect(memory.listTopicProjectionJobs().find(({ id }) => id === terminalId)).toMatchObject({ status: 'failed', attempts: 3 });
    expect(memory.hasPendingTopicWork()).toBe(false);
    expect(await memory.claimNextTopicProjection()).toBeNull();
    failed!.summary = '来源版本发生真正变化，可以启动新任务';
    expect(memory.hasPendingTopicWork()).toBe(true);
    expect((await memory.claimNextTopicProjection())!.events.map(({ id }) => id)).toEqual([failed!.id]);
  }, 15_000);

  it('marks truncation and prevents turning partial source text into factual overview', async () => {
    const memory = StrataGate.inMemory(options);
    const [event] = await seed(memory);
    event!.summary = '计划'.repeat(8_000) + '该计划已经取消，不应视为已发生。';
    const context = (await memory.claimNextTopicProjection())!;
    expect(context.truncatedEventIds).toEqual([event!.id]);
    const result = projection(context);
    await expect(memory.completeTopicProjection(context.jobId, result)).rejects.toThrow(/Truncated/);
    result.topics[0]!.overview[0]!.kind = 'scope';
    result.topics[0]!.overview[0]!.text = '这里包含一条需要读取完整事件的计划讨论。';
    await memory.completeTopicProjection(context.jobId, result);
  });

  it('shrinks batches before trimming normal source text, preserving cancellation at the end', async () => {
    const memory = StrataGate.inMemory(options);
    const events = await seed(memory, 3);
    for (const event of events) event.summary = '计划'.repeat(4_100) + '该计划已取消，不能当作已经发生。';
    const context = (await memory.claimNextTopicProjection())!;
    expect(context.events).toHaveLength(1);
    expect(context.events[0]!.summary).toMatch(/该计划已取消，不能当作已经发生。$/);
    expect(context.truncatedEventIds).toEqual([]);
  });

  it('retains only fixed failure categories instead of provider errors containing source text', async () => {
    const memory = StrataGate.inMemory(options);
    await seed(memory);
    const context = (await memory.claimNextTopicProjection())!;
    await memory.failTopicProjection(context.jobId, new Error('Invalid output contains 私密原文和模型响应'));
    expect(memory.listTopicProjectionJobs()[0]).toMatchObject({ lastError: 'invalid-output', context: null });
    expect(JSON.stringify(memory.exportSnapshot().memoryTopicState)).not.toContain('私密原文和模型响应');
    await memory.failTopicProjection(context.jobId, new Error('second failure'));
    expect(memory.listTopicProjectionJobs()[0]!.lastError).toBe('invalid-output');
  });

  it('uses a hard event-id scope before top-k for topic searches', async () => {
    const memory = StrataGate.inMemory(options);
    const events = await seed(memory, 25);
    expect(await memory.searchEvents('部署项目', { eventIds: [], trackRetrieval: false })).toEqual([]);
    expect((await memory.searchEvents('部署项目', { eventIds: [events[24]!.id], limit: 1, trackRetrieval: false })).map(({ event }) => event.id))
      .toEqual([events[24]!.id]);
  });

  it('makes every member reachable by bounded pages after passive and agent pool fusion', async () => {
    const memory = StrataGate.inMemory(options);
    const events = await seed(memory, 23);
    const facts = ['喜欢天蓝色背景', '星期四学习物理', '家乡位于杭州', '早餐经常喝咖啡', '书架收藏历史著作', '姐姐住在南京',
      '周末去登山', '希望明年学钢琴', '使用台式计算机', '新养的小猫叫雪球', '办公室桌子靠窗', '朋友阿诚负责采购'];
    const agentEvents = await Promise.all(facts.map((content) => memory.recordAgentEvent({ content, category: 'fact' })));
    expect(agentEvents.every(({ eventId }) => eventId !== undefined)).toBe(true);
    const allIds = [...events.map(({ id }) => id), ...agentEvents.map(({ eventId }) => eventId!)];
    const pages: string[][] = [];
    for (let offset = 0; offset < 35; offset += 12) pages.push((await memory.searchEvents('', {
      eventIds: allIds, offset, limit: 12, trackRetrieval: false,
    })).map(({ event }) => event.id));
    expect(pages.map((page) => page.length)).toEqual([12, 12, 11]);
    expect(pages.flat()).toHaveLength(35);
    expect(new Set(pages.flat())).toEqual(new Set(allIds));
    expect(await memory.searchEvents('', { eventIds: allIds, offset: 35, limit: 12, trackRetrieval: false })).toEqual([]);
    for (const offset of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(memory.searchEvents('', { offset })).rejects.toThrow(/offset/);
    }
  });

  it('persists topics safely, isolates namespaces, refreshes readers and recovers only expired leases', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-topics-'));
    const database = join(directory, 'memory.sqlite');
    let now = Date.parse('2026-10-02T00:00:00Z');
    const open = (namespace = 'project') => StrataGate.open({ ...options, database, namespace, now: () => new Date(now) });
    let writer: StrataGate | undefined;
    let reader: StrataGate | undefined;
    let foreign: StrataGate | undefined;
    try {
      writer = await open();
      const events = await seed(writer, 2);
      const context = (await writer.claimNextTopicProjection())!;
      reader = await open(); // Opening another connection does not fail/restart a live lease.
      expect(reader.listTopicProjectionJobs()[0]?.status).toBe('running');
      expect(reader.hasPendingTopicWork()).toBe(false);
      const { topicIds } = await writer.completeTopicProjection(context.jobId, projection(context));
      await reader.refreshFromStorage();
      expect(reader.getMemoryTopic(topicIds[0]!)?.sourceEventIds).toHaveLength(2);
      foreign = await open('other-project');
      expect(foreign.getMemoryTopic(topicIds[0]!)).toBeNull();
      expect(foreign.listMemoryTopics()).toEqual([]);
      await writer.forgetEvent(events[0]!.id);
      await reader.refreshFromStorage();
      expect(reader.getMemoryTopic(topicIds[0]!)?.isFallback).toBe(true);
      const interrupted = (await writer.claimNextTopicProjection())!;
      await writer.close(); writer = await open();
      expect(writer.listTopicProjectionJobs().find((job) => job.id === interrupted.jobId)?.status).toBe('running');
      expect(writer.hasPendingTopicWork()).toBe(false);
      now += TOPIC_LEASE_MS + 1;
      expect(writer.hasPendingTopicWork()).toBe(true);
      const recovered = (await writer.claimNextTopicProjection())!;
      expect(recovered.jobId).not.toBe(interrupted.jobId);
      await expect(writer.completeTopicProjection(interrupted.jobId, projection(recovered))).rejects.toThrow(/not running/);
      await writer.completeTopicProjection(recovered.jobId, projection(recovered, topicIds[0]));
      const check = new DatabaseSync(database);
      const stored = check.prepare('SELECT state_json FROM memory_topic_state WHERE namespace = ?').get('project') as { state_json: string };
      expect(JSON.parse(stored.state_json).topics[0].sourceEventIds).toEqual([events[1]!.id]);
      check.close();
    } finally {
      await writer?.close(); await reader?.close(); await foreign?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('accepts old schema-12 snapshots without a topic projection', () => {
    const snapshot = StrataGate.inMemory(options).exportSnapshot();
    delete snapshot.memoryTopicState;
    expect(normalizeSnapshot(snapshot).memoryTopicState).toBeUndefined();
  });

  it('reads a schema-12 database without the optional table before a writer safely adds it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-pre-topic-'));
    const database = join(directory, 'memory.sqlite');
    let memory: StrataGate | undefined;
    let reader: SqliteStorage | undefined;
    try {
      memory = await StrataGate.open({ ...options, database, namespace: 'old' });
      const events = await seed(memory, 29);
      const original = memory.exportSnapshot();
      await memory.close(); memory = undefined;
      const old = new DatabaseSync(database);
      old.exec('DROP TABLE memory_topic_state'); old.close();
      reader = new SqliteStorage({ filename: database, readonly: true });
      const loaded = (await reader.load('old'))!;
      expect(loaded.snapshot.memoryTopicState).toBeUndefined();
      expect(loaded.snapshot.events.map(({ id }) => id)).toEqual(events.map(({ id }) => id));
      expect(loaded.snapshot.blocks[0]!.l5Raw[0]!.content).toBe('项目原文');
      const verify = new DatabaseSync(database, { readOnly: true });
      expect(verify.prepare("SELECT name FROM sqlite_master WHERE name = 'memory_topic_state'").get()).toBeUndefined();
      verify.close();
      await reader.close(); reader = undefined;
      memory = await StrataGate.open({ ...options, database, namespace: 'old' });
      expect(memory.listMemoryTopics()).toHaveLength(29);
      expect(memory.listMemoryTopics().every((topic) => topic.isFallback)).toBe(true);
      const context = (await memory.claimNextTopicProjection())!;
      const { topicIds } = await memory.completeTopicProjection(context.jobId, projection(context));
      expect(memory.getTopicBootstrapState()).toMatchObject({ status: 'running', completedAt: null, failedEvents: 0 });
      await memory.close(); memory = await StrataGate.open({ ...options, database, namespace: 'old' });
      const seen = new Set(context.events.map(({ id }) => id));
      let batches = 1;
      while (memory.hasPendingTopicWork() && batches < 5) {
        const next = (await memory.claimNextTopicProjection())!;
        expect(next.events.length).toBeLessThanOrEqual(12);
        expect(next.events.some(({ id }) => seen.has(id))).toBe(false);
        for (const event of next.events) seen.add(event.id);
        expect((await memory.completeTopicProjection(next.jobId, projection(next, topicIds[0]))).topicIds).toEqual(topicIds);
        batches += 1;
      }
      expect(batches).toBe(3);
      expect(seen.size).toBe(29);
      expect(memory.getTopicBootstrapState()).toMatchObject({ status: 'completed', failedEvents: 0 });
      expect(memory.hasPendingTopicWork()).toBe(false);
      expect(await memory.claimNextTopicProjection()).toBeNull();
      expect(new Set(memory.listMemoryTopics().flatMap((topic) => topic.sourceEventIds))).toEqual(new Set(events.map(({ id }) => id)));
      const final = memory.exportSnapshot();
      expect(final.events).toEqual(original.events);
      expect(final.blocks).toEqual(original.blocks);
      expect(final.graphNodes).toEqual(original.graphNodes);
      expect(final.graphEdges).toEqual(original.graphEdges);
      expect(final.schemaVersion).toBe(12);
    } finally {
      await reader?.close(); await memory?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
