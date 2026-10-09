export const TOPIC_OVERVIEW_MAX_CHARACTERS = 1000;

/** Content-free diagnostics. Never copy arbitrary error messages or model output. */
export type TopicFailureCategory = 'max-tokens' | 'schema-invalid' | 'validation-failed'
  | 'timeout' | 'provider-failed' | 'worker-failed' | 'source-changed';

export interface TopicProjectionDiagnostics {
  category: TopicFailureCategory;
  reason: string;
  fieldPath?: string;
  actualCharacters?: number;
  minCharacters?: number;
  maxCharacters?: number;
  eventCount?: number;
  candidateTopicCount?: number;
  estimatedInputTokens?: number;
  requestedOutputTokens?: number;
  maxOutputTokens?: number;
  finishReason?: string;
  reasoningOff?: 'requested-unverified' | 'reasoning-observed' | 'fallback' | 'unavailable';
  reasoningObserved?: boolean;
  modelCalls?: number;
  attempt?: number;
  splitDepth?: number;
}

const categories: TopicFailureCategory[] = ['max-tokens', 'schema-invalid', 'validation-failed',
  'timeout', 'provider-failed', 'worker-failed', 'source-changed'];

// This catalog contains only code-owned rules, never model-supplied values.
const TOPIC_SAFE_REASONS = new Set<string>([
  'A topic may be updated only once per projection.',
  'Invalid duplicate chapter label conflicts with an existing topic.',
  'Invalid duplicate chapter label in one projection.',
  'Invalid duplicate chapter label matches an unexposed existing topic.',
  'Invalid or duplicate topic section title.',
  'Invalid section backfill: explicit sections must cover the existing chapter.',
  'Invalid topic membership source events.',
  'Invalid topic overview section.',
  'Invalid topic overview source events.',
  'Invalid topic overview title.',
  'Invalid topic section source events.',
  'Invalid topic sections.',
  'Invalid topic title or description.',
  'New topic overview must match a final topic section.',
  'Old overview evidence must be preserved verbatim; new sections need batch events.',
  'Old section membership must be preserved; reassignment needs batch events.',
  'Overview references must belong to returned topic membership.',
  'Section references must belong to returned topic membership.',
  'Topic projection lease expired; stale result rejected.',
  'Topic projection must contain at most 8 overview paragraphs per chapter per batch.',
  'Topic projection must return 1-12 topics.',
  'Topic projection omitted batch events.',
  'Topic retry must replace invalid overview without removing entries.',
  'Topic projection source version changed; stale result rejected.',
  'Topic sections omitted batch events.',
  'Truncated topic sources permit navigation scope only, not factual overview.',
  'Unknown or unexposed topic id.',
  'duplicate chapter label; combine its batch assignments',
  'duplicate section title',
  'every returned topic must cover a supplied batch Event',
  'every supplied batch Event must be assigned to a topic',
  'every topic batch Event must be assigned to a section',
  'expected only topics, with at most 12 entries',
  'new overview must match a declared or inherited section',
  'old overview evidence may only be preserved verbatim; rewritten entries must cite batch Events only',
  'overview must contain 0-8 source-grounded entries',
  'overview.sourceEventIds must contain unique, supplied Event ids (at most 12)',
  'overview.text must be nonempty and at most 600 characters',
  'overview.text must be a string',
  'overview.text is empty',
  'overview.text contains only whitespace',
  'overview.text exceeds the character limit',
  'overview.title must be nonempty and at most 80 characters',
  'section backfill must update only its existing chapter',
  'section.sourceEventIds must contain unique, supplied Event ids',
  'section.title must be nonempty and at most 80 characters',
  'sections must assign batch Events independently of overview',
  'topic.description must be nonempty and at most 400 characters',
  'topic.sourceEventIds must contain unique, supplied Event ids',
  'topic.title must be nonempty and at most 120 characters',
  'topicId must be nonempty and at most 200 characters',
  'truncated Event evidence may only support scope entries',
  'unexpected overview field',
  'unexpected section field',
  'unexpected topic field',
  'unknown or repeated topicId',
  'unknown overview kind',
  'topic input exceeds model context capacity', 'output token limit reached', 'structured topic schema mismatch', 'tool arguments are not valid JSON',
  'expected exactly one structured topic call', 'topic semantic validation failed',
  'structured model task timed out', 'provider or route error', 'topic worker failed',
  'source version changed; stale result rejected', 'topic projection lease expired',
]);

export function safeTopicDiagnostics(value: unknown): TopicProjectionDiagnostics | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const input = value as Record<string, unknown>;
  if (!categories.includes(input.category as TopicFailureCategory)) return undefined;
  const result: TopicProjectionDiagnostics = { category: input.category as TopicFailureCategory,
    reason: typeof input.reason === 'string' && TOPIC_SAFE_REASONS.has(input.reason)
      ? input.reason : 'topic worker failed' };
  for (const key of ['eventCount', 'candidateTopicCount', 'estimatedInputTokens', 'requestedOutputTokens',
    'maxOutputTokens', 'modelCalls', 'attempt', 'splitDepth', 'actualCharacters', 'minCharacters', 'maxCharacters'] as const) {
    const number = input[key];
    if (typeof number === 'number' && Number.isSafeInteger(number) && number >= 0) result[key] = number;
  }
  if (typeof input.fieldPath === 'string' && /^topics\[\d{1,5}\]\.overview\[\d{1,5}\]\.text$/.test(input.fieldPath)) {
    result.fieldPath = input.fieldPath;
  }
  if (['stop', 'max-tokens', 'error', 'aborted', 'tool-calls', 'unknown'].includes(String(input.finishReason))) {
    result.finishReason = input.finishReason as string;
  }
  if (['requested-unverified', 'reasoning-observed', 'fallback', 'unavailable'].includes(String(input.reasoningOff))) {
    result.reasoningOff = input.reasoningOff as NonNullable<TopicProjectionDiagnostics['reasoningOff']>;
  }
  if (typeof input.reasoningObserved === 'boolean') result.reasoningObserved = input.reasoningObserved;
  return result;
}

export class TopicProjectionError extends Error {
  readonly diagnostics: TopicProjectionDiagnostics;
  constructor(category: TopicFailureCategory, reason: string,
    metadata: Partial<TopicProjectionDiagnostics> = {}) {
    const diagnostics = safeTopicDiagnostics({ ...metadata, category, reason })!;
    super(`${diagnostics.category}: ${diagnostics.reason}`);
    this.name = 'TopicProjectionError';
    this.diagnostics = diagnostics;
  }
}

/** Count Unicode code points consistently across the bridge and commit gate. */
export function validateTopicOverviewText(value: unknown, fieldPath: string,
  category: TopicFailureCategory = 'validation-failed'): asserts value is string {
  const count = typeof value === 'string' ? Array.from(value).length : undefined;
  const metadata = { fieldPath, minCharacters: 1, maxCharacters: TOPIC_OVERVIEW_MAX_CHARACTERS,
    ...(count === undefined ? {} : { actualCharacters: count }) };
  const reason = typeof value !== 'string' ? 'overview.text must be a string'
    : value.length === 0 ? 'overview.text is empty'
    : !value.trim() ? 'overview.text contains only whitespace'
    : count! > TOPIC_OVERVIEW_MAX_CHARACTERS ? 'overview.text exceeds the character limit' : null;
  if (reason) throw new TopicProjectionError(category, reason, metadata);
}
