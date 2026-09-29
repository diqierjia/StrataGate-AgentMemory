import { spawn } from 'node:child_process'
import type {
  BlockSummarizer,
  ElementProjectionContext,
  ElementProjectionResult,
  ElementProjector,
  EventCardInput,
  EventExtractor,
  ExtractionContext,
  MemoryCriticality,
  MemoryElementType,
  MemoryScope,
  MemoryBlock,
  RawMessage,
} from '@diqier/stratagate'
import { buildMemoryDerivationMessages } from '@diqier/stratagate'
import type { ModelConfig, WorkBuddyModelConfig } from './config.js'

const ELEMENT_TYPES = new Set<MemoryElementType>(['person', 'project', 'organization', 'tool', 'place'])
const SCOPES = new Set<MemoryScope>(['user', 'project', 'session'])
const CRITICALITIES = new Set<MemoryCriticality>(['routine', 'preference', 'identity', 'safety'])

const SUMMARY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    l0Title: { type: 'string' },
    l0Tags: { type: 'array', items: { type: 'string' } },
    l1Summary: { type: 'string' },
    l2Keypoints: { type: 'array', items: { type: 'string' } },
    shouldExtract: { type: 'boolean' },
  },
  required: ['l0Title', 'l0Tags', 'l1Summary', 'l2Keypoints', 'shouldExtract'],
} as const

const EXTRACTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    shouldExtract: { type: 'boolean' },
    reason: { type: 'string' },
    events: { type: 'array', items: { type: 'object' } },
  },
  required: ['shouldExtract', 'reason', 'events'],
} as const

const ELEMENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    reason: { type: 'string' },
    changes: { type: 'array', items: { type: 'object' } },
  },
  required: ['reason', 'changes'],
} as const

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
    target: {
      blockId: context.target.id,
      sequence: context.target.sequence,
      startTurn: context.target.startTurn,
      endTurn: context.target.endTurn,
      createdAt: context.target.createdAt,
      messages: buildMemoryDerivationMessages(context.target.l5Raw),
    },
    neighbors: {
      previous: l2Neighbor(context.previous),
      next: l2Neighbor(context.next),
    },
    allowedSourceMessageIds: context.target.l5Raw.map((message) => message.id),
    timeline: context.timeline,
  }
}

function parseJsonResponse(value: string): unknown {
  const cleaned = value.trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '')
  try {
    return JSON.parse(cleaned)
  } catch {
    const start = cleaned.indexOf('{')
    const end = cleaned.lastIndexOf('}')
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1))
    throw new Error('StrataGate model response was not valid JSON')
  }
}

function completionUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/u, '')
  return normalized.endsWith('/chat/completions') ? normalized : `${normalized}/chat/completions`
}

export function fallbackSummarizer(messages: readonly RawMessage[]): Awaited<ReturnType<BlockSummarizer>> {
  const natural = messages.filter((message) => message.role === 'user' || message.role === 'assistant')
  const firstUser = natural.find((message) => message.role === 'user')
  return {
    l0Title: (firstUser?.content ?? 'Conversation block').replace(/\s+/gu, ' ').trim().slice(0, 120),
    l0Tags: [],
    l1Summary: natural.slice(0, 4).map((message) => message.content.replace(/\s+/gu, ' ').trim()).join(' ').slice(0, 2_000),
    l2Keypoints: natural.slice(0, 20).map((message) => message.content.replace(/\s+/gu, ' ').trim().slice(0, 240)),
    // Keep the delayed extraction opportunity alive if a model is configured later.
    shouldExtract: true,
  }
}

export interface ModelCallbacks {
  summarizer?: BlockSummarizer
  extractor?: EventExtractor
  elementProjector?: ElementProjector
}

