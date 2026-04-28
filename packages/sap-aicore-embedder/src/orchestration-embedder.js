import { RagError } from '@mcp-abap-adt/llm-agent';
import { decodeEmbedding } from './decode-embedding.js';
export class OrchestrationScenarioEmbedder {
  model;
  resourceGroup;
  constructor(config) {
    this.model = config.model;
    this.resourceGroup = config.resourceGroup;
  }
  async embed(text, _options) {
    const client = await this.createClient();
    const response = await client.embed({ input: text });
    const embeddings = response.getEmbeddings();
    if (!embeddings || embeddings.length === 0) {
      throw new RagError('No embeddings returned from SAP AI Core');
    }
    return { vector: decodeEmbedding(embeddings[0].embedding) };
  }
  async embedBatch(texts, _options) {
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
  async createClient() {
    const { OrchestrationEmbeddingClient } = await import(
      '@sap-ai-sdk/orchestration'
    );
    const modelName = this.model;
    return new OrchestrationEmbeddingClient(
      { embeddings: { model: { name: modelName } } },
      this.resourceGroup ? { resourceGroup: this.resourceGroup } : undefined,
    );
  }
}
//# sourceMappingURL=orchestration-embedder.js.map
