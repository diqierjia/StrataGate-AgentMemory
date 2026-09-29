import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  StorageConflictError,
  StrataGate,
  normalizeSnapshot,
  type BlockSummarizer,
  type EventExtractor,
} from '../src/index.js';
import { SqliteStorage } from '../src/sqlite.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function databasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'stratagate-'));
  temporaryDirectories.push(directory);
  return join(directory, 'memory.db');
}

function ids(): (prefix: 'msg' | 'blk' | 'evt') => string {
  let value = 0;
  return (prefix) => `${prefix}_${++value}`;
}

const fixedNow = (): Date => new Date('2026-08-12T00:00:00.000Z');

const summarizer: BlockSummarizer = async (messages) => ({
  l0Title: messages[0]?.content ?? 'block',
  l0Tags: ['persistent'],
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
  reason: 'durable preference',
  events: [{
    id: `event_for_${target.id}`,
    title: 'Persistent preference',
    summary: target.l5Raw[0]?.content ?? 'preference',
    sourceMessageIds: [target.l5Raw[0]?.id ?? 'missing'],
    sourceBlockId: target.id,
    criticality: 'preference',
  }],
});

describe('SQLite persistence', () => {
  it('loads legacy Event columns and snapshots without exposing retired fields', async () => {
    const filename = await databasePath();
    const options = { database: filename, namespace: 'legacy:events', blockTurnSize: 1,
      summarizer: nonExtractingSummarizer, now: fixedNow, idFactory: ids() };
    const memory = await StrataGate.open(options);
    const result = await memory.appendTurn({ user: 'Use SQLite.', assistant: 'Understood.' });
    const event = await memory.addEvent({ title: 'SQLite selected', summary: 'The project selected SQLite.',
      sourceBlockId: result.sealedBlock!.id, sourceMessageIds: [result.sealedBlock!.l5Raw[0]!.id] });
    const legacySnapshot = memory.exportSnapshot() as unknown as Record<string, any>;
    legacySnapshot.events[0].narrative = 'Old narrative.';
    legacySnapshot.events[0].confidence = 0.37;
    const normalized = normalizeSnapshot(legacySnapshot);
    expect(normalized.events[0]).toMatchObject({ id: event.id, summary: event.summary });
    expect(normalized.events[0]).not.toHaveProperty('narrative');
    expect(normalized.events[0]).not.toHaveProperty('confidence');
    await memory.close();

    const db = new Database(filename);
    db.prepare('UPDATE events SET narrative = ?, confidence = ? WHERE namespace = ? AND id = ?')
      .run('Old narrative.', 0.37, options.namespace, event.id);
    db.close();
    const reopened = await StrataGate.open(options);
    expect(reopened.listEvents()[0]).toMatchObject({ id: event.id, summary: event.summary });
    expect(reopened.listEvents()[0]).not.toHaveProperty('narrative');
    expect(reopened.listEvents()[0]).not.toHaveProperty('confidence');
    expect((await reopened.searchEvents('SQLite'))[0]?.event.id).toBe(event.id);
    await reopened.close();
  });
  it('restores an unfinished external-memory import job with saved progress', async () => {
    const filename = await databasePath();
    const memory = await StrataGate.open({ database: filename, namespace: 'imports', now: fixedNow });
    const job = await memory.createExternalMemoryImportJob(JSON.stringify({
      schemaVersion: 'stratagate.external-memory.v2',
      sourceType: 'external_ai_memory_export',
      candidates: [
        { title: '候选一', summary: '第一条。' },
        { title: '候选二', summary: '第二条。' },
      ],
    }));
    await memory.processNextExternalMemoryImport(job.id, async () => ({ action: 'ADD', confidence: 0.9 }));
    await memory.close();

    const reopened = await StrataGate.open({ database: filename, namespace: 'imports', now: fixedNow });
    expect(reopened.getExternalMemoryImportJob(job.id)).toMatchObject({
      status: 'processing', processedCount: 1, totalCount: 2,
    });
    await reopened.close();
  });

  it('uses SQLite for the normal open entrypoint and keeps memory mode explicit', async () => {
    const filename = await databasePath();
    const persistent = await StrataGate.open({
      database: filename,
      namespace: 'default:sqlite',
      now: fixedNow,
      idFactory: ids(),
    });
    expect(persistent.storageRevision).toBe(1);
    await persistent.appendTurn({ user: 'stored', assistant: 'durably' });
    expect(persistent.storageRevision).toBe(2);
    await persistent.close();

    const database = new Database(filename, { readonly: true });
    expect(database.prepare('SELECT current_turn FROM memory_spaces WHERE namespace = ?')
      .pluck().get('default:sqlite')).toBe(1);
    database.close();

    const ephemeral = StrataGate.inMemory({ now: fixedNow, idFactory: ids() });
    expect(ephemeral.storageRevision).toBe(0);
    await ephemeral.appendTurn({ user: 'temporary', assistant: 'only' });
    expect(ephemeral.storageRevision).toBe(0);
  });

  it('creates schema version twelve and rejects a newer database schema', async () => {
    const initializedFilename = await databasePath();
    const initialized = new SqliteStorage({ filename: initializedFilename });
    await initialized.close();
    const initializedDatabase = new Database(initializedFilename, { readonly: true });
    expect(initializedDatabase.pragma('user_version', { simple: true })).toBe(12);
    initializedDatabase.close();

    const newerFilename = await databasePath();
    const newerDatabase = new Database(newerFilename);
    newerDatabase.pragma('user_version = 13');
    newerDatabase.close();
    expect(() => new SqliteStorage({ filename: newerFilename })).toThrow('newer than supported');
  });

  it('backfills, incrementally updates, self-heals, and cleans the raw FTS index', async () => {
    const filename = await databasePath();
    const options = {
      database: filename,
      namespace: 'raw:fts-lifecycle',
      blockTurnSize: 1,
      summarizer: nonExtractingSummarizer,
      now: fixedNow,
      idFactory: ids(),
    };
    const first = await StrataGate.open(options);
    const initial = await first.appendTurn({ user: '星河项目由李明负责', assistant: '初始原文' });
    expect(first.searchRawMemory('星河项目')).toHaveLength(1);
    await first.close();

    const beforeBackfill = new Database(filename);
    beforeBackfill.exec('DROP TABLE raw_message_fts; DROP TABLE raw_message_fts_meta; DROP TABLE raw_message_fts_state;');
    beforeBackfill.close();

    const restored = await StrataGate.open(options);
    expect(restored.searchRawMemory('李明')[0]?.message.id).toBe(initial.sealedBlock!.l5Raw[0]!.id);
    await restored.appendTurn({ user: '新增消息：StrataGate raw index', assistant: '增量写入' });
    await restored.close();

    const afterIncrement = new Database(filename, { readonly: true });
    expect(afterIncrement.prepare(
      'SELECT COUNT(*) FROM raw_message_fts_meta WHERE namespace = ?',
    ).pluck().get(options.namespace)).toBe(4);
    afterIncrement.close();

    const downgrade = new Database(filename);
    const block = downgrade.prepare(
      'SELECT id, thread_id FROM blocks WHERE namespace = ? ORDER BY sequence DESC LIMIT 1',
    ).get(options.namespace) as { id: string; thread_id: string | null };
    downgrade.prepare(`
      INSERT INTO messages (namespace, id, block_id, thread_id, position, role, content, created_at, tool_calls_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(options.namespace, 'msg_downgrade', block.id, block.thread_id, 99, 'user', '降级期间新增的星河消息 rawfts_deleted_unique', fixedNow().toISOString(), null);
    downgrade.prepare(
      'UPDATE raw_message_fts_state SET backfill_complete = 1 WHERE namespace = ?',
    ).run(options.namespace);
    downgrade.close();

    const healed = await StrataGate.open(options);
    expect(healed.searchRawMemory('降级期间新增')[0]?.message.id).toBe('msg_downgrade');
    const loaded = healed.exportSnapshot();
    const targetBlock = loaded.blocks.find((candidate) => candidate.id === block.id)!;
    const removed = targetBlock.l5Raw.at(-1)!;
    targetBlock.l5Raw = targetBlock.l5Raw.filter(({ id }) => id !== removed.id);
    const indexedBeforeDelete = new Database(filename, { readonly: true });
    const removedRowId = indexedBeforeDelete.prepare(
      'SELECT fts_rowid FROM raw_message_fts_meta WHERE namespace = ? AND message_id = ?',
    ).pluck().get(options.namespace, removed.id) as number;
    expect(removedRowId).toBeTypeOf('number');
    expect(indexedBeforeDelete.prepare('SELECT rowid FROM raw_message_fts WHERE rowid = ?')
      .pluck().get(removedRowId)).toBe(removedRowId);
    indexedBeforeDelete.close();
    const storage = new SqliteStorage({ filename });
    await storage.save(options.namespace, loaded, healed.storageRevision, { upsert: [], deleteIds: [removed.id] });
    await storage.close();
    await healed.close();

    const cleaned = await StrataGate.open(options);
    expect(cleaned.searchRawMemory('星河').some(({ message }) => message.id === removed.id)).toBe(false);
    expect(cleaned.searchRawMemory('rawfts_deleted_unique')).toEqual([]);
    const cleanedDatabase = new Database(filename, { readonly: true });
    expect(cleanedDatabase.prepare(
      'SELECT message_id FROM raw_message_fts_meta WHERE namespace = ? AND message_id = ?',
    ).pluck().get(options.namespace, removed.id)).toBeUndefined();
    expect(cleanedDatabase.prepare(
      'SELECT rowid FROM raw_message_fts WHERE message_id = ?',
    ).pluck().get(removed.id)).toBeUndefined();
    cleanedDatabase.close();
    await cleaned.close();
  });

  it('filters session scope before the SQLite candidate limit and falls back when FTS is unavailable', async () => {
    const filename = await databasePath();
    const memory = await StrataGate.open({
      database: filename,
      namespace: 'raw:scope',
      blockTurnSize: 1,
      summarizer: nonExtractingSummarizer,
      now: fixedNow,
      idFactory: ids(),
    });
    for (let index = 0; index < 120; index += 1) {
      await memory.appendTurn({ user: `共同关键词 other ${index}`, assistant: 'other', threadId: 'other' });
    }
    await memory.appendTurn({ user: '共同关键词 current session target', assistant: 'current', threadId: 'current' });
    const scoped = memory.searchRawMemory('共同关键词 current', 1, { threadId: 'current' });
    expect(scoped[0]?.message.threadId).toBe('current');

    const storage = (memory as unknown as { storage: { rawSearchFtsAvailable: boolean } }).storage;
    storage.rawSearchFtsAvailable = false;
    const fallback = memory.searchRawMemory('共同关键词 current', 1, { threadId: 'current' });
    expect(fallback[0]?.message.threadId).toBe('current');
    await memory.close();
  }, 30_000);

  it('persists the source Block endTurn rather than a delayed creation turn', async () => {
    const filename = await databasePath();
    const options = { database: filename, namespace: 'formed-turn', blockTurnSize: 1,
      summarizer: nonExtractingSummarizer, now: fixedNow, idFactory: ids() };
    const memory = await StrataGate.open(options);
    const first = await memory.appendTurn({ user: 'remember this', assistant: 'okay' });
    await memory.appendTurn({ user: 'later', assistant: 'context' });
    const event = await memory.addEvent({ id: 'delayed', title: 'Delayed Event', summary: 'source remains first turn',
      sourceBlockId: first.sealedBlock!.id, sourceMessageIds: [first.sealedBlock!.l5Raw[0]!.id] });
    expect(memory.turn).toBe(2);
    expect(event.formedTurn).toBe(1);
    expect(event.weight.lastAdoptedTurn).toBe(1);
    const expected = memory.exportSnapshot();
    await memory.close();
    const restored = await StrataGate.open(options);
    expect(restored.exportSnapshot()).toEqual(expected);
    await restored.close();
  });

  it('migrates v10 formedTurn without guessing or changing legacy weight state', async () => {
    const filename = await databasePath();
    const options = { database: filename, namespace: 'legacy:v10', blockTurnSize: 1,
      summarizer: nonExtractingSummarizer, now: fixedNow, idFactory: ids() };
    const memory = await StrataGate.open(options);
    const expected = new Map();
    for (const [id, threadId] of [['normal', 'conversation'], ['external', 'external-import:fixture'], ['missing', 'conversation']] as const) {
      const result = await memory.appendTurn({ user: id, assistant: 'fixture', threadId });
      const event = await memory.addEvent({ id, title: id, summary: 'disposable legacy fixture',
        sourceBlockId: result.sealedBlock!.id, sourceMessageIds: [result.sealedBlock!.l5Raw[0]!.id] });
      expected.set(id, event);
    }
    await memory.recordMemoryUse(['normal'], { receiptId: 'legacy-use', audit: { sessionId: 'conversation', turn: memory.turn } });
    const before = memory.exportSnapshot();
    await memory.close();
    const database = new Database(filename);
    // Simulate an old orphaned source only in this disposable fixture.
    database.pragma('foreign_keys = OFF');
    database.exec('ALTER TABLE events DROP COLUMN formed_turn; PRAGMA user_version = 10; UPDATE memory_spaces SET schema_version = 10;');
    database.prepare('UPDATE events SET source_block_id = ? WHERE id = ?').run('unavailable-block', 'missing');
    database.close();

    const storage = new SqliteStorage({ filename });
    const loaded = (await storage.load(options.namespace))!.snapshot;
    expect(loaded.schemaVersion).toBe(12);
    expect(loaded.events.find(({ id }) => id === 'normal')?.formedTurn).toBe(1);
    expect(loaded.events.find(({ id }) => id === 'external')).not.toHaveProperty('formedTurn');
    expect(loaded.events.find(({ id }) => id === 'missing')).not.toHaveProperty('formedTurn');
    expect(loaded.blocks).toEqual(before.blocks);
    expect(loaded.usageReceipts).toEqual(before.usageReceipts);
    for (const event of loaded.events) {
      expect(event.weight).toEqual(before.events.find(({ id }) => id === event.id)!.weight);
      expect(event.summary).toBe(expected.get(event.id).summary);
      expect(event.sourceMessageIds).toEqual(expected.get(event.id).sourceMessageIds);
    }
    await storage.close();
    const reopened = new SqliteStorage({ filename });
    expect((await reopened.load(options.namespace))!.snapshot).toEqual(loaded);
    await reopened.close();
    const migrated = new Database(filename, { readonly: true });
    expect(migrated.pragma('user_version', { simple: true })).toBe(12);
    expect(migrated.prepare('SELECT formed_turn FROM events WHERE id = ?').pluck().get('normal')).toBe(1);
    expect(migrated.prepare('SELECT formed_turn FROM events WHERE id = ?').pluck().get('external')).toBeNull();
    migrated.close();
  });

  it('migrates schema v6 Blocks with an unknown legacy expansion source', async () => {
    const filename = await databasePath();
    const memory = await StrataGate.open({
      database: filename,
      namespace: 'legacy:v6',
      blockTurnSize: 1,
      summarizer: nonExtractingSummarizer,
      now: fixedNow,
      idFactory: ids(),
    });
    await memory.appendTurn({ user: 'legacy prompt', assistant: 'legacy answer' });
    await memory.close();

    const legacy = new Database(filename);
    legacy.exec(`
      ALTER TABLE blocks DROP COLUMN last_lifted_by;
      UPDATE memory_spaces SET schema_version = 6;
      PRAGMA user_version = 6;
    `);
    legacy.close();

    const storage = new SqliteStorage({ filename });
    const loaded = await storage.load('legacy:v6');
    expect(loaded?.snapshot.schemaVersion).toBe(12);
    expect(loaded?.snapshot.blocks[0]?.lastLiftedBy).toBeNull();
    await storage.close();

    const migrated = new Database(filename, { readonly: true });
    expect((migrated.pragma('table_info(blocks)') as Array<{ name: string }>).map(({ name }) => name))
      .toContain('last_lifted_by');
    migrated.close();
  });

  it('migrates schema v8 Blocks as ready and adds durable derivation jobs', async () => {
    const filename = await databasePath();
    const memory = await StrataGate.open({
      database: filename,
      namespace: 'legacy:v8',
      blockTurnSize: 1,
      summarizer: nonExtractingSummarizer,
      now: fixedNow,
      idFactory: ids(),
    });
    await memory.appendTurn({ user: 'legacy ready block', assistant: 'stored' });
    await memory.close();

    const legacy = new Database(filename);
    legacy.exec(`
      DROP TABLE block_summary_jobs;
      ALTER TABLE blocks DROP COLUMN processing_status;
      ALTER TABLE extraction_jobs DROP COLUMN next_retry_at;
      UPDATE memory_spaces SET schema_version = 8;
      PRAGMA user_version = 8;
    `);
    legacy.close();

    const storage = new SqliteStorage({ filename });
    const loaded = await storage.load('legacy:v8');
    expect(loaded?.snapshot).toMatchObject({ schemaVersion: 12, summaryJobs: [], externalMemoryImportJobs: [] });
    expect(loaded?.snapshot.blocks[0]?.processingStatus).toBe('ready');
    expect(loaded?.snapshot.extractionJobs[0]?.nextRetryAt).toBeNull();
    await storage.close();
  });

  it('persists whether a Block was expanded by the user', async () => {
    const filename = await databasePath();
    const memory = await StrataGate.open({
      database: filename,
      namespace: 'expand-source',
      blockTurnSize: 1,
      summarizer: nonExtractingSummarizer,
      now: fixedNow,
      idFactory: ids(),
    });
    const appended = await memory.appendTurn({ user: 'lift this', assistant: 'stored' });
    await memory.expandBlock(appended.sealedBlock!.id, 4, 'user');
    await memory.close();

    const restored = await StrataGate.open({ database: filename, namespace: 'expand-source' });
    expect(restored.listBlocks()[0]?.lastLiftedBy).toBe('user');
    await restored.close();
  });

  it('restores an open tail and seals it at the same boundary after restart', async () => {
    const filename = await databasePath();
    const idFactory = ids();
    const first = await StrataGate.open({
      database: filename,
      namespace: 'user:alice',
      blockTurnSize: 2,
      summarizer,
      idFactory,
      now: fixedNow,
    });
    await first.appendTurn({ user: 'turn one', assistant: 'answer one', threadId: 'session-a' });
    expect(first.listOpenTail('session-a')).toHaveLength(2);
    await first.close();

    const second = await StrataGate.open({
      database: filename,
      namespace: 'user:alice',
      summarizer,
      idFactory,
      now: fixedNow,
    });
    expect(second.turn).toBe(1);
    expect(second.listOpenTail('session-a').map((message) => message.content)).toEqual(['turn one', 'answer one']);
    const result = await second.appendTurn({ user: 'turn two', assistant: 'answer two', threadId: 'session-a' });
    expect(result.sealedBlock?.threadId).toBe('session-a');
    expect(result.sealedBlock?.startTurn).toBe(1);
    expect(result.sealedBlock?.endTurn).toBe(2);
    expect(second.listOpenTail()).toHaveLength(0);
    const expected = second.exportSnapshot();
    await second.close();

    const restored = await StrataGate.open({
      database: filename,
      namespace: 'user:alice',
      summarizer,
      idFactory,
      now: fixedNow,
    });
    expect(restored.exportSnapshot()).toEqual(expected);
    await restored.close();
  });

  it('keeps raw turns durable when summarization fails and resumes without appending again', async () => {
    const filename = await databasePath();
    const failingSummary: BlockSummarizer = async () => {
      throw new Error('summary unavailable');
    };
    const first = await StrataGate.open({
      database: filename,
      namespace: 'session:summary-retry',
      blockTurnSize: 1,
      summarizer: failingSummary,
      now: fixedNow,
      idFactory: ids(),
    });
    await first.appendTurn({ user: 'must survive', assistant: 'stored first' });
    expect(first.turn).toBe(1);
    expect(first.listOpenTail()).toHaveLength(0);
    expect(first.listBlocks()).toHaveLength(1);
    expect(first.listBlocks()[0]).not.toHaveProperty('l0Title');
    expect(first.listSummaryJobs()[0]).toMatchObject({ status: 'failed', attempts: 1, lastError: 'summary unavailable' });
    await first.close();

    const restored = await StrataGate.open({
      database: filename,
      namespace: 'session:summary-retry',
      summarizer: nonExtractingSummarizer,
      now: fixedNow,
      idFactory: ids(),
    });
    const resumed = await restored.resumePendingWork({ retryFailed: true });
    expect(resumed.sealedBlocks).toHaveLength(0);
    expect(resumed.readyBlocks).toHaveLength(1);
    expect(restored.listBlocks()[0]?.l5Raw[0]?.content).toBe('must survive');
    expect(restored.turn).toBe(1);
    await restored.close();
  });

  it('persists failed extraction and retries only that eligible block', async () => {
    const filename = await databasePath();
    let attempts = 0;
    const failingExtractor: EventExtractor = async () => {
      attempts += 1;
      throw new Error('extractor unavailable');
    };
    const idFactory = ids();
    const first = await StrataGate.open({
      database: filename,
      namespace: 'session:extract-retry',
      blockTurnSize: 1,
      summarizer,
      extractor: failingExtractor,
      now: fixedNow,
      idFactory,
    });
    await first.appendTurn({ user: 'remember this', assistant: 'okay' });
    await first.appendTurn({ user: 'later context', assistant: 'noted' });
    expect(attempts).toBe(2);
    expect(first.listBlocks()).toHaveLength(2);
    expect(first.listEvents()).toHaveLength(0);
    expect(first.listExtractionJobs()).toMatchObject([{
      status: 'failed',
      attempts: 1,
      lastError: 'extractor unavailable',
    }, {
      status: 'failed',
      attempts: 1,
      lastError: 'extractor unavailable',
    }]);
    await first.close();

    const restored = await StrataGate.open({
      database: filename,
      namespace: 'session:extract-retry',
      summarizer,
      extractor,
      now: fixedNow,
      idFactory,
    });
    const resumed = await restored.resumePendingWork({ retryFailed: true });
    expect(resumed.extractedEvents).toHaveLength(2);
    expect(restored.listEvents()).toHaveLength(2);
    expect(restored.listExtractionJobs()).toMatchObject([{
      status: 'succeeded',
      attempts: 2,
      lastError: null,
    }, {
      status: 'succeeded',
      attempts: 2,
      lastError: null,
    }]);
    await restored.close();
  });

  it('makes adoption receipts idempotent across retries and restarts', async () => {
    const filename = await databasePath();
    const idFactory = ids();
    const first = await StrataGate.open({
      database: filename,
      namespace: 'user:receipts',
      blockTurnSize: 1,
      summarizer,
      extractor,
      now: fixedNow,
      idFactory,
    });
    await first.appendTurn({ user: 'prefer short answers', assistant: 'okay' });
    await first.appendTurn({ user: 'what is my preference?', assistant: 'checking' });
    const event = first.listEvents()[0];
    expect(event).toBeDefined();
    if (!event) return;
    const audit = {
      sessionId: 'session-42',
      turn: 7,
      batchId: 'batch_1',
      evidenceRefs: [`event:${event.id}`],
      verdict: 'sufficient' as const,
      fit: 'The event directly supports the answer.',
      missing: '',
      nextStrategy: 'answer',
    };
    await first.recordMemoryUse([event.id], { receiptId: 'answer:42', audit });
    await first.recordMemoryUse([event.id], { receiptId: 'answer:42', audit });
    expect(event.weight.mentionCount).toBe(2);
    await first.close();

    const restored = await StrataGate.open({
      database: filename,
      namespace: 'user:receipts',
      summarizer,
      extractor,
      now: fixedNow,
      idFactory,
    });
    const restoredEvent = restored.listEvents()[0];
    expect(restoredEvent?.weight.mentionCount).toBe(2);
    if (restoredEvent) {
      expect(restored.listUsageReceipts()).toContainEqual(expect.objectContaining({
        id: 'answer:42',
        audit,
      }));
      await restored.recordMemoryUse([restoredEvent.id], { receiptId: 'answer:42', audit });
      expect(restoredEvent.weight.mentionCount).toBe(2);
      await expect(restored.recordMemoryUse([], { receiptId: 'answer:42' }))
        .rejects.toThrow('different memory IDs');
    }
    await restored.close();
  });

  it('persists explicitly reconfigured block settings for an existing namespace', async () => {
    const filename = await databasePath();
    const first = await StrataGate.open({
      database: filename,
      namespace: 'project:block-size-change',
      blockTurnSize: 4,
      blockDecayLambda: 0.2,
      now: fixedNow,
      idFactory: ids(),
    });
    await first.appendTurn({ user: 'one', assistant: 'stored' });
    await first.close();

    const changed = await StrataGate.open({
      database: filename,
      namespace: 'project:block-size-change',
      blockTurnSize: 6,
      blockDecayLambda: 0.35,
      now: fixedNow,
      idFactory: ids(),
    });
    expect(changed.blockTurnSize).toBe(6);
    expect(changed.blockDecayLambda).toBe(0.35);
    expect(changed.listOpenTail()).toHaveLength(2);
    await changed.setBlockTurnSize(3);
    await changed.setBlockDecayLambda(0.15);
    expect(changed.blockTurnSize).toBe(3);
    expect(changed.blockDecayLambda).toBe(0.15);
    await changed.close();

    const restored = await StrataGate.open({
      database: filename,
      namespace: 'project:block-size-change',
      now: fixedNow,
      idFactory: ids(),
    });
    expect(restored.blockTurnSize).toBe(3);
    expect(restored.blockDecayLambda).toBe(0.15);
    await restored.close();
  });

  it('rejects a stale writer and rolls back its in-memory mutation', async () => {
    const filename = await databasePath();
    const first = await StrataGate.open({
      database: filename,
      namespace: 'project:shared',
      blockTurnSize: 12,
      now: fixedNow,
      idFactory: ids(),
    });
    const stale = await StrataGate.open({
      database: filename,
      namespace: 'project:shared',
      now: fixedNow,
      idFactory: ids(),
    });

    await first.appendTurn({ user: 'writer one', assistant: 'committed' });
    await expect(stale.appendTurn({ user: 'writer two', assistant: 'stale' }))
      .rejects.toBeInstanceOf(StorageConflictError);
    expect(stale.turn).toBe(0);
    expect(stale.listOpenTail()).toHaveLength(0);
    await first.close();
    await stale.close();
  });

  it('migrates a schema-v1 database in place without losing its namespace', async () => {
    const filename = await databasePath();
    const legacy = new Database(filename);
    legacy.exec(`
      CREATE TABLE memory_spaces (
        namespace TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        current_turn INTEGER NOT NULL,
        block_turn_size INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE usage_receipts (
        namespace TEXT NOT NULL,
        receipt_id TEXT NOT NULL,
        event_ids_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (namespace, receipt_id),
        FOREIGN KEY (namespace) REFERENCES memory_spaces(namespace) ON DELETE CASCADE
      ) STRICT;
      INSERT INTO memory_spaces VALUES ('legacy:user', 1, 7, 0, 12, '2026-01-01', '2026-01-01');
      PRAGMA user_version = 1;
    `);
    legacy.close();

    const storage = new SqliteStorage({ filename });
    const loaded = await storage.load('legacy:user');
    expect(loaded?.revision).toBe(7);
    expect(loaded?.snapshot).toMatchObject({
      schemaVersion: 12,
      blockDecayLambda: 0.3,
      elements: [],
      elementProjectionJobs: [],
      graphNodes: [],
      graphEdges: [],
      graphProjectionJobs: [],
      ingestionReceipts: [],
    });
    await storage.close();

    const migrated = new Database(filename, { readonly: true });
    expect(migrated.pragma('user_version', { simple: true })).toBe(12);
    expect((migrated.pragma('table_info(usage_receipts)') as Array<{ name: string }>)
      .map(({ name }) => name)).toContain('element_ids_json');
    expect((migrated.pragma('table_info(usage_receipts)') as Array<{ name: string }>)
      .map(({ name }) => name)).toContain('audit_json');
    expect(migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'elements'")
      .pluck().get()).toBe('elements');
    expect(migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'graph_state'")
      .pluck().get()).toBe('graph_state');
    expect(migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ingestion_receipts'")
      .pluck().get()).toBe('ingestion_receipts');
    migrated.close();
  });

  it('normalizes legacy Graph jobs missing retry metadata at the SQLite load boundary', async () => {
    const filename = await databasePath();
    const namespace = 'legacy:graph-retry';
    const memory = await StrataGate.open({
      database: filename,
      namespace,
      blockTurnSize: 1,
      summarizer: nonExtractingSummarizer,
      graphProjector: async () => ({ reason: 'unused', nodes: [], edges: [] }),
      now: fixedNow,
    });
    await memory.appendTurn({ user: 'source', assistant: 'stored' });
    const block = memory.listBlocks()[0]!;
    await memory.addEvent({
      title: 'Legacy Graph job', summary: 'Retry metadata did not exist yet.',
      sourceBlockId: block.id, sourceMessageIds: [block.l5Raw[0]!.id],
    });
    const claim = await memory.claimNextGraphProjection();
    await memory.failGraphProjection(claim!.jobId, new Error('legacy failure'));
    await memory.close();

    const legacy = new Database(filename);
    const row = legacy.prepare('SELECT jobs_json FROM graph_state WHERE namespace = ?')
      .get(namespace) as { jobs_json: string };
    const jobs = JSON.parse(row.jobs_json) as Array<{ nextRetryAt?: string | null }>;
    delete jobs[0]!.nextRetryAt;
    legacy.prepare('UPDATE graph_state SET jobs_json = ? WHERE namespace = ?')
      .run(JSON.stringify(jobs), namespace);
    legacy.close();

    const storage = new SqliteStorage({ filename });
    const loaded = await storage.load(namespace);
    expect(loaded?.snapshot.graphProjectionJobs[0]?.nextRetryAt).toBeNull();
    await storage.close();
  });

  it('adds nullable thread ownership when migrating a schema-v4 database', async () => {
    const filename = await databasePath();
    const legacy = new Database(filename);
    legacy.exec(`
      CREATE TABLE memory_spaces (
        namespace TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, revision INTEGER NOT NULL,
        current_turn INTEGER NOT NULL, block_turn_size INTEGER NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE blocks (
        namespace TEXT NOT NULL, id TEXT NOT NULL, sequence INTEGER NOT NULL,
        start_turn INTEGER NOT NULL, end_turn INTEGER NOT NULL, created_at TEXT NOT NULL,
        should_extract INTEGER NOT NULL, l0_title TEXT NOT NULL, l0_tags_json TEXT NOT NULL,
        l1_summary TEXT NOT NULL, l2_keypoints_json TEXT NOT NULL, l3_condensed TEXT NOT NULL,
        l4_readable TEXT NOT NULL, pointer_current_level INTEGER NOT NULL,
        pointer_anchor_level INTEGER NOT NULL, pointer_anchor_turn INTEGER NOT NULL,
        last_lifted_at TEXT, PRIMARY KEY (namespace, id), UNIQUE (namespace, sequence),
        FOREIGN KEY (namespace) REFERENCES memory_spaces(namespace) ON DELETE CASCADE
      ) STRICT;
      CREATE TABLE messages (
        namespace TEXT NOT NULL, id TEXT NOT NULL, block_id TEXT, position INTEGER NOT NULL,
        role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL, tool_calls_json TEXT,
        PRIMARY KEY (namespace, id),
        FOREIGN KEY (namespace) REFERENCES memory_spaces(namespace) ON DELETE CASCADE,
        FOREIGN KEY (namespace, block_id) REFERENCES blocks(namespace, id) ON DELETE CASCADE
      ) STRICT;
      CREATE TABLE usage_receipts (
        namespace TEXT NOT NULL, receipt_id TEXT NOT NULL, event_ids_json TEXT NOT NULL,
        element_ids_json TEXT NOT NULL DEFAULT '[]', audit_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL, PRIMARY KEY (namespace, receipt_id),
        FOREIGN KEY (namespace) REFERENCES memory_spaces(namespace) ON DELETE CASCADE
      ) STRICT;
      INSERT INTO memory_spaces VALUES ('legacy:v4', 4, 3, 0, 6, '2026-01-01', '2026-01-01');
      PRAGMA user_version = 4;
    `);
    legacy.close();

    const storage = new SqliteStorage({ filename });
    const loaded = await storage.load('legacy:v4');
    expect(loaded?.snapshot.schemaVersion).toBe(12);
    expect(loaded?.snapshot.blockDecayLambda).toBe(0.3);
    await storage.close();

    const migrated = new Database(filename, { readonly: true });
    expect((migrated.pragma('table_info(blocks)') as Array<{ name: string }>).map(({ name }) => name))
      .toContain('thread_id');
    expect((migrated.pragma('table_info(blocks)') as Array<{ name: string }>).map(({ name }) => name))
      .toContain('pointer_anchor_block_position');
    expect((migrated.pragma('table_info(messages)') as Array<{ name: string }>).map(({ name }) => name))
      .toContain('thread_id');
    migrated.close();
  });

  it('converts turn anchors to per-thread block positions when migrating schema v5', async () => {
    const filename = await databasePath();
    const legacy = new Database(filename);
    legacy.exec(`
      CREATE TABLE memory_spaces (
        namespace TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, revision INTEGER NOT NULL,
        current_turn INTEGER NOT NULL, block_turn_size INTEGER NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE blocks (
        namespace TEXT NOT NULL, id TEXT NOT NULL, thread_id TEXT, sequence INTEGER NOT NULL,
        start_turn INTEGER NOT NULL, end_turn INTEGER NOT NULL, created_at TEXT NOT NULL,
        should_extract INTEGER NOT NULL, l0_title TEXT NOT NULL, l0_tags_json TEXT NOT NULL,
        l1_summary TEXT NOT NULL, l2_keypoints_json TEXT NOT NULL, l3_condensed TEXT NOT NULL,
        l4_readable TEXT NOT NULL, pointer_current_level INTEGER NOT NULL,
        pointer_anchor_level INTEGER NOT NULL, pointer_anchor_turn INTEGER NOT NULL,
        last_lifted_at TEXT, PRIMARY KEY (namespace, id), UNIQUE (namespace, sequence),
        FOREIGN KEY (namespace) REFERENCES memory_spaces(namespace) ON DELETE CASCADE
      ) STRICT;
      INSERT INTO memory_spaces VALUES ('legacy:v5', 5, 2, 12, 6, '2026-01-01', '2026-01-01');
      INSERT INTO blocks VALUES
        ('legacy:v5', 'a1', 'thread-a', 1, 1, 6, '2026-01-01', 0,
         'A1', '[]', 'A1', '[]', 'A1', 'A1', 5, 5, 7, NULL),
        ('legacy:v5', 'b1', 'thread-b', 2, 1, 6, '2026-01-01', 0,
         'B1', '[]', 'B1', '[]', 'B1', 'B1', 5, 5, 6, NULL),
        ('legacy:v5', 'a2', 'thread-a', 3, 7, 12, '2026-01-01', 0,
         'A2', '[]', 'A2', '[]', 'A2', 'A2', 5, 5, 12, NULL);
      PRAGMA user_version = 5;
    `);
    legacy.close();

    const storage = new SqliteStorage({ filename });
    const loaded = await storage.load('legacy:v5');
    expect(loaded?.snapshot).toMatchObject({ schemaVersion: 12, blockDecayLambda: 0.3 });
    expect(loaded?.snapshot.blocks.map(({ id, pointerAnchorBlockPosition }) =>
      [id, pointerAnchorBlockPosition])).toEqual([
      ['a1', 1],
      ['b1', 1],
      ['a2', 2],
    ]);
    await storage.close();
  });

  it('persists projected elements and idempotent element-use receipts across restarts', async () => {
    const filename = await databasePath();
    const storage = new SqliteStorage({ filename });
    const elementIdFactory = (() => {
      let value = 0;
      return (prefix: 'elem' | 'fact' | 'proj') => `${prefix}_${++value}`;
    })();
    const first = await StrataGate.openWithStorage({
      storage,
      namespace: 'project:elements',
      blockTurnSize: 1,
      summarizer,
      extractor,
      idFactory: ids(),
      elementIdFactory,
      elementProjector: async ({ events }) => ({
        reason: 'project current state',
        changes: [{
          element: { name: 'StrataGate', type: 'project' },
          operation: 'set_state',
          key: 'storage',
          mode: 'state',
          value: 'SQLite',
          sourceEventIds: [events[0]?.id ?? 'missing'],
        }],
      }),
      now: fixedNow,
    });
    await first.appendTurn({ user: 'Use SQLite.', assistant: 'Recorded.' });
    await first.appendTurn({ user: 'Continue.', assistant: 'Okay.' });
    const element = first.listElements()[0];
    expect(element?.currentState).toContain('SQLite');
    if (!element) return;
    await first.recordMemoryUse({ elementIds: [element.id] }, { receiptId: 'answer:element:1' });
    await first.recordMemoryUse({ elementIds: [element.id] }, { receiptId: 'answer:element:1' });
    expect(element.weight.mentionCount).toBe(2);
    await first.close();

    const restoredStorage = new SqliteStorage({ filename });
    const restored = await StrataGate.openWithStorage({ storage: restoredStorage, namespace: 'project:elements' });
    expect(restored.listElements()[0]).toMatchObject({
      name: 'StrataGate',
      currentState: 'storage: SQLite',
      weight: { mentionCount: 2 },
    });
    expect(restored.listElementProjectionJobs()[0]?.status).toBe('completed');
    await restored.close();
  });
});
