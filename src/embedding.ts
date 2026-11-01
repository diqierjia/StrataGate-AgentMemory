import type { ResolvedConfig } from './config.js'

/**
 * Host-side bridge for the optional embedding API (semantic Event recall).
 *
 * All HTTP network calls live in the host layer — the core package never makes
 * network calls and never computes embeddings; it only receives a precomputed
 * ranking lane. This mirrors the existing DshModelBridge split.
 *
 * Everything is opt-in: when embeddingUrl / embeddingKey / embeddingModel are
 * not all configured, embeddingReady is false, every method returns null/empty,
 * and retrieval degrades to exactly the lexical behavior that shipped before.
 */
export class EmbeddingBridge {
  private readonly queryVectorCache = new Map<string, number[]>()
  private readonly queryVectorCacheOrder: string[] = []
  private static readonly QUERY_CACHE_LIMIT = 32

  constructor(private readonly config: ResolvedConfig) {}

  /** True when embedding is configured (URL + key + model all present). */
  get embeddingReady(): boolean {
    return Boolean(this.config.embeddingUrl?.trim() && this.config.embeddingKey?.trim() && this.config.embeddingModel?.trim())
  }

  /**
   * Compute the embedding vector for a query string. Repeated queries hit an
   * in-memory LRU cache, so a session that keeps asking in the same shape pays
   * for one call, not one per turn. Returns null when embedding is not
   * configured, the query is blank, or the call fails.
   */
  async embedQuery(query: string): Promise<number[] | null> {
    if (!this.embeddingReady || !query.trim()) return null
    const cached = this.queryVectorCache.get(query)
    if (cached) return cached
    try {
      const vector = await this.callEmbeddingApi([query])
      if (!vector || vector.length === 0) return null
      const first = vector[0]
      if (!first || first.length === 0) return null
      this.queryVectorCache.set(query, first)
      this.queryVectorCacheOrder.push(query)
      if (this.queryVectorCacheOrder.length > EmbeddingBridge.QUERY_CACHE_LIMIT) {
        const evicted = this.queryVectorCacheOrder.shift()
        if (evicted !== undefined) this.queryVectorCache.delete(evicted)
      }
      return first
    } catch {
      return null
    }
  }

  /**
   * Compute embedding vectors for Event texts (write and backfill path).
   * Returns null when embedding is not configured or the call fails, so the
   * caller writes nothing and retries later.
   */
  async embedEvents(texts: string[]): Promise<number[][] | null> {
    if (!this.embeddingReady || texts.length === 0) return null
    try {
      return await this.callEmbeddingApi(texts)
    } catch {
      return null
    }
  }

  /**
   * List available models from the embedding endpoint (/models).
   * Accepts optional {url, key} overrides so the settings UI can validate
   * credentials before saving them.
   */
  async listEmbeddingModels(override?: { url?: string; key?: string }): Promise<string[]> {
    return listEndpointModels((override?.url ?? this.config.embeddingUrl ?? '').trim(),
      (override?.key ?? this.config.embeddingKey ?? '').trim())
  }

  /** Cosine similarity between two vectors; 0 for mismatched or empty input. */
  static cosineSimilarity(a: readonly number[], b: readonly number[]): number {
    if (a.length !== b.length || a.length === 0) return 0
    let dot = 0
    let normA = 0
    let normB = 0
    for (let i = 0; i < a.length; i++) {
      const left = a[i]!
      const right = b[i]!
      dot += left * right
      normA += left * left
      normB += right * right
    }
    if (normA === 0 || normB === 0) return 0
    return dot / (Math.sqrt(normA) * Math.sqrt(normB))
  }

  private async callEmbeddingApi(texts: string[]): Promise<number[][] | null> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10_000)
    try {
      const response = await fetch(`${this.config.embeddingUrl!.trim()}/embeddings`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.config.embeddingKey!.trim()}`,
        },
        body: JSON.stringify({
          model: this.config.embeddingModel!.trim(),
          input: texts,
        }),
        signal: controller.signal,
      })
      if (!response.ok) return null
      const data = await response.json() as { data?: Array<{ embedding: number[] }> }
      if (!data.data || data.data.length !== texts.length) return null
      return data.data.map(({ embedding }) => embedding)
    } catch {
      // Abort (timeout) or network error: behave exactly like "unavailable".
      return null
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * Shared OpenAI-compatible /models listing with a hard 5-second timeout.
 * Empty result on any failure — model listing never throws to the caller.
 */
async function listEndpointModels(url: string, key: string): Promise<string[]> {
  if (!url || !key) return []
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5_000)
  try {
    const response = await fetch(`${url}/models`, {
      headers: { authorization: `Bearer ${key}` },
      signal: controller.signal,
    })
    if (!response.ok) return []
    const data = await response.json() as { data?: Array<{ id: string }> }
    return (data.data ?? []).map(({ id }) => id).filter(Boolean)
  } catch {
    return []
  } finally {
    clearTimeout(timer)
  }
}
