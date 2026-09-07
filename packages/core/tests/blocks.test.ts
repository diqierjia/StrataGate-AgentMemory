import { describe, expect, it } from 'vitest';
import {
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
