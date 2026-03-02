import type {
  CallOptions,
  RagError,
  RagResult,
  Result,
} from '../interfaces/types.js';
import type { IReranker } from './types.js';

export class NoopReranker implements IReranker {
  async rerank(
    _query: string,
    results: RagResult[],
    _options?: CallOptions,
  ): Promise<Result<RagResult[], RagError>> {
    return { ok: true, value: results };
  }
}
