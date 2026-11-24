import { Buffer } from 'node:buffer';
import {
  type CallOptions,
  findAbort,
  type IReranker,
  RagError,
  type RagResult,
  type Result,
  startOperation,
} from '@mcp-abap-adt/llm-agent';
import {
  VoyageClient,
  type VoyageClientConfig,
  VoyageHttpError,
} from './voyage-client.js';

export type VoyageRerankerConfig = VoyageClientConfig;

export interface VoyageRerankOptions extends CallOptions {
  /** Maximum number of results after ranking all candidates. */
  topK?: number;
}

// https://docs.voyageai.com/docs/reranker
const MAX_DOCUMENTS = 1_000;
const maxBatchTokens: ReadonlyMap<string, number> = new Map([
  ['rerank-3', 600_000],
  ['rerank-3-lite', 600_000],
  ['rerank-2.5', 600_000],
  ['rerank-2.5-lite', 600_000],
  ['rerank-2', 600_000],
  ['rerank-2-lite', 600_000],
  ['rerank-1', 300_000],
  ['rerank-lite-1', 300_000],
]);

const requestSizeDetail =
  /\b(?:total\b[^.\n]{0,100}\btokens?|tokens?\b[^.\n]{0,150}\b(?:total|exceed(?:s|ed)?)|tokens? per (?:submitted )?(?:batch|request)|token (?:limit|budget)|context length|too many documents|(?:request|payload) (?:is )?too large)\b/i;

function candidateLabel(result: RagResult, index: number): string {
  const id = result.metadata.id;
  return `candidate at index ${index}${id === undefined ? '' : ` (id ${id})`}`;
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
      if (topK !== undefined && (!Number.isInteger(topK) || topK < 0)) {
        throw new RagError(
          'topK must be a non-negative integer',
          'RERANK_ERROR',
        );
      }
      const batches = this.splitRequests(query, results);
      const callOptions = { ...options, usageOp: startOperation(options) };
      const ranked: RagResult[] = [];
      let start = 0;
      for (const end of batches) {
        ranked.push(
          ...(await this.requestBatch(query, results, start, end, callOptions)),
        );
        start = end;
      }
      options?.signal?.throwIfAborted();
      ranked.sort((a, b) => b.score - a.score);
      return {
        ok: true,
        value: topK === undefined ? ranked : ranked.slice(0, topK),
      };
    } catch (error) {
      if (error instanceof RagError && !options?.signal?.aborted) {
        return { ok: false, error };
      }
      const aborted = options?.signal?.aborted || findAbort(error);
      return {
        ok: false,
        error: new RagError(
          String(error),
          aborted ? 'ABORTED' : 'RERANK_ERROR',
        ),
      };
    }
  }

  private splitRequests(query: string, results: RagResult[]): number[] {
    const maxTokens = maxBatchTokens.get(this.client.model);
    const queryBytes = Buffer.byteLength(query);
    const ends: number[] = [];
    let start = 0;
    let estimatedTokens = 0;
    for (const [index, result] of results.entries()) {
      // Count the query for each document and use UTF-8 only to group requests.
      const size = queryBytes + Buffer.byteLength(result.text);
      if (
        index - start === MAX_DOCUMENTS ||
        (index > start &&
          maxTokens !== undefined &&
          estimatedTokens + size > maxTokens)
      ) {
        ends.push(index);
        start = index;
        estimatedTokens = 0;
      }
      estimatedTokens += size;
    }
    ends.push(results.length);
    return ends;
  }

  private async requestBatch(
    query: string,
    results: RagResult[],
    start: number,
    end: number,
    options: CallOptions,
  ): Promise<RagResult[]> {
    const length = end - start;
    try {
      const { data } = await this.client.rerank(
        {
          query,
          documents: results.slice(start, end).map(({ text }) => text),
          truncation: false,
        },
        options,
      );
      if (data.length !== length) {
        throw new RagError('Invalid Voyage AI rerank response', 'RERANK_ERROR');
      }
      const seen = new Set<number>();
      return data.map((item) => {
        if (
          !Number.isInteger(item?.index) ||
          item.index < 0 ||
          item.index >= length ||
          seen.has(item.index) ||
          !Number.isFinite(item.relevance_score)
        ) {
          throw new RagError(
            'Invalid Voyage AI rerank response',
            'RERANK_ERROR',
          );
        }
        seen.add(item.index);
        return { ...results[start + item.index], score: item.relevance_score };
      });
    } catch (error) {
      if (!(error instanceof VoyageHttpError)) throw error;
      if (length === 1) {
        error.message = `Voyage AI rerank request for ${candidateLabel(results[start], start)} failed. ${error.message}`;
        throw error;
      }
      if (
        error.status !== 413 &&
        !(error.status === 400 && requestSizeDetail.test(error.message))
      ) {
        throw error;
      }
      const midpoint = start + Math.ceil(length / 2);
      const left = await this.requestBatch(
        query,
        results,
        start,
        midpoint,
        options,
      );
      const right = await this.requestBatch(
        query,
        results,
        midpoint,
        end,
        options,
      );
      return [...left, ...right];
    }
  }
}
