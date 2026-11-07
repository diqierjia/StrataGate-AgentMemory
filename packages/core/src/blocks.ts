import type { BlockLevel, MemoryBlock, RawMessage, ToolTrace } from './types.js';

export const DEFAULT_BLOCK_TURN_SIZE = 12;
export const BLOCK_MAX_LEVEL = 5;
export const BLOCK_DECAY_LAMBDA = 0.3;

export interface BlockPosition {
  blockPosition: number;
  latestBlockPosition: number;
}

/** Sealed order is independent of derivation status and isolated per thread. */
export function buildBlockTimeline(
  blocks: readonly Pick<MemoryBlock, 'id' | 'threadId' | 'sequence'>[],
): Map<string, BlockPosition> {
  const threads = new Map<string | undefined, typeof blocks[number][]>();
  for (const block of blocks) {
    const thread = threads.get(block.threadId) ?? [];
    thread.push(block);
    threads.set(block.threadId, thread);
  }
  const positions = new Map<string, BlockPosition>();
  for (const thread of threads.values()) {
    thread.sort((a, b) => a.sequence - b.sequence);
    thread.forEach((block, index) => positions.set(block.id, {
      blockPosition: index + 1,
      latestBlockPosition: thread.length,
    }));
  }
  return positions;
}

export function getBlockDecayView(
  block: Pick<MemoryBlock, 'pointerAnchorLevel' | 'pointerAnchorBlockPosition'>,
  position: BlockPosition,
  lambda = BLOCK_DECAY_LAMBDA,
): { age: number; level: BlockLevel } {
  return {
    age: Math.max(0, position.latestBlockPosition - position.blockPosition),
    level: getDecayedBlockLevel(block.pointerAnchorLevel, block.pointerAnchorBlockPosition, position.latestBlockPosition, lambda),
  };
}

const FILLER_ONLY = new Set([
  'ok', 'okay', 'got it', 'thanks', 'thank you', 'yes', 'correct', 'sure',
  '好', '好的', '嗯', '嗯嗯', '明白', '收到', '谢谢', '感谢', '辛苦了',
  '是', '是的', '对', '对的', '没错', '可以', '行', '同意', '就这样',
]);

const REPEATED_PASTE_MIN_CHARS = 80;
const REPEATED_PASTE_MARKER = '[repeated paste omitted; original remains in L5]';
const DERIVATION_SOURCE_FIELD_MIN_CHARS = 240;
const DERIVATION_ARGUMENT_MAX_CHARS = 1_200;
const DERIVATION_RESULT_MAX_CHARS = 2_400;
const DERIVATION_TOOL_MESSAGE_MAX_CHARS = 2_400;
const DERIVATION_SOURCE_FIELD = /^(?:code|command|program|script|source|sourcecode)$/u;

function asBlockLevel(value: number): BlockLevel {
  return Math.max(0, Math.min(BLOCK_MAX_LEVEL, Math.round(value))) as BlockLevel;
}

export function getBlockWeight(
  anchorBlockPosition: number,
  latestBlockPosition: number,
  lambda = BLOCK_DECAY_LAMBDA,
): number {
  return Math.exp(-lambda * Math.max(0, latestBlockPosition - anchorBlockPosition));
}

export function getDecayedBlockLevel(
  anchorLevel: BlockLevel,
  anchorBlockPosition: number,
  latestBlockPosition: number,
  lambda = BLOCK_DECAY_LAMBDA,
): BlockLevel {
  const weight = getBlockWeight(anchorBlockPosition, latestBlockPosition, lambda);
  const droppedLevels = weight > 0.7
    ? 0
    : weight > 0.5
      ? 1
      : weight > 0.3
        ? 2
        : weight > 0.15
          ? 3
          : weight > 0.08
            ? 4
            : 5;
  return asBlockLevel(anchorLevel - droppedLevels);
}

export function normalizeBlockLevel(value: unknown, currentLevel: BlockLevel): BlockLevel {
  if (value === 'raw' || value === 'L5' || value === 5 || value === '5') return 5;
  if (value === 'next' || value === '+1' || value === undefined || value === null) return asBlockLevel(currentLevel + 1);
  if (typeof value === 'number' && Number.isFinite(value)) return asBlockLevel(value);
  if (typeof value === 'string' && /^L?[0-5]$/i.test(value.trim())) return asBlockLevel(Number(value.replace(/^L/i, '')));
  return asBlockLevel(currentLevel + 1);
}

export function blockLevelLabel(level: BlockLevel): string {
  return [
    'L0 title and tags',
    'L1 narrative summary',
    'L2 key points',
    'L3 rule-condensed transcript',
    'L4 readable near-verbatim transcript',
    'L5 raw transcript',
  ][level] ?? 'unknown';
}

