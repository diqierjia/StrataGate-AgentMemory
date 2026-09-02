import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import { StrataGate } from '@diqier/stratagate'
import { describe, expect, it } from 'vitest'
import type { DshModelBridge } from '../src/llm.js'
import { StrataGateRuntime } from '../src/runtime.js'

const fakeModels = {
  run: async <T>(_session: Session, operation: () => Promise<T>): Promise<T> => operation(),
  summarizer: async () => ({
    l0Title: 'turns', l0Tags: [], l1Summary: 'turns', l2Keypoints: [], shouldExtract: false,
  }),
  extractor: async () => ({ shouldExtract: false, reason: 'none', events: [] }),
  projector: async () => ({ reason: 'none', changes: [] }),
  graphProjector: async () => ({ reason: 'none', nodes: [], edges: [] }),
} as unknown as DshModelBridge

const session = {
  id: 'session-runtime',
  header: { id: 'session-runtime', version: 0, createdAt: 0, cwd: 'C:\\work\\project' },
} as unknown as Session

function turnEvents(): SessionEvent[] {
  return [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    {
      type: 'user/message', seq: 1, time: 2,
      data: { id: 'u1', role: 'user', content: [{ type: 'text', text: 'remember pnpm' }], source: { kind: 'user' } },
    },
    {
      type: 'assistant/message', seq: 2, time: 3,
      data: {
        turn: 1, step: 1,
        message: {
          id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'Understood.' }],
          source: { kind: 'model', provider: 'test', model: 'test' },
        },
      },
    },
    { type: 'turn/end', seq: 3, time: 4, data: { turn: 1, reason: { kind: 'completed' } } },
  ] as SessionEvent[]
}

