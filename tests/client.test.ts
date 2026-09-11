import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

function loadSupportHelpers(stateValues: unknown[] = [], globals: Record<string, unknown> = {}) {
  const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
  const instrumented = source.replace(
    "    exports.name = 'stratagate-dsh'",
    "    exports.__test = { feedbackDraftMarkdown, issueUrl, buildSupportReport, copyReportAndOpenIssue, downloadSupportReport, readFeedbackDeepLink, readFeedbackNavigationState, readNewFeedbackNavigationState, consumeFeedbackDeepLink, feedbackLinkTarget, navigateToFeedback, installFeedbackLinkNavigation, SupportPage, ISSUE_URL, ISSUE_BODY_HINT, FEEDBACK_AI_PROMPT }; exports.name = 'stratagate-dsh'",
  )
  let definition: any
  runInNewContext(instrumented, {
    Blob,
    URL,
    URLSearchParams,
    ...globals,
    window: {
      ...(globals.window && typeof globals.window === 'object' ? globals.window : {}),
      __ModuleLoader__: { load: (value: unknown) => { definition = value } },
    },
  })
  let stateIndex = 0
  const React = {
    createElement: (...args: unknown[]) => args,
    Fragment: 'fragment',
    useState: (initial: unknown) => [stateIndex < stateValues.length ? stateValues[stateIndex++] : initial, () => {}],
    useEffect: () => {},
    useRef: (initial: unknown) => ({ current: initial }),
  }
  const plugin = definition.factory((name: string) => {
    if (name !== 'react') throw new Error(`unexpected client dependency: ${name}`)
    return React
  })
  return { ...plugin.__test, React }
}

function elementProps(tree: unknown): any[] {
  if (!Array.isArray(tree)) return []
  const props = tree[1] && typeof tree[1] === 'object' ? [tree[1]] : []
  return props.concat(tree.slice(2).flatMap(elementProps))
}

