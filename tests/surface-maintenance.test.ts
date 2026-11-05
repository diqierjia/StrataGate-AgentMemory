import { Session, type SessionSeq } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SqliteStorage } from '@diqier/stratagate/sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { surfaceFixture, surfaceRuntime, type SurfaceInternals } from './fixtures/surface-maintenance.js'

afterEach(() => vi.restoreAllMocks())

function compactSurface(session: Session, nodes = [...session.surface.nodes]) {
  const append = session.append.bind(session) as (...args: unknown[]) => unknown
  append('compaction/start', { compactionId: 'retired-blocks', turn: null })
  append('compaction/summary', {
    compactionId: 'retired-blocks', summary: [{ type: 'text', text: 'Host history summary' }],
    shadowedRange: { start: nodes[0], end: nodes.at(-1) }, shadowedSeqs: nodes,
    shadowedTokenCount: 10_000, provider: 'test', model: 'test',
  })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'Host history summary' }],
    source: { kind: 'plugin', plugin: 'dsh-compaction-basic' } as never,
  }), {
    surfaceOp: { op: 'replace', startSeq: nodes[0]!, endSeq: nodes.at(-1)! }, sourceEventSeqs: nodes,
  })
  append('compaction/end', { compactionId: 'retired-blocks', turn: null })
}

