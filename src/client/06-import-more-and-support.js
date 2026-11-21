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
        goRow('settings', '高级设置', '向量检索、精排与记忆配置', 'settings'),
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
