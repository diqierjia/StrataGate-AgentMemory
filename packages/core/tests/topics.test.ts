import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { StrataGate, MemoryTopicDirectory, MEMORY_TOPIC_PROJECTOR_VERSION, TOPIC_LEASE_MS, normalizeSnapshot, memoryTopicEventFingerprint, TopicProjectionError, type TopicProjectionContext, type TopicProjectionResult } from '../src/index.js';
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
  it('persists a single Event move without orphan overview across SQLite reopen', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'topic-reclassification-'));
    const database = join(folder, 'memory.sqlite'), namespace = 'reclassification';
    const open = () => StrataGate.open({ ...options, database, namespace });
    let memory = await open();
    try {
      const [event] = await seed(memory); const initial = (await memory.claimNextTopicProjection())!;
      const { topicIds: [id] } = await memory.completeTopicProjection(initial.jobId, { topics: [{ title: '项目', description: '资料',
        sourceEventIds: [event!.id], sections: [{ title: '旧小节', sourceEventIds: [event!.id] }],
        overview: [{ kind: 'history', title: '旧小节', text: '旧总览', sourceEventIds: [event!.id] }],
      }] });
      await memory.close();
      const storage = new SqliteStorage({ filename: database });
      try {
        const loaded = (await storage.load(namespace))!;
        delete loaded.snapshot.memoryTopicState!.projectedVersions[event!.id];
        await storage.save(namespace, loaded.snapshot, loaded.revision);
      } finally { storage.close(); }
      memory = await open(); const next = (await memory.claimNextTopicProjection())!;
      const eventsBefore = memory.listAllEvents();
      await memory.completeTopicProjection(next.jobId, { topics: [{ topicId: id!, title: '项目', description: '资料',
        sourceEventIds: [event!.id], sections: [{ title: '新小节', sourceEventIds: [event!.id] }], overview: [],
      }] });
      expect(memory.listAllEvents()).toEqual(eventsBefore);
      await memory.close(); memory = await open();
      expect(memory.getMemoryTopic(id!)).toMatchObject({ sourceEventIds: [event!.id], overview: [],
        sections: [{ title: '新小节', sourceEventIds: [event!.id] }], coverage: { totalEvents: 1, summarizedEvents: 0, omittedEvents: 1 },
      });
      expect(memory.exportSnapshot().memoryTopicState!.topics[0]!.overview).toEqual([]);
    } finally { await memory.close(); await rm(folder, { recursive: true, force: true }); }
  });

  it('persists section membership without overview evidence across SQLite reopen and incremental updates', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'topic-membership-'));
    const database = join(folder, 'memory.sqlite');
    const open = () => StrataGate.open({ ...options, database, namespace: 'sections' });
    let memory = await open();
    try {
      const events = await seed(memory, 2);
      const job = (await memory.claimNextTopicProjection())!;
      const sections = [{ title: '研究方向', sourceEventIds: events.map(({ id }) => id) }];
      const { topicIds: [topicId] } = await memory.completeTopicProjection(job.jobId, { topics: [{
        title: '学术背景', description: '学术资料', sourceEventIds: events.map(({ id }) => id), sections,
        overview: [{ kind: 'scope', title: '研究方向', text: '研究记录', sourceEventIds: [events[0]!.id] }],
      }] });
      expect(memory.getMemoryTopic(topicId!)?.coverage).toMatchObject({ summarizedEvents: 1, omittedEvents: 1 });
      expect(memory.exportSnapshot().memoryTopicState!.topics[0]!.sections).toEqual(sections);
      await memory.close(); memory = await open();
      expect(memory.getMemoryTopic(topicId!)?.sections).toEqual(sections);
      const [added] = await seed(memory);
      const next = (await memory.claimNextTopicProjection())!;
      expect(next.existingTopics[0]!.sectionTitles).toContain('研究方向');
      await memory.completeTopicProjection(next.jobId, { topics: [{ topicId: topicId!, title: '学术背景', description: '学术资料',
        sourceEventIds: [added!.id], sections: [{ title: '研究方向', sourceEventIds: [added!.id] }], overview: [],
      }] });
      expect(new Set(memory.getMemoryTopic(topicId!)!.sections![0]!.sourceEventIds)).toEqual(new Set([...events.map(({ id }) => id), added!.id]));
      expect(memory.getMemoryTopic(topicId!)!.overview).toHaveLength(1);
      await memory.forgetEvent(events[0]!.id);
      const snapshot = memory.exportSnapshot();
      expect(snapshot.memoryTopicState!.topics.every((topic) => !topic.sections?.length)).toBe(true);
      expect(memory.listMemoryTopics().flatMap((topic) => topic.sections ?? [])).toEqual([]);
    } finally { await memory.close(); await rm(folder, { recursive: true, force: true }); }
  });

  it('migrates only known legacy section memberships without inventing a category for uncited events', async () => {
    const memory = StrataGate.inMemory(options); const events = await seed(memory, 2);
    const job = (await memory.claimNextTopicProjection())!;
    await memory.completeTopicProjection(job.jobId, { topics: [{ title: '旧章', description: '旧资料',
      sourceEventIds: events.map(({ id }) => id), overview: [{ kind: 'scope', title: '背景', text: '背景资料', sourceEventIds: [events[0]!.id] }],
    }] });
    const legacy = memory.exportSnapshot().memoryTopicState!;
    delete legacy.topics[0]!.sections;
    const before = structuredClone(legacy);
    const directory = new MemoryTopicDirectory(); directory.restore(legacy);
    expect(directory.snapshot().topics[0]!.sections).toEqual([{ title: '背景', sourceEventIds: [events[0]!.id] }]);
    expect(legacy).toEqual(before);
    const stored = directory.snapshot(); stored.topics[0]!.overview = [];
    directory.restore(stored);
    expect(directory.list(events)[0]!.sections).toEqual([{ title: '背景', sourceEventIds: [events[0]!.id] }]);
  });

  it.each(['legacy', 'explicit'] as const)('keeps other memberships of non-batch Events in a %s update', async (mode) => {
    const memory = StrataGate.inMemory(options); const [original] = await seed(memory);
    const job = (await memory.claimNextTopicProjection())!;
    const oldParagraph = { kind: 'scope' as const, title: '研究方向', text: '研究资料', sourceEventIds: [original!.id] };
    const { topicIds: [id] } = await memory.completeTopicProjection(job.jobId, { topics: [{ title: '学术背景', description: '资料',
      sourceEventIds: [original!.id], overview: [oldParagraph], sections: [
        { title: '研究方向', sourceEventIds: [original!.id] }, { title: '教育背景', sourceEventIds: [original!.id] },
      ],
    }] });
    const [added] = await seed(memory); const next = (await memory.claimNextTopicProjection())!;
    await memory.completeTopicProjection(next.jobId, { topics: [{ topicId: id!, title: '学术背景', description: '资料',
      sourceEventIds: [original!.id, added!.id], overview: [oldParagraph,
        { kind: 'scope', title: '研究方向', text: '新增研究资料', sourceEventIds: [added!.id] }],
      ...(mode === 'explicit' ? { sections: [{ title: '研究方向', sourceEventIds: [original!.id, added!.id] }] } : {}),
    }] });
    expect(new Set(memory.getMemoryTopic(id!)!.sections!.find((section) => section.title === '研究方向')!.sourceEventIds)).toEqual(new Set([original!.id, added!.id]));
    expect(memory.getMemoryTopic(id!)!.sections!.find((section) => section.title === '教育背景')!.sourceEventIds).toEqual([original!.id]);
    const restarted = new MemoryTopicDirectory(); restarted.restore(memory.exportSnapshot().memoryTopicState);
    expect(restarted.list(memory.listAllEvents()).find((topic) => topic.id === id)!.sections).toEqual(memory.getMemoryTopic(id!)!.sections);
  });

  it('reclassifies only batch Events while keeping the other shared memberships', async () => {
    const memory = StrataGate.inMemory(options); const [current, other] = await seed(memory, 2);
    const events = memory.listAllEvents(); const now = new Date().toISOString();
    const directory = new MemoryTopicDirectory(); directory.initializeBootstrap([], now);
    const initial = directory.claim(events, now)!;
    const originalIds = [current!.id, other!.id];
    const { topicIds: [id] } = directory.complete(initial.jobId, { topics: [{ title: '学术背景', description: '资料',
      sourceEventIds: originalIds, overview: [{ kind: 'scope', title: '研究方向', text: '资料范围', sourceEventIds: originalIds }],
      sections: [{ title: '研究方向', sourceEventIds: originalIds }, { title: '教育背景', sourceEventIds: originalIds }],
    }] }, events, now);
    const snapshot = directory.snapshot(); delete snapshot.projectedVersions[current!.id]; directory.restore(snapshot);
    const [added] = await seed(memory); const allEvents = memory.listAllEvents();
    const next = directory.claim(allEvents, now)!;
    expect(new Set(next.events.map(({ id }) => id))).toEqual(new Set([current!.id, added!.id]));
    directory.complete(next.jobId, { topics: [{ topicId: id!, title: '学术背景', description: '资料', sourceEventIds: [current!.id, added!.id],
      sections: [{ title: '研究方向', sourceEventIds: [current!.id, added!.id] }], overview: [],
    }] }, allEvents, now);
    const sections = directory.list(allEvents).find((topic) => topic.id === id)!.sections!;
    expect(sections.find((section) => section.title === '教育背景')!.sourceEventIds).toEqual([other!.id]);
    expect(new Set(sections.find((section) => section.title === '研究方向')!.sourceEventIds)).toEqual(new Set([...originalIds, added!.id]));
  });

  it.each(['automatic', 'copied', 'default-kind', 'normalized', 'new-summary'] as const)(
    'drops orphaned inherited overview after batch reclassification (%s), including across restart', async (mode) => {
      const memory = StrataGate.inMemory(options); const [moved, unchanged] = await seed(memory, 2);
      const events = memory.listAllEvents(); const now = new Date().toISOString();
      const directory = new MemoryTopicDirectory(); directory.initializeBootstrap([], now);
      const initial = directory.claim(events, now)!;
      const oldTitle = mode === 'default-kind' ? '发展脉络' : mode === 'normalized' ? 'ai  研究' : '旧小节';
      const orphan = { kind: 'history' as const, text: '旧总览', sourceEventIds: [moved!.id],
        ...(mode === 'default-kind' ? {} : { title: mode === 'normalized' ? 'ＡＩ　研究' : oldTitle }) };
      const retained = { kind: 'scope' as const, title: '未变化小节', text: '保留总览', sourceEventIds: [unchanged!.id] };
      const { topicIds: [id] } = directory.complete(initial.jobId, { topics: [{ title: '项目', description: '资料',
        sourceEventIds: [moved!.id, unchanged!.id], overview: [orphan, retained], sections: [
          { title: oldTitle, sourceEventIds: [moved!.id] }, { title: retained.title, sourceEventIds: [unchanged!.id] },
        ],
      }] }, events, now);
      const pending = directory.snapshot(); delete pending.projectedVersions[moved!.id]; directory.restore(pending);
      const next = directory.claim(events, now)!;
      expect(next.events.map(({ id }) => id)).toEqual([moved!.id]);
      const added = { kind: 'history' as const, title: '新小节', text: '新总览', sourceEventIds: [moved!.id] };
      const result = { topics: [{ topicId: id!, title: '项目', description: '资料', sourceEventIds: [moved!.id],
        sections: [{ title: added.title, sourceEventIds: [moved!.id] }],
        overview: mode === 'copied' ? [orphan] : mode === 'new-summary' ? [added] : [],
      }] };
      directory.complete(next.jobId, result, events, now);
      const stored = directory.snapshot().topics.find((topic) => topic.id === id)!;
      expect(stored.sections).toEqual([
        { title: retained.title, sourceEventIds: [unchanged!.id] }, { title: added.title, sourceEventIds: [moved!.id] },
      ]);
      expect(stored.overview).toEqual(mode === 'new-summary' ? [added, retained] : [retained]);
      expect(stored.sourceEventIds).toEqual([moved!.id, unchanged!.id]);
      const snapshot = directory.snapshot();
      expect(directory.complete(next.jobId, result, events, now).topicIds).toEqual([id]);
      expect(directory.snapshot()).toEqual(snapshot);
      const restarted = new MemoryTopicDirectory(); restarted.restore(snapshot);
      expect(restarted.list(events).find((topic) => topic.id === id)).toMatchObject({
        sections: stored.sections, overview: stored.overview,
      });
      await memory.close();
    },
  );

  it.each(['explicit', 'legacy'] as const)('keeps overview when its section survives batch reprocessing (%s)', async (mode) => {
    const memory = StrataGate.inMemory(options); const [moved, remaining] = await seed(memory, 2);
    const events = memory.listAllEvents(); const now = new Date().toISOString();
    const directory = new MemoryTopicDirectory(); directory.initializeBootstrap([], now);
    const initial = directory.claim(events, now)!;
    const paragraph = { kind: 'scope' as const, title: '旧小节', text: '旧总览', sourceEventIds: [moved!.id] };
    const { topicIds: [id] } = directory.complete(initial.jobId, { topics: [{ title: '项目', description: '资料',
      sourceEventIds: [moved!.id, remaining!.id], overview: [paragraph],
      sections: [{ title: paragraph.title, sourceEventIds: [moved!.id, remaining!.id] }],
    }] }, events, now);
    const pending = directory.snapshot(); delete pending.projectedVersions[moved!.id]; directory.restore(pending);
    const next = directory.claim(events, now)!;
    directory.complete(next.jobId, { topics: [{ topicId: id!, title: '项目', description: '资料', sourceEventIds: [moved!.id],
      overview: [], ...(mode === 'explicit' ? { sections: [{ title: '新小节', sourceEventIds: [moved!.id] }] } : {}),
    }] }, events, now);
    const topic = directory.list(events).find((topic) => topic.id === id)!;
    expect(topic.overview).toEqual([paragraph]);
    expect(topic.sections!.find((section) => section.title === paragraph.title)!.sourceEventIds)
      .toEqual(mode === 'explicit' ? [remaining!.id] : [moved!.id, remaining!.id]);
    await memory.close();
  });

  it.each(['named', 'default-kind'] as const)('rejects new overview attached to a section removed by this batch atomically (%s)', async (mode) => {
    const memory = StrataGate.inMemory(options); const [event] = await seed(memory);
    const events = memory.listAllEvents(); const now = new Date().toISOString();
    const directory = new MemoryTopicDirectory(); directory.initializeBootstrap([], now);
    const initial = directory.claim(events, now)!; const oldTitle = mode === 'named' ? '旧小节' : '发展脉络';
    const { topicIds: [id] } = directory.complete(initial.jobId, { topics: [{ title: '项目', description: '资料',
      sourceEventIds: [event!.id], sections: [{ title: oldTitle, sourceEventIds: [event!.id] }], overview: [],
    }] }, events, now);
    const pending = directory.snapshot(); delete pending.projectedVersions[event!.id]; directory.restore(pending);
    const next = directory.claim(events, now)!; const before = directory.snapshot();
    const result = { topics: [{ topicId: id!, title: '项目', description: '资料', sourceEventIds: [event!.id],
      sections: [{ title: '新小节', sourceEventIds: [event!.id] }], overview: [{ kind: 'history' as const,
        ...(mode === 'named' ? { title: oldTitle } : {}), text: '新总览', sourceEventIds: [event!.id] }],
    }] };
    expect(() => directory.complete(next.jobId, result, events, now)).toThrow(/overview.*section/i);
    expect(directory.snapshot()).toEqual(before);
    result.topics[0]!.overview = [];
    expect(directory.complete(next.jobId, result, events, now).topicIds).toEqual([id]);
    await memory.close();
  });

  it.each(['missing', 'foreign', 'duplicate'] as const)('rejects %s explicit section assignments atomically', async (invalid) => {
    const memory = StrataGate.inMemory(options); const events = await seed(memory, 2);
    const job = (await memory.claimNextTopicProjection())!;
    const result = projection(job); result.topics[0]!.overview = [];
    result.topics[0]!.sections = [{ title: '背景', sourceEventIds: [events[0]!.id] }];
    if (invalid === 'foreign') result.topics[0]!.sections![0]!.sourceEventIds.push('unknown');
    if (invalid === 'duplicate') result.topics[0]!.sections!.push({ title: ' 背景 ', sourceEventIds: [events[1]!.id] });
    const before = memory.exportSnapshot();
    await expect(memory.completeTopicProjection(job.jobId, result)).rejects.toThrow(/section/i);
    expect(memory.exportSnapshot()).toEqual(before);
  });

  it.each(['unnamed', 'unknown-title'] as const)('rejects %s new overview without a declared section atomically', async (invalid) => {
    const memory = StrataGate.inMemory(options); const [event] = await seed(memory);
    const job = (await memory.claimNextTopicProjection())!; const before = memory.exportSnapshot();
    const paragraph = { kind: 'open-question' as const, text: '迁移待确认。', sourceEventIds: [event!.id],
      ...(invalid === 'unknown-title' ? { title: '不存在的小节' } : {}) };
    await expect(memory.completeTopicProjection(job.jobId, { topics: [{ title: '数据库', description: '资料',
      sourceEventIds: [event!.id], sections: [{ title: '数据库与迁移', sourceEventIds: [event!.id] }], overview: [paragraph],
    }] })).rejects.toThrow(/overview.*section/i);
    expect(memory.exportSnapshot()).toEqual(before);
  });

  it.each(['named', 'default-kind', 'normalized'] as const)('accepts %s overview mapped to a declared section', async (mode) => {
    const memory = StrataGate.inMemory(options); const [event] = await seed(memory); const job = (await memory.claimNextTopicProjection())!;
    const paragraph = { kind: 'open-question' as const, text: '迁移待确认。', sourceEventIds: [event!.id],
      ...(mode === 'named' ? { title: '数据库与迁移' } : mode === 'normalized' ? { title: 'ＡＩ　研究' } : {}) };
    const title = mode === 'default-kind' ? '尚未解决的问题' : mode === 'normalized' ? 'ai  研究' : '数据库与迁移';
    const { topicIds: [id] } = await memory.completeTopicProjection(job.jobId, { topics: [{ title: '数据库', description: '资料',
      sourceEventIds: [event!.id], sections: [{ title, sourceEventIds: [event!.id] }], overview: [paragraph],
    }] });
    expect(memory.getMemoryTopic(id!)!.overview).toEqual([paragraph]);
    expect(memory.getMemoryTopic(id!)!.sections).toEqual([{ title, sourceEventIds: [event!.id] }]);
  });

  it('accepts new overview in an inherited section without changing the new Event membership', async () => {
    const memory = StrataGate.inMemory(options); const [old] = await seed(memory); const initial = (await memory.claimNextTopicProjection())!;
    const { topicIds: [id] } = await memory.completeTopicProjection(initial.jobId, { topics: [{ title: '数据库', description: '资料',
      sourceEventIds: [old!.id], sections: [{ title: '已有小节', sourceEventIds: [old!.id] }], overview: [],
    }] });
    const [added] = await seed(memory); const next = (await memory.claimNextTopicProjection())!;
    await memory.completeTopicProjection(next.jobId, { topics: [{ topicId: id!, title: '数据库', description: '资料',
      sourceEventIds: [added!.id], sections: [{ title: '新小节', sourceEventIds: [added!.id] }],
      overview: [{ kind: 'scope', title: '已有小节', text: '新资料范围。', sourceEventIds: [added!.id] }],
    }] });
    expect(memory.getMemoryTopic(id!)!.sections).toEqual([{ title: '已有小节', sourceEventIds: [old!.id] }, { title: '新小节', sourceEventIds: [added!.id] }]);
  });

  it('preserves unnamed legacy overview verbatim in an explicit update', async () => {
    const memory = StrataGate.inMemory(options); const [old] = await seed(memory); const initial = (await memory.claimNextTopicProjection())!;
    const oldParagraph = { kind: 'history' as const, text: '旧资料。', sourceEventIds: [old!.id] };
    const { topicIds: [id] } = await memory.completeTopicProjection(initial.jobId, { topics: [{ title: '数据库', description: '资料',
      sourceEventIds: [old!.id], overview: [oldParagraph],
    }] });
    const [added] = await seed(memory); const next = (await memory.claimNextTopicProjection())!;
    await memory.completeTopicProjection(next.jobId, { topics: [{ topicId: id!, title: '数据库', description: '资料',
      sourceEventIds: [old!.id, added!.id], sections: [{ title: '新小节', sourceEventIds: [added!.id] }], overview: [oldParagraph],
    }] });
    expect(memory.getMemoryTopic(id!)!.overview).toEqual([oldParagraph]);
    expect(memory.getMemoryTopic(id!)!.sections).toEqual([{ title: '发展脉络', sourceEventIds: [old!.id] }, { title: '新小节', sourceEventIds: [added!.id] }]);
  });

  it('keeps exhausted collateral rebuild retries historical even after Bootstrap originally completed', async () => {
    let clock = Date.parse('2026-10-06T00:00:00Z');
    const memory = StrataGate.inMemory(options); const events = await seed(memory, 2);
    const directory = new MemoryTopicDirectory(); const now = () => new Date(clock).toISOString();
    directory.initializeBootstrap([], now());
    const initial = directory.claim(events, now(), 'incremental')!;
    directory.complete(initial.jobId, projection(initial), events, now());
    events[0]!.status = 'forgotten'; directory.synchronize(events, now());
    let job = directory.claim(events, now(), 'bootstrap')!;
    for (let attempt = 0; attempt < 3; attempt++) {
      directory.fail(job.jobId, new Error('timeout'), now()); clock += 120_000;
      if (attempt < 2) job = directory.claim(events, now(), 'bootstrap')!;
    }
    expect(directory.bootstrap()!.status).toBe('completed');
    expect(directory.hasPending(events, clock)).toBe(false);
    expect(directory.claim(events, now(), 'incremental')).toBeNull();
    const retry = directory.retry(job.jobId, events, now());
    const restarted = new MemoryTopicDirectory(); restarted.restore(directory.snapshot());
    expect(restarted.hasPending(events, clock, 'incremental')).toBe(false);
    const fresh = restarted.claim(events, now(), 'bootstrap')!;
    expect(fresh.jobId).toBe(retry.jobId);
    restarted.complete(fresh.jobId, projection(fresh), events, now());
    expect(restarted.snapshot().rebuildVersions).toEqual({});
    expect(restarted.hasPending(events, clock)).toBe(false);
  });

  it('rejects renaming an exposed chapter to another existing chapter label atomically', async () => {
    const memory = StrataGate.inMemory(options); const events = await seed(memory, 2);
    const initial = (await memory.claimNextTopicProjection())!;
    const ids = (await memory.completeTopicProjection(initial.jobId, { topics: events.map((event, index) => ({
      title: `章节 ${index}`, description: '资料', sourceEventIds: [event.id], overview: [],
    })) })).topicIds;
    const block = memory.listBlocks()[0]!;
    const event = await memory.addEvent({ title: '新活动', summary: '新活动', sourceBlockId: block.id, sourceMessageIds: [] });
    const job = (await memory.claimNextTopicProjection())!;
    expect(job.existingTopics).toHaveLength(2);
    const before = memory.exportSnapshot();
    await expect(memory.completeTopicProjection(job.jobId, { topics: [{ topicId: ids[0]!, title: '章节 1',
      description: '资料', sourceEventIds: [event.id], overview: [] }] })).rejects.toThrow(/duplicate chapter/);
    expect(memory.exportSnapshot()).toEqual(before);
  });

  it.each(['forgotten', 'changed'] as const)('budgets 10,000-member collateral rebuilds after one source is %s, across restart', async (change) => {
    const memory = StrataGate.inMemory(options);
    const [template] = await seed(memory);
    const events = Array.from({ length: 10_000 }, (_, index) => ({ ...structuredClone(template!), id: `large-${index}` }));
    const versions = Object.fromEntries(events.map((event) => [event.id, memoryTopicEventFingerprint(event)]));
    let directory = new MemoryTopicDirectory();
    const now = new Date().toISOString();
    directory.initializeBootstrap([], now);
    const frozen = directory.bootstrap();
    directory.restore({ ...directory.snapshot(), projectedVersions: versions, topics: [{
      id: 'large-chapter', title: '旧章', description: '旧描述', sourceEventIds: events.map(({ id }) => id),
      overview: [], sourceVersions: versions, dependencyVersions: versions,
      createdAt: now, updatedAt: now, projectorVersion: MEMORY_TOPIC_PROJECTOR_VERSION, invalidated: false,
    }] });
    if (change === 'forgotten') events[0]!.status = 'forgotten';
    else events[0]!.temporal.status = 'cancelled';
    directory.synchronize(events, now);
    expect(Object.keys(directory.snapshot().rebuildVersions!)).toHaveLength(9_999);
    expect(directory.bootstrap()).toEqual(frozen);
    expect(directory.hasPending(events, Date.parse(now), 'incremental')).toBe(change === 'changed');
    const incremental = directory.claim(events, now, 'incremental');
    if (change === 'changed') {
      expect(incremental!.events.map(({ id }) => id)).toEqual(['large-0']);
      directory.complete(incremental!.jobId, projection(incremental!, 'large-chapter'), events, now);
    } else expect(incremental).toBeNull();
    const snapshot = directory.snapshot();
    directory = new MemoryTopicDirectory(); directory.restore(snapshot);
    expect(directory.hasPending(events, Date.parse(now), 'incremental')).toBe(false);
    expect(directory.hasPending(events, Date.parse(now), 'bootstrap')).toBe(true);
    const batch = directory.claim(events, now, 'bootstrap')!;
    expect(batch.events).toHaveLength(12);
    expect(batch.events.map(({ id }) => id)).not.toContain('large-0');
    directory.complete(batch.jobId, projection(batch, 'large-chapter'), events, now);
    expect(Object.keys(directory.snapshot().rebuildVersions!)).toHaveLength(9_987);
    expect(directory.claim(events, now, 'incremental')).toBeNull();
    expect(directory.bootstrap()).toEqual(frozen);
  }, 30_000);

  it('budgets collateral members for background dependency changes and old invalidated snapshots', async () => {
    const memory = StrataGate.inMemory(options);
    const events = await seed(memory, 3);
    const directory = new MemoryTopicDirectory(); const now = new Date().toISOString();
    directory.initializeBootstrap(events, now);
    const job = directory.claim(events, now)!;
    directory.complete(job.jobId, { topics: events.map((event) => ({ title: event.id, description: '资料',
      sourceEventIds: [event.id], overview: [] })) }, events, now);
    events[0]!.summary = 'changed background';
    directory.synchronize(events, now);
    expect(Object.keys(directory.snapshot().rebuildVersions!)).toEqual(events.slice(1).map(({ id }) => id));
    const old = directory.snapshot(); delete old.rebuildVersions;
    const restored = new MemoryTopicDirectory(); restored.restore(old);
    expect(restored.claim(events, now, 'incremental')).toBeNull(); // Conservative old-version backlog recovery.
    expect(restored.claim(events, now, 'bootstrap')!.events).toHaveLength(3);
  });

  it('retains eight existing sections and repeated paragraphs while exposing every label beyond the four prose samples', async () => {
    const memory = StrataGate.inMemory(options);
    const events = await seed(memory, 8);
    const initial = (await memory.claimNextTopicProjection())!;
    const overview = events.map((event, index) => ({ kind: 'history' as const, title: `事项 ${index}`, text: `原段 ${index}`, sourceEventIds: [event.id] }));
    const id = (await memory.completeTopicProjection(initial.jobId, { topics: [{ title: '长期项目', description: '资料',
      sourceEventIds: events.map(({ id }) => id), overview }] })).topicIds[0]!;
    const block = memory.listBlocks()[0]!;
    for (const title of ['事项 5', '第九个事项', '事项 5']) {
      const event = await memory.addEvent({ title, summary: '新变化', sourceBlockId: block.id, sourceMessageIds: [] });
      const job = (await memory.claimNextTopicProjection())!;
      const candidate = job.existingTopics.find((topic) => topic.id === id)!;
      expect(candidate.overview).toHaveLength(4);
      expect(candidate.sectionTitles).toContain('事项 5');
      expect(candidate.sectionTitles).toContain('事项 7');
      expect(candidate.sourceEventIds).not.toContain(events[5]!.id); // A label grants no evidence capability.
      await memory.completeTopicProjection(job.jobId, { topics: [{ topicId: id, title: '长期项目', description: '资料',
        sourceEventIds: [event.id], overview: [{ kind: 'change', title, text: '新段 ' + event.id, sourceEventIds: [event.id] }] }] });
      expect(memory.getMemoryTopic(id)!.overview).toEqual(expect.arrayContaining(overview));
    }
    expect(memory.getMemoryTopic(id)!.overview).toHaveLength(11);
    await memory.close();
  });

  it('ranks by the sixth section even when only a middle chapter member carries the relevant subject', async () => {
    const memory = StrataGate.inMemory(options);
    const events = await seed(memory, 12);
    const initial = (await memory.claimNextTopicProjection())!;
    const id = (await memory.completeTopicProjection(initial.jobId, { topics: [{ title: '长期项目', description: '综合资料',
      sourceEventIds: events.map(({ id }) => id), overview: events.slice(0, 6).map((event, index) => ({
        kind: 'history' as const, title: index === 5 ? 'Zebra 海棠界面' : `事项 ${index}`, text: '资料', sourceEventIds: [event.id],
      })) }] })).topicIds[0]!;
    const block = memory.listBlocks()[0]!;
    for (let index = 0; index < 14; index++) {
      const event = await memory.addEvent({ title: `其他活动 ${index}`, summary: '比赛结果', sourceBlockId: block.id, sourceMessageIds: [] });
      const job = (await memory.claimNextTopicProjection())!;
      await memory.completeTopicProjection(job.jobId, { topics: [{ title: `体育 ${index}`, description: '比赛结果', sourceEventIds: [event.id], overview: [] }] });
    }
    await memory.addEvent({ title: 'Zebra 海棠界面', summary: '新记录', sourceBlockId: block.id, sourceMessageIds: [] });
    const job = (await memory.claimNextTopicProjection())!;
    expect(job.existingTopics).toHaveLength(12);
    expect(job.existingTopics[0]!.id).toBe(id);
    expect(job.existingTopics[0]!.sectionTitles).toContain('Zebra 海棠界面');
  });

  it('rejects globally duplicate labels outside the shortlist without accepting their unexposed evidence', async () => {
    const memory = StrataGate.inMemory(options);
    const [event] = await seed(memory);
    const directory = new MemoryTopicDirectory(); const now = new Date().toISOString();
    directory.initializeBootstrap([], now);
    const current = memoryTopicEventFingerprint(event!);
    const old = { id: 'hidden-chapter', title: 'ＳｔｒａｔａＧａｔｅ', description: '旧资料', sourceEventIds: [event!.id],
      overview: [], sourceVersions: { [event!.id]: current }, dependencyVersions: { [event!.id]: current },
      createdAt: now, updatedAt: now, projectorVersion: MEMORY_TOPIC_PROJECTOR_VERSION, invalidated: false };
    directory.restore({ ...directory.snapshot(), topics: Array.from({ length: 14 }, (_, index) => ({
      ...old, id: `chapter-${index}`, title: index === 0 ? old.title : `其他 ${index}`,
    })), projectedVersions: { [event!.id]: current } });
    const sources = [event!, { ...structuredClone(event!), id: 'new-event', title: '其他', summary: '其他' }];
    const job = directory.claim(sources, now, 'incremental')!;
    expect(job.existingTopics.map(({ id }) => id)).not.toContain('chapter-0');
    const result = { topics: [{ title: 'stratagate', description: '资料', sourceEventIds: ['new-event'], overview: [] }] };
    const before = directory.snapshot();
    expect(() => directory.complete(job.jobId, result, sources, now)).toThrow(/unexposed/);
    expect(directory.snapshot()).toEqual(before);
    result.topics.push({ title: '新的无关领域', description: '资料', sourceEventIds: ['new-event'], overview: [] });
    result.topics.shift();
    directory.complete(job.jobId, result, sources, now);
    expect(directory.snapshot().topics).toHaveLength(15);
  });

  it('rebuilds a fragmented persisted generation once and reuses a broad chapter across batches and restarts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-chapter-rebuild-'));
    const database = join(directory, 'memory.db');
    const namespace = 'project:rebuild';
    try {
      let memory = await StrataGate.open({ ...options, database, namespace });
      const events = await seed(memory, 29);
      const baseline = memory.exportSnapshot();
      await memory.close();
      const storage = new SqliteStorage({ filename: database });
      const loaded = (await storage.load(namespace))!;
      const old = new MemoryTopicDirectory();
      old.initializeBootstrap(events, new Date().toISOString());
      // Simulate v1's one-subtask-per-chapter output.
      while (old.hasPending(events, Date.now())) {
        const context = old.claim(events, new Date().toISOString())!;
        old.complete(context.jobId, { topics: context.events.map((event) => ({
          title: event.title, description: '细粒度事项', sourceEventIds: [event.id], overview: [],
        })) }, events, new Date().toISOString());
      }
      loaded.snapshot.memoryTopicState = old.snapshot();
      loaded.snapshot.memoryTopicState.bootstrap!.projectorVersion = 1;
      for (const topic of loaded.snapshot.memoryTopicState.topics) topic.projectorVersion = 1;
      for (const job of loaded.snapshot.memoryTopicState.jobs) job.projectorVersion = 1;
      const oldIds = loaded.snapshot.memoryTopicState.topics.map(({ id }) => id);
      await storage.save(namespace, loaded.snapshot, loaded.revision);
      await storage.close();
      const readerStorage = new SqliteStorage({ filename: database, readonly: true });
      const before = (await readerStorage.load(namespace))!;
      const reader = await StrataGate.openWithStorage({ ...options, storage: readerStorage, namespace });
      expect(reader.listMemoryTopics().every((topic) => topic.isFallback)).toBe(true);
      expect(await readerStorage.load(namespace)).toEqual(before);
      await reader.close();

      memory = await StrataGate.open({ ...options, database, namespace });
      expect(memory.exportSnapshot().memoryTopicState!.topics).toEqual([]);
      expect(Object.keys(memory.getTopicBootstrapState()!.sourceVersions)).toHaveLength(29);
      const first = (await memory.claimNextTopicProjection('bootstrap'))!;
      const chapterId = (await memory.completeTopicProjection(first.jobId, projection(first))).topicIds[0]!;
      await memory.close();
      memory = await StrataGate.open({ ...options, database, namespace });
      while (memory.hasPendingTopicWork('bootstrap')) {
        const context = (await memory.claimNextTopicProjection('bootstrap'))!;
        // No topicId and no overlapping new Event: canonical broad name still
        // continues the exposed chapter rather than creating another one.
        expect((await memory.completeTopicProjection(context.jobId, projection(context))).topicIds).toEqual([chapterId]);
      }
      expect(oldIds).not.toContain(chapterId);
      expect(memory.listMemoryTopics()).toHaveLength(1);
      expect(memory.listMemoryTopics()[0]!.sourceEventIds).toHaveLength(29);
      expect(memory.getTopicBootstrapState()).toMatchObject({ status: 'completed', failedEvents: 0 });
      const result = memory.exportSnapshot();
      for (const field of ['events', 'agentEvents', 'blocks', 'openTail', 'graphNodes', 'graphEdges', 'usageReceipts'] as const) {
        expect(result[field]).toEqual(baseline[field]);
      }
      await memory.close();
      memory = await StrataGate.open({ ...options, database, namespace });
      expect(memory.listMemoryTopics()[0]!.id).toBe(chapterId);
      expect(memory.hasPendingTopicWork()).toBe(false);
      await memory.close();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('routes by member hints when a broad chapter name omits the subtask and more than twelve chapters exist', async () => {
    const memory = StrataGate.inMemory(options);
    const events = await seed(memory, 18);
    events[0]!.title = '海棠 Zebra 界面开发';
    events[0]!.tags = ['Zebra', '海棠'];
    while (memory.hasPendingTopicWork()) {
      const context = (await memory.claimNextTopicProjection())!;
      await memory.completeTopicProjection(context.jobId, { topics: context.events.map((event) => ({
        title: event.id === events[0]!.id ? '长期项目' : '其他领域 ' + event.id,
        description: '进展记录', sourceEventIds: [event.id], overview: [],
      })) });
    }
    const block = memory.listBlocks()[0]!;
    await memory.addEvent({ title: '海棠 Zebra 发布', summary: '本次发布兼容性更新', tags: ['Zebra', '海棠'],
      sourceBlockId: block.id, sourceMessageIds: [block.l5Raw[0]!.id] });
    const context = (await memory.claimNextTopicProjection())!;
    expect(context.existingTopics.length).toBeLessThanOrEqual(12);
    expect(context.existingTopics.some((topic) => topic.title === '长期项目')).toBe(true);
  });

  it('reopens only a current terminal history failure as a fresh bounded cycle and rejects duplicate or late replies', async () => {
    let clock = Date.parse('2026-10-05T00:00:00Z');
    const memory = StrataGate.inMemory({ ...options, now: () => new Date(clock) });
    const events = await seed(memory, 2);
    const snapshot = memory.exportSnapshot();
    delete snapshot.memoryTopicState;
    const directory = new MemoryTopicDirectory();
    directory.initializeBootstrap(events, new Date(clock).toISOString());
    let context = directory.claim(events, new Date(clock).toISOString(), 'bootstrap')!;
    for (let attempt = 0; attempt < 3; attempt++) {
      directory.fail(context.jobId, new Error('timeout'), new Date(clock).toISOString());
      clock += 120_000;
      if (attempt < 2) context = directory.claim(events, new Date(clock).toISOString(), 'bootstrap')!;
    }
    directory.synchronize(events, new Date(clock).toISOString());
    expect(directory.bootstrap()).toMatchObject({ status: 'failed', failedEvents: 2 });
    const oldId = context.jobId;
    const retry = directory.retry(oldId, events, new Date(clock).toISOString());
    expect(retry.jobId).not.toBe(oldId);
    expect(directory.bootstrap()).toMatchObject({ status: 'pending', completedAt: null, failedEvents: 0 });
    expect(directory.hasPending(events, clock, 'incremental')).toBe(false);
    expect(directory.hasPending(events, clock, 'bootstrap')).toBe(true);
    expect(() => directory.retry(oldId, events, new Date(clock).toISOString())).toThrow(/conflict/);
    context = directory.claim(events, new Date(clock).toISOString(), 'bootstrap')!;
    expect(context.jobId).toBe(retry.jobId);
    expect(directory.jobs().find(({ id }) => id === context.jobId)!.attempts).toBe(1);
    expect(() => directory.complete(oldId, projection(context), events, new Date(clock).toISOString())).toThrow(/not running/);
    for (let attempt = 0; attempt < 3; attempt++) {
      directory.fail(context.jobId, new Error('timeout'), new Date(clock).toISOString());
      clock += 120_000;
      if (attempt < 2) context = directory.claim(events, new Date(clock).toISOString(), 'bootstrap')!;
    }
    directory.synchronize(events, new Date(clock).toISOString());
    expect(directory.jobs().find(({ id }) => id === context.jobId)!.attempts).toBe(3);
    expect(directory.hasPending(events, clock)).toBe(false);
    expect(directory.bootstrap()).toMatchObject({ status: 'failed', failedEvents: 2 });
    directory.retry(context.jobId, events, new Date(clock).toISOString());
    context = directory.claim(events, new Date(clock).toISOString(), 'bootstrap')!;
    directory.complete(context.jobId, projection(context), events, new Date(clock).toISOString());
    directory.synchronize(events, new Date(clock).toISOString());
    expect(directory.bootstrap()).toMatchObject({ status: 'completed', failedEvents: 0 });
    expect(directory.hasPending(events, clock)).toBe(false);
  });

  it('rejects a manual retry after any read dependency changes or a source is forgotten', async () => {
    let clock = Date.now();
    const memory = StrataGate.inMemory({ ...options, now: () => new Date(clock) });
    const events = await seed(memory, 2);
    let context = (await memory.claimNextTopicProjection())!;
    for (let attempt = 0; attempt < 3; attempt++) {
      await memory.failTopicProjection(context.jobId, new Error('timeout'));
      clock += 120_000;
      if (attempt < 2) context = (await memory.claimNextTopicProjection())!;
    }
    const terminalId = context.jobId;
    events[0]!.summary = '来源已修改';
    await expect(memory.retryTopicProjection(terminalId)).rejects.toThrow(/conflict/);
    await memory.forgetEvent(events[1]!.id);
    await expect(memory.retryTopicProjection(terminalId)).rejects.toThrow(/conflict/);
    expect(memory.listTopicProjectionJobs().some((job) => job.status === 'pending')).toBe(false);
  });

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
    expect(memory.hasPendingTopicWork('incremental')).toBe(false);
    expect(await memory.claimNextTopicProjection('incremental')).toBeNull();
    let calls = 0;
    while (memory.hasPendingTopicWork() && calls < 5) {
      const batch = (await memory.claimNextTopicProjection('bootstrap'))!;
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
    oldState.bootstrap!.projectorVersion = 1;
    oldState.topics[0]!.projectorVersion = 1;
    const directory = new MemoryTopicDirectory();
    directory.restore(oldState);
    const now = new Date().toISOString();
    expect(directory.hasPending(events, Date.parse(now))).toBe(true);
    directory.initializeBootstrap(events, now);
    expect(directory.claim(events, now, 'incremental')).toBeNull();
    expect(directory.bootstrap()?.status).toBe('pending');
    const rebuild = directory.claim(events, now, 'bootstrap')!;
    expect(directory.complete(rebuild.jobId, projection(rebuild), events, now).topicIds).not.toContain(oldId);
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
    await expect(memory.completeTopicProjection(context.jobId, omitted)).rejects.toThrow('every supplied batch Event must be assigned to a topic');
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
      title: '受隐藏偏好影响的主题 ' + event.id, description: '受隐藏偏好影响的简介',
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
    expect(memory.listTopicProjectionJobs()[0]).toMatchObject({ lastError: 'worker-failed', context: null });
    expect(JSON.stringify(memory.exportSnapshot().memoryTopicState)).not.toContain('私密原文和模型响应');
    await memory.failTopicProjection(context.jobId, new Error('second failure'));
    expect(memory.listTopicProjectionJobs()[0]!.lastError).toBe('worker-failed');
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
      expect(final.schemaVersion).toBe(14);
    } finally {
      await reader?.close(); await memory?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});


