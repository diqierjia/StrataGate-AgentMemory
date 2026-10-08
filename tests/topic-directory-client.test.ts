import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { memoryTopicSections, memoryTopicSectionNavigation, memoryTopicSectionKey } from '../src/topics.js'

type Element = { type: string | ((props: any) => Element); props: any; children: any[] }
type Rendered = { type: string; props: any; children: Rendered[]; text: string; visible: boolean }

// Runs the actual host components and their state setters. Browser regression
// covers layout/focus/motion; this harness exercises numbering and interactions
// without adding another React or DOM implementation to the plugin.
function clientRenderer(runEffects = false, fetchOverride?: any) {
  const hooks = new Map<string, any[]>()
  const callbacks = new Map<string, { dependencies: any[]; callback: any }>()
  let pendingEffects: Array<() => void> = []
  let current = { path: '', index: 0, callbackIndex: 0 }
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
    useCallback: (callback: any, dependencies: any[]) => {
      const key = current.path + ':callback:' + current.callbackIndex++
      const previous = callbacks.get(key)
      if (previous && previous.dependencies.length === dependencies.length && dependencies.every((value, index) => value === previous.dependencies[index])) return previous.callback
      callbacks.set(key, { dependencies, callback })
      return callback
    },
    useEffect: (effect: () => any, dependencies: any[]) => {
      if (!runEffects) return
      const { slots, index } = slot(() => undefined)
      const previous = slots[index]
      if (!previous || !dependencies || dependencies.some((value, key) => value !== previous.dependencies[key])) {
        const next = { dependencies, cleanup: undefined as any }
        slots[index] = next
        pendingEffects.push(() => { previous?.cleanup?.(); next.cleanup = effect() })
      }
    },
    useLayoutEffect: () => {},
  }
  const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8').replace(
    "    exports.name = 'stratagate-dsh'",
    "    exports.__topicTest = { TopicDirectory, TopicSection, TopicRetryButton, TopicBootstrapNotice, LongTermPage, MemoryPage, directoryScrollAction, topicSections, chapterOrdinal, useTopicEventPages }; exports.name = 'stratagate-dsh'",
  ).replace('      let content = null', '      exports.__topicTest.dashboardLoader = loadDashboard; let content = null')
  let backendDirectory = fixture()
  const fetchMock = vi.fn(fetchOverride || (async (url: string) => {
    const parsed = new URL(url, 'http://localhost')
    const params = parsed.searchParams
    if (parsed.pathname !== '/api/stratagate/topic-events') throw new Error('Unexpected read: ' + parsed.pathname)
    if (params.get('expectedRevision') !== backendDirectory.revision) return { ok: false, status: 409, json: async () => ({ code: 'directory-changed', error: 'Directory changed' }) }
    const topicId = params.get('topicId')
    const sectionKey = params.get('sectionKey') || ''
    const allEvents = eventFixture()
    const assigned = new Set(backendDirectory.topics.flatMap((topic) => topic.sourceEventIds))
    const pending = allEvents.filter(({ id }) => !assigned.has(id)).slice(0, backendDirectory.pending.total)
    let ids: string[] = []
    if (topicId === 'pending') {
      ids = pending.map(({ id }) => id)
      if (sectionKey.startsWith('failure:')) ids = backendDirectory.bootstrap.failures.find((job: any) => job.jobId === sectionKey.slice(8))?.eventIds || []
    } else {
      const topic = backendDirectory.topics.find((topic) => topic.id === topicId)!
      if (!sectionKey) ids = topic.sourceEventIds
      else if (sectionKey === 'uncovered') {
        const assigned = new Set(memoryTopicSections({ ...topic, sections: topic.memberships } as any).flatMap((section) => section.sourceEventIds))
        ids = topic.sourceEventIds.filter((id) => !assigned.has(id))
      } else {
        ids = memoryTopicSections({ ...topic, sections: topic.memberships } as any).find((section) => section.key === sectionKey)?.sourceEventIds || []
      }
    }
    const offset = Number(params.get('offset'))
    const limit = Number(params.get('limit'))
    const items = ids.slice(offset, offset + limit).map((id) => allEvents.find((event) => event.id === id)!)
    return { ok: true, status: 200, json: async () => ({ namespace: params.get('namespace'), topicId, sectionKey: sectionKey || null, revision: backendDirectory.revision, items, total: ids.length, offset, limit, nextOffset: offset + items.length < ids.length ? offset + items.length : null }) }
  }))
  let definition: any
  runInNewContext(source, {
    URL, URLSearchParams, AbortController, fetch: fetchMock,
    document: { body: { style: {} }, hidden: true, querySelector: () => null, addEventListener: () => {}, removeEventListener: () => {} },
    window: { __ModuleLoader__: { load: (value: any) => { definition = value } }, setTimeout: () => 0, clearTimeout: () => {}, addEventListener: () => {}, removeEventListener: () => {} },
  })
  const components = definition.factory(() => React).__topicTest
  // Raw relations belong to the mock server; actual UI components receive the
  // same count-only contract as Dashboard. Preserve snapshot identity so the
  // conflict/recovery tests still exercise real directory refresh behavior.
  const directoryViews = new WeakMap<object, { fingerprint: string; view: any }>()
  const directoryView = (directory: any) => {
    const fingerprint = JSON.stringify(directory)
    const cached = directoryViews.get(directory)
    if (cached?.fingerprint === fingerprint) return cached.view
    const view = { ...directory, topics: directory.topics.map((topic: any) => {
      const { sourceEventIds, overview, ...navigation } = topic
      const ids = sourceEventIds ? [...new Set<string>(sourceEventIds)] : null
      const summarized = new Set<string>(overview.flatMap((part: any) => part.sourceEventIds || []))
      const sections = topic.sections || memoryTopicSectionNavigation({ overview, sourceEventIds: sourceEventIds || [], sections: topic.memberships })
      const assigned = new Set(ids ? memoryTopicSections({ overview, sourceEventIds: sourceEventIds || [], sections: topic.memberships }).flatMap((section) => section.sourceEventIds) : [])
      return { ...navigation,
        coverage: ids ? { totalEvents: ids.length, summarizedEvents: ids.filter((id) => summarized.has(id)).length, omittedEvents: ids.filter((id) => !summarized.has(id)).length, unassignedEvents: ids.filter((id) => !assigned.has(id)).length } : topic.coverage,
        overview: overview.map(({ sourceEventIds: references, ...part }: any) => ({ ...part, sourceEventCount: references ? new Set(references).size : part.sourceEventCount })),
        sections: topic.sections || sections,
      }
    }), bootstrap: directory.bootstrap ? { ...directory.bootstrap, failures: directory.bootstrap.failures.map(({ eventIds, ...failure }: any) => ({ ...failure, eventCount: eventIds ? new Set(eventIds).size : failure.eventCount })) } : null }
    directoryViews.set(directory, { fingerprint, view })
    return view
  }
  const renderNode = (value: any, path: string, visible: boolean): Rendered | null => {
    if (value === null || value === undefined || value === false) return null
    if (typeof value !== 'object') return { type: '#text', props: {}, children: [], text: String(value), visible }
    if (typeof value.type === 'function') {
      const previous = current
      current = { path, index: 0, callbackIndex: 0 }
      const props = { ...value.props, children: value.children }
      if (value.type === components.TopicDirectory && props.directory) props.directory = directoryView(props.directory)
      const element = value.type(props)
      current = previous
      return renderNode(element, path + '/body', visible)
    }
    const shown = visible && !value.props.hidden && value.props['aria-hidden'] !== true
    const children = value.children.flat(Infinity).map((child: any, index: number) => renderNode(child, path + '/' + (child?.props?.key ?? index), shown)).filter(Boolean) as Rendered[]
    return { type: value.type, props: value.props, children, text: children.map((child) => child.text).join(''), visible: shown }
  }
  return {
    ...components,
    fetch: fetchMock,
    dashboardLoader: (...args: any[]) => components.dashboardLoader(...args),
    seedHooks: (values: Record<number, any>) => { const slots: any[] = []; Object.entries(values).forEach(([key, value]) => { slots[Number(key)] = value }); hooks.set('root', slots) },
    render: (component: Element['type'], props: any) => {
      if (props.directory || props.topicDirectory) backendDirectory = props.directory || props.topicDirectory
      const tree = renderNode(React.createElement(component, props), 'root', true)!
      const effects = pendingEffects
      pendingEffects = []
      effects.forEach((effect) => effect())
      return tree
    },
    flush: async () => { for (let step = 0; step < 50; step += 1) await Promise.resolve() },
  }
}

