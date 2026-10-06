import { randomUUID } from 'node:crypto';
import type {
  CallOptions,
  IDocumentEnricher,
  IQueryEmbedding,
  IQueryPreprocessor,
  IRag,
  IRagBackendWriter,
  RagMetadata,
  RagResult,
  Result,
} from '@mcp-abap-adt/llm-agent';
import {
  matchesRagIdentity,
  RagError,
  ragIdentityFilter,
} from '@mcp-abap-adt/llm-agent';
import { tokenizeSearchText } from './tokenizer.js';

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function tokenize(text: string): string[] {
  return tokenizeSearchText(text);
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
  /** Cosine similarity above which an upsert without an id updates an existing
   *  record without an id (a record with an id is replaced only by the same id).
   *  Default: 0.92 */
  dedupThreshold?: number;
  /** Namespace for this store. Records with different namespace are invisible to query. */
  namespace?: string;
  /** Query preprocessors (translate, expand, etc.). Applied in order before embedding. */
  queryPreprocessors?: IQueryPreprocessor[];
  /** Document enrichers. Applied in order before embedding on upsert. */
  documentEnrichers?: IDocumentEnricher[];
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
  private readonly queryPreprocessors: IQueryPreprocessor[];
  private readonly documentEnrichers: IDocumentEnricher[];

  constructor(config?: InMemoryRagConfig) {
    this.dedupThreshold = config?.dedupThreshold ?? 0.92;
    this.namespace = config?.namespace;
    this.queryPreprocessors = config?.queryPreprocessors ?? [];
    this.documentEnrichers = config?.documentEnrichers ?? [];
  }

  async upsert(
    text: string,
    metadata: RagMetadata,
    options?: CallOptions,
  ): Promise<Result<void, RagError>> {
    if (options?.signal?.aborted) {
      return { ok: false, error: new RagError('Aborted', 'ABORTED') };
    }

    let enrichedText = text;
    for (const enricher of this.documentEnrichers) {
      const eResult = await enricher.enrich(enrichedText, options);
      if (!eResult.ok) return eResult;
      enrichedText = eResult.value;
    }

    const embedding = embed(enrichedText);
    const effectiveNamespace = metadata.namespace ?? this.namespace;
    const resolvedMetadata: RagMetadata = {
      ...metadata,
      namespace: effectiveNamespace,
    };

    // Idempotent upsert: if metadata.id matches, replace in-place
    if (metadata.id) {
      const idx = this.records.findIndex((r) => r.metadata.id === metadata.id);
      if (idx !== -1) {
        this.records[idx].text = enrichedText;
        this.records[idx].embedding = embedding;
        this.records[idx].metadata = {
          ...this.records[idx].metadata,
          ...resolvedMetadata,
        };
        return { ok: true, value: undefined };
      }
    }

    // Similarity dedup only between records written WITHOUT an id: a record
    // with an id is replaced only by the same id (above). Merging on
    // similarity alone let a near-identical tool record overwrite another
    // tool's record (ReadFunctionInclude vanished under ReadFunctionGroup).
    const candidates = metadata.id
      ? []
      : this.records.filter(
          (r) =>
            !r.metadata.id &&
            (this.namespace === undefined ||
              r.metadata.namespace === this.namespace),
        );

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
      dupRecord.text = enrichedText;
      dupRecord.embedding = embedding;
      dupRecord.metadata = { ...dupRecord.metadata, ...resolvedMetadata };
    } else {
      // Push new record
      this.records.push({
        id: randomUUID(),
        text: enrichedText,
        embedding,
        metadata: resolvedMetadata,
      });
    }

    return { ok: true, value: undefined };
  }

  async query(
    embedding: IQueryEmbedding,
    k: number,
    options?: CallOptions,
  ): Promise<Result<RagResult[], RagError>> {
    if (options?.signal?.aborted) {
      return { ok: false, error: new RagError('Aborted', 'ABORTED') };
    }

    const text = embedding.text;
    let searchText = text;
    for (const pp of this.queryPreprocessors) {
      const ppResult = await pp.process(searchText, options);
      if (!ppResult.ok) return ppResult;
      searchText = ppResult.value;
    }
    const queryEmbedding = embed(searchText);
    const nowSecs = Date.now() / 1000;
    const identity = ragIdentityFilter(options);
    const targetNamespace = options?.ragFilter?.namespace;

    // Filter BEFORE top-k: store namespace + the query's `ragFilter.namespace`
    // + TTL not expired + the sessionId/userId the query is scoped to.
    const candidates = this.records.filter((r) => {
      if (
        this.namespace !== undefined &&
        r.metadata.namespace !== this.namespace
      )
        return false;
      if (
        targetNamespace !== undefined &&
        r.metadata.namespace !== targetNamespace
      )
        return false;
      if (r.metadata.ttl !== undefined && r.metadata.ttl < nowSecs)
        return false;
      return matchesRagIdentity(r.metadata, identity);
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

  async getById(
    id: string,
    _options?: CallOptions,
  ): Promise<Result<RagResult | null, RagError>> {
    const record = this.records.find((r) => r.metadata.id === id);
    if (!record) return { ok: true, value: null };
    return {
      ok: true,
      value: { text: record.text, metadata: record.metadata, score: 1 },
    };
  }

  async healthCheck(): Promise<Result<void, RagError>> {
    return { ok: true, value: undefined };
  }

  clear(): void {
    this.records.length = 0;
  }

  writer(): IRagBackendWriter {
    return {
      upsertRaw: async (id, text, metadata, options) => {
        const res = await this.upsert(text, { ...metadata, id }, options);
        return res.ok ? { ok: true, value: undefined } : res;
      },
      deleteByIdRaw: async (id) => {
        const idx = this.records.findIndex((r) => r.metadata.id === id);
        if (idx === -1) return { ok: true, value: false };
        this.records.splice(idx, 1);
        return { ok: true, value: true };
      },
      clearAll: async () => {
        this.records.length = 0;
        return { ok: true, value: undefined };
      },
    };
  }
}