function roleLabel(message: RawMessage, raw = false): string {
  const { role } = message;
  // Older synthetic provenance stored agent-authored facts with role=user.
  // Label their origin when rendering, keeping the stored source intact.
  if (role === 'user' && message.threadId?.startsWith('agent-memory:')) return 'Recorded';
  if (raw) return role;
  if (role === 'user') return 'User';
  if (role === 'assistant') return 'Assistant';
  if (role === 'tool') return 'Tool';
  return 'System';
}

function normalizedParagraph(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLocaleLowerCase();
}

function isFillerSentence(value: string): boolean {
  const normalized = value.trim().replace(/[。！？，、,.!?～~]+$/gu, '').trim().toLocaleLowerCase();
  return FILLER_ONLY.has(normalized);
}

function resultSummary(value: unknown): string {
  if (typeof value === 'string') {
    const text = value.replace(/\s+/g, ' ').trim();
    if (!text) return '';
    try {
      return resultSummary(JSON.parse(text));
    } catch {
      return text.slice(0, 160);
    }
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  if (typeof record.error === 'string') return `failed: ${record.error.replace(/\s+/g, ' ').slice(0, 140)}`;
  if (typeof record.summary === 'string') return record.summary.replace(/\s+/g, ' ').slice(0, 160);
  if (typeof record.message === 'string') return record.message.replace(/\s+/g, ' ').slice(0, 160);
  const counts = Object.entries(record)
    .filter(([key, item]) => !['arguments', 'params', 'input', 'request'].includes(key) && Array.isArray(item))
    .map(([key, item]) => `${key}: ${(item as unknown[]).length}`);
  if (counts.length > 0) return counts.join(', ').slice(0, 160);
  if (record.ok === true) return 'completed';
  if (record.ok === false) return 'not completed';
  return 'structured result returned';
}

function serializedValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function sourceFieldName(value: string): boolean {
  return DERIVATION_SOURCE_FIELD.test(value.replace(/[\s_-]+/gu, '').toLocaleLowerCase());
}

function omitLargeSourceFields(value: unknown, key = '', seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') {
    if (!sourceFieldName(key) || value.length <= DERIVATION_SOURCE_FIELD_MIN_CHARS) return value;
    return `[${key || 'source'} omitted: ${value.length} chars; full value remains in L5]`;
  }
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular value omitted; full value remains in L5]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => omitLargeSourceFields(item, key, seen));
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .map(([nestedKey, nestedValue]) => [nestedKey, omitLargeSourceFields(nestedValue, nestedKey, seen)]));
}

function compactDerivationValue(value: unknown, maxChars: number, label: string): unknown {
  const rendered = serializedValue(value);
  if (rendered.length <= maxChars) return value;
  const summary = resultSummary(value);
  const headChars = Math.max(160, Math.floor(maxChars * 0.48));
  const tailChars = Math.max(80, Math.floor(maxChars * 0.2));
  const omittedChars = Math.max(0, rendered.length - headChars - tailChars);
  return {
    _stratagate: `${label} compacted; full value remains in L5`,
    originalChars: rendered.length,
    ...(summary ? { summary } : {}),
    head: rendered.slice(0, headChars),
    tail: rendered.slice(-tailChars),
    omittedChars,
  };
}

function compactDerivationText(value: string, maxChars: number, label: string): string {
  if (value.length <= maxChars) return value;
  const headChars = Math.max(160, Math.floor(maxChars * 0.6));
  const tailChars = Math.max(80, Math.floor(maxChars * 0.2));
  const omittedChars = Math.max(0, value.length - headChars - tailChars);
  return `${value.slice(0, headChars)}\n[${label} compacted: ${omittedChars} chars omitted; full value remains in L5]\n${value.slice(-tailChars)}`;
}

/**
 * Builds the structured, provenance-preserving transcript used by memory
 * derivation model calls. It never mutates or replaces the stored L5 layer.
 */
export function buildMemoryDerivationMessages(messages: readonly RawMessage[]): RawMessage[] {
  return messages.map((message) => ({
    ...message,
    content: (message.role === 'tool' ? dailyToolJson(message.content) : undefined) ?? (message.role === 'tool'
      ? compactDerivationText(message.content, DERIVATION_TOOL_MESSAGE_MAX_CHARS, 'tool message content')
      : message.content),
    ...(message.toolCalls
      ? {
          toolCalls: message.toolCalls.map((trace) => {
            const daily = dailyToolSummary(trace);
            if (daily) return { name: trace.name, result: daily };
            const argumentsValue = trace.arguments === undefined
              ? undefined
              : compactDerivationValue(
                  omitLargeSourceFields(trace.arguments),
                  DERIVATION_ARGUMENT_MAX_CHARS,
                  'tool arguments',
                ) as Record<string, unknown>;
            return {
              name: trace.name,
              ...(argumentsValue === undefined ? {} : { arguments: argumentsValue }),
              ...(trace.result === undefined
                ? {}
                : { result: compactDerivationValue(trace.result, DERIVATION_RESULT_MAX_CHARS, 'tool result') }),
            };
          }),
        }
      : {}),
  }));
}

