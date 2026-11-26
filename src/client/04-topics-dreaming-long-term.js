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

    function chapterTitle(topic) {
      const title = typeof topic?.title === 'string' ? topic.title.trim() : ''
      return title || '未命名主题'
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

    function TopicSection({ part, chapter, chapterName = '', index, topicId, namespace, revision, active, openEvent, onDirectoryChanged, open = false, onToggle }) {
      const [overviewOpen, setOverviewOpen] = React.useState(true)
      const sectionNumber = chapter + '.' + index
      const regionId = 'sg-topic-' + encodeURIComponent(topicId) + '-' + encodeURIComponent(part.uiKey)
      const sourceCount = Number(part.sourceEventCount || 0)
      const paragraphs = (part.paragraphs || []).map(paragraph => paragraph.text || '').filter(Boolean)
      return h('section', { className: 'sg-topic-section', 'data-section-index': String(index) },
        h('h3', { className: 'sg-topic-section-heading' }, h('button', { type: 'button', className: 'sg-topic-section-toggle' + (open ? ' cur' : ''), title: part.uiTitle, 'data-count': String(sourceCount), 'aria-expanded': open, 'aria-controls': regionId, onClick: () => onToggle?.(part.uiKey) },
          h('span', { className: 'sg-directory-number' }, sectionNumber), h('span', { className: 'sg-toc-sec-title' }, part.uiTitle), h('span', { className: 'sg-toc-lead', 'aria-hidden': 'true' }), h('span', { className: 'sg-toc-cnt', title: sourceCount + ' 条事件'}, String(sourceCount)), h('span', { className: 'sg-directory-chevron', 'aria-hidden': 'true' }, '\u203a'))),
        h(DirectoryFold, { open, id: regionId }, h('div', { className: 'sg-topic-section-body' },
          h('div', { className: 'sg-leaf-head' },
            h('span', { className: 'sg-leaf-k', title: chapterName || undefined }, sectionNumber + ' · ' + sourceCount + ' 条事件'),
            h('h3', null, part.uiTitle),
            !paragraphs.length ? h('p', { className: 'sg-leaf-sum' }, '这一节暂时没有概要。') : null),
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
      const displayTitle = chapterTitle(topic)
      const chapterEvents = topicSections(topic).reduce((sum, part) => sum + Number(part.sourceEventCount || 0), 0)
      return h('article', { className: 'sg-topic-chapter', 'data-topic-id': topic.id },
        h('header', { className: 'sg-topic-chapter-header' },
          h('span', { className: 'sg-topic-chapter-number', 'aria-hidden': 'true' }, String(number).padStart(2, '0')),
          h('div', { className: 'sg-topic-chapter-copy' }, h('h2', null, h('button', { type: 'button', className: 'sg-topic-chapter-toggle', title: displayTitle, 'data-count': String(chapterEvents), 'aria-expanded': open, 'aria-controls': regionId, 'aria-label': chapterLabel + ' ' + displayTitle, onClick: () => setOpen((current) => !current) }, h('span', { className: 'sg-topic-chapter-label' }, chapterLabel), h('span', { className: 'sg-topic-chapter-title' }, displayTitle), h('span', { className: 'sg-toc-lead', 'aria-hidden': 'true' }), h('span', { className: 'sg-toc-cnt', title: chapterEvents + ' 条事件'}, String(chapterEvents)), h('span', { className: 'sg-directory-chevron', 'aria-hidden': 'true' }, '›'))), topic.description ? h('p', { className: 'sg-topic-description' }, topic.description) : null)),
        h(DirectoryFold, { open, id: regionId }, h('div', { className: 'sg-topic-sections' },
          topicSections(topic).map((part, index) => { const selectionKey = topic.id + ':' + part.uiKey; return h(TopicSection, { key: part.uiKey, part, chapter: number, chapterName: chapterLabel + ' · ' + displayTitle, index: index + 1, topicId: topic.id, namespace, revision, open: openSection === selectionKey, onToggle: () => onSectionToggle?.(selectionKey, part), active: active && open, openEvent, onDirectoryChanged }) }),
          !(topic.sections || []).length ? h('p', { className: 'sg-topic-no-overview' }, '这个主题还没有小节。') : null,
          // Keep the unassigned-event disclosure for pagination and aria; CSS
          // hides its old "待归类事件" wording in the book view.
          (() => {
            const remaining = Number(topic.coverage?.unassignedEvents ?? topic.coverage?.omittedEvents ?? 0)
            return remaining ? h('details', { className: 'sg-topic-other-events', open: otherOpen, onToggle: (event) => setOtherOpen(event.currentTarget.open) }, h('summary', { 'data-count': String(remaining) }, '待归类事件 · ' + remaining), h(TopicEventList, { namespace, revision, topicId: topic.id, sectionKey: 'uncovered', total: remaining, active: active && open && otherOpen, openEvent, onDirectoryChanged })) : null
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

    const DREAMING_STYLES = `.sg-dreaming{margin:0 0 20px;padding:14px 16px;border:1px solid var(--sg-border);border-radius:12px;background:var(--sg-surface)}.sg-dreaming-row{display:flex;align-items:center;gap:14px;flex-wrap:wrap}.sg-dreaming-animation{position:relative;width:48px;height:48px;flex:0 0 48px;color:var(--sg-accent)}.sg-dreaming-moon{display:block;font-size:43px;line-height:48px;animation:sg-dream-breathe 4s ease-in-out infinite}.sg-dreaming-star{position:absolute;right:0;top:1px;font-size:12px;animation:sg-dream-twinkle 3s ease-in-out infinite}.sg-dreaming-sleep{position:absolute;right:4px;bottom:1px;font-size:13px;animation:sg-dream-float 3s ease-in-out infinite}.sg-dreaming.resting .sg-dreaming-animation span{animation-play-state:paused}.sg-dreaming-copy{display:grid;gap:5px;flex:1;min-width:150px}.sg-dreaming-copy strong{font-size:14px;color:var(--sg-text)}.sg-dreaming-copy>span,.sg-dreaming p{font-size:12px;color:var(--sg-muted);line-height:1.6}.sg-dreaming-actions{display:flex;gap:8px;flex-wrap:wrap}.sg-dreaming button{padding:7px 12px;border:1px solid var(--sg-border);border-radius:7px;background:var(--sg-page);color:var(--sg-text);cursor:pointer}.sg-dreaming button:hover{border-color:var(--sg-accent)}.sg-dreaming button:disabled{opacity:.5;cursor:default}.sg-dreaming .sg-dreaming-stop{color:var(--sg-danger)}.sg-dreaming-state-pill{display:inline-flex;align-items:center;gap:5px;padding:2px 9px;border-radius:999px;font-size:11.5px;font-weight:600;width:fit-content}.sg-dreaming-state-pill.running{background:color-mix(in srgb,var(--sg-accent) 13%,transparent);color:var(--sg-accent)}.sg-dreaming-state-pill.paused{background:color-mix(in srgb,var(--sg-sand) 16%,transparent);color:var(--sg-sand)}.sg-dreaming-state-pill.done{background:color-mix(in srgb,var(--sg-good) 14%,transparent);color:var(--sg-good)}.sg-dreaming-state-dot{width:6px;height:6px;border-radius:50%;background:currentColor}.sg-dreaming-nums{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:10px;font:600 12px var(--sg-mono)}.sg-dreaming-num{display:inline-flex;align-items:center;gap:5px;padding:3px 9px;border-radius:7px;border:1px solid var(--sg-hair);background:var(--sg-page);color:var(--sg-text)}.sg-dreaming-num.edit .sg-dreaming-ico{color:var(--sg-water)}.sg-dreaming-num.del .sg-dreaming-ico{color:var(--sg-danger)}.sg-dreaming-num.exp .sg-dreaming-ico{color:var(--sg-sand)}.sg-dreaming-num small{font-family:var(--sg-sans);font-size:11.5px;font-weight:500;color:var(--sg-muted)}.sg-dlg .sg-dreaming-nums{margin:4px 0 10px}.sg-letter-overlay{position:fixed;inset:0;z-index:2147483040;display:grid;place-items:center;padding:24px 18px;overflow-y:auto;background:color-mix(in srgb,var(--sg-page) 58%,transparent);backdrop-filter:blur(11px);-webkit-backdrop-filter:blur(11px);animation:sg-r6-pop .2s both}.sg-letter-envelope{--letter-line:32px;--sg-hand:"KaiTi","STKaiti","DFKai-SB","BiauKai","Lucida Handwriting",cursive,serif;--sg-sign:"STXingkai","FZShuTi","KaiTi","Lucida Handwriting",cursive,serif;--sg-letter-paper:color-mix(in srgb,var(--sg-sand) 6%,var(--sg-page));--sg-letter-ink:color-mix(in srgb,var(--sg-text) 92%,var(--sg-sand));position:relative;width:min(580px,100%);padding:26px 28px 22px;border:1px solid color-mix(in srgb,var(--sg-sand) 28%,var(--sg-border));border-radius:14px;background:var(--sg-letter-paper);color:var(--sg-letter-ink);box-shadow:0 24px 60px rgba(0,0,0,.18),0 4px 14px rgba(0,0,0,.06)}.sg-wax-seal{position:absolute;top:18px;right:22px;width:44px;height:44px;border-radius:50%;display:grid;place-items:center;background:color-mix(in srgb,var(--sg-sand) 14%,var(--sg-page));border:1.5px dashed color-mix(in srgb,var(--sg-sand) 55%,transparent);color:var(--sg-sand);transform:rotate(-8deg)}.sg-letter-header{padding-right:58px;margin-bottom:10px}.sg-letter-heading{margin:0;font:400 22px/1.3 var(--sg-sign);color:var(--sg-letter-ink);letter-spacing:.03em}.sg-letter-meta{display:inline-flex;align-items:center;gap:6px;margin-top:6px;margin-right:6px;padding:2px 8px;border-radius:6px;background:color-mix(in srgb,var(--sg-sand) 15%,transparent);color:var(--sg-sand);font:600 11px var(--sg-sans)}.sg-letter-meta.profile{background:color-mix(in srgb,var(--sg-accent) 13%,transparent);color:var(--sg-accent)}.sg-letter-body{background-image:linear-gradient(to bottom,transparent 0,transparent calc(var(--letter-line) - 6px),color-mix(in srgb,var(--sg-sand) 18%,transparent) calc(var(--letter-line) - 6px),color-mix(in srgb,var(--sg-sand) 18%,transparent) calc(var(--letter-line) - 5px),transparent calc(var(--letter-line) - 5px),transparent var(--letter-line));background-size:100% var(--letter-line);background-repeat:repeat-y}.sg-hand-prose{margin:0;font-family:var(--sg-hand);font-size:16.5px;line-height:var(--letter-line);color:var(--sg-letter-ink);letter-spacing:.015em}.sg-hand-prose p{margin:0}.sg-hand-prose p+p{text-indent:2em}.sg-letter-sign-row{display:flex;align-items:baseline;justify-content:flex-end;height:var(--letter-line);line-height:var(--letter-line);margin-top:var(--letter-line);font-family:var(--sg-sign);font-size:20px;color:var(--sg-letter-ink)}.sg-letter-footer{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-top:16px;padding-top:12px;border-top:1px dashed var(--sg-border)}.sg-letter-chips{display:flex;align-items:center;gap:6px;flex-wrap:wrap}.sg-ps-chip{display:inline-flex;align-items:center;gap:4px;padding:3px 8px;border:1px solid var(--sg-border);border-radius:6px;background:var(--sg-page);color:var(--sg-text);font-size:11.5px;cursor:pointer}.sg-ps-chip:hover:not(:disabled){border-color:var(--sg-accent)}.sg-ps-chip:disabled{opacity:.7;cursor:default}.sg-ps-chip.del{color:var(--sg-muted);text-decoration:line-through;cursor:default}.sg-ps-tag{font-weight:700}.sg-ps-tag.edit{color:var(--sg-water)}.sg-ps-tag.del{color:var(--sg-danger)}.sg-ps-tag.exp{color:var(--sg-sand)}.sg-ps-tag.daily{color:var(--sg-good)}.sg-letter-acts{display:inline-flex;align-items:center;gap:6px;margin-left:auto}.sg-letter-acts .sg-btn{height:30px;padding:0 13px;border:1px solid var(--sg-border);border-radius:7px;background:var(--sg-page);color:var(--sg-text);font-size:12px;font-weight:550;cursor:pointer;white-space:nowrap}.sg-letter-acts .sg-btn.primary{border-color:var(--sg-text);background:var(--sg-text);color:var(--sg-page)}.sg-letter-acts .sg-btn.ghost{border-color:transparent;background:transparent;color:var(--sg-muted)}@media(max-width:600px){.sg-letter-envelope{--letter-line:28px;padding:20px 18px 18px}.sg-hand-prose{font-size:15px}.sg-letter-sign-row{font-size:18px}}@keyframes sg-dream-breathe{50%{opacity:.6;transform:translateY(-2px)}}@keyframes sg-dream-twinkle{50%{opacity:.25;transform:scale(.7)}}@keyframes sg-dream-float{50%{opacity:.4;transform:translate(2px,-5px)}}@media(prefers-reduced-motion:reduce){.sg-dreaming-animation span{animation:none!important}}`

    const DIRECTORY_PREVIEW_STYLES = `.sg-topic-directory-intro{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding-bottom:14px}.sg-context-trigger{display:inline-flex;align-items:center;gap:7px;padding:5px 0;border:0;background:transparent;color:var(--sg-muted);font-size:12px;cursor:pointer}.sg-context-trigger:hover,.sg-context-trigger[aria-expanded=true]{color:var(--sg-accent)}.sg-dreaming-start{padding:6px 12px;border:0;border-radius:7px;background:var(--sg-soft);color:var(--sg-accent);font-size:12px;cursor:pointer}.sg-dreaming-start:disabled{opacity:.5;cursor:default}.sg-dreaming{flex:1 0 100%;margin:0;border:0;background:var(--sg-soft);padding:12px 14px}.sg-dreaming-animation{width:36px;height:40px;flex-basis:36px}.sg-dreaming-moon{font-size:34px;line-height:40px}.sg-dreaming-copy strong{font-size:13px}.sg-dreaming-copy>span{font-size:12px;color:var(--sg-muted)}.sg-dreaming-session{margin:5px 0 0 50px;padding:2px 0!important;border:0!important;background:transparent!important;color:var(--sg-accent)!important;font-size:12px!important}.sg-context-overlay{position:fixed;inset:0;z-index:2147483020;background:transparent}.sg-context-window{position:fixed;display:flex;flex-direction:column;width:min(520px,calc(100vw - 24px));padding:16px;border:1px solid var(--sg-border);border-radius:11px;background:var(--sg-page);color:var(--sg-text);box-shadow:0 12px 42px rgba(0,0,0,.25);overflow:auto}.sg-context-window-head{display:flex;align-items:center;justify-content:space-between;gap:12px}.sg-context-window-head h3{font-size:14px;margin:0;font-weight:600}.sg-context-close{display:grid;place-items:center;width:29px;height:29px;padding:0;border:0;border-radius:5px;background:transparent;color:var(--sg-muted);cursor:pointer}.sg-context-subtitle{font-size:12px;color:var(--sg-muted);margin:3px 0 13px}.sg-context-injection{margin:0;padding:13px;background:var(--sg-soft);border-radius:7px;font:12px/1.8 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--sg-text)}@media(max-width:600px){.sg-context-overlay{background:rgba(0,0,0,.32)}.sg-context-window{left:12px!important;right:12px!important;top:auto!important;bottom:12px;width:auto;border-radius:13px;max-height:80vh!important}.sg-dreaming-actions{margin-left:50px}.sg-dreaming-copy{min-width:140px}}`

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

    const DREAMING_MARKS = {
      moon: 'M13.8 10.6A6 6 0 0 1 5.4 2.2a6.1 6.1 0 1 0 8.4 8.4Z',
      mail: 'M2 3.5h12v9H2z M2.5 4 8 8.5l5.5-4.5',
      undo: 'M5.5 3.5 2 7l3.5 3.5M2.5 7H9a3.5 3.5 0 1 1 0 7H6',
      pause: 'M6 3.5v9m4-9v9',
      resume: 'M5 3.5l7 4.5-7 4.5z',
      stop: 'M4.5 4.5h7v7h-7z',
      close: 'm4 4 8 8m0-8-8 8',
      more: 'm6 4 4 4-4 4',
    }

    const DREAMING_PHASES = [
      { key: 'orient', label: '1 定向', short: '定向' },
      { key: 'gather', label: '2 核实', short: '核实' },
      { key: 'consolidate', label: '3 整合', short: '整合' },
      { key: 'prune', label: '4 收口', short: '收口' },
    ]

    const DREAMING_ACTION_LABELS = {
      create: '新增',
      update: '修改',
      merge: '合并',
      supersede: '替代',
      delete: '删除',
    }

    function DreamingMark({ name }) {
      return h('svg', { viewBox: '0 0 16 16', 'aria-hidden': 'true' }, h('path', { d: DREAMING_MARKS[name] }))
    }

    function DreamingPhaseBar({ phase }) {
      const activeIndex = DREAMING_PHASES.findIndex(step => step.key === phase)
      if (activeIndex < 0) return null
      return h('div', { className: 'sg-dreaming-phases', role: 'list', 'aria-label': '整理阶段', 'data-testid': 'stratagate-dreaming-phases' },
        DREAMING_PHASES.map((step, index) => {
          const state = index < activeIndex ? 'done' : index === activeIndex ? 'active' : 'pending'
          return h('div', { key: step.key, role: 'listitem', className: 'sg-dreaming-phase ' + state, 'aria-current': state === 'active' ? 'step' : undefined },
            h('span', { className: 'sg-dreaming-phase-dot', 'aria-hidden': 'true' }),
            h('span', { className: 'sg-dreaming-phase-label' }, step.label))
        }))
    }

    function DreamingChangesModal({ namespace, runs, onReverted, onClose }) {
      const [busyKey, setBusyKey] = React.useState('')
      const [error, setError] = React.useState('')
      React.useEffect(() => {
        const onKeyDown = (event) => {
          if (event.key === 'Escape' && !busyKey) { event.preventDefault(); onClose() }
        }
        document.addEventListener('keydown', onKeyDown)
        return () => document.removeEventListener('keydown', onKeyDown)
      }, [busyKey, onClose])
      const revert = async (runId, changeId) => {
        const key = changeId ? runId + ':' + changeId : runId
        if (busyKey) return
        setBusyKey(key); setError('')
        try {
          const response = await api('dreaming', { namespace, action: 'revert' }, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(changeId ? { runId, changeId } : { runId }),
          })
          await onReverted?.(response?.dreaming)
        } catch (reason) {
          setError(reason?.message || '恢复失败，请稍后重试。')
        } finally { setBusyKey('') }
      }
      const formatTime = (iso) => typeof iso === 'string' && iso.length >= 16 ? iso.slice(0, 16).replace('T', ' ') : ''
      return h('div', { className: 'sg-import-overlay', role: 'presentation', onClick: event => { if (event.target === event.currentTarget && !busyKey) onClose() } },
        h('section', { className: 'sg-dreaming-changes-dlg', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'sg-dreaming-changes-title', 'data-testid': 'stratagate-dreaming-changes-modal' },
          h('div', { className: 'sg-dreaming-changes-head' },
            h('h3', { id: 'sg-dreaming-changes-title' }, 'Dreaming 事件改动与恢复'),
            h('button', { type: 'button', className: 'sg-btn ghost', disabled: Boolean(busyKey), onClick: onClose }, '关闭')),
          error ? h('p', { className: 'sg-dreaming-failure', role: 'alert' }, error) : null,
          h('div', { className: 'sg-dreaming-changes-body' },
            runs.length ? runs.map(group => {
              const runBusy = busyKey === group.runId
              return h('section', { key: group.runId, className: 'sg-dreaming-run-card', 'data-testid': 'dreaming-snapshot-run' },
                h('div', { className: 'sg-dreaming-run-head' },
                  h('span', { className: 'sg-dreaming-run-time' }, (formatTime(group.createdAt) || '近期整理') + ' · 共 ' + group.totalCount + ' 项事件改动'),
                  group.revertibleCount > 0
                    ? h('button', { type: 'button', className: 'sg-dreaming-revert-btn', 'data-testid': 'dreaming-revert-run', disabled: Boolean(busyKey), onClick: () => revert(group.runId) },
                      runBusy ? '正在撤销…' : '撤销整轮事件改动')
                    : h('span', { className: 'sg-dreaming-reverted-tag' }, '本轮已全部恢复')),
                h('ul', { className: 'sg-dreaming-run-list' },
                  group.items.map(item => {
                    const itemKey = group.runId + ':' + item.changeId
                    const actionName = DREAMING_ACTION_LABELS[item.action] || '改动'
                    return h('li', { key: item.changeId, className: 'sg-dreaming-change-row' },
                      h('span', { className: 'sg-dreaming-action-tag ' + (item.action || 'update') }, actionName),
                      h('div', { className: 'sg-dreaming-change-copy' },
                        h('strong', null, item.label),
                        item.detail ? h('span', null, item.detail) : null),
                      item.canRevert
                        ? h('button', { type: 'button', className: 'sg-dreaming-revert-btn', 'data-testid': 'dreaming-revert-item', disabled: Boolean(busyKey), onClick: () => revert(group.runId, item.changeId) },
                          busyKey === itemKey ? '恢复中…' : '恢复')
                        : h('span', { className: 'sg-dreaming-reverted-tag' }, '已恢复'))
                  })))
            }) : h('p', { className: 'sg-muted' }, '当前没有可恢复的事件快照。'))))
    }

    function DreamingLetterModal({ namespace, dates, date, onDate, onClose, onDirectoryChanged }) {
      const dialogRef = React.useRef(null)
      const [letter, setLetter] = React.useState(null)
      const [error, setError] = React.useState('')
      const [retry, setRetry] = React.useState(0)
      const [revertBusy, setRevertBusy] = React.useState('')
      const [revertError, setRevertError] = React.useState('')
      React.useEffect(() => {
        const dialog = dialogRef.current
        dialog?.showModal()
        return () => dialog?.close()
      }, [])
      React.useEffect(() => {
        const controller = new AbortController()
        setError(''); setRevertError('')
        api('letters/note', { namespace, date }, { signal: controller.signal }).then(value => {
          if (!controller.signal.aborted) setLetter(value)
        }).catch(() => {
          if (!controller.signal.aborted) setError('来信读取失败。')
        })
        if (dialogRef.current) dialogRef.current.scrollTop = 0
        return () => controller.abort()
      }, [namespace, date, retry])
      const revertItem = async (runId, changeId) => {
        const key = changeId ? runId + ':' + changeId : runId
        if (!runId || revertBusy) return
        setRevertBusy(key); setRevertError('')
        try {
          await api('dreaming', { namespace, action: 'revert' }, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(changeId ? { runId, changeId } : { runId }),
          })
          setRetry(value => value + 1)
          await onDirectoryChanged?.()
        } catch (reason) {
          setRevertError(reason?.message || '恢复失败，请稍后重试。')
        } finally { setRevertBusy('') }
      }
      const current = letter?.date === date ? letter : null
      const runs = (current?.reports || []).map(dreamingChangesOf)
      const items = runs.flatMap(run => run.items)
      const edited = runs.reduce((sum, run) => sum + run.editedEvents, 0)
      const deleted = runs.reduce((sum, run) => sum + run.deletedEvents, 0)
      const experiences = runs.reduce((sum, run) => sum + run.experiences, 0)
      const groups = [
        ['event-edit', '修改的事件', edited], ['event-delete', '删除的事件', deleted], ['experience', '整理出的经验', experiences],
      ]
      const counts = `修改 ${edited} 个事件 · 删除 ${deleted} 个事件 · 提取 ${experiences} 条经验`
      const revertibleRunIds = [...new Set(items.filter(item => item.canRevert && item.runId).map(item => item.runId))]
      return h('dialog', { ref: dialogRef, className: 'sg-daily-letter', 'aria-labelledby': 'sg-letter-heading',
        onCancel: event => { event.preventDefault(); onClose() },
        onClick: event => { if (event.target === event.currentTarget) onClose() } },
        h('article', null,
          h('header', null,
            h('time', { dateTime: date }, date.replaceAll('-', '.')),
            h('button', { type: 'button', className: 'sg-daily-letter-close', 'aria-label': '收起信件', onClick: onClose }, h(DreamingMark, { name: 'close' }))),
          h('h2', { id: 'sg-letter-heading' }, current?.title || '一封来信'),
          current ? h('div', { className: 'sg-daily-letter-lines' },
            ...current.paragraphs.map((text, index) => h('p', { key: index }, text)),
            h('p', { className: 'sg-daily-letter-signature' }, '—— ' + current.signature)) : error
              ? h('p', { role: 'alert' }, error, ' ', h('button', { type: 'button', onClick: () => setRetry(value => value + 1) }, '重试'))
              : h('p', { role: 'status' }, '正在读取来信…'),
          edited || deleted || experiences ? h('details', { key: date, className: 'sg-daily-letter-changes' },
            h('summary', null, counts, h(DreamingMark, { name: 'more' })),
            revertError ? h('p', { className: 'sg-daily-letter-revert-err', role: 'alert' }, revertError) : null,
            groups.filter(([, , count]) => count > 0).map(([kind, label, count]) => {
              const group = items.filter(item => item.kind === kind)
              const showRunRevert = kind !== 'experience' && revertibleRunIds.length === 1 && group.some(item => item.canRevert)
              return h('section', { key: kind },
                h('div', { className: 'sg-daily-letter-changes-head' },
                  h('h3', null, label),
                  showRunRevert ? h('button', { type: 'button', className: 'sg-letter-revert-btn', disabled: Boolean(revertBusy), onClick: () => revertItem(revertibleRunIds[0]) },
                    revertBusy === revertibleRunIds[0] ? '撤销中…' : '撤销本轮事件改动') : null),
                h('ul', null, group.map((item, index) => {
                  const hasAction = Boolean(item.changeId && item.runId && (item.canRevert || item.revertedAt))
                  const key = hasAction ? item.runId + ':' + item.changeId : ''
                  return h('li', { key: item.changeId || index, className: hasAction ? 'has-action' : undefined },
                    h('strong', null, item.label),
                    item.detail ? h('span', null, item.detail) : hasAction ? h('span', null, '') : null,
                    hasAction ? (item.canRevert
                      ? h('button', { type: 'button', className: 'sg-letter-revert-btn', disabled: Boolean(revertBusy), onClick: () => revertItem(item.runId, item.changeId) },
                        revertBusy === key ? '恢复中…' : '恢复')
                      : h('span', { className: 'sg-letter-reverted' }, '已恢复')) : null)
                })),
                group.length < count ? h('p', null, '部分改动没有留存明细。') : null)
            })) : null,
          dates.length > 1 ? h('footer', null,
            h('details', { className: 'sg-daily-letter-history' },
              h('summary', null, '往期来信', h(DreamingMark, { name: 'more' })),
              h('div', { className: 'sg-daily-letter-dates' }, dates.map(entry =>
                h('button', { key: entry, type: 'button', 'aria-pressed': date === entry, onClick: () => onDate(entry) },
                  h('time', { dateTime: entry }, entry.replaceAll('-', '.'))))))) : null))
    }

    function DreamingPanel({ namespace, initialRun, active, available, settings = false, onDirectoryChanged, onOpenDreamingSession }) {
      const [run, setRun] = React.useState(initialRun || null)
      const [statusReady, setStatusReady] = React.useState(Boolean(initialRun))
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
      const previousRunId = React.useRef(initialRun?.id)
      const [toast, setToast] = React.useState('')
      const [letterDates, setLetterDates] = React.useState([])
      const [letterDate, setLetterDate] = React.useState('')
      const [recentRuns, setRecentRuns] = React.useState([])
      const [changesOpen, setChangesOpen] = React.useState(false)
      const [prefs, setPrefs] = React.useState({ autoEnabled: true, dailyTokenBudget: 5_000_000, dailyLettersEnabled: true })
      const [usage, setUsage] = React.useState({ reportedTokens: 0, estimatedTokens: 0, effectiveTokens: 0, calls: 0, budget: 5_000_000, budgetExceeded: false })
      const [budgetDraft, setBudgetDraft] = React.useState('500')
      const [budgetDirty, setBudgetDirty] = React.useState(false)
      const [prefBusy, setPrefBusy] = React.useState('')
      const [prefStatus, setPrefStatus] = React.useState({ kind: '', text: '' })
      React.useEffect(() => {
        if (initialRun && (!run || initialRun.updatedAt > run.updatedAt)) {
          if (initialRun.status === 'completed' && previousStatus.current && previousStatus.current !== 'completed') {
            setToast(initialRun.scope === 'memory' ? '本轮记忆整理完成' : '目录已整理好')
            previousStatus.current = 'completed'
          }
          setRun(initialRun)
          previousRunId.current = initialRun.id
        }
      }, [initialRun])
      React.useEffect(() => {
        if (!toast) return undefined
        const timer = window.setTimeout(() => setToast(''), 3600)
        return () => window.clearTimeout(timer)
      }, [toast])
      const accept = React.useCallback((value, announce = true) => {
        const next = value?.run || null
        const changed = previousRunId.current !== next?.id || previousStatus.current !== next?.status
        if (next && changed && (settings || ['completed', 'paused', 'terminated'].includes(next.status))) void onDirectoryChanged?.()
        if (announce && next?.status === 'completed' && changed) setToast(next.scope === 'memory' ? '本轮记忆整理完成' : '目录已整理好')
        previousRunId.current = next?.id
        previousStatus.current = next?.status
        setLetterDates(Array.isArray(value?.letterDates) ? value.letterDates : [])
        if (Array.isArray(value?.recentRuns)) setRecentRuns(value.recentRuns)
        if (value?.settings && typeof value.settings === 'object') {
          const nextPrefs = {
            autoEnabled: value.settings.autoEnabled !== false,
            dailyTokenBudget: Number.isFinite(Number(value.settings.dailyTokenBudget)) ? Number(value.settings.dailyTokenBudget) : 5_000_000,
            dailyLettersEnabled: value.settings.dailyLettersEnabled !== false,
          }
          setPrefs(nextPrefs)
          if (!budgetDirty) setBudgetDraft(String(Math.round(nextPrefs.dailyTokenBudget / 10_000)))
        }
        if (value?.usage && typeof value.usage === 'object') {
          setUsage({
            reportedTokens: Number(value.usage.reportedTokens || 0),
            estimatedTokens: Number(value.usage.estimatedTokens || 0),
            effectiveTokens: Number(value.usage.effectiveTokens || 0),
            calls: Number(value.usage.calls || 0),
            budget: Number(value.usage.budget ?? 5_000_000),
            budgetExceeded: Boolean(value.usage.budgetExceeded),
          })
        }
        setRun(next); setStatusReady(true); setError('')
      }, [settings, onDirectoryChanged, budgetDirty])
      React.useEffect(() => {
        if (!active || !namespace || busy) return
        const pollingDelay = ['running', 'pausing'].includes(run?.status) ? 2000 : 45_000
        const controller = new AbortController()
        let timer
        const poll = () => api('dreaming', { namespace }, { signal: controller.signal }).then(value => {
          if (!controller.signal.aborted && !request.current) accept(value, statusReady)
        }).catch(() => {
          if (!controller.signal.aborted) setError('状态读取失败，可重新读取。')
        }).finally(() => { if (!controller.signal.aborted) timer = window.setTimeout(poll, pollingDelay) })
        timer = window.setTimeout(poll, statusReady ? pollingDelay : 0)
        return () => { controller.abort(); window.clearTimeout(timer) }
      }, [active, namespace, busy, statusReady, run?.id, run?.status, accept])
      React.useEffect(() => () => request.current?.abort(), [])
      const control = async action => {
        if (request.current) return
        const controller = new AbortController()
        request.current = controller; setBusy(action); setError('')
        try {
          const signal = controller.signal
          if (action === 'refresh') {
            accept(await api('dreaming', { namespace }, { signal }), statusReady)
          } else {
            const params = { namespace, action }
            if (action !== 'start') params.id = run.id
            accept(await api('dreaming', params, { method: 'POST', signal }))
          }
        } catch (reason) {
          if (!controller.signal.aborted) setError(action === 'refresh' ? '状态读取失败，请稍后重试。' : reason?.message || '操作失败，请重试。')
        }
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
      const changes = dreamingChangesOf(run)
      const safeRecentRuns = Array.isArray(recentRuns) ? recentRuns : []
      const revertibleCount = safeRecentRuns.reduce((sum, group) => sum + Number(group.revertibleCount || 0), 0)
      const hasSnapshots = safeRecentRuns.length > 0
      const phaseShort = DREAMING_PHASES.find(step => step.key === run?.phase)?.short || ''
      const handleReverted = async (dreamingPayload) => {
        if (dreamingPayload) accept(dreamingPayload, false)
        setToast('已恢复选中的事件改动')
        await onDirectoryChanged?.()
      }
      const changesModal = changesOpen ? h(DreamingChangesModal, {
        namespace,
        runs: safeRecentRuns,
        onReverted: handleReverted,
        onClose: () => setChangesOpen(false),
      }) : null
      const formatWan = (tokens) => {
        const num = Number(tokens || 0)
        if (num >= 10_000) {
          const wan = num / 10_000
          return (Number.isInteger(wan) ? String(wan) : wan.toFixed(1)) + ' 万'
        }
        return num.toLocaleString('zh-CN')
      }
      const savePrefs = async (key, patch, successText) => {
        if (prefBusy) return
        setPrefBusy(key); setPrefStatus({ kind: '', text: '' })
        try {
          const updated = await api('dreaming', { namespace, action: 'settings' }, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(patch),
          })
          setBudgetDirty(false)
          accept(updated, false)
          setPrefStatus({ kind: 'saved', text: successText })
        } catch (reason) {
          setPrefStatus({ kind: 'failed', text: '保存失败：' + String(reason?.message || reason) })
        } finally { setPrefBusy('') }
      }
      const saveBudget = () => {
        const wan = Number(budgetDraft)
        if (!Number.isFinite(wan) || wan < 0 || wan > 20_000) {
          setPrefStatus({ kind: 'failed', text: '请输入 0 到 20000 之间的数字（单位：万 Token，0 表示不限）。' })
          return
        }
        const tokens = Math.round(wan * 10_000)
        void savePrefs('budget', { dailyTokenBudget: tokens }, tokens === 0 ? '已关闭每日 Token 上限' : '每日上限已保存为 ' + Math.round(tokens / 10_000) + ' 万 Token')
      }
      const renderPrefsSection = () => {
        const budget = Number(prefs.dailyTokenBudget || 0)
        const ratio = budget > 0 ? Math.min(100, Math.round((usage.effectiveTokens / budget) * 100)) : 0
        const barTone = usage.budgetExceeded ? 'over' : ratio >= 80 ? 'warn' : ''
        const savedBudgetWan = String(Math.round(budget / 10_000))
        return h('div', { className: 'sg-dreaming-prefs', 'data-testid': 'stratagate-dreaming-settings' },
          h('div', { className: 'sg-dreaming-pref-row' },
            h('div', { className: 'sg-dreaming-pref-copy' },
              h('span', { className: 'sg-dreaming-pref-label' }, '允许空闲时自动整理（Dreaming）'),
              h('span', { className: 'sg-dreaming-pref-desc' }, '关闭后永久不再自动启动或重启后自动恢复；仍可随时手动点「立即整理」。')),
            h('button', {
              type: 'button',
              className: 'sg-setting-switch',
              role: 'switch',
              'aria-label': '允许空闲时自动整理（Dreaming）',
              'aria-checked': prefs.autoEnabled,
              disabled: !statusReady || Boolean(prefBusy),
              onClick: () => void savePrefs('auto', { autoEnabled: !prefs.autoEnabled }, !prefs.autoEnabled ? '已开启空闲时自动整理' : '已永久关闭自动整理'),
            })),
          h('div', { className: 'sg-dreaming-pref-row' },
            h('div', { className: 'sg-dreaming-pref-copy' },
              h('span', { className: 'sg-dreaming-pref-label' }, '每日自动来信'),
              h('span', { className: 'sg-dreaming-pref-desc' }, '关闭后不再在次日自动生成手写来信，已有来信与记录保留。')),
            h('button', {
              type: 'button',
              className: 'sg-setting-switch',
              role: 'switch',
              'aria-label': '每日自动来信',
              'aria-checked': prefs.dailyLettersEnabled,
              disabled: !statusReady || Boolean(prefBusy),
              onClick: () => void savePrefs('letters', { dailyLettersEnabled: !prefs.dailyLettersEnabled }, !prefs.dailyLettersEnabled ? '已开启每日自动来信' : '已关闭每日自动来信'),
            })),
          h('div', { className: 'sg-dreaming-pref-row' },
            h('div', { className: 'sg-dreaming-pref-copy' },
              h('span', { className: 'sg-dreaming-pref-label' }, '每日 Token 上限'),
              h('span', { className: 'sg-dreaming-pref-desc' }, '默认 500 万/天（够每天 1～2 轮增量整理，0 表示不限）；达到上限自动暂停并保留断点。')),
            h('div', { className: 'sg-dreaming-budget-ctrl' },
              h('input', {
                type: 'number',
                className: 'sg-dreaming-budget-input',
                'aria-label': '每日 Token 上限（万）',
                min: 0,
                max: 20000,
                step: 50,
                value: budgetDraft,
                disabled: !statusReady || Boolean(prefBusy),
                onChange: (event) => { setBudgetDraft(event.target.value); setBudgetDirty(true) },
                onKeyDown: (event) => { if (event.key === 'Enter') saveBudget() },
              }),
              h('span', { className: 'sg-dreaming-budget-unit' }, '万'),
              h('button', {
                type: 'button',
                className: 'sg-dreaming-budget-save',
                disabled: !statusReady || Boolean(prefBusy) || (!budgetDirty && budgetDraft === savedBudgetWan),
                onClick: saveBudget,
              }, prefBusy === 'budget' ? '保存中…' : '保存'))),
          h('div', { className: 'sg-dreaming-usage', 'data-testid': 'stratagate-dreaming-usage' },
            h('div', { className: 'sg-dreaming-usage-head' },
              h('span', { className: 'sg-dreaming-pref-label' }, '今日 Dreaming 消耗'),
              h('span', { className: 'sg-dreaming-usage-nums' },
                '已用 ' + formatWan(usage.effectiveTokens) + ' / ' + (budget > 0 ? formatWan(budget) : '不限') + '（' + usage.calls + ' 次调用）')),
            budget > 0 ? h('div', { className: 'sg-dreaming-usage-bar', 'aria-hidden': 'true' },
              h('div', { className: 'sg-dreaming-usage-fill' + (barTone ? ' ' + barTone : ''), style: { width: ratio + '%' } })) : null,
            usage.budgetExceeded
              ? h('span', { className: 'sg-dreaming-pref-desc' }, '今日已达上限，自动整理已暂停；次日自动恢复或可调高上限。')
              : usage.estimatedTokens > 0
                ? h('span', { className: 'sg-dreaming-pref-desc' }, '其中含未返回账单的估算用量约 ' + formatWan(usage.estimatedTokens) + '。')
                : null),
          prefStatus.text ? h('p', { className: 'sg-dreaming-pref-status ' + prefStatus.kind, role: prefStatus.kind === 'failed' ? 'alert' : 'status', 'aria-live': 'polite' }, prefStatus.text) : null)
      }
      const renderChangesNums = (compact = false) => h('div', { className: 'sg-dreaming-nums', 'aria-label': '本次整理改动' },
        h('span', { className: 'sg-dreaming-num edit', title: '修改 Event' }, h('span', { className: 'sg-dreaming-ico', 'aria-hidden': 'true' }, '✎'), h('b', null, changes.editedEvents), compact ? null : h('small', null, '修改 Event')),
        h('span', { className: 'sg-dreaming-num del', title: '删除 Event' }, h('span', { className: 'sg-dreaming-ico', 'aria-hidden': 'true' }, '✕'), h('b', null, changes.deletedEvents), compact ? null : h('small', null, '删除 Event')),
        h('span', { className: 'sg-dreaming-num exp', title: '提取经验' }, h('span', { className: 'sg-dreaming-ico', 'aria-hidden': 'true' }, '✦'), h('b', null, changes.experiences), compact ? null : h('small', null, '提取经验')))
      const renderSettings = (content, action = null) => h('section', { className: 'sg-settings-panel sg-dreaming-setting', 'aria-label': 'Dreaming 记忆整理' },
        h('div', { className: 'sg-dreaming-setting-head' },
          h('span', { className: 'sg-dreaming-setting-icon', 'aria-hidden': 'true' }, '☾'),
          h('h3', { className: 'sg-dreaming-setting-title' }, 'Dreaming 记忆整理'), action),
        content,
        renderPrefsSection())
      const feedback = error ? h('p', { className: 'sg-dreaming-failure', role: 'alert' }, error,
        h('button', { type: 'button', className: 'sg-dreaming-retry', disabled: !!busy, onClick: () => control('refresh') }, settings ? '刷新状态' : '重试')) : null
      const toastMessage = toast ? h('p', { className: 'sg-dreaming-toast', role: 'status', 'aria-live': 'polite' }, toast) : null
      const styles = h('style', null, DREAMING_STYLES)
      const showStopDialog = (event) => { stopTrigger.current = event.currentTarget; setConfirmStop(true) }
      const stopConfirmation = confirmStop ? h('div', { className: 'sg-import-overlay', role: 'presentation' }, h('section', { ref: stopDialog, className: 'sg-dlg', role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': 'sg-stop-title', 'aria-describedby': 'sg-stop-copy' },
        h('h3', { id: 'sg-stop-title' }, '终止这次整理？'),
        renderChangesNums(true),
        h('p', { id: 'sg-stop-copy' }, '已修改的事件与经验会保留；未整理部分下次继续。'),
        h('div', { className: 'sg-dlg-acts' }, h('button', { type: 'button', className: 'sg-btn ghost', disabled: busy, onClick: () => setConfirmStop(false) }, '继续整理'), h('button', { type: 'button', className: 'sg-btn danger', disabled: busy, onClick: async () => { await control('terminate'); setConfirmStop(false) } }, '终止')))) : null
      if (!settings) {
        const quiet = (name, label, onClick, options = {}) => h('button', { type: 'button', className: 'sg-dreaming-quiet' + (options.iconOnly ? ' sg-dreaming-icon' : options.read ? ' sg-dreaming-read' : ''),
          disabled: Boolean(busy && !options.read) || options.disabled, onClick, 'aria-label': label, title: options.iconOnly ? label : undefined },
        h(DreamingMark, { name }), options.iconOnly ? null : label)
        const state = running ? (phaseShort ? '正在整理 · ' + phaseShort : '正在整理') : pausing ? '正在暂停' : '已暂停'
        const letterButton = letterDates.length ? quiet('mail', '读来信', () => setLetterDate(letterDates[0]), { read: true }) : null
        const changesButton = hasSnapshots ? quiet('undo', revertibleCount > 0 ? '改动与恢复 (' + revertibleCount + ')' : '改动与恢复', () => setChangesOpen(true), { read: true }) : null
        const inlineSecondary = !outstanding ? (letterButton || changesButton) : null
        const stackedLinks = outstanding
          ? [letterButton, changesButton].filter(Boolean)
          : (letterButton && changesButton ? [changesButton] : [])
        return h(React.Fragment, null, stopConfirmation ? styles : null,
          h('div', { className: 'sg-ov-dreaming', 'data-testid': 'overview-dreaming' },
            h('div', { className: 'sg-ov-dreaming-row' },
              h('div', { className: 'sg-ov-dreaming-controls' + (outstanding ? ' is-active' : '') },
                outstanding ? h(React.Fragment, null,
                  quiet('moon', state, openSession, { disabled: !run.sessionId || !onOpenDreamingSession }),
                  h('span', { className: 'sg-ov-dreaming-btns' },
                    running ? quiet('pause', '暂停整理', () => control('pause'), { iconOnly: true }) : null,
                    paused && !run.replanRequired ? quiet('resume', '继续整理', () => control('resume'), { iconOnly: true }) : null,
                    quiet('stop', '终止整理', showStopDialog, { iconOnly: true })))
                  : quiet('moon', busy === 'start' ? '正在启动…' : '整理记忆', () => control('start'), { disabled: !available || !statusReady })),
              inlineSecondary),
            stackedLinks.length ? h('div', { className: 'sg-ov-dreaming-links' }, ...stackedLinks) : null,
            run?.replanRequired ? h('p', { className: 'sg-dreaming-failure' }, '请终止这次整理后重新开始。') : null, toastMessage, feedback),
          letterDate ? h(DreamingLetterModal, { namespace, dates: letterDates, date: letterDate, onDate: setLetterDate, onClose: () => setLetterDate(''), onDirectoryChanged }) : null,
          changesModal,
          stopConfirmation)
      }
      if (!outstanding) return renderSettings(h(React.Fragment, null, styles,
        ['completed', 'terminated'].includes(run?.status) ? h('div', { className: 'sg-dreaming-done' },
          h('span', { className: 'sg-dreaming-state-pill ' + (run.status === 'completed' ? 'done' : 'paused') }, h('i', { className: 'sg-dreaming-state-dot', 'aria-hidden': 'true' }), run.status === 'completed' ? '已完成' : '已终止'),
          renderChangesNums(false)) : null,
        run?.sessionId || hasSnapshots ? h('div', { className: 'sg-dreaming-done-actions' },
          run?.sessionId ? h('button', { type: 'button', className: 'sg-dreaming-open-letter', disabled: Boolean(busy), onClick: openSession }, '查看上次整理') : null,
          hasSnapshots ? h('button', { type: 'button', className: 'sg-dreaming-open-letter', 'data-testid': 'stratagate-dreaming-changes-btn', disabled: Boolean(busy), onClick: () => setChangesOpen(true) },
            revertibleCount > 0 ? '改动与恢复 (' + revertibleCount + ')' : '查看改动快照') : null) : null,
        changesModal,
        toastMessage, feedback),
        h('div', { className: 'sg-dreaming-setting-actions' },
          h('button', { type: 'button', className: 'sg-save-button sg-dreaming-setting-start', disabled: !!busy || !available || !statusReady, onClick: () => control('start') },
            busy === 'start' ? '正在启动…' : '立即整理', h('span', { 'aria-hidden': 'true' }, '→'))))
      const progressCard = h('aside', { className: 'sg-dreaming ' + (running ? 'running' : 'resting'), 'aria-label': 'Dreaming 记忆整理', 'data-testid': 'stratagate-dreaming' },
        styles,
        toastMessage,
        h('div', { className: 'sg-dreaming-row' },
          h('div', { className: 'sg-dreaming-copy', role: 'status', 'aria-live': 'polite' },
            h('span', { className: 'sg-dreaming-state-pill ' + (running ? 'running' : 'paused') },
              h('i', { className: 'sg-dreaming-state-dot', 'aria-hidden': 'true' }),
              running ? run.waitingForProjection ? 'Dreaming 正在准备…' : '☾ 正在整理' : pausing ? '⏸ 正在暂停…' : '⏸ 已暂停'),
            run.activity ? h('span', null, run.activity) : null),
          h('div', { className: 'sg-dreaming-actions' },
            running || pausing ? h('button', { type: 'button', disabled: busy || pausing, onClick: () => control('pause') }, pausing ? '正在暂停…' : '暂停') : null,
            paused && !run.replanRequired ? h('button', { type: 'button', disabled: busy, onClick: () => control('resume') }, '继续') : null,
            h('button', { type: 'button', className: 'sg-dreaming-stop', disabled: busy, onClick: showStopDialog }, '终止'))),
        run.scope === 'memory' && run.phase ? h(DreamingPhaseBar, { phase: run.phase }) : null,
        renderChangesNums(false),
        h('div', { className: 'sg-dreaming-done-actions' },
          h('button', { type: 'button', className: 'sg-dreaming-session', disabled: busy || !run.sessionId, onClick: openSession }, run.sessionId ? '打开 Dreaming 会话 ↗' : running || pausing ? '会话准备中…' : '本轮未创建会话'),
          hasSnapshots ? h('button', { type: 'button', className: 'sg-dreaming-open-letter', 'data-testid': 'stratagate-dreaming-changes-btn', disabled: Boolean(busy), onClick: () => setChangesOpen(true) },
            revertibleCount > 0 ? '改动与恢复 (' + revertibleCount + ')' : '查看改动快照') : null),
        run?.reason ? h('p', null, run.reason) : null,
        feedback, changesModal, stopConfirmation)
      return renderSettings(progressCard)
    }

    function TopicDirectory({ directory, namespace, active = true, openEvent, onDirectoryChanged }) {
      const [pendingOpen, setPendingOpen] = React.useState(false)
      const [invalidatedRevision, setInvalidatedRevision] = React.useState(null)
      const [expandRequest, setExpandRequest] = React.useState(0)
      const [selectedSection, setSelectedSection] = React.useState('')
      const chaptersRef = React.useRef(null)
      const leafRef = React.useRef(null)
      const readerTrackRef = React.useRef(null)
      const stickyAnchorRef = React.useRef(null)
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
      React.useEffect(() => {
        if (typeof window === 'undefined' || typeof ResizeObserver !== 'function') return undefined
        const leaf = leafRef.current
        const track = readerTrackRef.current
        const anchor = stickyAnchorRef.current
        if (!leaf || !track || !anchor) return undefined
        let frame = 0
        const sync = () => {
          frame = 0
          const wide = track.offsetWidth > 0 && getComputedStyle(track).display !== 'none'
          if (!wide) {
            leaf.style.removeProperty('--sg-reader-top')
            leaf.style.removeProperty('--sg-reader-left')
            leaf.style.removeProperty('--sg-reader-width')
            leaf.style.removeProperty('--sg-reader-max-height')
            track.style.removeProperty('min-height')
            return
          }
          const left = track.offsetLeft
          const width = track.offsetWidth
          const trackStyle = getComputedStyle(track)
          const padLeft = parseFloat(trackStyle.paddingLeft) || 0
          const padRight = parseFloat(trackStyle.paddingRight) || 0
          const openBody = leaf.querySelector('.sg-directory-fold.open > .sg-directory-fold-inner > .sg-topic-section-body')
          const bodyHeight = openBody ? openBody.offsetHeight : 0
          const anchorTop = anchor.offsetTop
          const foot = leaf.querySelector('.sg-toc-foot')
          const footBottom = foot ? (foot.offsetTop + foot.offsetHeight) : ((chaptersRef.current?.offsetTop || 0) + (chaptersRef.current?.offsetHeight || 0))
          const leftTrackSpan = Math.max(0, footBottom - track.offsetTop)
          const maxOffset = Math.max(0, leftTrackSpan - bodyHeight)
          const offset = openBody ? Math.max(0, Math.min(anchorTop, maxOffset)) : 0
          const readerTopInViewport = Math.max(14, Math.round(track.getBoundingClientRect().top + offset))
          const readerMaxHeight = Math.max(320, Math.floor(window.innerHeight - readerTopInViewport - 24))
          leaf.style.setProperty('--sg-reader-left', (left + padLeft) + 'px')
          leaf.style.setProperty('--sg-reader-width', Math.max(0, width - padLeft - padRight) + 'px')
          leaf.style.setProperty('--sg-reader-top', (track.offsetTop + offset) + 'px')
          leaf.style.setProperty('--sg-reader-max-height', readerMaxHeight + 'px')
          if (openBody && bodyHeight > 0) track.style.minHeight = (offset + bodyHeight) + 'px'
          else track.style.removeProperty('min-height')
        }
        const schedule = () => { if (!frame) frame = window.requestAnimationFrame(sync) }
        const onScroll = (event) => {
          const target = event?.target
          if (target instanceof Element && target.closest('.sg-topic-section-body, .sg-book-preview')) return
          schedule()
        }
        sync()
        const ro = new ResizeObserver(schedule)
        ro.observe(leaf)
        ro.observe(track)
        const openBody = leaf.querySelector('.sg-directory-fold.open > .sg-directory-fold-inner > .sg-topic-section-body')
        if (openBody) ro.observe(openBody)
        window.addEventListener('scroll', onScroll, { capture: true, passive: true })
        window.addEventListener('resize', schedule, { passive: true })
        return () => {
          if (frame) window.cancelAnimationFrame(frame)
          ro.disconnect()
          window.removeEventListener('scroll', onScroll, { capture: true })
          window.removeEventListener('resize', schedule)
        }
      }, [selectedSection, topics.length, pendingOpen, blocked])
      return h('section', { className: 'sg-topic-directory', 'data-testid': 'stratagate-topic-directory', 'aria-label': '主题目录' },
        blocked ? h('p', { className: 'sg-topic-read-error', role: 'status' }, '目录已有更新，正在重新读取。', h('button', { type: 'button', onClick: onDirectoryChanged }, '重新读取目录')) : null,
        h('div', { hidden: blocked }, h(TopicBootstrapNotice, { directory }),
          !directory ? h('p', { className: 'sg-topic-empty', role: 'status' }, '暂时无法读取主题目录，请稍后重新打开。') : !topics.length && !pendingTotal ? h('div', { className: 'sg-topic-empty' }, h('h3', null, '还没有长期记忆'), h('p', null, '产生长期事件后，主题会在这里逐步整理成目录。')) : null,
          topics.length || pendingTotal ? h('div', { className: 'sg-how' }, h('i', { className: 'sg-sw moss', 'aria-hidden': 'true' }), '目录一直带着', h('span', { 'aria-hidden': 'true' }, '→'), h('i', { className: 'sg-sw lib', 'aria-hidden': 'true' }), '需要时翻到具体事件') : null,
          h('div', { className: 'sg-book' },
            topics.length || pendingTotal ? h('span', { className: 'sg-book-ribbon', 'aria-hidden': 'true' },
              h('svg', { viewBox: '0 0 18 36', width: 17, height: 34, focusable: 'false' },
                h('path', { d: 'M0 0h18v35l-9-7-9 7z', fill: 'currentColor' }))) : null,
            h('div', { className: 'sg-leaf', ref: leafRef },
            h('h3', { className: 'sg-toc-title' }, '目录'),
            h('div', { className: 'sg-toc-col' }, '事件'),
            h('div', { ref: chaptersRef, className: 'sg-topic-chapters' }, topics.map((topic, index) => h(TopicChapter, { key: topic.id, topic, number: index + 1, namespace, revision: pageRevision, active: active && !blocked, openEvent, onDirectoryChanged: invalidate, expandRequest, openSection, onSectionToggle: (key, part) => setSelectedSection((current) => current === key ? '' : key) }))),
            // The right page shows the first section's title and prose until a
            // section is clicked; this avoids a blank page without prefetching
            // event rows before the user asks for them.
            h('div', { className: 'sg-reader-track', ref: readerTrackRef },
              h('div', { className: 'sg-reader-sticky-anchor', ref: stickyAnchorRef, 'aria-hidden': 'true' }),
              !selectedSection && firstSection ? h('div', { className: 'sg-book-preview', 'aria-label': '默认打开的章节' },
                h('div', { className: 'sg-leaf-head' },
                  h('span', { className: 'sg-leaf-k' }, '1.1 · ' + Number(firstSection.part.sourceEventCount || 0) + ' 条事件'),
                  h('h3', null, firstSection.part.uiTitle)),
                h('p', { className: 'sg-leaf-sum' }, (firstSection.part.paragraphs || []).map((paragraph) => paragraph.text || '').filter(Boolean).join('\n\n') || '这一节暂时没有概要，点下方按钮或左侧任意小节可翻看原事件。'),
                h('div', { className: 'sg-reader-cta-row' },
                  h('button', { type: 'button', className: 'sg-reader-open-btn', onClick: () => setSelectedSection(firstSection.topic.id + ':' + firstSection.part.uiKey) },
                    Number(firstSection.part.sourceEventCount || 0) > 0 ? '翻看本节 ' + Number(firstSection.part.sourceEventCount) + ' 条事件 →' : '打开本节 →')),
                h('div', { className: 'sg-leaf-folio', 'aria-hidden': 'true' }, '— 第一章 · 1.1 —')) : null),
            // Pending events stay reachable through the existing lightweight
            // disclosure; CSS hides the old "待整理 N 条" label in the book.
            unassignedTotal ? h('section', { className: 'sg-topic-pending', 'aria-label': '待整理事件' },
              h('div', { className: 'sg-topic-pending-heading' },
                h('button', { type: 'button', className: 'sg-topic-pending-toggle', 'aria-expanded': pendingOpen, 'aria-controls': 'sg-topic-pending-events', onClick: () => setPendingOpen((value) => !value) }, h('span', { className: 'sg-topic-pending-label' }, '待整理'), h('span', null, unassignedTotal + ' 条'), h('span', { className: 'sg-directory-chevron', 'aria-hidden': 'true' }, '›'))),
              h(DirectoryFold, { open: pendingOpen, id: 'sg-topic-pending-events' }, h('p', null, '这些记忆尚未形成稳定主题，仍可直接查看原事件。'), h(TopicEventList, { namespace, revision: pageRevision, topicId: 'pending', total: pendingTotal, active: active && !blocked && pendingOpen, openEvent, onDirectoryChanged: invalidate, expandLabel: '查看全部待整理', collapseLabel: '收起待整理事件' }))) : null,
            h('div', { className: 'sg-toc-foot sg-leaf-foot' },
              topics.length ? h('span', { className: 'sg-toc-foot-meta' }, directory?.dreaming?.status === 'completed' && directory?.dreaming?.updatedAt ? '最近整理 ' + eventDayKey(directory.dreaming.updatedAt) : '共 ' + topics.length + ' 章') : null,
              h('style', null, DIRECTORY_PREVIEW_STYLES), h(DirectoryContextPreview, { context: blocked ? '' : directory?.context, active }))))))
    }

    function LongTermPage({ events, eventPage, graph, graphSettings = {}, project, query, setQuery, openEvent, namespace, focusNodeId, onFocusHandled, topicDirectory, onDirectoryChanged, extractionGap = false, active = true, refresh }) {
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
        h('div', { className: 'sg-pg-head' },
          h('div', { className: 'sg-pg-title' },
            h('h2', null, '长期记忆'),
            mode === 'topics' && (topicDirectory?.topics?.length || 0) > 0 ? h('span', { className: 'sg-pg-tag' }, topicDirectory.topics.length + ' 个主题' + (Number(topicDirectory?.pending?.total || 0) > 0 ? ' · ' + Number(topicDirectory.pending.total) + ' 条待整理' : '')) : null),
          h('span', { className: 'sg-pg-end' }, h('nav', { className: 'sg-long-tabs sg-seg', 'aria-label': '长期记忆视角' }, tabChildren))),
        h('div', { hidden: mode !== 'topics' }, h(TopicDirectory, { directory: topicDirectory, namespace, active: active && mode === 'topics', openEvent, onDirectoryChanged })),
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

