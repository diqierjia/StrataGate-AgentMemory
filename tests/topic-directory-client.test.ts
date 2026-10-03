import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

type Element = { type: string | ((props: any) => Element); props: any; children: any[] }
type Rendered = { type: string; props: any; children: Rendered[]; text: string; visible: boolean }

// Runs the actual host components and their state setters. Browser regression
// covers layout/focus/motion; this harness exercises numbering and interactions
// without adding another React or DOM implementation to the plugin.
function clientRenderer(runEffects = false) {
  const hooks = new Map<string, any[]>()
  let pendingEffects: Array<() => void> = []
  let current = { path: '', index: 0 }
  const slot = (initial: () => any) => {
    const index = current.index++
    const slots = hooks.get(current.path) || []
    hooks.set(current.path, slots)
    if (!(index in slots)) slots[index] = initial()
    return { slots, index }
  }
  const React = {
    createContext: () => ({ Provider: 'provider' }),
    createElement: (type: Element['type'], props: any, ...children: any[]): Element => ({ type, props: props || {}, children: children.flat(Infinity) }),
    Fragment: 'fragment',
    useState: (initial: any) => {
      const { slots, index } = slot(() => typeof initial === 'function' ? initial() : initial)
      return [slots[index], (update: any) => { slots[index] = typeof update === 'function' ? update(slots[index]) : update }]
    },
    useRef: (value: any) => { const { slots, index } = slot(() => ({ current: value })); return slots[index] },
    useMemo: (compute: () => any) => compute(),
    useCallback: (callback: any) => callback,
    useEffect: (effect: () => void, dependencies: any[]) => {
      if (!runEffects) return
      const { slots, index } = slot(() => undefined)
      const previous = slots[index]
      slots[index] = dependencies
      if (!previous || !dependencies || dependencies.some((value, key) => value !== previous[key])) pendingEffects.push(effect)
    },
    useLayoutEffect: () => {},
  }
  const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8').replace(
    "    exports.name = 'stratagate-dsh'",
    "    exports.__topicTest = { TopicDirectory, TopicSection, TopicBootstrapNotice, LongTermPage, MemoryPage, directoryScrollAction, topicSections, chapterOrdinal }; exports.name = 'stratagate-dsh'",
  )
  let definition: any
  runInNewContext(source, {
    URL, URLSearchParams,
    document: { body: { style: {} }, querySelector: () => null },
    window: { __ModuleLoader__: { load: (value: any) => { definition = value } }, setTimeout: () => 0, clearTimeout: () => {}, addEventListener: () => {}, removeEventListener: () => {} },
  })
  const components = definition.factory(() => React).__topicTest
  const renderNode = (value: any, path: string, visible: boolean): Rendered | null => {
    if (value === null || value === undefined || value === false) return null
    if (typeof value !== 'object') return { type: '#text', props: {}, children: [], text: String(value), visible }
    if (typeof value.type === 'function') {
      const previous = current
      current = { path, index: 0 }
      const element = value.type({ ...value.props, children: value.children })
      current = previous
      return renderNode(element, path + '/body', visible)
    }
    const shown = visible && !value.props.hidden && value.props['aria-hidden'] !== true
    const children = value.children.flat(Infinity).map((child: any, index: number) => renderNode(child, path + '/' + (child?.props?.key ?? index), shown)).filter(Boolean) as Rendered[]
    return { type: value.type, props: value.props, children, text: children.map((child) => child.text).join(''), visible: shown }
  }
  return {
    ...components,
    seedHooks: (values: Record<number, any>) => { const slots: any[] = []; Object.entries(values).forEach(([key, value]) => { slots[Number(key)] = value }); hooks.set('root', slots) },
    render: (component: Element['type'], props: any) => {
      const tree = renderNode(React.createElement(component, props), 'root', true)!
      const effects = pendingEffects
      pendingEffects = []
      effects.forEach((effect) => effect())
      return tree
    },
  }
}

