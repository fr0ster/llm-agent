import type { IEmbedderBatch, IEmbedResult } from '@mcp-abap-adt/llm-agent';
import { type CallOptions, RagError } from '@mcp-abap-adt/llm-agent';

export interface OpenAiEmbedderConfig {
  /** API key for OpenAI-compatible service */
  apiKey: string;
  /** API base URL. Default: 'https://api.openai.com/v1' */
  baseURL?: string;
  /** Required: embedding model name (e.g. 'text-embedding-3-small'). No default — must be set explicitly. */
  model: string;
  /**
   * Per-request ceiling in milliseconds. **No default** — omit it and a request
   * is bounded only by the caller's own `signal`, which is where a deadline
   * belongs.
   */
  timeoutMs?: number;
}

/**
 * The signal for one request: the caller's, narrowed by a ceiling only if the
 * consumer set one.
 *
 * There is no default ceiling. A duration here runs on every request and fires
 * *instead* of whatever the caller decided — a strategy told to wait out a
 * server's `Retry-After` never gets to, because the request was already cut.
 * The bound belongs to whoever is waiting, and reaches us as `options.signal`.
 */
function requestSignal(
  caller: AbortSignal | undefined,
  timeoutMs: number | undefined,
): AbortSignal | undefined {
  if (timeoutMs === undefined) return caller;
  const ceiling = AbortSignal.timeout(timeoutMs);
  return caller ? AbortSignal.any([caller, ceiling]) : ceiling;
}

export class OpenAiEmbedder implements IEmbedderBatch {
  private readonly baseURL: string;
  private readonly apiKey: string;
  readonly model: string;
  private readonly timeoutMs: number | undefined;

  constructor(config: OpenAiEmbedderConfig) {
    if (!config.apiKey) {
      throw new Error('OpenAI API key is required for embedding');
    }
    if (!config.model) {
      throw new Error("OpenAIEmbedder requires a 'model'");
    }
    this.apiKey = config.apiKey;
    this.baseURL = (config.baseURL ?? 'https://api.openai.com/v1').replace(
      /\/$/,
      '',
    );
    this.model = config.model;
    this.timeoutMs = config.timeoutMs;
  }

  async embed(text: string, options?: CallOptions): Promise<IEmbedResult> {
    const url = `${this.baseURL}/embeddings`;
    let lastError: Error | undefined;
    const maxRetries = 3;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const signal = requestSignal(options?.signal, this.timeoutMs);

        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({ model: this.model, input: text }),
          signal,
        });

        if (!res.ok) {
          const errorText = await res.text();
          throw new RagError(
            `OpenAI embed error: HTTP ${res.status} - ${errorText}`,
            'EMBED_ERROR',
          );
        }

        const json = (await res.json()) as {
          data: Array<{ embedding: number[] }>;
          usage?: { prompt_tokens: number; total_tokens: number };
        };
        const vector = json.data[0].embedding;
        const usage = json.usage
          ? {
              promptTokens: json.usage.prompt_tokens,
              totalTokens: json.usage.total_tokens,
            }
          : undefined;
        return { vector, usage };
      } catch (err: unknown) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (err instanceof Error && err.name === 'AbortError') throw err;
        const delay = 500 * 2 ** attempt;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    throw (
      lastError ||
      new RagError('OpenAI embed failed after retries', 'EMBED_ERROR')
    );
  }

  async embedBatch(
    texts: string[],
    options?: CallOptions,
  ): Promise<IEmbedResult[]> {
    if (texts.length === 0) return [];

    const chunkSize = 100;
    const results: IEmbedResult[] = new Array(texts.length);

    for (let start = 0; start < texts.length; start += chunkSize) {
      const chunk = texts.slice(start, start + chunkSize);
      const url = `${this.baseURL}/embeddings`;
      let lastError: Error | undefined;
      const maxRetries = 3;

      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          const signal = requestSignal(options?.signal, this.timeoutMs);

          const res = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${this.apiKey}`,
            },
            body: JSON.stringify({ model: this.model, input: chunk }),
            signal,
          });

          if (!res.ok) {
            const errorText = await res.text();
            throw new RagError(
              `OpenAI batch embed error: HTTP ${res.status} - ${errorText}`,
              'EMBED_ERROR',
            );
          }

          const json = (await res.json()) as {
            data: Array<{ embedding: number[]; index: number }>;
            usage?: { prompt_tokens: number; total_tokens: number };
          };
          const sorted = json.data.sort((a, b) => a.index - b.index);
          const chunkLen = sorted.length;
          const usagePerItem = json.usage
            ? {
                promptTokens: Math.round(json.usage.prompt_tokens / chunkLen),
                totalTokens: Math.round(json.usage.total_tokens / chunkLen),
              }
            : undefined;
          for (let i = 0; i < sorted.length; i++) {
            results[start + i] = {
              vector: sorted[i].embedding,
              usage: usagePerItem,
            };
          }
          lastError = undefined;
          break;
        } catch (err: unknown) {
          lastError = err instanceof Error ? err : new Error(String(err));
          if (err instanceof Error && err.name === 'AbortError') throw err;
          const delay = 500 * 2 ** attempt;
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }

      if (lastError) {
        throw lastError;
      }
    }

    return results;
  }
}
