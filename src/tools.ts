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
    description: `This tool is provided by the StrataGate plugin. Update exactly one field of the user's global Persistent Profile. Persistent Profile data is injected into every future conversation without retrieval, so use this tool only for information that should remain continuously available or continuously affect future behavior, such as how to address the user, what the user wants the assistant to be called, language preferences, stable response preferences, standing instructions, stable user background, long-term goals, or other genuinely persistent notes.

preferredLanguage sets only the default language of the final/user-facing answer. reasoningLanguage sets only the desired language of reasoning/thinking text visible to the user in the DSH or host UI, when supported; it cannot control hidden internal chain-of-thought. An empty reasoningLanguage adds no visible-reasoning language requirement. These are independent settings: never infer one from the other, and never change one merely because the other changed.

Examples:
User: “以后都用中文回答我” → call memory_profile_update with preferredLanguage = 中文; do not change reasoningLanguage.
User: “以后思考过程用中文” or “思考链用中文” → call memory_profile_update with reasoningLanguage = 中文; do not change preferredLanguage.
User: “以后回答和思考过程都用中文” → make two separate memory_profile_update calls: first preferredLanguage = 中文, then reasoningLanguage = 中文. Each call still changes exactly one field.

Do not use this tool merely because the user says "remember". If the information describes something that happened, a decision, an activity, a project change, a dated fact, or something that only needs to be recalled when relevant, it belongs in Event memory instead. A separate Event-memory tool is reserved for that purpose and is not part of this implementation.

When the user explicitly asks to make a persistent change, that request is already authorization and the tool may be called immediately.

If the assistant only infers that something might be a useful persistent preference or profile fact, it must not update the profile immediately. It must first tell the user exactly which field it proposes to change and what the new value would be, and ask the user to reply exactly "同意". Only a directly subsequent "同意" authorizes that single proposed change. If the user refuses, does not reply "同意", changes the subject, or proposes a different change, do not perform the update.

Each call changes exactly one predefined Profile field. Never create, delete, or rename Profile fields, and never rewrite the complete Profile when only one field is being changed.`,
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
    name: 'memory_search_events',
    description: 'This tool is provided by the StrataGate plugin. Search durable StrataGate event memories. Returns a compact batch of event cards (id, title, summary, time, and evidence refs); call memory_expand_event for narrative/quotes/source messages. rankScore is BM25/RRF ordering only, never confidence or factual accuracy. Pass batchId to memory_assess before relying on evidence.',
    parameters: {
      query: { type: 'string', required: true, description: 'What historical decision, event, preference, or outcome to find.' },
      limit: { type: 'integer', description: 'Maximum results, 1-20.' },
      temporalIntent: { type: 'string', enum: ['first', 'latest'] as const },
      eventType: { type: 'string' },
      participants: { type: 'array', items: { type: 'string' } },
    },
    output: jsonOutput,
    execute: async (args, exec) => runtime.searchEvents(sessionOf(exec), args.query, {
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
      description: 'This tool is provided by the StrataGate plugin. Record one memorable fact as a durable long-term StrataGate memory: explicit user preferences or corrections, decisions the user makes, durable project facts, or anything the user asks you to remember. StrataGate checks existing memory first — exact or near duplicates reinforce the existing card instead of writing, related facts may be merged, supersede an outdated card, or be conflict-marked; the result reports the action. Recorded facts are ordinary Events: they participate in the knowledge graph, persist across sessions, are retrievable with memory_search_events, decay and reinforce through the normal lifecycle. Keep each call to one self-contained sentence; never record secrets, credentials, or transient task state.',
      parameters: {
        content: { type: 'string', required: true, description: 'The fact to remember, stated as one self-contained sentence.' },
        category: { type: 'string', enum: ['preference', 'decision', 'correction', 'fact'] as const },
      },
      output: jsonOutput,
      execute: async (args, exec) => runtime.recordAgentMemory(sessionOf(exec), args.content, args.category) as never,
    }))
  }
}
