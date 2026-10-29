import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { StrataGate, type BlockLevel } from '../src/index.js';
import { SqliteStorage } from '../src/sqlite.js';

const summarizer = async () => ({ l0Title: 'saved', l0Tags: [], l1Summary: 'summary', l2Keypoints: [], shouldExtract: false });

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'stratagate-surface-levels-'));
  const database = join(directory, 'memory.db');
  const memory = await StrataGate.open({ database, namespace: 'surface', blockTurnSize: 1, summarizer });
  for (let index = 0; index < 3; index++) await memory.appendTurn({ user: `turn ${index}`, assistant: 'answer', threadId: 'a' });
  return {
    memory, database,
    ids: memory.listBlocks().map(({ id }) => id),
    dispose: async () => { vi.restoreAllMocks(); await memory.close(); await rm(directory, { recursive: true, force: true }); },
  };
}

describe('batched surface level tracking', () => {
  it('commits the final values once and leaves decay anchors and other threads alone', async () => {
    const f = await fixture();
    try {
      await f.memory.appendTurn({ user: 'other thread', assistant: 'answer', threadId: 'b' });
      const anchors = f.memory.listBlocks().map(({ pointerAnchorLevel, pointerAnchorBlockPosition, lastLiftedBy }) => ({ pointerAnchorLevel, pointerAnchorBlockPosition, lastLiftedBy }));
      const revision = f.memory.storageRevision;
      const save = vi.spyOn(SqliteStorage.prototype, 'commitRecords');
      expect(await f.memory.setBlockSurfaceLevels([
        { id: f.ids[0]!, level: 3 }, { id: f.ids[1]!, level: 2 }, { id: f.ids[0]!, level: 1 },
      ])).toBe(2);
      expect(save).toHaveBeenCalledTimes(1);
      expect(f.memory.storageRevision).toBe(revision + 1);
      expect(f.memory.listBlocks().map(({ surfaceCurrentLevel }) => surfaceCurrentLevel)).toEqual([1, 2, 5, 5]);
      expect(f.memory.listBlocks().map(({ pointerAnchorLevel, pointerAnchorBlockPosition, lastLiftedBy }) => ({ pointerAnchorLevel, pointerAnchorBlockPosition, lastLiftedBy }))).toEqual(anchors);
      const storage = new SqliteStorage({ filename: f.database, readonly: true });
      try { expect((await storage.load('surface'))?.snapshot.blocks.map(({ surfaceCurrentLevel }) => surfaceCurrentLevel)).toEqual([1, 2, 5, 5]); }
      finally { await storage.close(); }
    } finally { await f.dispose(); }
  });

  it('skips snapshots, writes and revision changes for empty and same-value updates', async () => {
    const f = await fixture();
    try {
      const revision = f.memory.storageRevision;
      const snapshot = vi.spyOn(f.memory, 'exportSnapshot');
      const save = vi.spyOn(SqliteStorage.prototype, 'commitRecords');
      expect(await f.memory.setBlockSurfaceLevels([])).toBe(0);
      expect(await f.memory.setBlockSurfaceLevels(f.ids.map((id) => ({ id, level: 5 })))).toBe(0);
      await f.memory.setBlockSurfaceLevel(f.ids[0]!, 5);
      expect(snapshot).not.toHaveBeenCalled();
      expect(save).not.toHaveBeenCalled();
      expect(f.memory.storageRevision).toBe(revision);
    } finally { await f.dispose(); }
  });

  it('checks no-ops after earlier queued writes, so concurrent duplicates commit once', async () => {
    const f = await fixture();
    try {
      const save = vi.spyOn(SqliteStorage.prototype, 'commitRecords');
      const updates = [{ id: f.ids[0]!, level: 2 as const }];
      expect(await Promise.all([f.memory.setBlockSurfaceLevels(updates), f.memory.setBlockSurfaceLevels(updates)])).toEqual([1, 0]);
      expect(save).toHaveBeenCalledTimes(1);
    } finally { await f.dispose(); }
  });

  it('validates the whole batch before making any change and keeps the queue usable', async () => {
    const f = await fixture();
    try {
      const before = f.memory.exportSnapshot();
      const revision = f.memory.storageRevision;
      for (const invalid of [{ id: 'missing', level: 2 }, { id: f.ids[1]!, level: 6 }, { id: f.ids[1]!, level: 1.5 }]) {
        await expect(f.memory.setBlockSurfaceLevels([{ id: f.ids[0]!, level: 1 }, invalid as { id: string; level: BlockLevel }])).rejects.toThrow();
        expect(f.memory.exportSnapshot()).toEqual(before);
        expect(f.memory.storageRevision).toBe(revision);
      }
      await f.memory.appendTurn({ user: 'pending', assistant: 'answer', threadId: 'a' }, { deferDerivation: true });
      const pending = f.memory.listBlocks().at(-1)!;
      await expect(f.memory.setBlockSurfaceLevels([{ id: f.ids[0]!, level: 1 }, { id: pending.id, level: 2 }])).rejects.toThrow('not ready');
      expect(f.memory.listBlocks()[0]!.surfaceCurrentLevel).toBe(5);
      expect(await f.memory.setBlockSurfaceLevels([{ id: f.ids[0]!, level: 1 }])).toBe(1);
    } finally { await f.dispose(); }
  });

  it('rolls back every level on save failure, then persists a retry', async () => {
    const f = await fixture();
    try {
      const before = f.memory.exportSnapshot();
      const revision = f.memory.storageRevision;
      const updates = f.ids.map((id) => ({ id, level: 1 as const }));
      const save = vi.spyOn(SqliteStorage.prototype, 'commitRecords').mockRejectedValueOnce(new Error('disk failure'));
      await expect(f.memory.setBlockSurfaceLevels(updates)).rejects.toThrow('disk failure');
      expect(f.memory.exportSnapshot()).toEqual(before);
      expect(f.memory.storageRevision).toBe(revision);
      expect(await f.memory.setBlockSurfaceLevels(updates)).toBe(3);
      expect(save).toHaveBeenCalledTimes(2);
      expect(f.memory.storageRevision).toBe(revision + 1);
    } finally { await f.dispose(); }
  });
});
