import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { StrataGateRuntime } from './runtime.js'
import type {} from '@deepseek-ai/dsh-tools'
import { AGENT_FEEDBACK_ENABLED } from './feedback-policy.js'

// Email draft preparation is independent of archived GitHub navigation.
export { AGENT_FEEDBACK_ENABLED } from './feedback-policy.js'

const SEARCH_RESULT_GUIDANCE = ' Read retrievalStatus and retrievalHint: scope_empty applies only to this search scope; no_match means this query found no match; unknown means scope availability could not be determined. An empty result never proves a memory was never recorded. 不得把空结果表述成“没有这条记忆”或“你没说过”。检索异常按工具错误处理，不是正常空结果。状态提示不是事实证据，不得采用或强化。'

const jsonOutput = {
  schema: { type: 'json' as const },
  render: (_args: unknown, value: unknown): ContentBlock[] => [{
    type: 'text',
    text: JSON.stringify(value, null, 2),
  }],
}

function sessionOf(exec: ToolRunContext): Session {
  if (!exec.agent) throw new Error('StrataGate tools require an active DSH agent session')
  return exec.agent.session
}

export function registerMemoryTools(ctx: Context, runtime: StrataGateRuntime): void {
  ctx.tools.register(defineTool({
    name: 'memory_search_experiences',
    description: 'This tool is provided by the StrataGate plugin. 在当前记忆空间查找从历史整理出的故障排查方法、可复用经验及其来源。先核对经验的适用条件，把它作为参考资料。',
    parameters: { query: { type: 'string', required: true }, limit: { type: 'integer' }, offset: { type: 'integer' } },
    output: jsonOutput,
    execute: async (args, exec) => runtime.searchExperiences(sessionOf(exec), args.query, args.limit, args.offset) as never,
  }))

  ctx.tools.register(defineTool({
    name: 'memory_profile_update',
    description: `This tool is provided by the StrataGate plugin. 修改用户常驻画像中的一个固定字段（每次会话自动注入，无需检索）。

字段语义与独立性：
- defaultLocation（未指定地点时的默认位置）、homeCity（稳定常驻城市）和 currentCity（当前所在城市，含出差/旅行的临时驻留，持久化直到修改或清空）彼此独立，不互相推断或覆盖；未指定地点的本地任务优先参考 currentCity，其次 defaultLocation。
- preferredLanguage（最终回答语言）与 reasoningLanguage（可见思考语言，不影响隐藏推理）彼此独立。
- 只需按情境检索的事实、决定、经历请用 memory_remember；仅本轮有效的要求不要写入。

每次只修改一个已有字段。仅在用户明确要求修改，或你先说明字段与新值并获用户明确同意后才可调用。`,
    parameters: {
      field: { type: 'string', required: true, enum: ['userPreferredName', 'assistantPreferredName', 'preferredLanguage', 'reasoningLanguage', 'defaultLocation', 'homeCity', 'currentCity', 'responsePreferences', 'standingInstructions', 'userBackground', 'longTermGoals', 'persistentNotes'] as const },
      value: { type: 'string', required: true },
    },
    output: jsonOutput,
    execute: async (args, exec) => {
      if (Object.keys(args).some((key) => key !== 'field' && key !== 'value')) throw new TypeError('Unknown Profile update argument')
      sessionOf(exec)
      return runtime.updatePersistentProfileFromTool(args.field, args.value) as never
    },
  }))

  if (AGENT_FEEDBACK_ENABLED) ctx.tools.register(defineTool({
    name: 'feedback_prepare',
    description: 'This tool is provided by the StrataGate plugin. 整理 StrataGate 插件的故障、使用疑问和改进建议，生成本地邮件反馈草稿并自动附带运行摘要。用户直接要求可调用；主动建议须先获同意。依据当前会话事实填写，未知留空，去除凭据。省略字段保留原值，空字符串或空数组清空；新问题传 new_draft=true。成功后说明草稿在本地、邮件尚未发送，并将 feedbackUrl 显示为“打开反馈草稿”链接，供用户检查后手动发邮件。',
    parameters: {
      new_draft: { type: 'boolean', description: '新问题为 true；修改已有草稿时省略。' },
      title: { type: 'string', description: '简短问题标题。' },
      description: { type: 'string', description: '已知问题、建议或疑问。' },
      reproduction: { type: 'array', items: { type: 'string' }, description: '实际发生过的复现步骤。' },
      expected: { type: 'string', description: '已知预期结果。' },
      actual: { type: 'string', description: '实际观察到的结果。' },
      error_context: { type: 'string', description: '当前会话的相关错误；本地诊断由程序自动补充。' },
    },
    output: jsonOutput,
    execute: async (args, exec) => runtime.prepareFeedback(sessionOf(exec), {
      ...(args.new_draft !== undefined ? { newDraft: args.new_draft } : {}),
      ...(args.title !== undefined ? { title: args.title } : {}),
      ...(args.description !== undefined ? { description: args.description } : {}),
      ...(args.reproduction !== undefined ? { reproduction: args.reproduction } : {}),
      ...(args.expected !== undefined ? { expected: args.expected } : {}),
      ...(args.actual !== undefined ? { actual: args.actual } : {}),
      ...(args.error_context !== undefined ? { errorContext: args.error_context } : {}),
    }) as never,
  }))

  if (AGENT_FEEDBACK_ENABLED) ctx.tools.register(defineTool({
    name: 'stratagate_diagnostics',
    description: 'This tool is provided by the StrataGate plugin. 只读查询 StrataGate 插件当前记忆空间的运行诊断：近期失败、任务状态、耗时、Token 用量与采集覆盖度。默认给摘要；用返回的诊断 id 读取脱敏错误详情，offset 分页。用于排查或回应用户疑问；反馈草稿会自动附带摘要。',
    parameters: {
      id: { type: 'string', description: '摘要中返回的诊断 ID；提供时读取该条详情。' },
      offset: { type: 'integer', description: '使用返回的 nextOffset 继续读取近期异常。' },
    },
    output: jsonOutput,
    execute: async (args, exec) => runtime.diagnosticReport(runtime.namespaceFor(sessionOf(exec)), {
      ...(args.id !== undefined ? { id: args.id, details: true } : {}),
      ...(args.offset !== undefined ? { offset: args.offset } : {}),
    }) as never,
  }))

  ctx.tools.register(defineTool({
    name: 'memory_list_topics',
    description: 'This tool is provided by the StrataGate plugin. 浏览当前记忆空间的主题目录。可按分类分页，或用 query 查主题名称及简介。未整理的事件也有入口。目录仅供导航，不创建证据批次，不强化记忆；需要主题脉络时调用 memory_expand_topic；需要事实证据可直接 memory_search_events(topic_id)，并评估来源事件。',
    parameters: {
      query: { type: 'string', description: '可选的主题关键词；省略时浏览完整目录。' },
      category: { type: 'string', enum: ['preferences', 'decisions', 'work', 'relationships', 'other'] as const },
      offset: { type: 'integer', description: '从第几项开始，使用返回的 nextOffset 继续。' },
      limit: { type: 'integer', description: '每页 1-20 项，默认 12 项。' },
    },
    output: jsonOutput,
    execute: async (args, exec) => runtime.listTopics(sessionOf(exec), args) as never,
  }))

  ctx.tools.register(defineTool({
    name: 'memory_expand_topic',
    description: 'This tool is provided by the StrataGate plugin. 展开一个记忆主题，查看有事件来源的历史、决定、变化和待确认事项；返回覆盖范围及省略数量。概览用于导航，不是事实证据，也不创建证据批次。使用 memory_search_events 的 topic_id 检索真实来源，再按既有评估与采用流程使用。概览尚未生成或已失效时，仍可通过关联事件继续检索。',
    parameters: { id: { type: 'string', required: true, description: '目录返回的主题 ID。' } },
    output: jsonOutput,
    execute: async (args, exec) => runtime.expandTopic(sessionOf(exec), args.id) as never,
  }))

  ctx.tools.register(defineTool({
    name: 'memory_search_events',
    description: 'This tool is provided by the StrataGate plugin. Search durable Event memories for past facts, decisions, plans, changes, preferences, outcomes, and timing. Use a focused query with the most distinctive known names, entities, versions, tools, decisions, or outcomes. Results are compact candidates; rankScore reflects retrieval order only, not confidence or factual accuracy. Expand a relevant Event when its compact fields are not enough to verify the needed detail. Optionally pass topic_id to search within a navigated topic; query may be empty to browse its events, offset continues pagination, and temporalIntent first/latest controls chronology.' + SEARCH_RESULT_GUIDANCE,
    parameters: {
      query: { type: 'string', required: true, description: 'A focused query for the target historical memory. Prefer explicit names, entities, versions, tools, decisions, or outcomes over vague references. May be empty when browsing a supplied topic_id.' },
      topic_id: { type: 'string', description: '目录中的主题 ID；限定真实来源事件，空 query 可浏览。' },
      offset: { type: 'integer', description: '从第几项开始；主题浏览时用返回的 nextOffset 继续取证。' },
      limit: { type: 'integer', description: 'Maximum results, 1-20.' },
      temporalIntent: { type: 'string', enum: ['first', 'latest'] as const },
      eventType: { type: 'string' },
      participants: { type: 'array', items: { type: 'string' } },
    },
    output: jsonOutput,
    execute: async (args, exec) => runtime.searchEvents(sessionOf(exec), args.query, {
      ...(args.topic_id !== undefined ? { topicId: args.topic_id } : {}),
      ...(args.offset !== undefined ? { offset: args.offset } : {}),
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
      ...(args.temporalIntent ? { temporalIntent: args.temporalIntent } : {}),
      ...(args.eventType ? { eventType: args.eventType } : {}),
      ...(args.participants ? { participants: args.participants } : {}),
    }) as never,
  }))

  const graphDefinitions = [defineTool({
    name: 'memory_search_graph',
    description: 'This tool is provided by the StrataGate plugin. Search the Event-backed Knowledge Graph for current state and query-relevant history. Results explicitly label current, historical, or both; historical matches never imply current truth, disputed records remain marked, and Event evidence is bounded to the match. Endpoint names and aliases can match relations, while relation text alone is ranking context. rankScore is ranking-only, never confidence or factual accuracy.' + SEARCH_RESULT_GUIDANCE,
    parameters: {
      query: { type: 'string', required: true },
      limit: { type: 'integer', description: 'Maximum results, 1-20.' },
    },
    output: jsonOutput,
    execute: async (args, exec) => runtime.searchGraph(sessionOf(exec), args.query, args.limit ?? 8) as never,
  }), defineTool({
    name: 'memory_expand_graph_node',
    description: 'This tool is provided by the StrataGate plugin. Expand one Knowledge Graph node through the same Event-authoritative view as search: dynamic current state, marked disputed records, retrievable history, and bounded supporting Event evidence. Forgotten or archived Event provenance is never exposed.',
    parameters: { id: { type: 'string', required: true } },
    output: jsonOutput,
    execute: async (args, exec) => runtime.expandGraphNode(sessionOf(exec), args.id) as never,
  }), defineTool({
    name: 'memory_expand_element',
    description: 'This tool is provided by the StrataGate plugin. Expand an Element card, optionally as it was at an ISO date. The result is a new evidence batch and must be assessed.',
    parameters: {
      id: { type: 'string', required: true },
      at: { type: 'string' },
    },
    output: jsonOutput,
    execute: async (args, exec) => runtime.expandElement(sessionOf(exec), args.id, args.at) as never,
  })]
  let graphDisposers: Array<() => void> = []
  let syncAssessmentTool = () => {}
  const syncGraphTools = () => {
    if (runtime.graphEnabled === false) {
      for (const dispose of graphDisposers) dispose?.()
      graphDisposers = []
    } else if (!graphDisposers.length) graphDisposers = graphDefinitions.map(definition => ctx.tools.register(definition))
    syncAssessmentTool()
  }
  syncGraphTools()
  runtime.onGraphAvailabilityChanged?.(syncGraphTools)
  ctx.on?.('system-prompt/assemble', async (_assembly, _context, next) => { syncGraphTools(); return next() })

  ctx.tools.register(defineTool({
    name: 'memory_search_raw',
    description: 'This tool is provided by the StrataGate plugin. Search archived messages when summarized memories are insufficient. Returns compact raw hits (message id, blockId, excerpt, role, and time); use memory_expand_block with blockId for complete source details. By default searches the whole current namespace; use scope=session for the active thread. Returns evidence refs and batchId for assessment.' + SEARCH_RESULT_GUIDANCE,
    parameters: {
      query: { type: 'string', required: true },
      limit: { type: 'integer' },
      scope: { type: 'string', enum: ['namespace', 'session'] as const, description: 'Search range. Defaults to namespace for compatibility with historical raw search behavior.' },
    },
    output: jsonOutput,
    execute: async (args, exec) => runtime.searchRaw(sessionOf(exec), args.query, args.limit, args.scope) as never,
  }))

  ctx.tools.register(defineTool({
    name: 'memory_get_blocks',
    description: 'This tool is provided by the StrataGate plugin. Browse a paginated block directory containing id, title, turnRange, the layer actually injected into the model, and targetLevel when the decay target differs. Use memory_expand_block for source content. Defaults to blocks with the active threadId only; use scope=namespace to browse every thread and legacy unthreaded blocks in the current namespace. Reports counts, offset, limit, nextOffset, and emptyReason; use nextOffset to continue.',
    parameters: {
      scope: { type: 'string', enum: ['session', 'namespace'] as const, description: 'Query range. Defaults to session to preserve existing isolation behavior.' },
      offset: { type: 'integer', description: '从第几项开始，使用返回的 nextOffset 继续。' },
      limit: { type: 'integer', description: '每页 1-20 项，默认 12 项。' },
    },
    output: jsonOutput,
    execute: async (args, exec) => runtime.blocks(sessionOf(exec), args.scope, args) as never,
  }))

  ctx.tools.register(defineTool({
    name: 'memory_expand_block',
    description: 'This tool is provided by the StrataGate plugin. Expand one historical conversation Block to a more detailed layer. Use it when a Block checkpoint lacks the detail needed for the current task; pass the Block id shown in the checkpoint or returned by memory_get_blocks. The result is a new evidence batch and must be assessed.',
    parameters: {
      id: { type: 'string', required: true },
      target: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
    },
    output: jsonOutput,
    execute: async (args, exec) => runtime.expandBlock(sessionOf(exec), args.id, args.target) as never,
  }))

  ctx.tools.register(defineTool({
    name: 'memory_expand_event',
    description: 'This tool is provided by the StrataGate plugin. Retrieve one complete Event card by id. The result is a new evidence batch and must be assessed.',
    parameters: {
      id: { type: 'string', required: true },
    },
    output: jsonOutput,
    execute: async (args, exec) => runtime.expandEvent(sessionOf(exec), args.id) as never,
  }))

  let assessmentDisposer: (() => void) | undefined
  let assessmentGraphEnabled: boolean | undefined
  syncAssessmentTool = () => {
    const enabled = runtime.graphEnabled !== false
    if (assessmentGraphEnabled === enabled) return
    assessmentDisposer?.()
    assessmentDisposer = ctx.tools.register(defineTool({
      name: 'memory_assess',
      description: 'This tool is provided by the StrataGate plugin. Apply StrataGate Evidence Gate to a retrieval batch BEFORE the final user answer. Assess evidence, close all batches with memory_record_use, then output the user answer. Pass batch_id from the retrieval result; omitting it remains compatible with sequential flows and selects the latest batch. The response reports every input ref that was not adopted and why.',
      parameters: {
        batch_id: { type: 'string', description: 'The batchId returned by the retrieval to assess. Omit only in a strictly sequential flow.' },
        verdict: { type: 'string', enum: ['sufficient', 'partial', 'wrong'] as const, required: true },
        evidence_refs: { oneOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }], required: true,
          description: 'Evidence refs adopted from this batch. Use [] when none are adopted; null is also accepted as [].' },
        fit: { type: 'string', required: true },
        missing: { type: 'string', required: true },
        next_strategy: {
          type: 'string',
          enum: enabled
            ? ['answer', 'search_events', 'expand_event', 'search_graph', 'expand_graph_node', 'expand_element', 'search_raw_memory', 'expand_block'] as const
            : ['answer', 'search_events', 'expand_event', 'search_raw_memory', 'expand_block'] as const,
          required: true,
        },
      },
      output: jsonOutput,
      execute: async (args, exec) => runtime.assess(sessionOf(exec), { ...args, evidence_refs: args.evidence_refs ?? [] }, args.batch_id) as never,
    }))
    assessmentGraphEnabled = enabled
  }
  syncAssessmentTool()

  ctx.tools.register(defineTool({
    name: 'memory_record_use',
    description: 'This tool is provided by the StrataGate plugin. Close one StrataGate retrieval batch BEFORE outputting the final user answer. Complete memory_assess / memory_record_use as pre-answer evidence processing for ALL batches, then generate the final user answer. Pass its batch_id and exactly the evidenceRefs from that batch actually adopted for the answer, or [] when none are used. Non-empty refs require that batch\'s sufficient assessment. Never write the answer first and record usage afterwards. Do not turn this tool\'s internal receipt or batch status into a user-facing answer. The host renders successful selections as answer-tail citations, so do not write a manual citation list. Omitting batch_id selects the latest batch for sequential compatibility.',
    parameters: {
      batch_id: { type: 'string', description: 'The batchId to close. Omit only in a strictly sequential flow.' },
      evidence_refs: { oneOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }], required: true,
        description: 'Evidence refs actually used in the answer. Use [] when none are used; null is also accepted as [].' },
    },
    output: jsonOutput,
    execute: async (args, exec) => runtime.recordUse(
      sessionOf(exec),
      String(exec.callId),
      args.evidence_refs ?? [],
      args.batch_id,
    ) as never,
  }))

  if (runtime.dailyNotesEnabled) {
    ctx.tools.register(defineTool({
      name: 'memory_daily_write',
      description: `This tool is provided by the StrataGate plugin. 写入或更新当前记忆空间的每日工作笔记（按日期记录进展、阶段结果、有效失败、阻塞与下一步，供后续会话接续）。

- 新增：省略 old_text，提供 title 与 content（date 默认今天）。当天已有同名事项时工具会返回现有全文，请改用 old_text 局部更新；跨天接续工作时可简注前日来源，只写新进展。
- 修改/删除：提供 title、old_text 与 content（content 为空字符串表示删除）。old_text 须取自本会话读取或工具返回的最新原文且唯一匹配；会话开始注入的笔记可能已过期，若失败请按返回的当前全文合并重试。
- 区分计划、已执行与已验证，不记凭据与秘密，工具返回成功才算已记录。`,
      parameters: {
        date: { type: 'string', description: 'YYYY-MM-DD。新增时默认今天（本机时区）；修改时填事项所在日期，默认今天。' },
        title: { type: 'string', required: true, description: '事项名称，对应文件中的“## 标题”。必填；修改时用于定位，失败时据此返回该事项全文。' },
        content: { type: 'string', required: true, description: '新增时为事项正文，不含标题行；修改时为替换 old_text 的新文本，空字符串表示删除。' },
        old_text: { type: 'string', description: '要替换的原文片段，必须与文件当前内容逐字一致且只出现一次。省略表示新增。' }
      },
      output: jsonOutput,
      execute: async (args, exec) => runtime.dailyNotes.write(runtime.namespaceFor(sessionOf(exec)), args) as never,
    }))
    ctx.tools.register(defineTool({
      name: 'memory_daily_read',
      description: 'This tool is provided by the StrataGate plugin. 读取或检索当前记忆空间的每日工作笔记：仅传 date 读该日全文，传 query 检索近期笔记，都不传则列出近期日期与事项标题。最近几个有记录日期的笔记已在会话开始时注入，需要更早日期、关键词检索或编辑前获取最新原文时调用。笔记属于工作记录而非事实证据，不触发 Evidence Gate；未命中不证明没有记录。',
      parameters: {
        date: { type: 'string', description: 'YYYY-MM-DD，要读取或限定检索的日期。' },
        query: { type: 'string', description: '检索关键词，优先使用项目名、文件名、事项名称等具体词。' },
        offset: { type: 'number', description: '使用上次返回的 nextOffset 继续读取。' }
      },
      output: jsonOutput,
      execute: async (args, exec) => runtime.dailyNotes.read(runtime.namespaceFor(sessionOf(exec)), args) as never,
    }))
  }

  if (runtime.agentMemoryEnabled) {
    ctx.tools.register(defineTool({
      name: 'memory_remember',
      description: `This tool is provided by the StrataGate plugin. 主动保存一条适合在相关情境中召回的长期记忆（项目事实、决定、经历、纠正或特定情境偏好）。常驻画像字段请用 memory_profile_update；${runtime.dailyNotesEnabled ? '正在推进的工作进展请写入每日笔记（memory_daily_write）。' : '仅当前轮次有效的临时状态不要写入。'}

每次用一句完整、可独立理解的话记录一个事实（保留必要的项目、时间与范围），不记推测、秘密或凭据。若本条记忆直接更正或替代既有记忆，传入 supersedesEventIds 并在获得用户明确授权后设置 user_authorized=true；同一信息默认只写一处。`,
      parameters: {
        content: { type: 'string', required: true, description: 'The fact to remember, stated as one self-contained sentence.' },
        category: { type: 'string', enum: ['preference', 'decision', 'correction', 'fact'] as const },
        supersedesEventIds: { type: 'array', items: { type: 'string' }, description: 'Optional active Event IDs explicitly replaced by this memory. Requires user_authorized=true.' },
        user_authorized: { type: 'boolean', description: 'Must be true when supersedesEventIds is provided, confirming explicit user authorization.' },
        reason: { type: 'string', description: 'Optional brief explanation when replacing existing Events.' },
      },
      output: jsonOutput,
      execute: async (args, exec) => runtime.recordAgentMemory(sessionOf(exec), args.content, args.category, {
        ...(args.supersedesEventIds !== undefined ? { supersedesEventIds: args.supersedesEventIds } : {}),
        ...(args.user_authorized !== undefined ? { userAuthorized: args.user_authorized } : {}),
        ...(args.reason !== undefined ? { reason: args.reason } : {}),
      }) as never,
    }))
  }

  ctx.tools.register(defineTool({
    name: 'memory_update_event',
    description: 'This tool is provided by the StrataGate plugin. 修改或更正一条既有 Event 记忆卡（派生 Event 与主动记忆均支持，含置顶或安全卡），或将旧卡标记为被本卡替代（supersedesEventIds），不改动原始对话记录。必须先获得用户明确授权并传入 user_authorized=true。',
    parameters: {
      id: { type: 'string', required: true, description: '要修改的 Event ID。' },
      title: { type: 'string', description: '新的标题（1-200 字符）；省略则保持不变。' },
      summary: { type: 'string', description: '新的摘要内容（1-12000 字符）；省略则保持不变。' },
      supersedesEventIds: { type: 'array', items: { type: 'string' }, description: '要标记为被本卡替代的既有 active Event ID 列表。' },
      user_authorized: { type: 'boolean', required: true, description: '必须为 true，确认已获用户明确授权。' },
    },
    output: jsonOutput,
    execute: async (args, exec) => runtime.updateAgentMemoryEvent(sessionOf(exec), {
      id: args.id,
      ...(args.title !== undefined ? { title: args.title } : {}),
      ...(args.summary !== undefined ? { summary: args.summary } : {}),
      ...(args.supersedesEventIds !== undefined ? { supersedesEventIds: args.supersedesEventIds } : {}),
      userAuthorized: args.user_authorized,
    }) as never,
  }))

  ctx.tools.register(defineTool({
    name: 'memory_forget',
    description: 'This tool is provided by the StrataGate plugin. 遗忘一条不再需要的既有 Event 记忆卡（派生 Event 与主动记忆均支持，含置顶或安全卡），使其不再参与后续召回与激活。必须先获得用户明确授权并传入 user_authorized=true。',
    parameters: {
      id: { type: 'string', required: true, description: '要遗忘的 Event ID。' },
      user_authorized: { type: 'boolean', required: true, description: '必须为 true，确认已获用户明确授权。' },
      reason: { type: 'string', description: '可选的遗忘原因说明。' },
    },
    output: jsonOutput,
    execute: async (args, exec) => runtime.forgetAgentMemory(sessionOf(exec), args.id, args.user_authorized, args.reason) as never,
  }))
}
