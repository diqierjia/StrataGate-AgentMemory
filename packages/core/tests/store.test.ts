import { describe, expect, it } from 'vitest';
import { StrataGate, memoryWeightAt, type BlockSummarizer, type EventExtractor } from '../src/index.js';
import { toUtc8Iso } from '../src/time.js';

function ids(): (prefix: 'msg' | 'blk' | 'evt') => string {
  let value = 0;
  return (prefix) => `${prefix}_${++value}`;
}

const summarizer: BlockSummarizer = async (messages) => ({
  l0Title: messages[0]?.content.slice(0, 40) ?? 'block',
  l0Tags: ['test'],
  l1Summary: messages.map((message) => message.content).join(' '),
  l2Keypoints: messages.map((message) => message.content),
  shouldExtract: true,
});

const nonExtractingSummarizer: BlockSummarizer = async (messages) => ({
  ...(await summarizer(messages)),
  shouldExtract: false,
});

const extractor: EventExtractor = async ({ target }) => ({
  shouldExtract: true,
  reason: 'stable preference',
  events: [{
    title: 'Prefers concise answers',
    summary: 'The user asked for concise answers.',
    tags: ['preference', 'writing'],
    quotes: ['Please keep answers concise.'],
    sourceMessageIds: [target.l5Raw[0]?.id ?? 'missing'],
    sourceBlockId: target.id,
    criticality: 'preference',
    temporal: { happenedStart: '2026-01-01', participants: ['user'], eventType: 'preference' },
  }],
});

