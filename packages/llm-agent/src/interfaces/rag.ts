import type { IQueryEmbedding } from './query-embedding.js';
import type {
  CallOptions,
  RagError,
  RagMetadata,
  RagResult,
  Result,
} from './types.js';

export interface IEmbedResult {
  vector: number[];
  usage?: { promptTokens: number; totalTokens: number };
}

export interface IEmbedder {
  embed(text: string, options?: CallOptions): Promise<IEmbedResult>;
}

/** Config subset passed to EmbedderFactory so it can configure the embedder. */
export interface EmbedderFactoryConfig {
  /** Base URL for the embedding service (Ollama URL, OpenAI base, etc.) */
  url?: string;
  /** Embedding model name */
  model?: string;
  /** Per-request timeout in milliseconds */
  timeoutMs?: number;
}

/**
 * Factory function that creates an IEmbedder from declarative config.
 * Consumers register custom factories to support YAML-driven embedder selection.
 */
export type EmbedderFactory = (cfg: EmbedderFactoryConfig) => IEmbedder;

export interface IRag {
  /**
   * Top-`k` records for `embedding`.
   *
   * Identity scope (a security contract, not a hint): when
   * `options.ragFilter.sessionId` is set, return only records whose
   * `metadata.sessionId` equals it; the same for `ragFilter.userId` and
   * `metadata.userId`; both set → both must match. A record without the
   * filtered key is excluded. The filter applies BEFORE top-k, so a scoped
   * query returns up to `k` of its own records. Neither set → no identity
   * filtering. Conformance cases:
   * `@mcp-abap-adt/llm-agent/testing/rag-filter-conformance`.
   */
  query(
    embedding: IQueryEmbedding,
    k: number,
    options?: CallOptions,
  ): Promise<Result<RagResult[], RagError>>;

  healthCheck(options?: CallOptions): Promise<Result<void, RagError>>;

  /** Fetch a single document by its metadata id. Returns null if not found. */
  getById(
    id: string,
    options?: CallOptions,
  ): Promise<Result<RagResult | null, RagError>>;

  /** Returns a backend writer if this implementation supports writes. */
  writer?(): IRagBackendWriter | undefined;
}

export interface IEmbedderBatch extends IEmbedder {
  embedBatch(texts: string[], options?: CallOptions): Promise<IEmbedResult[]>;
}

export function isBatchEmbedder(e: IEmbedder): e is IEmbedderBatch {
  return (
    'embedBatch' in e &&
    typeof (e as { embedBatch?: unknown }).embedBatch === 'function'
  );
}

/**
 * An embedder that declares a provider-imposed cap on `embedBatch` input size.
 * Deliberately TINY and SEPARATE from IEmbedderBatch (ISP) — an embedder with
 * no known cap simply does not implement it.
 */
export interface IBatchSizeLimited {
  /** Maximum number of texts accepted in a single embedBatch call. */
  readonly maxBatchSize: number;
}

/**
 * Value guard, NOT a key-presence guard: an implementer may declare
 * `maxBatchSize?: number` and leave it undefined for models whose cap is
 * unknown. Under ES2022 class fields that still creates an own property, so
 * `'maxBatchSize' in e` would wrongly accept it.
 */
export function isBatchSizeLimited(
  e: IEmbedder,
): e is IEmbedder & IBatchSizeLimited {
  const v = (e as { maxBatchSize?: unknown }).maxBatchSize;
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
}

// Added in 9.0 refactor — see docs/superpowers/specs/2026-04-22-rag-registry-corrections-design.md

export interface IRagEditor {
  upsert(
    text: string,
    metadata: RagMetadata,
    options?: CallOptions,
  ): Promise<Result<{ id: string }, RagError>>;
  deleteById(
    id: string,
    options?: CallOptions,
  ): Promise<Result<boolean, RagError>>;
  clear?(): Promise<Result<void, RagError>>;
}

export interface IIdStrategy {
  /** Always returns a valid id; throws MissingIdError when required input is missing. */
  resolve(metadata: RagMetadata, text: string): string;
}

