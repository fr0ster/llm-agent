import { randomUUID as listStoreId, randomUUID } from 'node:crypto';
import { contextExceededError } from '../errors/terminal-run-error.js';
import type { IQueryEmbedding } from '../interfaces/query-embedding.js';
import type {
  IRag,
  IRagBackendWriter,
  IRetrievalEmbedder,
  RagDocumentVectors,
  RagListPage,
  RagListParams,
} from '../interfaces/rag.js';
import {
  assertNonEmptyFilter,
  type IRagFilteredDeleter,
  type IRagScanner,
  matchesScanFilter,
  type RagScanFilter,
  type RagScanPage,
} from '../interfaces/rag-scan.js';
import {
  type CallOptions,
  RagError,
  type RagMetadata,
  type RagResult,
  type Result,
} from '../interfaces/types.js';
import {
  matchesRagIdentity,
  ragIdentityFilter,
  tagRagMetadata,
} from './identity-filter.js';
import { InvertedIndex } from './inverted-index.js';
import { listKeyedPage } from './list-support.js';
import type { IDocumentEnricher, IQueryPreprocessor } from './preprocessor.js';
import {
  FallbackQueryEmbedding,
  QueryEmbedding,
  TextOnlyEmbedding,
} from './query-embedding.js';
import {
  embedRecord,
  type RecordEmbeddingConfig,
  recordVectors,
} from './record-embedding.js';
import { scanKeyedPage } from './scan-support.js';
import type {
  ISearchCandidate,
  ISearchContext,
  ISearchQuery,
  ISearchStrategy,
} from './search-strategy.js';
import { WeightedFusionStrategy } from './search-strategy.js';
import { tokenizeSearchText } from './tokenizer.js';
import { cosineSimilarity } from './vector-similarity.js';

interface StoredRecord {
  id: string;
  text: string;
  vector: number[];
  extraVectors?: number[][];
  metadata: RagMetadata;
}

