/**
 * SAP AI Core Embedder — IEmbedderBatch implementation using @sap-ai-sdk/orchestration.
 *
 * Generates text embeddings via SAP AI Core embedding model deployments.
 * Authentication: reads AICORE_SERVICE_KEY env var automatically (same as LLM provider).
 */

import type { IEmbedderBatch, IEmbedResult } from '@mcp-abap-adt/llm-agent';
import { type CallOptions, RagError } from '@mcp-abap-adt/llm-agent';

export interface SapAiCoreEmbedderConfig {
  /** Embedding model name (e.g. 'text-embedding-3-small') */
  model: string;
  /** SAP AI Core resource group (optional) */
  resourceGroup?: string;
}

export class SapAiCoreEmbedder implements IEmbedderBatch {
  private readonly model: string;
  private readonly resourceGroup?: string;

  constructor(config: SapAiCoreEmbedderConfig) {
    this.model = config.model;
    this.resourceGroup = config.resourceGroup;
  }

  async embed(text: string, _options?: CallOptions): Promise<IEmbedResult> {
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
      throw new RagError('No embeddings returned from SAP AI Core');
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
      return { vector: Array.from(float32) };
    }

    return { vector: embedding };
  }

  async embedBatch(
    texts: string[],
    _options?: CallOptions,
  ): Promise<IEmbedResult[]> {
    if (texts.length === 0) return [];

    const { OrchestrationEmbeddingClient } = await import(
      '@sap-ai-sdk/orchestration'
    );

    const modelName = this
      .model as unknown as import('@sap-ai-sdk/orchestration').EmbeddingModel;
    const client = new OrchestrationEmbeddingClient(
      { embeddings: { model: { name: modelName } } },
      this.resourceGroup ? { resourceGroup: this.resourceGroup } : undefined,
    );

    const response = await client.embed({ input: texts });
    const embeddings = response.getEmbeddings();

    if (!embeddings || embeddings.length === 0) {
      throw new RagError('No embeddings returned from SAP AI Core batch');
    }

    const sorted = [...embeddings].sort((a, b) => a.index - b.index);
    return sorted.map((e) => {
      if (typeof e.embedding === 'string') {
        const buffer = Buffer.from(e.embedding, 'base64');
        const float32 = new Float32Array(
          buffer.buffer,
          buffer.byteOffset,
          buffer.length / 4,
        );
        return { vector: Array.from(float32) };
      }
      return { vector: e.embedding };
    });
  }
}
