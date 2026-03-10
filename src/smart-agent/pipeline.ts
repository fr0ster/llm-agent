/**
 * Pipeline configuration types and factory helpers for SmartServer.
 */

import { AnthropicAgent } from '../agents/anthropic-agent.js';
import { DeepSeekAgent } from '../agents/deepseek-agent.js';
import { OpenAIAgent } from '../agents/openai-agent.js';
import { SapCoreAIAgent } from '../agents/sap-core-ai-agent.js';
import { AnthropicProvider } from '../llm-providers/anthropic.js';
import { DeepSeekProvider } from '../llm-providers/deepseek.js';
import { OpenAIProvider } from '../llm-providers/openai.js';
import {
  type SapAICoreCredentials,
  SapCoreAIProvider,
} from '../llm-providers/sap-core-ai.js';
import { MCPClientWrapper } from '../mcp/client.js';
import { LlmAdapter } from './adapters/llm-adapter.js';
import type { IRag } from './interfaces/rag.js';
import { TokenCountingLlm } from './llm/token-counting-llm.js';
import { InMemoryRag } from './rag/in-memory-rag.js';
import { OllamaEmbedder } from './rag/ollama-rag.js';
import { OpenAiEmbedder } from './rag/openai-embedder.js';
import { QdrantRag } from './rag/qdrant-rag.js';
import { VectorRag } from './rag/vector-rag.js';

// ---------------------------------------------------------------------------
// Config types
// ---------------------------------------------------------------------------

export interface PipelineLlmProviderConfig {
  provider: 'deepseek' | 'openai' | 'anthropic' | 'sap-ai-sdk';
  /** API key. Required for openai/anthropic/deepseek; optional for sap-ai-sdk. */
  apiKey?: string;
  model?: string;
  temperature?: number;
  /** SAP AI Core resource group (used when provider is 'sap-ai-sdk') */
  resourceGroup?: string;
  /** Programmatic OAuth2 credentials for SAP AI Core (bypasses AICORE_SERVICE_KEY env var) */
  credentials?: SapAICoreCredentials;
}

export interface PipelineRagStoreConfig {
  /** 'ollama' | 'openai' | 'in-memory' | 'qdrant'. Default: 'ollama' */
  type?: 'ollama' | 'openai' | 'in-memory' | 'qdrant';
  /** Base URL for embedding service or Qdrant server */
  url?: string;
  /** API key (for openai type or Qdrant auth) */
  apiKey?: string;
  /** Embedding model name */
  model?: string;
  /** Qdrant collection name (required for qdrant type) */
  collectionName?: string;
  /** Cosine similarity dedup threshold. Default: 0.92 */
  dedupThreshold?: number;
  /** Weight for vector search (0..1). Default: 0.7 */
  vectorWeight?: number;
  /** Weight for keyword search (0..1). Default: 0.3 */
  keywordWeight?: number;
  /** Per-request timeout for embedding calls in milliseconds. Default: 30 000 */
  timeoutMs?: number;
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
    case 'sap-ai-sdk': {
      const provider = new SapCoreAIProvider({
        apiKey: cfg.apiKey,
        model: cfg.model,
        temperature,
        resourceGroup: cfg.resourceGroup,
        credentials: cfg.credentials,
      });
      const agent = new SapCoreAIAgent({
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

  if (cfg.type === 'qdrant') {
    if (!cfg.url) {
      throw new Error('Qdrant URL is required for qdrant RAG type');
    }
    // Qdrant needs an embedder — default to Ollama
    const embedder = cfg.apiKey
      ? new OpenAiEmbedder({
          apiKey: cfg.apiKey,
          baseURL: undefined,
          model: cfg.model,
          timeoutMs: cfg.timeoutMs,
        })
      : new OllamaEmbedder({
          ollamaUrl: undefined,
          model: cfg.model,
          timeoutMs: cfg.timeoutMs,
        });
    return new QdrantRag({
      url: cfg.url,
      collectionName: cfg.collectionName ?? 'llm-agent',
      embedder,
      apiKey: cfg.apiKey,
      timeoutMs: cfg.timeoutMs,
    });
  }

  if (cfg.type === 'openai') {
    if (!cfg.apiKey) {
      throw new Error('OpenAI API key is required for openai RAG type');
    }
    const embedder = new OpenAiEmbedder({
      apiKey: cfg.apiKey,
      baseURL: cfg.url,
      model: cfg.model,
      timeoutMs: cfg.timeoutMs,
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
    timeoutMs: cfg.timeoutMs,
  });
  return new VectorRag(embedder, {
    dedupThreshold: cfg.dedupThreshold,
    vectorWeight: cfg.vectorWeight,
    keywordWeight: cfg.keywordWeight,
  });
}