export interface IRagBackendWriter {
  upsertRaw(
    id: string,
    text: string,
    metadata: RagMetadata,
    options?: CallOptions,
  ): Promise<Result<void, RagError>>;
  deleteByIdRaw(
    id: string,
    options?: CallOptions,
  ): Promise<Result<boolean, RagError>>;
  clearAll?(): Promise<Result<void, RagError>>;
  upsertPrecomputedRaw?(
    id: string,
    text: string,
    vector: number[],
    metadata: RagMetadata,
    options?: CallOptions,
  ): Promise<Result<void, RagError>>;
  /**
   * Write many precomputed records in one call, backed by the store's native
   * bulk API where one exists (Qdrant accepts many points per request).
   *
   * Optional and additive: a writer that does not implement it forces the
   * caller onto the per-record path. All-or-nothing — a single `Result` for the
   * whole batch, so a caller that needs to know which record failed must retry
   * per-record on error.
   */
  upsertManyPrecomputedRaw?(
    items: ReadonlyArray<{
      id: string;
      text: string;
      vector: number[];
      metadata: RagMetadata;
    }>,
    options?: CallOptions,
  ): Promise<Result<void, RagError>>;
}

export type RagCollectionScope = 'session' | 'user' | 'global';

/**
 * What a catalog can store and give back unchanged on every backend: JSON, with
 * finite numbers only. `unknown` admitted cycles, BigInt, functions and class
 * instances, which the three backends cannot round-trip alike. NaN, ±Infinity
 * and a cycle reached through an untyped caller are refused at runtime with
 * RAG_INVALID_ATTRIBUTES (validateRagAttributes), before anything is created.
 */
export type RagJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly RagJsonValue[]
  | { readonly [key: string]: RagJsonValue };

/**
 * The scope is required and selects its owner key. One type, used by the record
 * AND by both createCollection contracts, so no layer can hold a user or session
 * collection without its owner (§6.3).
 */
export type RagCollectionOwner =
  | { readonly scope: 'global' }
  | { readonly scope: 'user'; readonly userId: string }
  | { readonly scope: 'session'; readonly sessionId: string };

/** A catalog record. It says whose it is, or it is not a record at all. */
export type RagCollectionRecord = {
  /** What the PROVIDER knows the store by — the name createCollection was given. */
  readonly storeName: string;
  /** The LOGICAL name a registry registers it under. */
  readonly name: string;
  /** Opaque: persisted and returned exactly as given, never interpreted here. */
  readonly attributes?: RagJsonValue;
} & RagCollectionOwner;

/** IRagProvider.createCollection's options. */
export type RagProviderCreateCollectionOptions = RagCollectionOwner & {
  /** The logical name; `name` is the store name. Absent → the provider records `name`. */
  collectionName?: string;
  attributes?: RagJsonValue;
  /** Take over a store that exists without a record; never create one. */
  adoptExisting?: boolean;
};

/** IRagRegistry.createCollection's params. */
export type RagRegistryCreateCollectionParams = {
  providerName: string;
  /** Logical — passed on to the provider as opts.collectionName. */
  collectionName: string;
  displayName?: string;
  description?: string;
  tags?: readonly string[];
  /** Opaque, passed through unchanged (§9.5). */
  attributes?: RagJsonValue;
  /** Forwarded to the provider unchanged. */
  adoptExisting?: boolean;
} & RagCollectionOwner;

/** What IRagProvider.describeCollections reads back. */
export type RagCatalogDescription = {
  readonly records: readonly RagCollectionRecord[];
  /** Catalog rows that are not valid records — reported, never returned as records. */
  readonly rejected: readonly {
    readonly storeName?: string;
    readonly reason: string;
  }[];
};

export interface RagCollectionMeta {
  readonly name: string;
  readonly displayName: string;
  readonly description?: string;
  readonly editable: boolean;
  readonly scope?: RagCollectionScope;
  readonly sessionId?: string;
  readonly userId?: string;
  readonly providerName?: string;
  readonly tags?: readonly string[];
}

