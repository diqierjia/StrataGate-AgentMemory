import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'

const clientSource = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
const crypto = { subtle: { digest: async () => new Uint8Array(32).buffer } }

function loadClient(exportsForTest = '', extra: Record<string, unknown> = {}) {
  const source = clientSource.replace(
    "    exports.name = 'stratagate-dsh'",
    `    exports.__test = { ${exportsForTest} }; exports.name = 'stratagate-dsh'`,
  )
  let definition: any
  const React = {
    createContext: (value: unknown) => ({ Provider: 'provider', value }),
    createElement: (...args: unknown[]) => args,
    Fragment: 'fragment',
    useState: (initial: any) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
  }
  runInNewContext(source, {
    URLSearchParams,
    TextEncoder,
    AbortController,
    DOMException,
    Date,
    crypto,
    ...extra,
    window: {
      setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args),
      clearTimeout: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
      __ModuleLoader__: { load: (value: unknown) => { definition = value } },
    },
  })
  const plugin = definition.factory((name: string) => {
    if (name !== 'react') throw new Error(`unexpected dependency: ${name}`)
    return React
  })
  return { plugin, React }
}

function recordUseResult(turn: number, seq: number, callId: string, format = 'legacy') {
  const event = {
    type: 'tool/result', seq,
    data: {
      turn,
      message: {
        source: { kind: 'tool', callId },
        content: [{ type: 'tool_result', isError: false, content: [{
          type: 'text',
          text: JSON.stringify({
            recorded: true,
            namespace: 'dsh:project:test',
            batchId: `batch-${callId}`,
            citations: [{ kind: 'event', id: callId, title: 'Used memory', evidenceRef: `event:${callId}`, detailKind: 'eventId' }],
            retrievedCount: 1,
          }),
        }] }],
      },
    },
  }
  if (format === 'flat') {
    const message = event.data.message as any
    message.isError = false
    message.content = message.content[0].content
  }
  return event
}

