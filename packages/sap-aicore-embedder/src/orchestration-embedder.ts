import type { IBearerCredential } from '@mcp-abap-adt/interfaces-auth';
import type { IEmbedderBatch, IEmbedResult } from '@mcp-abap-adt/llm-agent';
import { type CallOptions, RagError } from '@mcp-abap-adt/llm-agent';
import { decodeEmbedding } from './decode-embedding.js';

export interface OrchestrationScenarioEmbedderConfig {
  model: string;
  resourceGroup?: string;
  /**
   * The bearer credential presented to SAP AI Core. Asked for fresh on every
   * `embed()`/`embedBatch()` call via `buildDestination` — never cached here.
   * Build one from a service key with `serviceKeyCredential`
   * (`@mcp-abap-adt/sap-aicore-auth`).
   */
  credential: IBearerCredential;
  /**
   * SAP AI Core orchestration base URL. Not part of the credential
   * (§4.6.3) — its own field, the name `parseServiceKey` returns.
   */
  apiBaseUrl: string;
}

/**
 * The constructed-destination shape the SAP AI SDK documents. Built fresh on
 * every call — never at construction — so a retry or a later call re-asks the
 * credential rather than reusing a token that may already be stale.
 */
async function buildDestination(cfg: {
  apiBaseUrl: string;
  credential: IBearerCredential;
}): Promise<{
  url: string;
  authentication: 'NoAuthentication';
  headers: Record<string, string>;
}> {
  return {
    url: cfg.apiBaseUrl,
    authentication: 'NoAuthentication',
    headers: { Authorization: `Bearer ${await cfg.credential.token()}` },
  };
}

export class OrchestrationScenarioEmbedder implements IEmbedderBatch {
  private readonly model: string;
  private readonly resourceGroup?: string;
  private readonly apiBaseUrl: string;
  private readonly credential: IBearerCredential;

  constructor(config: OrchestrationScenarioEmbedderConfig) {
    this.model = config.model;
    this.resourceGroup = config.resourceGroup;
    this.apiBaseUrl = config.apiBaseUrl;
    this.credential = config.credential;
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
    const destination = await buildDestination({
      apiBaseUrl: this.apiBaseUrl,
      credential: this.credential,
    });
    return new OrchestrationEmbeddingClient(
      { embeddings: { model: { name: modelName } } },
      this.resourceGroup ? { resourceGroup: this.resourceGroup } : undefined,
      destination,
    );
  }
}
