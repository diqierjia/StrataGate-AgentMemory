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
        background:var(--sg-page);color:var(--sg-text);font:14px/1.55 var(--sg-sans,"Noto Sans SC","Microsoft YaHei UI","Microsoft YaHei","PingFang SC","Segoe UI",sans-serif);-webkit-font-smoothing:antialiased;
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
      .sg-status{display:inline-flex;align-items:center;gap:5px;padding:2px 7px;border-radius:5px;font-size:12px;font-weight:650}.sg-status:before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}.sg-status.organized{color:var(--sg-good);background:var(--sg-good-soft)}.sg-save-state{align-self:flex-start;display:inline-grid;place-items:center;width:20px;height:20px;padding:0;gap:0;border-radius:50%;font-size:0;line-height:1}.sg-save-state:before{display:none}.sg-save-state:after{content:"✓";font-size:12px;line-height:1}.sg-status.processing{color:var(--sg-accent);background:var(--sg-accent-soft)}.sg-status.waiting{color:var(--sg-muted);background:var(--sg-soft)}.sg-status.failed{color:var(--sg-warn);background:var(--sg-warn-soft)}
      .sg-backbar{display:flex;align-items:center;min-height:35px;margin:-4px 0 13px}.sg-back{display:inline-flex;align-items:center;gap:6px;margin-left:-7px;padding:6px 7px;border-radius:6px;font-weight:650}.sg-detail-header{padding-bottom:16px;border-bottom:1px solid var(--sg-border)}.sg-detail-section{padding:18px 0;border-bottom:1px solid var(--sg-border)}.sg-detail-section:last-child{border-bottom:0}.sg-section-title{margin:0 0 11px;font-size:14px;font-weight:730}.sg-prose{margin:0;white-space:pre-wrap}.sg-facts{margin:0;padding-left:20px}.sg-facts li+li{margin-top:7px}.sg-related-list{display:flex;flex-direction:column}.sg-related{display:flex;justify-content:space-between;gap:12px;padding:9px 0;border:0;border-bottom:1px solid var(--sg-border);background:transparent;text-align:left}.sg-related-button,.sg-related:where(button){cursor:pointer}.sg-related:last-child{border-bottom:0}.sg-related-name{color:var(--sg-accent)}.sg-related-time{flex:0 0 auto;color:var(--sg-muted);font-size:12px}
      .sg-weight-header{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:10px}.sg-weight-header .sg-section-title,.sg-long-detail .sg-weight-header h3{margin:0}.sg-weight-metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px;margin-bottom:10px}.sg-weight-metric{min-width:0;padding:8px 9px;border-radius:7px;background:var(--sg-soft)}.sg-weight-metric span{display:block;color:var(--sg-muted);font-size:10px}.sg-weight-metric strong{display:block;margin-top:2px;font-size:14px;font-weight:740;font-variant-numeric:tabular-nums;white-space:nowrap}.sg-weight-chart{position:relative;padding:8px 8px 4px;border:1px solid var(--sg-border);border-radius:9px;background:color-mix(in srgb,var(--sg-surface) 72%,transparent)}.sg-weight-chart svg{display:block;width:100%;height:auto;min-height:156px}.sg-weight-grid{stroke:var(--sg-border);stroke-width:1}.sg-weight-axis-label{fill:var(--sg-muted);font-size:9px}.sg-weight-line{fill:none;stroke:var(--sg-accent);stroke-width:2.5;stroke-linecap:round;stroke-linejoin:round}.sg-weight-node{fill:var(--sg-page);stroke:var(--sg-accent);stroke-width:2}.sg-weight-node.adoption{fill:var(--sg-accent);stroke:var(--sg-page);stroke-width:2.5}.sg-weight-node.current{fill:var(--sg-text);stroke:var(--sg-page);stroke-width:2}.sg-weight-node-label{fill:var(--sg-text);font-size:9px;font-weight:680}.sg-weight-note{margin:7px 0 0;color:var(--sg-muted);font-size:10px;line-height:1.5}.sg-weight-retrieval{margin-top:6px;color:var(--sg-muted);font-size:10px}.sg-weight-help{margin-top:10px;border-top:1px solid var(--sg-border)}.sg-weight-help summary{padding:9px 2px 2px;color:var(--sg-muted);font-size:11px;font-weight:650;cursor:pointer}.sg-weight-help[open] summary{color:var(--sg-text)}.sg-weight-help-body{padding:8px 0 2px}.sg-weight-help-copy{margin:0 0 7px;color:var(--sg-muted);font-size:11px;line-height:1.58}.sg-weight-demo{padding:8px;border-radius:8px;background:var(--sg-soft)}.sg-weight-demo-label{display:block;margin-bottom:4px;color:var(--sg-muted);font-size:9px}.sg-weight-demo svg{display:block;width:100%;height:76px}.sg-weight-demo path{fill:none;stroke:var(--sg-accent);stroke-width:2}.sg-weight-demo circle{fill:var(--sg-accent)}
      .sg-source-label{display:flex;align-items:center;gap:8px}.sg-source-icon{color:var(--sg-muted)}.sg-tech{margin-top:13px}.sg-tech summary{color:var(--sg-muted);font-size:12px;cursor:pointer}.sg-tech-body{margin-top:10px;padding:11px;border-radius:7px;background:var(--sg-soft);font-size:12px}.sg-tech-row{display:grid;grid-template-columns:88px minmax(0,1fr);gap:9px;padding:3px 0}.sg-code{font:12px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere}.sg-raw-message{padding-top:10px;margin-top:10px;border-top:1px solid var(--sg-border)}
      .sg-model-settings{margin-bottom:12px;padding:16px;min-width:0}.sg-model-heading-row{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:4px}.sg-model-heading{margin:0;font-size:15px;font-weight:650;line-height:1.4}.sg-model-intro{margin:0;color:var(--sg-muted);font-size:13px;line-height:1.5}
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
        --sg-subtle:color-mix(in srgb,var(--sg-text) 78%,var(--sg-page));
        --sg-moss:color-mix(in srgb,var(--dsw-alias-state-success-primary,#5f7f4d) 62%,var(--sg-text));
        --sg-moss-deep:color-mix(in srgb,var(--sg-moss) 68%,var(--sg-text));
        --sg-moss-soft:color-mix(in srgb,var(--sg-moss) 11%,var(--sg-page));
        --sg-sand:color-mix(in srgb,var(--dsw-alias-state-warn-label,#a9822f) 74%,var(--sg-text));
        --sg-sand-deep:color-mix(in srgb,var(--sg-sand) 64%,var(--sg-text));
        --sg-sand-soft:color-mix(in srgb,var(--sg-sand) 13%,var(--sg-page));
        --sg-water:color-mix(in srgb,var(--dsw-alias-state-business-primary,#3f6d9c) 68%,var(--sg-text));
        --sg-water-deep:color-mix(in srgb,var(--sg-water) 62%,var(--sg-text));
        --sg-water-soft:color-mix(in srgb,var(--sg-water) 14%,var(--sg-page));
        --sg-sans:"Noto Sans SC","Microsoft YaHei UI","Microsoft YaHei","PingFang SC","Segoe UI",sans-serif;
        --sg-serif:"Noto Serif SC","Source Han Serif SC","Songti SC","Microsoft YaHei UI","Microsoft YaHei","Times New Roman",serif;
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
      .sg-pg-title{display:inline-flex;align-items:center;gap:10px;min-width:0}
      .sg-pg-end .sg-conversation{font-size:12px;gap:6px}
      .sg-pg-end .sg-conversation select{padding:4px 24px 4px 10px;border-radius:6px;background:var(--sg-page);color:var(--sg-text);font-size:12px}
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

      /* Share the approved top bar across views; keep page-body styling local. */
      .sg-memory-panel{container:sg-memory-host / inline-size}
      .sg-memory.sg-unified-top{
        --sg-top-sans:"Noto Sans SC","Microsoft YaHei UI","Microsoft YaHei","PingFang SC","Segoe UI",sans-serif;
        --sg-top-serif:"Noto Serif SC","Source Han Serif SC","Songti SC","Microsoft YaHei UI","Microsoft YaHei","Times New Roman",serif;
        --sg-overview-unit:clamp(.48px,.05733945cqi,1px);
        --sg-overview-gutter:clamp(16px,2.6087cqi,48px);
        max-width:1920px;padding:calc(30 * var(--sg-overview-unit)) var(--sg-overview-gutter) calc(32 * var(--sg-overview-unit));
      }
      .sg-memory.sg-overview-page{
        --sg-sans:var(--sg-top-sans);--sg-serif:var(--sg-top-serif);
        --sg-ink:color-mix(in srgb,#3d3c38 88%,var(--sg-text));
        --sg-moss:#607f4e;--sg-water:#426f9b;--sg-sand:#a98431;
        font-family:var(--sg-sans);
      }
      .sg-unified-top .sg-header-row-primary,.sg-unified-top .sg-tabs{
        --sg-serif:var(--sg-top-serif);
        --sg-ink:color-mix(in srgb,#3d3c38 88%,var(--sg-text));
        --sg-moss:#607f4e;--sg-water:#426f9b;--sg-sand:#a98431;
        font-family:var(--sg-top-sans);
      }
      .sg-page-body{display:contents}
      .sg-memory.sg-unified-top:not(.sg-overview-page){padding-bottom:0}
      .sg-unified-top:not(.sg-overview-page) .sg-page-body{
        display:block;container:sg-memory / inline-size;box-sizing:border-box;
        --sg-body-gutter:clamp(16px,2.7523cqi,48px);
        width:min(1200px,calc(100% + 2 * var(--sg-body-gutter)));
        margin-inline:calc((100% - min(1200px,calc(100% + 2 * var(--sg-body-gutter)))) / 2);
        padding:max(6px,calc(62 * var(--sg-overview-unit) - 24px)) 20px 36px;
      }
      .sg-unified-top.sg-settings-page .sg-page-body{container-name:sg-settings}
      @media (max-width:560px){.sg-unified-top:not(.sg-overview-page) .sg-page-body{padding-inline:12px;padding-bottom:26px}}
      .sg-unified-top .sg-header{padding:calc(6 * var(--sg-overview-unit)) 0 0}
      .sg-unified-top .sg-header-row{padding:0}
      .sg-unified-top .sg-brand{gap:calc(20 * var(--sg-overview-unit))}
      .sg-unified-top .sg-logo{width:calc(46 * var(--sg-overview-unit));height:calc(46 * var(--sg-overview-unit))}
      .sg-unified-top .sg-brand-title{gap:calc(16 * var(--sg-overview-unit));flex-wrap:nowrap}
      .sg-unified-top .sg-brand-name{font-family:var(--sg-serif);font-size:calc(34 * var(--sg-overview-unit));font-weight:600}
      .sg-unified-top .sg-brand-version{font-size:calc(24 * var(--sg-overview-unit));font-weight:400}
      .sg-unified-top .sg-header-usage{gap:calc(16 * var(--sg-overview-unit));font-size:calc(20 * var(--sg-overview-unit))}
      .sg-unified-top .sg-header-end{gap:calc(16 * var(--sg-overview-unit))}
      .sg-unified-top .sg-project{min-height:calc(56 * var(--sg-overview-unit));min-width:calc(210 * var(--sg-overview-unit));padding:0 calc(14 * var(--sg-overview-unit));gap:calc(12 * var(--sg-overview-unit));font-size:calc(24 * var(--sg-overview-unit));border-radius:calc(10 * var(--sg-overview-unit))}
      .sg-unified-top .sg-project-label{display:none}
      .sg-unified-top .sg-project-select{flex:1;width:auto;max-width:20ch;font-size:calc(24 * var(--sg-overview-unit));font-weight:400}
      .sg-unified-top .sg-ghstar{height:calc(56 * var(--sg-overview-unit));min-width:calc(220 * var(--sg-overview-unit));font-size:calc(24 * var(--sg-overview-unit));border-radius:calc(10 * var(--sg-overview-unit));color:color-mix(in srgb,var(--sg-text) 45%,var(--sg-muted))}
      .sg-unified-top .sg-ghstar:hover{color:var(--sg-text)}
      .sg-unified-top .sg-ghstar-label,.sg-unified-top .sg-ghstar-count{padding:0 calc(18 * var(--sg-overview-unit))}
      .sg-unified-top .sg-ghstar-label{flex:1;justify-content:center;gap:calc(12 * var(--sg-overview-unit))}
      .sg-unified-top .sg-ghstar-icon{width:calc(27 * var(--sg-overview-unit));height:calc(27 * var(--sg-overview-unit))}
      .sg-unified-top .sg-ghstar-count{min-width:calc(82 * var(--sg-overview-unit));justify-content:center;font-family:inherit}
      .sg-unified-top .sg-tabs{gap:calc(24 * var(--sg-overview-unit));margin:calc(22 * var(--sg-overview-unit)) calc(-1 * var(--sg-overview-gutter)) 0;padding:0 var(--sg-overview-gutter)}
      .sg-unified-top .sg-tab{gap:calc(12 * var(--sg-overview-unit));padding:calc(14 * var(--sg-overview-unit)) calc(14 * var(--sg-overview-unit)) calc(20 * var(--sg-overview-unit));font-size:calc(26 * var(--sg-overview-unit));color:color-mix(in srgb,var(--sg-text) 35%,var(--sg-muted))}
      .sg-unified-top .sg-tab.active{color:var(--sg-text)}
      .sg-unified-top .sg-tab-swatch{width:calc(17 * var(--sg-overview-unit));height:calc(17 * var(--sg-overview-unit));border-radius:3px}
      /* Native control/readability floors need less surrounding space as the
         panel narrows; retain the original spacing at the reference width. */
      .sg-overview-page .sg-view{padding-top:max(6px,calc(62 * var(--sg-overview-unit) - 24px))}
      .sg-overview-page .sg-footer{margin:max(12px,calc(50 * var(--sg-overview-unit) - 11px)) calc(-1 * var(--sg-overview-gutter)) 0;padding:calc(26 * var(--sg-overview-unit)) var(--sg-overview-gutter) 0;font-size:calc(23 * var(--sg-overview-unit));flex-wrap:wrap}
      .sg-overview-page .sg-footer-links{display:inline-flex;align-items:center;gap:calc(8 * var(--sg-overview-unit));flex-wrap:wrap}
      .sg-overview-page .sg-footer a{color:inherit;text-decoration:none}
      .sg-overview-page .sg-footer a:hover{text-decoration:underline}
      .sg-ov{--sg-bar-width:calc(168 * var(--sg-overview-unit));display:grid;gap:calc(55 * var(--sg-overview-unit));min-width:0}
      .sg-ov-top{display:grid;grid-template-columns:minmax(0,25%) minmax(0,1fr);gap:calc(44 * var(--sg-overview-unit));align-items:start}
      .sg-ov-big{display:flex;align-items:flex-end;gap:calc(14 * var(--sg-overview-unit));min-width:0}
      .sg-ov-big b{font:400 calc(144 * var(--sg-overview-unit))/.925 "Times New Roman",var(--sg-serif);letter-spacing:0}
      .sg-ov-speech{display:block;width:calc(54 * var(--sg-overview-unit));height:calc(48 * var(--sg-overview-unit));flex:none;color:var(--sg-text)}
      .sg-ov-big .sg-ov-speech{margin-bottom:calc(6 * var(--sg-overview-unit))}
      .sg-ov-summary{margin:calc(32 * var(--sg-overview-unit)) 0 0;color:color-mix(in srgb,var(--sg-text) 35%,var(--sg-muted));font-size:calc(24 * var(--sg-overview-unit));line-height:1.6;text-wrap:pretty}
      .sg-memory .sg-ov-dreaming{display:flex;align-items:center;justify-content:space-between;gap:4px 12px;flex-wrap:wrap;width:min(100%,290px);margin-top:calc(28 * var(--sg-overview-unit));padding-top:8px;border-top:1px solid var(--sg-hair);font-size:clamp(12px,calc(24 * var(--sg-overview-unit)),15px)}
      .sg-ov-dreaming-controls{display:flex;align-items:center;gap:5px;min-width:0}
      .sg-ov-dreaming .sg-dreaming-quiet{display:inline-flex;align-items:center;gap:7px;min-height:28px;padding:2px 0;border:0;background:none;color:var(--sg-text);white-space:nowrap;font:inherit;cursor:pointer}
      .sg-ov-dreaming .sg-dreaming-quiet:hover:not(:disabled){color:var(--sg-moss);text-decoration:underline;text-underline-offset:.22em}
      .sg-ov-dreaming .sg-dreaming-quiet:disabled{color:var(--sg-muted);cursor:default}
      .sg-ov-dreaming .sg-dreaming-quiet.sg-dreaming-icon{justify-content:center;min-width:28px;color:var(--sg-muted)}
      .sg-ov-dreaming .sg-dreaming-read{margin-left:auto}
      .sg-ov-dreaming svg,.sg-daily-letter svg{width:15px;height:15px;flex:none;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
      .sg-ov-dreaming svg{color:var(--sg-moss)}
      .sg-ov-dreaming>p{flex-basis:100%;margin:0}
      dialog.sg-daily-letter{--line:34px;--ink:var(--sg-text);--letter-link:color-mix(in srgb,var(--sg-moss) 65%,var(--sg-text));--paper:color-mix(in srgb,var(--sg-sand) 7%,var(--sg-page));width:min(610px,calc(100% - 30px));max-height:calc(100dvh - 30px);margin:auto;padding:0;border:1px solid var(--sg-border);border-radius:5px;background:var(--paper);color:var(--ink);box-shadow:0 20px 70px #292b2245;overscroll-behavior:contain}
      .sg-daily-letter::backdrop{background:#29282038;backdrop-filter:blur(5px)}
      .sg-daily-letter article{padding:24px clamp(19px,4.2vw,53px)}
      .sg-daily-letter header{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:10px}
      .sg-daily-letter time{color:var(--sg-muted);font:12px var(--sg-mono);font-variant-numeric:tabular-nums}
      .sg-daily-letter h2{margin:0 0 13px;font:400 clamp(27px,4vw,36px)/1.35 "STKaiti","KaiTi","Kaiti SC",serif;color:var(--ink);overflow-wrap:anywhere}
      .sg-daily-letter-lines{background:repeating-linear-gradient(to bottom,transparent 0 calc(var(--line) - 6px),var(--sg-hair) calc(var(--line) - 6px) calc(var(--line) - 5px),transparent calc(var(--line) - 5px) var(--line));font:400 clamp(18px,2.1vw,21px)/var(--line) "STKaiti","KaiTi","Kaiti SC",serif;overflow-wrap:anywhere;text-wrap:pretty}
      .sg-daily-letter-lines p{margin:0}
      .sg-daily-letter-lines p+p{margin-top:var(--line)}
      .sg-daily-letter-signature{text-align:right}
      .sg-daily-letter button,.sg-daily-letter summary{border:0;background:none;color:var(--letter-link);font:inherit;cursor:pointer}
      .sg-daily-letter button:hover,.sg-daily-letter summary:hover{text-decoration:underline;text-underline-offset:.2em}
      .sg-daily-letter button:focus-visible,.sg-daily-letter summary:focus-visible{outline:2px solid var(--letter-link);outline-offset:2px}
      .sg-daily-letter .sg-daily-letter-close{display:grid;place-items:center;width:30px;height:30px;padding:0;border-radius:4px}
      .sg-daily-letter summary{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 0;list-style:none}
      .sg-daily-letter summary::-webkit-details-marker{display:none}
      .sg-daily-letter details[open] summary svg{transform:rotate(90deg)}
      .sg-daily-letter-changes{margin-top:17px;border-block:1px solid var(--sg-hair);font-size:13px;line-height:1.55}
      .sg-daily-letter-changes section{padding:10px 0 12px;border-top:1px solid var(--sg-hair)}
      .sg-daily-letter-changes h3{margin:0 0 7px;color:var(--letter-link);font-size:13px}
      .sg-daily-letter-changes ul{display:grid;gap:7px;list-style:none;padding:0;margin:0}
      .sg-daily-letter-changes li{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.65fr);gap:3px 12px;overflow-wrap:anywhere}
      .sg-daily-letter-changes li span{color:var(--sg-muted)}
      .sg-daily-letter-history{margin-top:8px;font-size:13px}
      .sg-daily-letter-history summary{justify-content:flex-end}
      .sg-daily-letter-dates{display:flex;justify-content:flex-end;gap:5px 8px;flex-wrap:wrap;max-height:120px;overflow:auto}
      .sg-daily-letter-dates button{padding:4px 7px;border-radius:4px}
      .sg-daily-letter-dates [aria-pressed="true"]{background:var(--sg-soft)}
      @media(max-width:520px){.sg-daily-letter{--line:31px}.sg-daily-letter-changes li{grid-template-columns:minmax(0,1fr)}}
      .sg-runtime-dot{display:inline-block;flex:none;width:13px;height:13px;border-radius:50%;background:var(--sg-muted)}
      .sg-unified-top .sg-runtime-dot{width:calc(13 * var(--sg-overview-unit));height:calc(13 * var(--sg-overview-unit))}
      .sg-runtime-dot[data-state="ok"]{background:#2d8b57}
      .sg-runtime-dot[data-state="processing"],.sg-runtime-dot[data-state="warning"]{background:#a98431}
      .sg-runtime-dot[data-state="failed"]{background:var(--sg-danger)}
      .sg-project .sg-runtime-dot{width:12px;height:12px}
      .sg-unified-top .sg-project .sg-runtime-dot{width:calc(12 * var(--sg-overview-unit));height:calc(12 * var(--sg-overview-unit))}
      .sg-pillar-group{min-width:0}
      .sg-pillar-cap{display:flex;flex-direction:column;align-items:center;gap:calc(10 * var(--sg-overview-unit));width:var(--sg-bar-width);height:calc(92 * var(--sg-overview-unit));padding-top:calc(6 * var(--sg-overview-unit))}
      .sg-pillar-cap:after{content:"";flex:none;width:3px;height:calc(20 * var(--sg-overview-unit));background:var(--sg-text)}
      .sg-pillar{display:grid;gap:0}
      .sg-memory .sg-pillar-row{display:grid;grid-template-columns:var(--sg-bar-width) minmax(0,1fr) auto;column-gap:calc(28 * var(--sg-overview-unit));align-items:center;width:100%;min-height:0;padding:0;border:0;border-radius:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer;position:relative}
      .sg-pillar-row:after{content:"";position:absolute;left:var(--sg-bar-width);right:0;bottom:0;border-bottom:1px solid var(--sg-hair);pointer-events:none}
      .sg-memory .sg-pillar-row:hover{background:color-mix(in srgb,var(--sg-soft) 65%,transparent)}
      .sg-pillar-row:focus-visible{outline:2px solid var(--sg-accent);outline-offset:3px}
      .sg-pillar-tail{display:flex;align-items:center;justify-content:flex-end;gap:calc(66 * var(--sg-overview-unit));min-width:0}
      .sg-pillar-bar{display:block;width:100%;height:calc(86 * var(--sg-overview-unit));margin:0 0 calc(6 * var(--sg-overview-unit));border-radius:3px 3px 0 0;background:var(--sg-ink)}
      .sg-pillar-bar.moss{height:calc(66 * var(--sg-overview-unit));background:var(--sg-moss)}
      .sg-pillar-bar.water{height:calc(94 * var(--sg-overview-unit));background:var(--sg-water)}
      .sg-pillar-bar.sand{height:calc(78 * var(--sg-overview-unit));background:var(--sg-sand)}
      .sg-pillar-bar.lib{height:calc(124 * var(--sg-overview-unit));margin:0;border:2px dashed var(--sg-moss);border-radius:3px;background:color-mix(in srgb,var(--sg-moss) 12%,var(--sg-page))}
      .sg-pillar-gap{height:0;margin:calc(16 * var(--sg-overview-unit)) 0 calc(16 * var(--sg-overview-unit)) calc(var(--sg-bar-width) + calc(24 * var(--sg-overview-unit)));border-top:1px dashed var(--sg-border)}
      .sg-pillar-name,.sg-pillar-use,.sg-pillar-val{display:flex;align-items:center;min-width:0}
      .sg-pillar-name b{font-size:calc(28 * var(--sg-overview-unit));font-weight:600;white-space:nowrap}
      .sg-pillar-use:empty{display:none}
      .sg-ov .sg-used{gap:calc(6 * var(--sg-overview-unit));font-family:inherit;font-size:calc(24 * var(--sg-overview-unit));line-height:1.2}
      .sg-ov .sg-used svg{width:calc(23 * var(--sg-overview-unit));height:calc(20 * var(--sg-overview-unit))}
      .sg-pillar-val{justify-content:flex-end;gap:calc(10 * var(--sg-overview-unit));min-width:calc(178 * var(--sg-overview-unit));color:var(--sg-muted);font-size:calc(23 * var(--sg-overview-unit));white-space:nowrap}
      .sg-pillar-val b{font:400 calc(40 * var(--sg-overview-unit))/1 var(--sg-serif);color:var(--sg-text)}
      .sg-pillar-key{display:flex;gap:calc(40 * var(--sg-overview-unit));flex-wrap:wrap;margin-top:calc(30 * var(--sg-overview-unit));color:var(--sg-muted);font-size:calc(23 * var(--sg-overview-unit))}
      .sg-pillar-key>span{display:inline-flex;align-items:center;gap:calc(10 * var(--sg-overview-unit))}
      .sg-pillar-key .sg-sw{width:calc(19 * var(--sg-overview-unit));height:calc(19 * var(--sg-overview-unit));border-radius:3px;background:var(--sg-ink)}
      .sg-pillar-key .sg-sw.lib{border:2px dashed currentColor;background:transparent;box-shadow:none}
      .sg-heat{padding-top:calc(32 * var(--sg-overview-unit));border-top:1px solid var(--sg-hair)}
      .sg-heat-head{display:flex;justify-content:space-between;gap:calc(16 * var(--sg-overview-unit));margin-bottom:calc(22 * var(--sg-overview-unit));color:var(--sg-muted);font-size:calc(23 * var(--sg-overview-unit))}
      .sg-heat-head>span:first-child{display:inline-flex;align-items:center;gap:calc(12 * var(--sg-overview-unit));color:var(--sg-text);font-weight:600}
      .sg-heat-grid{display:grid;grid-template-columns:repeat(28,minmax(0,1fr));gap:calc(8 * var(--sg-overview-unit))}
      .sg-heat-grid i{aspect-ratio:1;border-radius:calc(5 * var(--sg-overview-unit));background:var(--sg-sheet);box-shadow:inset 0 0 0 1px var(--sg-hair)}
      .sg-heat-scale{display:flex;justify-content:space-between;margin-top:calc(10 * var(--sg-overview-unit));color:var(--sg-muted);font-size:calc(21 * var(--sg-overview-unit))}
      /* Keep small text readable without restoring the reference's large
         desktop minimums inside a host sidebar or a scaled application. */
      @container (min-width:721px){
        .sg-unified-top .sg-header-row-primary{min-height:0}
        .sg-unified-top .sg-brand-name{font-size:max(18px,calc(34 * var(--sg-overview-unit)))}
        .sg-unified-top .sg-brand-version{font-size:max(12px,calc(24 * var(--sg-overview-unit)))}
        .sg-unified-top .sg-project{min-height:max(32px,calc(56 * var(--sg-overview-unit)));min-width:max(120px,calc(210 * var(--sg-overview-unit)))}
        .sg-unified-top .sg-project,.sg-unified-top .sg-project-select{font-size:max(13px,calc(24 * var(--sg-overview-unit)))}
        .sg-unified-top .sg-ghstar{height:max(32px,calc(56 * var(--sg-overview-unit)));min-width:max(126px,calc(220 * var(--sg-overview-unit)));font-size:max(13px,calc(24 * var(--sg-overview-unit)))}
        .sg-unified-top .sg-tab{font-size:max(14px,calc(26 * var(--sg-overview-unit)))}
        .sg-ov-summary{font-size:max(12px,calc(24 * var(--sg-overview-unit)))}
        .sg-pillar-name b{font-size:max(14px,calc(28 * var(--sg-overview-unit)))}
        .sg-pillar-val{font-size:max(12px,calc(23 * var(--sg-overview-unit)))}
        .sg-pillar-key,.sg-ov .sg-used,.sg-heat-head,.sg-overview-page .sg-footer{font-size:max(12px,calc(23 * var(--sg-overview-unit)))}
        .sg-heat-scale{font-size:max(11px,calc(21 * var(--sg-overview-unit)))}
      }
      @container (min-width:721px) and (max-width:820px){
        .sg-ov-top{grid-template-columns:minmax(220px,28%) minmax(0,1fr)}
      }
      @container (max-width:720px){
        .sg-unified-top .sg-runtime-dot{width:10px;height:10px}
        .sg-unified-top .sg-project .sg-runtime-dot{width:9px;height:9px}
        .sg-unified-top .sg-brand{gap:10px}
        .sg-unified-top .sg-logo{width:34px;height:34px}
        .sg-unified-top .sg-brand-title{gap:4px 10px}
        .sg-unified-top .sg-brand-name{font-size:24px}
        .sg-unified-top .sg-brand-version{font-size:12px}
        .sg-unified-top .sg-header-row-primary{flex-wrap:wrap;gap:16px}
        .sg-unified-top .sg-header-usage{gap:10px}
        .sg-unified-top .sg-project{min-width:0;padding:0 9px;gap:8px}
        .sg-unified-top .sg-project,.sg-unified-top .sg-project-select{font-size:14px;min-height:34px}
        .sg-unified-top .sg-header-end{gap:10px}
        .sg-unified-top .sg-ghstar{height:34px;min-width:0;font-size:14px}
        .sg-unified-top .sg-ghstar-label,.sg-unified-top .sg-ghstar-count{padding:0 9px}
        .sg-unified-top .sg-ghstar-label{gap:6px}
        .sg-unified-top .sg-ghstar-count{min-width:0}
        .sg-unified-top .sg-ghstar-icon{width:17px;height:17px}
        .sg-unified-top .sg-tabs{gap:8px;margin-top:20px}
        .sg-unified-top .sg-tab{flex:0 0 auto;gap:6px;padding:12px 6px;font-size:14px}
        .sg-unified-top .sg-tab-swatch{width:11px;height:11px}
        .sg-overview-page .sg-view{padding-top:28px}
        .sg-ov{--sg-bar-width:72px;gap:30px}
        .sg-ov-top{grid-template-columns:minmax(0,1fr);gap:24px}
        .sg-ov-big b{font-size:88px}
        .sg-ov-big .sg-ov-speech{width:38px;height:34px}
        .sg-ov-summary{margin-top:16px;font-size:16px}
        .sg-memory .sg-ov-dreaming{margin-top:18px}
        .sg-pillar-cap{height:66px;gap:6px}
        .sg-pillar-cap .sg-ov-speech{width:38px;height:34px}
        .sg-pillar-cap:after{height:14px;width:2px}
        .sg-memory .sg-pillar-row{column-gap:14px}
        .sg-pillar-bar{height:56px;margin-bottom:4px}
        .sg-pillar-bar.moss{height:44px}.sg-pillar-bar.water{height:60px}.sg-pillar-bar.sand{height:52px}.sg-pillar-bar.lib{height:80px}
        .sg-pillar-name b{font-size:18px}
        .sg-pillar-tail{gap:12px}
        .sg-pillar-val{gap:5px;min-width:0;font-size:14px}
        .sg-pillar-val b{font-size:28px}
        .sg-ov .sg-used{font-size:14px;gap:4px}
        .sg-ov .sg-used svg{width:16px;height:14px}
        .sg-pillar-gap{margin:12px 0 12px calc(var(--sg-bar-width) + 14px)}
        .sg-pillar-key{gap:20px;margin-top:20px;font-size:14px}
        .sg-pillar-key>span{gap:7px}.sg-pillar-key .sg-sw{width:13px;height:13px}
        .sg-heat{padding-top:22px}.sg-heat-head{margin-bottom:14px;font-size:14px}
        .sg-heat-grid{grid-template-columns:repeat(14,minmax(0,1fr));gap:5px}
        .sg-heat-grid i:nth-child(-n+14){display:none}
        .sg-heat-scale span:first-child{font-size:0}
        .sg-heat-scale span:first-child:before{content:'2 周前';font-size:13px}
        .sg-overview-page .sg-footer{font-size:13px;margin-top:30px;padding-top:20px}
      }
      @container (max-width:380px){
        .sg-unified-top .sg-tabs{gap:4px}
        .sg-unified-top .sg-tab{flex:0 0 auto;gap:4px;padding-inline:2px;font-size:12px}
        .sg-unified-top .sg-tab-swatch{width:9px;height:9px}
        .sg-ov{--sg-bar-width:52px}
        .sg-memory .sg-pillar-row{column-gap:10px}
        .sg-pillar-name b{font-size:16px}
        .sg-pillar-tail{gap:8px}
        .sg-pillar-val{font-size:12px;gap:4px}.sg-pillar-val b{font-size:25px}
        .sg-heat-head{gap:8px;font-size:12px}.sg-heat-head>span:first-child{gap:6px}
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
      @container sg-memory (min-width:761px){
        .sg-topic-directory .sg-book-preview{position:absolute;top:18px;right:22px;width:calc(50% - 46px);max-height:calc(100% - 36px);padding:0 0 0 26px;overflow:auto}
        .sg-topic-directory .sg-book-preview .sg-leaf-sum{display:block}
        .sg-topic-directory .sg-book>.sg-leaf{padding-right:calc(50% + 28px);min-height:320px}
        .sg-topic-directory .sg-book>.sg-leaf:after{content:"";position:absolute;left:50%;top:18px;bottom:18px;border-left:1px solid var(--sg-border);box-shadow:-1px 0 0 color-mix(in srgb,var(--sg-page) 70%,transparent);pointer-events:none}
        .sg-topic-directory .sg-directory-fold.open>.sg-directory-fold-inner>.sg-topic-section-body{position:absolute;top:var(--sg-reader-top,28px);left:var(--sg-reader-left,calc(50% + 28px));width:var(--sg-reader-width,calc(50% - 58px));max-height:calc(100vh - 56px);padding:0;border-top:0;overflow:auto;animation:sg-daily-fade .2s var(--sg-ease) both}
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

      /* 会话记忆：水蓝洗色地层条 + 右侧可交互刻度详情 */
      .sg-ss-list{min-width:0;border:0;border-radius:0;background:none;overflow:visible}
      .sg-memory .sg-ss-list .sg-block-unit+.sg-block-unit{border-top:0}
      .sg-visually-hidden{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
      .sg-ss{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,370px);gap:28px;align-items:start}
      .sg-ss.single{grid-template-columns:minmax(0,1fr)}
      .sg-ss-col{min-width:0}
      .sg-ss-main{display:grid;gap:5px;min-width:0}
      .sg-memory .sg-ss-main .sg-block-unit{min-width:0}
      .sg-memory .sg-ss-main .sg-block-toggle{position:relative;display:grid;grid-template-columns:72px minmax(0,1fr) auto;gap:12px;align-items:center;width:100%;min-height:var(--sh,36px);padding:6px 12px 6px 14px;border:0;border-radius:4px;background:color-mix(in srgb,var(--sg-water) var(--tint,10%),var(--sg-page));text-align:left;cursor:pointer;overflow:hidden;transition:box-shadow .14s ease,background-color .14s ease;font-variant-numeric:tabular-nums}
      .sg-memory .sg-ss-main .sg-block-toggle::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3.5px;background:var(--sg-water);opacity:var(--spine,.45)}
      .sg-memory .sg-ss-main .sg-block-toggle:hover{background:color-mix(in srgb,var(--sg-water) calc(var(--tint,10%) + 6%),var(--sg-page))}
      .sg-memory .sg-ss-main .sg-block-toggle[aria-current="true"]{box-shadow:inset 0 0 0 1.5px var(--sg-text);background:color-mix(in srgb,var(--sg-water) calc(var(--tint,10%) + 8%),var(--sg-page))}
      .sg-ss-turns{color:var(--sg-subtle);font-size:12.5px;font-weight:400;white-space:nowrap;font-variant-numeric:tabular-nums}
      .sg-ss-title{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:13.5px;font-weight:450;color:var(--sg-text)}
      .sg-ss-tail{display:grid;grid-template-columns:minmax(51px,auto) 56px;gap:10px;align-items:center;justify-items:start;font-size:12px;color:var(--sg-muted);white-space:nowrap}
      .sg-ss-cost{text-align:left;font-size:12px;font-weight:450;color:var(--sg-subtle);font-variant-numeric:tabular-nums}
      .sg-ss-meter{display:inline-flex;gap:3px;align-items:center;justify-self:start}
      .sg-ss-meter i{width:6px;height:10px;border-radius:1.5px;background:color-mix(in srgb,var(--sg-water) 20%,transparent)}
      .sg-ss-meter i.on{background:var(--sg-water)}
      .sg-ss-open{position:relative;display:grid;grid-template-columns:72px minmax(0,1fr) auto;gap:12px;align-items:center;width:100%;min-height:36px;padding:4.5px 10.5px 4.5px 12.5px;border-radius:4px;cursor:default;background:transparent;border:1.5px dashed color-mix(in srgb,var(--sg-water) 70%,transparent);font-variant-numeric:tabular-nums}
      .sg-ss-open .sg-ss-title,.sg-ss-open .sg-ss-cost{color:var(--sg-muted);font-weight:400}
      .sg-ss-dots{display:inline-flex;gap:3px;align-items:center;justify-self:start}
      .sg-ss-dots i{width:6px;height:6px;border-radius:50%;background:var(--sg-water)}
      .sg-ss-dots i.o{background:none;box-shadow:inset 0 0 0 1.2px var(--sg-water)}
      .sg-ss-foot{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:10px 12px 0 14px;font-size:12px;color:var(--sg-muted)}
      .sg-ss-scale{display:inline-flex;align-items:center;gap:7px;color:var(--sg-muted);font-size:11.5px;white-space:nowrap}
      .sg-ss-scale .sg-r{display:inline-flex;align-items:flex-end;gap:2px}
      .sg-ss-scale .sg-r i{width:11px;border-radius:1.5px;background:var(--sg-water)}
      .sg-ss-total{color:var(--sg-subtle);font-weight:450;white-space:nowrap;font-variant-numeric:tabular-nums}
      .sg-ss-side{min-width:0;padding-top:12px;border-top:1.5px solid var(--sg-text)}
      .sg-ss-side h3{margin:0;font-family:var(--sg-serif);font-size:16.5px;font-weight:700;line-height:1.45;color:var(--sg-text)}
      .sg-ss-meta{margin:3px 0 14px;color:var(--sg-muted);font-size:12px;font-variant-numeric:tabular-nums}
      .sg-ss-step-bars{display:grid;grid-template-columns:.94fr .94fr .94fr .94fr 1.18fr .94fr;gap:4px;margin-bottom:8px}
      .sg-memory .sg-ss-step-bar{position:relative;height:8px;border:0;padding:0;border-radius:2px;background:var(--sg-soft);box-shadow:inset 0 0 0 1px var(--sg-hair);cursor:pointer;transition:background-color .14s ease,transform .12s ease}
      .sg-memory .sg-ss-step-bar.filled{background:color-mix(in srgb,var(--sg-water) 42%,var(--sg-page));box-shadow:none}
      .sg-memory .sg-ss-step-bar.current{background:var(--sg-water-deep);box-shadow:none}
      .sg-memory .sg-ss-step-bar.current::after{content:"";position:absolute;left:50%;top:100%;transform:translateX(-50%);border:4px solid transparent;border-top-color:var(--sg-water-deep)}
      .sg-memory .sg-ss-step-bar:hover{transform:translateY(-1px)}
      .sg-ss-step-pills{display:grid;grid-template-columns:.94fr .94fr .94fr .94fr 1.18fr .94fr;gap:4px;margin-bottom:14px}
      .sg-memory .sg-ss-step-pill{position:relative;border:1px solid transparent;border-radius:6px;background:var(--sg-sheet);padding:7px 2px 6px;cursor:pointer;display:grid;gap:2px;justify-items:center;min-width:0;transition:background-color .14s ease,border-color .14s ease}
      .sg-memory .sg-ss-step-pill:hover,.sg-memory .sg-ss-step-pill:focus-visible{background:color-mix(in srgb,var(--sg-water) 8%,var(--sg-sheet));z-index:10}
      .sg-memory .sg-ss-step-pill[aria-checked="true"]{background:var(--sg-water-soft);border-color:color-mix(in srgb,var(--sg-water) 45%,transparent);font-weight:600}
      .sg-memory .sg-ss-step-pill.applied{box-shadow:inset 0 -2px 0 var(--sg-water-deep)}
      .sg-ss-step-pill .pn{font-size:11px;white-space:nowrap;color:var(--sg-text)}
      .sg-ss-step-pill .pc{font-size:11px;color:var(--sg-muted);font-variant-numeric:tabular-nums}
      .sg-ss-step-tip{position:absolute;top:calc(100% + 7px);left:50%;transform:translateX(-50%) translateY(-2px);opacity:0;pointer-events:none;white-space:nowrap;padding:5px 9px;border-radius:6px;background:var(--sg-text);color:var(--sg-page);font-size:11.5px;font-weight:400;line-height:1.35;box-shadow:0 8px 20px rgba(0,0,0,.18);transition:opacity .12s ease,transform .12s ease;z-index:20}
      .sg-ss-step-tip::before{content:"";position:absolute;bottom:100%;left:50%;transform:translateX(-50%);border:4px solid transparent;border-bottom-color:var(--sg-text)}
      .sg-ss-step-pill.tip-left .sg-ss-step-tip{left:0;transform:translateY(-2px)}
      .sg-ss-step-pill.tip-left .sg-ss-step-tip::before{left:22px;transform:none}
      .sg-ss-step-pill.tip-right .sg-ss-step-tip{left:auto;right:0;transform:translateY(-2px)}
      .sg-ss-step-pill.tip-right .sg-ss-step-tip::before{left:auto;right:22px;transform:none}
      .sg-ss-step-pill:hover .sg-ss-step-tip,.sg-ss-step-pill:focus-visible .sg-ss-step-tip{opacity:1;transform:translateX(-50%) translateY(0)}
      .sg-ss-step-pill.tip-left:hover .sg-ss-step-tip,.sg-ss-step-pill.tip-left:focus-visible .sg-ss-step-tip,.sg-ss-step-pill.tip-right:hover .sg-ss-step-tip,.sg-ss-step-pill.tip-right:focus-visible .sg-ss-step-tip{opacity:1;transform:translateY(0)}
      .sg-ss-preview{border:1px solid var(--sg-hair);border-radius:8px;background:var(--sg-sheet);padding:11px 13px;font-size:13px;line-height:1.72;white-space:pre-wrap;overflow-wrap:anywhere;max-height:230px;overflow:auto;color:var(--sg-text)}
      .sg-ss-virtual-note{margin:8px 0 0;color:var(--sg-muted);font-size:11.5px}
      .sg-ss-apply{display:flex;justify-content:space-between;gap:10px;align-items:center;margin-top:12px;font-size:12px;color:var(--sg-muted)}
      .sg-ss-apply-delta{color:var(--sg-text);font-weight:600;font-variant-numeric:tabular-nums}
      .sg-ss-apply-right{display:flex;align-items:center;gap:10px;margin-left:auto}
      .sg-memory .sg-ss-ghost{border:0;background:none;padding:4px 6px;color:var(--sg-muted);cursor:pointer;font-size:12px}
      .sg-memory .sg-ss-ghost:hover{color:var(--sg-text);text-decoration:underline}
      .sg-memory .sg-ss-primary{border:0;border-radius:7px;background:var(--sg-water);color:#fff;padding:7px 15px;cursor:pointer;font-weight:600;font-size:13px}
      .sg-memory .sg-ss-primary:hover:not(:disabled){filter:brightness(1.06)}
      .sg-memory .sg-ss-primary:disabled{background:var(--sg-soft);color:var(--sg-muted);cursor:default}
      @container sg-memory (max-width:740px){.sg-ss{grid-template-columns:minmax(0,1fr);gap:18px}}
      @container sg-memory (max-width:480px){
        .sg-memory .sg-ss-main .sg-block-toggle,.sg-ss-open{grid-template-columns:64px minmax(0,1fr);gap:6px 10px}
        .sg-ss-tail{grid-column:2;justify-self:start}
        .sg-ss-step-bars{display:none}
        .sg-ss-step-pills{grid-template-columns:repeat(3,minmax(0,1fr))}
      }

      /* 短期记忆：按天排列 */
      .sg-daily-split{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,390px);gap:28px;align-items:start}
      .sg-daily-split.single{grid-template-columns:minmax(0,1fr)}
      .sg-days{display:grid;gap:6px;min-width:0}
      .sg-day-month{display:flex;align-items:center;gap:8px;margin:8px 0 2px;font:11.5px/1.3 var(--sg-sans);font-variant-numeric:tabular-nums;color:var(--sg-muted)}
      .sg-day-month:after{content:"";flex:1;border-top:1px solid var(--sg-hair)}
      .sg-day{position:relative;display:grid;grid-template-columns:64px minmax(0,1fr) auto;gap:12px;align-items:center;padding:10px 12px 10px 15px;border-radius:5px;background:color-mix(in srgb,var(--sg-sand) 9%,var(--sg-page));cursor:pointer;overflow:hidden;transition:background-color .14s ease,box-shadow .14s ease;animation:sg-r6-rise .35s both}
      .sg-day::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3.5px;background:var(--sg-sand);opacity:.82;transition:opacity .14s ease}
      .sg-day:hover{background:color-mix(in srgb,var(--sg-sand) 14%,var(--sg-page))}
      .sg-day.selected{background:color-mix(in srgb,var(--sg-sand) 16%,var(--sg-page));box-shadow:inset 0 0 0 1.5px var(--sg-text)}
      .sg-day.selected::before{opacity:1}
      .sg-day.out{background:transparent;border:1px solid var(--sg-hair);padding:9px 11px 9px 14px}
      .sg-day.out::before{background:var(--sg-border);opacity:.9}
      .sg-day.out:hover{background:var(--sg-sheet)}
      .sg-day.out.selected{border-color:transparent;background:var(--sg-sheet);box-shadow:inset 0 0 0 1.5px var(--sg-text)}
      .sg-day-d{display:block;width:100%;padding:0;border:0;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer}
      .sg-day-d b{display:block;font:400 22px/1.05 var(--sg-serif);color:var(--sg-text);font-variant-numeric:tabular-nums}
      .sg-day.out .sg-day-d b{color:var(--sg-muted)}
      .sg-day.out.selected .sg-day-d b{color:var(--sg-text)}
      .sg-day-d span{display:block;margin-top:2px;font-size:11.5px;line-height:1.35;color:var(--sg-muted);white-space:nowrap}
      .sg-day ul{margin:0;padding:0;list-style:none;min-width:0;display:grid;gap:4px}
      .sg-day li{display:flex;align-items:center;gap:8px;min-width:0;font-size:13.5px;line-height:1.45}
      .sg-memory .sg-day li .sg-day-s{min-width:0;flex:1 1 auto;padding:0;border:0;background:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--sg-text);text-align:left;font:inherit;font-weight:400;cursor:pointer}
      .sg-memory .sg-day li .sg-day-s:hover{color:var(--sg-sand-deep);text-decoration:underline;text-underline-offset:3px}
      .sg-day.out li .sg-day-s{color:var(--sg-subtle)}
      .sg-day-more{font-size:11.5px;color:var(--sg-muted)}
      .sg-day-tail{display:inline-flex;align-items:center;gap:4px;align-self:center;font-family:var(--sg-sans);font-size:12.5px;line-height:1.4;font-weight:450;font-variant-numeric:tabular-nums;color:var(--sg-subtle);white-space:nowrap}
      .sg-day.out .sg-day-tail{color:var(--sg-muted)}
      .sg-day-chev{display:inline-flex;align-items:center;opacity:.58;transition:transform .14s ease,opacity .14s ease}
      .sg-day-chev svg{width:14px;height:14px;display:block}
      .sg-day:hover .sg-day-chev,.sg-day.selected .sg-day-chev{opacity:1;transform:translateX(1px)}
      .sg-day-cut{display:flex;align-items:center;gap:8px;margin:4px 2px;color:var(--sg-muted);font-size:11px}
      .sg-day-cut::before{content:"";flex:0 0 14px;border-top:1px dashed var(--sg-border)}
      .sg-day-cut::after{content:"";flex:1;border-top:1px dashed var(--sg-border)}
      .sg-daily-actions{display:flex;align-items:center;gap:6px}
      .sg-stp-label{font-size:12px;color:var(--sg-muted);white-space:nowrap}
      .sg-stp{display:inline-flex;align-items:center;overflow:hidden;border:1px solid var(--sg-border);border-radius:7px;font-size:12.5px}
      .sg-memory .sg-stp button{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;border:0;background:none;color:var(--sg-muted);font-size:14px;line-height:1;cursor:pointer}
      .sg-memory .sg-stp button:hover:not(:disabled){background:var(--sg-soft);color:var(--sg-text)}
      .sg-memory .sg-stp button:disabled{opacity:.4;cursor:default}
      .sg-stp.sg-stp-wide{border:0;gap:0}
      .sg-stp.sg-stp-wide .sg-number-input{width:66px;margin:0 0 0 -1px;height:28px;text-align:center;border-radius:0;font-family:var(--sg-sans);font-variant-numeric:tabular-nums;font-size:12.5px;padding:0 2px;-moz-appearance:textfield}
      .sg-stp.sg-stp-wide .sg-number-input::-webkit-outer-spin-button,.sg-stp.sg-stp-wide .sg-number-input::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}
      .sg-stp.sg-stp-wide button{width:26px;height:28px;border:1px solid var(--sg-border)}
      .sg-stp.sg-stp-wide button:first-child{border-radius:7px 0 0 7px}
      .sg-stp.sg-stp-wide button:last-child{border-radius:0 7px 7px 0;border-left:0}
      .sg-stp span{display:inline-flex;align-items:center;justify-content:center;min-width:48px;height:26px;padding:0 8px;border-inline:1px solid var(--sg-border);text-align:center;line-height:1;font-family:var(--sg-sans);font-variant-numeric:tabular-nums}
      .sg-memory .sg-daily-note{position:sticky;top:14px;max-width:none;padding-top:12px;border-top:1.5px solid var(--sg-text);min-width:0;animation:sg-daily-fade .2s var(--sg-ease) both}
      .sg-memory .sg-daily-note-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:6px}
      .sg-memory .sg-daily-note-date{margin:0;gap:2px 10px}
      .sg-memory .sg-daily-note-date h3{margin:0;font-family:var(--sg-serif);font-size:20px;font-weight:700;line-height:1.25}
      .sg-memory .sg-daily-note-date span{font-size:12px;color:var(--sg-muted)}
      .sg-memory .sg-daily-close{flex:0 0 auto;border:1px solid var(--sg-border);border-radius:6px;background:var(--sg-page);color:var(--sg-muted);padding:3px 9px;font-size:12px;cursor:pointer}
      .sg-memory .sg-daily-close:hover{background:var(--sg-soft);color:var(--sg-text)}
      .sg-memory .sg-daily-meta{margin-bottom:12px;gap:8px}
      .sg-memory .sg-daily-pill{background:var(--sg-sand-soft);color:var(--sg-sand-deep)}
      .sg-memory .sg-daily-pill.muted{background:var(--sg-soft);color:var(--sg-muted)}
      .sg-memory .sg-daily-back{color:var(--sg-sand-deep)}
      .sg-memory .sg-daily-sheet{border:1px solid var(--sg-hair);border-radius:8px;background:var(--sg-sheet);padding:14px 16px}
      .sg-memory .sg-daily-item{padding:12px 0;border-top:1px solid var(--sg-hair);font-family:inherit}
      .sg-memory .sg-daily-item:first-child{border-top:0;padding-top:0}
      .sg-memory .sg-daily-item:last-child{padding-bottom:0}
      .sg-memory .sg-daily-item h4{margin:0 0 6px;font-size:14.5px;font-weight:650;line-height:1.45;color:var(--sg-text)}
      .sg-memory .sg-daily-status{margin:0 0 7px;font-size:13px;line-height:1.6}
      .sg-memory .sg-daily-status b{background:var(--sg-sand-soft);color:var(--sg-sand-deep)}
      .sg-memory .sg-daily-status.done b{background:var(--sg-good-soft);color:var(--sg-good)}
      .sg-memory .sg-daily-item p{margin:5px 0;font-size:13px;line-height:1.68;color:var(--sg-subtle)}
      .sg-memory .sg-daily-item ul{margin:4px 0 0;padding-left:18px;font-size:13px;line-height:1.65;color:var(--sg-subtle)}
      .sg-memory .sg-daily-item li+li{margin-top:4px}
      .sg-memory .sg-daily-note code{white-space:normal;overflow-wrap:break-word;word-break:break-word;font-family:var(--sg-mono),"Noto Sans SC","Microsoft YaHei UI","Microsoft YaHei","PingFang SC",monospace;font-size:11.5px;padding:1px 5px;border-radius:4px;background:var(--sg-soft)}
      .sg-memory .sg-daily-off{margin:0 0 14px;border:1px solid var(--sg-hair);background:var(--sg-sheet)}
      .sg-memory .sg-daily-state{padding:28px 20px;border:1px solid var(--sg-hair);border-radius:10px;background:var(--sg-sheet)}
      .sg-memory .sg-daily-state:not(.error) .sg-daily-icon-wrap{background:var(--sg-sand-soft);color:var(--sg-sand-deep)}
      @container sg-daily (max-width:740px){
        .sg-daily-split{grid-template-columns:minmax(0,1fr);gap:16px}
        .sg-memory .sg-daily-note{position:static;order:-1}
      }
      @container sg-daily (max-width:480px){
        .sg-day{grid-template-columns:58px minmax(0,1fr) auto;gap:10px;padding:9px 10px 9px 12px}
        .sg-day.out{padding:8px 9px 8px 11px}
        .sg-day-d b{font-size:19px}
      }

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
      .sg-settings-columns{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;align-items:start;min-width:0}
      .sg-settings-column{display:grid;gap:14px;align-content:start;min-width:0}
      .sg-settings-column>.sg-model-settings,.sg-settings-column>.sg-settings-panel,.sg-settings-column>.sg-storage-card{margin-bottom:0;min-width:0}
      .sg-settings-group>.sg-settings-columns{margin-top:2px}
      .sg-settings-group.sg-settings-compact{padding-bottom:4px}
      .sg-settings-shell .sg-settings-group-copy{display:none}
      .sg-settings-shell .sg-pg-head{margin-bottom:10px}
      .sg-memory .sg-dreaming-setting{margin:0 0 16px;padding:14px}
      .sg-dreaming-setting-head{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
      .sg-dreaming-setting-icon{display:grid;place-items:center;flex:none;width:36px;height:36px;border-radius:9px;background:var(--sg-soft);color:var(--sg-text);font:24px/1 'Segoe UI Symbol',sans-serif}
      .sg-dreaming-setting-title{flex:1;min-width:0;margin:0;font-size:14px;font-weight:650}
      .sg-dreaming-setting-actions{display:inline-flex;align-items:center;gap:8px;flex-wrap:wrap}
      .sg-memory .sg-dreaming-setting .sg-dreaming-setting-start{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:34px;margin:0;padding:6px 12px;font:inherit;font-size:12px;font-weight:650;white-space:nowrap;transition:background-color var(--sg-fast) var(--sg-ease)}
      .sg-memory .sg-dreaming-setting .sg-dreaming-open-letter{display:inline-flex;align-items:center;gap:5px;min-height:34px;padding:6px 12px;border:1px solid var(--sg-border);border-radius:7px;background:var(--sg-page);color:var(--sg-text);font-size:12px;font-weight:550;cursor:pointer;white-space:nowrap}
      .sg-memory .sg-dreaming-setting .sg-dreaming-open-letter:hover{border-color:var(--sg-accent);color:var(--sg-accent)}
      .sg-dreaming-setting-start:focus-visible{outline:2px solid var(--sg-accent);outline-offset:3px}
      .sg-memory .sg-dreaming-setting .sg-dreaming{margin-top:12px;padding:12px;border-radius:8px}
      .sg-memory .sg-dreaming-setting .sg-dreaming-actions,.sg-memory .sg-dreaming-setting .sg-dreaming-session{margin-left:0}
      .sg-dreaming-setting .sg-dreaming-failure{overflow-wrap:anywhere}
      .sg-memory .sg-dreaming-setting .sg-dreaming-toast{margin:10px 0 0}
      .sg-dreaming-prefs{margin-top:12px;padding-top:12px;border-top:1px solid var(--sg-hair);display:grid;gap:10px}
      .sg-dreaming-pref-row{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;min-width:0}
      .sg-dreaming-pref-copy{display:grid;gap:2px;flex:1 1 200px;min-width:0}
      .sg-dreaming-pref-label{font-size:13px;font-weight:550;color:var(--sg-text);overflow-wrap:anywhere}
      .sg-dreaming-pref-desc{font-size:11.5px;color:var(--sg-muted);line-height:1.5;overflow-wrap:anywhere}
      .sg-dreaming-budget-ctrl{display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}
      .sg-dreaming-budget-input{width:84px;min-height:30px;padding:3px 8px;border:1px solid var(--sg-border);border-radius:7px;background:var(--sg-page);color:var(--sg-text);font:500 12.5px var(--sg-mono);font-variant-numeric:tabular-nums;text-align:right}
      .sg-dreaming-budget-input:focus-visible{outline:2px solid var(--sg-accent);outline-offset:1px}
      .sg-dreaming-budget-unit{font-size:12px;color:var(--sg-muted);white-space:nowrap}
      .sg-dreaming-budget-save{min-height:30px;padding:0 10px;border:1px solid var(--sg-border);border-radius:7px;background:var(--sg-page);color:var(--sg-text);font-size:12px;font-weight:550;cursor:pointer;white-space:nowrap}
      .sg-dreaming-budget-save:hover:not(:disabled){border-color:var(--sg-accent);color:var(--sg-accent)}
      .sg-dreaming-budget-save:disabled{opacity:.5;cursor:default}
      .sg-dreaming-usage{display:grid;gap:6px;padding:10px 12px;border-radius:8px;background:var(--sg-soft);min-width:0}
      .sg-dreaming-usage-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;flex-wrap:wrap;min-width:0}
      .sg-dreaming-usage-nums{font:600 12px var(--sg-mono);font-variant-numeric:tabular-nums;color:var(--sg-text);overflow-wrap:anywhere}
      .sg-dreaming-usage-bar{height:5px;border-radius:999px;background:var(--sg-hair);overflow:hidden}
      .sg-dreaming-usage-fill{height:100%;border-radius:999px;background:var(--sg-accent);transition:width var(--sg-fast) var(--sg-ease)}
      .sg-dreaming-usage-fill.warn{background:var(--sg-warn)}
      .sg-dreaming-usage-fill.over{background:var(--sg-danger)}
      .sg-dreaming-pref-status{margin:0;font-size:11.5px;color:var(--sg-muted);overflow-wrap:anywhere}
      .sg-dreaming-pref-status.saved{color:var(--sg-good)}
      .sg-dreaming-pref-status.failed{color:var(--sg-danger)}
      .sg-dreaming-done{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-top:10px;padding:10px 12px;border-radius:8px;background:var(--sg-soft)}
      .sg-dreaming-done .sg-dreaming-nums{margin-top:0}
      .sg-settings-shell .sg-pg-head .sg-pg-tag{display:none}
      @media (max-width:680px){.sg-more{grid-template-columns:minmax(0,1fr);gap:16px}}
      /* The settings dialog can be ~900px wide, where two columns get cramped.
         Switch on the content container itself (not the viewport), so a narrow
         side panel and a wide standalone dialog both lay out honestly. */
      .sg-memory.sg-settings-page,.sg-settings-shell{container-name:sg-settings}
      .sg-settings-shell{container-type:inline-size;min-width:0}
      .sg-memory .sg-more{min-width:0}
      @container sg-settings (max-width:900px){
        .sg-memory .sg-more{grid-template-columns:minmax(0,1fr)}
        .sg-settings-columns{grid-template-columns:minmax(0,1fr)}
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
      .sg-memory .sg-toc-dream-letter{padding:0;border:0;background:none;color:var(--sg-accent);font:inherit;font-size:11.5px;font-weight:600;cursor:pointer}
      .sg-memory .sg-toc-dream-letter:hover{text-decoration:underline}
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
      .sg-memory .sg-topic-directory .sg-topic-pending-heading>.sg-dreaming-start,.sg-memory .sg-topic-directory .sg-topic-pending-heading>.sg-dreaming-idle-actions{flex:0 0 auto;margin-left:auto}
      .sg-memory .sg-dreaming-idle-actions{display:inline-flex;align-items:center;gap:8px;flex-wrap:wrap}
      .sg-memory .sg-dreaming.inline{flex:0 0 auto;margin:0;padding:0;border:0;background:none}
      .sg-memory .sg-dreaming.inline .sg-dreaming-row{gap:8px;flex-wrap:nowrap}
      .sg-memory .sg-dreaming.inline .sg-dreaming-animation{width:22px;height:22px;flex-basis:22px}
      .sg-memory .sg-dreaming.inline .sg-dreaming-moon{font-size:18px;line-height:22px}
      .sg-memory .sg-dreaming.inline .sg-dreaming-star,.sg-memory .sg-dreaming.inline .sg-dreaming-sleep{display:none}
      .sg-memory .sg-dreaming.inline .sg-dreaming-copy{min-width:0;gap:2px}
      .sg-memory .sg-dreaming.inline .sg-dreaming-copy strong{font-size:12px}
      .sg-memory .sg-dreaming.inline .sg-dreaming-copy>span{display:none}
      .sg-memory .sg-dreaming.inline .sg-dreaming-actions{gap:6px}
      .sg-memory .sg-dreaming.inline .sg-dreaming-nums{flex-basis:100%;margin-top:6px;gap:6px}
      .sg-memory .sg-dreaming.inline .sg-dreaming-num{padding:2px 7px;font-size:11.5px}
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

      /* 长期记忆：摊开的书籍目录（左页目录 + 右页正文与书签丝带） */
      .sg-memory .sg-topic-directory{max-width:none;padding:0 0 16px}
      .sg-memory .sg-how{margin:-4px 0 14px;gap:7px;font-size:12px;color:var(--sg-muted)}
      .sg-memory .sg-topic-directory .sg-book{position:relative;border:1px solid var(--sg-border);border-radius:4px;background:var(--sg-sheet);box-shadow:0 1px 0 var(--sg-border),0 3px 0 -1px var(--sg-sheet),0 3px 0 0 var(--sg-border),0 8px 24px color-mix(in srgb,var(--sg-text) 5%,transparent)}
      .sg-memory .sg-topic-directory .sg-book:before,.sg-memory .sg-topic-directory .sg-book>.sg-leaf:after{content:none;display:none}
      .sg-memory .sg-topic-directory .sg-book-ribbon{position:absolute;top:-1px;right:26px;z-index:3;display:block;width:17px;height:34px;color:color-mix(in srgb,var(--sg-moss) 28%,var(--sg-text));pointer-events:none;line-height:0}
      .sg-memory .sg-topic-directory .sg-leaf{--sg-reader-top:28px;--sg-reader-left:calc(50% + 28px);--sg-reader-width:calc(50% - 58px);--sg-reader-max-height:max(320px,calc(100vh - 136px));padding:28px 30px 22px 34px}
      .sg-memory .sg-topic-directory .sg-toc-title{display:block;margin:0 0 12px;padding-left:.6em;text-align:center;font:500 16px var(--sg-serif);letter-spacing:.6em;color:var(--sg-text)}
      .sg-memory .sg-topic-directory .sg-toc-col{display:flex;justify-content:flex-end;margin-bottom:4px;font-size:10.5px;color:var(--sg-muted)}
      .sg-memory .sg-topic-directory .sg-topic-chapters{display:grid;gap:12px;min-width:0}
      .sg-memory .sg-topic-directory .sg-topic-chapter{padding:0;border:0;border-radius:0;background:none}
      .sg-memory .sg-topic-directory .sg-topic-chapter-header{display:block}
      .sg-memory .sg-topic-directory .sg-topic-chapter-toggle{position:relative;display:grid;grid-template-columns:3.3em minmax(0,1fr) auto;align-items:baseline;gap:8px;width:100%;padding:2px 0;border:0;border-radius:4px;background:none;text-align:left;cursor:pointer;transition:color .14s ease}
      .sg-memory .sg-topic-directory .sg-topic-chapter-toggle:hover .sg-topic-chapter-title{color:var(--sg-moss-deep)}
      .sg-memory .sg-topic-directory .sg-topic-chapter-toggle>.sg-topic-chapter-label{min-width:0;font:400 12px var(--sg-serif);color:var(--sg-muted);white-space:nowrap}
      .sg-memory .sg-topic-directory .sg-topic-chapter-toggle>.sg-topic-chapter-title{display:block;flex:none;width:auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:700 14px/1.45 var(--sg-serif);color:var(--sg-text)}
      .sg-memory .sg-topic-directory .sg-topic-chapter-toggle>.sg-toc-lead,.sg-memory .sg-topic-directory .sg-topic-section-toggle>.sg-toc-lead{display:none}
      .sg-memory .sg-topic-directory .sg-topic-chapter-toggle>.sg-toc-cnt{min-width:1.8em;margin:0;padding:0;background:none;text-align:right;font:12px var(--sg-mono);color:var(--sg-muted);font-variant-numeric:tabular-nums}
      .sg-memory .sg-topic-directory .sg-topic-sections{display:grid;gap:1px;padding:4px 0 0}
      .sg-memory .sg-topic-directory .sg-topic-section-toggle{position:relative;display:flex;align-items:baseline;gap:7px;width:calc(100% - 3.3em);min-height:28px;margin:0 0 0 3.3em;padding:4px 4px 4px 6px;border-radius:4px;font-size:13px;color:var(--sg-muted);transition:background-color .14s ease,color .14s ease}
      .sg-memory .sg-topic-directory .sg-topic-section-toggle:before{content:none;flex:none}
      .sg-memory .sg-topic-directory .sg-topic-section-toggle:hover{background:color-mix(in srgb,var(--sg-text) 4.5%,transparent);color:var(--sg-text)}
      .sg-memory .sg-topic-directory .sg-topic-section-toggle>.sg-directory-number{flex:0 0 auto;min-width:2.4em;font:11.5px var(--sg-mono);color:var(--sg-muted)}
      .sg-memory .sg-topic-directory .sg-topic-section-toggle>.sg-toc-sec-title{display:block;flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .sg-memory .sg-topic-directory .sg-topic-section-toggle>.sg-toc-lead{display:block;flex:1 0 12px;min-width:12px;border-bottom:1px dotted color-mix(in srgb,var(--sg-muted) 42%,transparent);transform:translateY(-4px)}
      .sg-memory .sg-topic-directory .sg-topic-section-toggle>.sg-toc-cnt{flex:0 0 auto;min-width:1.8em;margin:0;text-align:right;font:12px var(--sg-mono);color:var(--sg-muted);font-variant-numeric:tabular-nums}
      .sg-memory .sg-topic-directory .sg-topic-section-toggle.cur{background:var(--sg-moss-soft);color:var(--sg-text);font-weight:600}
      .sg-memory .sg-topic-directory .sg-topic-section-toggle.cur:before{content:"";position:absolute;left:-9px;top:5px;bottom:5px;width:2.5px;border-radius:2px;background:var(--sg-text)}
      .sg-memory .sg-topic-directory .sg-topic-section-toggle.cur>.sg-directory-number,.sg-memory .sg-topic-directory .sg-topic-section-toggle.cur>.sg-toc-cnt{color:var(--sg-text);font-weight:600}
      .sg-memory .sg-topic-directory .sg-topic-other-events{margin:4px 0 0 3.3em;padding:2px 4px 2px 6px;border-top:0;font-size:12px;color:var(--sg-muted)}
      .sg-memory .sg-topic-directory .sg-topic-other-events>summary{display:flex;align-items:center;gap:6px;padding:3px 0;list-style:none;font-size:0;cursor:pointer}
      .sg-memory .sg-topic-directory .sg-topic-other-events>summary::-webkit-details-marker{display:none}
      .sg-memory .sg-topic-directory .sg-topic-other-events>summary:before{content:'其他事件';font-size:12px;color:var(--sg-muted)}
      .sg-memory .sg-topic-directory .sg-topic-other-events>summary:after{content:attr(data-count) ' 条 ▸';margin-left:auto;font:11.5px var(--sg-mono);color:var(--sg-muted)}
      .sg-memory .sg-topic-directory .sg-topic-other-events[open]>summary:after{content:attr(data-count) ' 条 ▾'}
      .sg-memory .sg-topic-directory .sg-topic-pending{margin-top:12px;padding:10px 0 0;border:0;border-top:1px dashed var(--sg-border);border-radius:0;background:none}
      .sg-memory .sg-topic-directory .sg-topic-pending-heading{margin:0;gap:10px}
      .sg-memory .sg-topic-directory .sg-topic-pending-toggle{display:flex;align-items:center;gap:8px;width:100%;padding:2px 0}
      .sg-memory .sg-topic-directory .sg-topic-pending-label{font:700 13.5px var(--sg-serif);color:var(--sg-text)}
      .sg-memory .sg-topic-directory .sg-topic-pending-toggle>span:nth-child(2){margin-left:auto;font:12px var(--sg-mono);color:var(--sg-muted);font-variant-numeric:tabular-nums}
      .sg-memory .sg-topic-directory .sg-topic-pending-toggle>span:nth-child(2):before{content:none}
      .sg-memory .sg-topic-directory .sg-toc-foot{margin-top:16px;padding-top:10px;border-top:1px solid var(--sg-border)}
      .sg-memory .sg-toc-foot-meta{color:var(--sg-muted);font-size:11.5px}
      .sg-memory .sg-topic-directory .sg-leaf-head{padding-right:26px}
      .sg-memory .sg-topic-directory .sg-leaf-k{color:var(--sg-muted);font:11.5px var(--sg-mono)}
      .sg-memory .sg-topic-directory .sg-leaf-head h3{margin:2px 0 8px;font:700 19px/1.35 var(--sg-serif);color:var(--sg-text)}
      .sg-memory .sg-topic-directory .sg-book-preview .sg-leaf-sum{margin:0 0 14px;max-height:min(360px,45vh);padding-right:6px;overflow:auto;color:var(--sg-subtle);font-size:13px;line-height:1.75}
      .sg-memory .sg-reader-cta-row{margin-top:4px;display:flex;justify-content:flex-start}
      .sg-memory .sg-reader-open-btn{display:inline-flex;align-items:center;gap:6px;padding:6px 13px;border:1px solid var(--sg-border);border-radius:6px;background:var(--sg-page);color:var(--sg-text);font-size:12.5px;font-weight:550;cursor:pointer;transition:border-color .14s ease,background-color .14s ease,color .14s ease}
      .sg-memory .sg-reader-open-btn:hover{border-color:var(--sg-moss);background:var(--sg-moss-soft);color:var(--sg-moss-deep)}
      .sg-memory .sg-topic-directory .sg-topic-overview{margin:0 0 10px}
      .sg-memory .sg-topic-directory .sg-topic-overview-toggle{display:inline-flex;align-items:center;gap:5px;width:auto;padding:1px 0;font-size:11px;color:var(--sg-muted)}
      .sg-memory .sg-topic-directory .sg-topic-overview-toggle>.sg-directory-number,.sg-memory .sg-topic-directory .sg-topic-overview-toggle>span:nth-child(2){font-size:0}
      .sg-memory .sg-topic-directory .sg-topic-overview-toggle>.sg-directory-number{min-width:0}
      .sg-memory .sg-topic-directory .sg-topic-overview-toggle>.sg-directory-number:before{content:'概要';font:11px var(--sg-sans);color:var(--sg-muted)}
      .sg-memory .sg-topic-directory .sg-topic-overview-text{margin:4px 0 8px;padding:0;font-size:13px;line-height:1.75;color:var(--sg-subtle)}
      .sg-memory .sg-topic-directory .sg-topic-event-list{border-top:1px solid var(--sg-border)}
      .sg-memory .sg-topic-directory .sg-topic-event{display:grid;grid-template-columns:minmax(3.2em,auto) minmax(0,1fr) auto auto;align-items:baseline;gap:10px;padding:8px 4px;border:0;border-bottom:1px solid var(--sg-hair);border-radius:0;transition:background-color .14s ease}
      .sg-memory .sg-topic-directory .sg-topic-event:hover{background:var(--sg-moss-soft)}
      .sg-memory .sg-topic-directory .sg-topic-event>.sg-directory-number{min-width:0;font:500 11.5px var(--sg-mono);color:var(--sg-muted)}
      .sg-memory .sg-topic-directory .sg-topic-event-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:500;color:var(--sg-text)}
      .sg-memory .sg-topic-directory .sg-topic-event:hover .sg-topic-event-title{color:var(--sg-moss-deep)}
      .sg-memory .sg-topic-directory .sg-topic-event-arrow{display:inline-block;opacity:0;color:var(--sg-moss-deep);font-size:12px;transition:opacity .12s ease}
      .sg-memory .sg-topic-directory .sg-topic-event:hover .sg-topic-event-arrow,.sg-memory .sg-topic-directory .sg-topic-event:focus-visible .sg-topic-event-arrow{opacity:1}
      .sg-memory .sg-topic-directory .sg-topic-show-all{width:100%;margin:0;padding:8px 4px;border-radius:0;text-align:left;font-size:12px!important;font-weight:600;color:var(--sg-moss-deep)!important}
      .sg-memory .sg-topic-directory .sg-topic-show-all:hover{background:var(--sg-moss-soft)}
      .sg-memory .sg-topic-directory .sg-topic-section-body .sg-leaf-sum{display:block;margin:0 0 10px;color:var(--sg-muted);font-size:12.5px}
      .sg-memory .sg-topic-directory .sg-leaf-folio{position:static;margin-top:auto;padding-top:18px;background:transparent;text-align:center;font:11px var(--sg-serif);color:var(--sg-muted)}
      @container sg-memory (min-width:761px){
        .sg-memory .sg-topic-directory .sg-book>.sg-leaf{display:grid;grid-template-columns:minmax(0,1.02fr) minmax(0,.98fr);column-gap:28px;row-gap:0;align-items:start;padding:28px 30px 22px 34px;min-height:460px}
        .sg-memory .sg-topic-directory .sg-toc-title,.sg-memory .sg-topic-directory .sg-toc-col,.sg-memory .sg-topic-directory .sg-topic-chapters,.sg-memory .sg-topic-directory .sg-topic-pending,.sg-memory .sg-topic-directory .sg-toc-foot{grid-column:1;min-width:0}
        .sg-memory .sg-topic-directory .sg-reader-track{grid-column:2;grid-row:1 / span 7;align-self:stretch;position:relative;z-index:1;min-width:0;padding-left:28px;border-left:1px solid var(--sg-border);pointer-events:none}
        .sg-memory .sg-topic-directory .sg-reader-sticky-anchor{position:sticky;top:14px;height:0;pointer-events:none}
        .sg-memory .sg-topic-directory .sg-book-preview{display:flex;flex-direction:column;position:sticky;top:14px;left:auto;right:auto;width:auto;min-height:min(440px,calc(100vh - 240px));max-height:calc(100vh - 70px);padding:0 6px 0 0;border:0;overflow:auto;pointer-events:auto;animation:sg-daily-fade .2s var(--sg-ease) both}
        .sg-memory .sg-topic-directory .sg-directory-fold.open>.sg-directory-fold-inner>.sg-topic-section-body{display:flex;flex-direction:column;z-index:2;min-height:min(440px,calc(100vh - 240px));max-height:var(--sg-reader-max-height,max(320px,calc(100vh - 136px)));padding-right:6px;pointer-events:auto}
      }
      @container sg-memory (max-width:760px){
        .sg-memory .sg-topic-directory .sg-book-ribbon,.sg-memory .sg-topic-directory .sg-reader-track{display:none}
        .sg-memory .sg-topic-directory .sg-book>.sg-leaf{display:block;padding:20px 16px 16px;min-height:0}
        .sg-memory .sg-topic-directory .sg-toc-title{margin-bottom:8px;font-size:15px}
        .sg-memory .sg-topic-directory .sg-topic-chapter-toggle{padding:4px 0}
        .sg-memory .sg-topic-directory .sg-topic-chapter-toggle>.sg-topic-chapter-title{white-space:normal;overflow:visible;text-overflow:clip;overflow-wrap:anywhere}
        .sg-memory .sg-topic-directory .sg-topic-sections{padding:4px 0 2px}
        .sg-memory .sg-topic-directory .sg-topic-section-toggle{display:grid;grid-template-columns:auto minmax(0,1fr) auto;width:100%;margin-left:0;padding:6px 4px 6px 16px}
        .sg-memory .sg-topic-directory .sg-topic-section-toggle>.sg-toc-lead{display:none}
        .sg-memory .sg-topic-directory .sg-topic-section-toggle>.sg-toc-sec-title{white-space:normal;overflow:visible;text-overflow:clip;overflow-wrap:anywhere}
        .sg-memory .sg-topic-directory .sg-topic-section-toggle>.sg-toc-cnt{margin:0}
        .sg-memory .sg-topic-directory .sg-topic-section-toggle.cur:before{left:6px}
        .sg-memory .sg-topic-directory .sg-topic-other-events{margin:4px 0 0 16px;padding:2px 4px}
        .sg-memory .sg-topic-directory .sg-directory-fold.open>.sg-directory-fold-inner>.sg-topic-section-body{position:static;top:auto;left:auto;z-index:auto;width:auto;min-height:0;max-height:none;margin:6px 0 10px 12px;padding:12px 12px 10px 14px;border:1px solid var(--sg-hair);border-left:2.5px solid var(--sg-moss);border-radius:0 6px 6px 0;background:var(--sg-page)}
        .sg-memory .sg-topic-directory .sg-leaf-head{padding-right:0}
        .sg-memory .sg-topic-directory .sg-topic-event-title{white-space:normal;overflow:visible;text-overflow:clip;overflow-wrap:anywhere}
      }
      .sg-pg-end .sg-long-tabs.sg-seg{border-radius:8px;padding:3px;background:var(--sg-sheet)}
      .sg-pg-end .sg-long-tabs.sg-seg>button[aria-current=page]{background:var(--sg-page);color:var(--sg-text);box-shadow:0 1px 3px color-mix(in srgb,#000 10%,transparent),0 0 0 1px var(--sg-hair)}
      .sg-memory .sg-long-toolbar .sg-search input{min-height:34px;border-radius:8px}
      .sg-memory .sg-toolbar-button{min-height:34px;border-radius:8px;font-size:12.5px;background:var(--sg-page)}
      .sg-memory .sg-long-layout{border-radius:10px;border-color:var(--sg-hair);background:var(--sg-page);box-shadow:none}
      .sg-memory .sg-timeline{padding:14px 18px 18px}
      .sg-memory .sg-ev{padding:7px 8px;border-radius:6px;transition:background-color .14s ease}
      .sg-memory .sg-ev:hover{background:var(--sg-moss-soft)}
      .sg-memory .sg-ev.selected{background:var(--sg-moss-soft);box-shadow:inset 2.5px 0 0 var(--sg-moss)}
      .sg-memory .sg-ev .sg-nd{left:-26.5px}
      .sg-memory .sg-ev .sg-tp{padding:1px 7px;border-radius:999px;background:var(--sg-soft);font-size:11px;color:var(--sg-muted)}
      .sg-memory .sg-dream{border-left-color:var(--sg-moss);background:var(--sg-moss-soft);border-radius:0 7px 7px 0;padding:7px 12px}
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
      .sg-memory .sg-ss-use{display:none}
    `

