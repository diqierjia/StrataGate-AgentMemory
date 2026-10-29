import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { StrataGate, type StorageAdapter } from '../src/index.js';
import { SqliteStorage } from '../src/sqlite.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture(full = false) {
  const root = await mkdtemp(join(tmpdir(), 'stratagate-changes-')); roots.push(root);
  const filename = join(root, 'memory.db');
  const storage = new SqliteStorage({ filename });
  const adapter: StorageAdapter = full ? { load: storage.load.bind(storage), save: storage.save.bind(storage) } : storage;
  let id = 0;
  const memory = await StrataGate.openWithStorage({ namespace: 'test', storage: adapter, blockTurnSize: 1,
    now: () => new Date('2026-10-01T00:00:00Z'), idFactory: prefix => `${prefix}_${++id}`, disableElementProjection: true,
    summarizer: async () => ({ l0Title: 'Test', l0Tags: [], l1Summary: 'Summary', l2Keypoints: [], shouldExtract: false }) });
  return { filename, memory, storage };
}

describe('SQLite Unit of Work', () => {
  it('matches full saves after sealing, adoption, event edits and reopen', async () => {
    const full = await fixture(true), delta = await fixture();
    try {
      for (const { memory } of [full, delta]) {
        for (let index = 0; index < 4; index++) await memory.appendTurn({ user: `message ${index}`, assistant: 'ok', threadId: 'a' });
        await memory.setBlockSurfaceLevels([{ id: memory.listBlocks()[0]!.id, level: 2 }]);
        const block = memory.listBlocks()[0]!;
        const event = await memory.addEvent({ title: 'Decision', summary: 'Keep SQLite', sourceBlockId: block.id,
          sourceMessageIds: [block.l5Raw[0]!.id], tags: [], quotes: [], temporal: {}, criticality: 'routine' });
        await memory.recordMemoryUse({ eventIds: [event.id] }, { receiptId: 'receipt' });
        await memory.pinEvent(event.id);
        await memory.forgetEvent(event.id);
        await memory.restoreEvent(event.id);
      }
      expect((await delta.storage.load('test'))!.snapshot).toEqual((await full.storage.load('test'))!.snapshot);
      const reopened = new SqliteStorage({ filename: delta.filename, readonly: true });
      try { expect((await reopened.load('test'))!.snapshot).toEqual((await delta.storage.load('test'))!.snapshot); }
      finally { await reopened.close(); }
    } finally { await full.storage.close(); await delta.storage.close(); }
  });

  it('writes one changed block without updating historical messages, events or graph', async () => {
    const f = await fixture();
    const audit = new DatabaseSync(f.filename);
    try {
      for (let index = 0; index < 4; index++) await f.memory.appendTurn({ user: `row ${index}`, assistant: 'ok', threadId: 'a' });
      audit.exec(`CREATE TABLE writes (name TEXT);`);
      for (const table of ['blocks', 'messages', 'events', 'graph_state', 'memory_topic_state']) {
        audit.exec(`CREATE TRIGGER audit_${table} AFTER UPDATE ON ${table} BEGIN INSERT INTO writes VALUES ('${table}'); END;`);
      }
      await f.memory.setBlockSurfaceLevels([{ id: f.memory.listBlocks()[0]!.id, level: 1 }]);
      expect(audit.prepare('SELECT name FROM writes').all()).toEqual([{ name: 'blocks' }]);
      audit.exec('DELETE FROM writes');
      await f.memory.appendTurn({ user: 'newtail', assistant: 'pending', threadId: 'a' }, { deferProcessing: true });
      expect(audit.prepare('SELECT name FROM writes').all()).toEqual([]);
      expect((await f.storage.load('test'))!.snapshot.openTail.map(message => message.content)).toEqual(['newtail', 'pending']);
      expect(audit.prepare('SELECT message_id FROM raw_message_fts_meta WHERE namespace = ? AND message_id = ?')
        .all('test', f.memory.listOpenTail()[0]!.id)).toHaveLength(1);
    } finally { audit.close(); await f.storage.close(); }
  });

  it('rolls back SQL, memory, revision and FTS when a transaction fails midway', async () => {
    const f = await fixture();
    const audit = new DatabaseSync(f.filename);
    try {
      await f.memory.appendTurn({ user: 'original', assistant: 'ok', threadId: 'a' });
      const before = f.memory.exportSnapshot(), revision = f.memory.storageRevision;
      audit.exec(`CREATE TRIGGER reject_messages BEFORE INSERT ON messages WHEN NEW.content = 'rejected'
        BEGIN SELECT RAISE(ABORT, 'injected write failure'); END;`);
      await expect(f.memory.appendTurn({ user: 'rejected', assistant: 'no', threadId: 'a' }, { deferProcessing: true })).rejects.toThrow('injected write failure');
      expect(f.memory.exportSnapshot()).toEqual(before);
      expect(f.memory.storageRevision).toBe(revision);
      expect((await f.storage.load('test'))!.snapshot).toEqual(before);
      expect(f.storage.searchRawMessageIds('test', ['rejected'], 10)).toEqual([]);
      audit.exec('DROP TRIGGER reject_messages');
      await f.memory.appendTurn({ user: 'retry', assistant: 'yes', threadId: 'a' }, { deferProcessing: true });
      expect((await f.storage.load('test'))!.snapshot.openTail[0]!.content).toBe('retry');
    } finally { audit.close(); await f.storage.close(); }
  });

  it('flushes legacy record and raw-text edits without mutating caller-owned tool inputs', async () => {
    const f = await fixture();
    try {
      const tools = [{ name: 'read', arguments: { content: 'original input' } }];
      await f.memory.appendTurn({ user: 'source', assistant: 'ok', threadId: 'a', assistantToolCalls: tools });
      tools[0]!.arguments.content = 'caller edit';
      const block = f.memory.listBlocks()[0]!;
      expect(block.l5Raw[1]!.toolCalls![0]!.arguments!.content).toBe('original input');
      block.l5Raw[0]!.content = 'legacy raw edit';
      const event = await f.memory.addEvent({ title: 'Old title', summary: 'old', sourceBlockId: block.id,
        sourceMessageIds: [block.l5Raw[0]!.id], tags: [], quotes: [], temporal: {}, criticality: 'routine' });
      event.summary = 'legacy semantic edit';
      await f.memory.appendTurn({ user: 'flush', assistant: 'ok', threadId: 'a' }, { deferProcessing: true });
      const saved = (await f.storage.load('test'))!.snapshot;
      expect(saved.blocks[0]!.l5Raw[0]!.content).toBe('legacy raw edit');
      expect(saved.events[0]!.summary).toBe('legacy semantic edit');
      expect(() => { block.l5Raw[1]!.toolCalls![0]!.arguments!.content = 'mutate original'; }).toThrow();
    } finally { await f.storage.close(); }
  });

  it('records simultaneous duplicate adoption once and rejects stale direct writes without polluting memory', async () => {
    const f = await fixture();
    const staleStorage = new SqliteStorage({ filename: f.filename });
    try {
      await f.memory.appendTurn({ user: 'source', assistant: 'ok', threadId: 'a' });
      const block = f.memory.listBlocks()[0]!;
      const event = await f.memory.addEvent({ title: 'Decision', summary: 'SQLite', sourceBlockId: block.id,
        sourceMessageIds: [block.l5Raw[0]!.id], tags: [], quotes: [], temporal: {}, criticality: 'routine' });
      const stale = await StrataGate.openWithStorage({ namespace: 'test', storage: staleStorage });
      const before = stale.exportSnapshot();
      const mentions = event.weight.mentionCount, revision = f.memory.storageRevision;
      await Promise.all([f.memory.recordMemoryUse([event.id], { receiptId: 'same' }), f.memory.recordMemoryUse([event.id], { receiptId: 'same' })]);
      expect(event.weight.mentionCount).toBe(mentions + 1);
      expect(f.memory.storageRevision).toBe(revision + 1);
      await expect(stale.setBlockSurfaceLevels([{ id: block.id, level: 1 }])).rejects.toThrow('revision conflict');
      expect(stale.exportSnapshot()).toEqual(before);
    } finally { await staleStorage.close(); await f.storage.close(); }
  });
});
