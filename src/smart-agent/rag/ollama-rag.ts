import type { IEmbedder } from '../interfaces/rag.js';
import { type CallOptions, RagError } from '../interfaces/types.js';
import { VectorRag, type VectorRagConfig } from './vector-rag.js';

export interface OllamaEmbedderConfig {
  /** Default: 'http://localhost:11434' */
  ollamaUrl?: string;
  /** Default: 'nomic-embed-text' */
  model?: string;
}

export class OllamaEmbedder implements IEmbedder {
  private readonly ollamaUrl: string;
  private readonly model: string;

  constructor(config: OllamaEmbedderConfig = {}) {
    this.ollamaUrl = config.ollamaUrl ?? 'http://localhost:11434';
    this.model = config.model ?? 'nomic-embed-text';
  }

  async embed(text: string, options?: CallOptions): Promise<number[]> {
    const url = `${this.ollamaUrl}/api/embeddings`;

    let lastError: Error | undefined;
    const maxRetries = 3;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: this.model, prompt: text }),
          signal: options?.signal,
        });

        if (!res.ok) {
          throw new RagError(
            `Ollama embed error: HTTP ${res.status}`,
            'EMBED_ERROR',
          );
        }

        const json = (await res.json()) as { embedding: number[] };
        return json.embedding;
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
}

/**
 * OllamaRag — convenience adapter that combines OllamaEmbedder with VectorRag.
 */
export class OllamaRag extends VectorRag {
  constructor(config: OllamaEmbedderConfig & VectorRagConfig = {}) {
    const embedder = new OllamaEmbedder(config);
    super(embedder, config);
  }
}
