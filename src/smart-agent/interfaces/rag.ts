import type {
  CallOptions,
  RagError,
  RagMetadata,
  RagResult,
  Result,
} from './types.js';

export interface IEmbedder {
  embed(text: string, options?: CallOptions): Promise<number[]>;
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
  upsert(
    text: string,
    metadata: RagMetadata,
    options?: CallOptions,
  ): Promise<Result<void, RagError>>;

  query(
    text: string,
    k: number,
    options?: CallOptions,
  ): Promise<Result<RagResult[], RagError>>;

  healthCheck(options?: CallOptions): Promise<Result<void, RagError>>;
}
