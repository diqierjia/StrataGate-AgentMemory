    function api(path, params, options) {
      const query = new URLSearchParams(params || {})
      const url = '/api/stratagate/' + path + (query.size ? '?' + query : '')
      let attempt = 0
      const request = () => fetch(url, { cache: 'no-store', ...options })
        .then((res) => res.json().catch(() => ({})).then((data) => {
          if (!res.ok) {
            const error = new Error((data && data.error) || 'HTTP ' + res.status)
            error.status = res.status
            error.code = data?.code
            throw error
          }
          return data
        }))
        .catch((reason) => {
          if (reason?.name === 'AbortError') throw reason
          const message = String(reason?.message || reason)
          const networkFailure = reason instanceof TypeError || message.includes('Failed to fetch')
          if (networkFailure && !options?.method && attempt < 2) {
            attempt += 1
            return new Promise((resolve) => window.setTimeout(resolve, attempt * 300)).then(request)
          }
          const error = new Error(message + '（' + path + '）')
          error.status = reason?.status
          error.code = reason?.code
          throw error
        })
      return request()
    }

    function citationKindLabel(citation) {
      if (citation.kind === 'event') return 'Event'
      if (citation.kind === 'graph') return '知识图谱'
      return 'Block'
    }

    function citationActionLabel(citation) {
      if (citation.kind === 'block' && citation.expanded && Number.isInteger(citation.level)) return '展开到 L' + citation.level
      if (citation.kind === 'block' && Number.isInteger(citation.level)) return 'L' + citation.level
      if (citation.expanded) return '已展开'
      if (String(citation.evidenceRef || '').startsWith('raw:')) return '原始片段'
      return ''
    }

    function retrievalGroupLabel(index) {
      return '第 ' + (index + 1) + ' 轮检索'
    }

    function evidenceGateLabel(group) {
      if (group.verdict === 'sufficient') return '证据充分'
      if (group.verdict === 'partial' || group.verdict === 'wrong') return '证据不足，继续检索'
      return ''
    }

    function selectMemoryCitations(owner) {
      const data = owner.turn.data.get(MEMORY_CITATIONS_KIND)
      const entries = Array.isArray(data?.entries) ? data.entries : []
      const cutoffSeq = Number.isSafeInteger(owner.turn.end?.seq) ? owner.turn.end.seq : owner.seq
      const selected = []
      const seen = new Set()
      const retrievalGroups = []
      const seenGroups = new Set()
      let retrievedCount = 0
      for (const entry of entries) {
        if (entry.seq > cutoffSeq || !Array.isArray(entry.citations)) continue
        const groupCount = Number.isInteger(entry.retrievedCount) && entry.retrievedCount >= 0 ? entry.retrievedCount : entry.citations.length
        const groupKey = String(entry.batchId || 'legacy:' + entry.seq)
        if (!seenGroups.has(groupKey)) {
          seenGroups.add(groupKey)
          retrievedCount += groupCount
          retrievalGroups.push({
            batchId: entry.batchId,
            sequence: Number.isInteger(entry.retrievalSequence) ? entry.retrievalSequence : null,
            seq: entry.seq,
            count: groupCount,
            verdict: entry.verdict,
            missing: entry.missing,
            nextStrategy: entry.nextStrategy,
            memories: (Array.isArray(entry.retrievedMemories) ? entry.retrievedMemories : []).map((memory) => ({ ...memory, namespace: entry.namespace })),
          })
        }
        for (const citation of entry.citations) {
          const key = [citation.detailKind, citation.id, citation.evidenceRef].join(':')
          if (seen.has(key)) continue
          seen.add(key)
          selected.push({ ...citation, namespace: entry.namespace })
        }
      }
      retrievalGroups.sort((left, right) => left.sequence !== null && right.sequence !== null
        ? left.sequence - right.sequence
        : left.sequence !== null
          ? -1
          : right.sequence !== null
            ? 1
            : left.seq - right.seq)
      return { turn: owner.turn.turn, citations: selected, retrievedCount, retrievalGroups }
    }

    function parseToolResultJson(event) {
      if (event.type !== 'tool/result') return null
      const message = event.data?.message
      if (!message || message.isError === true || !Array.isArray(message.content)) return null
      // Current DSH stores tool text directly; older sessions wrap it in tool_result.
      const first = message.content[0]
      const result = first?.type === 'tool_result' ? first : message
      if (result.isError === true || !Array.isArray(result.content)) return null
      const text = result.content.find((block) => block?.type === 'text' && typeof block.text === 'string')?.text
      if (!text) return null
      try {
        return JSON.parse(text)
      } catch {
        return null
      }
    }

    function parseMemoryRecordUseResult(event, callIds) {
      const callId = String(event.data?.message?.source?.callId || '')
      if (!callIds.has(callId)) return null
      try {
        const value = parseToolResultJson(event)
        if (value?.recorded !== true || typeof value.namespace !== 'string' || !Array.isArray(value.citations)) return null
        const retrievedCount = Number.isInteger(value.retrievedCount) && value.retrievedCount >= value.citations.length
          ? value.retrievedCount
          : value.citations.length
        const retrievedMemories = Array.isArray(value.retrievedMemories) ? value.retrievedMemories : []
        return {
          namespace: value.namespace,
          batchId: typeof value.batchId === 'string' ? value.batchId : undefined,
          retrievalSequence: Number.isInteger(value.retrievalSequence) ? value.retrievalSequence : undefined,
          citations: value.citations,
          retrievedCount,
          retrievedMemories,
          verdict: value.verdict === 'sufficient' || value.verdict === 'partial' || value.verdict === 'wrong' ? value.verdict : undefined,
          missing: typeof value.missing === 'string' ? value.missing : undefined,
          nextStrategy: typeof value.nextStrategy === 'string' ? value.nextStrategy : undefined,
        }
      } catch {
        return null
      }
    }

    const memoryCitationsDefinition = {
      kind: MEMORY_CITATIONS_KIND,
      match: (event) => {
        if (event.type === 'turn/start') return { id: String(event.data.turn), role: 'start' }
        if (event.type === 'stratagate/memory-citations') return { id: String(event.data.turn), role: 'update' }
        if (event.type === 'tool/call' && (event.data.name === 'memory_record_use' || MEMORY_RETRIEVAL_TOOLS.has(event.data.name))) return { id: String(event.data.turn), role: 'update' }
        if (event.type === 'tool/result') return { id: String(event.data.turn), role: 'update' }
        return null
      },
      start: (_context, match) => ({ turn: match.event.data.turn, callIds: new Set(), retrievalCallIds: new Map(), batchOrder: new Map(), entries: [] }),
      update: (context, match) => {
        if (match.event.type === 'stratagate/memory-citations') return {
          ...context.state,
          entries: [...context.state.entries, {
            seq: match.event.seq,
            namespace: match.event.data.namespace,
            batchId: match.event.data.batchId,
            retrievalSequence: match.event.data.retrievalSequence,
            citations: match.event.data.citations,
            retrievedCount: match.event.data.retrievedCount,
            retrievedMemories: match.event.data.retrievedMemories,
            verdict: match.event.data.verdict,
            missing: match.event.data.missing,
            nextStrategy: match.event.data.nextStrategy,
          }],
        }
        if (match.event.type === 'tool/call') {
          const callIds = new Set(context.state.callIds)
          const retrievalCallIds = new Map(context.state.retrievalCallIds)
          const callId = String(match.event.data.callId)
          if (match.event.data.name === 'memory_record_use') callIds.add(callId)
          if (MEMORY_RETRIEVAL_TOOLS.has(match.event.data.name)) retrievalCallIds.set(callId, match.event.seq)
          return { ...context.state, callIds, retrievalCallIds }
        }
        const resultCallId = String(match.event.data?.message?.source?.callId || '')
        if (context.state.retrievalCallIds.has(resultCallId)) {
          const value = parseToolResultJson(match.event)
          if (typeof value?.batchId !== 'string') return context.state
          const batchOrder = new Map(context.state.batchOrder)
          batchOrder.set(value.batchId, context.state.retrievalCallIds.get(resultCallId))
          return { ...context.state, batchOrder }
        }
        const result = parseMemoryRecordUseResult(match.event, context.state.callIds)
        return result === null ? context.state : {
          ...context.state,
          entries: [...context.state.entries, {
            seq: match.event.seq,
            namespace: result.namespace,
            batchId: result.batchId,
            retrievalSequence: context.state.batchOrder.get(result.batchId) ?? result.retrievalSequence,
            citations: result.citations,
            retrievedCount: result.retrievedCount,
            retrievedMemories: result.retrievedMemories,
            verdict: result.verdict,
            missing: result.missing,
            nextStrategy: result.nextStrategy,
          }],
        }
      },
      buildLocationData: (context, scope) => scope !== 'turn' || context.state === undefined ? null : {
        kind: 'turn',
        turn: context.state.turn,
        key: MEMORY_CITATIONS_KIND,
        value: { entries: context.state.entries },
      },
    }

    function ensureCitationStyles() {
      if (typeof document === 'undefined' || document.querySelector('style[data-stratagate-citations]')) return
      const style = document.createElement('style')
      style.dataset.stratagateCitations = 'true'
      style.textContent = citationCss
      document.head.appendChild(style)
    }

    function CitationSection({ title, children }) {
      if (children === null || children === undefined || children === '') return null
      return h('section', { className: 'sg-citation-section' }, h('h4', { className: 'sg-citation-section-title' }, title), children)
    }

    function CitationDisclosure({ title, children }) {
      if (children === null || children === undefined || children === '') return null
      return h('details', { className: 'sg-citation-disclosure' },
        h('summary', null, title),
        h('div', { className: 'sg-citation-disclosure-body' }, children))
    }

    function citationPreview(value, limit = 50) {
      const text = String(value || '').replace(/\s+/g, ' ').trim() || '暂无内容'
      return text.length > limit ? text.slice(0, limit) + '…' : text
    }

    function citationAdoptedFacts(citation, facts) {
      const activeFacts = facts.filter((fact) => !fact.status || fact.status === 'active')
      const factId = String(citation.evidenceRef || '').match(/:fact:([^:]+)$/)?.[1]
      if (factId) return activeFacts.filter((fact) => String(fact.id) === factId)
      return citation.expanded ? activeFacts : []
    }

    function CitationGraph({ citation, detail, primary, adopted = true }) {
      const containerRef = React.useRef(null)
      const graphRef = React.useRef(null)
      const center = detail?.node || primary
      const nodes = Array.isArray(detail?.nodes) && detail.nodes.length ? detail.nodes : center ? [center] : []
      const edges = Array.isArray(detail?.edges) ? detail.edges.filter((edge) => !edge.status || edge.status === 'active') : []
      const nodeMap = new Map(nodes.map((node) => [node.id, node]))
      const signature = JSON.stringify({
        center: center?.id,
        adopted,
        nodes: nodes.map((node) => [node.id, node.name, node.type]),
        edges: edges.map((edge) => [edge.id, edge.fromNodeId, edge.toNodeId, edge.relation]),
      })

      React.useEffect(() => {
        const container = containerRef.current
        if (!container || !cytoscape || !center || !nodes.length) return undefined
        const computed = getComputedStyle(container)
        const textColor = computed.getPropertyValue('--sg-text').trim() || '#0f1115'
        const mutedColor = computed.getPropertyValue('--sg-muted').trim() || '#64748b'
        const pageColor = computed.getPropertyValue('--sg-page').trim() || '#ffffff'
        const accentColor = computed.getPropertyValue('--sg-accent').trim() || '#4176e6'
        const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
        const graph = cytoscape({
          container,
          elements: [
            ...nodes.map((node) => {
              const meta = NODE_META[node.type] || ['实体', '#64748b', '•']
              return { data: { id: node.id, label: node.name, color: meta[1] }, classes: node.id === center.id ? adopted ? 'adopted' : 'retrieved' : 'related' }
            }),
            ...edges.filter((edge) => nodeMap.has(edge.fromNodeId) && nodeMap.has(edge.toNodeId)).map((edge) => ({ data: { id: 'citation-edge-' + edge.id, source: edge.fromNodeId, target: edge.toNodeId, label: edge.relation } })),
          ],
          userZoomingEnabled: true,
          userPanningEnabled: true,
          minZoom: .45,
          maxZoom: 2.2,
          wheelSensitivity: .22,
          style: [
            { selector: 'node', style: { width: 62, height: 62, 'background-color': 'data(color)', 'background-opacity': .2, 'border-color': 'data(color)', 'border-width': 1.5, label: 'data(label)', color: textColor, 'font-size': 11, 'font-weight': 650, 'text-wrap': 'wrap', 'text-max-width': 86, 'text-valign': 'center', 'text-halign': 'center', 'overlay-opacity': 0 } },
            { selector: 'node.adopted', style: { width: 76, height: 76, 'border-width': 4, 'border-color': accentColor, 'underlay-color': accentColor, 'underlay-opacity': .16, 'underlay-padding': 7 } },
            { selector: 'node.retrieved', style: { width: 72, height: 72, 'border-width': 3, 'border-color': mutedColor, 'border-style': 'dashed', 'underlay-color': mutedColor, 'underlay-opacity': .08, 'underlay-padding': 6 } },
            { selector: 'node.related', style: { opacity: .78 } },
            { selector: 'edge', style: { width: 1.4, 'line-color': mutedColor, 'target-arrow-color': mutedColor, 'target-arrow-shape': 'triangle', 'curve-style': 'bezier', opacity: .68, label: 'data(label)', color: textColor, 'font-size': 10, 'text-background-color': pageColor, 'text-background-opacity': .9, 'text-background-padding': '2px', 'text-rotation': 'autorotate', 'arrow-scale': .75, 'overlay-opacity': 0 } },
          ],
        })
        graphRef.current = graph
        graph.layout({ name: 'concentric', concentric: (node) => node.id() === center.id ? 2 : 1, levelWidth: () => 1, minNodeSpacing: 36, animate: reduceMotion ? false : true, animationDuration: reduceMotion ? 0 : 220, fit: true, padding: 48 }).run()
        const resizeObserver = globalThis.ResizeObserver ? new globalThis.ResizeObserver(() => graph.resize()) : null
        resizeObserver?.observe(container)
        return () => { resizeObserver?.disconnect(); graphRef.current = null; graph.destroy() }
      }, [signature])

      if (!center) return null
      return h('div', { className: 'sg-citation-graph' },
        h('div', { className: 'sg-citation-graph-frame' },
          cytoscape ? h('div', { ref: containerRef, className: 'sg-citation-graph-canvas' }) : h('div', { className: 'sg-citation-graph-fallback' }, edges.map((edge) => h('div', { key: edge.id, className: 'sg-citation-relation' }, h('strong', null, nodeMap.get(edge.fromNodeId)?.name || edge.fromNodeId), h('span', null, edge.relation), h('strong', null, nodeMap.get(edge.toNodeId)?.name || edge.toNodeId)))),
          h('div', { className: 'sg-citation-graph-a11y' }, (adopted ? '采用节点：' : '检索候选：') + center.name + '。关联节点：' + nodes.filter((node) => node.id !== center.id).map((node) => node.name).join('、'))),
        h('p', { className: 'sg-citation-graph-note' }, adopted
          ? citation.expanded
            ? '高亮节点及展开结果为本次采用内容；周边节点帮助理解关系。'
            : '高亮节点为本次采用内容；周边节点为点击后加载的关联信息，不进入本次上下文。'
          : '高亮节点是本次检索到的候选；它未参与回答，周边节点仅用于理解关系。'))
    }

    function CitationLayers({ citation, layers, adopted = true }) {
      const layerMap = new Map(layers.map((layer) => [Number(layer.level), layer]))
      const selectedLevel = Number.isInteger(citation.level) ? Number(citation.level) : String(citation.evidenceRef || '').startsWith('raw:') ? 5 : null
      return h('div', { className: 'sg-citation-layers' }, [0, 1, 2, 3, 4, 5].map((level) => {
        const layer = layerMap.get(level)
        const content = String(layer?.content || '尚未生成')
        const selected = selectedLevel === level
        const state = selected ? adopted ? 'adopted' : 'retrieved' : ''
        return h('div', { key: level, className: 'sg-citation-layer ' + state, title: selected ? undefined : content },
          h('span', { className: 'sg-citation-layer-level' }, 'L' + level),
          h('div', { className: 'sg-citation-layer-content' }, selected ? content : citationPreview(content), selected ? h('span', { className: 'sg-citation-layer-state ' + (adopted ? '' : 'retrieved') }, adopted ? '本次采用' : '本次检索 · 未采用') : null))
      }))
    }

    function CitationDetail({ citation, detail, adopted = true, onNode }) {
      const messages = Array.isArray(detail?.messages) ? detail.messages : []
      const sourceMessages = Array.isArray(detail?.sourceMessages) ? detail.sourceMessages : messages
      let primary = null
      let facts = []
      if (citation.kind === 'event') primary = (detail?.events || []).find((item) => item.id === citation.id) || detail?.events?.[0]
      else if (citation.detailKind === 'nodeId') {
        primary = detail?.node
        facts = Array.isArray(primary?.facts) ? primary.facts : []
      } else if (citation.detailKind === 'elementId') {
        primary = (detail?.elements || []).find((item) => item.id === citation.id) || detail?.elements?.[0]
        facts = Array.isArray(primary?.facts) ? primary.facts : []
      }
      const selectedLayer = citation.kind === 'block' && Array.isArray(detail?.layers)
        ? detail.layers.find((layer) => Number(layer.level) === Number(citation.level)) || detail.layers.at(-1)
        : null
      const summary = citation.kind === 'event'
        ? primary?.summary
        : citation.kind === 'graph'
          ? primary?.currentState
          : selectedLayer?.content
      const adoptedFacts = citationAdoptedFacts(citation, facts)
      const relatedEvents = (Array.isArray(detail?.events) ? detail.events : []).filter((event) => citation.kind !== 'event' || event.id !== primary?.id)
      const primaryTitle = adopted ? '已用于回答' : '检索候选 · 未采用'
      return h(React.Fragment, null,
        !adopted ? h('p', { className: 'sg-citation-context-note' }, '这是本次检索到的候选记忆，但它没有参与回答。关联信息与来源内容仅供核对。') : null,
        citation.kind === 'graph' ? h(CitationSection, { title: primaryTitle },
          summary ? h('p', { className: 'sg-citation-copy' }, summary) : null,
          adoptedFacts.length ? h('ul', { className: 'sg-citation-facts' }, adoptedFacts.map((fact, index) => h('li', { key: fact.id || index, className: 'sg-citation-fact' }, h('strong', null, String(fact.key || '事实') + '：'), Array.isArray(fact.value) ? fact.value.join('、') : String(fact.value || '')))) : null,
          h(CitationGraph, { citation, detail, primary, adopted })) : null,
        citation.kind === 'event' && primary ? h(EventMemoryDetails, { event: primary, sourceMessages, citation, relatedEvents }) : null,
        citation.kind === 'block' ? h(CitationSection, { title: 'L0–L5 记忆层级' }, h(CitationLayers, { citation, layers: Array.isArray(detail?.layers) ? detail.layers : [], adopted })) : null,
        citation.kind !== 'event' && relatedEvents.length ? h(CitationDisclosure, { title: '关联信息' }, h('div', { className: 'sg-citation-events' }, relatedEvents.map((event, index) => h('article', { key: event.id || index, className: 'sg-citation-event' }, h('strong', null, event.title || '关联事件'), h('p', null, event.summary || '暂无摘要'))))) : null,
        citation.kind !== 'event' && sourceMessages.length ? h(CitationDisclosure, { title: '来源与证据' }, h('div', { className: 'sg-citation-messages' }, sourceMessages.map((message, index) => h('div', { key: message.id || index, className: 'sg-citation-message' }, h('span', { className: 'sg-citation-message-role' }, message.role || 'message'), String(message.content || ''))))) : null,
        citation.kind !== 'event' ? h(CitationDisclosure, { title: '技术信息' }, h('div', { className: 'sg-citation-tech' }, citation.evidenceRef + '\n' + citation.detailKind + ': ' + citation.id)) : null)
    }

    const shortTermMemoryFeeds = new Map()
    const SHORT_TERM_POLL_WINDOW_MS = 120_000

    function shortTermLayerName(level) {
      return ['索引', '摘要', '关键事实', '精简对话', '近原文', '原文'][Number(level)] || '会话视图'
    }

    function shortTermFeed(sessionId) {
      let feed = shortTermMemoryFeeds.get(sessionId)
      if (feed) return feed
      feed = {
        sessionId,
        snapshot: { payload: null, loading: true, error: '' },
        listeners: new Set(),
        request: null,
        controller: null,
        namespace: '',
        workspacePath: '',
        signal: '',
        queuedWorkspacePath: '',
        queuedSignal: '',
        pollTimer: null,
        pollSignal: '',
        pollUntil: 0,
      }
      shortTermMemoryFeeds.set(sessionId, feed)
      return feed
    }

    function publishShortTermFeed(feed, patch) {
      feed.snapshot = { ...feed.snapshot, ...patch }
      for (const listener of feed.listeners) listener(feed.snapshot)
    }

    function sessionWorkspacePath(sessionId, sessionById, workspaceItems) {
      let candidateId = sessionId
      const visited = new Set()
      while (candidateId && !visited.has(candidateId)) {
        visited.add(candidateId)
        const workspace = workspaceItems.find((item) => (item.sessionIds || []).some((id) => String(id) === candidateId))
        if (workspace?.path) return workspace.path
        candidateId = sessionById[candidateId]?.parentId || ''
      }
      return sessionById[sessionId]?.cwd || ''
    }

    function shortTermBlocks(data) {
      if (Array.isArray(data?.blocks)) return data.blocks
      return Array.isArray(data?.items) ? data.items : []
    }

    function shortTermBlockNumber(block) {
      return Number(block?.blockIndex || block?.sequence || 1)
    }

    function shortTermTurnRangeText(range) {
      if (!Array.isArray(range) || range.length < 2 || Number(range[1]) < Number(range[0])) return '等待新对话'
      return '第 ' + Number(range[0]) + '–' + Number(range[1]) + ' 轮'
    }

    function shortTermDisplayLabel(display) {
      if (display.kind === 'progress') return '会话记忆 · ' + display.current + '/' + display.capacity
      if (display.kind === 'processing') return '已封块 ' + display.current + '/' + display.capacity + ' · 正在压缩…'
      if (display.kind === 'failed') return shortTermTurnRangeText(display.block.turnRange) + ' · 压缩暂不可用'
      return 'Block ' + shortTermBlockNumber(display.block) + ' · ' + shortTermTurnRangeText(display.block.turnRange)
        + ' · 已压缩为 L' + Number(display.block.currentLevel) + ' · ' + Number(display.block.compressionPercent ?? 0) + '%'
    }

    function strataGateStatusVisible(settingsSnapshot) {
      return settingsSnapshot?.value?.showStrataGateStatus !== false
    }

    function shortTermStatusVisible(settingsSnapshot) {
      return strataGateStatusVisible(settingsSnapshot)
        && settingsSnapshot?.value?.showShortTermStatus !== false
    }

    function retrievalStatusVisible(settingsSnapshot) {
      return strataGateStatusVisible(settingsSnapshot)
        && settingsSnapshot?.value?.showRetrievalStatus !== false
    }

    function shortTermNeedsPolling(payload, signal) {
      const data = payload?.data
      const blocks = shortTermBlocks(data)
      if (blocks.some((block) => block.processingStatus === 'pending'
        && !summaryUnavailable(block))) return true
      const match = /^(\d+):idle$/.exec(signal)
      if (!match || !data) return false
      const turn = Number(match[1])
      if (blocks.some((block) => Number(block.turnRange?.[1]) === turn)) return false
      const open = data.openBlock
      const capacity = Number(open?.capacity || data.blockTurnSize || 6)
      const count = Number(open?.turns || 0)
      const lastTurn = Number(open?.turnRange?.[1])
      return capacity > 0 && ((lastTurn === turn - 1 && count === capacity - 1)
        || (lastTurn === turn && count >= capacity))
    }

    function scheduleShortTermPoll(feed) {
      if (feed.pollTimer !== null || feed.listeners.size === 0 || Date.now() >= feed.pollUntil) return
      feed.pollTimer = window.setTimeout(() => {
        feed.pollTimer = null
        void refreshShortTermFeed(feed, feed.workspacePath, feed.signal, true)
      }, 1_200)
    }

    function loadSessionBlocks(namespace, sessionId, signal, offset = 0, items = []) {
      return api('memories', { namespace, kind: 'blocks', threadId: sessionId, offset, limit: 200 }, { signal }).then((page) => {
        const combined = [...items, ...(page.items || [])]
        return combined.length < Number(page.total || 0)
          ? loadSessionBlocks(namespace, sessionId, signal, combined.length, combined)
          : { ...page, items: combined }
      })
    }

    function refreshShortTermFeed(feed, workspacePath, signal, force = false) {
      if (!workspacePath) {
        publishShortTermFeed(feed, { loading: false, error: '无法确定当前会话所属的工作区。' })
        return Promise.resolve()
      }
      const workspaceChanged = feed.workspacePath !== workspacePath
      if (!force && !workspaceChanged && feed.signal === signal && feed.snapshot.payload) return feed.request || Promise.resolve()
      if (feed.pollSignal !== signal || workspaceChanged) {
        feed.pollSignal = signal
        feed.pollUntil = Date.now() + SHORT_TERM_POLL_WINDOW_MS
      }
      if (feed.request) {
        if (workspaceChanged || feed.signal !== signal) {
          feed.queuedWorkspacePath = workspacePath
          feed.queuedSignal = signal
        }
        return feed.request
      }
      if (feed.pollTimer !== null) {
        window.clearTimeout(feed.pollTimer)
        feed.pollTimer = null
      }
      if (workspaceChanged) {
        feed.workspacePath = workspacePath
        feed.namespace = ''
        publishShortTermFeed(feed, { payload: null, loading: true, error: '' })
      } else if (!feed.snapshot.payload) {
        publishShortTermFeed(feed, { loading: true, error: '' })
      }
      feed.signal = signal
      const controller = new AbortController()
      feed.controller = controller
      const run = workspaceProjectKey(workspacePath).then((projectKey) => {
        if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError')
        if (!projectKey) throw new Error('无法读取当前会话的工作区标识。')
        const namespace = 'dsh:project:' + projectKey
        feed.namespace = namespace
        return loadSessionBlocks(namespace, feed.sessionId, controller.signal)
      }).then((data) => {
        const payload = data?.activeThreadId === feed.sessionId ? { namespace: feed.namespace, data } : null
        publishShortTermFeed(feed, { payload, loading: false, error: '' })
        if (shortTermNeedsPolling(feed.snapshot.payload, feed.signal)) scheduleShortTermPoll(feed)
      }).catch((reason) => {
        if (reason?.name !== 'AbortError') publishShortTermFeed(feed, { loading: false, error: String(reason?.message || reason) })
      }).finally(() => {
        if (feed.controller === controller) feed.controller = null
        if (feed.request === run) feed.request = null
        const queuedWorkspacePath = feed.queuedWorkspacePath
        const queuedSignal = feed.queuedSignal
        feed.queuedWorkspacePath = ''
        feed.queuedSignal = ''
        if (queuedWorkspacePath && (queuedWorkspacePath !== feed.workspacePath || queuedSignal !== feed.signal)) {
          void refreshShortTermFeed(feed, queuedWorkspacePath, queuedSignal, true)
        }
      })
      feed.request = run
      return run
    }

    function shortTermTurnDisplay(data, turn) {
      const block = shortTermBlocks(data).find((item) => Array.isArray(item.turnRange) && Number(item.turnRange[1]) === Number(turn))
      if (block) {
        if (block.processingStatus === 'ready') return { kind: 'block', block }
        const failed = summaryUnavailable(block)
        return { kind: failed ? 'failed' : 'processing', block, current: block.turnRange[1] - block.turnRange[0] + 1, capacity: data.blockTurnSize || 6 }
      }
      const open = data?.openBlock
      if (!Array.isArray(open?.turnRange) || Number(open.turnRange[1]) !== Number(turn)) return null
      const current = Math.max(0, Number(open.turns ?? (open.turnRange[1] - open.turnRange[0] + 1)))
      const capacity = Math.max(1, Number(open.capacity || data.blockTurnSize || 6))
      return current >= capacity
        ? { kind: 'processing', block: null, current, capacity }
        : { kind: 'progress', block: null, current, capacity }
    }

    function useShortTermMemoryFeed(sessionId, workspacePath, signal) {
      const feed = shortTermFeed(sessionId)
      const [state, setState] = React.useState(() => feed.snapshot)
      React.useEffect(() => {
        feed.listeners.add(setState)
        setState(feed.snapshot)
        return () => {
          feed.listeners.delete(setState)
          if (feed.listeners.size === 0) {
            if (feed.pollTimer !== null) {
              window.clearTimeout(feed.pollTimer)
              feed.pollTimer = null
            }
            feed.controller?.abort()
            feed.controller = null
            feed.queuedWorkspacePath = ''
            feed.queuedSignal = ''
          }
        }
      }, [feed])
      React.useEffect(() => {
        void refreshShortTermFeed(feed, workspacePath, signal, true)
      }, [feed, workspacePath, signal])
      return state
    }

    function ShortTermMemoryBlockDetail({ namespace, block }) {
      const actualLayer = Number(block.currentLevel)
      const [selectedPreviewLayer, setSelectedPreviewLayer] = React.useState(actualLayer)
      const [detail, setDetail] = React.useState(null)
      const [loading, setLoading] = React.useState(true)
      const [error, setError] = React.useState('')
      React.useEffect(() => {
        setSelectedPreviewLayer(actualLayer)
        setDetail(null)
        setLoading(true)
        setError('')
        const controller = new AbortController()
        void api('sources', { namespace, blockId: block.id }, { signal: controller.signal })
          .then(setDetail)
          .catch((reason) => { if (reason?.name !== 'AbortError') setError(String(reason?.message || reason)) })
          .finally(() => { if (!controller.signal.aborted) setLoading(false) })
        return () => controller.abort()
      }, [namespace, block.id])

      const layerMetrics = new Map((block.layerTokens || []).map((layer) => [Number(layer.level), layer]))
      const layers = new Map((detail?.layers || []).map((layer) => [Number(layer.level), layer]))
      const preview = layers.get(selectedPreviewLayer)
      const previewMetrics = preview || layerMetrics.get(selectedPreviewLayer) || { tokens: 0, percentOfL5: selectedPreviewLayer === 5 ? 100 : 0 }
      return h('section', { className: 'sg-stm-detail', 'aria-label': '会话记忆详情' },
        h('div', { className: 'sg-stm-detail-head' },
          h('strong', null, 'Block ' + Number(block.blockIndex || block.sequence || 1) + ' · ' + shortTermTurnRangeText(block.turnRange)),
          h('span', null, '原文一直保留；选择层级只切换预览')),
        h('div', { className: 'sg-stm-facts' },
          h('span', null, '当前使用：', h('strong', null, 'L' + actualLayer)),
          h('span', null, '压缩至：', h('strong', null, Number(block.compressionPercent ?? 0) + '%')),
          h('span', null, h('strong', null, Number(block.currentTokens || 0) + ' / ' + Number(block.l5Tokens || 0)), ' tokens')),
        h('div', { className: 'sg-stm-layers', role: 'tablist', 'aria-label': '同一会话块的六层压缩视图' }, [5, 4, 3, 2, 1, 0].map((level) => {
          const metrics = layerMetrics.get(level) || { tokens: 0, percentOfL5: level === 5 ? 100 : 0 }
          const available = !loading && layers.has(level)
          return h('button', {
            key: level,
            type: 'button',
            role: 'tab',
            className: 'sg-stm-layer ' + (level === actualLayer ? 'actual ' : '') + (level === selectedPreviewLayer ? 'selected' : ''),
            'aria-selected': level === selectedPreviewLayer,
            disabled: !available,
            title: 'L' + level + ' · ' + shortTermLayerName(level) + ' · ' + Number(metrics.tokens || 0) + ' tokens · L5 的 ' + Number(metrics.percentOfL5 ?? 0) + '%',
            onClick: () => setSelectedPreviewLayer(level),
          },
          h('span', { className: 'sg-stm-layer-level' }, 'L' + level),
          h('span', { className: 'sg-stm-layer-name' }, shortTermLayerName(level)),
          h('span', { className: 'sg-stm-layer-size' }, Number(metrics.tokens || 0) + 't · ' + Number(metrics.percentOfL5 ?? 0) + '%'),
          h('span', { className: 'sg-stm-layer-current' }, level === actualLayer ? '当前使用' : ''))
        })),
        loading ? h('div', { className: 'sg-stm-loading', role: 'status' }, '正在读取 L0–L5…')
          : error ? h('div', { className: 'sg-stm-error' }, '暂时无法读取会话压缩视图：' + error)
            : preview ? h('div', { className: 'sg-stm-preview', role: 'tabpanel' },
              h('div', { className: 'sg-stm-preview-head' },
                h('strong', null, 'L' + selectedPreviewLayer + ' · ' + shortTermLayerName(selectedPreviewLayer)),
                h('span', null, Number(previewMetrics.tokens || 0) + ' tokens · ' + (selectedPreviewLayer === 5 ? '100%' : 'L5 的 ' + Number(previewMetrics.percentOfL5 ?? 0) + '%'))),
              h('pre', { className: 'sg-stm-content' }, preview.content)) : null)
    }

    function ShortTermMemoryTurnStatus({ matched, sessionId, useSession, useSessions, useWorkspaces }) {
      const sessionById = useSessions((state) => state.byId || {})
      const workspaceItems = useWorkspaces((state) => state.items || [])
      const sessionSignal = useSession((state) => {
        let latestTurn = 0
        for (const turn of state.turnEnds?.keys?.() || []) latestTurn = Math.max(latestTurn, Number(turn) || 0)
        return String(latestTurn) + ':' + (state.running ? 'running' : 'idle')
      })
      const workspacePath = sessionWorkspacePath(sessionId, sessionById, workspaceItems)
      const feed = useShortTermMemoryFeed(sessionId, workspacePath, sessionSignal)
      const data = feed.payload?.data
      const display = shortTermTurnDisplay(data, matched.turn)
      const [expanded, setExpanded] = React.useState(false)
      React.useEffect(() => {
        if (display?.kind !== 'block') setExpanded(false)
      }, [display?.kind, display?.block?.id])
      if (!display) return null
      const rule = () => h('span', { className: 'sg-stm-rule', 'aria-hidden': 'true' })
      if (display.kind === 'progress') return h('div', { className: 'sg-stm', 'data-testid': 'stratagate-short-term-progress' },
        h('div', { className: 'sg-stm-line', role: 'status' }, rule(), h('span', { className: 'sg-stm-line-copy' }, shortTermDisplayLabel(display)), rule()))
      if (display.kind === 'processing') return h('div', { className: 'sg-stm', 'data-testid': 'stratagate-short-term-processing' },
        h('div', { className: 'sg-stm-line processing', role: 'status', 'aria-live': 'polite' }, rule(), h('span', { className: 'sg-stm-line-copy' }, shortTermDisplayLabel(display)), rule()))
      if (display.kind === 'failed') return null
      const block = display.block
      return h('div', { className: 'sg-stm', 'data-testid': 'stratagate-short-term-block', 'data-block-id': block.id },
        h('div', { className: 'sg-stm-line' }, rule(),
          h('button', { type: 'button', className: 'sg-stm-toggle', 'aria-expanded': expanded, onClick: () => setExpanded((value) => !value) },
            shortTermDisplayLabel(display),
            h('span', { className: 'sg-stm-chevron ' + (expanded ? 'open' : ''), 'aria-hidden': 'true' }, '›')), rule()),
        expanded ? h(ShortTermMemoryBlockDetail, { namespace: feed.payload.namespace, block }) : null)
    }

    function RetrievalProcessPanel({ retrievalGroups, retrievedCount, citations, open }) {
      const adoptedRefs = new Set(citations.map((citation) => citation.evidenceRef))
      return h('section', { className: 'sg-retrieved-panel', 'aria-label': '本次记忆检索过程' },
        h('div', { className: 'sg-retrieved-heading' },
          h('strong', null, '检索过程'),
          h('span', null, retrievalGroups.length + ' 轮 · 共返回 ' + retrievedCount + ' 条')),
        retrievalGroups.map((group, groupIndex) => {
          const gateLabel = evidenceGateLabel(group)
          return h('details', { key: group.batchId || group.seq, className: 'sg-retrieved-group' },
            h('summary', null,
              h('span', { className: 'sg-retrieved-group-title' }, retrievalGroupLabel(groupIndex) + ' · 返回 ' + group.count + ' 条'),
              gateLabel ? h('span', { className: 'sg-retrieved-gate ' + (group.verdict === 'sufficient' ? 'sufficient' : '') }, gateLabel) : null),
            group.memories.length ? h('ol', { className: 'sg-retrieved-list' }, group.memories.map((memory, memoryIndex) => {
              const action = citationActionLabel(memory)
              const adopted = adoptedRefs.has(memory.evidenceRef)
              const state = adopted ? '最终采用' : '检索到 · 未采用'
              return h('li', { key: memory.batchId + ':' + memory.evidenceRef }, h('button', { type: 'button', className: 'sg-retrieved-memory', title: memory.evidenceRef, onClick: () => open(memory, adopted) },
                h('span', { className: 'sg-retrieved-index', 'aria-hidden': 'true' }, memoryIndex + 1 + '.'),
                h('span', { className: 'sg-retrieved-memory-kind' }, citationKindLabel(memory)),
                h('span', { className: 'sg-retrieved-memory-title' }, memory.title),
                h('span', { className: 'sg-retrieved-memory-state' }, action ? action + ' · ' + state : state)))
            })) : h('div', { className: 'sg-retrieved-unavailable' }, group.count === 0 ? '本轮检索没有返回匹配记忆。' : '这条历史回执未保存候选摘要。'))
        }),
        h('div', { className: 'sg-retrieved-final' }, h('span', null, '最终采用 ' + citations.length + ' 条'), h('span', null, '检索命中不会自动强化记忆')))
    }

    function MemoryCitationTail({ matched, turn, seq, sessionId, useSession, useSessions, useWorkspaces, usePluginSettings, onOpenGraphNode }) {
      // DSH 0.1.7 renders this list slot with owner props; older chain slots supply matched.
      matched = matched || selectMemoryCitations({ turn, seq })
      const citations = matched.citations
      const retrievedCount = matched.retrievedCount
      const retrievalGroups = matched.retrievalGroups
      const pluginSettings = usePluginSettings ? usePluginSettings((state) => state) : null
      const [showRetrieved, setShowRetrieved] = React.useState(false)
      const [selected, setSelected] = React.useState(null)
      const [detail, setDetail] = React.useState(null)
      const [loading, setLoading] = React.useState(false)
      const [error, setError] = React.useState('')
      const close = () => { setSelected(null); setDetail(null); setError(''); setLoading(false) }
      const openGraphNode = (nodeId, event) => {
        event?.stopPropagation?.()
        const namespace = selected?.namespace
        if (!namespace || !nodeId || typeof onOpenGraphNode !== 'function') {
          setError('暂时无法打开对应的知识图谱节点，请稍后重试。')
          return
        }
        setError('')
        Promise.resolve(onOpenGraphNode(namespace, nodeId)).then((opened) => {
          if (opened === false) {
            setError('暂时无法打开对应的知识图谱节点，请稍后重试。')
            return
          }
          close()
        }).catch((reason) => setError('暂时无法打开对应的知识图谱节点：' + String(reason?.message || reason)))
      }
      const open = (citation, adopted = true) => {
        setSelected({ ...citation, adopted })
        setDetail(null)
        setError('')
        setLoading(true)
        void api('sources', { namespace: citation.namespace, [citation.detailKind]: citation.id })
          .then(setDetail)
          .catch((reason) => setError(String(reason?.message || reason)))
          .finally(() => setLoading(false))
      }
      React.useEffect(() => {
        if (!selected) return undefined
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return
          if (document.querySelector('.sg-citation-dialog .sg-info-trigger[aria-expanded="true"]')) return
          close()
        }
        document.addEventListener('keydown', onKeyDown)
        return () => document.removeEventListener('keydown', onKeyDown)
      }, [selected])
      return h(React.Fragment, null,
        shortTermStatusVisible(pluginSettings)
          ? h(ShortTermMemoryTurnStatus, { matched, sessionId, useSession, useSessions, useWorkspaces })
          : null,
        retrievalStatusVisible(pluginSettings) && citations.length ? h('div', { className: 'sg-answer-citations', 'data-testid': 'stratagate-answer-citations' },
          h('div', { className: 'sg-answer-citations-head' },
            h('span', { className: 'sg-answer-citations-label' }, '本回答采用了 ' + citations.length + ' 条记忆'),
            retrievalGroups.length ? h('button', { type: 'button', className: 'sg-answer-process-link', 'aria-expanded': showRetrieved, onClick: () => setShowRetrieved((value) => !value) },
              h('span', null, '· 查看检索过程'),
              h('span', { className: 'sg-answer-retrieval-chevron ' + (showRetrieved ? 'open' : ''), 'aria-hidden': 'true' }, '›')) : null),
          h('div', { className: 'sg-answer-citations-list' }, citations.map((citation) => {
            const action = citationActionLabel(citation)
            return h('button', { key: citation.batchId + ':' + citation.evidenceRef, type: 'button', className: 'sg-answer-citation', title: citation.evidenceRef, onClick: () => open(citation, true) },
              h('span', { className: 'sg-answer-citation-kind' }, citationKindLabel(citation)),
              h('span', { className: 'sg-answer-citation-title' }, citation.title),
              action ? h('span', { className: 'sg-answer-citation-action' }, action) : null)
          })),
          showRetrieved && retrievalGroups.length ? h(RetrievalProcessPanel, { retrievalGroups, retrievedCount, citations, open }) : null) : null,
        retrievalStatusVisible(pluginSettings) && citations.length === 0 && retrievalGroups.length > 0 ? h('div', { className: 'sg-answer-retrieval', 'data-testid': 'stratagate-answer-retrieval-note' },
          h('button', { type: 'button', className: 'sg-answer-retrieval-toggle', 'aria-expanded': showRetrieved, onClick: () => setShowRetrieved((value) => !value) },
            h('span', null, '检索 ' + retrievalGroups.length + ' 轮 · 返回 ' + retrievedCount + ' 条 · 未采用'),
            h('span', { className: 'sg-answer-retrieval-chevron ' + (showRetrieved ? 'open' : ''), 'aria-hidden': 'true' }, '›')),
          showRetrieved ? h(RetrievalProcessPanel, { retrievalGroups, retrievedCount, citations, open }) : null) : null,
        retrievalStatusVisible(pluginSettings) && selected ? h('div', { className: 'sg-citation-overlay', onMouseDown: (event) => { if (event.target === event.currentTarget) close() } },
          h(InfoPopoverGroup, null, h('section', { className: 'sg-citation-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': citationKindLabel(selected) + ' 详情' },
            h('header', { className: 'sg-citation-dialog-head' },
              h('div', { className: 'sg-citation-dialog-heading' }, h('div', { className: 'sg-citation-dialog-kicker' }, citationKindLabel(selected)), h('h3', { className: 'sg-citation-dialog-title' }, (selected.kind === 'event' ? detail?.events?.find((item) => item.id === selected.id)?.title || detail?.events?.[0]?.title : '') || selected.title), selected.kind === 'event' ? h(EventMetadata, { event: detail?.events?.find((item) => item.id === selected.id) || detail?.events?.[0], nodes: detail?.relatedNodes || [], onNode: openGraphNode }) : null),
              h('div', { className: 'sg-citation-dialog-actions' },
                h('span', { className: 'sg-citation-status ' + (selected.adopted ? 'adopted' : 'retrieved') }, selected.adopted ? '已用于回答' : '检索候选 · 未采用'),
                selected.adopted ? h(InfoPopover, { label: '本次采用说明', className: 'sg-status-info' }, h('p', null, '只有标记为本次采用的记忆内容参与了本次回答；关联信息和来源内容仅用于查看与追溯依据。')) : null,
                h('button', { type: 'button', className: 'sg-citation-close', onClick: close, 'aria-label': '关闭记忆详情' }, '×'))),
            h('div', { className: 'sg-citation-dialog-body' }, loading ? h('div', { className: 'sg-citation-loading' }, '正在读取来源…') : error ? h('div', { className: 'sg-citation-error' }, error) : h(CitationDetail, { citation: selected, detail, adopted: selected.adopted, onNode: openGraphNode }))))) : null)
    }

