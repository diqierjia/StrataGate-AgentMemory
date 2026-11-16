import { describe, expect, it } from 'vitest';
import { findBestVerbatimQuote, StrataGate, type BlockSummarizer, type EventExtractor } from '../src/index.js';

const summarizer: BlockSummarizer = async (messages) => ({
  l0Title: '来源', l0Tags: [], l1Summary: messages[0]?.content ?? '来源', l2Keypoints: [], shouldExtract: true,
});

describe('automatic Event quote backfill', () => {
  it('returns a verbatim, relevant source fragment and leaves unrelated text out', () => {
    const source = [
      { id: 'm1', role: 'user' as const, content: '我决定使用 SQLite 存储。顺便记录一下今天的天气。', createdAt: '2026-01-01T00:00:00Z' },
    ];
    const quote = findBestVerbatimQuote('数据库决定：用户决定使用 SQLite 存储。', source);
    expect(quote).toBe('我决定使用 SQLite 存储。');
    expect(source[0]!.content).toContain(quote!);
  });

  it('fills newly extracted Events when the extractor leaves quotes empty', async () => {
    const extractor: EventExtractor = async ({ target }) => ({
      shouldExtract: true,
      reason: 'durable decision',
      events: [{ title: 'SQLite 决定', summary: '用户决定使用 SQLite 存储。', sourceBlockId: target.id,
        sourceMessageIds: [target.l5Raw[0]!.id] }],
    });
    const memory = StrataGate.inMemory({ blockTurnSize: 1, summarizer, extractor });
    const result = await memory.appendTurn({ user: '我决定使用 SQLite 存储。', assistant: '已记录。' });
    expect(result.extractedEvents[0]).toMatchObject({ quotes: ['我决定使用 SQLite 存储。'], quotesOrigin: 'auto_extracted' });
  });

  it('backfills historical empty Events through the normal mutation path', async () => {
    const memory = StrataGate.inMemory({ blockTurnSize: 1, summarizer: async (messages) => ({ ...await summarizer(messages), shouldExtract: false }) });
    const block = (await memory.appendTurn({ user: '以后发布前先做回归测试。', assistant: '记下了。' })).sealedBlock!;
    const event = await memory.addEvent({ title: '发布前回归测试', summary: '发布前先做回归测试。', sourceBlockId: block.id,
      sourceMessageIds: [block.l5Raw[0]!.id] });
    expect(event.quotes).toEqual([]);
    expect(await memory.backfillMissingEventQuotes()).toMatchObject({ updated: 1, inspected: 1 });
    expect(memory.listEvents()[0]).toMatchObject({ quotes: ['以后发布前先做回归测试。'], quotesOrigin: 'auto_extracted' });
    expect(await memory.backfillMissingEventQuotes()).toEqual({ updated: 0, inspected: 0 });
  });
});
