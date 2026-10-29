import { estimateTokens, type EventCardInput, type RawMessage } from '@diqier/stratagate'

/** Only capacity failures may fan out. Transport/auth/rate-limit errors must back off. */
export class ExtractionCapacityError extends Error {
  constructor(readonly capacity: 'input' | 'output') {
    super(`Event extraction ${capacity} capacity exceeded; a smaller source batch is required`)
  }
}

export interface ExtractionSlice {
  messages: RawMessage[]
  /** Context only. These excerpts never broaden the allowed provenance IDs. */
  before: string
  after: string
  depth: number
}

const CONTEXT_CHARS = 1_200

/** Keep every character, including tool evidence, and retain original message IDs. */
export function splitExtractionSlice(slice: ExtractionSlice): [ExtractionSlice, ExtractionSlice] {
  const messages = slice.messages
  let left: RawMessage[]
  let right: RawMessage[]
  if (messages.length > 1) {
    const weights = messages.map(message => estimateTokens(JSON.stringify(message)))
    const half = weights.reduce((sum, size) => sum + size, 0) / 2
    let index = 1
    let size = weights[0]!
    while (index < messages.length - 1 && size < half) size += weights[index++]!
    left = messages.slice(0, index)
    right = messages.slice(index)
  } else {
    const message = messages[0]
    if (!message) throw new Error('Event extraction has no source to split')
    // Oversized tool evidence becomes explicit text; never drop a tool trace to fit.
    const content = message.content + (message.toolCalls?.length
      ? `\n[Tool evidence, JSON]\n${JSON.stringify(message.toolCalls)}` : '')
    if (content.length < 2) throw new Error('Event extraction cannot split this source any further')
    const middle = Math.floor(content.length / 2)
    const boundary = content.lastIndexOf('\n', middle)
    let cut = boundary >= middle / 2 ? boundary + 1 : middle
    // Never split a UTF-16 surrogate pair.
    if (/[\uD800-\uDBFF]/.test(content[cut - 1]!)) cut += 1
    if (cut >= content.length) throw new Error('Event extraction cannot split this source any further')
    const { toolCalls: _tools, ...base } = message
    left = [{ ...base, content: content.slice(0, cut) }]
    right = [{ ...base, content: content.slice(cut) }]
  }
  const excerpt = (items: RawMessage[]) => items.map(message => JSON.stringify(message)).join('\n')
  return [
    { messages: left, before: slice.before, after: excerpt(right).slice(0, CONTEXT_CHARS), depth: slice.depth + 1 },
    { messages: right, before: excerpt(left).slice(-CONTEXT_CHARS), after: slice.after, depth: slice.depth + 1 },
  ]
}

export function mergeExtractionEvents(events: EventCardInput[], exactKey: (event: EventCardInput) => string): EventCardInput[] {
  const unique = new Map<string, EventCardInput>()
  for (const event of events) {
    const key = exactKey(event)
    const prior = unique.get(key)
    if (!prior) { unique.set(key, structuredClone(event)); continue }
    prior.sourceMessageIds = [...new Set([...prior.sourceMessageIds, ...event.sourceMessageIds])]
    prior.tags = [...new Set([...(prior.tags ?? []), ...(event.tags ?? [])])].slice(0, 16)
    prior.quotes = [...new Set([...(prior.quotes ?? []), ...(event.quotes ?? [])])].slice(0, 12)
  }
  return [...unique.values()]
}
