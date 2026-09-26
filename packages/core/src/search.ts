const wordSegmenter = new Intl.Segmenter(undefined, { granularity: 'word' });

export function normalizeSearchText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Word segmentation handles whitespace-delimited languages while overlapping
 * Han bigrams preserve recall for names and domain terms with unstable
 * segmentation. The output is deterministic and does not require embeddings.
 */
export function searchTokens(value: string): string[] {
  const normalized = normalizeSearchText(value);
  if (!normalized) return [];
  const tokens: string[] = [];
  for (const part of wordSegmenter.segment(normalized)) {
    const segment = part.segment.trim();
    if (part.isWordLike && segment) tokens.push(`word:${segment}`);
  }
  for (const match of normalized.matchAll(/\p{Script=Han}+/gu)) {
    const characters = [...match[0]];
    if (characters.length === 1) tokens.push(`han1:${characters[0]}`);
    for (let index = 0; index < characters.length - 1; index += 1) {
      tokens.push(`han2:${characters[index]}${characters[index + 1]}`);
    }
  }
  return tokens;
}

export function fuzzySearchMatch(candidate: string, requested: string): boolean {
  const left = normalizeSearchText(candidate);
  const right = normalizeSearchText(requested);
  return Boolean(left && right && (left === right || left.includes(right) || right.includes(left)));
}

export function weightedSearchTokens(fields: ReadonlyArray<readonly [string, number]>): string[] {
  return fields.flatMap(([value, rawWeight]) => {
    const tokens = searchTokens(value);
    const weight = Math.max(1, Math.floor(rawWeight));
    return Array.from({ length: weight }, () => tokens).flat();
  });
}

export interface RankedItem<T> {
  item: T;
  score: number;
}

/** BM25 ranks only documents with a real query-term match. */
export function bm25Rank<T extends { id: string }>(
  items: readonly T[],
  query: string,
  document: (item: T) => string[],
): Array<RankedItem<T>> {
  const terms = [...new Set(searchTokens(query))];
  if (terms.length === 0 || items.length === 0) return [];
  const documents = items.map((item) => document(item));
  const averageLength = documents.reduce((total, tokens) => total + tokens.length, 0) / documents.length || 1;
  const documentFrequency = new Map<string, number>();
  for (const tokens of documents) {
    for (const token of new Set(tokens)) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    }
  }

  const k1 = 1.2;
  const b = 0.75;
  return items.map((item, index) => {
    const tokens = documents[index] ?? [];
    const frequencies = new Map<string, number>();
    for (const token of tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
    let score = 0;
    for (const term of terms) {
      const frequency = frequencies.get(term) ?? 0;
      if (frequency === 0) continue;
      const frequencyInDocuments = documentFrequency.get(term) ?? 0;
      const inverseDocumentFrequency = Math.log(
        1 + (items.length - frequencyInDocuments + 0.5) / (frequencyInDocuments + 0.5),
      );
      score += inverseDocumentFrequency * (
        (frequency * (k1 + 1))
        / (frequency + k1 * (1 - b + b * tokens.length / averageLength))
      );
    }
    return { item, score };
  }).filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || left.item.id.localeCompare(right.item.id));
}

/** Reciprocal-rank fusion combines independently auditable rankings. */
export function rrfRank<T extends { id: string }>(
  rankings: ReadonlyArray<readonly T[]>,
  weights?: ReadonlyArray<number>,
): Array<RankedItem<T>> {
  const fused = new Map<string, { item: T; score: number; bestRank: number }>();
  for (const [rankingIndex, ranking] of rankings.entries()) {
    const weight = weights?.[rankingIndex] ?? 1;
    if (!(weight > 0)) continue;
    ranking.forEach((item, index) => {
      const current = fused.get(item.id) ?? { item, score: 0, bestRank: Number.POSITIVE_INFINITY };
      current.score += weight / (60 + index + 1);
      current.bestRank = Math.min(current.bestRank, index);
      fused.set(item.id, current);
    });
  }
  return [...fused.values()]
    .sort((left, right) => right.score - left.score
      || left.bestRank - right.bestRank
      || left.item.id.localeCompare(right.item.id))
    .map(({ item, score }) => ({ item, score }));
}
