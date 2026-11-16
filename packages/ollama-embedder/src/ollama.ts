import type { IEmbedderBatch, IEmbedResult } from '@mcp-abap-adt/llm-agent';
import {
  beginEmbeddingRequest,
  type CallOptions,
  composeResilientEmbedder,
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

  constructor(config: OllamaEmbedderConfig) {
    if (!config?.model) {
      throw new Error("OllamaEmbedder requires a 'model' (e.g. 'bge-m3')");
    }
    this.ollamaUrl = config.ollamaUrl ?? 'http://localhost:11434';
    this.model = config.model;
    this.usage = config.usage;
  }

  async embed(text: string, options?: CallOptions): Promise<IEmbedResult> {
    options?.signal?.throwIfAborted();
    const url = `${this.ollamaUrl}/api/embeddings`;

    const op = startOperation(options);

    const request = beginEmbeddingRequest(
      options,
      withProviderAttempt(op, 0),
      {
        provider: 'ollama',
        model: this.model,
        inputs: [text].length,
        inputChars: [text].reduce((sum, value) => sum + value.length, 0),
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
        body: JSON.stringify({ model: this.model, prompt: text }),
        signal: options?.signal,
      });

      if (!res.ok) {
        const errorText = await res.text().catch((error) => {
          options?.signal?.throwIfAborted();
          if (error instanceof Error && error.name === 'AbortError')
            throw error;
          return '';
        });
        options?.signal?.throwIfAborted();
        request.end({ outcome: 'error', errorCode: String(res.status) });
        throw Object.assign(
          new RagError(
            `Ollama embed error: HTTP ${res.status} - ${errorText}`,
            'EMBED_ERROR',
          ),
          {
            status: res.status,
            headers: res.headers,
            retryAfterSeconds: parseRetryAfter(res.headers.get('retry-after')),
          },
        );
      }

      const json = (await res.json()) as {
        embedding: number[];
        prompt_eval_count?: number;
      };
      const result = { vector: json.embedding };
      if (!Array.isArray(result.vector) || result.vector.length === 0)
        throw new RagError('Invalid embedding response');
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

  async embedBatch(
    texts: string[],
    options?: CallOptions,
  ): Promise<IEmbedResult[]> {
    options?.signal?.throwIfAborted();
    if (texts.length === 0) return [];

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
        body: JSON.stringify({ model: this.model, input: texts }),
        signal: options?.signal,
      });

      if (!res.ok) {
        const errorText = await res.text().catch((error) => {
          options?.signal?.throwIfAborted();
          if (error instanceof Error && error.name === 'AbortError')
            throw error;
          return '';
        });
        options?.signal?.throwIfAborted();
        request.end({ outcome: 'error', errorCode: String(res.status) });
        throw Object.assign(
          new RagError(
            `Ollama batch embed error: HTTP ${res.status} - ${errorText}`,
            'EMBED_ERROR',
          ),
          {
            status: res.status,
            headers: res.headers,
            retryAfterSeconds: parseRetryAfter(res.headers.get('retry-after')),
          },
        );
      }

      const json = (await res.json()) as {
        embeddings: number[][];
        prompt_eval_count?: number;
      };
      const result = json.embeddings.map((vector) => {
        if (!Array.isArray(vector) || vector.length === 0)
          throw new RagError('Invalid embedding response');
        return { vector };
      });
      if (result.length === 0) throw new RagError('Invalid embedding response');
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
