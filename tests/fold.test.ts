import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { TurnFolder } from '../src/fold.js'

const session = {
  id: 'session-1',
  header: { id: 'session-1', version: 0, createdAt: 0, cwd: 'C:\\repo' },
} as unknown as Session

function event(type: string, data: unknown, seq: number): SessionEvent {
  return { type, data, seq, time: Date.UTC(2026, 7, 16, 1, 2, seq) } as SessionEvent
}

function content(text: string): ContentBlock[] {
  return [{ type: 'text', text }]
}

describe('DSH turn folding', () => {
  it('preserves the original tool result when DSH prunes it before turn end', () => {
    const folder = new TurnFolder()
    folder.accept(session, event('turn/start', { turn: 12 }, 1))
    folder.accept(session, event('user/message', {
      id: 'human', role: 'user', content: content('Inspect file'), source: { kind: 'user' },
    }, 2))
    folder.accept(session, event('tool/call', {
      turn: 12, step: 1, callId: 'call', name: 'read_file', arguments: '{}',
    }, 3))
    folder.accept(session, { ...event('tool/result', {
      turn: 12, step: 1,
      message: { source: { kind: 'tool', callId: 'call' }, content: [{ type: 'tool-result', content: content('FULL ORIGINAL RESULT') }] },
    }, 4), surfaceOp: 'append' } as SessionEvent)
    folder.accept(session, { ...event('tool/result', {
      turn: 12, step: 1,
      message: { source: { kind: 'tool', callId: 'call' }, content: [{ type: 'tool-result', content: content('[pruned]') }] },
    }, 5), surfaceOp: { op: 'replace', startSeq: 4, endSeq: 4 } } as SessionEvent)
    const folded = folder.accept(session, event('turn/end', { turn: 12, reason: { kind: 'completed' } }, 6))
    expect(folded?.assistantToolCalls).toEqual([{ name: 'read_file', arguments: {}, result: 'FULL ORIGINAL RESULT' }])
  })

  it('folds a multi-step DSH turn and ignores injected plugin messages', () => {
    const folder = new TurnFolder()
    expect(folder.accept(session, event('turn/start', { turn: 7 }, 1))).toBeNull()
    folder.accept(session, event('user/message', {
      id: 'plugin-message', role: 'user', content: content('hidden instructions'),
      source: { kind: 'plugin', plugin: 'workspace-context' } as any,
    }, 2))
    folder.accept(session, event('user/message', {
      id: 'user-message', role: 'user', content: content('Fix login'), source: { kind: 'user' },
    }, 3))
    folder.accept(session, event('tool/call', {
      turn: 7, step: 1, callId: 'memory-call', name: 'memory_search_events', arguments: '{"query":"login"}',
    }, 3))
    folder.accept(session, event('tool/result', {
      turn: 7, step: 1,
      message: {
        id: 'memory-result', role: 'user', source: { kind: 'tool', callId: 'memory-call' },
        content: [{ type: 'tool-result', toolCallId: 'memory-call', content: content('old recalled evidence') }],
      },
    }, 3))
    folder.accept(session, event('assistant/message', {
      turn: 7, step: 1,
      message: { id: 'assistant-1', role: 'assistant', content: content('I will inspect it.'), source: { kind: 'model', provider: 'p', model: 'm' } },
    }, 4))
    folder.accept(session, event('tool/call', {
      turn: 7, step: 1, callId: 'call-1', name: 'read_file', arguments: '{"path":"src/login.ts"}',
    }, 5))
    folder.accept(session, event('tool/result', {
      turn: 7, step: 1,
      message: {
        id: 'tool-message', role: 'user', source: { kind: 'tool', callId: 'call-1' },
        content: [{ type: 'tool-result', toolCallId: 'call-1', content: content('file contents') }],
      },
    }, 6))
    folder.accept(session, event('assistant/message', {
      turn: 7, step: 2,
      message: { id: 'assistant-2', role: 'assistant', content: content('Fixed and tested.'), source: { kind: 'model', provider: 'p', model: 'm' } },
    }, 7))
    const folded = folder.accept(session, event('turn/end', { turn: 7, reason: { kind: 'completed' } }, 8))

    expect(folded).toMatchObject({
      user: 'Fix login',
      assistant: 'I will inspect it.\n\nFixed and tested.',
      threadId: 'session-1',
      receiptId: 'dsh:session-1:turn:7',
      assistantToolCalls: [{ name: 'read_file', arguments: { path: 'src/login.ts' }, result: 'file contents' }],
    })
  })

  it('does not store a turn without a direct human message', () => {
    const folder = new TurnFolder()
    folder.accept(session, event('turn/start', { turn: 8 }, 1))
    folder.accept(session, event('user/message', {
      id: 'plugin-message', role: 'user', content: content('notice'), source: { kind: 'plugin', plugin: 'notice' } as any,
    }, 2))
    expect(folder.accept(session, event('turn/end', { turn: 8, reason: { kind: 'completed' } }, 3))).toBeNull()
  })

  it('retains durable image and file references in L5 text, including attachment-only turns', () => {
    const folder = new TurnFolder()
    folder.accept(session, event('turn/start', { turn: 9 }, 1))
    folder.accept(session, event('user/message', {
      id: 'attachment-message', role: 'user', source: { kind: 'user' }, content: [
        { type: 'image', attachment: {
          attachmentId: 'sha256:image' as never, mediaType: 'image/png', bytes: 123,
          width: 640, height: 480, name: 'architecture.png',
        } },
        { type: 'file', attachment: {
          attachmentId: 'sha256:file' as never, name: 'requirements.pdf', bytes: 456,
        } },
      ],
    }, 2))
    const folded = folder.accept(session, event('turn/end', { turn: 9, reason: { kind: 'completed' } }, 3))

    expect(folded).toMatchObject({ userMessageId: 'dsh:session-1:turn:9:user' })
    expect(folded?.user).toContain('architecture.png')
    expect(folded?.user).toContain('sha256:image')
    expect(folded?.user).toContain('requirements.pdf')
    expect(folded?.user).toContain('sha256:file')
  })
})
