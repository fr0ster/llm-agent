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
import { InMemoryRag, VectorRag } from '@mcp-abap-adt/llm-agent';
import { OllamaRag } from '@mcp-abap-adt/ollama-embedder';
import { OpenAIProvider } from '@mcp-abap-adt/openai-llm';
import {
  type SapAICoreCredentials,
  SapCoreAIProvider,
} from '@mcp-abap-adt/sap-aicore-llm';
import { LlmAdapter } from './adapters/llm-adapter.js';
import { LlmProviderBridge } from './adapters/llm-provider-bridge.js';
import { NonStreamingLlm } from './adapters/non-streaming-llm.js';
import { builtInEmbedderFactories } from './embedder-factories.js';
import type { IModelResolver } from './interfaces/model-resolver.js';
import { resolveRag } from './rag-factories.js';

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
      llm = new LlmAdapter(new LlmProviderBridge(provider), {
        model: provider.model,
        getModels: () => provider.getModels?.() ?? Promise.resolve([]),
        getEmbeddingModels: () =>
          provider.getEmbeddingModels?.() ?? Promise.resolve([]),
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
      llm = new LlmAdapter(new LlmProviderBridge(provider), {
        model: provider.model,
        getModels: () => provider.getModels?.() ?? Promise.resolve([]),
        getEmbeddingModels: () =>
          provider.getEmbeddingModels?.() ?? Promise.resolve([]),
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
      llm = new LlmAdapter(new LlmProviderBridge(provider), {
        model: provider.model,
        getModels: () => provider.getModels?.() ?? Promise.resolve([]),
        getEmbeddingModels: () =>
          provider.getEmbeddingModels?.() ?? Promise.resolve([]),
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
      llm = new LlmAdapter(new LlmProviderBridge(provider), {
        model: provider.model,
        getModels: () => provider.getModels?.() ?? Promise.resolve([]),
        getEmbeddingModels: () =>
          provider.getEmbeddingModels?.() ?? Promise.resolve([]),
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
  /** SAP AI Core resource group (used when embedder is 'sap-ai-core' / 'sap-aicore'). */
  resourceGroup?: string;
  /**
   * SAP AI Core scenario for the embedding model deployment.
   * `'orchestration'` (default) uses the SAP SDK; `'foundation-models'` calls the REST inference API.
   */
  scenario?: 'orchestration' | 'foundation-models';
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
  const opts = {
    url: cfg.url,
    apiKey: cfg.apiKey,
    model: cfg.model,
    timeoutMs: cfg.timeoutMs,
    resourceGroup: cfg.resourceGroup,
    scenario: cfg.scenario,
  };

  // Check built-in prefetch-based factories first
  if (name in builtInEmbedderFactories) {
    return builtInEmbedderFactories[name](opts);
  }

  // Fall back to consumer-registered extra factories
  const extraFactory = options?.extraFactories?.[name];
  if (!extraFactory) {
    const known = [
      ...Object.keys(builtInEmbedderFactories),
      ...Object.keys(options?.extraFactories ?? {}),
    ];
    throw new Error(
      `Unknown embedder "${name}". Register a factory or use: ${known.join(', ')}`,
    );
  }
  return extraFactory(opts);
}

// ---------------------------------------------------------------------------
// RAG resolution
// ---------------------------------------------------------------------------

export interface RagResolutionConfig {
  type?:
    | 'ollama'
    | 'openai'
    | 'in-memory'
    | 'qdrant'
    | 'hana-vector'
    | 'pg-vector';
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
  /** Connection string or URL for external vector backends. */
  connectionString?: string;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  schema?: string;
  dimension?: number;
  autoCreateSchema?: boolean;
  poolMax?: number;
  connectTimeout?: number;
  /** SAP AI Core resource group (used when embedder is 'sap-ai-core' / 'sap-aicore'). */
  resourceGroup?: string;
  /**
   * SAP AI Core scenario for the embedding model deployment.
   * `'orchestration'` (default) uses the SAP SDK; `'foundation-models'` calls the REST inference API.
   */
  scenario?: 'orchestration' | 'foundation-models';
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
    return resolveRag('qdrant', {
      url: cfg.url,
      collectionName: cfg.collectionName ?? 'llm-agent',
      embedder,
      apiKey: cfg.apiKey,
      timeoutMs: cfg.timeoutMs,
    });
  }

  if (cfg.type === 'hana-vector') {
    if (!cfg.collectionName) {
      throw new Error('collectionName is required for hana-vector RAG type');
    }
    const embedder = resolveEmbedder(cfg, options);
    return resolveRag('hana-vector', {
      connectionString: cfg.connectionString,
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password: cfg.password,
      schema: cfg.schema,
      collectionName: cfg.collectionName,
      dimension: cfg.dimension,
      autoCreateSchema: cfg.autoCreateSchema,
      poolMax: cfg.poolMax,
      connectTimeout: cfg.connectTimeout,
      embedder,
    });
  }

  if (cfg.type === 'pg-vector') {
    if (!cfg.collectionName) {
      throw new Error('collectionName is required for pg-vector RAG type');
    }
    const embedder = resolveEmbedder(cfg, options);
    return resolveRag('pg-vector', {
      connectionString: cfg.connectionString,
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password: cfg.password,
      database: cfg.database,
      schema: cfg.schema,
      collectionName: cfg.collectionName,
      dimension: cfg.dimension,
      autoCreateSchema: cfg.autoCreateSchema,
      poolMax: cfg.poolMax,
      connectTimeout: cfg.connectTimeout,
      embedder,
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
