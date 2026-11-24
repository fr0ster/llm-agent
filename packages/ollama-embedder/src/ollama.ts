import type { IEmbedderBatch, IEmbedResult } from '@mcp-abap-adt/llm-agent';
import {
  beginEmbeddingRequest,
  type CallOptions,
  composeResilientEmbedder,
  EMBEDDING_CONTEXT_EXCEEDED,
  type IUsageRecorder,
  parseRetryAfter,
  RagError,
  startOperation,
  symmetricEmbedder,
  VectorRag,
  type VectorRagConfig,
  withProviderAttempt,
} from '@mcp-abap-adt/llm-agent';

export interface OllamaEmbedderConfig {
  usage?: IUsageRecorder;
  /** Default: 'http://localhost:11434' */
  ollamaUrl?: string;
  /** Required: embedding model name (e.g. 'bge-m3'). No default — must be set explicitly. */
  model: string;
}

export class OllamaEmbedder implements IEmbedderBatch {
  private readonly ollamaUrl: string;
  readonly model: string;
  private readonly usage?: IUsageRecorder;
  private context?: { length?: number };
  private readonly contextRequests = new Map<
    AbortSignal | undefined,
    Promise<number | undefined>
  >();

  constructor(config: OllamaEmbedderConfig) {
    if (!config?.model) {
      throw new Error("OllamaEmbedder requires a 'model' (e.g. 'bge-m3')");
    }
    this.ollamaUrl = config.ollamaUrl ?? 'http://localhost:11434';
    this.model = config.model;
    this.usage = config.usage;
  }

  private async modelContextLength(
    options?: CallOptions,
  ): Promise<number | undefined> {
    options?.signal?.throwIfAborted();
    if (this.context) return this.context.length;
    const signal = options?.signal;
    const pending = this.contextRequests.get(signal);
    if (pending) return pending;
    const request = this.fetchModelContext(options).finally(() =>
      this.contextRequests.delete(signal),
    );
    this.contextRequests.set(signal, request);
    return request;
  }

  private async fetchModelContext(
    options?: CallOptions,
  ): Promise<number | undefined> {
    const response = await fetch(`${this.ollamaUrl}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model }),
      signal: options?.signal,
    });
    if (!response.ok)
      throw await this.httpError(response, 'model info', options);
    const json = (await response.json()) as {
      model_info?: Record<string, string | number | object | boolean | null>;
    };
    const info = json.model_info ?? {};
    const architecture = info['general.architecture'];
    const value =
      typeof architecture === 'string'
        ? info[`${architecture}.context_length`]
        : Object.entries(info).find(([key]) =>
            key.endsWith('.context_length'),
          )?.[1];
    this.context = {
      length:
        typeof value === 'number' && Number.isSafeInteger(value) && value > 0
          ? value
          : undefined,
    };
    return this.context.length;
  }

  async getMaxInputChars(options?: CallOptions): Promise<number | undefined> {
    const length = await this.modelContextLength(options);
    if (length === undefined) return undefined;
    // Four UTF-8 bytes per code point plus two tokens for BOS/EOS.
    const capacity = Math.floor((length - 2) / 4);
    if (capacity < 1)
      throw new RagError(
        'Ollama context cannot fit one Unicode code point and special tokens',
        'EMBED_ERROR',
      );
    return capacity;
  }

  private async httpError(
    response: Response,
    action: string,
    options?: CallOptions,
  ): Promise<RagError> {
    const body = await response.text().catch((error) => {
      options?.signal?.throwIfAborted();
      if (error instanceof Error && error.name === 'AbortError') throw error;
      return '';
    });
    options?.signal?.throwIfAborted();
    const overflow =
      action !== 'model info' &&
      (response.status === 400 ||
        response.status === 413 ||
        response.status === 422) &&
      /\b(?:context_length_exceeded|input (?:text )?(?:is )?too (?:long|large)|input (?:length )?exceeds (?:the )?(?:maximum )?context (?:length|window)|too many tokens)\b/i.test(
        body,
      );
    return Object.assign(
      new RagError(
        `Ollama ${action} error: HTTP ${response.status} - ${body}`,
        overflow ? EMBEDDING_CONTEXT_EXCEEDED : 'EMBED_ERROR',
      ),
      {
        status: response.status,
        headers: response.headers,
        retryAfterSeconds: parseRetryAfter(response.headers.get('retry-after')),
      },
    );
  }

  async embed(text: string, options?: CallOptions): Promise<IEmbedResult> {
    const [result] = await this.request([text], 'embed', options);
    return result;
  }

  embedBatch(texts: string[], options?: CallOptions): Promise<IEmbedResult[]> {
    return this.request(texts, 'batch embed', options);
  }

  private async request(
    texts: string[],
    action: string,
    options?: CallOptions,
  ): Promise<IEmbedResult[]> {
    options?.signal?.throwIfAborted();
    if (texts.length === 0) return [];

    const contextLength = await this.modelContextLength(options);
    const url = `${this.ollamaUrl}/api/embed`;
    const op = startOperation(options);

    const request = beginEmbeddingRequest(
      options,
      withProviderAttempt(op, 0),
      {
        provider: 'ollama',
        model: this.model,
        inputs: texts.length,
        inputChars: texts.reduce((sum, value) => sum + value.length, 0),
        granularity: 'request',
        retriesVisible: true,
      },
      this.usage,
    );
    try {
      // The caller's signal and nothing else. A ceiling of our own would run
      // on every request and fire instead of whatever decided above us — a
      // caller waiting out a server's Retry-After, cut before the interval
      // is up. A consumer that wants one passes AbortSignal.timeout().
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          input: texts,
          truncate: false,
          ...(contextLength === undefined
            ? {}
            : { options: { num_ctx: contextLength } }),
        }),
        signal: options?.signal,
      });

      if (!res.ok) {
        const error = await this.httpError(res, action, options);
        request.end({ outcome: 'error', errorCode: String(res.status) });
        throw error;
      }

      const json = (await res.json()) as {
        embeddings: number[][];
        prompt_eval_count?: number;
      };
      if (
        !Array.isArray(json.embeddings) ||
        json.embeddings.length !== texts.length
      )
        throw new RagError('Invalid embedding response');
      const result = json.embeddings.map((vector) => {
        if (!Array.isArray(vector) || vector.length === 0)
          throw new RagError('Invalid embedding response');
        return { vector };
      });
      request.end({
        outcome: 'ok',
        inputTokens: json.prompt_eval_count,
        tokensSource:
          json.prompt_eval_count === undefined ? 'unknown' : 'provider',
      });
      return result;
    } catch (err) {
      request.end({
        outcome:
          options?.signal?.aborted ||
          (err instanceof Error && err.name === 'AbortError')
            ? 'aborted'
            : 'error',
        error: err,
      });
      throw err;
    }
  }
}

/**
 * OllamaRag — convenience adapter that combines OllamaEmbedder with VectorRag.
 */
export class OllamaRag extends VectorRag {
  constructor(config: OllamaEmbedderConfig & VectorRagConfig) {
    // An Ollama embedding model is symmetric: one embedder for both jobs.
    super(
      symmetricEmbedder(composeResilientEmbedder(new OllamaEmbedder(config))),
      config,
    );
  }
}
