import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, type SessionSeq } from '@deepseek-ai/dsh-session'
import { createSessionFormatCatalogWithChildren, sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
import { releasedV3SessionFormatCodec } from '@deepseek-ai/dsh-session-format-v3-to-v4'
import { StrataGate, estimateTokens, renderBlock, type BlockContextEntry, type MemoryBlock } from '@diqier/stratagate'
import { describe, expect, it, vi } from 'vitest'
import type { DshModelBridge } from '../src/llm.js'
import { buildDshMessageSource } from '../src/dsh-compatibility.js'
import { StrataGateRuntime } from '../src/runtime.js'

const models = {
  run: async <T>(_session: Session, operation: () => Promise<T>): Promise<T> => operation(),
  runDetached: async <T>(_id: string, operation: () => Promise<T>): Promise<T> => operation(),
  isReady: () => true,
  onAdaptersUpdated: () => () => {},
  summarizer: async () => ({
    l0Title: 'saved work', l0Tags: [], l1Summary: 'Saved work summary.',
    l2Keypoints: ['Saved work summary.'], shouldExtract: false,
  }),
  extractor: async () => ({ shouldExtract: false, reason: 'none', events: [] }),
  graphProjector: async () => ({ reason: 'none', nodes: [], edges: [] }),
} as unknown as DshModelBridge

function runtime(
  database: string,
  bridge: DshModelBridge = models,
  flush: (session: Session) => Promise<void> = async () => {},
): StrataGateRuntime {
  return new StrataGateRuntime({
    database, namespaceMode: 'session', namespacePrefix: 'dsh', globalNamespace: 'global',
    blockTurnSize: 1, blockDecayLambda: 0.3, ingestSubagents: false, maxOutputTokens: 2048,
  }, bridge, undefined, flush)
}

function appendTurn(session: Session, user: string, assistant: string, toolResult?: string, turn = 1): SessionSeq | undefined {
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 1 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: user }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  if (toolResult) {
    const callId = 'issue81-call' as never
    session.append('assistant/message', {
      turn, step: 1,
      message: createAssistantMessage({
        content: [{ type: 'tool-call', id: callId, name: 'inspect', arguments: '{"path":"large"}' }],
        source: { provider: 'test', model: 'test' },
      }),
      stream: [],
    }, { surfaceOp: 'append' })
    session.append('tool/call', { turn, step: 1, callId, name: 'inspect', arguments: '{"path":"large"}' })
    const event = session.append('tool/result', {
      turn, step: 1,
      message: createToolResultMessage({ callId, content: [{ type: 'text', text: toolResult }], isError: false }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
    return event.seq
  }
  session.append('assistant/message', {
    turn, step: 1,
    message: createAssistantMessage({
      content: [{ type: 'text', text: assistant }], source: { provider: 'test', model: 'test' },
    }),
    stream: [],
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
  return undefined
}

async function replace(runtime: StrataGateRuntime, memory: StrataGate, session: Session, block: MemoryBlock, context: BlockContextEntry): Promise<boolean> {
  return (runtime as unknown as { replaceSealedSurface: (
    session: Session, memory: StrataGate, block: MemoryBlock, context: BlockContextEntry, endTurn: number,
  ) => Promise<boolean> }).replaceSealedSurface(session, memory, block, context, 1)
}

function turnEndAt(session: Session): string {
  const ended = session.snapshotEvents().find((event) => event.type === 'turn/end')
  if (!ended) throw new Error('Expected completed DSH turn')
  return new Date(ended.time).toISOString()
}

async function queuedSurfaceFixture(flush = vi.fn(async (_session: Session) => {}), initialLevel: 0 | 1 | 2 = 0) {
  const directory = await mkdtemp(join(tmpdir(), 'stratagate-queued-surface-'))
  const database = join(directory, 'memory.db')
  const session = Session.create('queued-surface' as never)
  const user = 'Source detail that must return after expansion. '.repeat(60)
  const assistant = 'Original answer with supporting evidence. '.repeat(60)
  appendTurn(session, user, assistant)
  const plugin = runtime(database, models, flush)
  const namespace = plugin.namespaceFor(session)
  const memory = await StrataGate.open({
    database, namespace, blockTurnSize: 1, summarizer: models.summarizer, extractor: models.extractor,
  })
  await memory.appendTurn({ user, assistant, threadId: String(session.id), createdAt: turnEndAt(session) })
  const block = memory.listBlocks()[0]!
  const context = memory.getBlockContext(String(session.id))[0]!
  expect(await replace(plugin, memory, session, block, {
    ...context, level: initialLevel, content: renderBlock(block, initialLevel),
  })).toBe(true)
  const internals = plugin as unknown as {
    pendingSurfaceSync: Map<string, { namespace: string; blockId: string; reason?: 'user-expansion' }>
    spaces: Map<string, Promise<StrataGate>>
    knownSessions: Map<string, WeakRef<Session>>
    syncPendingRetrySurface(session: Session, memory: StrataGate): Promise<void>
    queueSurfaceSync(namespace: string, blockId: string, reason?: 'user-expansion'): void
    flushSurface(session: Session): Promise<void>
  }
  await internals.flushSurface(session)
  flush.mockClear()
  internals.spaces.set(namespace, Promise.resolve(memory))
  const key = `${namespace}\u0000${block.id}`
  const sync = () => internals.syncPendingRetrySurface(session, memory)
  const queue = () => internals.pendingSurfaceSync.set(key, { namespace, blockId: block.id, reason: 'user-expansion' })
  const dispose = async () => {
    await plugin.close()
    await memory.close()
    await rm(directory, { recursive: true, force: true })
  }
  return { plugin, memory, session, block, namespace, internals, key, sync, queue, flush, dispose, user, database }
}

describe('deferred Block surface synchronization', () => {
  it.each([0, 1, 2] as const)('replaces an existing L%s checkpoint with a larger L5 for a queued user expansion, without duplication', async (initialLevel) => {
    const f = await queuedSurfaceFixture(undefined, initialLevel)
    try {
      await f.plugin.adminExpandBlock(f.namespace, f.block.id, 'L5')
      expect(f.internals.pendingSurfaceSync.has(f.key)).toBe(true)
      expect(f.memory.listBlocks()[0]!.surfaceCurrentLevel).toBe(initialLevel)
      const originalRaw = structuredClone(f.memory.listBlocks()[0]!.l5Raw)
      const historyCount = f.session.snapshotEvents().length
      const previousTokens = estimateTokens(JSON.stringify(f.session.deriveMessages()))
      await f.sync()
      expect(f.internals.pendingSurfaceSync.has(f.key)).toBe(false)
      expect(f.memory.listBlocks()[0]!.surfaceCurrentLevel).toBe(5)
      expect(f.session.deriveMessages()).toHaveLength(1)
      expect(JSON.stringify(f.session.deriveMessages())).toContain('Level: L5')
      expect(JSON.stringify(f.session.deriveMessages())).toContain(f.user)
      expect(estimateTokens(JSON.stringify(f.session.deriveMessages()))).toBeGreaterThan(previousTokens)
      expect(f.memory.listBlocks()[0]!.l5Raw).toEqual(originalRaw)
      expect(f.session.snapshotEvents().length).toBe(historyCount + 1)
      expect(f.flush).toHaveBeenCalledWith(f.session)
      await f.sync()
      expect(f.session.snapshotEvents().length).toBe(historyCount + 1)
    } finally { await f.dispose() }
  })

  it.each([3, 5])('reports the actual updated L%s when the target session is already loaded', async (level) => {
    const f = await queuedSurfaceFixture()
    try {
      f.internals.knownSessions.set(String(f.session.id), new WeakRef(f.session))
      expect(await f.plugin.adminExpandBlock(f.namespace, f.block.id, `L${level}`)).toMatchObject({ level, surfaceLevel: level })
      expect(f.internals.pendingSurfaceSync.has(f.key)).toBe(false)
      expect(JSON.stringify(f.session.deriveMessages())).toContain(`Level: L${level}`)
    } finally { await f.dispose() }
  })

  it('keeps ordinary sealing retries idempotent when a checkpoint already exists', async () => {
    const f = await queuedSurfaceFixture()
    try {
      const before = f.session.seq
      f.internals.pendingSurfaceSync.set(f.key, { namespace: f.namespace, blockId: f.block.id })
      await f.sync()
      expect(f.session.seq).toBe(before)
      expect(f.memory.listBlocks()[0]!.surfaceCurrentLevel).toBe(0)
      expect(f.internals.pendingSurfaceSync.has(f.key)).toBe(false)
      expect(f.flush).not.toHaveBeenCalled()
    } finally { await f.dispose() }
  })

  it('preserves an expansion when background sealing schedules the same block', async () => {
    const f = await queuedSurfaceFixture()
    try {
      await f.plugin.adminExpandBlock(f.namespace, f.block.id, 'L5')
      f.internals.queueSurfaceSync(f.namespace, f.block.id)
      expect(f.internals.pendingSurfaceSync.get(f.key)?.reason).toBe('user-expansion')
      await f.sync()
      expect(f.memory.listBlocks()[0]!.surfaceCurrentLevel).toBe(5)
      expect(f.internals.pendingSurfaceSync.has(f.key)).toBe(false)
    } finally { await f.dispose() }
  })

  it('also expands original messages when no Block checkpoint has been written yet', async () => {
    const f = await queuedSurfaceFixture()
    try {
      const rawSession = Session.create(f.session.id, f.session.snapshotEvents().slice(0, -1), f.session.header)
      expect(rawSession.deriveMessages()).toHaveLength(2)
      await f.plugin.adminExpandBlock(f.namespace, f.block.id, 'L5')
      await f.internals.syncPendingRetrySurface(rawSession, f.memory)
      expect(f.internals.pendingSurfaceSync.has(f.key)).toBe(false)
      expect(rawSession.deriveMessages()).toHaveLength(1)
      expect(JSON.stringify(rawSession.deriveMessages())).toContain('Level: L5')
      expect(JSON.stringify(rawSession.deriveMessages())).toContain(f.user)
    } finally { await f.dispose() }
  })

  it('defers a cold namespace expansion until its existing conversation is loaded', async () => {
    const f = await queuedSurfaceFixture()
    try {
      f.internals.spaces.delete(f.namespace)
      await f.memory.close()
      expect(await f.plugin.adminExpandBlock(f.namespace, f.block.id, 'L5')).toMatchObject({ level: 5, surfaceLevel: 0 })
      expect(f.internals.pendingSurfaceSync.has(f.key)).toBe(true)
      const before = f.session.seq
      await f.plugin.buildAutoContext(f.session)
      expect(f.internals.pendingSurfaceSync.has(f.key)).toBe(false)
      expect(JSON.stringify(f.session.deriveMessages())).toContain('Level: L5')
      expect(f.session.seq).toBe(before + 1)
    } finally { await f.dispose() }
  })

  it('recovers an unapplied user expansion after the runtime restarts', async () => {
    const f = await queuedSurfaceFixture()
    let restarted: StrataGateRuntime | undefined
    try {
      await f.plugin.adminExpandBlock(f.namespace, f.block.id, 'L5')
      await f.plugin.close()
      restarted = runtime(f.database)
      const before = f.session.seq
      await restarted.buildAutoContext(f.session)
      expect(JSON.stringify(f.session.deriveMessages())).toContain('Level: L5')
      expect(f.session.seq).toBe(before + 1)
    } finally {
      await restarted?.close()
      await f.dispose()
    }
  })

  it('keeps an Agent expansion in tool evidence without raising the conversation checkpoint', async () => {
    const f = await queuedSurfaceFixture()
    try {
      const before = f.session.seq
      const result = await f.plugin.expandBlock(f.session, f.block.id, 'L5')
      expect(result).toMatchObject({ results: { level: 5, content: expect.stringContaining(f.user) } })
      await f.plugin.buildAutoContext(f.session)
      expect(f.session.seq).toBe(before)
      expect(f.memory.listBlocks()[0]!.surfaceCurrentLevel).toBe(0)
      expect(f.internals.pendingSurfaceSync.has(f.key)).toBe(false)
    } finally { await f.dispose() }
  })

  it.each([undefined, 'user-expansion'] as const)('retains a %s request while native event history is unavailable', async (reason) => {
    const f = await queuedSurfaceFixture()
    try {
      await f.memory.expandBlock(f.block.id, 'L5', 'user')
      f.internals.queueSurfaceSync(f.namespace, f.block.id, reason)
      const unloaded = Session.create(f.session.id)
      await f.internals.syncPendingRetrySurface(unloaded, f.memory)
      expect(f.internals.pendingSurfaceSync.has(f.key)).toBe(true)
      expect(unloaded.deriveMessages()).toHaveLength(0)
      expect(f.memory.listBlocks()[0]!.surfaceCurrentLevel).toBe(0)
    } finally { await f.dispose() }
  })

  it('rejects a known capacity failure before saving the pointer and allows a later user retry', async () => {
    const f = await queuedSurfaceFixture()
    try {
      f.internals.knownSessions.set(String(f.session.id), new WeakRef(f.session))
      const capacity = vi.spyOn(f.session, 'requestContext').mockReturnValue({ contextWindow: 100 } as never)
      const before = f.session.seq
      const original = structuredClone(f.memory.listBlocks()[0])
      await expect(f.plugin.adminExpandBlock(f.namespace, f.block.id, 'L5')).rejects.toThrow('当前模型预计放不下')
      expect(f.internals.pendingSurfaceSync.has(f.key)).toBe(false)
      expect(f.memory.listBlocks()[0]).toEqual(original)
      expect(f.session.seq).toBe(before)
      capacity.mockRestore()
      await f.plugin.adminExpandBlock(f.namespace, f.block.id, 'L5')
      expect(f.internals.pendingSurfaceSync.has(f.key)).toBe(false)
      expect(f.memory.listBlocks()[0]!.surfaceCurrentLevel).toBe(5)
    } finally { vi.restoreAllMocks(); await f.dispose() }
  })

  it('does not lose a request when flushing the native session fails', async () => {
    const f = await queuedSurfaceFixture()
    try {
      await f.memory.expandBlock(f.block.id, 'L5', 'user')
      f.queue()
      f.flush.mockRejectedValueOnce(new Error('session save failed'))
      await expect(f.sync()).rejects.toThrow('session save failed')
      expect(f.internals.pendingSurfaceSync.has(f.key)).toBe(true)
      const afterReplacement = f.session.seq
      await f.sync()
      expect(f.internals.pendingSurfaceSync.has(f.key)).toBe(false)
      expect(f.session.seq).toBe(afterReplacement)
      expect(f.flush).toHaveBeenCalledTimes(2)
    } finally { await f.dispose() }
  })

  it('keeps requests for a different conversation in the same namespace', async () => {
    const f = await queuedSurfaceFixture()
    try {
      await f.memory.expandBlock(f.block.id, 'L5', 'user')
      f.queue()
      const other = Session.create('other-conversation' as never)
      vi.spyOn(f.plugin, 'namespaceFor').mockReturnValue(f.namespace)
      await f.internals.syncPendingRetrySurface(other, f.memory)
      expect(f.internals.pendingSurfaceSync.has(f.key)).toBe(true)
      expect(other.deriveMessages()).toHaveLength(0)
      expect(f.memory.listBlocks()[0]!.surfaceCurrentLevel).toBe(0)
    } finally { vi.restoreAllMocks(); await f.dispose() }
  })

  it('waits for host compaction to finish before replacing a checkpoint', async () => {
    const f = await queuedSurfaceFixture()
    try {
      await f.memory.expandBlock(f.block.id, 'L5', 'user')
      f.queue()
      const append = f.session.append.bind(f.session) as (...args: unknown[]) => unknown
      append('compaction/start', { compactionId: 'queued-compaction', turn: null })
      const before = f.session.seq
      await f.sync()
      expect(f.internals.pendingSurfaceSync.has(f.key)).toBe(true)
      expect(f.session.seq).toBe(before)
      append('compaction/end', { compactionId: 'queued-compaction', turn: null, error: 'cancelled' })
      await f.sync()
      expect(f.internals.pendingSurfaceSync.has(f.key)).toBe(false)
      expect(f.memory.listBlocks()[0]!.surfaceCurrentLevel).toBe(5)
    } finally { await f.dispose() }
  })
})

describe('Issue #81 surface ownership and size', () => {
  it.each(['0.1.7-rc.1', '0.2.0-alpha.1', '0.2.0-beta.1', '0.2.0-rc.2', '0.2.0'])('encodes a new DSH %s checkpoint with a producer-owned source', (version) => {
    const session = Session.create('issue81-v4-source' as never)
    const event = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '[StrataGate historical conversation block]\nBlock: block-v4' }],
      source: buildDshMessageSource(version),
    }), { surfaceOp: 'append' })
    expect(() => sessionFormatCatalog.encodeCurrentEvent({
      type: event.type, seq: event.seq, time: event.time, data: event.data,
    } as never)).not.toThrow()
    expect(() => sessionFormatCatalog.encodeCurrentEvent({
      type: event.type, seq: event.seq, time: event.time,
      data: { ...event.data, source: { kind: 'plugin', plugin: 'stratagate-memory' } as any },
    } as never)).toThrow(/producer-owned source|retired plugin/)
  })

  it('persists a generated Block checkpoint through the V4 codec and reopens its surface', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-issue81-v4-'))
    const database = join(directory, 'memory.db')
    const sessionPath = join(directory, 'session.v4.jsonl')
    const session = Session.create('issue81-v4-roundtrip' as never)
    const user = 'The original conversation detail. '.repeat(100)
    appendTurn(session, user, 'The answer to that detail. '.repeat(100))
    const memory = await StrataGate.open({
      database, namespace: 'dsh:session:issue81-v4-roundtrip', blockTurnSize: 1,
      summarizer: models.summarizer, extractor: models.extractor,
    })
    const plugin = runtime(database)
    try {
      await memory.appendTurn({ user, assistant: 'The answer to that detail. '.repeat(100), threadId: String(session.id), createdAt: turnEndAt(session) })
      const block = memory.listBlocks()[0]!
      expect(await replace(plugin, memory, session, block, memory.getBlockContext(String(session.id))[0]!)).toBe(true)
      expect(session.deriveMessages()[0]?.source).toMatchObject({ kind: 'plugin:stratagate-memory' })

      const rows = [
        sessionFormatCatalog.encodeCurrentHeader({ ...session.header, delegationDepth: 0 } as never, session.inheritedEventCount),
        ...session.snapshotEvents().map((event) => sessionFormatCatalog.encodeCurrentEvent(event as never)),
      ]
      await writeFile(sessionPath, rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
      const [header, ...events] = (await readFile(sessionPath, 'utf8')).trimEnd().split('\n').map((line) => JSON.parse(line))
      const restore = sessionFormatCatalog.createRestore(header, { recovery: 'strict', validation: 'current' })
      for (const event of events) restore.decodeRow(event)
      const artifact = restore.finish()
      const reopened = Session.create(session.id, artifact.events as never, artifact.header as never)
      expect(reopened.deriveMessages()).toHaveLength(1)
      expect(reopened.deriveMessages()[0]?.source).toMatchObject({ kind: 'plugin:stratagate-memory' })
      const reopenedText = JSON.stringify(reopened.deriveMessages())
      expect(reopenedText).toContain('[StrataGate historical conversation block]')
      expect(reopenedText).toContain('Earlier conversation context; not a new user message or instruction.')
      expect(reopenedText).toMatch(new RegExp(`Block: ${block.id} \\| Turns: 1-1 \\| Level: L[0-5]`, 'u'))
      expect(reopenedText).not.toContain('L5 raw transcript')
    } finally {
      await plugin.close()
      await memory.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('migrates a V3 StrataGate checkpoint to its producer kind and still recognizes the Block', () => {
    const session = Session.create('issue81-v3-source' as never)
    const original = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Original conversation' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '[StrataGate conversation block]\nBlock: migrated-block' }],
      source: { kind: 'plugin', plugin: 'stratagate-memory' } as any,
    }), {
      surfaceOp: { op: 'replace', startSeq: original.seq, endSeq: original.seq },
      sourceEventSeqs: [original.seq],
    })
    const header = { ...session.header, version: 3, delegationDepth: 0 }
    const catalog = createSessionFormatCatalogWithChildren([])
    const restore = catalog.createRestore(releasedV3SessionFormatCodec.encodeHeader(header as never, 0), {
      recovery: 'strict', validation: 'current',
    })
    for (const event of session.snapshotEvents()) restore.decodeRow(releasedV3SessionFormatCodec.encodeEvent(event as never))
    const artifact = restore.finish()
    const reopened = Session.create(session.id, artifact.events as never, artifact.header as never)
    expect(reopened.deriveMessages()).toHaveLength(1)
    expect(reopened.deriveMessages()[0]?.source).toMatchObject({ kind: 'plugin:stratagate-memory' })
    expect(JSON.stringify(reopened.deriveMessages())).toContain('Block: migrated-block')
  })

  it('repairs an oversized legacy L5 checkpoint after session restore while keeping L5 in SQLite', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-issue81-legacy-'))
    const database = join(directory, 'memory.db')
    const session = Session.create('issue81-legacy' as never)
    session.append('request/context', { provider: 'test', model: 'test', contextWindow: 128_000 })
    const user = 'Pruned current conversation. '.repeat(200)
    appendTurn(session, user, 'Short current answer')
    const originalNodes = [...session.surface.nodes]
    const fullToolResult = 'FULL HISTORICAL TOOL RESULT '.repeat(15_000)
    const memory = await StrataGate.open({
      database, namespace: 'dsh:session:issue81-legacy', blockTurnSize: 1,
      summarizer: models.summarizer, extractor: models.extractor,
    })
    let blockId: string
    try {
      await memory.appendTurn({
        user, assistant: 'Short current answer', threadId: String(session.id),
        createdAt: turnEndAt(session),
        assistantToolCalls: [{ name: 'inspect', arguments: { path: 'large' }, result: fullToolResult }],
      })
      const block = memory.listBlocks()[0]!
      blockId = block.id
      const raw = memory.getBlockContext(String(session.id))[0]!
      expect(raw.level).toBe(5)
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: [
          '[StrataGate conversation block]', `Block: ${block.id}`, 'Turns: 1-1',
          'Level: L5 (L5 raw transcript)', '', raw.content,
        ].join('\n') }],
        source: { kind: 'plugin', plugin: 'stratagate-memory' } as any,
      }), {
        surfaceOp: { op: 'replace', startSeq: originalNodes[0]!, endSeq: originalNodes.at(-1)! },
        sourceEventSeqs: originalNodes,
      })
      expect(estimateTokens(JSON.stringify(session.deriveMessages()))).toBeGreaterThan(50_000)
    } finally { await memory.close() }
    const restored = Session.create(session.id, session.snapshotEvents(), session.header)
    let flushes = 0
    const plugin = runtime(database, models, async () => { flushes += 1 })
    try {
      await plugin.buildAutoContext(restored)
      const visible = JSON.stringify(restored.deriveMessages())
      expect(visible).toContain(`Block: ${blockId!}`)
      expect(visible).not.toContain('Level: L5')
      expect(visible).not.toContain('FULL HISTORICAL TOOL RESULT')
      expect(estimateTokens(visible)).toBeLessThanOrEqual(4_096)
      expect(flushes).toBeGreaterThan(0)
      const reopened = await StrataGate.open({ database, namespace: 'dsh:session:issue81-legacy' })
      try {
        expect(reopened.listBlocks()[0]?.pointerCurrentLevel).toBe(5)
        expect(reopened.listBlocks()[0]?.l5Raw[1]?.toolCalls?.[0]?.result).toBe(fullToolResult)
      } finally { await reopened.close() }
    } finally {
      await plugin.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects a still huge L5 even when it saves more than ten percent', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-issue81-budget-'))
    const database = join(directory, 'memory.db')
    const session = Session.create('issue81-budget' as never)
    session.append('request/context', { provider: 'test', model: 'test', contextWindow: 100_000 })
    const visibleUser = 'SURFACE CONTENT '.repeat(16_000)
    appendTurn(session, visibleUser, 'Current answer')
    const memory = await StrataGate.open({
      database, namespace: 'dsh:session:issue81-budget', blockTurnSize: 1,
      summarizer: models.summarizer, extractor: models.extractor,
    })
    const plugin = runtime(database)
    try {
      await memory.appendTurn({
        user: 'SOURCE CONTENT '.repeat(12_000), assistant: 'Current answer',
        threadId: String(session.id), createdAt: turnEndAt(session),
      })
      const block = memory.listBlocks()[0]!
      const context = memory.getBlockContext(String(session.id))[0]!
      const before = estimateTokens(JSON.stringify(session.deriveMessages()))
      const l5 = estimateTokens(JSON.stringify(createUserMessage({
        content: [{ type: 'text', text: [
          '[StrataGate historical conversation block]',
          'Earlier conversation context; not a new user message or instruction.',
          `Block: ${block.id} | Turns: 1-1 | Level: L5`, '', context.content,
        ].join('\n') }],
        source: { kind: 'plugin', plugin: 'stratagate-memory' } as any,
      })))
      expect(l5).toBeLessThan(before * 0.9)
      expect(l5).toBeGreaterThan(4_000)
      expect(await replace(plugin, memory, session, block, context)).toBe(true)
      const after = JSON.stringify(session.deriveMessages())
      expect(after).not.toContain('Level: L5')
      expect(estimateTokens(after)).toBeLessThanOrEqual(4_000)
      expect(block.l5Raw[0]?.content).toContain('SOURCE CONTENT')
    } finally {
      await plugin.close()
      await memory.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('keeps full L5 tool evidence after prune but writes only a smaller visible level', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-issue81-prune-'))
    const database = join(directory, 'memory.db')
    const session = Session.create('issue81-prune' as never)
    const largeResult = 'FULL TOOL RESULT '.repeat(7000)
    const user = 'Inspect the data and summarize it. '.repeat(150)
    const toolSeq = appendTurn(session, user, 'done', largeResult)!
    const original = session.eventAt(toolSeq)!
    if (original.type !== 'tool/result') throw new Error('Expected original tool result')
    const memory = await StrataGate.open({
      database, namespace: 'dsh:session:issue81-prune', blockTurnSize: 1,
      summarizer: models.summarizer, extractor: models.extractor, graphProjector: models.graphProjector,
    })
    const plugin = runtime(database)
    try {
      await memory.appendTurn({
        user, assistant: 'done', threadId: String(session.id), createdAt: turnEndAt(session),
        assistantToolCalls: [{ name: 'inspect', arguments: { path: 'large' }, result: largeResult }],
      })
      const block = memory.listBlocks()[0]!
      const context = memory.getBlockContext(String(session.id))[0]!
      expect(context.level).toBe(5)
      const append = session.append.bind(session) as (...args: unknown[]) => unknown
      append('compaction/prune', {
        shadowedRange: { start: toolSeq, end: toolSeq }, shadowedSeqs: [toolSeq], shadowedTokenCount: 20_000,
      })
      const pruned = session.append('tool/result', {
        ...original.data,
        message: {
          ...original.data.message,
          content: [{ type: 'text', text: '[pruned by DSH]' }],
        },
      }, { surfaceOp: { op: 'replace', startSeq: toolSeq, endSeq: toolSeq }, sourceEventSeqs: [toolSeq] })
      const before = estimateTokens(JSON.stringify(session.deriveMessages()))
      expect(await replace(plugin, memory, session, block, context)).toBe(true)
      const checkpoint = session.eventAt(session.surface.nodes[0]!)!
      expect(checkpoint.sourceEventSeqs).toContain(pruned.seq)
      expect(session.deriveMessages()).toHaveLength(1)
      const after = estimateTokens(JSON.stringify(session.deriveMessages()))
      expect(after).toBeLessThanOrEqual(before)
      expect(JSON.stringify(session.deriveMessages())).not.toContain(largeResult)
      expect(JSON.stringify(session.deriveMessages())).not.toContain('Level: L5')
      expect(block.l5Raw[1]?.toolCalls?.[0]?.result).toBe(largeResult)
      await memory.close()
      const reopened = await StrataGate.open({ database, namespace: 'dsh:session:issue81-prune' })
      try {
        expect(reopened.listBlocks()[0]?.l5Raw[1]?.toolCalls?.[0]?.result).toBe(largeResult)
      } finally { await reopened.close() }
    } finally {
      await plugin.close()
      await memory.close().catch(() => {})
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('does not replace while host compaction is open or restore history it has consumed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-issue81-compact-'))
    const database = join(directory, 'memory.db')
    const session = Session.create('issue81-compact' as never)
    const user = 'A completed historical request. '.repeat(100)
    appendTurn(session, user, 'A completed answer. '.repeat(100))
    const memory = await StrataGate.open({
      database, namespace: 'dsh:session:issue81-compact', blockTurnSize: 1,
      summarizer: models.summarizer, extractor: models.extractor, graphProjector: models.graphProjector,
    })
    const plugin = runtime(database)
    try {
      await memory.appendTurn({ user, assistant: 'A completed answer. '.repeat(100), threadId: String(session.id), createdAt: turnEndAt(session) })
      const block = memory.listBlocks()[0]!
      const context = memory.getBlockContext(String(session.id))[0]!
      const oldNodes = [...session.surface.nodes]
      const append = session.append.bind(session) as (...args: unknown[]) => unknown
      append('compaction/start', { compactionId: 'test-compact', turn: null })
      expect(await replace(plugin, memory, session, block, context)).toBe(false)
      expect(session.surface.nodes).toEqual(oldNodes)
      append('compaction/summary', {
        compactionId: 'test-compact', summary: [{ type: 'text', text: 'Host summary' }],
        shadowedRange: { start: oldNodes[0], end: oldNodes.at(-1) },
        shadowedSeqs: oldNodes, shadowedTokenCount: 10_000, provider: 'test', model: 'test',
      })
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'Host summary' }],
        source: { kind: 'plugin', plugin: 'dsh-compaction-basic' } as any,
      }), {
        surfaceOp: { op: 'replace', startSeq: oldNodes[0]!, endSeq: oldNodes.at(-1)! },
        sourceEventSeqs: oldNodes,
      })
      append('compaction/end', { compactionId: 'test-compact', turn: null })
      expect(await replace(plugin, memory, session, block, context)).toBe(false)
      expect(session.deriveMessages()).toHaveLength(1)
      expect(JSON.stringify(session.deriveMessages())).not.toContain('[StrataGate historical conversation block]')
      expect(memory.listBlocks()[0]?.processingStatus).toBe('ready')
    } finally {
      await plugin.close()
      await memory.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('does not restore a two-turn Block when Compact consumed only its first turn', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-issue81-partial-'))
    const database = join(directory, 'memory.db')
    const session = Session.create('issue81-partial' as never)
    const first = 'First historical request. '.repeat(100)
    const second = 'Second historical request. '.repeat(100)
    appendTurn(session, first, 'First historical answer. '.repeat(100))
    const firstEnd = turnEndAt(session)
    const firstNodes = [...session.surface.nodes]
    appendTurn(session, second, 'Second historical answer. '.repeat(100), undefined, 2)
    const secondEnd = new Date(session.snapshotEvents().filter((event) => event.type === 'turn/end').at(-1)!.time).toISOString()
    const memory = await StrataGate.open({
      database, namespace: 'dsh:session:issue81-partial', blockTurnSize: 2,
      summarizer: models.summarizer, extractor: models.extractor,
    })
    const plugin = runtime(database)
    try {
      await memory.appendTurn({ user: first, assistant: 'First historical answer. '.repeat(100), threadId: String(session.id), createdAt: firstEnd })
      await memory.appendTurn({ user: second, assistant: 'Second historical answer. '.repeat(100), threadId: String(session.id), createdAt: secondEnd })
      const block = memory.listBlocks()[0]!
      const context = memory.getBlockContext(String(session.id))[0]!
      const append = session.append.bind(session) as (...args: unknown[]) => unknown
      append('compaction/start', { compactionId: 'partial-compact', turn: null })
      append('compaction/summary', {
        compactionId: 'partial-compact', summary: [{ type: 'text', text: 'Host first-turn summary' }],
        shadowedRange: { start: firstNodes[0], end: firstNodes.at(-1) },
        shadowedSeqs: firstNodes, shadowedTokenCount: 5_000, provider: 'test', model: 'test',
      })
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'Host first-turn summary' }],
        source: { kind: 'plugin', plugin: 'dsh-compaction-basic' } as any,
      }), {
        surfaceOp: { op: 'replace', startSeq: firstNodes[0]!, endSeq: firstNodes.at(-1)! },
        sourceEventSeqs: firstNodes,
      })
      append('compaction/end', { compactionId: 'partial-compact', turn: null })
      const before = [...session.surface.nodes]
      await expect((plugin as unknown as { replaceSealedSurface: (
        session: Session, memory: StrataGate, block: MemoryBlock, context: BlockContextEntry, endTurn: number,
      ) => Promise<boolean> }).replaceSealedSurface(session, memory, block, context, 2)).resolves.toBe(false)
      expect(session.surface.nodes).toEqual(before)
      expect(JSON.stringify(session.deriveMessages())).toContain('Host first-turn summary')
      expect(JSON.stringify(session.deriveMessages())).toContain(second)
      expect(JSON.stringify(session.deriveMessages())).not.toContain('[StrataGate historical conversation block]')
      expect(block.l5Raw[0]?.content).toBe(first)
    } finally {
      await plugin.close()
      await memory.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('finishes background Block work during host Compact without a stale write or later rebound', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-issue81-race-'))
    const database = join(directory, 'memory.db')
    const session = Session.create('issue81-race' as never)
    appendTurn(session, 'Original request. '.repeat(200), 'Original answer. '.repeat(200))
    let release!: () => void
    let started = false
    const gate = new Promise<void>((resolve) => { release = resolve })
    const bridge = {
      ...models,
      summarizer: async () => {
        started = true
        await gate
        return { l0Title: 'stored', l0Tags: [], l1Summary: 'stored', l2Keypoints: [], shouldExtract: false }
      },
    } as unknown as DshModelBridge
    const plugin = runtime(database, bridge)
    try {
      for (const event of session.snapshotEvents()) plugin.acceptEvent(session, event)
      await plugin.flush()
      await vi.waitFor(() => expect(started).toBe(true))
      const oldNodes = [...session.surface.nodes]
      const append = session.append.bind(session) as (...args: unknown[]) => unknown
      append('compaction/start', { compactionId: 'race-compact', turn: null })
      release()
      await vi.waitFor(async () => {
        const snapshot = await plugin.adminSnapshot(plugin.namespaceFor(session))
        expect(snapshot?.blocks[0]?.processingStatus).toBe('ready')
      })
      expect(session.surface.nodes).toEqual(oldNodes)
      append('compaction/summary', {
        compactionId: 'race-compact', summary: [{ type: 'text', text: 'Host retained summary' }],
        shadowedRange: { start: oldNodes[0], end: oldNodes.at(-1) },
        shadowedSeqs: oldNodes, shadowedTokenCount: 10_000, provider: 'test', model: 'test',
      })
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'Host retained summary' }],
        source: { kind: 'plugin', plugin: 'dsh-compaction-basic' } as any,
      }), {
        surfaceOp: { op: 'replace', startSeq: oldNodes[0]!, endSeq: oldNodes.at(-1)! },
        sourceEventSeqs: oldNodes,
      })
      append('compaction/end', { compactionId: 'race-compact', turn: null })
      await plugin.buildAutoContext(session)
      await plugin.buildAutoContext(session)
      expect(session.deriveMessages()).toHaveLength(1)
      expect(JSON.stringify(session.deriveMessages())).toContain('Host retained summary')
      expect(JSON.stringify(session.deriveMessages())).not.toContain('[StrataGate historical conversation block]')
    } finally {
      release()
      await plugin.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('retries against the pruned surface after a failed Compact closes without a summary', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-issue81-failed-compact-'))
    const database = join(directory, 'memory.db')
    const session = Session.create('issue81-failed-compact' as never)
    session.append('request/context', { provider: 'test', model: 'test', contextWindow: 100_000 })
    const user = 'Summarize the inspected results. '.repeat(180)
    const fullResult = 'FULL TOOL RESULT '.repeat(8_000).trimEnd()
    const toolSeq = appendTurn(session, user, 'Current answer.', fullResult)!
    let release!: () => void
    let started = false
    const gate = new Promise<void>((resolve) => { release = resolve })
    const bridge = {
      ...models,
      summarizer: async () => {
        started = true
        await gate
        return { l0Title: 'stored', l0Tags: [], l1Summary: 'stored', l2Keypoints: [], shouldExtract: false }
      },
    } as unknown as DshModelBridge
    const plugin = runtime(database, bridge)
    try {
      for (const event of session.snapshotEvents()) plugin.acceptEvent(session, event)
      await plugin.flush()
      await vi.waitFor(() => expect(started).toBe(true))
      const original = session.eventAt(toolSeq)!
      if (original.type !== 'tool/result') throw new Error('Expected original tool result')
      const append = session.append.bind(session) as (...args: unknown[]) => unknown
      append('compaction/prune', {
        shadowedRange: { start: toolSeq, end: toolSeq }, shadowedSeqs: [toolSeq], shadowedTokenCount: 20_000,
      })
      const pruned = session.append('tool/result', {
        ...original.data,
        message: {
          ...original.data.message,
          content: [{ type: 'text', text: '[pruned by DSH]' }],
        },
      }, { surfaceOp: { op: 'replace', startSeq: toolSeq, endSeq: toolSeq }, sourceEventSeqs: [toolSeq] })
      const prunedTokens = estimateTokens(JSON.stringify(session.deriveMessages()))
      expect(JSON.stringify(session.deriveMessages())).not.toContain('FULL TOOL RESULT')
      append('compaction/start', { compactionId: 'failed-compact', turn: null })
      release()
      await vi.waitFor(async () => {
        const snapshot = await plugin.adminSnapshot(plugin.namespaceFor(session))
        expect(snapshot?.blocks[0]?.processingStatus).toBe('ready')
      })
      expect(session.surface.nodes).toContain(pruned.seq)
      expect(session.surface.nodes.some((seq) => {
        const event = session.eventAt(seq)
        const source = event?.type === 'user/message' ? event.data.source as any : undefined
        return event?.type === 'user/message' && source?.kind === 'plugin'
          && source.plugin === 'stratagate-memory'
      })).toBe(false)
      append('compaction/end', { compactionId: 'failed-compact', turn: null, error: 'summarization failed' })
      plugin.acceptEvent(session, session.eventAt((session.seq - 1) as SessionSeq)!)
      await plugin.buildAutoContext(session)
      await vi.waitFor(() => expect(session.deriveMessages()).toHaveLength(1))
      const after = JSON.stringify(session.deriveMessages())
      expect(session.deriveMessages()).toHaveLength(1)
      expect(after).toContain('[StrataGate historical conversation block]')
      expect(after).not.toContain(fullResult)
      expect(after).toContain('Level: L4')
      expect(estimateTokens(after)).toBeLessThanOrEqual(prunedTokens)
      const checkpoint = session.eventAt(session.surface.nodes[0]!)!
      expect(checkpoint.sourceEventSeqs).toContain(pruned.seq)
      const surfaceAfterRetry = [...session.surface.nodes]
      await plugin.buildAutoContext(session)
      expect(session.surface.nodes).toEqual(surfaceAfterRetry)
      const snapshot = await plugin.adminSnapshot(plugin.namespaceFor(session))
      const storedResult = snapshot?.blocks[0]?.l5Raw[1]?.toolCalls?.[0]?.result
      expect(storedResult).toBe(fullResult)
    } finally {
      release()
      await plugin.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('creates an L5 checkpoint when the equal-size surface is allowed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-issue81-skip-'))
    const database = join(directory, 'memory.db')
    const session = Session.create('issue81-skip' as never)
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const memory = await StrataGate.open({
      database, namespace: 'dsh:session:issue81-skip', blockTurnSize: 1,
      summarizer: models.summarizer, extractor: models.extractor,
    })
    const plugin = runtime(database)
    try {
      await memory.appendTurn({ user: 'hi', assistant: 'done', threadId: String(session.id), createdAt: turnEndAt(session) })
      const before = [...session.surface.nodes]
      expect(await replace(plugin, memory, session, memory.listBlocks()[0]!, memory.getBlockContext(String(session.id))[0]!)).toBe(true)
      expect(session.surface.nodes).not.toEqual(before)
      expect(JSON.stringify(session.deriveMessages())).toContain('Level: L5')
      expect(memory.listBlocks()[0]?.processingStatus).toBe('ready')
    } finally {
      await plugin.close()
      await memory.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('does not target an unrelated DSH turn when the Block has a different source time', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-issue81-turn-gap-'))
    const database = join(directory, 'memory.db')
    const session = Session.create('issue81-turn-gap' as never)
    const user = 'This turn belongs to the host. '.repeat(150)
    appendTurn(session, user, 'Host answer. '.repeat(150))
    const memory = await StrataGate.open({
      database, namespace: 'dsh:session:issue81-turn-gap', blockTurnSize: 1,
      summarizer: models.summarizer, extractor: models.extractor,
    })
    const plugin = runtime(database)
    try {
      await memory.appendTurn({
        user, assistant: 'Host answer. '.repeat(150), threadId: String(session.id),
        createdAt: new Date(Date.parse(turnEndAt(session)) - 60_000).toISOString(),
      })
      const before = [...session.surface.nodes]
      expect(await replace(plugin, memory, session, memory.listBlocks()[0]!, memory.getBlockContext(String(session.id))[0]!)).toBe(false)
      expect(session.surface.nodes).toEqual(before)
    } finally {
      await plugin.close()
      await memory.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('lets decay shrink a checkpoint and restores its detail on explicit user expansion', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-issue81-decay-'))
    const database = join(directory, 'memory.db')
    let session = Session.create('issue81-decay' as never)
    const user = 'Working through the project details. '.repeat(100)
    const assistant = 'The detailed project answer. '.repeat(100)
    appendTurn(session, user, assistant)
    const memory = await StrataGate.open({
      database, namespace: 'dsh:session:issue81-decay', blockTurnSize: 1, blockDecayLambda: 1,
      summarizer: models.summarizer, extractor: models.extractor,
    })
    const plugin = runtime(database)
    try {
      await memory.appendTurn({ user, assistant, threadId: String(session.id), createdAt: turnEndAt(session) })
      const block = memory.listBlocks()[0]!
      const fresh = memory.getBlockContext(String(session.id))[0]!
      const oldNodes = [...session.surface.nodes]
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: [
          '[StrataGate conversation block]', `Block: ${block.id}`, 'Turns: 1-1',
          'Level: L5 (L5 raw transcript)', '', fresh.content,
        ].join('\n') }],
        source: { kind: 'plugin', plugin: 'stratagate-memory' } as any,
      }), {
        surfaceOp: { op: 'replace', startSeq: oldNodes[0]!, endSeq: oldNodes.at(-1)! },
        sourceEventSeqs: oldNodes,
      })
      const v3Header = { ...session.header, version: 3, delegationDepth: 0 }
      const migration = createSessionFormatCatalogWithChildren([]).createRestore(
        releasedV3SessionFormatCodec.encodeHeader(v3Header as never, 0),
        { recovery: 'strict', validation: 'current' },
      )
      for (const event of session.snapshotEvents()) migration.decodeRow(releasedV3SessionFormatCodec.encodeEvent(event as never))
      const migrated = migration.finish()
      session = Session.create(session.id, migrated.events as never, migrated.header as never)
      expect(session.deriveMessages()[0]?.source).toMatchObject({ kind: 'plugin:stratagate-memory' })
      const beforeDecay = estimateTokens(JSON.stringify(session.deriveMessages()))
      await memory.appendTurn({ user: 'Later turn', assistant: 'Later answer', threadId: String(session.id) })
      await memory.appendTurn({ user: 'Another turn', assistant: 'Another answer', threadId: String(session.id) })
      await memory.appendTurn({ user: 'Final turn', assistant: 'Final answer', threadId: String(session.id) })
      const decayed = memory.getBlockContext(String(session.id))
      expect(decayed[0]!.level).toBeLessThan(5)
      const sync = (plugin as unknown as { syncDecayedBlockSurface: (
        session: Session, memory: StrataGate, contexts: BlockContextEntry[],
      ) => Promise<boolean> }).syncDecayedBlockSurface.bind(plugin)
      expect(await sync(session, memory, decayed)).toBe(true)
      expect(JSON.stringify(session.deriveMessages())).toContain('[StrataGate historical conversation block]')
      const afterDecay = estimateTokens(JSON.stringify(session.deriveMessages()))
      expect(afterDecay).toBeLessThan(beforeDecay * 0.9)
      await memory.expandBlock(block.id, 'L5', 'user')
      const expanded = memory.getBlockContext(String(session.id))
      expect(expanded[0]!.level).toBe(5)
      expect(await sync(session, memory, expanded)).toBe(true)
      expect(memory.listBlocks()[0]?.surfaceCurrentLevel).toBe(5)
      expect(estimateTokens(JSON.stringify(session.deriveMessages()))).toBeGreaterThan(afterDecay)
      expect(memory.listBlocks()[0]?.l5Raw[0]?.content).toBe(user)
    } finally {
      await plugin.close()
      await memory.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
