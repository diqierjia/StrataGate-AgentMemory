import { describe, expect, it } from 'vitest';
import { StrataGate, type BlockSummarizer, type EventExtractor, type EventTemporal, type ExtractionContext } from '../src/index.js';

const summarizer: BlockSummarizer = async (messages) => {
  const content = messages[0]?.content ?? '';
  return {
    l0Title: content,
    l0Tags: [],
    l1Summary: content,
    l2Keypoints: [content],
    shouldExtract: content.startsWith('TARGET'),
  };
};

function fixture(extractor?: EventExtractor) {
  let tick = 0;
  let timeline: ExtractionContext['timeline'] = [];
  const memory = StrataGate.inMemory({
    blockTurnSize: 1,
    summarizer,
    now: () => new Date(Date.UTC(2026, 0, 1, 0, tick++, 0)),
    extractor: async (context) => {
      timeline = context.timeline;
      if (extractor) return extractor(context);
      return { shouldExtract: false, reason: 'timeline inspection', events: [] };
    },
  });
  return { memory, timeline: () => timeline };
}

describe('Event extraction timeline', () => {
  it.each(['recent-3', 'outside'])('bounds all relationship IDs and validates sameEventId=%s', async (sameEventId) => {
    const relationships = ['recent-3', 'outside', 'missing', 'extracted', 'recent-3'];
    const { memory, timeline } = fixture(async ({ target }) => ({
      shouldExtract: true, reason: 'New target-supported fact.', events: [{
        id: 'extracted', title: 'A new decision', summary: 'A new target-supported decision.',
        sourceBlockId: target.id, sourceMessageIds: [target.l5Raw[0]!.id],
        temporal: {
          sameEventId,
          beforeEventIds: relationships, afterEventIds: relationships,
          supersedesEventIds: relationships, conflictsWithEventIds: relationships,
          relatedEventIds: relationships,
          happenedStart: '2026-01-01', participants: ['Orchard'], eventType: 'decision',
        },
      }],
    }));
    const source = (await memory.appendTurn({ user: 'source', assistant: 'recorded' })).sealedBlock!;
    const outside = await memory.addEvent({ id: 'outside', title: 'Older unrelated memory', summary: 'Unrelated history.',
      sourceBlockId: source.id, sourceMessageIds: [source.l5Raw[0]!.id] });
    for (let index = 0; index < 4; index += 1) {
      await memory.addEvent({ id: `recent-${index}`, title: `Recent memory ${index}`, summary: 'Recent history.',
        sourceBlockId: source.id, sourceMessageIds: [source.l5Raw[0]!.id] });
    }
    const before = structuredClone(outside);
    await memory.appendTurn({ user: 'TARGET zephyr', assistant: 'confirmed' });
    expect(timeline().map(({ id }) => id)).toEqual(['recent-3', 'recent-2', 'recent-1', 'recent-0']);
    const extracted = memory.listEvents().find(({ id }) => id === 'extracted')!;
    expect(extracted.temporal).toMatchObject({
      beforeEventIds: ['recent-3'], afterEventIds: ['recent-3'], supersedesEventIds: ['recent-3'],
      conflictsWithEventIds: ['recent-3'], relatedEventIds: ['recent-3'],
      happenedStart: '2026-01-01', participants: ['Orchard'], eventType: 'decision',
    });
    if (sameEventId === 'recent-3') expect(extracted.temporal.sameEventId).toBe('recent-3');
    else expect(extracted.temporal).not.toHaveProperty('sameEventId');
    expect(outside).toEqual(before);
    expect(memory.listEvents().find(({ id }) => id === 'recent-3')).toMatchObject({
      status: 'superseded', supersededBy: 'extracted', weight: { forcedCap: 0.1 },
    });
  });

  it('does not let an extractor mutate its timeline to widen relationship permissions or alter history', async () => {
    const { memory } = fixture(async ({ target, timeline }) => {
      timeline[0]!.id = 'outside';
      timeline[0]!.temporal.participants!.push('Injected participant');
      return { shouldExtract: true, reason: 'New fact.', events: [{
        title: 'New fact', summary: 'Uses target evidence.', sourceBlockId: target.id,
        sourceMessageIds: [target.l5Raw[0]!.id],
        temporal: {
          sameEventId: 'outside', supersedesEventIds: ['outside'], conflictsWithEventIds: ['outside'],
          beforeEventIds: 'outside', afterEventIds: [null, 123], relatedEventIds: ['missing'],
        } as unknown as EventTemporal,
      }] };
    });
    const source = (await memory.appendTurn({ user: 'source', assistant: 'recorded' })).sealedBlock!;
    for (let index = 0; index < 5; index += 1) {
      await memory.addEvent({ id: index === 0 ? 'outside' : `recent-${index}`, title: `Stored memory ${index}`,
        summary: 'Different subject.', sourceBlockId: source.id, sourceMessageIds: [source.l5Raw[0]!.id],
        temporal: { participants: ['Original participant'] } });
    }
    const history = structuredClone(memory.listEvents());
    await memory.appendTurn({ user: 'TARGET zephyr', assistant: 'confirmed' });
    expect(memory.listEvents().slice(0, 5)).toEqual(history);
    expect(memory.listEvents().at(-1)!.temporal).toEqual({ eventType: 'other' });
  });

  it('does not revive a timeline Event forgotten while the extractor is running', async () => {
    const { memory } = fixture(async ({ target, timeline }) => {
      expect(timeline.map(({ id }) => id)).toContain('old');
      await memory.forgetEvent('old');
      return { shouldExtract: true, reason: 'New fact.', events: [{
        title: 'New decision', summary: 'Uses target evidence.', sourceBlockId: target.id,
        sourceMessageIds: [target.l5Raw[0]!.id],
        temporal: { sameEventId: 'old', supersedesEventIds: ['old'], conflictsWithEventIds: ['old'] },
      }] };
    });
    const source = (await memory.appendTurn({ user: 'source', assistant: 'recorded' })).sealedBlock!;
    const old = await memory.addEvent({ id: 'old', title: 'Historic decision', summary: 'Historic decision.',
      sourceBlockId: source.id, sourceMessageIds: [source.l5Raw[0]!.id] });
    await memory.appendTurn({ user: 'TARGET zephyr', assistant: 'confirmed' });
    expect(old.status).toBe('forgotten');
    expect(old.supersededBy).toBeNull();
    expect(old.weight.forcedCap).not.toBe(0.1);
    expect(memory.listEvents().at(-1)!.temporal).toEqual({ eventType: 'other' });
  });

  it('keeps eight relevant Events and four recent Events when the database grows', async () => {
    const { memory, timeline } = fixture();
    const source = (await memory.appendTurn({ user: 'source', assistant: 'recorded' })).sealedBlock!;
    for (let index = 0; index < 8; index += 1) {
      await memory.addEvent({ id: `relevant-${index}`, title: `opal orchard migration ${index}`,
        summary: 'Historic project decision.', sourceBlockId: source.id, sourceMessageIds: [source.l5Raw[0]!.id] });
    }
    for (let index = 0; index < 36; index += 1) {
      await memory.addEvent({ id: `filler-${index}`, title: `unrelated topic ${index}`,
        summary: 'A different subject.', sourceBlockId: source.id, sourceMessageIds: [source.l5Raw[0]!.id] });
    }
    await memory.appendTurn({ user: 'TARGET opal orchard migration', assistant: 'review' });
    expect(memory.listEvents()).toHaveLength(44);
    expect(timeline().map(({ id }) => id)).toEqual([
      ...Array.from({ length: 8 }, (_, index) => `relevant-${index}`),
      'filler-35', 'filler-34', 'filler-33', 'filler-32',
    ]);
    expect(timeline()).toHaveLength(12);
    expect(timeline()[0]).toEqual(expect.objectContaining({ id: 'relevant-0' }));
    expect(Object.keys(timeline()[0]!)).toEqual(['id', 'title', 'temporal']);
    for (let index = 36; index < 76; index += 1) {
      await memory.addEvent({ id: `filler-${index}`, title: `unrelated topic ${index}`,
        summary: 'A different subject.', sourceBlockId: source.id, sourceMessageIds: [source.l5Raw[0]!.id] });
    }
    await memory.appendTurn({ user: 'TARGET opal orchard migration', assistant: 'review again' });
    expect(memory.listEvents()).toHaveLength(84);
    expect(timeline().map(({ id }) => id)).toEqual([
      ...Array.from({ length: 8 }, (_, index) => `relevant-${index}`),
      'filler-75', 'filler-74', 'filler-73', 'filler-72',
    ]);
    expect(timeline()).toHaveLength(12);
  });

  it('deduplicates overlap without backfilling and excludes forgotten and archived Events', async () => {
    const { memory, timeline } = fixture();
    const source = (await memory.appendTurn({ user: 'source', assistant: 'recorded' })).sealedBlock!;
    for (let index = 0; index < 12; index += 1) {
      await memory.addEvent({ id: `filler-${index}`, title: `unrelated topic ${index}`,
        summary: 'A different subject.', sourceBlockId: source.id, sourceMessageIds: [source.l5Raw[0]!.id] });
    }
    for (let index = 0; index < 8; index += 1) {
      await memory.addEvent({ id: `relevant-${index}`, title: `opal orchard migration ${index}`,
        summary: 'Historic project decision.', sourceBlockId: source.id, sourceMessageIds: [source.l5Raw[0]!.id] });
    }
    const forgotten = await memory.addEvent({ id: 'forgotten', title: 'opal orchard migration forgotten',
      summary: 'Excluded memory.', sourceBlockId: source.id, sourceMessageIds: [source.l5Raw[0]!.id] });
    await memory.forgetEvent(forgotten.id);
    const archived = await memory.addEvent({ id: 'archived', title: 'opal orchard migration archived',
      summary: 'Excluded memory.', sourceBlockId: source.id, sourceMessageIds: [source.l5Raw[0]!.id] });
    archived.status = 'archived';
    await memory.appendTurn({ user: 'TARGET opal orchard migration', assistant: 'review' });
    expect(timeline().map(({ id }) => id)).toEqual(Array.from({ length: 8 }, (_, index) => `relevant-${index}`));
    expect(new Set(timeline().map(({ id }) => id)).size).toBe(timeline().length);
  });

  it('includes superseded history and does no retrieval bookkeeping', async () => {
    const { memory, timeline } = fixture();
    const source = (await memory.appendTurn({ user: 'source', assistant: 'recorded' })).sealedBlock!;
    const add = (id: string, title: string, supersedesEventIds?: string[]) => memory.addEvent({
      id, title, summary: 'Stored Event.', sourceBlockId: source.id,
      sourceMessageIds: [source.l5Raw[0]!.id],
      ...(supersedesEventIds ? { temporal: { supersedesEventIds } } : {}),
    });
    await add('old-relevant', 'opal orchard migration');
    const superseded = await add('superseded', 'opal orchard migration archive');
    await add('old-touched', 'completely different subject');
    await add('replacement', 'another subject', [superseded.id]);
    for (let index = 0; index < 16; index += 1) await add(`filler-${index}`, `unrelated ${index}`);
    for (let index = 0; index < 4; index += 1) await add(`recent-${index}`, `fresh unrelated ${index}`);
    await memory.pinEvent('old-touched'); // Changes updatedAt, not formation time.
    const before = memory.listEvents().map(({ id, weight }) => [id, structuredClone(weight)]);
    await memory.appendTurn({ user: 'TARGET opal orchard migration', assistant: 'review' });
    expect(timeline().map(({ id }) => id)).toEqual([
      'old-relevant', 'superseded', 'recent-3', 'recent-2', 'recent-1', 'recent-0',
    ]);
    expect(timeline().map(({ id }) => id)).not.toContain('old-touched');
    expect(memory.listEvents().map(({ id, weight }) => [id, weight])).toEqual(before);
  });

  it('does not treat an old Block extracted later as a recent Event', async () => {
    const { memory, timeline } = fixture();
    const blocks = [];
    for (let index = 0; index < 6; index += 1) {
      blocks.push((await memory.appendTurn({ user: `source ${index}`, assistant: 'recorded' })).sealedBlock!);
    }
    const newer = [];
    for (let index = 1; index < blocks.length; index += 1) {
      const source = blocks[index]!;
      newer.push(await memory.addEvent({ id: `new-${index}`, title: `recent memory ${index}`,
        summary: 'A newer conversation.', sourceBlockId: source.id, sourceMessageIds: [source.l5Raw[0]!.id] }));
    }
    const oldSource = blocks[0]!;
    const delayed = await memory.addEvent({ id: 'delayed-old', title: 'historical memory',
      summary: 'An old conversation processed later.', sourceBlockId: oldSource.id,
      sourceMessageIds: [oldSource.l5Raw[0]!.id], temporal: { happenedStart: '2099-01-01' } });
    expect(delayed.createdAt > newer.at(-1)!.createdAt).toBe(true);
    expect(delayed.formedTurn! < newer[0]!.formedTurn!).toBe(true);
    await memory.appendTurn({ user: 'TARGET zephyr query', assistant: 'review' });
    expect(timeline().map(({ id }) => id)).toEqual(['new-5', 'new-4', 'new-3', 'new-2']);
  });

  it('uses namespace Block order when formedTurn is local to different threads', async () => {
    const { memory, timeline } = fixture();
    const earlier = [];
    for (let index = 1; index <= 5; index += 1) {
      earlier.push((await memory.appendTurn({ user: `source A ${index}`, assistant: 'recorded',
        threadId: 'A' })).sealedBlock!);
    }
    const later = (await memory.appendTurn({ user: 'source B', assistant: 'recorded',
      threadId: 'B' })).sealedBlock!;
    for (let index = 1; index <= earlier.length; index += 1) {
      const source = earlier[index - 1]!;
      await memory.addEvent({ id: `A-${index}`, title: `memory A ${index}`,
        summary: 'Different subject.', sourceBlockId: source.id, sourceMessageIds: [source.l5Raw[0]!.id] });
    }
    const latest = await memory.addEvent({ id: 'B-1', title: 'memory B',
      summary: 'Different subject.', sourceBlockId: later.id, sourceMessageIds: [later.l5Raw[0]!.id] });
    expect(latest.formedTurn).toBe(1);
    expect(memory.listEvents().find(({ id }) => id === 'A-5')?.formedTurn).toBe(5);
    expect(later.sequence).toBeGreaterThan(earlier.at(-1)!.sequence);
    await memory.appendTurn({ user: 'TARGET zephyr query', assistant: 'review', threadId: 'B' });
    expect(timeline().map(({ id }) => id)).toEqual(['B-1', 'A-5', 'A-4', 'A-3']);
  });

  it('still validates extractor evidence against the target L5 messages', async () => {
    const sourceIds: string[] = [];
    const memory = StrataGate.inMemory({
      blockTurnSize: 1,
      summarizer,
      extractor: async ({ target }) => ({ shouldExtract: true, reason: 'durable event', events: [{
        title: 'Validated Event', summary: 'Uses target evidence.', sourceBlockId: target.id,
        sourceMessageIds: sourceIds,
      }] }),
    });
    const source = (await memory.appendTurn({ user: 'source', assistant: 'recorded' })).sealedBlock!;
    sourceIds.push(source.l5Raw[0]!.id);
    const target = (await memory.appendTurn({ user: 'TARGET evidence', assistant: 'confirmed' })).sealedBlock!;
    expect(memory.listEvents()[0]?.sourceMessageIds).toEqual(target.l5Raw.map(({ id }) => id));
    expect(target.l5Raw.map(({ content }) => content)).toEqual(['TARGET evidence', 'confirmed']);
  });
});
