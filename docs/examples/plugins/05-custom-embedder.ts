/**
 * Plugin: custom-embedder — registers a custom embedder factory for RAG.
 *
 * Demonstrates how to add a new embedding provider that can be selected
 * via the `rag.embedder.factory` YAML config field.
 *
 * Usage in YAML:
 *   pluginDir: ./plugins
 *   rag:
 *     store:
 *       type: qdrant
 *       url: http://qdrant:6333
 *     embedder:
 *       factory: cohere            # references the factory registered below
 *       model: embed-english-v3.0
 *
 * The framework carries no credential for a `factory:` embedder — it is a
 * consumer factory, so it closes over its own (§4.6.2). This example reads
 * COHERE_API_KEY once, at module load, and every embedder the factory builds
 * shares that one credential.
 *
 * Drop this file into your plugin directory.
 */

import type {
  EmbedderFactory,
  EmbedderFactoryConfig,
  IEmbedder,
  IEmbedResult,
} from '@mcp-abap-adt/llm-agent';

const cohereApiKey = process.env.COHERE_API_KEY ?? '';

/**
 * Example embedder that calls the Cohere Embed API.
 * Replace the fetch logic with your actual provider SDK.
 */
class CohereEmbedder implements IEmbedder {
  private readonly model: string;
  private readonly baseUrl: string;

  constructor(
    cfg: EmbedderFactoryConfig,
    private readonly apiKey: string,
  ) {
    this.model = cfg.model ?? 'embed-english-v3.0';
    this.baseUrl = cfg.url ?? 'https://api.cohere.com';
  }

  async embed(text: string): Promise<IEmbedResult> {
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
      throw new Error(
        `Cohere embed failed: ${response.status} ${response.statusText}`,
      );
    }

    const data = (await response.json()) as { embeddings: number[][] };
    return { vector: data.embeddings[0] };
  }
}

/**
 * Factory function — the plugin loader calls this with the YAML config
 * when `rag.embedder.factory: cohere` is specified. It closes over the
 * credential read above; `cfg` itself carries no secret.
 */
const cohereFactory: EmbedderFactory = (cfg) =>
  new CohereEmbedder(cfg, cohereApiKey);

// Plugin export — registers under the name 'cohere'
export const embedderFactories = {
  cohere: cohereFactory,
};
