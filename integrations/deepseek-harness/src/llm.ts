import { AsyncLocalStorage } from 'node:async_hooks'
import type { Context } from '@deepseek-ai/cordis'
import { BlockAssembler, createUserMessage, type ContentBlock, type ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { parameterSchemaSpecToJsonSchema, validateArgs, type ParameterSchemaSpec, type ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import type { Session } from '@deepseek-ai/dsh-session'
import type {
  BlockSummarizer,
  ElementProjectionContext,
  ElementProjectionResult,
  ElementProjector,
  EventCardInput,
  EventExtractor,
  ExtractionContext,
  GraphProjector,
  GraphProjectionContext,
  GraphProjectionResult,
  MemoryCriticality,
  MemoryElementType,
  MemoryScope,
  MemoryBlock,
  SuccessfulModelResponse,
  SuccessfulModelResponseKind,
} from '@diqier/stratagate'
import { nowUtc8 } from '@diqier/stratagate'
import type { ResolvedConfig, StructuredReasoningEffortMode } from './config.js'
import { ModelJsonResponseError, parseJsonResponse } from './json-response.js'
import type {} from '@deepseek-ai/dsh-agent-default-model'

const ELEMENT_TYPES = new Set<MemoryElementType>(['person', 'project', 'organization', 'tool', 'place'])
const SCOPES = new Set<MemoryScope>(['user', 'project', 'session'])
const CRITICALITIES = new Set<MemoryCriticality>(['routine', 'preference', 'identity', 'safety'])

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback
}

function l2Neighbor(block: MemoryBlock | null): Record<string, unknown> | null {
  if (!block) return null
  return {
    blockId: block.id,
    sequence: block.sequence,
    startTurn: block.startTurn,
    endTurn: block.endTurn,
    l2Keypoints: block.l2Keypoints,
  }
}

function extractorPayload(context: ExtractionContext): Record<string, unknown> {
  return {
    target: context.target,
    neighbors: {
      previous: l2Neighbor(context.previous),
      next: l2Neighbor(context.next),
    },
    allowedSourceMessageIds: context.target.l5Raw.map((message) => message.id),
    timeline: context.timeline,
  }
}

const JSON_RESPONSE_ATTEMPTS = 2
const JSON_RETRY_INSTRUCTION = 'Your previous response did not make one valid call to the requested tool. Do not spend output on analysis or reasoning. Immediately call that tool exactly once with complete arguments. Do not return an answer as text or markdown.'
const RETRY_MAX_TOKENS = 10_000
const STRUCTURED_FIELDS = {
  summarizer: ['l0Title', 'l0Tags', 'l1Summary', 'l2Keypoints', 'shouldExtract'],
  extractor: ['shouldExtract', 'reason', 'events'],
  projector: ['reason', 'changes'],
  graphProjector: ['reason', 'nodes', 'edges'],
} as const
const STRING_ARRAY: ValueSchemaSpec = { type: 'array', items: { type: 'string' } }
const OPEN_OBJECT: ValueSchemaSpec = { type: 'object', additionalProperties: true }

const SUMMARIZER_PARAMETERS: ParameterSchemaSpec = {
  l0Title: { type: 'string', required: true },
  l0Tags: { ...STRING_ARRAY, required: true },
  l1Summary: { type: 'string', required: true },
  l2Keypoints: { ...STRING_ARRAY, required: true },
  shouldExtract: { type: 'boolean', required: true },
}

const EVENT_ITEM: ValueSchemaSpec = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string', required: true },
    summary: { type: 'string', required: true },
    narrative: { type: 'string' },
    tags: STRING_ARRAY,
    quotes: STRING_ARRAY,
    sourceMessageIds: { ...STRING_ARRAY, required: true },
    temporal: OPEN_OBJECT,
    scope: { type: 'string', enum: ['user', 'project', 'session'] },
    criticality: { type: 'string', enum: ['routine', 'preference', 'identity', 'safety'] },
    confidence: { type: 'number' },
  },
}

