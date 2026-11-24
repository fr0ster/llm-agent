import { Buffer } from 'node:buffer';
import {
  type CallOptions,
  type IEmbedderBatch,
  type IEmbedResult,
  RagError,
  startOperation,
  toEmbeddingError,
  withChunk,
} from '@mcp-abap-adt/llm-agent';
import {
  VoyageClient,
  type VoyageClientConfig,
  type VoyageInputType,
} from './voyage-client.js';

export interface VoyageEmbedderConfig extends VoyageClientConfig {
  /** Stored text uses 'document' (the default). Search text uses 'query'. */
  inputType?: VoyageInputType;
}

// https://docs.voyageai.com/reference/embeddings-api and /docs/embeddings
// The Atlas API reference also lists the request limit for voyage-code-4.
const maxBatchTokens: ReadonlyMap<string, number> = new Map([
  ['voyage-4-lite', 1_000_000],
  ['voyage-3.5-lite', 1_000_000],
  ['voyage-4', 320_000],
  ['voyage-code-4', 320_000],
  ['voyage-3.5', 320_000],
  ['voyage-2', 320_000],
  ['voyage-4-large', 120_000],
  ['voyage-3-large', 120_000],
  ['voyage-code-3', 120_000],
  ['voyage-large-2-instruct', 120_000],
  ['voyage-finance-2', 120_000],
  ['voyage-multilingual-2', 120_000],
  ['voyage-law-2', 120_000],
]);

const retrievalPrompts: Record<VoyageInputType, string> = {
  document: 'Represent the document for retrieval: ',
  query: 'Represent the query for retrieving supporting documents: ',
};

export class VoyageEmbedder implements IEmbedderBatch {
  readonly model: string;
  readonly maxBatchSize = 1_000;
  private readonly client: VoyageClient;
  private readonly inputType: VoyageInputType;

  constructor(config: VoyageEmbedderConfig) {
    this.client = new VoyageClient(config);
    this.model = this.client.model;
    this.inputType = config.inputType ?? 'document';
  }

  async embed(text: string, options?: CallOptions): Promise<IEmbedResult> {
    const [result] = await this.requestBatch([text], options);
    return result;
  }

  async embedBatch(
    texts: string[],
    options?: CallOptions,
  ): Promise<IEmbedResult[]> {
    options?.signal?.throwIfAborted();
    const chunks = this.splitRequests(texts);
    const operation = startOperation(options);
    const results: IEmbedResult[] = [];
    for (const [index, chunk] of chunks.entries()) {
      results.push(
        ...(await this.requestBatch(chunk, {
          ...options,
          usageOp:
            chunks.length === 1
              ? operation
              : withChunk(operation, index, chunks.length),
        })),
      );
    }
    return results;
  }

  private splitRequests(texts: string[]): string[][] {
    const maxTokens = maxBatchTokens.get(this.model);
    const promptBytes = Buffer.byteLength(retrievalPrompts[this.inputType]);
    const chunks: string[][] = [];
    let start = 0;
    let estimatedTokens = 0;
    for (const [index, text] of texts.entries()) {
      // Estimate request size conservatively from UTF-8, including Voyage's
      // retrieval prompt. The API's tokenizer still decides what fits.
      const size = Buffer.byteLength(text) + promptBytes;
      if (
        index - start === this.maxBatchSize ||
        (index > start &&
          maxTokens !== undefined &&
          estimatedTokens + size > maxTokens)
      ) {
        chunks.push(texts.slice(start, index));
        start = index;
        estimatedTokens = 0;
      }
      estimatedTokens += size;
    }
    if (start < texts.length) chunks.push(texts.slice(start));
    return chunks;
  }

  private async requestBatch(
    texts: string[],
    options?: CallOptions,
  ): Promise<IEmbedResult[]> {
    const operation = startOperation(options);
    try {
      const response = await this.client.embed(
        {
          input: texts,
          input_type: this.inputType,
          truncation: false,
        },
        { ...options, usageOp: operation },
      );
      const sorted = response.data.sort((a, b) => a.index - b.index);
      if (
        sorted.length !== texts.length ||
        sorted.some(
          (item, index) =>
            item?.index !== index ||
            !Array.isArray(item.embedding) ||
            item.embedding.length === 0 ||
            !item.embedding.every(Number.isFinite),
        )
      ) {
        throw new RagError(
          'Invalid Voyage AI embedding response',
          'EMBED_ERROR',
        );
      }
      const total = response.usage?.total_tokens;
      return sorted.map((item, index) => {
        const share =
          total === undefined
            ? undefined
            : Math.floor(total / texts.length) +
              Number(index < total % texts.length);
        return {
          vector: item.embedding,
          ...(share === undefined
            ? {}
            : { usage: { promptTokens: share, totalTokens: share } }),
        };
      });
    } catch (error) {
      if (
        options?.signal?.aborted ||
        (error instanceof Error && error.name === 'AbortError')
      )
        throw error;
      throw toEmbeddingError(error);
    }
  }
}
