/**
 * Provider resolution — the composition root for concrete implementations.
 *
 * This module is the ONLY place that knows about concrete LLM providers,
 * embedders, and RAG implementations. All factories (Builder, SmartServer,
 * pipeline YAML) delegate here to resolve config into interface instances.
 */

import { AnthropicProvider } from '@mcp-abap-adt/anthropic-llm';
import { DeepSeekProvider } from '@mcp-abap-adt/deepseek-llm';
import type {
  EmbedderFactory,
  IDocumentEnricher,
  IEmbedder,
  ILlm,
  IQueryPreprocessor,
  IRag,
  ISearchStrategy,
} from '@mcp-abap-adt/llm-agent';
import {
  builtInEmbedderFactories,
  InMemoryRag,
  QdrantRag,
  VectorRag,
} from '@mcp-abap-adt/llm-agent';
import { OllamaRag } from '@mcp-abap-adt/ollama-embedder';
import { OpenAIProvider } from '@mcp-abap-adt/openai-llm';
import {
  type SapAICoreCredentials,
  SapCoreAIProvider,
} from '@mcp-abap-adt/sap-aicore-llm';
import { AnthropicAgent } from '../agents/anthropic-agent.js';
import { DeepSeekAgent } from '../agents/deepseek-agent.js';
import { OpenAIAgent } from '../agents/openai-agent.js';
import { SapCoreAIAgent } from '../agents/sap-core-ai-agent.js';
import { MCPClientWrapper } from '../mcp/client.js';
import { LlmAdapter } from './adapters/llm-adapter.js';
import { NonStreamingLlm } from './adapters/non-streaming-llm.js';
import type { IModelResolver } from './interfaces/model-resolver.js';

// ---------------------------------------------------------------------------
// LLM provider resolution
// ---------------------------------------------------------------------------

export interface LlmProviderConfig {
  provider: 'deepseek' | 'openai' | 'anthropic' | 'sap-ai-sdk';
  apiKey?: string;
  /** Custom base URL for OpenAI-compatible endpoints (Azure OpenAI, Ollama, vLLM, etc.). */
  baseURL?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  resourceGroup?: string;
  credentials?: SapAICoreCredentials;
  /** When false, streamChat() is replaced with chat() yielding a single chunk. Default: true. */
  streaming?: boolean;
}

/**
 * Create an ILlm from a declarative provider config.
 * This is the only function that knows about concrete LLM implementations.
 */
export function makeLlm(cfg: LlmProviderConfig, temperature: number): ILlm {
  const dummyMcp = new MCPClientWrapper({
    transport: 'embedded',
    listToolsHandler: async () => [],
  });

  // Coerce numeric fields that may arrive as strings from ${ENV_VAR} substitution
  const maxTokens = cfg.maxTokens != null ? Number(cfg.maxTokens) : undefined;

  let llm: ILlm;

  switch (cfg.provider) {
    case 'deepseek': {
      const provider = new DeepSeekProvider({
        apiKey: cfg.apiKey,
        baseURL: cfg.baseURL,
        model: cfg.model,
        temperature,
        maxTokens,
      });
      const agent = new DeepSeekAgent({
        llmProvider: provider,
        mcpClient: dummyMcp,
      });
      llm = new LlmAdapter(agent, {
        model: provider.model,
        getModels: () => provider.getModels(),
        getEmbeddingModels: () => provider.getEmbeddingModels(),
      });
      break;
    }
    case 'openai': {
      const provider = new OpenAIProvider({
        apiKey: cfg.apiKey,
        baseURL: cfg.baseURL,
        model: cfg.model,
        temperature,
        maxTokens,
      });
      const agent = new OpenAIAgent({
        llmProvider: provider,
        mcpClient: dummyMcp,
      });
      llm = new LlmAdapter(agent, {
        model: provider.model,
        getModels: () => provider.getModels(),
        getEmbeddingModels: () => provider.getEmbeddingModels(),
      });
      break;
    }
    case 'anthropic': {
      const provider = new AnthropicProvider({
        apiKey: cfg.apiKey,
        baseURL: cfg.baseURL,
        model: cfg.model,
        temperature,
        maxTokens,
      });
      const agent = new AnthropicAgent({
        llmProvider: provider,
        mcpClient: dummyMcp,
      });
      llm = new LlmAdapter(agent, {
        model: provider.model,
        getModels: () => provider.getModels(),
        getEmbeddingModels: () => provider.getEmbeddingModels(),
      });
      break;
    }
    case 'sap-ai-sdk': {
      const provider = new SapCoreAIProvider({
        apiKey: cfg.apiKey,
        model: cfg.model,
        temperature,
        maxTokens,
        resourceGroup: cfg.resourceGroup,
        credentials: cfg.credentials,
        log: {
          debug: (msg: string, meta?: Record<string, unknown>) =>
            process.stderr.write(
              `[sap-ai-sdk:debug] ${msg} ${meta ? JSON.stringify(meta) : ''}\n`,
            ),
          error: (msg: string, meta?: Record<string, unknown>) =>
            process.stderr.write(
              `[sap-ai-sdk:error] ${msg} ${meta ? JSON.stringify(meta) : ''}\n`,
            ),
        },
      });
      const agent = new SapCoreAIAgent({
        llmProvider: provider,
        mcpClient: dummyMcp,
      });
      llm = new LlmAdapter(agent, {
        model: provider.model,
        getModels: () => provider.getModels(),
        getEmbeddingModels: () => provider.getEmbeddingModels(),
      });
      break;
    }
    default: {
      const _exhaustive: never = cfg.provider;
      throw new Error(`Unknown LLM provider: ${_exhaustive}`);
    }
  }

  // Wrap with non-streaming adapter when streaming is disabled for this provider
  if (cfg.streaming === false) {
    llm = new NonStreamingLlm(llm);
  }

  return llm;
}

