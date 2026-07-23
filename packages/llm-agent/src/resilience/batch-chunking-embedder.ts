/**
 * BatchChunkingEmbedder — splits embedBatch input into provider-safe chunks.
 *
 * Applied ONLY over a batch-capable inner (see composeResilientEmbedder): a
 * decorator exposing embedBatch unconditionally would make a non-batch embedder
 * look batch-capable to isBatchEmbedder.
 */

import type { IEmbedderBatch, IEmbedResult } from '../interfaces/rag.js';
// CallOptions lives in types.ts and is NOT re-exported by rag.ts.
import type { CallOptions } from '../interfaces/types.js';
import { RagError } from '../interfaces/types.js';

/**
 * Used when neither YAML nor the provider declares a cap. Comfortably below the
 * only hard cap we have confirmed (Vertex 250), and large enough that a
 * 356-tool catalog costs 4 requests.
 */
export const DEFAULT_MAX_BATCH_SIZE = 100;

export class BatchChunkingEmbedder implements IEmbedderBatch {
  constructor(
    private readonly inner: IEmbedderBatch,
    private readonly maxBatchSize: number,
  ) {
    if (!Number.isSafeInteger(maxBatchSize) || maxBatchSize < 1) {
      throw new RagError(
        `maxBatchSize must be a positive safe integer, got ${String(maxBatchSize)}`,
        'CONFIG_ERROR',
      );
    }
  }

  embed(text: string, options?: CallOptions): Promise<IEmbedResult> {
    return this.inner.embed(text, options);
  }

  async embedBatch(
    texts: string[],
    options?: CallOptions,
  ): Promise<IEmbedResult[]> {
    if (texts.length === 0) return [];
    const out: IEmbedResult[] = [];
    // Sequential on purpose: concurrent chunks would reintroduce the rate
    // limiting that chunking exists to avoid.
    for (let i = 0; i < texts.length; i += this.maxBatchSize) {
      const chunk = texts.slice(i, i + this.maxBatchSize);
      const res = await this.inner.embedBatch(chunk, options);
      if (res.length !== chunk.length) {
        throw new RagError(
          `Batch embedding returned ${res.length} embeddings, expected ${chunk.length}`,
          'EMBED_ERROR',
        );
      }
      out.push(...res);
    }
    return out;
  }
}
