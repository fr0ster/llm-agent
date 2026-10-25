import type { IEmbedderBatch, IEmbedResult } from '@mcp-abap-adt/llm-agent';
import {
  beginEmbeddingRequest,
  type CallOptions,
  type IUsageRecorder,
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
    const url = `${this.ollamaUrl}/api/embeddings`;

    let lastError: Error | undefined;
    const maxRetries = 3;
    const op = startOperation(options);

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const request = beginEmbeddingRequest(
        options,
        withProviderAttempt(op, attempt),
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
          request.end({ outcome: 'error', errorCode: String(res.status) });
          const errorText = await res.text();
          throw new RagError(
            `Ollama embed error: HTTP ${res.status} - ${errorText}`,
            'EMBED_ERROR',
          );
        }

        const json = (await res.json()) as {
          embedding: number[];
          prompt_eval_count?: number;
        };
        request.end({
          outcome: 'ok',
          inputTokens: json.prompt_eval_count,
          tokensSource:
            json.prompt_eval_count === undefined ? 'unknown' : 'provider',
        });
        return { vector: json.embedding };
      } catch (err: unknown) {
        request.end({
          outcome:
            options?.signal?.aborted ||
            (err instanceof Error && err.name === 'AbortError')
              ? 'aborted'
              : 'error',
          error: err,
        });
        lastError = err instanceof Error ? err : new Error(String(err));
        if (err instanceof Error && err.name === 'AbortError') throw err;

        // Exponential backoff: 500ms, 1000ms, 2000ms
        const delay = 500 * 2 ** attempt;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    throw (
      lastError ||
      new RagError('Ollama embed failed after retries', 'EMBED_ERROR')
    );
  }

  async embedBatch(
    texts: string[],
    options?: CallOptions,
  ): Promise<IEmbedResult[]> {
    if (texts.length === 0) return [];

    const url = `${this.ollamaUrl}/api/embed`;
    let lastError: Error | undefined;
    const maxRetries = 3;
    const op = startOperation(options);

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const request = beginEmbeddingRequest(
        options,
        withProviderAttempt(op, attempt),
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
          request.end({ outcome: 'error', errorCode: String(res.status) });
          const errorText = await res.text();
          throw new RagError(
            `Ollama batch embed error: HTTP ${res.status} - ${errorText}`,
            'EMBED_ERROR',
          );
        }

        const json = (await res.json()) as {
          embeddings: number[][];
          prompt_eval_count?: number;
        };
        request.end({
          outcome: 'ok',
          inputTokens: json.prompt_eval_count,
          tokensSource:
            json.prompt_eval_count === undefined ? 'unknown' : 'provider',
        });
        return json.embeddings.map((vector) => ({ vector }));
      } catch (err: unknown) {
        request.end({
          outcome:
            options?.signal?.aborted ||
            (err instanceof Error && err.name === 'AbortError')
              ? 'aborted'
              : 'error',
          error: err,
        });
        lastError = err instanceof Error ? err : new Error(String(err));
        if (err instanceof Error && err.name === 'AbortError') throw err;
        const delay = 500 * 2 ** attempt;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    throw (
      lastError ||
      new RagError('Ollama batch embed failed after retries', 'EMBED_ERROR')
    );
  }
}

/**
 * OllamaRag — convenience adapter that combines OllamaEmbedder with VectorRag.
 */
export class OllamaRag extends VectorRag {
  constructor(config: OllamaEmbedderConfig & VectorRagConfig) {
    // An Ollama embedding model is symmetric: one embedder for both jobs.
    super(symmetricEmbedder(new OllamaEmbedder(config)), config);
  }
}
