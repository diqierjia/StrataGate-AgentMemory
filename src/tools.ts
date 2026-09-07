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
    name: 'feedback_prepare',
    description: 'Prepare a local StrataGate feedback draft from facts known in the current conversation. Unknown fields must stay empty. Never invent versions, logs, Block counts, or diagnostics, and never submit anything to GitHub. After success, respond briefly that the draft is local and not submitted, then render feedbackUrl as a Markdown link labeled "打开反馈草稿". Do not print the draft fields or an Issue-content table, and do not direct the user through Settings manually.',
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
    description: 'Search durable StrataGate event memories. Returns a compact batch of event cards (id, title, summary, time, and evidence refs); call memory_expand_event for narrative/quotes/source messages. rankScore is BM25/RRF ordering only, never confidence or factual accuracy. Pass batchId to memory_assess before relying on evidence.',
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
    description: 'Search the current Event-backed Knowledge Graph for people, projects, organizations, tools, places, facts, and relations. Returns compact node cards with matchedFields/matchReason; call memory_expand_graph_node for complete facts and edges. rankScore is BM25/RRF ordering only, never confidence or factual accuracy. Results are independently assessable.',
    parameters: {
      query: { type: 'string', required: true },
      limit: { type: 'integer', description: 'Maximum results, 1-20.' },
    },
    output: jsonOutput,
    execute: async (args, exec) => runtime.searchGraph(sessionOf(exec), args.query, args.limit ?? 8) as never,
  }))

  ctx.tools.register(defineTool({
    name: 'memory_expand_graph_node',
    description: 'Expand one Knowledge Graph node with its current facts, directed edges, and supporting Event evidence.',
    parameters: { id: { type: 'string', required: true } },
    output: jsonOutput,
    execute: async (args, exec) => runtime.expandGraphNode(sessionOf(exec), args.id) as never,
  }))

  ctx.tools.register(defineTool({
    name: 'memory_search_elements',
    description: 'Deprecated compatibility search for legacy Element-card data. Returns compact fact hits; rankScore is BM25/RRF ordering only, never confidence or factual accuracy. Prefer memory_search_graph.',
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
    description: 'Search archived messages when summarized memories are insufficient. Returns compact raw hits (message id, blockId, excerpt, role, and time); use memory_expand_block with blockId for complete source details. By default searches the whole current namespace; use scope=session for the active thread. Returns evidence refs and batchId for assessment.',
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
    description: 'List decayed conversation-block summaries and their current detail levels. Defaults to the active session only; use scope=namespace to inspect every thread in the current namespace. The response always reports scope, namespace, threadId, counts, and a machine-readable emptyReason when no blocks match.',
    parameters: {
      scope: { type: 'string', enum: ['session', 'namespace'] as const, description: 'Query range. Defaults to session to preserve existing isolation behavior.' },
    },
    output: jsonOutput,
    execute: async (args, exec) => runtime.blocks(sessionOf(exec), args.scope) as never,
  }))

  ctx.tools.register(defineTool({
    name: 'memory_expand_block',
    description: 'Expand one memory block to a more detailed layer. The result is a new evidence batch and must be assessed.',
    parameters: {
      id: { type: 'string', required: true },
      target: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
    },
    output: jsonOutput,
    execute: async (args, exec) => runtime.expandBlock(sessionOf(exec), args.id, args.target) as never,
  }))

  ctx.tools.register(defineTool({
    name: 'memory_expand_event',
    description: 'Retrieve one complete Event card by id. The result is a new evidence batch and must be assessed.',
    parameters: {
      id: { type: 'string', required: true },
    },
    output: jsonOutput,
    execute: async (args, exec) => runtime.expandEvent(sessionOf(exec), args.id) as never,
  }))

  ctx.tools.register(defineTool({
    name: 'memory_expand_element',
    description: 'Expand an Element card, optionally as it was at an ISO date. The result is a new evidence batch and must be assessed.',
    parameters: {
      id: { type: 'string', required: true },
      at: { type: 'string' },
    },
    output: jsonOutput,
    execute: async (args, exec) => runtime.expandElement(sessionOf(exec), args.id, args.at) as never,
  }))

  ctx.tools.register(defineTool({
    name: 'memory_assess',
    description: 'Apply StrataGate Evidence Gate to a retrieval batch. Pass batch_id from the retrieval result; omitting it remains compatible with sequential flows and selects the latest batch. The response reports every input ref that was not adopted and why.',
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
    description: 'Close one StrataGate retrieval batch. Pass its batch_id and exactly the evidenceRefs from that batch actually used in the answer, or [] when none were used. Non-empty refs require that batch\'s sufficient assessment. The host renders successful selections as answer-tail citations, so do not write a manual citation list. Omitting batch_id selects the latest batch for sequential compatibility.',
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
}
