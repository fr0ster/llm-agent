import type { IBearerCredential } from '@mcp-abap-adt/interfaces-auth';
import type { IEmbedderBatch, IEmbedResult } from '@mcp-abap-adt/llm-agent';
import { type CallOptions, RagError } from '@mcp-abap-adt/llm-agent';
import { decodeEmbedding } from './decode-embedding.js';
import { resolveDeploymentId } from './deployments.js';

export interface FoundationModelsEmbedderConfig {
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
  data?: Array<{ embedding: number[] | string; index: number }>;
}

interface GeminiPredictResponse {
  predictions?: Array<{ embeddings?: { values?: number[] } }>;
}

export class FoundationModelsEmbedder implements IEmbedderBatch {
  private readonly model: string;
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
    this.family = detectFamily(config.model);
    this.azureApiVersion = config.azureApiVersion ?? '2023-05-15';
    this.resourceGroup = config.resourceGroup ?? 'default';
    this.apiBaseUrl = config.apiBaseUrl;
    this.credential = config.credential;
    if (this.family === 'gemini') this.maxBatchSize = 250;
  }

  async embed(text: string, _options?: CallOptions): Promise<IEmbedResult> {
    const [item] = await this.requestEmbeddings([text]);
    return { vector: toVector(item) };
  }

  async embedBatch(
    texts: string[],
    _options?: CallOptions,
  ): Promise<IEmbedResult[]> {
    if (texts.length === 0) return [];
    const items = await this.requestEmbeddings(texts);
    const sorted = [...items].sort((a, b) => a.index - b.index);
    // One item per text position: the indexes are exactly 0..n-1.
    sorted.forEach((item, i) => {
      if (item.index !== i) {
        throw new RagError(
          `SAP AI Core batch indexes do not cover 0..${texts.length - 1} (position ${i} has index ${item.index})`,
          'EMBED_ERROR',
        );
      }
    });
    return sorted.map((item) => ({ vector: toVector(item) }));
  }

  /**
   * Spec §10.5.4 R12: one embedding per text, or `EMBED_ERROR` — a short
   * answer, a missing `data`, an empty vector or an HTTP failure is never
   * returned as a result.
   */
  private async requestEmbeddings(input: string[]): Promise<NormalizedItem[]> {
    const items = await this.callInference(input);
    if (items.length !== input.length) {
      throw new RagError(
        `SAP AI Core returned ${items.length} embeddings for ${input.length} texts`,
        'EMBED_ERROR',
      );
    }
    return items;
  }

  private async callInference(input: string[]): Promise<NormalizedItem[]> {
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

    if (this.family === 'gemini') {
      const url = `${base}/models/${encodeURIComponent(this.model)}:predict`;
      const body = {
        instances: input.map((content) => ({ content })),
      };
      const json = (await postEmbeddings(
        url,
        headers,
        body,
      )) as GeminiPredictResponse;
      return (json.predictions ?? []).map((p, i) => {
        const values = p.embeddings?.values;
        if (!Array.isArray(values)) {
          throw new RagError(
            `SAP AI Core returned an empty embedding (prediction ${i} has no values)`,
            'EMBED_ERROR',
          );
        }
        return { embedding: values, index: i };
      });
    }

    // azure-openai
    const url = `${base}/embeddings?api-version=${encodeURIComponent(this.azureApiVersion)}`;
    const body = { input: input.length === 1 ? input[0] : input };
    const json = (await postEmbeddings(
      url,
      headers,
      body,
    )) as OpenAiEmbeddingsResponse;
    if (!Array.isArray(json.data)) {
      throw new RagError(
        'SAP AI Core embeddings answer has no data',
        'EMBED_ERROR',
      );
    }
    return json.data;
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

/**
 * POST one embeddings request and read its JSON answer. A network rejection,
 * an HTTP failure or an answer that is not JSON is `EMBED_ERROR` (spec §10.5.4
 * R12).
 */
async function postEmbeddings(
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new RagError(
      `SAP AI Core embeddings call failed: ${String(err)}`,
      'EMBED_ERROR',
    );
  }
  if (!res.ok) {
    // Diagnostics only: the body text completes the message when readable.
    const text = await res.text().catch(() => '');
    throw new RagError(
      `SAP AI Core embeddings call failed: ${res.status} ${res.statusText} ${text}`,
      'EMBED_ERROR',
    );
  }
  try {
    return await res.json();
  } catch (err) {
    throw new RagError(
      `SAP AI Core embeddings answer is not JSON: ${String(err)}`,
      'EMBED_ERROR',
    );
  }
}

/** The decoded vector of one item; an empty one is `EMBED_ERROR`. */
function toVector(item: NormalizedItem): number[] {
  const vector = decodeEmbedding(item.embedding);
  if (vector.length === 0) {
    throw new RagError(
      `SAP AI Core returned an empty embedding (item ${item.index})`,
      'EMBED_ERROR',
    );
  }
  return vector;
}

function detectFamily(model: string): ModelFamily {
  return /^gemini/i.test(model) ? 'gemini' : 'azure-openai';
}
