/**
 * SAP AI Core Embedder — IEmbedder implementation using @sap-ai-sdk/orchestration.
 *
 * Generates text embeddings via SAP AI Core embedding model deployments.
 * Authentication: reads AICORE_SERVICE_KEY env var automatically (same as LLM provider).
 */

import type { IEmbedder } from '../interfaces/rag.js';
import type { CallOptions } from '../interfaces/types.js';

export interface SapAiCoreEmbedderConfig {
  /** Embedding model name (e.g. 'text-embedding-3-small') */
  model: string;
  /** SAP AI Core resource group (optional) */
  resourceGroup?: string;
}

export class SapAiCoreEmbedder implements IEmbedder {
  private readonly model: string;
  private readonly resourceGroup?: string;

  constructor(config: SapAiCoreEmbedderConfig) {
    this.model = config.model;
    this.resourceGroup = config.resourceGroup;
  }

  async embed(text: string, _options?: CallOptions): Promise<number[]> {
    const { OrchestrationEmbeddingClient } = await import(
      '@sap-ai-sdk/orchestration'
    );

    const modelName = this
      .model as unknown as import('@sap-ai-sdk/orchestration').EmbeddingModel;
    const client = new OrchestrationEmbeddingClient(
      { embeddings: { model: { name: modelName } } },
      this.resourceGroup ? { resourceGroup: this.resourceGroup } : undefined,
    );

    const response = await client.embed({ input: text });
    const embeddings = response.getEmbeddings();

    if (!embeddings || embeddings.length === 0) {
      throw new Error('No embeddings returned from SAP AI Core');
    }

    const embedding = embeddings[0].embedding;

    // Handle base64-encoded embeddings
    if (typeof embedding === 'string') {
      const buffer = Buffer.from(embedding, 'base64');
      const float32 = new Float32Array(
        buffer.buffer,
        buffer.byteOffset,
        buffer.length / 4,
      );
      return Array.from(float32);
    }

    return embedding;
  }
}
