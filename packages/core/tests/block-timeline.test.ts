import { describe, expect, it } from 'vitest';
import {
  StrataGate, buildBlockTimeline, getDecayedBlockLevel, normalizeSnapshot,
  type BlockSummarizer,
} from '../src/index.js';

const summary: BlockSummarizer = async (messages) => ({
  l0Title: messages[0]!.content, l0Tags: [], l1Summary: 'summary', l2Keypoints: [], shouldExtract: false,
});

async function fixture(pending: number[], count = 8) {
  const failures = new Set(pending.map(String));
  const memory = StrataGate.inMemory({ blockTurnSize: 1, summarizer: async (messages) => {
    if (failures.has(messages[0]!.content)) throw new Error('synthetic summary failure');
    return summary(messages);
  } });
  for (let index = 1; index <= count; index++) {
    await memory.appendTurn({ user: String(index), assistant: 'saved', threadId: 'a' });
  }
  return { memory, failures };
}

describe('sealed block timeline', () => {
  it.each([{ pending: [1] }, { pending: [3] }, { pending: [8] }, { pending: [1, 3, 8] }])('keeps ready ages and layers fixed when $pending recovers', async ({ pending }) => {
    const { memory, failures } = await fixture(pending);
    try {
      const before = memory.getBlockContext('a');
      const blocks = memory.listBlocks();
      for (const view of before) {
        const position = Number(blocks.find((block) => block.id === view.id)!.l5Raw[0]!.content);
        expect(view.age).toBe(8 - position);
        expect(view.level).toBe(getDecayedBlockLevel(5, position, 8));
      }
      failures.clear();
      // Recover newest first, deliberately unlike sealed order.
      for (const index of [...pending].reverse()) await memory.retryBlockSummary(blocks[index - 1]!.id);
      const after = memory.getBlockContext('a');
      for (const view of before) expect(after.find(({ id }) => id === view.id)).toEqual(view);
      expect(after).toHaveLength(8);
      expect(after.map(({ age }) => age)).toEqual([7, 6, 5, 4, 3, 2, 1, 0]);
      expect(memory.turn).toBe(8);
      expect(memory.listBlocks().map(({ pointerAnchorBlockPosition }) => pointerAnchorBlockPosition))
        .toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    } finally { await memory.close(); }
  });

  it('ages on new pending seals, preserves an explicit lift on recovery, and isolates threads', async () => {
    const { memory, failures } = await fixture([1], 6);
    try {
      const id = memory.listBlocks()[1]!.id;
      await memory.expandBlock(id, 3, 'user');
      expect(memory.listBlocks()[1]).toMatchObject({ pointerAnchorLevel: 3, pointerAnchorBlockPosition: 6 });
      failures.clear();
      await memory.retryBlockSummary(memory.listBlocks()[0]!.id);
      expect(memory.getBlockContext('a').find((block) => block.id === id)?.level).toBe(3);
      await memory.appendTurn({ user: 'other thread', assistant: 'saved', threadId: 'b' });
      expect(memory.getBlockContext('a').find((block) => block.id === id)?.level).toBe(3);
      expect(memory.getBlockContext('b')[0]?.age).toBe(0);
      await memory.appendTurn({ user: 'pending seven', assistant: 'saved', threadId: 'a' }, { deferDerivation: true });
      await memory.appendTurn({ user: 'pending eight', assistant: 'saved', threadId: 'a' }, { deferDerivation: true });
      expect(memory.getBlockContext('a').find((block) => block.id === id)).toMatchObject({ age: 6, level: 2 });
      // Reading/checkpoint bookkeeping must not move the decay anchor (ratchet regression).
      await memory.setBlockSurfaceLevel(id, 2);
      for (let read = 0; read < 5; read++) memory.getBlockContext('a');
      expect(memory.listBlocks()[1]).toMatchObject({ pointerAnchorLevel: 3, pointerAnchorBlockPosition: 6, lastLiftedBy: 'user' });
      await memory.expandBlock(id, 'next', 'agent');
      expect(memory.listBlocks()[1]).toMatchObject({ pointerAnchorLevel: 3, pointerAnchorBlockPosition: 8 });
    } finally { await memory.close(); }
  });

  it('migrates legacy snapshots once while preserving elapsed decay, lifts, surface, and raw data', async () => {
    const { memory } = await fixture([1, 3], 8);
    try {
      const legacy = { ...memory.exportSnapshot(), schemaVersion: 13 };
      const lifted = legacy.blocks[1]!;
      lifted.pointerAnchorLevel = 3;
      lifted.pointerAnchorBlockPosition = 5;
      lifted.lastLiftedAt = '2026-01-01T00:00:00.000Z';
      lifted.lastLiftedBy = 'user';
      const original = structuredClone(legacy);
      const migrated = normalizeSnapshot(legacy);
      expect(migrated.schemaVersion).toBe(14);
      for (let index = 0; index < legacy.blocks.length; index++) {
        const before = legacy.blocks[index]!;
        const after = migrated.blocks[index]!;
        if (before.processingStatus === 'ready') {
          expect(after.pointerAnchorBlockPosition).toBe(before.pointerAnchorBlockPosition + 2);
          expect(getDecayedBlockLevel(after.pointerAnchorLevel, after.pointerAnchorBlockPosition, 8))
            .toBe(getDecayedBlockLevel(before.pointerAnchorLevel, before.pointerAnchorBlockPosition, 6));
        } else expect(after.pointerAnchorBlockPosition).toBe(before.pointerAnchorBlockPosition);
        expect(after.l5Raw).toEqual(before.l5Raw);
        expect(after.surfaceCurrentLevel).toBe(before.surfaceCurrentLevel);
        expect(after.lastLiftedBy).toBe(before.lastLiftedBy);
        expect(after.lastLiftedAt).toBe(before.lastLiftedAt);
      }
      expect(normalizeSnapshot(migrated)).toEqual(migrated);
      expect(legacy).toEqual(original);
    } finally { await memory.close(); }
  });

  it('orders each thread by sealed sequence without mutating input', () => {
    const blocks = [
      { id: 'a2', sequence: 3, threadId: 'a' }, { id: 'b1', sequence: 2, threadId: 'b' },
      { id: 'a1', sequence: 1, threadId: 'a' }, { id: 'legacy', sequence: 4 },
    ];
    const before = structuredClone(blocks);
    expect([...buildBlockTimeline(blocks)]).toEqual([
      ['a1', { blockPosition: 1, latestBlockPosition: 2 }],
      ['a2', { blockPosition: 2, latestBlockPosition: 2 }],
      ['b1', { blockPosition: 1, latestBlockPosition: 1 }],
      ['legacy', { blockPosition: 1, latestBlockPosition: 1 }],
    ]);
    expect(blocks).toEqual(before);
  });
});
