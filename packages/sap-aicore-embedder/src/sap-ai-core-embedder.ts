import type {
  CallOptions,
  IEmbedderBatch,
  IEmbedResult,
} from '@mcp-abap-adt/llm-agent';
import {
  type FoundationModelsCredentials,
  FoundationModelsEmbedder,
} from './foundation-embedder.js';
import { OrchestrationScenarioEmbedder } from './orchestration-embedder.js';

export type SapAiCoreEmbedderScenario = 'foundation-models' | 'orchestration';

export interface SapAiCoreEmbedderConfig {
  /** Embedding model name (e.g. 'text-embedding-3-small', 'gemini-embedding') */
  model: string;
  /** SAP AI Core resource group. Default: 'default'. */
  resourceGroup?: string;
  /**
   * SAP AI Core scenario under which the embedding model is deployed.
   * - `'foundation-models'` (default): calls the AI Core REST inference API directly.
   *   Works on tenants where embedding models are deployed under the foundation-models scenario.
   * - `'orchestration'`: uses `OrchestrationEmbeddingClient` from `@sap-ai-sdk/orchestration`.
   *   Requires an orchestration-scenario deployment of the embedding model.
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

export class SapAiCoreEmbedder implements IEmbedderBatch {
  private readonly backend: IEmbedderBatch;

  constructor(config: SapAiCoreEmbedderConfig) {
    const scenario = config.scenario ?? 'foundation-models';
    if (scenario === 'orchestration') {
      this.backend = new OrchestrationScenarioEmbedder({
        model: config.model,
        resourceGroup: config.resourceGroup,
      });
    } else {
      this.backend = new FoundationModelsEmbedder({
        model: config.model,
        resourceGroup: config.resourceGroup,
        credentials: config.credentials,
      });
    }
  }

  embed(text: string, options?: CallOptions): Promise<IEmbedResult> {
    return this.backend.embed(text, options);
  }

  embedBatch(texts: string[], options?: CallOptions): Promise<IEmbedResult[]> {
    return this.backend.embedBatch(texts, options);
  }
}
