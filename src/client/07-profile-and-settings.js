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
    const GRAPH_CONTROL_STYLES = `.sg-graph-no-reminder{display:inline-flex;align-items:center;min-height:30px;padding:5px 8px;border:1px solid var(--sg-border);border-radius:6px;background:var(--sg-surface);color:var(--sg-muted);cursor:pointer}.sg-graph-no-reminder:hover{border-color:var(--sg-accent);color:var(--sg-accent);background:var(--sg-soft)}.sg-graph-no-reminder:disabled{cursor:not-allowed;opacity:.5}.sg-graph-notice-toggle{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:9px 0;border-top:1px solid var(--sg-border);border-bottom:1px solid var(--sg-border)}.sg-graph-notice-toggle>span{font-size:13px;font-weight:650}.sg-graph-menu{position:relative;z-index:31;display:inline-flex;align-items:center}.sg-long-tabs .sg-graph-menu-trigger{display:grid;place-items:center;align-self:center;flex:none;box-sizing:border-box;width:32px;height:32px;min-width:32px;min-height:32px;padding:0;border:0;border-radius:999px;background:transparent;color:var(--sg-muted);font-size:22px;line-height:1;cursor:pointer}.sg-graph-menu-trigger svg{display:block;width:16px;height:16px;flex:none}.sg-graph-menu-trigger:hover,.sg-graph-menu-trigger[aria-expanded=true]{background:var(--sg-soft);color:var(--sg-accent)}.sg-graph-menu-popover{position:absolute;z-index:32;right:0;left:auto;top:calc(100% + 8px);width:min(300px,calc(100vw - 32px));padding:10px;border:1px solid var(--sg-border);border-radius:10px;background:var(--sg-page);box-shadow:var(--sg-shadow);text-align:left}.sg-graph-menu-title{display:block;padding:0 2px 8px;color:var(--sg-text);font-size:13px;font-weight:650;line-height:1.4}.sg-graph-open{display:block;width:100%;margin-top:8px;padding:6px 2px 2px;border:0;border-top:1px solid var(--sg-border);background:none;color:var(--sg-text);font-size:12.5px;text-align:left;cursor:pointer}.sg-graph-open:hover{color:var(--sg-accent)}.sg-graph-copy{display:block;min-width:0}.sg-graph-title-row{display:flex;align-items:center;gap:6px;min-width:0}.sg-graph-copy b{display:block;font-size:13.5px;font-weight:650;color:var(--sg-text)}.sg-graph-copy span{display:block;margin-top:2px;font-size:11.5px;line-height:1.45;color:var(--sg-muted)}.sg-graph-title-row .sg-info-disclosure{display:inline-flex;flex:none} .sg-graph-copy .sg-graph-title-row{display:flex}.sg-graph-title-row .sg-info-trigger{width:18px;height:18px;font-size:12px}.sg-graph-menu-popover .sg-storage-card{padding:0;border:0;background:transparent}.sg-graph-menu-popover .sg-setting-note{font-size:11px;line-height:1.5}.sg-graph-dialog-heading{display:flex;align-items:center;justify-content:space-between;gap:12px}.sg-graph-dialog-heading h3{margin:0}.sg-graph-dialog-control{display:flex;align-items:center;gap:7px;color:var(--sg-muted);font-size:12px}`

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
      const graphInfo = !page ? h(InfoPopover, { label: '知识图谱说明' }, h('p', null, GRAPH_EXPLANATION), h('p', null, GRAPH_USAGE_HINT)) : null
      const showExplanation = !hideExplanation && (!page || state.noticeSeen !== true)
      return h(React.Fragment, null, h('style', null, GRAPH_CONTROL_STYLES), h('aside', { className: 'sg-storage-card sg-graph-control' + (page ? ' sg-graph-page-control' : ''), 'aria-label': page ? '知识图谱开关' : undefined },
        h('div', { className: 'sg-stage' }, h('span', { className: 'sg-graph-copy' }, h('span', { className: 'sg-graph-title-row' }, h('b', null, page ? '显示知识图谱' : '启用知识图谱'), graphInfo), page ? h('span', null, graphStatus) : null), h('span', { className: 'sg-lambda-control sg-graph-toggle' }, !page && showExplanation ? h('button', { type: 'button', className: 'sg-icon-button', 'aria-label': '不再提醒', title: '不再提醒', disabled: busy, onClick: () => void control('notice') }, '×') : null, h('button', { type: 'button', role: 'switch', 'aria-label': '显示知识图谱', 'aria-checked': state.enabled === true, disabled: busy, className: 'sg-setting-switch', onClick: () => void control(state.enabled ? 'disable' : 'preview') }))),
        page && state.enabled === true ? h('button', { type: 'button', className: 'sg-graph-open', onClick: () => onOpenGraph?.() }, '打开知识图谱 →') : null,
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
          changed ? h('button', { type: 'button', className: 'sg-save-button', disabled: editingDisabled || !valid || (custom && !catalog), onClick: () => void save() }, saving ? '保存中…' : '保存') : h('span', { className: 'sg-status organized sg-save-state', role: 'status', title: '已保存', 'aria-label': '已保存' })),
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
        h('div', { className: 'sg-model-heading-row' }, h('h4', { className: 'sg-model-heading' }, title), h(InfoPopover, { label: title + '说明' },
          h('p', null, '填写地址、密钥和模型后启用；清空地址并保存即可停用。启用会产生服务商 API 费用。'),
          h('p', null, embedding ? '启用后，事件标题和摘要会发送给向量服务商。' : '启用后，检索问题和候选事件内容会发送给精排服务商。'),
          h('p', null, '填写 OpenAI 兼容接口基础地址，不含 ' + (embedding ? '/embeddings' : '/rerank') + '。'),
          h('p', null, '保存不验证连接。' + (embedding ? '已有事件的向量会在后续检索时补齐。' : '')))),
        h('div', { className: 'sg-retrieval-fields' },
          h('label', { className: 'sg-model-field' }, 'API 地址', h('input', { type: 'url', value: value(urlKey), disabled, placeholder: 'https://你的服务地址/v1', 'aria-label': title + ' API 地址', spellCheck: false, onChange: event => edit(urlKey, event.target.value) })),
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
          h('p', { className: 'sg-setting-note' }, '占比 1 与关键词检索平权；0 停用。最低相似度范围 0–1。'),
          !numericValid ? h('p', { className: 'sg-status-feedback failed', role: 'alert' }, '占比需为 0–5 的数字，最低相似度需为 0–1 的数字。') : null) : null,
        h('div', { className: 'sg-model-save-row' }, h('div', { className: 'sg-model-saved' }, h('span', { className: 'sg-model-active-label' }, '当前生效'), h('strong', null, status)),
          changed ? h('button', { type: 'button', className: 'sg-save-button', disabled: disabled || !urlValid || !numericValid, onClick: () => void save() }, saving ? '保存中…' : '保存') : saved ? h('span', { className: 'sg-status organized sg-save-state', role: 'status', title: '已保存', 'aria-label': '已保存' }) : null),
        !saved || writable !== true ? h('p', { className: 'sg-status-feedback' }, !saved ? '检索配置尚未读取，请重新读取。' : '当前检索配置为只读。') : null,
        feedback.text ? h('p', { className: 'sg-status-feedback ' + feedback.kind, role: feedback.kind === 'failed' ? 'alert' : 'status' }, feedback.text) : null,
        !saved || feedback.kind === 'failed' ? h('button', { type: 'button', className: 'sg-quiet-button', disabled: saving || reading, onClick: () => void readSaved() }, reading ? '正在读取…' : '重新读取配置') : null)
    }

    function SettingsPage({ selected, graphSettings, vectorSettings, retrievalSettingsWritable, onRetrievalSettingsSaved, refresh, namespace, dataDirectory, onBack, setView, updateSettings, savingSettings, usePluginSettings, setMemoryModel, setEffort, resetEffort, setDailyEnabled, setDailyTimeZone, setDailyInjectionDays, onDirectoryChanged, onOpenDreamingSession }) {
      const [turnSize, setTurnSize] = React.useState(String(selected.blockTurnSize ?? 6))
      const [lambda, setLambda] = React.useState(String(selected.blockDecayLambda ?? 0.3))
      const [eventLambda, setEventLambda] = React.useState(String(selected.eventDecayLambda ?? 0.015))
      const [agentWeight, setAgentWeight] = React.useState(String(selected.agentMemoryRetrievalWeight ?? 1))
      const [directoryOpening, setDirectoryOpening] = React.useState(false)
      const [directoryFeedback, setDirectoryFeedback] = React.useState({ kind: '', text: '' })
      React.useEffect(() => {
        setTurnSize(String(selected.blockTurnSize ?? 6))
        setLambda(String(selected.blockDecayLambda ?? 0.3))
        setEventLambda(String(selected.eventDecayLambda ?? 0.015))
        setAgentWeight(String(selected.agentMemoryRetrievalWeight ?? 1))
      }, [selected.blockTurnSize, selected.blockDecayLambda, selected.eventDecayLambda, selected.agentMemoryRetrievalWeight])
      const turnSizeValue = Number(turnSize)
      const lambdaValue = Number(lambda)
      const eventLambdaValue = Number(eventLambda)
      const agentWeightValue = Number(agentWeight)
      const valid = Number.isSafeInteger(turnSizeValue) && turnSizeValue >= 1 && lambda !== '' && Number.isFinite(lambdaValue) && lambdaValue >= 0
        && eventLambda !== '' && Number.isFinite(eventLambdaValue) && eventLambdaValue >= 0
        && agentWeight !== '' && Number.isFinite(agentWeightValue) && agentWeightValue >= 0 && agentWeightValue <= 5
      const changed = valid && (turnSizeValue !== selected.blockTurnSize || lambdaValue !== selected.blockDecayLambda
        || eventLambdaValue !== (selected.eventDecayLambda ?? 0.015)
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
          const decimals = Math.max(2, (String(delta).split('.')[1] || '').length)
          const next = Math.min(max, Math.max(min, Number((current + direction * delta).toFixed(decimals))))
          onChange(String(next))
        }
        return h('span', { className: 'sg-stp sg-stp-wide' },
          h('button', { type: 'button', 'aria-label': '减少' + label, disabled: !Number.isFinite(current) || current <= min, onClick: () => bump(-1) }, '\u2212'),
          h('input', { className: 'sg-number-input', type: 'number', min: String(min), max: max === undefined ? undefined : String(max), step: String(step), value, onChange: (event) => onChange(event.target.value), 'aria-label': label }),
          h('button', { type: 'button', 'aria-label': '增加' + label, disabled: !Number.isFinite(current) || max === undefined || current >= max, onClick: () => bump(1) }, '+'))
      }
      const blockSettings = h('div', { className: 'sg-settings-panel sg-pipeline' },
        h('div', { className: 'sg-stage' }, h('span', null, '每个 Block 的对话轮数'), h('span', { className: 'sg-lambda-control' }, stepper({ value: turnSize, onChange: setTurnSize, min: 1, max: 30, step: 1, label: '每个 Block 的对话轮数' }), h('span', { className: 'sg-stage-value waiting' }, '轮'))),
        h('p', { className: 'sg-setting-note' }, '1 轮等于一次提问和完整回复，只影响后续未封存内容。'),
        h('div', { className: 'sg-stage' }, h('span', null, 'Block 衰减系数 λ'), h('span', { className: 'sg-lambda-control' }, stepper({ value: lambda, onChange: setLambda, min: 0, max: 0.4, step: 0.05, label: 'Block 衰减系数 λ', allowFloat: true }))),
        h('p', { className: 'sg-setting-note' }, '越小遗忘越慢，token 消耗越多。'),
        showSuggestion ? h('div', { className: 'sg-setting-suggestion' }, h('span', null, '建议 λ 调整为 ' + suggestedLambda.toFixed(2) + '。'), h('button', { type: 'button', className: 'sg-quiet-button', onClick: () => setLambda(String(Number(suggestedLambda.toFixed(2)))) }, '采用建议值')) : null,
        h('div', { className: 'sg-stage' }, h('span', null, 'Event 衰减系数 λ'), h('span', { className: 'sg-lambda-control' }, stepper({ value: eventLambda, onChange: setEventLambda, min: 0, max: 0.2, step: 0.005, label: 'Event 衰减系数 λ', allowFloat: true }))),
        h('p', { className: 'sg-setting-note' }, '默认 0.015，越小长期记忆权重衰减越慢，0 表示不衰减；只影响检索排序与展示，不会删除记忆。'),
        h('div', { className: 'sg-stage' }, h('span', null, '主动记忆检索占比'), h('span', { className: 'sg-lambda-control' }, stepper({ value: agentWeight, onChange: setAgentWeight, min: 0, max: 5, step: 0.05, label: '主动记忆检索占比', allowFloat: true }))),
        h('p', { className: 'sg-setting-note' }, '1 为平权，0 不展示 agent 记录。'),
        changed ? h('div', { className: 'sg-dirty' }, h('span', null, [turnSizeValue !== selected.blockTurnSize, lambdaValue !== selected.blockDecayLambda, eventLambdaValue !== (selected.eventDecayLambda ?? 0.015), agentWeightValue !== (selected.agentMemoryRetrievalWeight ?? 1)].filter(Boolean).length + ' 项未保存'),
          h('button', { type: 'button', className: 'sg-quiet-button', disabled: savingSettings, onClick: () => { setTurnSize(String(selected.blockTurnSize ?? 6)); setLambda(String(selected.blockDecayLambda ?? 0.3)); setEventLambda(String(selected.eventDecayLambda ?? 0.015)); setAgentWeight(String(selected.agentMemoryRetrievalWeight ?? 1)) } }, '放弃'),
          h('button', { type: 'button', className: 'sg-save-button', disabled: !changed || savingSettings, onClick: () => void updateSettings({ blockTurnSize: turnSizeValue, blockDecayLambda: lambdaValue, eventDecayLambda: eventLambdaValue, agentMemoryRetrievalWeight: agentWeightValue }) }, savingSettings ? '保存中…' : '保存'))
          : h('span', { className: 'sg-status organized sg-save-state', role: 'status', title: '已保存', 'aria-label': '已保存' }))
      const effortSettings = h('div', { className: 'sg-settings-panel sg-pipeline' },
        h('div', { className: 'sg-stage' }, h('span', null, '结构化推理档位'), h('span', { className: 'sg-lambda-control' },
          h('select', { className: 'sg-effort-select', value: effortMode, disabled: !settingsWritable, onChange: (event) => { if (setEffort) void setEffort(event.target.value) }, 'aria-label': '结构化推理档位策略' },
            h('option', { value: 'auto' }, 'auto（自动）'),
            h('option', { value: 'force-off' }, 'force-off（强制关闭）')),
          effortOverridden ? h('button', { type: 'button', className: 'sg-effort-button', onClick: () => { if (resetEffort) void resetEffort() } }, '恢复默认') : h('span', { className: 'sg-stage-value waiting' }, '默认'))),
        h('p', { className: 'sg-setting-note' }, 'auto 跟随模型能力；force-off 优先关闭，不支持时自动降级。'))
      const workspaceInfo = h('div', { className: 'sg-settings-panel sg-pipeline' },
        workspaceRows.map(([label, value]) => h('div', { key: label, className: 'sg-stage' }, h('span', null, label), h('span', { className: label === '内部空间 ID' ? 'sg-stage-value sg-code' : 'sg-stage-value' }, String(value)))))
      return h('div', { className: 'sg-settings-shell' },
        h(BackBar, { label: '更多', onBack }),
        h('div', { className: 'sg-pg-head' }, h('h2', null, '高级设置')),
        namespace ? h(DreamingPanel, { key: namespace, namespace, active: true, available: true, settings: true, onDirectoryChanged, onOpenDreamingSession }) : null,
        h('section', { className: 'sg-settings-group sg-settings-install', 'aria-labelledby': 'sg-memory-settings-title' },
          h('h3', { id: 'sg-memory-settings-title', className: 'sg-settings-group-title' }, '安装级设置'),
          h('div', { className: 'sg-settings-columns' },
            h('div', { className: 'sg-settings-column' },
              h(GraphSettingsPanel, { state: graphSettings, refresh }),
              h(ProfileLimitSettings),
              h(DailyNotesSettings, { usePluginSettings, setDailyEnabled, setDailyTimeZone, setDailyInjectionDays }),
              blockSettings),
            h('div', { className: 'sg-settings-column' },
              h(RetrievalModelSettings, { kind: 'embedding', settings: vectorSettings, writable: retrievalSettingsWritable, onSaved: onRetrievalSettingsSaved }),
              h(RetrievalModelSettings, { kind: 'rerank', settings: vectorSettings, writable: retrievalSettingsWritable, onSaved: onRetrievalSettingsSaved })))),
        h('section', { className: 'sg-settings-group', 'aria-labelledby': 'sg-host-settings-title' },
          h('h3', { id: 'sg-host-settings-title', className: 'sg-settings-group-title' }, '宿主配置'),
          h('div', { className: 'sg-settings-columns' },
            h('div', { className: 'sg-settings-column' }, h(MemoryModelSettings, { usePluginSettings, setMemoryModel })),
            h('div', { className: 'sg-settings-column' }, effortSettings))),
        h('section', { className: 'sg-settings-group', 'aria-labelledby': 'sg-workspace-settings-title' },
          h('h3', { id: 'sg-workspace-settings-title', className: 'sg-settings-group-title' }, '工作区信息'),
          workspaceInfo),
        h('section', { className: 'sg-settings-group', 'aria-labelledby': 'sg-storage-title' },
          h('h3', { id: 'sg-storage-title', className: 'sg-settings-group-title' }, '数据与存储'),
          h('div', { className: 'sg-storage-card' },
            h('span', { className: 'sg-storage-label' }, '数据存储位置'),
            h('span', { className: 'sg-storage-path', title: dataDirectory || undefined }, dataDirectory || '当前使用内存存储，没有本地数据目录'),
            h('div', { className: 'sg-storage-actions' },
              h('button', { type: 'button', className: 'sg-storage-button', disabled: !dataDirectory || directoryOpening, onClick: openDirectory }, directoryOpening ? '正在打开…' : '打开文件夹'),
              h('button', { type: 'button', className: 'sg-storage-button', disabled: !dataDirectory, onClick: copyDirectory }, '复制路径')),
            h('p', { className: 'sg-storage-feedback ' + directoryFeedback.kind, role: directoryFeedback.kind === 'failed' ? 'alert' : 'status', 'aria-live': 'polite' }, directoryFeedback.text)),
          menu([['raw', '{}', '查看原始数据', 'Block、Event、Graph 与模型响应']])),
        h('section', { className: 'sg-settings-group sg-settings-compact', 'aria-labelledby': 'sg-diagnostics-title' },
          h('h3', { id: 'sg-diagnostics-title', className: 'sg-settings-group-title' }, '运行与诊断'),
          menu(runtimeDiagnostics))
      )
    }

