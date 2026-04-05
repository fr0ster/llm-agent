/**
 * Built-in embedder factories for declarative (YAML) embedder selection.
 *
 * Consumers can extend this map with custom factories via
 * `SmartAgentBuilder.withEmbedderFactory()` or `SmartServerConfig.embedderFactories`.
 */

import type { EmbedderFactory } from '../interfaces/rag.js';
import { OllamaEmbedder } from './ollama-rag.js';
import { OpenAiEmbedder } from './openai-embedder.js';
import { SapAiCoreEmbedder } from './sap-ai-core-embedder.js';

export const builtInEmbedderFactories: Record<string, EmbedderFactory> = {
  ollama: (cfg) =>
    new OllamaEmbedder({
      ollamaUrl: cfg.url,
      model: cfg.model,
      timeoutMs: cfg.timeoutMs,
    }),
  openai: (cfg) => {
    if (!cfg.apiKey) {
      throw new Error('API key is required for openai embedder');
    }
    return new OpenAiEmbedder({
      apiKey: cfg.apiKey,
      baseURL: cfg.url,
      model: cfg.model,
      timeoutMs: cfg.timeoutMs,
    });
  },
  'sap-ai-core': (cfg) =>
    new SapAiCoreEmbedder({
      model: cfg.model ?? 'text-embedding-3-small',
    }),
};
