import {
  type CallOptions,
  type DecisionError,
  type IReranker,
  type LlmError,
  RagError,
  type RagResult,
  type Result,
} from '@mcp-abap-adt/llm-agent';

/** The one short candidate a minimal health call reranks (spec §17.43 D97). */
const HEALTH_CANDIDATE: RagResult = {
  text: 'health check',
  metadata: { id: 'health' },
  score: 1,
};

/**
 * One minimal `rerank` call over one short candidate — the probe when no
 * cheaper check exists. `ok: false` stays the reranker's error.
 */
export async function minimalRerank(
  reranker: IReranker,
  options?: CallOptions,
): Promise<Result<boolean, RagError>> {
  const r = await reranker.rerank('health check', [HEALTH_CANDIDATE], options);
  return r.ok ? { ok: true, value: true } : r;
}

/**
 * A component's own `healthCheck` (an LLM's, a decision's) as the reranker's:
 * `ok: false` → RERANK_ERROR naming the component's code, a rejection →
 * RERANK_ERROR with its text — a Result, never a throw.
 */
export async function delegateHealth(
  what: string,
  check: () => Promise<Result<boolean, LlmError | DecisionError>>,
): Promise<Result<boolean, RagError>> {
  try {
    const r = await check();
    if (r.ok) return r;
    return {
      ok: false,
      error: new RagError(
        `${what} health check failed: ${r.error.code}: ${r.error.message}`,
        'RERANK_ERROR',
      ),
    };
  } catch (e) {
    return {
      ok: false,
      error: new RagError(
        `${what} health check failed: ${e instanceof Error ? e.message : String(e)}`,
        'RERANK_ERROR',
      ),
    };
  }
}
