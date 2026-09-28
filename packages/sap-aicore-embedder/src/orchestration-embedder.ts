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
  /**
   * The input `type` asymmetric retrieval models require (e.g.
   * `nvidia--llama-3.2-nv-embedqa-1b`: `document` for stored text, `query` for
   * search text). Sent on every call when set; unset, none is sent.
   */
  inputType?: SapAiCoreEmbedderInputType;
}

/** The input types an asymmetric embedding model distinguishes. */
export type SapAiCoreEmbedderInputType = 'document' | 'query';

/** The constructed-destination shape the SAP AI SDK documents. */
export interface OrchestrationEmbedderDestination {
  url: string;
  authentication: 'NoAuthentication';
  headers: Record<string, string>;
}

/**
 * Build the constructed-destination the SDK documents. Called from
 * `embed()`/`embedBatch()` — never at construction, never cached — so a
 * later call re-asks the credential rather than reusing a token that may
 * already be stale. Mirrors `sap-core-ai-provider.ts`'s `buildDestination`
 * (not imported from there: this package does not depend on `sap-aicore-llm`).
 */
async function buildDestination(cfg: {
  apiBaseUrl: string;
  credential: IBearerCredential;
}): Promise<OrchestrationEmbedderDestination> {
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
  private readonly inputType?: SapAiCoreEmbedderInputType;

  constructor(config: OrchestrationScenarioEmbedderConfig) {
    this.model = config.model;
    this.resourceGroup = config.resourceGroup;
    this.apiBaseUrl = config.apiBaseUrl;
    this.credential = config.credential;
    this.inputType = config.inputType;
  }

  private typed<T>(input: T): { input: T; type?: SapAiCoreEmbedderInputType } {
    return this.inputType ? { input, type: this.inputType } : { input };
  }

  async embed(text: string, _options?: CallOptions): Promise<IEmbedResult> {
    const destination = await buildDestination({
      apiBaseUrl: this.apiBaseUrl,
      credential: this.credential,
    });
    const client = await this.createClient(destination);
    const response = await client.embed(this.typed(text));
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
    const destination = await buildDestination({
      apiBaseUrl: this.apiBaseUrl,
      credential: this.credential,
    });
    const client = await this.createClient(destination);
    const response = await client.embed(this.typed(texts));
    const embeddings = response.getEmbeddings();
    if (!embeddings || embeddings.length === 0) {
      throw new RagError('No embeddings returned from SAP AI Core batch');
    }
    const sorted = [...embeddings].sort((a, b) => a.index - b.index);
    return sorted.map((e) => ({ vector: decodeEmbedding(e.embedding) }));
  }

  /**
   * Create an OrchestrationEmbeddingClient for the given destination.
   *
   * `destination` is built by the caller via `buildDestination()`, per call —
   * same split as `SapCoreAIProvider.createClient()` in `sap-aicore-llm`,
   * deliberately: it lets a test spy on this method and observe the
   * destination (and the credential's token behind it) that `embed()`/
   * `embedBatch()` actually computed, the way `sap-core-ai-provider.test.ts`
   * already does for the LLM provider.
   */
  private async createClient(destination: OrchestrationEmbedderDestination) {
    const { OrchestrationEmbeddingClient } = await import(
      '@sap-ai-sdk/orchestration'
    );
    const modelName = this
      .model as unknown as import('@sap-ai-sdk/orchestration').EmbeddingModel;
    return new OrchestrationEmbeddingClient(
      { embeddings: { model: { name: modelName } } },
      this.resourceGroup ? { resourceGroup: this.resourceGroup } : undefined,
      destination,
    );
  }
}
