/**
 * Provider resolution — the composition root for concrete implementations.
 *
 * This module is the ONLY place that knows about concrete LLM providers,
 * embedders, and RAG implementations. All factories (Builder, SmartServer,
 * pipeline YAML) delegate here to resolve config into interface instances.
 */
import type { EmbedderFactory, IDocumentEnricher, IEmbedder, ILlm, IQueryPreprocessor, IRag, ISearchStrategy } from '@mcp-abap-adt/llm-agent';
import { type SapAICoreCredentials } from '@mcp-abap-adt/sap-aicore-llm';
import type { IModelResolver } from './interfaces/model-resolver.js';
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
export declare function makeLlm(cfg: LlmProviderConfig, temperature: number): ILlm;
/**
 * Create a default DeepSeek-based ILlm from simple config (apiKey + model).
 * Used by the flat YAML / CLI path.
 */
export declare function makeDefaultLlm(apiKey: string, model: string, temperature: number): ILlm;
/**
 * Default IModelResolver — delegates to makeLlm() with the given provider settings.
 * Returns fully constructed ILlm instances ready for use with SmartAgent.reconfigure().
 */
export declare class DefaultModelResolver implements IModelResolver {
    private readonly providerConfig;
    private readonly defaults;
    constructor(providerConfig: Omit<LlmProviderConfig, 'model'>, defaults?: {
        temperature?: number;
    });
    resolve(modelName: string, role: 'main' | 'classifier' | 'helper'): Promise<ILlm>;
}
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
export declare function resolveEmbedder(cfg: EmbedderResolutionConfig, options?: EmbedderResolutionOptions): IEmbedder;
export interface RagResolutionConfig {
    type?: 'ollama' | 'openai' | 'in-memory' | 'qdrant' | 'hana-vector' | 'pg-vector';
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
export declare function makeRag(cfg: RagResolutionConfig, options?: RagResolutionOptions): IRag;
//# sourceMappingURL=providers.d.ts.map