const EXTRACTOR_PARAMETERS: ParameterSchemaSpec = {
  shouldExtract: { type: 'boolean', required: true },
  reason: { type: 'string', required: true },
  events: { type: 'array', items: EVENT_ITEM, required: true },
}

const VALUE: ValueSchemaSpec = {
  oneOf: [
    { type: 'string' },
    { type: 'array', items: { type: 'string' } },
  ],
}

const ELEMENT_CHANGE: ValueSchemaSpec = {
    type: 'object',
  additionalProperties: false,
  properties: {
    element: {
      type: 'object',
      additionalProperties: false,
      required: true,
      properties: {
        name: { type: 'string', required: true },
        type: { type: 'string', enum: ['person', 'project', 'organization', 'tool', 'place'], required: true },
        aliases: STRING_ARRAY,
      },
    },
    operation: { type: 'string', enum: ['set_state', 'add_set_item', 'set_relation'], required: true },
    key: { type: 'string' },
    mode: { type: 'string', enum: ['state', 'set', 'relation'], required: true },
    value: { ...VALUE, required: true },
    validFrom: { type: 'string' },
    validTo: { type: 'string' },
    sourceEventIds: { ...STRING_ARRAY, required: true },
    confidence: { type: 'number' },
  },
}

const PROJECTOR_PARAMETERS: ParameterSchemaSpec = {
  reason: { type: 'string', required: true },
  changes: { type: 'array', items: ELEMENT_CHANGE, required: true },
}

const GRAPH_FACT: ValueSchemaSpec = {
  type: 'object', additionalProperties: false,
  properties: { key: { type: 'string', required: true }, value: { ...VALUE, required: true }, sourceEventIds: { ...STRING_ARRAY, required: true } },
}

const GRAPH_NODE: ValueSchemaSpec = {
  type: 'object', additionalProperties: false,
  properties: {
    ref: { type: 'string', required: true }, name: { type: 'string', required: true },
    type: { type: 'string', enum: ['person', 'project', 'organization', 'tool', 'place'], required: true },
    aliases: STRING_ARRAY, tags: { ...STRING_ARRAY, required: true }, state: { type: 'string' }, facts: { type: 'array', items: GRAPH_FACT },
    status: { type: 'string', enum: ['active', 'superseded', 'disputed', 'archived'] },
    validFrom: { type: 'string' }, validTo: { type: 'string' }, confidence: { type: 'number' },
    sourceEventIds: { ...STRING_ARRAY, required: true },
  },
}

const GRAPH_EDGE: ValueSchemaSpec = {
  type: 'object', additionalProperties: false,
  properties: {
    fromRef: { type: 'string', required: true }, toRef: { type: 'string', required: true },
    relation: { type: 'string', required: true },
    status: { type: 'string', enum: ['active', 'superseded', 'disputed', 'archived'] },
    validFrom: { type: 'string' }, validTo: { type: 'string' }, confidence: { type: 'number' },
    sourceEventIds: { ...STRING_ARRAY, required: true },
  },
}

const GRAPH_PROJECTOR_PARAMETERS: ParameterSchemaSpec = {
  reason: { type: 'string', required: true },
  nodes: { type: 'array', items: GRAPH_NODE, required: true },
  edges: { type: 'array', items: GRAPH_EDGE, required: true },
}

const STRUCTURED_TOOLS = {
  summarizer: {
    name: 'stratagate_summarize_block',
    description: 'Submit the completed durable summary for the supplied conversation block.',
    parameters: SUMMARIZER_PARAMETERS,
  },
  extractor: {
    name: 'stratagate_extract_event_cards',
    description: 'Submit durable, evidence-backed event cards from the target block only.',
    parameters: EXTRACTOR_PARAMETERS,
  },
  projector: {
    name: 'stratagate_project_element_cards',
    description: 'Submit element-card changes supported by the supplied event cards.',
    parameters: PROJECTOR_PARAMETERS,
  },
  graphProjector: {
    name: 'stratagate_project_knowledge_graph',
    description: 'Project stable graph nodes and directed edges from supplied event evidence.',
    parameters: GRAPH_PROJECTOR_PARAMETERS,
  },
} as const

