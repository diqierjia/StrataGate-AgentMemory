export const RETRIEVAL_CONTRACT_VERSION = 7;

export const RETRIEVAL_STRATEGIES = [
  'answer',
  'search_events',
  'expand_event',
  'search_graph',
  'expand_graph_node',
  'search_elements',
  'expand_element',
  'search_raw_memory',
  'expand_block',
] as const;

export type RetrievalVerdict = 'sufficient' | 'partial' | 'wrong';
export type RetrievalStrategy = typeof RETRIEVAL_STRATEGIES[number];

export type RejectedEvidenceReason = 'invalid_ref' | 'duplicate' | 'not_in_batch' | 'limit_exceeded';

export interface RejectedEvidenceRef {
  inputIndex: number;
  ref: string;
  reason: RejectedEvidenceReason;
  detail: string;
}

export interface RetrievalAssessment {
  verdict: RetrievalVerdict;
  evidenceRefs: string[];
  rejectedEvidenceRefs: RejectedEvidenceRef[];
  fit: string;
  missing: string;
  nextStrategy: RetrievalStrategy;
}

export interface RetrievalAssessmentInput {
  verdict?: unknown;
  evidence_refs?: unknown;
  fit?: unknown;
  missing?: unknown;
  next_strategy?: unknown;
}

export const RETRIEVAL_ASSESSMENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: ['sufficient', 'partial', 'wrong'] },
    evidence_refs: { oneOf: [{ type: 'array', maxItems: 8, items: { type: 'string' } }, { type: 'null' }] },
    fit: { type: 'string', maxLength: 160 },
    missing: { type: 'string', maxLength: 160 },
    next_strategy: { type: 'string', enum: RETRIEVAL_STRATEGIES },
  },
  required: ['verdict', 'evidence_refs', 'fit', 'missing', 'next_strategy'],
} as const;

function shortText(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, 160) : '';
}

function normalizeStrategy(value: unknown): RetrievalStrategy {
  return typeof value === 'string' && (RETRIEVAL_STRATEGIES as readonly string[]).includes(value)
    ? value as RetrievalStrategy
    : 'search_events';
}

/**
 * The gate rejects a "sufficient" decision unless it points to evidence from
 * the selected retrieval batch and explicitly selects the answer step.
 */
export function normalizeRetrievalAssessment(
  input: RetrievalAssessmentInput,
  batchEvidenceRefs: ReadonlySet<string>,
): RetrievalAssessment {
  const requestedVerdict: RetrievalVerdict = input.verdict === 'sufficient' || input.verdict === 'wrong'
    ? input.verdict
    : 'partial';
  const evidenceRefs: string[] = [];
  const rejectedEvidenceRefs: RejectedEvidenceRef[] = [];
  const seen = new Set<string>();
  const requestedRefs = Array.isArray(input.evidence_refs) ? input.evidence_refs : [];
  for (const [inputIndex, value] of requestedRefs.entries()) {
    if (typeof value !== 'string' || value.length === 0) {
      rejectedEvidenceRefs.push({
        inputIndex,
        ref: typeof value === 'string' ? value : String(value),
        reason: 'invalid_ref',
        detail: 'Evidence refs must be non-empty strings returned by a retrieval batch.',
      });
      continue;
    }
    if (seen.has(value)) {
      rejectedEvidenceRefs.push({
        inputIndex,
        ref: value,
        reason: 'duplicate',
        detail: 'This ref was already included earlier in the same assessment.',
      });
      continue;
    }
    seen.add(value);
    if (!batchEvidenceRefs.has(value)) {
      rejectedEvidenceRefs.push({
        inputIndex,
        ref: value,
        reason: 'not_in_batch',
        detail: 'This ref was not returned by the selected retrieval batch.',
      });
      continue;
    }
    if (evidenceRefs.length >= 8) {
      rejectedEvidenceRefs.push({
        inputIndex,
        ref: value,
        reason: 'limit_exceeded',
        detail: 'At most 8 unique evidence refs can be adopted by one assessment.',
      });
      continue;
    }
    evidenceRefs.push(value);
  }
  const requestedStrategy = normalizeStrategy(input.next_strategy);
  const sufficient = requestedVerdict === 'sufficient' && evidenceRefs.length > 0 && requestedStrategy === 'answer';

  return {
    verdict: sufficient ? 'sufficient' : requestedVerdict === 'wrong' ? 'wrong' : 'partial',
    evidenceRefs,
    rejectedEvidenceRefs,
    fit: shortText(input.fit),
    missing: sufficient ? '' : shortText(input.missing) || 'Direct evidence required to answer the question is still missing.',
    nextStrategy: sufficient ? 'answer' : requestedStrategy === 'answer' ? 'search_events' : requestedStrategy,
  };
}