describe.each(['legacy', 'flat'])('DSH answer-tail timing (%s)', (format) => {
  it('rejects failed, malformed, unrecorded and unrelated results', () => {
    const { plugin } = loadClient('parseMemoryRecordUseResult')
    const parse = plugin.__test.parseMemoryRecordUseResult
    const event = recordUseResult(18, 305, 'use-1', format)
    expect(parse(event, new Set(['different-call']))).toBeNull()
    for (const failure of ['message-error', 'result-error', 'invalid-json', 'not-recorded']) {
      const invalid = structuredClone(event) as any
      const message = invalid.data.message
      const result = format === 'legacy' ? message.content[0] : message
      if (failure === 'message-error') message.isError = true
      if (failure === 'result-error') result.isError = true
      if (failure === 'invalid-json') result.content[0].text = '{broken'
      if (failure === 'not-recorded') {
        const value = JSON.parse(result.content[0].text)
        value.recorded = false
        result.content[0].text = JSON.stringify(value)
      }
      expect(parse(invalid, new Set(['use-1']))).toBeNull()
    }
  })

  it('retains retrieval order when batches are recorded in reverse order', () => {
    const { plugin } = loadClient('memoryCitationsDefinition, selectMemoryCitations')
    const definition = plugin.__test.memoryCitationsDefinition
    let state = definition.start({}, { event: { type: 'turn/start', data: { turn: 18 } } })
    const apply = (event: any) => { state = definition.update({ state }, { event }) }
    for (const [index, id] of ['first', 'second'].entries()) {
      apply({ type: 'tool/call', seq: index * 2 + 1, data: { turn: 18, callId: `search-${id}`, name: 'memory_search_events' } })
      const result = recordUseResult(18, index * 2 + 2, `search-${id}`, format) as any
      const message = result.data.message
      const content = format === 'legacy' ? message.content[0].content : message.content
      content[0].text = JSON.stringify({ batchId: `batch-${id}` })
      apply(result)
    }
    for (const [index, id] of ['second', 'first'].entries()) {
      apply({ type: 'tool/call', seq: 5 + index * 2, data: { turn: 18, callId: id, name: 'memory_record_use' } })
      apply(recordUseResult(18, 6 + index * 2, id, format))
    }
    const location = definition.buildLocationData({ state }, 'turn')
    const selected = plugin.__test.selectMemoryCitations({ turn: { turn: 18, end: { seq: 10 }, data: new Map([[location.key, location.value]]) }, seq: 9 })
    expect(selected.retrievalGroups.map((group: any) => group.batchId)).toEqual(['batch-first', 'batch-second'])
    expect(selected.citations).toHaveLength(2)
  })

  it.each([4, 8])('renders a result at seq %i without a subsequent Turn', (resultSeq) => {
    const dshChatPackage = JSON.parse(readFileSync(new URL('../node_modules/@deepseek-ai/dsh-client-ui-chat/package.json', import.meta.url), 'utf8'))
    const dshChat = readFileSync(new URL('../node_modules/@deepseek-ai/dsh-client-ui-chat/lib/client.js', import.meta.url), 'utf8')
    expect(dshChatPackage.version).toBe('0.2.0-rc.2')
    expect(dshChat).toMatch(/"conversation\.chat\.turnTail":\s*\{\s*kind: "list"/)
    expect(dshChat).toContain('seq: closing?.finalNode.seq ?? data.seq')

    const { plugin } = loadClient()
    let conversation: any
    const registrations: any[] = []
    plugin.apply({ get: (name: string) => name === 'slots'
      ? { inject: (_name: string, register: () => void) => register(), register: (metadata: unknown, render: unknown) => { registrations.push({ metadata, render }) } }
      : name === 'uiConversation'
        ? { events: { register: (definition: unknown) => { conversation = definition } } }
        : undefined })
    const tail = registrations.find(({ metadata }) => metadata.name === 'conversation.chat.turnTail')
    expect(tail.metadata.id).toBe('stratagate-memory-citations')

    const turnNumber = 6
    let state = conversation.start({}, { event: { type: 'turn/start', seq: 0, data: { turn: turnNumber } } })
    const callId = `use-${resultSeq}`
    state = conversation.update({ state }, { event: { type: 'tool/call', seq: 3, data: { turn: turnNumber, callId, name: 'memory_record_use' } } })
    let location = conversation.buildLocationData({ state }, 'turn')
    const turn = { turn: turnNumber, end: { seq: 12 }, data: { get: (key: string) => key === location.key ? location.value : undefined } }
    const render = () => JSON.stringify(tail.render({ turn, seq: 5 })) // DSH list slot passes owner props, not matched.
    expect(render()).not.toContain('本回答采用了')

    state = conversation.update({ state }, { event: recordUseResult(turnNumber, resultSeq, callId, format) })
    location = conversation.buildLocationData({ state }, 'turn')
    expect(location.value.entries).toHaveLength(1)
    expect(render()).toContain('本回答采用了 1 条记忆')
    expect(JSON.stringify(tail.render({ turn: { turn: 7, end: { seq: 20 }, data: { get: () => undefined } }, seq: 15 })))
      .not.toContain('本回答采用了')

    const futureCallId = `future-${resultSeq}`
    state = conversation.update({ state }, { event: { type: 'tool/call', seq: 11, data: { turn: turnNumber, callId: futureCallId, name: 'memory_record_use' } } })
    state = conversation.update({ state }, { event: recordUseResult(turnNumber, 13, futureCallId, format) })
    location = conversation.buildLocationData({ state }, 'turn')
    expect(render()).toContain('本回答采用了 1 条记忆')
  })
})

describe('DSH short-term Block timing', () => {
  afterEach(() => vi.useRealTimers())

  it.each([false, true])('keeps automatic retries neutral and terminal failures out of conversation reminders (terminal=%s)', (terminal) => {
    const { plugin } = loadClient('shortTermFeed, ShortTermMemoryTurnStatus')
    const feed = plugin.__test.shortTermFeed('session-1')
    feed.snapshot = { payload: { namespace: 'isolated', data: { blockTurnSize: 6, items: [{ id: 'block-1', turnRange: [1, 6],
      processingStatus: 'pending', summaryJob: { status: 'failed', state: terminal ? 'terminal-failed' : 'retryable',
        attempts: terminal ? 3 : 1, nextRetryAt: terminal ? null : '2026-10-22T00:00:00Z' } }] } } }
    const tree = plugin.__test.ShortTermMemoryTurnStatus({ matched: { turn: 6 }, sessionId: 'session-1',
      useSessions: (select: any) => select({ byId: {} }), useWorkspaces: (select: any) => select({ items: [] }),
      useSession: (select: any) => select({ turnEnds: new Map([[6, {}]]), running: false }) })
    if (terminal) expect(tree).toBeNull()
    else {
      expect(JSON.stringify(tree)).toContain('processing')
      expect(JSON.stringify(tree)).not.toMatch(/失败|重试|暂不可用|已完成/)
    }
  })

  function blockFeed(responses: unknown[]) {
    vi.useFakeTimers()
    const fetch = vi.fn(async () => ({ ok: true, json: async () => responses.shift() }))
    const { plugin } = loadClient('shortTermFeed, refreshShortTermFeed, shortTermTurnDisplay, shortTermDisplayLabel, useShortTermMemoryFeed', { fetch })
    const feed = plugin.__test.shortTermFeed('session-1')
    const snapshots: any[] = []
    const listener = (snapshot: unknown) => snapshots.push(snapshot)
    feed.listeners.add(listener)
    return { ...plugin.__test, feed, fetch, snapshots, listener }
  }

  it('does not poll after the ordinary fifth turn of a six-turn Block', async () => {
    const open = { activeThreadId: 'session-1', blockTurnSize: 6, items: [], total: 0, openBlock: { turnRange: [1, 5], turns: 5, capacity: 6 } }
    const { feed, fetch, snapshots, listener, refreshShortTermFeed, shortTermTurnDisplay } = blockFeed([open])
    await refreshShortTermFeed(feed, 'C:/project', '5:idle', true)
    expect(shortTermTurnDisplay(snapshots.at(-1)?.payload?.data, 5)).toMatchObject({ kind: 'progress', current: 5, capacity: 6 })
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(fetch).toHaveBeenCalledTimes(1)
    feed.listeners.delete(listener)
  })

  it('finds the sixth-turn Block through missing, pending, and ready snapshots without Turn 7', async () => {
    const missing = { activeThreadId: 'session-1', blockTurnSize: 6, items: [], total: 0, openBlock: { turnRange: [1, 5], turns: 5, capacity: 6 } }
    const pending = { activeThreadId: 'session-1', blockTurnSize: 6, items: [{ id: 'block-1', blockIndex: 1, turnRange: [1, 6], processingStatus: 'pending', summaryJob: { status: 'running' } }], total: 1, openBlock: { turnRange: null, turns: 0, capacity: 6 } }
    const ready = { ...pending, items: [{ id: 'block-1', blockIndex: 1, turnRange: [1, 6], processingStatus: 'ready', currentLevel: 2, compressionPercent: 31, summaryJob: { status: 'succeeded' } }] }
    const { feed, fetch, snapshots, listener, refreshShortTermFeed, shortTermTurnDisplay, shortTermDisplayLabel } = blockFeed([missing, pending, ready])
    await refreshShortTermFeed(feed, 'C:/project', '6:idle', true)
    expect(shortTermTurnDisplay(snapshots.at(-1)?.payload?.data, 6)).toBeNull()
    expect(vi.getTimerCount()).toBe(1)

    await vi.advanceTimersByTimeAsync(1_200)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(shortTermTurnDisplay(snapshots.at(-1)?.payload?.data, 6)).toMatchObject({ kind: 'processing' })
    await vi.advanceTimersByTimeAsync(1_200)
    const display = shortTermTurnDisplay(snapshots.at(-1)?.payload?.data, 6)
    expect(display).toMatchObject({ kind: 'block' })
    expect(shortTermDisplayLabel(display)).toContain('Block 1 · 第 1–6 轮 · 已压缩为 L2')
    expect(feed.signal).toBe('6:idle')
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(vi.getTimerCount()).toBe(0)
    feed.listeners.delete(listener)
  })

  it('stops when the Block reaches a terminal failure', async () => {
    const missing = { activeThreadId: 'session-1', blockTurnSize: 6, items: [], total: 0, openBlock: { turnRange: [1, 5], turns: 5, capacity: 6 } }
    const failed = { activeThreadId: 'session-1', blockTurnSize: 6, items: [{ id: 'block-1', turnRange: [1, 6], processingStatus: 'pending', summaryJob: { status: 'failed', nextRetryAt: null } }], total: 1, openBlock: { turnRange: null } }
    const { feed, fetch, snapshots, listener, refreshShortTermFeed, shortTermTurnDisplay } = blockFeed([missing, failed])
    await refreshShortTermFeed(feed, 'C:/project', '6:idle', true)
    await vi.advanceTimersByTimeAsync(1_200)
    expect(shortTermTurnDisplay(snapshots.at(-1)?.payload?.data, 6)).toMatchObject({ kind: 'failed' })
    expect(vi.getTimerCount()).toBe(0)
    expect(fetch).toHaveBeenCalledTimes(2)
    feed.listeners.delete(listener)
  })

  it('bounds the wait if the sixth-turn Block never appears', async () => {
    const missing = { activeThreadId: 'session-1', blockTurnSize: 6, items: [], total: 0, openBlock: { turnRange: [1, 5], turns: 5, capacity: 6 } }
    const { feed, fetch, listener, refreshShortTermFeed } = blockFeed([missing, missing])
    await refreshShortTermFeed(feed, 'C:/project', '6:idle', true)
    vi.setSystemTime(Date.now() + 120_000)
    await vi.advanceTimersByTimeAsync(1_200)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
    feed.listeners.delete(listener)
  })

  it('clears the scheduled poll when the last listener unmounts', async () => {
    vi.useFakeTimers()
    const missing = { activeThreadId: 'session-1', blockTurnSize: 6, items: [], total: 0, openBlock: { turnRange: [1, 5], turns: 5, capacity: 6 } }
    const fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => missing })
      .mockImplementationOnce((_url: string, options: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      }))
    const effects: Array<() => any> = []
    const react = {
      createContext: (value: unknown) => ({ Provider: 'provider', value }),
      createElement: (...args: unknown[]) => args,
      Fragment: 'fragment',
      useState: (initial: any) => [typeof initial === 'function' ? initial() : initial, () => {}],
      useEffect: (effect: () => any) => { effects.push(effect) },
    }
    const source = clientSource.replace("    exports.name = 'stratagate-dsh'", "    exports.__test = { shortTermFeed, useShortTermMemoryFeed }; exports.name = 'stratagate-dsh'")
    let definition: any
    runInNewContext(source, { URLSearchParams, TextEncoder, AbortController, DOMException, Date, crypto, fetch,
      window: { setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args), clearTimeout: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer), __ModuleLoader__: { load: (value: unknown) => { definition = value } } } })
    const plugin = definition.factory(() => react)
    plugin.__test.useShortTermMemoryFeed('session-1', 'C:/project', '6:idle')
    const cleanups = effects.map((effect) => effect())
    const feed = plugin.__test.shortTermFeed('session-1')
    await feed.request
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(1)
    cleanups[0]()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(fetch).toHaveBeenCalledTimes(1)

    effects.length = 0
    plugin.__test.useShortTermMemoryFeed('session-1', 'C:/project', '6:idle')
    const nextCleanups = effects.map((effect) => effect())
    await Promise.resolve()
    await Promise.resolve()
    expect(fetch).toHaveBeenCalledTimes(2)
    const requestSignal = (fetch.mock.calls[1]?.[1] as { signal: AbortSignal }).signal
    nextCleanups[0]()
    expect(vi.getTimerCount()).toBe(0)
    expect(requestSignal.aborted).toBe(true)
    await feed.request
    await vi.advanceTimersByTimeAsync(5_000)
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})