type StructuredToolKind = keyof typeof STRUCTURED_TOOLS

interface ForcedToolChoice {
  type: 'function'
  function: { name: string }
}

interface StructuredModelRequest {
  tool_choice: ForcedToolChoice
}

function toolSchema(kind: StructuredToolKind): Record<string, unknown> {
  return parameterSchemaSpecToJsonSchema(STRUCTURED_TOOLS[kind].parameters) as unknown as Record<string, unknown>
}

function renderBlockForDiagnostics(block: ContentBlock): string {
  if (block.type === 'text' || block.type === 'reasoning') return `${block.type}: ${block.text}`
  if (block.type === 'tool-call') return `tool-call ${block.name}: ${block.arguments}`
  return `${block.type}: ${JSON.stringify(block)}`
}

function renderBlocksForDiagnostics(blocks: readonly ContentBlock[], finish: string): string {
  const rendered = blocks.map(renderBlockForDiagnostics).join('\n\n')
  return rendered || `[no model blocks; finish=${finish}]`
}

export class DshModelBridge {
  private readonly sessions = new AsyncLocalStorage<Session>()
  private readonly successfulResponses: SuccessfulModelResponse[] = []
  private structuredEffort: StructuredReasoningEffortMode

  constructor(private readonly ctx: Context, private readonly config: ResolvedConfig) {
    this.structuredEffort = config.structuredReasoningEffort ?? 'auto'
  }

  /**
   * Update the structured-call reasoning-effort policy at runtime, pushed by
   * the settings section (`stratagate-memory` namespace) when the user edits
   * `structuredReasoningEffort`. The next structured call reads the new mode.
   * @param mode - the new policy mode.
   */
  setStructuredReasoningEffort(mode: StructuredReasoningEffortMode): void {
    this.structuredEffort = mode
  }

  run<T>(session: Session, operation: () => Promise<T>): Promise<T> {
    return this.sessions.run(session, operation)
  }

  takeSuccessfulResponses(): SuccessfulModelResponse[] {
    const responses = this.successfulResponses.splice(0, this.successfulResponses.length)
    return responses
  }

  readonly summarizer: BlockSummarizer = async (messages) => {
    const raw = object(await this.callStructured('summarizer',
      `You compress agent conversations into durable memory blocks. Read the supplied messages and call ${STRUCTURED_TOOLS.summarizer.name} exactly once with l0Title, l0Tags, l1Summary, l2Keypoints, and shouldExtract. Preserve decisions, constraints, preferences, outcomes, and unresolved work. shouldExtract is true only when durable events or facts exist. Do not return the summary as text.`,
      { messages },
    ))
    return {
      l0Title: text(raw.l0Title, 'Conversation block').slice(0, 120),
      l0Tags: strings(raw.l0Tags).slice(0, 12),
      l1Summary: text(raw.l1Summary).slice(0, 2_000),
      l2Keypoints: strings(raw.l2Keypoints).slice(0, 20),
      shouldExtract: raw.shouldExtract === true,
    }
  }

