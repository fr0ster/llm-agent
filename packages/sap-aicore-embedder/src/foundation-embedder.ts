// packages/sap-aicore-embedder/src/foundation-embedder.ts
import type { IEmbedderBatch, IEmbedResult } from '@mcp-abap-adt/llm-agent';
import { type CallOptions, RagError } from '@mcp-abap-adt/llm-agent';
import { TokenProvider } from './auth.js';
import { decodeEmbedding } from './decode-embedding.js';
import { resolveDeploymentId } from './deployments.js';
import { parseServiceKey } from './service-key.js';

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
}

interface EmbeddingsResponseItem {
  embedding: number[] | string;
  index: number;
}

interface EmbeddingsResponse {
  data?: EmbeddingsResponseItem[];
}

export class FoundationModelsEmbedder implements IEmbedderBatch {
  private readonly model: string;
  private readonly resourceGroup: string;
  private readonly apiBaseUrl: string;
  private readonly tokenProvider: TokenProvider;
  private deploymentIdPromise: Promise<string> | null = null;

  constructor(config: FoundationModelsEmbedderConfig) {
    const creds = config.credentials ?? this.loadCredentialsFromEnv();
    this.model = config.model;
    this.resourceGroup = config.resourceGroup ?? 'default';
    this.apiBaseUrl = creds.apiBaseUrl;
    this.tokenProvider = new TokenProvider({
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
      tokenUrl: creds.tokenUrl,
    });
  }

  async embed(text: string, _options?: CallOptions): Promise<IEmbedResult> {
    const items = await this.requestEmbeddings([text]);
    if (items.length === 0) {
      throw new RagError('No embeddings returned from SAP AI Core');
    }
    return { vector: decodeEmbedding(items[0].embedding) };
  }

  async embedBatch(
    texts: string[],
    _options?: CallOptions,
  ): Promise<IEmbedResult[]> {
    if (texts.length === 0) return [];
    const items = await this.requestEmbeddings(texts);
    if (items.length === 0) {
      throw new RagError('No embeddings returned from SAP AI Core batch');
    }
    const sorted = [...items].sort((a, b) => a.index - b.index);
    return sorted.map((item) => ({ vector: decodeEmbedding(item.embedding) }));
  }

  private async requestEmbeddings(
    input: string[],
  ): Promise<EmbeddingsResponseItem[]> {
    const token = await this.tokenProvider.getToken();
    const deploymentId = await this.getDeploymentId(token);
    const url = `${this.apiBaseUrl}/v2/inference/deployments/${deploymentId}/embeddings`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'AI-Resource-Group': this.resourceGroup,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ input: input.length === 1 ? input[0] : input }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new RagError(
        `SAP AI Core embeddings call failed: ${res.status} ${res.statusText} ${text}`,
      );
    }
    const body = (await res.json()) as EmbeddingsResponse;
    return body.data ?? [];
  }

  private getDeploymentId(token: string): Promise<string> {
    if (!this.deploymentIdPromise) {
      this.deploymentIdPromise = resolveDeploymentId({
        apiBaseUrl: this.apiBaseUrl,
        token,
        resourceGroup: this.resourceGroup,
        model: this.model,
      }).catch((err) => {
        // Don't cache failures
        this.deploymentIdPromise = null;
        throw err;
      });
    }
    return this.deploymentIdPromise;
  }

  private loadCredentialsFromEnv(): FoundationModelsCredentials {
    const raw = process.env.AICORE_SERVICE_KEY;
    if (!raw) {
      throw new Error(
        'SapAiCoreEmbedder (foundation-models): no credentials provided and AICORE_SERVICE_KEY env var is not set',
      );
    }
    return parseServiceKey(raw);
  }
}
