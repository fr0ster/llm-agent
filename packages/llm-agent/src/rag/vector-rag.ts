import type { IQueryEmbedding } from '../interfaces/query-embedding.js';
import type {
  IRag,
  IRagBackendWriter,
  IRetrievalEmbedder,
} from '../interfaces/rag.js';
import {
  type CallOptions,
  RagError,
  type RagMetadata,
  type RagResult,
  type Result,
} from '../interfaces/types.js';
import { matchesRagIdentity, ragIdentityFilter } from './identity-filter.js';
import { InvertedIndex } from './inverted-index.js';
import type { IDocumentEnricher, IQueryPreprocessor } from './preprocessor.js';
import { FallbackQueryEmbedding, QueryEmbedding } from './query-embedding.js';
import type {
  ISearchCandidate,
  ISearchContext,
  ISearchQuery,
  ISearchStrategy,
} from './search-strategy.js';
import { WeightedFusionStrategy } from './search-strategy.js';
import { tokenizeSearchText } from './tokenizer.js';

interface StoredRecord {
  text: string;
  vector: number[];
  metadata: RagMetadata;
}

export interface VectorRagConfig {
  /** Cosine similarity threshold for dedup of records written without an id
   *  (a record with an id is replaced only by the same id). Default: 0.92 */
  dedupThreshold?: number;
  /** Namespace for this store. */
  namespace?: string;
  /** Weight for vector search (0..1). Default: 0.7 */
  vectorWeight?: number;
  /** Weight for keyword search (0..1). Default: 0.3 */
  keywordWeight?: number;
  /** Search scoring strategy. Default: WeightedFusionStrategy with the configured weights. */
  strategy?: ISearchStrategy;
  /** Query preprocessors (translate, expand, etc.). Applied in order before embedding. */
  queryPreprocessors?: IQueryPreprocessor[];
  /** Document enrichers. Applied in order before embedding on upsert. */
  documentEnrichers?: IDocumentEnricher[];
}

export class VectorRag implements IRag {
  private records: (StoredRecord | null)[] = [];
  private readonly dedupThreshold: number;
  private readonly namespace?: string;
  private vectorWeight: number;
  private keywordWeight: number;
  private strategy: ISearchStrategy;
  private readonly queryPreprocessors: IQueryPreprocessor[];
  private readonly documentEnrichers: IDocumentEnricher[];
  /**
   * `embedder` writes the records (`embedDocument`) and embeds the search text
   * this store embeds itself (`embedQuery`) — a text-only query, a
   * preprocessed one, a failed caller embedding.
   */
  constructor(
    private readonly embedder: IRetrievalEmbedder,
    config: VectorRagConfig = {},
  ) {
    this.dedupThreshold = config.dedupThreshold ?? 0.92;
    this.namespace = config.namespace;
    this.vectorWeight = config.vectorWeight ?? 0.7;
    this.keywordWeight = config.keywordWeight ?? 0.3;
    this.strategy =
      config.strategy ??
      new WeightedFusionStrategy({
        vectorWeight: this.vectorWeight,
        keywordWeight: this.keywordWeight,
      });
    this.queryPreprocessors = config.queryPreprocessors ?? [];
    this.documentEnrichers = config.documentEnrichers ?? [];
  }

  /** Update hybrid search weights at runtime (hot-reload). */
  updateWeights(config: {
    vectorWeight?: number;
    keywordWeight?: number;
  }): void {
    if (config.vectorWeight !== undefined)
      this.vectorWeight = config.vectorWeight;
    if (config.keywordWeight !== undefined)
      this.keywordWeight = config.keywordWeight;
    if (this.strategy.name === 'weighted-fusion') {
      this.strategy = new WeightedFusionStrategy({
        vectorWeight: this.vectorWeight,
        keywordWeight: this.keywordWeight,
      });
    }
  }

  private tokenize(s: string): string[] {
    return tokenizeSearchText(s);
  }

