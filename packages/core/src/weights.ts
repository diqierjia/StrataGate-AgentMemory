import type { MemoryCriticality, MemoryStatus, MemoryWeight } from './types.js';

export const DEFAULT_EVENT_DECAY_LAMBDA = 0.015;
const REHEARSAL_FACTOR = 1.5;

export function criticalityFloor(criticality: MemoryCriticality): number {
  if (criticality === 'safety') return 1;
  if (criticality === 'identity') return 0.9;
  if (criticality === 'preference') return 0.3;
  return 0;
}

export function memoryWeightAt(
  memory: { weight: MemoryWeight; status?: MemoryStatus },
  currentTurn: number,
  baseDecay = DEFAULT_EVENT_DECAY_LAMBDA,
): number {
  if (memory.status === 'forgotten' || memory.status === 'archived') return 0;
  const elapsed = Math.max(0, currentTurn - memory.weight.lastAdoptedTurn);
  const mentionCount = Math.max(1, memory.weight.mentionCount);
  const decay = Number.isFinite(baseDecay) && baseDecay >= 0 ? baseDecay : DEFAULT_EVENT_DECAY_LAMBDA;
  const lambda = decay / (1 + REHEARSAL_FACTOR * Math.log(mentionCount));
  const decayed = Math.max(memory.weight.floorWeight, Math.exp(-lambda * elapsed));
  const capped = memory.weight.forcedCap === null ? decayed : Math.min(decayed, memory.weight.forcedCap);
  return memory.weight.pinned ? 1 : capped;
}
