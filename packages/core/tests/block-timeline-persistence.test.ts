import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { StrataGate, normalizeSnapshot, type BlockSummarizer } from '../src/index.js';
import { SqliteStorage } from '../src/sqlite.js';

describe('sealed timeline persistence and cutover', () => {
  it('matches snapshot migration in readonly and writable SQLite, survives restart and pending recovery', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-timeline-'));
    const filename = join(directory, 'isolated.db');
    let failing = true;
    const summarizer: BlockSummarizer = async (messages) => {
      if (failing && ['1', '3'].includes(messages[0]!.content)) throw new Error('synthetic failure');
      return { l0Title: messages[0]!.content, l0Tags: [], l1Summary: 'summary', l2Keypoints: [], shouldExtract: false };
    };
    let nextId = 0;
    const options = { database: filename, namespace: 'test', blockTurnSize: 1, summarizer,
      idFactory: (prefix: 'msg' | 'blk' | 'evt') => `${prefix}_${String(++nextId).padStart(5, '0')}` };
    const resources: Array<{ close(): unknown }> = [];
    try {
      let memory = await StrataGate.open(options);
      resources.push(memory);
      for (let index = 1; index <= 8; index++) {
        await memory.appendTurn({ user: String(index), assistant: 'saved', threadId: 'a' });
      }
      await memory.expandBlock(memory.listBlocks()[1]!.id, 3, 'user');
      await memory.appendTurn({ user: 'independent', assistant: 'saved', threadId: 'b' });
      await memory.appendTurn({ user: 'unthreaded', assistant: 'saved' });
      const legacy = { ...memory.exportSnapshot(), schemaVersion: 13 };
      // Seed an actual legacy ready clock: ready ranks, including a lifted anchor.
      let readyPosition = 0;
      for (const block of legacy.blocks) {
        if (block.threadId === 'a' && block.processingStatus === 'ready') {
          readyPosition++;
          block.pointerAnchorBlockPosition = block.lastLiftedAt ? 6 : readyPosition;
        }
      }
      const expected = normalizeSnapshot(legacy);
      await memory.close();

      // Downgrade only this disposable fixture's metadata/anchors to schema 13.
      const database = new Database(filename);
      resources.push(database);
      database.transaction(() => {
        for (const block of legacy.blocks) database.prepare(
          'UPDATE blocks SET pointer_anchor_block_position = ? WHERE namespace = ? AND id = ?',
        ).run(block.pointerAnchorBlockPosition, 'test', block.id);
        database.prepare('UPDATE memory_spaces SET schema_version = 13').run();
        database.pragma('user_version = 13');
      })();
      database.close();

      const readonly = new SqliteStorage({ filename, readonly: true });
      resources.push(readonly);
      expect((await readonly.load('test'))!.snapshot).toEqual(expected);
      await readonly.close();
      const unchanged = new Database(filename, { readonly: true });
      resources.push(unchanged);
      expect(unchanged.pragma('user_version', { simple: true })).toBe(13);
      expect(unchanged.prepare('SELECT pointer_anchor_block_position AS anchor FROM blocks WHERE id = ?')
        .get(legacy.blocks[1]!.id)).toEqual({ anchor: 6 });
      unchanged.close();

      const storage = new SqliteStorage({ filename });
      resources.push(storage);
      expect((await storage.load('test'))!.snapshot).toEqual(expected);
      await storage.close();
      memory = await StrataGate.open(options);
      resources.push(memory);
      const before = memory.getBlockContext('a');
      const anchors = memory.listBlocks().map((block) => block.pointerAnchorBlockPosition);
      failing = false;
      for (const index of [2, 0]) await memory.retryBlockSummary(memory.listBlocks()[index]!.id);
      const after = memory.getBlockContext('a');
      for (const view of before) expect(after.find(({ id }) => id === view.id)).toEqual(view);
      expect(memory.listBlocks().map((block) => block.pointerAnchorBlockPosition)).toEqual(anchors);
      const snapshot = memory.exportSnapshot();
      snapshot.extractionJobs.sort((a, b) => a.blockId.localeCompare(b.blockId));
      await memory.close();
      memory = await StrataGate.open(options);
      resources.push(memory);
      expect(memory.exportSnapshot()).toEqual(snapshot);
      expect(memory.getBlockContext('a')).toEqual(after);
      await memory.close();
      const verified = new Database(filename, { readonly: true });
      resources.push(verified);
      expect(verified.pragma('user_version', { simple: true })).toBe(14);
      expect(verified.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(verified.pragma('foreign_key_check')).toEqual([]);
      verified.close();
    } finally {
      for (const resource of resources.reverse()) {
        try { await resource.close(); } catch { /* Already closed on the successful path. */ }
      }
      await rm(directory, { recursive: true, force: true });
    }
  });
});
