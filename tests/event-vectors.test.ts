import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { StrataGate } from '@diqier/stratagate'
import { SqliteStorage } from '@diqier/stratagate/sqlite'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })

let sequence = 0
const ids = () => (prefix: 'msg' | 'blk' | 'evt') => `${prefix}_${++sequence}`
const nonExtractingSummarizer = async () => ({
  l0Title: 'turns', l0Tags: [], l1Summary: 'turns', l2Keypoints: [], shouldExtract: false,
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'stratagate-vectors-'))
  roots.push(root)
  return { filename: join(root, 'memory.db') }
}

/**
 * The legacy shape of the side table: a foreign key that only the passive
 * `events` pool can satisfy. This is exactly what an early build created, and
 * it is what makes writing a vector for an agent-recorded Event fail.
 */
const LEGACY_VECTOR_SCHEMA = `
CREATE TABLE IF NOT EXISTS event_vectors (
  namespace TEXT NOT NULL,
  event_id TEXT NOT NULL,
  model TEXT NOT NULL,
  dimension INTEGER NOT NULL,
  vector_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (namespace, event_id, model),
  FOREIGN KEY (namespace, event_id) REFERENCES events(namespace, id)
) STRICT;
`

/** A minimal passthrough table so the legacy foreign key has something to point at. */
const MINIMAL_EVENTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  namespace TEXT NOT NULL,
  id TEXT NOT NULL,
  PRIMARY KEY (namespace, id)
) STRICT;
`

describe('Event vector storage', () => {
  it('rejects an agent-recorded vector under the legacy cross-pool foreign key', async () => {
    const { filename } = await fixture()
    const database = new DatabaseSync(filename)
    try {
      database.exec('PRAGMA foreign_keys = ON')
      database.exec(MINIMAL_EVENTS_SCHEMA)
      database.exec(LEGACY_VECTOR_SCHEMA)
      database.prepare('INSERT INTO events (namespace, id) VALUES (?, ?)').run('ns', 'evt_passive')
      // Passive pool: allowed by the constraint.
      database.prepare('INSERT INTO event_vectors VALUES (?, ?, ?, ?, ?, ?)')
        .run('ns', 'evt_passive', 'm', 2, '[1,0]', '2026-10-01T00:00:00.000Z')
      // Agent pool: the same row shape, but the Event lives in agent_events.
      expect(() => database.prepare('INSERT INTO event_vectors VALUES (?, ?, ?, ?, ?, ?)')
        .run('ns', 'evt_agent', 'm', 2, '[0,1]', '2026-10-01T00:00:00.000Z'))
        .toThrow(/FOREIGN KEY constraint failed/)
    } finally {
      database.close()
    }
  })

  it('rebuilds a legacy side table in place, keeps existing rows, then accepts agent vectors', async () => {
    const { filename } = await fixture()
    // Build a real database first, then age the side table back to the legacy
    // shape — exactly the state an earlier build of this feature leaves behind.
    const seeded = await StrataGate.open({ database: filename, namespace: 'ns', blockTurnSize: 1,
      idFactory: ids(), summarizer: nonExtractingSummarizer })
    let passiveId = ''
    let agentId = ''
    try {
      await seeded.appendTurn({ user: 'The release train leaves on Friday.', assistant: 'Noted.' }, { deferDerivation: true })
      const block = seeded.listBlocks()[0]!
      passiveId = (await seeded.addEvent({
        title: 'Release train on Friday',
        summary: 'Releases leave on Friday.',
        sourceBlockId: block.id,
        sourceMessageIds: [block.l5Raw[0]!.id],
      })).id
      agentId = (await seeded.recordAgentEvent({ content: 'Preference: pnpm as package manager.', category: 'preference', threadId: 's' })).eventId!
      seeded.setEventVector(passiveId, 'm', 2, [1, 0])
    } finally {
      await seeded.close()
    }
    const seed = new DatabaseSync(filename)
    try {
      seed.exec('PRAGMA foreign_keys = ON')
      seed.exec('DROP TABLE event_vectors')
      seed.exec(LEGACY_VECTOR_SCHEMA)
      seed.prepare('INSERT INTO event_vectors VALUES (?, ?, ?, ?, ?, ?)')
        .run('ns', passiveId, 'm', 2, '[1,0]', '2026-10-01T00:00:00.000Z')
      // Under the legacy constraint the agent-pool write fails; this is the bug.
      expect(() => seed.prepare('INSERT INTO event_vectors VALUES (?, ?, ?, ?, ?, ?)')
        .run('ns', agentId, 'm', 2, '[0,1]', '2026-10-01T00:00:00.000Z'))
        .toThrow(/FOREIGN KEY constraint failed/)
    } finally {
      seed.close()
    }

    const storage = new SqliteStorage({ filename })
    try {
      // Opening runs the migration: the legacy constraint is gone, the row is intact.
      const check = new DatabaseSync(filename, { readOnly: true })
      try {
        const row = check.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'event_vectors'")
          .get() as { sql: string }
        expect(row.sql).not.toContain('REFERENCES events')
      } finally {
        check.close()
      }
      // The rebuilt row predates the fingerprint column, so it has none. That is
      // itself meaningful: the read path treats a hash-less row as stale and
      // re-embeds it rather than trusting text it can no longer verify.
      expect(storage.getEventVector('ns', passiveId, 'm')).toEqual({ dimension: 2, vector: [1, 0], contentHash: null })

      // The whole point of the rebuild: the other pool now works too.
      expect(() => storage.setEventVector('ns', agentId, 'm', 2, [0, 1])).not.toThrow()
      expect(storage.listEventVectors('ns', 'm').get(agentId)).toEqual([0, 1])
      expect([...storage.listEventVectorIds('ns', 'm')].sort()).toEqual([agentId, passiveId].sort())
    } finally {
      await storage.close()
    }

    // Idempotent: a second open changes neither the table shape nor the rows.
    const again = new SqliteStorage({ filename })
    try {
      const check = new DatabaseSync(filename, { readOnly: true })
      try {
        const row = check.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'event_vectors'")
          .get() as { sql: string }
        expect(row.sql).not.toContain('REFERENCES events')
      } finally {
        check.close()
      }
      expect([...again.listEventVectors('ns', 'm').entries()].sort()).toEqual([[agentId, [0, 1]], [passiveId, [1, 0]]].sort())
    } finally {
      await again.close()
    }
  })


  it('persists vectors for both pools and sweeps only truly orphaned rows', async () => {
    const { filename } = await fixture()
    const memory = await StrataGate.open({ database: filename, namespace: 'ns', blockTurnSize: 1,
      idFactory: ids(), summarizer: nonExtractingSummarizer })
    let passiveId = ''
    let agentId = ''
    try {
      await memory.appendTurn({ user: 'The release train leaves on Friday.', assistant: 'Noted.' }, { deferDerivation: true })
      const block = memory.listBlocks()[0]!
      passiveId = (await memory.addEvent({
        title: 'Release train on Friday',
        summary: 'Releases leave on Friday.',
        sourceBlockId: block.id,
        sourceMessageIds: [block.l5Raw[0]!.id],
      })).id
      const recorded = await memory.recordAgentEvent({ content: '用户偏好 pnpm 作为包管理器。', category: 'preference', threadId: 'session-1' })
      expect(recorded.recorded).toBe(true)
      agentId = recorded.eventId!

      // Both pools write through the same public API — no storage casting.
      memory.setEventVector(passiveId, 'test-embed', 3, [1, 0, 0])
      memory.setEventVector(agentId, 'test-embed', 3, [0, 1, 0])
      expect(memory.listEventVectors('test-embed').get(passiveId)).toEqual([1, 0, 0])
      expect(memory.listEventVectors('test-embed').get(agentId)).toEqual([0, 1, 0])

      // A vector for an Event that exists in neither pool is a leftover.
      memory.setEventVector('evt_missing', 'test-embed', 3, [0, 0, 1])
    } finally {
      await memory.close()
    }

    const reopened = await StrataGate.open({ database: filename, namespace: 'ns', blockTurnSize: 1,
      idFactory: ids(), summarizer: nonExtractingSummarizer })
    try {
      const vectors = reopened.listEventVectors('test-embed')
      expect(vectors.has('evt_missing')).toBe(false)
      expect(vectors.get(passiveId)).toEqual([1, 0, 0])
      expect(vectors.get(agentId)).toEqual([0, 1, 0])
    } finally {
      await reopened.close()
    }
  })

  it('keeps vectors of a previously used model invisible to the current one', async () => {
    const { filename } = await fixture()
    const memory = await StrataGate.open({ database: filename, namespace: 'ns', blockTurnSize: 1,
      idFactory: ids(), summarizer: nonExtractingSummarizer })
    try {
      const recorded = await memory.recordAgentEvent({ content: '用户偏好 pnpm 作为包管理器。', category: 'preference', threadId: 's' })
      memory.setEventVector(recorded.eventId!, 'old-model', 2, [1, 0])
      expect(memory.listEventVectors('old-model').size).toBe(1)
      expect(memory.listEventVectors('new-model').size).toBe(0)
    } finally {
      await memory.close()
    }
  })
})

describe('Event search vector lane', () => {
  const openMemory = () => StrataGate.inMemory({
    blockTurnSize: 1,
    now: () => new Date('2026-10-01T00:00:00Z'),
    idFactory: ids(),
    summarizer: nonExtractingSummarizer,
  })

  it('reaches a semantically similar Event that shares no keyword with the query', async () => {
    const memory = openMemory()
    try {
      const recorded = await memory.recordAgentEvent({
        content: 'Preference: the team uses pnpm as its package manager.',
        category: 'preference',
        threadId: 's',
      })
      const agentId = recorded.eventId!
      // The Chinese query shares no searchable token with the English card, so
      // BM25 cannot find it — exactly the case the vector lane exists for.
      const query = '包管理器'
      expect(await memory.searchEvents(query)).toEqual([])
      const fused = await memory.searchEvents(query, { vectorRanking: [agentId], vectorWeight: 1 })
      expect(fused.map(({ event }) => event.id)).toEqual([agentId])
    } finally {
      await memory.close()
    }
  })

  it('behaves exactly like lexical retrieval when no ranking is supplied', async () => {
    const memory = openMemory()
    try {
      await memory.recordAgentEvent({ content: '用户偏好 pnpm 作为包管理器。', category: 'preference', threadId: 's' })
      const lexical = await memory.searchEvents('pnpm')
      expect(lexical).toHaveLength(1)
      expect(await memory.searchEvents('pnpm', { vectorRanking: [] })).toEqual(lexical)
      expect(await memory.searchEvents('pnpm', { vectorWeight: 0 })).toEqual(lexical)
    } finally {
      await memory.close()
    }
  })
})
