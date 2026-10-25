import type { IBearerCredential } from '@mcp-abap-adt/interfaces-auth';
import type { IEmbedderBatch, IEmbedResult } from '@mcp-abap-adt/llm-agent';
import {
  beginEmbeddingRequest,
  type CallOptions,
  type IUsageRecorder,
  RagError,
  startOperation,
} from '@mcp-abap-adt/llm-agent';
import { decodeEmbedding } from './decode-embedding.js';
import { resolveDeploymentId } from './deployments.js';

export interface FoundationModelsEmbedderConfig {
  usage?: IUsageRecorder;
  model: string;
  resourceGroup?: string;
  /**
   * The bearer credential presented to SAP AI Core. Asked for fresh on every
   * `embed()`/`embedBatch()` call — never cached here, so a rotating token
   * keeps rotating. Build one from a service key with `serviceKeyCredential`
   * (`@mcp-abap-adt/sap-aicore-auth`).
   */
  credential: IBearerCredential;
  /**
   * SAP AI Core REST inference base URL. Not part of the credential
   * (§4.6.3) — its own field, the name `parseServiceKey` returns.
   */
  apiBaseUrl: string;
  /**
   * Azure OpenAI api-version query parameter for OpenAI-family deployments.
   * Default: '2023-05-15'. Ignored for Gemini-family models.
   */
  azureApiVersion?: string;
}

type ModelFamily = 'azure-openai' | 'gemini';

interface NormalizedItem {
  embedding: number[] | string;
  index: number;
}

interface OpenAiEmbeddingsResponse {
  usage?: { prompt_tokens?: number };
  data?: Array<{ embedding: number[] | string; index: number }>;
}

interface GeminiPredictResponse {
  predictions?: Array<{
    embeddings?: { values?: number[]; statistics?: { token_count?: number } };
  }>;
}

export class FoundationModelsEmbedder implements IEmbedderBatch {
  private readonly model: string;
  private readonly usage?: IUsageRecorder;
  private readonly family: ModelFamily;
  private readonly azureApiVersion: string;
  private readonly resourceGroup: string;
  private readonly apiBaseUrl: string;
  private readonly credential: IBearerCredential;
  private deploymentIdPromise: Promise<string> | null = null;

  /**
   * Provider batch cap, set only for families with a confirmed limit — see
   * IBatchSizeLimited. Vertex rejects a batchSize of 251 or more:
   * "supported range is from 1 (inclusive) to 251 (exclusive)".
   *
   * NOT `implements IBatchSizeLimited`: one class serves every family, and the
   * interface's property is required, which would give every instance a cap.
   */
  readonly maxBatchSize?: number;

  constructor(config: FoundationModelsEmbedderConfig) {
    this.model = config.model;
    this.usage = config.usage;
    this.family = detectFamily(config.model);
    this.azureApiVersion = config.azureApiVersion ?? '2023-05-15';
    this.resourceGroup = config.resourceGroup ?? 'default';
    this.apiBaseUrl = config.apiBaseUrl;
    this.credential = config.credential;
    if (this.family === 'gemini') this.maxBatchSize = 250;
  }

  async embed(text: string, options?: CallOptions): Promise<IEmbedResult> {
    const items = await this.requestEmbeddings([text], options);
    if (items.length === 0) {
      throw new RagError('No embeddings returned from SAP AI Core');
    }
    return { vector: decodeEmbedding(items[0].embedding) };
  }

  async embedBatch(
    texts: string[],
    options?: CallOptions,
  ): Promise<IEmbedResult[]> {
    if (texts.length === 0) return [];
    const items = await this.requestEmbeddings(texts, options);
    if (items.length === 0) {
      throw new RagError('No embeddings returned from SAP AI Core batch');
    }
    const sorted = [...items].sort((a, b) => a.index - b.index);
    return sorted.map((item) => ({ vector: decodeEmbedding(item.embedding) }));
  }

  private async requestEmbeddings(
    input: string[],
    options?: CallOptions,
  ): Promise<NormalizedItem[]> {
    // Asked fresh on every request — never cached on the instance — so a
    // rotating credential (client-credentials exchange, Entra ID, ...) keeps
    // rotating rather than being frozen at construction time.
    const token = await this.credential.token();
    const deploymentId = await this.getDeploymentId(token);
    const base = `${this.apiBaseUrl}/v2/inference/deployments/${deploymentId}`;
    const headers = {
      Authorization: `Bearer ${token}`,
      'AI-Resource-Group': this.resourceGroup,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };

    const request = beginEmbeddingRequest(
      options,
      startOperation(options),
      {
        provider: 'sap-aicore',
        model: this.model,
        inputs: input.length,
        inputChars: input.reduce((sum, value) => sum + value.length, 0),
        granularity: 'request',
        retriesVisible: true,
      },
      this.usage,
    );
    try {
      if (this.family === 'gemini') {
        const url = `${base}/models/${encodeURIComponent(this.model)}:predict`;
        const body = {
          instances: input.map((content) => ({ content })),
        };
        const res = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: options?.signal,
        });
        if (!res.ok) {
          request.end({ outcome: 'error', errorCode: String(res.status) });
          const text = await res.text().catch(() => '');
          throw new RagError(
            `SAP AI Core embeddings call failed: ${res.status} ${res.statusText} ${text}`,
          );
        }
        const json = (await res.json()) as GeminiPredictResponse;
        const counts = json.predictions?.map(
          (prediction) => prediction.embeddings?.statistics?.token_count,
        );
        const inputTokens =
          counts?.length && counts.every((count) => count !== undefined)
            ? counts.reduce<number>((sum, count) => sum + (count ?? 0), 0)
            : undefined;
        request.end({
          outcome: json.predictions?.length ? 'ok' : 'error',
          inputTokens,
          tokensSource: inputTokens === undefined ? 'unknown' : 'provider',
        });
        return (json.predictions ?? []).map((p, i) => ({
          embedding: p.embeddings?.values ?? [],
          index: i,
        }));
      }

      // azure-openai
      const url = `${base}/embeddings?api-version=${encodeURIComponent(this.azureApiVersion)}`;
      const body = { input: input.length === 1 ? input[0] : input };
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: options?.signal,
      });
      if (!res.ok) {
        request.end({ outcome: 'error', errorCode: String(res.status) });
        const text = await res.text().catch(() => '');
        throw new RagError(
          `SAP AI Core embeddings call failed: ${res.status} ${res.statusText} ${text}`,
        );
      }
      const json = (await res.json()) as OpenAiEmbeddingsResponse;
      request.end({
        outcome: json.data?.length ? 'ok' : 'error',
        inputTokens: json.usage?.prompt_tokens,
        tokensSource:
          json.usage?.prompt_tokens === undefined ? 'unknown' : 'provider',
      });
      return json.data ?? [];
    } catch (error) {
      request.end({
        outcome:
          options?.signal?.aborted ||
          (error instanceof Error && error.name === 'AbortError')
            ? 'aborted'
            : 'error',
        error,
      });
      throw error;
    }
  }

  private getDeploymentId(token: string): Promise<string> {
    if (!this.deploymentIdPromise) {
      this.deploymentIdPromise = resolveDeploymentId({
        apiBaseUrl: this.apiBaseUrl,
        token,
        resourceGroup: this.resourceGroup,
        model: this.model,
      }).catch((err) => {
        this.deploymentIdPromise = null;
        throw err;
      });
    }
    return this.deploymentIdPromise;
  }
}

function detectFamily(model: string): ModelFamily {
  return /^gemini/i.test(model) ? 'gemini' : 'azure-openai';
}
