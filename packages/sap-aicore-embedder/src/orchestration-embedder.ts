import type { IEmbedderBatch, IEmbedResult } from '@mcp-abap-adt/llm-agent';
import { type CallOptions, RagError } from '@mcp-abap-adt/llm-agent';

export interface OrchestrationScenarioEmbedderConfig {
  model: string;
  resourceGroup?: string;
}

export class OrchestrationScenarioEmbedder implements IEmbedderBatch {
  private readonly model: string;
  private readonly resourceGroup?: string;

  constructor(config: OrchestrationScenarioEmbedderConfig) {
    this.model = config.model;
    this.resourceGroup = config.resourceGroup;
  }

  async embed(text: string, _options?: CallOptions): Promise<IEmbedResult> {
    const client = await this.createClient();
    const response = await client.embed({ input: text });
    const embeddings = response.getEmbeddings();
    if (!embeddings || embeddings.length === 0) {
      throw new RagError('No embeddings returned from SAP AI Core');
    }
    return { vector: decodeEmbedding(embeddings[0].embedding) };
  }

  async embedBatch(
    texts: string[],
    _options?: CallOptions,
  ): Promise<IEmbedResult[]> {
    if (texts.length === 0) return [];
    const client = await this.createClient();
    const response = await client.embed({ input: texts });
    const embeddings = response.getEmbeddings();
    if (!embeddings || embeddings.length === 0) {
      throw new RagError('No embeddings returned from SAP AI Core batch');
    }
    const sorted = [...embeddings].sort((a, b) => a.index - b.index);
    return sorted.map((e) => ({ vector: decodeEmbedding(e.embedding) }));
  }

  private async createClient() {
    const { OrchestrationEmbeddingClient } = await import(
      '@sap-ai-sdk/orchestration'
    );
    const modelName = this
      .model as unknown as import('@sap-ai-sdk/orchestration').EmbeddingModel;
    return new OrchestrationEmbeddingClient(
      { embeddings: { model: { name: modelName } } },
      this.resourceGroup ? { resourceGroup: this.resourceGroup } : undefined,
    );
  }
}

function decodeEmbedding(embedding: number[] | string): number[] {
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
