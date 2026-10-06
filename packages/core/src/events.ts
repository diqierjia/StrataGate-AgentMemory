import { normalizeSearchText } from './search.js';
import type { EventCardInput, EventTemporal, StandardEventType } from './types.js';

export const EVENT_EXTRACTOR_VERSION = 2;

/** Optional metadata is bounded at admission and load, without inventing defaults. */
export function normalizeEventMetadata(value: unknown): Pick<EventCardInput, 'catalogHints' | 'extractorVersion'> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const item = value as Record<string, unknown>;
  const metadata: Pick<EventCardInput, 'catalogHints' | 'extractorVersion'> = {};
  if (Array.isArray(item.catalogHints)) {
    metadata.catalogHints = [...new Set(item.catalogHints.filter((hint): hint is string => typeof hint === 'string')
      .map((hint) => hint.trim()).filter((hint) => hint.length > 0 && [...hint].length <= 64
        && !/^(other|其他|其它)$/i.test(hint)
        && !/^(chapter|section|topic|chap|sec)[_:：-]/i.test(hint)
        && !/^[\/\\]|[\/\\].*[\/\\]|[>→]/.test(hint)))].slice(0, 2);
  }
  if (Number.isSafeInteger(item.extractorVersion) && (item.extractorVersion as number) > 0) {
    metadata.extractorVersion = item.extractorVersion as number;
  }
  return metadata;
}

/**
 * Validate only the runtime shapes consumed by Event code. Keep valid values
 * unchanged; discard malformed fields without discarding the Event.
 */
export function normalizeEventTemporal(value: unknown): EventTemporal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const temporal = { ...value } as EventTemporal;
  for (const field of [
    'mentionedAt', 'happenedStart', 'happenedEnd', 'originalText',
    'precision', 'basis', 'status', 'eventType', 'threadId', 'sameEventId',
  ] as const) {
    if (typeof temporal[field] !== 'string') delete temporal[field];
  }
  for (const field of [
    'participants', 'participantNodeIds', 'beforeEventIds', 'afterEventIds',
    'supersedesEventIds', 'conflictsWithEventIds', 'relatedEventIds',
  ] as const) {
    const values = temporal[field];
    if (Array.isArray(values) && [...values].every((item) => typeof item === 'string')) {
      temporal[field] = [...values];
    } else {
      delete temporal[field];
    }
  }
  return temporal;
}

/** Maps multilingual/free-text legacy labels into the stable Event taxonomy. */
export function normalizeStandardEventType(value: string | undefined): StandardEventType {
  const normalized = normalizeSearchText(value ?? '').replace(/[\s_-]+/g, '');
  const aliases: Record<string, StandardEventType> = {
    '发布': 'release', '版本发布': 'release', release: 'release', released: 'release',
    '决定': 'decision', '决策': 'decision', decision: 'decision',
    '完成': 'task_completed', '任务完成': 'task_completed', taskcompleted: 'task_completed', completed: 'task_completed',
    '计划': 'plan', plan: 'plan', planned: 'plan',
    '变更': 'change', '修改': 'change', change: 'change',
    '取消': 'cancellation', cancellation: 'cancellation', cancelled: 'cancellation', canceled: 'cancellation',
    '故障': 'incident', incident: 'incident',
    '会议': 'meeting', meeting: 'meeting',
    '协作': 'collaboration', collaboration: 'collaboration',
    '迁移': 'migration', migration: 'migration', other: 'other',
  };
  return aliases[normalized] ?? 'other';
}