/**
 * Create a default DeepSeek-based ILlm from simple config (apiKey + model).
 * Used by the flat YAML / CLI path.
 */
export function makeDefaultLlm(
  apiKey: string,
  model: string,
  temperature: number,
): ILlm {
  return makeLlm({ provider: 'deepseek', apiKey, model }, temperature);
}

/**
 * Default IModelResolver — delegates to makeLlm() with the given provider settings.
 * Returns fully constructed ILlm instances ready for use with SmartAgent.reconfigure().
 */
export class DefaultModelResolver implements IModelResolver {
  constructor(
    private readonly providerConfig: Omit<LlmProviderConfig, 'model'>,
    private readonly defaults: { temperature?: number } = {},
  ) {}

  async resolve(
    modelName: string,
    role: 'main' | 'classifier' | 'helper',
  ): Promise<ILlm> {
    const temperature =
      this.defaults.temperature ?? (role === 'main' ? 0.7 : 0.1);
    return makeLlm({ ...this.providerConfig, model: modelName }, temperature);
  }
}

// ---------------------------------------------------------------------------
// Embedder resolution
// ---------------------------------------------------------------------------

export interface EmbedderResolutionConfig {
  /** Embedder name — looked up in the factory registry. Default: 'ollama' */
  embedder?: string;
  url?: string;
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
}

export interface EmbedderResolutionOptions {
  /** Pre-built embedder injected by the consumer (takes precedence). */
  injectedEmbedder?: IEmbedder;
  /** Additional embedder factories (merged with built-ins). */
  extraFactories?: Record<string, EmbedderFactory>;
}

/**
 * Resolve an IEmbedder from config.
 *
 * Priority:
 *   1. Injected embedder instance (DI)
 *   2. Named factory from registry (YAML `embedder: <name>`)
 *   3. Default: 'ollama'
 */
export function resolveEmbedder(
  cfg: EmbedderResolutionConfig,
  options?: EmbedderResolutionOptions,
): IEmbedder {
  if (options?.injectedEmbedder) return options.injectedEmbedder;

  const name = cfg.embedder ?? 'ollama';
  const factories = { ...builtInEmbedderFactories, ...options?.extraFactories };
  const factory = factories[name];
  if (!factory) {
    throw new Error(
      `Unknown embedder "${name}". Register a factory or use: ${Object.keys(factories).join(', ')}`,
    );
  }
  return factory({
    url: cfg.url,
    apiKey: cfg.apiKey,
    model: cfg.model,
    timeoutMs: cfg.timeoutMs,
  });
}

