import type { IApiKeyCredential } from '@mcp-abap-adt/interfaces-auth';
import {
  beginEmbeddingRequest,
  beginLlmRequest,
  type CallOptions,
  embeddingErrorCode,
  type IUsageRecorder,
  parseRetryAfter,
  RagError,
  scopedUsage,
  startOperation,
} from '@mcp-abap-adt/llm-agent';

export type VoyageInputType = 'document' | 'query';

export interface VoyageClientConfig {
  credential: IApiKeyCredential;
  model: string;
  baseURL?: string;
  usage?: IUsageRecorder;
}

interface EmbeddingRequest {
  input: string[];
  input_type: VoyageInputType;
  truncation: false;
}

interface RerankRequest {
  query: string;
  documents: string[];
  truncation: false;
}

interface VoyageResponse<T> {
  model: string;
  data: T[];
  usage?: { total_tokens: number };
}

export interface EmbeddingEntry {
  index: number;
  embedding: number[];
}

export interface RerankEntry {
  index: number;
  relevance_score: number;
}

export class VoyageHttpError extends RagError {
  readonly retryAfterSeconds: number | undefined;

  constructor(
    endpoint: 'embeddings' | 'rerank',
    response: Response,
    body: string,
  ) {
    super(
      `Voyage AI ${endpoint} error: HTTP ${response.status} - ${body}`,
      endpoint === 'embeddings'
        ? embeddingErrorCode(response.status, body)
        : 'RERANK_ERROR',
      { status: response.status },
    );
    this.headers = response.headers;
    this.retryAfterSeconds = parseRetryAfter(this.headers.get('retry-after'));
  }

  declare readonly status: number;
  readonly headers: Headers;
}

export class VoyageClient {
  readonly model: string;
  private readonly baseURL: string;
  private readonly credential: IApiKeyCredential;
  private readonly usage?: IUsageRecorder;

  constructor(config: VoyageClientConfig) {
    if (!config.credential) throw new Error('Voyage AI API key is required');
    if (!config.model?.trim()) throw new Error('Voyage AI model is required');
    this.model = config.model;
    this.baseURL = (config.baseURL ?? 'https://api.voyageai.com/v1').replace(
      /\/$/,
      '',
    );
    this.credential = config.credential;
    this.usage = config.usage;
  }

  embed(
    body: EmbeddingRequest,
    options?: CallOptions,
  ): Promise<VoyageResponse<EmbeddingEntry>> {
    return this.post('embeddings', body, options);
  }

  rerank(
    body: RerankRequest,
    options?: CallOptions,
  ): Promise<VoyageResponse<RerankEntry>> {
    return this.post('rerank', body, options);
  }

  private async post<T>(
    endpoint: 'embeddings' | 'rerank',
    body: EmbeddingRequest | RerankRequest,
    options?: CallOptions,
  ): Promise<VoyageResponse<T>> {
    const signal = options?.signal;
    const operation = startOperation(options);
    const json = JSON.stringify({ ...body, model: this.model });
    const texts =
      'input' in body ? body.input : [body.query, ...body.documents];
    const base = {
      provider: 'voyage',
      model: this.model,
      inputChars: texts.reduce((sum, text) => sum + text.length, 0),
      granularity: 'request' as const,
      retriesVisible: true,
    };
    const rerankUsage =
      endpoint === 'rerank'
        ? scopedUsage(options?.usage ?? this.usage, { role: 'rerank' })
        : undefined;

    signal?.throwIfAborted();
    const authorization = `Bearer ${await this.credential.secret()}`;
    signal?.throwIfAborted();
    const request =
      endpoint === 'embeddings'
        ? beginEmbeddingRequest(
            options,
            operation,
            { ...base, inputs: texts.length },
            this.usage,
          )
        : beginLlmRequest({ ...options, usage: rerankUsage }, operation, {
            ...base,
            stream: false,
          });
    try {
      const response = await fetch(`${this.baseURL}/${endpoint}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: authorization,
        },
        body: json,
        signal,
      });
      if (!response.ok) {
        const errorBody = await response.text().catch((error) => {
          signal?.throwIfAborted();
          if (error instanceof Error && error.name === 'AbortError')
            throw error;
          return '';
        });
        signal?.throwIfAborted();
        throw new VoyageHttpError(endpoint, response, errorBody);
      }
      const result = (await response.json()) as VoyageResponse<T>;
      signal?.throwIfAborted();
      if (!Array.isArray(result?.data)) {
        throw new RagError(
          `Invalid Voyage AI ${endpoint} response`,
          endpoint === 'embeddings' ? 'EMBED_ERROR' : 'RERANK_ERROR',
        );
      }
      const inputTokens = result.usage?.total_tokens;
      request.end({
        outcome: 'ok',
        model: result.model || this.model,
        ...(inputTokens === undefined
          ? {}
          : { inputTokens, tokensSource: 'provider' }),
      });
      return result;
    } catch (error) {
      request.end({
        outcome:
          signal?.aborted ||
          (error instanceof Error && error.name === 'AbortError')
            ? 'aborted'
            : 'error',
        ...(error instanceof VoyageHttpError
          ? { errorCode: String(error.status) }
          : {}),
        error,
      });
      signal?.throwIfAborted();
      throw error;
    }
  }
}
