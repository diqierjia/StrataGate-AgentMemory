import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { StrataGateRuntime } from './runtime.js'
import type {} from '@deepseek-ai/dsh-tools'

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
    name: 'memory_profile_update',
    description: `This tool is provided by the StrataGate plugin. 修改用户常驻画像中的一个固定字段：用户称呼、助手名字、默认回答语言、思考过程语言、回复方式和风格偏好、长期持续生效的要求、稳定的用户背景、长期目标，或其他必须常驻的信息。

这些信息会自动提供给后续每次对话，无需检索。只有确实需要持续放在上下文中的信息，才适合写入画像。

默认回答语言只控制最终面向用户的回答；思考过程语言只控制宿主界面支持时用户可见的思考文本，不控制隐藏推理。两者是独立字段，只修改用户指定的字段。例如“以后都用中文回答我”只修改 preferredLanguage，“以后思考过程用中文”只修改 reasoningLanguage；两者都要求时分别调用两次。

每次调用只修改一个已有字段，不新增、删除或改名字段，也不为修改一个字段重写整份画像。用户明确要求修改时可直接执行；如果是你主动建议修改，须先说明具体字段和新值。只有用户紧接着明确回复“同意”，才授权这一次修改；沉默、拒绝、换话题或提出不同修改都不算授权。

只需在相关情境中想起的项目事实、经历、决定或偏好，请使用 memory_remember；仅本次有效的要求不写入记忆。不能因为用户说了“记住”就自动选择本工具，也不能在 memory_remember 不可用时把 Event 信息改写成常驻画像。`,
    parameters: {
      field: { type: 'string', required: true, enum: ['userPreferredName', 'assistantPreferredName', 'preferredLanguage', 'reasoningLanguage', 'responsePreferences', 'standingInstructions', 'userBackground', 'longTermGoals', 'persistentNotes'] as const },
      value: { type: 'string', required: true },
    },
    output: jsonOutput,
    execute: async (args, exec) => {
      if (Object.keys(args).some((key) => key !== 'field' && key !== 'value')) throw new TypeError('Unknown Profile update argument')
      sessionOf(exec)
      return runtime.updatePersistentProfileFromTool(args.field, args.value) as never
    },
  }))

  ctx.tools.register(defineTool({
    name: 'feedback_prepare',
    description: 'This tool is provided by the StrataGate plugin. Create or revise a local StrataGate feedback draft when the user directly requests it, or after a proactive suggestion permitted by the StrataGate feedback policy and the user explicitly agrees. A direct user request is already authorization. Use only facts known from the current conversation; leave unknown fields empty and never invent versions, logs, Block counts, or diagnostics. Never submit anything to GitHub. After success, briefly say the draft is local and not submitted, then render feedbackUrl as a Markdown link labeled "打开反馈草稿". Then ask exactly once: "要不要顺便让我尝试修复这个问题，并提交一个 PR？" If the user does not respond or declines, do not ask again. Do not use a popup or other additional UI. Do not print draft fields or an Issue-content table, and do not direct the user through Settings manually.',
    parameters: {
      title: { type: 'string' },
      description: { type: 'string' },
      reproduction: { type: 'array', items: { type: 'string' } },
      expected: { type: 'string' },
      actual: { type: 'string' },
      error_context: { type: 'string' },
    },
    output: jsonOutput,
    execute: async (args, exec) => runtime.prepareFeedback(sessionOf(exec), {
      ...(args.title !== undefined ? { title: args.title } : {}),
      ...(args.description !== undefined ? { description: args.description } : {}),
      ...(args.reproduction !== undefined ? { reproduction: args.reproduction } : {}),
      ...(args.expected !== undefined ? { expected: args.expected } : {}),
      ...(args.actual !== undefined ? { actual: args.actual } : {}),
      ...(args.error_context !== undefined ? { errorContext: args.error_context } : {}),
    }) as never,
  }))

  ctx.tools.register(defineTool({
    name: 'memory_list_topics',
    description: 'This tool is provided by the StrataGate plugin. 浏览当前记忆空间的主题目录。可按分类分页，或用 query 查主题名称及简介。未整理的事件也有入口。目录仅供导航，不创建证据批次，不强化记忆；找到相关主题后调用 memory_expand_topic，实际引用事实前检索并评估来源事件。',
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
    description: 'This tool is provided by the StrataGate plugin. Search durable Event memories for past facts, decisions, plans, changes, preferences, outcomes, and timing. Use a focused query with the most distinctive known names, entities, versions, tools, decisions, or outcomes. Results are compact candidates; rankScore reflects retrieval order only, not confidence or factual accuracy. Expand a relevant Event when its compact fields are not enough to verify the needed detail. Optionally pass topic_id to search within a navigated topic; query may be empty to browse its events, offset continues pagination, and temporalIntent first/latest controls chronology.',
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

  ctx.tools.register(defineTool({
    name: 'memory_search_graph',
    description: 'This tool is provided by the StrataGate plugin. Search the Event-backed Knowledge Graph for current state and query-relevant history. Results explicitly label current, historical, or both; historical matches never imply current truth, disputed records remain marked, and Event evidence is bounded to the match. Endpoint names and aliases can match relations, while relation text alone is ranking context. rankScore is ranking-only, never confidence or factual accuracy.',
    parameters: {
      query: { type: 'string', required: true },
      limit: { type: 'integer', description: 'Maximum results, 1-20.' },
    },
    output: jsonOutput,
    execute: async (args, exec) => runtime.searchGraph(sessionOf(exec), args.query, args.limit ?? 8) as never,
  }))

  ctx.tools.register(defineTool({
    name: 'memory_expand_graph_node',
    description: 'This tool is provided by the StrataGate plugin. Expand one Knowledge Graph node through the same Event-authoritative view as search: dynamic current state, marked disputed records, retrievable history, and bounded supporting Event evidence. Forgotten or archived Event provenance is never exposed.',
    parameters: { id: { type: 'string', required: true } },
    output: jsonOutput,
    execute: async (args, exec) => runtime.expandGraphNode(sessionOf(exec), args.id) as never,
  }))

  ctx.tools.register(defineTool({
    name: 'memory_search_elements',
    description: 'This tool is provided by the StrataGate plugin. Deprecated compatibility search for legacy Element-card data. Returns compact fact hits; rankScore is BM25/RRF ordering only, never confidence or factual accuracy. Prefer memory_search_graph.',
    parameters: {
      query: { type: 'string', required: true },
      limit: { type: 'integer' },
      name: { type: 'string' },
      elementType: { type: 'string', enum: ['person', 'project', 'organization', 'tool', 'place'] as const },
    },
    output: jsonOutput,
    execute: async (args, exec) => runtime.searchElements(sessionOf(exec), args.query, {
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
      ...(args.name ? { name: args.name } : {}),
      ...(args.elementType ? { type: args.elementType } : {}),
    }) as never,
  }))

  ctx.tools.register(defineTool({
    name: 'memory_search_raw',
    description: 'This tool is provided by the StrataGate plugin. Search archived messages when summarized memories are insufficient. Returns compact raw hits (message id, blockId, excerpt, role, and time); use memory_expand_block with blockId for complete source details. By default searches the whole current namespace; use scope=session for the active thread. Returns evidence refs and batchId for assessment.',
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
    description: 'This tool is provided by the StrataGate plugin. List decayed conversation-block summaries and their current detail levels. Defaults to the active session only; use scope=namespace to inspect every thread in the current namespace. The response always reports scope, namespace, threadId, counts, and a machine-readable emptyReason when no blocks match.',
    parameters: {
      scope: { type: 'string', enum: ['session', 'namespace'] as const, description: 'Query range. Defaults to session to preserve existing isolation behavior.' },
    },
    output: jsonOutput,
    execute: async (args, exec) => runtime.blocks(sessionOf(exec), args.scope) as never,
  }))

  ctx.tools.register(defineTool({
    name: 'memory_expand_block',
    description: 'This tool is provided by the StrataGate plugin. Expand one memory block to a more detailed layer. The result is a new evidence batch and must be assessed.',
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

  ctx.tools.register(defineTool({
    name: 'memory_expand_element',
    description: 'This tool is provided by the StrataGate plugin. Expand an Element card, optionally as it was at an ISO date. The result is a new evidence batch and must be assessed.',
    parameters: {
      id: { type: 'string', required: true },
      at: { type: 'string' },
    },
    output: jsonOutput,
    execute: async (args, exec) => runtime.expandElement(sessionOf(exec), args.id, args.at) as never,
  }))

  ctx.tools.register(defineTool({
    name: 'memory_assess',
    description: 'This tool is provided by the StrataGate plugin. Apply StrataGate Evidence Gate to a retrieval batch. Pass batch_id from the retrieval result; omitting it remains compatible with sequential flows and selects the latest batch. The response reports every input ref that was not adopted and why.',
    parameters: {
      batch_id: { type: 'string', description: 'The batchId returned by the retrieval to assess. Omit only in a strictly sequential flow.' },
      verdict: { type: 'string', enum: ['sufficient', 'partial', 'wrong'] as const, required: true },
      evidence_refs: { type: 'array', items: { type: 'string' }, required: true },
      fit: { type: 'string', required: true },
      missing: { type: 'string', required: true },
      next_strategy: {
        type: 'string',
        enum: ['answer', 'search_events', 'expand_event', 'search_graph', 'expand_graph_node', 'search_elements', 'expand_element', 'search_raw_memory', 'expand_block'] as const,
        required: true,
      },
    },
    output: jsonOutput,
    execute: async (args, exec) => runtime.assess(sessionOf(exec), args, args.batch_id) as never,
  }))

  ctx.tools.register(defineTool({
    name: 'memory_record_use',
    description: 'This tool is provided by the StrataGate plugin. Close one StrataGate retrieval batch. Pass its batch_id and exactly the evidenceRefs from that batch actually used in the answer, or [] when none were used. Non-empty refs require that batch\'s sufficient assessment. The host renders successful selections as answer-tail citations, so do not write a manual citation list. Omitting batch_id selects the latest batch for sequential compatibility.',
    parameters: {
      batch_id: { type: 'string', description: 'The batchId to close. Omit only in a strictly sequential flow.' },
      evidence_refs: { type: 'array', items: { type: 'string' }, required: true },
    },
    output: jsonOutput,
    execute: async (args, exec) => runtime.recordUse(
      sessionOf(exec),
      String(exec.callId),
      args.evidence_refs,
      args.batch_id,
    ) as never,
  }))

  if (runtime.agentMemoryEnabled) {
    ctx.tools.register(defineTool({
      name: 'memory_remember',
      description: `This tool is provided by the StrataGate plugin. 主动保存一条对未来有价值、适合在相关情境中回忆的信息，例如项目事实、已经做出的决定、重要经历、事实纠正，以及特定场景下的用户偏好。用户明确要求记住，或对话中出现明确且值得保留的信息时，可以使用本工具。

保存的信息会按相关性被检索或提供给后续对话，不保证每次出现。需要每次对话自动提供的常驻画像信息，请使用 memory_profile_update，并遵守其授权要求。

每次用一句完整、可独立理解的话记录一个事实，保留必要的项目、时间和适用范围。不要把推测当成事实，不记录秘密、凭据、临时任务状态或仅本次有效的要求。

根据内容和适用范围选择工具；“记住”一词本身不决定使用哪个工具。同一信息默认只写入一处。`,
      parameters: {
        content: { type: 'string', required: true, description: 'The fact to remember, stated as one self-contained sentence.' },
        category: { type: 'string', enum: ['preference', 'decision', 'correction', 'fact'] as const },
      },
      output: jsonOutput,
      execute: async (args, exec) => runtime.recordAgentMemory(sessionOf(exec), args.content, args.category) as never,
    }))
  }
}
