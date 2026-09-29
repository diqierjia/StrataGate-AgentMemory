import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { resolveConfig } from './config.js'
import { blockTarget, WorkBuddyRuntime } from './runtime.js'
import { loadStarWidgetHtml, STAR_WIDGET_MIME, STAR_WIDGET_URI } from './star-widget.js'

const config = resolveConfig()
const runtime = new WorkBuddyRuntime(config)
const server = new McpServer({
  name: 'stratagate-workbuddy',
  version: '0.1.0',
})

function response(value: unknown, meta?: Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    ...(value && typeof value === 'object' && !Array.isArray(value) ? { structuredContent: value as Record<string, unknown> } : {}),
    ...(meta ? { _meta: meta } : {}),
  }
}

function failure(error: unknown) {
  return {
    content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }],
    isError: true,
  }
}

async function safe(operation: () => Promise<unknown>) {
  try {
    return response(await operation())
  } catch (error) {
    return failure(error)
  }
}

const session = z.string().min(1).max(200).optional().describe('WorkBuddy session id; omit to use the current host session')

server.registerResource('stratagate-star-prompt', STAR_WIDGET_URI, {
  title: 'Support StrataGate',
  description: 'A one-time invitation shown after StrataGate has demonstrably helped with three answers.',
  mimeType: STAR_WIDGET_MIME,
  _meta: {
    ui: {
      csp: {
        resourceDomains: [],
        connectDomains: [],
      },
      permissions: {},
      prefersBorder: true,
    },
  },
}, async () => ({
  contents: [{
    uri: STAR_WIDGET_URI,
    mimeType: STAR_WIDGET_MIME,
    text: loadStarWidgetHtml(),
    _meta: {
      ui: {
        csp: {
          resourceDomains: [],
          connectDomains: [],
        },
        permissions: {},
        prefersBorder: true,
      },
    },
  }],
}))