  private cosine(a: number[], b: number[]): number {
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      na += a[i] ** 2;
      nb += b[i] ** 2;
    }
    return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
  }

  private upsertKnownVector(
    text: string,
    vector: number[],
    metadata: RagMetadata,
  ): Result<void, RagError> {
    // Idempotent upsert: if metadata.id matches, replace in-place
    if (metadata.id) {
      for (let i = 0; i < this.records.length; i++) {
        const slot = this.records[i];
        if (slot === null) continue;
        if (slot.metadata.id === metadata.id) {
          slot.text = text;
          slot.vector = vector;
          slot.metadata = { ...slot.metadata, ...metadata };
          return { ok: true, value: undefined };
        }
      }
    }

    // Similarity dedup only between records written WITHOUT an id: a record
    // with an id is replaced only by the same id (above). Merging on
    // similarity alone let a near-identical tool record overwrite another
    // tool's record (ReadFunctionInclude vanished under ReadFunctionGroup).
    for (let i = 0; !metadata.id && i < this.records.length; i++) {
      const slot = this.records[i];
      if (slot === null || slot.metadata.id) continue;
      if (this.cosine(slot.vector, vector) >= this.dedupThreshold) {
        slot.text = text;
        slot.vector = vector;
        slot.metadata = { ...slot.metadata, ...metadata };
        return { ok: true, value: undefined };
      }
    }

    // Reuse a tombstone slot if available
    const freeIdx = this.records.indexOf(null);
    if (freeIdx !== -1) {
      this.records[freeIdx] = { text, vector, metadata };
    } else {
      this.records.push({ text, vector, metadata });
    }
    return { ok: true, value: undefined };
  }

  async upsert(
    text: string,
    metadata: RagMetadata,
    options?: CallOptions,
  ): Promise<Result<void, RagError>> {
    if (options?.signal?.aborted) {
      return { ok: false, error: new RagError('Aborted', 'ABORTED') };
    }

    if (
      this.namespace !== undefined &&
      metadata.namespace !== undefined &&
      metadata.namespace !== this.namespace
    ) {
      return { ok: true, value: undefined };
    }

    try {
      let enrichedText = text;
      for (const enricher of this.documentEnrichers) {
        const eResult = await enricher.enrich(enrichedText, options);
        if (eResult.ok) enrichedText = eResult.value;
      }
      const { vector } = await this.embedder.embedDocument(
        enrichedText,
        options,
      );
      return this.upsertKnownVector(enrichedText, vector, metadata);
    } catch (err) {
      if (err instanceof RagError) return { ok: false, error: err };
      return { ok: false, error: new RagError(String(err), 'UPSERT_ERROR') };
    }
  }

  async upsertPrecomputed(
    text: string,
    vector: number[],
    metadata: RagMetadata,
    _options?: CallOptions,
  ): Promise<Result<void, RagError>> {
    try {
      return this.upsertKnownVector(text, vector, metadata);
    } catch (err) {
      if (err instanceof RagError) return { ok: false, error: err };
      return { ok: false, error: new RagError(String(err), 'UPSERT_ERROR') };
    }
  }

  async query(
    embedding: IQueryEmbedding,
    k: number,
    options?: CallOptions,
  ): Promise<Result<RagResult[], RagError>> {
    if (options?.signal?.aborted) {
      return { ok: false, error: new RagError('Aborted', 'ABORTED') };
    }

    try {
      const text = embedding.text;
      let searchText = text;
      for (const pp of this.queryPreprocessors) {
        const ppResult = await pp.process(searchText, options);
        if (ppResult.ok) searchText = ppResult.value;
      }
      const nowSecs = Date.now() / 1000;
      // If preprocessors transformed the text, embed the transformed version
      const effectiveEmbedding =
        searchText !== text
          ? new QueryEmbedding(searchText, this.embedder, options)
          : new FallbackQueryEmbedding(embedding, this.embedder);
      const queryVector = await effectiveEmbedding.toVector();
      const targetNamespace = options?.ragFilter?.namespace;
      const identity = ragIdentityFilter(options);

      // Filtered BEFORE the strategy scores and top-k slices, so a scoped
      // query still gets up to k of its own records.
      const filtered = this.records.filter(
        (r): r is StoredRecord =>
          r !== null &&
          !(r.metadata.ttl !== undefined && r.metadata.ttl < nowSecs) &&
          !(
            targetNamespace !== undefined &&
            r.metadata.namespace !== targetNamespace
          ) &&
          !(
            this.namespace !== undefined &&
            r.metadata.namespace !== undefined &&
            r.metadata.namespace !== this.namespace
          ) &&
          matchesRagIdentity(r.metadata, identity),
      );

      const candidates: ISearchCandidate[] = filtered.map((r) => ({
        text: r.text,
        vector: r.vector,
        metadata: r.metadata,
      }));

      const searchQuery: ISearchQuery = {
        text: searchText,
        vector: queryVector,
      };
      // Keyword statistics over THESE candidates only, never the whole store
      // — see ISearchContext.index. Built on first read: the built-in
      // strategies compute their own from `candidates` and never read it.
      const tokenize = this.tokenize.bind(this);
      let candidateIndex: InvertedIndex | undefined;
      const context: ISearchContext = {
        get index() {
          if (!candidateIndex) {
            candidateIndex = new InvertedIndex();
            candidates.forEach((c, i) => {
              candidateIndex?.add(i, tokenize(c.text));
            });
          }
          return candidateIndex;
        },
        tokenize,
      };

      const scored = this.strategy
        .score(searchQuery, candidates, context)
        .slice(0, k);

      return { ok: true, value: scored };
    } catch (err) {
      if (err instanceof RagError) return { ok: false, error: err };
      return { ok: false, error: new RagError(String(err), 'QUERY_ERROR') };
    }
  }

  async healthCheck(options?: CallOptions): Promise<Result<void, RagError>> {
    try {
      await this.embedder.embedQuery('ping', options);
      return { ok: true, value: undefined };
    } catch (err) {
      return {
        ok: false,
        error: new RagError(
          `RAG health check failed: ${String(err)}`,
          'HEALTH_CHECK_ERROR',
        ),
      };
    }
  }

  async getById(
    id: string,
    _options?: CallOptions,
  ): Promise<Result<RagResult | null, RagError>> {
    for (const r of this.records) {
      if (r !== null && r.metadata.id === id) {
        return {
          ok: true,
          value: { text: r.text, metadata: r.metadata, score: 1 },
        };
      }
    }
    return { ok: true, value: null };
  }

  writer(): IRagBackendWriter {
    return {
      upsertRaw: async (id, text, metadata, options) => {
        const res = await this.upsert(text, { ...metadata, id }, options);
        return res.ok ? { ok: true, value: undefined } : res;
      },
      deleteByIdRaw: async (id) => {
        for (let i = 0; i < this.records.length; i++) {
          const r = this.records[i];
          if (r !== null && r.metadata.id === id) {
            this.records[i] = null;
            return { ok: true, value: true };
          }
        }
        return { ok: true, value: false };
      },
      clearAll: async () => {
        this.records.length = 0;
        return { ok: true, value: undefined };
      },
      upsertPrecomputedRaw: async (id, text, vector, metadata, options) => {
        return this.upsertPrecomputed(
          text,
          vector,
          { ...metadata, id },
          options,
        );
      },
    };
  }

  clear(): void {
    this.records.length = 0;
  }
}
