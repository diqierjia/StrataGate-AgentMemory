import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { StrataGate } from '../src/store.js'
import { SqliteStorage } from '../src/sqlite.js'
import { tokenContainment } from '../src/store.js'
import type { ExternalMemoryDecision } from '../src/types.js'

let sequence = 0

function ids() {
  return (prefix: 'msg' | 'blk' | 'evt') => `${prefix}_${++sequence}`;
}

const nonExtractingSummarizer = async () => ({
  l0Title: 'turns', l0Tags: [], l1Summary: 'turns', l2Keypoints: [], shouldExtract: false,
})

describe('tokenContainment', () => {
  it('measures shared unique tokens over the shorter side and floors coincidental overlap', () => {
    expect(tokenContainment([], ['a'])).toBe(0)
    expect(tokenContainment(['a', 'b'], [])).toBe(0)
    expect(tokenContainment(['a'], ['a', 'b'])).toBe(0) // fewer than 2 shared tokens
    expect(tokenContainment(['a', 'b', 'c'], ['a', 'b', 'x'])).toBeCloseTo(2 / 3)
    expect(tokenContainment(['a', 'b'], ['a', 'b', 'c', 'd'])).toBe(1)
    // Duplicated input tokens are deduplicated before measuring.
    expect(tokenContainment(['a', 'a', 'b'], ['a', 'b', 'x'])).toBe(1)
  })
})

