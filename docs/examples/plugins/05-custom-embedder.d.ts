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
import type { EmbedderFactory } from '@mcp-abap-adt/llm-agent';
export declare const embedderFactories: {
    cohere: EmbedderFactory;
};
//# sourceMappingURL=05-custom-embedder.d.ts.map