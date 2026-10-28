import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import { describe, expect, it, vi } from 'vitest'

function loadSupportHelpers(stateValues: unknown[] = [], globals: Record<string, unknown> = {}, legacyGitHub?: boolean) {
  let source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
  if (legacyGitHub !== undefined) source = source.replace('const GITHUB_FEEDBACK_ENABLED = false', 'const GITHUB_FEEDBACK_ENABLED = ' + legacyGitHub)
  const instrumented = source.replace(
    "    exports.name = 'stratagate-dsh'",
    "    exports.__test = { feedbackEmailUrl, copyReportAndComposeEmail, handleFeedbackEmailResult, HeaderCommunityLinks, GITHUB_FEEDBACK_ENABLED, FEEDBACK_EMAIL, EMAIL_BODY_HINT, feedbackDraftMarkdown, restoreFeedbackDraftValues, shouldExpandFeedbackPreview, handleFeedbackIssueResult, issueUrl, buildSupportReport, copyReportAndOpenIssue, downloadSupportReport, readFeedbackDeepLink, readFeedbackNavigationState, readNewFeedbackNavigationState, readGraphNodeNavigationState, readGraphNodeDeepLink, consumeFeedbackDeepLink, consumeGraphNodeDeepLink, feedbackLinkTarget, navigateToFeedback, navigateToGraphNode, installFeedbackLinkNavigation, NodePill, StaticEntityPill, EventMetadata, MemoryWeightTrajectory, ProcessingStatus, summaryUnavailable, SummaryUnavailable, TopicBootstrapNotice, taskStatus, ProfilePage, SettingsPage, SupportPage, SidebarPlacementPrompt, readSidebarPromptState, ISSUE_URL, ISSUE_BODY_HINT, FEEDBACK_AI_PROMPT, apply }; exports.name = 'stratagate-dsh'",
  ).replace('exports.__test = {', 'exports.__test = { DailyNotesPage, DailyNotesSettings, renderDailyMarkdown, dailyRelative, dailyInline, DreamingPanel, MemoryPage, LongTermPage, ShortTermPage, BlockLayerPanel, LayerPreview, visibleBlockLevel, BlockSelectionFeedback,')
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
  const React = (globals.react as any) || {
    createContext: (value: unknown) => ({ Provider: 'provider', value }),
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

function buttonProps(tree: any, label: string): any {
  if (!Array.isArray(tree)) return undefined
  if (tree[0] === 'button' && tree.slice(2).includes(label)) return tree[1]
  return tree.map((child) => buttonProps(child, label)).find(Boolean)
}

function deepElementProps(tree: unknown): any[] {
  const props: any[] = []
  const visit = (value: unknown) => {
    if (!Array.isArray(value)) return
    if ((typeof value[0] === 'string' || typeof value[0] === 'function') && value[1] && typeof value[1] === 'object' && !Array.isArray(value[1])) props.push(value[1])
    value.forEach(visit)
  }
  visit(tree)
  return props
}

describe('StrataGate Web client contract', () => {
  it('separates preview from applying a layer and allows replacing a pending selection with the current layer', () => {
    const { BlockLayerPanel, LayerPreview, visibleBlockLevel } = loadSupportHelpers()
    const onExpand = vi.fn()
    const panel = BlockLayerPanel({ block: { currentLevel: 4 }, detail: { layers: [] } })
    expect(JSON.stringify(panel)).toContain('预览不会改变助手可见的内容')
    expect(JSON.stringify(panel)).toContain('助手可见：L4')
    expect(onExpand).not.toHaveBeenCalled()
    const layer = LayerPreview({ layer: { level: 0 }, currentLevel: 4, allowExpand: true, onExpand })
    buttonProps(layer, '让助手参考 L0').onClick({ stopPropagation() {} })
    expect(onExpand).toHaveBeenCalledWith(0)
    const current = { layer: { level: 4 }, currentLevel: 4, allowExpand: true, onExpand }
    expect(buttonProps(LayerPreview(current), '让助手参考 L4')).toBeUndefined()
    expect(JSON.stringify(LayerPreview(current))).toContain('助手可见')
    expect(buttonProps(LayerPreview({ ...current, pendingSelection: true }), '让助手参考 L4')).toBeDefined()
    expect(buttonProps(LayerPreview({ ...current, pendingSelection: true, busy: true }), '让助手参考 L4').disabled).toBe(true)
    expect(buttonProps(LayerPreview({ ...current, currentLevel: 0, allowExpand: false }), '让助手参考 L4')).toBeUndefined()
    expect(visibleBlockLevel({ currentLevel: 4, surfaceLevelKnown: false })).toBeNull()
    expect(visibleBlockLevel({ currentLevel: 4, surfaceLevelKnown: true })).toBe(4)
    const waiting = BlockLayerPanel({ block: { currentLevel: 0 }, detail: { layers: [{ level: 4 }] }, expandingLevel: -1, selectionBusy: true, onExpand })
    expect(deepElementProps(waiting).find(props => props.layer)?.busy).toBe(true)
  })

  it('explains waiting and failure next to the Block, retaining the actual available layer', () => {
    const { BlockSelectionFeedback } = loadSupportHelpers()
    const block = { currentLevel: 0, targetLevel: 4, surfaceLevelKnown: true }
    const waiting = BlockSelectionFeedback({ block: { ...block, surfaceSync: { status: 'pending', message: '已保存选择，打开这段对话后生效。' } } })
    expect(JSON.stringify(waiting)).toContain('已选择 L4。已保存选择，打开这段对话后生效。 助手当前可见 L0。')
    const blocked = BlockSelectionFeedback({ block: { ...block, surfaceSync: { status: 'blocked', message: '当前模型预计放不下，请选更简略的层级。' } } })
    expect(deepElementProps(blocked).some(props => props.role === 'alert')).toBe(true)
    expect(JSON.stringify(blocked)).toContain('助手当前可见 L0')
    expect(JSON.stringify(blocked)).toContain('请选更简略的层级')
    expect(BlockSelectionFeedback({ block: { ...block, surfaceSync: { status: 'applied' } } })).toBeNull()
    const unknown = BlockSelectionFeedback({ block: { ...block, surfaceLevelKnown: false }, feedback: { status: 'pending', message: '暂时无法确认应用结果，请刷新后查看。' } })
    expect(JSON.stringify(unknown)).toContain('助手可见的层级尚未确认')
  })

  it.each(['applied', 'pending', 'blocked', 'rejected', 'interrupted', 'refresh-failed'])('refreshes the actual state and reports a %s expansion response', async (status) => {
    const hooks: any[] = []
    let cursor = 0
    const react = {
      createContext: (value: unknown) => ({ value }), createElement: (...args: unknown[]) => args, Fragment: 'fragment',
      useState(initial: any) {
        const index = cursor++
        if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial
        return [hooks[index], (value: any) => { hooks[index] = typeof value === 'function' ? value(hooks[index]) : value }]
      },
      useRef(initial: unknown) { const index = cursor++; return hooks[index] ??= { current: initial } },
      useEffect: () => {},
    }
    const fetch = vi.fn(async (url: string, options: any) => {
      if (status === 'interrupted' && options?.method === 'PATCH') throw new TypeError('Failed to fetch')
      return {
        ok: status !== 'rejected' || options?.method !== 'PATCH', status: 409,
        json: async () => url.includes('/sources') ? { layers: [] } : status === 'rejected' ? { error: '容量不足' }
          : { surfaceSync: { status: status === 'refresh-failed' ? 'applied' : status, message: status + ' 的真实状态' } },
      }
    })
    const { ShortTermPage, BlockSelectionFeedback } = loadSupportHelpers([], { react, fetch })
    const block = { id: 'block-1', currentLevel: 0, targetLevel: 4, surfaceLevelKnown: true, sequence: 1, surfaceSync: undefined as unknown }
    const refresh = vi.fn(async () => {
      if (status === 'refresh-failed' && refresh.mock.calls.length === 1) throw new Error('read failed')
      if (!['rejected', 'interrupted'].includes(status)) block.surfaceSync = { status: status === 'refresh-failed' ? 'applied' : status, message: status + ' 的真实状态' }
      if (status === 'applied' || status === 'refresh-failed') block.currentLevel = 4
    })
    const props = { blocks: [block], conversations: [], namespace: 'test', activeThreadId: 'thread-1', refresh }
    const render = () => { cursor = 0; return ShortTermPage(props) }
    const toggle = deepElementProps(render()).find((item) => item.className === 'sg-block-toggle')!
    toggle.onClick()
    const expand = deepElementProps(render()).find((item) => typeof item.onExpand === 'function')!
    await Promise.all([expand.onExpand(4), expand.onExpand(4)])
    expect(fetch.mock.calls.filter(([, options]) => options?.method === 'PATCH')).toHaveLength(1)
    const feedbackProps = deepElementProps(render()).find(item => item.block && 'feedback' in item)!
    const text = JSON.stringify(BlockSelectionFeedback(feedbackProps))
    expect(refresh).toHaveBeenCalledTimes(1)
    if (status === 'rejected') expect(text).toContain('暂时无法应用 L4。容量不足')
    else if (status === 'applied') expect(text).toContain('已应用 L4，供助手后续回复参考')
    else if (status === 'interrupted' || status === 'refresh-failed') {
      expect(text).toContain('暂时无法确认应用结果')
      expect(text).not.toContain('暂时无法应用')
      await buttonProps(BlockSelectionFeedback(feedbackProps), '刷新状态').onClick()
      expect(refresh).toHaveBeenCalledTimes(2)
      const refreshed = deepElementProps(render()).find(item => item.block && 'feedback' in item)!
      expect(refreshed.feedback).toBeNull()
    }
    else expect(text).toContain(status + ' 的真实状态')
    if (status !== 'applied') expect(text).toContain(status === 'interrupted' || status === 'refresh-failed' ? '上次确认助手可见 L0' : '助手当前可见 L0')
  })

  it('shows projection drain status and requires restart instead of offering resume for a conflicted Dreaming', () => {
    const baseRun = { id: 'review', sessionId: null, status: 'running', waitingForProjection: true,
      activity: '等待当前后台目录整理完成，随后开始 Dreaming', completed: 0, total: 2 }
    const globals = { react: {
      createContext: (value: unknown) => ({ value }), createElement: (...args: unknown[]) => args, Fragment: 'fragment',
      useState: (initial: unknown) => [initial, () => {}], useRef: (current: unknown) => ({ current }),
      useEffect: () => {}, useCallback: (callback: unknown) => callback,
    } }
    const { DreamingPanel } = loadSupportHelpers([], globals)
    const waiting = DreamingPanel({ namespace: 'test', initialRun: baseRun, active: true, available: true })
    expect(JSON.stringify(waiting)).toContain('Dreaming 正在准备…')
    expect(JSON.stringify(waiting)).toContain('等待当前后台目录整理完成')
    expect(buttonProps(waiting, '暂停')).toBeDefined()
    expect(buttonProps(waiting, '终止')).toBeDefined()
    const conflicted = DreamingPanel({ namespace: 'test', initialRun: { ...baseRun, status: 'paused', replanRequired: true,
      reason: '请终止本轮后重新开始；已保存的修改会保留' }, active: true, available: true })
    expect(buttonProps(conflicted, '继续')).toBeUndefined()
    expect(buttonProps(conflicted, '终止')).toBeDefined()
    expect(JSON.stringify(conflicted)).toContain('请终止本轮后重新开始')
    const paused = DreamingPanel({ namespace: 'test', initialRun: { ...baseRun, status: 'paused', replanRequired: false }, active: true, available: true })
    expect(buttonProps(paused, '继续')).toBeDefined()
  })

  it('preserves feedback navigation from workspace A to B with one dashboard request', async () => {
    // Run the production MemoryPage and dependency-aware hook effects across
    // renders. Requests stay pending during the namespace transition.
    const hooks: any[] = []
    const effects: Array<() => void> = []
    const requests: Array<{ namespace: string; signal: AbortSignal; resolve: (value: unknown) => void }> = []
    const same = (a: any[] | undefined, b: any[]) => a && a.length === b.length && a.every((value, i) => Object.is(value, b[i]))
    let cursor = 0
    let dirty = true
    const react = {
      createContext: (value: unknown) => ({ value }), createElement: (...args: unknown[]) => args, Fragment: 'fragment',
      useState(initial: any) {
        const index = cursor++
        if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial
        return [hooks[index], (value: any) => {
          const next = typeof value === 'function' ? value(hooks[index]) : value
          if (!Object.is(hooks[index], next)) { hooks[index] = next; dirty = true }
        }]
      },
      useRef(initial: unknown) { const index = cursor++; return hooks[index] ??= { current: initial } },
      useCallback(callback: unknown, deps: any[]) {
        const index = cursor++
        if (!same(hooks[index]?.deps, deps)) hooks[index] = { deps, callback }
        return hooks[index].callback
      },
      useEffect(effect: () => (() => void) | undefined, deps: any[]) {
        const index = cursor++
        if (same(hooks[index]?.deps, deps)) return
        const previous = hooks[index]
        hooks[index] = { deps }
        effects.push(() => { previous?.cleanup?.(); hooks[index].cleanup = effect() })
      },
    }
    const { MemoryPage, SupportPage } = loadSupportHelpers([], {
      react, AbortController,
      document: { hidden: true, addEventListener() {}, removeEventListener() {} },
      window: { location: { search: '' } },
      fetch: (url: string, options: any) => new Promise(resolve => requests.push({
        namespace: new URL(url, 'http://localhost').searchParams.get('namespace') || 'A', signal: options.signal,
        resolve: data => resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => data }),
      })),
    })
    let navigationState: unknown
    let tree: any
    const workspaces: unknown[] = []
    const sessionState = { byId: {} }
    const pump = () => {
      let attempts = 0
      while (dirty) {
        expect(++attempts).toBeLessThan(20)
        dirty = false; cursor = 0
        tree = MemoryPage({ navigationState, useWorkspaces: (select: any) => select({ items: workspaces }), useSessions: (select: any) => select(sessionState) })
        effects.splice(0).forEach(effect => effect())
      }
      return tree
    }
    const settle = async () => { for (let i = 0; i < 12; i++) { await Promise.resolve(); pump() } }
    const dashboard = (namespace: string) => ({ namespace, overview: { namespaces: [{ namespace: 'A' }, { namespace: 'B' }] },
      data: { conversations: [], events: [], blocks: [], graph: { nodes: [], edges: [] }, audit: [] } })
    const supports = () => {
      const found: any[] = []
      const visit = (value: any) => { if (!Array.isArray(value)) return; if (value[0] === SupportPage) found.push(value[1]); value.forEach(visit) }
      visit(tree); return found
    }
    pump(); requests[0]!.resolve(dashboard('A')); await settle()
    navigationState = { view: 'feedback', namespace: 'B' }; dirty = true; pump()
    expect(requests.filter(request => request.namespace === 'B')).toHaveLength(1)
    expect(requests.at(-1)?.signal.aborted).toBe(false)
    requests.at(-1)!.resolve(dashboard('B')); await settle()
    expect(supports()).toMatchObject([{ namespace: 'B' }])
    navigationState = { view: 'feedback', namespace: 'B' }; dirty = true; pump()
    expect(requests.filter(request => request.namespace === 'B')).toHaveLength(2)
    requests.at(-1)!.resolve(dashboard('B')); await settle()
    expect(supports()).toMatchObject([{ namespace: 'B' }])
    deepElementProps(tree).find(props => props['aria-label'] === '当前工作区').onChange({ target: { value: 'A' } })
    pump(); requests.at(-1)!.resolve(dashboard('A')); await settle()
    expect(supports()).toEqual([])
  })

  it('registers its settings section through the DSH module loader', async () => {
    const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
    let definition: any
    runInNewContext(source, {
      URLSearchParams,
      window: { __ModuleLoader__: { load: (value: unknown) => { definition = value } } },
    })
    expect(definition.id).toBe('stratagate-dsh')
    const plugin = definition.factory((name: string) => {
      if (name !== 'react') throw new Error(`unexpected client dependency: ${name}`)
      return { createContext: (value: unknown) => ({ Provider: 'provider', value }), createElement: (...args: unknown[]) => args, Fragment: 'fragment', useState: () => [], useEffect: () => {}, useCallback: (fn: unknown) => fn }
    })
    expect(plugin.inject).toEqual(['slots', 'uiConversation'])

    const registrations: any[] = []
    const slots = {
      inject: (_name: string, callback: () => void) => callback(),
      register: (metadata: any, render: unknown) => {
        if (metadata.name === 'conversation.chat.turnTail' && !metadata.id) {
          throw new Error('list slot "conversation.chat.turnTail" requires options.id')
        }
        registrations.push({ metadata, render })
      },
    }
    const selectPanel = vi.fn()
    plugin.apply({ get: (name: string) => name === 'slots' ? slots : name === 'layout' ? { selectPanel } : name === 'configForms' ? { get: () => ({ set: async () => true }) } : name === 'uiConversation' ? { events: { register: () => {} } } : undefined })
    const tail = registrations.find(({ metadata }) => metadata.name === 'conversation.chat.turnTail')
    const registration = registrations.find(({ metadata }) => metadata.name === 'settings.section')
    expect(registrations[0].metadata.name).toBe('settings.section')
    expect(tail.metadata.id).toBe('stratagate-memory-citations')
    expect(registration.metadata).toMatchObject({ name: 'settings.section', id: 'stratagate-memory' })
    expect(registration.metadata.label()).toBe('StrataGate-AgentMemory')
    expect(typeof registration.render).toBe('function')
    const panel = registrations.find(({ metadata }) => metadata.name === 'main' && metadata.key === 'stratagate-memory')
    const sidebar = registrations.find(({ metadata }) => metadata.name === 'sidebar.panellist' && metadata.id === 'stratagate-memory')
    const prompt = registrations.find(({ metadata }) => metadata.name === 'shell.overlay' && metadata.id === 'stratagate.sidebar-placement-prompt')
    expect(panel).toBeDefined()
    expect(sidebar).toBeUndefined()
    expect(prompt).toBeUndefined()
    const close = vi.fn()
    await registration.render({ close })[1].onChooseSidebar()
    expect(selectPanel).toHaveBeenCalledWith('stratagate-memory')
    expect(close).toHaveBeenCalledOnce()
  })

  it('dismisses the compact sidebar placement prompt and remembers the selected action', async () => {
    const values = new Map<string, string>()
    const { SidebarPlacementPrompt } = loadSupportHelpers([], {
      localStorage: {
        getItem: (key: string) => values.get(key) || null,
        setItem: (key: string, value: string) => values.set(key, value),
      },
    })
    let selected = 0
    const first = SidebarPlacementPrompt({ usePluginSettings: (select: any) => select({ value: { showSidebarEntry: false }, writable: true }), onChooseSidebar: () => { selected += 1; return true } })
    expect(JSON.stringify(first)).toContain('从左侧栏快速打开记忆')
    await buttonProps(first, '放到左侧栏').onClick()
    await Promise.resolve()
    expect(selected).toBe(1)
    expect(values.get('stratagate-dsh.sidebar-prompt.v1')).toBe('sidebar')

    expect(values.get('stratagate-dsh.sidebar-prompt.v1')).toBe('sidebar')
  })

  it('reconciles the real sidebar registry from accepted settings and cleans up the subscription', async () => {
    const registry = new SlotCore()
    registry.register({ name: 'root', children: { 'settings.section': { kind: 'list', scope: 'root' }, main: { kind: 'keyed', scope: 'root' }, 'sidebar.panellist': { kind: 'list', scope: 'root' } } } as any, () => null)
    let snapshot = { status: 'loading', value: { showSidebarEntry: true } }
    let listener: (() => void) | undefined
    const stop = vi.fn(() => { listener = undefined })
    const disposers = new Map<string, (() => void)>()
    const layout = { activePanelId: 'stratagate-memory', selectPanel: vi.fn() }
    let accepted = true
    const form = {
      getSnapshot: () => snapshot,
      subscribe: (callback: () => void) => { listener = callback; return stop },
      set: vi.fn(async (_field: string, value: boolean) => {
        if (!accepted) return false
        snapshot = { status: 'ready', value: { showSidebarEntry: value } }; listener?.(); return true
      }),
    }
    const { apply } = loadSupportHelpers()
    apply({ get: (name: string) => name === 'slots' ? {
      inject: (key: string, callback: () => (() => void)) => { disposers.set(key, callback()) },
      register: (options: any, component: any) => registry.register(options, component),
    } : name === 'configForms' ? { get: () => form } : name === 'layout' ? layout : undefined })
    const entries = () => registry.entriesOfSlot('sidebar.panellist')
    expect(entries()).toHaveLength(0)
    snapshot = { status: 'ready', value: {} as { showSidebarEntry: boolean } }; listener?.()
    expect(entries()).toHaveLength(0)
    snapshot = { status: 'ready', value: { showSidebarEntry: false } }; listener?.()
    expect(entries()).toHaveLength(0)
    snapshot = { status: 'ready', value: { showSidebarEntry: true } }; listener?.()
    expect(entries()).toHaveLength(1)
    listener?.(); expect(entries()).toHaveLength(1)
    const section: any = registry.entriesOfSlot('settings.section')[0]
    const close = vi.fn()
    const page = section.component({ close })
    accepted = false
    expect(await page[1].onChooseSidebar()).toBe(false)
    expect(close).not.toHaveBeenCalled()
    expect(layout.selectPanel).not.toHaveBeenCalled()
    accepted = true
    expect(await section.inject().setSidebarEntry(false)).toBe(true)
    expect(entries()).toHaveLength(0)
    expect(layout.selectPanel).toHaveBeenCalledWith(null)
    expect(registry.entriesOfSlot('main')).toHaveLength(1)
    expect(await page[1].onChooseSidebar()).toBe(true)
    expect(entries()).toHaveLength(1)
    expect(close).toHaveBeenCalledOnce()
    disposers.get('sidebar.panellist')!()
    expect(stop).toHaveBeenCalledOnce()
    expect(entries()).toHaveLength(0)
  })

  it.each(['get', 'event', 'inject', 'register'] as const)('keeps Settings available when chat %s setup fails', (failure) => {
    const warnings: unknown[][] = []
    const { apply } = loadSupportHelpers([], { console: { warn: (...args: unknown[]) => warnings.push(args) } }) as any
    const registrations: string[] = []
    let delayedTailSetup: (() => unknown) | undefined
    const slots = {
      inject: (name: string, setup: () => unknown) => {
        if (name === 'conversation.chat.turnTail') {
          if (failure === 'inject') throw new Error('turnTail slot unavailable')
          if (failure === 'register') { delayedTailSetup = setup; return }
        }
        return setup()
      },
      register: (metadata: { name: string }) => {
        if (metadata.name === 'conversation.chat.turnTail' && failure === 'register') throw new Error('duplicate turnTail id')
        registrations.push(metadata.name)
        return () => {}
      },
    }
    const uiConversation = { events: { register: () => {
      if (failure === 'event') throw new Error('conversation definition unavailable')
    } } }
    expect(() => apply({ get: (name: string) => {
      if (name === 'slots') return slots
      if (name === 'uiConversation') {
        if (failure === 'get') throw new Error('conversation service unavailable')
        return uiConversation
      }
      return undefined
    } })).not.toThrow()
    expect(registrations).toContain('settings.section')
    if (failure === 'register') {
      expect(delayedTailSetup).toBeTypeOf('function')
      const dispose = delayedTailSetup!()
      expect(dispose).toBeTypeOf('function')
      expect(() => (dispose as () => void)()).not.toThrow()
    }
    expect(registrations).not.toContain('conversation.chat.turnTail')
    expect(warnings).toHaveLength(1)
    expect(String(warnings[0]?.[0])).toContain('memory settings remain available')
  })

  it('declares the supported DSH Conversation package and service contracts', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    expect(manifest.dsh.client.inject).toEqual(['@deepseek-ai/dsh-client-ui-conversation'])
    expect(manifest.dshWorkshop.compatibility.dshVersions).toEqual(['0.1.2-rc.1', '0.1.5-rc.1', '0.1.6-alpha.1', '0.1.7-rc.1', '0.1.7-rc.2', '0.2.0-rc.1', '0.2.0-rc.2'])
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
    let stopped = false
    listener({ target, button: 0, preventDefault: () => { prevented = true }, stopPropagation: () => { stopped = true } })
    expect(prevented).toBe(true)
    expect(stopped).toBe(true)
    expect(openSectionCalls).toEqual([[
      'stratagate-memory',
      { view: 'feedback', namespace: 'dsh:project:test' },
    ]])
    expect(location.assigned).toBe('')
    listener({ target, preventDefault: () => { prevented = true }, stopPropagation: () => {} })
    expect(openSectionCalls).toHaveLength(2)
    expect(feedbackLinkTarget({ parentElement: target }, location)).toMatchObject({ anchor, url: { href } })
    expect(navigateToFeedback({ get: () => undefined }, new URL(href), location)).toBe('http')
    expect(location.assigned).toBe(href)
    dispose()
    expect(removed).toBe(true)
  })

  it('opens Feedback through the real DSH shared settings shell when settingsNavigation is absent', () => {
    const { navigateToFeedback } = loadSupportHelpers()
    const calls: string[] = []
    const shared = { actions: { openSection: (id: string) => calls.push(id) } }
    const registry = new SlotCore()
    registry.register({ name: 'root', children: { 'sidebar.settings': { kind: 'single', scope: 'root' } } } as any, () => null)
    registry.register({ name: 'sidebar.settings', store: { create: () => shared } } as any, () => null)
    const ctx = { get: (name: string) => name === 'slots' ? registry : undefined }
    const route = new URL('http://127.0.0.1:19387/?settings=stratagate-memory&stratagateView=feedback&namespace=dsh%3Aproject%3Atest')
    expect(navigateToFeedback(ctx, route, { assign: () => { throw new Error('must stay in current app') } })).toBe('host')
    expect(calls).toEqual(['stratagate-memory'])
  })

  it('recognizes the Desktop-owned HTTP feedback endpoint across the dsh-app origin', () => {
    const { feedbackLinkTarget } = loadSupportHelpers()
    const desktop = { href: 'dsh-app://app/', origin: 'dsh-app://app' }
    const href = 'http://127.0.0.1:19387/?settings=stratagate-memory&stratagateView=feedback&namespace=dsh%3Aproject%3Atest'
    const target = (url: string) => ({ closest: () => ({ getAttribute: () => url }) })
    expect(feedbackLinkTarget(target(href), desktop, 'http://127.0.0.1:19387')).not.toBeNull()
    expect(feedbackLinkTarget(target(href), desktop)).toBeNull()
    expect(feedbackLinkTarget(target(href), desktop, 'http://127.0.0.1:19388')).toBeNull()
    expect(feedbackLinkTarget(target(href.replace('127.0.0.1:19387', 'example.com')), desktop, 'http://example.com')).toBeNull()
    expect(feedbackLinkTarget(target(href.replace('/?', '/other?')), desktop, 'http://127.0.0.1:19387')).toBeNull()
    expect(feedbackLinkTarget(target(href.replace('127.0.0.1', 'user@127.0.0.1')), desktop, 'http://127.0.0.1:19387')).toBeNull()
  })

  it.each(['owned', 'different-server', 'boot-error', 'disposed'])('handles an early Desktop feedback click with %s boot', async (mode) => {
    let release: (value: unknown) => void = () => {}
    let reject: (reason: unknown) => void = () => {}
    const ready = vi.fn(() => new Promise((resolve, fail) => { release = resolve; reject = fail }))
    const { installFeedbackLinkNavigation } = loadSupportHelpers([], { window: { dshDesktopBoot: { ready } } })
    let listener: (event: any) => void = () => {}
    const documentRef = { addEventListener: (_name: string, value: any) => { listener = value }, removeEventListener: vi.fn() }
    const openSection = vi.fn()
    const ctx = { get: (name: string) => name === 'settingsNavigation' ? { openSection } : undefined }
    const location = { href: 'dsh-app://app/', origin: 'dsh-app://app', assign: vi.fn() }
    const href = 'http://127.0.0.1:19387/?settings=stratagate-memory&stratagateView=feedback&namespace=dsh%3Aproject%3Atest'
    const anchor = { getAttribute: () => href, click: vi.fn() }
    const target = { closest: () => anchor }
    const dispose = installFeedbackLinkNavigation(ctx, documentRef, location)
    const event = { target, button: 0, preventDefault: vi.fn(), stopPropagation: vi.fn() }
    listener(event)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(event.stopPropagation).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce())
    if (mode === 'disposed') dispose()
    if (mode === 'boot-error') reject(new Error('boot unavailable'))
    else release({ streamBaseUrl: mode === 'different-server' ? 'http://127.0.0.1:19388' : 'http://127.0.0.1:19387' })
    await new Promise(resolve => setImmediate(resolve))
    expect(openSection).toHaveBeenCalledTimes(mode === 'owned' ? 1 : 0)
    expect(anchor.click).toHaveBeenCalledTimes(['different-server', 'boot-error'].includes(mode) ? 1 : 0)
    expect(location.assign).not.toHaveBeenCalled()
    if (mode !== 'disposed') dispose()
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

  it('opens a requested graph node through Settings navigation and reports failures', async () => {
    const { navigateToGraphNode, readGraphNodeNavigationState, readGraphNodeDeepLink, consumeGraphNodeDeepLink } = loadSupportHelpers()
    expect(readGraphNodeNavigationState({ view: 'graph-node', namespace: 'dsh:project:test', nodeId: 'node_1' }))
      .toEqual({ namespace: 'dsh:project:test', nodeId: 'node_1' })
    expect(readGraphNodeNavigationState({ view: 'graph-node', namespace: '', nodeId: 'node_1' })).toBeNull()
    expect(readGraphNodeDeepLink({ search: '?settings=stratagate-memory&stratagateView=graph-node&namespace=dsh%3Aproject%3Atest&nodeId=node_1' }))
      .toEqual({ namespace: 'dsh:project:test', nodeId: 'node_1' })
    let replaced = ''
    expect(consumeGraphNodeDeepLink({ pathname: '/', search: '?settings=stratagate-memory&stratagateView=graph-node&namespace=dsh%3Aproject%3Atest&nodeId=node_1&keep=1', hash: '#chat' }, { state: null, replaceState: (_state: unknown, _title: string, next: string) => { replaced = next } })).toBe('/?keep=1#chat')
    expect(replaced).toBe('/?keep=1#chat')

    const calls: unknown[][] = []
    expect(await navigateToGraphNode({
      get: (name: string) => name === 'settingsNavigation' ? { openSection: (...args: unknown[]) => { calls.push(args) } } : undefined,
    }, 'dsh:project:test', 'node_1')).toBe(true)
    expect(calls).toEqual([['stratagate-memory', { view: 'graph-node', namespace: 'dsh:project:test', nodeId: 'node_1' }]])
    const fallbackLocation = {
      href: 'http://127.0.0.1:10259/?keep=1',
      assigned: '',
      assign(next: string) { this.assigned = next },
    }
    expect(await navigateToGraphNode({ get: () => undefined }, 'dsh:project:test', 'node_1', fallbackLocation)).toBe(true)
    expect(new URL(fallbackLocation.assigned).searchParams.get('stratagateView')).toBe('graph-node')
    expect(new URL(fallbackLocation.assigned).searchParams.get('nodeId')).toBe('node_1')
    expect(await navigateToGraphNode({ get: () => undefined }, 'dsh:project:test', 'node_1', fallbackLocation, false)).toBe(false)
    expect(await navigateToGraphNode({ get: () => ({ openSection: () => Promise.reject(new Error('closed')) }) }, 'dsh:project:test', 'node_1')).toBe(false)
  })

  it('maps participants from node ids, deduplicates aliases, and keeps text-only pills inert', () => {
    const { EventMetadata, NodePill, StaticEntityPill } = loadSupportHelpers()
    const node = { id: 'node_1', name: 'StrataGate DSH', aliases: ['stratagate-dsh'], type: 'project' }
    const tree = EventMetadata({
      event: { temporal: { participantNodeIds: ['node_1', 'node_1'], participants: ['stratagate-dsh', 'StrataGate DSH', 'Alice', 'alice'] } },
      nodes: [node, { id: 'related_only', name: 'Unrelated', aliases: [], type: 'tool' }],
      onNode: () => {},
    })
    const participantComponents: Array<{ name: string; props: any }> = []
    const visit = (value: unknown) => {
      if (!Array.isArray(value)) return
      if (typeof value[0] === 'function' && ['NodePill', 'StaticEntityPill'].includes(value[0].name)) participantComponents.push({ name: value[0].name, props: value[1] })
      value.forEach(visit)
    }
    visit(tree)
    expect(participantComponents).toEqual([
      { name: 'NodePill', props: expect.objectContaining({ node }) },
      { name: 'StaticEntityPill', props: expect.objectContaining({ name: 'Alice' }) },
    ])

    let opened = false
    let stopped = 0
    const linkedPill = NodePill({ node, onClick: () => { opened = true } })
    linkedPill[1].onPointerDown({ stopPropagation: () => { stopped += 1 } })
    linkedPill[1].onClick({ stopPropagation: () => { stopped += 1 } })
    expect(opened).toBe(true)
    expect(stopped).toBe(2)
    expect(linkedPill).toContain('StrataGate DSH')
    expect(StaticEntityPill({ name: 'Alice' })).toEqual(['span', { className: 'sg-entity-pill sg-entity-pill-static' }, 'Alice'])
  })

  it('renders solid weight trajectories with a wider invisible hover target and collision-aware labels', () => {
    const { MemoryWeightTrajectory } = loadSupportHelpers()
    const points = [
      { kind: 'creation', turn: 0, weight: 1, label: '形成' },
      { kind: 'adoption', turn: 1, weight: 1, adoptionCount: 1 },
      { kind: 'adoption', turn: 2, weight: 1, adoptionCount: 1 },
      { kind: 'adoption', turn: 3, weight: 1, adoptionCount: 1 },
      { kind: 'current', turn: 100, weight: .9 },
    ]
    const tree = MemoryWeightTrajectory({
      event: {
        criticality: 'identity',
        formedTurn: 0,
        weight: { floorWeight: .9, mentionCount: 4 },
        weightTrajectory: {
          formedTurn: 0,
          trajectoryStartTurn: 0,
          currentWeight: .9,
          effectiveAdoptions: 3,
          points,
          segments: [{ certainty: 'incomplete', points }],
        },
      },
    })
    const props = deepElementProps(tree)
    const visibleLine = props.find((value) => value.className === 'sg-weight-line incomplete')
    const hitLine = props.find((value) => value.className === 'sg-weight-line-hit')
    expect(visibleLine).toBeTruthy()
    expect(hitLine).toMatchObject({ 'aria-label': '旧数据推算的记忆权重轨迹' })
    expect(typeof hitLine.onPointerEnter).toBe('function')
    expect(typeof hitLine.onPointerMove).toBe('function')
    expect(typeof hitLine.onPointerLeave).toBe('function')
    expect(() => hitLine.onPointerMove({ clientX: 120, clientY: 80, currentTarget: { ownerSVGElement: { parentElement: { getBoundingClientRect: () => ({ width: 620, left: 0, top: 0 }) } } } })).not.toThrow()

    const floorLine = props.find((value) => value.className === 'sg-weight-floor')
    const floorLabel = props.find((value) => value.className === 'sg-weight-floor-label')
    expect(Number(floorLabel.y)).toBeGreaterThan(Number(floorLine.y1))
    const crowdedLabels = props.filter((value) => value.className === 'sg-weight-node-label' && Number(value.x) < 100)
    expect(crowdedLabels.length).toBeGreaterThan(2)
    expect(new Set(crowdedLabels.map((value) => value.y)).size).toBeGreaterThan(1)
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
      return { createContext: (value: unknown) => ({ Provider: 'provider', value }), createElement: (...args: unknown[]) => args, Fragment: 'fragment', useState: () => [], useEffect: () => {}, useCallback: (fn: unknown) => fn, useRef: () => ({ current: null }) }
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
    expect(tail.metadata.inject()).toEqual({ hooks: { pluginSettings }, onOpenGraphNode: expect.any(Function) })
    settings.metadata.inject().setStrataGateStatus(false)
    settings.metadata.inject().setShortTermStatus(false)
    settings.metadata.inject().setRetrievalStatus(false)
    expect(settingWrites).toEqual([
      ['showStrataGateStatus', false],
      ['showShortTermStatus', false],
      ['showRetrievalStatus', false],
    ])
    expect(source).toContain('function ShortTermMemoryTurnStatus({ matched, sessionId, useSession, useSessions, useWorkspaces })')
    expect(source).toContain('会话记忆 · ')
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

  it('binds display settings through the DSH 0.1.7 config form when available', () => {
    const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
    let definition: any
    runInNewContext(source, {
      URLSearchParams,
      window: { __ModuleLoader__: { load: (value: unknown) => { definition = value } } },
    })
    const plugin = definition.factory((name: string) => {
      if (name !== 'react') throw new Error(`unexpected client dependency: ${name}`)
      return { createContext: (value: unknown) => ({ Provider: 'provider', value }), createElement: (...args: unknown[]) => args, Fragment: 'fragment' }
    })
    const registrations: any[] = []
    const writes: unknown[][] = []
    const form = { getSnapshot: () => ({ status: 'ready', value: {}, writable: true }), subscribe: () => () => {}, set: (...args: unknown[]) => { writes.push(args) }, unset: (...args: unknown[]) => { writes.push(args) } }
    const namespaces: string[] = []
    plugin.apply({ get: (name: string) => name === 'slots'
      ? { inject: (_name: string, callback: () => void) => callback(), register: (metadata: unknown, render: unknown) => { registrations.push({ metadata, render }) } }
      : name === 'uiConversation'
        ? { events: { register: () => {} } }
        : name === 'configForms'
          ? { get: (namespace: string) => { namespaces.push(namespace); return form } }
          : undefined })
    expect(namespaces).toEqual(['stratagate-memory'])
    const settings = registrations.find(({ metadata }) => metadata.name === 'settings.section')
    settings.metadata.inject().setStrataGateStatus(false)
    settings.metadata.inject().resetEffort()
    expect(writes).toEqual([['showStrataGateStatus', false], ['structuredReasoningEffort']])
  })

  it('defaults all chat status UI to visible and combines the master and child preferences', () => {
    const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
    const instrumented = source.replace(
      "    exports.name = 'stratagate-dsh'",
      "    exports.__test = { strataGateStatusVisible, shortTermStatusVisible, retrievalStatusVisible }; exports.name = 'stratagate-dsh'",
    )
    let definition: any
    runInNewContext(instrumented, {
      URLSearchParams,
      window: { __ModuleLoader__: { load: (value: unknown) => { definition = value } } },
    })
    const plugin = definition.factory((name: string) => {
      if (name !== 'react') throw new Error(`unexpected client dependency: ${name}`)
      return { createContext: (value: unknown) => ({ Provider: 'provider', value }), createElement: (...args: unknown[]) => args }
    })
    const { strataGateStatusVisible, shortTermStatusVisible, retrievalStatusVisible } = plugin.__test
    expect(strataGateStatusVisible(null)).toBe(true)
    expect(shortTermStatusVisible(null)).toBe(true)
    expect(retrievalStatusVisible(null)).toBe(true)
    expect(shortTermStatusVisible({ value: {} })).toBe(true)
    expect(shortTermStatusVisible({ value: { showShortTermStatus: true } })).toBe(true)
    expect(shortTermStatusVisible({ value: { showShortTermStatus: false } })).toBe(false)
    expect(retrievalStatusVisible({ value: { showRetrievalStatus: true } })).toBe(true)
    expect(retrievalStatusVisible({ value: { showRetrievalStatus: false } })).toBe(false)
    expect(shortTermStatusVisible({ value: { showStrataGateStatus: false, showShortTermStatus: true } })).toBe(false)
    expect(retrievalStatusVisible({ value: { showStrataGateStatus: false, showRetrievalStatus: true } })).toBe(false)
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
      return { createContext: (value: unknown) => ({ Provider: 'provider', value }), createElement: (...args: unknown[]) => args }
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
      return { createContext: (value: unknown) => ({ Provider: 'provider', value }), createElement: (...args: unknown[]) => args }
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
        createContext: (value: unknown) => ({ Provider: 'provider', value }),
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
                verdict: 'sufficient',
                missing: '',
                nextStrategy: 'answer',
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
    expect(matched.retrievalGroups[0]).toMatchObject({ verdict: 'sufficient', nextStrategy: 'answer' })
    const rendered = tail.render({ matched })
    const renderedTail = JSON.stringify(rendered)
    expect(renderedTail).toContain('本回答采用了 3 条记忆')
    expect(renderedTail).toContain('· 查看检索过程')
    const listRenderedTail = JSON.stringify(tail.render({ turn: { turn: 7, data: { get: (key: string) => locationData.get(key) } }, seq: 8 }))
    expect(listRenderedTail).toContain('本回答采用了 3 条记忆')
    expect(listRenderedTail).toContain('· 查看检索过程')
    expect(JSON.stringify(rendered[3])).not.toContain('pnpm compatibility')
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
    expect(source).toContain("'本回答采用了 ' + citations.length + ' 条记忆'")
    expect(source).not.toContain('本回答参考了')
    expect(source).toContain("'· 查看检索过程'")
    expect(source).toContain("'检索 ' + retrievalGroups.length + ' 轮 · 返回 ' + retrievedCount + ' 条 · 未采用'")
    expect(source).toContain('sg-answer-retrieval-toggle')
    expect(source).toContain("'aria-expanded': showRetrieved")
    expect(source).toContain("'检索过程'")
    expect(source).toContain('retrievalGroupLabel(groupIndex)')
    expect(source).toContain("memoryIndex + 1 + '.'")
    expect(source).toContain("open(memory, adopted)")
    expect(source).toContain("'检索候选 · 未采用'")
    expect(source).toContain("function CitationGraph({ citation, detail, primary, adopted = true })")
    expect(source).toContain("title: '关联信息'")
    expect(source).toContain("title: '来源与证据'")
    expect(source).toContain("title: '技术信息'")
    expect(source).toContain("selected.adopted ? '已用于回答' : '检索候选 · 未采用'")
    expect(source).toContain('只有标记为本次采用的记忆内容参与了本次回答')
    expect(source).not.toContain('弹窗中的关联信息与来源内容用于查看依据')
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
        createContext: (value: unknown) => ({ Provider: 'provider', value }),
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
    expect(JSON.stringify(rendered)).toContain('检索 2 轮 · 返回 3 条 · 未采用')
    expect(JSON.stringify(rendered)).not.toContain('stratagate-answer-citations')
    const retrievalHidden = tail.render({
      matched,
      usePluginSettings: (select: (state: unknown) => unknown) => select({ value: { showRetrievalStatus: false } }),
    })
    expect(JSON.stringify(retrievalHidden)).not.toContain('stratagate-answer-retrieval-note')
    const allStatusHidden = tail.render({
      matched,
      usePluginSettings: (select: (state: unknown) => unknown) => select({ value: { showStrataGateStatus: false } }),
    })
    expect(JSON.stringify(allStatusHidden)).not.toContain('stratagate-answer-retrieval-note')
    expect(JSON.stringify(allStatusHidden)).not.toContain('ShortTermMemoryTurnStatus')

    let stateCall = 0
    const expandedPlugin = definition.factory((name: string) => {
      if (name !== 'react') throw new Error(`unexpected client dependency: ${name}`)
      return {
        createContext: (value: unknown) => ({ Provider: 'provider', value }),
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
    expect(JSON.stringify(expanded)).toContain('retrievalGroups')
    expect(source).toContain("retrievalGroupLabel(groupIndex) + ' · 返回 ' + group.count + ' 条'")
    expect(source).toContain("adopted ? '最终采用' : '检索到 · 未采用'")
    expect(source).toContain("'最终采用 ' + citations.length + ' 条'")
    expect(source).toContain("if (group.verdict === 'sufficient') return '证据充分'")
    expect(source).toContain("return '证据不足，继续检索'")
  })

  it('keeps the project brand, mascot, usage count, and archived GitHub markup', () => {
    const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
    const buildSource = readFileSync(new URL('../scripts/build-client.mjs', import.meta.url), 'utf8')
    expect(source).toContain("'StrataGate'")
    expect(source).not.toContain('有来源、可追溯的跨会话记忆')
    expect(source).toContain('__STRATAGATE_MASCOT_DATA_URL__')
    expect(source).toContain('StrataGate 已在当前工作区中帮助使用记忆 ')
    expect(source).toContain("'v' + overview.pluginVersion")
    expect(source).toContain('给 StrataGate 点个 🌟')
    expect(source).toContain('参与开发 · Issue / PR →')
    expect(source).toContain("https://github.com/diqierjia/StrataGate-AgentMemory")
    expect(source).toContain("rel: 'noopener noreferrer'")
    expect(source).toContain("const STRATAGATE_CLIENT_VERSION = '__STRATAGATE_CLIENT_VERSION__'")
    expect(buildSource).toContain("readFileSync(new URL('package.json', root), 'utf8')")
    expect(buildSource).toContain(".replaceAll('__STRATAGATE_CLIENT_VERSION__', packageVersion)")
  })

  it('replaces the header community links with email contact and preserves the dormant Star link', () => {
    const { HeaderCommunityLinks, GITHUB_FEEDBACK_ENABLED } = loadSupportHelpers()
    expect(GITHUB_FEEDBACK_ENABLED).toBe(false)
    const tree = HeaderCommunityLinks()
    const hrefs = elementProps(tree).map((props) => props.href).filter(Boolean)
    expect(hrefs).toHaveLength(0)
    expect(elementProps(tree).find((props) => props['aria-controls'] === 'sg-contact-author-panel')['aria-expanded']).toBe(false)
    expect(JSON.stringify(tree)).toContain('联系作者')
    expect(JSON.stringify(tree)).not.toContain('GitHub')
    expect(JSON.stringify(tree)).not.toContain('Issue / PR')
    expect(JSON.stringify(tree)).not.toContain('点个')
    const archived = loadSupportHelpers([], {}, true).HeaderCommunityLinks()
    expect(elementProps(archived).filter((props) => props.href)).toHaveLength(2)
    expect(JSON.stringify(archived)).toContain('给 StrataGate 点个')
  })

  it.each(['available', 'missing', 'rejected'])('shows contact details and handles %s clipboard without requiring a mail application', async (clipboardState) => {
    const values: any[] = []
    let stateIndex = 0
    const copied: string[] = [], composed: string[] = []
    const React = {
      createContext: (value: unknown) => ({ value }), createElement: (...args: unknown[]) => args, Fragment: 'fragment',
      useState: (initial: unknown) => {
        const index = stateIndex++
        if (!(index in values)) values[index] = initial
        return [values[index], (value: any) => { values[index] = typeof value === 'function' ? value(values[index]) : value }]
      },
      useEffect: () => {}, useRef: (initial: unknown) => ({ current: initial }),
    }
    const clipboard = clipboardState === 'missing' ? undefined : { writeText: async (value: string) => {
      if (clipboardState === 'rejected') throw new Error('permission denied')
      copied.push(value)
    } }
    const { HeaderCommunityLinks } = loadSupportHelpers([], { react: React, navigator: { clipboard }, window: { location: { set href(value: string) { composed.push(value) } } } })
    const render = () => { stateIndex = 0; return HeaderCommunityLinks() }
    const button = (tree: any, label: string): any => {
      if (!Array.isArray(tree)) return undefined
      if (tree[0] === 'button' && tree.slice(2).includes(label)) return tree[1]
      return tree.slice(2).map((child) => button(child, label)).find(Boolean)
    }
    let tree = render()
    expect(JSON.stringify(tree)).not.toContain('jiahongcheng61@gmail.com')
    button(tree, '联系作者 →').onClick()
    tree = render()
    expect(JSON.stringify(tree)).toContain('jiahongcheng61@gmail.com')
    expect(elementProps(tree).find((props) => props['aria-label'] === '联系作者')).toBeDefined()
    expect(composed).toEqual([])
    await button(tree, '复制邮箱').onClick()
    tree = render()
    expect(copied).toEqual(clipboardState === 'available' ? ['jiahongcheng61@gmail.com'] : [])
    expect(JSON.stringify(tree)).toContain(clipboardState === 'available' ? '邮箱已复制' : '手动复制')
    button(tree, '打开邮件应用').onClick()
    tree = render()
    expect(new URL(composed[0]!).pathname).toBe('jiahongcheng61@gmail.com')
    expect(JSON.stringify(tree)).toContain('若没有打开，请复制邮箱')
    expect(JSON.stringify(tree)).not.toContain('邮件已发送')
    elementProps(tree).find((props) => props['aria-label'] === '关闭联系方式').onClick()
    expect(JSON.stringify(render())).not.toContain('jiahongcheng61@gmail.com')
    button(render(), '联系作者 →').onClick()
    expect(JSON.stringify(render())).not.toContain('已尝试打开邮件应用')
  })

  it('keeps contact details and manual fallback visible when desktop mail navigation throws', () => {
    const values: any[] = [true, '']
    let stateIndex = 0
    const React = {
      createContext: (value: unknown) => ({ value }), createElement: (...args: unknown[]) => args, Fragment: 'fragment',
      useState: () => { const index = stateIndex++; return [values[index], (value: any) => { values[index] = value }] },
      useEffect: () => {}, useRef: () => ({ current: null }),
    }
    const { HeaderCommunityLinks } = loadSupportHelpers([], { react: React, window: { location: { set href(_value: string) { throw new Error('unsupported protocol') } } } })
    const tree = HeaderCommunityLinks()
    // Find the mail button by its callback rather than depending on layout indexes.
    const buttons = (value: any): any[] => Array.isArray(value) ? (value[0] === 'button' && value.includes('打开邮件应用') ? [value] : value.slice(2).flatMap(buttons)) : []
    expect(() => buttons(tree)[0][1].onClick()).not.toThrow()
    stateIndex = 0
    const updated = JSON.stringify(HeaderCommunityLinks())
    expect(updated).toContain('未能打开邮件应用，请复制邮箱')
    expect(updated).toContain('jiahongcheng61@gmail.com')
  })

  it('encodes an email subject while keeping the report out of the mailto URL', async () => {
    const { feedbackEmailUrl, copyReportAndComposeEmail, EMAIL_BODY_HINT } = loadSupportHelpers()
    const title = '中文 & ? #\r\n另一个标题'
    const url = new URL(feedbackEmailUrl(title))
    expect(url.protocol).toBe('mailto:')
    expect(url.pathname).toBe('jiahongcheng61@gmail.com')
    expect(url.searchParams.get('subject')).toBe('StrataGate 反馈：中文 & ? # 另一个标题')
    expect(url.searchParams.get('body')).toBe(EMAIL_BODY_HINT)
    expect([...url.searchParams.keys()].sort()).toEqual(['body', 'subject'])
    const report = 'private report ' + 'x'.repeat(20_000)
    const calls: string[] = []
    let resolveCopy: (() => void) | undefined
    const pending = copyReportAndComposeEmail(report, { writeText: (value: string) => {
      expect(value).toBe(report)
      calls.push('copy')
      return new Promise<void>((resolve) => { resolveCopy = resolve })
    } }, (target: string) => {
      expect(target).not.toContain('private report')
      expect(target.length).toBeLessThan(1000)
      calls.push('compose')
    }, title)
    expect(calls).toEqual(['copy', 'compose'])
    resolveCopy!()
    expect(await pending).toEqual({ copied: true, composeRequested: true, error: '' })
  })

  it.each(['missing', 'throws', 'rejects'])('retains a manual report fallback when the clipboard %s', async (failure) => {
    const { copyReportAndComposeEmail, handleFeedbackEmailResult } = loadSupportHelpers()
    const clipboard = failure === 'missing' ? null : { writeText: () => {
      if (failure === 'throws') throw new Error('clipboard denied')
      return Promise.reject(new Error('clipboard denied'))
    } }
    let composed = ''
    const result = await copyReportAndComposeEmail('retained report', clipboard, (url: string) => { composed = url })
    expect(result).toMatchObject({ copied: false, composeRequested: true })
    expect(composed).toMatch(/^mailto:jiahongcheng61@gmail\.com/)
    let expanded = false
    let error = '保存反馈草稿失败：disk full'
    handleFeedbackEmailResult(result, {
      setPreviewOpen: (value: boolean) => { expanded = value },
      setError: (update: (current: string) => string) => { error = update(error) },
    })
    expect(expanded).toBe(true)
    expect(error).toContain('disk full')
    expect(error).toContain('报告仍保留在预览中')
    expect(error).toContain('jiahongcheng61@gmail.com')
  })

  it('keeps the copied report and offers the email address when mail application launch fails', async () => {
    const { copyReportAndComposeEmail, handleFeedbackEmailResult } = loadSupportHelpers()
    const result = await copyReportAndComposeEmail('report', { writeText: async () => {} }, () => { throw new Error('no mail app') })
    expect(result).toEqual({ copied: true, composeRequested: false, error: '' })
    let status = ''
    handleFeedbackEmailResult(result, { setStatus: (value: string) => { status = value } })
    expect(status).toContain('复制邮箱自行发送')
    expect(status).not.toContain('已发送')
  })

  it('copies the visible feedback email address without opening a mail application', async () => {
    const copied: string[] = []
    const { SupportPage } = loadSupportHelpers([false, false, false, '', '', '', '问题', false, false, false, 2, { text: '报告', title: '' }], {
      navigator: { clipboard: { writeText: async (value: string) => { copied.push(value) } } },
    })
    const tree = SupportPage({ namespace: '', overview: {}, selected: {}, data: {}, recentError: '', onBack: () => {} })
    const button = buttonProps(tree, '复制邮箱')
    expect(button).toBeDefined()
    await button!.onClick()
    expect(copied).toEqual(['jiahongcheng61@gmail.com'])
  })

  it('uses the user-defined DSH Workspace title and keeps the compact header collision-free', () => {
    const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
    expect(source).toContain('function MemoryPage({ useWorkspaces, useSessions, navigationState, usePluginSettings, setEffort, resetEffort, setStrataGateStatus, setShortTermStatus, setRetrievalStatus, setSidebarEntry, onOpenDreamingSession, onChooseSidebar, setDailyEnabled, setDailyTimeZone })')
    expect(source).toContain("settingsScope.bind({ namespace: 'stratagate-memory' })")
    expect(source).toContain("pluginSettingsScope.set('structuredReasoningEffort', mode)")
    expect(source).toContain("pluginSettingsScope.unset('structuredReasoningEffort')")
    expect(source).toContain("pluginSettingsScope.set('showStrataGateStatus', visible)")
    expect(source).toContain("pluginSettingsScope.set('showShortTermStatus', visible)")
    expect(source).toContain("pluginSettingsScope.set('showRetrievalStatus', visible)")
    expect(source).toContain("role: 'switch', 'aria-checked': checked")
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
    expect(source).toContain("'/' + run.total + ' 批次'")
    expect(source).toContain('Dreaming 整理进度（批次）')
    expect(source).toContain("const [section, setSection] = React.useState('short')")
    expect(source).toContain("[['profile', '常驻画像'], ['short', '会话记忆'], ['daily', '短期记忆'], ['long', '长期记忆'], ['more', '更多']]")
    expect(source).toContain('块衰减总览')
    expect(source).toContain('开放块 · 未封存')
    expect(source).toContain('距最新封存块')
    expect(source).toContain('分层内容预览')
    expect(source).toContain('让助手参考 L')
    expect(source).toContain("api('blocks/expand'")
    expect(source).toContain('助手可见层级')
    expect(source).not.toContain('用户展开')
    expect(source).not.toContain('Agent 展开')
    expect(source).toContain('当前对话：')
    expect(source).toContain('Block 分布滑轨')
    expect(source).toContain('L0 层最浅最简略，L5 层最深最详细，离当前对话越远，Block 会逐渐简略。')
    expect(source).toContain('document.body.appendChild(popover)')
    expect(source).toContain('BlockSelectionFeedback')
    expect(source).toContain('完整内容')
    expect(source).toContain("React.useState('topics')")
    expect(source).toContain('主题目录')
    expect(source).toContain('知识图谱')
    expect(source).toContain('事件时间线')
    expect(source).toContain('由于知识图谱功能与事件记录和主题目录有部分重复')
    expect(source).toContain('额外消耗token维护实体关系')
    expect(source).toContain('长期记忆页面点击“＋”')
    expect(source).toContain('已经生成的图谱数据会保留')
    expect(source).not.toContain('后续新功能会优先投入其他记忆能力')
    expect(source).toContain('.sg-long-tabs{position:relative;z-index:30;')
    expect(source).toContain('.sg-graph-menu{position:relative;z-index:31;')
    expect(source).toContain('.sg-graph-menu-popover{position:absolute;z-index:32;')
    expect(source).toContain("if (!graphMenuRef.current?.contains(event.target)) setGraphMenuOpen(false)")
    expect(source).toContain('border:1px solid color-mix(in srgb,var(--sg-muted) 58%,var(--sg-border))')
    expect(source).toContain('background:color-mix(in srgb,var(--sg-muted) 18%,var(--sg-surface))')
    expect(source).toContain("{ '今天': [], '本周': [], '更早': [] }")
    expect(source).toContain('发生时间未知')
    expect(source).toContain('记忆状态')
    expect(source).toContain('当前权重')
    expect(source).toContain('Agent 已采纳')
    expect(source).toContain('最低权重')
    expect(source).toContain('sg-weight-line.incomplete')
    expect(source).toContain('sg-weight-line-hit')
    expect(source).toContain('stroke-width:16;pointer-events:stroke')
    expect(source).toContain('sg-weight-tooltip')
    expect(source).not.toContain('stroke-dasharray:8 7')
    expect(source).toContain("y: String(y(floorWeight) + 16)")
    expect(source).toContain('const occupiedLabels = []')
    expect(source).not.toContain('图中可定位')
    expect(source).toContain('sg-weight-floor')
    expect(source).toContain('event?.criticality')
    expect(source).toContain("h(EventMemoryDetails, { event: primary")
    expect(source).toContain("event.weightTrajectory ? h('section'")
    expect(source).toContain("h(EventMemoryDetails, { event: detailedEvent")
    expect(source).toContain("onPointerDown: (event) => event.stopPropagation()")
    expect(source).toContain("onOpenGraphNode: (namespace, nodeId) => navigateToGraphNode(ctx, namespace, nodeId)")
    expect(source).toContain('当前图谱尚未更新完整。')
    expect(source).toContain('搜索记忆、人物、项目、概念')
    expect(source).not.toContain("['overview', '概览']")
    expect(source).not.toContain('sg-stats')
    expect(source).not.toContain('封存时为 L5')
  })

  it('keeps exactly the four requested primary entries in More and nests diagnostics under Advanced', () => {
    const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
    const moreSource = source.slice(source.indexOf('function MoreHome'), source.indexOf('function DisplayPage'))
    expect(moreSource).toContain("['display', '◐', '界面与显示', '控制会话记忆、检索状态等前端提示']")
    expect(moreSource).toContain("['import', '⇄', '导入其他 AI 的记忆', '将其他 AI 的历史记忆导入 StrataGate']")
    expect(moreSource).toContain("['settings', '⚙', '高级设置', '记忆配置、数据与运行诊断']")
    expect(moreSource).toContain("['support', '?', '反馈与支持', '报告问题、提出建议与查看帮助']")
    expect(moreSource.match(/^\s*\['(?:display|import|settings|support)'/gm)).toHaveLength(4)
    expect(moreSource).not.toContain("['structure'")
    expect(moreSource).not.toContain("['system'")
    expect(moreSource).not.toContain("['audit'")
    expect(moreSource).not.toContain("['raw'")
    const displaySource = source.slice(source.indexOf('function DisplayPage'), source.indexOf('function redactedJson'))
    expect(displaySource).toContain('控制侧栏入口和聊天界面中的显示信息。设置对所有工作区生效。')
    expect(displaySource).toContain('关闭后隐藏聊天界面中的 StrataGate 状态信息，不影响记忆、检索和后台处理。')
    expect(displaySource).toContain("title: '会话记忆状态'")
    expect(displaySource).toContain("title: '记忆检索状态'")
    expect(displaySource).toContain('disabled: !showStrataGateStatus')
    const settingsSource = source.slice(source.indexOf('function SettingsPage'), source.indexOf('function MemoryPage'))
    expect(settingsSource).toContain("['system', '✓', '系统状态'")
    expect(settingsSource).toContain("['audit', '↗', '使用记录'")
    expect(settingsSource).toContain("['raw', '{}', '查看原始数据'")
    expect(settingsSource).toContain("'StrataGate 安装级设置'")
    expect(settingsSource).toContain("'数据与存储'")
    expect(settingsSource).toContain("'当前工作区运行与诊断'")
    expect(settingsSource).toContain('适用于当前 StrataGate 安装中的所有工作区，也作为新工作区的默认设置。')
    expect(settingsSource).toContain("'宿主配置'")
    expect(settingsSource).toContain("'当前工作区信息'")
    expect(settingsSource).toContain("'保存全局设置'")
    expect(settingsSource).toContain('数据目录属于当前安装；原始数据查看当前选中的工作区。')
    expect(settingsSource).toContain('当前选中工作区的系统状态、使用记录与后台任务')
    expect(settingsSource).toContain("['status', '↻', '后台任务'")
    expect(settingsSource).toContain("api('storage/open-directory', {}, { method: 'POST' })")
    expect(settingsSource).toContain('navigator.clipboard.writeText(dataDirectory)')
    expect(settingsSource).toContain("back: { name: 'settings' }")
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

  it('copies the real data directory and sends the native open request from Advanced settings', async () => {
    let copied = ''
    const requests: Array<{ url: string; method?: string }> = []
    const { SettingsPage } = loadSupportHelpers([], {
      navigator: { clipboard: { writeText: async (value: string) => { copied = value } } },
      fetch: async (url: string, options: { method?: string } = {}) => {
        requests.push({ url, ...(options.method ? { method: options.method } : {}) })
        return { ok: true, json: async () => ({ opened: true }) }
      },
    })
    const dataDirectory = 'C:\\Users\\tester\\.dsh\\stratagate'
    const tree = SettingsPage({
      selected: { schemaVersion: 11, blockTurnSize: 6, blockDecayLambda: 0.3, currentTurn: 8, workspaceName: 'StrataGate' },
      namespace: 'dsh:project:test', dataDirectory, onBack: () => {}, setView: () => {},
      updateSettings: () => Promise.resolve(), savingSettings: false, usePluginSettings: null,
      setEffort: null, resetEffort: null,
    })
    const storageButtons = elementProps(tree).filter((props) => props.className === 'sg-storage-button')
    expect(storageButtons).toHaveLength(2)
    storageButtons[0]!.onClick()
    storageButtons[1]!.onClick()
    await Promise.resolve()
    expect(requests).toEqual([{ url: '/api/stratagate/storage/open-directory', method: 'POST' }])
    expect(copied).toBe(dataDirectory)
    expect(elementProps(tree).find((props) => props.className === 'sg-storage-path')?.title).toBe(dataDirectory)
  })

  it('shows eleven compact Profile rows on the primary page and no Profile editor in Advanced settings', () => {
    const profile = {
      userPreferredName: '', assistantPreferredName: '', preferredLanguage: '中文', reasoningLanguage: '', defaultLocation: '', homeCity: '', currentCity: '', responsePreferences: '',
      standingInstructions: '', userBackground: '', longTermGoals: '', persistentNotes: '',
    }
    const { ProfilePage } = loadSupportHelpers([profile])
    const profileTree = ProfilePage()
    expect(deepElementProps(profileTree).filter((props) => props.className === 'sg-profile-row')).toHaveLength(11)
    expect(deepElementProps(profileTree).filter((props) => props.className === 'sg-profile-group')).toHaveLength(5)
    expect(deepElementProps(profileTree).filter((props) => String(props.id || '').startsWith('sg-profile-') && props.value !== undefined)).toHaveLength(0)
    expect(deepElementProps(profileTree).filter((props) => props.className === 'sg-profile-action')).toHaveLength(11)
    expect(deepElementProps(profileTree).filter((props) => props.className === 'sg-profile-value empty')).toHaveLength(10)
    expect(JSON.stringify(profileTree)).toContain('默认回答语言')
    expect(JSON.stringify(profileTree)).toContain('思考过程语言')
    expect(JSON.stringify(profileTree)).toContain('常用地址')
    expect(JSON.stringify(profileTree)).toContain('常驻地址（未说明时默认地址）')
    expect(JSON.stringify(profileTree)).toContain('当前所在城市（临时）')
    expect(JSON.stringify(profileTree)).not.toContain('常驻城市（原有字段）')
    expect(JSON.stringify(profileTree)).not.toContain('两者独立，不会因旅行或临时所在地自动更改')
    expect(JSON.stringify(profileTree)).not.toContain('默认使用语言')
    const settings = loadSupportHelpers().SettingsPage
    const tree = settings({
      selected: { schemaVersion: 12, blockTurnSize: 6, blockDecayLambda: 0.3, currentTurn: 0 },
      namespace: '', dataDirectory: '', onBack: () => {}, setView: () => {},
      updateSettings: () => Promise.resolve(), savingSettings: false, usePluginSettings: null,
      setEffort: null, resetEffort: null,
    })
    expect(deepElementProps(tree).filter((props) => String(props.id || '').startsWith('sg-profile-'))).toHaveLength(0)
    expect(elementProps(tree).some((props) => props['aria-labelledby'] === 'sg-profile-title')).toBe(false)
  })

  it('keeps an existing home city visible without relabeling it as the temporary current city', () => {
    const profile = { userPreferredName: '', assistantPreferredName: '', preferredLanguage: '', reasoningLanguage: '', defaultLocation: '广州天河', homeCity: '深圳', currentCity: '杭州', responsePreferences: '', standingInstructions: '', userBackground: '', longTermGoals: '', persistentNotes: '' }
    const tree = loadSupportHelpers([profile]).ProfilePage()
    expect(deepElementProps(tree).filter((props) => props.className === 'sg-profile-row')).toHaveLength(12)
    expect(JSON.stringify(tree)).toContain('常驻城市（原有字段）')
    expect(JSON.stringify(tree)).toContain('当前所在城市（临时）')
    expect(JSON.stringify(tree)).toContain('深圳')
    expect(JSON.stringify(tree)).toContain('杭州')
    expect(deepElementProps(tree).filter((props) => props.className === 'sg-profile-action')).toHaveLength(12)
  })

  it('polls only while visible, keeps an edit draft, and saves only the current field after conflict resolution', async () => {
    let server = { userPreferredName: '', assistantPreferredName: '', preferredLanguage: '中文', reasoningLanguage: '', defaultLocation: '', homeCity: '', currentCity: '', responsePreferences: 'A', standingInstructions: '', userBackground: '', longTermGoals: '', persistentNotes: '' }
    const revisions: Record<string, number> = { preferredLanguage: 0, reasoningLanguage: 0, responsePreferences: 0, defaultLocation: 0, homeCity: 0, currentCity: 0 }
    const state: unknown[] = []
    const refs: Array<{ current: unknown }> = []
    const effects: Array<() => () => void> = []
    const timers = new Map<number, { callback: () => void; delay: number }>()
    const writes: Array<{ field: string; value: string; expectedValue: string; expectedRevision: number }> = []
    let stateIndex = 0
    let refIndex = 0
    let nextTimer = 0
    let mounted = false
    let reads = 0
    let changes = 0
    let onVisibilityChange = () => {}
    const document = { hidden: false, addEventListener: (_name: string, listener: () => void) => { onVisibilityChange = listener }, removeEventListener: () => {} }
    const react = {
      createContext: (value: unknown) => ({ Provider: 'provider', value }),
      createElement: (...args: unknown[]) => args, Fragment: 'fragment',
      useState: (initial: unknown) => {
        const index = stateIndex++
        if (!(index in state)) state[index] = initial
        return [state[index], (update: unknown) => {
          const next = typeof update === 'function' ? (update as (value: unknown) => unknown)(state[index]) : update
          if (next !== state[index]) changes++
          state[index] = next
        }]
      },
      useRef: (initial: unknown) => {
        const index = refIndex++
        return refs[index] ||= { current: initial }
      },
      useEffect: (effect: () => () => void) => { if (!mounted) effects.push(effect) },
    }
    const { ProfilePage } = loadSupportHelpers([], {
      react, document, AbortController,
      window: { setTimeout: (callback: () => void, delay: number) => { const id = ++nextTimer; timers.set(id, { callback, delay }); return id }, clearTimeout: (id: number) => timers.delete(id) },
      fetch: async (_url: string, options: { method?: string; body?: string } = {}) => {
        if (options.method === 'PATCH') {
          const body = JSON.parse(options.body || '{}') as { field: string; value: string; expectedValue: string; expectedRevision: number }
          writes.push(body)
          if (server[body.field as keyof typeof server] !== body.expectedValue || revisions[body.field] !== body.expectedRevision) return { ok: false, status: 409, json: async () => ({ error: '该项刚刚在其他位置更新' }) }
          server = { ...server, [body.field]: body.value }
          revisions[body.field] = (revisions[body.field] || 0) + 1
          return { ok: true, json: async () => ({ field: body.field, value: body.value, modified: true, snapshot: { ...server, _revisions: { ...revisions } } }) }
        }
        reads++
        return { ok: true, json: async () => ({ ...server, _revisions: { ...revisions } }) }
      },
    })
    const render = () => { stateIndex = 0; refIndex = 0; return ProfilePage() }
    const flush = () => new Promise((resolve) => setImmediate(resolve))
    const tick = async () => { await flush(); const next = [...timers].find(([, timer]) => timer.delay === 5000)!; expect(next).toBeDefined(); timers.delete(next[0]); next[1].callback(); await flush() }
    render()
    const cleanup = effects[0]!()
    mounted = true
    await flush()
    expect(reads).toBe(1)
    expect(deepElementProps(render()).filter((props) => props.className === 'sg-profile-row')).toHaveLength(11)
    changes = 0
    await tick()
    expect(changes).toBe(0)
    server = { ...server, preferredLanguage: 'English' }
    revisions.preferredLanguage = (revisions.preferredLanguage || 0) + 1
    await tick()
    expect(JSON.stringify(render())).toContain('English')
    const edit = deepElementProps(render()).filter((props) => props.className === 'sg-profile-action')[4]!
    edit.onClick()
    let tree = render()
    const textarea = deepElementProps(tree).find((props) => props.id === 'sg-profile-responsePreferences')!
    expect(textarea.value).toBe('A')
    textarea.onChange({ target: { value: 'discarded draft' } })
    deepElementProps(render()).find((props) => props.className === 'sg-quiet-button')!.onClick()
    expect(writes).toHaveLength(0)
    expect(deepElementProps(render()).filter((props) => props.id === 'sg-profile-responsePreferences')).toHaveLength(0)
    deepElementProps(render()).filter((props) => props.className === 'sg-profile-action')[4]!.onClick()
    deepElementProps(render()).find((props) => props.id === 'sg-profile-responsePreferences')!.onChange({ target: { value: 'draft C' } })
    server = { ...server, responsePreferences: 'B', preferredLanguage: 'Français' }
    revisions.responsePreferences = (revisions.responsePreferences || 0) + 1
    revisions.preferredLanguage = (revisions.preferredLanguage || 0) + 1
    await tick()
    tree = render()
    expect(deepElementProps(tree).find((props) => props.id === 'sg-profile-responsePreferences')?.value).toBe('draft C')
    expect(JSON.stringify(tree)).toContain('Français')
    expect(JSON.stringify(tree)).toContain('该项刚刚在其他位置更新')
    expect(deepElementProps(tree).find((props) => props.className === 'sg-save-button')?.disabled).toBe(true)
    buttonProps(tree, '放弃草稿并载入最新内容')!.onClick()
    await flush()
    tree = render()
    expect(deepElementProps(tree).find((props) => props.id === 'sg-profile-responsePreferences')?.value).toBe('B')
    deepElementProps(tree).find((props) => props.id === 'sg-profile-responsePreferences')!.onChange({ target: { value: 'saved C' } })
    deepElementProps(render()).find((props) => props.className === 'sg-save-button')!.onClick()
    await flush()
    expect(writes).toEqual([{ field: 'responsePreferences', value: 'saved C', expectedValue: 'B', expectedRevision: 1 }])
    expect(server.preferredLanguage).toBe('Français')
    server = { ...server, reasoningLanguage: '中文' }
    revisions.reasoningLanguage = (revisions.reasoningLanguage || 0) + 1
    await tick()
    expect(JSON.stringify(render())).toContain('中文')
    deepElementProps(render()).filter((props) => props.className === 'sg-profile-action')[3]!.onClick()
    expect(deepElementProps(render()).find((props) => props.id === 'sg-profile-reasoningLanguage')?.value).toBe('中文')
    deepElementProps(render()).find((props) => props.id === 'sg-profile-reasoningLanguage')!.onChange({ target: { value: '日语' } })
    server = { ...server, reasoningLanguage: 'English' }
    revisions.reasoningLanguage = (revisions.reasoningLanguage || 0) + 1
    await tick()
    tree = render()
    expect(deepElementProps(tree).find((props) => props.id === 'sg-profile-reasoningLanguage')?.value).toBe('日语')
    expect(JSON.stringify(tree)).toContain('该项刚刚在其他位置更新')
    expect(deepElementProps(tree).find((props) => props.className === 'sg-save-button')?.disabled).toBe(true)
    buttonProps(tree, '放弃草稿并载入最新内容')!.onClick()
    await flush()
    expect(deepElementProps(render()).find((props) => props.id === 'sg-profile-reasoningLanguage')?.value).toBe('English')
    deepElementProps(render()).find((props) => props.id === 'sg-profile-reasoningLanguage')!.onChange({ target: { value: '日语' } })
    deepElementProps(render()).find((props) => props.className === 'sg-save-button')!.onClick()
    await flush()
    expect(writes.at(-1)).toEqual({ field: 'reasoningLanguage', value: '日语', expectedValue: 'English', expectedRevision: 2 })
    expect(server.preferredLanguage).toBe('Français')
    for (const [index, field, value] of [[6, 'defaultLocation', '广州天河'], [7, 'currentCity', '深圳']] as const) {
      deepElementProps(render()).filter((props) => props.className === 'sg-profile-action')[index]!.onClick()
      const input = deepElementProps(render()).find((props) => props.id === 'sg-profile-' + field)!
      expect(input.value).toBe('')
      input.onChange({ target: { value } })
      deepElementProps(render()).find((props) => props.className === 'sg-save-button')!.onClick()
      await flush()
      expect(writes.at(-1)).toEqual({ field, value, expectedValue: '', expectedRevision: 0 })
      expect(JSON.stringify(render())).toContain(value)
    }
    expect(server.defaultLocation).toBe('广州天河')
    expect(server.currentCity).toBe('深圳')
    expect(server.homeCity).toBe('')
    document.hidden = true
    onVisibilityChange()
    expect([...timers.values()].filter((timer) => timer.delay === 5000)).toHaveLength(0)
    document.hidden = false
    onVisibilityChange()
    await flush()
    expect(reads).toBeGreaterThan(3)
    cleanup()
    expect(timers.size).toBe(0)
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
    expect(source).toContain('event.summary')
    expect(source).not.toContain('event.narrative')
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

  it('resets Event pagination when timeline search parameters change or clear', async () => {
    const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
    const instrumented = source.replace(
      "    exports.name = 'stratagate-dsh'",
      "    exports.__test = { usePagedMemory }; exports.name = 'stratagate-dsh'",
    )
    const slots: any[] = []
    const effectDependencies: any[][] = []
    let cursor = 0
    let pendingEffects: Array<() => unknown> = []
    const React = {
      createContext: (value: unknown) => ({ Provider: 'provider', value }),
      createElement: (...args: unknown[]) => args,
      Fragment: 'fragment',
      useState: (initial: unknown) => {
        const index = cursor++
        if (!(index in slots)) slots[index] = typeof initial === 'function' ? (initial as () => unknown)() : initial
        return [slots[index], (next: unknown) => { slots[index] = typeof next === 'function' ? (next as (value: unknown) => unknown)(slots[index]) : next }]
      },
      useRef: (initial: unknown) => {
        const index = cursor++
        if (!(index in slots)) slots[index] = { current: initial }
        return slots[index]
      },
      useEffect: (effect: () => unknown, dependencies: any[]) => {
        const index = cursor++
        const previous = effectDependencies[index]
        const changed = !previous || dependencies.some((value, dependencyIndex) => value !== previous[dependencyIndex])
        effectDependencies[index] = dependencies
        if (changed) pendingEffects.push(effect)
      },
    }
    const requests: string[] = []
    let serverItems: unknown[] = []
    let definition: any
    runInNewContext(instrumented, {
      URLSearchParams,
      fetch: async (url: string) => {
        requests.push(String(url))
        const parsed = new URL(String(url), 'http://localhost')
        return {
          ok: true,
          json: async () => ({ items: serverItems, total: 100, offset: Number(parsed.searchParams.get('offset')), limit: 40 }),
        }
      },
      window: { setTimeout, clearTimeout, __ModuleLoader__: { load: (value: unknown) => { definition = value } } },
    })
    const plugin = definition.factory((name: string) => {
      if (name !== 'react') throw new Error(`unexpected client dependency: ${name}`)
      return React
    })
    let initialItems: unknown[] = []
    const initialPage = { total: 100, offset: 0, limit: 40 }
    const render = (extraParams: Record<string, string>) => {
      cursor = 0
      pendingEffects = []
      const result = plugin.__test.usePagedMemory({
        namespace: 'timeline', kind: 'events', initialItems, initialPage, fallbackLimit: 40,
        extraParams, reloadOnParamsChange: true,
      })
      const effects = pendingEffects
      pendingEffects = []
      effects.forEach((effect) => effect())
      return result
    }

    const first = render({ timeline: 'true' })
    await first.loadOffset(40)
    expect(new URL(requests.at(-1)!, 'http://localhost').searchParams.get('offset')).toBe('40')

    render({ timeline: 'true', q: 'Needle Event' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    let latest = new URL(requests.at(-1)!, 'http://localhost')
    expect(latest.searchParams.get('offset')).toBe('0')
    expect(latest.searchParams.get('q')).toBe('Needle Event')

    serverItems = [{ id: 'filtered-dashboard-refresh' }]
    initialItems = [{ id: 'unfiltered-dashboard-refresh' }]
    render({ timeline: 'true', q: 'Needle Event' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const afterRefresh = render({ timeline: 'true', q: 'Needle Event' })
    expect(afterRefresh.items).toEqual([{ id: 'filtered-dashboard-refresh' }])
    latest = new URL(requests.at(-1)!, 'http://localhost')
    expect(latest.searchParams.get('offset')).toBe('0')
    expect(latest.searchParams.get('q')).toBe('Needle Event')

    render({ timeline: 'true' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    latest = new URL(requests.at(-1)!, 'http://localhost')
    expect(latest.searchParams.get('offset')).toBe('0')
    expect(latest.searchParams.has('q')).toBe(false)
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

  it('keeps all feedback data local and puts only the paste hint in email links', () => {
    const { SupportPage, FEEDBACK_EMAIL, EMAIL_BODY_HINT } = loadSupportHelpers([false, false, false, '', '', '', '问题', false, false, false, 2, { text: '报告', title: '' }])
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
    expect(hrefs).toHaveLength(0)
    expect(JSON.stringify(tree)).toContain(FEEDBACK_EMAIL)
    expect(JSON.stringify(tree)).toContain('尚未发送')
    expect(hrefs.every((href) => href.startsWith('mailto:' + FEEDBACK_EMAIL))).toBe(true)
    for (const href of hrefs) expect(new URL(href).searchParams.get('body')).toBe(EMAIL_BODY_HINT)
    expect(JSON.stringify(tree)).not.toContain('GitHub')
    expect(JSON.stringify(tree)).not.toContain('AI 帮我填')
    expect(JSON.stringify(tree)).not.toContain('提交 PR')
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
    expect(JSON.stringify(tree)).toContain('有了问题描述后，即可检查报告。')
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

  it('restores draft fields independently so a late GET cannot overwrite edited values', () => {
    const { restoreFeedbackDraftValues } = loadSupportHelpers()
    const draft = { title: 'old title', description: 'old body' }
    expect(restoreFeedbackDraftValues(draft, { title: true, body: false })).toEqual({ title: undefined, problemContent: '## 问题描述\n\nold body' })
    expect(restoreFeedbackDraftValues(draft, { title: false, body: true })).toEqual({ title: 'old title', problemContent: undefined })
    expect(restoreFeedbackDraftValues(draft, { title: false, body: false })).toEqual({ title: 'old title', problemContent: '## 问题描述\n\nold body' })
  })

  it('shows a persistent top AI-copy notice with retry, close, sticky, and scroll visibility handling', () => {
    let copied = ''
    const { SupportPage, FEEDBACK_AI_PROMPT } = loadSupportHelpers(
      [false, false, false, '', '', '', '', false, true],
      { navigator: { clipboard: { writeText: async (value: string) => { copied = value } } } },
      true, // Exercise the preserved GitHub UI only in this isolated test.
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

  it.each(['frontend', 'job'])('keeps %s error text out of default reports and redacts opted-in logs', (origin) => {
    const { buildSupportReport } = loadSupportHelpers()
    const error = 'private-error-body owner@example.net C:\\Users\\private\\memory.db /home/private/memory.db https://private.example.net/x?q=secret sk-private123456789 token=private-token'
    const input = {
      problemContent: '记忆处理异常',
      recentError: origin === 'frontend' ? error : '',
      selected: { failedJobDetails: origin === 'job' ? [{ kind: 'summary', lastError: error, lastErrorFull: error }] : [] },
      diagnostics: { records: [{ id: 'diag_test', stage: 'summarizer', category: 'storage', at: '2026-10-16T00:00:00Z', detail: error }] },
    }
    const report = buildSupportReport(input)
    expect(report).not.toContain('private-error-body')
    expect(report).toContain('summarizer')
    expect(report).toContain('2026-10-16T00:00:00Z')
    expect(report).toContain('storage')
    const logs = buildSupportReport({ ...input, includeLogs: true })
    expect(logs).toContain('private-error-body')
    for (const privateValue of ['owner@example.net', 'C:\\Users\\private\\memory.db', '/home/private/memory.db', 'https://private.example.net', 'sk-private123456789', 'private-token']) {
      expect(report).not.toContain(privateValue)
      expect(logs).not.toContain(privateValue)
    }
  })

  it('redacts nested sensitive values without breaking the attached JSON or recent errors', () => {
    const { buildSupportReport } = loadSupportHelpers()
    const secret = 'ghp_1234567890abcdef'
    const report = buildSupportReport({
      problemContent: 'Observed token=inline-secret and a useful detail.',
      recentError: `first line is useful\nsecond line has password=error-secret and Bearer abcdefghijklmnop`,
      includeLogs: true,
      includeMemory: true,
      selected: { failedJobDetails: [{ kind: 'summary', lastErrorFull: 'safe failure detail' }] },
      data: {
        blocks: [{
          id: 'block-1',
          l5Raw: [{ toolCalls: [{
            arguments: {
              password: 'nested-password', passwd: 'nested-passwd', token: 'nested-token',
              accessToken: 'nested-access', refresh_token: 'nested-refresh', apiKey: 'nested-api',
              authorization: 'nested-auth', secret: 'nested-secret', safe: 'keep this',
            },
            result: { message: `Bearer ${secret}` },
          }] }],
        }],
        events: [{ id: 'event-1', title: 'Keep event title', summary: 'api_key=event-secret' }],
        graph: { nodes: [{ id: 'node-1', name: 'Keep node', currentState: 'secret=graph-secret' }], edges: [] },
      },
    })
    expect(report).not.toContain(secret)
    expect(report).not.toContain('nested-password')
    expect(report).not.toContain('nested-passwd')
    expect(report).not.toContain('nested-token')
    expect(report).not.toContain('nested-access')
    expect(report).not.toContain('nested-refresh')
    expect(report).not.toContain('nested-api')
    expect(report).not.toContain('nested-auth')
    expect(report).not.toContain('nested-secret')
    expect(report).not.toContain('error-secret')
    expect(report).not.toContain('abcdefghijklmnop')
    expect(report).toContain('second line has')
    expect(report).toContain('Keep event title')
    const jsonBlock = report.match(/## 用户主动附加的记忆数据[\s\S]*?```json\n([\s\S]*?)\n```/)?.[1]
    expect(jsonBlock).toBeTruthy()
    expect(() => JSON.parse(jsonBlock!)).not.toThrow()
  })

  it('redacts complete free-text credentials without damaging JSON', () => {
    const { buildSupportReport } = loadSupportHelpers()
    const report = buildSupportReport({
      problemContent: 'password="two words" Authorization: Basic dXNlcjpwYXNz authorization=Basic basic-credential authorization = Token token-credential Basic bare-basic-credential Token bare-token-credential access_token=access-value refreshToken=refresh-value useful detail',
      includeLogs: true,
      recentError: 'password="error words" Authorization: Basic c2VjcmV0 access_token=error-access refreshToken=error-refresh; keep this detail',
      data: { blocks: [], events: [], graph: { nodes: [], edges: [] } },
    })
    for (const secret of ['two words', 'dXNlcjpwYXNz', 'basic-credential', 'token-credential', 'bare-basic-credential', 'bare-token-credential', 'access-value', 'refresh-value', 'error words', 'c2Vjcm0', 'c2VjcmV0', 'error-access', 'error-refresh']) {
      expect(report).not.toContain(secret)
    }
    expect(report).toContain('useful detail')
    expect(report).toContain('keep this detail')
    const jsonBlock = report.match(/## 诊断日志[\s\S]*?```json\n([\s\S]*?)\n```/)?.[1]
    expect(() => JSON.parse(jsonBlock!)).not.toThrow()
  })

  it('copies the frozen report and opens an Issue URL containing only title and the paste hint', async () => {
    const { buildSupportReport, copyReportAndOpenIssue, shouldExpandFeedbackPreview, issueUrl, ISSUE_BODY_HINT } = loadSupportHelpers()
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
      (url: string) => { opened.push(url); return null },
    )
    expect(failure).toMatchObject({ copied: false, opened: false })
    expect(failure.error).toContain('permission denied')
    expect(opened).toHaveLength(2)
    expect(shouldExpandFeedbackPreview(failure)).toBe(true)
    expect(report).toContain('chat snapshot')

    const unavailable = await copyReportAndOpenIssue(report, null, () => null)
    expect(unavailable).toMatchObject({ copied: false, opened: false })
    expect(unavailable.error).toContain('不支持自动复制')
    expect(shouldExpandFeedbackPreview(unavailable)).toBe(true)
    expect(shouldExpandFeedbackPreview({ copied: true })).toBe(false)

    const titled: string[] = []
    await copyReportAndOpenIssue(report, { writeText: async () => {} }, (url: string) => { titled.push(url); return {} }, 'Draft title')
    expect(new URL(titled[0]!).searchParams.get('title')).toBe('Draft title')
    expect(new URL(titled[0]!).searchParams.get('body')).toBe(ISSUE_BODY_HINT)
    expect([...new URL(titled[0]!).searchParams.keys()].sort()).toEqual(['body', 'title'])
    expect(titled[0]!).not.toContain('chat snapshot')

    const popupBlocked = await copyReportAndOpenIssue(report, { writeText: async () => {} }, () => null)
    expect(popupBlocked).toEqual({ copied: true, opened: false, error: '' })
  })

  it('keeps copying and email activation separate while draft saving is pending', async () => {
    const calls: string[] = []
    const { SupportPage } = loadSupportHelpers(
      [false, false, false, '', '', '', '## 问题描述\n\nLocal failure', false, false, false, 2, { text: 'reviewed report', title: 'feedback' }],
      {
        fetch: () => new Promise(() => {}),
        navigator: { clipboard: { writeText: () => { calls.push('copy'); return Promise.resolve() } } },
        window: { location: { set href(url: string) { expect(url).toMatch(/^mailto:jiahongcheng61@gmail\.com/); calls.push('compose') } } },
      },
    )
    const tree = SupportPage({ namespace: 'dsh:project:test', overview: {}, selected: {}, data: {}, recentError: '', onBack: () => {} })
    const button = elementProps(tree).find((props) => props.className === 'sg-primary-link')
    expect(button).toBeDefined()
    await button!.onClick()
    expect(calls).toEqual(['copy'])
    const mailButton = buttonProps(tree, '尝试打开邮件应用')
    expect(mailButton).toBeUndefined()
    expect(calls).toEqual(['copy'])
  })

  it('shows the complete reviewed report and reuses the exact preview for copy and download', async () => {
    const closedHelpers = loadSupportHelpers([true, false, false, '', '', '', '## 问题描述\n\nLocal failure', false, false, false, 2, { text: 'reviewed report', title: '' }])
    const closedTree = closedHelpers.SupportPage({ namespace: 'dsh:project:test', overview: {}, selected: {}, data: {}, recentError: 'local-only-error', onBack: () => {} })
    expect(elementProps(closedTree).find((props) => props['aria-label'] === '本地反馈报告预览')?.value).toBe('reviewed report')

    const report = '## 问题描述\n\nLocal failure\n\n## 诊断日志\nlocal-only-error'
    const { copyReportAndComposeEmail, downloadSupportReport, SupportPage } = loadSupportHelpers([true, false, false, '', '', '', '## 问题描述\n\nLocal failure', false, false, true, 2, { text: report, title: '' }])
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
    expect(JSON.stringify(tree)).toContain('完整报告')
    expect(preview).toContain('## 诊断日志')
    expect(preview).toContain('local-only-error')
    expect(objectUrlCalls).toBe(0)
    expect(clickCalls).toBe(0)
    expect(openCalls).toBe(0)

    await copyReportAndComposeEmail(preview, { writeText: async (value: string) => { copied.push(value) } }, () => { openCalls += 1 })
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
    expect(source).toContain('这段对话的摘要暂不可用。')
    expect(source).not.toContain('原始对话已保存，不会丢失')
    expect(source).toContain('没有记录技术错误。')
    expect(source).toContain("['raw', '{}', '查看原始数据'")
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

  it('has no global background task banner and retains dashboard read/error handling', () => {
    const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
    expect(source).not.toContain('function MemoryStatusAlert')
    expect(source).not.toContain('h(MemoryStatusAlert')
    expect(source).toContain("'/api/stratagate/dashboard'")
    expect(source).toContain("'If-None-Match'")
    expect(source).toContain('pollFast ? 2500 : 30000')
    expect(source).toContain('setError(')
  })

  it('distinguishes terminal summary failure from scheduled retries', () => {
    const { summaryUnavailable } = loadSupportHelpers()
    expect(summaryUnavailable({ summaryJob: { status: 'failed', attempts: 1, nextRetryAt: '2026-10-22T00:00:00Z' } })).toBe(false)
    expect(summaryUnavailable({ summaryJob: { status: 'failed', attempts: 3, nextRetryAt: null } })).toBe(true)
    expect(summaryUnavailable({ summaryJob: { state: 'retryable', status: 'failed' } })).toBe(false)
    expect(summaryUnavailable({ summaryJob: { state: 'terminal-failed', status: 'failed' } })).toBe(true)
    expect(summaryUnavailable({ summaryJob: { status: 'succeeded' } })).toBe(false)
  })

  it('offers raw conversation only with confirmed readable source data, without default retry', () => {
    const { SummaryUnavailable } = loadSupportHelpers()
    for (const rawAvailable of [false, true]) {
      const tree = SummaryUnavailable({ namespace: 'workspace-a', block: { id: 'a', rawAvailable } })
      expect(JSON.stringify(tree)).toContain('这段对话的摘要暂不可用。')
      expect(Boolean(buttonProps(tree, '查看原始对话'))).toBe(rawAvailable)
      expect(JSON.stringify(tree)).not.toMatch(/重新压缩|重试任务/)
    }
  })

  it('keeps transient source reads retryable, hides unavailable sources, and provides an explicit collapse', () => {
    const props = { namespace: 'workspace-a', block: { id: 'a', rawAvailable: true } }
    const temporary = loadSupportHelpers([null, { kind: 'temporary', text: '暂时无法读取这段对话的原文。' }, false, false])
    expect(buttonProps(temporary.SummaryUnavailable(props), '重新读取原文')).toBeDefined()
    const unavailable = loadSupportHelpers([null, { kind: 'unavailable', text: '当前没有可读取的原文。' }, false, false])
    expect(buttonProps(unavailable.SummaryUnavailable(props), '查看原始对话')).toBeUndefined()
    expect(buttonProps(unavailable.SummaryUnavailable(props), '重新读取原文')).toBeUndefined()
    const expanded = loadSupportHelpers([{ messages: [{ id: 'm1', content: '真实来源', role: 'user' }] }, null, false, true])
    const tree = expanded.SummaryUnavailable(props)
    expect(buttonProps(tree, '收起原始对话')?.['aria-expanded']).toBe(true)
    expect(JSON.stringify(tree)).toContain('真实来源')
  })

  it.each([true, false, undefined])('reports diagnostic source readability from evidence (%s)', (rawAvailable) => {
    const { ProcessingStatus } = loadSupportHelpers()
    const tree = ProcessingStatus({ namespace: 'workspace-a', blocks: [], conversations: [], refresh: async () => null,
      overview: { processingJobDetails: [], failedJobDetails: [{ id: 'b1', kind: 'block-summary', status: 'failed',
        state: 'terminal-failed', attempts: 3, blockDetails: [{ id: 'b1', threadId: 't1', rawAvailable }] }] } })
    const text = JSON.stringify(tree)
    expect(text).toContain(rawAvailable === true ? '当前可读取' : rawAvailable === false ? '当前无可读取原文' : '无法确认是否可读取')
    expect(text).not.toContain('保存原始对话')
    expect(text).toContain('后台任务')
  })

  it.each(['graph', 'timeline'])('keeps the empty long-term %s view quiet while preserving actual graph work', (mode) => {
    const render = (migration: any) => {
      let stateIndex = 0
      const React = {
        createContext: (value: unknown) => ({ Provider: 'provider', value }),
        createElement: (...args: unknown[]) => args,
        Fragment: 'fragment',
        useState: (initial: any) => [stateIndex++ === 0 ? mode : typeof initial === 'function' ? initial() : initial, () => {}],
        useEffect: () => {},
        useRef: (initial: unknown) => ({ current: initial }),
        useMemo: (factory: () => unknown) => factory(),
      }
      const { LongTermPage } = loadSupportHelpers([], { react: React })
      return JSON.stringify(LongTermPage({
        events: [], eventPage: { total: 0, offset: 0, limit: 40 },
        graphSettings: { enabled: true }, graph: { nodes: [], edges: [], migration }, project: '', query: '', setQuery: () => {}, namespace: '',
      }))
    }
    expect(render(null)).not.toContain('sg-migration')
    expect(render({ projected: 0, total: 0, state: 'incomplete', complete: false })).not.toContain('sg-migration')
    expect(render({ projected: 0, total: 0, state: 'complete', complete: true })).not.toContain('sg-migration')
    const notice = '当前图谱尚未更新完整。'
    for (const migration of [
      { projected: 0, total: 1, state: 'incomplete' },
      { projected: 0, total: 0, processing: 1 },
      { projected: 0, total: 0, failed: 1 },
    ]) {
      expect(render(migration).includes(notice)).toBe(mode === 'graph')
      expect(render(migration)).not.toMatch(/Graph Projection|Events|失败批次|立即重试/)
    }
    expect(render({ projected: 1, total: 1, complete: true })).not.toContain(notice)
    expect(render({ state: 'processing' })).not.toContain(notice)
    expect(render({ state: 'failed' })).not.toContain(notice)
  })

  it('keeps diagnostic task states separate and scheduled retries nonterminal', () => {
    const { taskStatus } = loadSupportHelpers()
    expect(taskStatus({
      processingJobDetails: [{ kind: 'graph-projection', id: 'g1', state: 'processing' }],
      failedJobDetails: [{ kind: 'graph-projection', id: 'g2', state: 'terminal-failed', attempts: 3, nextRetryAt: null }],
    })).toMatchObject({ graphProjection: { processing: 1, terminalFailed: 1 } })
    expect(taskStatus({
      processingJobDetails: [{ kind: 'graph-projection', id: 'retry-1', status: 'failed', state: 'retryable', nextRetryAt: '2026-09-19T00:01:00.000Z', attempts: 1 }],
      failedJobDetails: [{ kind: 'graph-projection', id: 'retry-1', status: 'failed', state: 'retryable', nextRetryAt: '2026-09-19T00:01:00.000Z', attempts: 1 }],
    })).toMatchObject({ graphProjection: { processing: 1, retryable: 1, terminalFailed: 0 } })
  })

  it('separates status refresh from per-job retry with explicit feedback', () => {
    const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
    const statusSource = source.slice(source.indexOf('function processingFingerprint'), source.indexOf('function ImportPage'))
    expect(statusSource).toContain("api('jobs/retry'")
    expect(statusSource).toContain("{ method: 'POST' }")
    expect(statusSource).toContain('重试此任务')
    expect(statusSource).toContain('正在处理…')
    expect(statusSource).toContain('后台任务')
    expect(statusSource).toContain('原始对话')
    expect(statusSource).not.toContain("['保存原始对话', { kind: 'done'")
    expect(statusSource).toContain('压缩会话记忆')
    expect(statusSource).toContain('提取长期记忆')
    expect(statusSource).toContain('更新知识图谱')
    expect(statusSource).toContain('const extractionJobs = item.jobs.filter')
    expect(statusSource).toContain('const graphJobs = item.jobs.filter')
    expect(statusSource).toContain('等待短期摘要')
    expect(statusSource).toContain('等待提取')
    expect(statusSource).toContain('查看技术详情')
    expect(statusSource).toContain('计划重试：')
    expect(statusSource).toContain('自动重试已停止')
    expect(statusSource).toContain('只读取最新状态，不会触发模型调用。')
    expect(statusSource).toContain('正在读取…')
    expect(statusSource).toContain('状态已更新')
    expect(statusSource).toContain('状态没有变化')
    expect(statusSource).toContain('读取失败：')
    expect(statusSource).toContain('groups.map((group) =>')
    expect(statusSource).toContain('group.items.map((item) =>')
    expect(statusSource).not.toContain("h('dt', null, 'Block')")
  })

  it('shows clipboard failure immediately without waiting for draft persistence', () => {
    const calls: string[] = []
    const { handleFeedbackIssueResult } = loadSupportHelpers()
    let combinedError = '保存反馈草稿失败：disk full'
    const result = handleFeedbackIssueResult({ copied: false, opened: true, error: '复制失败：permission denied' }, {
      setPreviewOpen: (value: boolean) => calls.push('preview:' + value),
      setError: (update: string | ((current: string) => string)) => {
        combinedError = typeof update === 'function' ? update(combinedError) : update
        calls.push('error:' + combinedError)
      },
    })
    expect(result.copied).toBe(false)
    expect(calls[0]).toBe('preview:true')
    expect(calls[1]).toContain('保存反馈草稿失败')
    expect(calls[1]).toContain('复制失败')
  })

  it('keeps Event Extraction and Graph Projection separate in the status details', () => {
    const { ProcessingStatus } = loadSupportHelpers()
    const blockDetails = [{ id: 'blk-1', sourceId: 'blk-1', sequence: 1, title: '测试块', threadId: 'thread-1', turnRange: [1, 4], shouldExtract: true }]
    const failedJob = (kind: string, id: string) => ({
      id, kind, status: 'failed', state: 'terminal-failed', attempts: 3, nextRetryAt: null,
      updatedAt: '2026-09-18T00:00:00.000Z', lastError: kind + ' failed', blockIds: ['blk-1'], blockDetails,
    })
    const rendered = JSON.stringify(ProcessingStatus({
      overview: {
        processingJobs: 0,
        failedJobs: 2,
        processingJobDetails: [],
        failedJobDetails: [failedJob('event-extraction', 'extract-1'), failedJob('graph-projection', 'graph-1')],
      },
      blocks: [],
      conversations: [{ id: 'thread-1', label: '测试对话' }],
      namespace: 'dsh:project:test',
      serverVersion: '0.2.73',
      onBack: () => {},
      refresh: async () => null,
    }))
    expect(rendered).toContain('提取长期记忆')
    expect(rendered).toContain('更新知识图谱')
    expect(rendered).toContain('"sg-process-stage-name"},"提取长期记忆"')
    expect(rendered).toContain('"sg-process-stage-name"},"更新知识图谱"')
    expect(rendered).toContain('长期记忆提取')
    expect(rendered).toContain('知识图谱更新')
  })

  it('uses a comprehensive diagnostic title and only exposes terminal retry actions', () => {
    const { ProcessingStatus } = loadSupportHelpers()
    const details = [{ id: 'blk-1', sourceId: 'blk-1', sequence: 1, title: '测试块', threadId: 'thread-1', turnRange: [1, 4], shouldExtract: true }]
    const job = (kind: string, state: string, nextRetryAt: string | null) => ({
      id: kind + '-1', kind, status: 'failed', state, attempts: state === 'retryable' ? 1 : 3, nextRetryAt,
      updatedAt: '2026-09-19T00:00:00.000Z', lastError: kind + ' failed', blockIds: ['blk-1'], blockDetails: details,
    })
    const props = (stage: string, jobs: any[]) => ({
      overview: { processingJobs: jobs.length, failedJobs: jobs.length, processingJobDetails: [], failedJobDetails: jobs },
      blocks: [], conversations: [{ id: 'thread-1', label: '测试对话' }], namespace: 'dsh:project:test', serverVersion: '0.2.73', stage,
      onBack: () => {}, refresh: async () => null,
    })
    const summaryRetryable = JSON.stringify(ProcessingStatus(props('summary', [job('block-summary', 'retryable', '2026-09-19T00:01:00.000Z')])))
    expect(summaryRetryable).toContain('后台任务')
    expect(summaryRetryable).toContain('计划自动重试')
    expect(summaryRetryable).not.toContain('重试此任务')
    const extractionTerminal = JSON.stringify(ProcessingStatus(props('extraction', [job('event-extraction', 'terminal-failed', null)])))
    expect(extractionTerminal).toContain('后台任务')
    expect(extractionTerminal).toContain('重试此任务')
    const graphTerminal = JSON.stringify(ProcessingStatus(props('graph', [job('graph-projection', 'terminal-failed', null)])))
    expect(graphTerminal).toContain('后台任务')
    expect(graphTerminal).toContain('提取长期记忆')
    expect(graphTerminal).toContain('已完成')
    expect(graphTerminal).toContain('更新失败，可重试')
    expect(graphTerminal).toContain('重试此任务')
  })

  it('does not claim legacy background work is empty when the old server omits job details', () => {
    const { ProcessingStatus } = loadSupportHelpers()
    const props = {
      overview: { processingJobs: 2, failedJobs: 0 },
      blocks: [],
      conversations: [],
      namespace: 'dsh:project:test',
      serverVersion: '0.2.62',
      onBack: () => {},
      refresh: async () => null,
    }
    const unavailable = JSON.stringify(ProcessingStatus(props))
    expect(unavailable).toContain('仍有 2 个后台任务正在整理')
    expect(unavailable).toContain('前后端版本尚未同步')
    expect(unavailable).toContain('当前页面为 __STRATAGATE_CLIENT_VERSION__，后台为 0.2.62')
    expect(unavailable).toContain('任务仍在整理，具体会话暂不可用')
    expect(unavailable).not.toContain('当前没有待整理的对话片段')

    const recovered = JSON.stringify(ProcessingStatus({
      ...props,
      overview: { processingJobs: 1, failedJobs: 0 },
      blocks: [{
        id: 'blk-legacy', status: 'processing', processingStatus: 'pending', threadId: 'thread-old',
        turnRange: [13, 18], summaryJob: { status: 'running', attempts: 1, updatedAt: '2026-09-13T00:00:00.000Z' },
      }],
      conversations: [{ id: 'thread-old', label: '帮我试用最新版' }],
    }))
    expect(recovered).toContain('帮我试用最新版')
    expect(recovered).toContain('第 13–18 轮')
    expect(recovered).toContain('压缩会话记忆')
    expect(recovered).toContain('处理中')
    expect(recovered).not.toContain('任务仍在整理，具体会话暂不可用')
  })
})


describe('daily notes client', () => {
  it('keeps the default session page and five untruncated navigation labels', () => {
    const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
    expect(source).toContain("React.useState('short')")
    expect(source).toContain("[['profile', '常驻画像'], ['short', '会话记忆'], ['daily', '短期记忆'], ['long', '长期记忆'], ['more', '更多']]")
    expect(source).toContain('repeat(5,1fr)')
    expect(source).toContain('会话记忆详情')
    expect(source).toContain('会话记忆状态')
    expect(source).toContain('完成一些 DSH 对话后，会话记忆和长期记忆会出现在这里。')
  })
  it('renders safe React Markdown, retaining unknown syntax and literal HTML', () => {
    const { renderDailyMarkdown } = loadSupportHelpers()
    const output = JSON.stringify(renderDailyMarkdown('# 2026-10-28\n## 事项\n当前：进展 `file.ts`\n已完成：验证通过\n- 列表\n### 未知语法\n<script>alert(1)</script>\n```\n# 不应丢失的标题'))
    expect(output).not.toContain('# 2026-10-28')
    for (const text of ['h4', '事项', 'sg-daily-status', ' done', 'ul', 'li', 'code', 'file.ts', '### 未知语法', '<script>alert(1)</script>', '# 不应丢失的标题', '```']) expect(output).toContain(text)
    const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
    const daily = source.slice(source.indexOf('function dailyInline'), source.indexOf('function ShortTermPage'))
    expect(daily).not.toContain('dangerouslySetInnerHTML')
    expect(daily).toContain('abort.abort()')
    expect(daily).not.toContain('setInterval')
  })
  it('calculates relative dates without timezone or daylight-saving shifts', () => {
    const { dailyRelative } = loadSupportHelpers()
    expect(dailyRelative('2026-10-28', '2026-10-28')).toBe('今天')
    expect(dailyRelative('2026-10-27', '2026-10-28')).toBe('昨天')
    expect(dailyRelative('2026-09-28', '2026-10-28')).toBe('30 天前')
    expect(dailyRelative('2026-10-29', '2026-10-28')).toBe('1 天后')
  })
  it('distinguishes empty, failed list, failed note and disabled states', () => {
    const empty = { dates: [], injectedDates: [], enabled: true, today: '2026-10-28' }
    const tree = (index: unknown, error = '', selected = '', note = { loading: false, date: selected, markdown: '', error: '' }) => loadSupportHelpers([index, false, error, selected, note]).DailyNotesPage({ namespace: 'n' })
    expect(JSON.stringify(tree(empty))).toContain('还没有笔记')
    expect(JSON.stringify(tree(empty))).toContain('Agent 推进工作时会自动记录。')
    const failed = JSON.stringify(tree(null, 'permission denied'))
    expect(failed).toContain('暂时无法读取笔记'); expect(failed).toContain('重新读取'); expect(failed).toContain('alert'); expect(failed).not.toContain('还没有笔记')
    const index = { ...empty, enabled: false, dates: ['2026-10-28'], injectedDates: ['2026-10-28'] }
    const disabled = JSON.stringify(tree(index, '', '2026-10-28'))
    expect(disabled).toContain('已关闭，不再写入，也不会带入新会话。'); expect(disabled).toContain('已暂停注入')
    const noteFailed = JSON.stringify(tree(index, '', '2026-10-28', { loading: false, date: '2026-10-28', markdown: '', error: 'file denied' }))
    expect(noteFailed).toContain('暂时无法读取笔记'); expect(noteFailed).not.toContain('还没有笔记')
  })
  it('binds confirmed DSH settings values without optimistic updates', async () => {
    const { DailyNotesSettings } = loadSupportHelpers()
    const enabled = vi.fn(async () => true)
    const timezone = vi.fn(async () => true)
    const tree = DailyNotesSettings({ usePluginSettings: (select: any) => select({ writable: true, value: { dailyNotesEnabled: false, dailyNotesTimeZone: 'UTC' } }), setDailyEnabled: enabled, setDailyTimeZone: timezone })
    const props = deepElementProps(tree)
    const toggle = props.find(prop => prop.role === 'switch')
    expect(toggle['aria-checked']).toBe(false)
    toggle.onClick(); await Promise.resolve(); expect(enabled).toHaveBeenCalledWith(true)
    const select = props.find(prop => prop['aria-label'] === '笔记时区')
    expect(select.value).toBe('UTC'); select.onChange({ target: { value: '' } }); await Promise.resolve(); expect(timezone).toHaveBeenCalledWith('')
    expect(JSON.stringify(tree)).toContain('已有笔记保留')
    const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
    expect(source).toContain("pluginSettingsScope.set('dailyNotesEnabled', enabled)")
    expect(source).toContain("pluginSettingsScope.unset('dailyNotesTimeZone')")
  })
})