export interface VectorRagConfig extends RecordEmbeddingConfig {
  /** Retry a failed caller query embedding with the store embedder. Default: true.
   *  TextOnlyEmbedding is always embedded by the store, regardless of this option. */
  fallbackOnQueryEmbeddingError?: boolean;
  /** @deprecated Anonymous records are deduplicated by exact document text. */
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

export class VectorRag implements IRag, IRagScanner, IRagFilteredDeleter {
  private readonly listStore = listStoreId();
  private records: (StoredRecord | null)[] = [];
  private readonly namespace?: string;
  private readonly fragmentSizeChars?: number;
  private vectorWeight: number;
  private keywordWeight: number;
  private strategy: ISearchStrategy;
  private readonly queryPreprocessors: IQueryPreprocessor[];
  private readonly documentEnrichers: IDocumentEnricher[];
  private readonly fallbackOnQueryEmbeddingError: boolean;
  /**
   * `embedder` writes the records (`embedDocument`) and embeds the search text
   * this store embeds itself (`embedQuery`) — a text-only query, a
   * preprocessed one, a failed caller embedding.
   */
  constructor(
    private readonly embedder: IRetrievalEmbedder,
    config: VectorRagConfig = {},
  ) {
    this.namespace = config.namespace;
    this.fragmentSizeChars = config.fragmentSizeChars;
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
    this.fallbackOnQueryEmbeddingError =
      config.fallbackOnQueryEmbeddingError ?? true;
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

  private upsertKnownVectors(
    text: string,
    [vector, ...extra]: number[][],
    metadata: RagMetadata,
  ): Result<void, RagError> {
    const extraVectors = extra.length > 0 ? extra : undefined;
    // Generated IDs remain reserved while their anonymous record exists.
    metadata = tagRagMetadata(metadata);
    if (metadata.ownerScope === 'invalid')
      return {
        ok: false,
        error: new RagError(
          'Conflicting owner scope and identity keys',
          'INVALID_ARGUMENT',
        ),
      };
    if (
      this.records.some(
        (r) =>
          r !== null && r.metadata.id === undefined && r.id === metadata.id,
      )
    )
      return {
        ok: false,
        error: new RagError(
          'ID belongs to an anonymous record',
          'INVALID_ARGUMENT',
        ),
      };

    // Idempotent upsert: if metadata.id matches, replace in-place
    if (metadata.id) {
      for (let i = 0; i < this.records.length; i++) {
        const slot = this.records[i];
        if (slot === null) continue;
        if (slot.metadata.id === metadata.id) {
          const merged = tagRagMetadata({ ...slot.metadata, ...metadata });
          if (merged.ownerScope === 'invalid')
            return {
              ok: false,
              error: new RagError(
                'Conflicting owner scope and identity keys',
                'INVALID_ARGUMENT',
              ),
            };
          slot.text = text;
          slot.vector = vector;
          slot.extraVectors = extraVectors;
          slot.metadata = merged;
          return { ok: true, value: undefined };
        }
      }
    }

    // Exact document dedup applies only to records written without an id.
    for (let i = 0; !metadata.id && i < this.records.length; i++) {
      const slot = this.records[i];
      if (slot === null || slot.metadata.id) continue;
      if (
        tagRagMetadata({ ...slot.metadata, ...metadata }).ownerScope !==
          'invalid' &&
        slot.text === text
      ) {
        slot.text = text;
        slot.vector = vector;
        slot.extraVectors = extraVectors;
        slot.metadata = tagRagMetadata({ ...slot.metadata, ...metadata });
        return { ok: true, value: undefined };
      }
    }

    // Reuse a tombstone slot if available
    const freeIdx = this.records.indexOf(null);
    if (freeIdx !== -1) {
      this.records[freeIdx] = {
        id: this.newRecordId(),
        text,
        vector,
        extraVectors,
        metadata,
      };
    } else {
      this.records.push({
        id: this.newRecordId(),
        text,
        vector,
        extraVectors,
        metadata,
      });
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
        else {
          const terminal = contextExceededError(eResult.error);
          if (terminal) return { ok: false, error: terminal };
        }
      }
      const vectors = await embedRecord(
        this.embedder,
        enrichedText,
        this.fragmentSizeChars,
        options,
      );
      options?.signal?.throwIfAborted();
      return this.upsertKnownVectors(enrichedText, vectors, metadata);
    } catch (err) {
      const terminal = contextExceededError(err);
      if (terminal) return { ok: false, error: terminal };
      if (options?.signal?.aborted)
        return { ok: false, error: new RagError('Aborted', 'ABORTED') };
      if (err instanceof RagError) return { ok: false, error: err };
      return { ok: false, error: new RagError(String(err), 'UPSERT_ERROR') };
    }
  }

  async upsertPrecomputed(
    text: string,
    vector: RagDocumentVectors,
    metadata: RagMetadata,
    options?: CallOptions,
  ): Promise<Result<void, RagError>> {
    try {
      if (options?.signal?.aborted)
        return { ok: false, error: new RagError('Aborted', 'ABORTED') };
      return this.upsertKnownVectors(text, recordVectors(vector), metadata);
    } catch (err) {
      if (err instanceof RagError) return { ok: false, error: err };
      return { ok: false, error: new RagError(String(err), 'UPSERT_ERROR') };
    }
  }

  private newRecordId(): string {
    let id: string;
    do {
      id = randomUUID();
    } while (
      this.records.some((r) => r !== null && (r.metadata.id ?? r.id) === id)
    );
    return id;
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
        else {
          const terminal = contextExceededError(ppResult.error);
          if (terminal) return { ok: false, error: terminal };
        }
      }
      const nowSecs = Date.now() / 1000;
      // Text-only and transformed queries need a fresh store embedding.
      const effectiveEmbedding =
        searchText !== text || embedding instanceof TextOnlyEmbedding
          ? new QueryEmbedding(searchText, this.embedder, options)
          : this.fallbackOnQueryEmbeddingError
            ? new FallbackQueryEmbedding(embedding, this.embedder, options)
            : embedding;
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
          this.inStore(r.metadata) &&
          matchesRagIdentity(r.metadata, identity),
      );

