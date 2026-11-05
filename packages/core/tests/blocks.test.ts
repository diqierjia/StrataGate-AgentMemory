import { describe, expect, it } from 'vitest';
import {
  buildMemoryDerivationMessages,
  condenseTranscript,
  deterministicBlockLayers,
  estimateTokens,
  formatRawTranscript,
  getBlockWeight,
  getDecayedBlockLevel,
  normalizeBlockLevel,
  type RawMessage,
} from '../src/index.js';

describe('progressive conversation blocks', () => {
  it('labels legacy agent provenance as Recorded without modifying raw messages or user quotations', () => {
    const messages: RawMessage[] = [
      { id: 'agent-source', role: 'user', content: 'User: quoted text stays intact.', createdAt: '2026-01-01T00:00:00Z', threadId: 'agent-memory:blk-old' },
      { id: 'real-user', role: 'user', content: 'Real user message.', createdAt: '2026-01-01T00:00:01Z', threadId: 'ordinary-thread' },
      { id: 'unthreaded', role: 'user', content: 'Legacy user message.', createdAt: '2026-01-01T00:00:02Z' },
    ];
    const before = structuredClone(messages);
    const layers = deterministicBlockLayers(messages);
    for (const text of [layers.l3Condensed, layers.l4Readable, formatRawTranscript(layers.l5Raw)]) {
      expect(text).toContain('Recorded: User: quoted text stays intact.');
      expect(text).not.toContain('User: User: quoted text');
      expect(text).toMatch(/(?:User|user): Real user message\./u);
      expect(text).toMatch(/(?:User|user): Legacy user message\./u);
    }
    expect(messages).toEqual(before);
    expect(layers.l5Raw).toEqual(before);
    expect(estimateTokens(layers.l3Condensed)).toBeLessThanOrEqual(estimateTokens(layers.l4Readable));
    expect(estimateTokens(layers.l4Readable)).toBeLessThanOrEqual(estimateTokens(formatRawTranscript(layers.l5Raw)));
  });

  it('keeps raw messages while removing only bounded redundancy from L3', () => {
    const paste = 'This is a deliberately long pasted paragraph that must remain available in the raw evidence layer even when its second identical occurrence is condensed from the smaller context layer.';
    const messages: RawMessage[] = [
      { id: 'u1', role: 'user', content: 'Okay.\nThe source must remain available.', createdAt: '2026-01-01T00:00:00Z' },
      { id: 'a1', role: 'assistant', content: `${paste}\n\n${paste}`, createdAt: '2026-01-01T00:00:01Z' },
      {
        id: 'a2',
        role: 'assistant',
        content: 'Done.',
        createdAt: '2026-01-01T00:00:02Z',
        toolCalls: [{ name: 'search_events', arguments: { privateQuery: 'hidden' }, result: { ok: true, events: [{ id: 'evt-1' }] } }],
      },
    ];

    const condensed = condenseTranscript(messages);
    const layers = deterministicBlockLayers(messages);

    expect(condensed).toContain('The source must remain available.');
    expect(condensed).toContain('Tool call: search_events');
    expect(condensed).not.toContain('privateQuery');
    expect((condensed.match(/deliberately long pasted paragraph/g) ?? [])).toHaveLength(1);
    expect(layers.l5Raw[1]?.content).toContain(paste);
  });

  it('keeps L3 through L5 monotonic while retaining raw tool-call evidence in L5', () => {
    const messages: RawMessage[] = [{
      id: 'u1',
      role: 'user',
      content: '第一句保持原样。第二句也保持原样。ASCII-run-should-not-be-fragmented。',
      createdAt: '2026-09-05T00:00:00Z',
      toolCalls: [{
        name: 'pwsh',
        arguments: { command: 'Get-ChildItem -Force' },
        result: { ok: true, files: ['package.json'] },
      }],
    }];

    const layers = deterministicBlockLayers(messages);
    const l5 = formatRawTranscript(layers.l5Raw);

    expect(layers.l3Condensed).toContain('第一句保持原样。第二句也保持原样。');
    expect(layers.l3Condensed).not.toContain('第一句保持原样。\n第二句也保持原样。');
    expect(l5).toContain('"arguments":{"command":"Get-ChildItem -Force"}');
    expect(l5).toContain('"result":{"ok":true,"files":["package.json"]}');
    expect(estimateTokens(layers.l3Condensed)).toBeLessThanOrEqual(estimateTokens(layers.l4Readable));
    expect(estimateTokens(layers.l4Readable)).toBeLessThanOrEqual(estimateTokens(l5));
  });

  it('builds bounded derivation messages without weakening L5 provenance', () => {
    const code = 'const secretImplementation = executeStep();\n'.repeat(300);
    const log = `started\n${'repeated low-value log line\n'.repeat(400)}FINAL_STATUS=passed`;
    const messages: RawMessage[] = [
      {
        id: 'u-derivation', role: 'user', content: 'Please verify the release and remember the outcome.',
        createdAt: '2026-09-21T08:00:00Z', threadId: 'thread-1',
      },
      {
        id: 'a-derivation', role: 'assistant', content: 'The release verification completed successfully.',
        createdAt: '2026-09-21T08:00:01Z', threadId: 'thread-1',
        toolCalls: [{
          name: 'run_code',
          arguments: { code, cwd: '/workspace/project', mode: 'verify' },
          result: { ok: true, summary: 'Release verification passed.', log },
        }],
      },
    ];

    const derived = buildMemoryDerivationMessages(messages);
    const layers = deterministicBlockLayers(messages);
    const rendered = JSON.stringify(derived);

    expect(derived.map(({ id, role, createdAt, threadId }) => ({ id, role, createdAt, threadId })))
      .toEqual(messages.map(({ id, role, createdAt, threadId }) => ({ id, role, createdAt, threadId })));
    expect(derived[0]?.content).toBe(messages[0]?.content);
    expect(derived[1]?.content).toBe(messages[1]?.content);
    expect(derived[1]?.toolCalls?.[0]?.name).toBe('run_code');
    expect(derived[1]?.toolCalls?.[0]?.arguments).toMatchObject({ cwd: '/workspace/project', mode: 'verify' });
    expect(String(derived[1]?.toolCalls?.[0]?.arguments?.code)).toContain('full value remains in L5');
    expect(rendered).toContain('Release verification passed.');
    expect(rendered).toContain('FINAL_STATUS=passed');
    expect(rendered).not.toContain('secretImplementation');
    expect(rendered.length).toBeLessThan(JSON.stringify(messages).length * 0.25);
    expect(messages[1]?.toolCalls?.[0]?.arguments?.code).toBe(code);
    expect((messages[1]?.toolCalls?.[0]?.result as { log: string }).log).toBe(log);
    expect(layers.l5Raw[1]?.toolCalls?.[0]?.arguments?.code).toBe(code);
    expect((layers.l5Raw[1]?.toolCalls?.[0]?.result as { log: string }).log).toBe(log);
  });

  it('bounds standalone tool messages while leaving conversational text unchanged', () => {
    const toolOutput = `begin\n${'payload\n'.repeat(1_000)}end`;
    const messages: RawMessage[] = [
      { id: 'u1', role: 'user', content: toolOutput, createdAt: '2026-09-21T08:00:00Z' },
      { id: 't1', role: 'tool', content: toolOutput, createdAt: '2026-09-21T08:00:01Z' },
    ];

    const derived = buildMemoryDerivationMessages(messages);

    expect(derived[0]?.content).toBe(toolOutput);
    expect(derived[1]?.content).toContain('tool message content compacted');
    expect(derived[1]?.content).toContain('begin');
    expect(derived[1]?.content).toContain('end');
    expect(derived[1]!.content.length).toBeLessThan(toolOutput.length * 0.5);
  });

  it('decays through six levels and expands only to the requested level', () => {
    expect(getDecayedBlockLevel(5, 0, 0)).toBe(5);
    expect(getDecayedBlockLevel(5, 0, 2)).toBe(4);
    expect(getDecayedBlockLevel(5, 0, 3)).toBe(3);
    expect(getDecayedBlockLevel(5, 0, 5)).toBe(2);
    expect(getDecayedBlockLevel(5, 0, 7)).toBe(1);
    expect(getDecayedBlockLevel(5, 0, 9)).toBe(0);
    expect(getDecayedBlockLevel(5, 0, 4, 0.1)).toBe(4);
    expect(normalizeBlockLevel('next', 2)).toBe(3);
    expect(normalizeBlockLevel('raw', 2)).toBe(5);
    expect(getBlockWeight(0, 2)).toBeCloseTo(Math.exp(-0.6), 8);
  });
});
