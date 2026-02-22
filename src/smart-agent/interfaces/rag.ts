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
}
