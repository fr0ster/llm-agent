import { RagError } from '@mcp-abap-adt/llm-agent';
export class OpenAiEmbedder {
  baseURL;
  apiKey;
  model;
  timeoutMs;
  constructor(config) {
    this.apiKey = config.apiKey;
    this.baseURL = (config.baseURL ?? 'https://api.openai.com/v1').replace(
      /\/$/,
      '',
    );
    this.model = config.model ?? 'text-embedding-3-small';
    this.timeoutMs = config.timeoutMs ?? 30_000;
    if (!this.apiKey) {
      throw new Error('OpenAI API key is required for embedding');
    }
  }
  async embed(text, options) {
    const url = `${this.baseURL}/embeddings`;
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
        const json = await res.json();
        const vector = json.data[0].embedding;
        const usage = json.usage
          ? {
              promptTokens: json.usage.prompt_tokens,
              totalTokens: json.usage.total_tokens,
            }
          : undefined;
        return { vector, usage };
      } catch (err) {
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
  async embedBatch(texts, options) {
    if (texts.length === 0) return [];
    const chunkSize = 100;
    const results = new Array(texts.length);
    for (let start = 0; start < texts.length; start += chunkSize) {
      const chunk = texts.slice(start, start + chunkSize);
      const url = `${this.baseURL}/embeddings`;
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
          const json = await res.json();
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
        } catch (err) {
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
//# sourceMappingURL=openai-embedder.js.map
