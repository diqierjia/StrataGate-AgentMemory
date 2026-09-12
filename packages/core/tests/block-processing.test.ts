import { describe, expect, it } from 'vitest';
import { StrataGate, type BlockSummarizer } from '../src/index.js';

const validSummary: BlockSummarizer = async (messages) => ({
  l0Title: messages[0]?.content ?? 'block',
  l0Tags: ['test'],
  l1Summary: messages.map(({ content }) => content).join(' '),
  l2Keypoints: messages.map(({ content }) => content),
  shouldExtract: true,
});

describe('sealed Block processing boundary', () => {
  it('seals three independent pending Blocks from 19 turns and preserves an open tail', async () => {
    const memory = StrataGate.inMemory({
      blockTurnSize: 6,
      summarizer: async () => { throw new Error('model unavailable'); },
    });
    for (let turn = 1; turn <= 19; turn += 1) {
      await memory.appendTurn({
        user: `user ${turn}`,
        assistant: `assistant ${turn}`,
        receiptId: `turn:${turn}`,
      }, { deferDerivation: true });
    }

    expect(memory.listBlocks()).toHaveLength(3);
    expect(memory.listOpenTail().map(({ content }) => content)).toEqual(['user 19', 'assistant 19']);
    expect(memory.exportSnapshot().ingestionReceipts).toHaveLength(19);

    await memory.resumePendingWork();
    for (const block of memory.listBlocks()) {
      expect(block.processingStatus).toBe('pending');
      expect(block).toMatchObject({ l3Condensed: expect.any(String), l4Readable: expect.any(String), l5Raw: expect.any(Array) });
      expect(block).not.toHaveProperty('l0Title');
      expect(block).not.toHaveProperty('l1Summary');
      expect(block).not.toHaveProperty('l2Keypoints');
    }
    expect(memory.getBlockContext()).toEqual([]);
    expect(memory.listSummaryJobs()).toHaveLength(3);
    expect(memory.listSummaryJobs().every(({ status, attempts }) => status === 'failed' && attempts === 1)).toBe(true);
  });

  it('becomes ready only after valid L0-L2 and successful event processing', async () => {
    const memory = StrataGate.inMemory({
      blockTurnSize: 1,
      summarizer: validSummary,
      extractor: async ({ target }) => ({
        shouldExtract: true,
        reason: 'durable event',
        events: [{
          title: 'Stored decision',
          summary: 'A durable decision was stored.',
          sourceBlockId: target.id,
          sourceMessageIds: [target.l5Raw[0]!.id],
        }],
      }),
    });

    const result = await memory.appendTurn({ user: 'Use SQLite.', assistant: 'Recorded.' });
    expect(result.readyBlocks).toHaveLength(1);
    expect(result.extractedEvents).toHaveLength(1);
    expect(result.sealedBlock).toMatchObject({ processingStatus: 'ready', l0Title: 'Use SQLite.' });
    expect(memory.listExtractionJobs()[0]).toMatchObject({ status: 'succeeded' });
    expect(memory.getBlockContext()).toHaveLength(1);
  });

  it('treats a valid empty extraction result as completed', async () => {
    const memory = StrataGate.inMemory({
      blockTurnSize: 1,
      summarizer: validSummary,
      extractor: async () => ({ shouldExtract: false, reason: 'No durable events.', events: [] }),
    });

    await memory.appendTurn({ user: 'Thanks.', assistant: 'You are welcome.' });
    expect(memory.listBlocks()[0]?.processingStatus).toBe('ready');
    expect(memory.listExtractionJobs()[0]).toMatchObject({ status: 'skipped', lastError: null });
    expect(memory.listEvents()).toEqual([]);
  });

  it('caps failed retries without losing turns or blocking later sealing', async () => {
    let attempts = 0;
    const memory = StrataGate.inMemory({
      blockTurnSize: 1,
      summarizer: async () => {
        attempts += 1;
        throw new Error('invalid structured output');
      },
    });

    await memory.appendTurn({ user: 'one', assistant: 'saved', receiptId: 'turn:1' });
    await memory.resumePendingWork({ retryFailed: true });
    await memory.resumePendingWork({ retryFailed: true });
    await memory.resumePendingWork({ retryFailed: true });
    expect(attempts).toBe(3);
    expect(memory.listSummaryJobs()[0]).toMatchObject({ status: 'failed', attempts: 3, nextRetryAt: null });

    await memory.appendTurn({ user: 'two', assistant: 'also saved', receiptId: 'turn:2' }, { deferDerivation: true });
    expect(memory.listBlocks()).toHaveLength(2);
    expect(memory.listBlocks().flatMap(({ l5Raw }) => l5Raw.map(({ content }) => content)))
      .toEqual(['one', 'saved', 'two', 'also saved']);
    expect(memory.exportSnapshot().ingestionReceipts.map(({ id }) => id)).toEqual(['turn:1', 'turn:2']);
  });

  it('allows an explicit retry of one terminally failed Block Summary', async () => {
    let shouldFail = true;
    let calls = 0;
    const memory = StrataGate.inMemory({
      blockTurnSize: 1,
      summarizer: async (messages) => {
        calls += 1;
        if (shouldFail) throw new Error('invalid API key');
        return validSummary(messages);
      },
      extractor: async () => ({ shouldExtract: false, reason: 'none', events: [] }),
    });

    await memory.appendTurn({ user: 'retry me', assistant: 'saved', receiptId: 'turn:retry' });
    await memory.resumePendingWork({ retryFailed: true });
    await memory.resumePendingWork({ retryFailed: true });
    expect(memory.listSummaryJobs()[0]).toMatchObject({ status: 'failed', attempts: 3, nextRetryAt: null });

    shouldFail = false;
    const blockId = memory.listBlocks()[0]!.id;
    const result = await memory.retryBlockSummary(blockId);
    expect(calls).toBe(4);
    expect(result.readyBlocks).toMatchObject([{ id: blockId, processingStatus: 'ready' }]);
    expect(memory.listSummaryJobs()[0]).toMatchObject({ status: 'succeeded', attempts: 1, lastError: null });
    expect(memory.listExtractionJobs()[0]).toMatchObject({ status: 'skipped' });
  });

  it('retries only one failed Event extraction and coalesces concurrent requests', async () => {
    let extractionCalls = 0;
    let summaryCalls = 0;
    let shouldFail = true;
    const memory = StrataGate.inMemory({
      blockTurnSize: 1,
      summarizer: async (messages) => {
        summaryCalls += 1;
        return validSummary(messages);
      },
      extractor: async () => {
        extractionCalls += 1;
        if (shouldFail) throw new Error('structured model task timed out');
        return { shouldExtract: false, reason: 'nothing durable', events: [] };
      },
    });

    await memory.appendTurn({ user: 'extract me', assistant: 'saved' });
    await memory.resumePendingWork({ retryFailed: true });
    await memory.resumePendingWork({ retryFailed: true });
    const blockId = memory.listBlocks()[0]!.id;
    expect(memory.listExtractionJobs()[0]).toMatchObject({ status: 'failed', attempts: 3, nextRetryAt: null });

    await expect(memory.retryEventExtraction(blockId)).rejects.toThrow('structured model task timed out');
    expect(memory.listExtractionJobs()[0]).toMatchObject({
      status: 'failed', attempts: 1, lastError: 'structured model task timed out',
    });

    shouldFail = false;
    const [first, second] = await Promise.all([
      memory.retryEventExtraction(blockId),
      memory.retryEventExtraction(blockId),
    ]);
    expect(first).toEqual([]);
    expect(second).toEqual([]);
    expect(summaryCalls).toBe(1);
    expect(extractionCalls).toBe(5);
    expect(memory.listBlocks()[0]).toMatchObject({ id: blockId, processingStatus: 'ready' });
    expect(memory.listExtractionJobs()[0]).toMatchObject({ status: 'skipped', attempts: 1, lastError: null });
  });
});
