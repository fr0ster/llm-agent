import type { CallOptions, IEmbedderBatch, IEmbedResult } from '@mcp-abap-adt/llm-agent';
import { type FoundationModelsCredentials } from './foundation-embedder.js';
export type SapAiCoreEmbedderScenario = 'foundation-models' | 'orchestration';
export interface SapAiCoreEmbedderConfig {
    /** Embedding model name (e.g. 'text-embedding-3-small', 'gemini-embedding') */
    model: string;
    /** SAP AI Core resource group. Default: 'default'. */
    resourceGroup?: string;
    /**
     * SAP AI Core scenario under which the embedding model is deployed.
     * - `'orchestration'` (default): uses `OrchestrationEmbeddingClient` from `@sap-ai-sdk/orchestration`.
     *   Requires an orchestration-scenario deployment of the embedding model. This matches v11.0.0 behavior.
     * - `'foundation-models'`: calls the AI Core REST inference API directly.
     *   Use this when your embedding models are deployed under the foundation-models scenario
     *   (common for tenants where SAP AI Core embedders such as `gemini-embedding` and `text-embedding-3-small`
     *   are deployed outside the orchestration scenario).
     */
    scenario?: SapAiCoreEmbedderScenario;
    /**
     * Explicit credentials for the `foundation-models` scenario.
     * When omitted, `AICORE_SERVICE_KEY` env var is parsed instead.
     * Ignored for `scenario: 'orchestration'` (the SAP SDK handles auth there).
     */
    credentials?: FoundationModelsCredentials;
}
export type { FoundationModelsCredentials };
export declare class SapAiCoreEmbedder implements IEmbedderBatch {
    private readonly backend;
    constructor(config: SapAiCoreEmbedderConfig);
    embed(text: string, options?: CallOptions): Promise<IEmbedResult>;
    embedBatch(texts: string[], options?: CallOptions): Promise<IEmbedResult[]>;
}
//# sourceMappingURL=sap-ai-core-embedder.d.ts.map