describe('StrataGate.recordAgentEvent', () => {
  beforeEach(() => { sequence = 0 })

  const openMemory = () => StrataGate.inMemory({
    blockTurnSize: 1,
    now: (): Date => new Date('2026-09-23T08:00:00Z'),
    idFactory: ids(),
    summarizer: nonExtractingSummarizer,
    graphProjector: async () => ({ reason: 'projected', nodes: [], edges: [] }),
  })

  const seedPassiveEvent = async (memory: StrataGate): Promise<string> => {
    await memory.appendTurn(
      { user: 'The deployment pipeline uses GitHub Actions.', assistant: 'Noted.' },
      { deferDerivation: true },
    )
    const block = memory.listBlocks()[0]!
    const event = await memory.addEvent({
      title: 'Deployment pipeline uses GitHub Actions',
      summary: 'The deployment pipeline uses GitHub Actions for every release.',
      sourceBlockId: block.id,
      sourceMessageIds: [block.l5Raw[0]!.id],
    })
    return event.id
  }

  it('adds a clear-new fact without any decider call and isolates it in the agent pool', async () => {
    const memory = openMemory()
    const passiveId = await seedPassiveEvent(memory)
    let deciderCalls = 0
    const result = await memory.recordAgentEvent({
      content: '用户偏好 pnpm 作为包管理器。',
      category: 'preference',
      threadId: 'session-1',
      decider: async () => { deciderCalls += 1; return { action: 'IGNORE', confidence: 1 } },
    })
    expect(deciderCalls).toBe(0)
    expect(result).toMatchObject({ action: 'ADDED', gate: 'clear-new', recorded: true })
    expect(result.eventId).toBeDefined()
    expect(memory.listEvents().map(({ id }) => id)).toEqual([passiveId])
    const agentEvents = memory.listAgentEvents()
    expect(agentEvents).toHaveLength(1)
    expect(agentEvents[0]).toMatchObject({
      id: result.eventId,
      criticality: 'preference',
      scope: 'user',
      sourceBlockId: result.sourceBlockId,
    })
    expect(agentEvents[0]!.tags).toContain('agent-recorded')
    expect(agentEvents[0]!.tags).toContain('category:preference')
    expect(agentEvents[0]!.temporal.threadId).toBe('session-1')
    const sourceBlock = memory.listBlocks().find(({ id }) => id === result.sourceBlockId)
    expect(sourceBlock?.l0Tags).toContain('agent-memory')
    expect(sourceBlock?.shouldExtract).toBe(false)
    expect(sourceBlock?.threadId).toMatch(/^agent-memory:/)
    // The graph projection job is queued for the new agent event (the passive
    // event seeded its own job through addEvent).
    expect(memory.listGraphProjectionJobs()).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'pending', sourceEventIds: [result.eventId] }),
    ]))
  })

  it('reinforces instead of writing on an exact duplicate', async () => {
    const memory = openMemory()
    const first = await memory.recordAgentEvent({ content: '用户偏好 pnpm 作为包管理器。' })
    expect(first.action).toBe('ADDED')
    const beforeCount = memory.listAgentEvents()[0]!.weight.mentionCount
    const beforeTurn = memory.listAgentEvents()[0]!.weight.lastAdoptedTurn
    const second = await memory.recordAgentEvent({ content: '用户偏好 pnpm 作为包管理器。' })
    expect(second).toMatchObject({
      action: 'REINFORCED', gate: 'exact-duplicate', recorded: false, reinforcedEventId: first.eventId,
    })
    const after = memory.listAgentEvents()[0]!
    expect(memory.listAgentEvents()).toHaveLength(1)
    expect(after.weight.mentionCount).toBe(beforeCount + 1)
    expect(after.weight.lastAdoptedTurn).toBeGreaterThanOrEqual(beforeTurn)
  })

  it('reinforces on a near-duplicate without calling the decider', async () => {
    const memory = openMemory()
    await seedPassiveEvent(memory)
    let deciderCalls = 0
    const result = await memory.recordAgentEvent({
      content: 'The deployment pipeline',
      decider: async () => { deciderCalls += 1; return { action: 'ADD', confidence: 1 } },
    })
    expect(deciderCalls).toBe(0)
    expect(result).toMatchObject({ action: 'REINFORCED', gate: 'near-duplicate', recorded: false })
    expect(memory.listAgentEvents()).toHaveLength(0)
  })

  it('marks heuristic conflicts when matches are ambiguous and no decider exists', async () => {
    const memory = openMemory()
    const passiveId = await seedPassiveEvent(memory)
    const result = await memory.recordAgentEvent({ content: 'The deployment pipeline switched to GitLab.' })
    expect(result).toMatchObject({
      action: 'CONFLICT_MARKED', gate: 'heuristic-conflict', recorded: true,
      existingEventIds: [passiveId],
    })
    const agentEvent = memory.listAgentEvents()[0]!
    expect(agentEvent.temporal.conflictsWithEventIds).toEqual([passiveId])
    const passive = memory.listEvents().find(({ id }) => id === passiveId)!
    expect(passive.temporal.conflictsWithEventIds).toEqual([agentEvent.id])
    expect(passive.status).toBe('active')
  })

  it('applies a high-confidence decider SUPERSEDE across pools', async () => {
    const memory = openMemory()
    const passiveId = await seedPassiveEvent(memory)
    const result = await memory.recordAgentEvent({
      content: 'The deployment pipeline switched to GitLab.',
      decider: async ({ matches }): Promise<ExternalMemoryDecision> => ({
        action: 'SUPERSEDE',
        existingEventIds: [matches[0]!.event.id],
        confidence: 0.92,
        reason: '明确的新状态',
      }),
    })
    expect(result).toMatchObject({
      action: 'SUPERSEDED', gate: 'decider', recorded: true, existingEventIds: [passiveId], confidence: 0.92,
    })
    const passive = memory.listEvents().find(({ id }) => id === passiveId)!
    expect(passive.status).toBe('superseded')
    expect(passive.supersededBy).toBe(result.eventId)
    expect(passive.weight.forcedCap).toBe(0.1)
    expect(memory.listAgentEvents()[0]!.temporal.supersedesEventIds).toEqual([passiveId])
  })

  it('downgrades a low-confidence MERGE into a non-destructive conflict mark', async () => {
    const memory = openMemory()
    const passiveId = await seedPassiveEvent(memory)
    const result = await memory.recordAgentEvent({
      content: 'The deployment pipeline switched to GitLab.',
      decider: async ({ matches }): Promise<ExternalMemoryDecision> => ({
        action: 'MERGE',
        existingEventIds: [matches[0]!.event.id],
        mergedCandidate: { title: 'Merged pipeline memory', summary: 'The deployment pipeline moved from GitHub Actions to GitLab.' },
        confidence: 0.6,
      }),
    })
    expect(result).toMatchObject({
      action: 'CONFLICT_MARKED', gate: 'decider', recorded: true, downgradedFrom: 'MERGE', confidence: 0.6,
    })
    expect(memory.listEvents().find(({ id }) => id === passiveId)?.status).toBe('active')
    expect(memory.listAgentEvents()[0]!.temporal.conflictsWithEventIds).toEqual([passiveId])
  })

  it('keeps writing when the decider throws, and honors IGNORE decisions', async () => {
    const memory = openMemory()
    await seedPassiveEvent(memory)
    const failed = await memory.recordAgentEvent({
      content: 'The deployment pipeline switched to GitLab.',
      decider: async () => { throw new Error('model unavailable') },
    })
    expect(failed).toMatchObject({ action: 'CONFLICT_MARKED', gate: 'decider-error', recorded: true })

    const ignored = await memory.recordAgentEvent({
      content: 'The release pipeline now runs on TeamCity.',
      decider: async (): Promise<ExternalMemoryDecision> => ({
        action: 'IGNORE', confidence: 0.9, reason: '与现有记忆无实质差异',
      }),
    })
    expect(ignored).toMatchObject({ action: 'IGNORED', gate: 'decider', recorded: false, reason: '与现有记忆无实质差异' })
    expect(memory.listAgentEvents()).toHaveLength(1)
  })

  it('never holds the mutation queue while the decider runs and re-checks duplicates on apply', async () => {
    const memory = openMemory()
    await seedPassiveEvent(memory)
    let deciderEntered = false
    let releaseDecider: (decision: ExternalMemoryDecision) => void = () => {}
    const pending = memory.recordAgentEvent({
      content: 'The deployment pipeline switched to GitLab.',
      decider: async (): Promise<ExternalMemoryDecision> => {
        deciderEntered = true
        return new Promise<ExternalMemoryDecision>((resolve) => { releaseDecider = resolve })
      },
    })
    await vi.waitFor(() => expect(deciderEntered).toBe(true))
    // While the adjudication is in flight the mutation queue is free: a
    // concurrent record completes instead of deadlocking.
    const concurrent = await memory.recordAgentEvent({ content: 'The deployment pipeline switched to GitLab.' })
    expect(concurrent).toMatchObject({ action: 'CONFLICT_MARKED', gate: 'heuristic-conflict', recorded: true })
    releaseDecider({ action: 'ADD', confidence: 0.95 })
    const settled = await pending
    // Phase 3 re-scans duplicates: the concurrent record wins, the adjudicated
    // one reinforces it instead of writing a second card.
    expect(settled).toMatchObject({
      action: 'REINFORCED',
      gate: 'exact-duplicate',
      recorded: false,
      reinforcedEventId: concurrent.eventId,
    })
    expect(memory.listAgentEvents()).toHaveLength(1)
  })

  it('cites real open-tail conversation messages as provenance when available', async () => {
    // blockTurnSize 2 keeps the first turn in the open tail while recording.
    const memory = StrataGate.inMemory({
      blockTurnSize: 6,
      now: (): Date => new Date('2026-09-23T08:00:00Z'),
      idFactory: ids(),
      summarizer: nonExtractingSummarizer,
      graphProjector: async () => ({ reason: 'projected', nodes: [], edges: [] }),
    })
    await memory.appendTurn(
      { user: '记住：我偏好用 pnpm。', assistant: '好的，我记下了。', threadId: 'session-thread' },
      { deferDerivation: true },
    )
    const realMessages = memory.listOpenTail('session-thread')
    expect(realMessages.length).toBeGreaterThan(0)
    const result = await memory.recordAgentEvent({
      content: '用户偏好 pnpm 作为包管理器。',
      category: 'preference',
      threadId: 'session-thread',
    })
    expect(result).toMatchObject({ action: 'ADDED', gate: 'clear-new', recorded: true })
    const event = memory.listAgentEvents()[0]!
    // Provenance cites the real conversation messages, not a fabricated one.
    expect(event.sourceBlockId).toBeUndefined()
    expect(event.sourceMessageIds).toEqual(realMessages.map(({ id }) => id))
    expect(realMessages.map(({ content }) => content)).toContain('记住：我偏好用 pnpm。')
    // No synthetic provenance block is created.
    expect(memory.listBlocks().some(({ threadId }) => threadId?.startsWith('agent-memory:'))).toBe(false)
    expect(result.sourceMessageIds).toEqual(event.sourceMessageIds)
  })

  it('falls back to the latest sealed block messages when the open tail is empty', async () => {
    // blockTurnSize 1 seals the turn immediately, so the open tail is empty.
    const memory = openMemory()
    await memory.appendTurn(
      { user: '记住：我偏好用 pnpm。', assistant: '好的，我记下了。', threadId: 'session-thread' },
      { deferDerivation: true },
    )
    expect(memory.listOpenTail('session-thread')).toHaveLength(0)
    const sealedBlock = memory.listBlocks().at(-1)!
    const result = await memory.recordAgentEvent({
      content: '用户偏好 pnpm 作为包管理器。',
      category: 'preference',
      threadId: 'session-thread',
    })
    expect(result.recorded).toBe(true)
    const event = memory.listAgentEvents()[0]!
    // Sealed-block provenance: a real block is cited with its real messages.
    expect(event.sourceBlockId).toBe(sealedBlock.id)
    expect(event.sourceMessageIds).toEqual(sealedBlock.l5Raw.map(({ id }) => id))
    expect(sealedBlock.l5Raw.map(({ content }) => content)).toContain('记住：我偏好用 pnpm。')
    expect(memory.listBlocks().some(({ threadId }) => threadId?.startsWith('agent-memory:'))).toBe(false)
  })

  it('gives the agent pool its own top-k lane in merged retrieval', async () => {
    const memory = openMemory()
    // Three passive matches would fill a size-2 window in a single merged
    // pool; separate lanes guarantee the agent match still surfaces.
    for (const title of ['Release pipeline checklist', 'Release pipeline automation', 'Release pipeline review']) {
      await memory.appendTurn({ user: title, assistant: '已记录。' }, { deferDerivation: true })
      const block = memory.listBlocks().at(-1)!
      await memory.addEvent({
        title,
        summary: `${title} for the deployment process.`,
        sourceBlockId: block.id,
        sourceMessageIds: [block.l5Raw[0]!.id],
      })
    }
    const recorded = await memory.recordAgentEvent({ content: 'Release pipeline owners rotate monthly.' })
    const hits = await memory.searchEvents('release pipeline', { limit: 2 })
    const ids = hits.map(({ event }) => event.id)
    expect(hits).toHaveLength(2)
    expect(ids).toContain(recorded.eventId)
  })

  it('honors the agent memory retrieval weight in fused ranking', async () => {
    const memory = openMemory()
    await memory.appendTurn({ user: 'Alpha launch decision', assistant: '已记录。' }, { deferDerivation: true })
    const block = memory.listBlocks().at(-1)!
    await memory.addEvent({
      title: 'Alpha launch decision',
      summary: 'Alpha launch decision made by the team.',
      sourceBlockId: block.id,
      sourceMessageIds: [block.l5Raw[0]!.id],
    })
    const agent = await memory.recordAgentEvent({ content: 'Alpha launch retrospective notes.' })
    expect(agent.eventId).toBeDefined()
    const query = 'alpha launch'

    const equal = await memory.searchEvents(query)
    expect(equal.map(({ event }) => event.id)).toContain(agent.eventId)

    // Boosting the agent lane puts its top hit above the passive one.
    const boosted = await memory.searchEvents(query, { agentMemoryWeight: 2 })
    expect(boosted[0]!.event.id).toBe(agent.eventId)

    // Weight 0 keeps the recording stored but never surfaced.
    const suppressed = await memory.searchEvents(query, { agentMemoryWeight: 0 })
    expect(suppressed.map(({ event }) => event.id)).not.toContain(agent.eventId)
    expect(suppressed.map(({ event }) => event.id)).toContain(memory.listEvents()[0]!.id)
  })

  it('merges both pools into one search and reinforces agent events through recordMemoryUse', async () => {
    const memory = openMemory()
    const passiveId = await seedPassiveEvent(memory)
    const recorded = await memory.recordAgentEvent({ content: 'The data warehouse runs on BigQuery.', category: 'fact' })
    expect(recorded.eventId).toBeDefined()
    const hits = await memory.searchEvents('data warehouse BigQuery')
    const hitIds = hits.map(({ event }) => event.id)
    expect(hitIds).toContain(recorded.eventId)
    const ranked = await memory.searchEvents('the deployment pipeline')
    expect(ranked.map(({ event }) => event.id)).toContain(passiveId)

    await memory.recordMemoryUse([recorded.eventId!], { receiptId: 'receipt-agent-1' })
    const agentEvent = memory.listAgentEvents().find(({ id }) => id === recorded.eventId)!
    expect(agentEvent.weight.mentionCount).toBe(2)
    await memory.forgetEvent(recorded.eventId!)
    expect(memory.listAgentEvents().find(({ id }) => id === recorded.eventId)?.status).toBe('forgotten')
    const afterForget = await memory.searchEvents('data warehouse BigQuery')
    expect(afterForget.map(({ event }) => event.id)).not.toContain(recorded.eventId)
  })

  it('treats agent events as exact duplicates during external-memory imports', async () => {
    const memory = openMemory()
    await memory.recordAgentEvent({ content: 'The team ships releases every Friday.' })
    const agentEvent = memory.listAgentEvents()[0]!
    let deciderCalls = 0
    const preview = await memory.previewExternalMemoryImport({
      text: 'ignored',
      extractor: async () => ({
        candidates: [{
          title: 'The team ships releases every Friday.',
          summary: 'The team ships releases every Friday.',
        }],
      }),
      decider: async () => { deciderCalls += 1; return { action: 'ADD', confidence: 1 } },
    })
    expect(deciderCalls).toBe(0)
    expect(preview.decisions[0]).toMatchObject({
      action: 'IGNORE', existingEventIds: [agentEvent.id], confidence: 1,
    })
  })
})

