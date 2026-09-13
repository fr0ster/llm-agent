import type { IEmbedderBatch, IEmbedResult } from '@mcp-abap-adt/llm-agent';
import {
  type CallOptions,
  RagError,
  VectorRag,
  type VectorRagConfig,
} from '@mcp-abap-adt/llm-agent';

export interface OllamaEmbedderConfig {
  /** Default: 'http://localhost:11434' */
  ollamaUrl?: string;
  /** Required: embedding model name (e.g. 'bge-m3'). No default — must be set explicitly. */
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

export class OllamaEmbedder implements IEmbedderBatch {
  private readonly ollamaUrl: string;
  readonly model: string;
  private readonly timeoutMs: number | undefined;

  constructor(config: OllamaEmbedderConfig) {
    if (!config?.model) {
      throw new Error("OllamaEmbedder requires a 'model' (e.g. 'bge-m3')");
    }
    this.ollamaUrl = config.ollamaUrl ?? 'http://localhost:11434';
    this.model = config.model;
    this.timeoutMs = config.timeoutMs;
  }

  async embed(text: string, options?: CallOptions): Promise<IEmbedResult> {
    const url = `${this.ollamaUrl}/api/embeddings`;

    let lastError: Error | undefined;
    const maxRetries = 3;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const signal = requestSignal(options?.signal, this.timeoutMs);

        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: this.model, prompt: text }),
          signal,
        });

        if (!res.ok) {
          const errorText = await res.text();
          throw new RagError(
            `Ollama embed error: HTTP ${res.status} - ${errorText}`,
            'EMBED_ERROR',
          );
        }

        const json = (await res.json()) as { embedding: number[] };
        return { vector: json.embedding };
      } catch (err: unknown) {
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

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const signal = requestSignal(options?.signal, this.timeoutMs);

        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: this.model, input: texts }),
          signal,
        });

        if (!res.ok) {
          const errorText = await res.text();
          throw new RagError(
            `Ollama batch embed error: HTTP ${res.status} - ${errorText}`,
            'EMBED_ERROR',
          );
        }

        const json = (await res.json()) as { embeddings: number[][] };
        return json.embeddings.map((vector) => ({ vector }));
      } catch (err: unknown) {
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
    const embedder = new OllamaEmbedder(config);
    super(embedder, config);
  }
}