export interface IRagRegistry {
  /**
   * Throws `DuplicateCollectionError` when its scope (default `'global'`)
   * already holds `name`, and `ReservedCollectionNameError` for a global named
   * `user/…` or `session/…`.
   */
  register(
    name: string,
    rag: IRag,
    editor?: IRagEditor,
    meta?: Omit<RagCollectionMeta, 'name' | 'editable'>,
  ): void;
  /**
   * Entries are keyed by scope and name (§6.4): a caller may hold a global, a
   * user and a session collection of one name. `scope` selects the entry. When
   * it is omitted the name must be held by exactly one scope; a name several
   * hold fails with AmbiguousCollectionError (RAG_AMBIGUOUS_COLLECTION, naming
   * them in `.scopes`) — thrown by `unregister`, `get` and `getEditor`, whose
   * return values cannot tell "ambiguous" from "absent", and returned by
   * `deleteCollection`.
   */
  unregister(name: string, scope?: RagCollectionScope): boolean;
  get(name: string, scope?: RagCollectionScope): IRag | undefined;
  getEditor(name: string, scope?: RagCollectionScope): IRagEditor | undefined;
  list(): readonly RagCollectionMeta[];

  /** Create a collection via a provider and register it atomically. */
  createCollection(
    params: RagRegistryCreateCollectionParams,
  ): Promise<Result<RagCollectionMeta, RagError>>;

  /**
   * Register a collection whose store EXISTS, from its catalog record, under its
   * logical name, keeping the store name the record gives (§6.3). Creates
   * nothing and asks no provider for anything. `providerName` is the name the
   * owning provider is registered under in the IRagProviderRegistry: with it,
   * deleting the entry reaches that provider under `record.storeName`; without
   * it the entry is a reference and deleting it only unregisters — so a
   * hydrated collection adopted without it could never be deleted, and would
   * come back at the next hydration. Throws InvalidOwnerError,
   * ReservedCollectionNameError or DuplicateCollectionError. Optional so an
   * external implementation is not broken by gaining a member.
   */
  adopt?(
    record: RagCollectionRecord,
    rag: IRag,
    editor?: IRagEditor,
    providerName?: string,
  ): void;

  /**
   * Delete a collection: unregister it, then delete its data through the
   * provider that created it. A failure is returned with the collection
   * already unregistered.
   */
  deleteCollection(
    name: string,
    scope?: RagCollectionScope,
  ): Promise<Result<void, RagError>>;

  /**
   * Delete every session-scoped collection with the given sessionId, going
   * through all of them even when one fails; the failures come back together.
   */
  closeSession(sessionId: string): Promise<Result<void, RagError>>;
}

// v9.1 — provider layer

export interface IRagProvider {
  readonly name: string;
  readonly kind: string;
  readonly editable: boolean;
  readonly supportedScopes: readonly RagCollectionScope[];

  createCollection(
    name: string,
    opts: RagProviderCreateCollectionOptions,
  ): Promise<Result<{ rag: IRag; editor: IRagEditor }, RagError>>;

  /**
   * Delete a store. A provider with a catalog deletes the record FIRST, then the
   * data; if the record cannot be deleted it stops, leaves both, and fails with
   * CatalogRecordDeleteError.
   */
  deleteCollection?(name: string): Promise<Result<void, RagError>>;
  listCollections?(): Promise<Result<string[], RagError>>;

  /** The catalog, read back. A provider without one does not declare this. */
  describeCollections?(): Promise<Result<RagCatalogDescription, RagError>>;

  /**
   * Handles for a store that EXISTS. Creates nothing, ensures nothing, writes no
   * catalog record — now or on any later call through the handles: an operation
   * on a store that is gone fails.
   */
  openCollection?(
    record: RagCollectionRecord,
  ): Promise<Result<{ rag: IRag; editor: IRagEditor }, RagError>>;
}

export interface IRagProviderRegistry {
  registerProvider(provider: IRagProvider): void;
  getProvider(name: string): IRagProvider | undefined;
  listProviders(): readonly string[];
}