function dailyToolSummary(trace: ToolTrace): string | undefined {
  if (trace.name !== 'memory_daily_write' && trace.name !== 'memory_daily_read') return undefined;
  let result = trace.result;
  if (typeof result === 'string') { try { result = JSON.parse(result); } catch { result = {}; } }
  const saved = result && typeof result === 'object' ? result as Record<string, unknown> : {};
  const args = trace.arguments ?? {};
  const oneLine = (value: unknown) => String(value ?? '').replace(/[\r\n]+/g, ' ');
  return trace.name === 'memory_daily_write'
    ? `更新了 ${oneLine(saved.date ?? args.date ?? '今天')} 日记：《${oneLine(args.title)}》`
    : `读取了每日笔记（${oneLine(args.date ?? args.query ?? '最近日期')}）`;
}

function dailyToolJson(text: string): string | undefined {
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    return dailyToolSummary({ name: String(value.name ?? value.tool ?? ''), arguments: (value.arguments ?? value.parameters) as Record<string, unknown>, result: value.result });
  } catch { return undefined; }
}

function summarizeToolTrace(trace: ToolTrace): string {
  const daily = dailyToolSummary(trace);
  if (daily) return daily;
  const summary = resultSummary(trace.result);
  return `Tool call: ${trace.name}${summary ? ` (${summary})` : ''}`;
}

function summarizeToolJson(value: string): string | null {
  const daily = dailyToolJson(value);
  if (daily) return daily;
  const trimmed = value.trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '');
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const names = new Set<string>();
    const visit = (item: unknown): void => {
      if (!item || typeof item !== 'object') return;
      if (Array.isArray(item)) {
        item.forEach(visit);
        return;
      }
      const record = item as Record<string, unknown>;
      if (typeof record.name === 'string' && ('arguments' in record || 'parameters' in record)) names.add(record.name);
      if (typeof record.tool === 'string') names.add(record.tool);
      if (record.function && typeof record.function === 'object') {
        const name = (record.function as Record<string, unknown>).name;
        if (typeof name === 'string') names.add(name);
      }
      Object.values(record).forEach(visit);
    };
    visit(parsed);
    if (names.size === 0) return null;
    const summary = resultSummary(parsed.result ?? parsed.content);
    return `Tool call: ${[...names].join(', ')}${summary ? ` (${summary})` : ''}`;
  } catch {
    if (!/(tool_calls|tool_call|"function"|"arguments")/iu.test(trimmed)) return null;
    const names = [...trimmed.matchAll(/"name"\s*:\s*"([^"\\]+)"/gu)].map((match) => match[1]);
    return names.length > 0 ? `Tool call: ${[...new Set(names)].join(', ')} (raw arguments omitted)` : 'Tool call (raw arguments omitted)';
  }
}

function removeStandaloneFillers(paragraph: string): string {
  const pieces = paragraph
    .split(/(?<=[。！？!?])|\n+/u)
    .map((piece) => piece.trim())
    .filter(Boolean);
  const kept = pieces.filter((piece) => !isFillerSentence(piece));
  if (kept.length === pieces.length) return paragraph.trim();
  return kept.join('\n');
}

function splitTextAndCode(source: string): Array<{ text: string; isCode: boolean }> {
  const parts: Array<{ text: string; isCode: boolean }> = [];
  const fencedCode = /```[\s\S]*?```/gu;
  let cursor = 0;
  for (const match of source.matchAll(fencedCode)) {
    const index = match.index ?? 0;
    if (index > cursor) parts.push({ text: source.slice(cursor, index), isCode: false });
    parts.push({ text: match[0], isCode: true });
    cursor = index + match[0].length;
  }
  if (cursor < source.length) parts.push({ text: source.slice(cursor), isCode: false });
  return parts;
}

function looksLikeCode(value: string): boolean {
  return /\n/u.test(value) && /(?:^|\n)\s*(?:const|let|var|function|class|import|export|def|SELECT|INSERT|UPDATE)\b|=>|[{};]/mu.test(value);
}

