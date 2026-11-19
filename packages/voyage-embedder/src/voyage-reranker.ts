import {
  type CallOptions,
  type IReranker,
  RagError,
  type RagResult,
  type Result,
} from '@mcp-abap-adt/llm-agent';
import { VoyageClient, type VoyageClientConfig } from './voyage-client.js';

export type VoyageRerankerConfig = VoyageClientConfig;

export interface VoyageRerankOptions extends CallOptions {
  /** When omitted, Voyage returns every ranked candidate. */
  topK?: number;
}

export class VoyageReranker implements IReranker {
  private readonly client: VoyageClient;

  constructor(config: VoyageRerankerConfig) {
    this.client = new VoyageClient(config);
  }

  async rerank(
    query: string,
    results: RagResult[],
    options?: VoyageRerankOptions,
  ): Promise<Result<RagResult[], RagError>> {
    try {
      options?.signal?.throwIfAborted();
      if (results.length === 0) return { ok: true, value: [] };

      const topK = options?.topK;
      const response = await this.client.rerank(
        {
          query,
          documents: results.map((result) => result.text),
          truncation: false,
          ...(topK === undefined ? {} : { top_k: topK }),
        },
        options,
      );
      const seen = new Set<number>();
      const value = response.data.map((item) => {
        const result = results[item?.index];
        if (
          !Number.isInteger(item?.index) ||
          !result ||
          seen.has(item.index) ||
          !Number.isFinite(item.relevance_score)
        ) {
          throw new RagError(
            'Invalid Voyage AI rerank response',
            'RERANK_ERROR',
          );
        }
        seen.add(item.index);
        return { ...result, score: item.relevance_score };
      });
      if (value.length !== Math.min(topK ?? results.length, results.length)) {
        throw new RagError('Invalid Voyage AI rerank response', 'RERANK_ERROR');
      }
      return { ok: true, value };
    } catch (error) {
      if (error instanceof RagError && !options?.signal?.aborted) {
        return { ok: false, error };
      }
      const aborted =
        options?.signal?.aborted ||
        (error instanceof Error && error.name === 'AbortError');
      return {
        ok: false,
        error: new RagError(
          String(error),
          aborted ? 'ABORTED' : 'RERANK_ERROR',
        ),
      };
    }
  }
}
