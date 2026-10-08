import { TopicProjectionError, type TopicProjectionDiagnostics } from './topic-diagnostics.js';
import type { MemoryTopicOverviewKind, TopicProjectionContext } from './topics.js';

/** No model text or titles: only legal evidence identities and structural counts. */
export interface TopicOverviewRepairRequirement {
  kind?: MemoryTopicOverviewKind;
  sourceEventIds: string[];
  minimumEntries: number;
}
const kinds = ['history', 'decision', 'change', 'open-question', 'scope'];
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};
const ids = (value: unknown): string[] => Array.isArray(value)
  ? [...new Set(value.filter((id): id is string => typeof id === 'string'))].sort() : [];
const key = (row: Pick<TopicOverviewRepairRequirement, 'kind' | 'sourceEventIds'>) => JSON.stringify([row.kind ?? null, row.sourceEventIds]);
const validText = (value: unknown): boolean => typeof value === 'string' && !!value.trim() && Array.from(value).length <= 600;
/** The same semantic identity is used for repair counts and persisted deduplication.
 * Source/property order cannot turn a copied paragraph into another replacement. */
export function uniqueTopicOverviewEntries<T>(parts: readonly T[]): T[] {
  const seen = new Set<string>();
  return parts.filter((part) => {
    const row = record(part);
    const identity = JSON.stringify([row.kind, row.title ?? null, row.text, ids(row.sourceEventIds)]);
    if (seen.has(identity)) return false;
    seen.add(identity); return true;
  });
}
function entries(value: unknown): Record<string, unknown>[] {
  const topics = record(value).topics;
  return Array.isArray(topics) ? topics.flatMap((topic) => {
    const overview = record(topic).overview;
    return Array.isArray(overview) ? uniqueTopicOverviewEntries(overview).map(record) : [];
  }) : [];
}

// Keep repair metadata off serialized errors/diagnostics. The owner persists it
// separately on the job so a new task attempt or process cannot erase the guard.
const repairsByError = new WeakMap<TopicProjectionError, TopicOverviewRepairRequirement[]>();
export function carryTopicOverviewRepairs(error: TopicProjectionError, requirements: readonly TopicOverviewRepairRequirement[]): TopicProjectionError {
  if (requirements.length) repairsByError.set(error, structuredClone([...requirements]));
  return error;
}
export function topicOverviewRepairsFromError(error: unknown): TopicOverviewRepairRequirement[] {
  return error instanceof TopicProjectionError ? structuredClone(repairsByError.get(error) ?? []) : [];
}

/** Old field failures lack paragraph identities; require a valid nonempty
 * replacement without guessing its kind, membership or original wording. */
export function topicOverviewRepairsForHistoricalFailure(diagnostics: TopicProjectionDiagnostics | undefined): TopicOverviewRepairRequirement[] {
  return diagnostics && ['schema-invalid', 'validation-failed'].includes(diagnostics.category)
    && ['overview.text must be a string', 'overview.text is empty', 'overview.text contains only whitespace',
      'overview.text exceeds the character limit', 'overview.text must be nonempty and at most 600 characters'].includes(diagnostics.reason)
    ? [{ sourceEventIds: [], minimumEntries: 1 }] : [];
}

