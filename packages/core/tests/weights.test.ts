import { describe, expect, it } from 'vitest';
import { DEFAULT_EVENT_DECAY_LAMBDA, criticalityFloor, memoryWeightAt } from '../src/index.js';

function routineMemory(overrides: Partial<{
  mentionCount: number;
  lastAdoptedTurn: number;
  pinned: boolean;
  floorWeight: number;
  forcedCap: number | null;
}> = {}, status: 'active' | 'superseded' | 'forgotten' | 'archived' = 'active') {
  return {
    status,
    weight: {
      mentionCount: 1,
      lastAdoptedTurn: 0,
      lastRetrievedAt: null,
      pinned: false,
      floorWeight: criticalityFloor('routine'),
      forcedCap: null,
      ...overrides,
    },
  };
}

describe('Event weight decay', () => {
  it('uses 0.015 as the default base decay so un-adopted events stay much slower than short-term blocks', () => {
    expect(DEFAULT_EVENT_DECAY_LAMBDA).toBe(0.015);
    const event = routineMemory();
    expect(memoryWeightAt(event, 0)).toBe(1);
    expect(memoryWeightAt(event, 6)).toBeCloseTo(Math.exp(-0.015 * 6), 12);
    expect(memoryWeightAt(event, 6)).toBeGreaterThan(0.9);
    expect(memoryWeightAt(event, 46)).toBeCloseTo(0.5, 1);
    expect(memoryWeightAt(event, 100)).toBeCloseTo(Math.exp(-1.5), 12);
    expect(memoryWeightAt(event, 100)).toBeGreaterThan(0.2);
  });

  it('slows future decay as adoptions increase and honors custom baseDecay rates', () => {
    const once = routineMemory({ mentionCount: 1 });
    const repeated = routineMemory({ mentionCount: 5 });
    expect(memoryWeightAt(repeated, 100)).toBeGreaterThan(memoryWeightAt(once, 100));
    expect(memoryWeightAt(once, 100, 0)).toBe(1);
    expect(memoryWeightAt(once, 50, 0.02)).toBeCloseTo(Math.exp(-1), 12);
    expect(memoryWeightAt(once, 50, Number.NaN)).toBeCloseTo(memoryWeightAt(once, 50), 12);
    expect(memoryWeightAt(once, 50, -0.1)).toBeCloseTo(memoryWeightAt(once, 50), 12);
  });

  it('preserves floorWeight, forcedCap, pinned, and forgotten/archived overrides', () => {
    expect(memoryWeightAt(routineMemory({ floorWeight: criticalityFloor('preference') }), 10_000)).toBe(0.3);
    expect(memoryWeightAt(routineMemory({ forcedCap: 0.1 }), 0)).toBe(0.1);
    expect(memoryWeightAt(routineMemory({ forcedCap: 0.1, pinned: true }), 1_000)).toBe(1);
    expect(memoryWeightAt(routineMemory({ pinned: true }, 'forgotten'), 0)).toBe(0);
    expect(memoryWeightAt(routineMemory({ pinned: true }, 'archived'), 0)).toBe(0);
  });
});