describe('surface maintenance outside assembly', () => {
  it('retires compacted automatic retries without requeueing or rendering history on repeated reconciliation', async () => {
    const flush = vi.fn(async (_session: Session) => {})
    const f = await surfaceFixture(80, flush)
    try {
      // Half had a retry before compaction; the rest would be discovered after restart.
      for (const id of f.ids.slice(0, 40)) f.internals.queueSurfaceSync(f.namespace, id)
      compactSurface(f.session)
      const before = f.session.seq
      const raw = structuredClone(f.memory.listBlocks().map(({ l5Raw }) => l5Raw))
      const render = vi.spyOn(f.memory, 'getBlockContext')
      const save = vi.spyOn(f.memory, 'setBlockSurfaceLevels')
      const history = vi.spyOn(f.session, 'snapshotEvents')
      for (let pass = 0; pass < 5; pass++) {
        history.mockClear()
        f.mark()
        await f.run()
        expect(f.internals.pendingSurfaceSync.size).toBe(0)
        // One shared eligibility scan, rather than one full scan per old Block.
        expect(history).toHaveBeenCalledTimes(1)
      }
      expect(render).not.toHaveBeenCalled()
      expect(save).not.toHaveBeenCalled()
      expect(flush).not.toHaveBeenCalled()
      expect(f.session.seq).toBe(before)
      expect(f.memory.listBlocks().map(({ l5Raw }) => l5Raw)).toEqual(raw)
      expect(JSON.stringify(f.session.deriveMessages())).toContain('Host history summary')
    } finally { await f.dispose() }
  })

  it('recovers a lost checkpoint with surviving sources while excluding compacted history from rendering', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000)
    const f = await surfaceFixture(8)
    try {
      const restored = Session.create(f.session.id, f.session.snapshotEvents().slice(0, -1), f.session.header)
      compactSurface(restored, [...restored.surface.nodes].slice(0, 7))
      const internals = f.internals
      internals.markSurfaceDirty(restored, f.memory)
      const render = vi.spyOn(f.memory, 'getBlockContext')
      await internals.runSurfaceMaintenance(restored)
      expect(internals.pendingSurfaceSync.size).toBe(0)
      const text = JSON.stringify(restored.deriveMessages())
      expect(text).toContain(`Block: ${f.ids[7]} |`)
      expect(text).toContain('Host history summary')
      for (const id of f.ids.slice(0, 7)) expect(text).not.toContain(`Block: ${id} |`)
      const before = restored.seq
      for (let pass = 0; pass < 3; pass++) {
        internals.markSurfaceDirty(restored, f.memory)
        await internals.runSurfaceMaintenance(restored)
      }
      expect(restored.seq).toBe(before)
      for (const [, ids] of render.mock.calls) expect([...ids!]).toEqual([f.ids[7]])
    } finally { await f.dispose() }
  })

  it('keeps an explicit selection blocked with its reason after its source was compacted', async () => {
    const errors: unknown[] = []
    const f = await surfaceFixture(1, undefined, (error) => errors.push(error))
    try {
      await f.memory.expandBlock(f.ids[0]!, 5, 'user')
      f.internals.queueSurfaceSync(f.namespace, f.ids[0]!, 'user-expansion')
      compactSurface(f.session)
      await f.run()
      expect(f.plugin.adminBlockSurfaceSync(f.namespace, f.ids[0]!)).toMatchObject({ status: 'blocked', reason: 'source-unavailable' })
      const render = vi.spyOn(f.memory, 'getBlockContext')
      for (let pass = 0; pass < 3; pass++) { f.mark(); await f.run() }
      expect(f.internals.pendingSurfaceSync.size).toBe(1)
      expect(render).not.toHaveBeenCalled()
      expect(errors).toHaveLength(1)
    } finally { await f.dispose() }
  })

  it('reads 80 existing checkpoints without rendering all Blocks or committing surface metadata', async () => {
    const f = await surfaceFixture()
    try {
      const render = vi.spyOn(f.memory, 'getBlockContext')
      const save = vi.spyOn(f.memory, 'setBlockSurfaceLevels')
      const revision = f.memory.storageRevision
      const before = f.session.seq
      await f.plugin.buildAutoContext(f.session)
      await f.plugin.buildAutoContext(f.session)
      expect(render).not.toHaveBeenCalled()
      expect(save).not.toHaveBeenCalled()
      expect(f.session.seq).toBe(before)
      expect(f.memory.storageRevision).toBe(revision)
    } finally { await f.dispose() }
  })

  it('commits one whole pass, and no snapshots or saves on a subsequent unchanged pass', async () => {
    const f = await surfaceFixture()
    try {
      const revision = f.memory.storageRevision
      const save = vi.spyOn(SqliteStorage.prototype, 'commitRecords')
      await f.run()
      expect(save).toHaveBeenCalledTimes(1)
      expect(f.memory.storageRevision).toBe(revision + 1)
      expect(f.level()).toBeLessThan(5)
      expect(f.memory.listBlocks()[0]!.surfaceCurrentLevel).toBe(f.level())
      save.mockClear()
      const snapshot = vi.spyOn(f.memory, 'exportSnapshot')
      const before = f.session.seq
      f.mark()
      await f.run()
      expect(save).not.toHaveBeenCalled()
      expect(snapshot).not.toHaveBeenCalled()
      expect(f.session.seq).toBe(before)
    } finally { await f.dispose() }
  })

  it('does not run during an active turn and resumes after turn/end', async () => {
    const f = await surfaceFixture(8)
    try {
      const before = f.session.seq
      f.event('turn/start', 9)
      await f.run()
      expect(f.session.seq).toBe(before + 1)
      expect(f.level()).toBe(5)
      f.event('turn/end', 9)
      await f.run()
      expect(f.level()).toBeLessThan(5)
    } finally { await f.dispose() }
  })

  it('abandons an old wake-up when a new turn starts while it waits for ingestion', async () => {
    const f = await surfaceFixture(8)
    let release!: () => void
    try {
      const gate = new Promise<void>((resolve) => { release = resolve })
      f.internals.drainTails.set(String(f.session.id), gate)
      const run = f.run()
      f.event('turn/start', 9)
      release()
      await run
      expect(f.level()).toBe(5)
      expect(f.internals.surfaceMaintenance.get(String(f.session.id))!.dirty).toBe(true)
      f.event('turn/end', 9)
      await f.run()
      expect(f.level()).toBeLessThan(5)
    } finally { release?.(); await f.dispose() }
  })

  it('waits for host compaction and rechecks the current surface after it ends', async () => {
    const f = await surfaceFixture(8)
    try {
      const append = f.session.append.bind(f.session) as (...args: unknown[]) => unknown
      append('compaction/start', { compactionId: 'surface-race', turn: null })
      f.plugin.acceptEvent(f.session, f.session.eventAt((f.session.seq - 1) as SessionSeq)!)
      const before = f.session.seq
      await f.run()
      expect(f.session.seq).toBe(before)
      append('compaction/end', { compactionId: 'surface-race', turn: null, error: 'cancelled' })
      f.plugin.acceptEvent(f.session, f.session.eventAt((f.session.seq - 1) as SessionSeq)!)
      await f.run()
      expect(f.level()).toBeLessThan(5)
    } finally { await f.dispose() }
  })

  it('keeps automatic native saves out of both flush() and the request path', async () => {
    let release!: () => void
    let started!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const saving = new Promise<void>((resolve) => { started = resolve })
    const f = await surfaceFixture(8, async () => { started(); await gate })
    try {
      let finished = false
      const run = f.run().then(() => { finished = true })
      await saving
      await f.plugin.flush()
      await f.plugin.buildAutoContext(f.session)
      expect(finished).toBe(false)
      release()
      await run
    } finally { release(); await f.dispose() }
  })

  it('preserves a later explicit user lift while an older native save is pending', async () => {
    let release!: () => void
    let started!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const saving = new Promise<void>((resolve) => { started = resolve })
    let saves = 0
    const f = await surfaceFixture(8, async () => { if (++saves === 1) { started(); await gate } })
    try {
      const run = f.run()
      await saving
      expect(f.level()).toBeLessThan(5)
      await f.plugin.adminExpandBlock(f.namespace, f.ids[0]!, 'L5')
      expect(f.level()).toBe(5)
      release()
      await run
      expect(f.level()).toBe(5)
      expect(f.memory.listBlocks()[0]).toMatchObject({ surfaceCurrentLevel: 5, lastLiftedBy: 'user' })
    } finally { release(); await f.dispose() }
  })

  it('does not clear a newer user request while an older background save finishes', async () => {
    let finishOld!: () => void
    let failUser!: (error: Error) => void
    let oldStarted!: () => void
    let userStarted!: () => void
    const oldGate = new Promise<void>((resolve) => { finishOld = resolve })
    const userGate = new Promise<void>((_resolve, reject) => { failUser = reject })
    const oldSaving = new Promise<void>((resolve) => { oldStarted = resolve })
    const userSaving = new Promise<void>((resolve) => { userStarted = resolve })
    let saves = 0
    const f = await surfaceFixture(8, async () => {
      if (++saves === 1) { oldStarted(); await oldGate }
      else if (saves === 2) { userStarted(); await userGate }
    })
    try {
      const automatic = f.run()
      await oldSaving
      const manual = f.plugin.adminExpandBlock(f.namespace, f.ids[0]!, 5)
      const rejected = expect(manual).rejects.toThrow('new save failed')
      await userSaving
      finishOld()
      await automatic
      expect(f.plugin.adminBlockSurfaceSync(f.namespace, f.ids[0]!)?.status).toBe('pending')
      failUser(new Error('new save failed'))
      await rejected
      expect(f.plugin.adminBlockSurfaceSync(f.namespace, f.ids[0]!)?.status).toBe('pending')
      await f.plugin.buildAutoContext(f.session)
      expect(f.plugin.adminBlockSurfaceSync(f.namespace, f.ids[0]!)).toBeUndefined()
      expect(f.level()).toBe(5)
    } finally { finishOld?.(); failUser?.(new Error('cleanup')); await f.dispose() }
  })

  it('retains a failed automatic write and repairs metadata without duplicate native messages', async () => {
    const errors: unknown[] = []
    const f = await surfaceFixture(8, undefined, (error) => errors.push(error))
    try {
      const revision = f.memory.storageRevision
      const save = vi.spyOn(SqliteStorage.prototype, 'commitRecords').mockRejectedValueOnce(new Error('disk failure'))
      await f.run()
      expect(errors).toHaveLength(1)
      expect(f.memory.storageRevision).toBe(revision)
      expect(f.memory.listBlocks()[0]!.surfaceCurrentLevel).toBe(5)
      const afterAppend = f.session.seq
      await f.run()
      expect(f.session.seq).toBe(afterAppend)
      expect(f.memory.listBlocks()[0]!.surfaceCurrentLevel).toBe(f.level())
      expect(f.memory.storageRevision).toBe(revision + 1)
      expect(save).toHaveBeenCalledTimes(2)
    } finally { await f.dispose() }
  })

  it('recovers after metadata persisted but the native session save failed before restart', async () => {
    const errors: unknown[] = []
    const flush = vi.fn(async (_session: Session) => {}).mockRejectedValueOnce(new Error('native save failed'))
    const f = await surfaceFixture(8, flush, (error) => errors.push(error))
    let restarted: ReturnType<typeof surfaceRuntime> | undefined
    try {
      const persistedNative = Session.create(f.session.id, f.session.snapshotEvents(), f.session.header)
      const raw = structuredClone(f.memory.listBlocks()[0]!.l5Raw)
      await f.run()
      expect(errors).toHaveLength(1)
      expect(f.memory.listBlocks()[0]!.surfaceCurrentLevel).toBeLessThan(5)
      await f.plugin.close()
      const resumedFlush = vi.fn(async (_session: Session) => {})
      restarted = surfaceRuntime(f.database, resumedFlush)
      await restarted.buildAutoContext(persistedNative)
      const internals = restarted as unknown as SurfaceInternals
      await internals.runSurfaceMaintenance(persistedNative)
      const reopened = await internals.spaces.get(f.namespace)!
      expect(reopened.listBlocks()[0]!.l5Raw).toEqual(raw)
      expect(reopened.listBlocks()[0]!.surfaceCurrentLevel).toBeLessThan(5)
      expect(resumedFlush).toHaveBeenCalledTimes(1)
      const seq = persistedNative.seq
      await internals.runSurfaceMaintenance(persistedNative)
      expect(persistedNative.seq).toBe(seq)
    } finally { await restarted?.close(); await f.dispose() }
  })

  it('cancels scheduled maintenance when the runtime closes', async () => {
    const f = await surfaceFixture(8)
    try {
      const write = vi.spyOn(f.memory, 'setBlockSurfaceLevels')
      f.mark()
      await f.plugin.close()
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(write).not.toHaveBeenCalled()
    } finally { await f.dispose() }
  })

  it('does not mark a settled surface dirty for ordinary reads or unchanged request capacity', async () => {
    const f = await surfaceFixture(8)
    try {
      await f.run()
      const render = vi.spyOn(f.memory, 'getBlockContext')
      const save = vi.spyOn(f.memory, 'setBlockSurfaceLevels')
      f.event('turn/start', 9)
      const request = f.session.append('request/context', { provider: 'test', model: 'test', contextWindow: 128_000 })
      f.plugin.acceptEvent(f.session, request)
      await f.plugin.buildAutoContext(f.session)
      f.event('turn/end', 9)
      await f.run()
      expect(render).not.toHaveBeenCalled()
      expect(save).not.toHaveBeenCalled()
      expect(f.internals.surfaceMaintenance.get(String(f.session.id))!.dirty).toBe(false)
    } finally { await f.dispose() }
  })

  it('keeps maintenance out of assembly even while retrieval is awaiting I/O', async () => {
    let release!: () => void
    let started!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const searching = new Promise<void>((resolve) => { started = resolve })
    const f = await surfaceFixture(8)
    try {
      vi.spyOn(f.memory, 'listOpenTail').mockReturnValue([{
        id: 'pending-query', role: 'user', content: 'Find earlier work', createdAt: new Date().toISOString(), threadId: String(f.session.id),
      }])
      vi.spyOn(f.memory, 'searchEvents').mockImplementation(async () => { started(); await gate; return [] })
      const render = vi.spyOn(f.memory, 'getBlockContext')
      const assembly = f.plugin.buildAutoContext(f.session)
      await searching
      f.mark()
      await f.run()
      expect(render).not.toHaveBeenCalled()
      release()
      await assembly
      await f.run()
      expect(f.level()).toBeLessThan(5)
    } finally { release?.(); await f.dispose() }
  })

  it('reconstructs a lost sealing request from ready Blocks and surviving native sources', async () => {
    const f = await surfaceFixture(8)
    let restarted: ReturnType<typeof surfaceRuntime> | undefined
    try {
      const restored = Session.create(f.session.id, f.session.snapshotEvents().slice(0, -1), f.session.header)
      await f.plugin.close()
      restarted = surfaceRuntime(f.database)
      await restarted.buildAutoContext(restored)
      const internals = restarted as unknown as SurfaceInternals
      const save = vi.spyOn(SqliteStorage.prototype, 'commitRecords')
      await internals.runSurfaceMaintenance(restored)
      expect(save).toHaveBeenCalledTimes(1)
      expect(restored.deriveMessages()).toHaveLength(8)
      expect(JSON.stringify(restored.deriveMessages())).toContain(`Block: ${f.ids.at(-1)} |`)
    } finally { await restarted?.close(); await f.dispose() }
  })

  it('repairs checkpoints that exceed the current hard capacity before returning context', async () => {
    const f = await surfaceFixture(8)
    try {
      f.event('turn/start', 9)
      vi.spyOn(f.session, 'requestContext').mockReturnValue({ contextWindow: 6_000 } as never)
      expect(f.level(7)).toBe(5)
      await f.plugin.buildAutoContext(f.session)
      expect(f.level(7)).toBeLessThan(5)
      expect(f.memory.listBlocks()[7]!.surfaceCurrentLevel).toBe(f.level(7))
    } finally { await f.dispose() }
  })
})
