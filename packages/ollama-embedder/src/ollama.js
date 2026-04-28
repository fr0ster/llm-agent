import { RagError, VectorRag } from '@mcp-abap-adt/llm-agent';
export class OllamaEmbedder {
  ollamaUrl;
  model;
  timeoutMs;
  constructor(config = {}) {
    this.ollamaUrl = config.ollamaUrl ?? 'http://localhost:11434';
    this.model = config.model ?? 'nomic-embed-text';
    this.timeoutMs = config.timeoutMs ?? 30_000;
  }
  async embed(text, options) {
    const url = `${this.ollamaUrl}/api/embeddings`;
    let lastError;
    const maxRetries = 3;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
        const signal = options?.signal
          ? AbortSignal.any([options.signal, timeoutSignal])
          : timeoutSignal;
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
        const json = await res.json();
        return { vector: json.embedding };
      } catch (err) {
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
  async embedBatch(texts, options) {
    if (texts.length === 0) return [];
    const url = `${this.ollamaUrl}/api/embed`;
    let lastError;
    const maxRetries = 3;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
        const signal = options?.signal
          ? AbortSignal.any([options.signal, timeoutSignal])
          : timeoutSignal;
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
        const json = await res.json();
        return json.embeddings.map((vector) => ({ vector }));
      } catch (err) {
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
  constructor(config = {}) {
    const embedder = new OllamaEmbedder(config);
    super(embedder, config);
  }
}
//# sourceMappingURL=ollama.js.map
