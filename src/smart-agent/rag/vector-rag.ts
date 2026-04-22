import type { IQueryEmbedding } from '../interfaces/query-embedding.js';
import type {
  IEmbedder,
  IPrecomputedVectorRag,
  IRagBackendWriter,
} from '../interfaces/rag.js';
import {
  type CallOptions,
  RagError,
  type RagMetadata,
  type RagResult,
  type Result,
} from '../interfaces/types.js';
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

interface StoredRecord {
  text: string;
  vector: number[];
  metadata: RagMetadata;
}

export interface VectorRagConfig {
  /** Cosine similarity threshold for dedup. Default: 0.92 */
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

export class VectorRag implements IPrecomputedVectorRag {
  private records: (StoredRecord | null)[] = [];
  private readonly index = new InvertedIndex();
  private readonly dedupThreshold: number;
  private readonly namespace?: string;
  private vectorWeight: number;
  private keywordWeight: number;
  private strategy: ISearchStrategy;
  private readonly queryPreprocessors: IQueryPreprocessor[];
  private readonly documentEnrichers: IDocumentEnricher[];

  constructor(
    private readonly embedder: IEmbedder,
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
    return s
      .toLowerCase()
      .split(/[^a-z0-9]/)
      .filter((t) => t.length > 1);
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
    const newTokens = this.tokenize(text);

    // Idempotent upsert: if metadata.id matches, replace in-place
    if (metadata.id) {
      for (let i = 0; i < this.records.length; i++) {
        const slot = this.records[i];
        if (slot === null) continue;
        if (slot.metadata.id === metadata.id) {
          const oldTokens = this.tokenize(slot.text);
          slot.text = text;
          slot.vector = vector;
          slot.metadata = { ...slot.metadata, ...metadata };
          this.index.update(i, oldTokens, newTokens);
          return { ok: true, value: undefined };
        }
      }
    }

    for (let i = 0; i < this.records.length; i++) {
      const slot = this.records[i];
      if (slot === null) continue;
      if (this.cosine(slot.vector, vector) >= this.dedupThreshold) {
        const oldTokens = this.tokenize(slot.text);
        slot.text = text;
        slot.vector = vector;
        slot.metadata = { ...slot.metadata, ...metadata };
        this.index.update(i, oldTokens, newTokens);
        return { ok: true, value: undefined };
      }
    }

    // Reuse a tombstone slot if available
    const freeIdx = this.records.indexOf(null);
    if (freeIdx !== -1) {
      this.records[freeIdx] = { text, vector, metadata };
      this.index.add(freeIdx, newTokens);
    } else {
      const docIdx = this.records.length;
      this.records.push({ text, vector, metadata });
      this.index.add(docIdx, newTokens);
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
      const { vector } = await this.embedder.embed(enrichedText, options);
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
          ),
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
      const context: ISearchContext = {
        index: this.index,
        tokenize: this.tokenize.bind(this),
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
      await this.embedder.embed('ping', options);
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
            this.index.remove(i, this.tokenize(r.text));
            this.records[i] = null;
            return { ok: true, value: true };
          }
        }
        return { ok: true, value: false };
      },
      clearAll: async () => {
        this.records.length = 0;
        this.index.clear();
        return { ok: true, value: undefined };
      },
    };
  }

  clear(): void {
    this.records.length = 0;
    this.index.clear();
  }
}
