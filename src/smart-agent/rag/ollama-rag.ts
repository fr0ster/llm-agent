import type { IEmbedder } from '../interfaces/rag.js';
import {
  type CallOptions,
  RagError,
} from '../interfaces/types.js';
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
  }
}

/**
 * OllamaRag — legacy adapter that combines OllamaEmbedder with VectorRag.
 * Keeps backward compatibility with Phase 3 contracts.
 */
export class OllamaRag extends VectorRag {
  constructor(config: OllamaEmbedderConfig & VectorRagConfig = {}) {
    const embedder = new OllamaEmbedder(config);
    super(embedder, config);
  }
}