export class TopicOverviewRepairGuard {
  private required: TopicOverviewRepairRequirement[] = [];
  constructor(requirements: readonly TopicOverviewRepairRequirement[] = []) { this.merge(requirements); }
  get requirements(): TopicOverviewRepairRequirement[] { return structuredClone(this.required); }
  merge(requirements: readonly TopicOverviewRepairRequirement[]): void {
    const merged = new Map(this.required.map((row) => [key(row), row]));
    for (const requirement of requirements) {
      const row: TopicOverviewRepairRequirement = {
        ...(kinds.includes(requirement.kind ?? '') ? { kind: requirement.kind! } : {}),
        sourceEventIds: ids(requirement.sourceEventIds), minimumEntries: requirement.minimumEntries,
      };
      if (!Number.isSafeInteger(row.minimumEntries) || row.minimumEntries < 1) continue;
      const previous = merged.get(key(row));
      if (!previous || previous.minimumEntries < row.minimumEntries) merged.set(key(row), row);
    }
    this.required = [...merged.values()];
  }
  observe(value: unknown, context: TopicProjectionContext): void {
    const parts = entries(value);
    if (!parts.some((part) => !validText(part.text))) return;
    const rawTopics = record(value).topics as unknown[];
    const rows = rawTopics.flatMap((topic) => {
      const item = record(topic), overview = item.overview;
      const candidate = context.existingTopics.find(({ id }) => id === item.topicId);
      const allowed = new Set([...context.events.map(({ id }) => id), ...(candidate?.sourceEventIds ?? [])]);
      return Array.isArray(overview) ? uniqueTopicOverviewEntries(overview).map((entry) => {
        const part = record(entry);
        const row: TopicOverviewRepairRequirement = {
          ...(kinds.includes(String(part.kind)) ? { kind: part.kind as MemoryTopicOverviewKind } : {}),
          sourceEventIds: ids(part.sourceEventIds).filter((id) => allowed.has(id)), minimumEntries: 1,
        };
        return { row, invalid: !validText(part.text) };
      }) : [];
    });
    const counts = new Map<string, TopicOverviewRepairRequirement>();
    for (const { row, invalid } of rows) {
      if (!invalid) continue;
      // A missing kind/source identity is a wildcard. Count all original
      // entries it could match, so an already-valid one cannot mask deletion.
      const count = rows.filter(({ row: original }) => (row.kind === undefined || row.kind === original.kind)
        && (!row.sourceEventIds.length || JSON.stringify(row.sourceEventIds) === JSON.stringify(original.sourceEventIds))).length;
      counts.set(key(row), { ...row, minimumEntries: count });
    }
    if (rows.some(({ row, invalid }) => invalid && (row.kind === undefined || !row.sourceEventIds.length))) {
      const total = { sourceEventIds: [], minimumEntries: parts.length };
      counts.set(key(total), total);
    }
    // Preserve multiplicity too: a valid duplicate cannot stand in for a
    // removed invalid paragraph. Reordering chapters/paragraphs remains legal.
    this.merge([...counts.values()]);
  }
  assert(value: unknown): void {
    if (!this.required.length) return;
    const actual = uniqueTopicOverviewEntries(entries(value)).filter((part) => validText(part.text)).map((part) => ({
      kind: part.kind, sourceEventIds: ids(part.sourceEventIds),
    }));
    // Constraints overlap intentionally: a legacy nonempty floor and a
    // subsequently observed exact identity describe the same repair, not two
    // separate paragraphs. Exact identities still retain their multiplicity.
    for (const row of this.required) {
      const count = actual.filter((part) => (row.kind === undefined || row.kind === part.kind)
        && (!row.sourceEventIds.length || JSON.stringify(row.sourceEventIds) === JSON.stringify(part.sourceEventIds))).length;
      if (count < row.minimumEntries) {
        throw new TopicProjectionError('validation-failed', 'Topic retry must replace invalid overview without removing entries.');
      }
    }
  }
}

/** Splits/partial recovery transfer obligations only to the owning sources. */
export function partitionTopicOverviewRepairs(requirements: readonly TopicOverviewRepairRequirement[] | undefined,
  parentIds: readonly string[], childIds: readonly string[]): TopicOverviewRepairRequirement[] | undefined {
  if (!requirements?.length) return undefined;
  const parent = new Set(parentIds), child = new Set(childIds);
  const rows = requirements.flatMap((row) => {
    const batchIds = row.sourceEventIds.filter((id) => parent.has(id));
    if (batchIds.length && !batchIds.some((id) => child.has(id))) return [];
    return [{ ...row, sourceEventIds: row.sourceEventIds.filter((id) => !parent.has(id) || child.has(id)) }];
  });
  const guard = new TopicOverviewRepairGuard(rows);
  return guard.requirements.length ? guard.requirements : undefined;
}