// ---------------------------------------------------------------------------
// RAG resolution
// ---------------------------------------------------------------------------

export interface RagResolutionConfig {
  type?: 'ollama' | 'openai' | 'in-memory' | 'qdrant';
  embedder?: string;
  url?: string;
  apiKey?: string;
  model?: string;
  collectionName?: string;
  dedupThreshold?: number;
  vectorWeight?: number;
  keywordWeight?: number;
  timeoutMs?: number;
  /** Search scoring strategy for hybrid RAG stores (VectorRag). */
  strategy?: ISearchStrategy;
  /** Query preprocessors for this RAG store. */
  queryPreprocessors?: IQueryPreprocessor[];
  /** Document enrichers for this RAG store. */
  documentEnrichers?: IDocumentEnricher[];
}

export interface RagResolutionOptions {
  /** Pre-built embedder injected by the consumer. */
  injectedEmbedder?: IEmbedder;
  /** Additional embedder factories (merged with built-ins). */
  extraFactories?: Record<string, EmbedderFactory>;
}

/**
 * Create an IRag from a declarative store config.
 * This is the only function that knows about concrete RAG implementations.
 */
export function makeRag(
  cfg: RagResolutionConfig,
  options?: RagResolutionOptions,
): IRag {
  if (cfg.type === 'in-memory') {
    // When an embedder is specified, upgrade to VectorRag for hybrid scoring
    if (cfg.embedder || options?.injectedEmbedder) {
      const embedder = resolveEmbedder(cfg, options);
      return new VectorRag(embedder, {
        dedupThreshold: cfg.dedupThreshold,
        vectorWeight: cfg.vectorWeight,
        keywordWeight: cfg.keywordWeight,
        strategy: cfg.strategy,
        queryPreprocessors: cfg.queryPreprocessors,
        documentEnrichers: cfg.documentEnrichers,
      });
    }
    return new InMemoryRag({
      dedupThreshold: cfg.dedupThreshold,
      queryPreprocessors: cfg.queryPreprocessors,
      documentEnrichers: cfg.documentEnrichers,
    });
  }

  if (cfg.type === 'qdrant') {
    if (!cfg.url) {
      throw new Error('Qdrant URL is required for qdrant RAG type');
    }
    const embedder = resolveEmbedder(cfg, options);
    return new QdrantRag({
      url: cfg.url,
      collectionName: cfg.collectionName ?? 'llm-agent',
      embedder,
      apiKey: cfg.apiKey,
      timeoutMs: cfg.timeoutMs,
    });
  }

  if (cfg.type === 'openai') {
    const embedder = resolveEmbedder(
      { ...cfg, embedder: cfg.embedder ?? 'openai' },
      options,
    );
    return new VectorRag(embedder, {
      dedupThreshold: cfg.dedupThreshold,
      vectorWeight: cfg.vectorWeight,
      keywordWeight: cfg.keywordWeight,
      strategy: cfg.strategy,
      queryPreprocessors: cfg.queryPreprocessors,
      documentEnrichers: cfg.documentEnrichers,
    });
  }

  // Default: 'ollama'
  // Use convenience OllamaRag when no custom embedder is involved
  if (!options?.injectedEmbedder && !cfg.embedder) {
    return new OllamaRag({
      ollamaUrl: cfg.url,
      model: cfg.model,
      timeoutMs: cfg.timeoutMs,
      dedupThreshold: cfg.dedupThreshold,
      vectorWeight: cfg.vectorWeight,
      keywordWeight: cfg.keywordWeight,
      strategy: cfg.strategy,
      queryPreprocessors: cfg.queryPreprocessors,
      documentEnrichers: cfg.documentEnrichers,
    });
  }

  const embedder = resolveEmbedder(
    { ...cfg, embedder: cfg.embedder ?? 'ollama' },
    options,
  );
  return new VectorRag(embedder, {
    dedupThreshold: cfg.dedupThreshold,
    vectorWeight: cfg.vectorWeight,
    keywordWeight: cfg.keywordWeight,
    strategy: cfg.strategy,
    queryPreprocessors: cfg.queryPreprocessors,
    documentEnrichers: cfg.documentEnrichers,
  });
}
