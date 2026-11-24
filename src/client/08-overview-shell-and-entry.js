    function overviewAbsolute(value) {
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return '时间未知'
      return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(date)
    }

    function overviewRelative(value) {
      const time = Date.parse(value || '')
      if (!Number.isFinite(time)) return '还没有更新'
      const seconds = Math.round((Date.now() - time) / 1000)
      if (seconds < 60) return '刚刚'
      if (seconds < 3600) return Math.floor(seconds / 60) + ' 分钟前'
      if (seconds < 86400) return Math.floor(seconds / 3600) + ' 小时前'
      const days = Math.floor(seconds / 86400)
      if (days === 1) return '昨天'
      if (days < 30) return days + ' 天前'
      return overviewAbsolute(value)
    }

    function overviewCount(value) {
      return Number(value || 0).toLocaleString('en-US')
    }

    function OverviewSpeechMark() {
      return h('svg', { className: 'sg-ov-speech', viewBox: '0 0 54 48', fill: 'none', stroke: 'currentColor', strokeWidth: 3, 'aria-hidden': 'true', focusable: 'false' },
        h('path', { d: 'M7 3h40a4 4 0 0 1 4 4v24a4 4 0 0 1-4 4H23L10 45V35H7a4 4 0 0 1-4-4V7a4 4 0 0 1 4-4Z' }),
        h('path', { d: 'M14 15h27M14 23h18' }))
    }

    function overviewRuntimeState(selected, loading, error) {
      if (error) return { state: 'warning', text: '暂时无法读取最新状态' }
      if (loading) return { state: 'loading', text: '正在读取状态' }
      if (!selected?.memoryOverview || !Number.isSafeInteger(selected.failedJobs) || selected.failedJobs < 0
        || !Number.isSafeInteger(selected.processingJobs) || selected.processingJobs < 0) {
        return { state: 'unknown', text: '状态暂不可用' }
      }
      if (selected.failedJobs > 0) return { state: 'failed', text: selected.failedJobs + ' 个任务需要处理' }
      const layers = selected.memoryOverview.layers
      if (selected.topicDirectoryReadError || !layers?.profile || !layers.directory || !layers.session || !layers.shortTerm || !layers.longTerm) {
        return { state: 'warning', text: '部分记忆暂时无法读取' }
      }
      if (selected.processingJobs > 0) return { state: 'processing', text: '正在整理记忆' }
      return { state: 'ok', text: '运行正常' }
    }

    function OverviewPage({ selected, loading, onOpenSection, dreaming }) {
      const stats = selected?.memoryOverview
      if (loading && !stats) return h(Loading)
      if (!stats) return h(Empty, { title: '还没有可汇总的记忆', copy: '这个工作区的记忆读出来之后，会显示在这里。' })
      // Visible units identify the quantity; update times remain in the tooltip.
      const layers = [
        { key: 'profile', name: '常驻画像', tone: 'ink', section: 'profile', value: stats.layers.profile ? overviewCount(stats.layers.profile.characters) : '—', unit: '字', updatedAt: stats.layers.profile?.updatedAt },
        { key: 'directory', name: '记忆目录', tone: 'moss', section: 'long', value: stats.layers.directory ? overviewCount(stats.layers.directory.chapters) : '—', unit: '章', updatedAt: stats.layers.directory?.updatedAt },
        { key: 'session', name: '会话记忆', tone: 'water', section: 'short', value: overviewCount(stats.layers.session.blocks), unit: '块', updatedAt: stats.layers.session.updatedAt },
        { key: 'short', name: '短期记忆', tone: 'sand', section: 'daily', value: stats.layers.shortTerm ? overviewCount(stats.layers.shortTerm.items) : '—', unit: '条', updatedAt: stats.layers.shortTerm?.updatedAt },
        { key: 'long', name: '长期记忆', tone: 'lib', section: 'long', value: overviewCount(stats.layers.longTerm.events), unit: '个事件', updatedAt: stats.layers.longTerm.updatedAt, answers: stats.layers.longTerm.answers },
      ]
      const heatmap = Array.isArray(stats.heatmap) ? stats.heatmap : []
      const peak = Math.max(1, ...heatmap.map((day) => Number(day.answers) || 0))
      return h('section', { className: 'sg-ov', 'data-testid': 'stratagate-overview', 'aria-label': '记忆总览' },
        h('div', { className: 'sg-ov-top' },
          h('div', { className: 'sg-ov-stat' },
            h('div', { className: 'sg-ov-big' },
              h('b', { className: 'sg-mono', 'data-testid': 'overview-answer-count' }, overviewCount(stats.answeredLast7Days)),
              h(OverviewSpeechMark)),
            h('p', { className: 'sg-ov-summary', 'data-testid': 'overview-answer-summary' }, '最近 7 天，长期记忆帮到 ' + overviewCount(stats.answeredLast7Days) + ' 次回答'),
            dreaming),
          h('div', { className: 'sg-pillar-group' },
          h('div', { className: 'sg-pillar-cap', 'aria-hidden': 'true' }, h(OverviewSpeechMark)),
          h('div', { className: 'sg-pillar', 'aria-label': '记忆分层' }, layers.map((layer) => {
            const when = '最近更新：' + overviewRelative(layer.updatedAt)
            const countText = layer.value === '—' ? '暂无数据' : layer.value + ' ' + layer.unit
            const summary = layer.name + ' ' + countText + '，' + when
            const open = () => { if (typeof onOpenSection === 'function') onOpenSection(layer.section) }
            return h(React.Fragment, { key: layer.key },
              layer.key === 'long' ? h('div', { className: 'sg-pillar-gap', 'aria-hidden': 'true' }) : null,
              h('button', {
                type: 'button', className: 'sg-pillar-row', 'data-testid': 'overview-layer-' + layer.key,
                'aria-label': '打开' + layer.name + '：' + countText + '，' + when, title: summary,
                // A native button already maps Enter/Space to click; a custom
                // key handler would fire the navigation twice.
                onClick: open,
              },
                h('span', { className: 'sg-pillar-bar ' + layer.tone, 'aria-hidden': 'true' }),
                h('span', { className: 'sg-pillar-name' }, h('b', null, layer.name)),
                h('span', { className: 'sg-pillar-tail' },
                  h('span', { className: 'sg-pillar-use' }, layer.key === 'long' && layer.answers > 0 ? h(UsedMark, { count: layer.answers, title: '被回答用到 ' + layer.answers + ' 次' }) : null),
                  h('span', { className: 'sg-pillar-val' }, h('b', { className: 'sg-mono' }, layer.value), layer.value !== '—' ? h('span', { className: 'sg-pillar-unit' }, layer.unit) : null)))
            )
          })),
          h('div', { className: 'sg-pillar-key' },
            h('span', null, h('i', { className: 'sg-sw', 'aria-hidden': 'true' }), '一直带着'),
            h('span', null, h('i', { className: 'sg-sw lib', 'aria-hidden': 'true' }), '需要时去找'),
            h('span', null, h(UsedMark), '被用到')))),
        h('div', { className: 'sg-heat' },
          h('div', { className: 'sg-heat-head' },
            h('span', null, h(UsedMark), '每天被回答用到几次'),
            h('span', null, '颜色越深越多')),
          h('div', { className: 'sg-heat-grid', 'aria-label': '最近 ' + heatmap.length + ' 天长期记忆采用' }, heatmap.map((day) => {
            const answers = Number(day.answers) || 0
            const ink = answers ? Math.min(28 + Math.round(answers / peak * 62), 90) : 0
            return h('i', { key: day.day, title: day.day + ' · ' + answers + ' 次回答', style: answers ? { background: 'color-mix(in srgb, var(--sg-ink) ' + ink + '%, var(--sg-sheet))', boxShadow: 'none' } : undefined })
          })),
          h('div', { className: 'sg-heat-scale' }, h('span', null, heatmap.length > 14 ? '4 周前' : '2 周前'), h('span', null, '今天'))))
    }

    function MemoryPage({ useWorkspaces, useSessions, navigationState, usePluginSettings, setMemoryModel, setEffort, resetEffort, setStrataGateStatus, setShortTermStatus, setRetrievalStatus, setSidebarEntry, onOpenDreamingSession, onChooseSidebar, setDailyEnabled, setDailyTimeZone, setDailyInjectionDays }) {
      const TAB_SWATCH = { profile: 'ink', short: 'water', daily: 'sand', long: 'lib' }
      const workspaceItems = useWorkspaces((state) => state.items)
      const sessionById = useSessions((state) => state.byId || {})
      const [overview, setOverview] = React.useState({ namespaces: [] })
      const [namespace, setNamespace] = React.useState('')
      const [workspaceTitles, setWorkspaceTitles] = React.useState({})
      const [workspaceSessionIds, setWorkspaceSessionIds] = React.useState({})
      const [conversationId, setConversationId] = React.useState('')
      const [section, setSection] = React.useState('overview')
      const [view, setView] = React.useState({ name: 'root' })
      const [graphFocusNodeId, setGraphFocusNodeId] = React.useState('')
      const consumeGraphFocus = React.useCallback(() => setGraphFocusNodeId(''), [])
      const [data, setData] = React.useState({ events: [], graph: { nodes: [], edges: [], migration: null }, blocks: [], openBlock: null, conversations: [], activeThreadId: null, audit: [], pagination: { events: { total: 0, offset: 0, limit: 40 }, blocks: { total: 0, offset: 0, limit: 40 }, audit: { total: 0, offset: 0, limit: 100 } } })
      const [query, setQuery] = React.useState('')
      const [source, setSource] = React.useState(null)
      const [loading, setLoading] = React.useState(true)
      const [error, setError] = React.useState('')
      const [recentError, setRecentError] = React.useState('')
      const [savingSettings, setSavingSettings] = React.useState(false)
      const [pollFast, setPollFast] = React.useState(false)
      const dashboardRequestRef = React.useRef(null)
      const sourceRequestRef = React.useRef(null)
      const namespaceRef = React.useRef(namespace)
      namespaceRef.current = namespace
      const dashboardEtagsRef = React.useRef(new Map())
      const loadedNamespaceRef = React.useRef('')
      const feedbackDeepLinkRef = React.useRef(readFeedbackNavigationState(navigationState) || readFeedbackDeepLink())
      const graphNodeNavigationRef = React.useRef(readGraphNodeNavigationState(navigationState) || readGraphNodeDeepLink())
      const feedbackNavigationStateRef = React.useRef(navigationState)
      const namespaceNavigationRef = React.useRef(null)
      const directoryScrollRef = React.useRef(null)
      const reportError = (reason) => {
        const message = String(reason?.message || reason)
        setError(message)
        setRecentError(message)
        if (namespace) {
          const category = /timeout|timed out|超时/i.test(message) ? 'timeout' : /fetch|network|网络/i.test(message) ? 'network' : 'request-failed'
          void api('diagnostics', { namespace, category }, { method: 'POST' }).catch(() => {})
        }
      }

      React.useEffect(() => {
        let active = true
        void Promise.all((workspaceItems || []).map(async (workspace) => ({
          key: await workspaceProjectKey(workspace.path),
          title: String(workspace.title || '').trim(),
          sessionIds: Array.isArray(workspace.sessionIds) ? workspace.sessionIds.map(String) : [],
        }))).then((entries) => {
          if (!active) return
          setWorkspaceTitles(Object.fromEntries(entries.filter(({ key, title }) => key && title).map(({ key, title }) => [key, title])))
          setWorkspaceSessionIds(Object.fromEntries(entries.filter(({ key }) => key).map(({ key, sessionIds }) => [key, sessionIds])))
        })
        return () => { active = false }
      }, [workspaceItems])

      const loadDashboard = React.useCallback((activeNamespace, options = {}) => {
        const background = options.background === true
        if (background && !options.force && dashboardRequestRef.current) return Promise.resolve(null)
        dashboardRequestRef.current?.abort()
        const controller = new AbortController()
        dashboardRequestRef.current = controller
        const key = String(activeNamespace || '') + '\u0000' + String(options.threadId || '')
        if (!background) setLoading(true)
        if (!background) setError('')
        return dashboardApi({
          ...(activeNamespace ? { namespace: activeNamespace } : {}),
          ...(options.threadId ? { threadId: options.threadId } : {}),
        }, { etag: options.force ? '' : dashboardEtagsRef.current.get(key), signal: controller.signal }).then((result) => {
          if (controller.signal.aborted || dashboardRequestRef.current !== controller) return null
          if (result.etag) dashboardEtagsRef.current.set(key, result.etag)
          if (result.notModified || !result.data) return null
          const next = result.data
          setOverview(next.overview || { namespaces: [] })
          setPollFast(next.processing === true)
          if (next.namespace) {
            loadedNamespaceRef.current = next.namespace
            setNamespace((current) => next.overview?.namespaces?.some((item) => item.namespace === current) ? current : next.namespace)
          }
          if (next.data) {
            setData(next.data)
            setConversationId(next.data.activeThreadId || '')
          }
          setError('')
          return next
        }).catch((reason) => {
          if (controller.signal.aborted || dashboardRequestRef.current !== controller) return null
          if (reason?.name !== 'AbortError') reportError(reason)
          if (options.propagateError === true && reason?.name !== 'AbortError') throw reason
          return null
        }).finally(() => {
          if (dashboardRequestRef.current !== controller) return
          dashboardRequestRef.current = null
          setLoading(false)
        })
      }, [])

      React.useEffect(() => {
        const graphLink = graphNodeNavigationRef.current
        const feedbackLink = feedbackDeepLinkRef.current
        if (graphLink) {
          setSection('long')
          setQuery('')
          setView({ name: 'root' })
          setSource(null)
          setGraphFocusNodeId(graphLink.nodeId)
          if (readGraphNodeDeepLink()) consumeGraphNodeDeepLink()
        } else if (feedbackLink) {
          setSection('more')
          setView({ name: 'support' })
          setSource(null)
          if (readFeedbackDeepLink()) consumeFeedbackDeepLink()
        }
        void loadDashboard(graphLink?.namespace || feedbackLink?.namespace || '')
        return () => { dashboardRequestRef.current?.abort(); sourceRequestRef.current?.abort() }
      }, [loadDashboard])
      React.useEffect(() => {
        const graphLink = navigationState !== feedbackNavigationStateRef.current ? readGraphNodeNavigationState(navigationState) : null
        const feedback = readNewFeedbackNavigationState(feedbackNavigationStateRef.current, navigationState)
        feedbackNavigationStateRef.current = navigationState
        if (graphLink) {
          setSection('long')
          setView({ name: 'root' })
          setSource(null)
          setGraphFocusNodeId(graphLink.nodeId)
          namespaceNavigationRef.current = namespace !== graphLink.namespace ? { namespace: graphLink.namespace } : null
          setNamespace(graphLink.namespace)
          if (namespace === graphLink.namespace) void loadDashboard(graphLink.namespace, { force: true })
          return
        }
        if (!feedback) return
        setSection('more')
        setView({ name: 'support' })
        setSource(null)
        namespaceNavigationRef.current = namespace !== feedback.namespace ? { namespace: feedback.namespace } : null
        setNamespace(feedback.namespace)
        if (namespace === feedback.namespace) void loadDashboard(feedback.namespace, { force: true })
      }, [navigationState, loadDashboard])
      React.useEffect(() => {
        if (!namespace) return
        const navigated = namespaceNavigationRef.current?.namespace === namespace
        namespaceNavigationRef.current = null
        if (loadedNamespaceRef.current === namespace) return
        directoryScrollRef.current = null
        setConversationId(''); if (!navigated) setView({ name: 'root' }); setSource(null); setRecentError(''); setData({ events: [], graph: { nodes: [], edges: [], migration: null }, blocks: [], openBlock: null, conversations: [], activeThreadId: null, audit: [], pagination: { events: { total: 0, offset: 0, limit: 40 }, blocks: { total: 0, offset: 0, limit: 40 }, audit: { total: 0, offset: 0, limit: 100 } } }); void loadDashboard(namespace, { force: true })
      }, [namespace, loadDashboard])
      React.useEffect(() => {
        if (!namespace) return undefined
        let stopped = false
        let timer = null
        const schedule = (delay) => {
          if (stopped || document.hidden) return
          timer = window.setTimeout(run, delay)
        }
        const run = () => {
          if (stopped || document.hidden) return
          void loadDashboard(namespace, { background: true, threadId: conversationId }).finally(() => {
            schedule(pollFast ? 2500 : 30000)
          })
        }
        const onVisibilityChange = () => {
          if (document.hidden) {
            if (timer !== null) window.clearTimeout(timer)
            timer = null
            dashboardRequestRef.current?.abort()
          } else {
            run()
          }
        }
        document.addEventListener('visibilitychange', onVisibilityChange)
        schedule(pollFast ? 2500 : 30000)
        return () => {
          stopped = true
          if (timer !== null) window.clearTimeout(timer)
          document.removeEventListener('visibilitychange', onVisibilityChange)
        }
      }, [namespace, conversationId, pollFast, loadDashboard])

      const selected = (overview.namespaces || []).find((item) => item.namespace === namespace)
      const runtimeState = overviewRuntimeState(selected, loading, error)
      const project = projectName(selected || namespace, workspaceTitles)
      const activeProjectKey = namespace.includes(':project:') ? namespace.split(':project:').pop() : ''
      const hostSessionIds = workspaceSessionIds[activeProjectKey] || []
      const memoryConversations = new Map(data.conversations.map((conversation) => [conversation.id, conversation]))
      const conversations = []
      const seenConversations = new Set()
      for (const id of hostSessionIds) {
        const session = sessionById[id]
        if (session?.parentId) continue
        const memory = memoryConversations.get(id)
        const dshTitle = String(session?.title || '').trim()
        conversations.push({ ...(memory || {}), id, label: dshTitle || memory?.label || ('对话 ' + id.slice(0, 8)) })
        seenConversations.add(id)
      }
      for (const memory of data.conversations) {
        if (seenConversations.has(memory.id)) continue
        conversations.push(memory)
      }
      conversations.sort((left, right) => left.id === '__legacy__' ? 1 : right.id === '__legacy__' ? -1 : 0)
      const clearSource = () => { sourceRequestRef.current?.abort(); sourceRequestRef.current = null; setSource(null) }
      const goSection = (next) => { directoryScrollRef.current = null; setSection(next); setView({ name: 'root' }); clearSource() }
      const sourceParams = (kind, item) => kind === 'event' ? { eventId: item.id } : kind === 'element' ? { elementId: item.id } : { blockId: item.id }
      const loadSource = (kind, item) => {
        clearSource()
        const controller = new AbortController()
        sourceRequestRef.current = controller
        const requestedNamespace = namespace
        const requestedId = String(item?.id || '')
        void api('sources', { namespace, ...sourceParams(kind, item) }, { signal: controller.signal }).then((value) => {
          if (sourceRequestRef.current !== controller || controller.signal.aborted || namespaceRef.current !== requestedNamespace) return
          const returnedId = value?.event?.id || value?.element?.id || value?.block?.id || value?.id
          const returnedIds = Array.isArray(value?.events) ? value.events.map((entry) => String(entry?.id || '')) : []
          if ((returnedId && String(returnedId) !== requestedId) || (returnedIds.length && !returnedIds.includes(requestedId))) return
          setSource(value)
        }).catch((reason) => {
          if (reason?.name !== 'AbortError' && sourceRequestRef.current === controller) reportError(reason)
        })
      }
      const openWithSource = (kind, item) => {
        setView((current) => ({ name: kind, item, back: current })); loadSource(kind, item)
      }
      const openEvent = (event, trigger) => {
        if (trigger?.getAttribute?.('data-topic-event-id')) {
          const ancestors = []
          for (let node = trigger.parentElement; node; node = node.parentElement) {
            if (node.scrollHeight > node.clientHeight) ancestors.push({ node, top: node.scrollTop, left: node.scrollLeft })
          }
          directoryScrollRef.current = { namespace, eventId: event.id, trigger, ancestors, top: window.scrollY || 0, left: window.scrollX || 0 }
        }
        openWithSource('event', data.events.find((item) => item.id === event.id) || event)
      }
      ;(React.useLayoutEffect || React.useEffect)(() => {
        const saved = directoryScrollRef.current
        const action = directoryScrollAction(saved, section, namespace, view.name)
        if (action === 'none') return
        if (action === 'clear') { directoryScrollRef.current = null; return }
        if (action === 'detail') {
          for (const { node } of saved.ancestors) { node.scrollTop = 0; node.scrollLeft = 0 }
          window.scrollTo?.(0, 0)
        } else if (action === 'restore') {
          const trigger = saved.trigger?.isConnected && saved.trigger.getClientRects().length ? saved.trigger : Array.from(document.querySelectorAll('.sg-topic-event[data-topic-event-id]')).find((node) => node.getAttribute('data-topic-event-id') === saved.eventId && node.getClientRects().length)
          trigger?.focus?.({ preventScroll: true })
          for (const { node, top, left } of saved.ancestors) { node.scrollTop = top; node.scrollLeft = left }
          window.scrollTo?.(saved.left, saved.top)
          directoryScrollRef.current = null
        }
      }, [view.name, section, namespace])
      const openGraphNode = (nodeId) => {
        directoryScrollRef.current = null
        setSection('long')
        setQuery('')
        setView({ name: 'root' })
        clearSource()
        setGraphFocusNodeId(nodeId)
      }
      const goBack = () => {
        const previous = view.back || { name: 'root' }
        setView(previous)
        if (previous.item && ['event', 'block'].includes(previous.name)) loadSource(previous.name, previous.item)
        else clearSource()
      }
      const backLabel = view.back?.name === 'duplicates' ? '重复记忆整理' : view.back?.name === 'block' ? '会话记忆' : view.back?.name === 'event' ? '长期记忆' : view.back?.name === 'structure' ? '记忆结构' : section === 'short' ? '会话记忆' : '长期记忆'
      const refresh = (options = {}) => loadDashboard(namespace, { threadId: conversationId, force: true, ...options })
      const refreshDirectory = React.useCallback(() => loadDashboard(namespace, { threadId: conversationId, background: true, force: true }), [namespace, conversationId, loadDashboard])
      const selectConversation = (nextConversationId) => {
        setConversationId(nextConversationId)
        return loadDashboard(namespace, { threadId: nextConversationId, force: true })
      }
      const updateSettings = (values) => {
        setSavingSettings(true)
        setError('')
        return api('settings', values, { method: 'PATCH' })
          .then(() => loadDashboard(namespace, { threadId: conversationId, force: true }))
          .catch(reportError)
          .finally(() => setSavingSettings(false))
      }
      const onRetrievalSettingsSaved = vectorSettings => setOverview(current => ({ ...current, vectorSettings }))
      const moreBack = () => setView({ name: 'root' })

      let content = null
      if ((section === 'long' || view.name === 'support') && loadedNamespaceRef.current !== namespace) content = h(Loading)
      else if (loading && !selected) content = h(Loading)
      else if (view.name === 'settings') content = h(SettingsPage, { selected: selected || { blockTurnSize: 6, blockDecayLambda: 0.3, eventDecayLambda: 0.015, agentMemoryRetrievalWeight: 1, currentTurn: 0, schemaVersion: 12 }, graphSettings: overview.graphSettings, vectorSettings: overview.vectorSettings, retrievalSettingsWritable: overview.settingsWritable, onRetrievalSettingsSaved, refresh, namespace, dataDirectory: overview.dataDirectory, onBack: moreBack, setView, updateSettings, savingSettings, usePluginSettings, setMemoryModel, setEffort, resetEffort, setDailyEnabled, setDailyTimeZone, setDailyInjectionDays, onDirectoryChanged: refreshDirectory, onOpenDreamingSession })
      else if (section === 'overview' && view.name === 'root') content = h(OverviewPage, { key: namespace, selected, loading, onOpenSection: goSection,
        dreaming: namespace ? h(DreamingPanel, { key: namespace, namespace, active: true, available: true, onDirectoryChanged: refreshDirectory, onOpenDreamingSession }) : null })
      else if (section === 'profile' && view.name === 'root') content = h(ProfilePage)
      else if (section === 'daily' && view.name === 'root') content = h(DailyNotesPage, { key: namespace, namespace, usePluginSettings, setDailyInjectionDays })
      else if (!selected && section !== 'more') content = h(Empty, { title: '还没有记忆', copy: '完成一些 DSH 对话后，会话记忆和长期记忆会出现在这里。' })
      else if (view.name === 'event') content = h(EventDetail, { event: view.item, project, source, onBack: goBack, backLabel, onNode: openGraphNode })
      else if (view.name === 'status') content = h(ProcessingStatus, { key: namespace, overview: selected, blocks: data.blocks, conversations, namespace, serverVersion: overview.pluginVersion, onBack: view.back ? goBack : () => setView({ name: 'root' }), backLabel: view.back?.name === 'settings' ? '高级设置' : '返回', refresh })
      else if (view.name === 'import') content = h(ImportPage, { key: namespace, namespace, onBack: moreBack, refresh })
      else if (view.name === 'structure') content = h(StructurePage, { events: data.events, eventPage: data.pagination?.events, graph: data.graph, openEvent, namespace, onBack: moreBack })
      else if (view.name === 'duplicates') content = h(DuplicateReviewPage, { namespace, repair: selected?.duplicateRepair, onBack: moreBack, openEvent, refresh })
      else if (view.name === 'system') content = h(SystemPage, { selected, blocks: data.blocks, onBack: view.back ? goBack : moreBack, backLabel: view.back?.name === 'settings' ? '高级设置' : '更多', refresh, onDuplicates: () => setView({ name: 'duplicates' }) })
      else if (view.name === 'audit') content = h(AuditPage, { audit: data.audit, auditPage: data.pagination?.audit, namespace, onBack: view.back ? goBack : moreBack, backLabel: view.back?.name === 'settings' ? '高级设置' : '更多' })
      else if (view.name === 'raw') content = h(RawPage, { data, selected, onBack: view.back ? goBack : moreBack, backLabel: view.back?.name === 'settings' ? '高级设置' : '更多' })
      else if (view.name === 'display') content = h(DisplayPage, { onBack: moreBack, usePluginSettings, setStrataGateStatus, setShortTermStatus, setRetrievalStatus, setSidebarEntry })
      else if (view.name === 'support') content = h(SupportPage, { key: namespace, namespace, overview, selected, data, recentError, onBack: moreBack })
      else content = h(React.Fragment, null,
        loading ? h(Loading) : section === 'short' ? h(ShortTermPage, { key: namespace + ':' + conversationId, blockTurnSize: selected?.blockTurnSize || 6, blocks: data.blocks, blockPage: data.pagination?.blocks, openBlock: data.openBlock, conversations, activeThreadId: conversationId || data.activeThreadId || '', namespace, onConversationChange: selectConversation, refresh })
          : section === 'long' ? null
            : h(MoreHome, { setView, selected, overview, namespace, dataDirectory: overview.dataDirectory, updateSettings, savingSettings, usePluginSettings, setStrataGateStatus, setShortTermStatus, setRetrievalStatus, setSidebarEntry, setDailyEnabled, setDailyInjectionDays }))

      return h('main', { className: 'sg-memory sg-unified-top' + (section === 'overview' && view.name === 'root' ? ' sg-overview-page' : '') + (view.name === 'duplicates' ? ' sg-memory-review' : '') + (view.name === 'settings' || view.name === 'display' || (section === 'more' && view.name === 'root') ? ' sg-settings-page' : ''), 'data-testid': 'stratagate-memory-ui' },
        h('style', null, css + DUPLICATE_STYLES + DAILY_NOTES_CSS + R6_STYLES),
        h('header', { className: 'sg-header' },
          h('div', { className: 'sg-header-row sg-header-row-primary' },
            h(GITHUB_FEEDBACK_ENABLED ? 'a' : 'div', { className: 'sg-brand', href: GITHUB_FEEDBACK_ENABLED ? STAR_REPOSITORY_URL : undefined, target: GITHUB_FEEDBACK_ENABLED ? '_blank' : undefined, rel: GITHUB_FEEDBACK_ENABLED ? 'noopener noreferrer' : undefined },
              h(StrataGateMark),
              h('span', { className: 'sg-brand-copy' }, h('span', { className: 'sg-brand-title' }, h('span', { className: 'sg-brand-name' }, 'StrataGate'), overview.pluginVersion && overview.pluginVersion !== 'unknown' ? h('span', { className: 'sg-brand-version' }, 'v' + overview.pluginVersion) : null), onChooseSidebar ? h(SidebarPlacementPrompt, { onChooseSidebar, usePluginSettings }) : null)),
            // Workspace switcher sits right beside Star, not on its own row.
            h('div', { className: 'sg-header-end' },
              h('div', { className: 'sg-project' }, h('i', { className: 'sg-runtime-dot', 'data-testid': 'overview-workspace-dot', 'data-state': runtimeState.state, role: 'img', 'aria-label': runtimeState.text, title: runtimeState.text }), h('span', { className: 'sg-project-label' }, '当前工作区'), h('select', { className: 'sg-project-select', value: namespace, onChange: (event) => setNamespace(event.target.value), 'aria-label': '当前工作区' }, (overview.namespaces || []).map((item) => h('option', { key: item.namespace, value: item.namespace }, projectName(item, workspaceTitles))))),
              GITHUB_FEEDBACK_ENABLED ? h(HeaderStarLink) : null)),
        h('nav', { className: 'sg-tabs', 'aria-label': '记忆视图' }, [['overview', '总览'], ['profile', '常驻画像'], ['short', '会话记忆'], ['daily', '短期记忆'], ['long', '长期记忆'], ['more', '更多']].map(([id, label]) => h('button', { key: id, type: 'button', className: 'sg-tab ' + (section === id ? 'active' : ''), 'aria-current': section === id ? 'page' : undefined, onClick: () => goSection(id) }, TAB_SWATCH[id] ? h('i', { key: 'sw', className: 'sg-tab-swatch ' + TAB_SWATCH[id], 'aria-hidden': 'true' }) : null, label))),
        h('div', { className: 'sg-page-body' },
        error ? h('div', { className: 'sg-error' }, h('div', { className: 'sg-error-title' }, '暂时无法读取完整记忆'), h('div', null, '已显示能够读取的内容，请稍后重新加载。'), h('details', null, h('summary', null, '技术详情'), h('div', { className: 'sg-code' }, error))) : null,
        view.name === 'root' && selected?.duplicateRepair?.needsReview > 0 ? h('button', { type: 'button', className: 'sg-dup-entry', onClick: () => setView({ name: 'duplicates' }) },
          h(DuplicateIcon, { size: 23 }), h('span', null, h('strong', null, selected.duplicateRepair.needsReview + ' 组相似记忆，等你确认'), h('small', null, '对比内容，选择保留哪张或合并双方证据')), h(DuplicateIcon, { kind: 'next' })) : null,
        h('section', { key: section, className: 'sg-view', 'aria-label': 'StrataGate 记忆内容' }, section === 'long' && selected && loadedNamespaceRef.current === namespace ? h(React.Fragment, null,
          h('div', { key: 'long-browser', hidden: view.name !== 'root' }, h(LongTermPage, { graphSettings: overview.graphSettings, extractionGap: selected?.longTermExtractionGap === true, key: namespace, events: data.events, eventPage: data.pagination?.events, graph: data.graph, project, query, setQuery, openEvent, namespace, focusNodeId: graphFocusNodeId, onFocusHandled: consumeGraphFocus, topicDirectory: data.topicDirectory, onDirectoryChanged: refreshDirectory, refresh, active: view.name === 'root' })),
          view.name === 'root' ? null : content) : content),
        h('footer', { className: 'sg-footer' },
          h('span', null, 'StrataGate-AgentMemory · MIT'),
          h('span', { className: 'sg-footer-links' },
            h('a', { href: STAR_REPOSITORY_URL, target: '_blank', rel: 'noopener noreferrer' }, 'GitHub 仓库'), ' · ',
            h('a', { href: ISSUE_URL, target: '_blank', rel: 'noopener noreferrer' }, '提 Issue'), ' · ',
            h('a', { href: STAR_REPOSITORY_URL + '/releases', target: '_blank', rel: 'noopener noreferrer' }, '更新记录'))))))
    }

    function MemoryPanel(props) {
      return h('div', { className: 'sg-memory-panel', style: { flex: '1 1 0%', minHeight: 0, width: '100%', overflowY: 'auto', overflowX: 'hidden' } }, h(MemoryPage, props))
    }

    function readSidebarPromptState() {
      try { return String(globalThis.localStorage?.getItem(SIDEBAR_PROMPT_STORAGE_KEY) || '') } catch { return '' }
    }

    function writeSidebarPromptState(value) {
      try { globalThis.localStorage?.setItem(SIDEBAR_PROMPT_STORAGE_KEY, value) } catch {}
    }

    function StrataGatePanelIcon({ size = 20 }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true, focusable: false, className: 'sg-sidebar-panel-icon',
        style: { display: 'block', flexShrink: 0 },
      },
      h('path', { opacity: 0.28, strokeWidth: 1.4, d: 'M3 12V4a1 1 0 0 1 1-1h8' }),
      h('path', { opacity: 0.55, d: 'M6 15V7a1 1 0 0 1 1-1h9' }),
      h('rect', { x: 9, y: 9, width: 12, height: 13, rx: 1.8 }),
      h('path', { d: 'M12 13h6M12 17h4' }))
    }

    function SidebarPlacementPrompt({ onChooseSidebar, usePluginSettings }) {
      const settings = usePluginSettings ? usePluginSettings((state) => state) : null
      const [visible, setVisible] = React.useState(() => readSidebarPromptState() !== 'dismissed')
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      if (!visible || settings?.value?.showSidebarEntry === true || settings?.writable !== true) return null
      const dismiss = () => {
        writeSidebarPromptState('dismissed')
        setVisible(false)
      }
      const chooseSidebar = async () => {
        setBusy(true); setError('')
        try {
          if (!await onChooseSidebar?.()) { setError('未能保存，请重试。'); return }
          writeSidebarPromptState('sidebar')
          setVisible(false)
        } catch { setError('未能保存，请检查连接后重试。') }
        finally { setBusy(false) }
      }
      return h(React.Fragment, null,
        h('style', null, SIDEBAR_PROMPT_STYLES),
        h('span', { className: 'sg-sidebar-placement-prompt', role: 'region', 'aria-label': 'StrataGate 侧栏入口提示' },
          h('span', { className: 'sg-sidebar-placement-text' }, '从左侧栏快速打开记忆'),
          h('button', { type: 'button', className: 'sg-sidebar-placement-action', disabled: busy, onClick: () => void chooseSidebar() }, '放到左侧栏'),
          h('button', { type: 'button', className: 'sg-sidebar-placement-close', 'aria-label': '关闭侧栏入口提示', title: '不再提醒', disabled: busy, onClick: dismiss }, '×'),
          error ? h('span', { role: 'alert' }, error) : null))
    }

    let disposeFeedbackLinkNavigation = null

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (!slots) return
      const configForms = ctx.get('configForms')
      const settingsScope = ctx.get('settingsScope')
      const pluginSettingsScope = configForms
        ? configForms.get('stratagate-memory')
        : settingsScope ? settingsScope.bind({ namespace: 'stratagate-memory' }) : null
      const setSidebarEntry = async (visible) => {
        if (!pluginSettingsScope || !await pluginSettingsScope.set('showSidebarEntry', visible)) return false
        if (!visible) {
          const layout = ctx.get('layout')
          if (layout?.activePanelId === MEMORY_PANEL_ID) layout.selectPanel?.(null)
        }
        return true
      }
      const warnCitationFailure = (part, error) => {
        if (typeof console === 'undefined' || typeof console.warn !== 'function') return
        try { console.warn('[StrataGate] ' + part + ' registration failed; memory settings remain available.', error) } catch {}
      }
      slots.inject('settings.section', () => slots.register({
        name: 'settings.section',
        id: 'stratagate-memory',
        order: 32,
        label: () => 'StrataGate-AgentMemory',
        inject: () => ({
          hooks: { pluginSettings: pluginSettingsScope },
          setMemoryModel: pluginSettingsScope ? selection => pluginSettingsScope.set('memoryModel', selection) : null,
          setEffort: pluginSettingsScope ? (mode) => pluginSettingsScope.set('structuredReasoningEffort', mode) : null,
          setDailyEnabled: pluginSettingsScope ? enabled => pluginSettingsScope.set('dailyNotesEnabled', enabled) : null,
          setDailyInjectionDays: pluginSettingsScope ? days => pluginSettingsScope.set('dailyNotesInjectionDays', days) : null,
          setDailyTimeZone: pluginSettingsScope ? zone => zone ? pluginSettingsScope.set('dailyNotesTimeZone', zone) : pluginSettingsScope.unset('dailyNotesTimeZone') : null,
          resetEffort: pluginSettingsScope ? () => pluginSettingsScope.unset('structuredReasoningEffort') : null,
          setStrataGateStatus: pluginSettingsScope ? (visible) => pluginSettingsScope.set('showStrataGateStatus', visible) : null,
          setShortTermStatus: pluginSettingsScope ? (visible) => pluginSettingsScope.set('showShortTermStatus', visible) : null,
          setRetrievalStatus: pluginSettingsScope ? (visible) => pluginSettingsScope.set('showRetrievalStatus', visible) : null,
          setSidebarEntry: pluginSettingsScope ? setSidebarEntry : null,
        }),
      }, (props) => h(FeedbackSettingsPage, { ...props, onChooseSidebar: async () => {
        const layout = ctx.get('layout')
        if (typeof layout?.selectPanel !== 'function' || !await setSidebarEntry(true)) return false
        layout.selectPanel(MEMORY_PANEL_ID)
        props.close?.()
        return true
      }, onOpenDreamingSession: sessionId => {
        const navigation = ctx.get('uiWorkspace')
        if (typeof navigation?.openSession !== 'function') throw new Error('当前 DSH 未提供会话导航，请升级宿主后重试')
        navigation.openSession(sessionId)
        props.close?.()
      } })))
      const memoryPanelInject = () => ({
        setMemoryModel: pluginSettingsScope ? selection => pluginSettingsScope.set('memoryModel', selection) : null,
        ...(pluginSettingsScope ? { hooks: { pluginSettings: pluginSettingsScope } } : {}),
        setEffort: pluginSettingsScope ? (mode) => pluginSettingsScope.set('structuredReasoningEffort', mode) : null,
          setDailyEnabled: pluginSettingsScope ? enabled => pluginSettingsScope.set('dailyNotesEnabled', enabled) : null,
          setDailyInjectionDays: pluginSettingsScope ? days => pluginSettingsScope.set('dailyNotesInjectionDays', days) : null,
          setDailyTimeZone: pluginSettingsScope ? zone => zone ? pluginSettingsScope.set('dailyNotesTimeZone', zone) : pluginSettingsScope.unset('dailyNotesTimeZone') : null,
        resetEffort: pluginSettingsScope ? () => pluginSettingsScope.unset('structuredReasoningEffort') : null,
        setStrataGateStatus: pluginSettingsScope ? (visible) => pluginSettingsScope.set('showStrataGateStatus', visible) : null,
        setShortTermStatus: pluginSettingsScope ? (visible) => pluginSettingsScope.set('showShortTermStatus', visible) : null,
        setRetrievalStatus: pluginSettingsScope ? (visible) => pluginSettingsScope.set('showRetrievalStatus', visible) : null,
        setSidebarEntry: pluginSettingsScope ? setSidebarEntry : null,
        onOpenDreamingSession: sessionId => {
          const navigation = ctx.get('uiWorkspace')
          if (typeof navigation?.openSession !== 'function') throw new Error('当前 DSH 未提供会话导航，请升级宿主后重试')
          navigation.openSession(sessionId)
        },
      })
      try {
        slots.inject('main', () => slots.register({
          name: 'main',
          key: MEMORY_PANEL_ID,
          order: 20,
          inject: memoryPanelInject,
        }, MemoryPanel))
        slots.inject('sidebar.panellist', () => {
          let removeEntry = null
          const syncSidebar = () => {
            const snapshot = pluginSettingsScope?.getSnapshot?.()
            if (snapshot?.status === 'loading') return
            const visible = snapshot?.value?.showSidebarEntry === true
            if (visible && !removeEntry) {
              removeEntry = slots.register({ name: 'sidebar.panellist', id: MEMORY_PANEL_ID, order: 20, label: () => 'StrataGate 记忆' }, StrataGatePanelIcon) || (() => {})
            } else if (!visible && removeEntry) { removeEntry(); removeEntry = null }
          }
          const unsubscribe = pluginSettingsScope?.subscribe?.(syncSidebar)
          syncSidebar()
          return () => { unsubscribe?.(); removeEntry?.(); removeEntry = null }
        })
      } catch (error) {
        warnCitationFailure('sidebar entry', error)
      }
      try {
        const uiConversation = ctx.get('uiConversation')
        if (uiConversation) {
          uiConversation.events.register(memoryCitationsDefinition)
          ensureCitationStyles()
          slots.inject('conversation.chat.turnTail', () => {
            try {
              return slots.register({
                name: 'conversation.chat.turnTail',
                id: 'stratagate-memory-citations',
                select: selectMemoryCitations,
                inject: () => ({
                  ...(pluginSettingsScope ? { hooks: { pluginSettings: pluginSettingsScope } } : {}),
                  onOpenGraphNode: (namespace, nodeId) => navigateToGraphNode(ctx, namespace, nodeId),
                }),
              }, MemoryCitationTail)
            } catch (error) {
              warnCitationFailure('chat turn tail', error)
              return () => {}
            }
          })
        }
      } catch (error) {
        warnCitationFailure('chat citations', error)
      }
      if (typeof document !== 'undefined') {
        disposeFeedbackLinkNavigation?.()
        const disposeLinkNavigation = installFeedbackLinkNavigation(ctx)
        const disposeDeepLink = openFeedbackDeepLink(ctx)
        const disposeGraphDeepLink = openGraphNodeDeepLink(ctx)
        disposeFeedbackLinkNavigation = () => {
          disposeLinkNavigation()
          disposeDeepLink()
          disposeGraphDeepLink()
        }
      }
    }

    exports.name = 'stratagate-dsh'
    exports.inject = ['slots', 'uiConversation']
    exports.apply = apply
    return module.exports
  },
})
