/**
 * Pipeline configuration types and factory helpers for SmartServer.
 */

import { AnthropicAgent } from '../agents/anthropic-agent.js';
import { DeepSeekAgent } from '../agents/deepseek-agent.js';
import { OpenAIAgent } from '../agents/openai-agent.js';
import { AnthropicProvider } from '../llm-providers/anthropic.js';
import { DeepSeekProvider } from '../llm-providers/deepseek.js';
import { OpenAIProvider } from '../llm-providers/openai.js';
import { MCPClientWrapper } from '../mcp/client.js';
import { LlmAdapter } from './adapters/llm-adapter.js';
import type { IRag } from './interfaces/rag.js';
import { TokenCountingLlm } from './llm/token-counting-llm.js';
import { InMemoryRag } from './rag/in-memory-rag.js';
import { OllamaEmbedder } from './rag/ollama-rag.js';
import { OpenAiEmbedder } from './rag/openai-embedder.js';
import { VectorRag } from './rag/vector-rag.js';

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
  /** 'ollama' | 'openai' | 'in-memory'. Default: 'ollama' */
  type?: 'ollama' | 'openai' | 'in-memory';
  /** Base URL for embedding service */
  url?: string;
  /** API key (for openai type) */
  apiKey?: string;
  /** Embedding model name */
  model?: string;
  /** Cosine similarity dedup threshold. Default: 0.92 */
  dedupThreshold?: number;
  /** Weight for vector search (0..1). Default: 0.7 */
  vectorWeight?: number;
  /** Weight for keyword search (0..1). Default: 0.3 */
  keywordWeight?: number;
}

export interface PipelineConfig {
  llm?: {
    /** Primary LLM for the tool-call loop. */
    main: PipelineLlmProviderConfig;
    /** Optional helper LLM for summarization and translation. */
    helper?: PipelineLlmProviderConfig;
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

export function makeLlmFromProvider(
  cfg: PipelineLlmProviderConfig,
  temperature: number,
): TokenCountingLlm {
  const dummyMcp = new MCPClientWrapper({
    transport: 'embedded',
    listToolsHandler: async () => [],
  });

  switch (cfg.provider) {
    case 'deepseek': {
      const provider = new DeepSeekProvider({
        apiKey: cfg.apiKey,
        model: cfg.model,
        temperature,
      });
      const agent = new DeepSeekAgent({
        llmProvider: provider,
        mcpClient: dummyMcp,
      });
      return new TokenCountingLlm(new LlmAdapter(agent));
    }
    case 'openai': {
      const provider = new OpenAIProvider({
        apiKey: cfg.apiKey,
        model: cfg.model,
        temperature,
      });
      const agent = new OpenAIAgent({
        llmProvider: provider,
        mcpClient: dummyMcp,
      });
      return new TokenCountingLlm(new LlmAdapter(agent));
    }
    case 'anthropic': {
      const provider = new AnthropicProvider({
        apiKey: cfg.apiKey,
        model: cfg.model,
        temperature,
      });
      const agent = new AnthropicAgent({
        llmProvider: provider,
        mcpClient: dummyMcp,
      });
      return new TokenCountingLlm(new LlmAdapter(agent));
    }
    default: {
      const _exhaustive: never = cfg.provider;
      throw new Error(`Unknown LLM provider: ${_exhaustive}`);
    }
  }
}

export function makeRagFromStoreConfig(cfg: PipelineRagStoreConfig): IRag {
  if (cfg.type === 'in-memory') {
    return new InMemoryRag({ dedupThreshold: cfg.dedupThreshold });
  }

  if (cfg.type === 'openai') {
    if (!cfg.apiKey) {
      throw new Error('OpenAI API key is required for openai RAG type');
    }
    const embedder = new OpenAiEmbedder({
      apiKey: cfg.apiKey,
      baseURL: cfg.url,
      model: cfg.model,
    });
    return new VectorRag(embedder, {
      dedupThreshold: cfg.dedupThreshold,
      vectorWeight: cfg.vectorWeight,
      keywordWeight: cfg.keywordWeight,
    });
  }

  const embedder = new OllamaEmbedder({
    ollamaUrl: cfg.url,
    model: cfg.model,
  });
  return new VectorRag(embedder, {
    dedupThreshold: cfg.dedupThreshold,
    vectorWeight: cfg.vectorWeight,
    keywordWeight: cfg.keywordWeight,
  });
}