function find(tree: Rendered, predicate: (node: Rendered) => boolean): Rendered[] {
  return (predicate(tree) ? [tree] : []).concat(tree.children.flatMap((child) => find(child, predicate)))
}
function buttons(tree: Rendered, text?: string) {
  return find(tree, (node) => node.visible && node.type === 'button' && (!text || node.text === text))
}
function fixture() {
  const events = Array.from({ length: 26 }, (_, index) => ({ id: 'event-' + (index + 1), title: '历史事件 ' + (index + 1), summary: '事件摘要' }))
  const topic = (id: string, title: string, parts: any[]) => ({ id, title, description: title + '的历史与进展', overview: parts, sourceEventIds: parts.flatMap((part) => part.sourceEventIds), coverage: { totalEvents: 20, summarizedEvents: 20, omittedEvents: 0 } })
  return {
    events,
    topics: [
      topic('topic-a', '记忆架构', [
        { kind: 'history', text: '八条事件的完整发展脉络', sourceEventIds: events.slice(0, 8).map(({ id }) => id) },
        { kind: 'decision', text: '关键决定总览', sourceEventIds: events.slice(8, 20).map(({ id }) => id) },
      ]),
      topic('topic-b', '求职与实习', [{ kind: 'scope', text: '正在讨论的机会', sourceEventIds: [events[20]!.id] }]),
      { id: 'fallback:22', isFallback: true, title: '等待整理', overview: [], sourceEventIds: [events[21]!.id] },
    ],
    bootstrap: { status: 'completed', total: 26, completed: 26, failedEvents: 0, failures: [] },
    context: '记忆目录：记忆架构；求职与实习',
  }
}