abstract class StructuredModelBridge {
  readonly summarizer: BlockSummarizer = async (messages) => {
    const raw = object(await this.callJson(
      'You compress agent conversations into durable memory blocks. Read the supplied provenance-preserving derivation messages. Return JSON only with l0Title, l0Tags, l1Summary, l2Keypoints, shouldExtract. Preserve decisions, constraints, preferences, outcomes, and unresolved work. Tool code and oversized tool payloads may be marked compacted; use the retained tool names, evidence summaries, and excerpts without inventing omitted details. shouldExtract is true only when durable events or facts exist.',
      { messages: buildMemoryDerivationMessages(messages) },
      SUMMARY_SCHEMA,
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
    const raw = object(await this.callJson(
      `You are the StrataGate Event Extractor. Make the final decision independently of the Summarizer pre-screen. Return JSON only: {shouldExtract:boolean,reason:string,events:[{title,summary,tags,quotes,sourceMessageIds,temporal,scope,criticality}]}. Set shouldExtract=true only for at least one durable, target-supported Event; otherwise set false with events=[] and a brief reason.

Each Event is one atomic fact, decision, plan, outcome, or state change that can independently be retrieved, updated, superseded, or contradicted. Split independently changing or conflicting facts into separate Events. Make each title and summary self-contained, with explicit source-supported names instead of pronouns. The title names the subject and one change; the summary states the complete supported fact and current status; tags add distinct retrieval entry points beyond title, summary, participants, and eventType. Preserve real names, aliases, abbreviations, versions, tools, technologies, projects, and distinctive concepts. Never invent keywords, unsupported synonyms, aliases, causes, relationships, or certainty; never stuff keywords.

Distinguish a user statement or decision, an assistant proposal or hypothesis, a tool-observed result, a plan, a completed result, and an unresolved possibility. Do not promote a suggestion to a decision, a hypothesis to a cause, or a plan to a completed outcome. All claims, exact quotes, times, status, and relationships require source evidence.

target.messages is a provenance-preserving derivation view of the target Block; tool code and oversized payloads may be compacted. Use retained tool names, evidence summaries, and excerpts without inventing omitted details. Only target.messages supplies new facts, quotes, and sourceMessageIds. neighbors.previous and neighbors.next are context-only; timeline is only for historical relationships. Neither neighbors, timeline, nor assistant recaps of old memory can create new Events. Require new human input or an observable target task/tool outcome. Every sourceMessageIds entry must exactly match allowedSourceMessageIds and directly support the Event. Use project scope for repository decisions, user scope for stable preferences/identity, and session scope for temporary task state. Use ISO-8601 timestamps with explicit +08:00 offset in temporal fields.`,
      extractorPayload(context),
      EXTRACTION_SCHEMA,
    ))
    const events = (Array.isArray(raw.events) ? raw.events : []).map((candidate): EventCardInput | null => {
      const item = object(candidate)
      const sourceMessageIds = strings(item.sourceMessageIds).filter((id) => validMessageIds.has(id))
      const scope = SCOPES.has(item.scope as MemoryScope) ? item.scope as MemoryScope : 'project'
      const criticality = CRITICALITIES.has(item.criticality as MemoryCriticality)
        ? item.criticality as MemoryCriticality
        : 'routine'
      if (!text(item.title) || !text(item.summary) || sourceMessageIds.length === 0
        || sourceMessageIds.length !== strings(item.sourceMessageIds).length) return null
      return {
        title: text(item.title).slice(0, 200),
        summary: text(item.summary).slice(0, 1_000),
        tags: strings(item.tags).slice(0, 16),
        quotes: strings(item.quotes).slice(0, 12),
        sourceMessageIds,
        sourceBlockId: context.target.id,
        temporal: object(item.temporal),
        scope,
        criticality,
      }
    }).filter((event): event is EventCardInput => event !== null)
    const shouldExtract = raw.shouldExtract === true && events.length > 0
    return {
      shouldExtract,
      reason: text(raw.reason) || (shouldExtract ? 'Durable evidence extracted.' : 'No durable evidence.'),
      events: shouldExtract ? events : [],
    }
  }

  readonly projector: ElementProjector = async (context: ElementProjectionContext): Promise<ElementProjectionResult> => {
    const eventIds = new Set(context.events.map((event) => event.id))
    const raw = object(await this.callJson(
      'Project event evidence into Element cards. Return JSON only: {reason,changes:[{element:{name,type,aliases},operation,key,mode,value,validFrom,validTo,sourceEventIds,confidence}]}. type is person/project/organization/tool/place. operation is set_state/add_set_item/set_relation. mode is state/set/relation. Use only supplied event ids and never create unsupported facts.',
      context,
      ELEMENT_SCHEMA,
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

  protected abstract callJson(system: string, payload: unknown, schema: unknown): Promise<unknown>
}

export class OpenAICompatibleModelBridge extends StructuredModelBridge {
  constructor(private readonly config: ModelConfig) {
    super()
  }

  protected async callJson(system: string, payload: unknown): Promise<unknown> {
    const response = await fetch(completionUrl(this.config.baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.config.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: JSON.stringify(payload) },
        ],
        temperature: 0,
        max_tokens: this.config.maxOutputTokens,
        response_format: { type: 'json_object' },
      }),
      signal: AbortSignal.timeout(90_000),
    })
    if (!response.ok) {
      const detail = (await response.text()).replace(/(?:sk-|Bearer\s+)[A-Za-z0-9._-]{8,}/gu, '[REDACTED]').slice(0, 500)
      throw new Error(`StrataGate model request failed (${response.status}): ${detail}`)
    }
    const body = object(await response.json())
    const choices = Array.isArray(body.choices) ? body.choices : []
    const message = object(object(choices[0]).message)
    const content = message.content
    if (typeof content !== 'string') throw new Error('StrataGate model response did not contain text content')
    return parseJsonResponse(content)
  }
}

function runHeadless(config: WorkBuddyModelConfig, args: string[], input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(config.command, [...config.commandArgs, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...process.env,
        STRATAGATE_DISABLE_HOST_ADAPTER: '1',
        CODEBUDDY_CODE_DISABLE_BACKGROUND_TASKS: '1',
        CODEBUDDY_DISABLE_AUTO_MEMORY: '1',
        CODEBUDDY_CODE_DISABLE_AUTO_MEMORY: '1',
      },
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let settled = false
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(Buffer.concat(stdout).toString('utf8'))
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(new Error(`WorkBuddy lite model timed out after ${config.timeoutMs}ms`))
    }, config.timeoutMs)
    child.stdout.on('data', (chunk) => {
      if (Buffer.concat(stdout).length < 2_000_000) stdout.push(Buffer.from(chunk))
    })
    child.stderr.on('data', (chunk) => {
      if (Buffer.concat(stderr).length < 20_000) stderr.push(Buffer.from(chunk))
    })
    child.on('error', (error) => finish(error))
    child.on('close', (code) => {
      if (code === 0) finish()
      else finish(new Error(`WorkBuddy lite model exited with code ${code}: ${Buffer.concat(stderr).toString('utf8').slice(0, 500)}`))
    })
    child.stdin.end(input)
  })
}

