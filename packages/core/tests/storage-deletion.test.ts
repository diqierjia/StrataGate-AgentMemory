import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { StrataGate, type StorageAdapter } from '../src/index.js';
import { SqliteStorage } from '../src/sqlite.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(full: boolean) {
  const root = await mkdtemp(join(tmpdir(), 'stratagate-delete-')); roots.push(root);
  const filename = join(root, 'memory.db'), storage = new SqliteStorage({ filename });
  const adapter: StorageAdapter = full ? { load: storage.load.bind(storage), save: storage.save.bind(storage) } : storage;
  const memory = await StrataGate.openWithStorage({ storage: adapter, namespace: 'test', blockTurnSize: 1, disableElementProjection: true,
    summarizer: async () => ({ l0Title: 'source', l0Tags: [], l1Summary: 'summary', l2Keypoints: [], shouldExtract: false }) });
  await memory.appendTurn({ user: 'originalsource', assistant: 'replacementsource', threadId: 'a' });
  const block = memory.listBlocks()[0]!;
  await memory.addEvent({ title: 'Decision', summary: 'SQLite', sourceBlockId: block.id, sourceMessageIds: [block.l5Raw[0]!.id] });
  return { storage, memory, filename };
}

describe.each([false, true])('foreign-key-safe deletion (fullSave=%s)', full => {
  it.each(['redirect-source', 'delete-block', 'reorder'] as const)('persists %s and reopens without stale provenance', async scenario => {
    const f = await fixture(full);
    try {
      const before = (await f.storage.load('test'))!, after = structuredClone(before.snapshot);
      const block = after.blocks[0]!, removed = block.l5Raw[0]!.id;
      const deleteIds: string[] = [];
      if (scenario === 'redirect-source') {
        block.l5Raw.shift();
        after.events[0]!.sourceMessageIds = [block.l5Raw[0]!.id];
        deleteIds.push(removed);
      } else if (scenario === 'delete-block') {
        deleteIds.push(...block.l5Raw.map(message => message.id));
        after.blocks = []; after.events = []; after.summaryJobs = []; after.extractionJobs = [];
      } else block.l5Raw.reverse();
      const delta = { upsert: [], deleteIds };
      if (full) await f.storage.save('test', after, before.revision, delta);
      else await f.storage.saveChanges('test', before.snapshot, after, before.revision, delta);
      const reopened = new SqliteStorage({ filename: f.filename, readonly: true });
      try { expect((await reopened.load('test'))!.snapshot).toEqual(after); }
      finally { await reopened.close(); }
      const audit = new DatabaseSync(f.filename, { readOnly: true });
      try {
        expect(audit.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
        if (scenario !== 'reorder') for (const id of deleteIds) {
          expect(audit.prepare('SELECT id FROM messages WHERE namespace = ? AND id = ?').all('test', id)).toEqual([]);
          expect(audit.prepare('SELECT message_id FROM raw_message_fts_meta WHERE namespace = ? AND message_id = ?').all('test', id)).toEqual([]);
        }
      } finally { audit.close(); }
    } finally { await f.storage.close(); }
  });

  it('undoes a persisted external import through the public API', async () => {
    const f = await fixture(full);
    try {
      const imported = await f.memory.importExternalMemory({ text: 'A new independent fact.',
        extractor: async () => ({ candidates: [{ title: 'Imported fact', summary: 'A new independent fact.' }] }),
        decider: async () => ({ action: 'ADD', confidence: .99 }) });
      await expect(f.memory.undoExternalMemoryImport(imported.sourceBlockId)).resolves.toMatchObject({ removedEventIds: [imported.addedEvents[0]!.id] });
      const state = (await f.storage.load('test'))!.snapshot;
      expect(state.blocks.some(block => block.id === imported.sourceBlockId)).toBe(false);
      expect(state.events.some(event => event.id === imported.addedEvents[0]!.id)).toBe(false);
    } finally { await f.storage.close(); }
  });

  it('rejects a still-referenced deletion and rolls back revision, rows and FTS', async () => {
    const f = await fixture(full);
    try {
      const before = (await f.storage.load('test'))!, after = structuredClone(before.snapshot);
      const audit = new DatabaseSync(f.filename, { readOnly: true });
      const readIndex = () => audit.prepare('SELECT * FROM raw_message_fts_meta WHERE namespace = ? ORDER BY message_id').all('test');
      const indexBefore = readIndex();
      const id = after.blocks[0]!.l5Raw.shift()!.id;
      const delta = { upsert: [], deleteIds: [id] };
      const save = full ? f.storage.save('test', after, before.revision, delta)
        : f.storage.saveChanges('test', before.snapshot, after, before.revision, delta);
      await expect(save).rejects.toThrow('FOREIGN KEY constraint failed');
      expect(await f.storage.load('test')).toEqual(before);
      try { expect(indexBefore.length).toBeGreaterThan(0); expect(readIndex()).toEqual(indexBefore); }
      finally { audit.close(); }
    } finally { await f.storage.close(); }
  });
});
