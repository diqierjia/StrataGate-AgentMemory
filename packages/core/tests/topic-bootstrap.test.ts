import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StorageConflictError, StrataGate, type LoadedStrataGateState, type RawMessageIndexDelta,
  type StrataGateSnapshot } from '../src/index.js';
import { SqliteStorage } from '../src/sqlite.js';

const temporaryDirectories: string[] = [];
const namespace = 'project:bootstrap-boundary';
const options = { blockTurnSize: 1, disableElementProjection: true,
  summarizer: async () => ({ l0Title: '资料', l0Tags: [], l1Summary: '历史资料',
    l2Keypoints: [], shouldExtract: false }) };

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function databasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'stratagate-bootstrap-boundary-'));
  temporaryDirectories.push(directory);
  return join(directory, 'memory.db');
}

async function addEvent(memory: StrataGate, id: string): Promise<void> {
  const block = memory.listBlocks()[0]!;
  await memory.addEvent({ id, title: `部署记录 ${id}`, summary: `部署资料 ${id}`,
    sourceBlockId: block.id, sourceMessageIds: [block.l5Raw[0]!.id] });
}

async function createLegacyDatabase(database: string, count: number, runningSummary = false): Promise<StrataGateSnapshot> {
  const memory = await StrataGate.open({ ...options, database, namespace });
  let original: StrataGateSnapshot;
  try {
    await memory.appendTurn({ user: '原始历史资料', assistant: '已记录' });
    for (let index = 0; index < count; index += 1) await addEvent(memory, `history-${index}`);
    original = memory.exportSnapshot();
  } finally { await memory.close(); }
  if (runningSummary) {
    const storage = new SqliteStorage({ filename: database });
    try {
      const loaded = (await storage.load(namespace))!;
      loaded.snapshot.summaryJobs = [{ blockId: loaded.snapshot.blocks[0]!.id,
        status: 'running', attempts: 1, lastError: null, nextRetryAt: null,
        updatedAt: '2026-10-03T00:00:00Z' }];
      await storage.save(namespace, loaded.snapshot, loaded.revision);
      original = loaded.snapshot;
    } finally { await storage.close(); }
  }
  const legacy = new DatabaseSync(database);
  try { legacy.exec('DROP TABLE memory_topic_state'); } finally { legacy.close(); }
  delete original.memoryTopicState;
  return original;
}