describe('Topic failure diagnostics and bounded recovery (#119)', () => {
  const maxTokens = () => new TopicProjectionError('max-tokens', 'output token limit reached',
    { finishReason: 'max-tokens', requestedOutputTokens: 32768, maxOutputTokens: 32768 });
  const start = async (count = 12) => {
    const memory = StrataGate.inMemory(options);
    const events = await seed(memory, count);
    const directory = new MemoryTopicDirectory();
    const clock = Date.parse('2026-10-07T00:00:00Z');
    directory.initializeBootstrap(events, new Date(clock).toISOString());
    return { memory, events, directory, clock };
  };
  it('splits explicit max-tokens without changing evidence, reprocessing success or accepting old replies', async () => {
    const { events, directory, clock } = await start();
    const now = (delta = 0) => new Date(clock + delta).toISOString();
    const parent = directory.claim(events, now(), 'bootstrap')!;
    directory.fail(parent.jobId, maxTokens(), now());
    expect(directory.jobs().find((job) => job.id === parent.jobId)).toMatchObject({
      superseded: true, lastError: 'max-tokens',
      diagnostics: { category: 'max-tokens', eventCount: 12, attempt: 1, splitDepth: 0 } });
    expect(directory.claim(events, now(29000), 'bootstrap')).toBeNull();
    const a = directory.claim(events, now(30000), 'bootstrap')!;
    expect(a.events).toHaveLength(6);
    expect(a.events).toEqual(parent.events.slice(0, 6));
    directory.complete(a.jobId, projection(a), events, now(30000));
    const restored = new MemoryTopicDirectory(); restored.restore(directory.snapshot());
    const b = restored.claim(events, now(30000), 'bootstrap')!;
    expect(b.events).toEqual(parent.events.slice(6));
    restored.complete(b.jobId, projection(b, b.existingTopics[0]!.id), events, now(30000));
    restored.synchronize(events, now(30000));
    expect(restored.hasPending(events, clock + 30000)).toBe(false);
    expect(restored.bootstrap()).toMatchObject({ status: 'completed', failedEvents: 0 });
    expect(Object.keys(restored.snapshot().projectedVersions)).toHaveLength(12);
    expect(() => restored.complete(parent.jobId, projection(parent), events, now(30000))).toThrow(/not running/);
  });
  it('bounds repeated max-tokens at singleton batches and keeps every exhausted source manually recoverable', async () => {
    const { events, directory, clock: initial } = await start();
    let clock = initial, calls = 0;
    for (;;) {
      const context = directory.claim(events, new Date(clock).toISOString(), 'bootstrap');
      if (!context) {
        if (!directory.jobs().some((job) => !job.superseded && (job.status === 'pending' || job.nextRetryAt !== null))) break;
        clock += 120000; continue;
      }
      expect(context.events.length).toBeGreaterThan(0);
      directory.fail(context.jobId, maxTokens(), new Date(clock).toISOString());
      calls += 1; expect(calls).toBeLessThanOrEqual(47); clock += 120000;
    }
    directory.synchronize(events, new Date(clock).toISOString());
    const terminal = directory.jobs().filter((job) => !job.superseded);
    expect(terminal).toHaveLength(12);
    expect(new Set(terminal.flatMap((job) => job.sourceEventIds)).size).toBe(12);
    expect(terminal.every((job) => job.attempts === 3 && job.nextRetryAt === null && (job.splitDepth ?? 0) <= 4)).toBe(true);
    expect(calls).toBe(47);
    expect(directory.bootstrap()!.failedEvents).toBe(12);
    const retry = directory.retry(terminal[0]!.id, events, new Date(clock).toISOString());
    expect(retry.jobId).not.toBe(terminal[0]!.id);
    expect(directory.jobs().find((job) => job.id === retry.jobId)).toMatchObject({ attempts: 0, splitDepth: 0 });
  });
  it.each(['schema-invalid', 'validation-failed', 'provider-failed', 'timeout', 'worker-failed'] as const)(
    'keeps %s on the original batch with existing exponential backoff', async (category) => {
      const { events, directory, clock: initial } = await start();
      let clock = initial;
      for (let attempt = 1; attempt <= 3; attempt++) {
        const context = directory.claim(events, new Date(clock).toISOString())!;
        expect(context.events).toHaveLength(12);
        directory.fail(context.jobId, new TopicProjectionError(category, 'topic worker failed'), new Date(clock).toISOString());
        const job = directory.jobs().find((job) => job.id === context.jobId)!;
        expect(job.diagnostics!.category).toBe(category);
        expect(job.nextRetryAt).toBe(attempt === 3 ? null : new Date(clock + 30000 * 2 ** (attempt - 1)).toISOString());
        clock += 120000;
      }
      expect(directory.hasPending(events, clock)).toBe(false);
      expect(directory.jobs().filter((job) => !job.superseded)).toHaveLength(1);
    });
  it('splits section-backfill work within its existing chapter and preserves the historical success ledger', async () => {
    const { events, directory, clock } = await start();
    const now = (delta = 0) => new Date(clock + delta).toISOString();
    const initial = directory.claim(events, now(), 'bootstrap')!;
    const [chapterId] = directory.complete(initial.jobId, projection(initial), events, now()).topicIds;
    const state = directory.snapshot(); const frozen = structuredClone(state.projectedVersions);
    state.topics[0]!.sections = []; delete state.sectionMembershipVersion;
    const repair = new MemoryTopicDirectory(); repair.restore(state); repair.initializeBootstrap(events, now());
    const parent = repair.claim(events, now(), 'bootstrap')!;
    expect(parent.sectionBackfillTopicId).toBe(chapterId);
    repair.fail(parent.jobId, maxTokens(), now());
    for (let part = 0; part < 2; part++) {
      const child = repair.claim(events, now(30000), 'bootstrap')!;
      expect(child.sectionBackfillTopicId).toBe(chapterId); expect(child.events).toHaveLength(6);
      const sourceEventIds = child.events.map((event) => event.id);
      repair.complete(child.jobId, { topics: [{ topicId: chapterId!, title: 'ignored routing label', description: 'ignored prose',
        sourceEventIds, overview: [], sections: [{ title: 'repaired section', sourceEventIds }] }] }, events, now(30000));
    }
    const after = repair.snapshot();
    expect(after.projectedVersions).toEqual(frozen); expect(after.sectionBackfill).toEqual({});
    expect(after.topics).toHaveLength(1); expect(after.topics[0]!.id).toBe(chapterId);
    expect(after.topics[0]!.title).toBe(state.topics[0]!.title);
    expect(after.topics[0]!.sourceEventIds).toEqual(state.topics[0]!.sourceEventIds);
    expect(after.topics[0]!.sections![0]!.sourceEventIds).toEqual(parent.events.map((event) => event.id));
  });
  it('keeps split source-version checks after restart and never resurrects a forgotten Event', async () => {
    const { events, directory, clock } = await start();
    const context = directory.claim(events, new Date(clock).toISOString())!;
    directory.fail(context.jobId, maxTokens(), new Date(clock).toISOString());
    events[0]!.status = 'forgotten'; events[6]!.summary = 'a genuinely new version';
    const restored = new MemoryTopicDirectory(); restored.restore(directory.snapshot());
    restored.initializeBootstrap(events, new Date(clock + 120000).toISOString());
    const fresh = restored.claim(events, new Date(clock + 120000).toISOString())!;
    expect(fresh.events.map((event) => event.id)).not.toContain(events[0]!.id);
    expect(fresh.events.find((event) => event.id === events[6]!.id)!.summary).toBe(events[6]!.summary);
    expect(restored.jobs().filter((job) => job.sourceVersions[events[0]!.id])).toSatisfy((jobs: any[]) => jobs.every((job) => job.superseded));
    expect(() => restored.complete(context.jobId, projection(context), events, new Date(clock + 120000).toISOString())).toThrow(/not running/);
  });
  it('requires an explicit max-tokens finish signal, not an error message or category alone', async () => {
    const { events, directory, clock } = await start();
    const context = directory.claim(events, new Date(clock).toISOString())!;
    directory.fail(context.jobId, new TopicProjectionError('max-tokens', 'output token limit reached'), new Date(clock).toISOString());
    expect(directory.jobs()).toHaveLength(1);
    expect(directory.jobs()[0]!.superseded).not.toBe(true);
  });
  it('persists safe diagnostics and a fresh manual lifecycle in SQLite without reviving old failures on reopen', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'topic-reliability-'));
    const database = join(folder, 'memory.sqlite'), namespace = 'topic-reliability';
    let clock = Date.parse('2026-10-07T00:00:00Z');
    const open = () => StrataGate.open({ ...options, database, namespace, now: () => new Date(clock) });
    let memory = await open();
    try {
      await seed(memory, 2);
      let context = (await memory.claimNextTopicProjection())!;
      for (let attempt = 0; attempt < 3; attempt++) {
        await memory.failTopicProjection(context.jobId, new TopicProjectionError('validation-failed',
          'every supplied batch Event must be assigned to a topic', { estimatedInputTokens: 100, requestedOutputTokens: 32768 }));
        clock += 120000;
        if (attempt < 2) context = (await memory.claimNextTopicProjection())!;
      }
      const oldId = context.jobId, before = memory.listTopicProjectionJobs();
      await memory.close(); memory = await open();
      expect(memory.listTopicProjectionJobs()).toEqual(before);
      expect(await memory.claimNextTopicProjection()).toBeNull();
      expect(JSON.stringify(before)).not.toContain('部署项目');
      expect(before.at(-1)!.diagnostics).toMatchObject({ category: 'validation-failed',
        reason: 'every supplied batch Event must be assigned to a topic', estimatedInputTokens: 100, attempt: 3 });
      const retry = await memory.retryTopicProjection(oldId);
      await memory.close(); memory = await open();
      const fresh = (await memory.claimNextTopicProjection())!;
      expect(fresh.jobId).toBe(retry.jobId);
      await expect(memory.completeTopicProjection(oldId, projection(fresh))).rejects.toThrow(/not running/);
      await memory.completeTopicProjection(fresh.jobId, projection(fresh));
      expect(memory.hasPendingTopicWork()).toBe(false);
    } finally { await memory.close(); await rm(folder, { recursive: true, force: true }); }
  });
  it('keeps the safe core semantic rule for missing Events without persisting source text', async () => {
    const { memory } = await start(2);
    const context = (await memory.claimNextTopicProjection())!;
    const result = projection(context); result.topics[0]!.sourceEventIds = [context.events[0]!.id];
    result.topics[0]!.overview = [];
    try { await memory.completeTopicProjection(context.jobId, result); } catch (error) { await memory.failTopicProjection(context.jobId, error); }
    expect(memory.listTopicProjectionJobs()[0]!.diagnostics).toMatchObject({ category: 'validation-failed',
      reason: 'every supplied batch Event must be assigned to a topic' });
    expect(JSON.stringify(memory.listTopicProjectionJobs())).not.toContain('部署项目');
  });
});
