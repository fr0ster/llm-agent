import {
  type CallOptions,
  type IReranker,
  RagError,
  type RagResult,
} from '@mcp-abap-adt/llm-agent';

/** Cap on a thrown error's text in a step or an error: enough for a reason, never a dump. */
export const MAX_THROWN_MESSAGE = 500;

export interface RerankFailure {
  readonly code: string;
  readonly message: string;
}

/**
 * Calls the reranker once. `ok: false` from it → its code / message; a throw →
 * RERANK_THROWN (message capped); a `check` that names a defect in the output →
 * RERANK_ERROR with that text.
 */
export async function callReranker(
  reranker: IReranker,
  query: string,
  candidates: RagResult[],
  options: CallOptions | undefined,
  check?: (out: RagResult[]) => string | undefined,
): Promise<
  { ok: true; value: RagResult[] } | { ok: false; failure: RerankFailure }
> {
  try {
    const r = await reranker.rerank(query, candidates, options);
    if (!r.ok) {
      return {
        ok: false,
        failure: { code: r.error.code, message: r.error.message },
      };
    }
    const bad = check?.(r.value);
    if (bad !== undefined) {
      return { ok: false, failure: { code: 'RERANK_ERROR', message: bad } };
    }
    return { ok: true, value: r.value };
  } catch (err) {
    return {
      ok: false,
      failure: {
        code: 'RERANK_THROWN',
        message: String(err).slice(0, MAX_THROWN_MESSAGE),
      },
    };
  }
}

/** The one error a failed rerank is (spec §9.3, D71). */
export function rerankFailedError(f: RerankFailure): RagError {
  return new RagError(`rerank failed: ${f.code}: ${f.message}`, 'RERANK_ERROR');
}