function condenseMessage(content: string): Array<{ text: string; pasteCandidate: boolean }> {
  const source = content.trim();
  const toolSummary = summarizeToolJson(source);
  if (toolSummary) return [{ text: toolSummary, pasteCandidate: false }];
  return splitTextAndCode(source).flatMap(({ text, isCode }) => {
    if (isCode) return text.trim() ? [{ text: text.trim(), pasteCandidate: true }] : [];
    return text
      .split(/\n\s*\n+/u)
      .map(removeStandaloneFillers)
      .filter(Boolean)
      .map((paragraph) => ({
        text: paragraph,
        pasteCandidate: looksLikeCode(paragraph) || normalizedParagraph(paragraph).length >= REPEATED_PASTE_MIN_CHARS,
      }));
  });
}

export function formatReadableTranscript(messages: readonly RawMessage[]): string {
  return messages
    .filter((message) => message.role !== 'system')
    .flatMap((message) => {
      const text = message.content.trim();
      const inline = message.role === 'tool' ? summarizeToolJson(text) ?? text : text;
      const lines = inline ? [`${roleLabel(message)}: ${inline}`] : [];
      lines.push(...(message.toolCalls ?? []).map(summarizeToolTrace));
      return lines;
    })
    .join('\n\n');
}

function renderRawToolTrace(trace: ToolTrace): string {
  return `Tool call (raw): ${JSON.stringify(trace)}`;
}

export function formatRawTranscript(messages: readonly RawMessage[]): string {
  return messages
    .flatMap((message) => [
      `${roleLabel(message, true)}: ${message.content}`,
      ...(message.toolCalls ?? []).map(renderRawToolTrace),
    ])
    .join('\n\n');
}

const ATTACHMENT_REFERENCE_PREFIX = '[StrataGate attachment] ';

function attachmentReferences(messages: readonly RawMessage[]): string[] {
  return [...new Set(messages
    .flatMap((message) => message.content.split(/\r?\n/u))
    .filter((line) => line.startsWith(ATTACHMENT_REFERENCE_PREFIX)))];
}

/** Keep durable attachment identity visible in every rendered layer. */
export function preserveAttachmentReferences(content: string, messages: readonly RawMessage[]): string {
  const references = attachmentReferences(messages);
  if (references.length === 0 || references.every((reference) => content.includes(reference))) return content;
  return `${content}\n\nAttachments retained in source:\n${references.join('\n')}`;
}

export function estimateTokens(value: string): number {
  let tokens = 0;
  let asciiRun = 0;
  const flushAscii = (): void => {
    if (asciiRun > 0) tokens += Math.ceil(asciiRun / 4);
    asciiRun = 0;
  };
  for (const character of value) {
    if (character.codePointAt(0)! <= 0x7f) asciiRun += 1;
    else {
      flushAscii();
      tokens += 1;
    }
  }
  flushAscii();
  return tokens;
}

export function condenseTranscript(messages: readonly RawMessage[]): string {
  const seen = new Set<string>();
  return messages
    .filter((message) => message.role !== 'system')
    .flatMap((message) => {
      const parts = [
        ...condenseMessage(message.content),
        ...(message.toolCalls ?? []).map((trace) => ({ text: summarizeToolTrace(trace), pasteCandidate: false })),
      ];
      const rendered = parts.map((part) => {
        if (!part.pasteCandidate) return part.text;
        const key = normalizedParagraph(part.text);
        if (!seen.has(key)) {
          seen.add(key);
          return part.text;
        }
        return REPEATED_PASTE_MARKER;
      });
      return rendered.length > 0 ? [`${roleLabel(message)}: ${rendered.join('\n\n')}`] : [];
    })
    .join('\n\n');
}

export function cloneRawMessages(messages: readonly RawMessage[]): RawMessage[] {
  return messages.map((message) => ({
    ...message,
    ...(message.toolCalls
      ? { toolCalls: message.toolCalls.map((trace) => ({
        ...trace,
        ...(trace.arguments ? { arguments: { ...trace.arguments } } : {}),
      })) }
      : {}),
  }));
}

export function deterministicBlockLayers(messages: readonly RawMessage[]): Pick<
  import('./types.js').BlockLayers,
  'l3Condensed' | 'l4Readable' | 'l5Raw'
> {
  const l5Rendered = formatRawTranscript(messages);
  const readable = formatReadableTranscript(messages);
  // Daily traces must never fall back to raw bodies, even for tiny calls where
  // the explanatory summary is longer than the original JSON.
  const hasDailyTrace = messages.some(message => message.toolCalls?.some(trace => dailyToolSummary(trace) !== undefined) || (message.role === 'tool' && dailyToolJson(message.content) !== undefined));
  const l4Readable = hasDailyTrace || estimateTokens(readable) <= estimateTokens(l5Rendered) ? readable : l5Rendered;
  const condensed = condenseTranscript(messages);
  const l3Condensed = estimateTokens(condensed) <= estimateTokens(l4Readable) ? condensed : l4Readable;
  return {
    l3Condensed,
    l4Readable,
    l5Raw: cloneRawMessages(messages),
  };
}