  readonly extractor: EventExtractor = async (context: ExtractionContext) => {
    const validMessageIds = new Set(context.target.l5Raw.map((message) => message.id))
    const raw = object(await this.callStructured('extractor',
      `Extract only durable, evidence-backed events from target.l5Raw, then call ${STRUCTURED_TOOLS.extractor.name} exactly once. The target block is the only legal source of new facts, quotations, and sourceMessageIds. neighbors.previous and neighbors.next are context-only L2 summaries; never extract from them. Every sourceMessageIds entry must exactly match allowedSourceMessageIds. If a fact appears only in a neighbor, do not extract it in this call. Events must be understandable later without the original chat. Use project scope for repository decisions, user scope for stable preferences/identity, and session scope for temporary task state. temporal.eventType must use exactly one stable value: decision, release, task_completed, plan, change, cancellation, incident, meeting, collaboration, migration, or other. temporal.participants contains canonical entity names. Use ISO-8601 timestamps with the explicit +08:00 offset in temporal fields. Keep happened time separate from mentionedAt; when happened time is unknown omit it and set precision/basis to unknown. Do not turn an assistant statement that merely recalls older memory into a new event; require new human input or a new observable task/tool outcome from target.l5Raw. Do not return the result as text.`,
      extractorPayload(context),
    ))
    const events = (Array.isArray(raw.events) ? raw.events : []).map((candidate): EventCardInput | null => {
      const item = object(candidate)
      const sourceMessageIds = strings(item.sourceMessageIds).filter((id) => validMessageIds.has(id))
      const scope = SCOPES.has(item.scope as MemoryScope) ? item.scope as MemoryScope : 'project'
      const criticality = CRITICALITIES.has(item.criticality as MemoryCriticality)
        ? item.criticality as MemoryCriticality
        : 'routine'
      if (!text(item.title) || !text(item.summary) || sourceMessageIds.length === 0) return null
      return {
        title: text(item.title).slice(0, 200),
        summary: text(item.summary).slice(0, 1_000),
        narrative: text(item.narrative),
        tags: strings(item.tags).slice(0, 16),
        quotes: strings(item.quotes).slice(0, 12),
        sourceMessageIds,
        sourceBlockId: context.target.id,
        temporal: object(item.temporal),
        scope,
        criticality,
        confidence: typeof item.confidence === 'number' ? item.confidence : 0.8,
      }
    }).filter((event): event is EventCardInput => event !== null)
    return {
      shouldExtract: raw.shouldExtract === true,
      reason: text(raw.reason, events.length ? 'Durable evidence extracted.' : 'No durable evidence.'),
      events,
    }
  }

  readonly projector: ElementProjector = async (context: ElementProjectionContext): Promise<ElementProjectionResult> => {
    const eventIds = new Set(context.events.map((event) => event.id))
    const raw = object(await this.callStructured('projector',
      `Use only the supplied event ids and never create unsupported facts. If events contain clear entities (people, projects, tools, orgs), include changes for them. Call ${STRUCTURED_TOOLS.projector.name} exactly once with the projected changes. Do not return the result as text.`,
      context,
    ))
    const changes = (Array.isArray(raw.changes) ? raw.changes : []).flatMap((candidate) => {
      const item = object(candidate)
      const element = object(item.element)
      const type = element.type as MemoryElementType
      const sourceEventIds = strings(item.sourceEventIds).filter((id) => eventIds.has(id))
      const operation = item.operation
      const mode = item.mode
      const value = item.value
      if (!text(element.name) || !ELEMENT_TYPES.has(type) || sourceEventIds.length === 0) return []
      if (!['set_state', 'add_set_item', 'set_relation'].includes(String(operation))) return []
      if (!['state', 'set', 'relation'].includes(String(mode))) return []
      if (!(typeof value === 'string' || (Array.isArray(value) && value.every((entry) => typeof entry === 'string')))) return []
      return [{
        element: { name: text(element.name), type, aliases: strings(element.aliases) },
        operation: operation as 'set_state' | 'add_set_item' | 'set_relation',
        key: text(item.key, 'state'),
        mode: mode as 'state' | 'set' | 'relation',
        value,
        ...(text(item.validFrom) ? { validFrom: text(item.validFrom) } : {}),
        ...(text(item.validTo) ? { validTo: text(item.validTo) } : {}),
        sourceEventIds,
        ...(typeof item.confidence === 'number' ? { confidence: item.confidence } : {}),
      }]
    })
    return { reason: text(raw.reason, 'Projected event evidence.'), changes }
  }

