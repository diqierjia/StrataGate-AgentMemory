import { describe, expect, it } from 'vitest';
import { normalizeRetrievalAssessment } from '../src/index.js';

describe('evidence gate', () => {
  it.each(['wrong', 'partial', 'sufficient'] as const)('normalizes null refs like an empty array for %s without granting sufficiency', (verdict) => {
    const input = { verdict, fit: '', missing: 'No evidence adopted.', next_strategy: 'answer' }
    const normalized = normalizeRetrievalAssessment({ ...input, evidence_refs: null }, new Set(['fresh']))
    expect(normalized).toEqual(normalizeRetrievalAssessment({ ...input, evidence_refs: [] }, new Set(['fresh'])))
    expect(normalized.evidenceRefs).toEqual([])
    expect(normalized.verdict).not.toBe('sufficient')
  })

  it('accepts sufficient only with fresh evidence and the answer strategy', () => {
    expect(normalizeRetrievalAssessment({
      verdict: 'sufficient',
      evidence_refs: ['old'],
      fit: 'looks relevant',
      missing: '',
      next_strategy: 'answer',
    }, new Set(['fresh']))).toMatchObject({
      verdict: 'partial',
      evidenceRefs: [],
      rejectedEvidenceRefs: [{ ref: 'old', reason: 'not_in_batch' }],
    });

    expect(normalizeRetrievalAssessment({
      verdict: 'sufficient',
      evidence_refs: ['fresh'],
      fit: 'direct evidence',
      missing: '',
      next_strategy: 'answer',
    }, new Set(['fresh']))).toMatchObject({
      verdict: 'sufficient',
      evidenceRefs: ['fresh'],
      rejectedEvidenceRefs: [],
      nextStrategy: 'answer',
    });
  });

  it('reports every evidence ref that was not adopted', () => {
    expect(normalizeRetrievalAssessment({
      verdict: 'sufficient',
      evidence_refs: ['fresh', 'fresh', 'old', ''],
      fit: 'one direct source',
      missing: '',
      next_strategy: 'answer',
    }, new Set(['fresh']))).toMatchObject({
      verdict: 'sufficient',
      evidenceRefs: ['fresh'],
      rejectedEvidenceRefs: [
        { inputIndex: 1, ref: 'fresh', reason: 'duplicate' },
        { inputIndex: 2, ref: 'old', reason: 'not_in_batch' },
        { inputIndex: 3, ref: '', reason: 'invalid_ref' },
      ],
    });
  });
});
