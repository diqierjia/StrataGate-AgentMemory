import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import {
  MemoryTopicDirectory, TopicProjectionError, MEMORY_TOPIC_PROJECTOR_VERSION, memoryTopicEventFingerprint, StrataGate,
  type EventCard, type MemoryTopicState, type StoredMemoryTopic, type StrataGateSnapshot,
  type TopicProjectionJob,
} from '@diqier/stratagate'
import { describe, expect, it, vi } from 'vitest'
import type { ResolvedConfig } from '../src/config.js'
import type { DshModelBridge } from '../src/llm.js'
import { StrataGateRuntime } from '../src/runtime.js'
import { handleAdminRequest, type WebResponse } from '../src/web.js'
import { memoryTopicSectionKey } from '../src/topics.js'

const namespace = 'dsh:project:topic-directory'
const now = '2026-10-03T00:00:00.000Z'

function event(id: string): EventCard {
  return {
    id, title: `标题 ${id}`, summary: `内容 ${id}`, tags: [], quotes: [], sourceMessageIds: [],
    sourceBlockId: 'block-source', temporal: {}, scope: 'project', criticality: 'routine', status: 'active',
    supersededBy: null,
    weight: { mentionCount: 1, lastAdoptedTurn: 0, lastRetrievedAt: null, pinned: false, floorWeight: 0, forcedCap: null },
    createdAt: now, updatedAt: now,
  }
}

function emptySnapshot(): StrataGateSnapshot {
  const snapshot = StrataGate.inMemory().exportSnapshot()
  delete snapshot.memoryTopicState
  return snapshot
}

function freeze(events: EventCard[]): MemoryTopicState {
  const directory = new MemoryTopicDirectory()
  directory.initializeBootstrap(events, now)
  return directory.snapshot()
}

function versions(events: EventCard[]): Record<string, string> {
  return Object.fromEntries(events.map((source) => [source.id, memoryTopicEventFingerprint(source)]))
}

function topic(id: string, sources: EventCard[], dependencies = sources): StoredMemoryTopic {
  return {
    id, title: `正式主题 ${id}`, description: `主题说明 ${id}`,
    sourceEventIds: sources.map(({ id }) => id),
    overview: [{ kind: 'history', text: `总览 ${id}`, sourceEventIds: sources.map(({ id }) => id) }],
    createdAt: now, updatedAt: now, sourceVersions: versions(sources), dependencyVersions: versions(dependencies),
    projectorVersion: MEMORY_TOPIC_PROJECTOR_VERSION, invalidated: false,
  }
}

function failedJob(id: string, sources: EventCard[], overrides: Partial<TopicProjectionJob> = {}): TopicProjectionJob {
  return {
    id, sourceEventIds: sources.map(({ id }) => id), sourceVersions: versions(sources),
    dependencyVersions: versions(sources), candidateVersions: {}, context: null,
    projectorVersion: MEMORY_TOPIC_PROJECTOR_VERSION, status: 'failed', attempts: 3,
    topicIds: [], lastError: 'worker-failed', nextRetryAt: null, createdAt: now, updatedAt: now,
    ...overrides,
  }
}

function fakeRuntime(snapshot: StrataGateSnapshot, weight: () => number = () => 1): StrataGateRuntime {
  return {
    adminSnapshot: async (key: string) => key === namespace ? snapshot : null,
    adminNamespaces: async () => [namespace],
    adminSnapshotEntries: async () => [{ namespace, revision: 5, snapshot }],
    adminAgentMemoryRetrievalWeight: weight,
    adminWorkspaceName: () => '测试工作区',
    adminDataDirectory: () => 'C:\\memory',
  } as unknown as StrataGateRuntime
}

async function request(runtime: StrataGateRuntime, path = 'topics', method = 'GET', headers?: Record<string, string>) {
  const [route, ...parameters] = path.split('&')
  let text = ''
  const outputHeaders: Record<string, string> = {}
  const response: WebResponse = {
    statusCode: 0,
    setHeader: (name, value) => { outputHeaders[name] = value },
    end: (body) => { text = body },
  }
  await handleAdminRequest(runtime, {
    method, url: `/api/stratagate/${route}?namespace=${encodeURIComponent(namespace)}${parameters.map((value) => `&${value}`).join('')}`,
    ...(headers ? { headers } : {}),
  }, response)
  return { status: response.statusCode, body: text ? JSON.parse(text) : null, headers: outputHeaders }
}