  readonly graphProjector: GraphProjector = async (context: GraphProjectionContext): Promise<GraphProjectionResult> => {
    const eventIds = new Set(context.events.map((event) => event.id))
    const raw = object(await this.callStructured('graphProjector',
      `Project the supplied Events into the current Knowledge Graph, then call ${STRUCTURED_TOOLS.graphProjector.name} exactly once. Events are the sole source of truth; never use legacy Element data. Return stable entity nodes for people, projects, organizations, tools, and places. Use aliases to merge spelling/case/separator variants. Give every returned node 1-6 concise semantic role tags such as benchmark, evaluation, memory-plugin, parser, or development-tool; tags describe the node's specific role and never replace its person/project/organization/tool/place type. Reuse stable tag wording when possible. Put attributes in node facts and every relationship in a directed edge using fromRef/toRef—never encode a relationship as a fact string. Prefer concise canonical Chinese relation labels such as 使用、属于、创建、参与、贡献、依赖、位于、相关. Every node, fact, and edge must cite only supplied Event ids. Do not return text.`,
      context,
    ))
    const nodes = (Array.isArray(raw.nodes) ? raw.nodes : []).flatMap((candidate) => {
      const item = object(candidate)
      const sourceEventIds = strings(item.sourceEventIds).filter((id) => eventIds.has(id))
      const type = item.type as MemoryElementType
      if (!text(item.ref) || !text(item.name) || !ELEMENT_TYPES.has(type) || sourceEventIds.length === 0) return []
      const facts = (Array.isArray(item.facts) ? item.facts : []).flatMap((candidateFact) => {
        const fact = object(candidateFact)
        const value = fact.value
        if (!text(fact.key) || !(typeof value === 'string' || (Array.isArray(value) && value.every((entry) => typeof entry === 'string')))) return []
        const sourceEventIds = strings(fact.sourceEventIds).filter((id) => eventIds.has(id))
        if (sourceEventIds.length === 0) return []
        return [{ key: text(fact.key), value, sourceEventIds }]
      })
      return [{
        ref: text(item.ref), name: text(item.name), type, aliases: strings(item.aliases), tags: strings(item.tags).slice(0, 12),
        ...(text(item.state) ? { state: text(item.state) } : {}), facts,
        ...(typeof item.status === 'string' ? { status: item.status as 'active' } : {}),
        ...(text(item.validFrom) ? { validFrom: text(item.validFrom) } : {}),
        ...(text(item.validTo) ? { validTo: text(item.validTo) } : {}),
        ...(typeof item.confidence === 'number' ? { confidence: item.confidence } : {}), sourceEventIds,
      }]
    })
    const refs = new Set(nodes.map(({ ref }) => ref))
    const edges = (Array.isArray(raw.edges) ? raw.edges : []).flatMap((candidate) => {
      const item = object(candidate)
      const sourceEventIds = strings(item.sourceEventIds).filter((id) => eventIds.has(id))
      const fromRef = text(item.fromRef); const toRef = text(item.toRef); const relation = text(item.relation)
      if (!refs.has(fromRef) || !refs.has(toRef) || !relation || sourceEventIds.length === 0) return []
      return [{
        fromRef, toRef, relation,
        ...(typeof item.status === 'string' ? { status: item.status as 'active' } : {}),
        ...(text(item.validFrom) ? { validFrom: text(item.validFrom) } : {}),
        ...(text(item.validTo) ? { validTo: text(item.validTo) } : {}),
        ...(typeof item.confidence === 'number' ? { confidence: item.confidence } : {}), sourceEventIds,
      }]
    })
    return { reason: text(raw.reason, 'Projected Event evidence into the Knowledge Graph.'), nodes, edges }
  }

