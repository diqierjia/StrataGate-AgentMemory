import { describe, expect, it } from 'vitest'
import type { StrataGateSnapshot, UsageReceipt } from '@diqier/stratagate'
import { answerAdoptionKey, memoryOverview } from '../src/memory-overview.js'

const now = Date.parse('2026-11-08T15:00:00+08:00')
const receipt = (id: string, day: string, sessionId: string | undefined, turn: number | undefined, eventIds: string[] = ['evt_1']): UsageReceipt => ({
  id,
  eventIds,
  elementIds: [],
  ...(sessionId === undefined && turn === undefined ? {} : { audit: { ...(sessionId ? { sessionId } : {}), ...(turn === undefined ? {} : { turn }) } }),
  createdAt: `${day}T12:00:00.000+08:00`,
})

function snapshot(usageReceipts: UsageReceipt[]): StrataGateSnapshot {
  return {
    schemaVersion: 14,
    currentTurn: 8,
    blockTurnSize: 6,
    blockDecayLambda: 0.3,
    openTail: [],
    blocks: [],
    summaryJobs: [],
    events: [{ id: 'evt_1', title: '前端不要 AI 味', summary: '', tags: [], quotes: [], sourceMessageIds: [], sourceBlockId: 'b', temporal: {}, scope: 'project', criticality: 'routine', status: 'active', supersededBy: null, weight: { mentionCount: 1, lastAdoptedTurn: 1, lastRetrievedAt: null, pinned: false, floorWeight: 0, forcedCap: null }, createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-05T00:00:00.000Z' }],
    agentEvents: [],
    graphNodes: [], graphEdges: [], graphProjectionJobs: [], elements: [], extractionJobs: [], elementProjectionJobs: [],
    usageReceipts,
    ingestionReceipts: [],
    externalMemoryImportJobs: [],
  }
}

describe('memory overview answer counting', () => {
  it('treats one receipt as one retrieval batch and counts a turn once', () => {
    const receipts = [
      receipt('batch-1', '2026-11-08', 'session-a', 4),
      receipt('batch-2', '2026-11-08', 'session-a', 4),
      receipt('batch-3', '2026-11-07', 'session-a', 5),
      receipt('empty', '2026-11-08', 'session-a', 6, []),
      receipt('legacy', '2026-11-06', undefined, undefined),
      receipt('other-session', '2026-10-01', 'session-b', 1),
    ]
    expect(answerAdoptionKey(receipts[0]!)).toBe(answerAdoptionKey(receipts[1]!))
    expect(answerAdoptionKey(receipts[4]!)).toBe('receipt:legacy')
    const stats = memoryOverview(snapshot(receipts), {}, { now })
    expect(stats.answeredLast7Days).toBe(3)
    expect(stats.lastRecall).toEqual({ title: '前端不要 AI 味', at: '2026-11-08T04:00:00.000Z' })
    expect(stats.layers.longTerm).toMatchObject({ events: 1, answers: 4 })
    expect(stats.heatmap).toHaveLength(28)
    expect(stats.heatmap.filter((day) => day.answers > 0)).toEqual([
      { day: '2026-11-06', answers: 1 },
      { day: '2026-11-07', answers: 1 },
      { day: '2026-11-08', answers: 1 },
    ])
    expect(stats.heatmap.find((day) => day.day === '2026-10-01')).toBeUndefined()
  })

  it('exposes one plain count per layer for the overview pillar', () => {
    const stats = memoryOverview(snapshot([]), {
      profile: { characters: 1234, updatedAt: '2026-11-08T04:00:00.000Z' },
      shortTerm: { enabled: true, items: 9, updatedAt: '2026-11-05T04:00:00.000Z' },
      directory: { chapters: 4, updatedAt: '2026-11-07T04:00:00.000Z' },
    }, { now })
    // 记忆柱只用这些数字；单位只属于界面文案。
    expect([
      stats.layers.profile?.characters,
      stats.layers.directory.chapters,
      stats.layers.session.blocks,
      stats.layers.shortTerm?.items,
      stats.layers.longTerm.events,
    ]).toEqual([1234, 4, 0, 9, 1])
    // 统计层只给数字，不拼单位或千分位，避免和界面文案重复。
    expect(JSON.stringify(stats.layers)).not.toMatch(/个事件|'字'|章|块|条/)
  })

  it('stays empty instead of inventing a recall', () => {
    const stats = memoryOverview(snapshot([]), { profile: null, shortTerm: null }, { now })
    expect(stats.answeredLast7Days).toBe(0)
    expect(stats.lastRecall).toBeNull()
    expect(stats.heatmap.every((day) => day.answers === 0)).toBe(true)
    expect(stats.layers.profile).toBeNull()
    expect(stats.layers.shortTerm).toBeNull()
  })
})
