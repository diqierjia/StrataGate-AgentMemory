import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { emptyProfile, PROFILE_FIELDS, PROFILE_MAINTAINABLE_FIELDS, PROFILE_MAINTENANCE_TOTAL_THRESHOLD, PROFILE_PROTECTED_SHORT_FIELDS, PROFILE_TOTAL_MAX_LENGTH, profileLength, profileMaintenanceDue, renderPersistentProfile } from '../src/profile.js';
import { SqliteStorage } from '../src/sqlite.js';

describe('installation-wide Persistent Profile', () => {
  it('starts with twelve empty fields and updates independent language fields across connections and namespaces', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-profile-'));
    const filename = join(directory, 'memory.db');
    try {
      const first = new SqliteStorage({ filename });
      expect(first.getPersistentProfile()).toEqual(emptyProfile());
      expect(Object.keys(first.getPersistentProfile())).toHaveLength(12);
      expect(Object.keys(PROFILE_FIELDS)).toHaveLength(12);
      expect(PROFILE_FIELDS.reasoningLanguage.maxLength).toBe(100);
      expect(PROFILE_TOTAL_MAX_LENGTH).toBe(6000);
      expect(PROFILE_MAINTENANCE_TOTAL_THRESHOLD).toBe(4800);
      expect(first.updateProfileField('preferredLanguage', '中文', 'user_explicit', 'msg-1'))
        .toEqual({ field: 'preferredLanguage', value: '中文', modified: true });
      expect(first.updateProfileField('preferredLanguage', '中文', 'agent_tool').modified).toBe(false);
      expect(first.getPersistentProfile()).toEqual({ ...emptyProfile(), preferredLanguage: '中文' });
      expect(first.getProfileChanges()).toEqual([expect.objectContaining({
        field: 'preferredLanguage', oldValue: '', newValue: '中文', source: 'user_explicit', sourceMessageId: 'msg-1',
      })]);
      expect(() => first.updateProfileField('unknown', 'x', 'settings')).toThrow(/Unknown/);
      expect(() => first.updateProfileField('preferredLanguage', 'x'.repeat(101), 'settings')).toThrow(/100 characters/);
      expect(() => first.updateProfileField('reasoningLanguage', 'x'.repeat(101), 'settings')).toThrow(/100 characters/);
      expect(first.getPersistentProfile().preferredLanguage).toBe('中文');
      expect(first.getPersistentProfile().reasoningLanguage).toBe('');
      await first.close();
      const second = new SqliteStorage({ filename });
      expect(second.listNamespaces()).toEqual([]);
      expect(second.getPersistentProfile()).toEqual({ ...emptyProfile(), preferredLanguage: '中文' });
      expect(second.getProfileSnapshot().profile.reasoningLanguage).toBe('');
      expect(second.getProfileSnapshot().revisions.reasoningLanguage).toBe(0);
      expect(second.updateProfileField('reasoningLanguage', '中文', 'agent_tool').modified).toBe(true);
      expect(second.getPersistentProfile()).toEqual({ ...emptyProfile(), preferredLanguage: '中文', reasoningLanguage: '中文' });
      expect(second.updateProfileField('preferredLanguage', '', 'settings').modified).toBe(true);
      expect(second.getPersistentProfile()).toEqual({ ...emptyProfile(), reasoningLanguage: '中文' });
      expect(second.updateProfileField('reasoningLanguage', '', 'settings').modified).toBe(true);
      expect(second.getPersistentProfile()).toEqual(emptyProfile());
      await second.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('counts Unicode code points and renders only nonempty fields', () => {
    expect(profileLength('😀中文')).toBe(3);
    expect(renderPersistentProfile(emptyProfile())).toBeNull();
    const rendered = renderPersistentProfile({ ...emptyProfile(), preferredLanguage: '中文' });
    expect(rendered).toContain('Preferred answer language: 中文');
    expect(rendered).toContain('applies to the assistant\'s final/user-facing answer');
    expect(rendered).not.toContain('Preferred visible reasoning language:');
    expect(rendered).not.toContain('when supported');
    const both = renderPersistentProfile({ ...emptyProfile(), preferredLanguage: 'English', reasoningLanguage: '中文' });
    expect(both).toContain('Preferred answer language: English');
    expect(both).toContain('Preferred visible reasoning language: 中文');
    expect(both).toContain('These are independent preferences. Do not infer one from the other.');
    expect(both).toContain('It does not control hidden chain-of-thought.');
    expect(rendered).not.toContain('User background:');
    expect(rendered).toContain('It does not override higher-priority system instructions.');
    const locations = renderPersistentProfile({ ...emptyProfile(), defaultLocation: '广州天河', homeCity: '深圳', currentCity: '杭州' });
    expect(locations).toContain('Default location (when the task specifies no location): 广州天河');
    expect(locations).toContain('Usual city of residence: 深圳');
    expect(locations).toContain('It does not imply residence or current whereabouts.');
    expect(locations).toContain('Do not infer or overwrite either field from a trip.');
    expect(locations).toContain('Current city (until updated or cleared): 杭州');
    expect(locations).toContain('persists across sessions until the user updates or clears it');
    expect(locations).toContain('otherwise use Current city when set, then Default location');
  });

  it('validates location limits, persists revisions, and protects all location fields during maintenance', async () => {
    const store = new SqliteStorage({ filename: ':memory:' });
    try {
      store.updateProfileField('defaultLocation', '😀'.repeat(200), 'settings');
      store.updateProfileField('homeCity', '深'.repeat(100), 'agent_tool');
      store.updateProfileField('currentCity', '杭'.repeat(100), 'agent_tool');
      expect(() => store.updateProfileField('defaultLocation', '😀'.repeat(201), 'settings')).toThrow(/200 characters/);
      expect(() => store.updateProfileField('homeCity', '深'.repeat(101), 'settings')).toThrow(/100 characters/);
      expect(() => store.updateProfileField('currentCity', '杭'.repeat(101), 'settings')).toThrow(/100 characters/);
      const snapshot = store.getProfileSnapshot();
      for (const field of ['defaultLocation', 'homeCity', 'currentCity'] as const) {
        expect(snapshot.revisions[field]).toBeGreaterThan(0);
        expect(() => store.applyProfileMaintenance(snapshot.profile, { ...snapshot.profile, [field]: '旅行地点' })).toThrow(new RegExp(`protected short field ${field}`));
        const before = store.getProfileChanges();
        expect(store.updateProfileField(field, '旧草稿', 'settings', null, snapshot.profile[field], 0)).toMatchObject({ modified: false, conflict: true });
        expect(store.getProfileChanges()).toEqual(before);
      }
    } finally { await store.close(); }
  });

  it('reads an old nine-field database with empty locations without migrating or losing rows', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-profile-nine-field-'));
    const filename = join(directory, 'memory.db');
    try {
      const first = new SqliteStorage({ filename });
      const oldFields = Object.keys(PROFILE_FIELDS).filter((field) => !['defaultLocation', 'homeCity', 'currentCity'].includes(field));
      for (const field of oldFields) first.updateProfileField(field, `old-${field}`, 'settings');
      const oldChanges = first.getProfileChanges();
      await first.close();
      const db = new DatabaseSync(filename);
      const beforeVersion = db.prepare('PRAGMA user_version').get();
      const beforeRows = db.prepare('SELECT * FROM persistent_profile ORDER BY field').all();
      db.close();
      const reopened = new SqliteStorage({ filename });
      expect(reopened.getPersistentProfile()).toEqual({ ...emptyProfile(), ...Object.fromEntries(oldFields.map((field) => [field, `old-${field}`])) });
      expect(reopened.getProfileSnapshot().revisions).toMatchObject({ defaultLocation: 0, homeCity: 0, currentCity: 0 });
      expect(reopened.getProfileChanges()).toEqual(oldChanges);
      await reopened.close();
      const after = new DatabaseSync(filename);
      expect(after.prepare('PRAGMA user_version').get()).toEqual(beforeVersion);
      expect(after.prepare('SELECT * FROM persistent_profile ORDER BY field').all()).toEqual(beforeRows);
      after.close();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('reads an eleven-field Profile without interpreting homeCity as the new currentCity', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-profile-eleven-field-'));
    const filename = join(directory, 'memory.db');
    try {
      const old = new SqliteStorage({ filename });
      for (const field of Object.keys(PROFILE_FIELDS).filter((field) => field !== 'currentCity')) {
        old.updateProfileField(field, field === 'homeCity' ? '深圳' : `old-${field}`, 'settings');
      }
      const audit = old.getProfileChanges();
      await old.close();
      const snapshot = () => {
        const db = new DatabaseSync(filename);
        try { return { version: db.prepare('PRAGMA user_version').get(), rows: db.prepare('SELECT * FROM persistent_profile ORDER BY field').all() }; }
        finally { db.close(); }
      };
      const before = snapshot();
      expect(before.rows).toHaveLength(11);
      const reopened = new SqliteStorage({ filename });
      expect(reopened.getPersistentProfile()).toMatchObject({ homeCity: '深圳', currentCity: '' });
      expect(reopened.getProfileSnapshot().revisions.currentCity).toBe(0);
      expect(reopened.getProfileChanges()).toEqual(audit);
      await reopened.close();
      expect(snapshot()).toEqual(before);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('triggers maintenance by time or either capacity threshold and records only changed fields', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-profile-maintenance-'));
    const filename = join(directory, 'memory.db');
    try {
      const storage = new SqliteStorage({ filename });
      const empty = storage.getPersistentProfile();
      expect(profileMaintenanceDue(empty, null)).toBe(false);
      storage.updateProfileField('responsePreferences', 'A. A.', 'settings');
      const current = storage.getPersistentProfile();
      const startedAt = storage.getProfileMaintenanceStartedAt()!;
      expect(() => storage.applyProfileMaintenance(current, { ...current, reasoningLanguage: '中文' })).toThrow(/protected short field reasoningLanguage/);
      expect(() => storage.applyProfileMaintenance(current, { ...current, preferredLanguage: '中文' })).toThrow(/protected short field preferredLanguage/);
      expect(profileMaintenanceDue(current, null)).toBe(false);
      expect(storage.profileMaintenanceDue(Date.parse(startedAt) + 24 * 60 * 60 * 1000 - 1)).toBe(false);
      expect(storage.profileMaintenanceDue(Date.parse(startedAt) + 24 * 60 * 60 * 1000)).toBe(true);
      await storage.close();
      const reopened = new SqliteStorage({ filename });
      expect(reopened.getProfileMaintenanceStartedAt()).toBe(startedAt);
      expect(reopened.profileMaintenanceDue(Date.parse(startedAt) + 60 * 60 * 1000)).toBe(false);
      expect(reopened.applyProfileMaintenance(current, { ...current, responsePreferences: 'A.' }, new Date(Date.parse(startedAt) + 24 * 60 * 60 * 1000).toISOString())).toBe(true);
      expect(reopened.getProfileChanges().at(-1)).toMatchObject({ source: 'maintenance', oldValue: 'A. A.', newValue: 'A.' });
      const last = reopened.getProfileMaintenanceState()!.lastSucceededAt;
      expect(reopened.profileMaintenanceDue(Date.parse(last) + 72 * 60 * 60 * 1000)).toBe(false);
      reopened.updateProfileField('responsePreferences', 'x'.repeat(800), 'settings');
      expect(reopened.profileMaintenanceDue()).toBe(true);
      expect(reopened.applyProfileMaintenance(current, current)).toBe(false);
      expect(reopened.getPersistentProfile().responsePreferences).toHaveLength(800);
      await reopened.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    expect(profileMaintenanceDue({ ...emptyProfile(), userBackground: 'x'.repeat(1500), responsePreferences: 'x'.repeat(1000),
      standingInstructions: 'x'.repeat(1000), persistentNotes: 'x'.repeat(1200), userPreferredName: 'x'.repeat(100) }, new Date().toISOString())).toBe(true);
    expect(profileMaintenanceDue({ ...emptyProfile(), userPreferredName: 'x'.repeat(80) }, null)).toBe(false);
    expect(profileMaintenanceDue({ ...emptyProfile(), userPreferredName: 'x'.repeat(80), assistantPreferredName: 'x'.repeat(80),
      preferredLanguage: 'x'.repeat(80), responsePreferences: 'x'.repeat(800), standingInstructions: 'x'.repeat(800),
      userBackground: 'x'.repeat(1200), longTermGoals: 'x'.repeat(800), persistentNotes: 'x'.repeat(960) }, null)).toBe(true);
  });

  it('uses first nonempty write as a durable time basis and allows early capacity maintenance', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-profile-first-write-'));
    const filename = join(directory, 'memory.db');
    try {
      const first = new SqliteStorage({ filename });
      first.updateProfileField('responsePreferences', '简洁', 'agent_tool');
      const startedAt = first.getProfileMaintenanceStartedAt()!;
      const hour = 60 * 60 * 1000;
      expect(first.profileMaintenanceDue(Date.parse(startedAt) + 23 * hour)).toBe(false);
      first.updateProfileField('responsePreferences', 'x'.repeat(800), 'agent_tool');
      expect(first.getProfileMaintenanceStartedAt()).toBe(startedAt);
      expect(first.profileMaintenanceDue(Date.parse(startedAt) + hour)).toBe(true);
      first.updateProfileField('responsePreferences', '', 'settings');
      expect(first.getProfileMaintenanceStartedAt()).toBeNull();
      first.updateProfileField('responsePreferences', '简洁', 'settings');
      expect(first.profileMaintenanceDue()).toBe(false);
      await first.close();
      const reopened = new SqliteStorage({ filename });
      const newStartedAt = reopened.getProfileMaintenanceStartedAt()!;
      expect(reopened.profileMaintenanceDue(Date.parse(newStartedAt) + 23 * hour)).toBe(false);
      expect(reopened.profileMaintenanceDue(Date.parse(newStartedAt) + 24 * hour)).toBe(true);
      await reopened.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(PROFILE_PROTECTED_SHORT_FIELDS)('never maintains protected field %s alone or because of its capacity', (field) => {
    const start = '2026-10-01T00:00:00.000Z';
    const now = Date.parse(start);
    const profile = { ...emptyProfile(), [field]: 'x'.repeat(PROFILE_FIELDS[field].maxLength) };
    expect(profileMaintenanceDue(profile, start, now + 7 * 24 * 60 * 60 * 1000)).toBe(false);
    expect(profileMaintenanceDue({ ...profile, persistentNotes: 'new note' }, start, now)).toBe(false);
  });

  it.each(PROFILE_MAINTAINABLE_FIELDS)('retains time and single-field capacity triggers for %s', (field) => {
    const start = '2026-10-01T00:00:00.000Z';
    const now = Date.parse(start);
    const profile = { ...emptyProfile(), [field]: 'new content' };
    expect(profileMaintenanceDue(profile, start, now + 24 * 60 * 60 * 1000 - 1)).toBe(false);
    expect(profileMaintenanceDue(profile, start, now + 24 * 60 * 60 * 1000)).toBe(true);
    expect(profileMaintenanceDue({ ...profile, [field]: '😀'.repeat(PROFILE_FIELDS[field].maxLength * 0.8) }, start, now)).toBe(true);
  });

  it('retains the total capacity trigger below every maintainable single-field threshold', () => {
    const profile = { ...emptyProfile(), responsePreferences: 'x'.repeat(700), standingInstructions: 'x'.repeat(700),
      userBackground: 'x'.repeat(1100), longTermGoals: 'x'.repeat(700), persistentNotes: 'x'.repeat(800) };
    for (const field of PROFILE_PROTECTED_SHORT_FIELDS) profile[field] = 'x'.repeat(PROFILE_FIELDS[field].maxLength);
    expect(profileMaintenanceDue(profile, null)).toBe(true);
    profile.persistentNotes = profile.persistentNotes.slice(1);
    expect(profileMaintenanceDue(profile, null)).toBe(false);
  });

  it.each([false, true])('persists successful maintenance suppression (model compresses: %s)', async (compresses) => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-profile-maintained-'));
    const filename = join(directory, 'memory.db');
    const hour = 60 * 60 * 1000;
    try {
      const first = new SqliteStorage({ filename });
      for (const field of PROFILE_PROTECTED_SHORT_FIELDS) first.updateProfileField(field, 'original', 'settings');
      const protectedStartedAt = Date.parse(first.getProfileMaintenanceStartedAt()!);
      expect(first.profileMaintenanceDue(protectedStartedAt + 7 * 24 * hour)).toBe(false);
      first.updateProfileField('responsePreferences', 'x'.repeat(800), 'settings');
      const snapshot = first.getPersistentProfile();
      const succeededAt = protectedStartedAt + 24 * hour;
      const result = { ...snapshot, responsePreferences: compresses ? 'shorter' : snapshot.responsePreferences };
      expect(first.profileMaintenanceDue(succeededAt)).toBe(true);
      expect(first.applyProfileMaintenance(snapshot, result, new Date(succeededAt).toISOString())).toBe(true);
      expect(first.getProfileMaintenanceState()!.inputJson).toBe(JSON.stringify(result));
      for (const days of [1, 2, 7]) expect(first.profileMaintenanceDue(succeededAt + days * 24 * hour)).toBe(false);
      for (const field of PROFILE_PROTECTED_SHORT_FIELDS) {
        first.updateProfileField(field, 'x'.repeat(PROFILE_FIELDS[field].maxLength), 'settings');
        expect(first.profileMaintenanceDue(succeededAt + 7 * 24 * hour)).toBe(false);
      }
      await first.close();
      const reopened = new SqliteStorage({ filename });
      expect(reopened.profileMaintenanceDue(succeededAt + 30 * 24 * hour)).toBe(false);
      // New maintainable content still obeys time/capacity and failed-attempt backoff.
      reopened.updateProfileField('responsePreferences', 'new preference', 'settings');
      expect(reopened.profileMaintenanceDue(succeededAt + 23 * hour)).toBe(false);
      expect(reopened.profileMaintenanceDue(succeededAt + 24 * hour)).toBe(true);
      reopened.recordProfileMaintenanceFailure(reopened.getPersistentProfile(), succeededAt + 24 * hour);
      expect(reopened.profileMaintenanceDue(succeededAt + 24 * hour + 1000)).toBe(false);
      expect(reopened.profileMaintenanceDue(succeededAt + 24 * hour + 5 * 60 * 1000)).toBe(true);
      for (const field of PROFILE_MAINTAINABLE_FIELDS) {
        const current = reopened.getPersistentProfile();
        expect(reopened.applyProfileMaintenance(current, current, new Date(succeededAt).toISOString())).toBe(true);
        reopened.updateProfileField(field, 'x'.repeat(PROFILE_FIELDS[field].maxLength * 0.8), 'settings');
        expect(reopened.profileMaintenanceDue(succeededAt + hour)).toBe(true);
      }
      await reopened.close();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('bounds failed maintenance attempts durably until Profile content changes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-profile-retry-'));
    const filename = join(directory, 'memory.db');
    try {
      const first = new SqliteStorage({ filename });
      first.updateProfileField('responsePreferences', '中文'.repeat(500), 'settings');
      const snapshot = first.getPersistentProfile();
      const start = Date.parse('2026-09-23T00:00:00.000Z');
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        first.recordProfileMaintenanceFailure(snapshot, start + attempt * 60 * 60 * 1000);
        expect(first.profileMaintenanceDue(start + attempt * 60 * 60 * 1000 + 1000)).toBe(false);
      }
      await first.close();
      const reopened = new SqliteStorage({ filename });
      expect(reopened.profileMaintenanceDue(start + 26 * 60 * 60 * 1000)).toBe(false);
      expect(reopened.profileMaintenanceDue(start + 28 * 60 * 60 * 1000)).toBe(true);
      reopened.recordProfileMaintenanceFailure(snapshot, start + 28 * 60 * 60 * 1000);
      expect(reopened.profileMaintenanceDue(start + 28 * 60 * 60 * 1000 + 1000)).toBe(false);
      reopened.updateProfileField('responsePreferences', '中文'.repeat(499), 'settings');
      expect(reopened.profileMaintenanceDue(start + 48 * 60 * 60 * 1000)).toBe(true);
      await reopened.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects a stale Settings edit inside the write transaction without changing audit history', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-profile-conflict-'));
    const filename = join(directory, 'memory.db');
    try {
      const store = new SqliteStorage({ filename });
      store.updateProfileField('responsePreferences', 'A', 'settings');
      const firstRevision = store.getProfileSnapshot().revisions.responsePreferences;
      store.updateProfileField('preferredLanguage', '中文', 'agent_tool');
      expect(store.updateProfileField('responsePreferences', 'C', 'settings', null, 'A', firstRevision)).toMatchObject({ modified: true });
      store.updateProfileField('responsePreferences', 'B', 'maintenance');
      const before = store.getProfileChanges().length;
      expect(store.updateProfileField('responsePreferences', 'stale C', 'settings', null, 'C', firstRevision + 1)).toMatchObject({ conflict: true, modified: false, value: 'B' });
      expect(store.getPersistentProfile().responsePreferences).toBe('B');
      expect(store.getProfileChanges()).toHaveLength(before);
      store.updateProfileField('responsePreferences', 'A', 'agent_tool');
      store.updateProfileField('responsePreferences', 'B', 'maintenance');
      const afterReturn = store.getProfileChanges().length;
      expect(store.updateProfileField('responsePreferences', 'stale after A→B→A→B', 'settings', null, 'B', firstRevision + 2)).toMatchObject({ conflict: true, modified: false, value: 'B' });
      expect(store.getProfileChanges()).toHaveLength(afterReturn);
      await store.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('opens a database containing only the former eight fields without losing them', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-profile-eight-field-'));
    const filename = join(directory, 'memory.db');
    try {
      const legacyFields = Object.keys(PROFILE_FIELDS).filter((field) => !['reasoningLanguage', 'defaultLocation', 'homeCity', 'currentCity'].includes(field));
      const first = new SqliteStorage({ filename });
      for (const field of legacyFields) first.updateProfileField(field, `old-${field}`, 'settings');
      await first.close();
      const reopened = new SqliteStorage({ filename });
      const profile = reopened.getPersistentProfile();
      expect(Object.keys(profile)).toHaveLength(12);
      expect(profile.reasoningLanguage).toBe('');
      expect(profile.currentCity).toBe('');
      for (const field of legacyFields) expect(profile[field as keyof typeof profile]).toBe(`old-${field}`);
      expect(reopened.getProfileSnapshot().revisions.reasoningLanguage).toBe(0);
      await reopened.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('backfills a pre-fix v12 Profile and removes consent-only index without losing audit rows', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-profile-v12-'));
    const filename = join(directory, 'memory.db');
    try {
      const first = new SqliteStorage({ filename });
      first.updateProfileField('preferredLanguage', '中文', 'agent_tool', 'msg-1');
      const firstWriteAt = first.getProfileChanges()[0]!.updatedAt;
      await first.close();
      const old = new DatabaseSync(filename);
      old.exec("DROP TABLE persistent_profile_maintenance_baseline; CREATE UNIQUE INDEX persistent_profile_single_consent ON persistent_profile_changes (source_message_id) WHERE source = 'agent_tool' AND source_message_id IS NOT NULL;");
      old.close();
      const reopened = new SqliteStorage({ filename });
      expect(reopened.getProfileMaintenanceStartedAt()).toBe(firstWriteAt);
      expect(reopened.profileMaintenanceDue(Date.parse(firstWriteAt) + 60 * 60 * 1000)).toBe(false);
      expect(reopened.getProfileChanges()).toHaveLength(1);
      reopened.updateProfileField('userPreferredName', '橙子', 'agent_tool', 'msg-1');
      expect(reopened.getProfileChanges()).toHaveLength(2);
      await reopened.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('upgrades a version 11 database without losing existing rows', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-profile-migration-'));
    const filename = join(directory, 'memory.db');
    try {
      const first = new SqliteStorage({ filename });
      await first.close();
      const old = new DatabaseSync(filename);
      old.exec("INSERT INTO memory_spaces (namespace, schema_version, revision, current_turn, block_turn_size, block_decay_lambda, created_at, updated_at) VALUES ('legacy:project', 11, 2, 1, 6, 0.3, '2026-01-01', '2026-01-01'); DROP TABLE persistent_profile_changes; DROP TABLE persistent_profile_maintenance; DROP TABLE persistent_profile; PRAGMA user_version = 11;");
      old.close();
      const upgraded = new SqliteStorage({ filename });
      expect(upgraded.listNamespaces()).toEqual(['legacy:project']);
      expect(upgraded.getPersistentProfile()).toEqual(emptyProfile());
      expect(upgraded.updateProfileField('preferredLanguage', '中文', 'settings').modified).toBe(true);
      await upgraded.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
