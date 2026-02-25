import type { IEmbedder } from '../interfaces/rag.js';
import {
  type CallOptions,
  RagError,
} from '../interfaces/types.js';

export interface OpenAiEmbedderConfig {
  /** API key for OpenAI-compatible service */
  apiKey: string;
  /** API base URL. Default: 'https://api.openai.com/v1' */
  baseURL?: string;
  /** Embedding model. Default: 'text-embedding-3-small' */
  model?: string;
}

export class OpenAiEmbedder implements IEmbedder {
  private readonly baseURL: string;
  private readonly apiKey: string;
  private readonly model: string;

  constructor(config: OpenAiEmbedderConfig) {
    this.apiKey = config.apiKey;
    this.baseURL = (config.baseURL ?? 'https://api.openai.com/v1').replace(/\/$/, '');
    this.model = config.model ?? 'text-embedding-3-small';

    if (!this.apiKey) {
      throw new Error('OpenAI API key is required for embedding');
    }
  }

  async embed(text: string, options?: CallOptions): Promise<number[]> {
    const url = `${this.baseURL}/embeddings`;
    let lastError: Error | undefined;
    const maxRetries = 3;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.apiKey}`
          },
          body: JSON.stringify({ model: this.model, input: text }),
          signal: options?.signal,
        });

        if (!res.ok) {
          const errorText = await res.text();
          throw new RagError(
            `OpenAI embed error: HTTP ${res.status} - ${errorText}`,
            'EMBED_ERROR',
          );
        }

        const json = (await res.json()) as { data: Array<{ embedding: number[] }> };
        return json.data[0].embedding;
      } catch (err: any) {
        lastError = err;
        if (err.name === 'AbortError') throw err;
        const delay = 500 * (2 ** attempt);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    
    throw lastError || new RagError('OpenAI embed failed after retries', 'EMBED_ERROR');
  }
}
