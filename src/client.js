// StrataGate AgentMemory UI for DSH.
window.__ModuleLoader__.load({
  id: 'stratagate-dsh',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const React = require('react')
    const h = React.createElement
    const cytoscape = globalThis.__StrataGateGraphLibraries?.cytoscape
    // Local AI feedback drafts stay available while GitHub navigation is dormant.
    // The client build checks Agent/client parity independently of the GitHub gate.
    const AGENT_FEEDBACK_ENABLED = true
    const GITHUB_FEEDBACK_ENABLED = true
    const FEEDBACK_EMAIL = 'jiahongcheng61@gmail.com'
    const EMAIL_BODY_HINT = '请在下方粘贴 StrataGate 反馈报告，检查后发送。也可以手动附加已下载的诊断文件。\r\n\r\n'
    const STAR_REPOSITORY_URL = 'https://github.com/diqierjia/StrataGate-AgentMemory'
    const ISSUE_URL = STAR_REPOSITORY_URL + '/issues/new'
    const DISCUSSION_URL = STAR_REPOSITORY_URL + '/discussions/categories/q-a'
    const FEEDBACK_AI_PROMPT = '请根据当前会话中 StrataGate 插件的故障、使用疑问或改进建议整理反馈。只用已知事实，不要猜测，未知留空，去除凭据。调用 feedback_prepare 保存本地草稿；新问题传 new_draft=true。诊断由程序自动补充。给我“打开反馈草稿”的链接，我会检查后手动发邮件。'
    const FEEDBACK_SETTINGS_ID = 'stratagate-memory'
    const FEEDBACK_VIEW_ID = 'feedback'
    const MEMORY_PANEL_ID = 'stratagate-memory'
    const SIDEBAR_PROMPT_STORAGE_KEY = 'stratagate-dsh.sidebar-prompt.v1'
    const SIDEBAR_PROMPT_STYLES = `.sg-sidebar-panel-icon{display:block;flex-shrink:0}.sg-sidebar-placement-prompt{display:inline-flex;align-items:center;gap:8px;flex-wrap:wrap;max-width:100%;font-size:11px;line-height:1.5;color:var(--sg-muted)}.sg-sidebar-placement-text{min-width:0}.sg-memory .sg-sidebar-placement-action{padding:0;border:0;background:transparent;color:var(--sg-accent);font-size:11px;line-height:1.5;cursor:pointer;white-space:nowrap}.sg-sidebar-placement-action:hover{text-decoration:underline}.sg-memory .sg-sidebar-placement-close{display:inline-grid;place-items:center;width:20px;height:20px;flex:none;padding:0;border:0;border-radius:4px;background:transparent;color:var(--sg-muted);font-size:15px;line-height:1;cursor:pointer}.sg-sidebar-placement-close:hover{background:var(--sg-soft);color:var(--sg-text)}`
    let pendingFeedbackNavigation = null
    const feedbackNavigationListeners = new Set()

    function setFeedbackNavigation(state) {
      pendingFeedbackNavigation = state
      for (const listener of feedbackNavigationListeners) listener(state)
      if (feedbackNavigationListeners.size) pendingFeedbackNavigation = null
    }

    function FeedbackSettingsPage(props) {
      const [navigationState, setNavigationState] = React.useState(() => pendingFeedbackNavigation)
      React.useEffect(() => {
        feedbackNavigationListeners.add(setNavigationState)
        if (pendingFeedbackNavigation) setNavigationState(pendingFeedbackNavigation)
        pendingFeedbackNavigation = null
        return () => feedbackNavigationListeners.delete(setNavigationState)
      }, [])
      return h(MemoryPage, { ...props, navigationState: navigationState || props.navigationState })
    }
    const ISSUE_BODY_HINT = '> 请在下方粘贴 StrataGate 反馈报告（Ctrl+V / ⌘V），检查后提交。若无法粘贴，请返回 StrataGate 手动复制报告。\n\n'
    const STRATAGATE_CLIENT_VERSION = '__STRATAGATE_CLIENT_VERSION__'
    const MEMORY_CITATIONS_KIND = 'stratagate-memory-citations'
    const MEMORY_RETRIEVAL_TOOLS = new Set([
      'memory_search_events', 'memory_search_graph', 'memory_expand_graph_node',
      'memory_search_elements', 'memory_search_raw', 'memory_get_blocks',
      'memory_expand_block', 'memory_expand_event', 'memory_expand_element',
    ])

    function readFeedbackDeepLink(locationRef = window.location) {
      const params = new URLSearchParams(String(locationRef?.search || ''))
      if (params.get('settings') !== FEEDBACK_SETTINGS_ID || params.get('stratagateView') !== FEEDBACK_VIEW_ID) return null
      const namespace = String(params.get('namespace') || '').trim()
      return namespace ? { namespace } : null
    }

    function readFeedbackNavigationState(state) {
      if (!state || state.view !== FEEDBACK_VIEW_ID) return null
      const namespace = String(state.namespace || '').trim()
      return namespace ? { namespace } : null
    }

    function readNewFeedbackNavigationState(previousState, state) {
      if (state === previousState) return null
      return readFeedbackNavigationState(state)
    }

    function readGraphNodeNavigationState(state) {
      if (!state || state.view !== 'graph-node') return null
      const namespace = String(state.namespace || '').trim()
      const nodeId = String(state.nodeId || '').trim()
      return namespace && nodeId ? { namespace, nodeId } : null
    }

    function readGraphNodeDeepLink(locationRef = window.location) {
      const params = new URLSearchParams(String(locationRef?.search || ''))
      if (params.get('settings') !== FEEDBACK_SETTINGS_ID || params.get('stratagateView') !== 'graph-node') return null
      const namespace = String(params.get('namespace') || '').trim()
      const nodeId = String(params.get('nodeId') || '').trim()
      return namespace && nodeId ? { namespace, nodeId } : null
    }

    function consumeFeedbackDeepLink(locationRef = window.location, historyRef = window.history) {
      const params = new URLSearchParams(String(locationRef?.search || ''))
      params.delete('settings')
      params.delete('stratagateView')
      params.delete('namespace')
      const search = params.toString()
      const next = String(locationRef?.pathname || '/') + (search ? '?' + search : '') + String(locationRef?.hash || '')
      historyRef?.replaceState?.(historyRef.state, '', next)
      return next
    }

    function consumeGraphNodeDeepLink(locationRef = window.location, historyRef = window.history) {
      const params = new URLSearchParams(String(locationRef?.search || ''))
      params.delete('settings')
      params.delete('stratagateView')
      params.delete('namespace')
      params.delete('nodeId')
      const search = params.toString()
      const next = String(locationRef?.pathname || '/') + (search ? '?' + search : '') + String(locationRef?.hash || '')
      historyRef?.replaceState?.(historyRef.state, '', next)
      return next
    }

    function isDesktopFeedbackSurface(locationRef) {
      try {
        const url = new URL(String(locationRef?.href || ''))
        return url.protocol === 'dsh-app:' && url.hostname === 'app'
      } catch { return false }
    }

    function desktopFeedbackOrigin(value) {
      try {
        const url = new URL(String(value || ''))
        return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
          && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash ? url.origin : ''
      } catch { return '' }
    }

    function feedbackAnchorTarget(target, locationRef) {
      const anchor = target?.closest?.('a[href]') || target?.parentElement?.closest?.('a[href]')
      if (!anchor) return null
      let url
      try {
        url = new URL(String(anchor.getAttribute?.('href') || ''), String(locationRef?.href || ''))
      } catch {
        return null
      }
      if (!readFeedbackDeepLink(url) || url.pathname !== '/' || url.username || url.password) return null
      return { anchor, url }
    }

    function feedbackLinkTarget(target, locationRef = window.location, desktopHostOrigin = '') {
      const match = feedbackAnchorTarget(target, locationRef)
      if (!match) return null
      return match.url.origin === String(locationRef?.origin || '')
        || isDesktopFeedbackSurface(locationRef) && desktopFeedbackOrigin(desktopHostOrigin) === match.url.origin ? match : null
    }

    function navigateToFeedback(ctx, targetUrl, locationRef = window.location, allowHttpFallback = true) {
      const feedback = readFeedbackDeepLink(targetUrl)
      if (!feedback) return 'ignored'
      const navigation = ctx?.get?.('settingsNavigation')
      if (typeof navigation?.openSection === 'function') {
        navigation.openSection(FEEDBACK_SETTINGS_ID, { view: FEEDBACK_VIEW_ID, namespace: feedback.namespace })
        return 'host'
      }
      // DSH 0.2.0 owns a single shared shell instance in this slot's store.
      // Its openSection takes only the section id; route state is plugin-owned.
      const shell = ctx?.get?.('slots')?.entries?.('sidebar.settings')
        ?.find(entry => typeof entry.store?.create === 'function')?.store.create()
      if (typeof shell?.actions?.openSection === 'function') {
        setFeedbackNavigation({ view: FEEDBACK_VIEW_ID, namespace: feedback.namespace })
        shell.actions.openSection(FEEDBACK_SETTINGS_ID)
        return 'host'
      }
      if (allowHttpFallback) locationRef.assign(targetUrl.href)
      return 'http'
    }

    function navigateToGraphNode(ctx, namespace, nodeId, locationRef = window.location, allowHttpFallback = true) {
      const targetNamespace = String(namespace || '').trim()
      const targetNodeId = String(nodeId || '').trim()
      if (!targetNamespace || !targetNodeId) return Promise.resolve(false)
      const navigation = ctx?.get?.('settingsNavigation')
      if (typeof navigation?.openSection !== 'function') {
        if (!allowHttpFallback || typeof locationRef?.assign !== 'function') return Promise.resolve(false)
        try {
          const targetUrl = new URL(String(locationRef.href || ''))
          targetUrl.searchParams.set('settings', FEEDBACK_SETTINGS_ID)
          targetUrl.searchParams.set('stratagateView', 'graph-node')
          targetUrl.searchParams.set('namespace', targetNamespace)
          targetUrl.searchParams.set('nodeId', targetNodeId)
          locationRef.assign(targetUrl.href)
          return Promise.resolve(true)
        } catch {
          return Promise.resolve(false)
        }
      }
      try {
        return Promise.resolve(navigation.openSection(FEEDBACK_SETTINGS_ID, { view: 'graph-node', namespace: targetNamespace, nodeId: targetNodeId }))
          .then((result) => result !== false, () => false)
      } catch {
        return Promise.resolve(false)
      }
    }

    function installFeedbackLinkNavigation(ctx, documentRef = document, locationRef = window.location) {
      const desktop = isDesktopFeedbackSurface(locationRef)
      let active = true
      let desktopHostOrigin = ''
      let bootPending = desktop && typeof window.dshDesktopBoot?.ready === 'function'
      let replayingAnchor = null
      // The native app document and its authenticated HTTP backend have
      // different origins. Read the owned endpoint once from the preload bridge.
      const bootReady = bootPending ? Promise.resolve().then(() => window.dshDesktopBoot.ready())
        .then(boot => { if (active) desktopHostOrigin = desktopFeedbackOrigin(boot?.streamBaseUrl) })
        .catch(() => {})
        .finally(() => { bootPending = false }) : Promise.resolve()
      const takeClick = (event) => {
        event.preventDefault()
        // Markdown explicitly opens the sidebar browser even if defaultPrevented.
        event.stopPropagation()
      }
      const onClick = (event) => {
        if (event.defaultPrevented || (typeof event.button === 'number' && event.button !== 0) || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
        const candidate = feedbackAnchorTarget(event.target, locationRef)
        if (!candidate || candidate.anchor === replayingAnchor) return
        const match = feedbackLinkTarget(event.target, locationRef, desktopHostOrigin)
        if (match) {
          takeClick(event)
          navigateToFeedback(ctx, match.url, locationRef, !desktop)
        } else if (bootPending && desktopFeedbackOrigin(candidate.url.origin)) {
          // Preserve an immediate first click while the local IPC reply arrives.
          takeClick(event)
          void bootReady.then(() => {
            if (!active) return
            if (candidate.url.origin === desktopHostOrigin) navigateToFeedback(ctx, candidate.url, locationRef, false)
            else {
              // A different server's link retains the host's normal link action.
              replayingAnchor = candidate.anchor
              try { candidate.anchor.click() } finally { replayingAnchor = null }
            }
          })
        }
      }
      documentRef.addEventListener('click', onClick, true)
      return () => { active = false; documentRef.removeEventListener('click', onClick, true) }
    }

    function exactInteractiveControl(labels, documentRef) {
      const selector = 'button,[role="button"],[role="tab"],a'
      const matches = (element) => {
        const values = [element.getAttribute?.('aria-label'), element.getAttribute?.('title'), element.textContent]
          .map((value) => String(value || '').trim())
        return labels.some((label) => values.includes(label))
      }
      const visible = (element) => !element.hidden
        && element.getAttribute?.('aria-hidden') !== 'true'
        && (typeof element.getClientRects !== 'function' || element.getClientRects().length > 0)
      const controls = Array.from(documentRef.querySelectorAll(selector))
      const direct = controls.find((element) => visible(element) && matches(element))
      if (direct) return direct
      for (const element of Array.from(documentRef.querySelectorAll('*'))) {
        if (String(element.textContent || '').trim() !== labels[0]) continue
        const control = element.closest?.(selector) || element
        if (visible(control) && typeof control.click === 'function') return control
      }
      return null
    }

    function openLegacyFeedbackDeepLink(documentRef = document) {
      let observer = null
      let timer = null
      let settingsClicked = false
      let sectionClicked = false
      const cleanup = () => {
        observer?.disconnect?.()
        if (timer !== null) window.clearTimeout(timer)
      }
      const attempt = () => {
        if (documentRef.querySelector('[data-testid="stratagate-memory-ui"]')) {
          cleanup()
          return
        }
        if (!sectionClicked) {
          const section = exactInteractiveControl(['StrataGate-AgentMemory'], documentRef)
          if (section) {
            sectionClicked = true
            section.click()
            return
          }
        }
        if (!settingsClicked) {
          const settings = exactInteractiveControl(['设置', 'Settings'], documentRef)
          if (settings) {
            settingsClicked = true
            settings.click()
          }
        }
      }
      const Observer = window.MutationObserver || globalThis.MutationObserver
      if (typeof Observer === 'function') {
        observer = new Observer(attempt)
        observer.observe(documentRef.documentElement || documentRef.body, { childList: true, subtree: true })
      }
      timer = window.setTimeout(cleanup, 12_000)
      attempt()
      return cleanup
    }

    function openFeedbackDeepLink(ctx, documentRef = document, locationRef = window.location, historyRef = window.history) {
      if (!readFeedbackDeepLink(locationRef)) return () => {}
      if (navigateToFeedback(ctx, locationRef, locationRef, false) === 'host') {
        consumeFeedbackDeepLink(locationRef, historyRef)
        return () => {}
      }
      let legacyCleanup = () => {}
      const timer = window.setTimeout(() => { legacyCleanup = openLegacyFeedbackDeepLink(documentRef) }, 250)
      ctx?.inject?.(['settingsNavigation'], (scope) => {
        if (navigateToFeedback(scope, locationRef, locationRef, false) !== 'host') return
        window.clearTimeout(timer)
        legacyCleanup()
        consumeFeedbackDeepLink(locationRef, historyRef)
      })
      return () => {
        window.clearTimeout(timer)
        legacyCleanup()
      }
    }

    function openGraphNodeDeepLink(ctx, documentRef = document, locationRef = window.location, historyRef = window.history) {
      const graphLink = readGraphNodeDeepLink(locationRef)
      if (!graphLink) return () => {}
      const navigation = ctx?.get?.('settingsNavigation')
      if (typeof navigation?.openSection === 'function') {
        void navigateToGraphNode(ctx, graphLink.namespace, graphLink.nodeId, locationRef, false).then((opened) => {
          if (opened) consumeGraphNodeDeepLink(locationRef, historyRef)
        })
        return () => {}
      }
      let legacyCleanup = () => {}
      const timer = window.setTimeout(() => { legacyCleanup = openLegacyFeedbackDeepLink(documentRef) }, 250)
      ctx?.inject?.(['settingsNavigation'], (scope) => {
        void navigateToGraphNode(scope, graphLink.namespace, graphLink.nodeId, locationRef, false).then((opened) => {
          if (!opened) return
          window.clearTimeout(timer)
          legacyCleanup()
          consumeGraphNodeDeepLink(locationRef, historyRef)
        })
      })
      return () => {
        window.clearTimeout(timer)
        legacyCleanup()
      }
    }

    const eventDetailCss = `
      .sg-event-metadata{display:flex;align-items:center;gap:7px 16px;flex-wrap:wrap;margin-top:8px;color:var(--sg-muted);font-size:12px;line-height:1.45}.sg-event-metadata-item{display:inline-flex;align-items:center;gap:5px;min-width:0}.sg-event-metadata b{color:var(--sg-muted);font-weight:620}.sg-event-participants{display:inline-flex;align-items:center;gap:5px;flex-wrap:wrap}.sg-event-metadata .sg-entity-pill{padding:2px 7px}.sg-entity-pill-static{cursor:default;opacity:.82}.sg-entity-pill-static:hover{transform:none!important;background:transparent!important}.sg-event-section{display:grid;gap:9px;padding:17px 0;border-bottom:1px solid var(--sg-border)}.sg-event-section-title{margin:0;color:var(--sg-text);font-size:14px;font-weight:730}.sg-event-memory-copy{max-width:65ch;margin:0;color:var(--sg-text);font-size:14px;line-height:1.72;white-space:pre-wrap;overflow-wrap:anywhere;text-wrap:pretty}.sg-event-weight-section{gap:0}
      .sg-weight-header{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:9px}.sg-weight-header .sg-section-title,.sg-long-detail .sg-weight-header h3{margin:0}.sg-weight-metrics{display:grid!important;grid-template-columns:1fr!important;gap:0!important;margin:0 0 13px!important}.sg-weight-metric{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:14px;min-width:0;padding:7px 2px!important;border-bottom:1px solid color-mix(in srgb,var(--sg-border) 72%,transparent);border-radius:0!important;background:transparent!important}.sg-weight-metric:last-child{border-bottom:0}.sg-weight-metric>span:first-child{color:var(--sg-muted);font-size:12px}.sg-weight-metric strong{margin:0!important;color:var(--sg-text);font-size:15px!important;font-weight:740;font-variant-numeric:tabular-nums;white-space:nowrap}.sg-weight-value{display:inline-flex!important;align-items:center;justify-content:flex-end;gap:6px;color:var(--sg-text)!important}
      .sg-info-disclosure{position:relative;display:inline-flex}.sg-info-trigger{display:grid;place-items:center;width:19px;height:19px;padding:0;border:0;border-radius:50%;background:transparent;color:var(--sg-muted);font-size:13px;line-height:1;cursor:pointer}.sg-info-trigger:hover,.sg-info-trigger[aria-expanded="true"]{background:var(--sg-soft);color:var(--sg-text)}.sg-info-popover{position:absolute;right:0;top:calc(100% + 7px);z-index:20;width:min(320px,calc(100vw - 40px));padding:13px 14px;border:1px solid color-mix(in srgb,var(--sg-accent) 20%,var(--sg-border));border-radius:9px;background:var(--sg-page);color:var(--sg-text);box-shadow:0 14px 36px color-mix(in srgb,var(--sg-text) 18%,transparent);font-size:12px;line-height:1.58;text-align:left}.sg-info-title{display:block;margin-bottom:7px;font-size:13px}.sg-info-popover p{margin:0;color:var(--sg-muted)}.sg-info-popover p+p{margin-top:7px}.sg-adoption-history{display:grid;gap:10px;margin:0;padding:0;list-style:none;counter-reset:history}.sg-adoption-history li{display:grid;gap:1px;padding-bottom:9px;border-bottom:1px solid var(--sg-border)}.sg-adoption-history li:last-child{padding-bottom:0;border-bottom:0}.sg-adoption-history time,.sg-adoption-history span{color:var(--sg-muted)}.sg-floor-table{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 14px;margin:10px 0 0;padding-top:9px;border-top:1px solid var(--sg-border)}.sg-floor-table dt,.sg-floor-table dd{margin:0;color:var(--sg-muted)}.sg-floor-table .current{color:var(--sg-accent);font-weight:720}
      .sg-weight-chart{position:relative;padding:10px 9px 3px!important;border:1px solid var(--sg-border);border-radius:9px;background:color-mix(in srgb,var(--sg-surface) 72%,transparent)}.sg-weight-chart svg{display:block;width:100%;height:auto;min-height:190px!important}.sg-weight-grid{stroke:var(--sg-border);stroke-width:1}.sg-weight-tick{stroke:var(--sg-border);stroke-width:1}.sg-weight-axis-label{fill:var(--sg-muted);font-size:11px}.sg-weight-line{fill:none;stroke:var(--sg-accent);stroke-width:3.2;stroke-linecap:round;stroke-linejoin:round}.sg-weight-line.incomplete{stroke:var(--sg-muted);stroke-width:2.4;opacity:.52}.sg-weight-line-hit{fill:none;stroke:transparent;stroke-width:16;pointer-events:stroke;cursor:help}.sg-weight-tooltip{position:absolute;z-index:4;max-width:250px;padding:8px 10px;border:1px solid color-mix(in srgb,var(--sg-accent) 22%,var(--sg-border));border-radius:7px;background:var(--sg-page);color:var(--sg-text);box-shadow:0 8px 24px color-mix(in srgb,var(--sg-text) 16%,transparent);font-size:11px;line-height:1.5;pointer-events:none;transform:translate(-50%,calc(-100% - 8px));white-space:normal}.sg-weight-tooltip.below{transform:translate(-50%,8px)}.sg-weight-tooltip small{display:block;color:var(--sg-muted);font-size:10px}.sg-weight-floor{stroke:color-mix(in srgb,var(--sg-accent) 58%,var(--sg-muted));stroke-width:1.5;stroke-dasharray:7 5}.sg-weight-floor-label{fill:var(--sg-muted);font-size:11px;font-weight:650}.sg-weight-node{fill:var(--sg-page);stroke:var(--sg-accent);stroke-width:2.5}.sg-weight-node.adoption{fill:var(--sg-accent);stroke:var(--sg-page);stroke-width:3}.sg-weight-node.current{fill:var(--sg-text);stroke:var(--sg-page);stroke-width:2.5}.sg-weight-node-label{fill:var(--sg-text);font-size:11px;font-weight:700}
      .sg-citation-disclosure{border-top:1px solid var(--sg-border)}.sg-citation-disclosure:last-child{border-bottom:1px solid var(--sg-border)}.sg-citation-disclosure summary{padding:11px 2px;color:var(--sg-muted);cursor:pointer;font-weight:650}.sg-citation-disclosure[open] summary{color:var(--sg-text)}.sg-citation-disclosure-body{padding:1px 2px 13px}.sg-provenance-note{margin:0 0 10px;color:var(--sg-muted);font-size:12px}.sg-citation-messages{display:grid;gap:8px}.sg-citation-message{padding:9px 10px;border-left:3px solid var(--sg-border);background:color-mix(in srgb,var(--sg-soft) 72%,transparent);white-space:pre-wrap;overflow-wrap:anywhere}.sg-citation-message-role{display:block;margin-bottom:3px;color:var(--sg-muted);font-size:11px;text-transform:uppercase}.sg-event-technical{display:grid;grid-template-columns:92px minmax(0,1fr);gap:8px 12px;margin:0;font-size:12px}.sg-event-technical dt{color:var(--sg-muted)}.sg-event-technical dd{display:flex;align-items:flex-start;gap:8px;min-width:0;margin:0}.sg-event-technical code{min-width:0;overflow-wrap:anywhere;color:var(--sg-muted);font:12px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace}.sg-copy-id{flex:0 0 auto;padding:1px 6px;border:1px solid var(--sg-border);border-radius:5px;background:transparent;color:var(--sg-muted);font-size:11px;cursor:pointer}.sg-copy-id:hover{border-color:var(--sg-accent);color:var(--sg-accent)}
      .sg-citation-dialog-heading{min-width:0;flex:1}.sg-citation-dialog-actions{display:flex;align-items:center;gap:5px;flex:0 0 auto}.sg-citation-status{display:inline-flex;align-items:center;padding:3px 8px;border:1px solid var(--sg-border);border-radius:6px;color:var(--sg-muted);font-size:11px;font-weight:690;white-space:nowrap}.sg-citation-status.adopted{border-color:color-mix(in srgb,var(--sg-accent) 25%,var(--sg-border));background:color-mix(in srgb,var(--sg-accent) 9%,var(--sg-page));color:var(--sg-accent)}.sg-status-info .sg-info-popover{right:-35px}.sg-event-detail-kicker{display:block;margin-bottom:3px;color:var(--sg-accent);font-size:11px;font-weight:720}.sg-event-detail-head h2{margin:0;font-size:16px;line-height:1.4}.sg-event-page-header .sg-event-detail-kicker{margin-bottom:4px}
      @media(max-width:560px){.sg-citation-dialog-head{align-items:flex-start}.sg-citation-dialog-actions{gap:2px}.sg-citation-status{font-size:10px}.sg-info-popover{position:fixed;left:12px;right:12px;top:auto;bottom:16px;width:auto}.sg-event-technical{grid-template-columns:1fr}.sg-weight-chart svg{min-height:170px!important}}
    `

    const topicDirectoryCss = `
      .sg-topic-directory{max-width:940px;padding:3px 2px 16px}.sg-topic-directory-intro{padding:0 0 18px;border-bottom:1px solid var(--sg-border)}.sg-topic-directory-intro h2{margin:0 0 5px;font-size:13px;font-weight:700}.sg-topic-directory-intro p{margin:0;color:var(--sg-muted);font-size:12px;line-height:1.6}.sg-topic-context{margin-top:6px;color:var(--sg-muted);font-size:11px}.sg-topic-context summary{width:max-content;cursor:pointer}.sg-topic-context pre{margin:7px 0 0;padding-left:12px;border-left:2px solid var(--sg-border);font:inherit;line-height:1.7;white-space:pre-wrap;overflow-wrap:anywhere}
      .sg-topic-chapter{padding:22px 0 20px;border-bottom:1px solid var(--sg-border)}.sg-topic-chapter-header{display:grid;grid-template-columns:44px minmax(0,1fr);gap:8px}.sg-topic-chapter-number{padding-top:2px;color:color-mix(in srgb,var(--sg-muted) 75%,var(--sg-page));font-size:27px;font-weight:450;line-height:1.35;font-variant-numeric:tabular-nums}.sg-topic-chapter-copy{min-width:0}.sg-topic-chapter-copy h2{margin:0;font-size:17px;font-weight:720;line-height:1.5}.sg-topic-chapter-toggle,.sg-topic-section-toggle,.sg-topic-overview-toggle{display:flex;align-items:baseline;gap:10px;width:100%;min-width:0;padding:0;border:0;background:transparent;text-align:left;cursor:pointer}.sg-topic-chapter-label{flex:0 0 auto;color:var(--sg-muted);font-size:12px;font-weight:560}.sg-topic-chapter-title{min-width:0;overflow-wrap:anywhere;text-wrap:pretty}.sg-directory-chevron{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;flex:0 0 auto;margin-left:auto;color:var(--sg-muted);font-size:18px;line-height:1;transform-origin:center;transition:transform var(--sg-medium) var(--sg-ease)}[aria-expanded="true"]>.sg-directory-chevron{transform:rotate(90deg)}.sg-topic-description{max-width:72ch;margin:4px 0 0;color:var(--sg-muted);font-size:12px;line-height:1.65;overflow-wrap:anywhere}.sg-topic-sections{padding:12px 0 0 52px}.sg-topic-section{margin:0}.sg-topic-section-heading{margin:0;font-size:13px;font-weight:620}.sg-topic-section-toggle{align-items:center;min-height:36px;padding:7px 8px;border-radius:5px}.sg-topic-section-toggle:hover,.sg-topic-overview-toggle:hover,.sg-topic-event:hover{background:var(--sg-soft)}.sg-directory-number{flex:0 0 auto;min-width:3.3em;color:var(--sg-muted);font-size:12px;font-weight:500;font-variant-numeric:tabular-nums}.sg-topic-section-body{margin:2px 0 8px 17px;padding:0 0 2px 16px;border-left:1px solid var(--sg-border)}.sg-topic-overview{margin-bottom:3px}.sg-topic-overview-heading{margin:0;font-size:12px;font-weight:620}.sg-topic-overview-toggle{align-items:center;min-height:33px;padding:6px 8px;border-radius:5px}.sg-topic-overview-text{max-width:72ch;margin:1px 0 10px;padding:0 8px 0 calc(3.3em + 18px);color:var(--sg-muted);font-size:13px;line-height:1.75;white-space:pre-wrap;overflow-wrap:anywhere}
      .sg-topic-event{display:flex;align-items:center;gap:10px;width:100%;min-width:0;min-height:33px;padding:6px 8px;border:0;border-radius:5px;background:transparent;text-align:left;cursor:pointer}.sg-topic-event-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}.sg-topic-event-arrow{flex:0 0 auto;color:var(--sg-muted);font-size:12px;opacity:0;transition:opacity var(--sg-fast) var(--sg-ease)}.sg-topic-event:hover .sg-topic-event-arrow,.sg-topic-event:focus-visible .sg-topic-event-arrow{opacity:1}.sg-topic-show-all{display:block;margin:5px 0 3px;padding:5px 8px;border:0;border-radius:5px;background:transparent;color:var(--sg-accent)!important;font-size:11px!important;cursor:pointer}.sg-topic-show-all:hover{background:var(--sg-soft)}.sg-topic-other-events{margin:7px 8px 0;color:var(--sg-muted);font-size:12px}.sg-topic-other-events>summary{padding:5px 0;cursor:pointer}.sg-topic-no-overview{margin:4px 8px;color:var(--sg-muted);font-size:12px}
      .sg-directory-fold{display:grid;grid-template-rows:0fr;opacity:0;visibility:hidden;transition:grid-template-rows var(--sg-medium) var(--sg-ease),opacity var(--sg-medium) var(--sg-ease),visibility 0s var(--sg-medium)}.sg-directory-fold.open{grid-template-rows:1fr;opacity:1;visibility:visible;transition-delay:0s}.sg-directory-fold-inner{min-height:0;overflow:hidden}.sg-directory-fold:not(.open){pointer-events:none}.sg-topic-bootstrap{margin:14px 0 1px;padding:9px 0 9px 12px;border-left:2px solid var(--sg-accent);transition:border-color var(--sg-medium) var(--sg-ease),background-color var(--sg-medium) var(--sg-ease)}.sg-topic-bootstrap.attention{border-color:var(--sg-warn)}.sg-topic-bootstrap-line{display:flex;align-items:center;gap:8px;min-width:0;font-size:12px;font-variant-numeric:tabular-nums}.sg-topic-bootstrap-line>span:nth-child(2){flex:1}.sg-topic-warning{color:var(--sg-warn)}.sg-topic-bootstrap-copy{margin:3px 0 0 22px;color:var(--sg-muted);font-size:11px;line-height:1.6}.sg-topic-status-details{flex:0 0 auto;padding:2px 4px;border:0;border-radius:4px;background:transparent;color:var(--sg-accent)!important;font-size:11px!important;cursor:pointer}.sg-topic-status-details:hover{background:var(--sg-soft)}.sg-topic-failures{padding:9px 0 0 22px;color:var(--sg-muted);font-size:12px}.sg-topic-failure{padding:7px 0;border-top:1px solid var(--sg-border)}.sg-topic-failure>p{margin:0 0 3px}.sg-topic-failure-technical{margin:4px 8px;font-size:11px}.sg-topic-failure-technical summary{cursor:pointer}.sg-topic-failure-technical p{white-space:pre-wrap;overflow-wrap:anywhere}
      .sg-topic-pending{padding:20px 0 0}.sg-topic-pending-heading{display:flex;align-items:center;gap:10px;min-width:0}.sg-topic-pending-heading span{color:var(--sg-muted);font-size:11px}.sg-topic-pending>p{margin:4px 0 8px;color:var(--sg-muted);font-size:12px}.sg-topic-pending-mark{width:12px;color:var(--sg-muted);text-align:center}.sg-topic-empty{padding:27px 0;color:var(--sg-muted);font-size:13px}.sg-topic-empty h3{margin:0 0 4px;color:var(--sg-text);font-size:14px;font-weight:650}.sg-topic-empty p{margin:0}.sg-long-tabs{max-width:100%;flex-wrap:wrap}.sg-long-tabs>button{padding-inline:16px}
      .sg-topic-pending-heading{margin:0}.sg-topic-pending-toggle{display:flex;align-items:center;gap:10px;width:100%;min-width:0;padding:6px 2px;border:0;border-radius:5px;background:transparent;text-align:left;cursor:pointer}.sg-topic-pending-toggle:hover{background:var(--sg-soft)}.sg-topic-pending-toggle>span:first-child{color:var(--sg-text);font-size:13px;font-weight:650}.sg-topic-pending .sg-directory-fold-inner>p{margin:4px 2px 8px;color:var(--sg-muted);font-size:12px}.sg-topic-read-status,.sg-topic-read-error{margin:5px 8px;color:var(--sg-muted);font-size:11px;line-height:1.6}.sg-topic-read-error{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.sg-topic-read-error button{padding:3px 5px;border:0;border-radius:4px;background:transparent;color:var(--sg-accent);font-size:11px;cursor:pointer}.sg-topic-read-error button:hover{background:var(--sg-soft)}.sg-topic-show-all:disabled{color:var(--sg-muted)!important;cursor:wait;opacity:.6}
      @media(max-width:650px){.sg-topic-chapter-header{grid-template-columns:34px minmax(0,1fr);gap:6px}.sg-topic-chapter-number{font-size:22px}.sg-topic-chapter-copy h2{font-size:15px}.sg-topic-chapter-toggle{flex-wrap:wrap;column-gap:8px;row-gap:0}.sg-topic-chapter-title{flex:1 1 calc(100% - 80px)}.sg-topic-sections{padding-left:23px}.sg-topic-section-body{margin-left:9px;padding-left:8px}.sg-topic-overview-text{padding-left:8px}.sg-topic-bootstrap-line{flex-wrap:wrap}.sg-topic-bootstrap-line>span:nth-child(2){flex-basis:calc(100% - 35px)}.sg-topic-status-details{margin-left:18px}.sg-long-tabs>button{padding:7px 12px;font-size:12px}}
      .sg-topic-directory{min-width:0;container-name:sg-topic-directory;container-type:inline-size}.sg-topic-section-toggle>span:nth-child(2),.sg-topic-overview-toggle>span:nth-child(2){min-width:0}
      @container sg-topic-directory (max-width:760px){.sg-topic-directory .sg-toc-lead,.sg-topic-directory .sg-topic-section-toggle .sg-toc-lead,.sg-topic-directory .sg-topic-chapter-toggle>.sg-toc-lead{display:none}.sg-topic-directory .sg-topic-chapter-toggle>.sg-topic-chapter-title{flex:1 1 100%;min-width:0;overflow:visible;white-space:normal;text-overflow:clip;overflow-wrap:anywhere}.sg-topic-directory .sg-topic-section-toggle>.sg-toc-sec-title{flex:1;min-width:0;overflow:visible;white-space:normal;text-overflow:clip;overflow-wrap:anywhere}.sg-topic-directory .sg-topic-chapter-toggle>.sg-toc-cnt,.sg-topic-directory .sg-topic-section-toggle>.sg-toc-cnt{margin-left:auto}.sg-topic-directory .sg-leaf{padding:16px 12px 14px 18px}.sg-topic-directory .sg-book:before{left:10px}.sg-topic-directory .sg-topic-section-toggle{margin-left:1.6em}.sg-topic-directory .sg-topic-section-toggle>.sg-directory-number{min-width:2em}.sg-topic-chapter-header{grid-template-columns:26px minmax(0,1fr);gap:4px}.sg-topic-chapter-number{font-size:19px}.sg-topic-chapter-copy h2{font-size:14px}.sg-topic-sections{padding-left:8px}.sg-topic-section-body{margin-left:6px;padding-left:6px}.sg-topic-section-toggle,.sg-topic-overview-toggle{gap:5px;padding:6px 2px}.sg-directory-number{min-width:0;font-size:11px}.sg-topic-event{gap:6px;padding-inline:2px}.sg-topic-event-title{font-size:11px}.sg-topic-pending-toggle{gap:6px}}

      @container sg-topic-directory (max-width:180px){.sg-topic-chapter-header{grid-template-columns:minmax(0,1fr)}.sg-topic-chapter-number{display:none}.sg-topic-sections{padding-left:0}.sg-topic-section-body{padding-left:0;border-left:0}.sg-topic-section-toggle,.sg-topic-overview-toggle{gap:3px;padding-inline:0;font-size:11px}.sg-directory-number{min-width:0;font-size:10px}.sg-topic-event{gap:3px;padding-inline:0}.sg-topic-event-arrow,.sg-directory-chevron{display:none}.sg-topic-bootstrap{padding-left:5px}.sg-topic-other-events{margin-inline:0}}

      @container sg-memory (max-width:760px){
        .sg-topic-directory .sg-toc-lead,.sg-topic-directory .sg-topic-section-toggle .sg-toc-lead,.sg-topic-directory .sg-topic-chapter-toggle>.sg-toc-lead{display:none}
        .sg-topic-directory .sg-topic-chapter-toggle>.sg-topic-chapter-title{flex:1 1 100%;min-width:0;overflow:visible;white-space:normal;text-overflow:clip;overflow-wrap:anywhere}.sg-topic-directory .sg-topic-section-toggle>.sg-toc-sec-title{flex:1;min-width:0;overflow:visible;white-space:normal;text-overflow:clip;overflow-wrap:anywhere}.sg-topic-directory .sg-topic-chapter-toggle>.sg-toc-cnt,.sg-topic-directory .sg-topic-section-toggle>.sg-toc-cnt{margin-left:auto}
        .sg-topic-directory .sg-leaf{padding:16px 12px 14px 18px}
        .sg-topic-directory .sg-book:before{left:10px}
        .sg-topic-directory .sg-topic-section-toggle{margin-left:1.6em}
      }
      @media(prefers-reduced-motion:reduce){.sg-directory-fold,.sg-directory-chevron,.sg-topic-bootstrap{transition:none!important}.sg-topic-bootstrap .sg-processing-icon{animation:none!important}}
    `

    const DAILY_NOTES_CSS = `
  /* New: short-term memory page */
  .sg-memory .sg-daily-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:14px}
  .sg-memory .sg-daily-head h2{margin:0;font-size:19px;line-height:1.28;font-weight:760}
  .sg-memory .sg-daily-head p{margin:4px 0 0;color:var(--sg-muted);font-size:13px}
  .sg-memory .sg-daily-actions{position:relative;display:flex;gap:4px;flex:0 0 auto}
  .sg-memory .sg-daily-icon-btn{position:relative;display:grid;place-items:center;width:34px;height:34px;padding:0;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--sg-muted);cursor:pointer;transition:background .14s,color .14s,border-color .14s}
  .sg-memory .sg-daily-icon-btn:hover, .sg-memory .sg-daily-icon-btn[aria-expanded=true]{background:var(--sg-soft);color:var(--sg-text)}
  .sg-memory .sg-daily-icon-btn[aria-expanded=true]{border-color:var(--sg-border)}
  .sg-memory .sg-daily-icon-btn svg{width:17px;height:17px}
  .sg-memory .sg-daily-icon-btn[data-tip]:hover:after{content:attr(data-tip);position:absolute;right:0;top:calc(100% + 6px);z-index:5;padding:4px 8px;border-radius:6px;background:#000;color:#fff;font-size:11px;white-space:nowrap;pointer-events:none}

  .sg-memory .sg-daily-strip{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-bottom:26px}
  .sg-memory .sg-daily-day{position:relative;display:grid;grid-template-columns:auto minmax(0,1fr);align-items:center;gap:2px 12px;min-width:0;padding:12px 14px 12px 13px;border:1px solid var(--sg-border);border-radius:8px;background:var(--sg-surface);text-align:left;cursor:pointer;overflow:hidden;transition:border-color .16s,background .16s,transform .16s var(--sg-ease)}
  .sg-memory .sg-daily-day:before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:transparent;transition:background .16s}
  .sg-memory .sg-daily-day:hover{border-color:color-mix(in srgb,var(--sg-accent) 40%,var(--sg-border));transform:translateY(-1px)}
  .sg-memory .sg-daily-num{grid-row:span 2;font-size:30px;line-height:1;font-weight:700;font-variant-numeric:tabular-nums;color:var(--sg-text)}
  .sg-memory .sg-daily-week{font-size:12px;font-weight:650;color:var(--sg-text);white-space:nowrap}
  .sg-memory .sg-daily-rel{font-size:11px;color:var(--sg-muted);white-space:nowrap}
  .sg-memory .sg-daily-day.selected{border-color:color-mix(in srgb,var(--sg-accent) 55%,transparent);background:var(--sg-accent-soft)}
  .sg-memory .sg-daily-day.selected:before{background:var(--sg-accent)}
  .sg-memory .sg-daily-day.selected .sg-daily-num{color:var(--sg-accent)}

  /* Calendar popover */
  .sg-memory .sg-daily-cal{position:absolute;right:0;top:calc(100% + 8px);z-index:10;width:268px;padding:12px;border:1px solid var(--sg-border);border-radius:10px;background:var(--sg-page);box-shadow:0 18px 44px rgba(0,0,0,.38)}
  .sg-memory .sg-daily-cal[hidden]{display:none}
  .sg-memory .sg-daily-cal-top{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}
  .sg-memory .sg-daily-cal-top strong{font-size:13px}
  .sg-memory .sg-daily-cal-nav{display:flex;gap:2px}
  .sg-memory .sg-daily-cal-nav .sg-daily-icon-btn{width:28px;height:28px}
  .sg-memory .sg-daily-cal-nav .sg-daily-icon-btn:disabled{opacity:.3;cursor:default;background:transparent}
  .sg-memory .sg-daily-cal-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:2px;text-align:center}
  .sg-memory .sg-daily-cal-dow{padding:3px 0 5px;color:var(--sg-muted);font-size:11px}
  .sg-memory .sg-daily-cal-day{position:relative;height:32px;padding:0;border:0;border-radius:7px;background:transparent;font-size:12px;font-variant-numeric:tabular-nums;color:color-mix(in srgb,var(--sg-muted) 45%,transparent);cursor:default}
  .sg-memory .sg-daily-cal-day.has{color:var(--sg-text);font-weight:600;cursor:pointer}
  .sg-memory .sg-daily-cal-day.has:after{content:"";position:absolute;left:50%;bottom:4px;width:4px;height:4px;margin-left:-2px;border-radius:50%;background:var(--sg-muted)}
  .sg-memory .sg-daily-cal-day.has:hover{background:var(--sg-soft)}
  .sg-memory .sg-daily-cal-day.recent{background:var(--sg-accent-soft);color:var(--sg-accent)}
  .sg-memory .sg-daily-cal-day.recent:after{background:var(--sg-accent)}
  .sg-memory .sg-daily-cal-day.selected{background:var(--sg-accent);color:#fff}
  .sg-memory .sg-daily-cal-day.selected:after{background:#fff}
  .sg-memory .sg-daily-cal-day.today{box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--sg-accent) 55%,transparent)}
  .sg-memory .sg-daily-cal-foot{display:flex;align-items:center;gap:6px;margin-top:9px;padding-top:9px;border-top:1px solid var(--sg-border);color:var(--sg-muted);font-size:11px}
  .sg-memory .sg-daily-cal-foot i{display:inline-block;width:10px;height:10px;border-radius:3px;background:var(--sg-accent-soft);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--sg-accent) 40%,transparent)}

  /* Reading view */
  .sg-memory .sg-daily-note{max-width:68ch;animation:sg-daily-fade .22s var(--sg-ease) both}
  @keyframes sg-daily-fade{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
  .sg-memory .sg-daily-note-date{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 10px;margin:0 0 4px}
  .sg-memory .sg-daily-note-date h3{margin:0;font-size:22px;line-height:1.3;font-weight:740}
  .sg-memory .sg-daily-note-date span{color:var(--sg-muted);font-size:13px}
  .sg-memory .sg-daily-meta{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-bottom:18px;color:var(--sg-muted);font-size:12px}
  .sg-memory .sg-daily-pill{display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border-radius:999px;background:var(--sg-accent-soft);color:var(--sg-accent);font-size:11px;font-weight:650}
  .sg-memory .sg-daily-pill.muted{background:var(--sg-soft);color:var(--sg-muted)}
  .sg-memory .sg-daily-back{padding:0;border:0;background:transparent;color:var(--sg-accent);font-size:12px;font-weight:600;cursor:pointer}
  .sg-memory .sg-daily-back:hover{text-decoration:underline}
  .sg-memory .sg-daily-item{padding:16px 0 18px;border-top:1px solid var(--sg-border)}
  .sg-memory .sg-daily-item h4{margin:0 0 8px;font-size:15px;line-height:1.45;font-weight:700}
  .sg-memory .sg-daily-status{display:flex;gap:9px;margin:0 0 9px;line-height:1.65}
  .sg-memory .sg-daily-status b{flex:0 0 auto;padding:1px 7px;border-radius:5px;background:var(--sg-accent-soft);color:var(--sg-accent);font-size:11.5px;font-weight:700;line-height:1.75;height:max-content}
  .sg-memory .sg-daily-status.done b{background:var(--sg-good-soft);color:var(--sg-good)}
  .sg-memory .sg-daily-item ul{margin:0;padding-left:18px;color:color-mix(in srgb,var(--sg-text) 86%,var(--sg-muted))}
  .sg-memory .sg-daily-item li{margin:3px 0;line-height:1.65}
  .sg-memory .sg-daily-item li::marker{color:var(--sg-muted)}
  .sg-memory .sg-daily-item p{margin:6px 0;line-height:1.7}
  .sg-memory .sg-daily-note code{padding:1px 5px;border-radius:4px;background:var(--sg-soft);font:12px ui-monospace,SFMono-Regular,Menlo,monospace}
  .sg-memory .sg-daily-ref{color:var(--sg-muted);font-size:12.5px}

  .sg-memory .sg-daily-state{display:grid;justify-items:start;gap:6px;padding:34px 2px 30px;border-top:1px solid var(--sg-border)}
  .sg-memory .sg-daily-state h3{margin:0;font-size:15px}
  .sg-memory .sg-daily-state p{margin:0;color:var(--sg-muted);font-size:13px}
  .sg-memory .sg-daily-state .sg-daily-icon-wrap{display:grid;place-items:center;width:38px;height:38px;margin-bottom:4px;border-radius:10px;background:var(--sg-soft);color:var(--sg-muted)}
  .sg-memory .sg-daily-state.error .sg-daily-icon-wrap{background:var(--sg-danger-soft);color:var(--sg-danger)}
  .sg-memory .sg-daily-retry{display:inline-flex;align-items:center;gap:6px;margin-top:8px;min-height:32px;padding:0 12px;border:1px solid var(--sg-border);border-radius:7px;background:var(--sg-surface);cursor:pointer}
  .sg-memory .sg-daily-retry:hover{border-color:var(--sg-accent);color:var(--sg-accent)}
  .sg-memory .sg-daily-retry svg{width:15px;height:15px}
  .sg-memory .sg-daily-off{display:flex;align-items:center;gap:8px;margin:-4px 0 16px;padding:8px 11px;border-radius:8px;background:var(--sg-soft);color:var(--sg-muted);font-size:12px}
  .sg-memory .sg-daily-off svg{width:15px;height:15px;flex:none}
@container sg-daily (max-width:400px){  .sg-memory .sg-daily-strip{gap:6px;margin-bottom:20px}
  .sg-memory .sg-daily-day{grid-template-columns:1fr;justify-items:center;gap:3px;padding:10px 4px 9px;text-align:center}
  .sg-memory .sg-daily-day:before{left:0;right:0;top:0;bottom:auto;width:auto;height:3px}
  .sg-memory .sg-daily-num{grid-row:auto;font-size:24px}}
.sg-daily{container:sg-daily / inline-size;min-width:0}.sg-memory .sg-daily *{min-width:0}.sg-memory .sg-daily-note,.sg-memory .sg-daily-note code{overflow-wrap:anywhere;white-space:pre-wrap}.sg-memory .sg-daily-item ul{white-space:normal}.sg-memory .sg-daily-note{min-width:0}.sg-memory .sg-daily-head>div:first-child{min-width:0}.sg-memory .sg-daily-cal{max-width:calc(100cqw - 2px)}.sg-memory .sg-daily-icon-btn:disabled{opacity:.35;cursor:default}.sg-memory .sg-daily-icon-wrap svg{width:24px;height:24px}.sg-memory .sg-daily-rel{font-size:11px}.sg-memory .sg-daily-tab:focus-visible{outline:2px solid var(--sg-accent)}
@container sg-daily (max-width:400px){.sg-memory .sg-daily-strip{gap:10px}.sg-memory .sg-daily-head{gap:8px}}
@container sg-memory (max-width:400px){.sg-memory .sg-tab{font-size:12px;padding:8px 0}.sg-tabs{gap:2px}}
@media(prefers-reduced-motion:reduce){.sg-memory .sg-daily *{animation:none!important;transition:none!important}}
`

    const css = `
      .sg-feedback-wizard .sg-primary-link{color:#fff}.sg-feedback-wizard .sg-support-field{display:grid;gap:6px;margin:14px 0}.sg-feedback-wizard .sg-support-preview{white-space:pre-wrap;overflow-wrap:anywhere}.sg-feedback-step-back{margin-bottom:14px}
      .sg-memory {
        color-scheme:inherit;
        --sg-page:var(--dsw-alias-bg-layer-2,#fff);
        --sg-surface:var(--dsw-specific-input-major,var(--sg-page));
        --sg-soft:var(--dsw-alias-interactive-bg-hover-solid,color-mix(in srgb,var(--sg-text) 8%,var(--sg-page)));
        --sg-text:var(--dsw-alias-label-primary,#0f1115);
        --sg-muted:var(--dsw-alias-label-secondary,#61666b);
        --sg-border:var(--dsw-alias-border-l2,rgba(0,0,0,.1));
        --sg-accent:var(--dsw-alias-state-business-primary,#4176e6);
        --sg-accent-soft:var(--dsw-alias-state-business-tertiary,#e4edfd);
        --sg-level-0:color-mix(in srgb,var(--sg-accent) 12%,var(--sg-surface));
        --sg-level-1:color-mix(in srgb,var(--sg-accent) 22%,var(--sg-surface));
        --sg-level-2:color-mix(in srgb,var(--sg-accent) 34%,var(--sg-surface));
        --sg-level-3:color-mix(in srgb,var(--sg-accent) 46%,var(--sg-surface));
        --sg-level-4:color-mix(in srgb,var(--sg-accent) 58%,var(--sg-surface));
        --sg-level-5:color-mix(in srgb,var(--sg-accent) 72%,var(--sg-surface));
        --sg-good:var(--dsw-alias-state-success-primary,#22c55e);
        --sg-good-soft:var(--dsw-alias-state-success-tertiary,#e6faed);
        --sg-warn:var(--dsw-alias-state-warn-label,#dd8629);
        --sg-warn-soft:var(--dsw-alias-state-warn-tertiary,#fef5e7);
        --sg-danger:var(--dsw-alias-state-error-primary,#ec1313);
        --sg-danger-soft:var(--dsw-alias-interactive-bg-hover-danger,rgba(236,19,19,.05));
        --sg-focus:color-mix(in srgb,var(--sg-accent) 32%,transparent);
        --sg-shadow:0 14px 36px color-mix(in srgb,var(--sg-text) 10%,transparent);
        --sg-ease:cubic-bezier(.22,1,.36,1);
        --sg-fast:140ms;
        --sg-medium:220ms;
        container:sg-memory / inline-size;position:relative;isolation:isolate;box-sizing:border-box;width:100%;max-width:1200px;min-width:0;margin:0 auto;padding:18px 20px 36px;
        background:var(--sg-page);color:var(--sg-text);font:14px/1.55 "Segoe UI Variable Text","Segoe UI",ui-sans-serif,system-ui,-apple-system,"Microsoft YaHei",sans-serif;
        letter-spacing:0;overflow-wrap:anywhere;font-variant-numeric:tabular-nums;
      }
      .sg-memory *{box-sizing:border-box;letter-spacing:0}.sg-memory button,.sg-memory input,.sg-memory select{font:inherit;color:inherit}.sg-memory button,.sg-memory a,.sg-memory input,.sg-memory select,.sg-memory summary{transition:color var(--sg-fast) var(--sg-ease),background-color var(--sg-fast) var(--sg-ease),border-color var(--sg-fast) var(--sg-ease),box-shadow var(--sg-fast) var(--sg-ease),opacity var(--sg-fast) var(--sg-ease),transform var(--sg-fast) var(--sg-ease)}.sg-memory button:active,.sg-memory a:active{transform:scale(.985)}.sg-memory :is(button,a,input,select,summary,[tabindex]):focus-visible{outline:2px solid var(--sg-accent);outline-offset:2px;box-shadow:0 0 0 4px var(--sg-focus)}
      .sg-header{display:grid;gap:9px;margin-bottom:12px;padding:12px 13px;border:1px solid color-mix(in srgb,var(--sg-accent) 16%,var(--sg-border));border-radius:12px;background:color-mix(in srgb,var(--sg-surface) 84%,transparent);box-shadow:0 8px 24px color-mix(in srgb,var(--sg-text) 6%,transparent)}.sg-header-row{display:flex;align-items:center;justify-content:space-between;gap:14px;min-width:0}.sg-header-row-primary{min-height:38px}.sg-header-row-secondary{align-items:center}.sg-brand{display:flex;align-items:center;gap:10px;min-width:0;color:var(--sg-text);text-decoration:none}.sg-brand:hover .sg-logo{transform:translateY(-1px)}.sg-logo{width:38px;height:38px;display:block;flex:0 0 auto;color:var(--sg-text);transition:transform var(--sg-medium) var(--sg-ease)}.sg-logo-back{fill:var(--sg-soft);stroke:var(--sg-border)}.sg-logo-middle{fill:var(--sg-surface);stroke:var(--sg-muted)}.sg-logo-front{fill:var(--sg-page);stroke:currentColor}.sg-logo-rule{stroke:var(--sg-accent)}.sg-brand-copy{display:grid;min-width:0;gap:1px}.sg-brand-title{display:flex;align-items:baseline;gap:7px;min-width:0}.sg-brand-name{min-width:0;font-size:15px;font-weight:740;letter-spacing:-.018em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.sg-brand-version{flex:0 0 auto;color:var(--sg-muted);font-size:10px;font-weight:560;font-variant-numeric:tabular-nums}.sg-brand-kicker{color:var(--sg-muted);font-size:11px;white-space:nowrap}.sg-header-usage{display:flex;align-items:center;justify-content:flex-end;gap:10px;min-width:0;color:var(--sg-muted);font-size:11px;line-height:1.4;text-align:right}.sg-usage-count{display:inline-flex;align-items:baseline;gap:4px;padding:4px 8px;border-radius:7px;background:var(--sg-soft)}.sg-usage-number{color:var(--sg-text);font-size:14px;font-weight:760}.sg-ghstar{display:inline-flex;align-items:center;flex:none;height:28px;border:1px solid var(--sg-border);border-radius:6px;background:none;color:var(--sg-muted);font-size:12px;text-decoration:none;white-space:nowrap}.sg-ghstar:hover{border-color:color-mix(in srgb,var(--sg-text) 34%,var(--sg-border));color:var(--sg-text)}.sg-ghstar-label{display:flex;align-items:center;gap:6px;height:100%;padding:0 9px}.sg-ghstar-icon{width:14px;height:14px;flex:none}.sg-ghstar-label b{font-weight:500}.sg-ghstar-count{display:flex;align-items:center;height:100%;padding:0 9px;border-left:1px solid var(--sg-border);color:var(--sg-text);font-family:var(--sg-mono);font-variant-numeric:tabular-nums}
      .sg-icon-button,.sg-back,.sg-quiet-button{border:0;background:transparent;cursor:pointer}.sg-icon-button{width:32px;height:32px;border-radius:6px;font-size:20px}.sg-icon-button:hover,.sg-back:hover,.sg-quiet-button:hover{background:var(--sg-soft);transform:translateY(-1px)}
      .sg-header-end{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex:0 1 auto;min-width:0}
      .sg-project{display:flex;align-items:center;gap:6px;flex:0 1 auto;min-width:0;margin:0;height:28px;padding:0 2px 0 9px;border:1px solid var(--sg-border);border-radius:6px;color:var(--sg-muted);font-size:12px;white-space:nowrap}.sg-project-label{flex:0 0 auto}.sg-project-select{min-width:0;max-width:14ch;padding:2px 20px 2px 3px;border:0;border-radius:5px;background:transparent;color:var(--sg-text);font-weight:620;cursor:pointer;text-overflow:ellipsis;white-space:nowrap;overflow:hidden}
      @media (max-width:560px){.sg-header-end{width:100%;justify-content:space-between}.sg-project-label{display:none}}
      .sg-tabs{display:grid;grid-template-columns:repeat(6,1fr);gap:4px;margin-bottom:22px;padding:4px;border:1px solid var(--sg-border);border-radius:11px;background:color-mix(in srgb,var(--sg-surface) 58%,transparent)}.sg-tab{position:relative;min-width:0;padding:9px 6px;border:0;border-radius:7px;background:transparent;color:var(--sg-muted);cursor:pointer;white-space:nowrap}.sg-tab:hover{color:var(--sg-text);background:color-mix(in srgb,var(--sg-soft) 70%,transparent)}.sg-tab.active{color:var(--sg-accent);background:var(--sg-surface);font-weight:720;box-shadow:0 3px 12px color-mix(in srgb,var(--sg-text) 7%,transparent)}
      .sg-alert{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:10px;width:100%;padding:11px 12px;margin:0 0 18px;border:1px solid color-mix(in srgb,var(--sg-warn) 28%,var(--sg-border));border-radius:8px;background:var(--sg-warn-soft);text-align:left;cursor:pointer}.sg-alert-mark{color:var(--sg-warn);font-size:17px}.sg-alert-title{font-weight:700}.sg-alert-copy{color:var(--sg-muted);font-size:12px}.sg-chevron{color:var(--sg-muted);font-size:18px}.sg-memory-alert{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:10px;width:100%;padding:11px 12px;margin:0 0 18px;border:1px solid var(--sg-border);border-radius:8px;background:var(--sg-soft);color:var(--sg-text);text-align:left;cursor:pointer}.sg-memory-alert.processing{border-color:color-mix(in srgb,var(--sg-accent) 30%,var(--sg-border));background:var(--sg-accent-soft)}.sg-memory-alert.attention{border-color:color-mix(in srgb,var(--sg-warn) 34%,var(--sg-border));background:var(--sg-warn-soft)}.sg-memory-alert:hover{box-shadow:0 6px 18px color-mix(in srgb,var(--sg-text) 7%,transparent);transform:translateY(-1px)}.sg-memory-alert-mark{display:inline-grid;place-items:center;width:20px;height:20px;flex:0 0 auto;color:var(--sg-accent);font-size:19px;font-weight:700;line-height:1}.sg-memory-alert.attention .sg-memory-alert-mark{color:var(--sg-warn)}.sg-memory-alert.processing .sg-memory-alert-mark{animation:sg-spin 1s linear infinite}.sg-memory-alert-title{display:block;font-weight:720}.sg-memory-alert-copy{display:block;margin-top:2px;color:var(--sg-muted);font-size:12px}.sg-processing-icon{display:inline-grid;place-items:center;width:20px;height:20px;flex:0 0 auto;font-size:19px;font-weight:700;line-height:1;animation:sg-spin 1s linear infinite}@keyframes sg-spin{to{transform:rotate(360deg)}}
      .sg-intro{margin-bottom:17px}.sg-intro h2,.sg-detail-title{margin:0;font-size:19px;line-height:1.28;font-weight:760;letter-spacing:-.025em;text-wrap:balance}.sg-intro p,.sg-detail-subtitle{max-width:65ch;margin:5px 0 0;color:var(--sg-muted);font-size:13px;text-wrap:pretty}.sg-search{position:relative;margin-bottom:7px}.sg-search-mark{position:absolute;left:12px;top:50%;transform:translateY(-50%);color:var(--sg-muted);font-size:16px;pointer-events:none}.sg-search input{width:100%;height:41px;padding:0 12px 0 37px;border:1px solid var(--sg-border);border-radius:9px;background:var(--sg-surface);outline:0}.sg-search input:hover{border-color:color-mix(in srgb,var(--sg-accent) 35%,var(--sg-border))}.sg-search input:focus{border-color:var(--sg-accent);box-shadow:0 0 0 3px var(--sg-focus)}
      .sg-feed{border-top:1px solid var(--sg-border)}.sg-entry{position:relative;width:100%;min-width:0;padding:17px 10px;margin:0 -10px;border:0;border-bottom:1px solid var(--sg-border);border-radius:8px;background:transparent;text-align:left}.sg-entry-button{cursor:pointer}.sg-entry-button:hover{background:color-mix(in srgb,var(--sg-accent) 5%,transparent);transform:translateX(2px)}.sg-entry-button:hover .sg-entry-title{color:var(--sg-accent)}.sg-entry-title{padding-right:22px;font-size:15px;line-height:1.42;font-weight:720;letter-spacing:-.01em}.sg-entry-summary{margin-top:5px;color:var(--sg-text);white-space:pre-wrap}.sg-entry-chevron{position:absolute;right:9px;top:18px;color:var(--sg-muted);font-size:18px}.sg-entry-button:hover .sg-entry-chevron{color:var(--sg-accent);transform:translateX(2px)}.sg-meta{display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin-top:9px;color:var(--sg-muted);font-size:12px}.sg-meta-sep:before{content:"·";margin-right:7px}.sg-tags{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}.sg-tag{max-width:100%;padding:3px 8px;border:1px solid var(--sg-border);border-radius:7px;background:var(--sg-soft);color:var(--sg-text);font-size:12px;line-height:1.45;text-overflow:ellipsis;overflow:hidden;white-space:nowrap}.sg-tag-button{cursor:pointer}.sg-tag-button:hover{border-color:var(--sg-accent);color:var(--sg-accent);transform:translateY(-1px)}
      .sg-status{display:inline-flex;align-items:center;gap:5px;padding:2px 7px;border-radius:5px;font-size:12px;font-weight:650}.sg-status:before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}.sg-status.organized{color:var(--sg-good);background:var(--sg-good-soft)}.sg-status.processing{color:var(--sg-accent);background:var(--sg-accent-soft)}.sg-status.waiting{color:var(--sg-muted);background:var(--sg-soft)}.sg-status.failed{color:var(--sg-warn);background:var(--sg-warn-soft)}
      .sg-backbar{display:flex;align-items:center;min-height:35px;margin:-4px 0 13px}.sg-back{display:inline-flex;align-items:center;gap:6px;margin-left:-7px;padding:6px 7px;border-radius:6px;font-weight:650}.sg-detail-header{padding-bottom:16px;border-bottom:1px solid var(--sg-border)}.sg-detail-section{padding:18px 0;border-bottom:1px solid var(--sg-border)}.sg-detail-section:last-child{border-bottom:0}.sg-section-title{margin:0 0 11px;font-size:14px;font-weight:730}.sg-prose{margin:0;white-space:pre-wrap}.sg-facts{margin:0;padding-left:20px}.sg-facts li+li{margin-top:7px}.sg-related-list{display:flex;flex-direction:column}.sg-related{display:flex;justify-content:space-between;gap:12px;padding:9px 0;border:0;border-bottom:1px solid var(--sg-border);background:transparent;text-align:left}.sg-related-button,.sg-related:where(button){cursor:pointer}.sg-related:last-child{border-bottom:0}.sg-related-name{color:var(--sg-accent)}.sg-related-time{flex:0 0 auto;color:var(--sg-muted);font-size:12px}
      .sg-weight-header{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:10px}.sg-weight-header .sg-section-title,.sg-long-detail .sg-weight-header h3{margin:0}.sg-weight-metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px;margin-bottom:10px}.sg-weight-metric{min-width:0;padding:8px 9px;border-radius:7px;background:var(--sg-soft)}.sg-weight-metric span{display:block;color:var(--sg-muted);font-size:10px}.sg-weight-metric strong{display:block;margin-top:2px;font-size:14px;font-weight:740;font-variant-numeric:tabular-nums;white-space:nowrap}.sg-weight-chart{position:relative;padding:8px 8px 4px;border:1px solid var(--sg-border);border-radius:9px;background:color-mix(in srgb,var(--sg-surface) 72%,transparent)}.sg-weight-chart svg{display:block;width:100%;height:auto;min-height:156px}.sg-weight-grid{stroke:var(--sg-border);stroke-width:1}.sg-weight-axis-label{fill:var(--sg-muted);font-size:9px}.sg-weight-line{fill:none;stroke:var(--sg-accent);stroke-width:2.5;stroke-linecap:round;stroke-linejoin:round}.sg-weight-node{fill:var(--sg-page);stroke:var(--sg-accent);stroke-width:2}.sg-weight-node.adoption{fill:var(--sg-accent);stroke:var(--sg-page);stroke-width:2.5}.sg-weight-node.current{fill:var(--sg-text);stroke:var(--sg-page);stroke-width:2}.sg-weight-node-label{fill:var(--sg-text);font-size:9px;font-weight:680}.sg-weight-note{margin:7px 0 0;color:var(--sg-muted);font-size:10px;line-height:1.5}.sg-weight-retrieval{margin-top:6px;color:var(--sg-muted);font-size:10px}.sg-weight-help{margin-top:10px;border-top:1px solid var(--sg-border)}.sg-weight-help summary{padding:9px 2px 2px;color:var(--sg-muted);font-size:11px;font-weight:650;cursor:pointer}.sg-weight-help[open] summary{color:var(--sg-text)}.sg-weight-help-body{padding:8px 0 2px}.sg-weight-help-copy{margin:0 0 7px;color:var(--sg-muted);font-size:11px;line-height:1.58}.sg-weight-demo{padding:8px;border-radius:8px;background:var(--sg-soft)}.sg-weight-demo-label{display:block;margin-bottom:4px;color:var(--sg-muted);font-size:9px}.sg-weight-demo svg{display:block;width:100%;height:76px}.sg-weight-demo path{fill:none;stroke:var(--sg-accent);stroke-width:2}.sg-weight-demo circle{fill:var(--sg-accent)}
      .sg-source-label{display:flex;align-items:center;gap:8px}.sg-source-icon{color:var(--sg-muted)}.sg-tech{margin-top:13px}.sg-tech summary{color:var(--sg-muted);font-size:12px;cursor:pointer}.sg-tech-body{margin-top:10px;padding:11px;border-radius:7px;background:var(--sg-soft);font-size:12px}.sg-tech-row{display:grid;grid-template-columns:88px minmax(0,1fr);gap:9px;padding:3px 0}.sg-code{font:12px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere}.sg-raw-message{padding-top:10px;margin-top:10px;border-top:1px solid var(--sg-border)}
      .sg-model-settings{margin-bottom:12px;padding:16px;min-width:0}.sg-model-heading{margin:0 0 4px;font-size:15px;font-weight:650;line-height:1.4}.sg-model-intro{margin:0;color:var(--sg-muted);font-size:13px;line-height:1.5}
      .sg-model-modes{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin:14px 0 10px}.sg-model-mode{display:flex;align-items:flex-start;gap:9px;min-width:0;padding:11px;border:1px solid var(--sg-border);border-radius:9px;cursor:pointer;background:var(--sg-surface);transition:background-color var(--sg-fast) var(--sg-ease),border-color var(--sg-fast) var(--sg-ease)}.sg-model-mode:hover{border-color:var(--sg-accent)}.sg-model-mode.selected{border-color:var(--sg-accent);background:color-mix(in srgb,var(--sg-accent) 6%,var(--sg-surface))}.sg-model-mode:has(input:disabled){cursor:default;opacity:.65}.sg-model-mode input{flex:0 0 auto;width:16px;height:16px;margin:2px 0 0;accent-color:var(--sg-accent)}.sg-model-mode-copy{display:grid;gap:2px;min-width:0}.sg-model-mode-title{font-size:14px;font-weight:600}.sg-model-mode-description{font-size:12px;line-height:1.45;color:var(--sg-muted)}
      .sg-model-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin:0 0 8px;padding:12px;border-radius:9px;background:var(--sg-soft)}.sg-model-field{display:grid;align-content:start;gap:5px;min-width:0;font-size:12px;font-weight:550}.sg-model-settings select{min-width:0;width:100%;max-width:100%;height:38px;background:var(--sg-surface);font-size:13px;font-weight:400}.sg-model-draft-note{margin:0 0 9px;color:var(--sg-muted);font-size:12px;line-height:1.5}.sg-model-save-row{display:flex;align-items:center;justify-content:space-between;gap:12px;border-top:1px solid var(--sg-border);padding-top:10px;margin-top:12px}.sg-model-saved{display:flex;align-items:baseline;flex-wrap:wrap;gap:5px 8px;min-width:0;font-size:12px;color:var(--sg-muted)}.sg-model-saved strong{font-weight:550;color:var(--sg-text);overflow-wrap:anywhere}.sg-model-pending{color:var(--sg-warn);font-size:12px}.sg-model-save-row .sg-save-button{flex:0 0 auto;margin:0}.sg-model-settings p{overflow-wrap:anywhere}
      .sg-retrieval-fields{display:grid;gap:9px;margin-top:14px;min-width:0}.sg-retrieval-settings input{box-sizing:border-box;width:100%;min-width:0;max-width:100%;padding:9px 10px;border:1px solid var(--sg-border);border-radius:7px;background:var(--sg-surface);color:var(--sg-text);font:inherit;font-weight:400}.sg-retrieval-settings input:focus-visible{outline:2px solid var(--sg-accent);outline-offset:2px}.sg-retrieval-settings input:disabled{opacity:.6}.sg-retrieval-fields .sg-setting-note,.sg-retrieval-fields .sg-status-feedback{margin:0}.sg-retrieval-actions{display:flex;flex-wrap:wrap;gap:8px;min-width:0}.sg-retrieval-actions:empty{display:none}.sg-retrieval-tuning{margin-top:14px;font-size:12px}.sg-retrieval-tuning>summary{cursor:pointer;color:var(--sg-muted)}.sg-retrieval-tuning .sg-model-fields{margin-top:9px}
      @container sg-memory (max-width:480px){.sg-model-settings{padding:14px}.sg-model-modes,.sg-model-fields{grid-template-columns:minmax(0,1fr)}.sg-model-modes{margin-top:14px}.sg-model-save-row{align-items:stretch;flex-direction:column;gap:12px}.sg-model-save-row .sg-save-button{width:100%}}
      .sg-result-count{margin:0 0 9px;color:var(--sg-muted);font-size:12px}.sg-result-event{padding:8px 0;border-bottom:1px solid var(--sg-border)}.sg-result-event:last-child{border-bottom:0}.sg-pipeline{display:flex;flex-direction:column}.sg-stage{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;padding:9px 0;border-bottom:1px solid var(--sg-border)}.sg-stage:last-child{border-bottom:0}.sg-stage-value{font-size:12px}.sg-stage-value.done{color:var(--sg-good)}.sg-stage-value.processing{color:var(--sg-accent)}.sg-stage-value.failed{color:var(--sg-danger)}.sg-stage-value.waiting{color:var(--sg-muted)}.sg-lambda-control{display:flex;align-items:center;justify-content:flex-end;gap:7px}.sg-number-input,.sg-effort-select{padding:4px 5px;border:1px solid var(--sg-border);border-radius:6px;background:var(--sg-surface)}.sg-number-input{width:82px;text-align:right}.sg-effort-button{padding:4px 6px;border:0;border-radius:5px;background:transparent;color:var(--sg-muted);cursor:pointer;font-size:12px}.sg-effort-button:hover{background:var(--sg-soft);color:var(--sg-accent)}.sg-setting-switch{position:relative;width:38px;height:22px;padding:0;border:1px solid color-mix(in srgb,var(--sg-muted) 58%,var(--sg-border));border-radius:999px;background:color-mix(in srgb,var(--sg-muted) 18%,var(--sg-surface));cursor:pointer;box-shadow:inset 0 1px 2px color-mix(in srgb,var(--sg-text) 12%,transparent)}.sg-setting-switch:before{content:"";position:absolute;left:3px;top:3px;width:14px;height:14px;border-radius:50%;background:var(--sg-muted);box-shadow:0 1px 2px color-mix(in srgb,var(--sg-text) 22%,transparent);transition:transform var(--sg-fast) var(--sg-ease),background-color var(--sg-fast) var(--sg-ease)}.sg-setting-switch[aria-checked="true"]{border-color:var(--sg-accent);background:var(--sg-accent);box-shadow:none}.sg-setting-switch[aria-checked="true"]:before{background:#fff;transform:translateX(16px)}.sg-setting-switch:disabled{cursor:not-allowed;opacity:.5}.sg-setting-note{margin:7px 0 11px;color:var(--sg-muted);font-size:12px}.sg-display-settings{display:grid;gap:2px}.sg-display-setting{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:start;gap:14px;padding:13px 0;border-bottom:1px solid var(--sg-border)}.sg-display-setting.child{padding-left:18px}.sg-display-setting-copy{display:grid;gap:4px}.sg-display-setting-title{font-size:13px;font-weight:680}.sg-display-setting-description{max-width:62ch;color:var(--sg-muted);font-size:11px;line-height:1.5}.sg-display-disabled{opacity:.58}.sg-settings-group{margin-top:24px;padding-top:18px;border-top:1px solid var(--sg-border)}.sg-settings-group:first-of-type{margin-top:0;padding-top:0;border-top:0}.sg-settings-group-title{margin:0;font-size:15px;letter-spacing:-.01em}.sg-settings-group-copy{margin:4px 0 11px;color:var(--sg-muted);font-size:12px}.sg-settings-panel{padding:2px 13px 12px;border:1px solid var(--sg-border);border-radius:10px;background:color-mix(in srgb,var(--sg-surface) 62%,transparent)}.sg-storage-card{padding:13px;border:1px solid var(--sg-border);border-radius:10px;background:color-mix(in srgb,var(--sg-surface) 62%,transparent)}.sg-storage-label{display:block;margin-bottom:6px;font-size:13px;font-weight:700}.sg-storage-path{display:block;width:100%;padding:9px 10px;border-radius:7px;background:var(--sg-soft);color:var(--sg-text);font:12px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.sg-storage-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:10px}.sg-storage-button{padding:6px 9px;border:1px solid var(--sg-border);border-radius:6px;background:var(--sg-surface);cursor:pointer;font-size:12px;font-weight:650;white-space:nowrap}.sg-storage-button:hover{border-color:color-mix(in srgb,var(--sg-accent) 38%,var(--sg-border));color:var(--sg-accent);transform:translateY(-1px)}.sg-storage-button:disabled{cursor:not-allowed;opacity:.5}.sg-storage-feedback{min-height:18px;margin:7px 0 -3px;color:var(--sg-good);font-size:12px}.sg-storage-feedback.failed{color:var(--sg-danger)}.sg-settings-menu{margin-top:10px}.sg-setting-suggestion{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 10px;margin:4px 0 10px;border-radius:7px;background:var(--sg-soft);font-size:12px}.sg-save-button{align-self:flex-end;padding:7px 12px;margin-top:12px;border:0;border-radius:6px;background:var(--sg-accent);color:white;cursor:pointer}.sg-save-button:disabled{opacity:.5;cursor:not-allowed}.sg-safe-note{padding:11px 12px;margin-bottom:12px;border-radius:7px;background:var(--sg-good-soft);color:var(--sg-good);font-weight:650}.sg-error-note{margin:8px 0 0;color:var(--sg-muted);font-size:12px}.sg-job-list{display:grid;gap:10px}.sg-job{padding:12px;border:1px solid var(--sg-border);border-radius:7px;background:var(--sg-surface)}.sg-job-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}.sg-job-title{margin:0;font-size:14px}.sg-job-meta{display:grid;grid-template-columns:112px minmax(0,1fr);gap:5px 10px;margin:11px 0;color:var(--sg-muted);font-size:12px}.sg-job-meta dd,.sg-job-meta dt{min-width:0;margin:0}.sg-job-meta dd{color:var(--sg-text);overflow-wrap:anywhere}.sg-job-error{max-height:150px;margin:9px 0;padding:9px;overflow:auto;border-radius:6px;background:var(--sg-danger-soft);color:var(--sg-danger)}.sg-job-actions{display:flex;align-items:center;justify-content:space-between;gap:10px}.sg-job-actions .sg-save-button{margin-top:0}.sg-status-feedback{margin:9px 0 0;color:var(--sg-muted);font-size:12px}.sg-status-feedback.failed{color:var(--sg-danger)}
      .sg-process-summary{padding:12px 13px;margin-bottom:14px;border-radius:8px;background:var(--sg-soft);color:var(--sg-text)}.sg-process-summary strong{display:block;font-size:13px}.sg-process-summary span{display:block;margin-top:2px;font-size:12px}.sg-process-groups{display:grid;gap:14px}.sg-process-group{overflow:hidden;border:1px solid var(--sg-border);border-radius:10px;background:var(--sg-surface)}.sg-process-group-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:11px 13px;border-bottom:1px solid var(--sg-border);background:color-mix(in srgb,var(--sg-soft) 65%,transparent)}.sg-process-group-title{margin:0;font-size:14px;font-weight:730}.sg-process-group-count{color:var(--sg-muted);font-size:11px}.sg-process-card{padding:13px}.sg-process-card+.sg-process-card{border-top:1px solid var(--sg-border)}.sg-process-card-head{display:flex;align-items:center;justify-content:space-between;gap:12px}.sg-process-range{font-weight:700}.sg-process-state{display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:680}.sg-process-state.processing{color:var(--sg-accent)}.sg-process-state.waiting{color:var(--sg-muted)}.sg-process-state.failed{color:var(--sg-warn)}.sg-process-stages{display:grid;gap:7px;margin-top:12px}.sg-process-stage{display:grid;grid-template-columns:18px minmax(0,1fr) auto;align-items:center;gap:7px;color:var(--sg-muted);font-size:12px}.sg-process-stage-name{color:var(--sg-text)}.sg-process-stage-state.done{color:var(--sg-good)}.sg-process-stage-state.processing{color:var(--sg-accent)}.sg-process-stage-state.failed{color:var(--sg-danger)}.sg-process-stage-state.waiting,.sg-process-stage-state.skipped{color:var(--sg-muted)}.sg-process-tech{margin-top:12px;padding-top:9px;border-top:1px solid var(--sg-border)}.sg-process-tech>summary{color:var(--sg-muted);font-size:11px;cursor:pointer}.sg-process-job{padding:10px 0}.sg-process-job+.sg-process-job{border-top:1px solid var(--sg-border)}.sg-process-job-head{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12px}.sg-process-job-meta{margin-top:5px;color:var(--sg-muted);font-size:11px}.sg-process-job .sg-job-error{font-size:11px}.sg-process-job-actions{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:8px}.sg-process-job-actions .sg-save-button{margin:0}.sg-process-footer{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:15px}.sg-process-footer .sg-quiet-button{padding:7px 9px;border-radius:6px;color:var(--sg-accent)}.sg-process-footer .sg-status-feedback{margin:0}
      .sg-process-notice{padding:12px 13px;margin:0 0 14px;border:1px solid color-mix(in srgb,var(--sg-warn) 30%,var(--sg-border));border-radius:8px;background:var(--sg-warn-soft)}.sg-process-notice strong{display:block;color:var(--sg-text);font-size:13px}.sg-process-notice span{display:block;margin-top:3px;color:var(--sg-muted);font-size:12px}.sg-process-unavailable{padding:24px 14px;text-align:center;color:var(--sg-muted)}.sg-process-unavailable strong{display:block;color:var(--sg-text);font-size:14px}.sg-process-unavailable span{display:block;margin-top:5px;font-size:12px}
      .sg-menu{display:grid;gap:7px}.sg-menu-row{display:grid;grid-template-columns:38px minmax(0,1fr) auto;align-items:center;gap:11px;width:100%;padding:12px;border:1px solid transparent;border-radius:10px;background:color-mix(in srgb,var(--sg-surface) 48%,transparent);text-align:left;cursor:pointer}.sg-menu-row:hover{border-color:color-mix(in srgb,var(--sg-accent) 22%,var(--sg-border));background:color-mix(in srgb,var(--sg-accent) 6%,var(--sg-surface));transform:translateY(-1px);box-shadow:0 8px 20px color-mix(in srgb,var(--sg-text) 6%,transparent)}.sg-menu-row:hover .sg-menu-title,.sg-menu-row:hover .sg-chevron{color:var(--sg-accent)}.sg-menu-icon{width:32px;height:32px;display:grid;place-items:center;border:1px solid color-mix(in srgb,var(--sg-accent) 14%,var(--sg-border));border-radius:8px;background:var(--sg-soft);color:var(--sg-muted);font-weight:700}.sg-menu-title{font-weight:700}.sg-menu-subtitle{color:var(--sg-muted);font-size:12px}.sg-counts{display:flex;gap:22px;padding:5px 0 18px;border-bottom:1px solid var(--sg-border)}.sg-count-value{font-size:22px;font-weight:760;letter-spacing:-.03em}.sg-count-label{color:var(--sg-muted);font-size:12px}.sg-structured-group{padding-top:17px}.sg-raw-group{padding:12px 0;border-bottom:1px solid var(--sg-border)}.sg-raw-group summary{cursor:pointer;font-weight:680}.sg-raw-json{max-height:360px;padding:11px;margin:10px 0 0;overflow:auto;border-radius:7px;background:var(--sg-soft)}
      .sg-import-card{padding:15px;border:1px solid color-mix(in srgb,var(--sg-accent) 22%,var(--sg-border));border-radius:11px;background:color-mix(in srgb,var(--sg-surface) 72%,transparent);box-shadow:0 8px 24px color-mix(in srgb,var(--sg-text) 5%,transparent)}.sg-import-card textarea{width:100%;min-height:270px;padding:11px;border:1px solid var(--sg-border);border-radius:8px;background:var(--sg-page);resize:vertical;outline:0;font:12px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace}.sg-import-card textarea:focus{border-color:var(--sg-accent);box-shadow:0 0 0 3px var(--sg-focus)}.sg-import-actions{display:flex;align-items:center;gap:10px;margin-top:11px;flex-wrap:wrap}.sg-import-button{padding:8px 13px;border:1px solid var(--sg-accent);border-radius:7px;background:var(--sg-accent);color:#fff;cursor:pointer;font-weight:680}.sg-import-button:disabled{cursor:wait;opacity:.6}.sg-import-hint{margin:8px 0 0;color:var(--sg-muted);font-size:12px}.sg-import-result{margin-top:12px;padding:10px 11px;border-radius:7px;background:var(--sg-good-soft);color:var(--sg-good);font-size:12px}.sg-import-error{margin-top:12px;padding:10px 11px;border-radius:7px;background:var(--sg-danger-soft);color:var(--sg-danger);font-size:12px}
      .sg-import-overlay{position:fixed;inset:0;z-index:40;display:flex;align-items:center;justify-content:center;padding:18px;background:rgba(0,0,0,.52);animation:sg-view-in var(--sg-medium) var(--sg-ease) both}.sg-import-dialog{width:min(720px,calc(100vw - 28px));max-height:calc(100vh - 36px);overflow:auto;padding:14px;border:1px solid color-mix(in srgb,var(--sg-border) 90%,#fff 10%);border-radius:12px;background:var(--sg-page);box-shadow:0 24px 80px rgba(0,0,0,.42)}.sg-import-dialog-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:13px}.sg-import-dialog-title{margin:0;font-size:18px;font-weight:760}.sg-import-step{padding:12px;margin-top:10px;border-radius:9px;background:color-mix(in srgb,var(--sg-surface) 78%,transparent)}.sg-import-step-head{display:flex;align-items:center;gap:9px;margin-bottom:9px}.sg-import-step-num{display:grid;place-items:center;width:25px;height:25px;border-radius:50%;background:var(--sg-text);color:var(--sg-page);font-weight:760}.sg-import-step-title{font-weight:720}.sg-import-prompt{max-height:185px;padding:10px;overflow:auto;border-radius:7px;background:var(--sg-page);color:var(--sg-muted);font:12px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap}.sg-import-dialog .sg-import-card{padding:0;border:0;box-shadow:none;background:transparent}.sg-import-dialog .sg-import-card textarea{min-height:165px;background:var(--sg-page)}.sg-import-dialog-foot{display:flex;justify-content:flex-end;gap:9px;margin-top:14px}.sg-import-cancel{padding:8px 18px;border:1px solid var(--sg-border);border-radius:7px;background:transparent;cursor:pointer}.sg-import-dialog .sg-import-button{padding:8px 18px}.sg-import-copy{margin-left:auto;padding:6px 11px;border:1px solid var(--sg-border);border-radius:6px;background:var(--sg-page);cursor:pointer;font-size:12px}.sg-import-copy:hover{border-color:var(--sg-accent);color:var(--sg-accent)}.sg-import-loading{color:var(--sg-muted);font-size:12px}.sg-import-preview{display:grid;gap:8px;margin-top:10px}.sg-import-preview-item{padding:10px;border:1px solid var(--sg-border);border-radius:8px;background:var(--sg-page)}.sg-import-preview-content{margin-top:7px;padding:8px;border-radius:6px;background:var(--sg-surface);font-size:12px;line-height:1.55}.sg-import-preview-content strong{display:block;margin-bottom:3px}.sg-import-preview-title{font-weight:700}.sg-import-preview-meta{display:flex;gap:8px;margin-top:5px;color:var(--sg-muted);font-size:12px}.sg-import-preview-reason{margin-top:5px;font-size:12px}.sg-import-review{display:flex;gap:7px;align-items:flex-start;margin-top:8px;color:var(--sg-warn);font-size:12px}
      .sg-audit{padding:14px 0;border-bottom:1px solid var(--sg-border)}.sg-audit summary{cursor:pointer}.sg-audit-body{margin-top:10px}.sg-audit-evidence{margin-top:9px}.sg-star{padding:14px 0;margin-top:14px;border-top:1px solid var(--sg-border)}.sg-star-actions{display:flex;gap:10px;align-items:center;margin-top:8px}.sg-link{color:var(--sg-accent);text-decoration:none}.sg-quiet-button{padding:5px 7px;border-radius:5px;color:var(--sg-muted);font-size:12px}.sg-pagination{display:flex;align-items:center;justify-content:center;gap:10px;padding:14px 0;color:var(--sg-muted);font-size:12px}.sg-page-button{padding:6px 10px;border:1px solid var(--sg-border);border-radius:6px;background:var(--sg-surface);cursor:pointer}.sg-page-button:hover:not(:disabled){border-color:var(--sg-accent);color:var(--sg-accent)}.sg-page-button:disabled{cursor:not-allowed;opacity:.45}.sg-page-error{color:var(--sg-danger)}
      .sg-decay-overview{padding:15px 16px 13px;margin-bottom:12px;border:1px solid var(--sg-border);border-radius:12px;background:var(--sg-surface)}.sg-decay-title{margin:0;font-size:14px;font-weight:740;letter-spacing:-.012em}.sg-decay-copy{margin:3px 0 12px;color:var(--sg-muted);font-size:12px}.sg-distribution{display:flex;align-items:stretch;gap:4px;min-width:0;overflow-x:auto;padding:2px 0 3px}.sg-level-chip{display:grid;place-items:center;min-width:39px;height:38px;padding:0 10px;border:1px solid color-mix(in srgb,var(--sg-accent) 36%,var(--sg-border));border-radius:7px;font-weight:740;white-space:nowrap;box-shadow:inset 0 1px 0 color-mix(in srgb,var(--sg-surface) 55%,transparent)}.sg-level-chip:hover{transform:translateY(-2px)}.sg-level-chip[data-level="0"],.sg-level-badge[data-level="0"],.sg-layer-item.current[data-level="0"]{background:var(--sg-level-0)}.sg-level-chip[data-level="1"],.sg-level-badge[data-level="1"],.sg-layer-item.current[data-level="1"]{background:var(--sg-level-1)}.sg-level-chip[data-level="2"],.sg-level-badge[data-level="2"],.sg-layer-item.current[data-level="2"]{background:var(--sg-level-2)}.sg-level-chip[data-level="3"],.sg-level-badge[data-level="3"],.sg-layer-item.current[data-level="3"]{background:var(--sg-level-3)}.sg-level-chip[data-level="4"],.sg-level-badge[data-level="4"],.sg-layer-item.current[data-level="4"]{background:var(--sg-level-4)}.sg-level-chip[data-level="5"],.sg-level-badge[data-level="5"],.sg-layer-item.current[data-level="5"]{background:var(--sg-level-5)}.sg-open-chip{min-width:116px;border-style:dashed;background:transparent;color:var(--sg-text);font-weight:650;box-shadow:none}.sg-time-direction{display:flex;align-items:center;gap:9px;margin-top:9px;color:var(--sg-muted);font-size:11px}.sg-time-line{height:1px;flex:1;background:var(--sg-border)}.sg-overview-meta{display:flex;gap:18px;flex-wrap:wrap;margin-top:8px;color:var(--sg-muted);font-size:12px}
      .sg-block-list{position:relative;border:1px solid var(--sg-border);border-radius:12px;background:color-mix(in srgb,var(--sg-surface) 56%,transparent);overflow:hidden}.sg-block-header,.sg-block-toggle{display:grid;grid-template-columns:88px 98px minmax(128px,1fr) 116px 24px;align-items:center;gap:8px;width:100%;min-width:0}.sg-block-header{padding:9px 12px;border-bottom:1px solid var(--sg-border);background:color-mix(in srgb,var(--sg-soft) 48%,transparent);color:var(--sg-muted);font-size:11px}.sg-block-unit+.sg-block-unit{border-top:1px solid var(--sg-border)}.sg-block-toggle{padding:11px 12px;border:0;background:transparent;text-align:left;cursor:pointer}.sg-block-toggle:hover,.sg-block-toggle[aria-expanded="true"]{background:color-mix(in srgb,var(--sg-accent) 6%,transparent)}.sg-block-toggle:hover .sg-row-chevron{color:var(--sg-accent);transform:translateX(2px)}.sg-block-toggle[aria-expanded="true"] .sg-row-chevron{color:var(--sg-accent);transform:rotate(180deg)}.sg-level-cell{display:flex;align-items:center;gap:6px;min-width:0}.sg-level-badge{display:inline-grid;place-items:center;min-width:38px;height:25px;padding:0 8px;border:1px solid color-mix(in srgb,var(--sg-accent) 42%,var(--sg-border));border-radius:6px;font-weight:740}.sg-lifted{padding:1px 5px;border:1px solid var(--sg-border);border-radius:5px;color:var(--sg-muted);font-size:10px;white-space:nowrap}.sg-block-name{font-weight:690}.sg-block-distance,.sg-block-turn{color:var(--sg-muted);font-size:12px}.sg-row-chevron{color:var(--sg-muted);font-size:17px;text-align:right;transition:color var(--sg-fast) var(--sg-ease),transform var(--sg-medium) var(--sg-ease)}.sg-open-row{cursor:default}.sg-open-row:hover{background:transparent}.sg-open-badge{display:inline-flex;align-items:center;height:25px;padding:0 8px;border:1px dashed var(--sg-muted);border-radius:6px;white-space:nowrap}.sg-block-expanded{padding:0 10px 11px;transform-origin:top;animation:sg-expand var(--sg-medium) var(--sg-ease) both}.sg-layer-panel{padding:11px;border:1px solid var(--sg-border);border-radius:9px;background:color-mix(in srgb,var(--sg-page) 82%,var(--sg-surface));box-shadow:inset 0 1px 0 color-mix(in srgb,var(--sg-surface) 70%,transparent)}.sg-layer-heading{display:flex;justify-content:space-between;gap:10px;margin-bottom:8px}.sg-layer-heading strong{font-size:13px}.sg-layer-heading span{color:var(--sg-muted);font-size:11px}.sg-layer-stack{display:flex;flex-direction:column;gap:5px}.sg-layer-hover{position:relative}.sg-layer-hover:has(.sg-layer-menu){z-index:15}.sg-layer-item:has(.sg-layer-menu){transform:none}.sg-layer-hover:after{content:"";position:absolute;left:100%;top:0;width:12px;height:100%}.sg-layer-item{position:relative;display:grid;grid-template-columns:39px minmax(0,1fr) 30px;align-items:stretch;min-height:39px;border:1px solid var(--sg-border);border-radius:7px;background:color-mix(in srgb,var(--sg-soft) 55%,transparent);color:var(--sg-muted)}.sg-layer-item:hover{border-color:color-mix(in srgb,var(--sg-accent) 34%,var(--sg-border));transform:translateX(2px)}.sg-layer-item.current{border-color:color-mix(in srgb,var(--sg-accent) 72%,var(--sg-border));color:var(--sg-text);box-shadow:inset 2px 0 0 var(--sg-accent)}.sg-layer-label{display:grid;place-items:center;border-right:1px solid var(--sg-border);font-weight:720;color:inherit}.sg-layer-preview{padding:8px 10px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:12px}.sg-layer-more{width:30px;border:0;border-left:1px solid transparent;border-radius:0 6px 6px 0;background:transparent;color:inherit;cursor:pointer;font-weight:800;letter-spacing:1px}.sg-layer-more:hover,.sg-layer-more[aria-expanded="true"]{background:color-mix(in srgb,var(--sg-accent) 14%,transparent)}.sg-layer-menu{position:absolute;right:3px;top:34px;z-index:14;min-width:132px;padding:4px;border:1px solid var(--sg-border);border-radius:8px;background:var(--sg-surface);box-shadow:var(--sg-shadow);animation:sg-pop var(--sg-fast) var(--sg-ease) both}.sg-layer-menu button{width:100%;padding:7px 9px;border:0;border-radius:5px;background:transparent;text-align:left;cursor:pointer;white-space:nowrap}.sg-layer-menu button:hover:not(:disabled){background:var(--sg-soft);color:var(--sg-accent)}.sg-layer-menu button:disabled{cursor:not-allowed;opacity:.45}.sg-layer-popover{position:absolute;left:calc(100% + 11px);top:-7px;z-index:12;width:min(360px,46vw);max-height:340px;padding:12px;overflow:auto;border:1px solid color-mix(in srgb,var(--sg-accent) 32%,var(--sg-border));border-radius:10px;background:var(--sg-surface);box-shadow:var(--sg-shadow);visibility:hidden;opacity:0;transform:translateX(-4px);transition:opacity var(--sg-fast) var(--sg-ease),transform var(--sg-fast) var(--sg-ease),visibility var(--sg-fast)}.sg-layer-hover:hover .sg-layer-popover,.sg-layer-item:focus-visible + .sg-layer-popover{visibility:visible;opacity:1;transform:translateX(0)}.sg-layer-popover strong{display:block;margin-bottom:7px}.sg-layer-full{margin:0;white-space:pre-wrap;font:12px/1.55 "Segoe UI Variable Text","Segoe UI",ui-sans-serif,system-ui,-apple-system,"Microsoft YaHei",sans-serif}.sg-inline-error{padding:7px 9px;margin-bottom:7px;border-radius:6px;background:var(--sg-danger-soft);color:var(--sg-danger);font-size:12px}
      .sg-loading{padding:32px 0}.sg-skeleton{position:relative;height:12px;margin:10px 0;overflow:hidden;border-radius:5px;background:var(--sg-soft)}.sg-skeleton:after{content:"";position:absolute;inset:0;background:color-mix(in srgb,var(--sg-surface) 55%,transparent);transform:translateX(-110%);animation:sg-shimmer 1.35s ease-in-out infinite}.sg-skeleton:nth-child(2){width:72%}.sg-empty{padding:40px 16px;text-align:center;color:var(--sg-muted)}.sg-empty strong{display:block;margin-bottom:5px;color:var(--sg-text);font-size:14px}.sg-error{padding:13px;margin-bottom:16px;border:1px solid color-mix(in srgb,var(--sg-danger) 28%,var(--sg-border));border-radius:9px;background:var(--sg-danger-soft);animation:sg-pop var(--sg-medium) var(--sg-ease) both}.sg-error-title{font-weight:700;color:var(--sg-danger)}.sg-error details{margin-top:7px;font-size:12px}
      .sg-muted{color:var(--sg-muted);font-size:12px}
      .sg-long-tabs{position:relative;z-index:30;display:flex;gap:4px;width:max-content;max-width:100%;box-sizing:border-box;margin:0 0 14px;padding:4px;border:1px solid var(--sg-border);border-radius:999px;background:color-mix(in srgb,var(--sg-surface) 62%,transparent)}.sg-long-tabs>button{padding:7px 19px;border:0;border-radius:999px;background:transparent;color:var(--sg-muted);cursor:pointer}.sg-long-tabs>button.active{background:var(--sg-soft);color:var(--sg-accent)}.sg-graph-menu{position:relative;z-index:31;display:inline-flex;align-items:center}.sg-long-tabs .sg-graph-menu-trigger{display:grid;place-items:center;align-self:center;flex:none;box-sizing:border-box;width:32px;height:32px;min-width:32px;min-height:32px;padding:0;border:0;border-radius:999px;background:transparent;color:var(--sg-muted);font-size:22px;line-height:1;cursor:pointer}.sg-graph-menu-trigger svg{display:block;width:16px;height:16px;flex:none}.sg-graph-menu-trigger:hover,.sg-graph-menu-trigger[aria-expanded=true]{background:var(--sg-soft);color:var(--sg-accent)}.sg-graph-menu-popover{position:absolute;z-index:32;right:0;left:auto;top:calc(100% + 8px);width:min(300px,calc(100vw - 32px));padding:10px;border:1px solid var(--sg-border);border-radius:10px;background:var(--sg-page);box-shadow:var(--sg-shadow);text-align:left;}
      .sg-migration{display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:9px;margin:0 0 10px;padding:9px 12px;border:1px solid color-mix(in srgb,var(--sg-accent) 28%,var(--sg-border));border-radius:8px;background:color-mix(in srgb,var(--sg-accent) 7%,transparent);font-size:12px}.sg-migration small{color:var(--sg-muted)}
      .sg-long-explorer{position:relative}.sg-long-explorer.fullscreen{position:fixed;inset:12px;z-index:2147482000;display:flex;flex-direction:column;max-width:none;padding:18px;border:1px solid var(--sg-border);border-radius:12px;background:var(--sg-page);box-shadow:0 24px 80px rgba(0,0,0,.48)}.sg-long-explorer.fullscreen .sg-long-layout{flex:1;height:auto;min-height:0}.sg-long-explorer.fullscreen .sg-long-tabs{flex:0 0 auto}.sg-long-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-bottom:8px}.sg-long-toolbar .sg-search{flex:1 1 14rem;min-width:min(100%,14rem);margin:0}.sg-long-toolbar .sg-toolbar-button{flex-shrink:0}.sg-toolbar-button{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:39px;padding:0 13px;border:1px solid var(--sg-border);border-radius:7px;background:var(--sg-surface);color:var(--sg-text);cursor:pointer;white-space:nowrap}.sg-toolbar-button:hover,.sg-toolbar-button[aria-expanded="true"]{border-color:var(--sg-accent);color:var(--sg-accent)}.sg-toolbar-count{margin:0 0 8px;color:var(--sg-muted);font-size:11px;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}.sg-long-layout{display:grid;grid-template-columns:minmax(0,1.72fr) minmax(280px,.9fr);height:min(680px,calc(100vh - 320px));min-height:480px;border:1px solid var(--sg-border);border-radius:9px;overflow:hidden;background:color-mix(in srgb,var(--sg-page) 74%,transparent)}.sg-summary-layout{grid-template-columns:minmax(0,1fr)}
      .sg-filterbar{display:flex;gap:7px;margin:0 0 8px;padding:8px;border:1px solid var(--sg-border);border-radius:7px;background:color-mix(in srgb,var(--sg-surface) 62%,transparent);flex-wrap:wrap}.sg-filterbar select{min-width:112px;padding:6px 25px 6px 8px;border:1px solid var(--sg-border);border-radius:6px;background:var(--sg-surface);color:var(--sg-text);font-size:11px}.sg-active-filter-count{display:inline-grid;place-items:center;min-width:18px;height:18px;padding:0 5px;border-radius:999px;background:var(--sg-accent);color:white;font-size:10px}
      .sg-graph-canvas{position:relative;min-width:0;overflow:hidden;background:var(--sg-page)}.sg-cytoscape{position:absolute;inset:0 0 38px;min-height:0}.sg-graph-zoom{position:absolute;z-index:7;top:12px;right:12px;display:grid;grid-template-columns:30px minmax(86px,124px) 30px;align-items:center;gap:5px;padding:5px;border:1px solid color-mix(in srgb,var(--sg-accent) 20%,var(--sg-border));border-radius:7px;background:color-mix(in srgb,var(--sg-surface) 94%,transparent);box-shadow:0 6px 18px color-mix(in srgb,var(--sg-text) 10%,transparent);}.sg-graph-zoom button{display:grid;place-items:center;width:30px;height:30px;padding:0;border:0;border-radius:5px;background:transparent;color:var(--sg-text);font-size:20px;line-height:1;cursor:pointer}.sg-graph-zoom button:hover:not(:disabled){background:var(--sg-soft);color:var(--sg-accent)}.sg-graph-zoom button:disabled{cursor:default;opacity:.35}.sg-graph-zoom input{width:100%;min-width:0;height:18px;margin:0;accent-color:var(--sg-accent);cursor:pointer}.sg-graph-legend{position:absolute;z-index:5;left:14px;bottom:10px;display:flex;gap:14px;flex-wrap:wrap;color:var(--sg-muted);font-size:11px}.sg-graph-legend span{display:flex;align-items:center;gap:5px}.sg-graph-legend i{width:9px;height:9px;border-radius:50%}.sg-node-bubble{position:absolute;z-index:8;width:min(310px,42%);padding:12px;border:1px solid color-mix(in srgb,var(--sg-accent) 38%,var(--sg-border));border-radius:9px;background:color-mix(in srgb,var(--sg-surface) 94%,transparent);box-shadow:0 14px 34px rgba(0,0,0,.3);transform:translate(35px,-50%)}.sg-node-bubble.flip{transform:translate(calc(-100% - 35px),-50%)}.sg-node-bubble h3{margin:0;font-size:14px}.sg-node-bubble-head,.sg-node-bubble-foot{display:flex;align-items:center;justify-content:space-between;gap:8px}.sg-node-bubble-state{margin:7px 0;color:var(--sg-muted);font-size:11px}.sg-node-bubble ul{margin:7px 0;padding-left:17px;font-size:11px;line-height:1.55}.sg-node-bubble-foot{padding-top:8px;border-top:1px solid var(--sg-border);color:var(--sg-muted);font-size:11px}.sg-node-bubble button{border:0;background:transparent;color:var(--sg-accent);cursor:pointer;font-weight:680}.sg-node-tags{display:flex;gap:5px;flex-wrap:wrap;margin-top:7px}.sg-node-tag{padding:2px 7px;border-radius:999px;background:var(--sg-accent-soft);color:var(--sg-accent);font-size:11px}.sg-graph-a11y{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
      .sg-long-detail{min-width:0;padding:16px;overflow:auto;border-left:1px solid var(--sg-border);background:color-mix(in srgb,var(--sg-surface) 70%,transparent)}.sg-placeholder-detail{display:grid;place-items:center;color:var(--sg-muted);text-align:center}.sg-long-detail h2{margin:0;font-size:17px}.sg-long-detail section{padding:13px 0;border-top:1px solid var(--sg-border)}.sg-long-detail section:first-of-type{margin-top:13px}.sg-long-detail h3{margin:0 0 8px;font-size:13px}.sg-long-detail ul{margin:0;padding-left:18px;font-size:12px;line-height:1.65}.sg-detail-copy{margin:0;color:var(--sg-muted);font-size:12px;line-height:1.65;white-space:pre-wrap}.sg-node-head{display:flex;align-items:center;gap:10px}.sg-node-avatar{display:grid;place-items:center;width:42px;height:42px;border-radius:50%;color:white;font-size:20px}.sg-status-dot{color:var(--sg-good);font-size:12px}.sg-relation-row{display:grid;grid-template-columns:68px 1fr auto;gap:7px;padding:7px 0;border-bottom:1px solid color-mix(in srgb,var(--sg-border) 65%,transparent);font-size:12px}.sg-relation-row span,.sg-relation-row small{color:var(--sg-muted)}.sg-support-event{display:flex;align-items:center;justify-content:space-between;width:100%;margin:5px 0;padding:9px;border:1px solid var(--sg-border);border-radius:7px;background:transparent;color:var(--sg-text);text-align:left;cursor:pointer}.sg-support-event:hover{border-color:var(--sg-accent)}
      .sg-timeline-layout{grid-template-columns:minmax(420px,1.35fr) minmax(320px,.9fr)}.sg-timeline{position:relative;padding:10px 20px 18px;overflow:auto}.sg-time-group{position:relative}.sg-time-group>h3{margin:7px 0 8px;padding-left:17px;font-size:13px}.sg-time-group:before{content:"";position:absolute;left:5px;top:30px;bottom:-12px;width:1px;background:var(--sg-border)}.sg-timeline-card{position:relative;display:grid;grid-template-columns:112px minmax(0,1fr) auto;gap:12px;width:100%;margin:0 0 8px;padding:12px 14px;border:1px solid var(--sg-border);border-radius:8px;background:color-mix(in srgb,var(--sg-surface) 62%,transparent);color:var(--sg-text);text-align:left;cursor:pointer}.sg-timeline-card:hover,.sg-timeline-card.selected{border-color:var(--sg-accent);background:color-mix(in srgb,var(--sg-accent) 7%,var(--sg-surface))}.sg-timeline-dot{position:absolute;left:-19px;top:17px;width:9px;height:9px;border:2px solid var(--sg-accent);border-radius:50%;background:var(--sg-page)}.sg-event-clock{font-size:11px;white-space:normal}.sg-event-clock small{display:block;margin-top:3px;color:var(--sg-muted);line-height:1.35}.sg-event-title-row{display:flex;align-items:center;gap:7px;min-width:0}.sg-event-title-row strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.sg-event-main p{margin:5px 0 7px;color:var(--sg-muted);font-size:12px;line-height:1.4;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.sg-type-badge{display:inline-flex;align-items:center;width:max-content;padding:2px 7px;border:1px solid color-mix(in srgb,var(--sg-accent) 30%,var(--sg-border));border-radius:5px;background:color-mix(in srgb,var(--sg-accent) 10%,transparent);color:var(--sg-accent);font-size:10px}.sg-event-status{display:inline-flex;width:max-content;height:max-content;padding:3px 8px;border:1px solid var(--sg-border);border-radius:999px;color:var(--sg-muted);font-size:10px;white-space:nowrap}.sg-event-status.occurred{border-color:color-mix(in srgb,var(--sg-good) 40%,var(--sg-border));background:var(--sg-good-soft);color:var(--sg-good)}.sg-event-status.planned,.sg-event-status.ongoing{border-color:color-mix(in srgb,var(--sg-accent) 35%,var(--sg-border));color:var(--sg-accent)}.sg-event-status.cancelled{color:var(--sg-muted)}.sg-event-detail-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:7px}.sg-event-popover{position:fixed;z-index:2147483000;width:min(380px,calc(100vw - 24px));max-height:min(72vh,620px);overflow:auto;border:1px solid color-mix(in srgb,var(--sg-accent) 38%,var(--sg-border));border-radius:10px;background:var(--sg-page);box-shadow:0 18px 50px rgba(0,0,0,.38)}.sg-event-popover .sg-long-detail{border:0;background:transparent}.sg-popover-close{position:absolute;right:8px;top:8px;z-index:2;width:27px;height:27px;border:0;border-radius:6px;background:var(--sg-soft);cursor:pointer}.sg-time-grid{display:grid;grid-template-columns:92px 1fr;margin:0;border:1px solid var(--sg-border);border-radius:7px;overflow:hidden;font-size:11px}.sg-time-grid dt,.sg-time-grid dd{margin:0;padding:7px 8px;border-bottom:1px solid var(--sg-border)}.sg-time-grid dt{color:var(--sg-muted);background:var(--sg-soft)}.sg-time-grid dt:nth-last-of-type(1),.sg-time-grid dd:nth-last-of-type(1){border-bottom:0}.sg-entity-pill{display:inline-flex;align-items:center;gap:4px;padding:3px 8px;border:1px solid var(--sg-border);border-radius:999px;background:transparent;color:var(--sg-text);font-size:11px;cursor:pointer}.sg-evidence-row{display:flex;justify-content:space-between;gap:8px;padding:6px 0;color:var(--sg-muted);font-size:11px}.sg-evidence-row code{max-width:180px;overflow:hidden;text-overflow:ellipsis}.sg-source-button{width:100%;padding:9px;border:1px solid color-mix(in srgb,var(--sg-accent) 42%,var(--sg-border));border-radius:7px;background:transparent;color:var(--sg-accent);cursor:pointer}
      .sg-view{min-width:0;animation:sg-view-in var(--sg-medium) var(--sg-ease) both}.sg-long-tabs{border-radius:10px}.sg-long-tabs>button{border-radius:7px}.sg-long-tabs>button:hover{color:var(--sg-text)}.sg-long-tabs>button.active{box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--sg-accent) 16%,var(--sg-border))}.sg-toolbar-button:hover,.sg-source-button:hover,.sg-primary-link:hover{transform:translateY(-1px);box-shadow:0 7px 18px color-mix(in srgb,var(--sg-accent) 14%,transparent)}.sg-long-layout{border-radius:12px;box-shadow:0 10px 28px color-mix(in srgb,var(--sg-text) 6%,transparent)}.sg-long-explorer.fullscreen{animation:sg-fullscreen-in var(--sg-medium) var(--sg-ease) both}.sg-node-bubble{animation:sg-fade var(--sg-medium) var(--sg-ease) both;box-shadow:var(--sg-shadow)}.sg-event-popover{animation:sg-pop var(--sg-medium) var(--sg-ease) both;box-shadow:var(--sg-shadow)}.sg-long-detail{animation:sg-panel-in var(--sg-medium) var(--sg-ease) both}.sg-timeline-card:hover{transform:translateX(2px);box-shadow:0 7px 18px color-mix(in srgb,var(--sg-text) 6%,transparent)}.sg-timeline-card.selected{box-shadow:inset 3px 0 0 var(--sg-accent)}.sg-support-event:hover,.sg-entity-pill:hover{transform:translateY(-1px);background:color-mix(in srgb,var(--sg-accent) 5%,transparent)}
      @keyframes sg-view-in{from{opacity:0}to{opacity:1}}
      @keyframes sg-expand{from{opacity:0;transform:translateY(-5px) scale(.992)}to{opacity:1;transform:translateY(0) scale(1)}}
      @keyframes sg-pop{from{opacity:0;transform:translateY(5px) scale(.985)}to{opacity:1;transform:translateY(0) scale(1)}}
      @keyframes sg-fade{from{opacity:0}to{opacity:1}}
      @keyframes sg-panel-in{from{opacity:0;transform:translateX(7px)}to{opacity:1;transform:translateX(0)}}
      @keyframes sg-fullscreen-in{from{opacity:0;transform:scale(.99)}to{opacity:1;transform:scale(1)}}
      @keyframes sg-shimmer{to{transform:translateX(110%)}}
      @media (min-width:720px){.sg-brand-kicker{display:block}}
      @media (max-width:900px){.sg-long-layout{grid-template-columns:1fr;height:auto;max-height:none}.sg-long-explorer.fullscreen{inset:4px;padding:10px}.sg-long-explorer.fullscreen .sg-long-layout{overflow:auto}.sg-graph-canvas{height:520px}.sg-long-detail{max-height:520px;border-top:1px solid var(--sg-border);border-left:0}.sg-timeline{max-height:520px}.sg-node-bubble{width:min(300px,72%)}}
      @media (max-width:620px){.sg-long-toolbar{flex-wrap:wrap}.sg-long-toolbar .sg-search{flex-basis:100%}.sg-toolbar-button{flex:1}.sg-timeline-card{grid-template-columns:78px minmax(0,1fr)}.sg-timeline-card>.sg-event-status{grid-column:2}.sg-node-bubble{left:50%!important;top:auto!important;bottom:45px;width:calc(100% - 24px);transform:translateX(-50%)!important}.sg-weight-metrics{grid-template-columns:1fr}.sg-weight-chart svg{min-height:132px}}
      @media (max-width:860px){.sg-layer-hover:after{display:none}.sg-layer-popover{position:relative;left:auto;top:auto;width:auto;max-height:280px;margin:5px 0 1px;display:none;transform:none}.sg-layer-hover:hover .sg-layer-popover,.sg-layer-item:focus-visible + .sg-layer-popover{display:block;transform:none}}
      @media (max-width:560px){.sg-memory{padding:12px 12px 26px}.sg-header-row{align-items:flex-start;gap:10px}.sg-header-row-primary{align-items:center}.sg-header-row-secondary{flex-wrap:wrap}.sg-ghstar{height:26px}.sg-ghstar-label{padding:0 7px}.sg-ghstar-count{padding:0 7px}.sg-brand-name{font-size:14px}.sg-tabs{margin-left:-2px;margin-right:-2px}.sg-tab{padding-left:0;padding-right:0}.sg-alert,.sg-memory-alert{grid-template-columns:auto minmax(0,1fr)}.sg-alert>.sg-chevron,.sg-memory-alert>.sg-chevron{display:none}.sg-tech-row{grid-template-columns:1fr;gap:1px}.sg-counts{gap:16px}.sg-entry-title{font-size:14px}.sg-block-header{display:none}.sg-block-toggle{grid-template-columns:76px minmax(76px,1fr) 24px;gap:6px}.sg-block-turn{grid-column:1/3}.sg-block-distance{display:none}.sg-layer-heading{display:block}.sg-layer-heading span{display:block;margin-top:2px}}
      .sg-decay-head{display:flex;align-items:center;justify-content:space-between;gap:12px}.sg-conversation{display:flex;align-items:center;justify-content:flex-end;gap:5px;min-width:0;color:var(--sg-muted);font-size:11px}.sg-conversation select{min-width:0;max-width:230px;padding:3px 21px 3px 6px;border:1px solid var(--sg-border);border-radius:5px;background:var(--sg-surface);font-size:11px;text-overflow:ellipsis}.sg-distribution{scrollbar-width:none}.sg-distribution::-webkit-scrollbar{display:none}.sg-distribution-rail{display:block;width:100%;height:14px;margin:4px 0 0;accent-color:var(--sg-accent);cursor:pointer}.sg-distribution-rail:disabled{cursor:default;opacity:.38}.sg-layer-hover:after{display:none}.sg-layer-more-placeholder{width:30px}.sg-layer-popover{position:fixed!important;left:0;top:0;z-index:2147483000;width:min(390px,calc(100vw - 24px));max-height:min(70vh,520px);display:block!important;margin:0;overflow:auto;visibility:visible!important;opacity:1!important;transform:none!important;transition:opacity .1s ease;border:1px solid color-mix(in srgb,var(--sg-accent) 38%,var(--sg-border));background:var(--sg-surface);color:var(--sg-text);box-shadow:0 18px 50px rgba(0,0,0,.38)}
      .sg-feedback-wizard{width:100%;max-width:680px;margin:8px auto;padding:22px;border:1px solid var(--sg-border);border-radius:12px;background:var(--sg-page)}.sg-feedback-heading h2{margin:0;font-size:19px;line-height:1.4;letter-spacing:-.02em}.sg-feedback-heading p{margin:6px 0 0;color:var(--sg-muted);font-size:12px}.sg-feedback-steps{display:flex;list-style:none;gap:10px;margin:23px 0;padding:0;border-bottom:1px solid var(--sg-border)}.sg-feedback-steps li{display:flex;flex:1;align-items:center;gap:7px;padding:0 4px 12px;color:var(--sg-muted);font-size:12px;min-width:0}.sg-feedback-steps li.active{color:var(--sg-accent);border-bottom:2px solid var(--sg-accent);font-weight:650}.sg-feedback-step-number{display:grid;place-items:center;flex:0 0 auto;width:23px;height:23px;border-radius:6px;background:var(--sg-soft);font-size:11px;font-variant-numeric:tabular-nums}.sg-feedback-steps li.active .sg-feedback-step-number{background:var(--sg-accent);color:#fff}.sg-feedback-stage h3{margin:0 0 7px;font-size:16px;line-height:1.5}.sg-feedback-stage .sg-support-description{min-height:142px}.sg-feedback-options{margin:20px 0 0;padding:0;border:0}.sg-feedback-options legend{padding:0;font-size:13px;font-weight:650}.sg-feedback-options>p,.sg-feedback-caption{margin:6px 0;color:var(--sg-muted);font-size:12px;line-height:1.65}.sg-feedback-checks{display:flex;gap:22px;flex-wrap:wrap}.sg-feedback-options p.sg-error-note{color:var(--sg-danger)}.sg-feedback-actions{display:flex;align-items:center;justify-content:flex-end;gap:10px;flex-wrap:wrap;margin-top:22px}.sg-feedback-ready{padding:12px 0 4px;text-align:center}.sg-feedback-ready h3{font-size:18px}.sg-feedback-ready>p{margin:11px 0;color:var(--sg-muted);font-size:12px;line-height:1.7}.sg-feedback-unsent{display:inline-flex;padding:2px 8px;border-radius:5px;background:var(--sg-soft);color:var(--sg-muted);font-size:11px}.sg-feedback-contact{margin-top:24px;padding-top:18px;border-top:1px solid var(--sg-border)}.sg-feedback-contact-head{display:flex;align-items:center;justify-content:space-between;gap:12px}.sg-feedback-contact-head h3{margin:0;font-size:13px}.sg-feedback-email{margin:8px 0;font-size:16px;overflow-wrap:anywhere;user-select:text}.sg-feedback-secondary{display:flex;gap:10px;flex-wrap:wrap;margin-top:18px}.sg-feedback-privacy{margin-top:18px}.sg-feedback-wizard button:focus-visible{outline:2px solid var(--sg-accent);outline-offset:3px}.sg-feedback-wizard button:disabled{opacity:.5;cursor:not-allowed}.sg-feedback-wizard .sg-primary-link:active:not(:disabled){transform:translateY(1px)}@media(max-width:560px){.sg-feedback-wizard{padding:16px}.sg-feedback-steps{gap:5px}.sg-feedback-steps li{flex-direction:column;gap:6px;padding:0 2px 10px;text-align:center}.sg-feedback-actions{justify-content:flex-start}.sg-feedback-wizard .sg-support-description,.sg-feedback-wizard .sg-support-input{font-size:16px}}@media(pointer:coarse){.sg-feedback-wizard button,.sg-feedback-wizard .sg-check{min-height:44px}}
      .sg-contact-trigger{padding:4px 0;border:0;background:transparent;font-family:inherit;cursor:pointer}.sg-contact-panel{position:absolute;right:0;top:calc(100% + 9px);z-index:50;width:min(340px,calc(100vw - 32px));max-height:calc(100vh - 40px);overflow:auto;padding:14px;border:1px solid var(--sg-border);border-radius:10px;background:var(--sg-page);box-shadow:0 12px 36px color-mix(in srgb,var(--sg-text) 18%,transparent);color:var(--sg-text);text-align:left}.sg-contact-head{display:flex;align-items:center;justify-content:space-between;gap:12px}.sg-contact-email{margin:9px 0;overflow-wrap:anywhere;user-select:text;font-size:14px}.sg-contact-note{margin:8px 0 0;color:var(--sg-muted);font-size:12px;line-height:1.6}@media(max-width:560px){.sg-contact-panel{position:fixed;left:12px;right:12px;top:auto;bottom:18px;width:auto}}
      .sg-support-card{padding:14px 0;border-bottom:1px solid var(--sg-border)}.sg-support-card h3{margin:0;font-size:14px}.sg-support-card p{margin:4px 0 10px;color:var(--sg-muted);font-size:12px}.sg-primary-link{display:inline-flex;padding:7px 11px;border:1px solid var(--sg-accent);border-radius:6px;background:var(--sg-accent);color:#fff;text-decoration:none;cursor:pointer}.sg-support-actions{display:flex;align-items:center;gap:9px;flex-wrap:wrap;margin-top:11px}.sg-support-preview-panel{margin-top:12px;padding:12px;border:1px solid var(--sg-border);border-radius:8px;background:var(--sg-soft)}.sg-support-preview-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}.sg-support-preview{width:100%;min-height:260px;max-height:440px;margin-top:9px;padding:11px;border:1px solid var(--sg-border);border-radius:7px;background:var(--sg-surface);resize:vertical;outline:0;color:var(--sg-text);font:12px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre;overflow:auto}.sg-support-preview:focus{border-color:var(--sg-accent);box-shadow:0 0 0 3px var(--sg-focus)}.sg-support-status{margin-top:9px;color:var(--sg-good);font-size:12px}.sg-support-error{margin-top:9px;color:var(--sg-danger);font-size:12px}.sg-check{display:flex;align-items:flex-start;gap:8px;margin:9px 0;color:var(--sg-text);font-size:12px}.sg-check input{margin-top:3px}.sg-privacy-note{padding:10px 11px;margin:12px 0;border-radius:7px;background:var(--sg-good-soft);color:var(--sg-good);font-size:12px}.sg-footer{margin-top:24px;padding-top:13px;border-top:1px solid var(--sg-border);text-align:center;color:var(--sg-muted);font-size:12px}.sg-footer button{padding:2px 4px;border:0;background:transparent;color:var(--sg-accent);cursor:pointer}.sg-virtual-note{margin-top:6px;color:var(--sg-muted);font-size:11px}
      .sg-support-compose{display:grid;gap:8px}.sg-support-compose-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}.sg-support-field{display:grid;gap:5px;color:var(--sg-muted);font-size:11px}.sg-support-input,.sg-support-description{width:100%;padding:9px 10px;border:1px solid var(--sg-border);border-radius:7px;background:var(--sg-surface);color:var(--sg-text);font:inherit;outline:0}.sg-support-description{min-height:190px;resize:vertical;line-height:1.55}.sg-support-input:focus,.sg-support-description:focus{border-color:var(--sg-accent);box-shadow:0 0 0 3px var(--sg-focus)}.sg-support-ai{display:inline-flex;align-items:center;gap:6px;padding:7px 11px;border:1px solid var(--sg-accent);border-radius:6px;background:transparent;color:var(--sg-accent);font-weight:650;cursor:pointer}.sg-support-empty{padding:22px 14px;border:1px dashed var(--sg-border);border-radius:8px;background:var(--sg-soft);color:var(--sg-muted);text-align:center}.sg-support-metrics{margin:0;color:var(--sg-muted);font-size:11px}.sg-support-sync{color:var(--sg-muted);font-size:11px}
      .sg-support-ai-notice{position:sticky;top:8px;z-index:8;display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:start;gap:10px;margin:12px 0;padding:13px 14px;border:1px solid color-mix(in srgb,var(--sg-good) 45%,var(--sg-border));border-radius:8px;background:color-mix(in srgb,var(--sg-good-soft) 92%,var(--sg-surface));color:var(--sg-text);box-shadow:0 8px 24px rgba(0,0,0,.16);scroll-margin-top:8px}.sg-support-ai-notice-mark{display:grid;place-items:center;width:24px;height:24px;border-radius:50%;background:var(--sg-good);color:#fff;font-weight:800}.sg-support-ai-notice strong{display:block;color:var(--sg-good);font-size:13px}.sg-support-ai-notice p{margin:4px 0 0;color:var(--sg-text);font-size:12px;line-height:1.5}.sg-support-ai-notice .sg-quiet-button{margin-top:9px}.sg-support-ai-notice-close{display:grid;place-items:center;width:26px;height:26px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--sg-muted);font-size:20px;line-height:1;cursor:pointer}.sg-support-ai-notice-close:hover{background:var(--sg-soft);color:var(--sg-text)}
      @media (max-width:560px){.sg-decay-head{align-items:flex-start;flex-direction:column}.sg-conversation{width:100%;justify-content:flex-start}.sg-conversation select{max-width:100%;flex:1}}
      @media (prefers-reduced-motion:reduce){.sg-memory *,.sg-memory *:before,.sg-memory *:after{scroll-behavior:auto!important;animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important}.sg-processing-icon,.sg-memory-alert-mark{animation:none}.sg-skeleton:after{display:none}}
      .sg-tabs{grid-template-columns:repeat(6,1fr)}
      .sg-profile-head{display:flex;align-items:center;justify-content:space-between;gap:12px}.sg-profile-sync{color:var(--sg-muted);font-size:11px;white-space:nowrap}.sg-profile-sync:before{content:'●';margin-right:5px;color:var(--sg-good)}.sg-profile-sync.pending:before{color:var(--sg-accent)}.sg-profile-sync.failed:before{color:var(--sg-danger)}
      .sg-profile-group{margin-top:19px;padding:14px 16px 3px;border:1px solid var(--sg-border);border-radius:10px;background:color-mix(in srgb,var(--sg-surface) 62%,transparent)}.sg-profile-group h3{margin:0 0 4px;font-size:14px}.sg-profile-row{border-bottom:1px solid var(--sg-border)}.sg-profile-row:last-child{border-bottom:0}.sg-profile-summary{display:grid;grid-template-columns:minmax(170px,1fr) minmax(0,2fr) auto;align-items:center;gap:14px;min-height:51px}.sg-profile-label{font-size:13px;font-weight:650}.sg-profile-value{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--sg-muted);font-size:13px}.sg-profile-value.empty{opacity:.66}.sg-profile-action{padding:5px 8px;border:0;border-radius:6px;background:transparent;color:var(--sg-accent)!important;cursor:pointer;font-size:12px!important}.sg-profile-action:hover{background:var(--sg-accent-soft)}.sg-profile-editor{padding:0 0 14px}.sg-profile-editor :is(input,textarea){width:100%;padding:9px 10px;border:1px solid var(--sg-border);border-radius:7px;background:var(--sg-surface);color:var(--sg-text);outline:0}.sg-profile-editor textarea{min-height:104px;resize:vertical;font:inherit}.sg-profile-editor :is(input,textarea):focus{border-color:var(--sg-accent);box-shadow:0 0 0 3px var(--sg-focus)}.sg-profile-editor-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:7px}.sg-profile-count{color:var(--sg-muted);font-size:11px}.sg-profile-actions{display:flex;align-items:center;gap:6px}.sg-profile-actions .sg-save-button{margin-top:0}.sg-profile-conflict{margin:8px 0 0;color:var(--sg-warn);font-size:12px}.sg-profile-error{margin:8px 0 0;color:var(--sg-danger);font-size:12px}
      .sg-profile-action:disabled{opacity:.45;cursor:default}.sg-profile-action:disabled:hover{background:transparent}
      .sg-profile-content{display:flex;align-items:center;min-width:0}.sg-profile-saved{flex-shrink:0;margin-left:8px;color:var(--sg-good);font-size:12px;white-space:nowrap}.sg-profile-save-feedback{margin:5px 0 0;color:var(--sg-warn);font-size:12px;line-height:1.5}.sg-profile-save-feedback p{margin:0}.sg-profile-save-feedback p+p{margin-top:3px}
      .sg-profile-summary.editing{align-items:start;padding:8px 0}.sg-profile-summary.editing>.sg-profile-label{padding-top:8px}.sg-profile-summary.editing>.sg-profile-action{visibility:hidden}.sg-profile-content .sg-profile-value{border:0;padding:0;background:transparent;text-align:left;font-family:inherit;cursor:text}.sg-profile-content .sg-profile-value:disabled{cursor:default}.sg-profile-editor{min-width:0;padding:0}.sg-profile-editor-foot{margin-top:5px}.sg-profile-actions .sg-save-button{padding:6px 10px;font-size:12px}
      @media(max-width:560px){.sg-profile-summary{grid-template-columns:minmax(0,1fr) minmax(0,1fr) auto;gap:8px}.sg-profile-summary.editing{grid-template-columns:minmax(0,1fr) minmax(0,2fr)}.sg-profile-summary.editing>.sg-profile-action{display:none}.sg-profile-editor-foot{flex-wrap:wrap;gap:4px}.sg-profile-editor-foot .sg-profile-actions{margin-left:auto}.sg-profile-group{padding:11px 12px 2px}.sg-profile-label,.sg-profile-value{font-size:12px}}
      .sg-layer-item{grid-template-columns:39px minmax(0,1fr) auto}.sg-layer-use,.sg-layer-using{display:flex;align-items:center;justify-content:center;min-width:0;max-width:10rem;padding:7px 10px;border:0;border-left:1px solid var(--sg-border);border-radius:0 6px 6px 0;background:transparent;color:var(--sg-accent);font:inherit;font-size:12px;line-height:1.45;white-space:normal;text-align:center}.sg-layer-use{cursor:pointer}.sg-layer-use:hover:not(:disabled){background:color-mix(in srgb,var(--sg-accent) 10%,transparent)}.sg-layer-use:focus-visible{outline:2px solid var(--sg-accent);outline-offset:-3px}.sg-layer-use:disabled{cursor:wait;opacity:.6}.sg-layer-using{color:var(--sg-muted)}.sg-layer-hint{margin:0 0 10px;color:var(--sg-muted);font-size:12px;line-height:1.6}.sg-selection-feedback{margin:0 12px 10px;padding:8px 10px;border-radius:6px;background:var(--sg-soft);color:var(--sg-muted);font-size:12px;line-height:1.6;overflow-wrap:anywhere}.sg-selection-feedback.error{background:var(--sg-danger-soft);color:var(--sg-danger)}
      ${eventDetailCss}
      ${topicDirectoryCss}
    `

    const citationCss = `
      .sg-stm{container:sg-stm / inline-size;--sgm-text:var(--dsw-alias-label-primary,#0f1115);--sgm-muted:var(--dsw-alias-label-tertiary,#8a8f98);--sgm-secondary:var(--dsw-alias-label-secondary,#61666b);--sgm-border:var(--dsw-alias-border-l2,rgba(0,0,0,.1));--sgm-soft:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04));--sgm-accent:var(--dsw-alias-state-business-primary,#4176e6);width:100%;max-width:640px;color:var(--sgm-muted);font:12px/1.5 "Segoe UI Variable Text","Segoe UI",ui-sans-serif,system-ui,-apple-system,"Microsoft YaHei",sans-serif;font-variant-numeric:tabular-nums}
      .sg-stm *{box-sizing:border-box}.sg-stm-line{display:grid;grid-template-columns:minmax(18px,1fr) auto minmax(18px,1fr);align-items:center;gap:10px;width:100%;min-height:24px;margin:1px 0;color:var(--sgm-muted);text-align:center}.sg-stm-rule{height:1px;background:color-mix(in srgb,var(--sgm-border) 76%,transparent)}.sg-stm-line-copy{white-space:nowrap}.sg-stm-line.processing .sg-stm-line-copy:before{content:"";display:inline-block;width:6px;height:6px;margin:0 7px 1px 0;border-radius:50%;background:var(--sgm-accent);animation:sg-stm-pulse 1.15s ease-in-out infinite}
      .sg-stm-toggle{appearance:none;padding:0;border:0;background:transparent;color:inherit;font:inherit;cursor:pointer}.sg-stm-toggle:hover{color:var(--sgm-secondary)}.sg-stm-toggle:active{transform:translateY(1px)}.sg-stm-toggle:focus-visible,.sg-stm-layer:focus-visible{outline:2px solid var(--sgm-accent);outline-offset:2px;border-radius:5px}.sg-stm-chevron{display:inline-block;margin-left:5px;color:inherit;font-size:14px;transition:transform 180ms cubic-bezier(.22,1,.36,1)}.sg-stm-chevron.open{transform:rotate(90deg)}
      .sg-stm-detail{margin:7px 0 4px;padding:10px 0 3px 14px;border-left:1px solid color-mix(in srgb,var(--sgm-accent) 42%,var(--sgm-border));color:var(--sgm-secondary);animation:sg-stm-open 180ms cubic-bezier(.22,1,.36,1) both}.sg-stm-detail-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:7px}.sg-stm-detail-head strong{color:var(--sgm-text);font-size:12px;font-weight:670}.sg-stm-detail-head span{color:var(--sgm-muted);font-size:11px}.sg-stm-facts{display:flex;gap:5px 12px;flex-wrap:wrap;margin-bottom:11px;color:var(--sgm-muted);font-size:11px}.sg-stm-facts strong{color:var(--sgm-secondary);font-weight:650}
      .sg-stm-layers{display:grid;grid-template-columns:repeat(6,minmax(70px,1fr));gap:3px;overflow-x:auto;padding:2px 0 5px;scrollbar-width:thin}.sg-stm-layer{position:relative;min-width:70px;padding:6px 4px 7px;border:0;border-radius:6px;background:transparent;color:var(--sgm-muted);font:inherit;text-align:center;cursor:pointer}.sg-stm-layer:hover{background:var(--sgm-soft);color:var(--sgm-secondary)}.sg-stm-layer.selected{background:color-mix(in srgb,var(--sgm-accent) 8%,transparent);color:var(--sgm-text)}.sg-stm-layer.actual:after{content:"";position:absolute;left:22%;right:22%;bottom:1px;height:2px;border-radius:2px;background:var(--sgm-accent)}.sg-stm-layer-level{display:block;font-weight:720}.sg-stm-layer-name{display:block;margin-top:1px;font-size:10px}.sg-stm-layer-size{display:block;margin-top:3px;color:var(--sgm-muted);font-size:9px}.sg-stm-layer-current{display:block;min-height:14px;margin-top:2px;color:var(--sgm-accent);font-size:9px;font-weight:680}
      .sg-stm-preview{margin-top:8px;padding-top:9px;border-top:1px solid color-mix(in srgb,var(--sgm-border) 78%,transparent)}.sg-stm-preview-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:7px}.sg-stm-preview-head strong{color:var(--sgm-text);font-weight:670}.sg-stm-preview-head span{color:var(--sgm-muted);font-size:10px}.sg-stm-content{max-height:320px;margin:0;padding:0 4px 1px 0;overflow:auto;color:var(--sgm-secondary);font:12px/1.62 "Segoe UI Variable Text","Segoe UI",ui-sans-serif,system-ui,-apple-system,"Microsoft YaHei",sans-serif;white-space:pre-wrap;overflow-wrap:anywhere}.sg-stm-loading,.sg-stm-error{padding:10px 0;color:var(--sgm-muted)}.sg-stm-error{color:var(--dsw-alias-state-error-primary,#c44)}
      @keyframes sg-stm-open{from{opacity:0;transform:translateY(-3px)}to{opacity:1;transform:translateY(0)}}@keyframes sg-stm-pulse{50%{opacity:.32;transform:scale(.78)}}
      @media (max-width:620px){.sg-stm-line{gap:7px}.sg-stm-line-copy{white-space:normal}.sg-stm-detail{padding-left:10px}.sg-stm-detail-head{display:block}.sg-stm-detail-head span{display:block;margin-top:2px}.sg-stm-layers{grid-template-columns:repeat(6,76px)}}
      @container sg-stm (max-width:560px){.sg-stm-layers{grid-template-columns:repeat(3,minmax(0,1fr));overflow:visible}.sg-stm-layer{min-width:0;padding:7px 3px}.sg-stm-layer-name{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.sg-stm-facts{gap:4px 9px}}
      @container sg-stm (max-width:340px){.sg-stm-layers{grid-template-columns:repeat(2,minmax(0,1fr))}.sg-stm-layer-size{font-size:9px}}
      @media (prefers-reduced-motion:reduce){.sg-stm *{animation-duration:.01ms!important;transition-duration:.01ms!important}}
      .sg-answer-citations{max-width:640px;margin-top:14px;font-size:13px;line-height:22px;color:var(--dsw-alias-label-secondary,#61666b)}
      .sg-answer-citations-head{display:flex;align-items:baseline;gap:4px;flex-wrap:wrap}
      .sg-answer-citations-label{color:var(--dsw-alias-label-secondary,#61666b);font-weight:620;white-space:nowrap}
      .sg-answer-process-link{display:inline-flex;align-items:center;gap:4px;padding:1px 3px;border:0;border-radius:4px;background:transparent;color:var(--dsw-alias-label-tertiary,#8a8f98);font:inherit;cursor:pointer}
      .sg-answer-process-link:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04));color:var(--dsw-alias-label-secondary,#61666b)}
      .sg-answer-citations-list{display:flex;flex-wrap:wrap;gap:7px;min-width:0;margin-top:7px}
      .sg-answer-citation{display:inline-flex;align-items:center;gap:6px;max-width:min(100%,420px);min-width:0;padding:2px 8px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:7px;background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04));color:var(--dsw-alias-label-secondary,#61666b);font:inherit;cursor:pointer}
      .sg-answer-citation:hover{border-color:var(--dsw-alias-state-business-primary,#4176e6);color:var(--dsw-alias-label-primary,#0f1115)}
      .sg-answer-citation:focus-visible,.sg-answer-process-link:focus-visible,.sg-answer-retrieval-toggle:focus-visible,.sg-retrieved-memory:focus-visible,.sg-retrieved-group>summary:focus-visible,.sg-citation-close:focus-visible,.sg-citation-disclosure summary:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4176e6);outline-offset:2px}
      .sg-answer-citation-kind{flex:0 0 auto;color:var(--dsw-alias-state-business-primary,#4176e6);font-weight:680}
      .sg-answer-citation-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .sg-answer-citation-action{flex:0 0 auto;color:var(--dsw-alias-label-tertiary,#8a8f98);font-size:12px}
      .sg-answer-retrieval{max-width:640px;margin-top:8px;color:var(--dsw-alias-label-tertiary,#8a8f98);font-size:11px;line-height:18px}
      .sg-answer-retrieval-toggle{display:inline-flex;align-items:center;gap:5px;padding:1px 3px;margin-left:-3px;border:0;border-radius:4px;background:transparent;color:inherit;font:inherit;cursor:pointer}
      .sg-answer-retrieval-toggle:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04));color:var(--dsw-alias-label-secondary,#61666b)}
      .sg-answer-retrieval-chevron{display:inline-block;font-size:12px;transition:transform 180ms cubic-bezier(.22,1,.36,1)}
      .sg-answer-retrieval-chevron.open{transform:rotate(90deg)}
      .sg-retrieved-panel{max-height:380px;margin-top:6px;padding:7px 0 2px 12px;overflow:auto;border-left:2px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));animation:sg-retrieved-in 180ms cubic-bezier(.22,1,.36,1) both}
      .sg-retrieved-heading{display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding:0 8px 7px;color:var(--dsw-alias-label-secondary,#61666b)}
      .sg-retrieved-heading strong{font-size:12px;font-weight:650}.sg-retrieved-heading span{color:var(--dsw-alias-label-tertiary,#8a8f98)}
      .sg-retrieved-group{padding-top:1px;border-top:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1))}.sg-retrieved-group+.sg-retrieved-group{margin-top:3px}
      .sg-retrieved-group>summary{display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding:7px 8px;color:var(--dsw-alias-label-secondary,#61666b);cursor:pointer;list-style:none}.sg-retrieved-group>summary::-webkit-details-marker{display:none}.sg-retrieved-group>summary:before{content:'›';display:inline-block;flex:0 0 auto;color:var(--dsw-alias-label-tertiary,#8a8f98);transition:transform 180ms cubic-bezier(.22,1,.36,1)}.sg-retrieved-group[open]>summary:before{transform:rotate(90deg)}
      .sg-retrieved-group-title{min-width:0;flex:1;font-size:12px;font-weight:680}.sg-retrieved-gate{flex:0 0 auto;color:var(--dsw-alias-label-tertiary,#8a8f98);font-size:11px}.sg-retrieved-gate.sufficient{color:var(--dsw-alias-state-success-primary,#34865d)}
      .sg-retrieved-list{margin:0;padding:0;list-style:none}
      .sg-retrieved-memory{display:grid;grid-template-columns:20px auto minmax(0,1fr) auto;align-items:center;gap:8px;width:100%;padding:7px 8px;border:0;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));background:transparent;color:var(--dsw-alias-label-secondary,#61666b);font:inherit;text-align:left;cursor:pointer}
      .sg-retrieved-memory:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04));color:var(--dsw-alias-label-primary,#0f1115)}
      .sg-retrieved-index{color:var(--dsw-alias-label-tertiary,#8a8f98);font-variant-numeric:tabular-nums;text-align:right}.sg-retrieved-memory-kind{color:var(--dsw-alias-label-tertiary,#8a8f98);font-weight:650}.sg-retrieved-memory-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}.sg-retrieved-memory-state{color:var(--dsw-alias-label-tertiary,#8a8f98);white-space:nowrap}
      .sg-retrieved-unavailable{padding:6px 8px;color:var(--dsw-alias-label-tertiary,#8a8f98)}
      .sg-retrieved-final{display:flex;justify-content:space-between;gap:12px;margin-top:6px;padding:8px;border-top:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));color:var(--dsw-alias-label-secondary,#61666b);font-weight:650}.sg-retrieved-final span:last-child{color:var(--dsw-alias-label-tertiary,#8a8f98);font-weight:500}
      @keyframes sg-retrieved-in{from{opacity:0;transform:translateY(-3px)}to{opacity:1;transform:translateY(0)}}
      .sg-citation-overlay{position:fixed;inset:0;z-index:2147483000;display:grid;place-items:center;padding:18px;background:rgba(0,0,0,.46)}
      .sg-citation-dialog{--sg-page:var(--dsw-alias-bg-layer-2,#fff);--sg-surface:var(--dsw-specific-input-major,var(--sg-page));--sg-soft:var(--dsw-alias-interactive-bg-hover-solid,#f1f3f5);--sg-text:var(--dsw-alias-label-primary,#0f1115);--sg-muted:var(--dsw-alias-label-secondary,#61666b);--sg-border:var(--dsw-alias-border-l2,rgba(0,0,0,.1));--sg-accent:var(--dsw-alias-state-business-primary,#4176e6);width:min(760px,calc(100vw - 28px));max-height:calc(100vh - 36px);overflow:auto;border:1px solid var(--sg-border);border-radius:13px;background:var(--sg-page);color:var(--sg-text);box-shadow:0 24px 80px rgba(0,0,0,.34);font:13px/1.6 "Segoe UI Variable Text","Segoe UI",ui-sans-serif,system-ui,-apple-system,"Microsoft YaHei",sans-serif}
      .sg-citation-dialog *{box-sizing:border-box}
      .sg-citation-dialog-head{position:sticky;top:0;z-index:3;display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:16px 17px 13px;border-bottom:1px solid var(--sg-border);background:var(--sg-page)}
      .sg-citation-dialog-kicker{color:var(--sg-accent);font-size:12px;font-weight:700}
      .sg-citation-dialog-title{margin:2px 0 0;font-size:18px;line-height:1.35}
      .sg-citation-close{width:30px;height:30px;flex:0 0 auto;border:0;border-radius:7px;background:transparent;color:var(--sg-muted);font-size:20px;cursor:pointer}
      .sg-citation-close:hover{background:var(--sg-soft)}
      .sg-citation-dialog-body{display:grid;gap:14px;padding:16px 17px 19px}
      .sg-citation-context-note{margin:0;padding:9px 11px;border-left:3px solid color-mix(in srgb,var(--sg-accent) 58%,var(--sg-border));background:color-mix(in srgb,var(--sg-accent) 6%,var(--sg-page));color:var(--sg-muted);font-size:12px}
      .sg-citation-section{display:grid;gap:8px;min-width:0}
      .sg-citation-section-title{margin:0;font-size:13px;font-weight:720}
      .sg-citation-copy{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}
      .sg-citation-muted{color:var(--sg-muted)}
      .sg-citation-facts{display:grid;gap:7px;margin:0;padding:0;list-style:none}
      .sg-citation-fact{padding:8px 10px;border-radius:7px;background:var(--sg-soft)}
      .sg-citation-related{display:grid;gap:7px}
      .sg-citation-disclosure{border-top:1px solid var(--sg-border)}
      .sg-citation-disclosure:last-child{border-bottom:1px solid var(--sg-border)}
      .sg-citation-disclosure summary{padding:9px 2px;color:var(--sg-muted);cursor:pointer;font-weight:650}
      .sg-citation-disclosure[open] summary{color:var(--sg-text)}
      .sg-citation-disclosure-body{padding:1px 2px 11px}
      .sg-citation-events{display:grid;gap:7px}
      .sg-citation-event{padding:8px 10px;border-radius:7px;background:var(--sg-soft)}
      .sg-citation-event strong{display:block}
      .sg-citation-event p{margin:2px 0 0;color:var(--sg-muted)}
      .sg-citation-messages{display:grid;gap:8px}
      .sg-citation-message{padding:9px 10px;border-left:3px solid var(--sg-border);background:color-mix(in srgb,var(--sg-soft) 72%,transparent);white-space:pre-wrap;overflow-wrap:anywhere}
      .sg-citation-message-role{display:block;margin-bottom:3px;color:var(--dsw-alias-label-tertiary,#8a8f98);font-size:11px;text-transform:uppercase}
      .sg-citation-tech{font:12px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--dsw-alias-label-tertiary,#8a8f98);overflow-wrap:anywhere;white-space:pre-wrap}
      .sg-citation-layers{display:grid;gap:6px}
      .sg-citation-layer{display:grid;grid-template-columns:42px minmax(0,1fr);border:1px solid var(--sg-border);border-radius:7px;background:var(--sg-soft);color:var(--sg-muted)}
      .sg-citation-layer.adopted{border-color:var(--sg-accent);background:color-mix(in srgb,var(--sg-accent) 8%,var(--sg-page));color:var(--sg-text);box-shadow:inset 3px 0 0 var(--sg-accent)}
      .sg-citation-layer.retrieved{border-color:color-mix(in srgb,var(--sg-muted) 48%,var(--sg-border));background:color-mix(in srgb,var(--sg-muted) 5%,var(--sg-page));color:var(--sg-text);box-shadow:inset 3px 0 0 color-mix(in srgb,var(--sg-muted) 52%,transparent)}
      .sg-citation-layer-level{display:grid;place-items:center;border-right:1px solid var(--sg-border);font-weight:740}
      .sg-citation-layer-content{min-width:0;padding:8px 10px;white-space:pre-wrap;overflow-wrap:anywhere}
      .sg-citation-layer:not(.adopted):not(.retrieved) .sg-citation-layer-content{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
      .sg-citation-layer-state{display:block;margin-top:2px;color:var(--sg-accent);font-size:11px;font-weight:700}
      .sg-citation-layer-state.retrieved{color:var(--sg-muted)}
      .sg-citation-graph{display:grid;gap:7px}
      .sg-citation-graph-frame{position:relative;height:320px;overflow:hidden;border:1px solid var(--sg-border);border-radius:9px;background:var(--sg-page)}
      .sg-citation-graph-canvas{position:absolute;inset:0}
      .sg-citation-graph-note{margin:0;color:var(--sg-muted);font-size:11px}
      .sg-citation-graph-fallback{display:grid;gap:6px;padding:12px}
      .sg-citation-relation{display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);gap:8px;align-items:center;padding:7px 9px;border-radius:7px;background:var(--sg-soft)}
      .sg-citation-relation span{color:var(--sg-muted);text-align:center}
      .sg-citation-graph-a11y{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
      .sg-citation-loading,.sg-citation-error{padding:12px;border-radius:8px;background:var(--sg-soft)}
      .sg-citation-error{color:var(--dsw-alias-state-error-primary,#c42b1c)}
      @media(max-width:560px){.sg-answer-citations{grid-template-columns:1fr}.sg-answer-citations-list{display:grid}.sg-answer-citation{max-width:100%;width:100%}.sg-retrieved-memory{grid-template-columns:20px auto minmax(0,1fr)}.sg-retrieved-memory-state{grid-column:3}.sg-citation-overlay{padding:8px}.sg-citation-dialog{width:100%;max-height:calc(100vh - 16px)}.sg-citation-graph-frame{height:280px}}
      ${eventDetailCss}
    `

    // Round 6 visual layer. These rules load after the legacy sheet so they win
    // without editing dozens of older declarations; behaviour stays untouched.
    const R6_STYLES = `
      .sg-memory{
        --sg-sheet:color-mix(in srgb,var(--sg-text) 4%,var(--sg-page));
        --sg-hair:color-mix(in srgb,var(--sg-border) 70%,transparent);
        --sg-ink:var(--sg-text);
        --sg-moss:color-mix(in srgb,var(--dsw-alias-state-success-primary,#5f7f4d) 62%,var(--sg-text));
        --sg-sand:color-mix(in srgb,var(--dsw-alias-state-warn-label,#a9822f) 74%,var(--sg-text));
        --sg-water:color-mix(in srgb,var(--dsw-alias-state-business-primary,#3f6d9c) 68%,var(--sg-text));
        --sg-serif:"Songti SC","STSong","Noto Serif SC","Source Han Serif SC","Microsoft YaHei UI","Microsoft YaHei","Segoe UI",serif;
        --sg-mono:"SF Mono","JetBrains Mono",ui-monospace,Menlo,"Cascadia Mono",Consolas,monospace;
        background:var(--sg-page);
      }
      /* header + tabs */
      .sg-memory .sg-header{padding:14px 0 0;margin-bottom:0;border:0;border-radius:0;background:transparent;box-shadow:none}
      .sg-memory .sg-header-row{padding:0 2px}
      .sg-memory .sg-header-row-primary{flex-wrap:nowrap}
      .sg-memory .sg-header-row-secondary{margin-top:6px}
      .sg-memory .sg-logo{width:28px;height:28px;border-radius:8px;box-shadow:none}
      .sg-memory .sg-brand-name{font-family:var(--sg-serif);font-size:18px;font-weight:400;letter-spacing:0}
      .sg-memory .sg-brand-version{font-family:var(--sg-mono);font-size:11px}
      .sg-memory .sg-usage-count{padding:0;background:none}
      .sg-memory .sg-usage-number{font-family:var(--sg-serif);font-weight:400;font-size:16px}
      .sg-memory .sg-tabs{display:flex;grid-template-columns:none;gap:2px;margin:12px 0 20px;padding:0;border:0;border-bottom:1px solid var(--sg-border);border-radius:0;background:transparent;overflow-x:auto;scrollbar-width:none}
      .sg-memory .sg-tabs::-webkit-scrollbar{display:none}
      .sg-memory .sg-tab{position:relative;display:inline-flex;align-items:center;justify-content:center;gap:7px;flex:0 0 auto;min-width:0;padding:8px 10px 10px;border:0;border-radius:0;background:none;color:var(--sg-muted);font-size:13px;box-shadow:none;white-space:nowrap}
      .sg-memory .sg-tab:hover{background:none;color:var(--sg-text)}
      .sg-memory .sg-tab.active{color:var(--sg-text);background:none;font-weight:600;box-shadow:none}
      .sg-memory .sg-tab.active:after{content:"";position:absolute;left:8px;right:8px;bottom:-1px;height:2px;background:var(--sg-text)}
      .sg-tab-swatch{width:10px;height:10px;flex:none;border-radius:2px;background:var(--sg-text)}
      .sg-tab-swatch.water{background:var(--sg-water)}
      .sg-tab-swatch.sand{background:var(--sg-sand)}
      .sg-tab-swatch.ink{background:var(--sg-ink)}
      .sg-tab-swatch.lib{background:color-mix(in srgb,var(--sg-moss) 16%,transparent);box-shadow:inset 0 0 0 1.2px var(--sg-moss)}
      /* shared page furniture */
      .sg-memory .sg-intro h2,.sg-memory .sg-detail-title,.sg-memory .sg-daily-head h2{font-family:var(--sg-serif);font-weight:700;letter-spacing:0;font-size:22px}
      .sg-memory .sg-intro p,.sg-memory .sg-daily-head p{font-size:12.5px;max-width:60ch}
      .sg-pg-head{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:16px}
      .sg-pg-head h2{margin:0;font:700 22px var(--sg-serif)}
      .sg-pg-tag{display:inline-flex;align-items:center;gap:6px;color:var(--sg-muted);font-size:12px}
      .sg-pg-end{margin-left:auto;display:flex;align-items:center;gap:8px;min-width:0;max-width:100%}
      .sg-sw{width:10px;height:10px;flex:none;border-radius:2px;background:var(--sg-text)}
      .sg-sw.moss{background:var(--sg-moss)}.sg-sw.sand{background:var(--sg-sand)}.sg-sw.water{background:var(--sg-water)}.sg-sw.ink{background:var(--sg-ink)}
      .sg-sw.lib{background:color-mix(in srgb,var(--sg-moss) 16%,transparent);box-shadow:inset 0 0 0 1.2px var(--sg-moss)}
      .sg-mono{font-family:var(--sg-mono);font-variant-numeric:tabular-nums}
      .sg-used{display:inline-flex;align-items:center;gap:3px;color:var(--sg-text);font:12px var(--sg-mono);white-space:nowrap}
      .sg-used svg{width:13px;height:11px;flex:none}
      .sg-memory .sg-save-button,.sg-memory .sg-primary-link,.sg-memory .sg-import-button{background:var(--sg-text);border-color:var(--sg-text);color:var(--sg-page);border-radius:6px}
      .sg-memory .sg-save-button:hover:not(:disabled){background:color-mix(in srgb,var(--sg-text) 88%,var(--sg-page))}
      .sg-memory .sg-block-toggle:hover,.sg-memory .sg-block-toggle[aria-expanded="true"],.sg-memory .sg-entry-button:hover{transform:none}
      .sg-memory .sg-footer{display:flex;justify-content:space-between;gap:12px;text-align:left;border-top:1px solid var(--sg-hair);color:var(--sg-muted);padding-top:12px}
      .sg-memory .sg-footer button{color:var(--sg-muted)}
      .sg-memory .sg-toolbar-button:hover,.sg-memory .sg-source-button:hover,.sg-memory .sg-primary-link:hover{transform:none;box-shadow:none}
      .sg-memory .sg-entity-pill:hover,.sg-memory .sg-support-event:hover,.sg-memory .sg-timeline-card:hover{transform:none}
      .sg-memory .sg-import-overlay{background:color-mix(in srgb,#000 42%,transparent)}
      .sg-memory .sg-import-dialog{border-radius:12px;box-shadow:0 18px 50px color-mix(in srgb,#000 24%,transparent)}
      @keyframes sg-r6-rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
      @keyframes sg-r6-grow{from{transform:scaleX(0)}to{transform:none}}
      @keyframes sg-r6-pop{from{opacity:0;transform:scale(.97)}to{opacity:1;transform:none}}
      @media (prefers-reduced-motion:reduce){.sg-r6-anim,.sg-memory .sg-r6-anim *{animation:none!important}}
      @media (max-width:680px){
        /* R6 pins nowrap for wide layouts; re-allow the two-line narrow header. */
        .sg-memory .sg-header-row-primary{gap:8px;flex-wrap:wrap;row-gap:8px}
        .sg-memory .sg-usage-count span{display:none}
        .sg-memory .sg-tab{padding:8px 8px 10px;font-size:12.5px}
        .sg-pg-head h2{font-size:20px}
      }
      /* Six labeled tabs have to stay on one row inside the 420px panel. */
      @container sg-memory (max-width:560px){
        .sg-memory .sg-tabs{gap:0}
        .sg-memory .sg-tab{flex:1 1 0;gap:4px;padding:8px 2px 10px;font-size:12px}
        .sg-memory .sg-tab.active:after{left:2px;right:2px}
      }

      /* 总览：大数字 + 精简记忆柱 + 长期记忆热力格 */
      .sg-ov{display:grid;gap:22px;min-width:0}
      .sg-ov-top{display:grid;grid-template-columns:minmax(180px,240px) minmax(0,1fr);gap:36px;align-items:start}
      .sg-ov-big{display:flex;align-items:flex-end;gap:8px}
      .sg-ov-big b{font:400 76px/0.9 var(--sg-serif);letter-spacing:-.03em}
      .sg-ov-big .sg-used svg{width:30px;height:24px;margin-bottom:12px}
      .sg-ov-stat p{margin:12px 0 0;color:var(--sg-muted);font-size:13px;line-height:1.6}
      .sg-ov-empty{color:var(--sg-muted)}
      .sg-pillar{display:grid;gap:0}
      .sg-pillar-row{display:grid;grid-template-columns:72px minmax(0,1fr) auto minmax(108px,auto) minmax(132px,auto);column-gap:12px;align-items:center;width:100%;min-height:46px;padding:0;border:0;border-bottom:1px solid var(--sg-hair);border-radius:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
      .sg-pillar-row:hover{background:color-mix(in srgb,var(--sg-soft) 65%,transparent)}
      .sg-pillar-row:focus-visible{outline:2px solid var(--sg-accent);outline-offset:-2px;border-radius:6px}
      .sg-pillar-tail{display:contents}
      .sg-pillar-bar{width:72px;height:34px;border-radius:3px;background:var(--sg-ink);animation:sg-r6-rise .45s both}
      .sg-pillar-bar.moss{background:var(--sg-moss)}
      .sg-pillar-bar.water{background:var(--sg-water)}
      .sg-pillar-bar.sand{background:var(--sg-sand)}
      .sg-pillar-bar.lib{height:42px;background:color-mix(in srgb,var(--sg-moss) 12%,transparent);box-shadow:inset 0 0 0 1.5px var(--sg-moss)}
      .sg-pillar-gap{height:0;margin:8px 0 8px 84px;border-top:1px dashed var(--sg-border)}
      .sg-pillar-name,.sg-pillar-use,.sg-pillar-val,.sg-pillar-when{display:flex;align-items:center;min-width:0;min-height:40px}
      .sg-pillar-name b{font-size:14px;font-weight:600;white-space:nowrap}
      .sg-pillar-use{justify-content:flex-end}
      .sg-pillar-use:empty{visibility:hidden}
      .sg-pillar-val{justify-content:flex-end;gap:6px;color:var(--sg-muted);font-size:12px;white-space:nowrap}
      .sg-pillar-val b{font:400 22px/1 var(--sg-serif);color:var(--sg-text)}
      .sg-pillar-when{justify-content:flex-end;padding-left:14px;color:var(--sg-muted);font-size:12px;white-space:nowrap}
      .sg-pillar-key{display:flex;gap:16px;flex-wrap:wrap;margin-top:12px;color:var(--sg-muted);font-size:12px}
      .sg-pillar-key span{display:inline-flex;align-items:center;gap:6px}
      .sg-heat{padding-top:16px;border-top:1px solid var(--sg-hair)}
      .sg-heat-head{display:flex;justify-content:space-between;gap:12px;margin-bottom:10px;color:var(--sg-muted);font-size:12px}
      .sg-heat-head span:first-child{display:inline-flex;align-items:center;gap:6px;color:var(--sg-text);font-weight:600}
      .sg-heat-grid{display:grid;grid-template-columns:repeat(28,minmax(0,1fr));gap:4px}
      .sg-heat-grid i{aspect-ratio:1;border-radius:3px;background:var(--sg-sheet);box-shadow:inset 0 0 0 1px var(--sg-hair)}
      .sg-heat-scale{display:flex;justify-content:space-between;margin-top:6px;color:var(--sg-muted);font:11px var(--sg-mono)}
      @container sg-memory (max-width:520px){
        .sg-ov-top{grid-template-columns:minmax(0,1fr);gap:18px}
        .sg-ov-big b{font-size:58px}
        .sg-pillar-row{grid-template-columns:44px minmax(0,1fr) auto;column-gap:10px;row-gap:2px;align-items:center;padding:7px 0 8px}
        .sg-pillar-bar{width:44px;height:28px}
        .sg-pillar-name,.sg-pillar-val,.sg-pillar-when{min-height:0}
        .sg-pillar-name{grid-column:2;grid-row:1}
        .sg-pillar-name b{white-space:nowrap}
        .sg-pillar-use{display:none}
        .sg-pillar-tail{grid-column:3;grid-row:1;display:flex;align-items:center;justify-content:flex-end;gap:8px;min-width:0}
        .sg-pillar-tail .sg-pillar-use{display:flex;min-height:0}
        .sg-pillar-val{white-space:nowrap}
        .sg-pillar-when{grid-column:2 / -1;grid-row:2;justify-content:flex-start;padding-left:0;font-size:11.5px;white-space:normal}
        .sg-pillar-gap{margin:6px 0;margin-left:0}
        .sg-heat-grid{grid-template-columns:repeat(14,minmax(0,1fr))}
        .sg-heat-grid i:nth-child(-n+14){display:none}
        .sg-heat-scale span:first-child{font-size:0}
        .sg-heat-scale span:first-child:before{content:'2 周前';font-size:11px}
            }
      }

      /* 常驻画像：分组列表，一行就是一项 */
      .sg-memory .sg-pf .sg-profile-group,.sg-memory .sg-more .sg-profile-group{margin:0;padding:0;border:0;border-radius:0;background:none}
      .sg-memory .sg-pf .sg-profile-row{border-bottom:0}
      .sg-cap-row{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:0 0 20px}
      .sg-cap-bar{flex:1;height:6px;border-radius:3px;background:var(--sg-sheet);box-shadow:inset 0 0 0 1px var(--sg-hair);overflow:hidden}
      .sg-cap-bar i{display:block;height:100%;border-radius:3px;background:var(--sg-ink);transform-origin:left;animation:sg-r6-grow .6s both}
      .sg-cap-num{color:var(--sg-muted);font-family:inherit;font-size:12px;font-variant-numeric:tabular-nums;white-space:nowrap}
      .sg-cap-num b{font:inherit;font-weight:650;color:var(--sg-text);margin-right:3px}
      .sg-cap-limit{padding:0;border:0;background:none;color:var(--sg-accent);font-size:12px;white-space:nowrap;cursor:pointer}
      .sg-cap-limit:hover{text-decoration:underline}
      .sg-cap-edit{display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
      .sg-cap-edit input{width:78px;padding:4px 7px;border:1px solid var(--sg-border);border-radius:6px;background:var(--sg-page);color:var(--sg-text);font:12px var(--sg-mono);outline:0}
      .sg-cap-edit input:focus{border-color:var(--sg-accent);box-shadow:0 0 0 3px var(--sg-focus)}
      .sg-cap-edit .sg-quiet-button,.sg-cap-edit .sg-save-button{min-height:0;padding:4px 9px;font-size:12px}
      .sg-cap-error{margin:-12px 0 14px;color:var(--dsw-alias-state-error-primary,#c42b1c);font-size:12px}
      .sg-profile-limit{padding:0 14px}
      .sg-profile-limit .sg-display-setting{grid-template-columns:minmax(0,1fr) auto;align-items:center}
      .sg-profile-limit-control{display:flex;align-items:center;justify-content:flex-end;gap:9px;white-space:nowrap}
      .sg-profile-limit-value{color:var(--sg-muted);font-family:inherit;font-size:12px;font-variant-numeric:tabular-nums}
      .sg-profile-limit-edit{display:flex;flex-wrap:wrap;padding:0 0 12px;white-space:normal}
      .sg-profile-limit-edit input{width:96px}
      .sg-profile-limit .sg-cap-error{margin:0 0 12px}
      @container sg-memory (max-width:480px){.sg-profile-limit .sg-display-setting{grid-template-columns:minmax(0,1fr);align-items:start;gap:8px}.sg-profile-limit-control{justify-content:flex-start;flex-wrap:wrap}}
      /* Two independent column stacks: left = 称呼与语言 + 地点, right =
         怎么回答你 + 关于你 + 其他. Each stack flows normally, so groups in the
         same column never share a grid area (the old rule overlapped them). */
      .sg-pf{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);grid-auto-rows:min-content;column-gap:26px;row-gap:20px;align-items:start}
      .sg-pf-col{display:flex;flex-direction:column;gap:22px;min-width:0}
      .sg-profile-group h4{margin:0 0 7px 2px;font-size:12px;font-weight:500;color:var(--sg-muted)}
      .sg-profile-group ul{margin:0;padding:0;list-style:none;border:1px solid var(--sg-border);border-radius:10px;overflow:hidden;background:var(--sg-page)}
      .sg-memory .sg-profile-group .sg-profile-row{display:block;border-top:1px solid var(--sg-hair);cursor:pointer}
      .sg-memory .sg-profile-group .sg-profile-row:first-child{border-top:0}
      .sg-memory .sg-profile-group .sg-profile-row:hover{background:var(--sg-sheet)}
      .sg-memory .sg-profile-group .sg-profile-row:has(.sg-profile-content textarea),.sg-memory .sg-profile-group .sg-profile-row:has(.sg-profile-content input){background:var(--sg-sheet);cursor:default}
      .sg-memory .sg-profile-group .sg-profile-summary{grid-template-columns:minmax(0,1fr) auto 14px;align-items:center;gap:10px;min-height:0;padding:10px 12px 10px 14px}
      .sg-memory .sg-profile-group .sg-profile-summary.editing{grid-template-columns:minmax(0,1fr);padding:10px 12px 12px 14px;align-items:start}
      .sg-memory .sg-profile-group .sg-profile-label{display:block;font-size:11.5px;font-weight:400;color:var(--sg-muted)}
      .sg-memory .sg-profile-group .sg-profile-value{display:block;font-size:13.5px;color:var(--sg-text)}
      /* Empty rows stay quiet: muted "未填写" plus the existing chevron. */
      .sg-memory .sg-profile-group .sg-profile-value.empty{opacity:1;color:var(--sg-muted);font-size:12.5px}
      .sg-memory .sg-profile-group .sg-profile-content{display:block}
      .sg-memory .sg-profile-group .sg-profile-action{display:none}
      .sg-memory .sg-profile-group .sg-profile-chev{color:var(--sg-muted);font-size:16px;line-height:1}
      .sg-memory .sg-profile-group .sg-profile-used{justify-self:end}
      .sg-memory .sg-profile-group .sg-profile-editor{padding:6px 0 0}
      .sg-memory .sg-profile-group .sg-profile-editor :is(input,textarea){border-color:var(--sg-accent);outline:3px solid color-mix(in srgb,var(--sg-accent) 16%,transparent);border-radius:7px;background:var(--sg-page);font-size:13px;padding:8px 10px}
      .sg-memory .sg-profile-group .sg-profile-editor :is(input,textarea):focus{box-shadow:none}
      .sg-memory .sg-profile-group .sg-profile-editor textarea{min-height:58px;resize:none;line-height:1.6}
      .sg-memory .sg-profile-group .sg-profile-editor-foot{margin-top:8px;font-size:11.5px;color:var(--sg-muted)}
      .sg-memory .sg-profile-group .sg-profile-actions .sg-save-button{background:var(--sg-text);color:var(--sg-page);border-radius:6px}
      .sg-memory .sg-profile-group .sg-profile-actions .sg-quiet-button{color:var(--sg-muted)}
      .sg-memory .sg-profile-group .sg-profile-conflict,.sg-memory .sg-profile-group .sg-profile-save-feedback-failed,.sg-memory .sg-profile-group .sg-profile-save-feedback-invalid{color:var(--dsw-alias-state-error-primary,#c42b1c)}
      .sg-memory .sg-profile-group .sg-profile-save-feedback-unknown{color:var(--sg-muted)}
      .sg-profile-head .sg-intro{margin-bottom:0}
      @media (max-width:680px){.sg-pf{grid-template-columns:minmax(0,1fr);row-gap:16px}.sg-pf-col{gap:16px}}

      /* 长期记忆：目录做成一本摊开的书 */
      .sg-how{display:flex;align-items:center;gap:8px;margin:-4px 0 14px;font-size:12px;color:var(--sg-muted);flex-wrap:wrap}
      .sg-book{position:relative;border:1px solid var(--sg-border);border-radius:3px;background:var(--sg-sheet);box-shadow:0 1px 0 var(--sg-border),0 3px 0 -1px var(--sg-sheet),0 3px 0 0 var(--sg-border)}
      .sg-book:before{content:"";position:absolute;top:0;bottom:0;left:34px;border-left:1px solid color-mix(in srgb,var(--sg-border) 55%,transparent);pointer-events:none}
      .sg-leaf{position:relative;min-width:0;padding:26px 26px 20px 54px}
      .sg-leaf-foot{margin-top:18px}
      .sg-toc-title{margin:0 0 16px;padding-left:.6em;text-align:center;font:400 15px var(--sg-serif);letter-spacing:.6em}
      .sg-toc-col{display:flex;justify-content:flex-end;margin-bottom:2px;color:var(--sg-muted);font-size:10.5px}
      .sg-toc-ch{margin:0 0 12px}
      .sg-toc-ch-head,.sg-toc-sec{display:flex;align-items:baseline;gap:8px;min-width:0}
      .sg-memory .sg-toc-ch-head{gap:8px;font:700 14px var(--sg-serif)}
      .sg-toc-ch-no{flex:0 0 auto;min-width:3.4em;font:400 12px var(--sg-serif);color:var(--sg-muted)}
      .sg-toc-lead{flex:1;min-width:14px;border-bottom:1.5px dotted color-mix(in srgb,var(--sg-muted) 55%,transparent);transform:translateY(-4px)}
      .sg-toc-cnt{flex:0 0 auto;min-width:1.6em;text-align:right;font:12px var(--sg-mono);color:var(--sg-muted)}
      .sg-memory .sg-toc-sec{position:relative;margin-left:3.2em;padding:3px 6px 3px 0;border:0;border-radius:4px;background:none;font-size:13px;color:var(--sg-muted);text-align:left;cursor:pointer}
      .sg-memory .sg-toc-sec:hover{background:color-mix(in srgb,var(--sg-text) 5%,transparent);color:var(--sg-text)}
      .sg-toc-sec-no{flex:0 0 auto;min-width:2.4em;font:11.5px var(--sg-mono);color:var(--sg-muted)}
      .sg-toc-sec-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .sg-memory .sg-toc-sec.cur{color:var(--sg-text);font-weight:600}
      .sg-toc-sec.cur:before{content:"";position:absolute;left:-12px;top:6px;bottom:6px;width:3px;border-radius:2px;background:var(--sg-text)}
      .sg-toc-foot{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:16px;padding-top:10px;border-top:1px solid var(--sg-border);color:var(--sg-muted);font-size:11.5px}
      .sg-toc-foot .sg-context-trigger{margin-left:auto;color:var(--sg-muted);font-size:11.5px}
      .sg-leaf-k{display:block;font:11.5px var(--sg-mono);color:var(--sg-muted)}
      .sg-leaf h3{margin:2px 0 4px;font:700 19px var(--sg-serif)}
      .sg-leaf-sum{margin:0 0 14px;color:var(--sg-muted);font-size:13px;line-height:1.75;white-space:pre-wrap}
      .sg-leaf-events{margin:0;padding:0;list-style:none}
      .sg-leaf-events li{display:grid;grid-template-columns:44px minmax(0,1fr) auto;align-items:baseline;gap:10px;padding:7px 0;border-top:1px solid var(--sg-border)}
      .sg-memory .sg-leaf-events .sg-topic-event{display:contents;background:none}
      .sg-leaf-events .sg-d{font:11.5px var(--sg-mono);color:var(--sg-muted);white-space:nowrap}
      .sg-leaf-events .sg-t{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:500;color:var(--sg-text)}
      .sg-leaf-events .sg-topic-event:hover .sg-t{color:var(--sg-accent)}
      .sg-leaf-events .sg-topic-event-arrow{display:none}
      .sg-leaf-folio{margin-top:14px;text-align:center;font:11px var(--sg-serif);color:var(--sg-muted)}
      .sg-leaf-empty{padding:24px 0;color:var(--sg-muted);font-size:12.5px}
      .sg-topic-directory .sg-topic-sections{padding-left:0}
      .sg-topic-directory .sg-topic-section-body{margin-left:0;padding-left:0;border-left:0}
      .sg-topic-directory .sg-topic-overview-text{padding-left:0}
      .sg-topic-directory .sg-topic-overview-toggle{display:none}
      .sg-topic-directory .sg-topic-section-toggle .sg-toc-lead{display:block}
      .sg-topic-directory .sg-toc-cnt{display:block;white-space:nowrap;font-variant-numeric:tabular-nums;flex:0 0 auto;text-align:right}
      .sg-topic-directory .sg-topic-section-toggle{padding:4px 6px 4px 0;margin-left:3.2em;font-size:13px;color:var(--sg-muted)}
      .sg-topic-directory .sg-topic-section-toggle>.sg-directory-number{min-width:2.4em;font:11.5px var(--sg-mono);color:var(--sg-muted)}
      .sg-topic-directory .sg-topic-section-toggle>.sg-toc-sec-title{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .sg-topic-directory .sg-topic-section-toggle.cur{color:var(--sg-text);font-weight:600}
      .sg-topic-directory .sg-topic-section-toggle.cur:before{content:"";position:absolute;left:-12px;top:6px;bottom:6px;width:3px;border-radius:2px;background:var(--sg-text)}
      .sg-topic-directory .sg-topic-chapter-toggle{position:relative;display:flex;align-items:baseline;gap:8px;width:100%;font:700 14.5px var(--sg-serif)}
      .sg-topic-directory .sg-topic-chapter-toggle>.sg-topic-chapter-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .sg-topic-directory .sg-topic-chapter-toggle>.sg-directory-chevron{margin-left:2px}
      .sg-topic-directory .sg-topic-chapter-toggle>.sg-toc-cnt{margin-left:6px;font:12px var(--sg-mono);color:var(--sg-muted)}
      .sg-topic-directory .sg-topic-chapter-toggle>.sg-topic-chapter-label{min-width:3.4em;font:400 12px var(--sg-serif);color:var(--sg-muted)}
      .sg-topic-directory .sg-topic-chapter{padding:0 0 12px;border-bottom:0}
      .sg-topic-directory .sg-topic-chapter-header{grid-template-columns:minmax(0,1fr);gap:0}
      .sg-topic-directory .sg-topic-chapter-copy{min-width:0}
      .sg-topic-directory .sg-topic-chapter-number{display:none}
      .sg-topic-directory .sg-topic-description{display:none}
      .sg-topic-directory .sg-topic-sections{padding-top:2px}
      .sg-topic-directory .sg-topic-section-heading{margin:0}
      .sg-topic-directory .sg-topic-section-toggle:before{content:"";flex:0 0 0}
      .sg-topic-directory .sg-toc-cnt{min-width:1.8em;text-align:right;font:12px var(--sg-mono);color:var(--sg-muted)}
      .sg-topic-directory .sg-leaf-sum{display:none}
      .sg-topic-directory .sg-topic-overview-text{font-size:13px;line-height:1.75}
      .sg-topic-directory .sg-topic-event{display:grid;grid-template-columns:44px minmax(0,1fr) auto;align-items:baseline;gap:10px;padding:7px 0;border:0;border-top:1px solid var(--sg-border);border-radius:0}
      .sg-topic-directory .sg-topic-event:hover{background:none}
      .sg-topic-directory .sg-topic-event>.sg-directory-number{font:11.5px var(--sg-mono);color:var(--sg-muted)}
      .sg-topic-directory .sg-topic-event-title{white-space:nowrap;font-size:13px;font-weight:500}
      .sg-topic-directory .sg-topic-event:hover .sg-topic-event-title{color:var(--sg-accent)}
      /* 宽屏：目录在左页，打开的节在右页；同一份事件数据，不重复读取。 */
      @media (min-width:681px){
        .sg-topic-directory .sg-book-preview{position:absolute;top:18px;right:22px;width:calc(50% - 46px);max-height:calc(100% - 36px);padding:0 0 0 26px;overflow:auto}
        .sg-topic-directory .sg-book-preview .sg-leaf-sum{display:block}
        .sg-topic-directory .sg-book>.sg-leaf{padding-right:calc(50% + 28px);min-height:320px}
        .sg-topic-directory .sg-book>.sg-leaf:after{content:"";position:absolute;left:50%;top:18px;bottom:18px;border-left:1px solid var(--sg-border);box-shadow:-1px 0 0 color-mix(in srgb,var(--sg-page) 70%,transparent);pointer-events:none}
        .sg-topic-directory .sg-directory-fold.open>.sg-directory-fold-inner>.sg-topic-section-body{position:absolute;top:18px;right:22px;bottom:18px;width:calc(50% - 46px);padding:0 0 0 26px;overflow:auto;overscroll-behavior:contain}
        .sg-topic-directory .sg-topic-section>.sg-directory-fold.open>.sg-directory-fold-inner{overflow:visible}
        .sg-topic-directory .sg-topic-section>.sg-directory-fold.open{grid-template-rows:1fr;display:block}
        .sg-topic-directory .sg-topic-section>.sg-directory-fold.open>.sg-directory-fold-inner{display:block;height:auto;overflow:visible}
        .sg-topic-directory .sg-leaf-head{display:block;margin-bottom:4px}
        .sg-topic-directory .sg-leaf h3{font:700 18px var(--sg-serif);margin:1px 0 8px}
        .sg-topic-directory .sg-topic-overview{margin-bottom:2px}
        .sg-topic-directory .sg-topic-overview-toggle{display:flex;padding:2px 0;color:var(--sg-muted);font-size:11px}
        .sg-topic-directory .sg-topic-overview-toggle .sg-directory-number{min-width:2.4em;font:11px var(--sg-mono)}
        .sg-topic-directory .sg-topic-overview-text{padding:0 0 8px;color:var(--sg-muted);font-size:13px;line-height:1.75}
        .sg-topic-directory .sg-leaf-folio{position:sticky;bottom:0;padding-top:10px;background:var(--sg-sheet)}
      }
      .sg-topic-directory .sg-topic-show-all{margin:6px 0;padding-left:0;color:var(--sg-accent)!important}

      /* 事件时间线 */
      .sg-tl-day{display:grid;grid-template-columns:76px 22px minmax(0,1fr);column-gap:10px}
      .sg-tl-date{text-align:right;padding-top:2px}
      .sg-tl-date b{display:block;font:400 22px/1.1 var(--sg-serif)}
      .sg-tl-date span{font-size:11px;color:var(--sg-muted);white-space:nowrap}
      .sg-tl-axis{position:relative}
      .sg-tl-axis:before{content:"";position:absolute;left:50%;top:0;bottom:0;border-left:1.5px solid var(--sg-border);transform:translateX(-50%)}
      .sg-tl-summary{margin:0 0 10px 86px;color:var(--sg-muted);font-size:11.5px}
      .sg-tl-items{padding-bottom:16px;min-width:0}
      .sg-ev{display:flex;align-items:baseline;gap:10px;padding:6px 0 7px;border-bottom:1px solid var(--sg-hair);min-width:0}
      .sg-ev:last-child{border-bottom:0}
      .sg-ev .sg-nd{position:absolute;left:-26px;top:12px;width:11px;height:11px;border-radius:50%;background:var(--sg-moss);box-shadow:0 0 0 3px var(--sg-page)}
      .sg-memory .sg-ev{position:relative;display:flex;width:auto;margin:0;border-radius:0;border-left:0;border-right:0;border-top:0;background:none;text-align:left;cursor:pointer;color:var(--sg-text)}
      .sg-memory .sg-ev.fade{color:var(--sg-muted)}
      .sg-memory .sg-ev.fade .sg-nd{background:var(--sg-page);box-shadow:0 0 0 3px var(--sg-page),inset 0 0 0 1.5px var(--sg-muted)}
      .sg-ev .sg-t{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13.5px;font-weight:500}
      .sg-ev .sg-tp{flex:0 0 auto;color:var(--sg-muted);font-size:11.5px;white-space:nowrap}
      .sg-ev .sg-used{margin-left:auto}
      .sg-dream{margin:2px 0 14px;padding:7px 12px;display:flex;align-items:center;gap:10px;border-left:3px solid var(--sg-sand);background:color-mix(in srgb,var(--sg-sand) 14%,transparent);color:var(--sg-muted);font-size:12.5px}
      .sg-dream .sg-m{display:flex;align-items:center;gap:4px}
      .sg-dream .sg-m i{width:9px;height:9px;border-radius:50%;background:var(--sg-moss)}
      .sg-dream .sg-m i.o{background:none;box-shadow:inset 0 0 0 1.3px var(--sg-muted)}
      .sg-memory .sg-long-tabs{border-radius:8px;background:transparent}
      .sg-memory .sg-long-tabs>button{border-radius:6px}
      .sg-memory .sg-long-tabs>button.active{background:var(--sg-sheet);color:var(--sg-text);box-shadow:none}
      @media (max-width:680px){
        .sg-tl-day{grid-template-columns:40px 18px minmax(0,1fr);column-gap:8px}
        .sg-tl-date b{font-size:17px}
        .sg-ev .sg-tp{display:none}
        .sg-leaf{padding:20px 16px 16px 24px}
        .sg-book:before{left:14px}
      }

      /* 会话记忆：一块一条横条，越早越薄；右侧是选中块的详情 */
      .sg-ss{display:grid;grid-template-columns:minmax(0,1fr) 250px;gap:26px;align-items:start}
      .sg-ss-scale{display:flex;align-items:center;gap:8px;margin:-4px 0 12px;color:var(--sg-muted);font-size:11.5px;flex-wrap:wrap}
      .sg-ss-scale .sg-r{display:flex;align-items:flex-end;gap:2px}
      .sg-ss-scale .sg-r i{width:14px;border-radius:1.5px;background:var(--sg-water)}
      .sg-ss-list{min-width:0;border:0;border-radius:0;background:none;overflow:visible}
      .sg-memory .sg-ss-list .sg-block-unit+.sg-block-unit{border-top:0}
      .sg-visually-hidden{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
      .sg-memory .sg-ss-list .sg-block-toggle{display:grid;grid-template-columns:28px minmax(0,1fr) auto 24px;gap:10px;align-items:center;padding:0;border:0;background:none;cursor:pointer;margin-bottom:3px;min-height:0}
      .sg-memory .sg-ss-list .sg-block-toggle:hover{background:none}
      .sg-ss-num{font:11px var(--sg-mono);color:var(--sg-muted);text-align:right}
      .sg-ss-bar{display:flex;align-items:center;padding:0 12px;border-radius:3px;min-width:0;color:var(--sg-text);font-size:12.5px;animation:sg-r6-rise .4s both}
      .sg-ss-bar span{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
      .sg-memory .sg-ss-list .sg-block-toggle[aria-expanded="true"] .sg-ss-bar{box-shadow:0 0 0 2px var(--sg-text)}
      .sg-memory .sg-ss-list .sg-block-turn,.sg-memory .sg-ss-list .sg-block-distance{display:none}
      .sg-memory .sg-ss-list .sg-level-cell{display:flex}
      .sg-memory .sg-ss-list .sg-level-badge{display:inline-grid;place-items:center;min-width:26px;height:20px;padding:0 5px;border:1px solid var(--sg-border);border-radius:4px;background:var(--sg-page);font:11px var(--sg-mono);color:var(--sg-muted)}
      .sg-memory .sg-ss-list .sg-row-chevron{display:block;color:var(--sg-muted);font-size:14px;text-align:right}
      .sg-memory .sg-ss-list .sg-block-name{font-weight:inherit}
      .sg-memory .sg-ss-list .sg-block-expanded{padding:6px 0 10px}
      .sg-ss-open{display:grid;grid-template-columns:28px minmax(0,1fr) auto;gap:10px;align-items:center;margin-bottom:3px}
      .sg-ss-open .sg-ss-bar{justify-content:space-between;border:1.5px dashed var(--sg-water);background:none!important;color:var(--sg-muted)}
      .sg-ss-dots{display:flex;gap:3px}
      .sg-ss-dots i{width:7px;height:7px;border-radius:50%;background:var(--sg-water)}
      .sg-ss-dots i.o{background:none;box-shadow:inset 0 0 0 1.2px var(--sg-water)}
      .sg-ss-side{padding-top:10px;border-top:1px solid var(--sg-text);min-width:0}
      .sg-ss-side h3{margin:0 0 2px;font:700 16px var(--sg-serif)}
      .sg-ss-side .sg-k{display:block;margin-bottom:10px;font:11.5px var(--sg-mono);color:var(--sg-muted)}
      .sg-ss-side p{margin:0 0 12px;color:var(--sg-muted);font-size:12.5px;line-height:1.7}
      .sg-lvl{display:flex;gap:3px;margin:4px 0}
      .sg-lvl i{flex:1;height:6px;border-radius:2px;background:var(--sg-sheet);box-shadow:inset 0 0 0 1px var(--sg-hair)}
      .sg-lvl i.on{background:var(--sg-water);box-shadow:none}
      .sg-lvl-l{display:flex;justify-content:space-between;margin-bottom:12px;color:var(--sg-muted);font-size:10.5px}
      @media (max-width:680px){.sg-ss{grid-template-columns:minmax(0,1fr)}.sg-ss-side{display:none}}

      /* 短期记忆：按天排列 */
      .sg-days{display:grid}
      .sg-day{display:grid;grid-template-columns:64px 6px minmax(0,1fr);column-gap:14px;padding:12px 0;border-top:1px solid var(--sg-hair);animation:sg-r6-rise .4s both}
      .sg-day-d{display:block;width:100%;padding:0;border:0;background:none;color:inherit;font:inherit;text-align:right;cursor:pointer}
      .sg-day-d b{display:block;font:400 26px/1 var(--sg-serif)}
      .sg-day-d span{font-size:11px;color:var(--sg-muted)}
      .sg-day-rail{border-radius:3px;background:var(--sg-sand)}
      .sg-day.out .sg-day-rail{background:none;box-shadow:inset 0 0 0 1.2px var(--sg-border)}
      .sg-day.out{color:var(--sg-muted)}
      .sg-day ul{margin:0;padding:0;list-style:none;min-width:0}
      .sg-day li{display:grid;grid-template-columns:44px minmax(0,1fr) auto;align-items:baseline;gap:10px;padding:3px 0;font-size:13px}
      .sg-memory .sg-day li .sg-day-t{font:11.5px var(--sg-mono);color:var(--sg-muted)}
      .sg-day li .sg-day-s{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--sg-text);text-align:left;font:inherit}
      .sg-day.out li .sg-day-s{color:var(--sg-muted)}
      .sg-day-cut{display:grid;grid-template-columns:64px minmax(0,1fr);column-gap:14px;align-items:center;margin:2px 0;color:var(--sg-muted);font-size:11px}
      .sg-day-cut span{display:flex;align-items:center;gap:8px}
      .sg-day-cut span:before{content:"";flex:0 0 8px;border-top:1px dashed var(--sg-border)}
      .sg-day-cut span:after{content:"";flex:1;border-top:1px dashed var(--sg-border)}
      .sg-daily-actions{display:flex;align-items:center;gap:6px}
      .sg-stp{display:inline-flex;align-items:center;overflow:hidden;border:1px solid var(--sg-border);border-radius:7px;font-size:12.5px}
      .sg-memory .sg-stp button{width:26px;height:26px;padding:0;border:0;background:none;color:var(--sg-muted);font-size:14px;line-height:1;cursor:pointer}
      .sg-memory .sg-stp button:hover:not(:disabled){background:var(--sg-soft);color:var(--sg-text)}
      .sg-memory .sg-stp button:disabled{opacity:.4;cursor:default}
      .sg-stp.sg-stp-wide{border:0;gap:0}
      .sg-stp.sg-stp-wide .sg-number-input{width:66px;margin:0 0 0 -1px;height:28px;text-align:center;border-radius:0;font-family:var(--sg-mono);font-size:12.5px;padding:0 2px;-moz-appearance:textfield}
      .sg-stp.sg-stp-wide .sg-number-input::-webkit-outer-spin-button,.sg-stp.sg-stp-wide .sg-number-input::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}
      .sg-stp.sg-stp-wide button{width:26px;height:28px;border:1px solid var(--sg-border)}
      .sg-stp.sg-stp-wide button:first-child{border-radius:7px 0 0 7px}
      .sg-stp.sg-stp-wide button:last-child{border-radius:0 7px 7px 0;border-left:0}
      .sg-stp span{min-width:48px;border-inline:1px solid var(--sg-border);text-align:center;line-height:26px;font-family:var(--sg-mono)}
      .sg-memory .sg-daily-note,.sg-memory .sg-daily-item,.sg-memory .sg-daily-note-date h3{font-family:inherit}
      .sg-memory .sg-daily-note-date h3{font-family:var(--sg-serif);font-weight:700}
      @media (max-width:680px){.sg-day{grid-template-columns:42px 5px minmax(0,1fr);column-gap:10px}.sg-day-d b{font-size:20px}.sg-day-cut{grid-template-columns:42px minmax(0,1fr);column-gap:10px}}

      /* 更多：与画像同一套分组列表 */
      .sg-more{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:20px 26px;align-items:start;min-width:0}
      .sg-more-col{display:grid;gap:20px;align-content:start;min-width:0}
      .sg-more .sg-profile-group{min-width:0}
      .sg-more .sg-more-path{min-width:0}
      .sg-more .sg-profile-group li{padding:10px 12px 10px 14px;border-top:1px solid var(--sg-hair)}
      .sg-more .sg-profile-group li:first-child{border-top:0}
      .sg-more .sg-k2{display:block;font-size:13.5px}
      .sg-more .sg-s2{display:block;margin-top:1px;font-size:11.5px;color:var(--sg-muted)}
      .sg-more .sg-row-go{display:flex;align-items:center;justify-content:flex-end;gap:8px;color:var(--sg-muted);font-size:16px;line-height:1}
      .sg-more .sg-badge{font:12px var(--sg-mono);padding:0 8px;border:1px solid var(--sg-border);border-radius:10px;background:var(--sg-sheet);color:var(--sg-text)}
      .sg-memory .sg-setting-switch[aria-checked="true"]{border-color:var(--sg-good);background:var(--sg-good)}
      .sg-memory .sg-setting-switch[aria-checked="true"]:before{background:#fff}
      .sg-memory .sg-setting-switch{border:1px solid var(--sg-border);background:var(--sg-sheet);box-shadow:none}
      .sg-memory .sg-setting-switch:before{background:var(--sg-muted)}
      .sg-dirty{display:flex;align-items:center;gap:8px;padding:10px 12px 10px 14px;border-top:1px solid var(--sg-border);background:color-mix(in srgb,var(--sg-accent) 7%,var(--sg-page));color:var(--sg-accent);font-size:12px}
      .sg-dirty .sg-save-button{margin:0 0 0 auto}
      .sg-dirty .sg-quiet-button{color:var(--sg-accent)}
      .sg-mem-menu{display:grid;gap:0}
      .sg-memory .sg-mem-menu .sg-menu-row{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:12px;padding:12px 14px;border:0;border-top:1px solid var(--sg-hair);border-radius:0;background:none;box-shadow:none}
      .sg-memory .sg-mem-menu .sg-menu-row:first-child{border-top:0}
      .sg-memory .sg-mem-menu .sg-menu-row:hover{background:var(--sg-sheet);transform:none;box-shadow:none}
      .sg-memory .sg-mem-menu .sg-menu-icon{display:none}
      .sg-memory .sg-mem-menu .sg-menu-title{display:block;font-weight:500;font-size:13.5px;color:var(--sg-text)}
      .sg-memory .sg-mem-menu .sg-menu-subtitle{display:block;margin-top:1px;font-size:11.5px;color:var(--sg-muted)}
      .sg-memory .sg-mem-menu .sg-menu-row:hover .sg-menu-title{color:var(--sg-text)}
      .sg-memory .sg-mem-menu .sg-chevron{color:var(--sg-muted)}
      /* 高级设置：沿用画像的分组列表 */
      .sg-memory .sg-settings-group{margin:0;padding:0 0 20px;border:0}
      .sg-memory .sg-settings-group-title{margin:0 0 6px;font-size:12px;font-weight:500;color:var(--sg-muted)}
      .sg-memory .sg-settings-group-copy{margin:0 0 10px;font-size:11.5px;line-height:1.6}
      .sg-memory .sg-settings-panel{padding:0 14px;border:1px solid var(--sg-border);border-radius:10px;background:var(--sg-page)}
      .sg-memory .sg-settings-panel.sg-pipeline{gap:0}
      .sg-memory .sg-settings-panel>.sg-stage{grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:12px;padding:11px 0;border-top:1px solid var(--sg-hair);border-bottom:0;font-size:13px}
      .sg-memory .sg-settings-panel>.sg-stage:first-child{border-top:0}
      .sg-memory .sg-settings-panel>.sg-setting-note{margin:0 0 8px;padding-right:78px;font-size:11.5px}
      .sg-memory .sg-settings-panel>.sg-stage+.sg-setting-note{margin-top:-4px}
      .sg-memory .sg-settings-panel>.sg-setting-note:last-child{margin-bottom:10px;padding-right:0}
      .sg-memory .sg-settings-panel .sg-display-setting{border-top:1px solid var(--sg-hair);border-bottom:0;padding:11px 0}
      .sg-memory .sg-settings-panel .sg-display-setting:first-child{border-top:0}
      .sg-memory .sg-settings-panel .sg-display-setting-copy{gap:2px}
      .sg-memory .sg-settings-panel .sg-display-setting-title{font-size:13px;font-weight:500}
      .sg-memory .sg-settings-panel .sg-display-setting-description{font-size:11.5px}
      .sg-memory .sg-settings-panel .sg-display-setting.child{padding-left:14px}
      .sg-memory .sg-settings-group .sg-menu.sg-settings-menu{margin-top:0;border:1px solid var(--sg-border);border-radius:10px;overflow:hidden;background:var(--sg-page)}
      .sg-memory .sg-settings-group .sg-mem-menu .sg-menu-row{padding:11px 14px}
      .sg-memory .sg-model-settings{margin:0 0 10px;padding:0 14px;border:1px solid var(--sg-border);border-radius:10px;background:var(--sg-page)}
      .sg-memory .sg-model-settings+.sg-settings-panel{margin-top:10px}
      .sg-memory .sg-settings-panel .sg-save-button{align-self:flex-end;margin:10px 0 12px}
      .sg-memory .sg-settings-panel .sg-dirty{margin:0 -14px -13px;border-radius:0 0 9px 9px}
      .sg-memory .sg-settings-panel .sg-dirty~*{display:none}
      .sg-memory .sg-storage-card{border-radius:10px;background:var(--sg-page)}
      .sg-memory .sg-settings-panel .sg-storage-card{border:0;border-radius:0;padding:0 0 12px}
      @media (max-width:680px){.sg-more{grid-template-columns:minmax(0,1fr);gap:16px}}
      /* The settings dialog can be ~900px wide, where two columns get cramped.
         Switch on the content container itself (not the viewport), so a narrow
         side panel and a wide standalone dialog both lay out honestly. */
      .sg-memory.sg-settings-page,.sg-settings-shell{container-name:sg-settings}
      .sg-settings-shell{container-type:inline-size;min-width:0}
      .sg-memory .sg-more{min-width:0}
      @container sg-settings (max-width:900px){
        .sg-memory .sg-more{grid-template-columns:minmax(0,1fr)}
        .sg-memory .sg-more-col{gap:16px}
        .sg-memory .sg-more .sg-more-row{flex-wrap:wrap;row-gap:6px}
        .sg-memory .sg-more .sg-more-row>.sg-quiet-button,.sg-memory .sg-more .sg-more-row>.sg-setting-switch{flex:0 0 auto;white-space:nowrap}
        .sg-memory .sg-more .sg-more-row>div{flex:1 1 180px}
        .sg-memory .sg-more .sg-more-path .sg-path{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
        .sg-memory .sg-more .sg-stp,.sg-memory .sg-more .sg-stp button{white-space:nowrap}
        .sg-memory .sg-topic-directory .sg-topic-pending-heading>.sg-dreaming-start{margin-left:0}
      }
      @container sg-settings (max-width:560px){
        .sg-memory .sg-more .sg-more-row{padding:10px}
        .sg-memory .sg-more .sg-more-kpi>div{grid-template-columns:repeat(3,minmax(0,1fr))}
      }

      /* 弹窗 */
      .sg-dlg{width:380px;max-width:100%;padding:22px 22px 18px;border-radius:12px;background:var(--sg-page);box-shadow:0 0 0 1px var(--sg-border),0 18px 50px color-mix(in srgb,#000 24%,transparent);animation:sg-r6-pop .18s both}
      .sg-dlg h3{margin:0 0 12px;font:700 18px var(--sg-serif)}
      .sg-dlg p{margin:0 0 12px;color:var(--sg-muted);font-size:13px;line-height:1.6}
      .sg-dlg-acts{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}
      .sg-memory .sg-btn{height:30px;padding:0 14px;border:1px solid var(--sg-border);border-radius:6px;background:var(--sg-page);color:var(--sg-text);font-size:12.5px;cursor:pointer}
      .sg-memory .sg-dlg .sg-btn{height:30px;padding:0 14px;border:1px solid var(--sg-border);border-radius:6px;background:var(--sg-page);color:var(--sg-text);font-size:12.5px;cursor:pointer}
      .sg-memory .sg-dlg .sg-btn.primary{border-color:var(--sg-text);background:var(--sg-text);color:var(--sg-page)}
      .sg-memory .sg-dlg .sg-btn.danger{border-color:var(--sg-danger);background:var(--sg-danger);color:#fff}
      .sg-memory .sg-dlg .sg-btn.ghost{border-color:transparent;background:none;color:var(--sg-muted)}
      .sg-steps{display:flex;gap:4px;margin:4px 0 8px}
      .sg-steps i{flex:1;height:8px;border-radius:2px;background:var(--sg-sand)}
      .sg-steps i.todo{background:none;box-shadow:inset 0 0 0 1.2px var(--sg-border)}
      .sg-steps-l{display:flex;justify-content:space-between;gap:10px;color:var(--sg-muted);font-size:11.5px}
      .sg-steps-l b{color:var(--sg-text);font-weight:500}
      .sg-memo{display:flex;align-items:center;gap:12px;margin-bottom:12px;padding:12px 14px;border:1px solid var(--sg-border);border-radius:8px}
      .sg-memo b{display:block;font-weight:500}
      .sg-memo span{font-size:11.5px;color:var(--sg-muted)}
      .sg-memo .sg-flip{display:flex;align-items:center;gap:6px;margin-left:auto;color:var(--sg-muted);font-size:14px}
      .sg-memo .sg-flip i{width:11px;height:11px;border-radius:50%;background:var(--sg-moss)}
      .sg-memo .sg-flip i.o{background:none;box-shadow:inset 0 0 0 1.5px var(--sg-muted)}
      .sg-keep{display:flex;align-items:center;gap:7px;color:var(--sg-muted);font-size:12px}
      .sg-keep svg{width:13px;height:13px;flex:none;color:var(--sg-good)}

      /* Round 6 follow-up: finished rounds collapse, so these states are only
         used by the transient toast and the inline failure line. */
      .sg-memory .sg-dreaming-toast{margin:0 0 10px;padding:7px 11px;border-radius:7px;background:var(--sg-sheet);color:var(--sg-text);font-size:12.5px;animation:sg-r6-rise .3s both}
      .sg-memory .sg-dreaming-failure{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:8px 0 0;color:var(--dsw-alias-state-error-primary,#c42b1c);font-size:12px}
      .sg-memory .sg-dreaming-retry{padding:2px 8px;border:1px solid var(--dsw-alias-state-error-primary,#c42b1c);border-radius:5px;background:none;color:inherit;font-size:11.5px;cursor:pointer}
      .sg-memory .sg-toc-dream{display:inline-flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
      .sg-memory .sg-toc-dream-run{padding:0;border:0;background:none;color:var(--sg-muted);font:inherit;font-size:11.5px;text-align:left;cursor:pointer}
      .sg-memory .sg-toc-dream-run:hover:not(:disabled){color:var(--sg-text);text-decoration:underline}
      .sg-memory .sg-toc-dream-run:disabled{cursor:default}
      .sg-memory .sg-toc-dream-merge{display:inline-flex;align-items:center;gap:3px;color:var(--sg-muted)}
      .sg-memory .sg-toc-dream-merge i{width:7px;height:7px;border-radius:50%;background:var(--sg-moss)}
      .sg-memory .sg-toc-dream-merge i.o{background:none;box-shadow:inset 0 0 0 1.2px var(--sg-muted)}
      .sg-memory .sg-toc-dream-note{color:var(--sg-muted)}.sg-memory .sg-toc-dream-close,.sg-memory .sg-dream-close{margin-left:auto;padding:0 4px;border:0;background:none;color:var(--sg-muted);font-size:14px;line-height:1;cursor:pointer}.sg-memory .sg-toc-dream-close:hover,.sg-memory .sg-dream-close:hover{color:var(--sg-text)}
      .sg-memory .sg-toc-dream-error{color:var(--dsw-alias-state-error-primary,#c42b1c)}
      .sg-memory .sg-toc-dream-retry{padding:0 6px;border:0;background:none;color:inherit;font-size:11.5px;text-decoration:underline;cursor:pointer}
      .sg-memory .sg-tl-dream{margin:6px 0 2px}
      .sg-memory .sg-tl-dream .sg-dream{width:100%;margin:0}
      .sg-memory .sg-tl-dream .sg-dream-note{margin-left:auto;color:var(--sg-muted);font-size:11.5px}
      .sg-memory .sg-topic-event-date{flex:0 0 auto;font:11px var(--sg-mono);color:var(--sg-muted);white-space:nowrap}
      .sg-memory .sg-topic-event-date:before{content:attr(data-event-date)}
      /* Book view: dotted leaders, no chevrons, no legacy bucket wording. */
      .sg-memory .sg-topic-directory .sg-directory-chevron,.sg-memory .sg-topic-directory .sg-topic-event-arrow{display:none}
      .sg-memory .sg-topic-directory .sg-topic-chapter-toggle>.sg-toc-lead{display:block;flex:1;min-width:14px;border-bottom:1.5px dotted color-mix(in srgb,var(--sg-muted) 55%,transparent);transform:translateY(-4px)}@container sg-memory (max-width:760px){.sg-memory .sg-topic-directory .sg-toc-lead,.sg-memory .sg-topic-directory .sg-topic-section-toggle .sg-toc-lead,.sg-memory .sg-topic-directory .sg-topic-chapter-toggle>.sg-toc-lead{display:none}.sg-memory .sg-topic-directory .sg-topic-chapter-toggle>.sg-topic-chapter-title{flex:1 1 100%}.sg-memory .sg-topic-directory .sg-topic-chapter-toggle>.sg-toc-cnt,.sg-memory .sg-topic-directory .sg-topic-section-toggle>.sg-toc-cnt{margin-left:auto}.sg-memory .sg-topic-directory .sg-topic-section-toggle{margin-left:1.2em;padding-right:2px}.sg-memory .sg-topic-directory .sg-leaf{padding-right:16px}.sg-memory .sg-topic-directory .sg-topic-chapter-toggle{padding-right:4px}.sg-memory .sg-topic-directory .sg-topic-section-toggle>.sg-toc-cnt{margin-right:28px}}
      .sg-memory .sg-topic-directory .sg-topic-chapter-toggle>.sg-topic-chapter-title{flex:0 1 auto}
      .sg-memory .sg-topic-directory .sg-topic-chapter-toggle>.sg-toc-cnt{flex:none;white-space:nowrap}
      .sg-memory .sg-topic-directory .sg-topic-pending-label,.sg-memory .sg-topic-directory .sg-topic-pending-toggle>span:nth-child(2),.sg-memory .sg-topic-directory .sg-topic-other-events>summary{font-size:0}
      .sg-memory .sg-topic-directory .sg-topic-pending-toggle>span:nth-child(2):before{content:'未归类事件';font-size:11.5px;color:var(--sg-muted)}
      .sg-memory .sg-topic-directory .sg-topic-pending-toggle{width:auto;flex:0 1 auto;min-width:0}
      .sg-memory .sg-topic-directory .sg-topic-pending .sg-topic-pending-toggle>span:first-child{font-family:var(--sg-serif);font-size:14px;font-weight:700;color:var(--sg-text)}
      .sg-memory .sg-topic-directory .sg-topic-pending-heading{gap:12px;flex-wrap:wrap;margin:0 0 2px}
      .sg-memory .sg-topic-directory .sg-topic-pending-heading>.sg-dreaming-start{flex:0 0 auto;margin-left:auto}
      .sg-memory .sg-dreaming.inline{flex:0 0 auto;margin:0;padding:0;border:0;background:none}
      .sg-memory .sg-dreaming.inline .sg-dreaming-row{gap:8px;flex-wrap:nowrap}
      .sg-memory .sg-dreaming.inline .sg-dreaming-animation{width:22px;height:22px;flex-basis:22px}
      .sg-memory .sg-dreaming.inline .sg-dreaming-moon{font-size:18px;line-height:22px}
      .sg-memory .sg-dreaming.inline .sg-dreaming-star,.sg-memory .sg-dreaming.inline .sg-dreaming-sleep{display:none}
      .sg-memory .sg-dreaming.inline .sg-dreaming-copy{min-width:0;gap:2px}
      .sg-memory .sg-dreaming.inline .sg-dreaming-copy strong{font-size:12px}
      .sg-memory .sg-dreaming.inline .sg-dreaming-copy>span{display:none}
      .sg-memory .sg-dreaming.inline .sg-dreaming-actions{gap:6px}
      .sg-memory .sg-dreaming.inline .sg-dreaming-progress{flex-basis:100%;margin-top:4px;gap:8px}
      .sg-memory .sg-dreaming.inline .sg-dreaming-session{margin:4px 0 0;font-size:11.5px!important}
      .sg-memory .sg-topic-directory .sg-topic-other-events>summary:before{content:'其他事件';font-size:11.5px;color:var(--sg-muted)}
      .sg-memory .sg-topic-directory .sg-topic-overview-toggle{display:flex}
      .sg-memory .sg-topic-directory .sg-topic-overview-toggle>.sg-directory-number,.sg-memory .sg-topic-directory .sg-topic-overview-toggle>span:nth-child(2){font-size:0}
      .sg-memory .sg-topic-directory .sg-topic-overview-toggle>.sg-directory-number:before{content:'概要';font:11px var(--sg-mono);color:var(--sg-muted)}
      .sg-memory .sg-topic-directory .sg-book-preview{display:none}
      .sg-memory .sg-topic-chapter-title{display:flex;align-items:baseline;gap:8px;width:100%;margin:0;font:700 14.5px var(--sg-serif)}
      .sg-memory .sg-topic-chapter-title .sg-toc-cnt{margin-left:2px}
      .sg-pg-end .sg-long-tabs.sg-seg{display:inline-flex;gap:2px;width:auto;margin:0;padding:2px;border:1px solid var(--sg-border);border-radius:7px;background:transparent}
      .sg-pg-end .sg-long-tabs.sg-seg>button{padding:3px 12px;border:0;border-radius:5px;background:none;color:var(--sg-muted);font-size:12px;cursor:pointer}
      .sg-pg-end .sg-long-tabs.sg-seg>button[aria-current=page]{background:var(--sg-sheet);color:var(--sg-text);font-weight:600;box-shadow:0 0 0 1px var(--sg-border)}
      .sg-pg-end .sg-long-tabs.sg-seg .sg-graph-menu-trigger{width:26px;height:26px;min-width:26px;min-height:26px;font-size:16px}
      .sg-more .sg-more-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 12px 10px 14px;border-top:1px solid var(--sg-hair);list-style:none}
      .sg-more .sg-more-row:first-child{border-top:0}
      .sg-more .sg-more-row>div{min-width:0;flex:1 1 auto}
      /* A directory path and a one-word action never wrap; the path ellipsizes
         to the room the action leaves, full value stays in the title tooltip. */
      .sg-more .sg-more-row .sg-path{display:block;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .sg-more .sg-more-row>.sg-quiet-button{flex:0 0 auto;white-space:nowrap}
      .sg-more .sg-more-switch{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center}
      .sg-more .sg-more-switch.child{padding-left:26px}
      .sg-more .sg-more-go{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;padding:0;border:0;background:none;text-align:left;cursor:pointer}
      .sg-more .sg-more-go:hover .sg-k2{color:var(--sg-text)}
      .sg-more .sg-engine-value .sg-stp-value{min-width:56px}
      .sg-more .sg-k2.dirty,.sg-more .sg-engine-value.dirty .sg-stp-value{color:var(--sg-accent)}
      .sg-more .sg-engine-value.dirty .sg-stp{border-color:var(--sg-accent)}
      .sg-more .sg-more-kpi{padding:10px 12px 4px}
      .sg-more .sg-more-kpi>div{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;text-align:center}
      .sg-more .sg-more-kpi b{display:block;font:400 22px/1.1 var(--sg-serif);color:var(--sg-text)}
      .sg-more .sg-more-kpi span{font-size:11px;color:var(--sg-muted)}
      .sg-memory .sg-more-error{margin:4px 0 0;color:var(--dsw-alias-state-error-primary,#c42b1c);font-size:11.5px;line-height:1.5}
      .sg-memory .sg-more-retry{padding:0 5px;border:0;background:none;color:inherit;font-size:11.5px;text-decoration:underline;cursor:pointer}
      .sg-memory .sg-footer-links{display:inline-flex;align-items:center;gap:2px;flex-wrap:wrap}
      .sg-memory .sg-footer-links a{color:var(--sg-muted);text-decoration:none}
      .sg-memory .sg-footer-links a:hover{color:var(--sg-text);text-decoration:underline}
      .sg-memory .sg-ss-use,.sg-memory .sg-ss-list .sg-level-cell{display:none}
    `

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

    function chapterOrdinal(value) {
      const digits = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九']
      if (value < 10) return digits[value]
      if (value < 100) return (value < 20 ? '' : digits[Math.floor(value / 10)]) + '十' + (value % 10 ? digits[value % 10] : '')
      return String(value)
    }

    // The server supplies canonical sections and their deduplicated counts.
    // Title identity stays stable as paragraphs and their sources accumulate.
    function topicSections(topic) {
      return (topic.sections || []).map((section) => ({ ...section, uiKey: section.key, uiTitle: section.title }))
    }

    function directoryScrollAction(saved, section, namespace, viewName) {
      if (!saved) return 'none'
      if (section !== 'long' || namespace !== saved.namespace) return 'clear'
      return viewName === 'root' ? 'restore' : viewName === 'event' ? 'detail' : 'clear'
    }

    function DirectoryFold({ open, id, children }) {
      const bodyRef = React.useRef(null)
      React.useEffect(() => {
        if (open) bodyRef.current?.removeAttribute('inert')
        else bodyRef.current?.setAttribute('inert', '')
      }, [open])
      return h('div', { id, ref: bodyRef, className: 'sg-directory-fold ' + (open ? 'open' : ''), 'aria-hidden': !open }, h('div', { className: 'sg-directory-fold-inner' }, children))
    }

    function TopicEventRow({ event, number, openEvent }) {
      return h('button', {
        type: 'button', className: 'sg-topic-event', 'data-topic-event-id': event.id,
        onClick: (click) => openEvent(event, click.currentTarget), title: event.title || event.summary || undefined,
      }, number ? h('span', { className: 'sg-directory-number' }, number) : h('span', { className: 'sg-topic-pending-mark', 'aria-hidden': 'true' }, '·'),
      h('span', { className: 'sg-topic-event-title' }, event.title || event.summary || '记忆事件'),
      // The date comes from the topic-events row itself; no guessed chronology.
      // The topic-events row supplies createdAt; render it as MM/DD via CSS so
      // the row's click target keeps its original accessible text.
      h('span', { className: 'sg-topic-event-date', 'data-event-date': eventDayKey(event.createdAt) || '', 'aria-hidden': 'true' }),
      h('span', { className: 'sg-topic-event-arrow', 'aria-hidden': 'true' }, '↗'))
    }

    function useTopicEventPages({ namespace, revision, topicId, sectionKey = '', total, active, wantAll, onDirectoryChanged }) {
      const key = JSON.stringify([namespace, revision, topicId, sectionKey])
      const empty = { key, epoch: 0, items: [], total, nextOffset: total ? 0 : null, loading: false, error: '' }
      const [state, setState] = React.useState(empty)
      const [retry, setRetry] = React.useState(0)
      const requestRef = React.useRef({ key, epoch: 0, generation: 0, controller: null })
      const changedRef = React.useRef(onDirectoryChanged)
      changedRef.current = onDirectoryChanged
      if (requestRef.current.key !== key) {
        requestRef.current.controller?.abort()
        requestRef.current = { key, epoch: requestRef.current.epoch + 1, generation: requestRef.current.generation + 1, controller: null }
      }
      // Old rows disappear in the same render as a workspace or revision change,
      // before a promise or a later effect can return its previous result.
      const epoch = requestRef.current.epoch
      const current = state.key === key && state.epoch === epoch ? state : { ...empty, epoch }
      React.useEffect(() => {
        if (!active || !revision || !total) return undefined
        if (current.error || (current.items.length && (!wantAll || current.nextOffset === null))) return undefined
        const controller = new AbortController()
        const generation = ++requestRef.current.generation
        requestRef.current.controller = controller
        const valid = () => !controller.signal.aborted && requestRef.current.key === key && requestRef.current.generation === generation
        let items = current.items
        let nextOffset = current.nextOffset ?? 0
        let pageTotal = current.total
        setState({ ...current, loading: true, error: '' })
        const read = async () => {
          do {
            const offset = nextOffset
            const page = await api('topic-events', { namespace, topicId, ...(sectionKey ? { sectionKey } : {}), offset, limit: 9, expectedRevision: revision }, { signal: controller.signal })
            if (!valid()) return
            if (page.revision !== revision || page.namespace !== namespace || page.topicId !== topicId || String(page.sectionKey || '') !== sectionKey) {
              const error = new Error('目录已更新')
              error.code = 'directory-changed'
              throw error
            }
            if (!Array.isArray(page.items) || page.items.length > 9 || Number(page.offset) !== offset || (page.nextOffset !== null && (!Number.isSafeInteger(page.nextOffset) || page.nextOffset <= offset))) throw new Error('事件分页响应无效')
            items = [...items, ...page.items]
            pageTotal = Number(page.total || 0)
            nextOffset = page.nextOffset
            setState({ key, epoch, items, total: pageTotal, nextOffset, loading: wantAll && nextOffset !== null, error: '' })
          } while (wantAll && nextOffset !== null && valid())
        }
        void read().catch((reason) => {
          if (!valid() || reason?.name === 'AbortError') return
          if (reason?.code === 'directory-changed' || reason?.status === 409 || reason?.status === 404) {
            setState({ key, epoch, items: [], total, nextOffset: 0, loading: false, error: '目录已有更新，正在读取最新目录。' })
            changedRef.current?.()
          } else setState({ key, epoch, items, total: pageTotal, nextOffset, loading: false, error: '暂时无法读取事件，请重试。' })
        })
        return () => {
          controller.abort()
          requestRef.current.generation += 1
          setState((previous) => previous.key === key && previous.epoch === epoch && previous.loading ? { ...previous, loading: false } : previous)
        }
      }, [key, active, wantAll, retry])
      return { ...current, items: revision ? (wantAll ? current.items : current.items.slice(0, 9)) : [], retry: () => { setState({ ...current, error: '' }); setRetry((value) => value + 1) } }
    }

    function TopicEventList({ namespace, revision, topicId, sectionKey = '', total, active, openEvent, numberPrefix, onDirectoryChanged, expandLabel, collapseLabel = '收起多余事件' }) {
      const [showAll, setShowAll] = React.useState(false)
      const page = useTopicEventPages({ namespace, revision, topicId, sectionKey, total, active, wantAll: showAll, onDirectoryChanged })
      return h('div', { className: 'sg-topic-event-list', 'data-topic-event-scope': topicId + ':' + sectionKey },
        page.items.map((event, index) => h(TopicEventRow, { key: event.id, event, number: numberPrefix ? numberPrefix + '.' + (index + 1) : undefined, openEvent })),
        page.loading ? h('p', { className: 'sg-topic-read-status', role: 'status' }, showAll ? '正在读取事件 · ' + page.items.length + ' / ' + page.total : '正在读取事件…') : null,
        page.error ? h('div', { className: 'sg-topic-read-error', role: 'alert' }, h('span', null, page.error), h('button', { type: 'button', onClick: page.retry }, '重新读取事件')) : null,
        page.total > 9 ? h('button', { type: 'button', className: 'sg-topic-show-all', disabled: !showAll && (page.loading || Boolean(page.error)), 'aria-expanded': showAll, onClick: () => setShowAll((value) => !value) }, showAll ? collapseLabel : '还有 ' + (page.total - 9) + ' 条事件 · ' + (expandLabel || '展开全部')) : null)
    }

    function TopicSection({ part, chapter, index, topicId, namespace, revision, active, openEvent, onDirectoryChanged, open = false, onToggle }) {
      const [overviewOpen, setOverviewOpen] = React.useState(true)
      const sectionNumber = chapter + '.' + index
      const regionId = 'sg-topic-' + encodeURIComponent(topicId) + '-' + encodeURIComponent(part.uiKey)
      const sourceCount = Number(part.sourceEventCount || 0)
      const paragraphs = (part.paragraphs || []).map(paragraph => paragraph.text || '').filter(Boolean)
      return h('section', { className: 'sg-topic-section', 'data-section-index': String(index) },
        h('h3', { className: 'sg-topic-section-heading' }, h('button', { type: 'button', className: 'sg-topic-section-toggle' + (open ? ' cur' : ''), title: part.uiTitle, 'data-count': String(sourceCount), 'aria-expanded': open, 'aria-controls': regionId, onClick: () => onToggle?.(part.uiKey) },
          h('span', { className: 'sg-directory-number' }, sectionNumber), h('span', { className: 'sg-toc-sec-title' }, part.uiTitle), h('span', { className: 'sg-toc-lead', 'aria-hidden': 'true' }), h('span', { className: 'sg-toc-cnt', title: sourceCount + ' 条事件'}, String(sourceCount)), h('span', { className: 'sg-directory-chevron', 'aria-hidden': 'true' }, '\u203a'))),
        h(DirectoryFold, { open, id: regionId }, h('div', { className: 'sg-topic-section-body' },
          h('div', { className: 'sg-leaf-head' }, h('span', { className: 'sg-leaf-k' }, sectionNumber), h('h3', null, part.uiTitle), h('p', { className: 'sg-leaf-sum' }, paragraphs.join('\n\n') || '这一节暂时没有概要。')),
          // Keep the .0 control for focus, overview state and pagination; CSS
          // hides the "总览" label so the right page reads as prose + dated rows.
          (part.paragraphs || []).length ? h('div', { className: 'sg-topic-overview' }, h('h4', { className: 'sg-topic-overview-heading' }, h('button', { type: 'button', className: 'sg-topic-overview-toggle', 'aria-expanded': overviewOpen, 'aria-controls': regionId + '-overview', onClick: () => setOverviewOpen((current) => !current) }, h('span', { className: 'sg-directory-number' }, sectionNumber + '.0'), h('span', null, '总览'), h('span', { className: 'sg-directory-chevron', 'aria-hidden': 'true' }, '›'))),
            h(DirectoryFold, { open: overviewOpen, id: regionId + '-overview' }, (part.paragraphs || []).map((paragraph, paragraphIndex) => h('p', { key: paragraphIndex, className: 'sg-topic-overview-text', 'data-overview-paragraph-index': String(paragraphIndex) }, paragraph.text || '暂无总览')))) : null,
          h(TopicEventList, { namespace, revision, topicId, sectionKey: part.uiKey, total: sourceCount, active: active && open, openEvent, numberPrefix: sectionNumber, onDirectoryChanged }),
          h('div', { className: 'sg-leaf-folio', 'aria-hidden': 'true' }, '— 第' + chapterOrdinal(chapter) + '章 · ' + sectionNumber + ' —'))))
    }

    function TopicChapter({ topic, number, namespace, revision, active, openEvent, onDirectoryChanged, expandRequest = 0, openSection = '', onSectionToggle }) {
      const [open, setOpen] = React.useState(true)
      const [otherOpen, setOtherOpen] = React.useState(false)
      React.useEffect(() => { if (expandRequest > 0) setOpen(true) }, [expandRequest])
      const regionId = 'sg-topic-chapter-' + encodeURIComponent(topic.id)
      const chapterLabel = '第' + chapterOrdinal(number) + '章'
      const chapterEvents = topicSections(topic).reduce((sum, part) => sum + Number(part.sourceEventCount || 0), 0)
      return h('article', { className: 'sg-topic-chapter', 'data-topic-id': topic.id },
        h('header', { className: 'sg-topic-chapter-header' },
          h('span', { className: 'sg-topic-chapter-number', 'aria-hidden': 'true' }, String(number).padStart(2, '0')),
          h('div', { className: 'sg-topic-chapter-copy' }, h('h2', null, h('button', { type: 'button', className: 'sg-topic-chapter-toggle', title: topic.title, 'data-count': String(chapterEvents), 'aria-expanded': open, 'aria-controls': regionId, 'aria-label': chapterLabel + ' ' + topic.title, onClick: () => setOpen((current) => !current) }, h('span', { className: 'sg-topic-chapter-label' }, chapterLabel), h('span', { className: 'sg-topic-chapter-title' }, topic.title), h('span', { className: 'sg-toc-lead', 'aria-hidden': 'true' }), h('span', { className: 'sg-toc-cnt', title: chapterEvents + ' 条事件'}, String(chapterEvents)), h('span', { className: 'sg-directory-chevron', 'aria-hidden': 'true' }, '›'))), topic.description ? h('p', { className: 'sg-topic-description' }, topic.description) : null)),
        h(DirectoryFold, { open, id: regionId }, h('div', { className: 'sg-topic-sections' },
          topicSections(topic).map((part, index) => h(TopicSection, { key: part.uiKey, part, chapter: number, index: index + 1, topicId: topic.id, namespace, revision, open: openSection === part.uiKey, onToggle: (key) => onSectionToggle?.(key, part), active: active && open, openEvent, onDirectoryChanged })),
          !(topic.sections || []).length ? h('p', { className: 'sg-topic-no-overview' }, '这个主题还没有小节。') : null,
          // Keep the unassigned-event disclosure for pagination and aria; CSS
          // hides its old "待归类事件" wording in the book view.
          (() => {
            const remaining = Number(topic.coverage?.unassignedEvents ?? topic.coverage?.omittedEvents ?? 0)
            return remaining ? h('details', { className: 'sg-topic-other-events', open: otherOpen, onToggle: (event) => setOtherOpen(event.currentTarget.open) }, h('summary', null, '待归类事件 · ' + remaining), h(TopicEventList, { namespace, revision, topicId: topic.id, sectionKey: 'uncovered', total: remaining, active: active && open && otherOpen, openEvent, onDirectoryChanged })) : null
          })())))
    }

    function TopicRetryButton({ failure, namespace, revision, onDirectoryChanged }) {
      const scope = JSON.stringify([namespace, revision, failure.jobId])
      const [state, setState] = React.useState({ scope, busy: false, error: '' })
      const current = state.scope === scope ? state : { scope, busy: false, error: '' }
      const request = React.useRef(null)
      const scopeRef = React.useRef(scope)
      if (scopeRef.current !== scope) {
        request.current?.abort()
        request.current = null
        scopeRef.current = scope
      }
      React.useEffect(() => () => {
        if (scopeRef.current === scope) { request.current?.abort(); request.current = null }
      }, [scope])
      const retry = async () => {
        if (request.current) return
        const controller = new AbortController()
        request.current = controller
        setState({ scope, busy: true, error: '' })
        try {
          await api('topics/retry', { namespace, jobId: failure.jobId, expectedRevision: revision }, { method: 'POST', signal: controller.signal })
          if (request.current !== controller || controller.signal.aborted) return
          await onDirectoryChanged?.()
        } catch (reason) {
          if (request.current !== controller || controller.signal.aborted) return
          if (reason?.status === 409) await onDirectoryChanged?.()
          else setState({ scope, busy: false, error: '提交失败，请重试。' })
        } finally {
          if (request.current === controller) { request.current = null; setState((previous) => previous.scope === scope ? { ...previous, busy: false } : previous) }
        }
      }
      return h('div', { className: 'sg-topic-retry' },
        h('button', { type: 'button', className: 'sg-topic-status-details', disabled: current.busy || !revision, onClick: retry }, current.busy ? '正在提交…' : '重新整理这 ' + Number(failure.eventCount || 0) + ' 条'),
        current.error ? h('p', { role: 'alert' }, current.error) : null)
    }

    function TopicBootstrapNotice({ directory }) {
      if (!directory) return null
      const bootstrap = directory.bootstrap
      const working = bootstrap?.status === 'pending' || bootstrap?.status === 'running'
      const total = bootstrap?.total
      const completed = bootstrap?.completed
      // Counts are distinct source Events whose current topic and section work
      // is complete. Failed Events do not contribute to completed.
      const counted = Number.isSafeInteger(total) && total > 0 && Number.isSafeInteger(completed)
        && completed >= 0 && completed <= total
      // Only a run in flight deserves a standing notice. Unclassified memory
      // now lives at the end of the directory as an actionable section.
      if (!working || bootstrap?.total === 0) return null
      return h('aside', { className: 'sg-topic-bootstrap', 'aria-label': '历史记忆整理状态' },
        h('p', { className: 'sg-muted' }, '历史记忆整理中' + (counted ? ' · 已处理 ' + completed + ' / ' + total + ' 条事件' : '')))
    }

    const DREAMING_STYLES = `.sg-dreaming{margin:0 0 20px;padding:14px 16px;border:1px solid var(--sg-border);border-radius:12px;background:var(--sg-surface)}.sg-dreaming-row{display:flex;align-items:center;gap:14px;flex-wrap:wrap}.sg-dreaming-animation{position:relative;width:48px;height:48px;flex:0 0 48px;color:var(--sg-accent)}.sg-dreaming-moon{display:block;font-size:43px;line-height:48px;animation:sg-dream-breathe 4s ease-in-out infinite}.sg-dreaming-star{position:absolute;right:0;top:1px;font-size:12px;animation:sg-dream-twinkle 3s ease-in-out infinite}.sg-dreaming-sleep{position:absolute;right:4px;bottom:1px;font-size:13px;animation:sg-dream-float 3s ease-in-out infinite}.sg-dreaming.resting .sg-dreaming-animation span{animation-play-state:paused}.sg-dreaming-copy{display:grid;gap:5px;flex:1;min-width:150px}.sg-dreaming-copy strong{font-size:14px;color:var(--sg-text)}.sg-dreaming-copy>span,.sg-dreaming p{font-size:12px;color:var(--sg-muted);line-height:1.6}.sg-dreaming-actions{display:flex;gap:8px;flex-wrap:wrap}.sg-dreaming button{padding:7px 12px;border:1px solid var(--sg-border);border-radius:7px;background:var(--sg-page);color:var(--sg-text);cursor:pointer}.sg-dreaming button:hover{border-color:var(--sg-accent)}.sg-dreaming button:disabled{opacity:.5;cursor:default}.sg-dreaming .sg-dreaming-stop{color:var(--sg-danger)}.sg-dreaming-progress{display:flex;align-items:center;gap:12px;margin-top:12px;color:var(--sg-muted);font-size:11px}.sg-dreaming-progress progress{width:100%;height:7px;accent-color:var(--sg-accent);flex:1;min-width:0}@keyframes sg-dream-breathe{50%{opacity:.6;transform:translateY(-2px)}}@keyframes sg-dream-twinkle{50%{opacity:.25;transform:scale(.7)}}@keyframes sg-dream-float{50%{opacity:.4;transform:translate(2px,-5px)}}@media(prefers-reduced-motion:reduce){.sg-dreaming-animation span{animation:none!important}}`

    const DIRECTORY_PREVIEW_STYLES = `.sg-topic-directory-intro{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding-bottom:14px}.sg-context-trigger{display:inline-flex;align-items:center;gap:7px;padding:5px 0;border:0;background:transparent;color:var(--sg-muted);font-size:12px;cursor:pointer}.sg-context-trigger:hover,.sg-context-trigger[aria-expanded=true]{color:var(--sg-accent)}.sg-dreaming-start{padding:6px 12px;border:0;border-radius:7px;background:var(--sg-soft);color:var(--sg-accent);font-size:12px;cursor:pointer}.sg-dreaming-start:disabled{opacity:.5;cursor:default}.sg-dreaming{flex:1 0 100%;margin:0;border:0;background:var(--sg-soft);padding:12px 14px}.sg-dreaming-animation{width:36px;height:40px;flex-basis:36px}.sg-dreaming-moon{font-size:34px;line-height:40px}.sg-dreaming-copy strong{font-size:13px}.sg-dreaming-copy>span{font-size:12px;color:var(--sg-muted)}.sg-dreaming-progress{margin-top:9px}.sg-dreaming-session{margin:5px 0 0 50px;padding:2px 0!important;border:0!important;background:transparent!important;color:var(--sg-accent)!important;font-size:12px!important}.sg-context-overlay{position:fixed;inset:0;z-index:2147483020;background:transparent}.sg-context-window{position:fixed;display:flex;flex-direction:column;width:min(520px,calc(100vw - 24px));padding:16px;border:1px solid var(--sg-border);border-radius:11px;background:var(--sg-page);color:var(--sg-text);box-shadow:0 12px 42px rgba(0,0,0,.25);overflow:auto}.sg-context-window-head{display:flex;align-items:center;justify-content:space-between;gap:12px}.sg-context-window-head h3{font-size:14px;margin:0;font-weight:600}.sg-context-close{display:grid;place-items:center;width:29px;height:29px;padding:0;border:0;border-radius:5px;background:transparent;color:var(--sg-muted);cursor:pointer}.sg-context-subtitle{font-size:12px;color:var(--sg-muted);margin:3px 0 13px}.sg-context-injection{margin:0;padding:13px;background:var(--sg-soft);border-radius:7px;font:12px/1.8 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--sg-text)}@media(max-width:600px){.sg-context-overlay{background:rgba(0,0,0,.32)}.sg-context-window{left:12px!important;right:12px!important;top:auto!important;bottom:12px;width:auto;border-radius:13px;max-height:80vh!important}.sg-dreaming-actions{margin-left:50px}.sg-dreaming-copy{min-width:140px}}`

    function DirectoryContextPreview({ context, active }) {
      const [open, setOpen] = React.useState(false)
      const [position, setPosition] = React.useState({ left: 12, top: 12, maxHeight: '70vh' })
      const trigger = React.useRef(null)
      const closeButton = React.useRef(null)
      const close = () => { setOpen(false); trigger.current?.focus?.() }
      React.useEffect(() => {
        if (!active || !context) setOpen(false)
      }, [active, context])
      React.useEffect(() => {
        if (!open || typeof window === 'undefined') return
        const place = () => {
          const rect = trigger.current?.getBoundingClientRect?.()
          const width = window.innerWidth || 800, height = window.innerHeight || 700
          const top = Math.max(12, Math.min((rect?.bottom || 80) + 8, height - 220))
          setPosition({ left: Math.max(12, Math.min(rect?.left || 12, width - Math.min(520, width - 24) - 12)), top, maxHeight: Math.max(180, height - top - 20) })
        }
        place(); closeButton.current?.focus?.()
        window.addEventListener('resize', place)
        const key = event => { if (event.key === 'Escape') close(); if (event.key === 'Tab') { event.preventDefault(); closeButton.current?.focus?.() } }
        window.addEventListener('keydown', key)
        return () => { window.removeEventListener('resize', place); window.removeEventListener('keydown', key) }
      }, [open])
      return h(React.Fragment, null,
        h('button', { type: 'button', ref: trigger, className: 'sg-context-trigger', 'aria-haspopup': 'dialog', 'aria-expanded': open, disabled: !context, onClick: () => setOpen(value => !value) }, 'AI 会看到的目录', h('span', { 'aria-hidden': 'true' }, '↗')),
        open ? h('div', { className: 'sg-context-overlay', onClick: close },
          h('section', { className: 'sg-context-window', style: position, role: 'dialog', 'aria-modal': true, 'aria-label': 'AI 会看到的目录', onClick: event => event.stopPropagation() },
            h('div', { className: 'sg-context-window-head' }, h('h3', null, 'AI 会看到的目录'), h('button', { type: 'button', ref: closeButton, className: 'sg-context-close', 'aria-label': '关闭目录预览', onClick: close }, '×')),
            h('p', { className: 'sg-context-subtitle' }, '以下目录内容默认提供给 AI'), h('pre', { className: 'sg-context-injection' }, context))) : null)
    }

    function DreamingPanel({ namespace, initialRun, active, available, inline = false, onDirectoryChanged, onOpenDreamingSession }) {
      const [run, setRun] = React.useState(initialRun || null)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const [confirmStop, setConfirmStop] = React.useState(false)
      const stopDialog = React.useRef(null)
      const stopTrigger = React.useRef(null)
      React.useEffect(() => {
        if (!confirmStop) return undefined
        const previous = stopTrigger.current
        stopDialog.current?.querySelector('button')?.focus?.()
        const onKeyDown = (event) => {
          if (event.key === 'Escape' && !busy) { event.preventDefault(); setConfirmStop(false) }
          if (event.key !== 'Tab') return
          const buttons = [...(stopDialog.current?.querySelectorAll('button:not(:disabled)') || [])]
          if (!buttons.length) return
          const first = buttons[0]; const last = buttons.at(-1)
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
        }
        document.addEventListener('keydown', onKeyDown)
        return () => { document.removeEventListener('keydown', onKeyDown); if (previous?.isConnected) previous.focus?.() }
      }, [confirmStop, busy])
      const request = React.useRef(null)
      const previousStatus = React.useRef(initialRun?.status)
      const [toast, setToast] = React.useState('')
      React.useEffect(() => {
        if (initialRun && (!run || initialRun.updatedAt > run.updatedAt)) {
          if (initialRun.status === 'completed' && previousStatus.current && previousStatus.current !== 'completed') {
            setToast('目录已整理好')
            previousStatus.current = 'completed'
          }
          setRun(initialRun)
        }
      }, [initialRun])
      React.useEffect(() => {
        if (!toast) return undefined
        const timer = window.setTimeout(() => setToast(''), 3600)
        return () => window.clearTimeout(timer)
      }, [toast])
      const accept = React.useCallback(value => {
        const next = value?.run || null
        if (next && previousStatus.current !== next.status && ['completed', 'paused', 'terminated'].includes(next.status)) void onDirectoryChanged?.()
        if (next?.status === 'completed' && previousStatus.current !== 'completed') setToast('目录已整理好')
        previousStatus.current = next?.status
        setRun(next); setError('')
      }, [onDirectoryChanged])
      React.useEffect(() => {
        if (!active || !run || !['running', 'pausing'].includes(run.status)) return
        const controller = new AbortController()
        let timer
        const poll = () => api('dreaming', { namespace }, { signal: controller.signal }).then(accept).catch(() => {
          if (!controller.signal.aborted) setError('状态读取失败，可重新读取。')
        }).finally(() => { if (!controller.signal.aborted) timer = window.setTimeout(poll, 2000) })
        timer = window.setTimeout(poll, 1500)
        return () => { controller.abort(); window.clearTimeout(timer) }
      }, [active, namespace, run?.id, run?.status, accept])
      React.useEffect(() => () => request.current?.abort(), [])
      const control = async action => {
        if (request.current) return
        const controller = new AbortController()
        request.current = controller; setBusy(true); setError('')
        try {
          const params = { namespace, action }
          if (action !== 'start') params.id = run.id
          accept(await api('dreaming', params, { method: 'POST', signal: controller.signal }))
        } catch (reason) { if (!controller.signal.aborted) setError(reason?.message || '操作失败，请重试。') }
        finally { if (request.current === controller) { request.current = null; setBusy(false) } }
      }
      const running = run?.status === 'running'
      const pausing = run?.status === 'pausing'
      const paused = run?.status === 'paused'
      const outstanding = running || pausing || paused
      const openSession = async () => {
        if (busy) return
        setBusy(true); setError('')
        try {
          const response = await api('dreaming', { namespace, action: 'open-session', id: run.id }, { method: 'POST' })
          if (!response.sessionId || !onOpenDreamingSession) throw new Error('当前宿主无法打开 Dreaming 会话')
          await onOpenDreamingSession(response.sessionId)
        } catch (reason) { setError(reason?.message || '无法打开会话，请稍后重试。') }
        finally { setBusy(false) }
      }
      // Only a run that is still in flight keeps the card. Finished rounds fold
      // into the single summary row under the directory, never a lingering card.
      const showCard = Boolean(run) && ['running', 'pausing', 'paused'].includes(run.status)
      if (!showCard) return h(React.Fragment, null, h('style', null, DREAMING_STYLES + DIRECTORY_PREVIEW_STYLES),
        toast ? h('p', { className: 'sg-dreaming-toast', role: 'status', 'aria-live': 'polite' }, toast) : null,
        h('button', { type: 'button', className: 'sg-dreaming-start' + (inline ? ' sg-dreaming-arrange' : ''), disabled: busy || !available, onClick: () => control('start') }, inline ? '整理这些' : '🌙 Dreaming'),
        error ? h('p', { className: 'sg-dreaming-failure', role: 'alert' }, error, h('button', { type: 'button', className: 'sg-dreaming-retry', disabled: busy, onClick: () => api('dreaming', { namespace }).then(accept).catch(() => setError('状态读取失败，请稍后重试。')) }, '重试')) : null)
      return h('aside', { className: 'sg-dreaming ' + (running ? 'running' : 'resting') + (inline ? ' inline' : ''), 'aria-label': 'Dreaming 目录整理', 'data-testid': 'stratagate-dreaming' },
        h('style', null, DREAMING_STYLES + DIRECTORY_PREVIEW_STYLES),
        toast ? h('p', { className: 'sg-dreaming-toast', role: 'status', 'aria-live': 'polite' }, toast) : null,
        h('div', { className: 'sg-dreaming-row' },
          h('div', { className: 'sg-dreaming-animation', 'aria-hidden': 'true' }, h('span', { className: 'sg-dreaming-moon' }, '☾'), h('span', { className: 'sg-dreaming-star' }, '✦'), h('span', { className: 'sg-dreaming-sleep' }, 'z')),
          h('div', { className: 'sg-dreaming-copy', role: 'status', 'aria-live': 'polite' }, h('strong', null, running ? run.waitingForProjection ? 'Dreaming 正在准备…' : '正在做梦…' : pausing ? '正在暂停…' : 'Dreaming 已暂停'),
            h('span', null, run?.activity || '整理目录、总览与经验')),
          h('div', { className: 'sg-dreaming-actions' },
            running || pausing ? h('button', { type: 'button', disabled: busy || pausing, onClick: () => control('pause') }, pausing ? '正在暂停…' : '暂停') : null,
            paused && !run.replanRequired ? h('button', { type: 'button', disabled: busy, onClick: () => control('resume') }, '继续') : null,
            outstanding ? h('button', { type: 'button', className: 'sg-dreaming-stop', disabled: busy, onClick: (event) => { stopTrigger.current = event.currentTarget; setConfirmStop(true) } }, '终止') : null)),
        run ? h('div', { className: 'sg-dreaming-progress' }, h('progress', { max: Math.max(1, run.total), value: run.completed, 'aria-label': 'Dreaming 整理进度（批次）' }), h('span', null, Math.round(100 * run.completed / Math.max(1, run.total)) + '% · ' + run.completed + '/' + run.total + ' 批次')) : null,
        h('button', { type: 'button', className: 'sg-dreaming-session', disabled: busy || !run.sessionId, onClick: openSession }, run.sessionId ? '打开 Dreaming 会话 ↗' : running || pausing ? '会话准备中…' : '本轮未创建会话'),
        run?.reason ? h('p', null, run.reason) : null,
        error ? h('p', { className: 'sg-dreaming-failure', role: 'alert' }, error, h('button', { type: 'button', className: 'sg-dreaming-retry', disabled: busy, onClick: () => api('dreaming', { namespace }).then(accept).catch(() => setError('状态读取失败，请稍后重试。')) }, '重试')) : null,
        confirmStop ? h('div', { className: 'sg-import-overlay', role: 'presentation' }, h('section', { ref: stopDialog, className: 'sg-dlg', role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': 'sg-stop-title', 'aria-describedby': 'sg-stop-copy' },
          h('h3', { id: 'sg-stop-title' }, '终止这次整理？'),
          h('div', { className: 'sg-steps', 'aria-hidden': 'true' }, Array.from({ length: 7 }, (_, index) => h('i', { key: index, className: index < Math.min(7, Math.max(0, Math.round(run.completed / Math.max(1, run.total) * 7))) ? '' : 'todo' }))),
          h('div', { className: 'sg-steps-l', id: 'sg-stop-copy' }, h('span', null, h('b', null, Math.min(7, Math.max(0, Math.round(run.completed / Math.max(1, run.total) * 7))) + ' 章'), '整理好的会保留'), h('span', null, (7 - Math.min(7, Math.max(0, Math.round(run.completed / Math.max(1, run.total) * 7)))) + ' 章保持原样')),
          h('div', { className: 'sg-dlg-acts' }, h('button', { type: 'button', className: 'sg-btn ghost', disabled: busy, onClick: () => setConfirmStop(false) }, '继续整理'), h('button', { type: 'button', className: 'sg-btn danger', disabled: busy, onClick: async () => { await control('terminate'); setConfirmStop(false) } }, '终止')))) : null)
    }

    function TopicDirectory({ directory, namespace, active = true, openEvent, onDirectoryChanged, onOpenDreamingSession }) {
      const [pendingOpen, setPendingOpen] = React.useState(false)
      const [invalidatedRevision, setInvalidatedRevision] = React.useState(null)
      const [expandRequest, setExpandRequest] = React.useState(0)
      const [selectedSection, setSelectedSection] = React.useState('')
      const [summaryBusy, setSummaryBusy] = React.useState(false)
      const [summaryError, setSummaryError] = React.useState('')
      const chaptersRef = React.useRef(null)
      const revision = directory?.revision || ''
      const blocked = invalidatedRevision === revision
      // A successful dashboard read is a fresh snapshot even if content changed
      // away and back to the same hash before the refresh completed.
      React.useEffect(() => { setInvalidatedRevision(null) }, [directory])
      const pageRevision = blocked ? '' : revision
      const invalidate = React.useCallback(() => { setInvalidatedRevision(revision); return onDirectoryChanged?.() }, [revision, onDirectoryChanged])
      const topics = directory?.topics || []
      const pendingTotal = Number(directory?.pending?.total || 0)
      // The pending list is exactly the set of events with no topic yet, and it
      // is the set Dreaming can re-file. Section-coverage gaps are not listed by
      // this read, so they must not inflate the count.
      const unassignedTotal = pendingTotal
      const firstSection = topics.flatMap((topic) => topicSections(topic).map((part) => ({ topic, part })))[0]
      const openSection = selectedSection
      const [dreamHidden, setDreamHidden] = React.useState(() => dreamDismissed(directory?.dreaming?.id))
      const dreamRun = !dreamHidden && directory?.dreaming && ['completed', 'terminated'].includes(directory.dreaming.status) ? directory.dreaming : null
      // A completed or terminated round keeps one quiet summary line under the
      // table of contents; clicking it opens that round's real host session.
      const openDreamRun = async () => {
        if (summaryBusy || !dreamRun?.sessionId || !onOpenDreamingSession) return
        setSummaryBusy(true); setSummaryError('')
        try {
          const response = await api('dreaming', { namespace, action: 'open-session', id: dreamRun.id }, { method: 'POST' })
          if (!response.sessionId) throw new Error('当前宿主无法打开 Dreaming 会话')
          await onOpenDreamingSession(response.sessionId)
        } catch (reason) { setSummaryError(reason?.message || '无法打开会话，请稍后重试。') }
        finally { setSummaryBusy(false) }
      }
      const dreamSummary = () => {
        if (!dreamRun?.updatedAt) return h('span', null, '目录会随整理更新')
        // changedBatches counts actual section rewrites; the destination count
        // is the number of sections that survived the round.
        const changed = Math.max(0, Number(dreamRun.changedBatches || 0))
        const sections = topics.reduce((sum, topic) => sum + topicSections(topic).length, 0)
        const [, month, day] = eventDayKey(dreamRun.updatedAt).split('-')
        const stamp = month && day ? month + '/' + day : formatTime(dreamRun.updatedAt)
        return h('span', { className: 'sg-toc-dream' },
          h('button', { type: 'button', className: 'sg-toc-dream-run', disabled: summaryBusy || !dreamRun.sessionId || !onOpenDreamingSession, onClick: openDreamRun, title: dreamRun.sessionId ? '打开当轮 Dreaming 会话' : '本轮没有创建会话' },
            '上次整理 ' + stamp + (changed ? ' · ' + changed + ' 节 → ' + sections + ' 节' : '') + (dreamRun.status === 'terminated' ? ' · 已终止' : '')),
          // A schematic “merge” glyph, matching the timeline strip; not a count.
          h('span', { className: 'sg-toc-dream-merge', 'aria-hidden': 'true' },
            Array.from({ length: 4 }, (_, index) => h('i', { key: 'f' + index })), h('span', null, '→'), Array.from({ length: 2 }, (_, index) => h('i', { key: 't' + index, className: 'o' }))),
          dreamRun.status === 'terminated' ? h('span', { className: 'sg-toc-dream-note' }, '已整理的章节已保留') : null,
          h('button', { type: 'button', className: 'sg-toc-dream-close', 'aria-label': '关闭这次整理记录', onClick: () => { dismissDream(dreamRun.id); setDreamHidden(true) } }, '×'),
          summaryError ? h('span', { className: 'sg-toc-dream-error', role: 'alert' }, summaryError, h('button', { type: 'button', className: 'sg-toc-dream-retry', onClick: openDreamRun, disabled: summaryBusy }, '重试')) : null)
      }
      return h('section', { className: 'sg-topic-directory', 'data-testid': 'stratagate-topic-directory', 'aria-label': '主题目录' },
        blocked ? h('p', { className: 'sg-topic-read-error', role: 'status' }, '目录已有更新，正在重新读取。', h('button', { type: 'button', onClick: onDirectoryChanged }, '重新读取目录')) : null,
        h('div', { hidden: blocked }, h(TopicBootstrapNotice, { directory }),
          !directory ? h('p', { className: 'sg-topic-empty', role: 'status' }, '暂时无法读取主题目录，请稍后重新打开。') : !topics.length && !pendingTotal ? h('div', { className: 'sg-topic-empty' }, h('h3', null, '还没有长期记忆'), h('p', null, '产生长期事件后，主题会在这里逐步整理成目录。')) : null,
          topics.length || pendingTotal ? h('div', { className: 'sg-how' }, h('i', { className: 'sg-sw moss', 'aria-hidden': 'true' }), '目录一直带着', h('span', { 'aria-hidden': 'true' }, '→'), h('i', { className: 'sg-sw lib', 'aria-hidden': 'true' }), '需要时翻到具体事件') : null,
          h('div', { className: 'sg-book' }, h('div', { className: 'sg-leaf' },
            h('h3', { className: 'sg-toc-title' }, '目录'),
            h('div', { className: 'sg-toc-col' }, '事件'),
            h('div', { ref: chaptersRef }, topics.map((topic, index) => h(TopicChapter, { key: topic.id, topic, number: index + 1, namespace, revision: pageRevision, active: active && !blocked, openEvent, onDirectoryChanged: invalidate, expandRequest, openSection, onSectionToggle: (key, part) => setSelectedSection(key) }))),
            // The right page shows the first section's title and prose until a
            // section is clicked; this avoids a blank page without prefetching
            // event rows before the user asks for them.
            !selectedSection && firstSection ? h('div', { className: 'sg-book-preview', 'aria-label': '默认打开的章节' },
              h('span', { className: 'sg-leaf-k' }, '1.1'), h('h3', null, firstSection.part.uiTitle),
              h('p', { className: 'sg-leaf-sum' }, (firstSection.part.paragraphs || []).map((paragraph) => paragraph.text || '').filter(Boolean).join('\n\n') || '点左侧小节，翻开具体事件。')) : null,
            // Pending events stay reachable through the existing lightweight
            // disclosure; CSS hides the old "待整理 N 条" label in the book.
            unassignedTotal ? h('section', { className: 'sg-topic-pending', 'aria-label': '待整理事件' },
              h('div', { className: 'sg-topic-pending-heading' },
                h('button', { type: 'button', className: 'sg-topic-pending-toggle', 'aria-expanded': pendingOpen, 'aria-controls': 'sg-topic-pending-events', onClick: () => setPendingOpen((value) => !value) }, h('span', { className: 'sg-topic-pending-label' }, '待整理'), h('span', null, unassignedTotal + ' 条'), h('span', { className: 'sg-directory-chevron', 'aria-hidden': 'true' }, '›')),
                h(DreamingPanel, { key: namespace, namespace, initialRun: directory?.dreaming, active, available: unassignedTotal > 0 && !blocked, inline: true, onDirectoryChanged, onOpenDreamingSession })),
              h(DirectoryFold, { open: pendingOpen, id: 'sg-topic-pending-events' }, h('p', null, '这些记忆尚未形成稳定主题，仍可直接查看原事件。'), h(TopicEventList, { namespace, revision: pageRevision, topicId: 'pending', total: pendingTotal, active: active && !blocked && pendingOpen, openEvent, onDirectoryChanged: invalidate, expandLabel: '查看全部待整理', collapseLabel: '收起待整理事件' }))) : null,
            h('div', { className: 'sg-toc-foot sg-leaf-foot' }, dreamSummary(), h(DirectoryContextPreview, { context: blocked ? '' : directory?.context, active }))))))
    }

    function LongTermPage({ events, eventPage, graph, graphSettings = {}, project, query, setQuery, openEvent, namespace, focusNodeId, onFocusHandled, topicDirectory, onDirectoryChanged, onOpenDreamingSession, extractionGap = false, active = true, refresh }) {
      const graphVisible = graphSettings.enabled === true || graphSettings.noticeSeen !== true
      const [mode, setMode] = React.useState('topics')
      const [selectedNodeId, setSelectedNodeId] = React.useState('')
      const [selectedEventId, setSelectedEventId] = React.useState('')
      const [graphNodeLimit, setGraphNodeLimit] = React.useState(100)
      const [eventFilters, setEventFilters] = React.useState({ time: '', node: '', type: '', status: '' })
      const [nodeType, setNodeType] = React.useState('')
      const [nodeTag, setNodeTag] = React.useState('')
      const [filtersOpen, setFiltersOpen] = React.useState(false)
      const [fullScreen, setFullScreen] = React.useState(false)
      const [graphMenuOpen, setGraphMenuOpen] = React.useState(false)
      const graphMenuRef = React.useRef(null)
      const debouncedQuery = useDebouncedValue(query)
      const timelineParams = mode === 'timeline' ? {
        timeline: 'true',
        ...(debouncedQuery.trim() ? { q: debouncedQuery.trim() } : {}),
        ...(eventFilters.time ? { time: eventFilters.time } : {}),
        ...(eventFilters.node ? { participant: eventFilters.node } : {}),
        ...(eventFilters.type ? { eventType: eventFilters.type } : {}),
        ...(eventFilters.status ? { eventStatus: eventFilters.status } : {}),
      } : {}
      const pagedEvents = usePagedMemory({ namespace, kind: 'events', initialItems: events, initialPage: eventPage, fallbackLimit: 40, extraParams: timelineParams, reloadOnParamsChange: mode === 'timeline' })
      const timelineEvents = pagedEvents.items
      const nodes = graph.nodes || []; const edges = graph.edges || []; const clusters = graph.clusters || []; const normalized = query.trim().toLocaleLowerCase()
      const nodeImportance = React.useMemo(() => graphNodeImportance(nodes, edges, project), [nodes, edges, project])
      const nodeTags = [...new Set(nodes.flatMap((node) => node.tags || []))].sort((left, right) => left.localeCompare(right))
      React.useEffect(() => {
        if (!graphVisible || !focusNodeId || !nodes.some((node) => node.id === focusNodeId)) return
        setMode('graph')
        setNodeType('')
        setNodeTag('')
        const rank = [...nodes].sort((left, right) => (nodeImportance.get(right.id)?.score || 0) - (nodeImportance.get(left.id)?.score || 0)).findIndex((node) => node.id === focusNodeId)
        if (rank >= 0) setGraphNodeLimit((current) => Math.max(current, rank + 1))
        setSelectedNodeId(focusNodeId)
        setFullScreen(true)
        onFocusHandled?.()
      }, [graphVisible, focusNodeId, nodes, nodeImportance, onFocusHandled])
      React.useEffect(() => {
        if (!fullScreen || !active) return undefined
        const previous = document.body.style.overflow
        document.body.style.overflow = 'hidden'
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return
          if (document.querySelector('.sg-long-explorer .sg-info-trigger[aria-expanded="true"]')) return
          setFullScreen(false)
          setFiltersOpen(false)
        }
        window.addEventListener('keydown', onKeyDown)
        return () => { document.body.style.overflow = previous; window.removeEventListener('keydown', onKeyDown) }
      }, [fullScreen, active])
      React.useEffect(() => {
        if (!graphMenuOpen) return undefined
        const onPointerDown = (event) => {
          if (!graphMenuRef.current?.contains(event.target)) setGraphMenuOpen(false)
        }
        const onKeyDown = (event) => { if (event.key === 'Escape') setGraphMenuOpen(false) }
        document.addEventListener('pointerdown', onPointerDown)
        document.addEventListener('keydown', onKeyDown)
        return () => { document.removeEventListener('pointerdown', onPointerDown); document.removeEventListener('keydown', onKeyDown) }
      }, [graphMenuOpen])
      const visibleNodes = nodes.filter((node) => node.status !== 'archived').filter((node) => !nodeType || node.type === nodeType).filter((node) => !nodeTag || (node.tags || []).includes(nodeTag)).filter((node) => !normalized || JSON.stringify(node).toLocaleLowerCase().includes(normalized))
      const visibleGraphIds = new Set(visibleNodes.map((node) => node.id))
      const displayedGraphIds = new Set([...visibleNodes].sort((left, right) => (nodeImportance.get(right.id)?.score || 0) - (nodeImportance.get(left.id)?.score || 0)).slice(0, graphNodeLimit).map((node) => node.id))
      const activeEdges = edges.filter((edge) => edge.status === 'active' && visibleGraphIds.has(edge.fromNodeId) && visibleGraphIds.has(edge.toNodeId))
      const displayedEdgeCount = activeEdges.filter((edge) => displayedGraphIds.has(edge.fromNodeId) && displayedGraphIds.has(edge.toNodeId)).length
      const displayedNodeCount = Math.min(graphNodeLimit, visibleNodes.length)
      const countText = (shown, total, unit) => (shown === total ? String(total) : shown + ' / ' + total) + ' ' + unit
      const resultCount = mode === 'graph'
        ? countText(displayedNodeCount, visibleNodes.length, '个节点') + ' · ' + countText(displayedEdgeCount, activeEdges.length, '条关系')
        : countText(timelineEvents.length, pagedEvents.page.total, '条事件')
      const selectEvent = (id) => { setSelectedEventId(id); setMode('timeline') }
      const selectNode = (id) => { setSelectedNodeId(id); setMode('graph') }
      const openExplorer = () => {
        if (mode === 'graph' && !selectedNodeId && visibleNodes[0]) setSelectedNodeId(visibleNodes[0].id)
        if (mode === 'timeline' && !selectedEventId && timelineEvents[0]) setSelectedEventId(timelineEvents[0].id)
        setFiltersOpen(true)
        setFullScreen(true)
      }
      const migrationNotice = graphMigrationNotice(graph.migration)
      const activeFilterCount = mode === 'graph' ? Number(Boolean(nodeType)) + Number(Boolean(nodeTag)) : Object.values(eventFilters).filter(Boolean).length
      const filterControls = mode === 'graph'
        ? h('div', { className: 'sg-filterbar' }, h('select', { value: nodeType, onChange: (event) => setNodeType(event.target.value), 'aria-label': '节点类型' }, h('option', { value: '' }, '全部节点类型'), Object.entries(NODE_META).map(([value, meta]) => h('option', { key: value, value }, meta[0]))), h('select', { value: nodeTag, onChange: (event) => setNodeTag(event.target.value), 'aria-label': '语义标签' }, h('option', { value: '' }, '全部语义标签'), nodeTags.map((tag) => h('option', { key: tag, value: tag }, tag))))
        : h('div', { className: 'sg-filterbar' },
          h('select', { value: eventFilters.time, onChange: (event) => setEventFilters({ ...eventFilters, time: event.target.value }), 'aria-label': '时间范围' }, h('option', { value: '' }, '全部时间'), h('option', { value: 'today' }, '今天'), h('option', { value: 'week' }, '本周'), h('option', { value: 'unknown' }, '发生时间未知')),
          h('select', { value: eventFilters.node, onChange: (event) => setEventFilters({ ...eventFilters, node: event.target.value }), 'aria-label': '参与实体' }, h('option', { value: '' }, '全部实体'), nodes.map((node) => h('option', { key: node.id, value: node.id }, node.name))),
          h('select', { value: eventFilters.type, onChange: (event) => setEventFilters({ ...eventFilters, type: event.target.value }), 'aria-label': '事件类型' }, h('option', { value: '' }, '全部类型'), Object.entries(EVENT_TYPE_TEXT).map(([value, label]) => h('option', { key: value, value }, label))),
          h('select', { value: eventFilters.status, onChange: (event) => setEventFilters({ ...eventFilters, status: event.target.value }), 'aria-label': '事件状态' }, h('option', { value: '' }, '全部状态'), Object.entries(EVENT_STATUS_TEXT).map(([value, label]) => h('option', { key: value, value }, label))))
      // The page header carries the two real views; the graph keeps its own "+"
      // entry and only reappears as a segment once the user has turned it on.
      // The graph is off by default: only its "+" entry shows until the user
      // explicitly enables it, so no graph label appears in the segment.
      const longTabs = [['topics', '目录'], ...(graphSettings.enabled === true ? [['graph', '知识图谱']] : []), ['timeline', '时间线']]
      const tabButton = ([id, label]) => h('button', { key: id, type: 'button', className: mode === id ? 'active' : '', 'aria-current': mode === id ? 'page' : undefined, 'aria-pressed': mode === id, 'aria-label': id === 'graph-add' ? '重新打开知识图谱' : label, onClick: () => { setMode(id === 'graph-add' ? 'graph' : id); setGraphMenuOpen(id === 'graph-add' || (id === 'graph' && graphSettings.enabled !== true && graphSettings.noticeSeen !== true)); if (id === 'topics') { setFullScreen(false); setFiltersOpen(false) } } }, label)
      const graphMenu = h('div', { ref: graphMenuRef, className: 'sg-graph-menu' }, h('button', { type: 'button', className: 'sg-graph-menu-trigger', 'aria-label': '知识图谱设置', 'aria-expanded': graphMenuOpen, onClick: () => setGraphMenuOpen((value) => !value) }, h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' }, h('path', { d: 'M12 5v14M5 12h14', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' }))), graphMenuOpen ? h('div', { className: 'sg-graph-menu-popover' }, h(GraphControlPanel, { state: graphSettings, refresh, page: true, onOpenGraph: () => { setGraphMenuOpen(false); setMode('graph') }, onGraphHidden: () => { setGraphMenuOpen(false); setMode('topics') } })) : null)
      const tabChildren = [...longTabs.map(tabButton), graphMenu]
      return h('section', { className: 'sg-long-explorer ' + (fullScreen ? 'fullscreen' : ''), 'aria-label': fullScreen ? '长期记忆全屏探索' : '长期记忆浏览' },
        h('div', { className: 'sg-pg-head' }, h('h2', null, '长期记忆'),
          h('span', { className: 'sg-pg-end' }, h('nav', { className: 'sg-long-tabs sg-seg', 'aria-label': '长期记忆视角' }, tabChildren))),
        h('div', { hidden: mode !== 'topics' }, h(TopicDirectory, { directory: topicDirectory, namespace, active: active && mode === 'topics', openEvent, onDirectoryChanged, onOpenDreamingSession })),
        mode === 'topics' ? null : h(React.Fragment, null,
        mode === 'graph' && migrationNotice ? h('p', { className: 'sg-muted' }, migrationNotice) : null,
        mode === 'timeline' && extractionGap ? h('p', { className: 'sg-muted' }, '部分对话尚未形成长期记忆，暂不能通过长期记忆检索。') : null,
        h('div', { className: 'sg-long-toolbar' },
          h(SearchBox, { value: query, onChange: setQuery, placeholder: mode === 'graph' ? '搜索人物、项目、概念…' : '搜索事件…' }),
          h('button', { type: 'button', className: 'sg-toolbar-button', 'aria-expanded': filtersOpen ? 'true' : 'false', onClick: () => setFiltersOpen(!filtersOpen) }, '筛选 ▾', activeFilterCount ? h('span', { className: 'sg-active-filter-count' }, activeFilterCount) : null),
          mode === 'graph' && graphNodeLimit < visibleNodes.length ? h('button', { type: 'button', className: 'sg-toolbar-button', onClick: () => setGraphNodeLimit((current) => Math.min(visibleNodes.length, current + 100)) }, '再显示 100 个') : null,
          h('button', { type: 'button', className: 'sg-toolbar-button', onClick: fullScreen ? () => { setFullScreen(false); setFiltersOpen(false) } : openExplorer }, fullScreen ? '退出全屏' : '⛶ 全屏查看' + (mode === 'graph' ? '图谱' : '时间线'))),
        h('div', { className: 'sg-toolbar-count' }, resultCount),
        filtersOpen ? filterControls : null,
        mode === 'graph'
          ? h('div', { className: 'sg-long-layout ' + (fullScreen ? '' : 'sg-summary-layout'), 'aria-disabled': !graphSettings.enabled, inert: !graphSettings.enabled ? '' : undefined, style: !graphSettings.enabled ? { filter: 'grayscale(1)', opacity: 0.4, pointerEvents: 'none' } : undefined },
            h(GraphCanvas, { nodes: visibleNodes, edges, clusters, importance: nodeImportance, selectedId: selectedNodeId, onSelect: setSelectedNodeId, nodeLimit: graphNodeLimit, showSummary: !fullScreen, onViewDetails: openExplorer }),
            fullScreen ? h(NodeDetailPanel, { node: nodes.find((node) => node.id === selectedNodeId), nodes, edges, events, onEvent: selectEvent }) : null)
          : h(React.Fragment, null,
            h('div', { className: 'sg-long-layout ' + (fullScreen ? 'sg-timeline-layout' : 'sg-summary-layout') },
              h(TimelineList, { events: timelineEvents, nodes, onSelect: setSelectedEventId, selectedId: selectedEventId, floating: !fullScreen, onNode: selectNode, openSource: openEvent, dreaming: topicDirectory?.dreaming }),
              fullScreen ? h(EventDetailPanel, { event: timelineEvents.find((event) => event.id === selectedEventId), nodes, events: timelineEvents, onNode: selectNode, openSource: openEvent }) : null),
            h(Pagination, { page: pagedEvents.page, loading: pagedEvents.loading, error: pagedEvents.error, onOffset: pagedEvents.loadOffset }))))
    }

    function previewText(value) {
      const text = String(value || '').replace(/\s+/g, ' ').trim() || '暂无内容'
      return text.length > 200 ? text.slice(0, 200) + '…' : text
    }

    function turnRangeText(range) {
      if (!Array.isArray(range) || range.length < 2 || range[1] < range[0]) return '等待新对话'
      return 'Turn ' + range[0] + '–' + range[1]
    }

    function LayerPreview({ layer, currentLevel, expanding, busy, pendingSelection, allowExpand, onExpand }) {
      const itemRef = React.useRef(null)
      const hideTimer = React.useRef(null)
      const popoverRef = React.useRef(null)
      const level = Number(layer.level)
      const actionable = allowExpand && Number.isInteger(level) && (level !== currentLevel || pendingSelection)

      const cancelHide = () => {
        if (hideTimer.current) window.clearTimeout(hideTimer.current)
        hideTimer.current = null
      }
      const removePopover = () => {
        popoverRef.current?.remove()
        popoverRef.current = null
      }
      const showPopover = () => {
        cancelHide()
        const rect = itemRef.current?.getBoundingClientRect()
        if (!rect) return
        const inline = window.innerWidth < 860
        const width = Math.min(390, Math.max(240, window.innerWidth - 24))
        const maxHeight = Math.min(520, window.innerHeight * 0.7)
        const right = rect.right + 12
        const left = right + width <= window.innerWidth - 12 ? right : Math.max(12, rect.left - width - 12)
        const top = Math.min(Math.max(12, rect.top - 8), Math.max(12, window.innerHeight - maxHeight - 12))
        if (!popoverRef.current) {
          const popover = document.createElement('aside')
          const title = document.createElement('strong')
          const content = document.createElement('p')
          const theme = window.getComputedStyle(itemRef.current)
          const pageTheme = window.getComputedStyle(itemRef.current.closest('.sg-memory'))
          popover.className = 'sg-layer-popover'
          popover.setAttribute('role', 'tooltip')
          popover.style.background = pageTheme.backgroundColor
          popover.style.color = pageTheme.color
          popover.style.borderColor = theme.borderColor
          title.textContent = 'L' + level + ' 完整内容'
          content.className = 'sg-layer-full'
          content.textContent = String(layer.content || '暂无内容')
          popover.append(title, content)
          popover.addEventListener('mouseenter', cancelHide)
          popover.addEventListener('mouseleave', scheduleHide)
          if (inline) itemRef.current.parentElement.appendChild(popover)
          else document.body.appendChild(popover)
          popoverRef.current = popover
        }
        popoverRef.current.style.setProperty('position', inline ? 'relative' : 'fixed', 'important')
        popoverRef.current.style.width = inline ? 'auto' : width + 'px'
        popoverRef.current.style.left = inline ? '0' : left + 'px'
        popoverRef.current.style.top = inline ? '0' : top + 'px'
        popoverRef.current.style.maxHeight = inline ? '240px' : maxHeight + 'px'
      }
      const scheduleHide = () => {
        cancelHide()
        hideTimer.current = window.setTimeout(removePopover, 140)
      }
      React.useEffect(() => () => { cancelHide(); removePopover() }, [])

      return h('div', { className: 'sg-layer-hover' },
        h('div', { ref: itemRef, className: 'sg-layer-item ' + (level === currentLevel ? 'current' : ''), 'data-level': String(level) },
          h('span', { className: 'sg-layer-label' }, 'L' + level),
          h('span', { className: 'sg-layer-preview', tabIndex: 0, onMouseEnter: showPopover, onMouseLeave: scheduleHide, onFocus: showPopover, onBlur: scheduleHide }, previewText(layer.content)),
          actionable ? h('button', { className: 'sg-layer-use', type: 'button', disabled: busy, onMouseEnter: removePopover, onFocus: removePopover, onClick: (event) => { event.stopPropagation(); void onExpand(level) } }, expanding ? '正在应用…' : '让助手参考 L' + level)
            : h('span', { className: 'sg-layer-using' }, level === currentLevel ? '助手可见' : '仅供预览')))
    }

    function BlockLayerPanel({ block, detail, loading, expandingLevel, selectionBusy, onExpand }) {
      if (loading) return h('div', { className: 'sg-layer-panel' }, h(Loading))
      const layers = Array.isArray(detail?.layers) ? detail.layers : []
      const visibleLevel = visibleBlockLevel(block)
      return h('div', { className: 'sg-layer-panel' },
        h('div', { className: 'sg-layer-heading' }, h('strong', null, '分层内容预览'), h('span', null, '助手可见：' + (visibleLevel === null ? '尚未确认' : 'L' + visibleLevel))),
        h('p', { className: 'sg-layer-hint' }, '预览不会改变助手可见的内容。悬停或聚焦可查看完整内容。'),
        block.virtual ? h('div', { className: 'sg-virtual-note' }, '旧会话展示片段为只读内容，不会改写原始数据库。') : null,
        layers.length ? h('div', { className: 'sg-layer-stack' }, layers.slice().sort((a, b) => a.level - b.level).map((layer) => h(LayerPreview, { key: layer.level, layer, currentLevel: visibleLevel, expanding: expandingLevel === layer.level, busy: selectionBusy || expandingLevel >= 0, pendingSelection: block.surfaceSync?.status === 'pending' || block.surfaceSync?.status === 'blocked', allowExpand: !block.virtual, onExpand }))) : h('div', { className: 'sg-muted' }, '暂时无法读取这段历史的分层内容。'))
    }

    function visibleBlockLevel(block) {
      return block.surfaceLevelKnown === false || !Number.isInteger(block.currentLevel) ? null : block.currentLevel
    }

    function BlockSelectionFeedback({ block, feedback, onRefresh }) {
      const value = feedback || block.surfaceSync
      if (!value || value.status === 'applied' && !feedback) return null
      const visible = visibleBlockLevel(block)
      const current = visible === null ? '助手可见的层级尚未确认。' : (value.uncertain ? '上次确认助手可见 L' : '助手当前可见 L') + visible + '。'
      const level = value.level ?? block.targetLevel
      const selected = Number.isInteger(level) ? 'L' + level : '所选内容'
      const message = value.status === 'applied' ? value.message
        : (value.status === 'pending' ? '已选择 ' + selected + '。' : '暂时无法应用 ' + selected + '。') + value.message + ' ' + current
      return h('div', { className: 'sg-selection-feedback' + (value.status === 'blocked' ? ' error' : ''), role: value.status === 'blocked' ? 'alert' : 'status' }, message,
        value.uncertain && onRefresh ? h('button', { type: 'button', className: 'sg-quiet-button', onClick: onRefresh }, '刷新状态') : null)
    }

    function SummaryUnavailable({ namespace, block }) {
      const [source, setSource] = React.useState(null)
      const [readError, setReadError] = React.useState(null)
      const [loading, setLoading] = React.useState(false)
      const [open, setOpen] = React.useState(false)
      const request = React.useRef(null)
      React.useEffect(() => () => request.current?.abort(), [])
      const openRaw = async () => {
        if (request.current) return
        if (source) { setOpen(true); return }
        const controller = new AbortController()
        request.current = controller
        setLoading(true)
        setReadError(null)
        try {
          const value = await api('sources', { namespace, blockId: block.id }, { signal: controller.signal })
          if (controller.signal.aborted) return
          if (value.namespace !== namespace || !Array.isArray(value.messages)) {
            setReadError({ kind: 'temporary', text: '暂时无法读取这段对话的原文。' }); return
          }
          if (!value.messages.some((message) => String(message.content || '').trim())) {
            setReadError({ kind: 'unavailable', text: '当前没有可读取的原文。' }); return
          }
          setSource(value)
          setOpen(true)
        } catch (reason) {
          if (!controller.signal.aborted) setReadError({
            kind: [401, 403, 404, 410].includes(reason?.status) ? 'unavailable' : 'temporary',
            text: '暂时无法读取这段对话的原文。',
          })
        } finally {
          if (request.current === controller) { request.current = null; if (!controller.signal.aborted) setLoading(false) }
        }
      }
      const rawId = 'sg-summary-raw-' + block.id
      return h('div', { className: 'sg-block-expanded sg-muted' },
        h('p', null, '这段对话的摘要暂不可用。'),
        (block.rawAvailable || source) && readError?.kind !== 'unavailable' ? h('button', { type: 'button', className: 'sg-quiet-button', disabled: loading, 'aria-expanded': open, 'aria-controls': rawId, onClick: open ? () => setOpen(false) : openRaw }, open ? '收起原始对话' : loading ? '正在读取…' : readError?.kind === 'temporary' ? '重新读取原文' : '查看原始对话') : null,
        readError ? h('p', { role: 'status' }, readError.text) : null,
        open && source ? h('div', { id: rawId, className: 'sg-summary-raw' }, source.messages.map((message) => h('div', { key: message.id, className: 'sg-raw-message' }, h('div', { className: 'sg-muted' }, message.role + ' · ' + formatTime(message.createdAt)), h('div', { className: 'sg-code' }, String(message.content || ''))))) : null)
    }

    const DAILY_WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
    function dailyParts(date) {
      const [year, month, day] = date.split('-').map(Number)
      return { year, month, day, week: DAILY_WEEK[new Date(Date.UTC(year, month - 1, day)).getUTCDay()] }
    }
    function dailyRelative(date, today) {
      const days = Math.round((Date.parse(today + 'T00:00:00Z') - Date.parse(date + 'T00:00:00Z')) / 86400000)
      return days === 0 ? '今天' : days === 1 ? '昨天' : days > 1 ? days + ' 天前' : Math.abs(days) + ' 天后'
    }
    function DailyIcon({ name }) {
      const paths = {
        calendar: ['M8 2v4', 'M16 2v4', 'M3 10h18', 'M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2'],
        folder: ['M6 14 7.5 11a2 2 0 0 1 1.8-1H20a2 2 0 0 1 1.9 2.6l-2.2 7A2 2 0 0 1 17.8 21H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v2'],
        left: ['m15 18-6-6 6-6'], right: ['m9 18 6-6-6-6'],
        refresh: ['M3 12a9 9 0 0 1 15.4-6.4L21 8', 'M21 3v5h-5', 'M21 12a9 9 0 0 1-15.4 6.4L3 16', 'M8 16H3v5'],
        notebook: ['M2 6h4', 'M2 10h4', 'M2 14h4', 'M2 18h4', 'M8 2v20', 'M6 2h13a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2'],
        alert: ['M12 8v4', 'M12 16h.01'], pause: ['M10 8v8', 'M14 8v8'],
      }
      return h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        ['alert', 'pause'].includes(name) ? h('circle', { cx: 12, cy: 12, r: 10 }) : null,
        (paths[name] || []).map((d, key) => h('path', { key, d })))
    }
    function dailyInline(text) {
      return String(text).split(/(`[^`\n]+`)/g).map((part, key) =>  /^`[^`\n]+`$/.test(part) ? h('code', { key }, part.slice(1, -1)) : part)
    }
    function renderDailyMarkdown(markdown) {
      const output = []; let children = []; let title = null; let list = []
      const flushList = () => { if (list.length) { children.push(h('ul', { key: 'list-' + children.length }, list)); list = [] } }
      const flushItem = () => { flushList(); if (children.length || title !== null) output.push(h('article', { className: 'sg-daily-item', key: output.length }, title !== null ? h('h4', null, dailyInline(title)) : null, children)); children = []; title = null }
      for (const raw of String(markdown).split(/\r?\n/)) {
        const line = raw.trimEnd()
        if (/^# \d{4}-\d{2}-\d{2}$/.test(line)) continue
        if (line.startsWith('## ')) { flushItem(); title = line.slice(3); continue }
        if (line.startsWith('- ')) { list.push(h('li', { key: list.length }, dailyInline(line.slice(2)))); continue }
        flushList()
        if (!line) continue
        const status = line.match(/^(当前|已完成)：\s*(.*)$/)
        children.push(status ? h('p', { key: children.length, className: 'sg-daily-status' + (status[1] === '已完成' ? ' done' : '') }, h('b', null, status[1]), h('span', null, dailyInline(status[2]))) : h('p', { key: children.length }, dailyInline(line)))
      }
      flushItem(); return output
    }
    // Plain digest for the day list. The full note view keeps the original Markdown.
    function dailyNoteDigest(markdown) {
      const items = []
      let current = null
      for (const raw of String(markdown || '').split(/\r?\n/)) {
        const line = raw.trim()
        if (!line || /^# \d{4}-\d{2}-\d{2}$/.test(line)) continue
        if (line.startsWith('## ')) { current = { title: line.slice(3), detail: '', time: '' }; items.push(current); continue }
        if (!current) continue
        const clock = line.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/)
        if (clock && !current.time) current.time = clock[1].padStart(2, '0') + ':' + clock[2]
        if (!current.detail) current.detail = line.replace(/^(当前|已完成)：\s*/, '').replace(/^[-*]\s+/, '')
      }
      return items
    }
    function DailyNotesPage({ namespace, setDailyInjectionDays }) {
      const [index, setIndex] = React.useState(null)
      const [indexLoading, setIndexLoading] = React.useState(true)
      const [indexError, setIndexError] = React.useState('')
      const [selected, setSelected] = React.useState('')
      const [note, setNote] = React.useState({ loading: false, date: '', markdown: '', error: '' })
      const [revision, setRevision] = React.useState(0)
      const [noteRevision, setNoteRevision] = React.useState(0)
      const [dayDigests, setDayDigests] = React.useState({})
      const [daySaving, setDaySaving] = React.useState(false)
      const [dayError, setDayError] = React.useState('')
      const [daysOverride, setDaysOverride] = React.useState(null)
      // The full note is an explicit second step, not an always-open panel.
      const [openDay, setOpenDay] = React.useState(false)
      React.useEffect(() => {
        const abort = new AbortController()
        setIndexLoading(true); setIndexError(''); setOpenDay(false)
        if (!namespace) { setIndex(null); setSelected(''); setIndexLoading(false); return () => abort.abort() }
        void api('daily', { namespace }, { signal: abort.signal }).then(data => {
          if (abort.signal.aborted) return
          setDaysOverride(null)
          setIndex(data); setSelected(current => data.dates.includes(current) ? current : data.injectedDates[0] || data.dates[0] || '')
        }).catch(error => { if (!abort.signal.aborted) setIndexError(String(error.message || error)) }).finally(() => { if (!abort.signal.aborted) setIndexLoading(false) })
        return () => abort.abort()
      }, [namespace, revision])
      React.useEffect(() => {
        const abort = new AbortController()
        setNote({ loading: Boolean(selected), date: selected, markdown: '', error: '' })
        if (selected) void api('daily/note', { namespace, date: selected }, { signal: abort.signal }).then(data => {
          if (!abort.signal.aborted) setNote({ loading: false, date: selected, markdown: data.markdown, error: '' })
        }).catch(error => { if (!abort.signal.aborted) setNote({ loading: false, date: selected, markdown: '', error: String(error.message || error) }) })
        return () => abort.abort()
      }, [namespace, selected, noteRevision])
      const choose = date => { setSelected(date); setOpenDay(true) }
      const dates = index?.dates || []; const injected = index?.injectedDates || []; const enabled = index?.enabled !== false
      const savedInjectionDays = index?.injectionDays ?? 3
      const injectionDays = daysOverride ?? savedInjectionDays
      const digests = dayDigests && typeof dayDigests === 'object' ? dayDigests : {}
      React.useEffect(() => {
        let active = true
        const controller = new AbortController()
        const wanted = dates.slice(0, 14).filter(date => !(date in digests))
        if (!wanted.length || indexError || !namespace) return () => controller.abort()
        void Promise.all(wanted.map(async date => {
          try {
            const value = await api('daily/note', { namespace, date }, { signal: controller.signal })
            return [date, dailyNoteDigest(value?.markdown)]
          } catch { return [date, null] }
        })).then(entries => {
          if (!active || controller.signal.aborted) return
          setDayDigests(current => {
            const next = { ...current }
            for (const [date, items] of entries) next[date] = items
            return next
          })
        })
        return () => { active = false; controller.abort() }
      }, [namespace, indexError, dates.join(',')])
      const stepDays = async (delta) => {
        if (!setDailyInjectionDays || daySaving) return
        const next = Math.min(30, Math.max(1, injectionDays + delta))
        if (next === injectionDays) return
        setDaysOverride(next); setDaySaving(true); setDayError('')
        try {
          if (!await setDailyInjectionDays(next)) {
            setDaysOverride(null)
            setDayError('天数未保存，请重试。')
          }
        }
        catch (reason) {
          setDaysOverride(null)
          setDayError('天数保存失败：' + String(reason?.message || reason))
        }
        finally { setDaySaving(false) }
      }
      const failure = error => h('div', { className: 'sg-daily-state error', role: 'alert' }, h('span', { className: 'sg-daily-icon-wrap' }, h(DailyIcon, { name: 'alert' })), h('h3', null, '暂时无法读取笔记'), h('p', null, '文件可能被占用或权限不足，已有笔记不会丢失。'), h('button', { type: 'button', className: 'sg-daily-retry', onClick: () => indexError ? setRevision(v => v + 1) : setNoteRevision(v => v + 1) }, h(DailyIcon, { name: 'refresh' }), '重新读取'), h('details', null, h('summary', null, '错误详情'), error))
      const date = selected ? dailyParts(selected) : null
      const days = dates.slice(0, 14)
      const dayRows = () => {
        const rows = []
        let cutShown = false
        days.forEach((day, position) => {
          const parts = dailyParts(day)
          const isInjected = enabled && injected.includes(day)
          const items = digests[day]
          // When injection is off every day is outside the window, so the cut
          // line would separate nothing and is omitted.
          if (enabled && !cutShown && !isInjected && days.slice(0, position).some(earlier => injected.includes(earlier))) {
            cutShown = true
            rows.push(h('div', { key: day + '-cut', className: 'sg-day-cut' }, h('span', null, '以下不带入')))
          }
          const entries = Array.isArray(items) && items.length ? items : [{ title: '查看当天笔记', detail: '', time: '' }]
          const lines = entries.slice(0, 6).map((item, key) => h('li', { key },
            h('span', { className: 'sg-day-t' }, item.time || ''),
            h('button', {
              type: 'button',
              className: 'sg-day-s',
              onClick: () => choose(day),
              'aria-label': parts.month + '月' + parts.day + '日 ' + item.title + '，查看当天笔记',
            }, item.title),
            h('span')))
          rows.push(h('div', { key: day, className: 'sg-day' + (isInjected ? '' : ' out'), style: { animationDelay: position * 40 + 'ms' } },
            h('button', { type: 'button', role: 'tab', id: 'sg-day-tab-' + day, 'aria-controls': 'sg-day-note', 'data-day': day, 'aria-selected': selected === day, tabIndex: selected === day || (!days.includes(selected) && position === 0) ? 0 : -1, className: 'sg-day-d', onClick: () => choose(day), onKeyDown: event => {
              const next = event.key === 'ArrowDown' ? (position + 1) % days.length : event.key === 'ArrowUp' ? (position + days.length - 1) % days.length : event.key === 'Home' ? 0 : event.key === 'End' ? days.length - 1 : -1
              if (next >= 0) { event.preventDefault(); choose(days[next]); event.currentTarget.closest('.sg-days')?.querySelector('[data-day="' + days[next] + '"]')?.focus() }
            } }, h('b', null, parts.day), h('span', null, parts.week), h('span', { className: 'sg-visually-hidden' }, parts.month + '月 · ' + dailyRelative(day, index.today))),
            h('div', { className: 'sg-day-rail', 'aria-hidden': 'true' }),
            h('ul', null, lines)))
        })
        return rows
      }
      return h('div', { className: 'sg-daily' },
        h('div', { className: 'sg-pg-head' }, h('h2', null, '短期记忆'),
          h('span', { className: 'sg-pg-tag' }, h('i', { className: 'sg-sw sand', 'aria-hidden': 'true' }), enabled ? '新会话带入最近 ' + injectionDays + ' 个有笔记日期' : '已暂停注入'),
          h('span', { className: 'sg-pg-end' }, setDailyInjectionDays ? h('span', { className: 'sg-stp', role: 'group', 'aria-label': '带入新会话的天数' },
            h('button', { type: 'button', 'aria-label': '减少一天', disabled: daySaving || injectionDays <= 1, onClick: () => void stepDays(-1) }, '\u2212'),
            h('span', { 'aria-live': 'polite' }, injectionDays + ' 天'),
            h('button', { type: 'button', 'aria-label': '增加一天', disabled: daySaving || injectionDays >= 30, onClick: () => void stepDays(1) }, '+')) : null,
          // The calendar and folder icons are gone; earlier dates come from the day
          // list itself, so the header only keeps the day stepper.
          null),
        dayError ? h('p', { className: 'sg-storage-feedback failed', role: 'alert' }, dayError) : null,
        indexLoading ? h(Loading) : indexError ? failure(indexError) : h(React.Fragment, null,
          !enabled ? h('div', { className: 'sg-daily-off' }, h(DailyIcon, { name: 'pause' }), '已关闭，不再写入，也不会带入新会话。') : null,
          dates.length ? h(React.Fragment, null,
            h('div', { className: 'sg-days', role: 'tablist', 'aria-label': '带入新会话的笔记' }, dayRows()),
            // The day list only carries the point titles; the whole note opens on
            // an explicit click, so the page never stacks a full note under it.
            !openDay ? null
              : note.loading || note.date !== selected ? h(Loading) : note.error ? failure(note.error) : date ? h('article', { key: selected, id: 'sg-day-note', role: 'tabpanel', 'aria-labelledby': 'sg-day-tab-' + selected, className: 'sg-daily-note' },
              h('div', { className: 'sg-daily-note-date' }, h('h3', null, date.month + ' 月 ' + date.day + ' 日'), h('span', null, date.week + ' · ' + dailyRelative(selected, index.today))),
              h('div', { className: 'sg-daily-meta' }, h('button', { type: 'button', className: 'sg-daily-back', onClick: () => setOpenDay(false) }, '收起笔记'), h('span', { className: 'sg-daily-pill' + (!enabled || !injected.includes(selected) ? ' muted' : '') }, !enabled ? '已暂停注入' : injected.includes(selected) ? '会带入新会话' : '不在带入范围内'), !injected.includes(selected) && enabled ? h('button', { type: 'button', className: 'sg-daily-back', onClick: () => choose(injected[0]) }, '回到最近笔记') : null), renderDailyMarkdown(note.markdown)) : null)
            : h('div', { className: 'sg-daily-state' }, h('span', { className: 'sg-daily-icon-wrap' }, h(DailyIcon, { name: 'notebook' })), h('h3', null, '还没有笔记'), h('p', null, 'Agent 推进工作时会自动记录。')))))
    }

    function ShortTermPage({ blocks, blockPage, openBlock, conversations, activeThreadId, namespace, onConversationChange, refresh, blockTurnSize = 6 }) {
      const pagedBlocks = usePagedMemory({ namespace, kind: 'blocks', initialItems: blocks, initialPage: blockPage, fallbackLimit: 40, extraParams: { threadId: activeThreadId } })
      const visible = [...pagedBlocks.items].sort((a, b) => Number(a.sequence || 0) - Number(b.sequence || 0) || String(a.createdAt).localeCompare(String(b.createdAt)))
      const [expandedId, setExpandedId] = React.useState('')
      const [detailBlockId, setDetailBlockId] = React.useState('')
      const [details, setDetails] = React.useState({})
      const [loadingId, setLoadingId] = React.useState('')
      const [expanding, setExpanding] = React.useState({ blockId: '', level: -1 })
      const [previewError, setPreviewError] = React.useState(null)
      const [selectionFeedback, setSelectionFeedback] = React.useState({})
      const scope = namespace + '\u0000' + activeThreadId
      const activeScope = React.useRef(scope)
      activeScope.current = scope
      const selectionRequest = React.useRef(null)
      const currentOpen = openBlock || { turnRange: null, messages: 0, status: 'open' }

      React.useEffect(() => {
        setExpandedId(''); setDetailBlockId(''); setDetails({}); setLoadingId(''); setPreviewError(null); setSelectionFeedback({})
      }, [scope])

      React.useEffect(() => {
        const applied = Object.entries(selectionFeedback).filter(([, value]) => value?.status === 'applied')
        if (!applied.length) return undefined
        const timer = window.setTimeout(() => setSelectionFeedback((current) => {
          const next = { ...current }
          for (const [id, value] of applied) if (next[id] === value) delete next[id]
          return next
        }), 4000)
        return () => window.clearTimeout(timer)
      }, [selectionFeedback])


      const toggleBlock = (block) => {
        if (expandedId === block.id) { setExpandedId(''); return }
        setExpandedId(block.id)
        setPreviewError(null)
        if (details[block.id]) return
        setLoadingId(block.id)
        void api('sources', { namespace, blockId: block.id })
          .then((value) => { if (activeScope.current === scope) setDetails((current) => ({ ...current, [block.id]: value })) })
          .catch(() => { if (activeScope.current === scope) setPreviewError({ scope, blockId: block.id, message: '暂时无法读取预览，请稍后重新打开。' }) })
          .finally(() => { if (activeScope.current === scope) setLoadingId((current) => current === block.id ? '' : current) })
      }

      const expandTo = async (block, level) => {
        if (selectionRequest.current?.scope === scope) return
        const request = { scope, blockId: block.id, level }
        selectionRequest.current = request
        const isCurrent = () => activeScope.current === scope && selectionRequest.current === request
        setSelectionFeedback((current) => ({ ...current, [block.id]: null }))
        setExpanding(request)
        let result
        try {
          result = await api('blocks/expand', { namespace, blockId: block.id, level: 'L' + level }, { method: 'PATCH' })
        } catch (reason) {
          const rejected = reason?.code === 'BLOCK_SELECTION_REJECTED' || [400, 403, 404, 409].includes(reason?.status)
          if (isCurrent()) setSelectionFeedback((current) => ({ ...current, [block.id]: {
            scope, level, status: rejected ? 'blocked' : 'pending', uncertain: !rejected,
            message: rejected ? (/[\u4e00-\u9fff]/.test(reason?.message || '') ? reason.message.replace('（blocks/expand）', '') : '这次选择未能应用，请稍后重试。') : '暂时无法确认应用结果，请刷新后查看。',
          } }))
        }
        if (isCurrent()) {
          try {
            await refresh()
            if (isCurrent() && pagedBlocks.page.offset > 0) await pagedBlocks.loadOffset(pagedBlocks.page.offset)
            if (result && isCurrent()) setSelectionFeedback((current) => ({ ...current, [block.id]: result.surfaceSync?.status === 'applied'
              ? { scope, level, status: 'applied', message: '已应用 L' + level + '，供助手后续回复参考。' }
              : null }))
          } catch {
            if (isCurrent()) setSelectionFeedback((current) => ({ ...current, [block.id]: { scope, level, status: 'pending', uncertain: true, message: '暂时无法确认应用结果，请刷新后查看。' } }))
          }
        }
        if (selectionRequest.current === request) {
          selectionRequest.current = null
          setExpanding({ blockId: '', level: -1 })
        }
      }

      const selectedBlock = visible.find((block) => block.id === expandedId) || visible[visible.length - 1] || null
      const levelOf = (block) => { const level = visibleBlockLevel(block); return level === null ? 0 : Math.min(5, Math.max(0, level)) }
      // Turns per Block can differ from the historical 6, so the open Block's dot
      // count follows the real capacity instead of a hard-coded six.
      const openCapacity = Math.max(1, Number(currentOpen.capacity || blockTurnSize || 6))
      const openUsed = Math.min(openCapacity, Math.max(0, Number(currentOpen.turns || 0)))
      const remainingDots = Math.max(1, openCapacity - openUsed)
      const firstTurn = visible.length ? visible[0].turnRange?.[0] : null
      const lastTurn = visible.length ? visible[visible.length - 1].turnRange?.[1] : null
      const turnSpan = Number.isInteger(firstTurn) && Number.isInteger(lastTurn) ? ' · 第 ' + firstTurn + '–' + lastTurn + ' 轮' : ''
      // Narrow panels move to the real detail view instead of expanding in place.
      const narrow = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia('(max-width: 680px)').matches === true
        : false
      const detailBlock = narrow && detailBlockId ? visible.find((block) => block.id === detailBlockId) : null
      if (detailBlock) return h('div', { className: 'sg-ss-detail-page' },
        h(BackBar, { label: '会话记忆', onBack: () => setDetailBlockId('') }),
        h(ShortTermMemoryBlockDetail, { key: namespace + ':' + detailBlock.id, namespace, block: detailBlock }))
      return h(React.Fragment, null,
        h('div', { className: 'sg-pg-head' }, h('h2', null, '会话记忆'),
          h('span', { className: 'sg-pg-tag' }, h('i', { className: 'sg-sw water', 'aria-hidden': 'true' }), pagedBlocks.page.total + ' 块' + turnSpan),
          conversations.length ? h('span', { className: 'sg-pg-end' }, h('label', { className: 'sg-conversation' }, h('span', null, '当前对话：'), h('select', { value: activeThreadId || '', onChange: (event) => onConversationChange(event.target.value), 'aria-label': '当前对话' }, conversations.map((conversation) => h('option', { key: conversation.id, value: conversation.id }, conversation.label))))) : null),
        h('section', { className: 'sg-block-list sg-ss-list', 'aria-label': 'Block 列表' },
          h('section', { className: 'sg-visually-hidden', 'aria-labelledby': 'sg-decay-title' },
            h('h2', { id: 'sg-decay-title' }, '块衰减总览'),
            h('div', { className: 'sg-distribution', 'aria-label': 'Block 当前层级分布' }, visible.map((block) => h('span', { key: block.id, className: 'sg-level-chip', 'data-level': visibleBlockLevel(block) === null ? undefined : String(block.currentLevel), title: 'Block #' + block.sequence }, visibleBlockLevel(block) === null ? '尚未确认' : 'L' + block.currentLevel)), h('span', { className: 'sg-level-chip sg-open-chip' }, '开放块 · 未封存')),
            h('input', { className: 'sg-distribution-rail', type: 'range', min: '0', max: '0', step: '1', value: '0', disabled: true, readOnly: true, 'aria-label': 'Block 分布滑轨' })),
          h('div', { className: 'sg-block-header sg-visually-hidden', 'aria-hidden': 'true' }, h('span', null, '助手可见层级'), h('span', null, 'Block'), h('span', null, '覆盖 Turn'), h('span', null, '距最新封存块'), h('span')),
          h('div', { className: 'sg-ss-scale' }, h('span', null, '更早'), h('span', { className: 'sg-r', 'aria-hidden': 'true' }, [0, 1, 2, 3, 4, 5].map((level) => h('i', { key: level, style: { height: 5 + level * 3 + 'px', opacity: .3 + level * .14 } }))), h('span', null, '最近'), h('span', null, '越早的对话压得越薄')),
          h('div', { className: 'sg-ss' },
            h('div', { className: 'sg-ss-main' }, visible.map((block) => h('div', { key: block.id, className: 'sg-block-unit' },
            h('button', { className: 'sg-block-toggle', type: 'button', onClick: () => narrow ? setDetailBlockId(block.id) : toggleBlock(block), 'aria-expanded': narrow ? undefined : expandedId === block.id ? 'true' : 'false', 'aria-label': '记忆块 ' + block.sequence + '，' + turnRangeText(block.turnRange) + (narrow ? '，打开详情' : '') },
              h('span', { className: 'sg-ss-num' }, String(block.sequence)),
              h('span', { className: 'sg-ss-bar', style: { height: 20 + levelOf(block) * 5 + 'px', background: 'color-mix(in srgb, var(--sg-water) ' + (14 + levelOf(block) * 14) + '%, var(--sg-page))' } }, h('span', null, block.title || (block.virtual ? '旧 Block #' : 'Block #') + block.sequence)),
              // The level badge repeated what the bar height already encodes, so
              // the row keeps only the real title.
              h('span', { className: 'sg-ss-use' }),
              h('span', { className: 'sg-block-turn' }, turnRangeText(block.turnRange)),
              h('span', { className: 'sg-block-distance' }, block.distanceFromLatest === 0 ? '0（最新）' : block.distanceFromLatest + ' 个 Block'),
              null),
            h(BlockSelectionFeedback, { block, feedback: selectionFeedback[block.id]?.scope === scope ? selectionFeedback[block.id] : null, onRefresh: async () => {
              try {
                await refresh()
                if (activeScope.current !== scope) return
                if (pagedBlocks.page.offset > 0) await pagedBlocks.loadOffset(pagedBlocks.page.offset)
                if (activeScope.current === scope) setSelectionFeedback((current) => ({ ...current, [block.id]: null }))
              } catch { /* Keep the existing explanation and refresh action available. */ }
            } }),
            previewError?.scope === scope && previewError.blockId === block.id ? h('div', { role: 'alert', className: 'sg-selection-feedback error' }, previewError.message) : null,
            summaryUnavailable(block) ? h(SummaryUnavailable, { key: namespace + ':' + block.id, namespace, block }) : null,
            expandedId === block.id ? h('div', { className: 'sg-block-expanded' }, h(BlockLayerPanel, { block, detail: details[block.id], loading: loadingId === block.id, selectionBusy: expanding.scope === scope && expanding.level >= 0, expandingLevel: expanding.scope === scope && expanding.blockId === block.id ? expanding.level : -1, onExpand: (level) => expandTo(block, level) })) : null)),
            h('div', { className: 'sg-block-unit' }, h('div', { className: 'sg-ss-open' },
              h('span', { className: 'sg-ss-num' }, '·'),
              h('div', { className: 'sg-ss-bar' }, h('span', null, '正在记录'), h('span', { className: 'sg-ss-dots', role: 'img', 'aria-label': '还差 ' + remainingDots + ' 轮封存', 'aria-hidden': undefined }, Array.from({ length: remainingDots }, (_, index) => h('i', { key: index, className: index < Math.min(remainingDots, Math.max(0, openCapacity - openUsed)) ? '' : 'o' })))),
              h('span')))),
            selectedBlock ? h('aside', { className: 'sg-ss-side', 'aria-label': '选中记忆块详情' },
              h('h3', null, selectedBlock.title || 'Block #' + selectedBlock.sequence),
              h('span', { className: 'sg-k' }, '记忆块 ' + selectedBlock.sequence + ' · ' + turnRangeText(selectedBlock.turnRange)),
              h('div', { className: 'sg-lvl', 'aria-hidden': 'true' }, [0, 1, 2, 3, 4, 5].map((level) => h('i', { key: level, className: level <= levelOf(selectedBlock) ? 'on' : '' }))),
              h('div', { className: 'sg-lvl-l' }, h('span', null, '只留标题'), h('span', null, '原文')),
              h('p', null, selectedBlock.summary || (selectedBlock.keypoints || []).join('；') || '这一块暂时没有摘要。'),
              h('button', { type: 'button', className: 'sg-btn', onClick: () => toggleBlock(selectedBlock) }, expandedId === selectedBlock.id ? '收起详情' : '看原文')) : null)),
        h(Pagination, { page: pagedBlocks.page, loading: pagedBlocks.loading, error: pagedBlocks.error, onOffset: pagedBlocks.loadOffset }))
    }

    function SourceDetails({ item, source, kind }) {
      const messages = source?.messages || []
      return h('div', { className: 'sg-detail-section' },
        h('h3', { className: 'sg-section-title' }, '来源'),
        h('div', { className: 'sg-source-label' }, h('span', { className: 'sg-source-icon', 'aria-hidden': 'true' }, '▣'), h('span', null, '当前 DeepSeek 对话')),
        h('details', { className: 'sg-tech' }, h('summary', null, '技术详情'), h('div', { className: 'sg-tech-body' },
          h('div', { className: 'sg-tech-row' }, h('span', { className: 'sg-muted' }, kind === 'block' ? 'Block ID' : 'Event ID'), h('span', { className: 'sg-code' }, item.id)),
          kind === 'block' && item.turnRange ? h('div', { className: 'sg-tech-row' }, h('span', { className: 'sg-muted' }, 'Turn'), h('span', null, item.turnRange.join(' - '))) : null,
          messages.length ? messages.map((message) => h('div', { key: message.id, className: 'sg-raw-message' }, h('div', { className: 'sg-muted' }, String(message.role || '') + ' · ' + formatTime(message.createdAt)), h('div', { className: 'sg-code' }, String(message.content || '')))) : h('div', { className: 'sg-muted' }, '当前数据中没有可显示的来源消息。'))))
    }

    function EventDetail({ event, project, source, onBack, backLabel, onNode }) {
      const detailedEvent = source?.events?.find((item) => item.id === event.id) || event
      return h(InfoPopoverGroup, null,
        h(BackBar, { label: backLabel, onBack }),
        h('header', { className: 'sg-detail-header sg-event-page-header' }, h('span', { className: 'sg-event-detail-kicker' }, 'Event'), h('h2', { className: 'sg-detail-title' }, detailedEvent.title || '记忆详情'), h(EventMetadata, { event: detailedEvent, nodes: source?.relatedNodes || [], onNode })),
        h(EventMemoryDetails, { event: detailedEvent, sourceMessages: source?.messages || [] }))
    }

    function ElementDetail({ element, events, source, openEvent, onBack, backLabel }) {
      const facts = []
      if (element.currentState) facts.push(element.currentState)
      for (const fact of element.facts || []) {
        const value = Array.isArray(fact.value) ? fact.value.join('、') : fact.value
        if (value && !facts.includes(String(value))) facts.push(String(value))
      }
      const related = events.filter((event) => (element.sourceEventIds || []).includes(event.id)).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
      return h(React.Fragment, null,
        h(BackBar, { label: backLabel, onBack }),
        h('header', { className: 'sg-detail-header' }, h('h2', { className: 'sg-detail-title' }, element.name || '相关事物'), h('p', { className: 'sg-detail-subtitle' }, 'AI 关于它目前知道这些'), h('div', { className: 'sg-meta' }, h('span', null, '相关经历 ' + related.length + ' 条'), h('span', { className: 'sg-meta-sep' }, '最近更新 ' + formatTime(element.updatedAt)))),
        h('div', { className: 'sg-detail-section' }, facts.length ? h('ul', { className: 'sg-facts' }, facts.map((fact, index) => h('li', { key: index }, fact))) : h('div', { className: 'sg-muted' }, '暂时没有形成可展示的认识。')),
        h('div', { className: 'sg-detail-section' }, h('h3', { className: 'sg-section-title' }, '相关经历'), related.length ? h('div', { className: 'sg-related-list' }, related.map((event) => h('button', { key: event.id, className: 'sg-related', onClick: () => openEvent(event) }, h('span', { className: 'sg-related-name' }, event.title), h('span', { className: 'sg-related-time' }, formatTime(event.updatedAt || event.createdAt))))) : h('div', { className: 'sg-muted' }, '没有关联经历。')),
        h(SourceDetails, { item: element, source, kind: 'element' }))
    }

    function processingFingerprint(overview) {
      return JSON.stringify({
        failedJobs: Number(overview?.failedJobs || 0),
        duplicateRepair: overview?.duplicateRepair ?? null,
        processingJobs: Number(overview?.processingJobs || 0),
        failures: (overview?.failedJobDetails || []).map(({ kind, id, attempts, updatedAt, lastError }) => ({ kind, id, attempts, updatedAt, lastError })),
        processing: (overview?.processingJobDetails || []).map(({ kind, id, status, attempts, updatedAt }) => ({ kind, id, status, attempts, updatedAt })),
      })
    }

    function ProcessingStatus({ overview, blocks, conversations, namespace, serverVersion, onBack, backLabel = '返回', refresh }) {
      const failures = overview.failedJobDetails || []
      const failedKeys = new Set(failures.map(statusJobKey))
      const terminalFailedKeys = new Set(failures
        .filter((job) => job.state === 'terminal-failed' || (!job.state && !job.nextRetryAt))
        .map(statusJobKey))
      const hasProcessingDetails = Array.isArray(overview.processingJobDetails)
      const rawProcessingCount = activeProcessingCount(overview)
      const jobsByKey = new Map((overview.processingJobDetails || []).map((job) => [statusJobKey(job), job]))
      for (const job of failures) jobsByKey.set(statusJobKey(job), job)
      const [refreshing, setRefreshing] = React.useState(false)
      const [feedback, setFeedback] = React.useState({ kind: '', text: '' })
      const [retrying, setRetrying] = React.useState('')
      const retryRequest = React.useRef(false)
      const [retryErrors, setRetryErrors] = React.useState({})
      const blockById = new Map(blocks.map((block) => [block.id, block]))
      const conversationById = new Map((conversations || []).map((conversation) => [conversation.id, conversation]))
      if (!hasProcessingDetails && rawProcessingCount > 0) {
        const addLegacyJob = (block, kind, status, details = {}) => {
          const job = {
            id: 'legacy:' + block.id + ':' + kind,
            kind,
            status,
            attempts: details.attempts ?? 0,
            nextRetryAt: details.nextRetryAt ?? null,
            updatedAt: details.updatedAt || block.createdAt,
            legacy: true,
            blockIds: [block.id],
            blockDetails: [{
              id: block.id, sourceId: block.sourceId || block.id, sequence: block.sequence || block.blockIndex,
              title: block.title || block.l0Title, threadId: block.threadId, turnRange: block.turnRange,
              shouldExtract: block.shouldExtract,
            }],
          }
          jobsByKey.set(statusJobKey(job), job)
        }
        for (const block of blocks) {
          const processing = block.status === 'processing' || block.processingStatus === 'pending'
          if (!processing) continue
          let found = false
          if (['pending', 'running'].includes(block.summaryJob?.status) || block.processingStatus === 'pending') {
            addLegacyJob(block, 'block-summary', block.summaryJob?.status || 'pending', block.summaryJob)
            found = true
          }
          if (block.eventExtraction?.status === 'running') {
            addLegacyJob(block, 'event-extraction', 'running', block.eventExtraction)
            found = true
          }
          if (['pending', 'running'].includes(block.graphProjection?.status)) {
            addLegacyJob(block, 'graph-projection', block.graphProjection.status, block.graphProjection)
            found = true
          }
          if (!found) addLegacyJob(block, 'event-extraction', 'running')
        }
      }
      const taskLabel = (kind) => kind === 'block-summary' ? '会话记忆压缩' : kind === 'event-extraction' ? '长期记忆提取' : kind === 'topic-projection' ? '主题整理' : '知识图谱更新'
      const retryKey = statusJobKey
      const technicalStatusText = (status, job) => job?.state === 'terminal-failed'
        ? '终态失败'
        : job?.state === 'retryable'
          ? '计划自动重试'
          : status === 'running' ? '运行中' : status === 'pending' ? '排队中' : status === 'failed' ? '失败' : status === 'succeeded' || status === 'completed' ? '已完成' : String(status || '未知')
      const workItems = new Map()
      for (const job of jobsByKey.values()) {
        let details = Array.isArray(job.blockDetails) ? job.blockDetails : []
        if (!details.length) {
          const ids = Array.isArray(job.blockIds) && job.blockIds.length ? job.blockIds : job.id && !['graph-projection', 'topic-projection'].includes(job.kind) ? [job.id] : []
          details = ids.map((id) => blockById.get(id)).filter(Boolean).map((block) => ({
            id: block.id, sourceId: block.id, sequence: block.sequence, title: block.title || block.l0Title,
            threadId: block.threadId, turnRange: block.turnRange, shouldExtract: block.shouldExtract, rawAvailable: block.rawAvailable,
          }))
        }
        if (!details.length) details = [{ id: statusJobKey(job), sourceId: '', sequence: null, title: '', threadId: job.threadId || '', turnRange: job.turnRange, shouldExtract: null }]
        for (const detail of details) {
          const key = String(detail.threadId || '') + ':' + String(detail.id || detail.sourceId || statusJobKey(job))
          const item = workItems.get(key) || { ...detail, jobs: [] }
          if (!item.jobs.some((candidate) => statusJobKey(candidate) === statusJobKey(job))) item.jobs.push(job)
          workItems.set(key, item)
        }
      }
      const items = [...workItems.values()].sort((left, right) => {
        const threadOrder = String(left.threadId || '').localeCompare(String(right.threadId || ''))
        if (threadOrder) return threadOrder
        return Number(left.turnRange?.[0] || left.sequence || 0) - Number(right.turnRange?.[0] || right.sequence || 0)
      })
      const itemState = (item) => {
        if (item.jobs.some((job) => terminalFailedKeys.has(statusJobKey(job)))) return { kind: 'failed', label: '终态失败，可重试', mark: '!' }
        if (item.jobs.some((job) => job.status === 'running')) return { kind: 'processing', label: '正在整理', mark: '●' }
        if (item.jobs.some((job) => job.state === 'retryable' || (failedKeys.has(statusJobKey(job)) && job.nextRetryAt))) return { kind: 'processing', label: '计划自动重试', mark: '↻' }
        return { kind: 'waiting', label: '等待整理', mark: '○' }
      }
      const itemStages = (item) => {
        const summaryJob = item.jobs.find((job) => job.kind === 'block-summary')
        const extractionJobs = item.jobs.filter((job) => job.kind === 'event-extraction')
        const graphJobs = item.jobs.filter((job) => job.kind === 'graph-projection')
        const topicJobs = item.jobs.filter((job) => job.kind === 'topic-projection')
        const summaryFailed = summaryJob && terminalFailedKeys.has(statusJobKey(summaryJob))
        const extractionFailed = extractionJobs.some((job) => terminalFailedKeys.has(statusJobKey(job)))
        const graphFailed = graphJobs.some((job) => terminalFailedKeys.has(statusJobKey(job)))
        const shortStage = summaryFailed
          ? { kind: 'failed', mark: '!', label: '终态失败，可重试' }
            : summaryJob?.status === 'running'
              ? { kind: 'processing', mark: '●', label: '处理中' }
              : summaryJob?.state === 'retryable'
                ? { kind: 'processing', mark: '↻', label: '计划自动重试' }
            : summaryJob
              ? { kind: 'waiting', mark: '○', label: '排队中' }
              : { kind: 'done', mark: '✓', label: '已完成' }
        const stageForJobs = (jobs, failed, emptyLabel, failedLabel = '终态失败，可重试') => {
          if (failed) return { kind: 'failed', mark: '!', label: failedLabel }
          if (jobs.some((job) => job.status === 'running')) return { kind: 'processing', mark: '●', label: '处理中' }
          if (jobs.some((job) => job.state === 'retryable')) return { kind: 'processing', mark: '↻', label: '计划自动重试' }
          if (jobs.length) return { kind: 'waiting', mark: '○', label: '排队中' }
          return { kind: 'waiting', mark: '○', label: emptyLabel }
        }
        if (topicJobs.length === item.jobs.length) return [['主题整理', stageForJobs(topicJobs,
          topicJobs.some((job) => terminalFailedKeys.has(statusJobKey(job))), '等待整理')]]
        const extractionStage = extractionFailed
          ? stageForJobs(extractionJobs, true, '等待提取')
          : extractionJobs.length
            ? stageForJobs(extractionJobs, false, '等待提取')
            : graphJobs.length
              ? { kind: 'done', mark: '✓', label: '已完成' }
            : shortStage.kind !== 'done'
              ? { kind: 'waiting', mark: '○', label: '等待短期摘要' }
              : item.shouldExtract === false
                ? { kind: 'skipped', mark: '–', label: '无需提取' }
                : { kind: 'waiting', mark: '○', label: '等待提取' }
        const graphStage = graphFailed
          ? stageForJobs(graphJobs, true, '等待图谱更新', '更新失败，可重试')
          : graphJobs.length
            ? stageForJobs(graphJobs, false, '等待图谱更新')
            : extractionStage.kind === 'failed' || extractionStage.kind === 'waiting' || extractionStage.kind === 'processing'
              ? { kind: 'waiting', mark: '○', label: '等待长期记忆提取' }
              : { kind: 'waiting', mark: '○', label: '等待图谱更新' }
        return [
          ['原始对话', item.rawAvailable === true
            ? { kind: 'done', mark: '✓', label: '当前可读取' }
            : { kind: 'waiting', mark: '○', label: item.rawAvailable === false ? '当前无可读取原文' : '无法确认是否可读取' }],
          ['压缩会话记忆', shortStage],
          ['提取长期记忆', extractionStage],
          ['更新知识图谱', graphStage],
        ]
      }
      const conversationLabel = (threadId) => {
        if (threadId === '__legacy__') return '历史对话'
        return conversationById.get(threadId)?.label || (threadId ? '对话 ' + String(threadId).slice(0, 8) : '历史或未知对话')
      }
      const groups = []
      for (const item of items) {
        const key = item.threadId || '__unknown__'
        let group = groups.find((candidate) => candidate.key === key)
        if (!group) { group = { key, label: conversationLabel(item.threadId), items: [] }; groups.push(group) }
        group.items.push(item)
      }
      const checkStatus = () => {
        const before = processingFingerprint(overview)
        setRefreshing(true)
        setFeedback({ kind: '', text: '正在读取…' })
        return refresh({ propagateError: true }).then((next) => {
          const selected = next?.overview?.namespaces?.find((item) => item.namespace === namespace)
          const changed = selected && processingFingerprint(selected) !== before
          setFeedback({ kind: 'done', text: changed ? '状态已更新' : '状态没有变化' })
        }).catch((reason) => {
          setFeedback({ kind: 'failed', text: '读取失败：' + String(reason?.message || reason) })
        }).finally(() => setRefreshing(false))
      }
      const retryJob = (job) => {
        if (retryRequest.current) return
        retryRequest.current = true
        const key = retryKey(job)
        setRetrying(key)
        setRetryErrors((current) => ({ ...current, [key]: '' }))
        setFeedback({ kind: '', text: taskLabel(job.kind) + ' 正在处理…' })
        return api('jobs/retry', { namespace, kind: job.kind, jobId: job.id }, { method: 'POST' })
          .then(() => refresh({ propagateError: true }))
          .then(() => setFeedback({ kind: 'done', text: job.kind === 'topic-projection' ? '已重新排队，按历史额度继续整理' : '任务已完成，状态已更新' }))
          .catch(async (reason) => {
            const message = String(reason?.message || reason)
            setRetryErrors((current) => ({ ...current, [key]: message }))
            setFeedback({ kind: 'failed', text: '重试失败：' + message })
            try { await refresh({ propagateError: true }) } catch {}
          })
          .finally(() => { retryRequest.current = false; setRetrying('') })
      }
      const failedItems = items.filter((item) => item.jobs.some((job) => terminalFailedKeys.has(statusJobKey(job)))).length
      const activeItems = Math.max(0, items.length - failedItems)
      const unresolvedProcessingCount = hasProcessingDetails ? 0 : Math.max(0, rawProcessingCount - activeItems)
      const detailsUnavailable = !hasProcessingDetails && rawProcessingCount > 0
      const versionMismatch = Boolean(serverVersion && serverVersion !== STRATAGATE_CLIENT_VERSION)
      const summary = items.length
        ? groups.length + ' 个会话 · ' + (activeItems ? activeItems + ' 个正在整理' : '') + (activeItems && failedItems ? ' · ' : '') + (failedItems ? failedItems + ' 个需要重试' : '') + (unresolvedProcessingCount ? ' · 另有 ' + unresolvedProcessingCount + ' 个详情暂不可用' : '')
        : detailsUnavailable
          ? '仍有 ' + rawProcessingCount + ' 个后台任务正在整理'
          : hasProcessingDetails ? '当前没有待处理或失败的任务' : '暂时无法确认后台任务状态'
      return h(React.Fragment, null,
        h(BackBar, { label: backLabel, onBack }),
        h('div', { className: 'sg-intro' }, h('h2', null, '后台任务'), h('p', null, summary)),
        h('div', { className: 'sg-process-summary' }, h('strong', null, '后台整理状态'), h('span', null, '已有记忆可继续查看；具体来源以实际可读取内容为准。')),
        detailsUnavailable ? h('div', { className: 'sg-process-notice', role: 'status' },
          h('strong', null, versionMismatch ? '前后端版本尚未同步' : '暂时无法读取完整任务详情'),
          h('span', null, versionMismatch
            ? '当前页面为 ' + STRATAGATE_CLIENT_VERSION + '，后台为 ' + serverVersion + '。请确认安装新包后完全退出并重新启动 DSH。'
            : '后台只返回了任务数量，没有返回会话和轮次。请完全退出并重新启动 DSH 后再检查。')) : null,
        groups.length ? h('div', { className: 'sg-process-groups' }, groups.map((group) => h('section', { key: group.key, className: 'sg-process-group' },
          h('header', { className: 'sg-process-group-head' }, h('h3', { className: 'sg-process-group-title' }, group.label), h('span', { className: 'sg-process-group-count' }, group.items.length + ' 个对话片段')),
          group.items.map((item) => {
            const state = itemState(item)
            const range = Array.isArray(item.turnRange) ? '第 ' + item.turnRange[0] + '–' + item.turnRange[1] + ' 轮' : item.title || '对话片段'
            const technicalJobs = item.jobs.filter((job) => !job.legacy)
            return h('article', { key: String(item.id || item.sourceId), className: 'sg-process-card' },
              h('div', { className: 'sg-process-card-head' }, h('span', { className: 'sg-process-range' }, range), h('span', { className: 'sg-process-state ' + state.kind }, h('span', { 'aria-hidden': 'true' }, state.mark), state.label)),
              h('div', { className: 'sg-process-stages' }, itemStages(item).map(([name, stage]) => h('div', { key: name, className: 'sg-process-stage' }, h('span', { className: 'sg-process-stage-state ' + stage.kind, 'aria-hidden': 'true' }, stage.mark), h('span', { className: 'sg-process-stage-name' }, name), h('span', { className: 'sg-process-stage-state ' + stage.kind }, stage.label)))),
              technicalJobs.length ? h('details', { className: 'sg-process-tech' }, h('summary', null, '查看技术详情'), technicalJobs.map((job) => {
                const key = retryKey(job)
                const failed = terminalFailedKeys.has(key)
                const busy = retrying === key
                return h('div', { key, className: 'sg-process-job' },
                  h('div', { className: 'sg-process-job-head' }, h('strong', null, taskLabel(job.kind)), h('span', { className: 'sg-stage-value ' + (terminalFailedKeys.has(key) ? 'failed' : job.status === 'running' || job.state === 'retryable' ? 'processing' : 'waiting') }, technicalStatusText(job.status, job))),
                  h('div', { className: 'sg-process-job-meta sg-code' }, '任务 ' + job.id + ' · 已尝试 ' + String(job.attempts ?? 0) + ' 次 · 更新于 ' + formatTime(job.updatedAt)),
                  job.nextRetryAt ? h('div', { className: 'sg-process-job-meta' }, '计划重试：' + formatTime(job.nextRetryAt)) : null,
                  failed && !job.nextRetryAt ? h('div', { className: 'sg-process-job-meta' }, '自动重试已停止') : null,
                  failed ? h('pre', { className: 'sg-job-error sg-code' }, job.lastErrorFull || job.lastError || '没有记录技术错误。') : null,
                  job.kind === 'topic-projection' && job.diagnostics ? h('pre', { className: 'sg-code' }, JSON.stringify(job.diagnostics, null, 2)) : null,
                  job.kind === 'topic-projection' && overview.topicDirectoryReadError ? h('p', { className: 'sg-muted' }, '暂时无法读取目录状态，请重新检查状态。') : null,
                  failed ? h('div', { className: 'sg-process-job-actions' }, h('span', { className: 'sg-status-feedback failed', role: retryErrors[key] ? 'alert' : undefined }, retryErrors[key] || ''), job.kind === 'topic-projection' ? h(TopicRetryButton, { failure: { jobId: job.id, eventCount: job.eventCount }, namespace, revision: overview.topicDirectoryRevision, onDirectoryChanged: () => refresh({ propagateError: true }) }) : h('button', { type: 'button', className: 'sg-save-button', disabled: Boolean(retrying), onClick: () => void retryJob(job) }, busy ? '正在处理…' : '重试此任务')) : null)
              })) : null
            )
          })
        ))) : detailsUnavailable
          ? h('div', { className: 'sg-process-unavailable' }, h('strong', null, '任务仍在整理，具体会话暂不可用'), h('span', null, '这不代表对话丢失；重启并加载同一版本后即可显示详情。'))
          : h(Empty, { title: hasProcessingDetails ? '当前没有待处理或失败的任务' : '暂时无法读取任务详情', copy: '目录与图谱的覆盖情况请以对应页面为准。' }),
        h('div', { className: 'sg-process-footer' }, h('button', { type: 'button', className: 'sg-quiet-button', disabled: refreshing, onClick: () => void checkStatus() }, refreshing ? '正在读取…' : '↻ 重新检查状态'), h('span', { className: 'sg-muted' }, '只读取最新状态，不会触发模型调用。'), feedback.text ? h('span', { className: 'sg-status-feedback ' + feedback.kind, role: feedback.kind === 'failed' ? 'alert' : 'status' }, feedback.text) : null)
      )
    }

    // These caches belong to this loaded browser page, never to durable storage.
    const profilePageMemory = new Map()
    const profileFieldDrafts = new Map()
    const importDrafts = new Map()
    const importRequests = new Map()
    function usePageMemoryState(cache, key, initial) {
      if (!cache.has(key)) cache.set(key, initial)
      const [value, setValue] = React.useState(cache.get(key))
      const update = (next) => {
        const resolved = typeof next === 'function' ? next(cache.get(key)) : next
        cache.set(key, resolved)
        setValue(resolved)
      }
      return [value, update]
    }

    function ImportPage({ namespace, onBack, refresh }) {
      const [draft, setDraft] = usePageMemoryState(importDrafts, namespace, { text: '' })
      const text = draft.text
      const setText = (value) => setDraft({ text: value })
      const [prompt, setPrompt] = React.useState('')
      const [promptLoading, setPromptLoading] = React.useState(true)
      const [copied, setCopied] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [job, setJob] = React.useState(null)
      const [choices, setChoices] = React.useState({})
      const [result, setResult] = React.useState(null)
      const [error, setError] = React.useState('')
      const [connectionError, setConnectionError] = React.useState('')
      const [restoring, setRestoring] = React.useState(true)
      const lifecycle = React.useRef(null)
      React.useEffect(() => {
        let active = true; let restoreTimer
        const controller = new AbortController()
        lifecycle.current = controller
        api('import', {}, { signal: controller.signal }).then((value) => { if (active) setPrompt(String(value.prompt || '')) }).catch((reason) => { if (active) setError(String(reason?.message || reason)) }).finally(() => { if (active) setPromptLoading(false) })
        // A close can precede the create/commit response. Wait for that original
        // request before consulting SQLite; never replay it while restoring text.
        const restore = async () => {
          await importRequests.get(namespace)?.catch(() => {})
          if (!active) return
          return api('import', { operation: 'status', namespace }, { signal: controller.signal })
          .then((value) => {
            if (!active) return
            setConnectionError('')
            setRestoring(false)
            if (value?.jobId && !['undone', 'abandoned'].includes(value.status)) {
              setJob(value)
              if (value.status === 'committed') { setResult(value); clearCommittedDraft(value) }
            }
          })
          .catch(() => {
            if (!active) return
            setConnectionError('连接暂时中断，正在自动重试…')
            restoreTimer = window.setTimeout(restore, 2500)
          })
        }
        void restore()
        const onKeyDown = (event) => { if (event.key === 'Escape') onBack() }
        window.addEventListener('keydown', onKeyDown)
        return () => { active = false; controller.abort(); lifecycle.current = null; window.clearTimeout(restoreTimer); window.removeEventListener('keydown', onKeyDown) }
      }, [])
      React.useEffect(() => {
        if (!job?.jobId || !['extracting', 'processing'].includes(job.status)) return undefined
        let active = true; let timer
        const controller = new AbortController()
        const poll = () => api('import', { operation: 'status', namespace, jobId: job.jobId }, { signal: controller.signal }).then((next) => {
          if (!active) return
          setConnectionError('')
          setJob(next)
          if (['extracting', 'processing'].includes(next.status)) timer = window.setTimeout(poll, 1200)
        }).catch(() => {
          if (!active) return
          setConnectionError('连接暂时中断，正在自动重试…')
          timer = window.setTimeout(poll, 2500)
        })
        timer = window.setTimeout(poll, 600)
        return () => { active = false; controller.abort(); window.clearTimeout(timer) }
      }, [job?.jobId, job?.status, namespace])
      const copyPrompt = () => {
        if (!prompt) return
        const copiedPromise = navigator.clipboard?.writeText
          ? navigator.clipboard.writeText(prompt)
          : Promise.reject(new Error('当前浏览器不支持自动复制'))
        void copiedPromise.then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1600) }).catch((reason) => setError(String(reason?.message || reason)))
      }
      const clearCommittedDraft = (next) => {
        const current = importDrafts.get(namespace)
        if (next.status === 'committed' && current?.jobId === next.jobId && current.text.trim() === next.text) setText('')
      }
      const mutate = (body, onResult, submission) => {
        if (importRequests.has(namespace)) return
        const controller = lifecycle.current
        const valid = () => controller && lifecycle.current === controller && !controller.signal.aborted
        setBusy(true); setError('')
        const request = api('import', { namespace }, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, namespace }),
        })
        importRequests.set(namespace, request)
        return request.then((next) => {
          // Associate only the actual submitted draft, even if its dialog closed.
          // Equal text pasted later is a new draft, not evidence of a saved write.
          if (submission && importDrafts.get(namespace) === submission && next?.jobId) submission.jobId = next.jobId
          if (valid()) return onResult(next)
        })
          .catch((reason) => { if (valid()) setError(String(reason?.message || reason)) })
          .finally(() => {
            if (importRequests.get(namespace) === request) importRequests.delete(namespace)
            if (valid()) setBusy(false)
          })
      }
      const analyze = () => {
        if (!text.trim() || busy || restoring || (job && job.status !== 'failed')) return
        setResult(null); setJob(null); setChoices({})
        return mutate({ operation: 'preview', text }, setJob, draft)
      }
      const commit = () => {
        if (!job || busy) return
        const requestedChoices = (job.decisions || []).flatMap((decision, index) => decision.requiresConfirmation
          ? [{ index, action: choices[index] || decision.action || 'IGNORE' }]
          : [])
        if (draft.text.trim() === job.text) draft.jobId = job.jobId
        return mutate({ operation: 'commit', jobId: job.jobId, choices: requestedChoices }, (next) => { clearCommittedDraft(next); setResult(next); setJob(next); return refresh() })
      }
      const retry = () => {
        if (!job?.jobId || busy) return
        return mutate({ operation: 'retry', jobId: job.jobId }, setJob)
      }
      const abandon = () => {
        if (!job?.jobId || busy) return
        return mutate({ operation: 'abandon', jobId: job.jobId }, () => { setJob(null); setText(''); setChoices({}) })
      }
      const undo = () => {
        if (!result?.sourceBlockId || busy) return
        return mutate({ operation: 'undo', sourceBlockId: result.sourceBlockId }, () => { setResult(null); setJob(null); return refresh() })
      }
      const reset = () => { setResult(null); setJob(null); setChoices({}); setError('') }
      const actionLabel = { ADD: '新增', MERGE: '合并', SUPERSEDE: '取代旧记忆', CONFLICT: '保留并标记冲突', IGNORE: '忽略' }
      const running = job && ['extracting', 'processing'].includes(job.status)
      const reviewable = job && ['ready', 'awaiting_confirmation'].includes(job.status)
      const emptyJob = reviewable && Number(job.totalCount || 0) === 0
      const percent = !job ? 0 : job.status === 'extracting' ? 5 : job.totalCount ? Math.round(job.processedCount / job.totalCount * 100) : 100
      return h('div', { className: 'sg-import-overlay', role: 'presentation', onMouseDown: (event) => { if (event.target === event.currentTarget) onBack() } },
        h('section', { className: 'sg-import-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'sg-import-title' },
          h('header', { className: 'sg-import-dialog-head' }, h('h2', { id: 'sg-import-title', className: 'sg-import-dialog-title' }, '将记忆导入 StrataGate'), h('button', { type: 'button', className: 'sg-icon-button', onClick: onBack, 'aria-label': '关闭' }, '×')),
          h('div', { className: 'sg-import-step' },
            h('div', { className: 'sg-import-step-head' }, h('span', { className: 'sg-import-step-num' }, '1'), h('span', { className: 'sg-import-step-title' }, '复制以下提示词到其他 AI 对话中'), h('button', { type: 'button', className: 'sg-import-copy', disabled: promptLoading || !prompt, onClick: copyPrompt }, copied ? '已复制' : '复制')),
            promptLoading ? h('div', { className: 'sg-import-loading' }, '正在加载提示词…') : h('div', { className: 'sg-import-prompt', tabIndex: '0' }, prompt || '提示词暂时无法读取。')),
          h('div', { className: 'sg-import-step' },
            h('div', { className: 'sg-import-step-head' }, h('span', { className: 'sg-import-step-num' }, '2'), h('span', { className: 'sg-import-step-title' }, '粘贴结果，先分析再导入')),
            h('div', { className: 'sg-import-card' }, h('textarea', { value: text, disabled: restoring || busy || Boolean(result) || (Boolean(job) && job.status !== 'failed'), onChange: (event) => setText(event.target.value), placeholder: '粘贴 JSON；格式不合格时会自动尝试恢复', 'aria-label': '外部 AI 记忆 JSON' })),
            !job && !result ? h('div', { className: 'sg-import-hint' }, restoring ? '正在检查已有导入任务…' : '关闭后可继续编辑；草稿仅在当前浏览器页面保留，刷新后清空。') : null),
          running ? h('div', { className: 'sg-import-step' },
            h('div', { className: 'sg-import-step-head' }, h('span', { className: 'sg-import-step-num' }, '3'), h('span', { className: 'sg-import-step-title' }, job.status === 'extracting' ? '正在修复并提取候选记忆' : '正在检测重复与冲突')),
            h('div', { role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': percent, style: { height: '9px', overflow: 'hidden', borderRadius: '999px', background: 'var(--sg-border)' } }, h('div', { style: { width: percent + '%', height: '100%', background: 'var(--sg-accent)', transition: 'width .25s ease' } })),
            h('div', { className: 'sg-import-hint', style: { marginTop: '8px' } }, job.status === 'extracting' ? '原 JSON 不合格，正在使用模型兜底。可以关闭页面，任务会继续。' : '已完成 ' + job.processedCount + '/' + job.totalCount + '，正在判断第 ' + Math.min(job.processedCount + 1, job.totalCount) + ' 条；可以关闭页面，稍后重新打开查看。')) : null,
          reviewable ? h('div', { className: 'sg-import-step' },
            h('div', { className: 'sg-import-step-head' }, h('span', { className: 'sg-import-step-num' }, '3'), h('span', { className: 'sg-import-step-title' }, '导入预览')),
            h('div', { className: 'sg-import-hint' }, emptyJob ? '没有发现可导入的长期记忆。' : job.recoveredFromInvalidJson ? '这些候选由兜底模型恢复，全部需要人工确认。' : '高置信度结果自动采用；低置信度结果请人工选择处理方式。'),
            h('div', { className: 'sg-import-preview' }, (job.decisions || []).map((decision, index) => h('div', { key: index, className: 'sg-import-preview-item' },
              h('div', { className: 'sg-import-preview-title' }, decision.candidate?.title || '未命名记忆'),
              h('div', { className: 'sg-import-preview-content' }, h('strong', null, '新记忆：'), h('span', null, decision.candidate?.summary || '无内容'), decision.candidate?.narrative ? h('div', null, decision.candidate.narrative) : null),
              decision.mergedCandidate ? h('div', { className: 'sg-import-preview-content' }, h('strong', null, '合并后：'), h('span', null, decision.mergedCandidate.title + '：' + decision.mergedCandidate.summary)) : null,
              decision.existingEventIds?.length && decision.matches?.length ? h('div', { className: 'sg-import-preview-content' }, h('strong', null, '受影响的旧记忆：'), decision.matches.filter((match) => decision.existingEventIds.includes(match.event.id)).map((match) => h('div', { key: match.event.id }, match.event.title + '：' + match.event.summary))) : null,
              h('div', { className: 'sg-import-preview-meta' }, h('span', null, actionLabel[decision.action] || decision.action), h('span', null, '置信度 ' + Math.round(Number(decision.confidence || 0) * 100) + '%'), decision.existingEventIds?.length ? h('span', null, '关联 ' + decision.existingEventIds.length + ' 条') : null),
              decision.reason ? h('div', { className: 'sg-import-preview-reason' }, decision.reason) : null,
              decision.requiresConfirmation ? h('label', { className: 'sg-import-review' }, h('span', null, '人工选择'), h('select', { value: choices[index] || decision.action, onChange: (event) => setChoices((current) => ({ ...current, [index]: event.target.value })) },
                (decision.existingEventIds?.length ? ['ADD', 'MERGE', 'SUPERSEDE', 'CONFLICT', 'IGNORE'] : ['ADD', 'IGNORE']).map((action) => h('option', { key: action, value: action }, actionLabel[action])))) : null,
            )))) : null,
          job?.status === 'failed' ? h('div', { className: 'sg-import-error' }, '任务失败：' + (job.lastError || '未知错误')) : null,
          connectionError ? h('div', { className: 'sg-import-hint' }, connectionError) : null,
          error ? h('div', { className: 'sg-import-error' }, error) : null,
          result ? h('div', { className: 'sg-import-result' }, '导入完成：新增 ' + Number(result.importedCount || 0) + ' 条记忆。可立即撤销本批次。') : null,
          h('footer', { className: 'sg-import-dialog-foot' },
            result ? h('button', { type: 'button', className: 'sg-import-cancel', disabled: busy, onClick: undo }, busy ? '正在撤销…' : '撤销本次导入') : h('button', { type: 'button', className: 'sg-import-cancel', onClick: onBack }, running ? '关闭，后台继续' : '关闭'),
            !job && !result && text ? h('button', { type: 'button', className: 'sg-import-cancel', disabled: restoring || busy, onClick: () => { setText(''); setError('') } }, '放弃草稿') : null,
            result ? h('button', { type: 'button', className: 'sg-import-button', disabled: busy, onClick: reset }, '导入另一批')
              : job?.status === 'failed' ? h(React.Fragment, null, h('button', { type: 'button', className: 'sg-import-cancel', disabled: busy, onClick: () => { setJob(null); setChoices({}); setError('') } }, '修改后重新分析'), h('button', { type: 'button', className: 'sg-import-cancel', disabled: busy, onClick: abandon }, '放弃本次导入'), h('button', { type: 'button', className: 'sg-import-button', disabled: busy, onClick: retry }, busy ? '正在重试…' : '重试') )
                : emptyJob ? h('button', { type: 'button', className: 'sg-import-button', onClick: reset }, '导入另一批')
                  : reviewable ? h('button', { type: 'button', className: 'sg-import-button', disabled: busy, onClick: commit }, busy ? '正在导入…' : '确认导入')
                    : running ? h('button', { type: 'button', className: 'sg-import-button', disabled: true }, '后台处理中')
                      : h('button', { type: 'button', className: 'sg-import-button', disabled: restoring || busy || !text.trim(), onClick: analyze }, busy ? '正在创建任务…' : '分析并预览'))))
    }

    // A − value + stepper shared by the More page rows. Buttons disable at the
    // real bounds so a click can never send an out-of-range value.
    function SettingStepper({ value, unit = '', min = 1, max = 30, step = 1, disabled = false, label, onChange }) {
      const current = Number(value)
      const bump = (direction) => {
        if (!Number.isFinite(current) || disabled) return
        const next = Math.min(max, Math.max(min, Number((current + direction * step).toFixed(2))))
        if (next !== current) onChange(next)
      }
      return h('span', { className: 'sg-stp', role: 'group', 'aria-label': label },
        h('button', { type: 'button', 'aria-label': '减少' + label, disabled: disabled || !Number.isFinite(current) || current <= min, onClick: () => bump(-1) }, '\u2212'),
        h('span', { 'aria-live': 'polite', className: 'sg-stp-value' }, (Number.isFinite(current) ? String(current) : '') + unit),
        h('button', { type: 'button', 'aria-label': '增加' + label, disabled: disabled || !Number.isFinite(current) || current >= max, onClick: () => bump(1) }, '+'))
    }

    function MoreHome({ setView, selected, overview = {}, namespace, dataDirectory, updateSettings, savingSettings, usePluginSettings, setStrataGateStatus, setShortTermStatus, setRetrievalStatus, setSidebarEntry, setDailyEnabled, setDailyInjectionDays }) {
      const pluginSettings = usePluginSettings ? usePluginSettings((state) => state) : null
      const settingsWritable = pluginSettings?.writable === true
      const [pending, setPending] = React.useState({})
      const [settingError, setSettingError] = React.useState({ key: '', text: '' })
      const [savingKey, setSavingKey] = React.useState('')
      const [copyState, setCopyState] = React.useState('')
      React.useEffect(() => {
        setPending({ blockTurnSize: String(selected?.blockTurnSize ?? 6), blockDecayLambda: String(selected?.blockDecayLambda ?? 0.3), agentMemoryRetrievalWeight: String(selected?.agentMemoryRetrievalWeight ?? 1) })
      }, [selected?.blockTurnSize, selected?.blockDecayLambda, selected?.agentMemoryRetrievalWeight])
      const engine = [
        ['blockTurnSize', '每块轮数', '', 1, 30, 1],
        ['blockDecayLambda', '衰减系数', '', 0, 0.4, 0.05],
        ['agentMemoryRetrievalWeight', '主动检索占比', '', 0, 5, 0.05],
      ]
      const saved = (key) => Number(selected?.[key] ?? (key === 'blockTurnSize' ? 6 : key === 'blockDecayLambda' ? 0.3 : 1))
      const changedKeys = engine.map(([key]) => key).filter((key) => pending[key] !== undefined && Number(pending[key]) !== saved(key) && pending[key] !== '')
      const validEngine = engine.every(([key]) => { const raw = pending[key]; return raw !== undefined && raw !== '' && Number.isFinite(Number(raw)) })
      const saveEngine = async () => {
        if (!changedKeys.length || !validEngine || savingSettings) return
        setSettingError({ key: '', text: '' })
        try { await updateSettings({ blockTurnSize: Number(pending.blockTurnSize), blockDecayLambda: Number(pending.blockDecayLambda), agentMemoryRetrievalWeight: Number(pending.agentMemoryRetrievalWeight) }) }
        catch (reason) { setSettingError({ key: 'engine', text: '未能保存引擎参数：' + String(reason?.message || reason) }) }
      }
      const discardEngine = () => setPending({ blockTurnSize: String(saved('blockTurnSize')), blockDecayLambda: String(saved('blockDecayLambda')), agentMemoryRetrievalWeight: String(saved('agentMemoryRetrievalWeight')) })
      // Every switch writes its own setting immediately; a failure is reported on
      // the row that caused it instead of a page-level banner.
      const toggle = async (key, setter, next) => {
        if (!setter) return
        setSavingKey(key); setSettingError({ key: '', text: '' })
        try { if (!await setter(next)) setSettingError({ key, text: '未能保存这项设置，请重试。' }) }
        catch (reason) { setSettingError({ key, text: '保存失败：' + String(reason?.message || reason) }) }
        finally { setSavingKey('') }
      }
      const stepDays = async (next) => {
        if (!setDailyInjectionDays) return
        setSavingKey('dailyDays'); setSettingError({ key: '', text: '' })
        try { if (!await setDailyInjectionDays(next)) setSettingError({ key: 'dailyDays', text: '天数未保存，请重试。' }) }
        catch (reason) { setSettingError({ key: 'dailyDays', text: '天数保存失败：' + String(reason?.message || reason) }) }
        finally { setSavingKey('') }
      }
      const copyWorkspace = async () => {
        if (!navigator?.clipboard?.writeText) return
        try { await navigator.clipboard.writeText(namespace || ''); setCopyState('已复制'); setSettingError({ key: '', text: '' }) }
        catch { setSettingError({ key: 'workspace', text: '复制工作区 ID 失败，请手动复制。' }) }
      }
      // Failure and its retry stay beside the control that failed; no global
      // red banner, and no hidden reload of the host page.
      const retry = async (key, apply) => {
        setSettingError({ key: '', text: '' })
        try { if (!await apply()) setSettingError({ key, text: '仍然无法保存，请稍后重试。' }) }
        catch (reason) { setSettingError({ key, text: '仍然无法保存：' + String(reason?.message || reason) }) }
      }
      const rowError = (key, apply) => settingError.key === key ? h('p', { className: 'sg-more-error', role: 'alert' }, settingError.text, apply ? h('button', { type: 'button', className: 'sg-more-retry', onClick: () => void retry(key, apply) }, '重试') : null) : null
      const switchRow = ({ key, title, description, checked, setter, disabled = false, child = false }) => h('li', { key, className: 'sg-more-row sg-more-switch' + (child ? ' child' : '') },
        h('div', null, h('span', { className: 'sg-k2' }, title), description ? h('span', { className: 'sg-s2' }, description) : null, rowError(key, () => setter(!checked))),
        h('button', { type: 'button', className: 'sg-setting-switch', role: 'switch', 'aria-label': title, 'aria-checked': checked, disabled: disabled || !settingsWritable || savingKey === key, onClick: () => void toggle(key, setter, !checked) }))
      const goRow = (key, title, description, view) => h('li', { key, className: 'sg-more-row' },
        h('button', { type: 'button', className: 'sg-more-go', onClick: () => setView({ name: view }) },
          h('div', null, h('span', { className: 'sg-k2' }, title), description ? h('span', { className: 'sg-s2' }, description) : null),
          h('span', { className: 'sg-row-go', 'aria-hidden': 'true' }, '\u203a')))
      const group = (title, rows, extra = '') => h('section', { key: title, className: 'sg-profile-group', 'aria-label': title }, h('h4', null, title), h('ul', null, rows, extra))
      const duplicates = Number(selected?.duplicateRepair?.needsReview || 0)
      const failed = Number(selected?.failedJobs || 0)
      const processing = Number(selected?.processingJobs || 0)
      const statusRows = [
        h('li', { key: 'kpi', className: 'sg-more-kpi' }, h('div', null,
          ['blocks', 'events', 'graphNodes'].map((key, index) => h('div', { key }, h('b', null, String(Number(selected?.[key] || 0))), h('span', null, ['记忆块', '事件', '图谱节点'][index]))))),
        goRow('system', '系统状态', failed ? failed + ' 个任务需要重试' : processing ? processing + ' 个任务进行中' : '运行正常', 'system'),
        goRow('duplicates', '重复记忆', duplicates ? duplicates + ' 组等你确认' : '没有需要确认的分组', 'duplicates'),
      ]
      const dataRows = [
        goRow('import', '导入其他 AI 的记忆', '把别的 AI 的历史记忆带进来', 'import'),
        h('li', { key: 'directory', className: 'sg-more-row sg-more-row-path' }, h('div', { className: 'sg-more-path' }, h('span', { className: 'sg-k2' }, '数据目录'), h('span', { className: 'sg-s2 sg-mono sg-path', title: dataDirectory || undefined }, dataDirectory || '当前使用内存存储')),
        h('button', { type: 'button', className: 'sg-quiet-button', disabled: !dataDirectory, onClick: () => void api('storage/open-directory', {}, { method: 'POST' }).catch((reason) => setSettingError({ key: 'directory', text: '打开失败：' + String(reason?.message || reason) })) }, '打开')),
        h('li', { key: 'workspace', className: 'sg-more-row' }, h('div', null, h('span', { className: 'sg-k2' }, '当前工作区'), h('span', { className: 'sg-s2 sg-mono' }, selected?.workspaceName || '当前工作区')),
          h('button', { type: 'button', className: 'sg-quiet-button', disabled: !namespace, onClick: copyWorkspace }, copyState || '复制 ID')),
      ]
      const feedbackRows = [
        h('li', { key: 'issue', className: 'sg-more-row' }, h('div', null, h('span', { className: 'sg-k2' }, 'GitHub Issue'), h('span', { className: 'sg-s2' }, '问题和建议提到 GitHub')),
          h('a', { className: 'sg-quiet-button', href: ISSUE_URL, target: '_blank', rel: 'noopener noreferrer' }, '提 Issue')),
        goRow('support', '生成反馈报告', '发出前可以先看完整内容', 'support'),
      ]
      const displayRows = [
        switchRow({ key: 'sidebar', title: '放到左侧栏', checked: pluginSettings?.value?.showSidebarEntry === true, setter: setSidebarEntry }),
        switchRow({ key: 'shortStatus', title: '会话记忆状态', checked: pluginSettings?.value?.showShortTermStatus !== false, setter: setShortTermStatus }),
        switchRow({ key: 'retrievalStatus', title: '记忆检索状态', checked: pluginSettings?.value?.showRetrievalStatus !== false, setter: setRetrievalStatus }),
        // Only visible when the global gate was switched off earlier, so the user
        // can always restore the three switches above.
        pluginSettings?.value?.showStrataGateStatus === false
          ? switchRow({ key: 'master', title: '恢复状态提示', description: '之前整体关闭了聊天界面的状态提示', checked: false, setter: setStrataGateStatus })
          : null,
      ].filter(Boolean)
      const dailyRows = [
        switchRow({ key: 'daily', title: '写每日笔记', description: '关闭后不再写入，已有笔记保留', checked: pluginSettings?.value?.dailyNotesEnabled !== false, setter: setDailyEnabled }),
        h('li', { key: 'days', className: 'sg-more-row' }, h('div', null, h('span', { className: 'sg-k2' }, '带入天数'), h('span', { className: 'sg-s2' }, '取最近有笔记的日期')),
          SettingStepper({ value: pluginSettings?.value?.dailyNotesInjectionDays ?? 3, unit: ' 天', min: 1, max: 30, disabled: !settingsWritable || savingKey === 'dailyDays', label: '带入新会话的天数', onChange: (next) => void stepDays(next) })),
      ]
      const engineRows = engine.map(([key, title, unit, min, max, step]) => {
        const dirty = changedKeys.includes(key)
        return h('li', { key, className: 'sg-more-row' }, h('div', null, h('span', { className: 'sg-k2' + (dirty ? ' dirty' : '') }, title)),
          h('span', { className: 'sg-engine-value' + (dirty ? ' dirty' : '') }, SettingStepper({ value: pending[key] ?? saved(key), unit, min, max, step, disabled: savingSettings, label: title, onChange: (next) => setPending((current) => ({ ...current, [key]: String(next) })) })))
      })
      return h(React.Fragment, null,
        h('div', { className: 'sg-pg-head' }, h('h2', null, '更多')),
        h('div', { className: 'sg-more' },
          h('div', { className: 'sg-more-col' },
            group('运行状态', statusRows),
            group('数据', dataRows),
            group('反馈', feedbackRows)),
          h('div', { className: 'sg-more-col' },
            group('显示', displayRows),
            group('短期记忆', dailyRows),
            group('引擎参数', engineRows, h(React.Fragment, null,
              rowError('engine', () => updateSettings({ blockTurnSize: Number(pending.blockTurnSize), blockDecayLambda: Number(pending.blockDecayLambda), agentMemoryRetrievalWeight: Number(pending.agentMemoryRetrievalWeight) })),
              changedKeys.length ? h('li', { className: 'sg-dirty' },
                h('span', null, changedKeys.length + ' 项未保存'),
                h('button', { type: 'button', className: 'sg-quiet-button', disabled: savingSettings, onClick: discardEngine }, '放弃'),
                h('button', { type: 'button', className: 'sg-save-button', disabled: savingSettings || !validEngine, onClick: () => void saveEngine() }, savingSettings ? '保存中…' : '保存')) : null)))))
    }

    function DisplayPage({ onBack, usePluginSettings, setStrataGateStatus, setShortTermStatus, setRetrievalStatus, setSidebarEntry }) {
      const pluginSettings = usePluginSettings ? usePluginSettings((state) => state) : null
      const settingsWritable = pluginSettings?.writable === true
      const [sidebarSaving, setSidebarSaving] = React.useState(false)
      const [sidebarError, setSidebarError] = React.useState('')
      const changeSidebar = async (visible) => {
        setSidebarSaving(true); setSidebarError('')
        try { if (!await setSidebarEntry?.(visible)) setSidebarError('未能保存侧栏设置，请重试。') }
        catch { setSidebarError('未能保存侧栏设置，请检查连接后重试。') }
        finally { setSidebarSaving(false) }
      }
      const showStrataGateStatus = strataGateStatusVisible(pluginSettings)
      const showShortTermStatus = pluginSettings?.value?.showShortTermStatus !== false
      const showRetrievalStatus = pluginSettings?.value?.showRetrievalStatus !== false
      const setting = ({ title, description, checked, disabled = false, onChange, child = false }) => h('div', { className: 'sg-display-setting ' + (child ? 'child ' : '') + (disabled ? 'sg-display-disabled' : '') },
        h('span', { className: 'sg-display-setting-copy' }, h('span', { className: 'sg-display-setting-title' }, title), h('span', { className: 'sg-display-setting-description' }, description)),
        h('button', { type: 'button', className: 'sg-setting-switch', role: 'switch', 'aria-checked': checked, 'aria-label': title, disabled: !settingsWritable || disabled, onClick: () => { if (onChange) void onChange(!checked) } }))
      return h(React.Fragment, null,
        h(BackBar, { label: '更多', onBack }),
        h('div', { className: 'sg-pg-head' }, h('h2', null, '界面与显示')),
        h('p', { className: 'sg-settings-group-copy' }, '控制侧栏入口和聊天界面中的显示信息。设置对所有工作区生效。'),
        h('div', { className: 'sg-settings-panel sg-display-settings' },
          setting({ title: '在左侧栏显示 StrataGate', description: '关闭后隐藏侧栏入口，仍可从设置打开；记忆、检索和后台处理不受影响。', checked: pluginSettings?.value?.showSidebarEntry === true, disabled: sidebarSaving || !setSidebarEntry, onChange: changeSidebar }),
          sidebarError ? h('p', { role: 'alert', className: 'sg-error-note' }, sidebarError) : null,
          setting({ title: '显示 StrataGate 状态提示', description: '关闭后隐藏聊天界面中的 StrataGate 状态信息，不影响记忆、检索和后台处理。', checked: showStrataGateStatus, onChange: setStrataGateStatus }),
          setting({ title: '会话记忆状态', description: '显示 Block 进度、封存结果和正在整理会话记忆等状态。', checked: showShortTermStatus, disabled: !showStrataGateStatus, onChange: setShortTermStatus, child: true }),
          setting({ title: '记忆检索状态', description: '显示检索次数、返回数量，以及回答下方的记忆采用信息。', checked: showRetrievalStatus, disabled: !showStrataGateStatus, onChange: setRetrievalStatus, child: true })))
    }

    function redactText(value) {
      return String(value ?? '')
        .split(/\nRaw response(?: preview| \(full\))/i)[0]
        .replace(/\b(?:sk[-_]|gh[opasu]_|github_pat_)[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
        .replace(/(["']?\b(?:api[_-]?key|token|password|passwd|access[_-]?token|refresh[_-]?token|secret|authorization)["']?\s*[:=]\s*)(["'])([\s\S]*?)\2/gi, '$1$2[REDACTED]$2')
        .replace(/(\bauthorization\s*[:=]\s*)(Bearer|Basic|Token)\s+[^\s,;}]+/gi, '$1$2 [REDACTED]')
        .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{8,}={0,2}\b/gi, 'Bearer [REDACTED]')
        .replace(/\b(?:Basic|Token)\s+[^\s,;}]+/gi, (match) => match.replace(/\s+[^\s,;}]+$/, ' [REDACTED]'))
        .replace(/(["']?\b(?:api[_-]?key|token|password|passwd|access[_-]?token|refresh[_-]?token|secret|authorization)["']?\s*[:=]\s*)([^\s,;}]+)/gi, '$1[REDACTED]')
        .replace(/https?:\/\/[^\s<>"']+/gi, '[url]')
        .replace(/[A-Z]:[\\/][^\s"'<>]+/gi, '[path]')
        .replace(/\\\\[^\s"'<>\\]+\\[^\s"'<>]+/g, '[path]')
        .replace(/(^|[\s"'(=:])\/(?:[^\s"'<>/]+\/)+[^\s"'<>]*/g, '$1[path]')
        .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '[email]')
    }

    function redactedJson(value) {
      const sensitive = /^(password|passwd|token|access[_-]?token|refresh[_-]?token|api[_-]?key|secret|authorization)$/i
      const visit = (current, key = '') => {
        if (sensitive.test(String(key))) return '[REDACTED]'
        if (typeof current === 'string') return redactText(current)
        if (Array.isArray(current)) return current.map((item) => visit(item))
        if (current && typeof current === 'object') return Object.fromEntries(Object.entries(current).map(([name, item]) => [name, visit(item, name)]))
        return current
      }
      return JSON.stringify(visit(value), null, 2) ?? 'null'
    }

    function restoreFeedbackDraftValues(draft, touched = {}) {
      return {
        title: touched.title ? undefined : String(draft?.title || ''),
        problemContent: touched.body ? undefined : feedbackDraftMarkdown(draft),
      }
    }

    function whitelistedMessage(message) {
      return {
        id: message?.id,
        role: message?.role,
        content: message?.content,
        createdAt: message?.createdAt,
        threadId: message?.threadId,
        toolCalls: Array.isArray(message?.toolCalls) ? message.toolCalls.map((call) => ({
          name: call?.name,
          arguments: call?.arguments,
          result: call?.result,
        })) : undefined,
      }
    }

    function whitelistedEvent(event) {
      const temporal = event?.temporal
      const weight = event?.weight
      return {
        id: event?.id,
        formedTurn: event?.formedTurn,
        title: event?.title,
        summary: event?.summary,
        tags: event?.tags,
        quotes: event?.quotes,
        sourceBlockId: event?.sourceBlockId,
        sourceMessageIds: event?.sourceMessageIds,
        temporal: temporal ? {
          mentionedAt: temporal.mentionedAt,
          happenedStart: temporal.happenedStart,
          happenedEnd: temporal.happenedEnd,
          originalText: temporal.originalText,
          precision: temporal.precision,
          basis: temporal.basis,
          status: temporal.status,
          participants: temporal.participants,
          participantNodeIds: temporal.participantNodeIds,
          eventType: temporal.eventType,
          threadId: temporal.threadId,
          sameEventId: temporal.sameEventId,
          beforeEventIds: temporal.beforeEventIds,
          afterEventIds: temporal.afterEventIds,
          supersedesEventIds: temporal.supersedesEventIds,
          conflictsWithEventIds: temporal.conflictsWithEventIds,
          relatedEventIds: temporal.relatedEventIds,
        } : undefined,
        scope: event?.scope,
        criticality: event?.criticality,
        status: event?.status,
        supersededBy: event?.supersededBy,
        weight: weight ? {
          mentionCount: weight.mentionCount,
          lastAdoptedTurn: weight.lastAdoptedTurn,
          lastRetrievedAt: weight.lastRetrievedAt,
          pinned: weight.pinned,
          floorWeight: weight.floorWeight,
          forcedCap: weight.forcedCap,
        } : undefined,
        createdAt: event?.createdAt,
        updatedAt: event?.updatedAt,
      }
    }

    function whitelistedBlock(block) {
      const source = block?.source || block || {}
      const messages = block?.messages || block?.l5Raw || source?.l5Raw
      return {
        id: block?.id ?? source?.id,
        threadId: block?.threadId ?? source?.threadId,
        sequence: block?.sequence ?? source?.sequence,
        blockIndex: block?.blockIndex,
        turnRange: block?.turnRange || (source?.startTurn !== undefined && source?.endTurn !== undefined ? [source.startTurn, source.endTurn] : undefined),
        title: block?.title ?? source?.l0Title,
        tags: block?.tags ?? source?.l0Tags,
        summary: block?.summary ?? source?.l1Summary,
        keypoints: block?.keypoints ?? source?.l2Keypoints,
        condensed: source?.l3Condensed,
        readable: source?.l4Readable,
        messages: Array.isArray(messages) ? messages.map(whitelistedMessage) : undefined,
        layers: Array.isArray(block?.layers) ? block.layers.map((layer) => ({ level: layer?.level, content: layer?.content, tokens: layer?.tokens, percentOfL5: layer?.percentOfL5 })) : undefined,
        currentLevel: block?.currentLevel ?? source?.pointerCurrentLevel,
        currentTokens: block?.currentTokens,
        l5Tokens: block?.l5Tokens,
        compressionPercent: block?.compressionPercent,
        layerTokens: block?.layerTokens,
        distanceFromLatest: block?.distanceFromLatest,
        expansionSource: block?.expansionSource,
        lastLiftedAt: block?.lastLiftedAt ?? source?.lastLiftedAt,
        sourceMessages: block?.sourceMessages,
        createdAt: block?.createdAt ?? source?.createdAt,
        virtual: block?.virtual,
        processingStatus: block?.processingStatus ?? source?.processingStatus,
        summaryJob: block?.summaryJob ? { status: block.summaryJob.status, attempts: block.summaryJob.attempts, nextRetryAt: block.summaryJob.nextRetryAt, updatedAt: block.summaryJob.updatedAt } : undefined,
        eventExtraction: block?.eventExtraction ? { status: block.eventExtraction.status, attempts: block.eventExtraction.attempts, updatedAt: block.eventExtraction.updatedAt, lastError: block.eventExtraction.lastError } : undefined,
        graphProjection: block?.graphProjection ? { status: block.graphProjection.status, jobs: block.graphProjection.jobs, lastError: block.graphProjection.lastError } : undefined,
        relatedEvents: Array.isArray(block?.relatedEvents) ? block.relatedEvents.map(whitelistedEvent) : undefined,
        relatedNodes: Array.isArray(block?.relatedNodes) ? block.relatedNodes.map((node) => ({ id: node?.id, name: node?.name, type: node?.type })) : undefined,
      }
    }

    function whitelistedGraphNode(node) {
      return {
        id: node?.id,
        name: node?.name,
        type: node?.type,
        aliases: node?.aliases,
        tags: node?.tags,
        currentState: node?.currentState,
        facts: Array.isArray(node?.facts) ? node.facts.map((fact) => ({
          id: fact?.id,
          key: fact?.key,
          value: fact?.value,
          status: fact?.status,
          validFrom: fact?.validFrom,
          validTo: fact?.validTo,
          confidence: fact?.confidence,
          sourceEventIds: fact?.sourceEventIds,
          createdAt: fact?.createdAt,
          updatedAt: fact?.updatedAt,
        })) : undefined,
        status: node?.status,
        confidence: node?.confidence,
        sourceEventIds: node?.sourceEventIds,
        supportingEvents: Array.isArray(node?.supportingEvents) ? node.supportingEvents.map(whitelistedEvent) : undefined,
        createdAt: node?.createdAt,
        updatedAt: node?.updatedAt,
      }
    }

    function whitelistedGraph(graph) {
      return {
        projectorVersion: graph?.projectorVersion,
        nodes: Array.isArray(graph?.nodes) ? graph.nodes.map(whitelistedGraphNode) : [],
        edges: Array.isArray(graph?.edges) ? graph.edges.map((edge) => ({
          id: edge?.id,
          fromNodeId: edge?.fromNodeId,
          toNodeId: edge?.toNodeId,
          relation: edge?.relation,
          status: edge?.status,
          validFrom: edge?.validFrom,
          validTo: edge?.validTo,
          confidence: edge?.confidence,
          sourceEventIds: edge?.sourceEventIds,
          createdAt: edge?.createdAt,
          updatedAt: edge?.updatedAt,
        })) : [],
        clusters: Array.isArray(graph?.clusters) ? graph.clusters.map((cluster) => ({ id: cluster?.id, label: cluster?.label, nodeIds: cluster?.nodeIds, tags: cluster?.tags })) : [],
        migration: graph?.migration ? {
          projected: graph.migration.projected,
          total: graph.migration.total,
          pending: graph.migration.pending,
          running: graph.migration.running,
          failed: graph.migration.failed,
          retryable: graph.migration.retryable,
          processing: graph.migration.processing,
          state: graph.migration.state,
          complete: graph.migration.complete,
        } : null,
      }
    }

    function feedbackDraftMarkdown(draft = {}) {
      if (String(draft.bodyMarkdown || '').trim()) return String(draft.bodyMarkdown).trim()
      const lines = []
      const section = (heading, value) => {
        const text = String(value || '').trim()
        if (text) lines.push('## ' + heading, '', text, '')
      }
      section('问题描述', draft.description)
      const steps = Array.isArray(draft.reproduction) ? draft.reproduction.map((value) => String(value || '').trim()).filter(Boolean) : []
      if (steps.length) lines.push('## 复现步骤', '', ...steps.map((value, index) => (index + 1) + '. ' + value), '')
      section('预期行为', draft.expected)
      section('实际行为', draft.actual)
      section('相关错误信息', draft.errorContext)
      return lines.join('\n').trim()
    }

    function issueUrl(title = '') {
      const value = String(title || '').trim()
      const params = new URLSearchParams()
      if (value) params.set('title', value)
      params.set('body', ISSUE_BODY_HINT)
      return ISSUE_URL + '?' + params.toString()
    }

    function feedbackEmailUrl(title = '') {
      // Legacy drafts can contain lone surrogates. Keep encoding total even
      // before the server repairs them, and cap the user-controlled subject.
      const value = String(title || '').replace(/[\uD800-\uDFFF]/gu, '\uFFFD')
        .replace(/[\u0000-\u001F\u007F-\u009F]+/g, ' ').trim()
        .slice(0, 240).replace(/[\uD800-\uDBFF]$/, '')
      const subject = 'StrataGate 反馈' + (value ? '：' + value : '')
      return 'mailto:' + FEEDBACK_EMAIL + '?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(EMAIL_BODY_HINT)
    }

    // Request the mail application synchronously within the click gesture.
    // Report data stays on the clipboard; mailto contains only a paste hint.
    async function copyReportAndComposeEmail(report, clipboard = navigator?.clipboard, compose = (url) => { window.location.href = url }, title = '') {
      let copyPromise = null
      let copyError = ''
      if (!clipboard?.writeText) copyError = '当前浏览器不支持自动复制。'
      else {
        try { copyPromise = Promise.resolve(clipboard.writeText(report)) }
        catch (reason) { copyError = '复制失败：' + String(reason?.message || reason) }
      }
      let composeRequested = false
      try { compose(feedbackEmailUrl(title)); composeRequested = true } catch {}
      if (copyError) return { copied: false, composeRequested, error: copyError }
      try {
        await copyPromise
        return { copied: true, composeRequested, error: '' }
      } catch (reason) {
        return { copied: false, composeRequested, error: '复制失败：' + String(reason?.message || reason) }
      }
    }

    function handleFeedbackEmailResult(result, callbacks = {}) {
      if (result?.copied) {
        callbacks.setStatus?.(result.composeRequested
          ? '报告已复制。请在邮件撰写窗口中粘贴、检查并发送；若未打开，请复制下方邮箱自行发送。'
          : '报告已复制。请点击下方邮件链接，或复制邮箱自行发送。')
      } else {
        callbacks.setPreviewOpen?.(true)
        const message = (result?.error || '复制报告失败。') + ' 报告仍保留在预览中，可手动复制或下载后发送至 ' + FEEDBACK_EMAIL + '。'
        callbacks.setError?.((current) => current ? current + ' ' + message : message)
      }
      return result
    }

    // The star count is baked in at build time by scripts/fetch-github-stars.mjs;
    // the page makes no GitHub API request. The build script keeps the previous
    // value when the fetch fails, so the number is static, never invented at runtime.
    const GITHUB_STARS_FALLBACK = 128
    const GITHUB_STARS = (() => {
      const value = Number(globalThis.__STRATAGATE_GITHUB_STARS__)
      return Number.isSafeInteger(value) && value >= 0 ? value : GITHUB_STARS_FALLBACK
    })()

    function formatStarCount(value) {
      return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value).toLocaleString('en-US') : ''
    }

    function loadStarCount() {
      return Promise.resolve(formatStarCount(GITHUB_STARS))
    }

    function GitHubMarkIcon() {
      return h('svg', { className: 'sg-ghstar-icon', viewBox: '0 0 16 16', fill: 'currentColor', 'aria-hidden': 'true', focusable: 'false' },
        h('path', { d: 'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z' }))
    }

    // Inline brand mark: three offset memory sheets. It lives in the JS bundle,
    // so the desktop app cannot lose the header icon to a missing asset path.
    function StrataGateMark() {
      return h('svg', { className: 'sg-logo', viewBox: '0 0 32 32', role: 'img', 'aria-label': 'StrataGate', focusable: 'false' },
        h('rect', { className: 'sg-logo-back', x: 10, y: 5, width: 16, height: 17, rx: 3, strokeWidth: 1.5 }),
        h('rect', { className: 'sg-logo-middle', x: 7, y: 8, width: 16, height: 17, rx: 3, strokeWidth: 1.5 }),
        h('rect', { className: 'sg-logo-front', x: 4, y: 11, width: 16, height: 17, rx: 3, strokeWidth: 1.8 }),
        h('path', { className: 'sg-logo-rule', d: 'M8 17h8M8 21h5', fill: 'none', strokeWidth: 1.8, strokeLinecap: 'round' }))
    }

    // Header star entry: brand row, right side. The Issue entry stays in the
    // footer so the header keeps one action.
    function HeaderStarLink() {
      const shown = formatStarCount(GITHUB_STARS)
      const label = shown ? '在 GitHub 上给 StrataGate 点 Star，当前 ' + shown + ' 个' : '在 GitHub 上给 StrataGate 点 Star'
      return h('a', { className: 'sg-ghstar', href: STAR_REPOSITORY_URL, target: '_blank', rel: 'noopener noreferrer', title: label, 'aria-label': label },
        h('span', { className: 'sg-ghstar-label' }, h(GitHubMarkIcon), h('b', null, 'Star')),
        shown ? h('span', { className: 'sg-ghstar-count', 'aria-hidden': 'true' }, shown) : null)
    }

    function buildSupportReport({ problemContent = '', overview = {}, selected = {}, data = {}, recentError = '', includeLogs = false, includeMemory = false, willingToContribute = false, diagnostics = null } = {}) {
      const problem = redactText(String(problemContent || '').trim())
      if (!problem) return ''
      // Error text stays behind the explicit log option, including legacy
      // diagnostic snapshots that may already contain a detail field.
      const reportDiagnostics = diagnostics && !includeLogs ? {
        ...diagnostics,
        records: Array.isArray(diagnostics.records) ? diagnostics.records.filter(record => record && typeof record === 'object').map(({ detail: _detail, ...record }) => record) : [],
      } : diagnostics
      const lines = [
        '# StrataGate 问题报告',
        '',
        problem,
        '',
        '## 自动诊断信息',
        '',
        '- StrataGate 版本：' + (overview.pluginVersion || 'unknown'),
        '- Harness 版本：' + (overview.harnessVersion || 'unknown'),
        '- blockTurnSize：' + (selected?.blockTurnSize ?? 'unknown'),
        '- 已封存块：' + (selected?.blocks ?? 'unknown'),
        '- Event / Graph Node 数量：' + (selected?.events ?? 'unknown') + ' / ' + (selected?.graphNodes ?? 'unknown'),
        '- 异常摘要：见下方结构化统计与诊断。',
        '',
        '> 此报告在浏览器本地生成。默认诊断不包含原始聊天、L5、Event 或 Graph 内容。正则脱敏仅是纵深防御，提交前仍需人工检查。',
      ]
      lines.push('', '## 近期运行摘要', '', '> 运行数据在本地采集；时间范围、缺失数据与统计口径见下方。')
      if (diagnostics) {
        const totals = diagnostics.totals || {}
        const shown = (key) => typeof totals[key] === 'number' ? totals[key] : '未取得'
        lines.push('', '- 统计范围：' + (diagnostics.since || '未取得') + ' 至 ' + (diagnostics.through || '未取得') + '（UTC）',
          '- 模型请求次数：' + shown('modelCalls') + '；其中缺少用量记录：' + shown('missingUsageCalls'),
          '- 已报告 Token 合计：' + shown('totalTokens') + '；完整总量记录的请求数：' + shown('totalTokenCalls'),
          '- 记忆操作成功 / 失败：' + shown('operationsSucceeded') + ' / ' + shown('operationsFailed'))
      }
      lines.push('', '### 结构化统计与诊断', '', '```json', redactedJson(reportDiagnostics || { coverage: { available: false, note: '运行统计尚未取得。' } }), '```')
      if (willingToContribute) lines.push('', '## 贡献意愿', '', '- [x] 我愿意尝试修复并提交 PR。')
      if (includeLogs) {
        const failedJobs = Array.isArray(selected?.failedJobDetails) ? selected.failedJobDetails.map((job) => ({
          id: job?.id,
          kind: job?.kind,
          attempts: job?.attempts,
          lastError: job?.lastErrorFull || job?.lastError,
          updatedAt: job?.updatedAt,
          ...(job?.kind === 'topic-projection' ? { diagnostics: job?.diagnostics } : {}),
        })) : []
        lines.push('', '## 诊断日志', '', '```json', redactedJson({ frontendError: recentError || null, failedJobs }), '```')
      }
      if (includeMemory) {
        lines.push('', '## 用户主动附加的记忆数据（可能包含私人对话）', '', '> 警告：这些内容可能包含私人对话。自动脱敏不能保证识别所有敏感信息，提交前必须人工检查。', '', '```json', redactedJson({
          blocks: Array.isArray(data?.blocks) ? data.blocks.map(whitelistedBlock) : [],
          events: Array.isArray(data?.events) ? data.events.map(whitelistedEvent) : [],
          graph: whitelistedGraph(data?.graph),
        }), '```')
      }
      return lines.join('\n')
    }

    async function copyReportAndOpenIssue(report, clipboard = navigator?.clipboard, openWindow = (url) => window.open(url, '_blank'), title = '') {
      let copyPromise = null
      let copyError = ''
      if (!clipboard?.writeText) copyError = '当前浏览器不支持自动复制。'
      else {
        try {
          copyPromise = Promise.resolve(clipboard.writeText(report))
        } catch (reason) {
          copyError = '复制失败：' + String(reason?.message || reason)
        }
      }
      let opened = false
      try {
        const issueWindow = openWindow(issueUrl(title))
        opened = Boolean(issueWindow)
        if (issueWindow) issueWindow.opener = null
      } catch {}
      if (copyError) return { copied: false, opened, error: copyError }
      try {
        await copyPromise
        return { copied: true, opened, error: '' }
      } catch (reason) {
        return { copied: false, opened, error: '复制失败：' + String(reason?.message || reason) }
      }
    }

    function shouldExpandFeedbackPreview(result) {
      return result?.copied === false
    }

    function handleFeedbackIssueResult(result, callbacks = {}) {
      const messages = []
      if (result?.copied) {
        callbacks.setStatus?.(result.opened ? '报告已复制。请在新打开的 Issue 中粘贴、检查并提交。' : '报告已复制，但浏览器可能拦截了新窗口。请点击下方普通链接打开 Issue。')
      } else {
        if (shouldExpandFeedbackPreview(result)) callbacks.setPreviewOpen?.(true)
        messages.push((result?.error || '复制或打开 Issue 失败') + ' 报告仍保留在预览中；请手动复制或下载诊断文件。' + (result?.opened ? '' : ' 也可点击下方普通链接打开 Issue。'))
        callbacks.setError?.((current) => current ? current + ' ' + messages.join(' ') : messages.join(' '))
      }
      return result
    }

    function downloadSupportReport(report, documentRef = document, urlRef = URL) {
      const blob = new Blob([report], { type: 'text/plain;charset=utf-8' })
      const objectUrl = urlRef.createObjectURL(blob)
      const link = documentRef.createElement('a')
      link.href = objectUrl
      link.download = 'stratagate-diagnostics.txt'
      link.style.display = 'none'
      try {
        documentRef.body?.appendChild(link)
        link.click()
      } finally {
        link.remove()
        urlRef.revokeObjectURL(objectUrl)
      }
      return blob
    }

    function SupportPage({ namespace, overview, selected, data, recentError, onBack }) {
      const [includeLogs, setIncludeLogs] = React.useState(false)
      const [includeMemory, setIncludeMemory] = React.useState(false)
      const [willingToContribute, setWillingToContribute] = React.useState(false)
      const [status, setStatus] = React.useState('')
      const [error, setError] = React.useState('')
      const [title, setTitle] = React.useState('')
      const [problemContent, setProblemContent] = React.useState('')
      const [draftLoading, setDraftLoading] = React.useState(true)
      const titleTouchedRef = React.useRef(false)
      const bodyTouchedRef = React.useRef(false)
      const [aiPromptCopied, setAiPromptCopied] = React.useState(false)
      const [previewOpen, setPreviewOpen] = React.useState(false)
      const [feedbackStep, setFeedbackStep] = React.useState(0)
      const [reviewedReport, setReviewedReport] = React.useState(null)
      const feedbackHeadingRef = React.useRef(null)
      const previousFeedbackStepRef = React.useRef(0)
      const aiNoticeRef = React.useRef(null)
      const diagnosticsRef = React.useRef(null)
      React.useEffect(() => {
        if (previousFeedbackStepRef.current !== feedbackStep) feedbackHeadingRef.current?.focus({ preventScroll: true })
        previousFeedbackStepRef.current = feedbackStep
      }, [feedbackStep])
      React.useEffect(() => {
        let active = true
        titleTouchedRef.current = false
        bodyTouchedRef.current = false
        setDraftLoading(true)
        void Promise.resolve().then(() => api('feedback', { namespace })).then((result) => {
          if (!active) return
          diagnosticsRef.current = result?.diagnostics || null
          if (!result?.draft) return
          const restored = restoreFeedbackDraftValues(result.draft, { title: titleTouchedRef.current, body: bodyTouchedRef.current })
          if (!titleTouchedRef.current) setTitle(restored.title)
          if (!bodyTouchedRef.current) setProblemContent(restored.problemContent)
          if (result.draft.aiPrepared && restored.problemContent && !titleTouchedRef.current && !bodyTouchedRef.current) {
            setReviewedReport(Object.freeze({ title: restored.title, text: buildSupportReport({ problemContent: restored.problemContent, overview, selected, data, recentError, diagnostics: diagnosticsRef.current }) }))
            setFeedbackStep(1)
          }
        }).catch((reason) => {
          if (active) setError('读取反馈草稿失败：' + String(reason?.message || reason))
        }).finally(() => {
          if (active) setDraftLoading(false)
        })
        return () => { active = false }
      }, [namespace])
      React.useEffect(() => {
        if (!aiPromptCopied) return undefined
        const reveal = () => aiNoticeRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
        if (typeof window.requestAnimationFrame !== 'function') {
          reveal()
          return undefined
        }
        const frame = window.requestAnimationFrame(reveal)
        return () => window.cancelAnimationFrame?.(frame)
      }, [aiPromptCopied])
      const saveDraft = async () => {
        if (!namespace) return
        // Async converts even a synchronous fetch/serialization failure into
        // a rejection, so callers can isolate it from copying and composing.
        await api('feedback', {}, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ namespace, title, bodyMarkdown: problemContent }),
        })
      }
      const reportSnapshot = Object.freeze({ text: buildSupportReport({ problemContent, overview, selected, data, recentError, includeLogs, includeMemory, willingToContribute, diagnostics: diagnosticsRef.current }), title })
      const reportBytes = reportSnapshot.text ? new Blob([reportSnapshot.text]).size : 0
      const hasProblem = Boolean(problemContent.trim())
      const persistDraft = () => {
        setStatus(''); setError('')
        void saveDraft().then(() => setStatus('反馈草稿已保存在本地。')).catch((reason) => setError('保存反馈草稿失败：' + String(reason?.message || reason)))
      }
      const copyAndOpen = () => {
        setStatus(''); setError('')
        void saveDraft().catch((reason) => setError((current) => {
          const message = '保存反馈草稿失败：' + String(reason?.message || reason)
          return current ? current + ' ' + message : message
        }))
        const issue = copyReportAndOpenIssue(reportSnapshot.text, navigator?.clipboard, (url) => window.open(url, '_blank'), title)
        void issue.then((result) => handleFeedbackIssueResult(result, { setStatus, setError, setPreviewOpen }))
          .catch((reason) => setError((current) => {
            const message = '复制或打开 Issue 失败：' + String(reason?.message || reason)
            return current ? current + ' ' + message : message
          }))
      }
      const copyAndEmail = () => {
        setStatus(''); setError('')
        void saveDraft().catch((reason) => setError((current) => {
          const message = '保存反馈草稿失败：' + String(reason?.message || reason)
          return current ? current + ' ' + message : message
        }))
        void copyReportAndComposeEmail(reportSnapshot.text, navigator?.clipboard, undefined, title)
          .then((result) => handleFeedbackEmailResult(result, { setStatus, setError, setPreviewOpen }))
          .catch((reason) => setError((current) => {
            const message = '准备邮件反馈失败：' + String(reason?.message || reason)
            return current ? current + ' ' + message : message
          }))
      }
      const copyEmail = async () => {
        setStatus(''); if (GITHUB_FEEDBACK_ENABLED) setError('')
        if (!navigator?.clipboard?.writeText) {
          setError('当前浏览器不支持自动复制，请手动复制邮箱：' + FEEDBACK_EMAIL)
          return
        }
        try {
          await navigator.clipboard.writeText(FEEDBACK_EMAIL)
          setStatus('邮箱已复制：' + FEEDBACK_EMAIL)
        } catch { setError('复制邮箱失败，请手动复制：' + FEEDBACK_EMAIL) }
      }
      const copyAiPrompt = () => {
        setStatus(''); setError('')
        if (!navigator?.clipboard?.writeText) {
          setError('当前浏览器不支持自动复制。请展开下方提示词并手动复制。')
          return
        }
        void navigator.clipboard.writeText(FEEDBACK_AI_PROMPT)
          .then(() => setAiPromptCopied(true))
          .catch((reason) => setError('复制 AI 提示词失败：' + String(reason?.message || reason)))
      }
      const download = () => {
        setStatus(''); setError('')
        try {
          downloadSupportReport(GITHUB_FEEDBACK_ENABLED ? reportSnapshot.text : reviewedReport?.text || '')
          setStatus('诊断文件已下载。文件内容与当前预览完全一致。')
        } catch (reason) {
          setError('下载失败：' + String(reason?.message || reason) + '。报告仍保留在预览中，可手动复制。')
        }
      }
      if (!GITHUB_FEEDBACK_ENABLED) {
        const review = () => {
          if (!hasProblem || draftLoading) return
          setStatus(''); setError('')
          setReviewedReport(reportSnapshot)
          setFeedbackStep(1)
          void saveDraft().catch((reason) => setError('保存反馈草稿失败：' + String(reason?.message || reason)))
        }
        const edit = () => { setFeedbackStep(0); setReviewedReport(null); setStatus(''); setError('') }
        const copyReport = async () => {
          if (!reviewedReport?.text) return
          setStatus('')
          try {
            if (!globalThis.navigator?.clipboard?.writeText) throw new Error('当前环境不支持自动复制')
            await globalThis.navigator.clipboard.writeText(reviewedReport.text)
            setStatus('报告已复制。请在自己的邮箱中粘贴、检查并发送。')
          } catch {
            setError('无法自动复制。下方保留完整报告，可选中手动复制，或下载报告。')
          }
        }
        return h(React.Fragment, null,
          h(BackBar, { label: '更多', onBack }),
          h('section', { className: 'sg-feedback-wizard', 'aria-label': 'StrataGate 插件反馈' },
            h('div', { className: 'sg-feedback-heading' }, h('h2', { ref: feedbackHeadingRef, tabIndex: -1 }, '反馈 StrataGate'),
              h('p', null, feedbackStep === 0 ? '让 AI 根据刚才的会话整理，你也可以补充一两句。运行摘要会自动加入报告。' : '检查下面的完整报告，再复制到自己的邮箱发送。')),
            draftLoading ? h('p', { className: 'sg-support-sync', role: 'status' }, '正在读取本地反馈草稿…') : null,
            feedbackStep === 0 ? h('section', { className: 'sg-feedback-stage', 'aria-label': '编辑反馈' },
              AGENT_FEEDBACK_ENABLED ? h('div', { className: 'sg-feedback-actions' }, h('button', { type: 'button', className: 'sg-quiet-button', onClick: copyAiPrompt }, '让 AI 整理反馈')) : null,
              AGENT_FEEDBACK_ENABLED ? h('details', null, h('summary', null, '查看 AI 提示词'), h('pre', { className: 'sg-raw-json sg-code' }, FEEDBACK_AI_PROMPT)) : null,
              aiPromptCopied ? h('p', { ref: aiNoticeRef, role: 'status' }, '提示词已复制。回到刚才的会话，粘贴并发送，AI 会生成本地草稿。') : null,
              h('label', { className: 'sg-support-field' }, h('span', null, '问题内容'), h('textarea', { className: 'sg-support-description', rows: 7, value: problemContent, onChange: (event) => { bodyTouchedRef.current = true; setProblemContent(event.target.value) }, onBlur: persistDraft, placeholder: '可以让 AI 整理后再补充，也可以直接描述问题、建议或疑问。', 'aria-label': '问题内容' })),
              h('label', { className: 'sg-support-field' }, h('span', null, '邮件主题（可选）'), h('input', { className: 'sg-support-input', value: title, onChange: (event) => { titleTouchedRef.current = true; setTitle(event.target.value) }, onBlur: persistDraft })),
              h('fieldset', { className: 'sg-feedback-options' }, h('legend', null, '附加信息'), h('p', null, '默认包含基础诊断、近期运行统计和异常分类；以下内容由你选择加入。'),
                h('div', { className: 'sg-feedback-checks' },
                  h('label', { className: 'sg-check' }, h('input', { type: 'checkbox', checked: includeLogs, onChange: (event) => setIncludeLogs(event.target.checked), 'aria-label': '加入日志' }), h('span', null, '加入详细错误日志')),
                  h('label', { className: 'sg-check' }, h('input', { type: 'checkbox', checked: includeMemory, onChange: (event) => setIncludeMemory(event.target.checked), 'aria-label': '加入记忆内容' }), h('span', null, '加入记忆内容'))),
                includeMemory ? h('p', { className: 'sg-error-note' }, '记忆内容可能包含私人对话，请逐项检查后发送。') : null),
              !hasProblem ? h('p', { className: 'sg-support-empty' }, '有了问题描述后，即可检查报告。') : null,
              h('div', { className: 'sg-feedback-actions' }, h('button', { type: 'button', className: 'sg-primary-link', disabled: !hasProblem || draftLoading, onClick: review }, '检查报告'))) : null,
            feedbackStep > 0 && reviewedReport ? h('section', { className: 'sg-feedback-stage', 'aria-label': '检查并发送反馈' },
              h('div', { className: 'sg-feedback-ready' }, h('span', { className: 'sg-feedback-unsent' }, '尚未发送'),
                h('p', null, '报告包含问题描述和本地运行摘要。请检查凭据与私人内容；可返回修改。')),
              h('label', { className: 'sg-support-field' }, h('span', null, '完整报告 · ' + new Blob([reviewedReport.text]).size + ' 字节'),
                h('textarea', { className: 'sg-support-preview', readOnly: true, value: reviewedReport.text, spellCheck: false, 'aria-label': '本地反馈报告预览' })),
              h('div', { className: 'sg-feedback-actions' },
                h('button', { type: 'button', className: 'sg-primary-link', onClick: copyReport }, '复制报告'),
                h('button', { type: 'button', className: 'sg-quiet-button', onClick: edit }, '修改或补充'),
                h('button', { type: 'button', className: 'sg-quiet-button', onClick: download }, '下载报告')),
              h('section', { className: 'sg-feedback-contact', 'aria-label': '邮件发送信息' },
                h('p', { className: 'sg-feedback-email' }, FEEDBACK_EMAIL),
                h('button', { type: 'button', className: 'sg-quiet-button', onClick: copyEmail }, '复制邮箱'),
                h('p', null, '邮件主题：StrataGate 反馈' + (reviewedReport.title ? '：' + reviewedReport.title : '')),
                h('p', { className: 'sg-feedback-caption' }, '在自己的邮箱填写收件地址，粘贴报告后发送。')),
              h('p', { className: 'sg-feedback-caption' }, '资料保存在本地；作者在收到你发送的邮件后才能查看。')) : null,
            status ? h('p', { className: 'sg-support-status', role: 'status', 'aria-live': 'polite' }, status) : null,
            error ? h('p', { className: 'sg-support-error', role: 'alert' }, error) : null))
      }
      // Preserve the previous GitHub feedback view and handlers for restoration.
      return h(React.Fragment, null,
        h(BackBar, { label: '更多', onBack }),
        h('div', { className: 'sg-intro' }, h('h2', null, '反馈与支持'), h('p', null, GITHUB_FEEDBACK_ENABLED ? '报告只在本地生成。只有你主动粘贴或上传后，内容才会进入 GitHub。' : '报告只在本地生成。请通过邮件反馈问题，检查内容后自行发送。')),
        GITHUB_FEEDBACK_ENABLED && aiPromptCopied ? h('div', { ref: aiNoticeRef, className: 'sg-support-ai-notice', role: 'status', 'aria-live': 'polite' },
          h('span', { className: 'sg-support-ai-notice-mark', 'aria-hidden': 'true' }, '✓'),
          h('div', null,
            h('strong', null, 'AI 提示词已复制'),
            h('p', null, '下一步：回到刚才出现问题的会话，直接粘贴并发送。'),
            h('p', null, 'Agent 会根据刚才的会话整理问题，并自动创建反馈草稿。'),
            h('button', { type: 'button', className: 'sg-quiet-button', onClick: copyAiPrompt }, '再次复制提示词')),
          h('button', { type: 'button', className: 'sg-support-ai-notice-close', onClick: () => setAiPromptCopied(false), 'aria-label': '关闭 AI 提示词提示' }, '×')) : null,
        h('div', { className: 'sg-privacy-note' }, GITHUB_FEEDBACK_ENABLED ? 'GitHub 链接不包含报告正文、诊断日志或记忆数据。StrataGate 永远不会自动提交 Issue。' : '邮件链接只预填主题和粘贴提示，不包含报告正文、诊断日志或记忆数据。StrataGate 不会自动发送邮件。'),
        GITHUB_FEEDBACK_ENABLED ? null : h('section', { className: 'sg-support-card' }, h('h3', null, '反馈邮箱'),
          h('p', null, h('a', { className: 'sg-link', href: feedbackEmailUrl(title) }, FEEDBACK_EMAIL)),
          h('button', { type: 'button', className: 'sg-quiet-button', onClick: copyEmail }, '复制邮箱'),
          h('p', null, '若点击链接后没有打开邮件应用，可复制邮箱，在常用邮箱中撰写邮件；诊断文件可手动添加为附件。')),
        h('section', { className: 'sg-support-card sg-support-compose' },
          h('div', { className: 'sg-support-compose-head' }, h('div', null, h('h3', null, '描述问题'), h('p', null, '自由描述即可，不需要填写多组必填表单。')), GITHUB_FEEDBACK_ENABLED ? h('button', { type: 'button', className: 'sg-support-ai', onClick: copyAiPrompt }, 'AI 帮我填') : null),
          h('label', { className: 'sg-support-field' }, h('span', null, GITHUB_FEEDBACK_ENABLED ? 'Issue 标题（可选）' : '邮件主题（可选）'), h('input', { className: 'sg-support-input', value: title, onChange: (event) => { titleTouchedRef.current = true; setTitle(event.target.value) }, onBlur: persistDraft, placeholder: '简短概括问题' })),
          h('label', { className: 'sg-support-field' }, h('span', null, '问题内容'), h('textarea', { className: 'sg-support-description', value: problemContent, onChange: (event) => { bodyTouchedRef.current = true; setProblemContent(event.target.value) }, onBlur: persistDraft, placeholder: GITHUB_FEEDBACK_ENABLED ? '描述刚才发生了什么；也可以点击“AI 帮我填”。' : '描述发生了什么、复现步骤，以及预期和实际结果。', 'aria-label': '问题内容' })),
          GITHUB_FEEDBACK_ENABLED ? h('details', null, h('summary', null, '查看可手动复制的 AI 提示词'), h('pre', { className: 'sg-raw-json sg-code' }, FEEDBACK_AI_PROMPT)) : null,
          draftLoading ? h('div', { className: 'sg-support-sync' }, '正在读取本地反馈草稿…') : null),
        h('section', { className: 'sg-support-card' }, h('h3', null, '附加信息'), h('p', null, '基础诊断默认包含；日志和记忆数据只有在你主动勾选后才会加入。'),
          h('label', { className: 'sg-check' }, h('input', { type: 'checkbox', checked: true, disabled: true }), h('span', null, '默认基础诊断')),
          h('label', { className: 'sg-check' }, h('input', { type: 'checkbox', checked: includeLogs, onChange: (event) => setIncludeLogs(event.target.checked) }), h('span', null, '附加诊断日志')),
          h('label', { className: 'sg-check' }, h('input', { type: 'checkbox', checked: includeMemory, onChange: (event) => setIncludeMemory(event.target.checked) }), h('span', null, '附加记忆数据（可能包含对话内容）')),
          includeMemory ? h('div', { className: 'sg-error-note' }, '警告：内容可能包含私人对话；自动脱敏不能保证识别所有敏感信息；提交前必须人工检查。') : null,
          GITHUB_FEEDBACK_ENABLED ? h('label', { className: 'sg-check' }, h('input', { type: 'checkbox', checked: willingToContribute, onChange: (event) => setWillingToContribute(event.target.checked) }), h('span', null, '我愿意尝试修复并提交 PR')) : null,
          hasProblem ? null : h('div', { className: 'sg-support-empty' }, GITHUB_FEEDBACK_ENABLED ? '请先描述问题，或使用 AI 帮你填写。' : '请先描述问题，再复制报告并通过邮件发送。'),
          h('div', { className: 'sg-support-actions' },
            h('button', { type: 'button', className: 'sg-primary-link', disabled: !hasProblem, onClick: GITHUB_FEEDBACK_ENABLED ? copyAndOpen : copyAndEmail }, GITHUB_FEEDBACK_ENABLED ? '复制报告并打开 GitHub Issue' : '复制报告并撰写邮件'),
            h('button', { type: 'button', className: 'sg-quiet-button', disabled: !hasProblem, onClick: () => setPreviewOpen((open) => !open), 'aria-expanded': previewOpen }, previewOpen ? '收起将复制的内容' : '查看将复制的内容'),
            h('button', { type: 'button', className: 'sg-quiet-button', disabled: !hasProblem, onClick: download }, '下载诊断文件'),
            GITHUB_FEEDBACK_ENABLED ? h('a', { className: 'sg-link', href: issueUrl(title), target: '_blank', rel: 'noopener noreferrer' }, '仅打开 GitHub Issue') : h('a', { className: 'sg-link', href: feedbackEmailUrl(title) }, '仅撰写邮件')),
          hasProblem && previewOpen ? h('div', { className: 'sg-support-preview-panel', role: 'region', 'aria-label': '将复制的反馈报告' },
            h('div', { className: 'sg-support-preview-head' },
              h('strong', null, '将复制的内容'),
              h('div', { className: 'sg-support-metrics' }, reportSnapshot.text.length + ' 个字符 · ' + reportBytes + ' 字节')),
            includeMemory ? h('div', { className: 'sg-error-note' }, '已包含你主动勾选的 Memory 数据，请逐项检查脱敏结果和私人对话。') : null,
            h('textarea', { id: 'sg-support-preview', className: 'sg-support-preview', readOnly: true, value: reportSnapshot.text, spellCheck: false, 'aria-label': '本地反馈报告预览' })) : null,
          status ? h('div', { className: 'sg-support-status', role: 'status' }, status) : null,
          error ? h('div', { className: 'sg-support-error', role: 'alert' }, error) : null),
        GITHUB_FEEDBACK_ENABLED ? h('section', { className: 'sg-support-card' }, h('h3', null, '功能建议'), h('p', null, 'GitHub 入口不会预填正文，请在页面中主动填写并提交。'), h('a', { className: 'sg-link', href: ISSUE_URL, target: '_blank', rel: 'noopener noreferrer' }, '创建 Feature Request →'))
          : h('section', { className: 'sg-support-card' }, h('h3', null, '功能建议'), h('p', null, '欢迎通过邮件提出功能建议。'), h('a', { className: 'sg-link', href: feedbackEmailUrl('功能建议') }, '发送功能建议 →')),
        GITHUB_FEEDBACK_ENABLED ? h('section', { className: 'sg-support-card' }, h('h3', null, '使用疑问'), h('p', null, '在 GitHub Discussion 的 Q&A 区交流使用方法。'), h('a', { className: 'sg-link', href: DISCUSSION_URL, target: '_blank', rel: 'noopener noreferrer' }, '前往 Discussion / Q&A →'))
          : h('section', { className: 'sg-support-card' }, h('h3', null, '使用疑问'), h('p', null, '欢迎通过邮件咨询使用方法。'), h('a', { className: 'sg-link', href: feedbackEmailUrl('使用疑问') }, '邮件咨询 →')))
    }

    function StructurePage({ events, eventPage, graph, openEvent, namespace, onBack }) {
      const pagedEvents = usePagedMemory({ namespace, kind: 'events', initialItems: events, initialPage: eventPage, fallbackLimit: 40 })
      return h(React.Fragment, null,
        h(BackBar, { label: '更多', onBack }),
        h('div', { className: 'sg-intro' }, h('h2', null, '记忆结构'), h('p', null, '完整浏览现有结构化记忆')),
        h('div', { className: 'sg-counts' },
          h('div', null, h('div', { className: 'sg-count-value' }, pagedEvents.page.total), h('div', { className: 'sg-count-label' }, '经历 / Event')),
          h('div', null, h('div', { className: 'sg-count-value' }, graph.nodes.length), h('div', { className: 'sg-count-label' }, '知识图谱节点'))),
        h('div', { className: 'sg-structured-group' },
          h('h3', { className: 'sg-section-title' }, '经历'),
          pagedEvents.items.map((event) => h('button', { key: event.id, className: 'sg-related', onClick: () => openEvent(event) }, h('span', null, event.title), h('span', { className: 'sg-related-time' }, formatTime(event.updatedAt))))),
        h(Pagination, { page: pagedEvents.page, loading: pagedEvents.loading, error: pagedEvents.error, onOffset: pagedEvents.loadOffset }),
        h('div', { className: 'sg-structured-group' },
          h('h3', { className: 'sg-section-title' }, '图谱节点'),
          graph.nodes.map((node) => h('div', { key: node.id, className: 'sg-related' }, h('span', null, node.name), h('span', { className: 'sg-related-time' }, (node.sourceEventIds || []).length + ' 条支撑事件')))))
    }

    const DUPLICATE_STYLES = `
      .sg-memory-review .sg-header{padding:10px 12px;margin-bottom:12px}.sg-memory-review .sg-logo{width:28px;height:28px}.sg-memory-review .sg-brand-name{font-size:14px}.sg-memory-review .sg-header-row-secondary{margin-top:4px}.sg-memory-review .sg-tabs{margin-bottom:12px}.sg-memory-review .sg-dup-heading h2{font-size:21px}
      .sg-dup-entry{display:flex;align-items:center;gap:12px;width:100%;margin:12px 0;padding:14px 16px;border:1px solid color-mix(in srgb,var(--sg-accent) 28%,var(--sg-border));border-radius:10px;background:var(--sg-accent-soft);color:var(--sg-accent);text-align:left;cursor:pointer}.sg-dup-entry>span{display:grid;gap:3px;flex:1}.sg-dup-entry strong{font-size:13px;font-weight:650}.sg-dup-entry small{font-size:11px;color:var(--sg-muted)}.sg-dup-entry:focus-visible{outline:2px solid var(--sg-accent);outline-offset:3px}
      .sg-duplicates{container-type:inline-size;display:grid;gap:18px;color:var(--sg-text)}
      .sg-dup-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}.sg-dup-heading h2{margin:0;font-size:23px;font-weight:720;letter-spacing:-.6px}.sg-dup-heading p{margin:5px 0 0;color:var(--sg-muted);font-size:12px;line-height:1.65}
      .sg-dup-button{display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:36px;padding:8px 12px;border:1px solid var(--sg-border);border-radius:8px;background:transparent;color:var(--sg-text);font:inherit;font-size:12px;font-weight:600;cursor:pointer;transition:background .18s,border-color .18s,transform .18s;white-space:normal;text-align:center}.sg-dup-button:hover:not(:disabled){background:var(--sg-soft);border-color:var(--sg-accent)}.sg-dup-button:active:not(:disabled){transform:translateY(1px)}.sg-dup-button:focus-visible,.sg-dup-choice:has(input:focus-visible){outline:2px solid var(--sg-accent);outline-offset:3px}.sg-dup-button:disabled{opacity:.42;cursor:not-allowed}.sg-dup-button.primary{background:var(--sg-accent);border-color:var(--sg-accent);color:#fff}.sg-dup-button.primary:hover:not(:disabled){background:color-mix(in srgb,var(--sg-accent) 86%,var(--sg-text));color:#fff}.sg-dup-button.text{border-color:transparent;color:var(--sg-muted);padding-inline:4px}.sg-dup-button svg{flex-shrink:0}
      .sg-dup-navigation{display:flex;align-items:center;gap:8px;padding-bottom:14px;border-bottom:1px solid var(--sg-border)}.sg-dup-navigation select{flex:1;min-width:0;max-width:100%;padding:8px 10px;border:1px solid var(--sg-border);border-radius:7px;background:var(--sg-surface);color:var(--sg-text);font:inherit;font-size:12px}.sg-dup-count{color:var(--sg-muted);font-size:11px;white-space:nowrap}.sg-dup-navigation .sg-dup-button{padding:5px;min-width:30px;min-height:30px}
      .sg-dup-pair{display:grid;gap:14px}.sg-dup-status-row{display:flex;align-items:center;justify-content:space-between;gap:10px}.sg-dup-status{display:inline-flex;align-items:center;gap:6px;color:var(--sg-accent);font-size:12px;font-weight:650}.sg-dup-status.done{color:var(--sg-muted)}.sg-dup-status small{font-weight:400;color:var(--sg-muted)}.sg-dup-reason{margin:0;padding:11px 13px;border-radius:8px;background:var(--sg-soft);color:var(--sg-muted);font-size:12px;line-height:1.65;overflow-wrap:anywhere}.sg-dup-reason strong{display:block;margin-bottom:3px;color:var(--sg-text);font-size:11px;font-weight:650}
      .sg-dup-comparison{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;align-items:stretch}.sg-dup-card{display:flex;flex-direction:column;min-width:0;border:1px solid var(--sg-border);border-radius:12px;background:var(--sg-surface);overflow:hidden;transition:border-color .18s,box-shadow .18s}.sg-dup-card.selected{border-color:var(--sg-accent);box-shadow:inset 0 0 0 1px var(--sg-accent)}.sg-dup-card.archived{opacity:.68}.sg-dup-choice{display:flex;align-items:center;gap:8px;min-height:45px;padding:12px 13px;border-bottom:1px solid var(--sg-border);color:var(--sg-muted);font-size:12px;font-weight:600;cursor:pointer;background:color-mix(in srgb,var(--sg-soft) 45%,transparent)}.sg-dup-choice input{width:15px;height:15px;margin:0;accent-color:var(--sg-accent);flex-shrink:0}.sg-dup-choice input:disabled{cursor:not-allowed}.sg-dup-card.selected .sg-dup-choice{background:var(--sg-accent-soft);color:var(--sg-accent)}.sg-dup-choice em{margin-left:auto;font-size:10px;font-style:normal;font-weight:600}.sg-dup-letter{display:inline-grid;place-items:center;width:22px;height:22px;border-radius:5px;background:var(--sg-soft);font-size:11px;font-weight:750}.sg-dup-card-body{display:grid;align-content:start;gap:11px;padding:14px 13px;flex:1}.sg-dup-card h3{margin:0;color:var(--sg-text);font-size:15px;font-weight:680;line-height:1.5;text-wrap:pretty}.sg-dup-card p{margin:0}.sg-dup-summary{font-size:12px;line-height:1.8;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--sg-text)}.sg-dup-summary.collapsed{display:-webkit-box;-webkit-line-clamp:5;-webkit-box-orient:vertical;overflow:hidden}.sg-dup-expand{justify-self:start;padding:0;border:0;background:transparent;color:var(--sg-accent);font:inherit;font-size:11px;cursor:pointer}
      .sg-dup-meta{display:flex;flex-wrap:wrap;gap:5px;color:var(--sg-muted);font-size:10px}.sg-dup-meta span{padding:3px 6px;border-radius:4px;background:var(--sg-soft)}.sg-dup-evidence{display:grid;gap:8px;margin:0;font-size:11px;line-height:1.65}.sg-dup-evidence dt{color:var(--sg-muted);font-size:10px}.sg-dup-evidence dd{margin:2px 0 0;color:var(--sg-text)}.sg-dup-evidence blockquote{margin:0;padding-left:9px;border-left:2px solid var(--sg-border)}.sg-dup-card-footer{padding:10px 13px;border-top:1px solid var(--sg-border);display:grid;gap:5px}.sg-dup-card-footer .sg-dup-button{justify-content:flex-start;min-height:28px;padding:0;border:0;text-align:left;font-size:11px;color:var(--sg-accent)}.sg-dup-card-footer small{color:var(--sg-muted);font-size:10px;line-height:1.5}
      .sg-dup-method{display:grid;gap:8px;padding-top:4px}.sg-dup-method legend{padding:0;margin-bottom:8px;color:var(--sg-text);font-size:12px;font-weight:650}.sg-dup-method fieldset{padding:0;margin:0;border:0;min-width:0}.sg-dup-methods{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.sg-dup-method label{display:grid;grid-template-columns:15px 1fr;align-content:start;gap:3px 7px;padding:11px;border:1px solid var(--sg-border);border-radius:8px;font-size:12px;cursor:pointer}.sg-dup-method input{margin:2px 0 0;width:14px;height:14px;accent-color:var(--sg-accent)}.sg-dup-method label:has(input:checked){border-color:var(--sg-accent);background:color-mix(in srgb,var(--sg-accent-soft) 38%,transparent)}.sg-dup-method label:has(input:disabled){cursor:not-allowed;color:var(--sg-muted)}.sg-dup-method label span{grid-column:2;color:var(--sg-muted);font-size:10px;line-height:1.5}.sg-dup-constraint{display:flex;gap:7px;margin:0;color:var(--sg-muted);font-size:11px;line-height:1.65}.sg-dup-constraint svg{flex-shrink:0;margin-top:2px}
      .sg-dup-actions{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;padding-top:13px;border-top:1px solid var(--sg-border)}.sg-dup-actions p{margin:0;color:var(--sg-muted);font-size:11px}.sg-dup-actions>div{display:flex;align-items:center;gap:7px;flex-wrap:wrap}.sg-dup-preview{padding:17px;border:1px solid var(--sg-accent);border-radius:11px;background:color-mix(in srgb,var(--sg-accent-soft) 36%,var(--sg-surface))}.sg-dup-preview h3{margin:0 0 5px;font-size:16px;font-weight:680}.sg-dup-preview>p{margin:0 0 14px;color:var(--sg-muted);font-size:12px;line-height:1.65}.sg-dup-result{display:grid;grid-template-columns:48px minmax(0,1fr);gap:7px 9px;margin:0 0 13px;font-size:12px;line-height:1.6}.sg-dup-result dt{color:var(--sg-muted)}.sg-dup-result dd{margin:0;color:var(--sg-text);overflow-wrap:anywhere}.sg-dup-preview .sg-dup-actions{border-top-color:color-mix(in srgb,var(--sg-accent) 20%,var(--sg-border))}.sg-dup-notice{padding:11px 13px;border-radius:8px;background:var(--sg-soft);font-size:12px;line-height:1.65}.sg-dup-notice.error{color:var(--sg-danger);background:var(--sg-danger-soft)}.sg-dup-empty{display:grid;justify-items:center;gap:10px;padding:40px 24px;border:1px dashed var(--sg-border);border-radius:12px;text-align:center;color:var(--sg-muted)}.sg-dup-empty strong{font-size:15px;color:var(--sg-text)}.sg-dup-empty p{margin:0;max-width:35ch;font-size:12px;line-height:1.7}.sg-dup-skeleton{height:220px;border-radius:11px;background:var(--sg-soft);animation:sg-dup-pulse 1.5s ease-in-out infinite}.sg-dup-tools{padding-top:12px;border-top:1px solid var(--sg-border);color:var(--sg-muted);font-size:11px;line-height:1.6}.sg-dup-tools summary{cursor:pointer;list-style-position:inside}.sg-dup-tools p{margin:8px 0}.sg-dup-tools .sg-dup-button{font-size:11px}
      .sg-dup-history{display:flex;align-items:flex-start;gap:10px;margin:16px 0;padding:14px 15px;border-left:3px solid var(--sg-accent);border-radius:4px 9px 9px 4px;background:var(--sg-soft);font-size:12px;line-height:1.75}.sg-dup-history>svg{flex:none;margin-top:3px;color:var(--sg-accent)}.sg-dup-history strong{font-size:13px;font-weight:650;color:var(--sg-text)}.sg-dup-history p{margin:5px 0;color:var(--sg-muted);text-wrap:pretty}.sg-dup-history .sg-dup-button{margin-top:7px}
      @keyframes sg-dup-pulse{50%{opacity:.45}}@media(prefers-reduced-motion:reduce){.sg-dup-skeleton{animation:none}.sg-dup-button,.sg-dup-card{transition:none}}
      .sg-dup-source{display:grid;gap:12px;padding:14px 13px;border-top:1px solid var(--sg-border);background:var(--sg-soft);font-size:12px;line-height:1.7}.sg-dup-source h4{margin:0;font-size:12px}.sg-dup-source .sg-citation-message{background:var(--sg-surface);font-size:11px}.sg-dup-card.archived:has(.sg-dup-source){opacity:1}
      .sg-dup-queues{display:flex;gap:5px;flex-wrap:wrap;padding:4px;background:var(--sg-soft);border-radius:9px}.sg-dup-queues button{flex:1;border:0}.sg-dup-queues button[aria-pressed=true]{background:var(--sg-surface);color:var(--sg-accent);box-shadow:0 1px 4px #0001}.sg-dup-editor{display:grid;gap:13px;margin:15px 0;padding:14px;border-radius:9px;background:var(--sg-surface)}.sg-dup-draft-heading{display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:12px}.sg-dup-editor label{display:grid;gap:7px;color:var(--sg-muted);font-size:11px}.sg-dup-editor input,.sg-dup-editor textarea{box-sizing:border-box;width:100%;min-width:0;border:1px solid var(--sg-border);border-radius:7px;padding:10px;background:var(--sg-surface);color:var(--sg-text);font:inherit;font-size:13px;line-height:1.8}.sg-dup-editor textarea{resize:vertical;min-height:160px}.sg-dup-editor input:focus-visible,.sg-dup-editor textarea:focus-visible{outline:2px solid var(--sg-accent);outline-offset:2px}.sg-dup-notice .sg-dup-button{margin-left:8px}
      .sg-dup-options{display:grid;grid-template-columns:1.2fr 1fr 1fr;gap:10px}.sg-dup-option{display:grid;grid-template-columns:18px 1fr;align-content:start;gap:7px;padding:14px;border:1px solid var(--sg-border);border-radius:9px;background:transparent;color:var(--sg-text);text-align:left;font:inherit;cursor:pointer;transition:background .18s,border-color .18s}.sg-dup-option:first-child{background:var(--sg-accent-soft);border-color:color-mix(in srgb,var(--sg-accent) 55%,var(--sg-border))}.sg-dup-option strong{font-size:12px}.sg-dup-option span{grid-column:2;font-size:11px;line-height:1.75;color:var(--sg-muted)}.sg-dup-option:hover:not(:disabled){border-color:var(--sg-accent);background:var(--sg-soft)}.sg-dup-option:focus-visible{outline:2px solid var(--sg-accent);outline-offset:3px}.sg-dup-option:disabled{opacity:.5;cursor:default}
      .sg-dup-summary{font-size:13px}.sg-dup-stage-title{margin:0;font-size:16px;font-weight:650}.sg-dup-stage-heading h3{margin:0 0 7px;font-size:19px;font-weight:650}.sg-dup-stage-heading p{margin:0;color:var(--sg-muted);font-size:12px;line-height:1.8;max-width:65ch}.sg-dup-back{justify-self:start}.sg-dup-steps{display:flex;gap:16px;font-size:11px;color:var(--sg-muted)}.sg-dup-steps [aria-current=step]{color:var(--sg-accent);font-weight:650}
      .sg-dup-consequences{padding-top:16px;border-top:1px solid var(--sg-border)}.sg-dup-consequences h3{font-size:12px;margin:0 0 12px}.sg-dup-consequences .sg-dup-result{grid-template-columns:65px minmax(0,1fr)}.sg-dup-result-card{padding:18px;border:1px solid var(--sg-border);border-radius:9px;background:var(--sg-soft)}.sg-dup-result-card small{font-size:11px;color:var(--sg-muted)}.sg-dup-result-card h3{margin:7px 0 11px;font-size:16px}
      .sg-dup-pair>details summary{cursor:pointer;font-size:12px;color:var(--sg-accent)}.sg-dup-pair>details .sg-dup-comparison{margin-top:14px}.sg-dup-card-body[for]{cursor:pointer}.sg-dup-card:has(input:focus-visible){outline:2px solid var(--sg-accent);outline-offset:3px}.sg-dup-selection-result{margin:0;padding:10px 13px;border-top:1px solid var(--sg-border);font-size:11px;line-height:1.7;color:var(--sg-muted)}.sg-dup-card.selected .sg-dup-selection-result{color:var(--sg-accent);background:var(--sg-accent-soft);font-weight:600}.sg-dup-card .sg-dup-source{border-radius:0}.sg-dup-card.archived{opacity:1}
      .sg-dup-draft-skeleton{display:grid;gap:12px;padding:12px 0;min-height:180px}.sg-dup-draft-skeleton span{height:12px;border-radius:4px;background:var(--sg-soft);animation:sg-dup-pulse 1.5s ease-in-out infinite}.sg-dup-draft-skeleton span:last-child{width:70%}.sg-dup-editor{margin:0;border:1px solid var(--sg-border);padding:18px}.sg-dup-editor .sg-dup-notice{margin:0}.sg-dup-editor input:disabled,.sg-dup-editor textarea:disabled{opacity:.7}.sg-dup-button.primary{color:var(--sg-surface)}.sg-dup-button.primary:hover:not(:disabled){color:var(--sg-surface)}
      @container(max-width:600px){.sg-dup-options{grid-template-columns:1fr}.sg-dup-option{padding:12px}.sg-dup-draft-heading{flex-wrap:wrap}}
      @media(prefers-reduced-motion:reduce){.sg-dup-draft-skeleton span{animation:none}}
      @container(max-width:420px){.sg-dup-comparison,.sg-dup-methods{grid-template-columns:1fr}.sg-dup-heading h2{font-size:21px}.sg-dup-card-body{padding:13px}.sg-dup-actions>div{width:100%;justify-content:space-between}.sg-dup-button.primary{flex:1}.sg-dup-preview{padding:13px}}
    `

    function DuplicateIcon({ kind = 'cards', size = 17 }) {
      const paths = { cards: 'M7 3H3v14h10v-4M7 3v10h10V3H7Z', check: 'm4 10 4 4 8-8', info: 'M10 9v5m0-8v.2M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z', back: 'm12 5-5 5 5 5', next: 'm8 5 5 5-5 5', merge: 'M4 3v3c0 3 6 3 6 6v5m6-14v3c0 3-6 3-6 6m-3 2 3 3 3-3' }
      return h('svg', { width: size, height: size, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, h('path', { d: paths[kind] || paths.cards }))
    }

    function DuplicateEvidence({ namespace, card, hideSummary = false }) {
      const [result, setResult] = React.useState(null)
      const [error, setError] = React.useState('')
      const [attempt, setAttempt] = React.useState(0)
      React.useEffect(() => {
        let active = true
        setResult(null); setError('')
        void api('sources', { namespace, eventId: card.id }).then(value => { if (active) setResult(value) })
          .catch(reason => { if (active) setError(String(reason.message || reason)) })
        return () => { active = false }
      }, [namespace, card.id, attempt])
      return h('section', { className: 'sg-dup-source', 'aria-label': '完整记忆与来源' },
        h('h4', null, hideSummary ? '原始来源' : '完整记忆与来源'), !hideSummary ? h('p', { className: 'sg-dup-summary' }, card.summary) : null,
        error ? h('div', { role: 'alert' }, error, h('button', { type: 'button', className: 'sg-dup-button', onClick: () => setAttempt(value => value + 1) }, '重试读取来源'))
          : !result ? h('p', { role: 'status' }, '正在读取来源…')
            : result.messages?.length ? h('div', { className: 'sg-citation-messages' }, result.messages.map(message => h('div', { key: message.id, className: 'sg-citation-message' },
              h('span', { className: 'sg-citation-message-role' }, (message.role || 'Recorded') + (message.createdAt ? ' · ' + exactTime(message.createdAt) : '')), String(message.content || ''))))
              : h('p', null, '当前没有可显示的原始来源消息。'))
    }

    function DuplicateCard({ card, letter, selected, onSelect, unavailable, disabled, namespace, fullContent = false, selectionMade = false }) {
      const [expanded, setExpanded] = React.useState(false)
      const [showSource, setShowSource] = React.useState(false)
      const sourcePosition = React.useRef(null)
      ;(React.useLayoutEffect || React.useEffect)(() => {
        if (showSource || !sourcePosition.current) return
        const { trigger, ancestors, top, left } = sourcePosition.current
        trigger?.focus?.({ preventScroll: true })
        for (const saved of ancestors) { saved.node.scrollTop = saved.top; saved.node.scrollLeft = saved.left }
        window.scrollTo?.(left, top)
        sourcePosition.current = null
      }, [showSource])
      const toggleSource = event => {
        if (!showSource) {
          const ancestors = []
          for (let node = event.currentTarget.parentElement; node; node = node.parentElement) {
            if (node.scrollHeight > node.clientHeight) ancestors.push({ node, top: node.scrollTop, left: node.scrollLeft })
          }
          sourcePosition.current = { trigger: event.currentTarget, ancestors, top: window.scrollY || 0, left: window.scrollX || 0 }
        }
        setShowSource(value => !value)
      }
      if (!card) return h('article', { className: 'sg-dup-card' }, h('div', { className: 'sg-dup-card-body' }, h('h3', null, '记忆 ' + letter), h('p', null, '原卡已不可用')))
      const status = { active: '当前有效', superseded: '已被替代', archived: '已归档', forgotten: '已遗忘' }
      const criticality = { routine: '一般记忆', preference: '偏好', identity: '个人经历', safety: '重要约束' }
      const scope = { user: '个人', project: '项目', session: '本次会话' }
      const temporal = card.temporal || {}
      const date = temporal.happenedStart || temporal.originalText
      return h('article', { className: 'sg-dup-card' + (selected ? ' selected' : '') + (card.status === 'archived' ? ' archived' : '') },
        h('label', { className: 'sg-dup-choice' },
          onSelect ? h('input', { id: 'sg-retain-' + card.id, type: 'radio', name: 'duplicate-retained', checked: selected, disabled: disabled || Boolean(unavailable), onChange: onSelect, 'aria-label': '只保留 ' + letter + '：' + card.title }) : h('span', { className: 'sg-dup-letter' }, letter),
          h('span', null, onSelect ? '只保留 ' + letter : '记忆 ' + letter), h('em', null, status[card.status] || '')),
        h(onSelect ? 'label' : 'div', { className: 'sg-dup-card-body', htmlFor: onSelect ? 'sg-retain-' + card.id : undefined }, h('h3', null, card.title),
          h('div', { className: 'sg-dup-meta' }, date ? h('span', null, date) : null, h('span', null, criticality[card.criticality] || '一般记忆'), h('span', null, scope[card.scope] || card.scope || '个人'), card.weight?.pinned ? h('span', null, '已置顶') : null),
          h('p', { className: 'sg-dup-summary' + (!expanded && !fullContent ? ' collapsed' : '') }, card.summary),
          !fullContent && card.summary?.length > 160 ? h('button', { type: 'button', className: 'sg-dup-expand', onClick: () => setExpanded(!expanded), 'aria-expanded': expanded }, expanded ? '收起全文' : '展开全文') : null,
          h('dl', { className: 'sg-dup-evidence' },
            card.quotes?.length ? h(React.Fragment, null, h('dt', null, '引语'), h('dd', null, card.quotes.map(quote => h('blockquote', { key: quote }, quote)))) : null,
            temporal.participants?.length ? h(React.Fragment, null, h('dt', null, '参与者'), h('dd', null, temporal.participants.join('、'))) : null,
            card.tags?.length ? h(React.Fragment, null, h('dt', null, '标签'), h('dd', null, card.tags.join(' · '))) : null)),
        fullContent && onSelect && !unavailable ? null : h('div', { className: 'sg-dup-card-footer' }, fullContent && onSelect ? null : h('button', { type: 'button', className: 'sg-dup-button', 'aria-expanded': showSource, onClick: toggleSource }, showSource ? '收起来源，返回对比' : '查看 ' + (card.sourceMessageIds?.length || 0) + ' 条来源与完整记忆'), unavailable ? h('small', null, unavailable) : null),
        fullContent && onSelect ? h('p', { className: 'sg-dup-selection-result' }, !selectionMade ? '点击保留这张记忆' : selected ? '确认后保留这张' : '确认后将这张归档 · 原文和来源仍保留') : null,
        showSource || fullContent && onSelect ? h(React.Fragment, null, h(DuplicateEvidence, { namespace, card, hideSummary: fullContent }), showSource ? h('button', { type: 'button', className: 'sg-dup-button text', onClick: toggleSource }, '收起来源，返回对比') : null) : null)
    }

    function DuplicatePair({ item, busy, namespace, onResolve, onPrepareDraft, onTakeOver, draftState, onDraftState }) {
      const [selectedId, setSelectedId] = React.useState(draftState?.selectedId || '')
      const [mode, setMode] = React.useState(draftState?.mode || '')
      const [draft, setDraft] = React.useState(draftState?.draft || item.draft || { title: '', summary: '' })
      const [draftError, setDraftError] = React.useState('')
      const [draftBusy, setDraftBusy] = React.useState(false)
      const [dirty, setDirty] = React.useState(Boolean(draftState?.dirty))
      const [regenerate, setRegenerate] = React.useState(false)
      const [saveError, setSaveError] = React.useState('')
      const [draftOrigin, setDraftOrigin] = React.useState(draftState?.draftOrigin || (item.draft ? 'AI 合并稿 · 请核对' : '手动填写合并稿'))
      const stageHeading = React.useRef(null)
      React.useEffect(() => { onDraftState?.({ selectedId, mode, draft, draftOrigin, dirty }) }, [selectedId, mode, draft, draftOrigin, dirty])
      React.useEffect(() => { if (mode) { stageHeading.current?.focus({ preventScroll: true }); stageHeading.current?.scrollIntoView({ block: 'nearest' }) } }, [mode])
      const archived = item.outcome === 'merged' || item.outcome === 'selected'
      const retained = item.outcome === 'kept' && (item.aiResolved || item.userReviewed)
      const done = archived || retained
      const awaitingAI = item.outcome === 'pending'
      const selected = selectedId === item.leftId ? item.left : selectedId === item.rightId ? item.right : null
      const letter = selectedId === item.leftId ? 'A' : 'B'
      // Storage identity is an implementation detail; a merge never asks the user to choose a primary.
      const mergeId = item.recommendedKeepId || (item.choices?.right?.canMerge ? item.rightId : item.leftId)
      const mergeCard = mergeId === item.leftId ? item.left : item.right
      const selection = item.choices?.[selectedId === item.leftId ? 'left' : 'right']
      const draftValid = Boolean(draft.title.trim() && draft.summary.trim())
      const generateDraft = async (force = false) => {
        if (dirty && !force) { setRegenerate(true); return }
        setRegenerate(false); setDraftBusy(true); setDraftError('')
        try {
          const result = await onPrepareDraft(item, force)
          if (!result?.draft) throw new Error('AI 尚未生成完整稿，你可以手动填写或稍后重试。')
          setDraft(result.draft); setDirty(false); setDraftOrigin('AI 合并稿 · 请核对')
        } catch (reason) {
          setDraftError(String(reason.message || reason).replace(/\s*[（(]duplicates[）)]$/, ''))
        } finally { setDraftBusy(false) }
      }
      const start = value => {
        setMode(value); setSaveError('')
        if (value === 'select') setSelectedId('')
        if (value === 'merge' && !draft.title && !draft.summary && onPrepareDraft) void generateDraft()
      }
      const save = async () => {
        setSaveError('')
        try { await onResolve(mode === 'both' ? 'keep' : mode, item, mode === 'select' ? selectedId : mode === 'merge' ? mergeId : undefined, mode === 'merge' ? draft : undefined) }
        catch (reason) { setSaveError('你的选择和编辑已保留。' + String(reason.message || reason).replace(/\s*[（(]duplicates[）)]$/, '')) }
      }
      const cards = (selectable = false, originals = false) => h('div', { className: 'sg-dup-comparison', role: selectable ? 'radiogroup' : undefined, 'aria-label': selectable ? '选择要保留的记忆' : '双方完整记忆' },
        [originals ? item.originalLeft || item.left : item.left, originals ? item.originalRight || item.right : item.right].map((card, i) => h(DuplicateCard, {
          key: card?.id || i, card, letter: i ? 'B' : 'A', namespace, fullContent: true,
          selected: selectable && selectedId === card?.id, selectionMade: Boolean(selectedId),
          onSelect: selectable ? () => { setSelectedId(i ? item.rightId : item.leftId); setSaveError('') } : null,
          disabled: busy || draftBusy, unavailable: selectable ? item.choices?.[i ? 'right' : 'left']?.selectBlockedReason : '' })))
      const back = () => { setMode(''); setSaveError(''); setRegenerate(false) }
      const result = done && item.keepId === item.leftId ? item.left : item.right
      const consequences = h('section', { className: 'sg-dup-consequences' }, h('h3', null, '确认后会发生什么'),
        h('dl', { className: 'sg-dup-result' },
          h('dt', null, '日常检索'), h('dd', null, mode === 'merge' ? '显示上面的完整合并稿。' : mode === 'both' ? '两张记忆分别保留，内容和来源不变。' : '只显示记忆 ' + letter + ' · ' + (selected?.title || '')),
          h('dt', null, '原始记录'), h('dd', null, mode === 'merge' ? '双方处理前的内容、来源和历史关联保留，可在已处理记录中核对。' : mode === 'both' ? '双方原卡均保留。' : '记忆 ' + (letter === 'A' ? 'B' : 'A') + ' 转入历史；独有内容不会合入所选卡，原文和来源仍保留。'),
          mode === 'merge' && mergeCard?.temporal?.happenedStart ? h(React.Fragment, null, h('dt', null, '日期'), h('dd', null, '检索日期沿用 ' + mergeCard.temporal.happenedStart + '；请核对正文中的原安排、后续变化与当前事实。')) : null,
          h('dt', null, '后续调整'), h('dd', null, '可在“已处理”查看结果；没有后续冲突时可撤销。')))
      return h('section', { className: 'sg-dup-pair', 'aria-label': '记忆对比与处理', 'aria-busy': busy || draftBusy },
        h('nav', { className: 'sg-dup-steps', 'aria-label': '处理步骤' }, ['对比记忆', '核对结果', '完成'].map((label, i) => h('span', { key: label, 'aria-current': (done ? 2 : mode ? 1 : 0) === i ? 'step' : undefined }, (i + 1) + ' ' + label))),
        done ? h(React.Fragment, null,
          h('h3', { className: 'sg-dup-stage-title' }, archived ? item.outcome === 'merged' ? '已整理成一张完整记忆' : '已保留记忆 ' + (item.keepId === item.leftId ? 'A' : 'B') : '已分别保留两张记忆'),
          h('p', { className: 'sg-dup-reason' }, item.aiResolved ? '由 AI 自动处理 · ' + item.reason : item.reason),
          archived ? h(React.Fragment, null, h('div', { className: 'sg-dup-result-card' }, h('small', null, '今后使用的记忆'), h('h3', null, result?.title), h('p', { className: 'sg-dup-summary' }, result?.summary)),
            h('details', null, h('summary', null, item.originalLeft && item.originalRight ? '查看处理前的两张记忆与来源' : '查看两张记忆与来源（按当前记录）'), cards(false, true))) : cards(),
          h('div', { className: 'sg-dup-actions' }, h('p', null, '撤销前会检查后续变化，避免覆盖新数据。'),
            item.undoId ? h('button', { type: 'button', className: 'sg-dup-button', disabled: busy, onClick: () => onResolve('undo', item).catch(() => {}) }, '撤销本次处理')
              : retained ? h('button', { type: 'button', className: 'sg-dup-button', disabled: busy, onClick: () => onTakeOver?.(item) }, '重新处理这组') : h('p', null, '此记录创建于支持撤销之前。'))) : awaitingAI ? h(React.Fragment, null,
          h('div', { className: 'sg-dup-reason' }, h('strong', null, 'AI 会先判断这组记忆'), h('p', null, '判断明确的自动处理并留下记录；不确定或处理失败的，才会进入“需要你判断”。两张原卡目前均保留。'), h('button', { type: 'button', className: 'sg-dup-button', disabled: busy, onClick: () => onTakeOver(item) }, '我来处理这组')), cards()) : !mode ? h(React.Fragment, null,
          h('p', { className: 'sg-dup-reason' }, h('strong', null, '为什么需要你判断'), item.reason), cards(), h('h3', { className: 'sg-dup-stage-title' }, '你希望怎么处理？'),
          h('div', { className: 'sg-dup-options' }, [['merge', '合并双方内容', 'AI 整理完整稿，你可以编辑后再确认。'], ['select', '只保留一张', '查看完整内容，选择 A 或 B，另一张转入历史。'], ['both', '保留两张', '分别保留，结束这组整理。']].map(([value, title, description]) => h('button', { key: value, type: 'button', className: 'sg-dup-option', disabled: busy || draftBusy, onClick: () => start(value) }, h(DuplicateIcon, { kind: value === 'merge' ? 'merge' : 'cards' }), h('strong', null, title), h('span', null, description)))),
          h('p', { className: 'sg-dup-constraint' }, '选择后先核对处理结果，确认保存前不会改动原卡。')) : h(React.Fragment, null,
          h('button', { type: 'button', className: 'sg-dup-button text sg-dup-back', disabled: busy || draftBusy, onClick: back }, h(DuplicateIcon, { kind: 'back', size: 14 }), '返回对比'),
          h('div', { className: 'sg-dup-stage-heading' }, h('h3', { ref: stageHeading, tabIndex: -1 }, mode === 'merge' ? '把双方信息整理成一张记忆' : mode === 'select' ? '只保留哪张记忆？' : '分别保留这两张记忆'), h('p', null, mode === 'merge' ? '双方有效信息会整理进完整稿，保存前你可以修改标题和正文。' : mode === 'select' ? '两张完整内容都在下方，点击要保留的卡片。另一张转入历史，内容不会自动合并。' : '适用于不同事件、前后进展，或暂时无法确认的情况。')),
          mode === 'merge' ? h(React.Fragment, null,
            item.historyNotice || item.mergeWarning ? h('p', { className: 'sg-dup-reason' }, item.historyNotice || item.mergeWarning) : null,
            !item.canMerge && item.mergeBlockedReason ? h('p', { className: 'sg-dup-notice error', role: 'note' }, item.mergeBlockedReason, ' 仍可在下方整理草稿，原卡不会自动改动。') : null,
            h('div', { className: 'sg-dup-editor' },
              h('div', { className: 'sg-dup-draft-heading' }, h('strong', null, draftBusy ? 'AI 正在整理合并稿…' : draftOrigin), h('button', { type: 'button', className: 'sg-dup-button', disabled: busy || draftBusy, onClick: () => generateDraft(!dirty) }, '重新让 AI 整理')),
              regenerate ? h('div', { className: 'sg-dup-reason' }, '重新生成会替换你当前编辑的标题和正文。', h('div', { className: 'sg-dup-actions' }, h('button', { type: 'button', className: 'sg-dup-button', onClick: () => setRegenerate(false) }, '保留当前编辑'), h('button', { type: 'button', className: 'sg-dup-button', onClick: () => generateDraft(true) }, '替换为新稿'))) : null,
              draftError ? h('p', { role: 'alert', className: 'sg-dup-notice error' }, draftError, ' 原卡未改动，可直接填写下方完整记忆。') : null,
              draftBusy ? h('div', { className: 'sg-dup-draft-skeleton', role: 'status', 'aria-label': '正在生成合并稿' }, [1, 2, 3, 4].map(i => h('span', { key: i }))) : h(React.Fragment, null,
                h('label', null, '合并后的标题', h('input', { type: 'text', 'aria-label': '合并后的标题', value: draft.title, maxLength: 200, disabled: busy, onChange: event => { setDraft({ ...draft, title: event.target.value }); setDirty(true); setDraftOrigin('你已编辑') } })),
                h('label', null, '合并后的完整正文', h('textarea', { 'aria-label': '合并后的完整正文', value: draft.summary, maxLength: 12000, rows: 8, disabled: busy, placeholder: '写出你希望今后记住的完整内容，保留时间、条件和不确定性。', onChange: event => { setDraft({ ...draft, summary: event.target.value }); setDirty(true); setDraftOrigin('你已编辑') } })),
                h('p', { className: 'sg-dup-constraint' }, draftValid ? '将按此全文保存，原始证据另行保留。' : '请填写完整标题和正文后再保存。'))),
            h('details', null, h('summary', null, '展开双方原卡，核对合并稿'), cards())) : cards(mode === 'select'),
          mode === 'select' && selected?.status === 'superseded' ? h('p', { className: 'sg-dup-reason', role: 'note' }, '你选择的是历史版本 ' + letter + '。保存后它会重新成为有效记忆，另一张的新增内容不会合入；请确认这符合你的意思。') : null,
          mode === 'select' && selected && selection?.selectBlockedReason ? h('p', { className: 'sg-dup-notice error', role: 'note' }, selection.selectBlockedReason) : null,
          mode !== 'select' || selected ? consequences : h('p', { className: 'sg-dup-constraint' }, '尚未选择。请对比上方完整内容，再选择保留 A 或 B。'),
          saveError ? h('p', { className: 'sg-dup-notice error', role: 'alert' }, saveError) : null,
          h('div', { className: 'sg-dup-actions' }, h('p', null, '只有确认保存，才会更新记忆。'), h('div', null,
            h('button', { type: 'button', className: 'sg-dup-button', disabled: busy || draftBusy, onClick: back }, '返回对比'),
            h('button', { type: 'button', className: 'sg-dup-button primary', disabled: busy || draftBusy || mode === 'merge' && !draftValid || mode === 'select' && !selected, onClick: save }, busy ? '正在保存…' : saveError ? '重试保存' : mode === 'merge' ? '确认保存合并稿' : mode === 'both' ? '确认保留两张' : selected ? '确认只保留 ' + letter : '请选择 A 或 B')))))
    }

    function DuplicateReviewPage({ namespace, repair, onBack, openEvent, refresh }) {
      const [page, setPage] = React.useState({ items: [], offset: 0, limit: 20, total: 0 })
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const [notice, setNotice] = React.useState('')
      const [loading, setLoading] = React.useState(true)
      const [index, setIndex] = React.useState(0)
      const [queue, setQueue] = React.useState('review')
      const [lastAction, setLastAction] = React.useState(null)
      const draftCache = React.useRef(new Map())
      const focusPair = React.useRef(null)
      const committedRead = React.useRef(false)
      const readFailure = reason => (committedRead.current ? '处理已保存，但读取结果失败。请重新读取结果。' : '') + String(reason.message || reason)
      const requestId = React.useRef(0)
      const load = (offset = 0, targetQueue = queue, focus = focusPair.current) => {
        const id = ++requestId.current
        setLoading(true)
        return api('duplicates', { namespace, offset, limit: 20, queue: targetQueue, ...(focus ? { focusLeft: focus.leftId, focusRight: focus.rightId } : {}) }).then(value => {
          if (id === requestId.current) { setPage(value); setIndex(i => value.focusIndex ?? Math.min(i, Math.max(0, value.items.length - 1))); focusPair.current = null; committedRead.current = false }
        }).finally(() => { if (id === requestId.current) setLoading(false) })
      }
      React.useEffect(() => {
        let active = true
        const id = ++requestId.current
        setLoading(true); setError('')
        const focus = focusPair.current
        void api('duplicates', { namespace, offset: page.namespace === namespace && page.queue === queue ? page.offset : 0, limit: 20, queue, ...(focus ? { focusLeft: focus.leftId, focusRight: focus.rightId } : {}) }).then(value => { if (active && id === requestId.current) { setPage(value); setIndex(i => value.focusIndex ?? (page.namespace === namespace && page.queue === queue ? Math.min(i, Math.max(0, value.items.length - 1)) : 0)); focusPair.current = null; committedRead.current = false } }).catch(reason => { if (active && id === requestId.current) setError(readFailure(reason)) }).finally(() => { if (active && id === requestId.current) setLoading(false) })
        return () => { active = false }
      }, [namespace, queue, JSON.stringify(repair)])
      const pairInput = item => item ? { leftId: item.leftId, rightId: item.rightId, leftFingerprint: item.leftFingerprint, rightFingerprint: item.rightFingerprint, exact: item.exact, similarity: item.similarity } : undefined
      const takeOver = item => {
        setBusy(true); setError('')
        return api('duplicates', { namespace }, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'takeover', pair: pairInput(item) }) })
          .then(() => { focusPair.current = item; setQueue('review'); setNotice('已由你接管，AI 不再自动处理这组。'); return refresh() })
          .catch(reason => setError(String(reason.message || reason))).finally(() => setBusy(false))
      }
      const prepareDraft = (item, regenerate = false) => {
        setBusy(true)
        return api('duplicates', { namespace }, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'draft', pair: pairInput(item), regenerate }) }).finally(() => setBusy(false))
      }
      const control = (action, item, keepId, draft) => {
        let committed = false
        setBusy(true); setError(''); setNotice('')
        const pair = item ? { leftId: item.leftId, rightId: item.rightId, leftFingerprint: item.leftFingerprint,
          rightFingerprint: item.rightFingerprint, exact: item.exact, similarity: item.similarity } : undefined
        return api('duplicates', { namespace }, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, pair, keepId, draft, undoId: action === 'undo' ? item?.undoId : undefined }) })
          .then(result => { committed = true; committedRead.current = true; if (action === 'undo') { for (const key of draftCache.current.keys()) { if (key.startsWith(namespace + ':' + item.leftId + ':' + item.rightId + ':')) draftCache.current.delete(key) } focusPair.current = item; setQueue('review') } setLastAction(result.undoId ? { ...item, undoId: result.undoId } : null); if (['merge', 'select', 'keep'].includes(action)) { focusPair.current = item; setQueue('history') } setNotice(action === 'rescan' ? '已重新扫描，AI 会先处理候选。' : action === 'undo' ? '已撤销，恢复了处理前的内容、状态和关联。' : action === 'merge' ? '已保存完整合并稿，双方证据与来源已保留。' : action === 'select' ? '已保留所选记忆，另一张已归档，内容未混合。' : '已确认保留两张。'); return refresh() })
          .then(() => { if (action === 'rescan') setIndex(0); return action === 'undo' ? load(0, 'review', item) : ['merge', 'select', 'keep'].includes(action) ? load(0, 'history', item) : load(action === 'rescan' ? 0 : page.offset) })
          .catch(reason => { if (committed) { setError('处理已保存，但读取结果失败。请重新读取结果。' + String(reason.message || reason)); return } if (!['merge', 'select', 'keep'].includes(action)) setError(String(reason.message || reason)); throw reason })
          .finally(() => setBusy(false))
      }
      const navigate = direction => {
        setError(''); setNotice('')
        if (index + direction >= 0 && index + direction < page.items.length) { setIndex(index + direction); return }
        const id = ++requestId.current
        setLoading(true)
        void api('duplicates', { namespace, offset: Math.max(0, page.offset + direction * page.limit), limit: 20, queue }).then(value => {
          if (id === requestId.current) { setPage(value); setIndex(direction > 0 ? 0 : Math.max(0, value.items.length - 1)) }
        }).catch(reason => { if (id === requestId.current) setError(String(reason.message || reason)) }).finally(() => { if (id === requestId.current) setLoading(false) })
      }
      const current = page.items[Math.min(index, Math.max(0, page.items.length - 1))]
      const draftKey = current ? namespace + ':' + current.leftId + ':' + current.rightId + ':' + current.leftFingerprint + ':' + current.rightFingerprint : ''
      return h(React.Fragment, null,
        h(BackBar, { label: '更多', onBack }),
        h('div', { className: 'sg-duplicates' },
          h('header', { className: 'sg-dup-heading' }, h('div', null, h('h2', null, '重复记忆整理'), h('p', null, 'AI 先判断并整理。这里只需要你处理拿不准的记忆。')), h(DuplicateIcon, { size: 25 })),
          h('nav', { className: 'sg-dup-queues', 'aria-label': '整理队列' }, [['review', '需要你判断', repair?.needsReview || 0], ['ai', '等待 AI', repair?.awaitingAI || 0], ['history', '已处理', (repair?.merged || 0) + (repair?.selected || 0) + (repair?.retained || 0) - (repair?.needsReview || 0) + (repair?.failed || 0)]].map(([value, label, count]) => h('button', { key: value, type: 'button', className: 'sg-dup-button', 'aria-pressed': queue === value, disabled: busy, onClick: () => { setQueue(value); setError(''); setIndex(0) } }, label + ' ' + Math.max(0, count)))),
          error ? h('div', { role: 'alert', className: 'sg-dup-notice error' }, error, h('button', { type: 'button', className: 'sg-dup-button text', disabled: busy || loading, onClick: () => { setError(''); void load(page.offset).catch(reason => setError(readFailure(reason))) } }, '重新读取')) : null,
          notice ? h('div', { role: 'status', className: 'sg-dup-notice', 'aria-live': 'polite' }, notice, lastAction ? h('button', { type: 'button', className: 'sg-dup-button', disabled: busy, onClick: () => void control('undo', lastAction).catch(() => {}) }, '撤销本次处理') : null) : null,
          !error && (loading || page.namespace !== namespace || page.queue !== queue) ? h('div', { className: 'sg-dup-comparison', role: 'status', 'aria-label': '正在读取重复记忆' }, h('div', { className: 'sg-dup-skeleton' }), h('div', { className: 'sg-dup-skeleton' }))
            : current && page.namespace === namespace && page.queue === queue ? h(React.Fragment, null,
              h('nav', { className: 'sg-dup-navigation', 'aria-label': '切换候选组' },
                h('button', { type: 'button', className: 'sg-dup-button', 'aria-label': '上一组', disabled: busy || page.offset + index <= 0, onClick: () => navigate(-1) }, h(DuplicateIcon, { kind: 'back', size: 14 })),
                h('select', { value: index, disabled: busy, onChange: event => { setIndex(Number(event.target.value)); setNotice('') }, 'aria-label': '当前候选组' }, page.items.map((item, i) => h('option', { key: item.leftId + ':' + item.rightId, value: i }, item.left?.title || item.right?.title || '原卡已不可用'))),
                h('span', { className: 'sg-dup-count' }, (page.offset + index + 1) + ' / ' + page.total),
                h('button', { type: 'button', className: 'sg-dup-button', 'aria-label': '下一组', disabled: busy || page.offset + index + 1 >= page.total, onClick: () => navigate(1) }, h(DuplicateIcon, { kind: 'next', size: 14 }))),
              h(DuplicatePair, { key: namespace + current.leftId + current.rightId + current.leftFingerprint + current.rightFingerprint + current.outcome + Boolean(current.userReviewed), item: current, busy, namespace, onResolve: control, onPrepareDraft: prepareDraft, onTakeOver: takeOver, draftState: draftCache.current.get(draftKey), onDraftState: value => { draftCache.current.set(draftKey, value); if (draftCache.current.size > 50) draftCache.current.delete(draftCache.current.keys().next().value) } }))
              : !error ? h('section', { className: 'sg-dup-empty' }, h(DuplicateIcon, { kind: 'check', size: 28 }), h('strong', null, queue === 'review' ? '暂时没有需要你判断的记忆' : queue === 'ai' ? '没有等待 AI 的候选' : '还没有处理记录'), h('p', null, queue === 'review' ? 'AI 能处理的会自动完成。你可以在“已处理”查看结果。' : '扫描和处理进度会在对应队列中显示。')) : null,
          h('details', { className: 'sg-dup-tools' }, h('summary', null, '重新检查记忆库'), h('p', null, '按当前规则重新扫描。后续判断可能使用当前模型，已完成的扫描不会在每次启动时重复执行。'),
            h('button', { type: 'button', className: 'sg-dup-button', disabled: busy || loading, onClick: () => void control('rescan').catch(() => {}) }, '重新扫描与判断'))))
    }

    function SystemPage({ selected, blocks, onBack, backLabel = '更多', refresh, onDuplicates }) {
      const processing = blocks.filter((block) => block.status === 'processing').length
      const [refreshing, setRefreshing] = React.useState(false)
      const [feedback, setFeedback] = React.useState({ kind: '', text: '' })
      const repair = selected.duplicateRepair
      const checkStatus = () => {
        const before = processingFingerprint(selected)
        setRefreshing(true)
        setFeedback({ kind: '', text: '正在读取…' })
        return refresh({ propagateError: true }).then((next) => {
          const updated = next?.overview?.namespaces?.find((item) => item.namespace === selected.namespace)
          setFeedback({ kind: 'done', text: updated && processingFingerprint(updated) !== before ? '状态已更新' : '状态没有变化' })
        }).catch((reason) => {
          setFeedback({ kind: 'failed', text: '读取失败：' + String(reason?.message || reason) })
        }).finally(() => setRefreshing(false))
      }
      return h(React.Fragment, null, h(BackBar, { label: backLabel, onBack }), h('div', { className: 'sg-intro' }, h('h2', null, '系统状态'), h('p', null, '仅在这里展示记忆处理的工程状态')), h('div', { className: 'sg-pipeline' },
        [['Block 数量', selected.blocks], ['待处理任务', processing], ['失败任务', selected.failedJobs], ['最近整理时间', formatTime(selected.lastActivityAt)], ['Event 提取', selected.failedJobDetails?.some((item) => item.kind === 'event-extraction') ? '有失败' : '正常'], ['图谱投影', selected.failedJobDetails?.some((item) => item.kind === 'graph-projection') ? '有失败' : '正常']].map(([label, value]) => h('div', { key: label, className: 'sg-stage' }, h('span', null, label), h('span', { className: 'sg-stage-value ' + (label === '失败任务' && value ? 'failed' : 'waiting') }, String(value))))),
        repair ? h('p', { className: 'sg-setting-note', role: 'status' }, '历史重复记忆整理' + (repair.status === 'completed' ? '已完成' : '进行中') + '：已扫描 ' + repair.scannedEvents + ' 张卡，归档重复卡 ' + repair.merged + ' 张；其余保留。' + (repair.failed ? ' 部分判断未完成，原卡已保留。' : '')) : null,
        h('button', { type: 'button', className: 'sg-quiet-button', onClick: onDuplicates }, '查看重复候选与处理原因'),
        h('button', { type: 'button', className: 'sg-quiet-button', disabled: refreshing, onClick: () => void checkStatus(), style: { marginTop: '14px' } }, refreshing ? '↻ 正在读取…' : '↻ 重新检查'), feedback.text ? h('p', { className: 'sg-status-feedback ' + feedback.kind, role: feedback.kind === 'failed' ? 'alert' : 'status' }, feedback.text) : null)
    }

    function AuditPage({ audit, auditPage, namespace, onBack, backLabel = '更多' }) {
      const pagedAudit = usePagedMemory({ namespace, kind: 'audit', initialItems: audit, initialPage: auditPage, fallbackLimit: 100 })
      return h(React.Fragment, null,
        h(BackBar, { label: backLabel, onBack }),
        h('div', { className: 'sg-intro' }, h('h2', null, '使用记录'), h('p', null, '长期记忆被使用的时间与来源')),
        pagedAudit.items.length ? pagedAudit.items.map((item) => { const value = item.audit || {}; return h('details', { key: item.id, className: 'sg-audit' }, h('summary', null, h('strong', null, '使用了 ' + ((item.events || []).length + (item.elements || []).length) + ' 条记忆'), h('span', { className: 'sg-muted' }, ' · ' + formatTime(item.createdAt))), h('div', { className: 'sg-audit-body' }, h('div', null, (item.events || []).map((event) => event.title).join('、') || (item.elements || []).map((element) => element.name).join('、') || '旧版使用记录'), h('div', { className: 'sg-tech-row sg-audit-evidence' }, h('span', { className: 'sg-muted' }, '来源会话'), h('span', { className: 'sg-code' }, value.sessionId || '未记录')), value.turn !== undefined ? h('div', { className: 'sg-tech-row' }, h('span', { className: 'sg-muted' }, 'Turn'), h('span', null, value.turn)) : null)) }) : h(Empty, { title: '还没有使用记录', copy: 'AI 在回答中采用长期记忆后会记录在这里。' }),
        h(Pagination, { page: pagedAudit.page, loading: pagedAudit.loading, error: pagedAudit.error, onOffset: pagedAudit.loadOffset }))
    }

    function RawPage({ data, selected, onBack, backLabel = '更多' }) {
      const groups = [['Block raw', data.blocks, data.pagination?.blocks?.total], ['Event raw', data.events, data.pagination?.events?.total], ['Graph raw', data.graph], ['Usage raw', data.audit, data.pagination?.audit?.total], ['模型响应', selected.successfulModelResponses || []]]
      return h(React.Fragment, null, h(BackBar, { label: backLabel, onBack }), h('div', { className: 'sg-intro' }, h('h2', null, '原始数据'), h('p', null, '供排查问题使用的内部字段与 JSON')), groups.map(([label, value, total]) => h('details', { key: label, className: 'sg-raw-group' }, h('summary', null, label + ' (' + (Array.isArray(value) && Number(total) > value.length ? '已加载 ' + value.length + ' / 共 ' + total : Array.isArray(value) ? value.length : ((value.nodes?.length || 0) + (value.edges?.length || 0))) + ')'), h('pre', { className: 'sg-raw-json sg-code' }, JSON.stringify(value, null, 2)))))
    }

    // Grouped like the design list. Display labels became plain questions;
    // field keys and backend ordering are untouched.
    const profileGroups = [
      ['称呼与语言', [['userPreferredName', '怎么称呼你', 100], ['assistantPreferredName', '助手叫什么', 100], ['preferredLanguage', '回答用什么语言', 100], ['reasoningLanguage', '思考过程用什么语言', 100]]],
      ['地点', [['defaultLocation', '常驻地址', 200], ['currentCity', '现在在哪', 100], ['homeCity', '常驻城市（原有字段）', 100]]],
      ['怎么回答你', [['responsePreferences', '回复方式', 1000], ['standingInstructions', '一直要遵守的要求', 1000]]],
      ['关于你', [['userBackground', '背景', 1500], ['longTermGoals', '长期目标', 1000]]],
      ['其他', [['persistentNotes', '其他要一直记住的', 1200]]],
    ]
    const PROFILE_EMPTY_HINTS = {
      userPreferredName: '未设置 · 例如：小程',
      assistantPreferredName: '未设置 · 例如：橙子',
      preferredLanguage: '未设置 · 例如：中文',
      reasoningLanguage: '未设置 · 例如：中文',
      responsePreferences: '未设置 · 例如：先给结论，再展开',
      standingInstructions: '未设置 · 例如：改代码前先说方案',
      defaultLocation: '未设置 · 例如：北京市海淀区',
      currentCity: '未设置 · 例如：上海',
      homeCity: '未设置 · 例如：杭州',
      userBackground: '未设置 · 例如：软件工程师，熟悉 Python',
      longTermGoals: '未设置 · 例如：今年完成一篇论文',
      persistentNotes: '未设置 · 例如：项目统一使用 pnpm',
    }
    const profileFieldNames = profileGroups.flatMap(([, fields]) => fields.map(([field]) => field))
    const PROFILE_LIMIT_DEFAULT = 6000
    const PROFILE_LIMIT_MIN = 2000
    const PROFILE_LIMIT_MAX = 12000
    // Unknown future keys are fine: only the four string fields and revision
    // map are required. `_limits` is optional so an older backend still renders.
    const profileTotalLimit = (value) => {
      const candidate = Number(value?._limits?.totalMaxLength)
      return Number.isSafeInteger(candidate) && candidate > 0 ? candidate : PROFILE_LIMIT_DEFAULT
    }
    const profileTotalLength = (value) => profileFieldNames.reduce((sum, field) => sum + Array.from(value?.[field] || '').length, 0)
    // Fixed two-column layout. Left stack: 称呼与语言 + 地点. Right stack:
    // 怎么回答你 + 关于你 + 其他. Each column is its own flex stack so groups
    // no longer share one grid row (the old rule overlapped them).
    const profileRightColumn = new Set(['怎么回答你', '关于你', '其他'])
    const formatCount = (value) => Number(value || 0).toLocaleString('en-US')
    function sameProfile(left, right) {
      return profileFieldNames.every((field) => left?.[field] === right?.[field] && left?._revisions?.[field] === right?._revisions?.[field])
        && profileTotalLimit(left) === profileTotalLimit(right)
    }

    function ProfilePage() {
      const [profile, setProfile] = usePageMemoryState(profilePageMemory, 'profile', null)
      const [editing, updateEditing] = usePageMemoryState(profilePageMemory, 'editing', null)
      const setEditing = (update) => {
        const previous = profilePageMemory.get('editing')
        const next = typeof update === 'function' ? update(previous) : update
        if (next) profileFieldDrafts.set(next.field, next)
        else if (previous) profileFieldDrafts.delete(previous.field)
        updateEditing(next)
      }
      const [saving, setSaving] = React.useState(false)
      const [syncStatus, setSyncStatus] = React.useState('更新中…')
      const [error, setError] = React.useState('')
      const [conflicts, setConflicts] = usePageMemoryState(profilePageMemory, 'conflicts', {})
      const conflict = Boolean(conflicts[editing?.field])
      const setConflict = (value, field = profilePageMemory.get('editing')?.field) => {
        if (field) setConflicts((current) => ({ ...current, [field]: value }))
      }
      const [saveResults, setSaveResults] = usePageMemoryState(profilePageMemory, 'saveResults', {})
      const [reading, setReading] = React.useState(false)
      const session = React.useRef(0)
      const action = React.useRef(null)
      const actionTimeout = React.useRef(null)
      const readController = React.useRef(null)
      const savedTimers = React.useRef(new Map())
      const requestVersion = React.useRef(0)
      const refreshRef = React.useRef(null)
      const clearSavedTimer = (field) => {
        window.clearTimeout(savedTimers.current.get(field))
        savedTimers.current.delete(field)
      }
      const showSaved = (submission) => {
        clearSavedTimer(submission.field)
        setSaveResults((current) => ({ ...current, [submission.field]: { kind: 'saved', submission, flash: true } }))
        const timer = window.setTimeout(() => {
          if (savedTimers.current.get(submission.field) !== timer) return
          savedTimers.current.delete(submission.field)
          setSaveResults((current) => current[submission.field]?.submission === submission ? { ...current, [submission.field]: { ...current[submission.field], flash: false } } : current)
        }, 2000)
        savedTimers.current.set(submission.field, timer)
      }
      React.useEffect(() => {
        let active = true
        let timer = null
        let controller = null
        const stopRequest = () => { if (controller) controller.abort(); controller = null; readController.current = null }
        const check = ({ valid = () => true, onResult } = {}) => {
          if (!active || document.hidden) return
          if (timer !== null) window.clearTimeout(timer)
          timer = null
          stopRequest()
          if (action.current) { timer = window.setTimeout(check, 5000); return }
          const version = ++requestVersion.current
          const requestController = new AbortController()
          controller = requestController
          readController.current = requestController
          return api('profile', {}, { method: 'GET', signal: requestController.signal }).then((latest) => {
            if (!active || document.hidden || version !== requestVersion.current || !valid()) return
            if (!profileFieldNames.every((field) => typeof latest?.[field] === 'string') || !latest?._revisions) throw new Error('画像读取响应不完整')
            setProfile((current) => sameProfile(current, latest) ? current : latest)
            setSyncStatus('已是最新')
            setError('')
            onResult?.(latest)
          }).catch((reason) => {
            if (active && version === requestVersion.current && valid() && reason?.name !== 'AbortError') { setSyncStatus('读取失败'); setError(String(reason?.message || reason)) }
          }).finally(() => {
            if (controller === requestController) { controller = null; readController.current = null }
            if (active && !document.hidden && version === requestVersion.current) timer = window.setTimeout(check, 5000)
          })
        }
        refreshRef.current = check
        const onVisibilityChange = () => {
          if (timer !== null) window.clearTimeout(timer)
          timer = null
          if (document.hidden) { ++requestVersion.current; stopRequest() }
          else check()
        }
        document.addEventListener('visibilitychange', onVisibilityChange)
        check()
        return () => {
          const submission = action.current?.submission
          if (submission && !profilePageMemory.get('saveResults')?.[submission.field]) setSaveResults((current) => ({ ...current, [submission.field]: { kind: 'unknown', submission } }))
          active = false; ++session.current; ++requestVersion.current; refreshRef.current = null
          if (timer !== null) window.clearTimeout(timer)
          stopRequest(); action.current?.abort(); action.current = null
          window.clearTimeout(actionTimeout.current); actionTimeout.current = null
          savedTimers.current.forEach((id) => window.clearTimeout(id)); savedTimers.current.clear()
          setSaveResults((current) => Object.fromEntries(Object.entries(current).map(([field, result]) => [field, result.kind === 'saved' ? { ...result, flash: false } : result])))
          document.removeEventListener('visibilitychange', onVisibilityChange)
        }
      }, [])
      const resetEdit = (field) => {
        ++session.current; ++requestVersion.current; readController.current?.abort()
        setReading(false)
        if (field) {
          setConflict(false, field)
          clearSavedTimer(field)
          setSaveResults((current) => { const next = { ...current }; delete next[field]; return next })
        }
        refreshRef.current?.()
      }
      const beginEdit = (field) => { resetEdit(profileFieldDrafts.has(field) ? undefined : field); setEditing(profileFieldDrafts.get(field) || { field, draft: profile[field] || '', baseValue: profile[field] || '', baseRevision: profile._revisions?.[field] || 0 }) }
      const reloadField = () => {
        if (!editing || saving || reading) return
        const id = session.current
        setReading(true)
        refreshRef.current?.({ valid: () => session.current === id, onResult: (latest) => {
          setEditing((current) => current ? { ...current, draft: latest[current.field], baseValue: latest[current.field], baseRevision: latest._revisions[current.field] } : null)
          setConflict(false)
          setSaveResults((current) => { const next = { ...current }; delete next[editing.field]; return next })
        } })?.finally(() => { if (session.current === id) setReading(false) })
      }
      const save = () => {
        if (!editing || action.current || saving || reading || saveResults[editing.field]?.kind === 'unknown') return
        if (conflict || profile[editing.field] !== editing.baseValue || profile._revisions?.[editing.field] !== editing.baseRevision) { setConflict(true); return }
        const submission = { ...editing }
        const id = session.current
        const controller = new AbortController()
        controller.submission = submission
        action.current = controller
        const valid = () => session.current === id && action.current === controller
        setSaving(true)
        setSaveResults((current) => { const next = { ...current }; delete next[submission.field]; return next })
        ++requestVersion.current
        readController.current?.abort()
        const timeout = window.setTimeout(() => controller.abort(), 15000)
        actionTimeout.current = timeout
        void api('profile', {}, { method: 'PATCH', signal: controller.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ field: submission.field, value: submission.draft, expectedValue: submission.baseValue, expectedRevision: submission.baseRevision }) })
          .then((result) => {
            if (!valid()) return
            if (!profileFieldNames.every((field) => typeof result?.snapshot?.[field] === 'string') || !Number.isSafeInteger(result.snapshot?._revisions?.[submission.field])) throw new Error('画像保存响应不完整')
            setProfile(result.snapshot); setEditing(null); setConflict(false, submission.field); showSaved(submission)
          })
          .catch((reason) => {
            if (!valid()) return
            const message = String(reason?.message || reason)
            if (reason?.status === 409 || message.includes('刚刚在其他位置更新')) { setConflict(true); return }
            // A transport failure (including a gateway timeout) may follow a committed write.
            const unknown = !reason?.status || [408, 502, 504].includes(reason.status)
            const invalid = [400, 413, 422].includes(reason?.status)
            const maximum = profileGroups.flatMap(([, fields]) => fields).find(([field]) => field === submission.field)?.[2]
            const detail = /Persistent Profile exceeds/.test(message) ? '画像总字符数不能超过 6000，请缩短内容。'
              : /exceeds \d+ characters/.test(message) ? '此字段不能超过 ' + maximum + ' 个字符，请缩短内容。' : message
            setSaveResults((current) => ({ ...current, [submission.field]: { kind: unknown ? 'unknown' : invalid ? 'invalid' : 'failed', submission, detail } }))
          })
          .finally(() => {
            window.clearTimeout(timeout)
            if (actionTimeout.current === timeout) actionTimeout.current = null
            if (valid()) { action.current = null; setSaving(false); refreshRef.current?.() }
          })
      }
      const checkSave = (result) => {
        if (reading || action.current) return
        const id = session.current
        const { submission } = result
        setReading(true)
        refreshRef.current?.({ valid: () => session.current === id, onResult: (latest) => {
          // Revisions are global audit IDs, not consecutive counters for each field.
          // Confirm the submitted content is persisted; retain any newer local draft.
          if (latest[submission.field] === submission.draft && Number.isSafeInteger(latest._revisions[submission.field]) && latest._revisions[submission.field] > submission.baseRevision) {
            showSaved(submission)
            setEditing((current) => current?.field === submission.field ? current.draft === submission.draft ? null : { ...current, baseValue: latest[submission.field], baseRevision: latest._revisions[submission.field] } : current)
            setConflict(false, submission.field)
          }
        } })?.finally(() => { if (session.current === id) setReading(false) })
      }
      const total = profileTotalLength(profile)
      const limit = profileTotalLimit(profile)
      return h(React.Fragment, null,
        h('div', { className: 'sg-pg-head' }, h('h2', null, '常驻画像'), h('span', { className: 'sg-pg-tag' }, h('i', { className: 'sg-sw ink', 'aria-hidden': 'true' }), '每轮都带给 AI · 点任意一行修改'),
          // “已是最新” is noise; only a real read failure needs the header slot.
          syncStatus === '读取失败' ? h('span', { className: 'sg-pg-end' }, h('span', { className: 'sg-profile-sync failed', role: 'alert' }, syncStatus)) : null),
        error ? h('p', { className: 'sg-profile-error', role: 'alert' }, error) : null,
        profile ? h(React.Fragment, null,
          h('div', { className: 'sg-cap-row' }, h('div', { className: 'sg-cap-bar', role: 'img', 'aria-label': '常驻画像已用 ' + total + ' 字，上限 ' + formatCount(limit) + ' 字' }, h('i', { style: { width: Math.min(100, total / limit * 100) + '%' } })), h('span', { className: 'sg-cap-num' }, h('b', null, formatCount(total)), '/ ' + formatCount(limit) + ' 字')),
          h('div', { className: 'sg-pf' }, [['1', profileGroups.filter(([title]) => !profileRightColumn.has(title))], ['2', profileGroups.filter(([title]) => profileRightColumn.has(title))]].map(([column, groups]) => h('div', { key: column, className: 'sg-pf-col', 'data-pf-stack': column }, groups.map(([title, fields]) => h('section', { key: title, className: 'sg-profile-group', 'aria-label': title },
            h('h4', null, title),
            h('ul', null, fields.filter(([field]) => field !== 'homeCity' || profile.homeCity || profileFieldDrafts.has(field)).map(([field, label, maximum]) => {
              const value = profile[field] || ''
              const isEditing = editing?.field === field
              const changedElsewhere = isEditing && (value !== editing.baseValue || profile._revisions?.[field] !== editing.baseRevision)
              const draftLength = isEditing ? Array.from(editing.draft).length : 0
              const nextTotal = total - Array.from(value).length + draftLength
              const result = saveResults[field]
              const savedReadError = result?.kind === 'saved' && Boolean(error)
              const savedFeedback = result?.kind === 'saved' && result.flash ? h('span', { className: 'sg-profile-saved', role: 'status' }, isEditing && editing.draft !== result.submission.draft ? '上次提交已保存' : '已保存') : null
              const editor = isEditing ? h('div', { className: 'sg-profile-editor' },
                  field === 'userPreferredName' || field === 'assistantPreferredName' || field === 'preferredLanguage' || field === 'reasoningLanguage' || field === 'defaultLocation' || field === 'homeCity' || field === 'currentCity'
                    ? h('input', { id: 'sg-profile-' + field, 'aria-label': label, autoFocus: true, disabled: saving, value: editing.draft, onChange: (event) => setEditing((current) => ({ ...current, draft: event.target.value })) })
                    : h('textarea', { id: 'sg-profile-' + field, 'aria-label': label, autoFocus: true, disabled: saving, value: editing.draft, onChange: (event) => setEditing((current) => ({ ...current, draft: event.target.value })) }),
                  changedElsewhere || conflict ? h('p', { className: 'sg-profile-conflict', role: 'alert' }, '该项刚刚在其他位置更新。', h('button', { type: 'button', className: 'sg-profile-action', disabled: saving || reading, onClick: reloadField }, '放弃草稿并载入最新内容')) : null,
                  // Only a real rejection is red; an unconfirmed write stays neutral
                  // because it may already have been saved.
                  result && ['failed', 'invalid', 'unknown'].includes(result.kind) ? h('div', { className: 'sg-profile-save-feedback sg-profile-save-feedback-' + result.kind, role: result.kind === 'unknown' ? 'status' : 'alert' },
                    h('p', null, result.kind === 'unknown' ? '暂时无法确认是否已保存，输入内容已保留。' : '修改未保存，输入内容已保留。'),
                    result.kind === 'unknown' ? h('button', { type: 'button', className: 'sg-profile-action', disabled: reading, onClick: () => checkSave(result) }, reading ? '检查中…' : '检查保存结果')
                      : result.kind === 'invalid' ? h('p', null, result.detail) : null) : null,
                  h('div', { className: 'sg-profile-editor-foot' }, h('span', { className: 'sg-profile-count' }, formatCount(draftLength) + ' / ' + formatCount(maximum), draftLength > maximum ? '，请缩短至 ' + formatCount(maximum) + ' 个字符以内。' : nextTotal > limit ? '，画像总字符数不能超过 ' + formatCount(limit) + '。' : '', savedFeedback), h('div', { className: 'sg-profile-actions' }, h('button', { type: 'button', className: 'sg-quiet-button', disabled: saving, onClick: () => { resetEdit(field); setEditing(null) } }, '取消编辑'), h('button', { type: 'button', className: 'sg-save-button', disabled: saving || reading || result?.kind === 'unknown' || draftLength > maximum || nextTotal > limit || editing.draft === editing.baseValue || changedElsewhere || conflict, onClick: save }, saving ? '保存中…' : result?.kind === 'failed' ? '重新保存' : '保存')))) : null
              return h('li', { key: field, className: 'sg-profile-row', onClick: isEditing ? undefined : () => { if (!saving) beginEdit(field) } },
                h('div', { className: 'sg-profile-summary' + (isEditing ? ' editing' : '') },
                  h('div', { className: 'sg-profile-label-cell' }, h('span', { className: 'sg-profile-label' }, label),
                    editor || h('span', { className: 'sg-profile-content' }, h('button', { type: 'button', className: 'sg-profile-value ' + (value ? '' : 'empty'), title: value || PROFILE_EMPTY_HINTS[field], 'aria-label': label + (value ? '，点击编辑' : '，未填写，点击填写'), disabled: saving, onClick: (event) => { event?.stopPropagation?.(); beginEdit(field) } }, profileFieldDrafts.has(field) ? '继续编辑草稿' : value || '未填写'), savedFeedback)),
                  isEditing ? null : h('span', { className: 'sg-profile-chev', 'aria-hidden': 'true' }, '›'),
                  h('button', { type: 'button', className: 'sg-profile-action', onClick: (event) => { event?.stopPropagation?.(); beginEdit(field) }, disabled: saving, 'aria-hidden': isEditing || undefined }, !isEditing && profileFieldDrafts.has(field) ? '继续编辑' : value ? '编辑' : '添加')),
                savedReadError ? h('p', { className: 'sg-profile-save-feedback', role: 'status' }, h('span', null, '修改已保存，暂时无法读取最新内容。'), h('button', { type: 'button', className: 'sg-profile-action', disabled: reading, onClick: () => refreshRef.current?.() }, '重新读取')) : null)
            })))))))) : h('p', null, '正在读取常驻画像…'))
    }

    const GRAPH_EXPLANATION = '由于知识图谱功能与事件记录和主题目录有部分重复，还需要额外消耗token维护实体关系，将会默认关闭知识图谱功能，已经生成的图谱数据会保留。'
    const GRAPH_USAGE_HINT = '提示：如需使用，可以在长期记忆页面点击“＋”，打开知识图谱，功能可以正常使用。'
    const GRAPH_CONTROL_STYLES = `.sg-graph-no-reminder{display:inline-flex;align-items:center;min-height:30px;padding:5px 8px;border:1px solid var(--sg-border);border-radius:6px;background:var(--sg-surface);color:var(--sg-muted);cursor:pointer}.sg-graph-no-reminder:hover{border-color:var(--sg-accent);color:var(--sg-accent);background:var(--sg-soft)}.sg-graph-no-reminder:disabled{cursor:not-allowed;opacity:.5}.sg-graph-notice-toggle{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:9px 0;border-top:1px solid var(--sg-border);border-bottom:1px solid var(--sg-border)}.sg-graph-notice-toggle>span{font-size:13px;font-weight:650}.sg-graph-menu{position:relative;z-index:31;display:inline-flex;align-items:center}.sg-long-tabs .sg-graph-menu-trigger{display:grid;place-items:center;align-self:center;flex:none;box-sizing:border-box;width:32px;height:32px;min-width:32px;min-height:32px;padding:0;border:0;border-radius:999px;background:transparent;color:var(--sg-muted);font-size:22px;line-height:1;cursor:pointer}.sg-graph-menu-trigger svg{display:block;width:16px;height:16px;flex:none}.sg-graph-menu-trigger:hover,.sg-graph-menu-trigger[aria-expanded=true]{background:var(--sg-soft);color:var(--sg-accent)}.sg-graph-menu-popover{position:absolute;z-index:32;right:0;left:auto;top:calc(100% + 8px);width:min(300px,calc(100vw - 32px));padding:10px;border:1px solid var(--sg-border);border-radius:10px;background:var(--sg-page);box-shadow:var(--sg-shadow);text-align:left}.sg-graph-menu-title{display:block;padding:0 2px 8px;color:var(--sg-text);font-size:13px;font-weight:650;line-height:1.4}.sg-graph-open{display:block;width:100%;margin-top:8px;padding:6px 2px 2px;border:0;border-top:1px solid var(--sg-border);background:none;color:var(--sg-text);font-size:12.5px;text-align:left;cursor:pointer}.sg-graph-open:hover{color:var(--sg-accent)}.sg-graph-copy{display:block;min-width:0}.sg-graph-copy b{display:block;font-size:13.5px;font-weight:650;color:var(--sg-text)}.sg-graph-copy span{display:block;margin-top:2px;font-size:11.5px;line-height:1.45;color:var(--sg-muted)}.sg-graph-menu-popover .sg-storage-card{padding:0;border:0;background:transparent}.sg-graph-menu-popover .sg-setting-note{font-size:11px;line-height:1.5}.sg-graph-dialog-heading{display:flex;align-items:center;justify-content:space-between;gap:12px}.sg-graph-dialog-heading h3{margin:0}.sg-graph-dialog-control{display:flex;align-items:center;gap:7px;color:var(--sg-muted);font-size:12px}`

    function GraphControlPanel({ state = {}, refresh, page = false, onGraphHidden, onOpenGraph }) {
      const shouldShowNotice = !page && state.enabled !== true && state.noticeSeen !== true
      const [notice, setNotice] = React.useState(shouldShowNotice)
      const [preview, setPreview] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const [hideExplanation, setHideExplanation] = React.useState(false)
      const dialogRef = React.useRef(null)
      React.useEffect(() => { setNotice(!page && state.enabled !== true && state.noticeSeen !== true) }, [page, state.enabled, state.noticeSeen])
      React.useEffect(() => {
        if (!notice && !preview) return
        const previous = document.activeElement
        dialogRef.current?.querySelector('button')?.focus()
        return () => { if (previous?.isConnected) previous.focus?.() }
      }, [notice, preview])
      const control = async (action, token) => {
        setBusy(true); setError('')
        try {
          const result = await api('graph/control', { action, ...(token ? { token } : {}) }, { method: 'POST' })
          if (action === 'preview') {
            if (result.pending > 0) setPreview(result)
            else { await api('graph/control', { action: 'enable', token: result.token }, { method: 'POST' }); await refresh?.() }
          } else { setPreview(null); if (action === 'notice') { setNotice(false); setHideExplanation(true); onGraphHidden?.() }; await refresh?.() }
        } catch (reason) { setError(String(reason?.message || reason)) }
        finally { setBusy(false) }
      }
      const graphStatus = state.enabled === true ? (state.paused ? '已暂停更新，可查看旧图谱' : '已开启') : '默认关闭，打开后可查看已有图谱'
      const showExplanation = !page || (state.noticeSeen !== true && !hideExplanation)
      return h(React.Fragment, null, h('style', null, GRAPH_CONTROL_STYLES), h('aside', { className: 'sg-storage-card sg-graph-control' + (page ? ' sg-graph-page-control' : ''), 'aria-label': page ? '知识图谱开关' : undefined },
        h('div', { className: 'sg-stage' }, h('span', { className: 'sg-graph-copy' }, h('b', null, page ? '显示知识图谱' : '启用知识图谱'), page ? h('span', null, graphStatus) : null), h('span', { className: 'sg-graph-toggle' }, !page ? h('span', { className: 'sg-stage-value ' + (state.enabled === true ? 'processing' : 'waiting') }, state.enabled === true ? (state.paused ? '已暂停' : '已开启') : '已关闭') : null, h('button', { type: 'button', role: 'switch', 'aria-label': '显示知识图谱', 'aria-checked': state.enabled === true, disabled: busy, className: 'sg-setting-switch', onClick: () => void control(state.enabled ? 'disable' : 'preview') }))),
        page && state.enabled === true ? h('button', { type: 'button', className: 'sg-graph-open', onClick: () => onOpenGraph?.() }, '打开知识图谱 →') : null,
        !page && showExplanation ? h(React.Fragment, null, h('p', { className: 'sg-setting-note' }, GRAPH_EXPLANATION), h('p', { className: 'sg-setting-note' }, GRAPH_USAGE_HINT)) : null,
        !page && showExplanation ? h('button', { type: 'button', className: 'sg-quiet-button sg-graph-no-reminder', disabled: busy, onClick: () => void control('notice') }, '不再提醒') : null,
        !page ? h('p', { className: 'sg-setting-note' }, '图谱开关与任务操作单独保存，无需点击“保存全局设置”。') : null,
        !page && state.enabled ? h('button', { type: 'button', className: 'sg-storage-button', disabled: busy, onClick: () => void control(state.paused ? 'preview' : 'pause') }, state.paused ? '统计并继续图谱任务' : '暂停图谱任务') : null,
        error ? h('p', { role: 'alert', className: 'sg-error-note' }, error) : null,
        notice || preview ? h('div', { className: 'sg-import-overlay' }, h('section', { ref: dialogRef, role: 'dialog', 'aria-modal': 'true', 'aria-label': notice ? '知识图谱默认关闭说明' : '确认恢复知识图谱', className: 'sg-import-dialog', onKeyDown: (event) => {
          if (event.key === 'Escape' && preview && !notice && !busy) { event.preventDefault(); setPreview(null) }
          if (event.key === 'Tab') {
            const buttons = [...dialogRef.current.querySelectorAll('button:not(:disabled)')]
            if (!buttons.length) { event.preventDefault(); return }
            const first = buttons[0], last = buttons.at(-1)
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
          }
        } },
          h('div', { className: 'sg-graph-dialog-heading' }, h('h3', null, notice ? '知识图谱默认关闭' : '确认恢复知识图谱'), notice ? h('span', { className: 'sg-graph-dialog-control' }, h('span', null, '开启'), h('button', { type: 'button', role: 'switch', 'aria-label': '启用知识图谱', 'aria-checked': state.enabled === true, disabled: busy, className: 'sg-setting-switch', onClick: () => void control('preview') })) : null),
          h('p', null, GRAPH_EXPLANATION), h('p', null, GRAPH_USAGE_HINT),
          preview && !notice ? h('p', null, '当前有 ' + preview.pending + ' 条待处理事件，约 ' + preview.batches + ' 个批次。确认后仅补建这份清单，沿用现有租约、并发和重试限额；可随时暂停。') : null,
          notice && !preview ? h('button', { type: 'button', className: 'sg-graph-no-reminder', disabled: busy, onClick: () => void control('notice') }, '暂时关闭') : !notice && preview ? h(React.Fragment, null,
            h('button', { type: 'button', disabled: busy, onClick: () => setPreview(null) }, '取消'),
            h('button', { type: 'button', disabled: busy, onClick: () => void control('enable', preview.token) }, '确认开启并分批处理')) : null,
          !notice && !preview ? h('button', { type: 'button', className: 'sg-graph-no-reminder', disabled: busy, onClick: () => void control('notice') }, '暂时关闭') : null)) : null))
    }

    function GraphSettingsPanel({ state = {}, refresh }) {
      return h(GraphControlPanel, { state, refresh })
    }

    function DailyNotesSettings({ usePluginSettings, setDailyEnabled, setDailyTimeZone, setDailyInjectionDays }) {
      const settings = usePluginSettings ? usePluginSettings(state => state) : null
      const [saving, setSaving] = React.useState(false)
      const [error, setError] = React.useState('')
      const localTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
      const timeZone = settings?.value?.dailyNotesTimeZone || ''
      const enabled = settings?.value?.dailyNotesEnabled !== false
      const injectionDays = settings?.value?.dailyNotesInjectionDays ?? 3
      const zones = [...new Set(['Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Tokyo', 'Asia/Singapore', 'Asia/Kolkata', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Los_Angeles', 'Australia/Sydney', 'UTC', timeZone].filter(Boolean))]
      const save = async (setter, value) => {
        setSaving(true); setError('')
        try { if (!setter || !await setter(value)) setError('未能保存笔记设置，请重试。') }
        catch (reason) { setError('保存失败：' + String(reason.message || reason)) }
        finally { setSaving(false) }
      }
      const disabled = settings?.writable !== true || saving
      return h('div', { className: 'sg-settings-panel sg-pipeline' },
        h('div', { className: 'sg-display-setting' }, h('span', { className: 'sg-display-setting-copy' }, h('span', { className: 'sg-display-setting-title' }, '短期记忆'), h('span', { className: 'sg-display-setting-description' }, '每天一份工作笔记。关闭后不再写入和注入，已有笔记保留。')),
          h('button', { type: 'button', className: 'sg-setting-switch', role: 'switch', 'aria-label': '短期记忆', 'aria-checked': enabled, disabled: disabled || !setDailyEnabled, onClick: () => void save(setDailyEnabled, !enabled) })),
        h('div', { className: 'sg-display-setting' }, h('span', { className: 'sg-display-setting-copy' }, h('span', { className: 'sg-display-setting-title' }, '带入新会话的天数'), h('span', { className: 'sg-display-setting-description' }, '取最近有笔记的日期，默认 3 天。修改后用于新会话；内容仍受长度上限约束。')),
          h('select', { className: 'sg-effort-select', 'aria-label': '带入新会话的天数', value: injectionDays, disabled: disabled || !setDailyInjectionDays, onChange: event => void save(setDailyInjectionDays, Number(event.target.value)) }, Array.from({ length: 30 }, (_, i) => h('option', { key: i + 1, value: i + 1 }, (i + 1) + ' 天')))),
        h('div', { className: 'sg-stage' }, h('span', null, '笔记时区'), h('select', { className: 'sg-effort-select', style: { maxWidth: '100%', minWidth: 0 }, 'aria-label': '笔记时区', value: timeZone, disabled: disabled || !setDailyTimeZone, onChange: event => void save(setDailyTimeZone, event.target.value) }, h('option', { value: '' }, '跟随本机（' + localTimeZone + '）'), zones.map(zone => h('option', { key: zone, value: zone }, zone)))),
        error ? h('p', { className: 'sg-storage-feedback failed', role: 'alert' }, error) : null)
    }

    function ProfileLimitSettings() {
      const [profile, setProfile] = React.useState(null)
      const [loading, setLoading] = React.useState(true)
      const [loadError, setLoadError] = React.useState('')
      const [editing, setEditing] = React.useState(false)
      const [draft, setDraft] = React.useState('')
      const [saving, setSaving] = React.useState(false)
      const [error, setError] = React.useState('')
      const total = profileTotalLength(profile)
      const limit = profileTotalLimit(profile)
      React.useEffect(() => {
        const controller = new AbortController()
        void api('profile', {}, { method: 'GET', signal: controller.signal })
          .then((value) => {
            if (!controller.signal.aborted) setProfile(value)
            setLoadError('')
          })
          .catch((reason) => {
            if (!controller.signal.aborted) setLoadError('暂时无法读取画像用量：' + String(reason?.message || reason))
          })
          .finally(() => { if (!controller.signal.aborted) setLoading(false) })
        return () => controller.abort()
      }, [])
      const begin = () => {
        if (loading || loadError) return
        setDraft(String(limit)); setError(''); setEditing(true)
      }
      const cancel = () => {
        if (saving) return
        setEditing(false); setError('')
      }
      const save = async () => {
        if (saving) return
        const next = Number(draft)
        if (!Number.isSafeInteger(next) || next < PROFILE_LIMIT_MIN || next > PROFILE_LIMIT_MAX) {
          setError('请输入 ' + formatCount(PROFILE_LIMIT_MIN) + ' 到 ' + formatCount(PROFILE_LIMIT_MAX) + ' 之间的整数。')
          return
        }
        if (next < total) {
          setError('上限不能低于当前已用的 ' + formatCount(total) + ' 字。')
          return
        }
        if (next === limit) { setEditing(false); return }
        setSaving(true); setError('')
        try {
          const result = await api('settings', null, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ profileMaxLength: next }) })
          const saved = Number(result?.profileMaxLength)
          if (!Number.isSafeInteger(saved) || saved !== next) throw new Error('上限保存结果不完整')
          setProfile((current) => current ? { ...current, _limits: { ...(current._limits || {}), totalMaxLength: next } } : current)
          setEditing(false)
        } catch (reason) {
          setError('上限未保存：' + String(reason?.message || reason))
        } finally { setSaving(false) }
      }
      return h('div', { className: 'sg-settings-panel sg-profile-limit', 'data-testid': 'stratagate-profile-limit-settings' },
        h('div', { className: 'sg-display-setting' },
          h('span', { className: 'sg-display-setting-copy' },
            h('span', { className: 'sg-display-setting-title' }, '常驻画像字数上限'),
            h('span', { className: 'sg-display-setting-description' }, '限制每轮带入的常驻画像总量，不能低于当前已写内容。')),
          h('span', { className: 'sg-profile-limit-control' },
            loading ? h('span', { className: 'sg-setting-note' }, '读取中…')
              : h(React.Fragment, null,
                !loadError ? h('span', { className: 'sg-profile-limit-value', 'aria-label': '常驻画像已用 ' + total + ' 字，上限 ' + formatCount(limit) + ' 字' }, formatCount(total) + ' / ' + formatCount(limit) + ' 字') : null,
                !loadError && !editing ? h('button', { type: 'button', className: 'sg-cap-limit', onClick: begin }, '调整上限') : null))),
        editing ? h('div', { className: 'sg-cap-edit sg-profile-limit-edit' },
          h('input', { type: 'number', inputMode: 'numeric', min: PROFILE_LIMIT_MIN, max: PROFILE_LIMIT_MAX, step: 100, 'aria-label': '常驻画像字数上限', value: draft, disabled: saving, autoFocus: true, onChange: (event) => setDraft(event.target.value), onKeyDown: (event) => { if (event.key === 'Enter') { event.preventDefault(); void save() } else if (event.key === 'Escape') { event.preventDefault(); cancel() } } }),
          h('button', { type: 'button', className: 'sg-quiet-button', disabled: saving, onClick: cancel }, '取消'),
          h('button', { type: 'button', className: 'sg-save-button', disabled: saving, onClick: () => void save() }, saving ? '保存中…' : '保存')) : null,
        loadError ? h('p', { className: 'sg-storage-feedback failed', role: 'alert' }, loadError) : null,
        error ? h('p', { className: 'sg-cap-error', role: 'alert' }, error) : null)
    }

    function MemoryModelSettings({ usePluginSettings, setMemoryModel }) {
      const settings = usePluginSettings ? usePluginSettings(state => state) : null
      const [catalog, setCatalog] = React.useState(null)
      const [draft, setDraft] = React.useState(null)
      const customDraft = React.useRef(null)
      const [models, setModels] = React.useState([])
      const [loading, setLoading] = React.useState(false)
      const [catalogError, setCatalogError] = React.useState('')
      const [modelsError, setModelsError] = React.useState('')
      const [feedback, setFeedback] = React.useState({ kind: '', text: '' })
      const [saving, setSaving] = React.useState(false)
      const [revision, setRevision] = React.useState(0)
      React.useEffect(() => {
        if (feedback.kind !== 'done') return
        const timer = window.setTimeout(() => setFeedback({ kind: '', text: '' }), 4500)
        return () => window.clearTimeout(timer)
      }, [feedback])
      const saved = settings?.value?.memoryModel || catalog?.selection || { mode: 'auto' }
      const value = draft || saved
      const provider = value.mode === 'custom' ? value.provider || '' : ''
      React.useEffect(() => {
        let active = true
        if (settings?.value?.memoryModel?.mode === 'auto' && value.mode === 'auto') {
          setCatalog(null)
          setCatalogError('')
          return () => { active = false }
        }
        setCatalogError('')
        api('models').then(result => { if (active) setCatalog(result) })
          .catch(reason => { if (active) setCatalogError(String(reason?.message || reason)) })
        return () => { active = false }
      }, [revision, settings?.value?.memoryModel?.mode, value.mode])
      React.useEffect(() => {
        let active = true
        setModels([]); setModelsError('')
        if (!provider) { setLoading(false); return () => { active = false } }
        setLoading(true)
        api('models', { provider }).then(result => { if (active) setModels(result.models) })
          .catch(reason => { if (active) setModelsError(String(reason?.message || reason)) })
          .finally(() => { if (active) setLoading(false) })
        return () => { active = false }
      }, [provider, revision])
      const providers = catalog?.providers || []
      const custom = value.mode === 'custom'
      React.useEffect(() => {
        if (!draft || !custom || provider || !providers[0]) return
        const next = { ...value, provider: providers[0].id }
        customDraft.current = next
        setDraft(next)
      }, [providers, custom, provider, draft, value])
      const valid = !custom || providers.some(item => item.id === provider) && Boolean(value.model?.trim())
      const changed = value.mode !== saved.mode || custom && (value.provider !== saved.provider || value.model !== saved.model)
      const editingDisabled = settings?.writable !== true || !setMemoryModel || saving
      const disabled = editingDisabled
      const edit = next => {
        if (next.mode === 'custom') customDraft.current = next
        setDraft(next); setFeedback({ kind: '', text: '' })
      }
      const save = async () => {
        if (disabled || !valid || !changed) return
        setSaving(true); setFeedback({ kind: '', text: '' })
        try {
          if (!await setMemoryModel(value)) throw new Error('宿主未确认保存，请重试。')
          setCatalog(current => ({ ...current, selection: value }))
          setDraft(null)
          setFeedback({ kind: 'done', text: '已保存，对后续记忆处理调用生效。正在运行的调用继续完成。' })
        } catch (reason) {
          setFeedback({ kind: 'failed', text: '未能确认保存：' + String(reason?.message || reason) + ' 当前选择已保留，请重试。' })
        } finally { setSaving(false) }
      }
      const savedProvider = providers.find(item => item.id === saved.provider)?.name || saved.provider
      const savedModel = saved.provider === provider ? models.find(item => item.id === saved.model)?.name || saved.model : saved.model
      const pendingProvider = providers.find(item => item.id === value.provider)?.name || value.provider
      const pendingModel = value.provider === provider ? models.find(item => item.id === value.model)?.name || value.model : value.model
      const savedSummary = saved.mode === 'custom' ? savedProvider + ' / ' + savedModel : '跟随聊天模型'
      const pendingSummary = value.mode === 'custom' ? pendingProvider + ' / ' + pendingModel : '跟随聊天模型'
      return h('div', { className: 'sg-settings-panel sg-model-settings' },
        h('h4', { className: 'sg-model-heading' }, '记忆处理模型'),
        h('div', { className: 'sg-model-modes', role: 'radiogroup', 'aria-label': '记忆处理模型' },
          [{ mode: 'auto', title: '跟随聊天模型' },
            { mode: 'custom', title: '单独指定模型' }].map(item => h('label', { key: item.mode, className: 'sg-model-mode' + (value.mode === item.mode ? ' selected' : '') },
              h('input', { type: 'radio', name: 'sg-memory-model-mode', value: item.mode, checked: value.mode === item.mode, disabled: editingDisabled,
                onChange: () => edit(item.mode === 'auto' ? { mode: 'auto' } : customDraft.current || (saved.mode === 'custom' ? saved : { mode: 'custom', provider: providers[0]?.id || '', model: '' })) }),
              h('span', { className: 'sg-model-mode-copy' }, h('span', { className: 'sg-model-mode-title' }, item.title))))),
        custom ? h(React.Fragment, null,
          h('div', { className: 'sg-model-fields' },
            h('label', { className: 'sg-model-field' }, '服务商', h('select', { className: 'sg-effort-select', 'aria-label': '记忆处理服务商', value: provider, disabled: editingDisabled || !catalog, onChange: event => edit({ mode: 'custom', provider: event.target.value, model: '' }) },
              h('option', { value: '' }, '请选择服务商'), provider && !providers.some(item => item.id === provider) ? h('option', { value: provider }, provider + '（当前不可用）') : null,
              providers.map(item => h('option', { key: item.id, value: item.id }, item.name || item.id)))),
            h('label', { className: 'sg-model-field' }, '模型', h('select', { className: 'sg-effort-select', 'aria-label': '记忆处理具体模型', value: value.model || '', disabled: editingDisabled || !catalog || !provider || loading || Boolean(modelsError), onChange: event => edit({ ...value, model: event.target.value }) },
              h('option', { value: '' }, loading ? '正在读取模型…' : '请选择模型'), value.model && !models.some(item => item.id === value.model) ? h('option', { value: value.model }, value.model + '（未在列表中）') : null,
              models.map(item => h('option', { key: item.id, value: item.id }, item.name || item.id))))),
          null)
          : null,
        custom && !catalog && !catalogError ? h('p', { className: 'sg-status-feedback', role: 'status' }, '正在读取服务商…') : null,
        settings && settings.writable !== true ? h('p', { className: 'sg-status-feedback' }, '当前配置为只读。') : null,
        catalogError || modelsError ? h('p', { className: 'sg-status-feedback failed', role: 'alert' }, '读取失败：' + (catalogError || modelsError), ' ', h('button', { type: 'button', className: 'sg-quiet-button', disabled: saving, onClick: () => setRevision(current => current + 1) }, '重新读取')) : null,
        h('div', { className: 'sg-model-save-row' },
          h('div', { className: 'sg-model-saved' }, h('span', { className: 'sg-model-active-label' }, '当前生效'), h('strong', null, catalog || settings?.value?.memoryModel ? savedSummary : '跟随聊天模型'), changed ? h('span', { className: 'sg-model-pending' }, '→ ' + pendingSummary) : null),
          h('button', { type: 'button', className: 'sg-save-button', disabled: editingDisabled || !changed || !valid || (custom && !catalog), onClick: () => void save() }, saving ? '保存中…' : '保存')),
        feedback.text ? h('p', { className: 'sg-status-feedback ' + feedback.kind, role: feedback.kind === 'failed' ? 'alert' : 'status' }, feedback.text) : null)
    }

    function RetrievalModelSettings({ kind, settings, writable, onSaved }) {
      const embedding = kind === 'embedding'
      const title = embedding ? '向量检索' : '结果精排（Rerank）'
      const prefix = embedding ? 'embedding' : 'rerank'
      const urlKey = prefix + 'Url', secretKey = prefix + 'Key', modelKey = prefix + 'Model'
      const [saved, setSaved] = React.useState(settings || null)
      const [draft, setDraft] = React.useState({})
      const [models, setModels] = React.useState([])
      const [listing, setListing] = React.useState(false)
      const [listFeedback, setListFeedback] = React.useState('')
      const [saving, setSaving] = React.useState(false)
      const [reading, setReading] = React.useState(false)
      const [feedback, setFeedback] = React.useState({ kind: '', text: '' })
      const lookup = React.useRef(0)
      React.useEffect(() => { if (settings) setSaved(settings) }, [settings])
      React.useEffect(() => () => { lookup.current += 1 }, [])
      React.useEffect(() => {
        if (feedback.kind !== 'done') return
        const timer = window.setTimeout(() => setFeedback({ kind: '', text: '' }), 4500)
        return () => window.clearTimeout(timer)
      }, [feedback])
      const value = key => draft[key] ?? saved?.[key] ?? ''
      const url = String(value(urlKey)).trim().replace(/\/+$/, '')
      const keyEdited = Object.hasOwn(draft, secretKey)
      const keyConfigured = keyEdited ? Boolean(draft[secretKey].trim()) : saved?.[prefix + 'KeyConfigured'] === true
      let urlValid = !url
      try { urlValid = ['http:', 'https:'].includes(new URL(url).protocol) } catch {}
      const numericValid = !embedding || ['vectorWeight', 'embeddingMinScore'].every(key => {
        const raw = draft[key] ?? saved?.[key] ?? (key === 'vectorWeight' ? 1 : 0.3)
        return String(raw).trim() !== '' && Number.isFinite(Number(raw)) && Number(raw) >= 0 && Number(raw) <= (key === 'vectorWeight' ? 5 : 1)
      })
      const changed = Object.keys(draft).some(key => key === secretKey || String(draft[key]) !== String(saved?.[key] ?? ''))
      const disabled = !saved || writable !== true || saving || reading
      const edit = (key, next) => {
        setDraft(current => ({ ...current, [key]: next }))
        setFeedback({ kind: '', text: '' })
        if (key === urlKey || key === secretKey) {
          lookup.current += 1; setModels([]); setListing(false); setListFeedback('')
        }
      }
      const listModels = async () => {
        if (disabled || listing || !url || !urlValid || !keyConfigured) return
        const request = ++lookup.current
        setListing(true); setModels([]); setListFeedback('')
        try {
          const result = await api('models', null, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind, url, ...(keyEdited ? { key: draft[secretKey].trim() } : {}) }) })
          if (request !== lookup.current) return
          const ids = Array.isArray(result.models) ? result.models.filter(id => typeof id === 'string' && id) : []
          setModels(ids)
          setListFeedback(ids.length ? '已读取模型列表。请选择对应类型的模型，也可手动填写。' : '未能读取模型列表，可重试或手动填写模型名称。')
        } catch {
          if (request === lookup.current) setListFeedback('未能读取模型列表，可重试或手动填写模型名称。')
        } finally { if (request === lookup.current) setListing(false) }
      }
      const save = async () => {
        if (disabled || !changed || !urlValid || !numericValid) return
        const patch = {}
        for (const key of Object.keys(draft)) {
          patch[key] = key === 'vectorWeight' || key === 'embeddingMinScore' ? Number(draft[key])
            : key === urlKey ? url : draft[key].trim()
        }
        setSaving(true); setFeedback({ kind: '', text: '' })
        lookup.current += 1; setListing(false)
        try {
          const result = await api('settings', null, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) })
          if (!result.vectorSettings || typeof result.vectorSettings[prefix + 'Ready'] !== 'boolean') throw new Error('Missing saved settings')
          setSaved(result.vectorSettings); setDraft({})
          onSaved?.(result.vectorSettings)
          setFeedback({ kind: 'done', text: '配置已保存。' })
        } catch {
          setFeedback({ kind: 'failed', text: '未能确认保存，输入已保留。请重新读取配置后核对，或重试保存。' })
        } finally { setSaving(false) }
      }
      const readSaved = async () => {
        if (saving || reading) return
        setReading(true)
        try {
          const result = await api('overview')
          if (!result.vectorSettings || typeof result.vectorSettings[prefix + 'Ready'] !== 'boolean') throw new Error('Missing saved settings')
          setSaved(result.vectorSettings); onSaved?.(result.vectorSettings)
          setFeedback({ kind: 'done', text: '已重新读取保存的配置；未保存输入已保留。' })
        } catch { setFeedback({ kind: 'failed', text: '未能读取保存的配置，输入已保留，请重试。' }) }
        finally { setReading(false) }
      }
      const ready = saved?.[prefix + 'Ready'] === true
      const active = ready && (!embedding || Number(saved.vectorWeight) > 0)
      const status = !saved ? '尚未读取配置' : active ? '已配置 · ' + saved[modelKey]
        : ready && embedding ? '已停用（向量检索占比为 0）' : saved[urlKey] ? '配置未完整，暂未启用' : '未启用'
      return h('div', { className: 'sg-settings-panel sg-model-settings sg-retrieval-settings', 'data-kind': kind },
        h('h4', { className: 'sg-model-heading' }, title),
        h('p', { className: 'sg-model-intro' }, embedding ? '按语义查找相关事件，补充关键词检索。' : '对已找回的候选重新排序，可独立于向量检索配置。'),
        h('p', { className: 'sg-setting-note' }, '填写地址、密钥和模型后启用；清空地址并保存即可停用。启用后会向服务商发送' + (embedding ? '检索文本和事件标题、摘要' : '检索文本和候选事件内容') + '，可能产生 API 费用。'),
        h('div', { className: 'sg-retrieval-fields' },
          h('label', { className: 'sg-model-field' }, 'API 地址', h('input', { type: 'url', value: value(urlKey), disabled, placeholder: 'https://你的服务地址/v1', 'aria-label': title + ' API 地址', spellCheck: false, onChange: event => edit(urlKey, event.target.value) })),
          h('p', { className: 'sg-setting-note' }, '使用 OpenAI 兼容接口的基础地址，无需填写 ' + (embedding ? '/embeddings' : '/rerank') + '。'),
          !urlValid ? h('p', { className: 'sg-status-feedback failed', role: 'alert' }, '请填写以 http:// 或 https:// 开头的有效地址。') : null,
          h('label', { className: 'sg-model-field' }, 'API Key', h('input', { type: 'password', value: draft[secretKey] ?? '', disabled, placeholder: keyEdited && !draft[secretKey] ? '保存后清除密钥' : saved?.[prefix + 'KeyConfigured'] ? '已保存密钥，未修改时保留' : '填写 API Key', 'aria-label': title + ' API Key', autoComplete: 'new-password', spellCheck: false, onChange: event => edit(secretKey, event.target.value) })),
          h('div', { className: 'sg-retrieval-actions' }, saved?.[prefix + 'KeyConfigured'] ? h('button', { type: 'button', className: 'sg-quiet-button', disabled, onClick: () => edit(secretKey, '') }, '清除已保存密钥') : null,
            keyEdited ? h('button', { type: 'button', className: 'sg-quiet-button', disabled, onClick: () => {
              setDraft(current => { const next = { ...current }; delete next[secretKey]; return next })
              lookup.current += 1; setModels([]); setListing(false); setListFeedback(''); setFeedback({ kind: '', text: '' })
            } }, '撤销密钥修改') : null),
          keyEdited && !draft[secretKey].trim() ? h('p', { className: 'sg-setting-note' }, '保存后将清除密钥并停用此功能。') : null,
          h('label', { className: 'sg-model-field' }, '模型名称', h('input', { type: 'text', value: value(modelKey), disabled, list: 'sg-' + kind + '-models', placeholder: '填写模型名称或从列表选择', 'aria-label': title + '模型名称', autoComplete: 'off', spellCheck: false, onChange: event => edit(modelKey, event.target.value) })),
          h('datalist', { id: 'sg-' + kind + '-models' }, models.map(id => h('option', { key: id, value: id }))),
          h('div', { className: 'sg-retrieval-actions' }, h('button', { type: 'button', className: 'sg-storage-button', disabled: disabled || listing || !url || !urlValid || !keyConfigured, onClick: () => void listModels() }, listing ? '正在读取…' : '读取模型列表')),
          listFeedback ? h('p', { className: 'sg-status-feedback', role: 'status' }, listFeedback) : null),
        embedding ? h('details', { className: 'sg-retrieval-tuning' }, h('summary', null, '检索参数'),
          h('div', { className: 'sg-model-fields' },
            h('label', { className: 'sg-model-field' }, '向量检索占比', h('input', { type: 'number', min: 0, max: 5, step: 0.1, value: draft.vectorWeight ?? saved?.vectorWeight ?? 1, disabled, 'aria-label': '向量检索占比', onChange: event => edit('vectorWeight', event.target.value) })),
            h('label', { className: 'sg-model-field' }, '最低相似度', h('input', { type: 'number', min: 0, max: 1, step: 0.05, value: draft.embeddingMinScore ?? saved?.embeddingMinScore ?? 0.3, disabled, 'aria-label': '最低相似度', onChange: event => edit('embeddingMinScore', event.target.value) }))),
          h('p', { className: 'sg-setting-note' }, '占比默认 1，与关键词检索平权；0 停用向量检索。最低相似度默认 0.3，范围 0–1。'),
          !numericValid ? h('p', { className: 'sg-status-feedback failed', role: 'alert' }, '占比需为 0–5 的数字，最低相似度需为 0–1 的数字。') : null) : null,
        h('div', { className: 'sg-model-save-row' }, h('div', { className: 'sg-model-saved' }, h('span', { className: 'sg-model-active-label' }, '已保存配置'), h('strong', null, status), changed ? h('span', { className: 'sg-model-pending' }, '有未保存修改') : null),
          h('button', { type: 'button', className: 'sg-save-button', disabled: disabled || !changed || !urlValid || !numericValid, onClick: () => void save() }, saving ? '保存中…' : '保存' + (embedding ? '向量检索设置' : '精排设置'))),
        h('p', { className: 'sg-setting-note' }, '保存不验证连接或检索效果。' + (embedding ? '已有事件的向量会在后续检索时逐步补齐。' : '')),
        !saved || writable !== true ? h('p', { className: 'sg-status-feedback' }, !saved ? '检索配置尚未读取，请重新读取。' : '当前检索配置为只读。') : null,
        feedback.text ? h('p', { className: 'sg-status-feedback ' + feedback.kind, role: feedback.kind === 'failed' ? 'alert' : 'status' }, feedback.text) : null,
        !saved || feedback.kind === 'failed' ? h('button', { type: 'button', className: 'sg-quiet-button', disabled: saving || reading, onClick: () => void readSaved() }, reading ? '正在读取…' : '重新读取配置') : null)
    }

    function SettingsPage({ selected, graphSettings, vectorSettings, retrievalSettingsWritable, onRetrievalSettingsSaved, refresh, namespace, dataDirectory, onBack, setView, updateSettings, savingSettings, usePluginSettings, setMemoryModel, setEffort, resetEffort, setDailyEnabled, setDailyTimeZone, setDailyInjectionDays }) {
      const [turnSize, setTurnSize] = React.useState(String(selected.blockTurnSize ?? 6))
      const [lambda, setLambda] = React.useState(String(selected.blockDecayLambda ?? 0.3))
      const [agentWeight, setAgentWeight] = React.useState(String(selected.agentMemoryRetrievalWeight ?? 1))
      const [directoryOpening, setDirectoryOpening] = React.useState(false)
      const [directoryFeedback, setDirectoryFeedback] = React.useState({ kind: '', text: '' })
      React.useEffect(() => {
        setTurnSize(String(selected.blockTurnSize ?? 6))
        setLambda(String(selected.blockDecayLambda ?? 0.3))
        setAgentWeight(String(selected.agentMemoryRetrievalWeight ?? 1))
      }, [selected.blockTurnSize, selected.blockDecayLambda, selected.agentMemoryRetrievalWeight])
      const turnSizeValue = Number(turnSize)
      const lambdaValue = Number(lambda)
      const agentWeightValue = Number(agentWeight)
      const valid = Number.isSafeInteger(turnSizeValue) && turnSizeValue >= 1 && lambda !== '' && Number.isFinite(lambdaValue) && lambdaValue >= 0
        && agentWeight !== '' && Number.isFinite(agentWeightValue) && agentWeightValue >= 0 && agentWeightValue <= 5
      const changed = valid && (turnSizeValue !== selected.blockTurnSize || lambdaValue !== selected.blockDecayLambda
        || agentWeightValue !== (selected.agentMemoryRetrievalWeight ?? 1))
      const suggestedLambda = Math.round(((selected.blockDecayLambda ?? 0.3) * turnSizeValue / (selected.blockTurnSize || 6)) / 0.05) * 0.05
      const showSuggestion = Number.isSafeInteger(turnSizeValue) && turnSizeValue >= 1 && turnSizeValue !== selected.blockTurnSize
      const pluginSettings = usePluginSettings ? usePluginSettings((state) => state) : null
      const effortMode = pluginSettings?.value?.structuredReasoningEffort || 'auto'
      const effortOverridden = pluginSettings?.user?.structuredReasoningEffort !== undefined
      const settingsWritable = pluginSettings?.writable === true
      const workspaceRows = [['Schema', 'v' + selected.schemaVersion], ['工作区', selected.workspaceName || '当前工作区'], ['内部空间 ID', namespace], ['已处理轮次', selected.currentTurn]]
      const runtimeDiagnostics = [
        ['duplicates', '⇄', '重复记忆整理', '查看保留原因、合并候选与重新扫描'],
        ['system', '✓', '系统状态', '处理概览与最近整理时间'],
        ['audit', '↗', '使用记录', '长期记忆何时被使用'],
        ['status', '↻', '后台任务', '处理进度、失败任务与重试'],
      ]
      const openDirectory = () => {
        if (!dataDirectory || directoryOpening) return
        setDirectoryOpening(true)
        setDirectoryFeedback({ kind: '', text: '' })
        void api('storage/open-directory', {}, { method: 'POST' })
          .then(() => setDirectoryFeedback({ kind: 'done', text: '已在文件管理器中打开' }))
          .catch((reason) => setDirectoryFeedback({ kind: 'failed', text: '打开失败：' + String(reason?.message || reason) }))
          .finally(() => setDirectoryOpening(false))
      }
      const copyDirectory = () => {
        if (!dataDirectory) return
        setDirectoryFeedback({ kind: '', text: '' })
        if (!navigator?.clipboard?.writeText) {
          setDirectoryFeedback({ kind: 'failed', text: '当前浏览器不支持自动复制' })
          return
        }
        void navigator.clipboard.writeText(dataDirectory)
          .then(() => setDirectoryFeedback({ kind: 'done', text: '路径已复制' }))
          .catch((reason) => setDirectoryFeedback({ kind: 'failed', text: '复制失败：' + String(reason?.message || reason) }))
      }
      const menu = (items) => h('div', { className: 'sg-menu sg-settings-menu' }, items.map(([id, icon, title, subtitle]) => h('button', { key: id, type: 'button', className: 'sg-menu-row', onClick: () => setView({ name: id, back: { name: 'settings' } }) }, h('span', { className: 'sg-menu-icon', 'aria-hidden': 'true' }, icon), h('span', null, h('span', { className: 'sg-menu-title' }, title), h('br'), h('span', { className: 'sg-menu-subtitle' }, subtitle)), h('span', { className: 'sg-chevron' }, '›'))))
      const stepper = ({ value, onChange, min, max, step, label, allowFloat }) => {
        const current = Number(value)
        const delta = allowFloat ? step : 1
        const bump = (direction) => {
          if (!Number.isFinite(current)) return
          const next = Math.min(max, Math.max(min, Number((current + direction * delta).toFixed(2))))
          onChange(String(next))
        }
        return h('span', { className: 'sg-stp sg-stp-wide' },
          h('button', { type: 'button', 'aria-label': '减少' + label, disabled: !Number.isFinite(current) || current <= min, onClick: () => bump(-1) }, '\u2212'),
          h('input', { className: 'sg-number-input', type: 'number', min: String(min), max: max === undefined ? undefined : String(max), step: String(step), value, onChange: (event) => onChange(event.target.value), 'aria-label': label }),
          h('button', { type: 'button', 'aria-label': '增加' + label, disabled: !Number.isFinite(current) || max === undefined || current >= max, onClick: () => bump(1) }, '+'))
      }
      return h('div', { className: 'sg-settings-shell' },
        h(BackBar, { label: '更多', onBack }),
        h('div', { className: 'sg-pg-head' }, h('h2', null, '高级设置'), h('span', { className: 'sg-pg-tag' }, '记忆配置、数据与运行诊断')),
        h('section', { className: 'sg-settings-group', 'aria-labelledby': 'sg-memory-settings-title' },
          h('h3', { id: 'sg-memory-settings-title', className: 'sg-settings-group-title' }, 'StrataGate 安装级设置'),
          h('p', { className: 'sg-settings-group-copy' }, '适用于当前 StrataGate 安装中的所有工作区，也作为新工作区的默认设置。设置保存在当前记忆数据库中，不会自动同步到其他设备或安装。'),
          h(GraphSettingsPanel, { state: graphSettings, refresh }),
          h(ProfileLimitSettings),
          h(DailyNotesSettings, { usePluginSettings, setDailyEnabled, setDailyTimeZone, setDailyInjectionDays }),
          h(RetrievalModelSettings, { kind: 'embedding', settings: vectorSettings, writable: retrievalSettingsWritable, onSaved: onRetrievalSettingsSaved }),
          h(RetrievalModelSettings, { kind: 'rerank', settings: vectorSettings, writable: retrievalSettingsWritable, onSaved: onRetrievalSettingsSaved }),
          h('div', { className: 'sg-settings-panel sg-pipeline' },
            h('div', { className: 'sg-stage' }, h('span', null, '每个 Block 的对话轮数'), h('span', { className: 'sg-lambda-control' }, stepper({ value: turnSize, onChange: setTurnSize, min: 1, max: 30, step: 1, label: '每个 Block 的对话轮数' }), h('span', { className: 'sg-stage-value waiting' }, '轮'))),
            h('p', { className: 'sg-setting-note' }, '1 轮是一次用户提问和 AI 完整回复。轮数越小，Block 生成越频繁，也会让相同长度的对话衰减得更快；已有 Block 不会重新切分，尚未封存的内容按新阈值继续处理。'),
            h('div', { className: 'sg-stage' }, h('span', null, 'Block 衰减系数 λ'), h('span', { className: 'sg-lambda-control' }, stepper({ value: lambda, onChange: setLambda, min: 0, max: 0.4, step: 0.05, label: 'Block 衰减系数 λ', allowFloat: true }))),
            h('p', { className: 'sg-setting-note' }, '默认 0.3；数字越小，记忆遗忘越慢，消耗 token 越多，不建议大于 0.4。'),
            showSuggestion ? h('div', { className: 'sg-setting-suggestion' }, h('span', null, '为保持按对话轮数计算的遗忘速度，建议 λ 调整为 ' + suggestedLambda.toFixed(2) + '。'), h('button', { type: 'button', className: 'sg-quiet-button', onClick: () => setLambda(String(Number(suggestedLambda.toFixed(2)))) }, '采用建议值')) : null,
            h('div', { className: 'sg-stage' }, h('span', null, '主动记忆检索占比'), h('span', { className: 'sg-lambda-control' }, stepper({ value: agentWeight, onChange: setAgentWeight, min: 0, max: 5, step: 0.05, label: '主动记忆检索占比', allowFloat: true }))),
            h('p', { className: 'sg-setting-note' }, 'agent 主动记录与对话派生记忆分别独立排序后按此权重融合：1 为平权，0 为不浮现 agent 记录，更大值提升 agent 记录的排序权重。'),
            h('p', { className: 'sg-setting-note' }, '保存以上三项参数后，将应用于当前安装中的所有已有工作区，也作为新工作区的默认设置。'),
            changed ? h('div', { className: 'sg-dirty' }, h('span', null, '3 项中 ' + [turnSizeValue !== selected.blockTurnSize, lambdaValue !== selected.blockDecayLambda, agentWeightValue !== (selected.agentMemoryRetrievalWeight ?? 1)].filter(Boolean).length + ' 项未保存'),
              h('button', { type: 'button', className: 'sg-quiet-button', disabled: savingSettings, onClick: () => { setTurnSize(String(selected.blockTurnSize ?? 6)); setLambda(String(selected.blockDecayLambda ?? 0.3)); setAgentWeight(String(selected.agentMemoryRetrievalWeight ?? 1)) } }, '放弃'),
              h('button', { type: 'button', className: 'sg-save-button', disabled: !changed || savingSettings, onClick: () => void updateSettings({ blockTurnSize: turnSizeValue, blockDecayLambda: lambdaValue, agentMemoryRetrievalWeight: agentWeightValue }) }, savingSettings ? '保存中…' : '保存全局设置'))
              : h('button', { type: 'button', className: 'sg-save-button', disabled: true }, '全局设置已保存'))),
        h('section', { className: 'sg-settings-group', 'aria-labelledby': 'sg-host-settings-title' },
          h('h3', { id: 'sg-host-settings-title', className: 'sg-settings-group-title' }, '宿主配置'),
          h('p', { className: 'sg-settings-group-copy' }, '所有工作区共用。'),
          h(MemoryModelSettings, { usePluginSettings, setMemoryModel }),
          h('div', { className: 'sg-settings-panel sg-pipeline' },
            h('div', { className: 'sg-stage' }, h('span', null, '结构化推理档位'), h('span', { className: 'sg-lambda-control' },
              h('select', { className: 'sg-effort-select', value: effortMode, disabled: !settingsWritable, onChange: (event) => { if (setEffort) void setEffort(event.target.value) }, 'aria-label': '结构化推理档位策略' },
                h('option', { value: 'auto' }, 'auto（自动）'),
                h('option', { value: 'force-off' }, 'force-off（强制关闭）')),
              effortOverridden ? h('button', { type: 'button', className: 'sg-effort-button', onClick: () => { if (resetEffort) void resetEffort() } }, '恢复默认') : h('span', { className: 'sg-stage-value waiting' }, '默认'))),
            h('p', { className: 'sg-setting-note' }, 'auto：仅在模型明确支持 off 时使用；force-off：优先使用 off，能力检查失败或模型不支持时安全降级，并对同一模型只告警一次。'),
            h('p', { className: 'sg-setting-note' }, '推理档位由当前 DSH profile 的所有工作区共享，修改后由宿主立即保存，对后续记忆处理调用生效，无需点击“保存全局设置”。'))),
        h('section', { className: 'sg-settings-group', 'aria-labelledby': 'sg-workspace-settings-title' },
          h('h3', { id: 'sg-workspace-settings-title', className: 'sg-settings-group-title' }, '当前工作区信息'),
          h('p', { className: 'sg-settings-group-copy' }, '当前选中工作区的记忆数据 Schema 与处理轮次；随顶部工作区选择器切换。'),
          h('div', { className: 'sg-settings-panel sg-pipeline' },
            workspaceRows.map(([label, value]) => h('div', { key: label, className: 'sg-stage' }, h('span', null, label), h('span', { className: label === '内部空间 ID' ? 'sg-stage-value sg-code' : 'sg-stage-value' }, String(value)))))),
        h('section', { className: 'sg-settings-group', 'aria-labelledby': 'sg-storage-title' },
          h('h3', { id: 'sg-storage-title', className: 'sg-settings-group-title' }, '数据与存储'),
          h('p', { className: 'sg-settings-group-copy' }, '数据目录属于当前安装；原始数据查看当前选中的工作区。'),
          h('div', { className: 'sg-storage-card' },
            h('span', { className: 'sg-storage-label' }, '数据存储位置'),
            h('span', { className: 'sg-storage-path', title: dataDirectory || undefined }, dataDirectory || '当前使用内存存储，没有本地数据目录'),
            h('div', { className: 'sg-storage-actions' },
              h('button', { type: 'button', className: 'sg-storage-button', disabled: !dataDirectory || directoryOpening, onClick: openDirectory }, directoryOpening ? '正在打开…' : '打开文件夹'),
              h('button', { type: 'button', className: 'sg-storage-button', disabled: !dataDirectory, onClick: copyDirectory }, '复制路径')),
            h('p', { className: 'sg-storage-feedback ' + directoryFeedback.kind, role: directoryFeedback.kind === 'failed' ? 'alert' : 'status', 'aria-live': 'polite' }, directoryFeedback.text)),
          menu([['raw', '{}', '查看原始数据', 'Block、Event、Graph 与模型响应']])),
        h('section', { className: 'sg-settings-group', 'aria-labelledby': 'sg-diagnostics-title' },
          h('h3', { id: 'sg-diagnostics-title', className: 'sg-settings-group-title' }, '当前工作区运行与诊断'),
          h('p', { className: 'sg-settings-group-copy' }, '当前选中工作区的系统状态、使用记录与后台任务；随顶部工作区选择器切换。'),
          menu(runtimeDiagnostics))
      )
    }

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

    function OverviewPage({ selected, loading, onOpenSection }) {
      const stats = selected?.memoryOverview
      if (loading && !stats) return h(Loading)
      if (!stats) return h(Empty, { title: '还没有可汇总的记忆', copy: '这个工作区的记忆读出来之后，会显示在这里。' })
      // 每行只显示数字；单位放在 aria-label / title 里，保留语义又不挤占版式。
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
              h(UsedMark, { title: '长期记忆帮到的回答' })),
            stats.lastRecall
              ? h('p', { 'data-testid': 'overview-last-recall' }, '最近一次：帮你想起了「' + stats.lastRecall.title + '」')
              : h('p', { className: 'sg-ov-empty', 'data-testid': 'overview-last-recall' }, '最近还没有长期记忆被用到回答里')),
          h('div', { className: 'sg-pillar', 'aria-label': '记忆分层' }, layers.map((layer, index) => {
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
                h('span', { className: 'sg-pillar-bar ' + layer.tone, style: { animationDelay: index * 60 + 'ms' }, 'aria-hidden': 'true' }),
                h('span', { className: 'sg-pillar-name' }, h('b', null, layer.name)),
                h('span', { className: 'sg-pillar-tail' },
                  h('span', { className: 'sg-pillar-use' }, layer.key === 'long' && layer.answers > 0 ? h(UsedMark, { count: layer.answers, title: '被回答用到 ' + layer.answers + ' 次' }) : null),
                  h('span', { className: 'sg-pillar-val' }, h('b', { className: 'sg-mono' }, layer.value))),
                h('span', { className: 'sg-pillar-when' }, when))
            )
          })),
          h('div', { className: 'sg-pillar-key' },
            h('span', null, h('i', { className: 'sg-sw', 'aria-hidden': 'true' }), '一直带着'),
            h('span', null, h('i', { className: 'sg-sw lib', 'aria-hidden': 'true' }), '需要时去找'),
            h('span', null, h(UsedMark), '被用到'))),
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
      else if (view.name === 'settings' && !selected) content = h(SettingsPage, { graphSettings: overview.graphSettings, vectorSettings: overview.vectorSettings, retrievalSettingsWritable: overview.settingsWritable, onRetrievalSettingsSaved, refresh, selected: { blockTurnSize: 6, blockDecayLambda: 0.3, agentMemoryRetrievalWeight: 1, currentTurn: 0, schemaVersion: 12 }, namespace, dataDirectory: overview.dataDirectory, onBack: moreBack, setView, updateSettings, savingSettings, usePluginSettings, setMemoryModel, setEffort, resetEffort, setDailyEnabled, setDailyTimeZone, setDailyInjectionDays })
      else if (section === 'overview' && view.name === 'root') content = h(OverviewPage, { key: namespace, selected, loading, onOpenSection: goSection })
      else if (section === 'profile' && view.name === 'root') content = h(ProfilePage)
      else if (section === 'daily' && view.name === 'root') content = h(DailyNotesPage, { key: namespace, namespace, setDailyInjectionDays })
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
      else if (view.name === 'settings') content = h(SettingsPage, { selected, graphSettings: overview.graphSettings, vectorSettings: overview.vectorSettings, retrievalSettingsWritable: overview.settingsWritable, onRetrievalSettingsSaved, refresh, namespace, dataDirectory: overview.dataDirectory, onBack: moreBack, setView, updateSettings, savingSettings, usePluginSettings, setMemoryModel, setEffort, resetEffort, setDailyEnabled, setDailyTimeZone, setDailyInjectionDays })
      else if (view.name === 'support') content = h(SupportPage, { key: namespace, namespace, overview, selected, data, recentError, onBack: moreBack })
      else content = h(React.Fragment, null,
        loading ? h(Loading) : section === 'short' ? h(ShortTermPage, { key: namespace + ':' + conversationId, blockTurnSize: selected?.blockTurnSize || 6, blocks: data.blocks, blockPage: data.pagination?.blocks, openBlock: data.openBlock, conversations, activeThreadId: conversationId || data.activeThreadId || '', namespace, onConversationChange: selectConversation, refresh })
          : section === 'long' ? null
            : h(MoreHome, { setView, selected, overview, namespace, dataDirectory: overview.dataDirectory, updateSettings, savingSettings, usePluginSettings, setStrataGateStatus, setShortTermStatus, setRetrievalStatus, setSidebarEntry, setDailyEnabled, setDailyInjectionDays }))

      return h('main', { className: 'sg-memory' + (view.name === 'duplicates' ? ' sg-memory-review' : '') + (view.name === 'settings' || view.name === 'display' || (section === 'more' && view.name === 'root') ? ' sg-settings-page' : ''), 'data-testid': 'stratagate-memory-ui' },
        h('style', null, css + DUPLICATE_STYLES + DAILY_NOTES_CSS + R6_STYLES),
        h('header', { className: 'sg-header' },
          h('div', { className: 'sg-header-row sg-header-row-primary' },
            h(GITHUB_FEEDBACK_ENABLED ? 'a' : 'div', { className: 'sg-brand', href: GITHUB_FEEDBACK_ENABLED ? STAR_REPOSITORY_URL : undefined, target: GITHUB_FEEDBACK_ENABLED ? '_blank' : undefined, rel: GITHUB_FEEDBACK_ENABLED ? 'noopener noreferrer' : undefined },
              h(StrataGateMark),
              h('span', { className: 'sg-brand-copy' }, h('span', { className: 'sg-brand-title' }, h('span', { className: 'sg-brand-name' }, 'StrataGate'), overview.pluginVersion && overview.pluginVersion !== 'unknown' ? h('span', { className: 'sg-brand-version' }, 'v' + overview.pluginVersion) : null), onChooseSidebar ? h(SidebarPlacementPrompt, { onChooseSidebar, usePluginSettings }) : null)),
            // Workspace switcher sits right beside Star, not on its own row.
            h('div', { className: 'sg-header-end' },
              h('div', { className: 'sg-project' }, h('span', { className: 'sg-project-label' }, '当前工作区'), h('select', { className: 'sg-project-select', value: namespace, onChange: (event) => setNamespace(event.target.value), 'aria-label': '当前工作区' }, (overview.namespaces || []).map((item) => h('option', { key: item.namespace, value: item.namespace }, projectName(item, workspaceTitles))))),
              GITHUB_FEEDBACK_ENABLED ? h(HeaderStarLink) : null)),
        h('nav', { className: 'sg-tabs', 'aria-label': '记忆视图' }, [['overview', '总览'], ['profile', '常驻画像'], ['short', '会话记忆'], ['daily', '短期记忆'], ['long', '长期记忆'], ['more', '更多']].map(([id, label]) => h('button', { key: id, type: 'button', className: 'sg-tab ' + (section === id ? 'active' : ''), 'aria-current': section === id ? 'page' : undefined, onClick: () => goSection(id) }, TAB_SWATCH[id] ? h('i', { key: 'sw', className: 'sg-tab-swatch ' + TAB_SWATCH[id], 'aria-hidden': 'true' }) : null, label))),
        error ? h('div', { className: 'sg-error' }, h('div', { className: 'sg-error-title' }, '暂时无法读取完整记忆'), h('div', null, '已显示能够读取的内容，请稍后重新加载。'), h('details', null, h('summary', null, '技术详情'), h('div', { className: 'sg-code' }, error))) : null,
        view.name === 'root' && selected?.duplicateRepair?.needsReview > 0 ? h('button', { type: 'button', className: 'sg-dup-entry', onClick: () => setView({ name: 'duplicates' }) },
          h(DuplicateIcon, { size: 23 }), h('span', null, h('strong', null, selected.duplicateRepair.needsReview + ' 组相似记忆，等你确认'), h('small', null, '对比内容，选择保留哪张或合并双方证据')), h(DuplicateIcon, { kind: 'next' })) : null,
        h('section', { key: section, className: 'sg-view', 'aria-label': 'StrataGate 记忆内容' }, section === 'long' && selected && loadedNamespaceRef.current === namespace ? h(React.Fragment, null,
          h('div', { key: 'long-browser', hidden: view.name !== 'root' }, h(LongTermPage, { graphSettings: overview.graphSettings, extractionGap: selected?.longTermExtractionGap === true, key: namespace, events: data.events, eventPage: data.pagination?.events, graph: data.graph, project, query, setQuery, openEvent, namespace, focusNodeId: graphFocusNodeId, onFocusHandled: consumeGraphFocus, topicDirectory: data.topicDirectory, onDirectoryChanged: refreshDirectory, onOpenDreamingSession, refresh, active: view.name === 'root' })),
          view.name === 'root' ? null : content) : content),
        h('footer', { className: 'sg-footer' },
          h('span', null, 'StrataGate-AgentMemory · MIT'),
          h('span', { className: 'sg-footer-links' },
            h('a', { href: STAR_REPOSITORY_URL, target: '_blank', rel: 'noopener noreferrer' }, 'GitHub 仓库'), ' · ',
            h('a', { href: ISSUE_URL, target: '_blank', rel: 'noopener noreferrer' }, '提 Issue'), ' · ',
            h('a', { href: STAR_REPOSITORY_URL + '/releases', target: '_blank', rel: 'noopener noreferrer' }, '更新记录')))))
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
