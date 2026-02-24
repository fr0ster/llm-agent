import type {
  CallOptions,
  RagError,
  RagMetadata,
  RagResult,
  Result,
} from './types.js';

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

  /**
   * Optional startup health check. When present, SmartAgentBuilder calls it
   * once during build() and logs a warning if it throws (non-fatal).
   */
  checkHealth?(): Promise<void>;
}