  private async callStructured(kind: SuccessfulModelResponseKind, system: string, payload: unknown): Promise<unknown> {
    const session = this.sessions.getStore()
    if (!session) throw new Error('StrataGate model callback ran without a DSH session')
    // Structured memory jobs need a bounded machine-readable response. The
    // host adapters currently do not expose a provider-neutral tool_choice,
    // so reasoning preference is delegated to the configured
    // structuredReasoningEffort mode (auto probes the model's advertised
    // efforts; force-off requires "off" and raises a notification otherwise).
    const route = await this.resolveRoute(session, true)
    let lastError: ModelJsonResponseError | undefined
    let lastResponse = ''
    let retryMaxTokens = this.config.maxOutputTokens
    for (let attempt = 1; attempt <= JSON_RESPONSE_ATTEMPTS; attempt += 1) {
      const message = createUserMessage({
        content: [{ type: 'text', text: JSON.stringify(payload) }],
        source: { kind: 'plugin', plugin: 'stratagate-memory' },
      })
      const assembler = new BlockAssembler()
      const request: Parameters<typeof this.ctx.llm.stream>[0] & StructuredModelRequest = {
        ...route,
        messages: [message],
        system: attempt === 1 ? system : `${system}\n\n${JSON_RETRY_INSTRUCTION}`,
        tools: [{
          name: STRUCTURED_TOOLS[kind].name,
          description: STRUCTURED_TOOLS[kind].description,
          parameters: toolSchema(kind),
        }],
        tool_choice: {
          type: 'function',
          function: { name: STRUCTURED_TOOLS[kind].name },
        },
        maxTokens: retryMaxTokens,
        sessionId: session.id,
        purpose: 'compaction',
      }
      for await (const chunk of this.ctx.llm.stream(request)) assembler.push(chunk)
      const finish = assembler.finish
      if (finish.kind === 'error' || finish.kind === 'aborted') {
        throw new Error(`StrataGate model call failed: ${finish.failure.message}`)
      }
      const blocks = assembler.blocks()
      const calls = blocks.filter((block): block is Extract<ContentBlock, { type: 'tool-call' }> => block.type === 'tool-call')
      const responseForError = `${renderBlocksForDiagnostics(blocks, finish.kind)}\n[finish=${finish.kind}; toolCalls=${calls.length}]`
      lastResponse = responseForError
      try {
        const expectedTool = STRUCTURED_TOOLS[kind].name
        let parsed: unknown
        if (calls.length !== 1 || calls[0]?.name !== expectedTool) {
          const textFallback = blocks
            .filter((block): block is Extract<ContentBlock, { type: 'text' | 'reasoning' }> => block.type === 'text' || block.type === 'reasoning')
            .map((block) => block.text)
            .join('\n')
          try {
            parsed = parseJsonResponse(textFallback, STRUCTURED_FIELDS[kind])
          } catch {
            throw new ModelJsonResponseError(
              `StrataGate model response did not call ${expectedTool} exactly once`,
              { response: responseForError },
            )
          }
        } else {
          try {
            parsed = JSON.parse(calls[0].arguments)
          } catch {
            throw new ModelJsonResponseError(
              `StrataGate ${expectedTool} arguments were not valid JSON`,
              { response: responseForError },
            )
          }
        }
        const violations = validateArgs(STRUCTURED_TOOLS[kind].parameters, parsed)
        if (violations.length > 0) {
          throw new ModelJsonResponseError(
            `StrataGate ${expectedTool} arguments were invalid: ${violations.join('; ')}`,
            { response: responseForError },
          )
        }
        this.successfulResponses.push({
          id: `model_response_${crypto.randomUUID()}`,
          kind,
          response: responseForError,
          createdAt: nowUtc8(),
        })
        if (this.successfulResponses.length > 5) this.successfulResponses.shift()
        return parsed
      } catch (error) {
        if (!(error instanceof ModelJsonResponseError)) throw error
        lastError = finish.kind === 'max-tokens'
          ? new ModelJsonResponseError(
            `StrataGate ${STRUCTURED_TOOLS[kind].name} call was truncated before valid arguments`,
            { cause: error, response: responseForError },
          )
          : error
        if (finish.kind === 'max-tokens') retryMaxTokens = Math.max(this.config.maxOutputTokens, RETRY_MAX_TOKENS)
        if (attempt < JSON_RESPONSE_ATTEMPTS) {
          this.ctx.logger.warn(`stratagate-memory model returned an invalid structured tool call; retrying (${attempt}/${JSON_RESPONSE_ATTEMPTS})`)
        }
      }
    }
    throw new ModelJsonResponseError(
      `StrataGate model did not produce a valid ${STRUCTURED_TOOLS[kind].name} call after ${JSON_RESPONSE_ATTEMPTS} attempts`,
      { cause: lastError, response: lastResponse },
    )
  }