      const candidates: ISearchCandidate[] = filtered.map((r) => ({
        text: r.text,
        vector:
          r.extraVectors?.reduce(
            (best, fragment) =>
              cosineSimilarity(queryVector, fragment) >
              cosineSimilarity(queryVector, best)
                ? fragment
                : best,
            r.vector,
          ) ?? r.vector,
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
      const terminal = contextExceededError(err);
      if (terminal) return { ok: false, error: terminal };
      if (err instanceof RagError) return { ok: false, error: err };
      return { ok: false, error: new RagError(String(err), 'QUERY_ERROR') };
    }
  }

  async healthCheck(options?: CallOptions): Promise<Result<void, RagError>> {
    try {
      await this.embedder.embedQuery('ping', {
        ...options,
        usage: options?.usage?.with({ role: 'embedding' }),
      });
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

  /** The store-configured namespace boundary, as `query` applies it. */
  private inStore(metadata: RagMetadata): boolean {
    return (
      this.namespace === undefined ||
      metadata.namespace === undefined ||
      metadata.namespace === this.namespace
    );
  }

  async list(
    params?: RagListParams,
    options?: CallOptions,
  ): Promise<Result<RagListPage, RagError>> {
    return listKeyedPage(
      this.listEntries(),
      (metadata) => this.inStore(metadata),
      this.listStore,
      params,
      options,
    );
  }

  private *listEntries() {
    for (let key = 0; key < this.records.length; key++) {
      const record = this.records[key];
      if (record !== null)
        yield {
          key,
          id: record.id,
          text: record.text,
          metadata: record.metadata,
        };
    }
  }

  async scan(
    opts?: { filter?: RagScanFilter; pageSize?: number; cursor?: string },
    options?: CallOptions,
  ): Promise<Result<RagScanPage, RagError>> {
    if (options?.signal?.aborted)
      return { ok: false, error: new RagError('Aborted', 'ABORTED') };
    // The slot index is the stable key: a record keeps its slot until deleted.
    const entries: { key: number; text: string; metadata: RagMetadata }[] = [];
    this.records.forEach((r, key) => {
      if (r !== null) entries.push({ key, text: r.text, metadata: r.metadata });
    });
    return scanKeyedPage(entries, (m) => this.inStore(m), opts);
  }

  async deleteWhere(
    filter: RagScanFilter,
    options?: CallOptions,
  ): Promise<Result<{ deleted: number }, RagError>> {
    if (options?.signal?.aborted)
      return { ok: false, error: new RagError('Aborted', 'ABORTED') };
    const guard = assertNonEmptyFilter(filter);
    if (!guard.ok) return guard;
    let deleted = 0;
    for (let i = 0; i < this.records.length; i++) {
      const r = this.records[i];
      if (
        r !== null &&
        this.inStore(r.metadata) &&
        matchesScanFilter(r.metadata, filter)
      ) {
        this.records[i] = null;
        deleted++;
      }
    }
    return { ok: true, value: { deleted } };
  }

  async getById(
    id: string,
    options?: CallOptions,
  ): Promise<Result<RagResult | null, RagError>> {
    if (options?.signal?.aborted) {
      return { ok: false, error: new RagError('Aborted', 'ABORTED') };
    }
    try {
      const identity = ragIdentityFilter(options);
      const namespace = options?.ragFilter?.namespace;
      for (const r of this.records) {
        if (
          r !== null &&
          (r.metadata.id ?? r.id) === id &&
          this.inStore(r.metadata) &&
          (namespace === undefined || r.metadata.namespace === namespace) &&
          matchesRagIdentity(r.metadata, identity)
        ) {
          return {
            ok: true,
            value: { text: r.text, metadata: r.metadata, score: 1 },
          };
        }
      }
      return { ok: true, value: null };
    } catch (err) {
      return {
        ok: false,
        error:
          err instanceof RagError
            ? err
            : new RagError(String(err), 'QUERY_ERROR'),
      };
    }
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
          if (r !== null && (r.metadata.id ?? r.id) === id) {
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