describe('agent event persistence', () => {
  beforeEach(() => { sequence = 0 })

  it('persists agent events into the isolated agent_events table and restores them', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-agent-events-'))
    const database = join(directory, 'memory.db')
    try {
      const options = {
        database,
        namespace: 'agent:persistence',
        blockTurnSize: 1,
        now: (): Date => new Date('2026-09-23T08:00:00Z'),
        idFactory: ids(),
        summarizer: nonExtractingSummarizer,
        graphProjector: async () => ({ reason: 'projected', nodes: [], edges: [] }),
      }
      const first = await StrataGate.open(options)
      const recorded = await first.recordAgentEvent({
        content: '用户偏好 pnpm 作为包管理器。', category: 'preference', threadId: 'session-9',
      })
      const before = first.exportSnapshot()
      await first.close()

      const raw = new DatabaseSync(database)
      const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('events', 'agent_events')").all() as Array<{ name: string }>
      expect(tables.map(({ name }) => name).sort()).toEqual(['agent_events', 'events'])
      expect(raw.prepare('SELECT COUNT(*) AS n FROM agent_events').get()).toMatchObject({ n: 1 })
      expect(raw.prepare('SELECT COUNT(*) AS n FROM events').get()).toMatchObject({ n: 0 })
      raw.close()

      const second = await StrataGate.open(options)
      expect(second.exportSnapshot()).toEqual(before)
      expect(second.listAgentEvents()).toHaveLength(1)
      expect(second.listAgentEvents()[0]).toMatchObject({ id: recorded.eventId, criticality: 'preference' })
      expect(second.listAgentEvents()[0]!.temporal.threadId).toBe('session-9')
      const hits = await second.searchEvents('pnpm')
      expect(hits.map(({ event }) => event.id)).toContain(recorded.eventId)
      await second.close()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('migrates a schema-v11 database in place without touching passive events', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-agent-migrate-'))
    const database = join(directory, 'memory.db')
    try {
      const options = {
        database,
        namespace: 'agent:migration',
        blockTurnSize: 1,
        now: (): Date => new Date('2026-09-23T08:00:00Z'),
        idFactory: ids(),
        summarizer: nonExtractingSummarizer,
        graphProjector: async () => ({ reason: 'projected', nodes: [], edges: [] }),
      }
      const first = await StrataGate.open(options)
      await first.appendTurn({ user: '星河项目由李明负责', assistant: '已记录。' }, { deferDerivation: true })
      const before = first.exportSnapshot()
      await first.close()

      const legacy = new DatabaseSync(database)
      legacy.exec('DROP TABLE agent_event_sources; DROP TABLE agent_events;')
      // Simulate the pre-v12 provenance constraint that only knew the events table.
      legacy.exec(`
        DROP TABLE element_fact_sources;
        CREATE TABLE element_fact_sources (
          namespace TEXT NOT NULL,
          fact_id TEXT NOT NULL,
          event_id TEXT NOT NULL,
          position INTEGER NOT NULL,
          PRIMARY KEY (namespace, fact_id, event_id),
          FOREIGN KEY (namespace, fact_id) REFERENCES element_facts(namespace, id) ON DELETE CASCADE,
          FOREIGN KEY (namespace, event_id) REFERENCES events(namespace, id)
        ) STRICT;
      `)
      legacy.exec('PRAGMA user_version = 11;')
      legacy.exec('UPDATE memory_spaces SET schema_version = 11;')
      legacy.close()

      const storage = new SqliteStorage({ filename: database })
      const loaded = await storage.load(options.namespace)
      expect(loaded?.snapshot.schemaVersion).toBe(12)
      expect(loaded?.snapshot.agentEvents).toEqual([])
      expect(loaded?.snapshot.events).toEqual(before.events)
      await storage.close()

      const reopened = await StrataGate.open(options)
      expect(reopened.listEvents()).toHaveLength(before.events.length)
      expect(reopened.listAgentEvents()).toEqual([])
      await reopened.close()

      const migrated = new DatabaseSync(database)
      const rebuiltSql = (migrated.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'element_fact_sources'").get() as { sql: string }).sql
      expect(rebuiltSql).not.toContain('REFERENCES events')
      migrated.close()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('persists element provenance that cites agent events', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-agent-elements-'))
    const database = join(directory, 'memory.db')
    try {
      const options = {
        database,
        namespace: 'agent:elements',
        blockTurnSize: 1,
        now: (): Date => new Date('2026-09-23T08:00:00Z'),
        idFactory: ids(),
        summarizer: nonExtractingSummarizer,
        graphProjector: async () => ({ reason: 'projected', nodes: [], edges: [] }),
      }
      const memory = await StrataGate.open(options)
      const recorded = await memory.recordAgentEvent({
        content: '用户偏好 pnpm 作为包管理器。', category: 'preference',
      })
      expect(memory.listElementProjectionJobs()).toHaveLength(1)

      const claim = await memory.claimNextElementProjection()
      expect(claim?.events.map(({ id }) => id)).toEqual([recorded.eventId])
      await memory.completeElementProjection(claim!.jobId, {
        reason: 'projected',
        changes: [{
          element: { name: 'pnpm', type: 'tool' },
          operation: 'set_state',
          key: 'package_manager',
          mode: 'state',
          value: 'pnpm',
          sourceEventIds: [recorded.eventId!],
        }],
      })
      expect(memory.listElements()[0]!.sourceEventIds).toEqual([recorded.eventId])
      await memory.close()

      // The provenance row cites the agent_events pool; the legacy events-only
      // foreign key would have rejected this insert.
      const raw = new DatabaseSync(database)
      expect(raw.prepare('SELECT event_id FROM element_sources').all()).toEqual([
        { event_id: recorded.eventId },
      ])
      raw.close()

      const second = await StrataGate.open(options)
      expect(second.listElements()[0]!.sourceEventIds).toEqual([recorded.eventId])
      await second.close()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