describe('read-only Topic Directory admin data', () => {
  it('moves migrated uncategorized Events into actual section paging without manufacturing overview prose', async () => {
    const snapshot = emptySnapshot(); snapshot.events = ['research', 'education', 'math-news'].map(event);
    const state = freeze(snapshot.events), chapter = topic('personal', snapshot.events);
    chapter.overview = [{ kind: 'history', title: '研究方向', text: 'AI4Math', sourceEventIds: ['research'] }];
    state.topics = [chapter]; state.projectedVersions = versions(snapshot.events);
    delete state.sectionMembershipVersion;
    const directory = new MemoryTopicDirectory(); directory.restore(state);
    directory.initializeBootstrap(snapshot.events, now);
    const context = directory.claim(snapshot.events, now, 'bootstrap')!;
    expect(context.events.map(({ id }) => id)).toEqual(['education', 'math-news']);
    directory.complete(context.jobId, { topics: [{ topicId: 'personal', title: chapter.title, description: chapter.description,
      sourceEventIds: ['education', 'math-news'], overview: [], sections: [
        { title: '教育背景', sourceEventIds: ['education'] }, { title: '研究方向', sourceEventIds: ['math-news'] },
      ],
    }] }, snapshot.events, now);
    snapshot.memoryTopicState = directory.snapshot();
    const runtime = fakeRuntime(snapshot), before = JSON.stringify(snapshot);
    const response = await request(runtime);
    expect(response.body.topics[0].coverage).toMatchObject({ totalEvents: 3, summarizedEvents: 1, omittedEvents: 2, unassignedEvents: 0 });
    expect(response.body.topics[0].sections.map((section: any) => [section.title, section.sourceEventCount, section.paragraphs.length]))
      .toEqual([['研究方向', 2, 1], ['教育背景', 1, 0]]);
    expect((await request(runtime, `topic-events&topicId=personal&sectionKey=${memoryTopicSectionKey('教育背景')}`)).body.items.map((item: any) => item.id))
      .toEqual(['education']);
    expect((await request(runtime, 'topic-events&topicId=personal&sectionKey=uncovered')).body.items).toEqual([]);
    expect(JSON.stringify(snapshot)).toBe(before);
  });

  it('shows exhausted membership-backfill failures even when prose projection was already completed', async () => {
    const snapshot = emptySnapshot(); snapshot.events = ['known', 'unassigned'].map(event);
    const state = freeze(snapshot.events), chapter = topic('personal', snapshot.events);
    chapter.overview = [{ kind: 'history', title: '研究方向', text: '资料', sourceEventIds: ['known'] }];
    state.topics = [chapter]; state.projectedVersions = versions(snapshot.events);
    delete state.sectionMembershipVersion;
    const directory = new MemoryTopicDirectory(); directory.restore(state);
    directory.initializeBootstrap(snapshot.events, now);
    let clock = Date.parse(now), lastJob = '';
    for (let i = 0; i < 3; i++) {
      const context = directory.claim(snapshot.events, new Date(clock).toISOString(), 'bootstrap')!;
      lastJob = context.jobId; directory.fail(lastJob, new Error('invalid sections'), new Date(clock).toISOString());
      clock += 120_000;
    }
    snapshot.memoryTopicState = directory.snapshot();
    const response = await request(fakeRuntime(snapshot));
    expect(response.body.bootstrap).toMatchObject({ total: 2, completed: 1, failedEvents: 1,
      failures: [{ jobId: lastJob, eventCount: 1, attempts: 3 }] });
    expect(JSON.stringify(response.body)).not.toContain('sourceEventIds');
  });

  it('counts A and B backfill relations separately through failure, B success, restart and manual A retry', async () => {
    const snapshot = emptySnapshot(); snapshot.events = [event('shared')];
    const state = freeze(snapshot.events), chapterA = topic('chapter-a', snapshot.events), chapterB = topic('chapter-b', snapshot.events);
    chapterA.overview = []; chapterB.overview = [];
    state.topics = [chapterA, chapterB]; state.projectedVersions = versions(snapshot.events);
    delete state.sectionMembershipVersion;
    let directory = new MemoryTopicDirectory(); directory.restore(state); directory.initializeBootstrap(snapshot.events, now);
    let clock = Date.parse(now), failedJob = '';
    for (let i = 0; i < 3; i++) {
      const context = directory.claim(snapshot.events, new Date(clock).toISOString(), 'bootstrap')!;
      expect(context.sectionBackfillTopicId).toBe('chapter-a');
      failedJob = context.jobId; directory.fail(failedJob, new Error('invalid sections'), new Date(clock).toISOString());
      clock += 120_000;
    }
    snapshot.memoryTopicState = directory.snapshot();
    const pendingB = (await request(fakeRuntime(snapshot))).body.bootstrap;
    expect(pendingB).toMatchObject({ status: 'running', total: 1, completed: 0, failedEvents: 1,
      sectionBackfill: { pendingRelations: 2, failedRelations: 1 }, failures: [{ jobId: failedJob, eventCount: 1 }] });
    expect((await request(fakeRuntime(snapshot), 'dashboard')).body.processing).toBe(true);
    const repair = (context: NonNullable<ReturnType<MemoryTopicDirectory['claim']>>) => ({ topics: [{
      topicId: context.sectionBackfillTopicId!, title: '学术资料', description: '资料', sourceEventIds: ['shared'],
      overview: [], sections: [{ title: '研究方向', sourceEventIds: ['shared'] }],
    }] });
    const contextB = directory.claim(snapshot.events, new Date(clock).toISOString(), 'bootstrap')!;
    expect(contextB.sectionBackfillTopicId).toBe('chapter-b');
    directory.complete(contextB.jobId, repair(contextB), snapshot.events, new Date(clock).toISOString());
    snapshot.memoryTopicState = directory.snapshot();
    const failedA = (await request(fakeRuntime(snapshot))).body.bootstrap;
    expect(failedA).toMatchObject({ status: 'failed', total: 1, completed: 0, failedEvents: 1,
      sectionBackfill: { pendingRelations: 1, failedRelations: 1 } });
    expect((await request(fakeRuntime(snapshot), 'dashboard')).body.processing).toBe(false);
    directory = new MemoryTopicDirectory(); directory.restore(snapshot.memoryTopicState);
    directory.initializeBootstrap(snapshot.events, new Date(clock).toISOString()); snapshot.memoryTopicState = directory.snapshot();
    expect((await request(fakeRuntime(snapshot))).body.bootstrap).toEqual(failedA);
    directory.retry(failedJob, snapshot.events, new Date(clock).toISOString()); snapshot.memoryTopicState = directory.snapshot();
    expect((await request(fakeRuntime(snapshot))).body.bootstrap).toMatchObject({ status: 'running', failedEvents: 0,
      sectionBackfill: { pendingRelations: 1, failedRelations: 0 } });
    const contextA = directory.claim(snapshot.events, new Date(clock).toISOString(), 'bootstrap')!;
    directory.complete(contextA.jobId, repair(contextA), snapshot.events, new Date(clock).toISOString());
    snapshot.memoryTopicState = directory.snapshot();
    expect((await request(fakeRuntime(snapshot))).body.bootstrap).toMatchObject({ status: 'completed', total: 1, completed: 1, failedEvents: 0,
      sectionBackfill: { pendingRelations: 0, failedRelations: 0 } });
  });

  it('does not recreate an orphan overview section in the directory or paging after reclassification', async () => {
    const snapshot = emptySnapshot(); snapshot.events = [event('moved')];
    const directory = new MemoryTopicDirectory(); directory.initializeBootstrap([], now);
    const initial = directory.claim(snapshot.events, now)!;
    const { topicIds: [id] } = directory.complete(initial.jobId, { topics: [{ title: '项目', description: '资料',
      sourceEventIds: ['moved'], sections: [{ title: '旧小节', sourceEventIds: ['moved'] }],
      overview: [{ kind: 'history', title: '旧小节', text: '旧总览', sourceEventIds: ['moved'] }],
    }] }, snapshot.events, now);
    const pending = directory.snapshot(); delete pending.projectedVersions.moved; directory.restore(pending);
    const next = directory.claim(snapshot.events, now)!;
    directory.complete(next.jobId, { topics: [{ topicId: id!, title: '项目', description: '资料', sourceEventIds: ['moved'],
      sections: [{ title: '新小节', sourceEventIds: ['moved'] }], overview: [],
    }] }, snapshot.events, now);
    snapshot.memoryTopicState = directory.snapshot();
    const runtime = fakeRuntime(snapshot); const before = JSON.stringify(snapshot);
    const response = await request(runtime);
    expect(response.status).toBe(200);
    expect(response.body.topics[0].sections.map((section: any) => [section.title, section.sourceEventCount, section.paragraphs.length]))
      .toEqual([['新小节', 1, 0]]);
    expect(response.body.topics[0].coverage).toMatchObject({ totalEvents: 1, summarizedEvents: 0, unassignedEvents: 0 });
    const page = await request(runtime, `topic-events&topicId=${id}&sectionKey=${memoryTopicSectionKey('新小节')}`);
    expect(page.status).toBe(200); expect(page.body.items.map((item: any) => item.id)).toEqual(['moved']);
    expect((await request(runtime, `topic-events&topicId=${id}&sectionKey=${memoryTopicSectionKey('旧小节')}`)).status).toBe(404);
    expect(JSON.stringify(snapshot)).toBe(before);
  });

  it('indexes uncited and summary-free section members while leaving only genuinely unassigned events in uncovered', async () => {
    const snapshot = emptySnapshot(); snapshot.events = ['cited', 'uncited', 'no-summary', 'unassigned'].map(event);
    snapshot.memoryTopicState = freeze(snapshot.events);
    const chapter = topic('independent', snapshot.events);
    chapter.overview = [{ kind: 'scope', title: '研究方向', text: '研究资料', sourceEventIds: ['cited'] }];
    chapter.sections = [{ title: '研究方向', sourceEventIds: ['cited', 'uncited'] }, { title: '教育背景', sourceEventIds: ['no-summary'] }];
    snapshot.memoryTopicState.topics = [chapter]; snapshot.memoryTopicState.projectedVersions = versions(snapshot.events);
    const before = JSON.stringify(snapshot); const runtime = fakeRuntime(snapshot);
    const directory = (await request(runtime)).body;
    expect(directory.topics[0].coverage).toEqual({ totalEvents: 4, summarizedEvents: 1, omittedEvents: 3, unassignedEvents: 1 });
    expect(directory.topics[0].sections.map((section: any) => [section.title, section.sourceEventCount, section.paragraphs.length]))
      .toEqual([['研究方向', 2, 1], ['教育背景', 1, 0]]);
    const research = (await request(runtime, `topic-events&topicId=independent&sectionKey=${memoryTopicSectionKey('研究方向')}`)).body;
    expect(research.items.map((item: any) => item.id)).toEqual(['cited', 'uncited']);
    const background = (await request(runtime, `topic-events&topicId=independent&sectionKey=${memoryTopicSectionKey('教育背景')}`)).body;
    expect(background.items.map((item: any) => item.id)).toEqual(['no-summary']);
    expect((await request(runtime, 'topic-events&topicId=independent&sectionKey=uncovered')).body.items.map((item: any) => item.id)).toEqual(['unassigned']);
    expect(JSON.stringify(directory)).not.toContain('sourceEventIds'); expect(JSON.stringify(snapshot)).toBe(before);
  });

  it('keeps .0 paragraph order and .1-N Event numbers when same-section proposals prepend overlapping sources', async () => {
    const snapshot = emptySnapshot();
    snapshot.events = Array.from({ length: 16 }, (_, index) => event(`stable-${index}`));
    const ids = snapshot.events.map(({ id }) => id);
    const stored = topic('chapter', snapshot.events);
    const a = { kind: 'history' as const, title: '界面与交互', text: '旧 A', sourceEventIds: ids.slice(0, 8) };
    const b = { kind: 'decision' as const, title: '界面与交互', text: '旧 B', sourceEventIds: ids.slice(7, 15) };
    stored.overview = [a, b];
    snapshot.memoryTopicState = freeze(snapshot.events);
    snapshot.memoryTopicState.topics = [stored];
    snapshot.memoryTopicState.projectedVersions = versions(snapshot.events);
    const runtime = fakeRuntime(snapshot);
    const before = (await request(runtime)).body;
    const key = before.topics[0].sections[0].key;
    stored.overview = [{ kind: 'change', title: a.title, text: '新 C', sourceEventIds: [ids[15]!, ids[10]!] }, b, a];
    const original = JSON.stringify(snapshot);
    const after = (await request(runtime)).body;
    expect(after.topics[0].sections[0].key).toBe(key);
    expect(after.topics[0].sections[0].paragraphs.map(({ text }: { text: string }) => text)).toEqual(['旧 A', '旧 B', '新 C']);
    const query = `topic-events&topicId=chapter&sectionKey=${key}&expectedRevision=${after.revision}`;
    const first = (await request(runtime, query)).body;
    const second = (await request(runtime, query + '&offset=9')).body;
    expect([...first.items, ...second.items].map(({ id }: { id: string }) => id)).toEqual(ids);
    expect(first.items).toHaveLength(9);
    expect((await request(runtime, `topic-events&topicId=chapter&sectionKey=${key}&expectedRevision=${before.revision}`)).status).toBe(409);
    expect(JSON.stringify(snapshot)).toBe(original);
  });

  it('exposes exhausted rebuild failures for manual retry after an originally completed Bootstrap', async () => {
    const snapshot = emptySnapshot(); snapshot.events = [event('old')];
    snapshot.memoryTopicState = freeze([]);
    snapshot.memoryTopicState.rebuildVersions = versions(snapshot.events);
    snapshot.memoryTopicState.jobs = [failedJob('rebuild-failure', snapshot.events)];
    snapshot.memoryTopicState.topics = [topic('partially-rebuilt', snapshot.events)];
    const runtime = fakeRuntime(snapshot);
    const retry = vi.fn(async () => ({ jobId: 'new-rebuild', status: 'pending' as const }));
    runtime.adminRetryTopicProjection = retry;
    const directory = (await request(runtime)).body;
    expect(directory.bootstrap).toMatchObject({ total: 1, completed: 0, failedEvents: 1, status: 'failed' });
    expect(directory.bootstrap.failures[0]).toMatchObject({ jobId: 'rebuild-failure', eventCount: 1 });
    expect(directory.pending.total).toBe(0);
    const page = await request(runtime, `topic-events&topicId=pending&sectionKey=failure:rebuild-failure&expectedRevision=${directory.revision}`);
    expect(page.body.items.map(({ id }: { id: string }) => id)).toEqual(['old']);
    expect((await request(runtime, `topics/retry&jobId=rebuild-failure&expectedRevision=${directory.revision}`, 'POST')).status).toBe(200);
    expect(retry).toHaveBeenCalledExactlyOnceWith(namespace, 'rebuild-failure');
  });

  it('invalidates a prerelease paragraph-view ETag without changing the package or database version', async () => {
    const runtime = fakeRuntime(emptySnapshot())
    const current = await request(runtime, 'dashboard')
    const oldEtag = `"${createHash('sha256').update(`${current.body.overview.pluginVersion}\0${namespace}:5\0${namespace}\0\0${1}`).digest('base64url').slice(0, 24)}"`
    expect((await request(runtime, 'dashboard', 'GET', { 'if-none-match': oldEtag })).status).toBe(200)
    expect((await request(runtime, 'dashboard', 'GET', { 'if-none-match': current.headers.ETag! })).status).toBe(304)
  })

  it('queues only a selected current visible failure through POST and rejects stale or hidden retries', async () => {
    const snapshot = emptySnapshot()
    snapshot.events = [event('history')]
    snapshot.agentEvents = [event('agent-history')]
    snapshot.memoryTopicState = freeze([...snapshot.events, ...snapshot.agentEvents])
    snapshot.memoryTopicState.jobs = [
      failedJob('visible-failure', snapshot.events),
      failedJob('agent-failure', snapshot.agentEvents),
    ]
    let weight = 1
    const runtime = fakeRuntime(snapshot, () => weight)
    const retry = vi.fn(async () => ({ jobId: 'new-attempt', status: 'pending' as const }))
    runtime.adminRetryTopicProjection = retry
    const first = await request(runtime)
    expect((await request(runtime, 'topics/retry&jobId=visible-failure&expectedRevision=' + first.body.revision)).status).toBe(405)
    expect((await request(runtime, 'topics/retry&jobId=visible-failure', 'POST')).status).toBe(400)
    expect((await request(runtime, 'topics/retry&jobId=visible-failure&expectedRevision=stale', 'POST')).status).toBe(409)
    expect((await request(runtime, 'topics/retry&jobId=unknown&expectedRevision=' + first.body.revision, 'POST')).status).toBe(409)
    expect(retry).not.toHaveBeenCalled()
    expect((await request(runtime, 'topics/retry&jobId=visible-failure&expectedRevision=' + first.body.revision, 'POST')).body)
      .toMatchObject({ namespace, jobId: 'new-attempt', status: 'pending' })
    expect(retry).toHaveBeenCalledExactlyOnceWith(namespace, 'visible-failure')
    retry.mockClear()
    weight = 0
    const changed = await request(runtime)
    expect((await request(runtime, 'topics/retry&jobId=agent-failure&expectedRevision=' + changed.body.revision, 'POST')).status).toBe(409)
    snapshot.events[0]!.status = 'forgotten'
    expect((await request(runtime, 'topics/retry&jobId=visible-failure&expectedRevision=' + changed.body.revision, 'POST')).status).toBe(409)
    expect(retry).not.toHaveBeenCalled()
  })

  it('routes generic Topic retry to the same queue-only lifecycle without requiring model readiness', async () => {
    const snapshot = emptySnapshot(); snapshot.events = [event('history')];
    snapshot.memoryTopicState = freeze(snapshot.events); snapshot.memoryTopicState.jobs = [failedJob('failure', snapshot.events)];
    const runtime = fakeRuntime(snapshot);
    const queue = vi.fn(async () => ({ jobId: 'fresh-topic', status: 'pending' as const }));
    runtime.adminRetryTopicProjection = queue; runtime.adminRetryJob = StrataGateRuntime.prototype.adminRetryJob;
    const result = await request(runtime, 'jobs/retry&kind=topic-projection&jobId=failure', 'POST');
    expect(result.status).toBe(200); expect(result.body).toMatchObject({ jobId: 'fresh-topic', status: 'pending' });
    expect(queue).toHaveBeenCalledExactlyOnceWith(namespace, 'failure');
    queue.mockRejectedValueOnce(new Error('Topic retry conflict: no longer current'));
    expect((await request(runtime, 'jobs/retry&kind=topic-projection&jobId=failure', 'POST')).status).toBe(409);
    expect((await request(runtime, 'jobs/retry&kind=topic-projection&jobId=unknown', 'POST')).status).toBe(404);
  });
  it('exposes safe Topic diagnostics in directory and general task APIs, including incremental failures', async () => {
    const snapshot = emptySnapshot(); snapshot.events = [event('history')]; snapshot.memoryTopicState = freeze(snapshot.events);
    const diagnostics = new TopicProjectionError('validation-failed', 'every supplied batch Event must be assigned to a topic',
      { eventCount: 1, candidateTopicCount: 2, requestedOutputTokens: 32768, maxOutputTokens: 32768,
        estimatedInputTokens: 200, attempt: 3, finishReason: 'stop', reasoningOff: 'unavailable' }).diagnostics;
    snapshot.memoryTopicState.jobs = [failedJob('failure', snapshot.events, { diagnostics,
      lastError: 'PRIVATE RAW ERROR', context: { jobId: 'failure', events: snapshot.events, existingTopics: [] } })];
    const runtime = fakeRuntime(snapshot); const directory = (await request(runtime)).body;
    expect(directory.bootstrap.failures[0]).toMatchObject({ diagnostics, lastError: 'validation-failed: every supplied batch Event must be assigned to a topic' });
    snapshot.memoryTopicState.bootstrap!.sourceVersions = {};
    const overview = (await request(runtime, 'overview')).body.namespaces[0];
    expect(overview.taskStatus.topicProjection.terminalFailed).toBe(1);
    expect(overview.failedJobDetails[0]).toMatchObject({ kind: 'topic-projection', diagnostics });
    expect(JSON.stringify(overview.failedJobDetails)).not.toContain('PRIVATE');
    expect(overview.failedJobDetails[0]).not.toHaveProperty('context');
  });
  it('agrees on 86/86 and zero current failures while retaining the original historical records', async () => {
    const snapshot = emptySnapshot(); snapshot.events = Array.from({ length: 86 }, (_, i) => event(`solved-${i}`));
    snapshot.memoryTopicState = freeze(snapshot.events);
    snapshot.memoryTopicState.projectedVersions = versions(snapshot.events);
    const completedChapter = topic('completed', snapshot.events); completedChapter.overview = [];
    completedChapter.sections = [{ title: '历史', sourceEventIds: snapshot.events.map(({ id }) => id) }];
    snapshot.memoryTopicState.topics = [completedChapter];
    snapshot.memoryTopicState.jobs = [failedJob('solved-failure', snapshot.events.slice(74)),
      failedJob('solved-retryable', snapshot.events.slice(74), { attempts: 1, nextRetryAt: now })];
    const original = structuredClone(snapshot);
    const runtime = fakeRuntime(snapshot);
    const dashboard = (await request(runtime, 'dashboard')).body;
    expect(dashboard.data.topicDirectory.bootstrap).toMatchObject({ status: 'completed', total: 86, completed: 86, failedEvents: 0, failures: [] });
    const row = dashboard.overview.namespaces[0];
    expect(row).toMatchObject({ failedJobs: 0, processingJobs: 0, failedJobDetails: [], processingJobDetails: [] });
    expect(row.taskStatus.topicProjection).toMatchObject({ terminalFailed: 0, retryable: 0, processing: 0 });
    expect(dashboard.processing).toBe(false);
    expect((await request(runtime, 'overview')).body.namespaces[0].failedJobs).toBe(0);
    expect(snapshot).toEqual(original); // every read is a clone; history is retained
    const directory = new MemoryTopicDirectory(); directory.restore(snapshot.memoryTopicState); directory.synchronize(snapshot.events, now);
    snapshot.memoryTopicState = directory.snapshot();
    expect(snapshot.memoryTopicState.jobs.every((job) => job.status === 'failed' && job.superseded)).toBe(true);
    expect((await request(runtime, 'dashboard')).body.overview.namespaces[0].failedJobs).toBe(0);
  });

  it('counts only remaining ordinary/Backfill work and excludes stale, hidden and solved Topic failures in every task view', async () => {
    const snapshot = emptySnapshot(); snapshot.events = [event('done'), event('remaining'), event('stale'), event('backfill')];
    snapshot.agentEvents = [event('hidden')]; snapshot.memoryTopicState = freeze(snapshot.events);
    snapshot.memoryTopicState.projectedVersions = versions([snapshot.events[0]!, snapshot.events[3]!]);
    const chapter = topic('chapter', [snapshot.events[3]!]); chapter.overview = []; chapter.sections = [];
    snapshot.memoryTopicState.topics = [chapter];
    snapshot.memoryTopicState.sectionBackfill = { chapter: versions([snapshot.events[3]!]) };
    snapshot.memoryTopicState.jobs = [failedJob('partial', snapshot.events.slice(0, 2)),
      failedJob('stale', [snapshot.events[2]!]), failedJob('solved', [snapshot.events[0]!]),
      failedJob('backfill', [snapshot.events[3]!], { sectionBackfillTopicId: 'chapter' }),
      failedJob('hidden', snapshot.agentEvents)];
    snapshot.events[2]!.summary = 'new version';
    const dashboard = (await request(fakeRuntime(snapshot, () => 0), 'dashboard')).body;
    const row = dashboard.overview.namespaces[0];
    expect(row.failedJobs).toBe(2);
    expect(row.taskStatus.topicProjection.terminalFailed).toBe(2);
    expect(row.failedJobDetails.map(({ id, eventCount }: any) => [id, eventCount])).toEqual([['partial', 1], ['backfill', 1]]);
    expect(dashboard.data.topicDirectory.bootstrap.failedEvents).toBe(2);
    expect(dashboard.data.topicDirectory.bootstrap.failures.map(({ jobId, eventCount }: any) => [jobId, eventCount])).toEqual([['partial', 1], ['backfill', 1]]);
  });

  it('drops forged diagnostic fields, arbitrary reason strings and raw model data at the API boundary', async () => {
    const snapshot = emptySnapshot(); snapshot.events = [event('history')]; snapshot.memoryTopicState = freeze(snapshot.events);
    snapshot.memoryTopicState.jobs = [failedJob('failure', snapshot.events, { diagnostics: {
      category: 'schema-invalid', reason: 'PRIVATE REASON', rawResponse: 'PRIVATE RESPONSE', reasoning: 'PRIVATE REASONING',
      finishReason: 'PRIVATE FINISH', eventCount: 1, maxOutputTokens: 32768 } as any })];
    const result = (await request(fakeRuntime(snapshot))).body;
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(result.bootstrap.failures[0].diagnostics).toEqual({ category: 'schema-invalid', reason: 'topic worker failed', eventCount: 1, maxOutputTokens: 32768 });
  });

  it('converts a source race after the directory check into a refresh conflict', async () => {
    const snapshot = emptySnapshot()
    snapshot.events = [event('history')]
    snapshot.memoryTopicState = freeze(snapshot.events)
    snapshot.memoryTopicState.jobs = [failedJob('failure', snapshot.events)]
    const runtime = fakeRuntime(snapshot)
    runtime.adminRetryTopicProjection = vi.fn(async () => { throw new Error('Topic retry conflict: source changed') })
    const directory = await request(runtime)
    const result = await request(runtime, 'topics/retry&jobId=failure&expectedRevision=' + directory.body.revision, 'POST')
    expect(result.status).toBe(409)
    expect(result.body.code).toBe('directory-changed')
  })

  it('exposes every chapter with counts while loading Event references in bounded pages', async () => {
    const snapshot = emptySnapshot()
    snapshot.events = Array.from({ length: 60 }, (_, index) => event(`event-${String(index).padStart(3, '0')}`))
    const state = freeze(snapshot.events)
    state.topics = [topic('topic-b', snapshot.events.slice(30, 50)), topic('topic-a', snapshot.events.slice(0, 30))]
    state.projectedVersions = versions(snapshot.events.slice(0, 50))
    snapshot.memoryTopicState = state
    const before = JSON.stringify(snapshot)
    const result = await request(fakeRuntime(snapshot), 'dashboard')
    expect(result.status).toBe(200)
    expect(result.body.data.events).toHaveLength(40)
    const directory = result.body.data.topicDirectory
    expect(directory.navigationOnly).toBe(true)
    expect(directory.topics.filter((item: { isFallback?: boolean }) => !item.isFallback)
      .map((item: { id: string }) => item.id)).toEqual(['topic-a', 'topic-b'])
    expect(directory.topics).toHaveLength(2)
    expect(directory.topics.find((item: { id: string }) => item.id === 'topic-b').overview[0].sourceEventCount).toBe(20)
    expect(JSON.stringify(directory)).not.toContain('"sourceEventIds"')
    expect(JSON.stringify(directory)).not.toContain('"eventIds"')
    expect(directory).not.toHaveProperty('events')
    expect(directory.pending).toEqual({ total: 10 })
    expect(directory.revision).toMatch(/^[a-f0-9]{64}$/)
    expect(directory.context).toContain('StrataGate 记忆目录')
    expect(directory).not.toHaveProperty('batchId')
    expect(directory).not.toHaveProperty('evidenceRefs')
    expect(JSON.stringify(snapshot)).toBe(before)
    const separate = await request(fakeRuntime(snapshot))
    expect(separate.body).toEqual({ namespace, ...directory })
    const page = await request(fakeRuntime(snapshot), `topic-events&topicId=topic-b&sectionKey=${memoryTopicSectionKey('发展脉络')}`)
    expect(page.body).toMatchObject({
      revision: directory.revision, total: 20, offset: 0, limit: 9, nextOffset: 9,
    })
    expect(page.body.items).toHaveLength(9)
    expect(page.body.items[0]).toMatchObject({ id: 'event-030', title: '标题 event-030' })
    expect(page.body.items[0]).not.toHaveProperty('summary')
    const pending = await request(fakeRuntime(snapshot), 'topic-events&topicId=pending&offset=9')
    expect(pending.body).toMatchObject({ total: 10, nextOffset: null, items: [{ id: 'event-059', title: '标题 event-059' }] })
  })

  it.each([2_000, 10_000])('does not duplicate %i Event titles or summaries into the collapsed directory', async (count) => {
    const snapshot = emptySnapshot()
    snapshot.events = Array.from({ length: count }, (_, index) => ({
      ...event(`event-${String(index).padStart(5, '0')}`),
      title: `private-event-title-${index}`,
      summary: `private-event-summary-${index} ${'长期记忆正文'.repeat(40)}`,
    }))
    const runtime = fakeRuntime(snapshot)
    const result = await request(runtime, 'dashboard')
    expect(result.status).toBe(200)
    const directory = result.body.data.topicDirectory
    expect(directory).not.toHaveProperty('events')
    expect(directory.topics).toEqual([])
    expect(directory.pending).toEqual({ total: count })
    // Existing timeline remains a bounded page. Topic navigation may only
    // expose a bounded directory-context sample, never the full Event payload.
    expect(result.body.data.events).toHaveLength(40)
    expect(JSON.stringify(directory)).not.toContain('private-event-summary-')
    expect(JSON.stringify(result.body)).not.toContain(`private-event-title-${count - 1}`)
    expect(JSON.stringify(result.body)).not.toContain(`private-event-summary-${count - 1}`)
    expect(JSON.stringify(directory).length).toBeLessThan(4_000)
    const page = await request(runtime, 'topic-events&topicId=pending&limit=10000000000000000000000000000000')
    expect(page.body).toMatchObject({ total: count, limit: 9, offset: 0, nextOffset: 9 })
    expect(page.body.items).toHaveLength(9)
    for (const item of page.body.items) expect(Object.keys(item)).toEqual(['id', 'title', 'status', 'createdAt'])
  }, 30_000)

  it.each([2_000, 10_000])('keeps a formal Topic with %i members count-only while retaining server-side pagination', async (count) => {
    const snapshot = emptySnapshot()
    snapshot.events = Array.from({ length: count }, (_, index) => event(`member-${String(index).padStart(5, '0')}`))
    snapshot.memoryTopicState = freeze(snapshot.events)
    const chapter = topic('large-topic', snapshot.events)
    chapter.overview[0]!.sourceEventIds = snapshot.events.slice(0, 12).map(({ id }) => id)
    snapshot.memoryTopicState.topics = [chapter]
    snapshot.memoryTopicState.projectedVersions = versions(snapshot.events)
    const runtime = fakeRuntime(snapshot)
    const before = JSON.stringify(snapshot)
    const result = await request(runtime, 'dashboard')
    const directory = result.body.data.topicDirectory
    expect(directory.topics).toHaveLength(1)
    expect(directory.topics[0].coverage).toEqual({ totalEvents: count, summarizedEvents: 12, omittedEvents: count - 12, unassignedEvents: count - 12 })
    expect(directory.topics[0].overview[0].sourceEventCount).toBe(12)
    expect(directory.pending.total).toBe(0)
    const serialized = JSON.stringify(directory)
    expect(serialized).not.toContain('"sourceEventIds"')
    expect(serialized).not.toContain('"eventIds"')
    expect(serialized).not.toContain('member-00000')
    expect(serialized).not.toContain(`member-${String(count - 1).padStart(5, '0')}`)
    expect(serialized.length).toBeLessThan(4_000)
    expect((await request(runtime)).body).toEqual({ namespace, ...directory })
    const page = await request(runtime, `topic-events&topicId=large-topic&sectionKey=uncovered&expectedRevision=${directory.revision}`)
    expect(page.body).toMatchObject({ total: count - 12, limit: 9, offset: 0, nextOffset: 9 })
    expect(page.body.items.map((item: { id: string }) => item.id)).toEqual(snapshot.events.slice(12, 21).map(({ id }) => id))
    const tail = await request(runtime, `topic-events&topicId=large-topic&offset=${count - 1}&expectedRevision=${directory.revision}`)
    expect(tail.body).toMatchObject({ total: count, nextOffset: null, items: [{ id: snapshot.events[count - 1]!.id }] })
    expect(JSON.stringify(snapshot)).toBe(before)
  }, 30_000)

  it('does not expose Event ID arrays even in oversized overview and failure records', async () => {
    const snapshot = emptySnapshot()
    snapshot.events = Array.from({ length: 2_000 }, (_, index) => event(`private-member-${index}`))
    snapshot.memoryTopicState = freeze(snapshot.events)
    snapshot.memoryTopicState.topics = [topic('large-overview', snapshot.events)]
    snapshot.memoryTopicState.projectedVersions = versions(snapshot.events)
    const overviewDirectory = (await request(fakeRuntime(snapshot))).body
    expect(overviewDirectory.topics[0].overview[0].sourceEventCount).toBe(2_000)
    expect(JSON.stringify(overviewDirectory)).not.toContain('"sourceEventIds"')
    expect(JSON.stringify(overviewDirectory).length).toBeLessThan(4_000)

    snapshot.memoryTopicState.topics = []
    snapshot.memoryTopicState.projectedVersions = {}
    snapshot.memoryTopicState.jobs = [failedJob('large-failure', snapshot.events)]
    const runtime = fakeRuntime(snapshot)
    const failureDirectory = (await request(runtime)).body
    expect(failureDirectory.bootstrap.failures[0].eventCount).toBe(2_000)
    expect(JSON.stringify(failureDirectory)).not.toContain('"eventIds"')
    expect(JSON.stringify(failureDirectory).length).toBeLessThan(4_000)
    const page = await request(runtime, `topic-events&topicId=pending&sectionKey=failure:large-failure&expectedRevision=${failureDirectory.revision}`)
    expect(page.body).toMatchObject({ total: 2_000, limit: 9, nextOffset: 9 })
    expect(page.body.items).toHaveLength(9)
  }, 30_000)

  it('changes revision on same-count membership reorder without exposing the member IDs', async () => {
    const snapshot = emptySnapshot()
    snapshot.events = [event('member-a'), event('member-b')]
    snapshot.memoryTopicState = freeze(snapshot.events)
    snapshot.memoryTopicState.topics = [topic('chapter', snapshot.events)]
    snapshot.memoryTopicState.projectedVersions = versions(snapshot.events)
    const runtime = fakeRuntime(snapshot)
    const first = (await request(runtime)).body
    snapshot.memoryTopicState.topics[0]!.sourceEventIds.reverse()
    const second = (await request(runtime)).body
    expect(second.topics).toEqual(first.topics)
    expect(second.revision).not.toBe(first.revision)
    expect((await request(runtime, `topic-events&topicId=chapter&expectedRevision=${first.revision}`)).status).toBe(409)
    expect((await request(runtime, `topic-events&topicId=chapter&expectedRevision=${second.revision}`)).body.items.map((item: { id: string }) => item.id)).toEqual(['member-b', 'member-a'])
  })

  it('retains source order for distinct sections of the same kind and uncovered members', async () => {
    const snapshot = emptySnapshot()
    snapshot.events = Array.from({ length: 15 }, (_, index) => event(`event-${index}`))
    const sources = [snapshot.events[9]!, snapshot.events[1]!, snapshot.events[13]!, ...snapshot.events.filter((_event, index) => ![9, 1, 13].includes(index))]
    const stored = topic('chapter', sources)
    stored.overview = [
      { kind: 'history', text: '第一段脉络', sourceEventIds: sources.slice(0, 8).map(({ id }) => id) },
      { kind: 'history', title: '后续进展', text: '第二段脉络', sourceEventIds: [sources[8]!.id] },
    ]
    snapshot.memoryTopicState = freeze(snapshot.events)
    snapshot.memoryTopicState.topics = [stored]
    snapshot.memoryTopicState.projectedVersions = versions(snapshot.events)
    const runtime = fakeRuntime(snapshot)
    const members = await request(runtime, 'topic-events&topicId=chapter')
    expect(members.body.items.map((item: { id: string }) => item.id)).toEqual(sources.slice(0, 9).map(({ id }) => id))
    const first = await request(runtime, `topic-events&topicId=chapter&sectionKey=${memoryTopicSectionKey('发展脉络')}`)
    expect(first.body.items.map((item: { id: string }) => item.id)).toEqual(sources.slice(0, 8).map(({ id }) => id))
    expect(first.body.nextOffset).toBeNull()
    const second = await request(runtime, `topic-events&topicId=chapter&sectionKey=${memoryTopicSectionKey('后续进展')}`)
    expect(second.body.items.map((item: { id: string }) => item.id)).toEqual([sources[8]!.id])
    const uncovered = await request(runtime, 'topic-events&topicId=chapter&sectionKey=uncovered')
    expect(uncovered.body.items.map((item: { id: string }) => item.id)).toEqual(sources.slice(9).map(({ id }) => id))
    const later = await request(runtime, 'topic-events&topicId=chapter&offset=9')
    expect(later.body.items.map((item: { id: string }) => item.id)).toEqual(sources.slice(9).map(({ id }) => id))
    expect(later.body.nextOffset).toBeNull()
    expect((await request(runtime, 'topic-events&topicId=chapter&sectionKey=history:2')).status).toBe(404)
  })

  it('groups normalized section titles across kinds and pages the deduplicated source union', async () => {
    const snapshot = emptySnapshot()
    snapshot.events = Array.from({ length: 16 }, (_, index) => event(`event-${index}`))
    const stored = topic('chapter', snapshot.events)
    const ids = snapshot.events.map(({ id }) => id)
    stored.overview = [
      { kind: 'history', title: 'UI  Design', text: '原始设计段落', sourceEventIds: ids.slice(0, 8) },
      { kind: 'history', title: 'DSH 兼容', text: '另一个事项', sourceEventIds: [ids[15]!] },
      { kind: 'decision', title: 'ｕｉ design', text: '后来新增的决定', sourceEventIds: ids.slice(7, 15) },
    ]
    snapshot.memoryTopicState = freeze(snapshot.events)
    snapshot.memoryTopicState.topics = [stored]
    snapshot.memoryTopicState.projectedVersions = versions(snapshot.events)
    const before = JSON.stringify(snapshot)
    const runtime = fakeRuntime(snapshot)
    const directory = (await request(runtime)).body
    const sections = directory.topics[0].sections
    expect(sections.map((section: { title: string }) => section.title)).toEqual(['UI  Design', 'DSH 兼容'])
    expect(sections[0].sourceEventCount).toBe(15)
    expect(sections[0].paragraphs).toEqual([
      { kind: 'history', title: 'UI  Design', text: '原始设计段落', sourceEventCount: 8 },
      { kind: 'decision', title: 'ｕｉ design', text: '后来新增的决定', sourceEventCount: 8 },
    ])
    expect(JSON.stringify(directory)).not.toContain('sourceEventIds')
    const query = `topic-events&topicId=chapter&sectionKey=${sections[0].key}&expectedRevision=${directory.revision}`
    const first = (await request(runtime, query)).body
    const second = (await request(runtime, query + '&offset=9')).body
    expect(first).toMatchObject({ total: 15, nextOffset: 9 })
    expect(second).toMatchObject({ total: 15, nextOffset: null })
    expect([...first.items, ...second.items].map(({ id }: { id: string }) => id)).toEqual(ids.slice(0, 15))
    expect(JSON.stringify(snapshot)).toBe(before)
    // Paragraph changes retain section identity but invalidate page caches.
    stored.overview[2]!.text = '更新后的决定'
    const updated = (await request(runtime)).body
    expect(updated.topics[0].sections[0].key).toBe(sections[0].key)
    expect(updated.revision).not.toBe(directory.revision)
    expect((await request(runtime, query)).status).toBe(409)
  })

  it('keeps existing section numbers when a new proposal precedes inherited paragraphs', async () => {
    const snapshot = emptySnapshot()
    snapshot.events = [event('old-a'), event('old-b'), event('new-c')]
    const stored = topic('chapter', snapshot.events.slice(0, 2))
    const a = { kind: 'history' as const, title: '界面与交互', text: '旧 A', sourceEventIds: ['old-a'] }
    const b = { kind: 'history' as const, title: 'DSH 兼容', text: '旧 B', sourceEventIds: ['old-b'] }
    stored.overview = [a, b]
    snapshot.memoryTopicState = freeze(snapshot.events)
    snapshot.memoryTopicState.topics = [stored]
    snapshot.memoryTopicState.projectedVersions = versions(snapshot.events)
    const runtime = fakeRuntime(snapshot)
    const before = (await request(runtime)).body
    expect(before.topics[0].sections.map(({ title }: { title: string }) => title)).toEqual([a.title, b.title])
    // The actual storage shape: proposal first, inherited paragraphs after it;
    // membership keeps old sources then appends the new Event.
    stored.sourceEventIds.push('new-c')
    stored.sourceVersions = versions(snapshot.events)
    stored.dependencyVersions = versions(snapshot.events)
    stored.overview = [{ kind: 'change', title: '发布与版本', text: '新 C', sourceEventIds: ['new-c'] }, b, a]
    const after = (await request(runtime)).body
    const sections = after.topics[0].sections
    expect(sections.map(({ title }: { title: string }) => title)).toEqual([a.title, b.title, '发布与版本'])
    expect(sections.slice(0, 2).map(({ key }: { key: string }) => key)).toEqual(before.topics[0].sections.map(({ key }: { key: string }) => key))
    expect(after.revision).not.toBe(before.revision)
    for (const [index, id] of ['old-a', 'old-b', 'new-c'].entries()) {
      const page = await request(runtime, `topic-events&topicId=chapter&sectionKey=${sections[index].key}&expectedRevision=${after.revision}`)
      expect(page.body.items.map(({ id }: { id: string }) => id)).toEqual([id])
    }
  })

  it('keeps pending ordering predictable by creation time and ID', async () => {
    const snapshot = emptySnapshot()
    snapshot.events = [
      { ...event('event-late'), createdAt: '2026-10-04T00:00:00.000Z' },
      event('event-b'), event('event-a'),
    ]
    const result = await request(fakeRuntime(snapshot), 'topic-events&topicId=pending')
    expect(result.body.items.map((item: { id: string }) => item.id)).toEqual(['event-a', 'event-b', 'event-late'])
  })

  it('changes the directory revision when a Bootstrap failure scope disappears without changing Events', async () => {
    const snapshot = emptySnapshot()
    snapshot.events = [event('pending')]
    snapshot.memoryTopicState = freeze(snapshot.events)
    snapshot.memoryTopicState.jobs = [failedJob('failed-job', snapshot.events)]
    const runtime = fakeRuntime(snapshot)
    const first = await request(runtime)
    expect(first.body.bootstrap.failures).toHaveLength(1)
    const visibleBefore = JSON.stringify({ topics: first.body.topics, pending: first.body.pending, events: snapshot.events })
    const page = await request(runtime, `topic-events&topicId=pending&sectionKey=failure:failed-job&expectedRevision=${first.body.revision}`)
    expect(page.status).toBe(200)

    snapshot.memoryTopicState.jobs = []
    const second = await request(runtime, 'dashboard')
    const current = second.body.data.topicDirectory
    expect(current.bootstrap.failures).toEqual([])
    expect(JSON.stringify({ topics: current.topics, pending: current.pending, events: snapshot.events })).toBe(visibleBefore)
    expect(current.revision).not.toBe(first.body.revision)
    const stalePage = await request(runtime, `topic-events&topicId=pending&sectionKey=failure:failed-job&expectedRevision=${first.body.revision}`)
    expect(stalePage.status).toBe(409)
    expect(stalePage.body).toMatchObject({ code: 'directory-changed', revision: current.revision })
    expect(stalePage.body).not.toHaveProperty('items')
    const currentScope = await request(runtime, `topic-events&topicId=pending&sectionKey=failure:failed-job&expectedRevision=${current.revision}`)
    expect(currentScope.status).toBe(404)
    const pendingPage = await request(runtime, `topic-events&topicId=pending&expectedRevision=${current.revision}`)
    expect(pendingPage.body).toMatchObject({ revision: current.revision, total: 1, items: [{ id: 'pending' }] })
  })

  it('pages only the visible fallback sources of an existing terminal Bootstrap failure', async () => {
    const snapshot = emptySnapshot()
    snapshot.events = Array.from({ length: 20 }, (_, index) => event(`event-${index}`))
    snapshot.memoryTopicState = freeze(snapshot.events)
    snapshot.memoryTopicState.projectedVersions = versions(snapshot.events.slice(0, 8))
    snapshot.memoryTopicState.topics = [topic('done', snapshot.events.slice(0, 8))]
    const failed = snapshot.events.slice(8)
    snapshot.memoryTopicState.jobs = [failedJob('failed-job', failed)]
    const runtime = fakeRuntime(snapshot)
    const first = await request(runtime, 'topic-events&topicId=pending&sectionKey=failure:failed-job')
    expect(first.body).toMatchObject({ topicId: 'pending', sectionKey: 'failure:failed-job', total: 12, nextOffset: 9 })
    expect(first.body.items.map((item: { id: string }) => item.id)).toEqual(failed.slice(0, 9).map(({ id }) => id))
    const second = await request(runtime, 'topic-events&topicId=pending&sectionKey=failure:failed-job&offset=9')
    expect(second.body.items.map((item: { id: string }) => item.id)).toEqual(failed.slice(9).map(({ id }) => id))
    expect((await request(runtime, 'topic-events&topicId=pending&sectionKey=failure:unknown')).status).toBe(404)
    snapshot.events[8]!.status = 'forgotten'
    expect((await request(runtime, 'topic-events&topicId=pending&sectionKey=failure:failed-job')).status).toBe(404)
  })

  it('rejects stale directory pages after source or lane changes without writing state', async () => {
    const snapshot = emptySnapshot()
    snapshot.events = [event('conversation')]
    snapshot.agentEvents = [event('agent')]
    let weight = 1
    const runtime = fakeRuntime(snapshot, () => weight)
    const first = await request(runtime)
    const accepted = await request(runtime, `topic-events&topicId=pending&expectedRevision=${first.body.revision}`)
    expect(accepted.body.revision).toBe(first.body.revision)
    weight = 0
    const before = JSON.stringify(snapshot)
    const disabled = await request(runtime, `topic-events&topicId=pending&expectedRevision=${first.body.revision}`)
    expect(disabled.status).toBe(409)
    expect(disabled.body).toMatchObject({ code: 'directory-changed' })
    expect(disabled.body).not.toHaveProperty('items')
    const current = await request(runtime)
    expect(disabled.body.revision).toBe(current.body.revision)
    snapshot.events[0]!.title = '更新后的标题'
    const changed = await request(runtime, `topic-events&topicId=pending&expectedRevision=${current.body.revision}`)
    expect(changed.status).toBe(409)
    snapshot.events[0]!.title = '标题 conversation'
    expect(JSON.stringify(snapshot)).toBe(before)
  })

  it('binds pages to the requested namespace and rejects unknown or unbounded parameters', async () => {
    const snapshot = emptySnapshot()
    snapshot.events = [event('kept')]
    const runtime = fakeRuntime(snapshot)
    for (const parameters of [
      'topicId=pending&eventIds=kept', 'topicId=pending&limit=-1', 'topicId=pending&limit=Infinity',
      'topicId=pending&limit=1.5', 'topicId=pending&offset=-1', 'topicId=pending&offset=1.5',
      'topicId=pending&offset=9007199254740992', 'topicId=pending&limit=9&limit=9',
      'topicId=pending&expectedRevision=old', 'topicId=pending&namespace=other',
    ]) expect((await request(runtime, `topic-events&${parameters}`)).status).toBe(400)
    expect((await request(runtime, 'topic-events')).status).toBe(400)
    expect((await request(runtime, 'topic-events&topicId=unknown')).status).toBe(404)
    expect((await request(runtime, 'topic-events&topicId=fallback:kept')).status).toBe(404)
    expect((await request(runtime, 'topic-events&topicId=pending&sectionKey=uncovered')).status).toBe(404)
    expect((await request(runtime, 'topic-events&topicId=pending&offset=9007199254740991')).body).toMatchObject({ items: [], nextOffset: null })
    expect((await request(runtime, 'topic-events&topicId=pending&limit=0')).body.limit).toBe(1)
    expect((await request(runtime, 'topic-events&topicId=pending', 'POST')).status).toBe(405)
    let body = ''
    const response: WebResponse = { statusCode: 0, setHeader: () => {}, end: (value) => { body = value } }
    await handleAdminRequest(runtime, { method: 'GET', url: '/api/stratagate/topic-events?namespace=dsh%3Aproject%3Aother&topicId=pending' }, response)
    expect(response.statusCode).toBe(404)
    expect(JSON.parse(body)).not.toHaveProperty('items')
  })

  it('removes all cached language when a cited or uncited dependency changes', async () => {
    const snapshot = emptySnapshot()
    const cited = event('visible-source')
    const background = event('uncited-source')
    snapshot.events = [cited, background]
    snapshot.memoryTopicState = freeze(snapshot.events)
    snapshot.memoryTopicState.topics = [topic('topic-sensitive', [cited], snapshot.events)]
    snapshot.memoryTopicState.projectedVersions = versions(snapshot.events)
    background.summary = '更新后的来源内容'
    const before = JSON.stringify(snapshot)
    const result = await request(fakeRuntime(snapshot))
    const serialized = JSON.stringify(result.body)
    expect(serialized).not.toContain('正式主题 topic-sensitive')
    expect(serialized).not.toContain('总览 topic-sensitive')
    expect(result.body.topics).toEqual([])
    expect(result.body.pending).toEqual({ total: 2 })
    expect((await request(fakeRuntime(snapshot), 'topic-events&topicId=topic-sensitive&sectionKey=history:0')).status).toBe(404)
    expect(JSON.stringify(snapshot)).toBe(before)
  })

  it('hides forgotten/archived sources and preserves safe fallback entries', async () => {
    const snapshot = emptySnapshot()
    snapshot.events = [event('kept'), { ...event('forgotten'), status: 'forgotten' }, { ...event('archived'), status: 'archived' }]
    const result = await request(fakeRuntime(snapshot))
    expect(result.body.topics).toEqual([])
    expect(result.body.pending).toEqual({ total: 1 })
    expect(result.body).not.toHaveProperty('events')
    expect((await request(fakeRuntime(snapshot), 'topic-events&topicId=pending')).body.items)
      .toEqual([expect.objectContaining({ id: 'kept' })])
    expect(result.body.bootstrap).toBeNull()
  })

  it('applies the agent lane control to mixed dependencies, fallback, detail and dashboard caching', async () => {
    const snapshot = emptySnapshot()
    const conversation = event('conversation')
    const agent = event('agent-only')
    snapshot.events = [conversation]
    snapshot.agentEvents = [agent]
    snapshot.memoryTopicState = freeze([conversation, agent])
    snapshot.memoryTopicState.topics = [topic('mixed', [conversation], [conversation, agent])]
    snapshot.memoryTopicState.projectedVersions = versions([conversation, agent])
    let weight = 1
    const runtime = fakeRuntime(snapshot, () => weight)
    const first = await request(runtime, 'dashboard')
    const detail = await request(runtime, 'sources&eventId=agent-only')
    expect(detail.status).toBe(200)
    weight = 0
    const second = await request(runtime, 'dashboard', 'GET', { 'if-none-match': first.headers.ETag! })
    expect(second.status).toBe(200)
    expect(second.headers.ETag).not.toBe(first.headers.ETag)
    const directory = second.body.data.topicDirectory
    expect(directory.topics).toEqual([])
    expect(directory.pending).toEqual({ total: 1 })
    expect((await request(runtime, 'topic-events&topicId=pending')).body.items.map((item: { id: string }) => item.id)).toEqual(['conversation'])
    expect((await request(runtime, 'topic-events&topicId=mixed')).status).toBe(404)
    expect(JSON.stringify(directory)).not.toContain('agent-only')
    expect(JSON.stringify(directory)).not.toContain('正式主题 mixed')
    expect((await request(runtime, 'sources&eventId=agent-only')).status).toBe(404)
    weight = 1
    agent.status = 'forgotten'
    expect((await request(runtime, 'sources&eventId=agent-only')).status).toBe(404)
  })

  it.each(['pending', 'running'] as const)('shows %s Bootstrap progress with only successful completions', async (status) => {
    const snapshot = emptySnapshot()
    snapshot.events = [event('complete'), event('pending')]
    snapshot.memoryTopicState = freeze(snapshot.events)
    snapshot.memoryTopicState.bootstrap!.status = status
    snapshot.memoryTopicState.projectedVersions = versions([snapshot.events[0]!])
    const result = await request(fakeRuntime(snapshot), 'dashboard')
    expect(result.body.processing).toBe(true)
    expect(result.body.data.topicDirectory.bootstrap).toMatchObject({ status, total: 2, completed: 1, failedEvents: 0, failures: [] })
  })

  it('keeps terminal failures visible without exposing model inputs or raw error text', async () => {
    const snapshot = emptySnapshot()
    snapshot.events = [event('complete'), event('failed')]
    snapshot.memoryTopicState = freeze(snapshot.events)
    snapshot.memoryTopicState.projectedVersions = versions([snapshot.events[0]!])
    snapshot.memoryTopicState.jobs = [failedJob('failed-job', [snapshot.events[1]!], {
      lastError: 'RAW SECRET MODEL RESPONSE',
      context: { jobId: 'failed-job', events: snapshot.events, existingTopics: [] },
    })]
    const result = await request(fakeRuntime(snapshot))
    expect(result.body.bootstrap).toMatchObject({
      status: 'failed', total: 2, completed: 1, failedEvents: 1,
      failures: [{ jobId: 'failed-job', eventCount: 1, attempts: 3, lastError: 'worker-failed' }],
    })
    expect(JSON.stringify(result.body)).not.toContain('RAW SECRET MODEL RESPONSE')
    expect(result.body.bootstrap.failures[0]).not.toHaveProperty('context')
  })

  it('does not count changed, forgotten, superseded or retryable inputs as historical failures', async () => {
    const snapshot = emptySnapshot()
    snapshot.events = [event('complete'), event('changed'), event('forgotten'), event('retrying')]
    snapshot.memoryTopicState = freeze(snapshot.events)
    snapshot.memoryTopicState.projectedVersions = versions([snapshot.events[0]!])
    snapshot.memoryTopicState.jobs = [
      failedJob('changed-job', [snapshot.events[1]!]),
      failedJob('forgotten-job', [snapshot.events[2]!]),
      failedJob('retrying-job', [snapshot.events[3]!], { attempts: 1, nextRetryAt: '2026-10-04T00:00:00.000Z' }),
      failedJob('superseded-job', [snapshot.events[3]!], { superseded: true }),
    ]
    snapshot.events[1]!.summary = '来源已更新'
    snapshot.events[2]!.status = 'forgotten'
    const result = await request(fakeRuntime(snapshot))
    expect(result.body.bootstrap).toMatchObject({ status: 'pending', total: 2, completed: 1, failedEvents: 0, failures: [] })
  })

  it('reports 74/86 truthfully before recovery, while queued, after success and after exhaustion', async () => {
    const snapshot = emptySnapshot(); snapshot.events = Array.from({ length: 86 }, (_, i) => event(`history-${i}`));
    snapshot.memoryTopicState = freeze(snapshot.events);
    snapshot.memoryTopicState.projectedVersions = versions(snapshot.events.slice(0, 74));
    snapshot.memoryTopicState.jobs = [failedJob('old-failure', snapshot.events.slice(74), { lastError: 'invalid-output' })];
    snapshot.memoryTopicState.bootstrap!.status = 'completed';
    delete snapshot.memoryTopicState.recoveryVersion;
    const original = structuredClone(snapshot.memoryTopicState);
    expect((await request(fakeRuntime(snapshot))).body.bootstrap).toMatchObject({ status: 'failed', total: 86, completed: 74, failedEvents: 12 });
    // Read-only API calls do not recover jobs or consume the recovery marker.
    expect(snapshot.memoryTopicState).toEqual(original);
    const directory = new MemoryTopicDirectory(); directory.restore(snapshot.memoryTopicState);
    directory.initializeBootstrap(snapshot.events, now);
    snapshot.memoryTopicState = directory.snapshot();
    expect((await request(fakeRuntime(snapshot))).body.bootstrap).toMatchObject({ status: 'pending', total: 86, completed: 74, failedEvents: 0, failures: [] });
    const queued = structuredClone(snapshot.memoryTopicState);
    const claim = directory.claim(snapshot.events, now)!;
    snapshot.memoryTopicState = directory.snapshot();
    expect((await request(fakeRuntime(snapshot))).body.bootstrap).toMatchObject({ status: 'running', total: 86, completed: 74 });
    directory.complete(claim.jobId, { topics: [{ title: '历史', description: '历史资料', sourceEventIds: claim.events.map(({ id }) => id), overview: [] }] }, snapshot.events, now);
    snapshot.memoryTopicState = directory.snapshot();
    expect((await request(fakeRuntime(snapshot))).body.bootstrap).toMatchObject({ status: 'completed', total: 86, completed: 86, failedEvents: 0, failures: [] });
    directory.restore(queued);
    let clock = Date.parse(now);
    for (let i = 0; i < 3; i++) {
      const claim = directory.claim(snapshot.events, new Date(clock).toISOString())!;
      directory.fail(claim.jobId, new TopicProjectionError('validation-failed', 'overview.text is empty'), new Date(clock).toISOString());
      clock += 120000;
    }
    snapshot.memoryTopicState = directory.snapshot();
    const failed = (await request(fakeRuntime(snapshot))).body.bootstrap;
    expect(failed).toMatchObject({ status: 'failed', total: 86, completed: 74, failedEvents: 12 });
    expect(failed.failures).toHaveLength(1);
    expect(failed.failures[0]).toMatchObject({ attempts: 3, eventCount: 12, lastError: 'validation-failed: overview.text is empty' });
  });

  it('returns a completed empty Bootstrap without an active-processing signal', async () => {
    const snapshot = emptySnapshot()
    snapshot.memoryTopicState = freeze([])
    const result = await request(fakeRuntime(snapshot), 'dashboard')
    expect(result.body.processing).toBe(false)
    expect(result.body.data.topicDirectory).toMatchObject({
      context: '', topics: [], pending: { total: 0 }, bootstrap: { status: 'completed', total: 0, completed: 0, failedEvents: 0 },
    })
  })

  it('requires a namespace and rejects writes to the new navigation endpoint', async () => {
    const runtime = fakeRuntime(emptySnapshot())
    expect((await request(runtime, 'topics', 'POST')).status).toBe(405)
    let result = ''
    const response: WebResponse = { statusCode: 0, setHeader: () => {}, end: (body) => { result = body } }
    await handleAdminRequest(runtime, { method: 'GET', url: '/api/stratagate/topics' }, response)
    expect(response.statusCode).toBe(400)
    expect(JSON.parse(result).error).toBe('namespace is required')
  })

  it('browses a legacy database without creating Topic state, writing receipts or calling a model', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-directory-readonly-'))
    const database = join(directory, 'memory.db')
    const memory = await StrataGate.open({ database, namespace, blockTurnSize: 1 })
    await memory.appendTurn({ user: '可追溯的原始消息', assistant: '已保存' }, { deferDerivation: true })
    const block = memory.listBlocks()[0]!
    await memory.addEvent({ id: 'legacy-event', title: '旧记忆', summary: '仍可正常查看', sourceBlockId: block.id, sourceMessageIds: [block.l5Raw[0]!.id] })
    await memory.close()
    const legacy = new DatabaseSync(database)
    legacy.exec('DROP TABLE memory_topic_state')
    legacy.close()
    const beforeBytes = await readFile(database)
    const modelCall = vi.fn(() => { throw new Error('Browsing must not call a model') })
    const runtime = new StrataGateRuntime({
      database, namespaceMode: 'project', namespacePrefix: 'dsh', globalNamespace: 'global',
      blockTurnSize: 1, blockDecayLambda: 0.3, ingestSubagents: false, maxOutputTokens: 2048,
    } satisfies ResolvedConfig, {
      onAdaptersUpdated: () => () => {}, isReady: () => false, topicProjector: modelCall,
    } as unknown as DshModelBridge)
    try {
      const before = await runtime.adminSnapshot(namespace)
      for (const path of ['topics', 'dashboard', 'topic-events&topicId=pending', 'sources&eventId=legacy-event']) {
        const result = await request(runtime, path)
        expect(result.status).toBe(200)
        if (path === 'topics') expect(result.body).toMatchObject({
          topics: [], pending: { total: 1 }, bootstrap: null,
        })
      }
      expect(await runtime.adminSnapshot(namespace)).toEqual(before)
      expect(modelCall).not.toHaveBeenCalled()
      const internals = runtime as unknown as { spaces: Map<string, unknown>; batches: Map<string, unknown>; latestBatchIds: Map<string, unknown> }
      expect(internals.spaces.size).toBe(0)
      expect(internals.batches.size).toBe(0)
      expect(internals.latestBatchIds.size).toBe(0)
      expect((await readFile(database)).equals(beforeBytes)).toBe(true)
      const reader = new DatabaseSync(database, { readOnly: true })
      try {
        expect(reader.prepare("SELECT name FROM sqlite_master WHERE name IN ('memory_topic_state', 'stratagate_dsh_workspaces', 'stratagate_dsh_settings', 'stratagate_dsh_feedback_drafts')").all()).toEqual([])
      }
      finally { reader.close() }
    } finally {
      await runtime.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