server.registerTool('memory_search_events', {
  title: 'Search StrataGate events',
  description: 'Search source-traceable historical decisions, outcomes, plans, corrections, and time-based events. Results are compact by default; use memory_expand_event for the full summary, quotes, and source messages. rankScore is BM25/RRF ordering only, not confidence or factual accuracy. Results must be assessed before use.',
  inputSchema: {
    query: z.string().min(1).max(2_000),
    session_id: session,
    limit: z.number().int().min(1).max(20).optional(),
    temporal_intent: z.enum(['first', 'latest']).optional(),
    participants: z.array(z.string()).max(12).optional(),
    event_type: z.string().max(100).optional(),
    happened_from: z.string().optional(),
    happened_to: z.string().optional(),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
}, (args) => safe(() => runtime.searchEvents(args.query, args.session_id, {
  ...(args.limit !== undefined ? { limit: args.limit } : {}),
  ...(args.temporal_intent !== undefined ? { temporalIntent: args.temporal_intent } : {}),
  ...(args.participants !== undefined ? { participants: args.participants } : {}),
  ...(args.event_type !== undefined ? { eventType: args.event_type } : {}),
  ...(args.happened_from !== undefined ? { happenedFrom: args.happened_from } : {}),
  ...(args.happened_to !== undefined ? { happenedTo: args.happened_to } : {}),
})))

server.registerTool('memory_search_elements', {
  title: 'Search StrataGate current state',
  description: 'Search current source-backed facts about people, projects, organizations, tools, or places. Results must be assessed before use.',
  inputSchema: {
    query: z.string().min(1).max(2_000),
    session_id: session,
    limit: z.number().int().min(1).max(12).optional(),
    name: z.string().max(200).optional(),
    element_type: z.enum(['person', 'project', 'organization', 'tool', 'place']).optional(),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
}, (args) => safe(() => runtime.searchElements(args.query, args.session_id, {
  ...(args.limit !== undefined ? { limit: args.limit } : {}),
  ...(args.name !== undefined ? { name: args.name } : {}),
  ...(args.element_type !== undefined ? { type: args.element_type } : {}),
})))

server.registerTool('memory_search_raw', {
  title: 'Search raw StrataGate memory',
  description: 'Search recent or archived L5 source messages when derived memory is missing exact wording, dates, constraints, or tool results. Results include a bounded excerpt and blockId; expand the block for complete source details. Defaults to the whole current namespace; use scope=session for the active thread.',
  inputSchema: {
    query: z.string().min(1).max(2_000),
    session_id: session,
    limit: z.number().int().min(1).max(20).optional(),
    scope: z.enum(['session', 'namespace']).default('namespace'),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
}, (args) => safe(() => runtime.searchRaw(args.query, args.session_id, args.limit, args.scope)))

server.registerTool('memory_get_blocks', {
  title: 'List StrataGate memory blocks',
  description: 'List decayed L0-L5 block views. Defaults to the active session; use scope=namespace to inspect all threads in the current namespace. The response includes scope, namespace, threadId, counts, and a machine-readable emptyReason when no block matches.',
  inputSchema: {
    session_id: session,
    scope: z.enum(['session', 'namespace']).default('session'),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
}, (args) => safe(() => runtime.getBlocks(args.session_id, args.scope)))

server.registerTool('memory_expand_event', {
  title: 'Expand a StrataGate event',
  description: 'Expand one event card. The result is a new evidence batch and must be assessed before use.',
  inputSchema: {
    batch_id: z.string().startsWith('batch_'),
    event_id: z.string().min(1).max(200),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
}, (args) => safe(() => runtime.expandEvent(args.batch_id, args.event_id)))

server.registerTool('memory_expand_element', {
  title: 'Expand a StrataGate element',
  description: 'Expand one element card, optionally as of an ISO date. The result is a new evidence batch and must be assessed before use.',
  inputSchema: {
    batch_id: z.string().startsWith('batch_'),
    element_id: z.string().min(1).max(200),
    at: z.string().optional(),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
}, (args) => safe(() => runtime.expandElement(args.batch_id, args.element_id, args.at)))

server.registerTool('memory_expand_block', {
  title: 'Expand a StrataGate block',
  description: 'Expand a memory block toward L5. The result is a new evidence batch and must be assessed before use.',
  inputSchema: {
    batch_id: z.string().startsWith('batch_'),
    block_id: z.string().min(1).max(200),
    target: z.union([z.number().int().min(0).max(5), z.enum(['next', 'raw'])]).optional(),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
}, (args) => safe(() => runtime.expandBlock(args.batch_id, args.block_id, blockTarget(args.target))))

server.registerTool('memory_assess', {
  title: 'Assess StrataGate evidence',
  description: 'Apply the evidence gate to exactly one retrieval batch. A sufficient verdict requires at least one ref from that batch and next_strategy=answer.',
  inputSchema: {
    batch_id: z.string().startsWith('batch_'),
    verdict: z.enum(['sufficient', 'partial', 'wrong']),
    evidence_refs: z.array(z.string()).max(8),
    fit: z.string().max(160),
    missing: z.string().max(160),
    next_strategy: z.enum(['answer', 'search_events', 'expand_event', 'search_elements', 'expand_element', 'search_raw_memory', 'expand_block']),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
}, (args) => safe(() => runtime.assess(args.batch_id, args)))

server.registerTool('memory_record_use', {
  title: 'Record adopted StrataGate evidence',
  description: 'Record exactly once that a sufficient assessment was actually used in the answer. Search hits alone are never reinforced.',
  inputSchema: { assessment_id: z.string().startsWith('assessment_') },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  _meta: { ui: { resourceUri: STAR_WIDGET_URI } },
}, async (args) => {
  try {
    const result = await runtime.recordUse(args.assessment_id)
    return response(result, result.starPrompt ? { ui: { resourceUri: STAR_WIDGET_URI } } : undefined)
  } catch (error) {
    return failure(error)
  }
})

server.registerTool('memory_status', {
  title: 'Check StrataGate status',
  description: 'Show the active project namespace, local database, processing mode, queue counts, and memory counts.',
  inputSchema: {},
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
}, () => safe(() => runtime.status()))

let workerRunning = false
let workerFailures = 0
let nextWorkerAttempt = 0
async function work(): Promise<void> {
  if (workerRunning || Date.now() < nextWorkerAttempt) return
  workerRunning = true
  try {
    await runtime.processPending()
    workerFailures = 0
    nextWorkerAttempt = 0
  } catch (error) {
    workerFailures += 1
    const retryMs = Math.min(5 * 60_000, 15_000 * (2 ** Math.min(workerFailures - 1, 5)))
    nextWorkerAttempt = Date.now() + retryMs
    process.stderr.write(`[stratagate-workbuddy] background processing failed: ${error instanceof Error ? error.message : String(error)}\n`)
  } finally {
    workerRunning = false
  }
}

const worker = setInterval(() => { void work() }, config.workerIntervalMs)
worker.unref()
void work()

async function main(): Promise<void> {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

void main().catch((error) => {
  process.stderr.write(`[stratagate-workbuddy] MCP server failed: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