describe('StrataGate Web client contract', () => {
  it('registers its settings section through the DSH module loader', () => {
    const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
    let definition: any
    runInNewContext(source, {
      URLSearchParams,
      window: { __ModuleLoader__: { load: (value: unknown) => { definition = value } } },
    })
    expect(definition.id).toBe('stratagate-dsh')
    const plugin = definition.factory((name: string) => {
      if (name !== 'react') throw new Error(`unexpected client dependency: ${name}`)
      return { createElement: (...args: unknown[]) => args, Fragment: 'fragment', useState: () => [], useEffect: () => {}, useCallback: (fn: unknown) => fn }
    })
    expect(plugin.inject).toEqual(['slots', 'uiConversation'])

    let registration: any
    const slots = {
      inject: (_name: string, callback: () => void) => callback(),
      register: (metadata: unknown, render: unknown) => { registration = { metadata, render } },
    }
    plugin.apply({ get: (name: string) => name === 'slots' ? slots : undefined })
    expect(registration.metadata).toMatchObject({ name: 'settings.section', id: 'stratagate-memory' })
    expect(registration.metadata.label()).toBe('StrataGate-AgentMemory')
    expect(typeof registration.render).toBe('function')
  })

  it('declares the DSH 0.1.2 Conversation package and service contracts', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    expect(manifest.dsh.client.inject).toEqual(['@deepseek-ai/dsh-client-ui-conversation'])
    expect(manifest.dshWorkshop.compatibility.dshVersions).toEqual(['0.1.2-rc.1'])
  })

  it('parses and consumes only the StrataGate feedback deep link while preserving unrelated URL state', () => {
    const { readFeedbackDeepLink, consumeFeedbackDeepLink } = loadSupportHelpers()
    const location = {
      pathname: '/',
      search: '?settings=stratagate-memory&stratagateView=feedback&namespace=dsh%3Aproject%3Atest&keep=1',
      hash: '#conversation',
    }
    let replaced = ''
    const history = { state: { retained: true }, replaceState: (_state: unknown, _title: string, next: string) => { replaced = next } }
    expect(readFeedbackDeepLink(location)).toEqual({ namespace: 'dsh:project:test' })
    expect(consumeFeedbackDeepLink(location, history)).toBe('/?keep=1#conversation')
    expect(replaced).toBe('/?keep=1#conversation')
    expect(readFeedbackDeepLink({ search: '?settings=other&stratagateView=feedback&namespace=dsh%3Aproject%3Atest' })).toBeNull()
    expect(readFeedbackDeepLink({ search: '?settings=stratagate-memory&stratagateView=other&namespace=dsh%3Aproject%3Atest' })).toBeNull()
  })

  it('prefers formal Settings navigation for same-origin Feedback links and falls back to the HTTP deep link', () => {
    const { feedbackLinkTarget, installFeedbackLinkNavigation, navigateToFeedback } = loadSupportHelpers()
    const href = 'http://127.0.0.1:10259/?settings=stratagate-memory&stratagateView=feedback&namespace=dsh%3Aproject%3Atest'
    const anchor = { getAttribute: (name: string) => name === 'href' ? href : null }
    const target = { closest: (selector: string) => selector === 'a[href]' ? anchor : null }
    const location = {
      href: 'http://127.0.0.1:10259/',
      origin: 'http://127.0.0.1:10259',
      assigned: '',
      assign(next: string) { this.assigned = next },
    }
    expect(feedbackLinkTarget(target, location)).toMatchObject({ anchor, url: { href } })
    expect(feedbackLinkTarget({ closest: () => null }, location)).toBeNull()
    expect(feedbackLinkTarget({ closest: () => ({ getAttribute: () => 'https://example.com/' }) }, location)).toBeNull()

    let listener: (event: any) => void = () => { throw new Error('click listener was not installed') }
    let removed = false
    const documentRef = {
      addEventListener: (_name: string, next: (event: any) => void, capture: boolean) => {
        expect(capture).toBe(true)
        listener = next
      },
      removeEventListener: (_name: string, next: (event: any) => void, capture: boolean) => {
        expect(next).toBe(listener)
        expect(capture).toBe(true)
        removed = true
      },
    }
    const openSectionCalls: unknown[][] = []
    const ctx = {
      get: (name: string) => name === 'settingsNavigation'
        ? { openSection: (...args: unknown[]) => { openSectionCalls.push(args) } }
        : undefined,
    }
    const dispose = installFeedbackLinkNavigation(ctx, documentRef, location)
    let prevented = false
    listener({ target, button: 0, preventDefault: () => { prevented = true } })
    expect(prevented).toBe(true)
    expect(openSectionCalls).toEqual([[
      'stratagate-memory',
      { view: 'feedback', namespace: 'dsh:project:test' },
    ]])
    expect(location.assigned).toBe('')
    listener({ target, preventDefault: () => { prevented = true } })
    expect(openSectionCalls).toHaveLength(2)
    expect(feedbackLinkTarget({ parentElement: target }, location)).toMatchObject({ anchor, url: { href } })
    expect(navigateToFeedback({ get: () => undefined }, new URL(href), location)).toBe('http')
    expect(location.assigned).toBe(href)
    dispose()
    expect(removed).toBe(true)
  })

  it('accepts Feedback route state from the Settings host without reading localized DOM controls', () => {
    const { readFeedbackNavigationState, readNewFeedbackNavigationState, navigateToFeedback } = loadSupportHelpers()
    const first = { view: 'feedback', namespace: 'dsh:project:test' }
    const repeated = { view: 'feedback', namespace: 'dsh:project:test' }
    expect(readFeedbackNavigationState({ view: 'feedback', namespace: 'dsh:project:test' }))
      .toEqual({ namespace: 'dsh:project:test' })
    expect(readFeedbackNavigationState({ view: 'other', namespace: 'dsh:project:test' })).toBeNull()
    expect(readFeedbackNavigationState({ view: 'feedback', namespace: '' })).toBeNull()
    expect(readNewFeedbackNavigationState(first, first)).toBeNull()
    expect(readNewFeedbackNavigationState(first, repeated)).toEqual({ namespace: 'dsh:project:test' })

    const openSection = (sectionId: string, state: unknown) => {
      expect(sectionId).toBe('stratagate-memory')
      expect(state).toEqual({ view: 'feedback', namespace: 'dsh:project:test' })
    }
    const route = new URL('http://127.0.0.1:10259/?settings=stratagate-memory&stratagateView=feedback&namespace=dsh%3Aproject%3Atest')
    expect(navigateToFeedback({ get: () => ({ openSection }) }, route, {
      assign: () => { throw new Error('formal navigation must not use the HTTP fallback') },
    })).toBe('host')

    const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
    expect(source).toContain('const disposeDeepLink = openFeedbackDeepLink(ctx)')
    expect(source).toContain('disposeDeepLink()')
  })

  it('keeps short-term status in the chat content flow and does not register a composer dock', () => {
    const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
    let definition: any
    runInNewContext(source, {
      URLSearchParams,
      window: { __ModuleLoader__: { load: (value: unknown) => { definition = value } } },
    })
    const plugin = definition.factory((name: string) => {
      if (name !== 'react') throw new Error(`unexpected client dependency: ${name}`)
      return { createElement: (...args: unknown[]) => args, Fragment: 'fragment', useState: () => [], useEffect: () => {}, useCallback: (fn: unknown) => fn, useRef: () => ({ current: null }) }
    })
    const registrations: any[] = []
    const slots = {
      inject: (_name: string, callback: () => void) => callback(),
      register: (metadata: unknown, render: unknown) => { registrations.push({ metadata, render }) },
    }
    const settingWrites: unknown[][] = []
    const pluginSettings = {
      getSnapshot: () => ({ value: { showShortTermStatus: true } }),
      subscribe: () => () => {},
      set: (...args: unknown[]) => { settingWrites.push(args) },
      unset: () => {},
    }
    plugin.apply({ get: (name: string) => name === 'slots'
      ? slots
      : name === 'uiConversation'
        ? { events: { register: () => {} } }
        : name === 'settingsScope'
          ? { bind: () => pluginSettings }
          : undefined })
    const tail = registrations.find(({ metadata }) => metadata.name === 'conversation.chat.turnTail')
    const settings = registrations.find(({ metadata }) => metadata.name === 'settings.section')
    expect(typeof tail.render).toBe('function')
    expect(tail.metadata.inject()).toEqual({ hooks: { pluginSettings } })
    settings.metadata.inject().setShortTermStatus(false)
    expect(settingWrites).toEqual([['showShortTermStatus', false]])
    expect(source).toContain('function ShortTermMemoryTurnStatus({ matched, sessionId, useSession, useSessions, useWorkspaces })')
    expect(source).toContain('短期记忆块 · ')
    expect(source).toContain('正在压缩…')
    expect(source).toContain('已压缩为 L')
    expect(source).toContain("api('sources', { namespace, blockId: block.id }, { signal: controller.signal })")
    expect(source).toContain("api('memories', { namespace, kind: 'blocks', threadId: sessionId, offset, limit: 200 }, { signal })")
    expect(source).toContain('data?.activeThreadId === feed.sessionId')
    expect(source).toContain('void refreshShortTermFeed(feed, workspacePath, signal, true)')
    expect(source).toContain("if (reason?.name === 'AbortError') throw reason")
    expect(registrations.some(({ metadata }) => metadata.name === 'conversation.composer.dock')).toBe(false)
    expect(registrations.some(({ metadata }) => metadata.name === 'sidebar.footer.action')).toBe(false)
    expect(source).not.toContain('ShortTermMemoryDock')
    expect(source).not.toContain('sg-stm-dock')
    expect(source).not.toContain('IntersectionObserver')
    expect(source).not.toContain('MemoryCompressionWidget')
    expect(source).not.toContain('sg-compression-panel')
  })

  it('defaults the inline short-term status to visible and respects the persisted setting', () => {
    const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
    const instrumented = source.replace(
      "    exports.name = 'stratagate-dsh'",
      "    exports.__test = { shortTermStatusVisible }; exports.name = 'stratagate-dsh'",
    )
    let definition: any
    runInNewContext(instrumented, {
      URLSearchParams,
      window: { __ModuleLoader__: { load: (value: unknown) => { definition = value } } },
    })
    const plugin = definition.factory((name: string) => {
      if (name !== 'react') throw new Error(`unexpected client dependency: ${name}`)
      return { createElement: (...args: unknown[]) => args }
    })
    const { shortTermStatusVisible } = plugin.__test
    expect(shortTermStatusVisible(null)).toBe(true)
    expect(shortTermStatusVisible({ value: {} })).toBe(true)
    expect(shortTermStatusVisible({ value: { showShortTermStatus: true } })).toBe(true)
    expect(shortTermStatusVisible({ value: { showShortTermStatus: false } })).toBe(false)
  })

  it('maps progress and multiple persisted Blocks to only their real Turn positions', () => {
    const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
    const instrumented = source.replace(
      '    exports.name = \'stratagate-dsh\'',
      '    exports.__test = { shortTermTurnDisplay }; exports.name = \'stratagate-dsh\'',
    )
    let definition: any
    runInNewContext(instrumented, {
      URLSearchParams,
      window: { __ModuleLoader__: { load: (value: unknown) => { definition = value } } },
    })
    const plugin = definition.factory((name: string) => {
      if (name !== 'react') throw new Error(`unexpected client dependency: ${name}`)
      return { createElement: (...args: unknown[]) => args }
    })
    const display = plugin.__test.shortTermTurnDisplay
    for (let turn = 1; turn < 6; turn += 1) {
      expect(display({ blockTurnSize: 6, blocks: [], openBlock: { turnRange: [1, turn], turns: turn, capacity: 6 } }, turn))
        .toMatchObject({ kind: 'progress', current: turn, capacity: 6 })
    }
    expect(display({ blockTurnSize: 6, blocks: [], openBlock: { turnRange: [1, 6], turns: 6, capacity: 6 } }, 6)).toMatchObject({ kind: 'processing', current: 6, capacity: 6 })

    const blocks = [
      { id: 'block-a', turnRange: [1, 6], processingStatus: 'ready', currentLevel: 2, compressionPercent: 21 },
      { id: 'block-b', turnRange: [7, 12], processingStatus: 'ready', currentLevel: 4, compressionPercent: 63 },
    ]
    expect(display({ blocks, openBlock: { turnRange: null } }, 1)).toBeNull()
    expect(display({ blocks, openBlock: { turnRange: null } }, 6)).toMatchObject({ kind: 'block', block: { id: 'block-a', currentLevel: 2 } })
    expect(display({ blocks, openBlock: { turnRange: null } }, 12)).toMatchObject({ kind: 'block', block: { id: 'block-b', currentLevel: 4 } })
    expect(display({ items: blocks, openBlock: { turnRange: null } }, 12)).toMatchObject({
      kind: 'block',
      block: { id: 'block-b', currentLevel: 4 },
    })
  })

  it('routes session switches to the correct workspace and rebuilds status from persisted API data', () => {
    const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
    const instrumented = source.replace(
      '    exports.name = \'stratagate-dsh\'',
      '    exports.__test = { sessionWorkspacePath, shortTermTurnDisplay }; exports.name = \'stratagate-dsh\'',
    )
    let definition: any
    runInNewContext(instrumented, {
      URLSearchParams,
      window: { __ModuleLoader__: { load: (value: unknown) => { definition = value } } },
    })
    const plugin = definition.factory((name: string) => {
      if (name !== 'react') throw new Error(`unexpected client dependency: ${name}`)
      return { createElement: (...args: unknown[]) => args }
    })
    const { sessionWorkspacePath, shortTermTurnDisplay } = plugin.__test
    const sessions = {
      'child-a': { parentId: 'root-a', cwd: 'C:/stale-a' },
      'root-a': { cwd: 'C:/project-a' },
      'root-b': { cwd: 'D:/project-b' },
    }
    const workspaces = [
      { path: 'C:/project-a', sessionIds: ['root-a'] },
      { path: 'D:/project-b', sessionIds: ['root-b'] },
    ]
    expect(sessionWorkspacePath('child-a', sessions, workspaces)).toBe('C:/project-a')
    expect(sessionWorkspacePath('root-b', sessions, workspaces)).toBe('D:/project-b')

    const restoredPayload = {
      blocks: [{ id: 'persisted', turnRange: [13, 18], processingStatus: 'ready', currentLevel: 4, compressionPercent: 61 }],
      openBlock: { turnRange: null },
    }
    expect(shortTermTurnDisplay(restoredPayload, 18)).toMatchObject({
      kind: 'block',
      block: { id: 'persisted', currentLevel: 4, compressionPercent: 61 },
    })
  })

  it('keeps preview selection read-only and leaves the actual layer visibly marked', () => {
    const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
    const detailSource = source.slice(source.indexOf('function ShortTermMemoryBlockDetail'), source.indexOf('function ShortTermMemoryTurnStatus'))
    expect(detailSource).toContain('const actualLayer = Number(block.currentLevel)')
    expect(detailSource).toContain('const [selectedPreviewLayer, setSelectedPreviewLayer] = React.useState(actualLayer)')
    expect(detailSource).toContain('onClick: () => setSelectedPreviewLayer(level)')
    expect(detailSource).toContain("level === actualLayer ? 'actual ' : ''")
    expect(detailSource).toContain("level === actualLayer ? '当前使用' : ''")
    expect(detailSource).not.toContain("api('blocks/expand'")
  })

  it('publishes adopted memory citations into the closing answer turn tail', () => {
    const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
    let definition: any
    runInNewContext(source, {
      URLSearchParams,
      window: { __ModuleLoader__: { load: (value: unknown) => { definition = value } } },
    })
    const plugin = definition.factory((name: string) => {
      if (name !== 'react') throw new Error(`unexpected client dependency: ${name}`)
      return {
        createElement: (...args: unknown[]) => args,
        Fragment: 'fragment',
        useState: () => [],
        useEffect: () => {},
        useCallback: (fn: unknown) => fn,
      }
    })
    let conversationDefinition: any
    const registrations: any[] = []
    const slots = {
      inject: (_name: string, callback: () => void) => callback(),
      register: (metadata: unknown, render: unknown) => { registrations.push({ metadata, render }) },
    }
    plugin.apply({
      get: (name: string) => name === 'slots'
        ? slots
        : name === 'uiConversation'
          ? { events: { register: (value: unknown) => { conversationDefinition = value } } }
          : undefined,
    })

    expect(conversationDefinition.kind).toBe('stratagate-memory-citations')
    const startEvent = { type: 'turn/start', seq: 0, data: { turn: 7 } }
    const recordUseCall = {
      type: 'tool/call',
      seq: 3,
      data: { turn: 7, step: 2, callId: 'record-use-1', name: 'memory_record_use', arguments: '{}' },
    }
    const recordUseResult = {
      type: 'tool/result',
      seq: 4,
      data: {
        turn: 7,
        step: 2,
        message: {
          source: { kind: 'tool', callId: 'record-use-1' },
          content: [{
            type: 'tool_result',
            isError: false,
            content: [{
              type: 'text',
              text: JSON.stringify({
                recorded: true,
                namespace: 'dsh:project:test',
                batchId: 'batch_1',
                retrievedCount: 5,
                retrievedMemories: [
                  { kind: 'event', id: 'event-1', title: 'Use pnpm', evidenceRef: 'event:event-1', batchId: 'batch_1', detailKind: 'eventId' },
                  { kind: 'event', id: 'event-2', title: 'pnpm compatibility', evidenceRef: 'event:event-2', batchId: 'batch_1', detailKind: 'eventId' },
                  { kind: 'graph', id: 'node-1', title: 'pnpm', evidenceRef: 'graph-node:node-1:expanded', batchId: 'batch_1', detailKind: 'nodeId', expanded: true },
                  { kind: 'block', id: 'block-1', title: 'Package manager', evidenceRef: 'block:block-1:level:4', batchId: 'batch_1', detailKind: 'blockId', level: 4, expanded: true },
                  { kind: 'block', id: 'block-2', title: 'Tooling notes', evidenceRef: 'block:block-2:level:2', batchId: 'batch_1', detailKind: 'blockId', level: 2 },
                ],
                citations: [
                  { kind: 'event', id: 'event-1', title: 'Use pnpm', evidenceRef: 'event:event-1', batchId: 'batch_1', detailKind: 'eventId' },
                  { kind: 'graph', id: 'node-1', title: 'pnpm', evidenceRef: 'graph-node:node-1:expanded', batchId: 'batch_1', detailKind: 'nodeId', expanded: true },
                  { kind: 'block', id: 'block-1', title: 'Package manager', evidenceRef: 'block:block-1:level:4', batchId: 'batch_1', detailKind: 'blockId', level: 4, expanded: true },
                ],
              }),
            }],
          }],
        },
      },
    }
    const started = conversationDefinition.start({}, { event: startEvent })
    const tracked = conversationDefinition.update({ state: started }, { event: recordUseCall })
    const updated = conversationDefinition.update({ state: tracked }, { event: recordUseResult })
    const location = conversationDefinition.buildLocationData({ state: updated }, 'turn')
    expect(location.key).toBe(conversationDefinition.kind)
    const tail = registrations.find(({ metadata }) => metadata.name === 'conversation.chat.turnTail')
    const locationData = new Map([[location.key, location.value]])
    const matched = tail.metadata.select({ turn: { data: { get: (key: string) => locationData.get(key) } }, seq: 8 })
    expect(matched.citations.map((citation: any) => citation.kind)).toEqual(['event', 'graph', 'block'])
    expect(matched.citations[2]).toMatchObject({ id: 'block-1', level: 4, expanded: true, namespace: 'dsh:project:test' })
    expect(matched.retrievedCount).toBe(5)
    expect(matched.retrievalGroups).toHaveLength(1)
    expect(matched.retrievalGroups[0].memories).toHaveLength(5)
    expect(tail.metadata.select({ turn: { turn: 7, data: { get: (key: string) => locationData.get(key) } }, seq: 2 })).toMatchObject({ turn: 7, citations: [], retrievalGroups: [] })
    const legacyUpdated = conversationDefinition.update({ state: started }, {
      event: {
        type: 'stratagate/memory-citations',
        seq: 5,
        data: {
          turn: 7,
          namespace: 'dsh:project:legacy',
          citations: [{ kind: 'event', id: 'legacy-event', evidenceRef: 'event:legacy-event', detailKind: 'eventId' }],
        },
      },
    })
    expect(legacyUpdated.entries).toEqual([expect.objectContaining({ namespace: 'dsh:project:legacy' })])
    expect(source).toContain("event.data.name === 'memory_record_use'")
    expect(source).toContain("api('sources', { namespace: citation.namespace, [citation.detailKind]: citation.id })")
    expect(source).toContain('展开到 L')
    expect(source).toContain("'本回答参考了 ' + citations.length + ' 条记忆'")
    expect(source).toContain("'已进行 ' + retrievalGroups.length + ' 次检索，共返回 ' + retrievedCount + ' 条记忆，未采用'")
    expect(source).toContain('sg-answer-retrieval-toggle')
    expect(source).toContain("'aria-expanded': showRetrieved")
    expect(source).toContain("'检索过程'")
    expect(source).toContain('retrievalGroupLabel(groupIndex)')
    expect(source).toContain("memoryIndex + 1 + '.'")
    expect(source).toContain("open(memory, false)")
    expect(source).toContain("'检索候选 · 未采用'")
    expect(source).toContain("function CitationGraph({ citation, detail, primary, adopted = true })")
    expect(source).toContain("title: '关联信息'")
    expect(source).toContain("adopted ? '来源对话 ·未作为加入本次上下文' : '来源对话 · 未用于本次回答'")
    expect(source).toContain("title: '详细情况'")
    expect(source).toContain("title: 'L0–L5 记忆层级'")
    expect(source).toContain("'本次采用'")
    expect(source).toContain("citationPreview(content)")
    expect(source).toContain("title: selected ? undefined : content")
    expect(source).not.toContain("facts.slice(0, 12)")
    expect(source).not.toContain("sourceMessages.slice(0, 12)")
  })

  it('shows a quiet answer-tail note when retrieved memories were not adopted', () => {
    const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
    let definition: any
    runInNewContext(source, {
      URLSearchParams,
      window: { __ModuleLoader__: { load: (value: unknown) => { definition = value } } },
    })
    const plugin = definition.factory((name: string) => {
      if (name !== 'react') throw new Error(`unexpected client dependency: ${name}`)
      return {
        createElement: (...args: unknown[]) => args,
        Fragment: 'fragment',
        useState: (initial: unknown) => [initial, () => {}],
        useEffect: () => {},
        useCallback: (fn: unknown) => fn,
      }
    })
    let conversationDefinition: any
    const registrations: any[] = []
    const slots = {
      inject: (_name: string, callback: () => void) => callback(),
      register: (metadata: unknown, render: unknown) => { registrations.push({ metadata, render }) },
    }
    plugin.apply({
      get: (name: string) => name === 'slots'
        ? slots
        : name === 'uiConversation'
          ? { events: { register: (value: unknown) => { conversationDefinition = value } } }
          : undefined,
    })

    const started = conversationDefinition.start({}, { event: { type: 'turn/start', seq: 0, data: { turn: 8 } } })
    const searchEarlier = conversationDefinition.update({ state: started }, {
      event: { type: 'tool/call', seq: 1, data: { turn: 8, callId: 'search-earlier', name: 'memory_search_events' } },
    })
    const searchedEarlier = conversationDefinition.update({ state: searchEarlier }, {
      event: {
        type: 'tool/result',
        seq: 2,
        data: {
          turn: 8,
          message: {
            source: { kind: 'tool', callId: 'search-earlier' },
            content: [{ type: 'tool_result', isError: false, content: [{ type: 'text', text: JSON.stringify({ batchId: 'batch_1' }) }] }],
          },
        },
      },
    })
    const searchLater = conversationDefinition.update({ state: searchedEarlier }, {
      event: { type: 'tool/call', seq: 3, data: { turn: 8, callId: 'search-later', name: 'memory_search_raw' } },
    })
    const searchedLater = conversationDefinition.update({ state: searchLater }, {
      event: {
        type: 'tool/result',
        seq: 4,
        data: {
          turn: 8,
          message: {
            source: { kind: 'tool', callId: 'search-later' },
            content: [{ type: 'tool_result', isError: false, content: [{ type: 'text', text: JSON.stringify({ batchId: 'batch_2' }) }] }],
          },
        },
      },
    })
    const trackedLater = conversationDefinition.update({ state: searchedLater }, {
      event: { type: 'tool/call', seq: 5, data: { turn: 8, callId: 'record-use-later', name: 'memory_record_use' } },
    })
    const completedLater = conversationDefinition.update({ state: trackedLater }, {
      event: {
        type: 'tool/result',
        seq: 6,
        data: {
          turn: 8,
          message: {
            source: { kind: 'tool', callId: 'record-use-later' },
            content: [{
              type: 'tool_result',
              isError: false,
              content: [{ type: 'text', text: JSON.stringify({
                recorded: true,
                namespace: 'dsh:project:test',
                batchId: 'batch_2',
                retrievalSequence: 1,
                retrievedCount: 2,
                retrievedMemories: [
                  { kind: 'event', id: 'event-1', title: '编辑器选择', evidenceRef: 'event:event-1', batchId: 'batch_2', detailKind: 'eventId' },
                  { kind: 'block', id: 'block-1', title: '开发环境讨论', evidenceRef: 'block:block-1:level:3', batchId: 'batch_2', detailKind: 'blockId', level: 3 },
                ],
                citations: [],
              }) }],
            }],
          },
        },
      },
    })
    const trackedEarlier = conversationDefinition.update({ state: completedLater }, {
      event: { type: 'tool/call', seq: 7, data: { turn: 8, callId: 'record-use-earlier', name: 'memory_record_use' } },
    })
    const completed = conversationDefinition.update({ state: trackedEarlier }, {
      event: {
        type: 'tool/result',
        seq: 8,
        data: {
          turn: 8,
          message: {
            source: { kind: 'tool', callId: 'record-use-earlier' },
            content: [{
              type: 'tool_result',
              isError: false,
              content: [{ type: 'text', text: JSON.stringify({
                recorded: true,
                namespace: 'dsh:project:test',
                batchId: 'batch_1',
                retrievalSequence: 99,
                retrievedCount: 1,
                retrievedMemories: [
                  { kind: 'event', id: 'event-0', title: '更早的检索结果', evidenceRef: 'event:event-0', batchId: 'batch_1', detailKind: 'eventId' },
                ],
                citations: [],
              }) }],
            }],
          },
        },
      },
    })
    const location = conversationDefinition.buildLocationData({ state: completed }, 'turn')
    const tail = registrations.find(({ metadata }) => metadata.name === 'conversation.chat.turnTail')
    const matched = tail.metadata.select({ turn: { data: { get: () => location.value } }, seq: 10 })
    expect(matched).toMatchObject({ citations: [], retrievedCount: 3 })
    expect(matched.retrievalGroups).toHaveLength(2)
    expect(matched.retrievalGroups.map((group: any) => group.batchId)).toEqual(['batch_1', 'batch_2'])
    expect(matched.retrievalGroups[0].memories.map((memory: any) => memory.title)).toEqual(['更早的检索结果'])
    expect(matched.retrievalGroups[1].memories.map((memory: any) => memory.title)).toEqual(['编辑器选择', '开发环境讨论'])
    const rendered = tail.render({ matched })
    expect(JSON.stringify(rendered)).toContain('已进行 2 次检索，共返回 3 条记忆，未采用')
    expect(JSON.stringify(rendered)).not.toContain('stratagate-answer-citations')

    let stateCall = 0
    const expandedPlugin = definition.factory((name: string) => {
      if (name !== 'react') throw new Error(`unexpected client dependency: ${name}`)
      return {
        createElement: (...args: unknown[]) => args,
        Fragment: 'fragment',
        useState: (initial: unknown) => [stateCall++ === 0 ? true : initial, () => {}],
        useEffect: () => {},
        useCallback: (fn: unknown) => fn,
      }
    })
    const expandedRegistrations: any[] = []
    expandedPlugin.apply({
      get: (name: string) => name === 'slots'
        ? { inject: (_name: string, callback: () => void) => callback(), register: (metadata: unknown, render: unknown) => { expandedRegistrations.push({ metadata, render }) } }
        : name === 'uiConversation'
          ? { events: { register: () => {} } }
          : undefined,
    })
    const expandedTail = expandedRegistrations.find(({ metadata }) => metadata.name === 'conversation.chat.turnTail')
    const expanded = expandedTail.render({ matched })
    expect(JSON.stringify(expanded)).toContain('检索过程')
    expect(JSON.stringify(expanded)).toContain('第一次检索')
    expect(JSON.stringify(expanded)).toContain('第二次检索')
    expect(JSON.stringify(expanded)).toContain('更早的检索结果')
    expect(JSON.stringify(expanded)).toContain('编辑器选择')
    expect(JSON.stringify(expanded)).toContain('开发环境讨论')
    expect(JSON.stringify(expanded)).toContain('未采用')
  })

  it('shows the unified project brand, mascot, usage count, and GitHub Star link', () => {
    const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
    expect(source).toContain('StrataGate-AgentMemory')
    expect(source).toContain('__STRATAGATE_MASCOT_DATA_URL__')
    expect(source).toContain('StrataGate 已在当前工作区中帮助使用记忆 ')
    expect(source).toContain('为 StrataGate 点 🌟🌟')
    expect(source).toContain("https://github.com/diqierjia/StrataGate-AgentMemory")
    expect(source).toContain("rel: 'noopener noreferrer'")
  })

  it('uses the user-defined DSH Workspace title and keeps the compact header collision-free', () => {
    const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
    expect(source).toContain('function MemoryPage({ useWorkspaces, useSessions, navigationState, usePluginSettings, setEffort, resetEffort, setShortTermStatus })')
    expect(source).toContain("settingsScope.bind({ namespace: 'stratagate-memory' })")
    expect(source).toContain("pluginSettingsScope.set('structuredReasoningEffort', mode)")
    expect(source).toContain("pluginSettingsScope.unset('structuredReasoningEffort')")
    expect(source).toContain("pluginSettingsScope.set('showShortTermStatus', visible)")
    expect(source).toContain("role: 'switch', 'aria-checked': showShortTermStatus")
    expect(source).toContain('状态行跟随对应回答一起滚动')
    expect(source).toContain('const workspaceItems = useWorkspaces((state) => state.items)')
    expect(source).toContain('const sessionById = useSessions((state) => state.byId || {})')
    expect(source).toContain("String(session?.title || '').trim()")
    expect(source).toContain("workspace.sessionIds")
    expect(source).toContain("String(workspace.title || '').trim()")
    expect(source).toContain("value.split(':project:').pop()")
    expect(source).toContain('display:grid;grid-template-columns:minmax(0,1fr)')
    expect(source).not.toContain("title: '重新加载', onClick: refresh")
  })

  it('uses the memory-first three-part information architecture', () => {
    const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
    expect(source).toContain("const [section, setSection] = React.useState('short')")
    expect(source).toContain("[['short', '短期记忆'], ['long', '长期记忆'], ['more', '更多']]")
    expect(source).toContain('块衰减总览')
    expect(source).toContain('开放块 · 未封存')
    expect(source).toContain('距最新封存块')
    expect(source).toContain('分层内容预览')
    expect(source).toContain('展开到这一层')
    expect(source).toContain("api('blocks/expand'")
    expect(source).toContain('用户展开')
    expect(source).toContain('Agent 展开')
    expect(source).toContain('曾展开')
    expect(source).toContain('当前对话：')
    expect(source).toContain('Block 分布滑轨')
    expect(source).toContain('L0 层最浅最简略，L5 层最深最详细，离当前对话越远，Block 会逐渐简略。')
    expect(source).toContain('document.body.appendChild(popover)')
    expect(source).toContain('setOpenMenuLevel')
    expect(source).toContain('完整内容')
    expect(source).toContain("React.useState('graph')")
    expect(source).toContain('知识图谱')
    expect(source).toContain('事件时间线')
    expect(source).toContain("{ '今天': [], '本周': [], '更早': [] }")
    expect(source).toContain('发生时间未知')
    expect(source).toContain('正在升级长期记忆')
    expect(source).toContain('搜索记忆、人物、项目、概念')
    expect(source).not.toContain("['overview', '概览']")
    expect(source).not.toContain('sg-stats')
    expect(source).not.toContain('封存时为 L5')
  })

  it('places external AI memory import before memory structure in More', () => {
    const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
    expect(source).toContain("['import', '⇄', '导入别的 AI 记忆'")
    expect(source.indexOf("['import', '⇄', '导入别的 AI 记忆'")).toBeLessThan(source.indexOf("['structure', '◇', '记忆结构'"))
    expect(source).toContain("function ImportPage({ namespace, onBack, refresh })")
    expect(source).toContain("api('import', { namespace }")
    expect(source).toContain('复制以下提示词到其他 AI 对话中')
    expect(source).toContain('粘贴结果，先分析再导入')
    expect(source).toContain('分析并预览')
    expect(source).toContain('低置信度结果请人工选择处理方式')
    expect(source).toContain('已完成 ')
    expect(source).toContain('正在判断第 ')
    expect(source).toContain('关闭，后台继续')
    expect(source).toContain("operation: 'status', namespace, jobId: job.jobId")
    expect(source).toContain('连接暂时中断，正在自动重试')
    expect(source).toContain('撤销本次导入')
  })

  it('inherits the resolved light, dark, or system appearance from DSH theme tokens', () => {
    const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
    expect(source).toContain('color-scheme:inherit')
    expect(source).toContain('--sg-page:var(--dsw-alias-bg-layer-2')
    expect(source).toContain('--sg-text:var(--dsw-alias-label-primary')
    expect(source).toContain('--sg-accent:var(--dsw-alias-state-business-primary')
    expect(source).not.toContain('@media (prefers-color-scheme:dark)')
    expect(source).not.toContain('--dsh-color-background')
  })

  it('keeps long-term memory summary-first and moves complex exploration to full screen', () => {
    const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
    expect(source).toContain('sg-summary-layout')
    expect(source).toContain('sg-node-bubble')
    expect(source).toContain("eventCount + ' 条相关事件'")
    expect(source).toContain('查看详情 →')
    expect(source).toContain("'筛选 ▾'")
    expect(source).toContain("'⛶ 全屏查看'")
    expect(source).toContain('sg-event-popover')
    expect(source).toContain('onMouseEnter: cancelHide')
    expect(source).toContain('event.narrative')
    expect(source).not.toContain("'Block · ' + event.sourceBlockId.slice")
  })

  it('keeps the full-screen explorer anchored to the viewport', () => {
    const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
    expect(source).toContain('.sg-long-explorer.fullscreen{position:fixed;inset:12px')
    expect(source).toContain('@keyframes sg-view-in{from{opacity:0}to{opacity:1}}')
    expect(source).not.toContain('@keyframes sg-view-in{from{opacity:0;transform:')
  })

  it('provides synchronized knowledge graph zoom controls', () => {
    const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
    expect(source).toContain("className: 'sg-graph-zoom'")
    expect(source).toContain("type: 'range', min: '25', max: '240'")
    expect(source).toContain("graph.on('zoom', updateZoom)")
    expect(source).toContain("renderedPosition: { x: container.clientWidth / 2, y: container.clientHeight / 2 }")
    expect(source).toContain('wheelSensitivity: .22')
  })

  it('makes graph and memory list truncation explicit and pageable', () => {
    const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
    expect(source).toContain('nodeLimit = 100')
    expect(source).toContain('.slice(0, nodeLimit)')
    expect(source).not.toContain('.slice(0, 40)')
    expect(source).toContain("'再显示 100 个'")
    expect(source).toContain("function Pagination({ page, loading, error, onOffset })")
    expect(source).toContain("'上一页'")
    expect(source).toContain("'下一页'")
    expect(source).toContain("kind: 'blocks'")
    expect(source).toContain("kind: 'events'")
    expect(source).toContain("kind: 'audit'")
    expect(source).toContain("kind: 'events', initialItems: events, initialPage: eventPage, fallbackLimit: 40")
    expect(source).toContain("kind: 'blocks', initialItems: blocks, initialPage: blockPage, fallbackLimit: 40")
  })

  it('sizes graph nodes by stable long-term importance without conflating selection', () => {
    const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
    expect(source).toContain('function graphNodeImportance(nodes, edges, project)')
    expect(source).toContain('const GRAPH_NODE_RADIUS = { peripheral: 30, normal: 38, important: 46, core: 54 }')
    expect(source).toContain('new Set(node.sourceEventIds || []).size')
    expect(source).toContain("event.status !== 'forgotten' && event.status !== 'archived'")
    expect(source).toContain("edges.filter((edge) => edge.status === 'active')")
    expect(source).toContain('node.supportingEvents || []')
    expect(source).toContain('workspaceAffinity')
    expect(source).toContain('React.useMemo(() => graphNodeImportance(nodes, edges, project), [nodes, edges, project])')
    expect(source).toContain('nodes: visibleNodes, edges, clusters, importance: nodeImportance')
    expect(source).toContain('size: visualImportance.radius * 2')
    expect(source).not.toContain('r: selected ? 47 : 42')
  })

  it('renders server-side Leiden communities with Cytoscape.js and fCoSE', () => {
    const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
    const buildSource = readFileSync(new URL('../scripts/build-client.mjs', import.meta.url), 'utf8')
    expect(buildSource).toContain("import cytoscape from 'cytoscape'")
    expect(buildSource).toContain("import fcose from 'cytoscape-fcose'")
    expect(buildSource).toContain('cytoscape.use(fcose)')
    expect(source).toContain('const cytoscape = globalThis.__StrataGateGraphLibraries?.cytoscape')
    expect(source).toContain("name: 'fcose'")
    expect(source).toContain("node.sg-community")
    expect(source).toContain("edge.sg-memory-edge.cross-community")
    expect(source).toContain("graph.clusters || []")
    expect(source).toContain('Leiden 主题群组')
    expect(source).toContain('全部语义标签')
    expect(source).toContain("node.tags || []")
    expect(source).not.toContain('function graphClusters(')
    expect(source).not.toContain('function graphClusterLayout(')
  })

  it('makes a well-supported workspace project larger than a sparsely mentioned tool', () => {
    const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
    const start = source.indexOf('const GRAPH_NODE_RADIUS')
    const end = source.indexOf('function GraphCanvas', start)
    const context: any = {}
    runInNewContext(source.slice(start, end) + '\nthis.graphNodeImportance = graphNodeImportance', context)
    const event = (id: string, updatedAt: string) => ({ id, status: 'active', updatedAt })
    const node = (id: string, name: string, eventCount: number, updatedAt: string) => ({
      id, name, aliases: [], updatedAt, sourceEventIds: Array.from({ length: eventCount }, (_, index) => `${id}-event-${index}`),
      supportingEvents: Array.from({ length: eventCount }, (_, index) => event(`${id}-event-${index}`, updatedAt)),
    })
    const nodes = [
      node('project', 'StrataGate-AgentMemory', 8, '2026-08-25T00:00:00Z'),
      node('memory', 'Memory Service', 5, '2026-08-20T00:00:00Z'),
      node('agent', 'Agent', 3, '2026-07-01T00:00:00Z'),
      node('json', 'parseJsonResponse', 1, '2025-08-25T00:00:00Z'),
    ]
    const edges = [
      { id: 'edge-1', fromNodeId: 'project', toNodeId: 'memory', status: 'active', updatedAt: '2026-08-25T00:00:00Z' },
      { id: 'edge-2', fromNodeId: 'project', toNodeId: 'agent', status: 'active', updatedAt: '2026-08-24T00:00:00Z' },
      { id: 'edge-3', fromNodeId: 'memory', toNodeId: 'agent', status: 'active', updatedAt: '2026-08-20T00:00:00Z' },
    ]
    const importance = context.graphNodeImportance(nodes, edges, 'StrataGate-AgentMemory')
    expect(importance.get('project').radius).toBe(54)
    expect(importance.get('json').radius).toBe(30)
    expect(importance.get('project').radius).toBeGreaterThan(importance.get('json').radius)
    expect([...importance.values()].every(({ radius }: { radius: number }) => radius >= 30 && radius <= 54)).toBe(true)
  })

  it('keeps all feedback data local and puts only the paste hint in Feedback Issue URLs', () => {
    const { SupportPage, ISSUE_URL, ISSUE_BODY_HINT } = loadSupportHelpers()
    const privateChat = 'private chat content'
    const logContent = 'diagnostic log content'
    const graphContent = 'private graph state'
    const tree = SupportPage({
      overview: { pluginVersion: '1.2.3', harnessVersion: '4.5.6' },
      selected: { blockTurnSize: 6, blocks: 1, events: 1, graphNodes: 1, failedJobDetails: [{ lastError: logContent }] },
      data: {
        blocks: [{ id: 'block-1', l5Raw: [{ id: 'message-1', role: 'user', content: privateChat }] }],
        events: [{ id: 'event-1', title: 'event title' }],
        graph: { nodes: [{ id: 'node-1', name: graphContent }], edges: [] },
      },
      recentError: logContent,
      onBack: () => {},
    })
    const hrefs = elementProps(tree).map((props) => props.href).filter(Boolean)
    expect(hrefs.length).toBeGreaterThanOrEqual(3)
    const issueLinks = hrefs.filter((href) => href.startsWith(ISSUE_URL))
    expect(issueLinks).toHaveLength(2)
    const feedbackIssue = issueLinks.find((href) => href !== ISSUE_URL)!
    expect(new URL(feedbackIssue).searchParams.get('body')).toBe(ISSUE_BODY_HINT)
    for (const href of hrefs) {
      expect(href).not.toContain(privateChat)
      expect(href).not.toContain(logContent)
      expect(href).not.toContain(graphContent)
    }
  })

  it('keeps an empty feedback page incomplete and formats structured AI drafts without guessing', () => {
    const { SupportPage, feedbackDraftMarkdown, FEEDBACK_AI_PROMPT } = loadSupportHelpers()
    const tree = SupportPage({ namespace: 'dsh:project:test', overview: {}, selected: {}, data: {}, recentError: '', onBack: () => {} })
    const props = elementProps(tree)
    expect(props.find((value) => value['aria-label'] === '本地反馈报告预览')).toBeUndefined()
    expect(props.some((value) => value.disabled === true && value.children === undefined)).toBe(true)
    expect(JSON.stringify(tree)).toContain('请先描述问题，或使用 AI 帮你填写。')
    expect(FEEDBACK_AI_PROMPT).toContain('feedback_prepare')
    expect(FEEDBACK_AI_PROMPT).toContain('不要猜测')
    expect(feedbackDraftMarkdown({
      description: '保存草稿失败。',
      reproduction: ['打开反馈页', '点击保存'],
      expected: '草稿保存在本地。',
      actual: '页面显示错误。',
      errorContext: 'EACCES',
    })).toBe('## 问题描述\n\n保存草稿失败。\n\n## 复现步骤\n\n1. 打开反馈页\n2. 点击保存\n\n## 预期行为\n\n草稿保存在本地。\n\n## 实际行为\n\n页面显示错误。\n\n## 相关错误信息\n\nEACCES')
  })

  it('shows a persistent top AI-copy notice with retry, close, sticky, and scroll visibility handling', () => {
    let copied = ''
    const { SupportPage, FEEDBACK_AI_PROMPT } = loadSupportHelpers(
      [false, false, false, '', '', '', '', false, true],
      { navigator: { clipboard: { writeText: async (value: string) => { copied = value } } } },
    )
    const tree = SupportPage({ namespace: 'dsh:project:test', overview: {}, selected: {}, data: {}, recentError: '', onBack: () => {} })
    const serialized = JSON.stringify(tree)
    expect(serialized).toContain('AI 提示词已复制')
    expect(serialized).toContain('回到刚才出现问题的会话，直接粘贴并发送')
    const props = elementProps(tree)
    const retry = props.find((value) => value.children === undefined && value.className === 'sg-quiet-button' && typeof value.onClick === 'function')
    expect(retry).toBeDefined()
    retry!.onClick()
    expect(copied).toBe(FEEDBACK_AI_PROMPT)
    expect(props.find((value) => value['aria-label'] === '关闭 AI 提示词提示')).toBeDefined()

    const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
    expect(source).toContain('.sg-support-ai-notice{position:sticky;top:8px')
    expect(source).toContain("scrollIntoView({ behavior: 'smooth', block: 'start' })")
  })

  it('builds complete option-controlled reports without the former 4500 character truncation', () => {
    const { buildSupportReport } = loadSupportHelpers()
    const longChat = 'private-chat-' + 'x'.repeat(6000) + '-tail-marker'
    const data = {
      blocks: [{ id: 'block-1', l5Raw: [{ id: 'message-1', role: 'user', content: longChat, createdAt: '2026-09-04T00:00:00Z' }], unrelatedAppState: 'must-not-leak' }],
      events: [{ id: 'event-1', title: 'Event title', summary: 'Event summary' }],
      graph: { nodes: [{ id: 'node-1', name: 'Graph node', currentState: 'Graph content' }], edges: [] },
      unrelatedAppState: 'must-not-leak',
    }
    const base = buildSupportReport({ problemContent: '## 问题描述\n\nSomething failed.', data })
    expect(base).not.toContain('## 诊断日志')
    expect(base).not.toContain('## 用户主动附加的记忆数据')

    const logs = buildSupportReport({ problemContent: '## 问题描述\n\nSomething failed.', recentError: 'frontend exploded', selected: { failedJobDetails: [{ kind: 'event-extraction', lastErrorFull: 'full failure' }] }, data, includeLogs: true })
    expect(logs).toContain('## 诊断日志')
    expect(logs).toContain('frontend exploded')
    expect(logs).not.toContain('## 用户主动附加的记忆数据')

    const memory = buildSupportReport({ problemContent: '## 问题描述\n\nSomething failed.', data, includeMemory: true, willingToContribute: true })
    expect(memory.length).toBeGreaterThan(6000)
    expect(memory).toContain('-tail-marker')
    expect(memory).not.toContain('内容已截断')
    expect(memory).toContain('## 用户主动附加的记忆数据（可能包含私人对话）')
    expect(memory).toContain('自动脱敏不能保证识别所有敏感信息')
    expect(memory).toContain('## 贡献意愿')
    expect(memory).toContain('我愿意尝试修复并提交 PR')
    expect(memory).not.toContain('must-not-leak')
  })

  it('copies the frozen report and opens an Issue URL containing only title and the paste hint', async () => {
    const { buildSupportReport, copyReportAndOpenIssue, issueUrl, ISSUE_BODY_HINT } = loadSupportHelpers()
    const report = buildSupportReport({ problemContent: '## 问题描述\n\nSomething failed.', data: { blocks: [{ l5Raw: [{ content: 'chat snapshot' }] }] }, includeMemory: true })
    const copied: string[] = []
    const opened: string[] = []
    const actionOrder: string[] = []
    const popup: any = { opener: 'original' }
    const success = await copyReportAndOpenIssue(
      report,
      { writeText: async (value: string) => { actionOrder.push('copy'); copied.push(value) } },
      (url: string) => { actionOrder.push('open'); opened.push(url); return popup },
    )
    expect(success).toEqual({ copied: true, opened: true, error: '' })
    expect(copied).toEqual([report])
    expect(opened).toEqual([issueUrl()])
    expect(new URL(opened[0]!).searchParams.get('body')).toBe(ISSUE_BODY_HINT)
    expect(opened[0]!).not.toContain('chat snapshot')
    expect(actionOrder).toEqual(['copy', 'open'])
    expect(popup.opener).toBeNull()

    const failure = await copyReportAndOpenIssue(
      report,
      { writeText: async () => { throw new Error('permission denied') } },
      () => null,
    )
    expect(failure).toMatchObject({ copied: false, opened: false })
    expect(failure.error).toContain('permission denied')
    expect(report).toContain('chat snapshot')

    const unavailable = await copyReportAndOpenIssue(report, null, () => null)
    expect(unavailable).toMatchObject({ copied: false, opened: false })
    expect(unavailable.error).toContain('不支持自动复制')

    const titled: string[] = []
    await copyReportAndOpenIssue(report, { writeText: async () => {} }, (url: string) => { titled.push(url); return {} }, 'Draft title')
    expect(new URL(titled[0]!).searchParams.get('title')).toBe('Draft title')
    expect(new URL(titled[0]!).searchParams.get('body')).toBe(ISSUE_BODY_HINT)
    expect(titled[0]!).not.toContain('chat snapshot')
  })

  it('starts the Issue action immediately instead of waiting for the local draft save', async () => {
    let resolveSave: ((value: unknown) => void) | undefined
    const calls: string[] = []
    const { SupportPage } = loadSupportHelpers(
      [false, false, false, '', '', '', '## 问题描述\n\nLocal failure', false],
      {
        fetch: () => new Promise((resolve) => { resolveSave = resolve }),
        navigator: { clipboard: { writeText: () => { calls.push('copy'); return Promise.resolve() } } },
        window: { open: () => { calls.push('open'); return {} } },
      },
    )
    const tree = SupportPage({ namespace: 'dsh:project:test', overview: {}, selected: {}, data: {}, recentError: '', onBack: () => {} })
    const button = elementProps(tree).find((props) => props.className === 'sg-primary-link')
    expect(button).toBeDefined()
    button!.onClick()
    expect(calls).toEqual(['copy', 'open'])
    resolveSave!({ ok: true, json: async () => ({}) })
    await Promise.resolve()
    await Promise.resolve()
  })

  it('shows the report only on demand and reuses the exact preview for copy and download', async () => {
    const closedHelpers = loadSupportHelpers([true, false, false, '', '', '', '## 问题描述\n\nLocal failure', false, false, false])
    const closedTree = closedHelpers.SupportPage({ namespace: 'dsh:project:test', overview: {}, selected: {}, data: {}, recentError: 'local-only-error', onBack: () => {} })
    expect(elementProps(closedTree).find((props) => props['aria-label'] === '本地反馈报告预览')).toBeUndefined()
    expect(elementProps(closedTree).find((props) => props.children === undefined && props['aria-expanded'] === false)).toBeDefined()

    const { copyReportAndOpenIssue, downloadSupportReport, SupportPage } = loadSupportHelpers([true, false, false, '', '', '', '## 问题描述\n\nLocal failure', false, false, true])
    let objectUrlCalls = 0
    let revokeCalls = 0
    let clickCalls = 0
    let openCalls = 0
    const copied: string[] = []
    let appended: any
    const link: any = { style: {}, remove: () => {} }
    const documentRef: any = {
      body: { appendChild: (value: unknown) => { appended = value } },
      createElement: () => Object.assign(link, { click: () => { clickCalls += 1 } }),
    }
    const urlRef = {
      createObjectURL: (blob: Blob) => { objectUrlCalls += 1; expect(blob.type).toBe('text/plain;charset=utf-8'); return 'blob:report' },
      revokeObjectURL: (url: string) => { revokeCalls += 1; expect(url).toBe('blob:report') },
    }

    const tree = SupportPage({ namespace: 'dsh:project:test', overview: {}, selected: {}, data: {}, recentError: 'local-only-error', onBack: () => {} })
    const preview = elementProps(tree).find((props) => props['aria-label'] === '本地反馈报告预览')?.value
    expect(JSON.stringify(tree)).toContain('将复制的内容')
    expect(preview).toContain('## 诊断日志')
    expect(preview).toContain('local-only-error')
    expect(objectUrlCalls).toBe(0)
    expect(clickCalls).toBe(0)
    expect(openCalls).toBe(0)

    await copyReportAndOpenIssue(preview, { writeText: async (value: string) => { copied.push(value) } }, () => { openCalls += 1; return null })
    const blob = downloadSupportReport(preview, documentRef, urlRef)
    expect(copied).toEqual([preview])
    expect(await blob.text()).toBe(preview)
    expect(appended).toBe(link)
    expect(link.href).toBe('blob:report')
    expect(link.download).toBe('stratagate-diagnostics.txt')
    expect(link.download).not.toContain('workspace')
    expect(objectUrlCalls).toBe(1)
    expect(clickCalls).toBe(1)
    expect(openCalls).toBe(1)
    expect(revokeCalls).toBe(1)
  })

  it('keeps failures reassuring and exposes related Block settings under More', () => {
    const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
    expect(source).toContain('lastErrorFull')
    expect(source).toContain('原始内容已经保存，不会丢失。')
    expect(source).toContain('原始记忆已保存，不会丢失。')
    expect(source).toContain('技术错误详情')
    expect(source).toContain("['raw', '{}', '原始数据'")
    expect(source).toContain("['audit', '↗', '使用记录'")
    expect(source).toContain("['settings', '⚙', '高级设置'")
    expect(source).not.toContain("['responses', '模型响应']")
    expect(source).toContain("type: 'number'")
    expect(source).toContain("step: '1'")
    expect(source).toContain("step: '0.05'")
    expect(source).toContain('每个 Block 的对话轮数')
    expect(source).toContain('尚未封存的内容按新阈值继续处理。')
    expect(source).toContain('为保持按对话轮数计算的遗忘速度，建议 λ 调整为')
    expect(source).toContain('采用建议值')
    expect(source).toContain('默认 0.3；数字越小，记忆遗忘越慢，消耗 token 越多，不建议大于 0.4。')
    expect(source).toContain("method: 'PATCH'")
    expect(source).toContain('当前工作区')
    expect(source).toContain("['support', '?', '反馈与支持'")
    expect(source).toContain('复制报告并打开 GitHub Issue')
    expect(source).toContain('下载诊断文件')
    expect(source).toContain('本地反馈报告预览')
    expect(source).toContain('附加诊断日志')
    expect(source).toContain('附加记忆数据（可能包含对话内容）')
    expect(source).toContain('默认诊断不包含原始聊天、L5、Event 或 Graph 内容。')
    expect(source).toContain('发现问题？ ')
    expect(source).toContain("'提交反馈'")
  })

  it('shows a red processing banner with a loading icon while memory work is active', () => {
    const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
    expect(source).toContain('sg-processing-alert')
    expect(source).toContain('sg-processing-icon')
    expect(source).toContain('正在触发记忆整理')
    expect(source).toContain("role: 'status'")
    expect(source).toContain('processingJobs')
    expect(source).toContain("'/api/stratagate/dashboard'")
    expect(source).toContain("'If-None-Match'")
    expect(source).toContain("document.addEventListener('visibilitychange'")
    expect(source).toContain('pollFast ? 2500 : 30000')
    expect(source).not.toContain('window.setInterval')
    expect(source).toContain("status === 'waiting'")
  })
})
