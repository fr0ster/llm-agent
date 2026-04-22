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
  /** API key when required by the embedding provider */
  apiKey?: string;
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
}

export interface RagCollectionMeta {
  readonly name: string;
  readonly displayName: string;
  readonly description?: string;
  readonly editable: boolean;
  readonly tags?: readonly string[];
}

export interface IRagRegistry {
  register(
    name: string,
    rag: IRag,
    editor?: IRagEditor,
    meta?: Omit<RagCollectionMeta, 'name' | 'editable'>,
  ): void;
  unregister(name: string): boolean;
  get(name: string): IRag | undefined;
  getEditor(name: string): IRagEditor | undefined;
  list(): readonly RagCollectionMeta[];
}
