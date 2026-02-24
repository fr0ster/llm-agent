import type { IEmbedder } from '../../interfaces/embedder.js';
import { RagError } from '../../interfaces/types.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface OllamaEmbedderConfig {
  /** Default: 'http://localhost:11434' */
  url?: string;
  /** Default: 'nomic-embed-text' */
  model?: string;
  /** Timeout for each embed HTTP call in ms. Default: 30 000 */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// OllamaEmbedder
// ---------------------------------------------------------------------------

export class OllamaEmbedder implements IEmbedder {
  private readonly url: string;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(config: OllamaEmbedderConfig = {}) {
    this.url = (config.url ?? 'http://localhost:11434').replace(/\/$/, '');
    this.model = config.model ?? 'nomic-embed-text';
    this.timeoutMs = config.timeoutMs ?? 30_000;
  }

  async embed(text: string): Promise<number[]> {
    return this._embedWithRetry(text, 3);
  }

  async checkHealth(): Promise<void> {
    await this._embedOnce('health');
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async _embedWithRetry(text: string, maxRetries: number): Promise<number[]> {
    let delay = 500;
    let lastErr: unknown;

    for (let i = 0; i < maxRetries; i++) {
      try {
        return await this._embedOnce(text);
      } catch (err) {
        lastErr = err;
        if (i < maxRetries - 1) {
          await new Promise<void>((r) => setTimeout(r, delay));
          delay *= 2;
        }
      }
    }

    if (lastErr instanceof RagError) throw lastErr;
    throw new RagError(String(lastErr), 'EMBED_ERROR');
  }

  private async _embedOnce(text: string): Promise<number[]> {
    const ctrl = new AbortController();
    const timeoutId = setTimeout(() => ctrl.abort(), this.timeoutMs);

    try {
      const res = await fetch(`${this.url}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model, prompt: text }),
        signal: ctrl.signal,
      });

      if (!res.ok) {
        throw new RagError(`Ollama embed HTTP ${res.status}`, 'EMBED_ERROR');
      }

      const json = (await res.json()) as { embedding: number[] };
      return json.embedding;
    } catch (err) {
      if (err instanceof RagError) throw err;
      throw new RagError(String(err), 'EMBED_ERROR');
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