  /**
   * Resolve the provider/model route for one LLM call.
   *
   * For non-structured calls the session's requested effort (or the model
   * default) is preserved. For structured memory-processing calls the
   * `structuredReasoningEffort` config selects the behavior:
   * - `auto`: probe the exact model's advertised reasoning efforts and use
   *   `off` only when supported; otherwise omit the effort so the adapter's
   *   default (or the provider default) applies.
   * - `force-off`: always request `off`. When the model does not advertise it,
   *   fall back to the model default with a warning instead of throwing, so one
   *   unsupported provider can never trigger an ingestion-failure storm.
   */
  private async resolveRoute(session: Session, structured = false): Promise<{ provider: string; model: string; reasoningEffort?: ReasoningEffortId }> {
    const request = session.requestHeader()?.config
    const requestedReasoningEffort = request?.reasoningEffort
    const withReasoningEffort = (route: { provider: string; model: string }): { provider: string; model: string; reasoningEffort?: ReasoningEffortId } => ({
      ...route,
      ...(structured ? {} : requestedReasoningEffort !== undefined ? { reasoningEffort: requestedReasoningEffort } : {}),
    })
    if (this.config.provider && this.config.model) {
      return this.applyStructuredEffort(withReasoningEffort({ provider: this.config.provider, model: this.config.model }), structured)
    }
    if (request) return this.applyStructuredEffort(withReasoningEffort({ provider: request.provider, model: request.model }), structured)
    const fallback = this.ctx.agentDefaultModel.currentSelection()
    return this.applyStructuredEffort({
      provider: fallback.provider,
      model: fallback.model,
      ...(fallback.reasoningEffort !== undefined ? { reasoningEffort: fallback.reasoningEffort as ReasoningEffortId } : {}),
    }, structured)
  }

  /** Apply the configured structured-effort policy to a resolved route. */
  private async applyStructuredEffort(route: { provider: string; model: string; reasoningEffort?: ReasoningEffortId }, structured: boolean): Promise<{ provider: string; model: string; reasoningEffort?: ReasoningEffortId }> {
    if (!structured) return route
    if (this.structuredEffort !== 'force-off') {
      const supportsOff = await this.modelSupportsReasoningEffort(route.provider, route.model, 'off')
      if (supportsOff) return { ...route, reasoningEffort: 'off' as ReasoningEffortId }
      return route
    }
    const supportsOff = await this.modelSupportsReasoningEffort(route.provider, route.model, 'off')
    if (supportsOff) return { ...route, reasoningEffort: 'off' as ReasoningEffortId }
    this.ctx.logger.warn(`stratagate-memory force-off requested but provider "${route.provider}" model "${route.model}" does not support reasoning effort "off"; falling back to the model default`)
    return route
  }

  /** Probe one exact model's advertised reasoning efforts through the DSH LLM service. */
  private async modelSupportsReasoningEffort(provider: string, model: string, effortId: string): Promise<boolean> {
    try {
      const info = await this.ctx.llm.resolveModelInfo(provider, model)
      const efforts = info.reasoning?.efforts ?? []
      return efforts.some((effort) => effort.id === effortId)
    } catch {
      // Capability lookup is best-effort; if it fails, assume support so the
      // request itself decides (a real rejection surfaces as a normal call error).
      return true
    }
  }
}
