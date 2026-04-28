import type { IEmbedderBatch, IEmbedResult } from '@mcp-abap-adt/llm-agent';
import { type CallOptions } from '@mcp-abap-adt/llm-agent';
export interface FoundationModelsCredentials {
    clientId: string;
    clientSecret: string;
    tokenUrl: string;
    apiBaseUrl: string;
}
export interface FoundationModelsEmbedderConfig {
    model: string;
    resourceGroup?: string;
    /** Explicit credentials. When omitted, `AICORE_SERVICE_KEY` env var is parsed. */
    credentials?: FoundationModelsCredentials;
    /**
     * Azure OpenAI api-version query parameter for OpenAI-family deployments.
     * Default: '2023-05-15'. Ignored for Gemini-family models.
     */
    azureApiVersion?: string;
}
export declare class FoundationModelsEmbedder implements IEmbedderBatch {
    private readonly model;
    private readonly family;
    private readonly azureApiVersion;
    private readonly resourceGroup;
    private readonly apiBaseUrl;
    private readonly tokenProvider;
    private deploymentIdPromise;
    constructor(config: FoundationModelsEmbedderConfig);
    embed(text: string, _options?: CallOptions): Promise<IEmbedResult>;
    embedBatch(texts: string[], _options?: CallOptions): Promise<IEmbedResult[]>;
    private requestEmbeddings;
    private getDeploymentId;
    private loadCredentialsFromEnv;
}
//# sourceMappingURL=foundation-embedder.d.ts.map