describe('DSH runtime ingestion', () => {
  it('builds compact automatic context without reinforcing retrieved memories', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-dsh-auto-context-'))
    const database = join(directory, 'memory.db')
    const activeSession = {
      ...session,
      events: [],
      deriveMessages: () => [{
        id: 'current-user',
        role: 'user',
        content: [{ type: 'text', text: 'Continue with that plan.' }],
        source: { kind: 'user' },
      }],
    } as unknown as Session
    const runtime = new StrataGateRuntime({
      database,
      namespaceMode: 'project',
      namespacePrefix: 'dsh',
      globalNamespace: 'global',
      blockTurnSize: 2,
      blockDecayLambda: 0.3,
      ingestSubagents: false,
      maxOutputTokens: 2048,
    }, fakeModels)
    try {
      const memory = await (runtime as unknown as { space: (session: Session) => Promise<StrataGate> })
        .space(activeSession)
      await memory.appendTurn({ user: 'Initial setup.', assistant: 'Ready.', threadId: 'historical-session' })
      await memory.appendTurn({ user: 'Seal this block.', assistant: 'Sealed.', threadId: 'historical-session' })
      const block = memory.listBlocks()[0]
      expect(block).toBeDefined()

      const relevant = await memory.addEvent({
        title: 'Use pnpm',
        summary: 'The project package manager is pnpm.',
        narrative: 'PRIVATE NARRATIVE',
        quotes: ['PRIVATE QUOTE'],
        sourceMessageIds: [block!.l5Raw[0]!.id],
        sourceBlockId: block!.id,
        temporal: {
          happenedStart: '2026-08-20T10:00:00+08:00',
          happenedEnd: '2026-08-20T11:00:00+08:00',
          status: 'ongoing',
        },
      })
      const projection = await memory.claimNextGraphProjection()
      expect(projection).not.toBeNull()
      await memory.completeGraphProjection(projection!.jobId, {
        reason: 'project tool',
        nodes: [{
          ref: 'stratagate', name: 'StrataGate', type: 'project', state: 'packageManager: pnpm',
          facts: [{ key: 'packageManager', value: 'pnpm', sourceEventIds: [relevant.id] }],
          sourceEventIds: [relevant.id],
        }],
        edges: [],
      })
      const irrelevant = await memory.addEvent({
        title: 'Unrelated archive note',
        summary: 'A completely unrelated zebra record.',
        sourceMessageIds: [block!.l5Raw[0]!.id],
        sourceBlockId: block!.id,
      })
      const pinned = await memory.addEvent({
        title: 'Pinned background',
        summary: 'This pinned fact has no lexical overlap.',
        sourceMessageIds: [block!.l5Raw[0]!.id],
        sourceBlockId: block!.id,
      })
      await memory.pinEvent(pinned.id)
      const safety = await memory.addEvent({
        title: 'Safety background',
        summary: 'This safety fact has no lexical overlap.',
        sourceMessageIds: [block!.l5Raw[0]!.id],
        sourceBlockId: block!.id,
        criticality: 'safety',
      })
      await memory.appendTurn({
        user: 'We chose pnpm earlier.',
        assistant: 'I will keep that in mind.',
        threadId: String(activeSession.id),
      })

      const before = new Map(memory.listEvents().map((event) => [
        event.id,
        [event.weight.mentionCount, event.weight.lastAdoptedTurn],
      ]))
      await runtime.refreshAutoContext(activeSession)
      const context = runtime.buildAutoContext(activeSession)

      expect(context).toContain('[Activated long-term memory]')
      expect(context).toContain('Historical memory context.')
      expect(context).not.toContain('[Current conversation]')
      expect(context).not.toContain('[Decayed memory blocks]')
      expect(context).not.toContain('We chose pnpm earlier.')
      expect(context).not.toContain('toolCalls:')
      expect(context).toContain(relevant.id)
      expect(context).toContain('"temporal":{"status":"ongoing"}')
      expect(context).toContain('"summary":"The project package manager is pnpm."')
      expect(context).toContain(pinned.id)
      expect(context).toContain(safety.id)
      expect(context).not.toContain(irrelevant.id)
      expect(context).not.toContain('PRIVATE NARRATIVE')
      expect(context).not.toContain('PRIVATE QUOTE')
      expect(context).not.toContain('sourceMessageIds')
      expect(context).not.toContain('sourceEventIds')
      expect(context).not.toContain('mentionCount')
      expect((context.match(/^\- \{"id":"evt_/gm) ?? [])).toHaveLength(3)
      expect((context.match(/^\- \{"nodeId":/gm) ?? [])).toHaveLength(1)
      for (const event of memory.listEvents()) {
        expect([event.weight.mentionCount, event.weight.lastAdoptedTurn]).toEqual(before.get(event.id))
      }
    } finally {
      await runtime.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('keeps short-term blocks session-local while activating project long-term memory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-dsh-session-scope-'))
    const database = join(directory, 'memory.db')
    const sessionA = {
      ...session,
      id: 'session-a',
      header: { ...session.header, id: 'session-a' },
      events: [],
      deriveMessages: () => [],
    } as unknown as Session
    const sessionB = {
      ...session,
      id: 'session-b',
      header: { ...session.header, id: 'session-b' },
      events: [],
      deriveMessages: () => [{
        id: 'session-b-user',
        role: 'user',
        content: [{ type: 'text', text: 'Which package manager does this project use?' }],
        source: { kind: 'user' },
      }],
    } as unknown as Session
    const runtime = new StrataGateRuntime({
      database,
      namespaceMode: 'project',
      namespacePrefix: 'dsh',
      globalNamespace: 'global',
      blockTurnSize: 2,
      blockDecayLambda: 0.3,
      ingestSubagents: false,
      maxOutputTokens: 2048,
    }, fakeModels)
    try {
      expect(runtime.namespaceFor(sessionA)).toBe(runtime.namespaceFor(sessionB))
      const memory = await (runtime as unknown as { space: (active: Session) => Promise<StrataGate> }).space(sessionA)
      await memory.appendTurn({ user: 'A-only setup.', assistant: 'A reply.', threadId: 'session-a' })
      await memory.appendTurn({ user: 'A-only sealed turn.', assistant: 'A sealed reply.', threadId: 'session-a' })
      const blockA = memory.listBlocks()[0]!
      const event = await memory.addEvent({
        title: 'Project package manager',
        summary: 'The project package manager is pnpm.',
        sourceMessageIds: [blockA.l5Raw[0]!.id],
        sourceBlockId: blockA.id,
      })
      await memory.appendTurn({ user: 'A-only open tail.', assistant: 'A tail reply.', threadId: 'session-a' })
      await memory.appendTurn({ user: 'B-only open tail.', assistant: 'B tail reply.', threadId: 'session-b' })

      await runtime.refreshAutoContext(sessionB)
      const context = runtime.buildAutoContext(sessionB)
      expect(context).not.toContain('[Current conversation]')
      expect(context).not.toContain('[Decayed memory blocks]')
      expect(context).not.toContain('B-only open tail.')
      expect(context).not.toContain(blockA.id)
      expect(context).not.toContain('A-only')
      expect(context).toContain(event.id)

      const blockBatch = await runtime.blocks(sessionB) as { results: unknown[] }
      expect(blockBatch.results).toEqual([])
      await runtime.recordUse(sessionB, 'session-local-blocks', [])
    } finally {
      await runtime.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('does not cache a rejected namespace opening after pending-work recovery fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-dsh-recovery-'))
    const database = join(directory, 'memory.db')
    let attempts = 0
    const models = {
      ...fakeModels,
      run: async <T>(_session: Session, operation: () => Promise<T>): Promise<T> => {
        if (attempts++ === 0) throw new Error('temporary recovery failure')
        return operation()
      },
    } as unknown as DshModelBridge
    const runtime = new StrataGateRuntime({
      database,
      namespaceMode: 'project',
      namespacePrefix: 'dsh',
      globalNamespace: 'global',
      blockTurnSize: 4,
      blockDecayLambda: 0.3,
      ingestSubagents: false,
      maxOutputTokens: 2048,
    }, models)
    try {
      const space = (runtime as unknown as { space: (session: Session) => Promise<StrataGate> }).space
      await expect(space.call(runtime, session)).rejects.toThrow('temporary recovery failure')
      await expect(space.call(runtime, session)).resolves.toBeInstanceOf(StrataGate)
    } finally {
      await runtime.close().catch(() => {})
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('persists the UI lambda globally for existing and future workspaces', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-dsh-cadence-'))
    const database = join(directory, 'memory.db')
    const namespace = 'dsh:project:cadence'
    const seed = await StrataGate.open({ database, namespace, blockTurnSize: 4, blockDecayLambda: 0.2 })
    await seed.close()
    const runtime = new StrataGateRuntime({
      database,
      namespaceMode: 'project',
      namespacePrefix: 'dsh',
      globalNamespace: 'global',
      blockTurnSize: 6,
      blockDecayLambda: 0.3,
      ingestSubagents: false,
      maxOutputTokens: 2048,
    }, fakeModels)
    let futureNamespace = ''
    try {
      await runtime.syncConfiguredSettings()
      expect((await runtime.adminSnapshot(namespace))?.blockTurnSize).toBe(6)
      expect((await runtime.adminSnapshot(namespace))?.blockDecayLambda).toBe(0.3)

      await runtime.adminSetBlockDecayLambda(0.15)
      expect((await runtime.adminSnapshot(namespace))?.blockDecayLambda).toBe(0.15)

      const futureSession = {
        ...session,
        id: 'future-workspace',
        header: { ...session.header, id: 'future-workspace', cwd: 'C:\\work\\StrataGate' },
      } as unknown as Session
      futureNamespace = runtime.namespaceFor(futureSession)
      const future = await (runtime as unknown as { space: (active: Session) => Promise<StrataGate> })
        .space(futureSession)
      expect(future.blockDecayLambda).toBe(0.15)
      expect(runtime.adminWorkspaceName(futureNamespace)).toBe('StrataGate')
    } finally {
      await runtime.close()
    }

    const restored = new StrataGateRuntime({
      database,
      namespaceMode: 'project',
      namespacePrefix: 'dsh',
      globalNamespace: 'global',
      blockTurnSize: 6,
      blockDecayLambda: 0.3,
      ingestSubagents: false,
      maxOutputTokens: 2048,
    }, fakeModels)
    try {
      await restored.syncConfiguredSettings()
      expect((await restored.adminSnapshot(namespace))?.blockDecayLambda).toBe(0.15)
      expect((await restored.adminSnapshot(futureNamespace))?.blockDecayLambda).toBe(0.15)
      expect(restored.adminWorkspaceName(futureNamespace)).toBe('StrataGate')
    } finally {
      await restored.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('persists a folded DSH turn once even if the event bracket is delivered twice', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-dsh-runtime-'))
    const database = join(directory, 'memory.db')
    const runtime = new StrataGateRuntime({
      database,
      namespaceMode: 'project',
      namespacePrefix: 'dsh',
      globalNamespace: 'global',
      blockTurnSize: 4,
      blockDecayLambda: 0.3,
      ingestSubagents: false,
      maxOutputTokens: 2048,
    }, fakeModels)
    const namespace = runtime.namespaceFor(session)
    try {
      for (const event of turnEvents()) runtime.acceptEvent(session, event)
      for (const event of turnEvents()) runtime.acceptEvent(session, event)
      await runtime.close()

      const memory = await StrataGate.open({ database, namespace })
      expect(memory.turn).toBe(1)
      expect(memory.listOpenTail().map(({ content }) => content)).toEqual(['remember pnpm', 'Understood.'])
      expect(memory.hasIngestionReceipt('dsh:session-runtime:turn:1')).toBe(true)
      await memory.close()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('uses native surface replacement for sealed turns and preserves the open-tail tool chain', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-dsh-native-compaction-'))
    const database = join(directory, 'memory.db')
    const activeSession = Session.create('native-compaction-session' as never)
    const runtime = new StrataGateRuntime({
      database,
      namespaceMode: 'session',
      namespacePrefix: 'dsh',
      globalNamespace: 'global',
      blockTurnSize: 2,
      blockDecayLambda: 1,
      ingestSubagents: false,
      maxOutputTokens: 2048,
    }, fakeModels)
    const append = <T extends Parameters<Session['append']>[0]>(
      type: T,
      data: Parameters<Session['append']>[1],
      opts?: { surfaceOp: 'append'; sourceEventSeqs?: number[] },
    ): SessionEvent => {
      const appendEvent = activeSession.append.bind(activeSession) as (...args: unknown[]) => SessionEvent
      const event = opts
        ? appendEvent(type, data, opts)
        : appendEvent(type, data)
      runtime.acceptEvent(activeSession, event)
      return event
    }
    const appendPlainTurn = (turn: number, user: string, assistant: string): void => {
      append('turn/start', { turn })
      append('user/message', createUserMessage({
        content: [{ type: 'text', text: user }], source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      append('step/start', { turn, step: 1 })
      append('assistant/message', {
        turn, step: 1,
        message: createAssistantMessage({
          content: [{ type: 'text', text: assistant }],
          source: { provider: 'test', model: 'test' },
        }),
      }, { surfaceOp: 'append', sourceEventSeqs: [] })
      append('step/end', { turn, step: 1 })
      append('turn/end', { turn, reason: { kind: 'completed' } })
    }

    try {
      appendPlainTurn(1, 'SEALED ORIGINAL ONE', 'SEALED ANSWER ONE')
      appendPlainTurn(2, 'SEALED ORIGINAL TWO', 'SEALED ANSWER TWO')
      await runtime.flush()

      let derived = activeSession.deriveMessages()
      expect(derived).toHaveLength(1)
      expect(derived[0]).toMatchObject({
        role: 'user',
        source: { kind: 'plugin', plugin: 'stratagate-memory' },
      })
      expect(JSON.stringify(derived)).toContain('[StrataGate conversation block]')
      expect(JSON.stringify(derived)).toContain('Level: L5 (L5 raw transcript)')
      expect(JSON.stringify(derived)).toContain('SEALED ORIGINAL ONE')
      expect(JSON.stringify(derived)).toContain('SEALED ORIGINAL TWO')
      const nativeMemory = await (runtime as unknown as { space: (active: Session) => Promise<StrataGate> })
        .space(activeSession)
      const currentBlock = nativeMemory.listBlocks()[0]!
      const currentConversationEvent = await nativeMemory.addEvent({
        title: 'CURRENT USER SENTINEL history',
        summary: 'CURRENT USER SENTINEL came from this same conversation.',
        sourceMessageIds: [currentBlock.l5Raw[0]!.id],
        sourceBlockId: currentBlock.id,
      })

      const callId = 'current-tool-call' as never
      append('turn/start', { turn: 3 })
      append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'CURRENT USER SENTINEL' }], source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      append('step/start', { turn: 3, step: 1 })
      append('assistant/message', {
        turn: 3, step: 1,
        message: createAssistantMessage({
          content: [{ type: 'tool-call', id: callId, name: 'inspect_workspace', arguments: '{"path":"CURRENT_TOOL_PATH"}' }],
          source: { provider: 'test', model: 'test' },
        }),
      }, { surfaceOp: 'append', sourceEventSeqs: [] })
      append('tool/call', { turn: 3, step: 1, callId, name: 'inspect_workspace', arguments: '{"path":"CURRENT_TOOL_PATH"}' })
      append('tool/result', {
        turn: 3, step: 1,
        message: createToolResultMessage({
          callId,
          content: [{ type: 'text', text: 'CURRENT TOOL RESULT' }],
          isError: false,
        }),
      }, { surfaceOp: 'append' })
      append('step/end', { turn: 3, step: 1 })
      append('step/start', { turn: 3, step: 2 })
      append('assistant/message', {
        turn: 3, step: 2,
        message: createAssistantMessage({
          content: [{ type: 'text', text: 'CURRENT FINAL ANSWER' }],
          source: { provider: 'test', model: 'test' },
        }),
      }, { surfaceOp: 'append', sourceEventSeqs: [] })
      append('step/end', { turn: 3, step: 2 })
      append('turn/end', { turn: 3, reason: { kind: 'completed' } })
      await runtime.flush()

      derived = activeSession.deriveMessages()
      const nativeRequest = JSON.stringify(derived)
      expect(nativeRequest.match(/CURRENT USER SENTINEL/g)).toHaveLength(1)
      expect(nativeRequest).toContain('CURRENT_TOOL_PATH')
      expect(nativeRequest).toContain('CURRENT TOOL RESULT')
      expect(nativeRequest).toContain('CURRENT FINAL ANSWER')
      expect(derived.some((message) => message.content.some((block) => block.type === 'tool-call' && block.id === callId))).toBe(true)
      expect(derived.some((message) => message.content.some((block) => block.type === 'tool-result' && block.toolCallId === callId))).toBe(true)

      await runtime.refreshAutoContext(activeSession)
      const dynamicContext = runtime.buildAutoContext(activeSession)
      expect(dynamicContext).toContain('[Activated long-term memory]')
      expect(dynamicContext).not.toContain('CURRENT USER SENTINEL')
      expect(dynamicContext).not.toContain('CURRENT_TOOL_PATH')
      expect(dynamicContext).not.toContain('CURRENT TOOL RESULT')
      expect(dynamicContext).not.toContain(currentConversationEvent.id)
      expect(dynamicContext).not.toContain('[Current conversation]')
      expect(dynamicContext).not.toContain('[Decayed memory blocks]')
      expect(`${nativeRequest}\n${dynamicContext}`.match(/CURRENT USER SENTINEL/g)).toHaveLength(1)

      appendPlainTurn(4, 'SECOND BLOCK CLOSER', 'SECOND BLOCK ANSWER')
      await runtime.flush()
      const decayed = nativeMemory.getBlockContext(String(activeSession.id))
      expect(decayed.map(({ level }) => level)).toEqual([3, 5])
      derived = activeSession.deriveMessages()
      expect(derived).toHaveLength(2)
      const decayedRequest = JSON.stringify(derived)
      const decayedTexts = derived.flatMap((message) => message.content
        .flatMap((block) => block.type === 'text' ? [block.text] : []))
      expect(decayedRequest).toContain(`Block: ${decayed[0]!.id}`)
      expect(decayedRequest).toContain('Level: L3 (L3 rule-condensed transcript)')
      expect(decayedTexts.find((text) => text.includes(`Block: ${decayed[0]!.id}`))).toContain(decayed[0]!.content)
      expect(decayedRequest).toContain(`Block: ${decayed[1]!.id}`)
      expect(decayedRequest).toContain('Level: L5 (L5 raw transcript)')

      await nativeMemory.expandBlock(decayed[0]!.id, 'L4', 'user')
      await runtime.refreshAutoContext(activeSession)
      expect(JSON.stringify(activeSession.deriveMessages())).toContain('Level: L4 (L4 readable near-verbatim transcript)')
    } finally {
      await runtime.close().catch(() => {})
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('persists the retrieval assessment as an answer-to-source usage audit', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-dsh-audit-'))
    const database = join(directory, 'memory.db')
    const runtime = new StrataGateRuntime({
      database,
      namespaceMode: 'project',
      namespacePrefix: 'dsh',
      globalNamespace: 'global',
      blockTurnSize: 1,
      blockDecayLambda: 0.3,
      ingestSubagents: false,
      maxOutputTokens: 2048,
    }, fakeModels)
    const activeSession = {
      ...session,
      events: [{ type: 'turn/start', seq: 0, time: 1, data: { turn: 9 } }],
    } as unknown as Session
    const namespace = runtime.namespaceFor(activeSession)
    try {
      const seed = await StrataGate.open({
        database,
        namespace,
        blockTurnSize: 1,
        summarizer: async () => ({
          l0Title: 'package manager', l0Tags: ['pnpm'], l1Summary: 'Use pnpm.', l2Keypoints: ['pnpm'], shouldExtract: true,
        }),
        extractor: async ({ target }) => ({
          shouldExtract: true,
          reason: 'durable project decision',
          events: [{
            title: 'Use pnpm',
            summary: 'The project uses pnpm.',
            sourceMessageIds: [target.l5Raw[0]?.id ?? 'missing'],
            sourceBlockId: target.id,
          }],
        }),
      })
      await seed.appendTurn({ user: 'Use pnpm.', assistant: 'Okay.' })
      await seed.appendTurn({ user: 'Continue.', assistant: 'Okay.' })
      const sourceBlock = seed.listBlocks()[0]!
      await seed.addEvent({
        title: 'pnpm alternative note',
        summary: 'A second pnpm memory that should not be reinforced unless selected.',
        sourceMessageIds: [sourceBlock.l5Raw[0]!.id],
        sourceBlockId: sourceBlock.id,
      })
      await seed.close()

      const batch = await runtime.searchEvents(activeSession, 'pnpm') as { batchId: string; evidenceRefs: string[] }
      expect(batch.evidenceRefs).toHaveLength(2)
      await runtime.assess(activeSession, {
        verdict: 'sufficient',
        evidence_refs: batch.evidenceRefs,
        fit: 'The event records the package-manager decision.',
        missing: '',
        next_strategy: 'answer',
      })
      expect(runtime.needsRecordUse(activeSession)).toBe(true)
      const selectedRefs = [batch.evidenceRefs[0]!]
      await runtime.recordUse(activeSession, 'call-audit-1', selectedRefs)
      expect(runtime.needsRecordUse(activeSession)).toBe(false)

      const audit = (await runtime.adminSnapshot(namespace))?.usageReceipts[0]
      expect(audit).toMatchObject({
        id: 'dsh:session-runtime:tool:call-audit-1',
        audit: {
          sessionId: 'session-runtime',
          turn: 9,
          batchId: batch.batchId,
          evidenceRefs: selectedRefs,
          verdict: 'sufficient',
          nextStrategy: 'answer',
        },
      })

      const afterSelected = await runtime.adminSnapshot(namespace)
      const selectedEventId = selectedRefs[0]!.slice('event:'.length)
      expect(afterSelected?.events.find(({ id }) => id === selectedEventId)?.weight.mentionCount).toBe(2)
      expect(afterSelected?.events.find(({ id }) => id !== selectedEventId)?.weight.mentionCount).toBe(1)
      const mentionCounts = new Map(afterSelected?.events.map((event) => [event.id, event.weight.mentionCount]))
      await runtime.searchEvents(activeSession, 'pnpm')
      expect(runtime.needsRecordUse(activeSession)).toBe(true)
      await runtime.recordUse(activeSession, 'call-audit-zero', [])
      expect(runtime.needsRecordUse(activeSession)).toBe(false)
      const afterZero = await runtime.adminSnapshot(namespace)
      for (const event of afterZero?.events ?? []) {
        expect(event.weight.mentionCount).toBe(mentionCounts.get(event.id))
      }
      expect(afterZero?.usageReceipts).toContainEqual(expect.objectContaining({
        id: 'dsh:session-runtime:tool:call-audit-zero',
        eventIds: [],
        elementIds: [],
      }))
    } finally {
      await runtime.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('keeps parallel retrieval batches independently assessable and recordable', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-dsh-parallel-batches-'))
    const database = join(directory, 'memory.db')
    const runtime = new StrataGateRuntime({
      database,
      namespaceMode: 'project',
      namespacePrefix: 'dsh',
      globalNamespace: 'global',
      blockTurnSize: 1,
      blockDecayLambda: 0.3,
      ingestSubagents: false,
      maxOutputTokens: 2048,
    }, fakeModels)
    const activeSession = {
      ...session,
      events: [{ type: 'turn/start', seq: 0, time: 1, data: { turn: 10 } }],
    } as unknown as Session
    const namespace = runtime.namespaceFor(activeSession)

    try {
      const memory = await (runtime as unknown as { space: (active: Session) => Promise<StrataGate> })
        .space(activeSession)
      await memory.appendTurn({
        user: 'Use pnpm for this project.',
        assistant: 'Recorded.',
        threadId: String(activeSession.id),
      })
      const sourceBlock = memory.listBlocks()[0]!
      const event = await memory.addEvent({
        title: 'Use pnpm',
        summary: 'The project package manager is pnpm.',
        sourceMessageIds: [sourceBlock.l5Raw[0]!.id],
        sourceBlockId: sourceBlock.id,
      })
      const projection = await memory.claimNextGraphProjection()
      expect(projection).not.toBeNull()
      await memory.completeGraphProjection(projection!.jobId, {
        reason: 'package manager state',
        nodes: [{
          ref: 'pnpm',
          name: 'pnpm',
          type: 'tool',
          state: 'selected package manager',
          facts: [{ key: 'role', value: 'project package manager', sourceEventIds: [event.id] }],
          sourceEventIds: [event.id],
        }],
        edges: [],
      })
      await memory.addEvent({
        title: 'pnpm compatibility note',
        summary: 'A second pnpm Event should remain unreinforced unless its ref is assessed and used.',
        sourceMessageIds: [sourceBlock.l5Raw[0]!.id],
        sourceBlockId: sourceBlock.id,
      })

      type Batch = { batchId: string; evidenceRefs: string[] }
      const [eventBatch, graphBatch, rawBatch, blockBatch] = await Promise.all([
        runtime.searchEvents(activeSession, 'pnpm') as Promise<Batch>,
        runtime.searchGraph(activeSession, 'pnpm') as Promise<Batch>,
        runtime.searchRaw(activeSession, 'pnpm') as Promise<Batch>,
        runtime.blocks(activeSession) as Promise<Batch>,
      ])
      expect(new Set([eventBatch.batchId, graphBatch.batchId, rawBatch.batchId, blockBatch.batchId]).size).toBe(4)
      expect(eventBatch.evidenceRefs).not.toHaveLength(0)
      expect(graphBatch.evidenceRefs).not.toHaveLength(0)
      expect(rawBatch.evidenceRefs).not.toHaveLength(0)
      expect(blockBatch.evidenceRefs).not.toHaveLength(0)
      const pendingBatchIds = runtime.pendingBatchIds(activeSession)
      expect(new Set(pendingBatchIds)).toEqual(new Set([
        eventBatch.batchId,
        graphBatch.batchId,
        rawBatch.batchId,
        blockBatch.batchId,
      ]))
      const latestBatchId = pendingBatchIds.at(-1)!

      const eventRef = eventBatch.evidenceRefs[0]!
      const graphRef = graphBatch.evidenceRefs[0]!
      const assessment = await runtime.assess(activeSession, {
        verdict: 'sufficient',
        evidence_refs: [eventRef, graphRef, graphRef, 'event:not-real'],
        fit: 'The Event directly records the decision.',
        missing: '',
        next_strategy: 'answer',
      }, eventBatch.batchId) as {
        batchId: string
        evidenceRefs: string[]
        rejectedEvidenceRefs: Array<{ ref: string; reason: string }>
      }
      expect(assessment).toMatchObject({
        batchId: eventBatch.batchId,
        evidenceRefs: [eventRef],
        rejectedEvidenceRefs: [
          { ref: graphRef, reason: 'not_in_batch' },
          { ref: graphRef, reason: 'duplicate' },
          { ref: 'event:not-real', reason: 'not_in_batch' },
        ],
      })

      const invalidRefs = [
        eventRef,
        ...eventBatch.evidenceRefs.slice(1),
        graphRef,
        'event:not-real',
        ' ',
      ]
      await expect(runtime.recordUse(
        activeSession,
        'parallel-invalid',
        invalidRefs,
        eventBatch.batchId,
      )).rejects.toSatisfy((error: Error) => {
        expect(error.message).toContain('memory_record_use rejected invalid evidence refs')
        expect(error.message).toContain(eventBatch.batchId)
        expect(error.message).toContain(graphRef)
        expect(error.message).toContain('event:not-real')
        expect(error.message).toContain('not_adopted')
        expect(error.message).toContain('not_in_batch')
        expect(error.message).toContain('invalid_ref')
        expect(error.message).toContain(`Available refs for ${eventBatch.batchId}`)
        expect(error.message).toContain(`Latest batch: ${latestBatchId}`)
        for (const ref of eventBatch.evidenceRefs.slice(1)) expect(error.message).toContain(ref)
        return true
      })
      expect(runtime.pendingBatchIds(activeSession)).toContain(eventBatch.batchId)

      const recordedEvent = await runtime.recordUse(
        activeSession,
        'parallel-event',
        [eventRef, eventRef],
        eventBatch.batchId,
      ) as { batchId: string; evidenceRefs: string[]; duplicateEvidenceRefs: string[] }
      expect(recordedEvent).toMatchObject({
        batchId: eventBatch.batchId,
        evidenceRefs: [eventRef],
        duplicateEvidenceRefs: [eventRef],
      })

      await runtime.assess(activeSession, {
        verdict: 'sufficient',
        evidence_refs: graphBatch.evidenceRefs,
        fit: 'The graph node reflects Event-backed current state.',
        missing: '',
        next_strategy: 'answer',
      }, graphBatch.batchId)
      await runtime.recordUse(activeSession, 'parallel-graph', graphBatch.evidenceRefs, graphBatch.batchId)

      // rawBatch is older than blockBatch but remains addressable after newer batches are created.
      await runtime.assess(activeSession, {
        verdict: 'sufficient',
        evidence_refs: rawBatch.evidenceRefs,
        fit: 'The archived source message directly states the choice.',
        missing: '',
        next_strategy: 'answer',
      }, rawBatch.batchId)
      await runtime.recordUse(activeSession, 'parallel-raw', rawBatch.evidenceRefs, rawBatch.batchId)
      await runtime.recordUse(activeSession, 'parallel-block-empty', [], blockBatch.batchId)
      expect(runtime.needsRecordUse(activeSession)).toBe(false)

      const receipts = (await runtime.adminSnapshot(namespace))?.usageReceipts ?? []
      expect(receipts).toContainEqual(expect.objectContaining({
        id: 'dsh:session-runtime:tool:parallel-event',
        audit: expect.objectContaining({ batchId: eventBatch.batchId, evidenceRefs: [eventRef] }),
      }))
      expect(receipts).toContainEqual(expect.objectContaining({
        id: 'dsh:session-runtime:tool:parallel-graph',
        audit: expect.objectContaining({ batchId: graphBatch.batchId, evidenceRefs: graphBatch.evidenceRefs }),
      }))
      expect(receipts).toContainEqual(expect.objectContaining({
        id: 'dsh:session-runtime:tool:parallel-block-empty',
        audit: expect.objectContaining({ batchId: blockBatch.batchId, evidenceRefs: [] }),
      }))

      // Existing sequential calls remain valid when batch_id is omitted.
      const sequential = await runtime.searchEvents(activeSession, 'pnpm') as Batch
      await runtime.assess(activeSession, {
        verdict: 'sufficient',
        evidence_refs: sequential.evidenceRefs,
        fit: 'Direct Event evidence.',
        missing: '',
        next_strategy: 'answer',
      })
      await runtime.recordUse(activeSession, 'sequential-compatible', sequential.evidenceRefs)
      expect(runtime.needsRecordUse(activeSession)).toBe(false)
    } finally {
      await runtime.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe('DSH runtime background drain and auto-context snapshot cache', () => {
  const backgroundSession = {
    ...session,
    events: [],
    deriveMessages: () => [{
      id: 'background-current-user',
      role: 'user',
      content: [{ type: 'text', text: 'Any current question.' }],
      source: { kind: 'user' },
    }],
  } as unknown as Session

  function backgroundTurns(count: number): SessionEvent[] {
    const events = [] as unknown[]
    let seq = 0
    for (let turn = 1; turn <= count; turn += 1) {
      events.push(
        { type: 'turn/start', seq: seq++, time: turn * 10, data: { turn } },
        {
          type: 'user/message', seq: seq++, time: turn * 10 + 1,
          data: { id: `u${turn}`, role: 'user', content: [{ type: 'text', text: `Background turn ${turn}` }], source: { kind: 'user' } },
        },
        {
          type: 'assistant/message', seq: seq++, time: turn * 10 + 2,
          data: {
            turn, step: 1,
            message: { id: `a${turn}`, role: 'assistant', content: [{ type: 'text', text: 'OK.' }], source: { kind: 'model', provider: 'test', model: 'test' } },
          },
        },
        { type: 'turn/end', seq: seq++, time: turn * 10 + 3, data: { turn, reason: { kind: 'completed' } } },
      )
    }
    return events as SessionEvent[]
  }

  it('keeps the assemble hot path synchronous: empty snapshot until the background drain settles', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-dsh-bg-sync-'))
    const database = join(directory, 'memory.db')
    const runtime = new StrataGateRuntime({
      database,
      namespaceMode: 'project',
      namespacePrefix: 'dsh',
      globalNamespace: 'global',
      blockTurnSize: 100,
      blockDecayLambda: 0.3,
      ingestSubagents: false,
      maxOutputTokens: 2048,
    }, fakeModels)
    try {
      expect(runtime.buildAutoContext(backgroundSession)).toBe('')
      for (const event of backgroundTurns(1)) runtime.acceptEvent(backgroundSession, event)
      // Turn entry is queued and the hook returns without inline retrieval.
      expect(runtime.buildAutoContext(backgroundSession)).toBe('')
    } finally {
      await runtime.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('serves a snapshot from the cache once the background drain settles', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-dsh-bg-cache-'))
    const database = join(directory, 'memory.db')
    const runtime = new StrataGateRuntime({
      database,
      namespaceMode: 'project',
      namespacePrefix: 'dsh',
      globalNamespace: 'global',
      blockTurnSize: 100,
      blockDecayLambda: 0.3,
      ingestSubagents: false,
      maxOutputTokens: 2048,
    }, fakeModels)
    try {
      for (const event of backgroundTurns(3)) runtime.acceptEvent(backgroundSession, event)
      // 3 queued turns reach DRAIN_THRESHOLD, so the eager drain (150ms) runs
      // off the hot path and refreshes the snapshot cache.
      const deadline = Date.now() + 3_000
      while (runtime.buildAutoContext(backgroundSession) === '' && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      const context = runtime.buildAutoContext(backgroundSession)
      expect(context).not.toBe('')
      expect(context).toContain('[Activated long-term memory]')
    } finally {
      await runtime.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
