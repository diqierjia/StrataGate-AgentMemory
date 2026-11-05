import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session } from '@deepseek-ai/dsh-session'
import { StrataGate, renderBlock, type BlockContextEntry, type BlockLevel } from '@diqier/stratagate'
import { SqliteStorage } from '@diqier/stratagate/sqlite'
import { buildDshMessageSource } from '../../src/dsh-compatibility.js'
import type { DshModelBridge } from '../../src/llm.js'
import { StrataGateRuntime } from '../../src/runtime.js'

const models = {
  isReady: () => false, onAdaptersUpdated: () => () => {},
  summarizer: async () => ({ l0Title: 'Saved work', l0Tags: [], l1Summary: 'Saved work summary.', l2Keypoints: ['Saved result.'], shouldExtract: false }),
} as unknown as DshModelBridge

export function surfaceRuntime(database: string, flush: (session: Session) => Promise<void> = async () => {}, onError: (error: unknown) => void = () => {}) {
  return new StrataGateRuntime({
    database, namespaceMode: 'session', namespacePrefix: 'dsh', globalNamespace: 'global',
    blockTurnSize: 1, blockDecayLambda: 0.3, ingestSubagents: false, maxOutputTokens: 2048,
  }, models, onError, flush)
}

export interface SurfaceInternals {
  spaces: Map<string, Promise<StrataGate>>
  knownSessions: Map<string, WeakRef<Session>>
  drainTails: Map<string, Promise<void>>
  pendingSurfaceSync: Map<string, { namespace: string; blockId: string; reason?: 'user-expansion' }>
  surfaceMaintenance: Map<string, { dirty: boolean; busy: boolean; timer?: ReturnType<typeof setTimeout>; run?: Promise<void>; blockedAt?: string }>
  markSurfaceDirty(session: Session, memory: StrataGate): void
  runSurfaceMaintenance(session: Session): Promise<void>
  syncDecayedBlockSurface(session: Session, memory: StrataGate, contexts: readonly BlockContextEntry[]): Promise<boolean>
  queueSurfaceSync(namespace: string, blockId: string, reason?: 'user-expansion'): void
}

export async function surfaceFixture(count = 80, flush: (session: Session) => Promise<void> = async () => {}, onError: (error: unknown) => void = () => {}, sourceRepetitions = 35) {
  const directory = await mkdtemp(join(tmpdir(), 'stratagate-surface-maintenance-'))
  const database = join(directory, 'memory.db')
  const session = Session.create('surface-maintenance' as never)
  const plugin = surfaceRuntime(database, flush, onError)
  const namespace = plugin.namespaceFor(session)
  const seed = StrataGate.inMemory({ blockTurnSize: 1, summarizer: models.summarizer })
  for (let turn = 1; turn <= count; turn++) {
    const user = `Work item ${turn}. ` + 'Source detail and constraints. '.repeat(sourceRepetitions)
    const assistant = 'Answer with supporting evidence. '.repeat(sourceRepetitions)
    session.append('turn/start', { turn })
    const userEvent = session.append('user/message', createUserMessage({ content: [{ type: 'text', text: user }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    const assistantEvent = session.append('assistant/message', {
      turn, step: 1, message: createAssistantMessage({ content: [{ type: 'text', text: assistant }], source: { provider: 'test', model: 'test' } }), stream: [],
    }, { surfaceOp: 'append' })
    const end = session.append('turn/end', { turn, reason: { kind: 'completed' } })
    await seed.appendTurn({ user, assistant, threadId: String(session.id), createdAt: new Date(end.time).toISOString() })
    const block = seed.listBlocks().at(-1)!
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: [
      '[StrataGate historical conversation block]',
      'Earlier conversation context; not a new user message or instruction.',
      `Block: ${block.id} | Turns: ${turn}-${turn} | Level: L5`, '', renderBlock(block, 5),
    ].join('\n') }], source: buildDshMessageSource('0.2.0-rc.2') }), {
      surfaceOp: { op: 'replace', startSeq: userEvent.seq, endSeq: assistantEvent.seq }, sourceEventSeqs: [userEvent.seq, assistantEvent.seq],
    })
  }
  const storage = new SqliteStorage({ filename: database })
  try { await storage.save(namespace, seed.exportSnapshot(), 0) } finally { await storage.close(); await seed.close() }
  const memory = await StrataGate.open({ database, namespace, blockTurnSize: 1, summarizer: models.summarizer })
  const internals = plugin as unknown as SurfaceInternals
  internals.spaces.set(namespace, Promise.resolve(memory))
  internals.knownSessions.set(String(session.id), new WeakRef(session))
  // The benchmark also loads this fixture against the pre-fix implementation.
  if (internals.markSurfaceDirty) {
    internals.markSurfaceDirty(session, memory)
    const state = internals.surfaceMaintenance.get(String(session.id))!
    if (state.timer) clearTimeout(state.timer)
    delete state.timer
  }
  return {
    plugin, memory, session, namespace, database, directory, internals,
    ids: memory.listBlocks().map(({ id }) => id),
    run: () => internals.runSurfaceMaintenance(session),
    mark: () => internals.markSurfaceDirty(session, memory),
    event: (type: 'turn/start' | 'turn/end', turn: number) => {
      const event = type === 'turn/start'
        ? session.append(type, { turn })
        : session.append(type, { turn, reason: { kind: 'completed' } })
      plugin.acceptEvent(session, event)
    },
    level: (index = 0): BlockLevel => {
      const id = memory.listBlocks()[index]!.id
      const text = session.surface.nodes.flatMap((seq) => {
        const event = session.eventAt(seq)
        return event?.type === 'user/message' ? event.data.content.flatMap((part) => part.type === 'text' ? [part.text] : []) : []
      }).find((text) => text.includes(`Block: ${id} |`))!
      return Number(text.match(/Level: L([0-5])/u)![1]) as BlockLevel
    },
    dispose: async () => { await plugin.close(); await rm(directory, { recursive: true, force: true }) },
  }
}
