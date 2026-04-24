/**
 * SAP AI Core Embedder — IEmbedderBatch implementation using @sap-ai-sdk/orchestration.
 *
 * Generates text embeddings via SAP AI Core embedding model deployments.
 * Authentication: reads AICORE_SERVICE_KEY env var automatically (same as LLM provider).
 */

import type {
  CallOptions,
  IEmbedderBatch,
  IEmbedResult,
} from '@mcp-abap-adt/llm-agent';
import { OrchestrationScenarioEmbedder } from './orchestration-embedder.js';

export interface SapAiCoreEmbedderConfig {
  /** Embedding model name (e.g. 'text-embedding-3-small') */
  model: string;
  /** SAP AI Core resource group (optional) */
  resourceGroup?: string;
}

export class SapAiCoreEmbedder implements IEmbedderBatch {
  private readonly backend: IEmbedderBatch;

  constructor(config: SapAiCoreEmbedderConfig) {
    this.backend = new OrchestrationScenarioEmbedder({
      model: config.model,
      resourceGroup: config.resourceGroup,
    });
  }

  embed(text: string, options?: CallOptions): Promise<IEmbedResult> {
    return this.backend.embed(text, options);
  }

  embedBatch(texts: string[], options?: CallOptions): Promise<IEmbedResult[]> {
    return this.backend.embedBatch(texts, options);
  }
}
