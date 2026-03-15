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
import type { EmbedderFactory, IEmbedder, IRag } from './interfaces/rag.js';
import { TokenCountingLlm } from './llm/token-counting-llm.js';
import { builtInEmbedderFactories } from './rag/embedder-factories.js';
import { InMemoryRag } from './rag/in-memory-rag.js';
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
  /** Maximum number of tokens in the LLM response. */
  maxTokens?: number;
  /** SAP AI Core resource group (used when provider is 'sap-ai-sdk') */
  resourceGroup?: string;
  /** Programmatic OAuth2 credentials for SAP AI Core (bypasses AICORE_SERVICE_KEY env var) */
  credentials?: SapAICoreCredentials;
}

export interface PipelineRagStoreConfig {
  /** 'ollama' | 'openai' | 'in-memory' | 'qdrant'. Default: 'ollama' */
  type?: 'ollama' | 'openai' | 'in-memory' | 'qdrant';
  /**
   * Embedder name — resolved from the embedder factory registry.
   * Built-in: 'ollama', 'openai'. Consumers can register custom factories.
   * When omitted, defaults to 'ollama'.
   */
  embedder?: string;
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
        maxTokens: cfg.maxTokens,
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
        maxTokens: cfg.maxTokens,
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
        maxTokens: cfg.maxTokens,
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
        maxTokens: cfg.maxTokens,
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

/**
 * Resolve an IEmbedder from config.
 *
 * Priority:
 *   1. Injected embedder instance (DI — consumer provides ready IEmbedder)
 *   2. Named factory from the registry (YAML `embedder: <name>`)
 *   3. Default: 'ollama'
 */
function resolveEmbedder(
  cfg: PipelineRagStoreConfig,
  injectedEmbedder?: IEmbedder,
  extraFactories?: Record<string, EmbedderFactory>,
): IEmbedder {
  if (injectedEmbedder) return injectedEmbedder;

  const name = cfg.embedder ?? 'ollama';
  const factories = { ...builtInEmbedderFactories, ...extraFactories };
  const factory = factories[name];
  if (!factory) {
    throw new Error(
      `Unknown embedder "${name}". Register a factory via embedderFactories or use one of: ${Object.keys(factories).join(', ')}`,
    );
  }
  return factory({
    url: cfg.url,
    apiKey: cfg.apiKey,
    model: cfg.model,
    timeoutMs: cfg.timeoutMs,
  });
}

export interface MakeRagOptions {
  /** Pre-built embedder injected by the consumer (takes precedence over config). */
  embedder?: IEmbedder;
  /** Additional embedder factories (merged with built-ins). */
  embedderFactories?: Record<string, EmbedderFactory>;
}

export function makeRagFromStoreConfig(
  cfg: PipelineRagStoreConfig,
  options?: MakeRagOptions,
): IRag {
  if (cfg.type === 'in-memory') {
    return new InMemoryRag({ dedupThreshold: cfg.dedupThreshold });
  }

  if (cfg.type === 'qdrant') {
    if (!cfg.url) {
      throw new Error('Qdrant URL is required for qdrant RAG type');
    }
    const embedder = resolveEmbedder(
      cfg,
      options?.embedder,
      options?.embedderFactories,
    );
    return new QdrantRag({
      url: cfg.url,
      collectionName: cfg.collectionName ?? 'llm-agent',
      embedder,
      apiKey: cfg.apiKey,
      timeoutMs: cfg.timeoutMs,
    });
  }

  // 'openai' and 'ollama' (default) — VectorRag with resolved embedder
  const embedder = resolveEmbedder(
    { ...cfg, embedder: cfg.embedder ?? cfg.type ?? 'ollama' },
    options?.embedder,
    options?.embedderFactories,
  );
  return new VectorRag(embedder, {
    dedupThreshold: cfg.dedupThreshold,
    vectorWeight: cfg.vectorWeight,
    keywordWeight: cfg.keywordWeight,
  });
}