function find(tree: Rendered, predicate: (node: Rendered) => boolean): Rendered[] {
  return (predicate(tree) ? [tree] : []).concat(tree.children.flatMap((child) => find(child, predicate)))
}
function buttons(tree: Rendered, text?: string) {
  return find(tree, (node) => node.visible && node.type === 'button' && (!text || node.text === text))
}
function eventFixture() {
  return Array.from({ length: 26 }, (_, index) => ({ id: 'event-' + (index + 1), title: '历史事件 ' + (index + 1), status: 'active', createdAt: '2026-10-04T00:00:00.000Z' }))
}
function fixture() {
  const events = eventFixture()
  const topic = (id: string, title: string, parts: any[]): { id: string; title: string; description: string; overview: any[]; sourceEventIds: string[]; coverage: any; memberships?: any[] } => ({ id, title, description: title + '的历史与进展', overview: parts, sourceEventIds: parts.flatMap((part) => part.sourceEventIds), coverage: { totalEvents: 20, summarizedEvents: 20, omittedEvents: 0 } })
  return {
    revision: 'revision-1',
    pending: { total: 1 },
    topics: [
      topic('topic-a', '记忆架构', [
        { kind: 'history', text: '八条事件的完整发展脉络', sourceEventIds: events.slice(0, 8).map(({ id }) => id) },
        { kind: 'decision', text: '关键决定总览', sourceEventIds: events.slice(8, 20).map(({ id }) => id) },
      ]),
      topic('topic-b', '求职与实习', [{ kind: 'scope', text: '正在讨论的机会', sourceEventIds: [events[20]!.id] }]),
    ],
    bootstrap: { status: 'completed', total: 26, completed: 26, failedEvents: 0, failures: [] as any[] },
    context: '记忆目录：记忆架构；求职与实习',
  }
}

function pageReply(url: string, items: any[], total: number, nextOffset: number | null) {
  const params = new URL(url, 'http://localhost').searchParams
  return { ok: true, status: 200, json: async () => ({ namespace: params.get('namespace'), topicId: params.get('topicId'), sectionKey: params.get('sectionKey') || null, revision: params.get('expectedRevision'), items, total, offset: Number(params.get('offset')), limit: Number(params.get('limit')), nextOffset }) }
}

