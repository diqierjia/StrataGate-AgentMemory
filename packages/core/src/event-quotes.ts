import { normalizeSearchText, searchTokens } from './search.js';
import type { RawMessage } from './types.js';

/** A stable explanation shown when a quote was selected by this helper. */
export const AUTO_EXTRACTED_QUOTES_NOTICE = '引用逐字摘自来源消息，由相似度算法选择，未独立验证其是否充分支持事件摘要。';

interface QuoteCandidate {
  text: string;
  messageIndex: number;
  candidateIndex: number;
  role: RawMessage['role'];
  score: number;
}

function fragments(content: string): string[] {
  const trimmed = content.trim();
  if (!trimmed) return [];
  const parts = trimmed
    .split(/(?<=[。！？!?；;\n])/u)
    .flatMap((part) => part.length > 260 ? part.split(/(?<=[，,、])/u) : [part])
    .map((part) => part.trim())
    .filter((part) => [...part].length >= 4);
  // A short source message is often the best evidence as a whole. Keep it as
  // a candidate while still preferring a focused sentence when one exists.
  if ([...trimmed].length <= 260 && !parts.includes(trimmed)) parts.push(trimmed);
  return [...new Set(parts)];
}

/**
 * Select one verbatim source fragment for an Event summary. The score is only
 * a deterministic relevance filter; the returned text is always an exact
 * substring of one of the supplied raw messages.
 */
export function findBestVerbatimQuote(query: string, messages: readonly RawMessage[]): string | null {
  const queryTokens = [...new Set(searchTokens(query))];
  if (queryTokens.length === 0) return null;
  const querySet = new Set(queryTokens);
  const candidates: QuoteCandidate[] = [];
  for (const [messageIndex, message] of messages.entries()) {
    for (const [candidateIndex, text] of fragments(message.content).entries()) {
      const normalized = normalizeSearchText(text);
      if (!normalized || !normalizeSearchText(message.content).includes(normalized)) continue;
      let overlap = 0;
      for (const token of new Set(searchTokens(text))) if (querySet.has(token)) overlap += 1;
      const minimumOverlap = queryTokens.length <= 2 ? 1 : Math.max(2, Math.ceil(queryTokens.length * 0.2));
      if (overlap < minimumOverlap) continue;
      const coverage = overlap / queryTokens.length;
      const roleBonus = message.role === 'user' ? 0.75 : 0;
      // Slightly prefer concise, evidence-like fragments over an entire long
      // message, while retaining deterministic source ordering as a tie break.
      const lengthPenalty = Math.min(1, Math.max(0, ([...text].length - 120) / 240));
      candidates.push({ text, messageIndex, candidateIndex, role: message.role,
        score: overlap * 2 + coverage * 8 + roleBonus - lengthPenalty });
    }
  }
  candidates.sort((left, right) => right.score - left.score
    || (left.role === 'user' ? 0 : 1) - (right.role === 'user' ? 0 : 1)
    || left.messageIndex - right.messageIndex
    || left.candidateIndex - right.candidateIndex
    || left.text.localeCompare(right.text));
  return candidates[0]?.text ?? null;
}
