import type { MemoryTopicOverviewKind } from './topics.js';

/** Legacy draft metadata: readable for snapshot compatibility, never authoritative. */
export interface TopicOverviewRepairRequirement {
  kind?: MemoryTopicOverviewKind;
  sourceEventIds: string[];
  minimumEntries: number;
}
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};
const ids = (value: unknown): string[] => Array.isArray(value)
  ? [...new Set(value.filter((id): id is string => typeof id === 'string'))].sort() : [];
/** Deduplicate persisted entries independently of property/source order. */
export function uniqueTopicOverviewEntries<T>(parts: readonly T[]): T[] {
  const seen = new Set<string>();
  return parts.filter((part) => {
    const row = record(part);
    const identity = JSON.stringify([row.kind, row.title ?? null, row.text, ids(row.sourceEventIds)]);
    if (seen.has(identity)) return false;
    seen.add(identity); return true;
  });
}