describe('Topic Directory client interactions', () => {
  it('marks truncated context as partial and opens the complete chapter navigation without reading Events', async () => {
    const client = clientRenderer(true)
    const directory = fixture()
    directory.context = '[StrataGate 记忆目录]\n仅供导航，不是事实证据。\n共 2 项；分类：work（工作与结果 2）。目录已裁剪；完整目录用 memory_list_topics(category, offset) 分页。\n- topic-a：记忆架构'
    const props = { directory, namespace: 'dsh:project:test', openEvent: vi.fn() }
    let tree = client.render(client.TopicDirectory, props)
    expect(find(tree, (node) => node.type === 'summary').map((node) => node.text)).toContain('查看目录摘要（部分内容）')
    expect(tree.text).toContain('…… 此处仅显示部分章节与小节。')
    expect(find(tree, (node) => node.type === 'pre')[0]!.text).toBe(directory.context)
    const chapterButtons = () => find(tree, (node) => node.props.className === 'sg-topic-chapter-toggle')
    for (const button of chapterButtons()) button.props.onClick()
    tree = client.render(client.TopicDirectory, props)
    expect(chapterButtons().every((button) => button.props['aria-expanded'] === false)).toBe(true)
    const focus = vi.fn(); const scrollIntoView = vi.fn(); const querySelector = vi.fn(() => ({ focus }))
    find(tree, (node) => Boolean(node.props.ref))[0]!.props.ref.current = { scrollIntoView, querySelector }
    buttons(tree, '查看完整目录')[0]!.props.onClick()
    client.render(client.TopicDirectory, props); await client.flush(); tree = client.render(client.TopicDirectory, props)
    expect(chapterButtons()).toHaveLength(directory.topics.length)
    expect(chapterButtons().every((button) => button.props['aria-expanded'] === true)).toBe(true)
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start' })
    expect(querySelector).toHaveBeenCalledWith('.sg-topic-chapter-toggle')
    expect(focus).toHaveBeenCalledWith({ preventScroll: true })
    expect(find(tree, (node) => node.props.className === 'sg-topic-section-toggle').length).toBeGreaterThan(0)
    expect(find(tree, (node) => node.props.className === 'sg-topic-section-toggle').every((node) => node.props['aria-expanded'] === false)).toBe(true)
    expect(client.fetch).not.toHaveBeenCalled()
    chapterButtons()[0]!.props.onClick(); tree = client.render(client.TopicDirectory, props)
    expect(chapterButtons()[0]!.props['aria-expanded']).toBe(false)
    buttons(tree, '查看完整目录')[0]!.props.onClick()
    client.render(client.TopicDirectory, props); await client.flush(); tree = client.render(client.TopicDirectory, props)
    expect(chapterButtons()[0]!.props['aria-expanded']).toBe(true)
    expect(client.fetch).not.toHaveBeenCalled()
  })

  it('does not label a complete or absent context as truncated', () => {
    const client = clientRenderer()
    const directory = fixture()
    directory.context = '[StrataGate 记忆目录]\n仅供导航，不是事实证据。\n- topic-a：目录已裁剪 的处理记录'
    const props = { directory, namespace: 'dsh:project:test', openEvent: vi.fn() }
    let tree = client.render(client.TopicDirectory, props)
    expect(find(tree, (node) => node.type === 'summary').map((node) => node.text)).toContain('查看目录内容')
    expect(tree.text).not.toContain('部分章节与小节')
    expect(buttons(tree, '查看完整目录')).toHaveLength(0)
    directory.context = ''
    tree = client.render(client.TopicDirectory, props)
    expect(find(tree, (node) => node.props.className === 'sg-topic-context')).toHaveLength(0)
    expect(buttons(tree, '查看完整目录')).toHaveLength(0)
  })

  it('shows independently assigned Events without a summary or an other-events bucket', async () => {
    const client = clientRenderer(true); const directory = fixture();
    directory.topics = [directory.topics[0]!]; const chapter = directory.topics[0]!;
    chapter.overview = []; chapter.sourceEventIds = ['event-1', 'event-2'];
    chapter.memberships = [{ title: '研究方向', sourceEventIds: ['event-1', 'event-2'] }];
    const props = { directory, namespace: 'dsh:project:test', openEvent: vi.fn() };
    let tree = client.render(client.TopicDirectory, props);
    expect(find(tree, (node) => node.props.className === 'sg-topic-other-events')).toHaveLength(0);
    buttons(tree, '1.1研究方向›')[0]!.props.onClick();
    client.render(client.TopicDirectory, props); await client.flush(); tree = client.render(client.TopicDirectory, props);
    expect(buttons(tree).filter((node) => node.props['data-topic-event-id']).map(({ text }) => text))
      .toEqual(['1.1.1历史事件 1↗', '1.1.2历史事件 2↗']);
    expect(buttons(tree, '1.1.0总览›')).toHaveLength(0);
  });

  it('groups same-named paragraphs of different kinds into stable named sections', () => {
    const client = clientRenderer()
    const sections = client.topicSections({ sections: memoryTopicSectionNavigation({ sourceEventIds: ['E1', 'E2'], overview: [
      { kind: 'history', title: '界面与交互', text: 'UI 历史', sourceEventIds: ['E1'] },
      { kind: 'history', title: 'DSH 兼容', text: '兼容性历史', sourceEventIds: ['E2'] },
      { kind: 'decision', title: '界面与交互', text: 'UI 决定', sourceEventIds: ['E1', 'E2'] },
    ] }) })
    expect(sections.map((section: any) => section.uiTitle)).toEqual(['界面与交互', 'DSH 兼容'])
    expect(sections.map((section: any) => section.uiKey)).toEqual([memoryTopicSectionKey('界面与交互'), memoryTopicSectionKey('DSH 兼容')])
    expect(sections[0].sourceEventCount).toBe(2)
    expect(sections[0].paragraphs.map((part: any) => part.text)).toEqual(['UI 历史', 'UI 决定'])
  })

  it('keeps .1 and .2 numbers when a new Event section is prepended by the projector', () => {
    const client = clientRenderer()
    const directory = fixture()
    const chapter = directory.topics[0]!
    chapter.overview[0].title = '界面与交互'
    chapter.overview[1].title = 'DSH 兼容'
    const props = { directory, namespace: 'dsh:project:test', openEvent: vi.fn() }
    let tree = client.render(client.TopicDirectory, props)
    expect(buttons(tree, '1.1界面与交互›')).toHaveLength(1)
    expect(buttons(tree, '1.2DSH 兼容›')).toHaveLength(1)
    buttons(tree, '1.1界面与交互›')[0]!.props.onClick()
    client.render(client.TopicDirectory, props)
    chapter.sourceEventIds.push('event-26')
    chapter.overview.unshift({ kind: 'change', title: '发布与版本', text: '新增发布', sourceEventIds: ['event-26'] })
    directory.revision = 'revision-2'
    tree = client.render(client.TopicDirectory, props)
    expect(buttons(tree, '1.1界面与交互›')[0]!.props['aria-expanded']).toBe(true)
    expect(buttons(tree, '1.2DSH 兼容›')).toHaveLength(1)
    expect(buttons(tree, '1.3发布与版本›')).toHaveLength(1)
    expect(buttons(tree, '1.1.0总览›')).toHaveLength(1)
  })


  it('keeps Event book numbers and .0 paragraph order after a same-section proposal prepends a new source', async () => {
    const client = clientRenderer(true); const directory = fixture();
    const chapter = directory.topics[0]!;
    chapter.overview = [{ kind: 'history', title: '界面与交互', text: '原段落', sourceEventIds: ['event-1', 'event-2'] }];
    chapter.sourceEventIds = ['event-1', 'event-2'];
    const props = { directory, namespace: 'dsh:project:test', openEvent: vi.fn() };
    let tree = client.render(client.TopicDirectory, props);
    buttons(tree, '1.1界面与交互›')[0]!.props.onClick();
    client.render(client.TopicDirectory, props); await client.flush(); tree = client.render(client.TopicDirectory, props);
    expect(buttons(tree).filter((node) => node.props['data-topic-event-id']).map(({ text }) => text))
      .toEqual(['1.1.1历史事件 1↗', '1.1.2历史事件 2↗']);
    chapter.sourceEventIds.push('event-3');
    chapter.overview.unshift({ kind: 'change', title: '界面与交互', text: '新增段落', sourceEventIds: ['event-3'] });
    directory.revision = 'revision-2';
    client.render(client.TopicDirectory, props); await client.flush();
    client.render(client.TopicDirectory, props); await client.flush(); tree = client.render(client.TopicDirectory, props);
    expect(buttons(tree).filter((node) => node.props['data-topic-event-id']).map(({ text }) => text))
      .toEqual(['1.1.1历史事件 1↗', '1.1.2历史事件 2↗', '1.1.3历史事件 3↗']);
    expect(find(tree, (node) => node.visible && node.props.className === 'sg-topic-overview-text').map(({ text }) => text))
      .toEqual(['原段落', '新增段落']);
  });

  it('uses stable section identity for shared-source ties even when paragraph order changes', () => {
    const topic = { sourceEventIds: ['E1'], overview: [
      { kind: 'history' as const, title: '界面与交互', text: '界面', sourceEventIds: ['E1'] },
      { kind: 'decision' as const, title: 'DSH 兼容', text: '兼容', sourceEventIds: ['E1'] },
    ] }
    const first = memoryTopicSections(topic).map(({ key }) => key)
    topic.overview.reverse()
    expect(memoryTopicSections(topic).map(({ key }) => key)).toEqual(first)
  })

  it('posts the selected failed batch once and refreshes only after it is queued', async () => {
    let resolve!: (value: any) => void
    const client = clientRenderer(true, (url: string, options: any) => {
      expect(new URL(url, 'http://localhost').pathname).toBe('/api/stratagate/topics/retry')
      expect(options.method).toBe('POST')
      return new Promise((done) => { resolve = done })
    })
    const refresh = vi.fn()
    const props = { failure: { jobId: 'failed-12', eventCount: 12 }, namespace: 'workspace-a', revision: 'revision-a', onDirectoryChanged: refresh }
    let tree = client.render(client.TopicRetryButton, props)
    const button = buttons(tree, '重新整理这 12 条')[0]!
    const run = button.props.onClick()
    button.props.onClick()
    tree = client.render(client.TopicRetryButton, props)
    expect(buttons(tree, '正在提交…')[0]!.props.disabled).toBe(true)
    expect(client.fetch).toHaveBeenCalledTimes(1)
    const params = new URL(String(client.fetch.mock.calls[0]![0]), 'http://localhost').searchParams
    expect(Object.fromEntries(params)).toEqual({ namespace: 'workspace-a', jobId: 'failed-12', expectedRevision: 'revision-a' })
    expect(refresh).not.toHaveBeenCalled()
    resolve({ ok: true, json: async () => ({ status: 'pending', jobId: 'retry-12' }) })
    await run
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('aborts a retry on workspace changes and ignores a late result instead of refreshing the new workspace', async () => {
    let resolve!: (value: any) => void
    let signal!: AbortSignal
    const client = clientRenderer(true, (_url: string, options: any) => {
      signal = options.signal
      return new Promise((done) => { resolve = done })
    })
    const refresh = vi.fn()
    const props = { failure: { jobId: 'failed', eventCount: 2 }, namespace: 'workspace-a', revision: 'revision-a', onDirectoryChanged: refresh }
    let tree = client.render(client.TopicRetryButton, props)
    const run = buttons(tree, '重新整理这 2 条')[0]!.props.onClick()
    props.namespace = 'workspace-b'
    props.revision = 'revision-b'
    client.render(client.TopicRetryButton, props)
    expect(signal.aborted).toBe(true)
    tree = client.render(client.TopicRetryButton, props)
    expect(buttons(tree, '重新整理这 2 条')[0]!.props.disabled).toBe(false)
    resolve({ ok: true, json: async () => ({ status: 'pending' }) })
    await run
    expect(refresh).not.toHaveBeenCalled()
  })

  it('keeps a failed submission retryable and reloads on a stale failure conflict', async () => {
    let status = 503
    const client = clientRenderer(true, async () => ({ ok: false, status, json: async () => ({ error: 'failed' }) }))
    const refresh = vi.fn()
    const props = { failure: { jobId: 'failed', eventCount: 1 }, namespace: 'workspace-a', revision: 'revision-a', onDirectoryChanged: refresh }
    let tree = client.render(client.TopicRetryButton, props)
    await buttons(tree, '重新整理这 1 条')[0]!.props.onClick()
    tree = client.render(client.TopicRetryButton, props)
    expect(tree.text).toContain('提交失败，请重试。')
    expect(buttons(tree, '重新整理这 1 条')[0]!.props.disabled).toBe(false)
    status = 409
    await buttons(tree, '重新整理这 1 条')[0]!.props.onClick()
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('uses count-only navigation for a large uncovered section and lazily reads its first nine rows', async () => {
    const client = clientRenderer(true, async (url: string) => {
      const parsed = new URL(url, 'http://localhost')
      expect(parsed.searchParams.get('sectionKey')).toBe('uncovered')
      return pageReply(url, eventFixture().slice(8, 17), 9_992, 9)
    })
    const directory = { ...fixture(), topics: [{
      id: 'large-topic', title: '大型正式主题', description: '完整关系仅在服务端',
      coverage: { totalEvents: 10_000, summarizedEvents: 8, omittedEvents: 9_992 },
      overview: [{ kind: 'history', text: '八条事件总览', sourceEventCount: 8 }],
      sections: [{ key: memoryTopicSectionKey('发展脉络'), title: '发展脉络', sourceEventCount: 8, paragraphs: [{ kind: 'history', text: '八条事件总览', sourceEventCount: 8 }] }],
    }] }
    const props = { directory, namespace: 'dsh:project:test', openEvent: vi.fn() }
    let tree = client.render(client.TopicDirectory, props)
    expect(client.fetch).toHaveBeenCalledTimes(0)
    const details = find(tree, (node) => node.props.className === 'sg-topic-other-events')[0]!
    expect(details.text).toContain('待归类事件 · 9992')
    details.props.onToggle({ currentTarget: { open: true } })
    client.render(client.TopicDirectory, props)
    await client.flush()
    tree = client.render(client.TopicDirectory, props)
    expect(buttons(tree).filter((node) => node.props['data-topic-event-id'])).toHaveLength(9)
    expect(buttons(tree, '还有 9983 条事件 · 展开全部')).toHaveLength(1)
    expect(client.fetch).toHaveBeenCalledTimes(1)
  })

  it('forces a fresh dashboard over an in-flight poll and ignores its later old data and ETag', async () => {
    const namespace = 'dsh:project:test'
    const overview = { namespaces: [{ namespace, events: 21 }] }
    const makeData = (revision: string, title: string) => {
      const directory = { ...fixture(), revision }
      directory.topics[0]!.title = title
      return { events: [], graph: { nodes: [], edges: [] }, blocks: [], openBlock: null, conversations: [], activeThreadId: null, audit: [], topicDirectory: directory, pagination: {} }
    }
    const oldData = makeData('revision-A', '旧版本记忆 A')
    const newData = makeData('revision-B', '新版本记忆 B')
    const dashboardReply = (data: any, etag: string) => ({ ok: true, status: 200, headers: { get: () => etag }, json: async () => ({ namespace, overview, processing: false, data }) })
    const pending: Array<{ signal: AbortSignal; resolve: (value: any) => void; options: any }> = []
    let request = 0
    const client = clientRenderer(true, (_url: string, options: any) => {
      request += 1
      if (request === 1) return Promise.resolve(dashboardReply(oldData, 'etag-A'))
      if (request === 4) return Promise.resolve({ ok: true, status: 304, headers: { get: () => 'etag-B' } })
      return new Promise((resolve) => pending.push({ signal: options.signal, resolve, options }))
    })
    client.seedHooks({ 0: overview, 1: namespace, 5: 'long', 8: oldData, 11: false, 18: { current: namespace } })
    const props = { useWorkspaces: (select: any) => select({ items: [] }), useSessions: (select: any) => select({ byId: {} }) }
    client.render(client.MemoryPage, props)
    await client.flush()
    let tree = client.render(client.MemoryPage, props)
    expect(buttons(tree, '第一章旧版本记忆 A›')).toHaveLength(1)
    const oldPoll = client.dashboardLoader(namespace, { background: true })
    expect(pending).toHaveLength(1)
    const forced = client.dashboardLoader(namespace, { background: true, force: true })
    expect(pending).toHaveLength(2)
    expect(pending[0]!.signal.aborted).toBe(true)
    pending[1]!.resolve(dashboardReply(newData, 'etag-B'))
    await forced
    tree = client.render(client.MemoryPage, props)
    expect(buttons(tree, '第一章新版本记忆 B›')).toHaveLength(1)
    pending[0]!.resolve(dashboardReply(oldData, 'etag-A-late'))
    await oldPoll
    tree = client.render(client.MemoryPage, props)
    expect(buttons(tree, '第一章新版本记忆 B›')).toHaveLength(1)
    expect(buttons(tree, '第一章旧版本记忆 A›')).toHaveLength(0)
    await client.dashboardLoader(namespace, { background: true })
    expect(client.fetch.mock.calls[3]![1].headers['If-None-Match']).toBe('etag-B')
  })

  it('groups repeated unnamed kinds into one section and preserves server chapter order', () => {
    const client = clientRenderer()
    const directory = fixture()
    directory.topics[0]!.overview.push({ kind: 'history', text: '另一段发展脉络', sourceEventIds: ['event-26'] })
    directory.topics[0]!.sourceEventIds.push('event-26')
    directory.topics[1]!.id = 'topic-0'
    const tree = client.render(client.TopicDirectory, { directory, namespace: 'dsh:project:test', openEvent: vi.fn() })
    expect(buttons(tree, '1.1发展脉络›')).toHaveLength(1)
    expect(buttons(tree).some((node) => node.text.includes('（二）'))).toBe(false)
    expect(buttons(tree, '1.2关键设计决策›')).toHaveLength(1)
    expect(find(tree, (node) => node.props.className === 'sg-topic-chapter').map((node) => node.props['data-topic-id'])).toEqual(['topic-a', 'topic-0'])
  })

  it('reads pending events only after opening its lightweight entry', async () => {
    const client = clientRenderer(true)
    const props = { directory: fixture(), namespace: 'dsh:project:test', openEvent: vi.fn() }
    let tree = client.render(client.TopicDirectory, props)
    expect(client.fetch).toHaveBeenCalledTimes(0)
    const pending = find(tree, (node) => node.props.className === 'sg-topic-pending-toggle')[0]!
    expect(pending.props['aria-expanded']).toBe(false)
    pending.props.onClick()
    tree = client.render(client.TopicDirectory, props)
    await client.flush()
    tree = client.render(client.TopicDirectory, props)
    expect(client.fetch).toHaveBeenCalledTimes(1)
    expect(new URL(client.fetch.mock.calls[0]![0], 'http://localhost').searchParams.get('topicId')).toBe('pending')
    expect(buttons(tree).filter((node) => node.props['data-topic-event-id'])).toHaveLength(1)
    const trigger = {}
    buttons(tree).find((node) => node.props['data-topic-event-id'] === 'event-22')!.props.onClick({ currentTarget: trigger })
    expect(props.openEvent).toHaveBeenCalledWith(eventFixture()[21], trigger)
  })

  it('clears cached rows immediately when the revision changes, then reads the new safe page', async () => {
    const client = clientRenderer(true)
    const props = { directory: fixture(), namespace: 'dsh:project:test', openEvent: vi.fn() }
    let tree = client.render(client.TopicDirectory, props)
    buttons(tree, '1.1发展脉络›')[0]!.props.onClick()
    client.render(client.TopicDirectory, props)
    await client.flush()
    tree = client.render(client.TopicDirectory, props)
    expect(buttons(tree).some((node) => node.props['data-topic-event-id'] === 'event-1')).toBe(true)
    props.directory = { ...fixture(), revision: 'revision-2' }
    props.directory.topics[0]!.overview[0].sourceEventIds = ['event-25']
    props.directory.topics[0]!.sourceEventIds.push('event-25')
    tree = client.render(client.TopicDirectory, props)
    expect(buttons(tree).filter((node) => node.props['data-topic-event-id'])).toHaveLength(0)
    await client.flush()
    tree = client.render(client.TopicDirectory, props)
    expect(buttons(tree).filter((node) => node.props['data-topic-event-id']).map((node) => node.props['data-topic-event-id'])).toEqual(['event-25'])
    expect(client.fetch).toHaveBeenCalledTimes(2)
  })

  it('aborts a previous workspace read and ignores its response even when the transport resolves it late', async () => {
    const pending: Array<{ url: string; signal: AbortSignal; resolve: (value: any) => void }> = []
    const client = clientRenderer(true, (url: string, options: any) => new Promise((resolve) => pending.push({ url, signal: options.signal, resolve })))
    const props = { directory: fixture(), namespace: 'dsh:project:old', openEvent: vi.fn() }
    let tree = client.render(client.TopicDirectory, props)
    buttons(tree, '1.1发展脉络›')[0]!.props.onClick()
    client.render(client.TopicDirectory, props)
    expect(pending).toHaveLength(1)
    props.namespace = 'dsh:project:new'
    props.directory = { ...fixture(), revision: 'revision-new' }
    props.directory.topics[0]!.overview[0].sourceEventIds = ['event-25']
    props.directory.topics[0]!.sourceEventIds.push('event-25')
    tree = client.render(client.TopicDirectory, props)
    expect(pending[0]!.signal.aborted).toBe(true)
    expect(pending).toHaveLength(2)
    pending[0]!.resolve(pageReply(pending[0]!.url, [eventFixture()[0]], 8, null))
    await client.flush()
    tree = client.render(client.TopicDirectory, props)
    expect(buttons(tree).filter((node) => node.props['data-topic-event-id'])).toHaveLength(0)
    pending[1]!.resolve(pageReply(pending[1]!.url, [eventFixture()[24]], 1, null))
    await client.flush()
    tree = client.render(client.TopicDirectory, props)
    expect(buttons(tree).filter((node) => node.props['data-topic-event-id']).map((node) => node.props['data-topic-event-id'])).toEqual(['event-25'])
  })

  it('retries a failed additional page without repeating the first nine events', async () => {
    let request = 0
    const events = eventFixture().slice(8, 20)
    const client = clientRenderer(true, async (url: string) => {
      request += 1
      if (request === 2) return { ok: false, status: 503, json: async () => ({ error: 'Temporary failure' }) }
      const offset = Number(new URL(url, 'http://localhost').searchParams.get('offset'))
      return pageReply(url, events.slice(offset, offset + 9), 12, offset === 0 ? 9 : null)
    })
    const props = { directory: fixture(), namespace: 'dsh:project:test', openEvent: vi.fn() }
    let tree = client.render(client.TopicDirectory, props)
    buttons(tree, '1.2关键设计决策›')[0]!.props.onClick()
    client.render(client.TopicDirectory, props)
    await client.flush()
    tree = client.render(client.TopicDirectory, props)
    buttons(tree, '还有 3 条事件 · 展开全部')[0]!.props.onClick()
    client.render(client.TopicDirectory, props)
    await client.flush()
    tree = client.render(client.TopicDirectory, props)
    expect(buttons(tree).filter((node) => node.props['data-topic-event-id'])).toHaveLength(9)
    expect(buttons(tree, '重新读取事件')).toHaveLength(1)
    buttons(tree, '重新读取事件')[0]!.props.onClick()
    client.render(client.TopicDirectory, props)
    await client.flush()
    tree = client.render(client.TopicDirectory, props)
    expect(buttons(tree).filter((node) => node.props['data-topic-event-id'])).toHaveLength(12)
    expect(buttons(tree, '重新读取事件')).toHaveLength(0)
    expect(client.fetch.mock.calls.map((call: any[]) => new URL(String(call[0]), 'http://localhost').searchParams.get('offset'))).toEqual(['0', '9', '9'])
  })

  it('aborts loading all on collapse and does not append a late remaining page', async () => {
    let delayed: { url: string; signal: AbortSignal; resolve: (value: any) => void } | undefined
    const events = eventFixture().slice(8, 20)
    const client = clientRenderer(true, (url: string, options: any) => {
      if (new URL(url, 'http://localhost').searchParams.get('offset') === '0') return Promise.resolve(pageReply(url, events.slice(0, 9), 12, 9))
      return new Promise((resolve) => { delayed = { url, signal: options.signal, resolve } })
    })
    const props = { directory: fixture(), namespace: 'dsh:project:test', openEvent: vi.fn() }
    let tree = client.render(client.TopicDirectory, props)
    buttons(tree, '1.2关键设计决策›')[0]!.props.onClick()
    client.render(client.TopicDirectory, props)
    await client.flush()
    tree = client.render(client.TopicDirectory, props)
    buttons(tree, '还有 3 条事件 · 展开全部')[0]!.props.onClick()
    tree = client.render(client.TopicDirectory, props)
    expect(delayed).toBeDefined()
    buttons(tree, '收起多余事件')[0]!.props.onClick()
    client.render(client.TopicDirectory, props)
    expect(delayed!.signal.aborted).toBe(true)
    delayed!.resolve(pageReply(delayed!.url, events.slice(9), 12, null))
    await client.flush()
    tree = client.render(client.TopicDirectory, props)
    expect(buttons(tree).filter((node) => node.props['data-topic-event-id'])).toHaveLength(9)
    expect(buttons(tree, '还有 3 条事件 · 展开全部')).toHaveLength(1)
  })

  it('blocks a stale revision after 409 but permits A again after observing B', async () => {
    let request = 0
    const client = clientRenderer(true, async (url: string) => {
      request += 1
      if (request === 1) return { ok: false, status: 409, json: async () => ({ code: 'directory-changed', error: 'Directory changed' }) }
      return pageReply(url, eventFixture().slice(0, 8), 8, null)
    })
    const onDirectoryChanged = vi.fn()
    const props = { directory: fixture(), namespace: 'dsh:project:test', openEvent: vi.fn(), onDirectoryChanged }
    let tree = client.render(client.TopicDirectory, props)
    buttons(tree, '1.1发展脉络›')[0]!.props.onClick()
    client.render(client.TopicDirectory, props)
    await client.flush()
    tree = client.render(client.TopicDirectory, props)
    expect(onDirectoryChanged).toHaveBeenCalledTimes(1)
    expect(buttons(tree).filter((node) => node.props['data-topic-event-id'])).toHaveLength(0)
    expect(buttons(tree, '重新读取目录')).toHaveLength(1)
    expect(find(tree, (node) => node.props.className === 'sg-topic-context' || node.type === 'pre')).toHaveLength(0)
    expect(request).toBe(1)
    props.directory = { ...fixture(), revision: 'revision-B' }
    client.render(client.TopicDirectory, props)
    await client.flush()
    tree = client.render(client.TopicDirectory, props)
    expect(buttons(tree).filter((node) => node.props['data-topic-event-id'])).toHaveLength(8)
    expect(find(tree, (node) => node.type === 'pre')).toHaveLength(1)
    props.directory = fixture()
    client.render(client.TopicDirectory, props)
    await client.flush()
    tree = client.render(client.TopicDirectory, props)
    expect(buttons(tree).filter((node) => node.props['data-topic-event-id'])).toHaveLength(8)
    expect(request).toBe(3)
  })

  it('discards the old A page error when B arrives inactive, then reads a legal A on returning', async () => {
    let request = 0
    const client = clientRenderer(true, async (url: string) => {
      request += 1
      if (request === 1) return { ok: false, status: 409, json: async () => ({ code: 'directory-changed', error: 'Directory changed' }) }
      return pageReply(url, eventFixture().slice(0, 8), 8, null)
    })
    const props = { directory: fixture(), namespace: 'dsh:project:test', active: true, openEvent: vi.fn(), onDirectoryChanged: vi.fn() }
    let tree = client.render(client.TopicDirectory, props)
    buttons(tree, '1.1发展脉络›')[0]!.props.onClick()
    client.render(client.TopicDirectory, props)
    await client.flush()
    tree = client.render(client.TopicDirectory, props)
    expect(buttons(tree, '重新读取目录')).toHaveLength(1)
    props.active = false
    props.directory = { ...fixture(), revision: 'revision-B' }
    client.render(client.TopicDirectory, props)
    props.directory = fixture()
    client.render(client.TopicDirectory, props)
    expect(request).toBe(1)
    props.active = true
    client.render(client.TopicDirectory, props)
    await client.flush()
    tree = client.render(client.TopicDirectory, props)
    expect(buttons(tree, '重新读取事件')).toHaveLength(0)
    expect(buttons(tree, '重新读取目录')).toHaveLength(0)
    expect(buttons(tree).filter((node) => node.props['data-topic-event-id'])).toHaveLength(8)
    expect(request).toBe(2)
  })

  it('keeps an old conflicted snapshot blocked, then recovers from a fresh snapshot with the same revision', async () => {
    let request = 0
    const client = clientRenderer(true, async (url: string) => {
      request += 1
      if (request === 1) return { ok: false, status: 409, json: async () => ({ code: 'directory-changed', error: 'Directory changed' }) }
      return pageReply(url, eventFixture().slice(0, 8), 8, null)
    })
    const directory = fixture()
    const props = { directory, namespace: 'dsh:project:test', openEvent: vi.fn(), onDirectoryChanged: vi.fn() }
    let tree = client.render(client.TopicDirectory, props)
    buttons(tree, '1.1发展脉络›')[0]!.props.onClick()
    client.render(client.TopicDirectory, props)
    await client.flush()
    tree = client.render(client.TopicDirectory, props)
    expect(buttons(tree, '重新读取目录')).toHaveLength(1)
    expect(find(tree, (node) => node.type === 'pre')).toHaveLength(0)
    client.render(client.TopicDirectory, props)
    await client.flush()
    tree = client.render(client.TopicDirectory, props)
    expect(request).toBe(1)
    expect(buttons(tree, '重新读取目录')).toHaveLength(1)
    props.directory = structuredClone(directory)
    client.render(client.TopicDirectory, props)
    // The new snapshot clears the block; the following render starts a new
    // page request rather than reusing the first A response/error.
    client.render(client.TopicDirectory, props)
    await client.flush()
    tree = client.render(client.TopicDirectory, props)
    expect(buttons(tree, '重新读取目录')).toHaveLength(0)
    expect(buttons(tree, '重新读取事件')).toHaveLength(0)
    expect(buttons(tree).filter((node) => node.props['data-topic-event-id'])).toHaveLength(8)
    expect(find(tree, (node) => node.type === 'pre')).toHaveLength(1)
    expect(request).toBe(2)
  })

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

  it('renders chapters and sections; opening eight-event section reads only that page and shows .0 through .8', async () => {
    const client = clientRenderer(true)
    const props = { directory: fixture(), namespace: 'dsh:project:test', openEvent: vi.fn() }
    let tree = client.render(client.TopicDirectory, props)
    expect(buttons(tree).map(({ text }) => text)).toContain('第一章记忆架构›')
    expect(buttons(tree).map(({ text }) => text)).toContain('第二章求职与实习›')
    expect(find(tree, (node) => node.props.className === 'sg-topic-chapter')).toHaveLength(2)
    expect(buttons(tree, '1.1发展脉络›')).toHaveLength(1)
    expect(buttons(tree, '1.2关键设计决策›')).toHaveLength(1)
    expect(buttons(tree, '2.1主题范围›')).toHaveLength(1)
    expect(buttons(tree).filter((node) => node.props['data-topic-event-id'])).toHaveLength(0)
    expect(client.fetch).toHaveBeenCalledTimes(0)
    buttons(tree, '1.1发展脉络›')[0]!.props.onClick()
    tree = client.render(client.TopicDirectory, props)
    await client.flush()
    tree = client.render(client.TopicDirectory, props)
    const first = find(tree, (node) => node.props['data-topic-id'] === 'topic-a')[0]!
    expect(buttons(first, '1.1.0总览›')[0]!.props['aria-expanded']).toBe(true)
    expect(find(first, (node) => node.visible && node.props.className === 'sg-topic-overview-text')[0]!.text).toBe('八条事件的完整发展脉络')
    const rows = buttons(first).filter((node) => node.props['data-topic-event-id'])
    expect(rows).toHaveLength(8)
    expect(rows[0]!.text).toBe('1.1.1历史事件 1↗')
    expect(rows.at(-1)!.text).toBe('1.1.8历史事件 8↗')
    expect(buttons(first, '还有 3 条事件 · 展开全部')).toHaveLength(0)
    expect(client.fetch).toHaveBeenCalledTimes(1)
    expect(new URL(client.fetch.mock.calls[0]![0], 'http://localhost').searchParams.get('sectionKey')).toBe(memoryTopicSectionKey('发展脉络'))
  })

  it('renders one .0 with two independent paragraphs and pages their unique Event union', async () => {
    const client = clientRenderer(true)
    const directory = fixture()
    const chapter = directory.topics[0]!
    chapter.overview = [
      { kind: 'history', title: '界面与交互', text: '早期界面设计', sourceEventIds: eventFixture().slice(0, 8).map(({ id }) => id) },
      { kind: 'decision', title: '界面与交互', text: '后续界面决定', sourceEventIds: eventFixture().slice(7, 15).map(({ id }) => id) },
    ]
    chapter.sourceEventIds = eventFixture().slice(0, 15).map(({ id }) => id)
    const props = { directory, namespace: 'dsh:project:test', openEvent: vi.fn() }
    let tree = client.render(client.TopicDirectory, props)
    expect(buttons(tree, '1.1界面与交互›')).toHaveLength(1)
    expect(client.fetch).toHaveBeenCalledTimes(0)
    buttons(tree, '1.1界面与交互›')[0]!.props.onClick()
    client.render(client.TopicDirectory, props)
    await client.flush()
    tree = client.render(client.TopicDirectory, props)
    expect(buttons(tree, '1.1.0总览›')).toHaveLength(1)
    expect(find(tree, (node) => node.visible && node.props.className === 'sg-topic-overview-text').map(({ text }) => text)).toEqual(['早期界面设计', '后续界面决定'])
    expect(buttons(tree).filter((node) => node.props['data-topic-event-id'])).toHaveLength(9)
    buttons(tree, '还有 6 条事件 · 展开全部')[0]!.props.onClick()
    client.render(client.TopicDirectory, props)
    await client.flush()
    tree = client.render(client.TopicDirectory, props)
    const rows = buttons(tree).filter((node) => node.props['data-topic-event-id'])
    expect(rows.map((node) => node.props['data-topic-event-id'])).toEqual(chapter.sourceEventIds)
    expect(rows.at(-1)!.text).toBe('1.1.15历史事件 15↗')
    expect(client.fetch.mock.calls.map((call: any[]) => new URL(call[0], 'http://localhost').searchParams.get('offset'))).toEqual(['0', '9'])
  })

  it('limits a large section to .0 + nine events, pages the rest only on request, and reuses its cache and Event callback', async () => {
    const client = clientRenderer(true)
    const openEvent = vi.fn()
    const props = { directory: fixture(), namespace: 'dsh:project:test', openEvent }
    let tree = client.render(client.TopicDirectory, props)
    buttons(tree, '1.2关键设计决策›')[0]!.props.onClick()
    tree = client.render(client.TopicDirectory, props)
    await client.flush()
    tree = client.render(client.TopicDirectory, props)
    let section = find(tree, (node) => node.props['data-section-index'] === '2')[0]!
    expect(buttons(section).filter((node) => node.props['data-topic-event-id'])).toHaveLength(9)
    expect(buttons(section, '1.2.0总览›')[0]!.props['aria-expanded']).toBe(true)
    buttons(section, '还有 3 条事件 · 展开全部')[0]!.props.onClick()
    tree = client.render(client.TopicDirectory, props)
    await client.flush()
    tree = client.render(client.TopicDirectory, props)
    section = find(tree, (node) => node.props['data-section-index'] === '2')[0]!
    expect(buttons(section).filter((node) => node.props['data-topic-event-id'])).toHaveLength(12)
    const last = buttons(section).filter((node) => node.props['data-topic-event-id']).at(-1)!
    expect(last.text).toBe('1.2.12历史事件 20↗')
    const trigger = { getAttribute: () => 'event-20' }
    last.props.onClick({ currentTarget: trigger })
    expect(openEvent).toHaveBeenCalledWith(eventFixture()[19]!, trigger)
    buttons(section, '收起多余事件')[0]!.props.onClick()
    tree = client.render(client.TopicDirectory, props)
    section = find(tree, (node) => node.props['data-section-index'] === '2')[0]!
    expect(buttons(section).filter((node) => node.props['data-topic-event-id'])).toHaveLength(9)
    expect(client.fetch).toHaveBeenCalledTimes(2)
    expect(client.fetch.mock.calls.map((call: any[]) => new URL(String(call[0]), 'http://localhost').searchParams.get('offset'))).toEqual(['0', '9'])
    buttons(section, '还有 3 条事件 · 展开全部')[0]!.props.onClick()
    tree = client.render(client.TopicDirectory, props)
    await client.flush()
    expect(client.fetch).toHaveBeenCalledTimes(2)
    expect(buttons(tree).filter((node) => node.props['data-topic-event-id'])).toHaveLength(12)
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
    const oldParts = client.topicSections({ sections: memoryTopicSectionNavigation(props.directory.topics[0]! as any) })
    const newParts = client.topicSections({ sections: memoryTopicSectionNavigation(updated.directory.topics[0]! as any) })
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

  it.each(['running', 'failed'])('shows outstanding chapter relations and retry warnings for %s', (status) => {
    const client = clientRenderer(), directory = fixture();
    directory.bootstrap = { ...directory.bootstrap, status, total: 1, completed: 0, failedEvents: 1,
      sectionBackfill: { pendingRelations: status === 'running' ? 2 : 1, failedRelations: 1 },
      failures: [{ jobId: 'failed-a', eventCount: 1, attempts: 3 }],
    } as any;
    const tree = client.render(client.TopicDirectory, { directory, openEvent: vi.fn() });
    expect(tree.text).toContain('仍有 ' + (status === 'running' ? 2 : 1) + ' 项小节归属待补齐，其中 1 项需要重新整理');
    expect(tree.text).toContain('1 条历史记忆暂未完成整理');
    expect(tree.text).not.toContain('整理完成');
    expect(buttons(tree, '重新整理这 1 条')).toHaveLength(1);
  });

  it.each(['pending', 'running', 'failed', 'completed'])('shows truthful 74/86 recovery progress for %s', (status) => {
    const client = clientRenderer(), directory = fixture();
    const failed = status === 'failed';
    directory.bootstrap = { status, total: 86, completed: status === 'completed' ? 86 : 74, failedEvents: failed ? 12 : 0,
      failures: failed ? [{ jobId: 'failed-recovery', eventCount: 12, attempts: 3, lastError: 'validation-failed: overview.text is empty' }] : [] } as any;
    const tree = client.render(client.TopicDirectory, { directory, openEvent: vi.fn() });
    if (failed) {
      expect(tree.text).toContain('历史记忆部分完成 · 74 / 86');
      expect(tree.text).toContain('12 条历史记忆暂未完成整理');
      expect(buttons(tree, '重新整理这 12 条')).toHaveLength(1);
    } else if (status === 'completed') {
      expect(find(tree, (node) => String(node.props.className || '').startsWith('sg-topic-bootstrap '))).toHaveLength(0);
    } else expect(tree.text).toContain('正在整理历史记忆 · 74 / 86');
  });

  it('removes completed successful/empty bootstrap notices and loads failure titles only on inspection', async () => {
    const client = clientRenderer(true)
    const props = { directory: fixture(), namespace: 'dsh:project:test', openEvent: vi.fn() }
    expect(find(client.render(client.TopicDirectory, props), (node) => String(node.props.className || '').startsWith('sg-topic-bootstrap '))).toHaveLength(0)
    props.directory.bootstrap = { ...props.directory.bootstrap, total: 0, completed: 0, status: 'pending' }
    expect(find(client.render(client.TopicDirectory, props), (node) => String(node.props.className || '').startsWith('sg-topic-bootstrap '))).toHaveLength(0)
    props.directory.bootstrap = { status: 'completed', total: 61, completed: 58, failedEvents: 3, failures: [{ jobId: 'failed-1', eventIds: ['event-22'], attempts: 3, lastError: 'validation-failed: every supplied batch Event must be assigned to a topic', diagnostics: { category: 'validation-failed', reason: 'every supplied batch Event must be assigned to a topic', eventCount: 3, requestedOutputTokens: 32768, maxOutputTokens: 32768, attempt: 3 } }] } as any
    let tree = client.render(client.TopicDirectory, props)
    expect(tree.text).toContain('3 条历史记忆暂未完成整理')
    buttons(tree, '查看详情')[0]!.props.onClick()
    tree = client.render(client.TopicDirectory, props)
    await client.flush()
    tree = client.render(client.TopicDirectory, props)
    expect(find(tree, (node) => node.visible && node.props.className === 'sg-topic-failure')).toHaveLength(1)
    expect(buttons(tree, '收起详情')).toHaveLength(1)
    const diagnostics = find(tree, (node) => node.type === 'pre').map((node) => node.text).join('')
    expect(diagnostics).toContain('maxOutputTokens')
    expect(diagnostics).toContain('32768')
    expect(diagnostics).not.toContain('Raw response')
    const failureEvent = buttons(tree).find((node) => node.props['data-topic-event-id'] === 'event-22')!
    failureEvent.props.onClick({ currentTarget: {} })
    expect(props.openEvent).toHaveBeenCalledWith(eventFixture()[21]!, {})
    expect(client.fetch).toHaveBeenCalledTimes(1)
    expect(new URL(client.fetch.mock.calls[0]![0], 'http://localhost').searchParams.get('sectionKey')).toBe('failure:failed-1')
  })

  it('keeps zero/one/nine event overviews complete without inventing rows or show-all actions', async () => {
    for (const count of [0, 1, 9]) {
      const client = clientRenderer(true)
      const directory = fixture()
      directory.topics = [directory.topics[0]!]
      directory.topics[0]!.overview = [{ kind: 'scope', text: '总览', sourceEventIds: eventFixture().slice(0, count).map(({ id }) => id) }]
      directory.topics[0]!.sourceEventIds = directory.topics[0]!.overview[0]!.sourceEventIds
      const props = { directory, namespace: 'dsh:project:test', openEvent: vi.fn() }
      let tree = client.render(client.TopicDirectory, props)
      buttons(tree, '1.1主题范围›')[0]!.props.onClick()
      tree = client.render(client.TopicDirectory, props)
      await client.flush()
      tree = client.render(client.TopicDirectory, props)
      expect(buttons(tree).filter((node) => node.props['data-topic-event-id'])).toHaveLength(count)
      expect(buttons(tree, '1.1.0总览›')).toHaveLength(1)
      expect(buttons(tree).filter((node) => node.props.className === 'sg-topic-show-all')).toHaveLength(0)
      expect(client.fetch).toHaveBeenCalledTimes(count ? 1 : 0)
    }
  })
})
