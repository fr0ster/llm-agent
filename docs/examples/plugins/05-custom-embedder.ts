/**
 * Plugin: custom-embedder — registers a custom embedder factory for RAG.
 *
 * Demonstrates how to add a new embedding provider that can be selected
 * via the `rag.embedder` YAML config field.
 *
 * Usage in YAML:
 *   pluginDir: ./plugins
 *   rag:
 *     type: qdrant
 *     embedder: cohere           # references the factory registered below
 *     model: embed-english-v3.0
 *     apiKey: ${COHERE_API_KEY}
 *     url: http://qdrant:6333
 *
 * Drop this file into your plugin directory.
 */

import type {
  EmbedderFactory,
  EmbedderFactoryConfig,
  IEmbedder,
} from '@mcp-abap-adt/llm-agent';

/**
 * Example embedder that calls the Cohere Embed API.
 * Replace the fetch logic with your actual provider SDK.
 */
class CohereEmbedder implements IEmbedder {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;

  constructor(cfg: EmbedderFactoryConfig) {
    this.apiKey = cfg.apiKey ?? '';
    this.model = cfg.model ?? 'embed-english-v3.0';
    this.baseUrl = cfg.url ?? 'https://api.cohere.com';
  }

  async embed(text: string): Promise<number[]> {
    const response = await fetch(`${this.baseUrl}/v1/embed`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        texts: [text],
        model: this.model,
        input_type: 'search_document',
        truncate: 'END',
      }),
    });

    if (!response.ok) {
      throw new Error(`Cohere embed failed: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as { embeddings: number[][] };
    return data.embeddings[0];
  }
}

/**
 * Factory function — the plugin loader calls this with the YAML config
 * when `rag.embedder: cohere` is specified.
 */
const cohereFactory: EmbedderFactory = (cfg) => new CohereEmbedder(cfg);

// Plugin export — registers under the name 'cohere'
export const embedderFactories = {
  cohere: cohereFactory,
};
