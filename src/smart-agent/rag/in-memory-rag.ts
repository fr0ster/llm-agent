import { randomUUID } from 'node:crypto';
import type { IRag } from '../interfaces/rag.js';
import type {
  CallOptions,
  RagMetadata,
  RagResult,
  Result,
} from '../interfaces/types.js';
import { RagError } from '../interfaces/types.js';

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

function embed(text: string): Map<string, number> {
  const tokens = tokenize(text);
  const freq = new Map<string, number>();
  for (const t of tokens) freq.set(t, (freq.get(t) ?? 0) + 1);
  const norm = Math.sqrt([...freq.values()].reduce((s, v) => s + v * v, 0));
  if (norm === 0) return freq;
  for (const [k, v] of freq) freq.set(k, v / norm);
  return freq;
}

function cosineSimilarity(
  a: Map<string, number>,
  b: Map<string, number>,
): number {
  let dot = 0;
  for (const [term, wa] of a) {
    const wb = b.get(term);
    if (wb !== undefined) dot += wa * wb;
  }
  return dot; // both are unit vectors → dot = cosine
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface InMemoryRagConfig {
  /** Cosine similarity above which upsert updates existing record. Default: 0.92 */
  dedupThreshold?: number;
  /** Namespace for this store. Records with different namespace are invisible to query. */
  namespace?: string;
}

// ---------------------------------------------------------------------------
// Internal record
// ---------------------------------------------------------------------------

interface StoredRecord {
  id: string;
  text: string;
  embedding: Map<string, number>;
  metadata: RagMetadata;
}

// ---------------------------------------------------------------------------
// InMemoryRag
// ---------------------------------------------------------------------------

export class InMemoryRag implements IRag {
  private records: StoredRecord[] = [];
  private readonly dedupThreshold: number;
  private readonly namespace?: string;

  constructor(config?: InMemoryRagConfig) {
    this.dedupThreshold = config?.dedupThreshold ?? 0.92;
    this.namespace = config?.namespace;
  }

  async upsert(
    text: string,
    metadata: RagMetadata,
    options?: CallOptions,
  ): Promise<Result<void, RagError>> {
    if (options?.signal?.aborted) {
      return { ok: false, error: new RagError('Aborted', 'ABORTED') };
    }

    const embedding = embed(text);
    const effectiveNamespace = metadata.namespace ?? this.namespace;
    const resolvedMetadata: RagMetadata = {
      ...metadata,
      namespace: effectiveNamespace,
    };

    // Filter existing records by same namespace
    const candidates =
      this.namespace !== undefined
        ? this.records.filter((r) => r.metadata.namespace === this.namespace)
        : this.records;

    // Find record with cosine similarity >= dedupThreshold
    let dupRecord: StoredRecord | undefined;
    for (const r of candidates) {
      if (cosineSimilarity(embedding, r.embedding) >= this.dedupThreshold) {
        dupRecord = r;
        break;
      }
    }

    if (dupRecord !== undefined) {
      // Update existing record
      dupRecord.text = text;
      dupRecord.embedding = embedding;
      dupRecord.metadata = { ...dupRecord.metadata, ...resolvedMetadata };
    } else {
      // Push new record
      this.records.push({
        id: randomUUID(),
        text,
        embedding,
        metadata: resolvedMetadata,
      });
    }

    return { ok: true, value: undefined };
  }

  async query(
    text: string,
    k: number,
    options?: CallOptions,
  ): Promise<Result<RagResult[], RagError>> {
    if (options?.signal?.aborted) {
      return { ok: false, error: new RagError('Aborted', 'ABORTED') };
    }

    const queryEmbedding = embed(text);
    const nowSecs = Date.now() / 1000;

    // Filter: namespace match + TTL not expired
    const candidates = this.records.filter((r) => {
      if (
        this.namespace !== undefined &&
        r.metadata.namespace !== this.namespace
      )
        return false;
      if (r.metadata.ttl !== undefined && r.metadata.ttl < nowSecs)
        return false;
      return true;
    });

    // Compute cosine similarity for each candidate
    const scored = candidates.map((r) => ({
      text: r.text,
      metadata: r.metadata,
      score: cosineSimilarity(queryEmbedding, r.embedding),
    }));

    // Sort desc by score, take top k
    scored.sort((a, b) => b.score - a.score);
    const results: RagResult[] = scored.slice(0, k);

    return { ok: true, value: results };
  }

  async healthCheck(): Promise<Result<void, RagError>> {
    return { ok: true, value: undefined };
  }
}