function parseHeadlessOutput(output: string): Record<string, unknown> {
  const candidates = [output.trim(), ...output.trim().split(/\r?\n/u).reverse()]
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    } catch {
      // Some launchers may print a status line before the JSON result.
    }
  }
  throw new Error(`WorkBuddy lite model did not return JSON: ${output.trim().slice(0, 300)}`)
}

export class WorkBuddyHeadlessModelBridge extends StructuredModelBridge {
  constructor(private readonly config: WorkBuddyModelConfig) {
    super()
  }

  protected async callJson(system: string, payload: unknown, schema: unknown): Promise<unknown> {
    const output = await runHeadless(this.config, [
      '-p',
      '--output-format', 'json',
      '--json-schema', JSON.stringify(schema),
      '--model', this.config.model,
      '--tools=',
      '--strict-mcp-config',
      '--mcp-config', '{"mcpServers":{}}',
      '--no-session-persistence',
      '--setting-sources', 'user',
      '--settings', '{"disableAllHooks":true}',
      '--system-prompt', system,
      '--max-turns', '1',
    ], JSON.stringify(payload))
    const body = parseHeadlessOutput(output)
    if (!body.structured_output || typeof body.structured_output !== 'object') {
      throw new Error(`WorkBuddy lite model did not return structured_output: ${text(body.result).slice(0, 300)}`)
    }
    return body.structured_output
  }
}

export function modelCallbacks(workBuddy?: WorkBuddyModelConfig, external?: ModelConfig): ModelCallbacks {
  const bridges: StructuredModelBridge[] = []
  if (workBuddy) bridges.push(new WorkBuddyHeadlessModelBridge(workBuddy))
  if (external) bridges.push(new OpenAICompatibleModelBridge(external))
  if (bridges.length === 0) return {}

  const attempt = async <T>(operation: (bridge: StructuredModelBridge) => Promise<T>): Promise<T> => {
    let lastError: unknown
    for (const bridge of bridges) {
      try {
        return await operation(bridge)
      } catch (error) {
        lastError = error
      }
    }
    throw lastError
  }
  return {
    summarizer: (messages) => attempt((bridge) => bridge.summarizer(messages)),
    extractor: (context) => attempt((bridge) => bridge.extractor(context)),
    elementProjector: (context) => attempt((bridge) => bridge.projector(context)),
  }
}
