    function dashboardApi(params, options = {}) {
      const query = new URLSearchParams(params || {})
      const url = '/api/stratagate/dashboard' + (query.size ? '?' + query : '')
      let attempt = 0
      const request = () => fetch(url, {
        cache: 'no-cache',
        signal: options.signal,
        headers: options.etag ? { 'If-None-Match': options.etag } : undefined,
      }).then(async (res) => {
        const etag = res.headers.get('etag') || options.etag || ''
        if (res.status === 304) return { notModified: true, etag, data: null }
        const data = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error((data && data.error) || 'HTTP ' + res.status)
        return { notModified: false, etag, data }
      }).catch((reason) => {
        if (reason?.name === 'AbortError') throw reason
        const message = String(reason?.message || reason)
        const networkFailure = reason instanceof TypeError || message.includes('Failed to fetch')
        if (networkFailure && attempt < 2) {
          attempt += 1
          return new Promise((resolve) => window.setTimeout(resolve, attempt * 300)).then(request)
        }
        throw new Error(message + '（dashboard）')
      })
      return request()
    }

    function pageMeta(value, fallbackLimit) {
      return {
        total: Math.max(0, Number(value?.total || 0)),
        offset: Math.max(0, Number(value?.offset || 0)),
        limit: Math.max(1, Number(value?.limit || fallbackLimit)),
      }
    }

    function usePagedMemory({ namespace, kind, initialItems, initialPage, fallbackLimit, extraParams = {}, reloadOnParamsChange = false }) {
      const key = namespace + '\u0000' + kind
      const paramsKey = JSON.stringify(extraParams)
      const [state, setState] = React.useState(() => ({ items: initialItems, page: pageMeta(initialPage, fallbackLimit) }))
      const [loading, setLoading] = React.useState(false)
      const [error, setError] = React.useState('')
      const requestVersion = React.useRef(0)
      const previousParamsKey = React.useRef(paramsKey)
      const previousInitialData = React.useRef({ items: initialItems, total: initialPage?.total, limit: initialPage?.limit })
      React.useEffect(() => {
        requestVersion.current += 1
        setState({ items: initialItems, page: pageMeta(initialPage, fallbackLimit) })
        setError('')
      }, [key])
      const loadOffset = (offset) => {
        const version = ++requestVersion.current
        setLoading(true)
        setError('')
        const path = kind === 'audit' ? 'audit' : 'memories'
        const params = { namespace, offset, limit: state.page.limit, ...extraParams }
        if (kind !== 'audit') params.kind = kind
        return api(path, params).then((result) => {
          if (version !== requestVersion.current) return
          setState({ items: result.items || [], page: pageMeta(result, state.page.limit) })
        }).catch((reason) => {
          if (version !== requestVersion.current) return
          setError(String(reason?.message || reason))
        }).finally(() => { if (version === requestVersion.current) setLoading(false) })
      }
      React.useEffect(() => {
        const previous = previousInitialData.current
        const changed = previous.items !== initialItems || previous.total !== initialPage?.total || previous.limit !== initialPage?.limit
        previousInitialData.current = { items: initialItems, total: initialPage?.total, limit: initialPage?.limit }
        if (reloadOnParamsChange) {
          if (changed && previousParamsKey.current === paramsKey) {
            setState((current) => ({ ...current, page: { ...current.page, offset: 0 } }))
            void loadOffset(0)
          }
          return
        }
        setState((current) => current.page.offset === 0
          ? { items: initialItems, page: pageMeta(initialPage, fallbackLimit) }
          : current)
      }, [initialItems, initialPage?.total, initialPage?.limit, reloadOnParamsChange, paramsKey])
      React.useEffect(() => {
        if (!reloadOnParamsChange) {
          previousParamsKey.current = paramsKey
          return
        }
        if (previousParamsKey.current === paramsKey) return
        previousParamsKey.current = paramsKey
        setState((current) => ({ items: [], page: { ...current.page, total: 0, offset: 0 } }))
        void loadOffset(0)
      }, [paramsKey, reloadOnParamsChange])
      return { ...state, loading, error, loadOffset }
    }

    function Pagination({ page, loading, error, onOffset }) {
      const totalPages = Math.max(1, Math.ceil(page.total / page.limit))
      const currentPage = Math.min(totalPages, Math.floor(page.offset / page.limit) + 1)
      const start = page.total ? page.offset + 1 : 0
      const end = Math.min(page.total, page.offset + page.limit)
      return h('div', { className: 'sg-pagination', role: 'navigation', 'aria-label': '分页' },
        h('button', { type: 'button', className: 'sg-page-button', disabled: loading || page.offset <= 0, onClick: () => onOffset(Math.max(0, page.offset - page.limit)) }, '上一页'),
        h('span', null, loading ? '加载中…' : '第 ' + currentPage + ' / ' + totalPages + ' 页 · 显示 ' + start + '–' + end + ' / 共 ' + page.total + ' 条'),
        h('button', { type: 'button', className: 'sg-page-button', disabled: loading || page.offset + page.limit >= page.total, onClick: () => onOffset(page.offset + page.limit) }, '下一页'),
        error ? h('span', { className: 'sg-page-error' }, '加载失败：' + error) : null)
    }

    function projectName(item, workspaceTitles = {}) {
      const name = projectNameRaw(item, workspaceTitles)
      return name === 'default-workspace' ? '默认工作区' : name
    }
    function projectNameRaw(item, workspaceTitles = {}) {
      const value = String(item?.namespace || item || '')
      if (value.includes(':project:')) {
        const key = value.split(':project:').pop()
        if (key && workspaceTitles[key]) return workspaceTitles[key]
        if (item?.workspaceName && item.workspaceName !== '当前工作区') return item.workspaceName
        return '工作区名称读取中…'
      }
      if (item?.workspaceName) return item.workspaceName
      if (value.includes(':global:')) return value.split(':global:').pop() || '全局记忆'
      if (value.includes(':session:')) return '当前对话'
      return value || '当前工作区'
    }

    function workspaceProjectKey(path) {
      const canonical = String(path || '').replaceAll('\\', '/').toLowerCase()
      if (!canonical || !globalThis.crypto?.subtle) return Promise.resolve('')
      return globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical)).then((digest) =>
        Array.from(new Uint8Array(digest).slice(0, 10), (byte) => byte.toString(16).padStart(2, '0')).join(''))
    }

    function formatTime(value) {
      if (!value) return '时间未知'
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return String(value)
      const seconds = Math.round((Date.now() - date.getTime()) / 1000)
      if (seconds >= 0 && seconds < 60) return '刚刚'
      if (seconds >= 60 && seconds < 3600) return Math.floor(seconds / 60) + ' 分钟前'
      const timeZone = 'Asia/Shanghai'
      const dayKey = (input) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(input)
      const clock = (input) => new Intl.DateTimeFormat('zh-CN', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).format(input)
      const now = new Date()
      if (dayKey(date) === dayKey(now)) return '今天 ' + clock(date)
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000)
      if (dayKey(date) === dayKey(yesterday)) return '昨天 ' + clock(date)
      return new Intl.DateTimeFormat('zh-CN', { timeZone, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(date)
    }

    function statusText(status) {
      if (status === 'organized') return '已整理'
      if (status === 'failed') return '整理失败'
      if (status === 'waiting') return '等待整理'
      return '整理中'
    }

    function UsedMark({ count, title }) {
      const numeric = Number(count)
      return h('span', { className: 'sg-used', title: title || '被回答用到' },
        h('svg', { viewBox: '0 0 13 11', 'aria-hidden': 'true', focusable: 'false' }, h('path', { d: 'M2 .5h9A1.5 1.5 0 0 1 12.5 2v4.5A1.5 1.5 0 0 1 11 8H6L3 10.5V8H2A1.5 1.5 0 0 1 .5 6.5V2A1.5 1.5 0 0 1 2 .5z', fill: 'currentColor' })),
        Number.isFinite(numeric) && numeric > 0 ? String(numeric) : null)
    }

    function eventDayKey(value) {
      const time = Date.parse(value)
      if (!Number.isFinite(time)) return ''
      return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(time))
    }

    function eventDayLabel(value) {
      const time = Date.parse(value)
      if (!Number.isFinite(time)) return { day: '?', week: '时间未知' }
      const date = new Date(time)
      const today = eventDayKey(new Date().toISOString())
      const key = eventDayKey(value)
      const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', day: '2-digit' }).format(date)
      if (key === today) return { day, week: '今天' }
      const yesterday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() - 86_400_000))
      if (key === yesterday) return { day, week: '昨天' }
      return { day, week: new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric' }).format(date) }
    }

    function Loading() {
      return h('div', { className: 'sg-loading', role: 'status' }, h('div', { className: 'sg-skeleton' }), h('div', { className: 'sg-skeleton' }), h('div', { className: 'sg-skeleton' }))
    }

    function Empty({ title, copy }) {
      return h('div', { className: 'sg-empty' }, h('strong', null, title), h('span', null, copy))
    }

    function BackBar({ label, onBack }) {
      return h('div', { className: 'sg-backbar' }, h('button', { className: 'sg-back', onClick: onBack, title: '返回' }, h('span', { 'aria-hidden': 'true' }, '←'), label))
    }

    function activeProcessingCount(overview) {
      const scheduledRetries = (overview?.failedJobDetails || []).filter((job) => job.nextRetryAt).length
      return Math.max(0, Number(overview?.processingJobs || 0) - scheduledRetries)
    }

    function statusJobKey(job) {
      return String(job?.kind || 'job') + ':' + String(job?.id || '')
    }

    function emptyTaskStatus() {
      return { processing: 0, retryable: 0, terminalFailed: 0, completed: 0, blocked: 0 }
    }

    function taskStatus(overview) {
      const explicit = overview?.taskStatus
      if (explicit?.blockSummary && explicit?.eventExtraction && explicit?.graphProjection) return explicit
      const result = { blockSummary: emptyTaskStatus(), eventExtraction: emptyTaskStatus(), graphProjection: emptyTaskStatus() }
      const kindMap = {
        'block-summary': result.blockSummary,
        'event-extraction': result.eventExtraction,
        'graph-projection': result.graphProjection,
      }
      const processingKeys = new Set()
      for (const job of overview?.processingJobDetails || []) {
        const group = kindMap[job.kind]
        if (group) {
          processingKeys.add(statusJobKey(job))
          group.processing += 1
        }
      }
      for (const job of overview?.failedJobDetails || []) {
        const group = kindMap[job.kind]
        if (!group) continue
        const retryable = Boolean(job.nextRetryAt) && Number(job.attempts || 0) < 3
        if (retryable) {
          group.retryable += 1
          if (!processingKeys.has(statusJobKey(job))) group.processing += 1
        } else if (!retryable) group.terminalFailed += 1
      }
      return result
    }

    function graphMigrationState(overview, status = taskStatus(overview)) {
      const migration = overview?.graphMigration || {}
      if (status.graphProjection.processing > 0 || migration.processing > 0) return 'processing'
      if (status.graphProjection.terminalFailed > 0 || migration.failed > 0) return 'failed'
      if (migration.state === 'processing' || migration.state === 'failed') return migration.state
      const total = Number(migration.total ?? overview?.events)
      // First login may have no namespace or snapshot yet. Missing data does
      // not establish unfinished work; actual jobs above still take priority.
      if (!Number.isFinite(total)) return 'unknown'
      if (total === 0) return 'empty'
      if (migration.state) return migration.state
      if (migration.complete) return 'complete'
      return 'incomplete'
    }

    // A missing snapshot is unknown, never evidence of completeness or a gap.
    function graphMigrationNotice(migration) {
      if (!migration) return ''
      const total = Number(migration.total)
      const projected = Number(migration.projected)
      const uncovered = migration.total != null && migration.projected != null
        && Number.isSafeInteger(total) && total > 0 && Number.isSafeInteger(projected)
        && projected >= 0 && projected < total
      return uncovered || Number(migration.processing) > 0 || Number(migration.failed) > 0
        ? '当前图谱尚未更新完整。' : ''
    }

    function summaryUnavailable(block) {
      const job = block?.summaryJob
      return job?.state === 'terminal-failed' || (job?.status === 'failed' && !job.state
        && !(Number(job.attempts || 0) < 3 && job.nextRetryAt && Number.isFinite(Date.parse(job.nextRetryAt))))
    }

    function SearchBox({ value, onChange, placeholder = '搜索记忆、人物、项目、概念…' }) {
      return h('div', { className: 'sg-search' }, h('span', { className: 'sg-search-mark', 'aria-hidden': 'true' }, '⌕'), h('input', { value, onChange: (event) => onChange(event.target.value), placeholder, 'aria-label': '搜索长期记忆' }))
    }

    function useDebouncedValue(value, delay = 250) {
      const [debounced, setDebounced] = React.useState(value)
      React.useEffect(() => {
        const timer = window.setTimeout(() => setDebounced(value), delay)
        return () => window.clearTimeout(timer)
      }, [value, delay])
      return debounced
    }

    const NODE_META = {
      person: ['人物', '#8b6ccf', '♙'], project: ['项目', '#6f55ae', '▣'], organization: ['组织', '#3978cf', '⌘'],
      tool: ['工具', '#3b854d', '▤'], place: ['地点', '#8a8378', '⌂'],
    }
    const EVENT_TYPE_TEXT = { decision: '决策', release: '发布', task_completed: '任务完成', plan: '计划', change: '变更', cancellation: '取消', incident: '事件', meeting: '会议', collaboration: '协作', migration: '迁移', other: '其他' }
    const EVENT_STATUS_TEXT = { occurred: '已发生', planned: '计划中', cancelled: '已取消', ongoing: '进行中', unknown: '未知' }
    const EVENT_RELATIONS = [['supersedesEventIds', '取代'], ['conflictsWithEventIds', '冲突'], ['sameEventId', '同一事件'], ['beforeEventIds', '之前'], ['afterEventIds', '之后'], ['relatedEventIds', '相关']]

    function exactTime(value) {
      if (!value) return '未知'
      const date = new Date(value)
      return Number.isNaN(date.getTime()) ? String(value) : new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date)
    }

    function eventOccurrence(event) {
      const happened = event.temporal?.happenedStart || event.temporal?.happenedEnd
      return { value: happened || event.temporal?.mentionedAt || event.createdAt, known: Boolean(happened) }
    }

    function NodePill({ node, onClick }) {
      const meta = NODE_META[node.type] || ['实体', '#64748b', '•']
      return h('button', {
        type: 'button',
        className: 'sg-entity-pill',
        onPointerDown: (event) => event.stopPropagation(),
        onClick: (event) => { event.stopPropagation(); onClick?.(event) },
        title: '在知识图谱中查看 ' + node.name,
      }, h('span', { style: { color: meta[1] }, 'aria-hidden': 'true' }, meta[2]), node.name)
    }

    function StaticEntityPill({ name }) {
      return h('span', { className: 'sg-entity-pill sg-entity-pill-static' }, name)
    }

    function NodeSummaryBubble({ node, x, y, width, height = 560, onViewDetails }) {
      if (!node) return null
      const facts = (node.facts || []).filter((fact) => fact.status === 'active').slice(0, 5)
      const eventCount = new Set(node.sourceEventIds || []).size
      return h('aside', { className: 'sg-node-bubble ' + (x > width * .62 ? 'flip' : ''), style: { left: (x / width * 100) + '%', top: (y / height * 100) + '%' } },
        h('div', { className: 'sg-node-bubble-head' }, h('h3', null, node.name), h('span', { className: 'sg-status-dot' }, '● ' + (node.status === 'active' ? '活跃' : node.status || '未知'))),
        (node.tags || []).length ? h('div', { className: 'sg-node-tags' }, node.tags.slice(0, 4).map((tag) => h('span', { key: tag, className: 'sg-node-tag' }, tag))) : null,
        h('p', { className: 'sg-node-bubble-state' }, node.currentState || '暂无当前状态'),
        facts.length ? h('ul', null, facts.map((fact) => h('li', { key: fact.id }, h('strong', null, fact.key + '：'), Array.isArray(fact.value) ? fact.value.join('、') : fact.value))) : h('p', { className: 'sg-node-bubble-state' }, '暂无关键事实'),
        h('div', { className: 'sg-node-bubble-foot' }, h('span', null, eventCount + ' 条相关事件'), h('button', { type: 'button', onClick: onViewDetails }, '查看详情 →')))
    }

    const GRAPH_NODE_RADIUS = { peripheral: 30, normal: 38, important: 46, core: 54 }
    const GRAPH_IMPORTANCE_TEXT = { peripheral: '边缘节点', normal: '普通节点', important: '重要节点', core: '核心节点' }

    function graphNameKey(value) {
      return String(value || '').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
    }

    function graphTimestamp(value) {
      const timestamp = Date.parse(String(value || ''))
      return Number.isFinite(timestamp) ? timestamp : 0
    }

    // Importance is derived from the complete persisted graph snapshot. The caller
    // deliberately computes this before search/type filters are applied, so a view
    // change never changes the meaning of a node's size.
    function graphNodeImportance(nodes, edges, project) {
      const activeEdges = edges.filter((edge) => edge.status === 'active')
      const activeSupportingEvents = (node) => (node.supportingEvents || []).filter((event) => event.status !== 'forgotten' && event.status !== 'archived')
      const relationCounts = new Map(nodes.map((node) => [node.id, 0]))
      const neighbors = new Map(nodes.map((node) => [node.id, new Set()]))
      for (const edge of activeEdges) {
        relationCounts.set(edge.fromNodeId, (relationCounts.get(edge.fromNodeId) || 0) + 1)
        relationCounts.set(edge.toNodeId, (relationCounts.get(edge.toNodeId) || 0) + 1)
        neighbors.get(edge.fromNodeId)?.add(edge.toNodeId)
        neighbors.get(edge.toNodeId)?.add(edge.fromNodeId)
      }

      const projectKey = graphNameKey(project)
      const directWorkspaceNodes = new Set(nodes.filter((node) => projectKey && [node.name, ...(node.aliases || [])].some((name) => {
        const key = graphNameKey(name)
        return key === projectKey || (key.length >= 5 && projectKey.length >= 5 && (key.includes(projectKey) || projectKey.includes(key)))
      })).map((node) => node.id))
      const workspaceAffinity = new Map(nodes.map((node) => [node.id, directWorkspaceNodes.has(node.id) ? 1 : 0]))
      for (const nodeId of directWorkspaceNodes) {
        for (const neighborId of neighbors.get(nodeId) || []) {
          workspaceAffinity.set(neighborId, Math.max(workspaceAffinity.get(neighborId) || 0, .55))
          for (const secondHopId of neighbors.get(neighborId) || []) {
            workspaceAffinity.set(secondHopId, Math.max(workspaceAffinity.get(secondHopId) || 0, .25))
          }
        }
      }

      const supportCounts = new Map(nodes.map((node) => {
        const supportingEvents = activeSupportingEvents(node)
        return [node.id, supportingEvents.length ? new Set(supportingEvents.map((event) => event.id)).size : new Set(node.sourceEventIds || []).size]
      }))
      const maxSupport = Math.max(1, ...supportCounts.values())
      const maxRelations = Math.max(1, ...relationCounts.values())
      let latestActivity = 0
      for (const node of nodes) {
        latestActivity = Math.max(latestActivity, graphTimestamp(node.updatedAt))
        for (const event of activeSupportingEvents(node)) latestActivity = Math.max(latestActivity, graphTimestamp(event.updatedAt || event.createdAt))
      }
      for (const edge of activeEdges) latestActivity = Math.max(latestActivity, graphTimestamp(edge.updatedAt))
      const halfLife = 90 * 24 * 60 * 60 * 1000
      const recency = (timestamp) => timestamp && latestActivity ? Math.exp(-Math.max(0, latestActivity - timestamp) / halfLife) : 0

      const scored = nodes.map((node) => {
        const supportingEvents = activeSupportingEvents(node)
        const sustainedMentions = supportingEvents.map((event) => recency(graphTimestamp(event.updatedAt || event.createdAt))).sort((left, right) => right - left).slice(0, 3)
        const recentScore = .25 * recency(graphTimestamp(node.updatedAt)) + .75 * sustainedMentions.reduce((sum, value) => sum + value, 0) / 3
        const supportScore = Math.log1p(supportCounts.get(node.id) || 0) / Math.log1p(maxSupport)
        const relationScore = Math.log1p(relationCounts.get(node.id) || 0) / Math.log1p(maxRelations)
        const score = .42 * supportScore + .28 * relationScore + .15 * recentScore + .15 * (workspaceAffinity.get(node.id) || 0)
        return { id: node.id, score }
      })
      const ordered = scored.map(({ score }) => score).sort((left, right) => left - right)
      const quantile = (ratio) => ordered[Math.ceil(Math.max(0, ordered.length - 1) * ratio)] || 0
      const spread = (ordered[ordered.length - 1] || 0) - (ordered[0] || 0)
      const thresholds = { normal: quantile(.25), important: quantile(.6), core: quantile(.85) }
      return new Map(scored.map(({ id, score }) => {
        let tier
        if (spread < .02) tier = score >= .65 ? 'core' : score >= .38 ? 'important' : 'normal'
        else if (score >= thresholds.core) tier = 'core'
        else if (score >= thresholds.important) tier = 'important'
        else if (score >= thresholds.normal) tier = 'normal'
        else tier = 'peripheral'
        return [id, { score, tier, radius: GRAPH_NODE_RADIUS[tier] }]
      }))
    }

    function GraphCanvas({ nodes, edges, clusters, importance, selectedId, onSelect, nodeLimit = 100, showSummary = false, onViewDetails }) {
      const containerRef = React.useRef(null)
      const graphRef = React.useRef(null)
      const selectedIdRef = React.useRef(selectedId)
      selectedIdRef.current = selectedId
      const [selectedPoint, setSelectedPoint] = React.useState(null)
      const [zoomPercent, setZoomPercent] = React.useState(100)
      const displayedNodes = [...nodes].sort((left, right) => (importance.get(right.id)?.score || 0) - (importance.get(left.id)?.score || 0)).slice(0, nodeLimit)
      const displayedIds = new Set(displayedNodes.map((node) => node.id))
      const visibleClusters = (clusters || []).map((cluster) => ({ ...cluster, nodeIds: (cluster.nodeIds || []).filter((id) => displayedIds.has(id)) })).filter((cluster) => cluster.nodeIds.length)
      const assignedIds = new Set(visibleClusters.flatMap((cluster) => cluster.nodeIds))
      for (const node of displayedNodes.filter((item) => !assignedIds.has(item.id))) visibleClusters.push({ id: 'fallback-' + node.id, label: (node.tags || [])[0] || node.name, nodeIds: [node.id], tags: node.tags || [] })
      const membership = new Map(visibleClusters.flatMap((cluster) => cluster.nodeIds.map((id) => [id, cluster.id])))
      const activeEdges = edges.filter((edge) => edge.status === 'active' && displayedIds.has(edge.fromNodeId) && displayedIds.has(edge.toNodeId))
      const signature = JSON.stringify({
        nodes: displayedNodes.map((node) => [node.id, node.name, node.type, node.tags || [], importance.get(node.id)?.tier]),
        edges: activeEdges.map((edge) => [edge.id, edge.fromNodeId, edge.toNodeId, edge.relation, edge.confidence]),
        clusters: visibleClusters.map((cluster) => [cluster.id, cluster.label, cluster.nodeIds]),
      })

      React.useEffect(() => {
        const container = containerRef.current
        if (!container || !cytoscape || !displayedNodes.length) return undefined
        const computed = getComputedStyle(container)
        const textColor = computed.getPropertyValue('--sg-text').trim() || '#0f1115'
        const mutedColor = computed.getPropertyValue('--sg-muted').trim() || '#64748b'
        const borderColor = computed.getPropertyValue('--sg-border').trim() || '#d5d9df'
        const pageColor = computed.getPropertyValue('--sg-page').trim() || '#ffffff'
        const accentColor = computed.getPropertyValue('--sg-accent').trim() || '#4176e6'
        const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
        const parentIds = new Map(visibleClusters.map((cluster) => [cluster.id, 'sg-parent-' + cluster.id]))
        const clusterSizes = new Map(visibleClusters.map((cluster) => [cluster.id, cluster.nodeIds.length]))
        const elements = [
          ...visibleClusters.map((cluster) => ({ data: { id: parentIds.get(cluster.id), label: cluster.label + ' · ' + cluster.nodeIds.length }, classes: 'sg-community' })),
          ...displayedNodes.map((node) => {
            const meta = NODE_META[node.type] || ['实体', '#64748b', '•']
            const semantic = (node.tags || [])[0] || meta[0]
            const visualImportance = importance.get(node.id) || { tier: 'normal', radius: GRAPH_NODE_RADIUS.normal }
            return { data: { id: node.id, parent: parentIds.get(membership.get(node.id)), label: node.name + '\n' + semantic, color: meta[1], size: visualImportance.radius * 2, tier: visualImportance.tier }, classes: 'sg-memory-node' }
          }),
          ...activeEdges.map((edge) => {
            const fromCluster = membership.get(edge.fromNodeId); const toCluster = membership.get(edge.toNodeId)
            const sameCluster = fromCluster === toCluster
            const labeled = sameCluster && (clusterSizes.get(fromCluster) || 0) <= 6
            return { data: { id: 'sg-edge-' + edge.id, source: edge.fromNodeId, target: edge.toNodeId, label: edge.relation }, classes: 'sg-memory-edge ' + (sameCluster ? 'same-community' : 'cross-community') + (labeled ? ' labeled' : '') }
          }),
        ]
        const graph = cytoscape({
          container,
          elements,
          wheelSensitivity: .22,
          minZoom: .25,
          maxZoom: 2.4,
          selectionType: 'single',
          boxSelectionEnabled: false,
          style: [
            { selector: 'node.sg-community', style: { 'background-color': accentColor, 'background-opacity': .045, 'border-color': accentColor, 'border-opacity': .28, 'border-width': 1, 'border-style': 'dashed', shape: 'round-rectangle', padding: '22px', label: 'data(label)', color: mutedColor, 'font-size': 12, 'font-weight': 700, 'text-valign': 'top', 'text-halign': 'center', 'text-margin-y': -9, 'text-background-color': pageColor, 'text-background-opacity': .82, 'text-background-padding': '3px' } },
            { selector: 'node.sg-memory-node', style: { width: 'data(size)', height: 'data(size)', 'background-color': 'data(color)', 'background-opacity': .28, 'border-color': 'data(color)', 'border-width': 1.5, label: 'data(label)', color: textColor, 'font-size': 11, 'font-weight': 650, 'text-wrap': 'wrap', 'text-max-width': 96, 'text-valign': 'center', 'text-halign': 'center', 'overlay-opacity': 0, 'transition-property': 'border-width, border-color, underlay-opacity', 'transition-duration': reduceMotion ? '0ms' : '180ms' } },
            { selector: 'node.sg-memory-node:selected', style: { 'border-width': 4, 'border-color': accentColor, 'underlay-color': accentColor, 'underlay-opacity': .16, 'underlay-padding': 7 } },
            { selector: 'edge.sg-memory-edge', style: { width: 1.2, 'line-color': mutedColor, 'target-arrow-color': mutedColor, 'target-arrow-shape': 'triangle', 'curve-style': 'bezier', opacity: .58, 'arrow-scale': .75, label: '', 'overlay-opacity': 0 } },
            { selector: 'edge.sg-memory-edge.labeled', style: { label: 'data(label)', color: textColor, 'font-size': 10, 'text-background-color': pageColor, 'text-background-opacity': .88, 'text-background-padding': '2px', 'text-rotation': 'autorotate' } },
            { selector: 'edge.sg-memory-edge.cross-community', style: { opacity: .24, 'line-style': 'dashed' } },
            { selector: 'edge.sg-memory-edge.selected-relation', style: { opacity: .9, width: 2, label: 'data(label)', color: textColor, 'font-size': 10, 'text-background-color': pageColor, 'text-background-opacity': .9, 'text-background-padding': '2px' } },
          ],
        })
        graphRef.current = graph
        const updatePoint = () => {
          const selected = graph.getElementById(selectedIdRef.current)
          if (!selected.length) { setSelectedPoint(null); return }
          const point = selected.renderedPosition()
          setSelectedPoint({ x: point.x, y: point.y, width: container.clientWidth || 760, height: container.clientHeight || 522 })
        }
        graph.on('tap', 'node.sg-memory-node', (event) => onSelect(event.target.id()))
        const updateZoom = () => setZoomPercent(Math.round(graph.zoom() * 100))
        graph.on('pan zoom resize', updatePoint)
        graph.on('zoom', updateZoom)
        graph.on('layoutstop', updatePoint)
        graph.on('layoutstop', updateZoom)
        const resizeObserver = globalThis.ResizeObserver ? new globalThis.ResizeObserver(() => { graph.resize(); updatePoint() }) : null
        resizeObserver?.observe(container)
        graph.layout({ name: 'fcose', quality: 'default', randomize: true, animate: reduceMotion ? false : 'end', animationDuration: reduceMotion ? 0 : 320, animationEasing: 'ease-out-cubic', fit: true, padding: 48, nodeRepulsion: 5200, idealEdgeLength: (edge) => edge.hasClass('cross-community') ? 170 : 78, edgeElasticity: .42, nestingFactor: 1.35, gravity: .28, gravityCompound: 1, gravityRangeCompound: 1.5, tile: true }).run()
        return () => { resizeObserver?.disconnect(); graphRef.current = null; graph.destroy() }
      }, [signature])

      React.useEffect(() => {
        const graph = graphRef.current
        if (!graph) return
        graph.nodes('.sg-memory-node').unselect()
        graph.edges().removeClass('selected-relation')
        const selected = graph.getElementById(selectedId)
        if (!selected.length) { setSelectedPoint(null); return }
        selected.select()
        selected.connectedEdges().addClass('selected-relation')
        graph.center(selected)
        const point = selected.renderedPosition()
        const container = containerRef.current
        setSelectedPoint({ x: point.x, y: point.y, width: container?.clientWidth || 760, height: container?.clientHeight || 522 })
      }, [selectedId, signature])

      const setGraphZoom = (nextPercent) => {
        const graph = graphRef.current
        const container = containerRef.current
        if (!graph || !container) return
        const percent = Math.min(240, Math.max(25, Number(nextPercent)))
        graph.zoom({ level: percent / 100, renderedPosition: { x: container.clientWidth / 2, y: container.clientHeight / 2 } })
      }

      if (!nodes.length) return h(Empty, { title: '知识图谱正在形成', copy: 'Event 会在后台分批投影为节点与关系。' })
      if (!cytoscape) return h(Empty, { title: '图谱组件未能加载', copy: '请重新加载页面后再试。' })
      const selectedNode = nodes.find((node) => node.id === selectedId)
      return h('div', { className: 'sg-graph-canvas', role: 'img', 'aria-label': visibleClusters.length + ' 个 Leiden 主题群组的知识图谱' },
        h('div', { ref: containerRef, className: 'sg-cytoscape' }),
        h('div', { className: 'sg-graph-zoom', role: 'group', 'aria-label': '知识图谱缩放' },
          h('button', { type: 'button', onClick: () => setGraphZoom(zoomPercent - 20), disabled: zoomPercent <= 25, title: '缩小', 'aria-label': '缩小知识图谱' }, '\u2212'),
          h('input', { type: 'range', min: '25', max: '240', step: '5', value: String(zoomPercent), onInput: (event) => setGraphZoom(event.target.value), title: '缩放比例 ' + zoomPercent + '%', 'aria-label': '知识图谱缩放比例', 'aria-valuetext': zoomPercent + '%' }),
          h('button', { type: 'button', onClick: () => setGraphZoom(zoomPercent + 20), disabled: zoomPercent >= 240, title: '放大', 'aria-label': '放大知识图谱' }, '+')),
        h('div', { className: 'sg-graph-a11y', 'aria-label': '知识图谱节点列表' }, displayedNodes.map((node) => h('button', { key: node.id, onClick: () => onSelect(node.id) }, node.name + '，' + ((node.tags || [])[0] || (NODE_META[node.type] || ['实体'])[0]) + '，' + GRAPH_IMPORTANCE_TEXT[importance.get(node.id)?.tier || 'normal']))),
        showSummary && selectedNode && selectedPoint ? h(NodeSummaryBubble, { node: selectedNode, x: selectedPoint.x, y: selectedPoint.y, width: selectedPoint.width, height: selectedPoint.height, onViewDetails }) : null,
        h('div', { className: 'sg-graph-legend' }, Object.entries(NODE_META).map(([type, meta]) => h('span', { key: type }, h('i', { style: { background: meta[1] } }), meta[0]))))
    }

    function NodeDetailPanel({ node, nodes, edges, events, onEvent }) {
      if (!node) return h('aside', { className: 'sg-long-detail sg-placeholder-detail' }, '选择节点查看当前状态与证据')
      const meta = NODE_META[node.type] || ['实体', '#64748b', '•']
      const relations = edges.filter((edge) => edge.status === 'active' && (edge.fromNodeId === node.id || edge.toNodeId === node.id))
      const eventMap = new Map(events.map((event) => [event.id, event]))
      return h('aside', { className: 'sg-long-detail' },
        h('div', { className: 'sg-node-head' }, h('span', { className: 'sg-node-avatar', style: { background: meta[1] } }, meta[2]), h('div', null, h('h2', null, node.name), h('span', { className: 'sg-muted' }, meta[0]))),
        (node.tags || []).length ? h('section', null, h('h3', null, '语义标签'), h('div', { className: 'sg-node-tags' }, node.tags.map((tag) => h('span', { key: tag, className: 'sg-node-tag' }, tag)))) : null,
        h('section', null, h('h3', null, '当前状态'), h('span', { className: 'sg-status-dot' }, '● ' + (node.status === 'active' ? '活跃' : node.status)), node.currentState ? h('p', { className: 'sg-detail-copy' }, node.currentState) : null),
        h('section', null, h('h3', null, '关键事实'), node.facts?.filter((fact) => fact.status === 'active').length ? h('ul', null, node.facts.filter((fact) => fact.status === 'active').map((fact) => h('li', { key: fact.id }, h('strong', null, fact.key + '：'), Array.isArray(fact.value) ? fact.value.join('、') : fact.value))) : h('p', { className: 'sg-muted' }, '暂无关键事实')),
        h('section', null, h('h3', null, '相关关系'), relations.length ? relations.map((edge) => { const outgoing = edge.fromNodeId === node.id; const other = nodes.find((item) => item.id === (outgoing ? edge.toNodeId : edge.fromNodeId)); return h('div', { key: edge.id, className: 'sg-relation-row' }, h('span', null, outgoing ? edge.relation : '被' + edge.relation), h('strong', null, other?.name || '未知节点'), h('small', null, Math.round(edge.confidence * 100) + '%')) }) : h('p', { className: 'sg-muted' }, '暂无关系')),
        h('section', null, h('h3', null, '支撑事件'), (node.sourceEventIds || []).flatMap((id) => eventMap.get(id) || []).slice(0, 8).map((event) => h('button', { key: event.id, className: 'sg-support-event', onClick: () => onEvent(event.id) }, h('span', null, exactTime(eventOccurrence(event).value) + ' · ' + event.title), h('b', null, '›')))))
    }

    const CRITICALITY_INFO = {
      routine: ['普通事件', 0],
      preference: ['用户偏好', .3],
      identity: ['身份信息', .9],
      safety: ['安全相关', 1],
    }

    function eventDate(value) {
      if (!value) return ''
      const date = new Date(value)
      return Number.isNaN(date.getTime()) ? String(value) : new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date).replaceAll('/', '-')
    }

    function participantIdentity(value) {
      return String(value || '').normalize('NFKC').trim().toLocaleLowerCase().replace(/[\s._\-·•/\\]+/g, '')
    }

    function EventMetadata({ event, nodes = [], onNode }) {
      if (!event) return null
      const temporal = event.temporal || {}
      const start = eventDate(temporal.happenedStart)
      const end = eventDate(temporal.happenedEnd)
      const happened = start ? start + (end && end !== start ? ' — ' + end : '') : end
      const nodeMap = new Map(nodes.map((node) => [node.id, node]))
      const linked = [...new Set(temporal.participantNodeIds || [])].map((id) => nodeMap.get(id)).filter(Boolean)
      const linkedNames = new Set(linked.flatMap((node) => [node.name, ...(node.aliases || [])]).map(participantIdentity).filter(Boolean))
      const seenText = new Set()
      const unlinked = (temporal.participants || []).map((name) => String(name || '').trim()).filter((name) => {
        const identity = participantIdentity(name)
        if (!identity || linkedNames.has(identity) || seenText.has(identity)) return false
        seenText.add(identity)
        return true
      })
      const mentioned = eventDate(temporal.mentionedAt)
      if (!happened && !Number.isSafeInteger(event.formedTurn) && !linked.length && !unlinked.length && !mentioned) return null
      return h('div', { className: 'sg-event-metadata' },
        happened ? h('span', { className: 'sg-event-metadata-item' }, h('b', null, '实际发生：'), happened) : null,
        Number.isSafeInteger(event.formedTurn) ? h('span', { className: 'sg-event-metadata-item' }, h('b', null, '记忆形成：'), '第 ' + event.formedTurn + ' 轮') : null,
        linked.length || unlinked.length ? h('span', { className: 'sg-event-metadata-item' }, h('b', null, '参与：'), h('span', { className: 'sg-event-participants' },
          linked.map((node) => h(NodePill, { key: node.id, node, onClick: onNode ? (event) => onNode(node.id, event) : undefined })),
          unlinked.map((name) => h(StaticEntityPill, { key: name, name })))) : null,
        mentioned ? h('span', { className: 'sg-event-metadata-item' }, h('b', null, '提及：'), mentioned) : null)
    }

    const InfoPopoverContext = React.createContext(null)

    function InfoPopoverGroup({ children }) {
      const [openId, setOpenId] = React.useState(null)
      return h(InfoPopoverContext.Provider, { value: { openId, setOpenId } }, children)
    }

    function InfoPopover({ label, children, className = '' }) {
      const id = React.useId()
      const rootRef = React.useRef(null)
      const group = React.useContext(InfoPopoverContext)
      const [localOpenId, setLocalOpenId] = React.useState(null)
      const openId = group?.openId ?? localOpenId
      const setOpenId = group?.setOpenId ?? setLocalOpenId
      const open = openId === id
      React.useEffect(() => {
        if (!open) return undefined
        const onPointerDown = (event) => {
          if (!rootRef.current?.contains(event.target)) setOpenId(null)
        }
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setOpenId(null)
        }
        document.addEventListener('pointerdown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown)
        return () => {
          document.removeEventListener('pointerdown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown)
        }
      }, [open, setOpenId])
      return h('span', { ref: rootRef, className: 'sg-info-disclosure ' + className },
        h('button', { type: 'button', className: 'sg-info-trigger', 'aria-label': label, title: label, 'aria-expanded': open, 'aria-controls': id, onClick: () => setOpenId((current) => current === id ? null : id) }, 'ⓘ'),
        open ? h('div', { id, className: 'sg-info-popover', role: 'dialog', 'aria-label': label, onPointerDown: (event) => event.stopPropagation() }, h('strong', { className: 'sg-info-title' }, label), children) : null)
    }

    function AdoptionHistoryInfo({ trajectory }) {
      const history = Array.isArray(trajectory?.adoptionHistory) ? trajectory.adoptionHistory : []
      const total = Number.isSafeInteger(trajectory?.effectiveAdoptions) ? trajectory.effectiveAdoptions : 0
      return h(InfoPopover, { label: '采纳历史' },
        total === 0 ? h('p', null, '该 Event 尚未被 Agent 采纳。') : !history.length ? h('p', null, '当前没有可展示的采纳回执详情。') : null,
        history.length ? h('ol', { className: 'sg-adoption-history' }, history.map((receipt, index) => h('li', { key: receipt.receiptId || index },
          h('strong', null, '已确认采纳'),
          h('time', { dateTime: receipt.createdAt }, exactTime(receipt.createdAt)),
          h('span', null, '会话：' + receipt.sessionId + ' · 第 ' + receipt.turn + ' 轮'),
          Number.isFinite(receipt.relativeTurn) ? h('span', null, '距记忆形成 +' + receipt.relativeTurn + ' 轮') : null))) : null)
    }

    function FloorWeightInfo({ event, floorWeight }) {
      const type = CRITICALITY_INFO[event?.criticality]
      return h(InfoPopover, { label: '最低权重' },
        type ? h('p', null, '此 Event 被识别为「' + type[0] + '」，因此最低权重为 ' + Number(floorWeight).toFixed(2) + '。') : h('p', null, '此 Event 的最低权重为 ' + Number(floorWeight).toFixed(2) + '。'),
        h('p', null, '记忆会随对话推进逐渐衰减，但不会低于对应类型的最低权重。'),
        type ? h('dl', { className: 'sg-floor-table' }, Object.entries(CRITICALITY_INFO).map(([key, value]) => h(React.Fragment, { key }, h('dt', { className: key === event.criticality ? 'current' : '' }, value[0]), h('dd', { className: key === event.criticality ? 'current' : '' }, Number(value[1]).toFixed(2))))) : null)
    }

    function denseWeightPath(points, x, y) {
      return points.reduce((path, point, index) => {
        const px = x(point.turn)
        const py = y(point.weight)
        if (index === 0) return 'M' + px.toFixed(1) + ' ' + py.toFixed(1)
        return path + ' L' + px.toFixed(1) + ' ' + py.toFixed(1)
      }, '')
    }

    function relativeTurnTicks(maximum) {
      if (maximum <= 0) return [0]
      const target = Math.max(1, maximum / 5)
      const magnitude = 10 ** Math.floor(Math.log10(target))
      const candidates = [1, 2, 5, 10].map((value) => value * magnitude)
      const step = candidates.reduce((best, value) => Math.abs(value - target) < Math.abs(best - target) ? value : best)
      const ticks = []
      for (let value = 0; value <= maximum; value += step) ticks.push(Math.round(value))
      if (ticks.at(-1) !== maximum) ticks.push(maximum)
      return [...new Set(ticks)]
    }

    function MemoryWeightTrajectory({ event }) {
      const [hoveredSegment, setHoveredSegment] = React.useState(null)
      const trajectory = event?.weightTrajectory
      const points = Array.isArray(trajectory?.points) ? trajectory.points.filter((point) => Number.isFinite(point?.turn) && Number.isFinite(point?.weight)) : []
      const formedTurn = Number.isSafeInteger(event?.formedTurn) ? event.formedTurn : Number.isSafeInteger(trajectory?.formedTurn) ? trajectory.formedTurn : null
      const trajectoryStartTurn = Number.isSafeInteger(trajectory?.trajectoryStartTurn) ? trajectory.trajectoryStartTurn : points[0]?.turn
      const currentWeight = Number.isFinite(trajectory?.currentWeight) ? trajectory.currentWeight : Number(event?.weight?.forcedCap ?? 1)
      const effectiveAdoptions = Number.isSafeInteger(trajectory?.effectiveAdoptions) ? trajectory.effectiveAdoptions : Math.max(0, Number(event?.weight?.mentionCount || 1) - 1)
      const floorWeight = Number.isFinite(event?.weight?.floorWeight) ? event.weight.floorWeight : Number.isFinite(trajectory?.floorWeight) ? trajectory.floorWeight : 0
      const metrics = h('div', { className: 'sg-weight-metrics' },
        h('div', { className: 'sg-weight-metric' }, h('span', null, '当前权重'), h('strong', null, Number(currentWeight).toFixed(2))),
        h('div', { className: 'sg-weight-metric' }, h('span', null, 'Agent 已采纳'), h('span', { className: 'sg-weight-value' }, h('strong', null, effectiveAdoptions + ' 次'), h(AdoptionHistoryInfo, { trajectory }))),
        h('div', { className: 'sg-weight-metric' }, h('span', null, '最低权重'), h('span', { className: 'sg-weight-value' }, h('strong', null, Number(floorWeight).toFixed(2)), h(FloorWeightInfo, { event, floorWeight }))))
      if (!trajectory || points.length === 0) return h(React.Fragment, null, h('div', { className: 'sg-weight-header' }, h('h3', { className: 'sg-section-title' }, '记忆状态')), metrics)
      const rawSegments = Array.isArray(trajectory.segments) ? trajectory.segments : [points]
      const segments = rawSegments.map((segment) => {
        const source = Array.isArray(segment) ? segment : segment?.points
        const certainty = Array.isArray(segment) ? 'known' : segment?.certainty === 'incomplete' ? 'incomplete' : 'known'
        return {
          certainty,
          points: (Array.isArray(source) ? source : []).filter((point) => Number.isFinite(point?.turn) && Number.isFinite(point?.weight)).map((point) => ({ ...point, weight: Math.max(certainty === 'incomplete' ? floorWeight : 0, Math.min(1, point.weight)) })),
        }
      }).filter((segment) => segment.points.length)
      const maxTurn = Math.max(...points.map((point) => point.turn))
      const minTurn = Math.min(Number.isSafeInteger(trajectoryStartTurn) ? trajectoryStartTurn : maxTurn, ...points.map((point) => point.turn))
      const turnSpan = Math.max(0, maxTurn - minTurn)
      const x = (turn) => turnSpan === 0 ? 307 : 48 + (turn - minTurn) / turnSpan * 518
      const y = (weight) => 22 + (1 - Math.max(0, Math.min(1, weight))) * 154
      const nodeByTurn = new Map()
      for (const point of points.filter((candidate) => candidate.kind !== 'sample')) {
        const existing = nodeByTurn.get(point.turn)
        if (!existing || point.kind === 'adoption' || (point.kind === 'current' && existing.kind !== 'adoption')) nodeByTurn.set(point.turn, { ...point, isCurrent: point.kind === 'current' || existing?.isCurrent })
        else if (point.kind === 'current') nodeByTurn.set(point.turn, { ...existing, isCurrent: true })
      }
      const nodes = [...nodeByTurn.values()].sort((left, right) => left.turn - right.turn)
      const adoptionNodes = nodes.filter((point) => point.kind === 'adoption')
      const ticks = relativeTurnTicks(turnSpan)
      const relativeAxis = formedTurn !== null
      const nodeLabel = (point) => {
        if (point.kind === 'creation') return point.label || ''
        if (point.kind === 'current') return '当前'
        if (point.kind !== 'adoption') return ''
        if (point.isCurrent) return '最近采纳 · 当前'
        if (adoptionNodes.length <= 3 || point.turn === trajectory.latestAdoptionTurn) return point.adoptionCount > 1 ? '采纳 ×' + point.adoptionCount : '采纳'
        return ''
      }
      const nodeTooltip = (point) => {
        const count = point.kind === 'adoption' && point.adoptionCount > 1 ? '（同轮 ' + point.adoptionCount + ' 次）' : ''
        const prefix = point.kind === 'creation' ? (trajectory.formationTurnSource === 'sourceBlock' ? '来源 Block 结束' : '记忆形成') : point.kind === 'adoption' ? 'Agent 采纳' + count : '当前权重'
        return prefix + ' · 第 ' + point.turn + ' 轮 · 权重：' + Number(point.weight).toFixed(2)
      }
      const occupiedLabels = []
      const labelPositions = new Map()
      for (const [index, point] of nodes.entries()) {
        const label = nodeLabel(point)
        if (!label) continue
        const px = x(point.turn)
        const anchor = index === 0 ? 'start' : index === nodes.length - 1 ? 'end' : 'middle'
        const width = Math.max(28, label.length * 6.6)
        const left = anchor === 'start' ? px : anchor === 'end' ? px - width : px - width / 2
        const candidates = [y(point.weight) - 11, y(point.weight) - 27, y(point.weight) + 24, y(point.weight) + 40]
        const py = candidates.map((value) => Math.max(13, Math.min(169, value))).find((value) => !occupiedLabels.some((box) => left < box.right + 7 && left + width > box.left - 7 && Math.abs(value - box.y) < 15)) ?? Math.max(13, Math.min(169, candidates.at(-1)))
        occupiedLabels.push({ left, right: left + width, y: py })
        labelPositions.set(point, { x: px, y: py, anchor, label })
      }
      const showSegmentTooltip = (event, segment) => {
        const bounds = event.currentTarget?.ownerSVGElement?.parentElement?.getBoundingClientRect?.()
        if (!bounds) return
        const first = segment.points[0]
        const last = segment.points.at(-1)
        setHoveredSegment({
          x: Math.max(128, Math.min(bounds.width - 128, event.clientX - bounds.left)),
          y: Math.max(18, event.clientY - bounds.top),
          below: event.clientY - bounds.top < 72,
          certainty: segment.certainty,
          startTurn: first.turn,
          endTurn: last.turn,
          startWeight: first.weight,
          endWeight: last.weight,
        })
      }
      return h(React.Fragment, null,
        h('div', { className: 'sg-weight-header' }, h('h3', { className: 'sg-section-title' }, '记忆状态')),
        metrics,
        h('div', { className: 'sg-weight-chart' },
          h('svg', { viewBox: '0 0 620 238', preserveAspectRatio: 'xMidYMid meet', role: 'img', 'aria-label': '该 Event 的记忆权重轨迹，横轴为' + (relativeAxis ? '距记忆形成的对话轮次' : '对话轮次') + '，纵轴为记忆权重，最低权重为 ' + Number(floorWeight).toFixed(2) },
            [0, .5, 1].map((weight) => h(React.Fragment, { key: weight },
              h('line', { className: 'sg-weight-grid', x1: '48', y1: String(y(weight)), x2: '566', y2: String(y(weight)) }),
              h('text', { className: 'sg-weight-axis-label', x: '39', y: String(y(weight) + 4), textAnchor: 'end' }, weight.toFixed(1)))),
            h('line', { className: 'sg-weight-floor', x1: '48', y1: String(y(floorWeight)), x2: '566', y2: String(y(floorWeight)) }),
            h('text', { className: 'sg-weight-floor-label', x: '562', y: String(y(floorWeight) + 16), textAnchor: 'end' }, '最低权重 ' + Number(floorWeight).toFixed(2)),
            segments.filter((segment) => segment.points.length > 1).map((segment, index) => h(React.Fragment, { key: 'segment:' + index },
              h('path', { className: 'sg-weight-line ' + (segment.certainty === 'incomplete' ? 'incomplete' : 'known'), d: denseWeightPath(segment.points, x, y) }),
              h('path', {
                className: 'sg-weight-line-hit',
                d: denseWeightPath(segment.points, x, y),
                onPointerEnter: (event) => showSegmentTooltip(event, segment),
                onPointerMove: (event) => showSegmentTooltip(event, segment),
                onPointerLeave: () => setHoveredSegment(null),
                'aria-label': segment.certainty === 'incomplete' ? '旧数据推算的记忆权重轨迹' : '已确认的记忆权重轨迹',
              }))),
            nodes.map((point, index) => h(React.Fragment, { key: point.kind + ':' + point.turn + ':' + index },
              h('circle', { className: 'sg-weight-node ' + point.kind, cx: String(x(point.turn)), cy: String(y(point.weight)), r: point.kind === 'adoption' ? '6' : '5' },
                h('title', null, nodeTooltip(point))),
              labelPositions.has(point) ? h('text', { className: 'sg-weight-node-label', x: String(labelPositions.get(point).x), y: String(labelPositions.get(point).y), textAnchor: labelPositions.get(point).anchor }, labelPositions.get(point).label) : null)),
            ticks.map((offset) => {
              const turn = minTurn + offset
              return h(React.Fragment, { key: 'tick:' + turn },
                h('line', { className: 'sg-weight-tick', x1: String(x(turn)), y1: '176', x2: String(x(turn)), y2: '181' }),
                h('text', { className: 'sg-weight-axis-label', x: String(x(turn)), y: '215', textAnchor: offset === 0 ? 'start' : offset === turnSpan ? 'end' : 'middle' }, relativeAxis ? turn - formedTurn : turn))
            }),
            h('text', { className: 'sg-weight-axis-label', x: '307', y: '232', textAnchor: 'middle' }, relativeAxis ? '距记忆形成的对话轮次' : '对话轮次')),
          hoveredSegment ? h('div', { className: 'sg-weight-tooltip ' + (hoveredSegment.below ? 'below' : 'above'), style: { left: hoveredSegment.x + 'px', top: hoveredSegment.y + 'px' }, role: 'tooltip' },
            h('strong', null, hoveredSegment.certainty === 'incomplete' ? '旧数据推算轨迹' : '已确认轨迹'),
            h('small', null, '第 ' + hoveredSegment.startTurn + '–' + hoveredSegment.endTurn + ' 轮 · ' + Number(hoveredSegment.startWeight).toFixed(2) + ' → ' + Number(hoveredSegment.endWeight).toFixed(2)),
            hoveredSegment.certainty === 'incomplete' ? h('small', null, '旧版本未记录部分采纳的准确轮次') : null) : null))
    }

    function CopyEventId({ value }) {
      const [copied, setCopied] = React.useState(false)
      const copy = () => {
        if (!globalThis.navigator?.clipboard?.writeText) return
        void globalThis.navigator.clipboard.writeText(String(value)).then(() => {
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1400)
        })
      }
      return h('button', { type: 'button', className: 'sg-copy-id', onClick: copy, disabled: !globalThis.navigator?.clipboard?.writeText }, copied ? '已复制' : '复制')
    }

    function EventSourceDisclosure({ sourceMessages }) {
      if (!sourceMessages?.length) return null
      return h(CitationDisclosure, { title: '来源与证据' },
        h('p', { className: 'sg-provenance-note' }, '以下原始内容用于查看与追溯依据，不代表全部内容都参与了某次回答。'),
        h('div', { className: 'sg-citation-messages' }, sourceMessages.map((message, index) => h('div', { key: message.id || index, className: 'sg-citation-message' },
          h('span', { className: 'sg-citation-message-role' }, (message.role || 'message') + (message.createdAt ? ' · ' + exactTime(message.createdAt) : '')),
          String(message.content || '')))))
    }

    function EventTechnicalDisclosure({ event, citation }) {
      const evidenceRef = String(citation?.evidenceRef || '')
      const redundantEvidenceRef = !evidenceRef || evidenceRef === event.id || evidenceRef === 'event:' + event.id
      return h(CitationDisclosure, { title: '技术信息' }, h('dl', { className: 'sg-event-technical' },
        h('dt', null, 'Event ID'), h('dd', null, h('code', null, event.id), h(CopyEventId, { value: event.id })),
        !redundantEvidenceRef ? h(React.Fragment, null, h('dt', null, 'evidenceRef'), h('dd', null, h('code', null, evidenceRef))) : null,
        citation?.detailKind ? h(React.Fragment, null, h('dt', null, 'detailKind'), h('dd', null, h('code', null, citation.detailKind))) : null,
        event.sourceBlockId ? h(React.Fragment, null, h('dt', null, '来源 Block'), h('dd', null, h('code', null, event.sourceBlockId))) : null))
    }

    function EventMemoryDetails({ event, sourceMessages = [], citation = null, relatedEvents = [] }) {
      const memoryContent = event?.summary
      return h(React.Fragment, null,
        h('section', { className: 'sg-event-section' }, h('h3', { className: 'sg-event-section-title' }, '记忆内容'), h('p', { className: 'sg-event-memory-copy' }, memoryContent || '暂无可展示的记忆内容。')),
        h('section', { className: 'sg-event-section sg-event-weight-section' }, h(MemoryWeightTrajectory, { event })),
        relatedEvents.length ? h(CitationDisclosure, { title: '关联信息' }, h('div', { className: 'sg-citation-events' }, relatedEvents.map((related, index) => h('article', { key: related.id || index, className: 'sg-citation-event' }, h('strong', null, related.title || '关联事件'), h('p', null, related.summary || '暂无摘要'))))) : null,
        h(EventSourceDisclosure, { sourceMessages }),
        h(EventTechnicalDisclosure, { event, citation }))
    }

    function EventDetailPanel({ event, nodes, events, onNode, openSource, className = '', onMouseEnter, onMouseLeave }) {
      if (!event) return h('aside', { className: 'sg-long-detail sg-placeholder-detail' }, '选择事件查看完整时间、关系与证据')
      const temporal = event.temporal || {}; const eventMap = new Map(events.map((item) => [item.id, item]))
      const relations = EVENT_RELATIONS.flatMap(([key, label]) => { const value = temporal[key]; const ids = Array.isArray(value) ? value : value ? [value] : []; return ids.map((id) => ({ id, label })) })
      return h(InfoPopoverGroup, { key: event.id }, h('aside', { className: 'sg-long-detail ' + className, onMouseEnter, onMouseLeave },
        h('div', { className: 'sg-event-detail-head' }, h('div', null, h('span', { className: 'sg-event-detail-kicker' }, 'Event'), h('h2', null, event.title)), h('span', { className: 'sg-event-status ' + (temporal.status || 'unknown') }, EVENT_STATUS_TEXT[temporal.status] || '未知')),
        h(EventMetadata, { event, nodes, onNode }),
        h('section', null, h('h3', null, '记忆内容'), h('p', { className: 'sg-detail-copy' }, event.summary || '暂无可展示的记忆内容。')),
        relations.length ? h('section', null, h('h3', null, '事件关系'), relations.map((relation) => h('div', { key: relation.label + relation.id, className: 'sg-relation-row' }, h('span', null, relation.label), h('strong', null, eventMap.get(relation.id)?.title || relation.id)))) : null,
        event.weightTrajectory ? h('section', null, h(MemoryWeightTrajectory, { event })) : null,
        h('button', { className: 'sg-source-button', onClick: () => openSource(event) }, '查看来源与证据 →')))
    }

    function dismissedDreamKey(id) {
      return id ? 'sg-dream-dismiss:' + id : ''
    }

    function dreamDismissed(id) {
      const key = dismissedDreamKey(id)
      if (!key || typeof localStorage === 'undefined') return false
      try { return localStorage.getItem(key) === '1' } catch { return false }
    }

    function dismissDream(id) {
      const key = dismissedDreamKey(id)
      if (!key || typeof localStorage === 'undefined') return
      try { localStorage.setItem(key, '1') } catch { /* a private window can block storage; the click still hides it */ }
    }

    function dreamingChangesOf(run) {
      const raw = run?.changes || {}
      return {
        editedEvents: Math.max(0, Number(raw.editedEvents || 0)),
        deletedEvents: Math.max(0, Number(raw.deletedEvents || 0)),
        experiences: Math.max(0, Number(raw.experiences || 0)),
        items: Array.isArray(raw.items) ? raw.items : [],
      }
    }

    function TimelineList({ events, nodes, onSelect, selectedId, floating = false, onNode, openSource, dreaming = null }) {
      const [preview, setPreview] = React.useState(null)
      const pinnedId = React.useRef('')
      const hideTimer = React.useRef(null)
      const cancelHide = () => { if (hideTimer.current) window.clearTimeout(hideTimer.current); hideTimer.current = null }
      const hidePreview = () => { cancelHide(); setPreview(null); pinnedId.current = '' }
      const showPreview = (event, target, pin = false) => {
        if (!floating || (!pin && pinnedId.current)) return
        cancelHide()
        const rect = target.getBoundingClientRect(); const width = Math.min(380, window.innerWidth - 24); const maxHeight = Math.min(620, window.innerHeight * .72)
        const rightSide = rect.right + 12 + width <= window.innerWidth - 12
        const left = rightSide ? rect.right + 12 : Math.max(12, rect.left - width - 12)
        const top = Math.min(Math.max(12, rect.top - 8), Math.max(12, window.innerHeight - maxHeight - 12))
        setPreview({ event, left, top })
        if (pin) pinnedId.current = event.id
      }
      const scheduleHide = () => {
        if (pinnedId.current) return
        cancelHide()
        hideTimer.current = window.setTimeout(() => setPreview(null), 140)
      }
      React.useEffect(() => () => cancelHide(), [])
      const sorted = events.slice().sort((a, b) => String(eventOccurrence(b).value).localeCompare(String(eventOccurrence(a).value)))
      const days = []
      for (const event of sorted) {
        const info = eventOccurrence(event)
        const key = eventDayKey(info.value) || 'unknown'
        let group = days.find((item) => item.key === key)
        if (!group) { group = { key, label: key === 'unknown' ? { day: '?', week: '发生时间未知' } : eventDayLabel(info.value), items: [] }; days.push(group) }
        group.items.push({ event, info })
      }
      const nodeMap = new Map(nodes.map((node) => [node.id, node]))
      const usedCount = (event) => Number(event?.weight?.mentionCount || 0) - 1
      const [dreamHidden, setDreamHidden] = React.useState(() => dreamDismissed(dreaming?.id))
      const dreamRun = !dreamHidden && dreaming && ['completed', 'terminated'].includes(dreaming.status) && dreaming.updatedAt ? dreaming : null
      // One thin strip sits after the day whose events it rewrote; nothing is
      // repeated at the top, so the strip always belongs to a real day group.
      const dreamDay = dreamRun ? eventDayKey(dreamRun.updatedAt) : ''
      const dreamStrip = kind => h('div', { className: 'sg-tl-day sg-tl-dream', 'aria-label': 'Dreaming 整理记录' },
        h('div', { className: 'sg-tl-date' }), h('div', { className: 'sg-tl-axis', 'aria-hidden': 'true' }),
        h('div', { className: 'sg-tl-items' }, h('div', { className: 'sg-dream' },
          h('span', null, kind === 'terminated' ? '整理已终止' : '整理过'),
          h('span', { className: 'sg-m', 'aria-hidden': 'true' }, Array.from({ length: 4 }, (_, index) => h('i', { key: index })), h('span', null, '→'), Array.from({ length: 2 }, (_, index) => h('i', { key: 'n' + index, className: 'o' }))),
          h('span', { className: 'sg-dream-note' }, kind === 'terminated' ? '改过的章节已保留' : '章节已合并'),
          h('button', { type: 'button', className: 'sg-dream-close', 'aria-label': '关闭这次整理记录', onClick: () => { dismissDream(dreaming?.id); setDreamHidden(true) } }, '×'))))
      return h('div', { className: 'sg-timeline sg-tl' },
        dreamRun && !days.some((group) => group.key === dreamDay) ? dreamStrip(dreamRun.status) : null,
        days.map((group) => h(React.Fragment, { key: group.key },
        h('section', { className: 'sg-tl-day', 'aria-label': group.label.week },
        h('div', { className: 'sg-tl-date' }, h('b', null, group.label.day), h('span', null, group.label.week)),
        h('div', { className: 'sg-tl-axis', 'aria-hidden': 'true' }),
        h('div', { className: 'sg-tl-items' }, group.items.map(({ event, info }) => {
          const temporal = event.temporal || {}
          const faded = event.status === 'forgotten' || event.status === 'archived' || temporal.status === 'cancelled'
          return h('button', { key: event.id, className: 'sg-ev' + (faded ? ' fade' : '') + (event.id === selectedId ? ' selected' : ''), 'data-event-id': event.id, onMouseEnter: (hover) => showPreview(event, hover.currentTarget), onMouseLeave: scheduleHide, onFocus: (focus) => showPreview(event, focus.currentTarget), onBlur: scheduleHide, onClick: (click) => { onSelect(event.id); showPreview(event, click.currentTarget, true) } },
            h('i', { className: 'sg-nd', 'aria-hidden': 'true' }),
            h('span', { className: 'sg-t' }, event.title || '记忆事件'),
            h('span', { className: 'sg-tp' }, temporal.eventType ? EVENT_TYPE_TEXT[temporal.eventType] || '其他' : '未分类'),
            usedCount(event) > 0 ? h(UsedMark, { count: usedCount(event), title: '被回答用到 ' + usedCount(event) + ' 次' }) : h('span'))
        }))),
        group.key === dreamDay ? dreamStrip(dreamRun.status) : null)),
        floating && preview ? h('div', { className: 'sg-event-popover', style: { left: preview.left + 'px', top: preview.top + 'px' }, onMouseEnter: cancelHide, onMouseLeave: scheduleHide },
        h('button', { type: 'button', className: 'sg-popover-close', 'aria-label': '关闭事件详情', onClick: hidePreview }, '×'),
        h(EventDetailPanel, { event: preview.event, nodes, events, onNode, openSource })) : null)
    }

