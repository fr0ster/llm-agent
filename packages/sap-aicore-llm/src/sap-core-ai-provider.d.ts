/**
 * SAP AI SDK LLM Provider
 *
 * Implementation of LLMProvider interface using @sap-ai-sdk/orchestration.
 * Authentication is handled automatically via AICORE_SERVICE_KEY environment variable.
 *
 * Architecture:
 * - Agent → SapCoreAIProvider → OrchestrationClient → SAP AI Core → External LLM
 */
import type { IModelInfo, LLMProviderConfig, LLMResponse, Message } from '@mcp-abap-adt/llm-agent';
import { BaseLLMProvider } from '@mcp-abap-adt/llm-agent';
/**
 * OAuth2 Client Credentials for programmatic SAP AI Core authentication.
 * When provided, bypasses the AICORE_SERVICE_KEY environment variable.
 */
export interface SapAICoreCredentials {
    /** OAuth2 client ID (e.g. 'sb-xxx...') */
    clientId: string;
    /** OAuth2 client secret */
    clientSecret: string;
    /** Token endpoint URL (e.g. 'https://xxx.authentication.xxx.hana.ondemand.com/oauth/token') */
    tokenServiceUrl: string;
    /** SAP AI Core API base URL (e.g. 'https://api.ai.xxx.aicore.cfapps.xxx.hana.ondemand.com') */
    servicUrl: string;
}
export interface SapCoreAIConfig extends LLMProviderConfig {
    /** Model name (e.g. 'gpt-4o', 'claude-3-5-sonnet'). Default: 'gpt-4o' */
    model?: string;
    /** Temperature for generation. Default: 0.7 */
    temperature?: number;
    /** Max tokens for generation. Default: 16384 */
    maxTokens?: number;
    /** SAP AI Core resource group */
    resourceGroup?: string;
    /**
     * Programmatic OAuth2 credentials for SAP AI Core.
     * When set, the SDK uses these instead of the AICORE_SERVICE_KEY env var.
     */
    credentials?: SapAICoreCredentials;
    /** Optional logger */
    log?: {
        debug(message: string, meta?: Record<string, unknown>): void;
        error(message: string, meta?: Record<string, unknown>): void;
    };
}
/**
 * SAP AI SDK Provider implementation
 *
 * Uses @sap-ai-sdk/orchestration for authentication and LLM access.
 * A new OrchestrationClient is created per call because tools may change between calls.
 */
export declare class SapCoreAIProvider extends BaseLLMProvider<SapCoreAIConfig> {
    readonly model: string;
    readonly resourceGroup?: string;
    private log?;
    private readonly destination?;
    private readonly httpsAgent;
    private modelsCache;
    private modelsCacheExpiry;
    private static readonly MODELS_CACHE_TTL_MS;
    private modelOverride?;
    private static summarizeMessages;
    private static summarizeStreamingError;
    /** Set a per-request model override. Cleared after each chat/streamChat call. */
    setModelOverride(model?: string): void;
    constructor(config: SapCoreAIConfig);
    chat(messages: Message[], tools?: unknown[]): Promise<LLMResponse>;
    streamChat(messages: Message[], tools?: unknown[]): AsyncIterable<LLMResponse>;
    /**
     * Fetch all models from SAP AI Core, caching the result for MODELS_CACHE_TTL_MS.
     * Returns ALL models regardless of capability — callers filter as needed.
     */
    private _fetchAllModels;
    getModels(): Promise<IModelInfo[]>;
    getEmbeddingModels(): Promise<IModelInfo[]>;
    /**
     * Extract detailed error information from SAP AI SDK / axios errors.
     */
    private static extractErrorDetail;
    /**
     * Create an OrchestrationClient with the given tools configuration.
     * Tools are expected in OpenAI function format (already converted by the agent layer).
     */
    private createClient;
    /**
     * Format messages for the SAP AI SDK (OpenAI-compatible format).
     */
    private formatMessages;
}
//# sourceMappingURL=sap-core-ai-provider.d.ts.map