describe('writer-open Bootstrap boundary', () => {
  it('completes an empty Bootstrap before the first Event in a new namespace', async () => {
    const database = await databasePath();
    const memory = await StrataGate.open({ ...options, database, namespace });
    try {
      expect(memory.storageRevision).toBe(1);
      expect(memory.getTopicBootstrapState()).toMatchObject({
        status: 'completed', sourceVersions: {}, failedEvents: 0,
      });
      expect(memory.getTopicBootstrapState()!.completedAt).not.toBeNull();
      await memory.appendTurn({ user: '第一条新资料', assistant: '已记录' });
      await addEvent(memory, 'first-incremental');
      expect(memory.getTopicBootstrapState()!.sourceVersions).toEqual({});
      expect(memory.hasPendingTopicWork('bootstrap')).toBe(false);
      expect(memory.hasPendingTopicWork('incremental')).toBe(true);
      const claim = (await memory.claimNextTopicProjection('incremental'))!;
      expect(claim.events.map(({ id }) => id)).toEqual(['first-incremental']);
      expect(memory.getTopicBootstrapState()!.sourceVersions).toEqual({});
    } finally { await memory.close(); }
    const ephemeral = StrataGate.inMemory(options);
    expect(ephemeral.getTopicBootstrapState()).toMatchObject({ status: 'completed', sourceVersions: {} });
  });

  it('freezes an old namespace at writer open, before any claim or later Event', async () => {
    const database = await databasePath();
    const original = await createLegacyDatabase(database, 3);
    let memory = await StrataGate.open({ ...options, database, namespace });
    try {
      const frozen = memory.getTopicBootstrapState()!;
      expect(frozen.status).toBe('pending');
      expect(Object.keys(frozen.sourceVersions).sort()).toEqual(['history-0', 'history-1', 'history-2']);
      expect(memory.listTopicProjectionJobs()).toEqual([]);
      expect(memory.listMemoryTopics()).toHaveLength(3);
      expect(memory.exportSnapshot().events).toEqual(original.events);
      expect(memory.exportSnapshot().blocks).toEqual(original.blocks);
      const revision = memory.storageRevision;
      await memory.close();
      memory = await StrataGate.open({ ...options, database, namespace });
      expect(memory.storageRevision).toBe(revision);
      expect(memory.getTopicBootstrapState()).toEqual(frozen);
      await addEvent(memory, 'after-open');
      expect(memory.getTopicBootstrapState()!.sourceVersions).toEqual(frozen.sourceVersions);
      const incremental = (await memory.claimNextTopicProjection('incremental'))!;
      expect(incremental.events.map(({ id }) => id)).toEqual(['after-open']);
      expect(memory.getTopicBootstrapState()!.sourceVersions).toEqual(frozen.sourceVersions);
    } finally { await memory.close(); }
  });

  it('opens old storage read-only without creating Bootstrap, migrating, recovering a job, or saving settings', async () => {
    const database = await databasePath();
    const original = await createLegacyDatabase(database, 2, true);
    const storage = new SqliteStorage({ filename: database, readonly: true });
    const save = vi.spyOn(storage, 'save');
    let memory: StrataGate | undefined;
    try {
      const before = (await storage.load(namespace))!;
      memory = await StrataGate.openWithStorage({ storage, namespace, ...options, blockTurnSize: 2 });
      expect(memory.getTopicBootstrapState()).toBeNull();
      expect(memory.blockTurnSize).toBe(original.blockTurnSize);
      expect(memory.listSummaryJobs()).toEqual(original.summaryJobs);
      expect(memory.exportSnapshot().events).toEqual(original.events);
      expect(memory.listMemoryTopics()).toHaveLength(2);
      expect(save).not.toHaveBeenCalled();
      const after = (await storage.load(namespace))!;
      expect(after).toEqual(before);
      const check = new DatabaseSync(database, { readOnly: true });
      try {
        expect(check.prepare("SELECT name FROM sqlite_master WHERE name = 'memory_topic_state'").get()).toBeUndefined();
      } finally { check.close(); }
    } finally {
      save.mockRestore();
      if (memory) await memory.close();
      else await storage.close();
    }
  });

  it('preserves the winning frozen set and subsequent Event when two first writers compete', async () => {
    const database = await databasePath();
    await createLegacyDatabase(database, 3);
    let releaseLoaded!: () => void;
    const loadedBarrier = new Promise<void>((resolve) => { releaseLoaded = resolve; });
    let releaseLoser!: () => void;
    const loserBarrier = new Promise<void>((resolve) => { releaseLoser = resolve; });
    let initialLoads = 0;
    let conflicts = 0;
    class CoordinatedStorage extends SqliteStorage {
      private initialLoad = true;
      private initialSave = true;
      constructor(private readonly loser: boolean) { super({ filename: database }); }
      override async load(key: string): Promise<LoadedStrataGateState | null> {
        const loaded = await super.load(key);
        if (this.initialLoad) {
          this.initialLoad = false;
          initialLoads += 1;
          if (initialLoads === 2) releaseLoaded();
          await loadedBarrier;
        }
        return loaded;
      }
      override async save(key: string, snapshot: StrataGateSnapshot, expectedRevision: number,
        rawMessageIndexDelta?: RawMessageIndexDelta): Promise<number> {
        if (this.initialSave) {
          this.initialSave = false;
          if (this.loser) await loserBarrier;
        }
        try { return await super.save(key, snapshot, expectedRevision, rawMessageIndexDelta); }
        catch (error) {
          if (error instanceof StorageConflictError) conflicts += 1;
          throw error;
        }
      }
    }
    const firstStorage = new CoordinatedStorage(false);
    const secondStorage = new CoordinatedStorage(true);
    const firstOpening = StrataGate.openWithStorage({ ...options, storage: firstStorage, namespace });
    const secondOpening = StrataGate.openWithStorage({ ...options, storage: secondStorage, namespace });
    let first: StrataGate | undefined;
    let second: StrataGate | undefined;
    // Capture failure immediately so a deliberately delayed competitor cannot
    // create an unhandled rejection while the winning writer is being tested.
    const secondSettled = secondOpening.then((value) => ({ value }), (error: unknown) => ({ error }));
    try {
      first = await firstOpening;
      const frozen = first.getTopicBootstrapState()!;
      expect(Object.keys(frozen.sourceVersions)).toHaveLength(3);
      await addEvent(first, 'after-winner-open');
      releaseLoser();
      const settled = await secondSettled;
      if ('error' in settled) throw settled.error;
      second = settled.value;
      expect(conflicts).toBe(1);
      expect(second.getTopicBootstrapState()).toEqual(frozen);
      expect(second.listEvents().map(({ id }) => id).sort())
        .toEqual(['after-winner-open', 'history-0', 'history-1', 'history-2']);
      const incremental = (await second.claimNextTopicProjection('incremental'))!;
      expect(incremental.events.map(({ id }) => id)).toEqual(['after-winner-open']);
      expect(second.getTopicBootstrapState()!.sourceVersions['after-winner-open']).toBeUndefined();
    } finally {
      releaseLoaded(); releaseLoser();
      await Promise.allSettled([firstOpening, secondOpening]);
      if (first) await first.close(); else await firstStorage.close();
      if (second) await second.close(); else await secondStorage.close();
    }
  });
});
