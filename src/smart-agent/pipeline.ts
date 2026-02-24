/**
 * Pipeline configuration types and factory helpers for SmartServer.
 *
 * Provides granular, per-component control that the flat SmartServerConfig
 * cannot express:
 *   - Different LLM providers for main vs. classifier
 *   - Per-store RAG configuration (facts / feedback / state)
 *   - Multiple simultaneous MCP servers (array)
 */

import { AnthropicAgent } from '../agents/anthropic-agent.js';
import { AnthropicProvider } from '../llm-providers/anthropic.js';
import { DeepSeekAgent } from '../agents/deepseek-agent.js';
import { DeepSeekProvider } from '../llm-providers/deepseek.js';
import { OpenAIAgent } from '../agents/openai-agent.js';
import { OpenAIProvider } from '../llm-providers/openai.js';
import { MCPClientWrapper } from '../mcp/client.js';
import { LlmAdapter } from './adapters/llm-adapter.js';
import type { IRag } from './interfaces/rag.js';
import { TokenCountingLlm } from './llm/token-counting-llm.js';
import { InMemoryRag } from './rag/in-memory-rag.js';
import { OllamaRag } from './rag/ollama-rag.js';

// ---------------------------------------------------------------------------
// Config types
// ---------------------------------------------------------------------------

export interface PipelineLlmProviderConfig {
  provider: 'deepseek' | 'openai' | 'anthropic';
  apiKey: string;
  model?: string;
  temperature?: number;
}

export interface PipelineRagStoreConfig {
  /** 'ollama' uses neural embeddings; 'in-memory' uses bag-of-words. Default: 'ollama' */
  type?: 'ollama' | 'in-memory';
  /** Ollama base URL. Default: 'http://localhost:11434' */
  url?: string;
  /** Ollama embedding model. Default: 'nomic-embed-text' */
  model?: string;
  /** Cosine similarity dedup threshold. Default: 0.92 */
  dedupThreshold?: number;
}

export interface PipelineConfig {
  llm?: {
    /** Primary LLM for the tool-call loop. */
    main: PipelineLlmProviderConfig;
    /** LLM used by the intent classifier. If absent, main config is reused at 0.1 temp. */
    classifier?: PipelineLlmProviderConfig;
  };
  rag?: {
    /** RAG store for tool descriptions and domain facts. */
    facts?: PipelineRagStoreConfig;
    /** RAG store for conversation / user feedback. */
    feedback?: PipelineRagStoreConfig;
    /** RAG store for session state. */
    state?: PipelineRagStoreConfig;
  };
  /** One or more MCP servers to connect to simultaneously. */
  mcp?: Array<{
    type: 'http' | 'stdio';
    url?: string;
    command?: string;
    args?: string[];
  }>;
}

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

/**
 * Creates a TokenCountingLlm wrapping the provider described by `cfg`.
 * The `temperature` parameter overrides cfg.temperature so callers can
 * normalise main (0.7) vs. classifier (0.1) temps independently.
 */
export function makeLlmFromProvider(cfg: PipelineLlmProviderConfig, temperature: number): TokenCountingLlm {
  const dummyMcp = new MCPClientWrapper({
    transport: 'embedded',
    listToolsHandler: async () => [],
  });

  switch (cfg.provider) {
    case 'deepseek': {
      const provider = new DeepSeekProvider({ apiKey: cfg.apiKey, model: cfg.model, temperature });
      const agent = new DeepSeekAgent({ llmProvider: provider, mcpClient: dummyMcp });
      return new TokenCountingLlm(new LlmAdapter(agent));
    }
    case 'openai': {
      const provider = new OpenAIProvider({ apiKey: cfg.apiKey, model: cfg.model, temperature });
      const agent = new OpenAIAgent({ llmProvider: provider, mcpClient: dummyMcp });
      return new TokenCountingLlm(new LlmAdapter(agent));
    }
    case 'anthropic': {
      const provider = new AnthropicProvider({ apiKey: cfg.apiKey, model: cfg.model, temperature });
      const agent = new AnthropicAgent({ llmProvider: provider, mcpClient: dummyMcp });
      return new TokenCountingLlm(new LlmAdapter(agent));
    }
    default: {
      const _exhaustive: never = cfg.provider;
      throw new Error(`Unknown LLM provider: ${_exhaustive}`);
    }
  }
}

/**
 * Creates an IRag instance from a PipelineRagStoreConfig.
 * Defaults to OllamaRag when type is absent or 'ollama'.
 */
export function makeRagFromStoreConfig(cfg: PipelineRagStoreConfig): IRag {
  if (cfg.type === 'in-memory') {
    return new InMemoryRag({ dedupThreshold: cfg.dedupThreshold });
  }
  return new OllamaRag({
    ollamaUrl: cfg.url,
    model: cfg.model,
    dedupThreshold: cfg.dedupThreshold,
  });
}
