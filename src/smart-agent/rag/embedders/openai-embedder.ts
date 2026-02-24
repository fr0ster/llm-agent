import type { IEmbedder } from '../../interfaces/embedder.js';
import { RagError } from '../../interfaces/types.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface OpenAIEmbedderConfig {
  apiKey: string;
  /** Default: 'text-embedding-3-small' */
  model?: string;
  /** Default: 'https://api.openai.com/v1' — override for Azure or compatible providers */
  baseURL?: string;
  /** Timeout for each embed HTTP call in ms. Default: 30 000 */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// OpenAIEmbedder
// ---------------------------------------------------------------------------

export class OpenAIEmbedder implements IEmbedder {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseURL: string;
  private readonly timeoutMs: number;

  constructor(config: OpenAIEmbedderConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? 'text-embedding-3-small';
    this.baseURL = (config.baseURL ?? 'https://api.openai.com/v1').replace(/\/$/, '');
    this.timeoutMs = config.timeoutMs ?? 30_000;
  }

  async embed(text: string): Promise<number[]> {
    const ctrl = new AbortController();
    const timeoutId = setTimeout(() => ctrl.abort(), this.timeoutMs);

    try {
      const res = await fetch(`${this.baseURL}/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ model: this.model, input: text }),
        signal: ctrl.signal,
      });

      if (!res.ok) {
        throw new RagError(`OpenAI embed HTTP ${res.status}`, 'EMBED_ERROR');
      }

      const json = (await res.json()) as { data: Array<{ embedding: number[] }> };
      return json.data[0].embedding;
    } catch (err) {
      if (err instanceof RagError) throw err;
      throw new RagError(String(err), 'EMBED_ERROR');
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async checkHealth(): Promise<void> {
    await this.embed('health');
  }
}