describe('StrataGate lifecycle', () => {
  it('searches Event title, summary, tags, quotes, and structured temporal fields', async () => {
    const memory = StrataGate.inMemory({ blockTurnSize: 1, summarizer: nonExtractingSummarizer, idFactory: ids() });
    const result = await memory.appendTurn({ user: 'Atlas selected SQLite in dragonfruit mode.', assistant: 'Recorded.' });
    const event = await memory.addEvent({
      title: 'Atlas database selected', summary: 'Atlas selected SQLite for storage.',
      tags: ['release-42'], quotes: ['Atlas selected SQLite in dragonfruit mode.'],
      sourceBlockId: result.sealedBlock!.id, sourceMessageIds: [result.sealedBlock!.l5Raw[0]!.id],
      temporal: { eventType: 'decision', participants: ['Atlas'], happenedStart: '2026-08-12T08:00:00+08:00' },
    });
    for (const query of ['database', 'SQLite', 'release-42', 'dragonfruit']) {
      expect((await memory.searchEvents(query)).some(({ event: hit }) => hit.id === event.id)).toBe(true);
    }
    expect((await memory.searchEvents('', { participants: ['Atlas'] })).some(({ event: hit }) => hit.id === event.id)).toBe(true);
    expect((await memory.searchEvents('', { eventType: 'decision' })).some(({ event: hit }) => hit.id === event.id)).toBe(true);
  });
  it('writes canonical timestamps with the UTC+8 offset', () => {
    expect(toUtc8Iso('2026-08-20T00:00:00.000Z')).toBe('2026-08-20T08:00:00.000+08:00');
  });

  it('rejects implicit construction so ephemeral storage stays explicit', () => {
    const UnsafeConstructor = StrataGate as unknown as new () => StrataGate;
    expect(() => new UnsafeConstructor()).toThrow('Use StrataGate.open() for SQLite');
  });

  it('seals blocks, completes extraction, searches, and records adoption separately', async () => {
    const memory = StrataGate.inMemory({ blockTurnSize: 1, summarizer, extractor, idFactory: ids() });
    const first = await memory.appendTurn({ user: 'Please keep answers concise.', assistant: 'Understood.' });
    expect(first.sealedBlock).not.toBeNull();
    expect(first.extractedEvents).toHaveLength(1);

    const second = await memory.appendTurn({ user: 'What did I ask?', assistant: 'Let me check.' });
    expect(second.extractedEvents).toHaveLength(1);
    const result = await memory.searchEvents('concise writing preference');
    expect(result[0]?.event.title).toBe('Prefers concise answers');

    const event = result[0]?.event;
    expect(event).toBeDefined();
    if (!event) return;
    const before = event.weight.mentionCount;
    await memory.searchEvents('concise');
    expect(event.weight.mentionCount).toBe(before);
    await memory.recordMemoryUse([event.id]);
    expect(event.weight.mentionCount).toBe(before + 1);
    expect(memoryWeightAt(event, memory.turn)).toBe(1);
  });

  it('ranks exhaustive raw fallback instead of returning the first weak matches', async () => {
    const memory = StrataGate.inMemory({ blockTurnSize: 1, summarizer: nonExtractingSummarizer, idFactory: ids() });
    for (let index = 0; index < 1_000; index += 1) {
      await memory.appendTurn({ user: `StrataGate archive note ${index}`, assistant: 'acknowledged' });
    }
    await memory.appendTurn({ user: 'StrataGate target migration decision', assistant: 'The target is the PostgreSQL migration.' });
    const hits = memory.searchRawMemory('StrataGate target migration', 6);
    expect(hits.some(({ message }) => message.content.includes('target migration decision'))).toBe(true);
  }, 30_000);

  it('preserves Chinese tokens and applies thread scope before ranking', async () => {
    const memory = StrataGate.inMemory({ blockTurnSize: 1, summarizer: nonExtractingSummarizer, idFactory: ids() });
    await memory.appendTurn({ user: '星河项目由李明负责', assistant: '其他会话高相关结果', threadId: 'other' });
    await memory.appendTurn({ user: '星河项目由王芳负责', assistant: '当前会话证据', threadId: 'current' });
    expect(memory.searchRawMemory('李明', 3).some(({ message }) => message.content.includes('李明'))).toBe(true);
    const scoped = memory.searchRawMemory('星河项目', 3, { threadId: 'current' });
    expect(scoped).toHaveLength(1);
    expect(scoped.every(({ message }) => message.threadId === 'current')).toBe(true);
  });

  it('keeps forgotten events out of search without deleting their provenance', async () => {
    const memory = StrataGate.inMemory({ blockTurnSize: 1, summarizer, extractor, idFactory: ids() });
    await memory.appendTurn({ user: 'Please keep answers concise.', assistant: 'Understood.' });
    await memory.appendTurn({ user: 'What did I ask?', assistant: 'Let me check.' });
    const event = memory.listEvents()[0];
    expect(event).toBeDefined();
    if (!event) return;
    for (const candidate of memory.listEvents()) await memory.forgetEvent(candidate.id);
    expect(await memory.searchEvents('concise')).toHaveLength(0);
    expect(memory.listEvents()[0]?.sourceMessageIds.length).toBeGreaterThan(0);
  });

  it('fails extraction when the model requests events but returns none', async () => {
    const extractorWithNoEvents: EventExtractor = async () => ({
      shouldExtract: true,
      reason: 'All source ids belonged to the neighboring block.',
      events: [],
    });
    const memory = StrataGate.inMemory({ blockTurnSize: 1, summarizer, extractor: extractorWithNoEvents, idFactory: ids() });
    await memory.appendTurn({ user: 'Target evidence', assistant: 'Recorded.' });
    expect(memory.listEvents()).toHaveLength(0);
    expect(memory.listExtractionJobs()).toMatchObject([{
      status: 'failed',
      lastError: expect.stringContaining('All source ids belonged'),
    }]);
  });

  it('treats skipped extraction jobs as completed even when retry is requested', async () => {
    let attempts = 0;
    const retryableExtractor: EventExtractor = async ({ target }) => {
      attempts += 1;
      if (attempts === 1) return { shouldExtract: false, reason: 'No event yet.', events: [] };
      return {
        shouldExtract: true,
        reason: 'Event became available after retry.',
        events: [{
          title: 'Recovered event',
          summary: 'Recovered after a bounded retry.',
          sourceMessageIds: [target.l5Raw[0]?.id ?? 'missing'],
          sourceBlockId: target.id,
        }],
      };
    };
    const memory = StrataGate.inMemory({ blockTurnSize: 1, summarizer, extractor: retryableExtractor, idFactory: ids() });
    await memory.appendTurn({ user: 'First block', assistant: 'Recorded.' });
    await memory.appendTurn({ user: 'Second block', assistant: 'Continuing.' });
    expect(memory.listExtractionJobs()[0]?.status).toBe('skipped');
    const resumed = await memory.resumePendingWork({ retrySkipped: true });
    expect(resumed.extractedEvents).toHaveLength(0);
    expect(memory.listExtractionJobs()[0]?.status).toBe('skipped');
    expect(attempts).toBe(2);
  });

  it('keeps open tails, blocks, and extraction neighbors isolated by thread', async () => {
    const extractionPairs: string[][] = [];
    const memory = StrataGate.inMemory({
      blockTurnSize: 2,
      summarizer,
      extractor: async ({ target, next }) => {
        extractionPairs.push([target.threadId ?? '', next?.threadId ?? '']);
        return { shouldExtract: false, reason: 'test only', events: [] };
      },
      idFactory: ids(),
    });

    await memory.appendTurn({ user: 'A1', assistant: 'A1 reply', threadId: 'session-a' });
    await memory.appendTurn({ user: 'B1', assistant: 'B1 reply', threadId: 'session-b' });
    await memory.appendTurn({ user: 'A2', assistant: 'A2 reply', threadId: 'session-a' });

    expect(memory.listOpenTail('session-a')).toHaveLength(0);
    expect(memory.listOpenTail('session-b').map(({ content }) => content)).toEqual(['B1', 'B1 reply']);
    expect(memory.listBlocks()[0]).toMatchObject({
      threadId: 'session-a',
      startTurn: 1,
      endTurn: 2,
    });
    expect(memory.listBlocks()[0]?.l5Raw.map(({ content }) => content)).toEqual(['A1', 'A1 reply', 'A2', 'A2 reply']);

    await memory.appendTurn({ user: 'B2', assistant: 'B2 reply', threadId: 'session-b' });
    await memory.appendTurn({ user: 'A3', assistant: 'A3 reply', threadId: 'session-a' });
    await memory.appendTurn({ user: 'A4', assistant: 'A4 reply', threadId: 'session-a' });

    expect(memory.getBlockContext('session-a')).toHaveLength(2);
    expect(memory.getBlockContext('session-b')).toHaveLength(1);
    expect(extractionPairs).toContainEqual(['session-a', '']);
    expect(extractionPairs).not.toContainEqual(['session-a', 'session-b']);
    expect(extractionPairs).not.toContainEqual(['session-b', 'session-a']);
  });

  it('ages blocks only when a newer block is sealed in the same thread', async () => {
    const memory = StrataGate.inMemory({
      blockTurnSize: 2,
      blockDecayLambda: 0.3,
      summarizer: nonExtractingSummarizer,
      idFactory: ids(),
    });

    await memory.appendTurn({ user: 'A1', assistant: 'A1 reply', threadId: 'session-a' });
    await memory.appendTurn({ user: 'A2', assistant: 'A2 reply', threadId: 'session-a' });
    expect(memory.getBlockContext('session-a')).toMatchObject([{ age: 0, level: 5 }]);

    await memory.appendTurn({ user: 'A3', assistant: 'A3 reply', threadId: 'session-a' });
    await memory.appendTurn({ user: 'B1', assistant: 'B1 reply', threadId: 'session-b' });
    await memory.appendTurn({ user: 'B2', assistant: 'B2 reply', threadId: 'session-b' });
    expect(memory.getBlockContext('session-a')).toMatchObject([{ age: 0, level: 5 }]);

    await memory.appendTurn({ user: 'A4', assistant: 'A4 reply', threadId: 'session-a' });
    expect(memory.getBlockContext('session-a')).toMatchObject([
      { age: 1, level: 5 },
      { age: 0, level: 5 },
    ]);

    await memory.appendTurn({ user: 'A5', assistant: 'A5 reply', threadId: 'session-a' });
    await memory.appendTurn({ user: 'A6', assistant: 'A6 reply', threadId: 'session-a' });
    expect(memory.getBlockContext('session-a')).toMatchObject([
      { age: 2, level: 4 },
      { age: 1, level: 5 },
      { age: 0, level: 5 },
    ]);
  });

  it('records whether a Block lift came from an Agent or the user', async () => {
    const memory = StrataGate.inMemory({ blockTurnSize: 1, summarizer: nonExtractingSummarizer, idFactory: ids() });
    const first = await memory.appendTurn({ user: 'First', assistant: 'Stored' });
    await memory.expandBlock(first.sealedBlock!.id, 4);
    expect(memory.listBlocks()[0]?.lastLiftedBy).toBe('agent');
    await memory.expandBlock(first.sealedBlock!.id, 5, 'user');
    expect(memory.listBlocks()[0]?.lastLiftedBy).toBe('user');
  });
});
