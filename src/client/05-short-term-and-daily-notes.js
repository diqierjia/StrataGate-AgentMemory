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