describe('Topic Directory client interactions', () => {
  it('restores directory scroll only on returning to the same workspace and clears it on other navigation', () => {
    const { directoryScrollAction } = clientRenderer()
    const saved = { namespace: 'dsh:project:old', top: 740 }
    expect(directoryScrollAction(saved, 'long', saved.namespace, 'event')).toBe('detail')
    expect(directoryScrollAction(saved, 'long', saved.namespace, 'root')).toBe('restore')
    for (const section of ['short', 'profile', 'more']) expect(directoryScrollAction(saved, section, saved.namespace, 'root')).toBe('clear')
    expect(directoryScrollAction(saved, 'long', 'dsh:project:new', 'root')).toBe('clear')
    expect(directoryScrollAction(saved, 'long', saved.namespace, 'settings')).toBe('clear')
    expect(directoryScrollAction(null, 'long', saved.namespace, 'root')).toBe('none')
  })

  it('does not render another workspace directory while its new dashboard request is pending', () => {
    const client = clientRenderer()
    const oldNamespace = 'dsh:project:old'
    const namespace = 'dsh:project:new'
    const directory = fixture()
    const data = { events: [], graph: { nodes: [], edges: [] }, blocks: [], openBlock: null, conversations: [], activeThreadId: null, audit: [], topicDirectory: directory, pagination: {} }
    const overview = { namespaces: [{ namespace: oldNamespace }, { namespace }] }
    const props = { useWorkspaces: (select: any) => select({ items: [] }), useSessions: (select: any) => select({ byId: {} }) }
    // These are MemoryPage's ordinary state/ref slots, before any effects run.
    client.seedHooks({ 0: overview, 1: namespace, 5: 'long', 8: data, 11: false, 18: { current: oldNamespace } })
    let tree = client.render(client.MemoryPage, props)
    expect(find(tree, (node) => node.visible && node.props['data-testid'] === 'stratagate-topic-directory')).toHaveLength(0)
    expect(find(tree, (node) => node.visible && node.props.className === 'sg-skeleton')).not.toHaveLength(0)
    const newDirectory = fixture()
    newDirectory.topics[0]!.title = '新工作区主题'
    client.seedHooks({ 0: overview, 1: namespace, 5: 'long', 8: { ...data, topicDirectory: newDirectory }, 11: false, 18: { current: namespace } })
    tree = client.render(client.MemoryPage, props)
    expect(find(tree, (node) => node.visible && node.props['data-testid'] === 'stratagate-topic-directory')).toHaveLength(1)
    expect(buttons(tree, '第一章新工作区主题›')).toHaveLength(1)
  })

  it('consumes a graph navigation request once and accepts another request for the same node', () => {
    const client = clientRenderer(true)
    const props = { events: [], eventPage: { total: 0, offset: 0, limit: 40 }, graph: { nodes: [{ id: 'node-1', name: '记忆架构', type: 'concept', status: 'active', sourceEventIds: [] }], edges: [], clusters: [] }, project: '当前工作区', query: '', setQuery: vi.fn(), openEvent: vi.fn(), namespace: 'dsh:project:test', topicDirectory: fixture(), focusNodeId: 'node-1', onFocusHandled: vi.fn() }
    props.onFocusHandled.mockImplementation(() => { props.focusNodeId = '' })
    client.render(client.LongTermPage, props)
    let tree = client.render(client.LongTermPage, props)
    expect(buttons(tree, '知识图谱')[0]!.props['aria-current']).toBe('page')
    expect(props.onFocusHandled).toHaveBeenCalledTimes(1)
    buttons(tree, '主题目录')[0]!.props.onClick()
    tree = client.render(client.LongTermPage, props)
    props.graph.nodes = [...props.graph.nodes]
    tree = client.render(client.LongTermPage, props)
    expect(buttons(tree, '主题目录')[0]!.props['aria-current']).toBe('page')
    expect(props.onFocusHandled).toHaveBeenCalledTimes(1)
    props.focusNodeId = 'node-1'
    client.render(client.LongTermPage, props)
    tree = client.render(client.LongTermPage, props)
    expect(buttons(tree, '知识图谱')[0]!.props['aria-current']).toBe('page')
    expect(props.onFocusHandled).toHaveBeenCalledTimes(2)
  })

  it('defaults LongTermPage to the directory while preserving graph and timeline navigation', () => {
    const client = clientRenderer()
    const props = { events: [], eventPage: { total: 0, offset: 0, limit: 40 }, graph: { nodes: [], edges: [], clusters: [] }, project: '当前工作区', query: '', setQuery: vi.fn(), openEvent: vi.fn(), namespace: 'dsh:project:test', topicDirectory: fixture() }
    let tree = client.render(client.LongTermPage, props)
    const nav = find(tree, (node) => node.props['aria-label'] === '长期记忆视角')[0]!
    expect(buttons(nav).map(({ text }) => text)).toEqual(['主题目录', '知识图谱', '事件时间线'])
    expect(buttons(nav, '主题目录')[0]!.props['aria-current']).toBe('page')
    expect(find(tree, (node) => node.visible && node.props.className === 'sg-long-toolbar')).toHaveLength(0)
    buttons(tree, '1.1发展脉络›')[0]!.props.onClick()
    buttons(tree, '知识图谱')[0]!.props.onClick()
    tree = client.render(client.LongTermPage, props)
    expect(buttons(tree, '知识图谱')[0]!.props['aria-current']).toBe('page')
    expect(find(tree, (node) => node.visible && node.props.className === 'sg-long-toolbar')).toHaveLength(1)
    buttons(tree, '事件时间线')[0]!.props.onClick()
    tree = client.render(client.LongTermPage, props)
    expect(buttons(tree, '事件时间线')[0]!.props['aria-current']).toBe('page')
    expect(buttons(tree, '下一页')).toHaveLength(1)
    buttons(tree, '主题目录')[0]!.props.onClick()
    tree = client.render(client.LongTermPage, props)
    expect(buttons(tree, '1.1发展脉络›')[0]!.props['aria-expanded']).toBe(true)
  })

  it('renders chapters and sections; opening eight-event section shows .0 through .8 with no show-all action', () => {
    const client = clientRenderer()
    const props = { directory: fixture(), openEvent: vi.fn() }
    let tree = client.render(client.TopicDirectory, props)
    expect(buttons(tree).map(({ text }) => text)).toContain('第一章记忆架构›')
    expect(buttons(tree).map(({ text }) => text)).toContain('第二章求职与实习›')
    expect(find(tree, (node) => node.props.className === 'sg-topic-chapter')).toHaveLength(2)
    expect(buttons(tree, '1.1发展脉络›')).toHaveLength(1)
    expect(buttons(tree, '1.2关键设计决策›')).toHaveLength(1)
    expect(buttons(tree, '2.1主题范围›')).toHaveLength(1)
    expect(buttons(tree).filter((node) => node.props['data-topic-event-id'] && node.props.className === 'sg-topic-event')).toHaveLength(1) // fallback remains reachable
    buttons(tree, '1.1发展脉络›')[0]!.props.onClick()
    tree = client.render(client.TopicDirectory, props)
    const first = find(tree, (node) => node.props['data-topic-id'] === 'topic-a')[0]!
    expect(buttons(first, '1.1.0总览›')[0]!.props['aria-expanded']).toBe(true)
    expect(find(first, (node) => node.visible && node.props.className === 'sg-topic-overview-text')[0]!.text).toBe('八条事件的完整发展脉络')
    const rows = buttons(first).filter((node) => node.props['data-topic-event-id'])
    expect(rows).toHaveLength(8)
    expect(rows[0]!.text).toBe('1.1.1历史事件 1↗')
    expect(rows.at(-1)!.text).toBe('1.1.8历史事件 8↗')
    expect(buttons(first, '还有 3 条事件 · 展开全部')).toHaveLength(0)
  })

  it('limits a large section to .0 + nine events, expands all, collapses again, and reuses the Event callback', () => {
    const client = clientRenderer()
    const openEvent = vi.fn()
    const props = { directory: fixture(), openEvent }
    let tree = client.render(client.TopicDirectory, props)
    buttons(tree, '1.2关键设计决策›')[0]!.props.onClick()
    tree = client.render(client.TopicDirectory, props)
    let section = find(tree, (node) => node.props['data-section-index'] === '2')[0]!
    expect(buttons(section).filter((node) => node.props['data-topic-event-id'])).toHaveLength(9)
    expect(buttons(section, '1.2.0总览›')[0]!.props['aria-expanded']).toBe(true)
    buttons(section, '还有 3 条事件 · 展开全部')[0]!.props.onClick()
    tree = client.render(client.TopicDirectory, props)
    section = find(tree, (node) => node.props['data-section-index'] === '2')[0]!
    expect(buttons(section).filter((node) => node.props['data-topic-event-id'])).toHaveLength(12)
    const last = buttons(section).filter((node) => node.props['data-topic-event-id']).at(-1)!
    expect(last.text).toBe('1.2.12历史事件 20↗')
    const trigger = { getAttribute: () => 'event-20' }
    last.props.onClick({ currentTarget: trigger })
    expect(openEvent).toHaveBeenCalledWith(props.directory.events[19]!, trigger)
    buttons(section, '收起多余事件')[0]!.props.onClick()
    tree = client.render(client.TopicDirectory, props)
    section = find(tree, (node) => node.props['data-section-index'] === '2')[0]!
    expect(buttons(section).filter((node) => node.props['data-topic-event-id'])).toHaveLength(9)
  })

  it('preserves section and overview state across topic refresh and stable section identity', () => {
    const client = clientRenderer()
    const props = { directory: fixture(), openEvent: vi.fn() }
    let tree = client.render(client.TopicDirectory, props)
    buttons(tree, '1.1发展脉络›')[0]!.props.onClick()
    tree = client.render(client.TopicDirectory, props)
    buttons(tree, '1.1.0总览›')[0]!.props.onClick()
    const updated = { directory: structuredClone(props.directory) }
    updated.directory.topics[0]!.overview[0]!.text = '刷新后的脉络'
    updated.directory.topics[0]!.overview[0]!.sourceEventIds.push('event-26')
    tree = client.render(client.TopicDirectory, { ...props, directory: updated.directory })
    expect(buttons(tree, '1.1发展脉络›')[0]!.props['aria-expanded']).toBe(true)
    expect(buttons(tree, '1.1.0总览›')[0]!.props['aria-expanded']).toBe(false)
    const oldParts = client.topicSections(props.directory.topics[0]!)
    const newParts = client.topicSections(updated.directory.topics[0]!)
    expect(oldParts.map((part: any) => part.uiKey)).toEqual(newParts.map((part: any) => part.uiKey))
  })

  it.each(['pending', 'running'])('shows temporary bootstrap progress for %s', (status) => {
    const client = clientRenderer()
    const directory = fixture()
    directory.bootstrap = { ...directory.bootstrap, status, total: 61, completed: 24 }
    const tree = client.render(client.TopicDirectory, { directory, openEvent: vi.fn() })
    expect(tree.text).toContain('正在整理历史记忆 · 24 / 61')
    expect(tree.text).toContain('不影响正常使用，未整理记忆仍可正常检索')
  })

  it('removes completed successful/empty bootstrap notices and keeps terminal failures inspectable', () => {
    const client = clientRenderer()
    const props = { directory: fixture(), openEvent: vi.fn() }
    expect(find(client.render(client.TopicDirectory, props), (node) => String(node.props.className || '').startsWith('sg-topic-bootstrap '))).toHaveLength(0)
    props.directory.bootstrap = { ...props.directory.bootstrap, total: 0, completed: 0, status: 'pending' }
    expect(find(client.render(client.TopicDirectory, props), (node) => String(node.props.className || '').startsWith('sg-topic-bootstrap '))).toHaveLength(0)
    props.directory.bootstrap = { status: 'completed', total: 61, completed: 58, failedEvents: 3, failures: [{ jobId: 'failed-1', eventIds: ['event-22'], attempts: 3, lastError: '结构校验失败' }] } as any
    let tree = client.render(client.TopicDirectory, props)
    expect(tree.text).toContain('3 条历史记忆暂未完成整理')
    buttons(tree, '查看详情')[0]!.props.onClick()
    tree = client.render(client.TopicDirectory, props)
    expect(find(tree, (node) => node.visible && node.props.className === 'sg-topic-failure')).toHaveLength(1)
    expect(buttons(tree, '收起详情')).toHaveLength(1)
    const failureEvent = buttons(tree).find((node) => node.props['data-topic-event-id'] === 'event-22')!
    failureEvent.props.onClick({ currentTarget: {} })
    expect(props.openEvent).toHaveBeenCalledWith(props.directory.events[21]!, {})
  })

  it('keeps zero/one/nine event overviews complete without inventing rows or show-all actions', () => {
    for (const count of [0, 1, 9]) {
      const client = clientRenderer()
      const directory = fixture()
      directory.topics = [directory.topics[0]!]
      directory.topics[0]!.overview = [{ kind: 'scope', text: '总览', sourceEventIds: directory.events.slice(0, count).map(({ id }) => id) }]
      directory.topics[0]!.sourceEventIds = directory.topics[0]!.overview[0]!.sourceEventIds
      const props = { directory, openEvent: vi.fn() }
      let tree = client.render(client.TopicDirectory, props)
      buttons(tree, '1.1主题范围›')[0]!.props.onClick()
      tree = client.render(client.TopicDirectory, props)
      expect(buttons(tree).filter((node) => node.props['data-topic-event-id'])).toHaveLength(count)
      expect(buttons(tree, '1.1.0总览›')).toHaveLength(1)
      expect(buttons(tree).filter((node) => node.props.className === 'sg-topic-show-all')).toHaveLength(0)
    }
  })
})
