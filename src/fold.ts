import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ToolTrace, TurnInput } from '@diqier/stratagate'
import { toUtc8Iso } from '@diqier/stratagate'

interface PendingTurn {
  turn: number
  user: string[]
  assistant: string[]
  tools: Map<string, ToolTrace>
  ignoredTools: Set<string>
}

export interface FoldedTurn extends TurnInput {
  receiptId: string
  /** Native DSH turn number used to replace the sealed surface range. */
  dshTurn: number
}

function renderBlocks(blocks: readonly ContentBlock[]): string {
  const output: string[] = []
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        if (block.text.trim()) output.push(block.text)
        break
      case 'reasoning':
        break
      case 'image':
        output.push('[image]')
        break
      case 'tool-call':
        break
      default: {
        // V3 tool results could be nested content blocks. V4 uses a tool-role
        // message, but old records may still pass through this reader.
        const legacy = block as { type: string; content?: readonly ContentBlock[] }
        if (legacy.type === 'tool-result' && legacy.content) {
          const nested = renderBlocks(legacy.content)
          if (nested) output.push(nested)
        }
        break
      }
    }
  }
  return output.join('\n').trim()
}

function parseArguments(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : { value: parsed }
  } catch {
    return { raw: value }
  }
}

function reasonLabel(reason: { kind: string }): string {
  return reason.kind === 'completed' ? 'Turn completed.' : `Turn ended: ${reason.kind}.`
}

export class TurnFolder {
  private readonly turns = new Map<string, Map<number, PendingTurn>>()
  private readonly activeTurn = new Map<string, number>()

  accept(session: Session, event: SessionEvent): FoldedTurn | null {
    const sessionId = String(session.id)
    switch (event.type) {
      case 'turn/start': {
        this.activeTurn.set(sessionId, event.data.turn)
        this.pending(sessionId, event.data.turn)
        return null
      }
      case 'user/message': {
        if (event.data.source.kind !== 'user') return null
        const turn = this.activeTurn.get(sessionId)
        if (turn === undefined) return null
        const text = renderBlocks(event.data.content)
        if (text) this.pending(sessionId, turn).user.push(text)
        return null
      }
      case 'assistant/message': {
        const text = renderBlocks(event.data.message.content)
        if (text) this.pending(sessionId, event.data.turn).assistant.push(text)
        return null
      }
      case 'tool/call': {
        if (event.data.name.startsWith('memory_') && !['memory_daily_write', 'memory_daily_read'].includes(event.data.name)) {
          this.pending(sessionId, event.data.turn).ignoredTools.add(String(event.data.callId))
          return null
        }
        this.pending(sessionId, event.data.turn).tools.set(String(event.data.callId), {
          name: event.data.name,
          arguments: parseArguments(event.data.arguments),
        })
        return null
      }
      case 'tool/result': {
        // DSH prune emits a second tool/result for the model-visible surface.
        // The first append is the execution evidence kept in L5.
        if (event.surfaceOp && event.surfaceOp !== 'append') return null
        const callId = String(event.data.message.source.callId)
        const pending = this.pending(sessionId, event.data.turn)
        if (pending.ignoredTools.has(callId)) return null
        const current = pending.tools.get(callId) ?? { name: 'unknown' }
        const rendered = renderBlocks(event.data.message.content)
        pending.tools.set(callId, { ...current, result: rendered })
        return null
      }
      case 'turn/end': {
        this.activeTurn.delete(sessionId)
        const byTurn = this.turns.get(sessionId)
        const pending = byTurn?.get(event.data.turn)
        byTurn?.delete(event.data.turn)
        if (byTurn?.size === 0) this.turns.delete(sessionId)
        if (!pending || pending.user.length === 0) return null
        return {
          user: pending.user.join('\n\n'),
          assistant: pending.assistant.join('\n\n') || reasonLabel(event.data.reason),
          threadId: sessionId,
          assistantToolCalls: [...pending.tools.values()],
          createdAt: toUtc8Iso(event.time),
          receiptId: `dsh:${sessionId}:turn:${event.data.turn}`,
          dshTurn: event.data.turn,
        }
      }
      default:
        return null
    }
  }

  private pending(sessionId: string, turn: number): PendingTurn {
    let byTurn = this.turns.get(sessionId)
    if (!byTurn) {
      byTurn = new Map()
      this.turns.set(sessionId, byTurn)
    }
    let pending = byTurn.get(turn)
    if (!pending) {
      pending = { turn, user: [], assistant: [], tools: new Map(), ignoredTools: new Set() }
      byTurn.set(turn, pending)
    }
    return pending
  }
}
