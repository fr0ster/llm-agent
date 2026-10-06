import type { IBearerCredential } from '@mcp-abap-adt/interfaces-auth';
import {
  type CallOptions,
  DecisionError,
  type DecisionErrorCode,
  type IRelevanceDecision,
  type RelevanceRequest,
  type RelevanceResult,
  type Result,
} from '@mcp-abap-adt/llm-agent';
import { codeForStatus, mapRerankResults } from './map-rerank.js';

export const SAP_AICORE_DEFAULT_RESOURCE_GROUP = 'default';

/** The one fetch shape this provider uses; a test seam (unset → global fetch). */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface SapAiCoreRelevanceConfig {
  /** The AI Core deployment that serves the rerank model (D10: an id, not a model name). */
  deploymentId: string;
  /** Sent as `model` in the body (e.g. the Cohere rerank model name). */
  model: string;
  /** Header `AI-Resource-Group`. Unset → 'default', as the AI Core embedder and LLM. */
  resourceGroup?: string;
  /** AI Core REST API base URL (the name `parseServiceKey` returns). */
  apiBaseUrl: string;
  /** Asked for a fresh token on every call; never cached here. */
  credential: IBearerCredential;
  fetch?: FetchLike;
}

/** The AI Core deployment status that means the model can answer (spec §17.43 D97). */
const RUNNING = 'RUNNING';

const fail = (
  message: string,
  code: DecisionErrorCode = 'DECISION_ERROR',
): Result<never, DecisionError> => ({
  ok: false,
  error: new DecisionError(message, code),
});

const required = (v: string | undefined, field: string): string => {
  if (typeof v !== 'string' || v.trim().length === 0) {
    throw new Error(`SapAiCoreRelevanceDecision: ${field} is required`);
  }
  return v;
};

const nameOf = (err: unknown): string =>
  err instanceof Error ? err.name : 'Error';

/**
 * Cohere Rerank on SAP AI Core as an IRelevanceDecision (spec §5.3): one
 * relevance score per passage — NOT a probability; comparable for the same
 * query and model, also across calls (spec §3.9, D28). ONE /rerank call per
 * score(). No env, no timeout, no retries.
 */
export class SapAiCoreRelevanceDecision implements IRelevanceDecision {
  readonly model: string;
  private readonly url: string;
  private readonly deploymentUrl: string;
  private readonly resourceGroup: string;
  private readonly fetchImpl: FetchLike;

  constructor(private readonly cfg: SapAiCoreRelevanceConfig) {
    if (!cfg?.credential) {
      throw new Error('SapAiCoreRelevanceDecision requires a credential');
    }
    const base = required(cfg.apiBaseUrl, 'apiBaseUrl').replace(/\/+$/, '');
    const deployment = encodeURIComponent(
      required(cfg.deploymentId, 'deploymentId'),
    );
    this.model = required(cfg.model, 'model');
    this.url = `${base}/v2/inference/deployments/${deployment}/rerank`;
    this.deploymentUrl = `${base}/v2/lm/deployments/${deployment}`;
    this.resourceGroup = cfg.resourceGroup ?? SAP_AICORE_DEFAULT_RESOURCE_GROUP;
    this.fetchImpl = cfg.fetch ?? ((url, init) => fetch(url, init));
  }

  async score(
    request: RelevanceRequest,
    options?: CallOptions,
  ): Promise<Result<RelevanceResult, DecisionError>> {
    if (
      typeof request.query !== 'string' ||
      request.query.trim().length === 0
    ) {
      return fail(
        'relevance request has an empty query',
        'DECISION_INVALID_REQUEST',
      );
    }
    if (request.passages.length === 0) {
      return fail(
        'relevance request has no passages',
        'DECISION_INVALID_REQUEST',
      );
    }
    if (request.passages.some((p) => typeof p !== 'string' || p.length === 0)) {
      return fail(
        'relevance request has an empty passage',
        'DECISION_INVALID_REQUEST',
      );
    }
    const body = await this.call(
      'rerank',
      this.url,
      {
        method: 'POST',
        body: JSON.stringify({
          model: this.model,
          query: request.query,
          documents: request.passages,
          top_n: request.passages.length,
        }),
      },
      options,
    );
    if (!body.ok) return body;
    const scores = mapRerankResults(body.value, request.passages.length);
    if (!scores.ok) return scores;
    return { ok: true, value: { scores: scores.value, model: this.model } };
  }

  /**
   * The cheapest real check (spec §17.43 D97): the deployment's status,
   * `GET {apiBaseUrl}/v2/lm/deployments/{deploymentId}` — no inference.
   * `RUNNING` → true, any other status → false; a failure → ok:false with the
   * code mapped as for `score`. Never rejects.
   */
  async healthCheck(
    options?: CallOptions,
  ): Promise<Result<boolean, DecisionError>> {
    try {
      const body = await this.call(
        'deployment status',
        this.deploymentUrl,
        { method: 'GET' },
        options,
      );
      if (!body.ok) return body;
      const status = (body.value as { status?: unknown } | null)?.status;
      if (typeof status !== 'string') {
        return fail('sap-aicore deployment status: response has no status');
      }
      return { ok: true, value: status === RUNNING };
    } catch (err) {
      return fail(`sap-aicore deployment status failed (${nameOf(err)})`);
    }
  }

  /**
   * One authenticated AI Core request → its JSON body. A token failure is
   * DECISION_AUTH, a network failure DECISION_UNAVAILABLE, an HTTP failure its
   * status code's mapping, an abort DECISION_ABORTED, a non-JSON body
   * DECISION_ERROR. Messages carry the HTTP status, never the token or body.
   */
  private async call(
    what: string,
    url: string,
    init: { method: 'GET' | 'POST'; body?: string },
    options?: CallOptions,
  ): Promise<Result<unknown, DecisionError>> {
    const aborted = () =>
      fail(`sap-aicore ${what} aborted`, 'DECISION_ABORTED');
    if (options?.signal?.aborted) return aborted();
    let token: string;
    try {
      token = await this.cfg.credential.token();
    } catch (err) {
      return fail(
        `sap-aicore credential gave no token (${nameOf(err)})`,
        'DECISION_AUTH',
      );
    }
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: init.method,
        headers: {
          Authorization: `Bearer ${token}`,
          'AI-Resource-Group': this.resourceGroup,
          ...(init.body !== undefined
            ? { 'Content-Type': 'application/json' }
            : {}),
        },
        ...(init.body !== undefined ? { body: init.body } : {}),
        ...(options?.signal ? { signal: options.signal } : {}),
      });
    } catch (err) {
      if (options?.signal?.aborted) return aborted();
      return fail(
        `sap-aicore ${what} request failed (${nameOf(err)})`,
        'DECISION_UNAVAILABLE',
      );
    }
    if (!res.ok) {
      return fail(
        `sap-aicore ${what} HTTP ${res.status}`,
        codeForStatus(res.status),
      );
    }
    try {
      return { ok: true, value: await res.json() };
    } catch {
      if (options?.signal?.aborted) return aborted();
      return fail(`sap-aicore ${what}: response is not JSON`);
    }
  }
}
