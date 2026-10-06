// packages/llm-agent-reranker/src/batching.ts
// Package-private (not exported from index.ts): the batching both rerankers share
// (spec §5.2 — the same defaults and validation as ProbabilityReranker).
import type { RagResult, Result } from '@mcp-abap-adt/llm-agent';

/** 30.1.0's `DecisionReranker` defaults — request-size and fan-out limits. */
export const DEFAULT_MAX_BATCH_TOKENS = 48_000;
export const DEFAULT_CONCURRENCY = 4;
export const estimateTokens = (s: string): number => Math.ceil(s.length / 4);

/**
 * Item indices split into batches under `budget`: every batch starts at
 * `baseCost`; a batch closes when the next item's cost would take it past the
 * budget; an item over the budget is a batch of its own (never dropped).
 */
export function batchByTokens(
  baseCost: number,
  costs: readonly number[],
  budget: number,
): number[][] {
  const out: number[][] = [];
  let cur: number[] = [];
  let used = baseCost;
  costs.forEach((cost, i) => {
    if (cur.length > 0 && used + cost > budget) {
      out.push(cur);
      cur = [];
      used = baseCost;
    }
    cur.push(i);
    used += cost;
  });
  if (cur.length > 0) out.push(cur);
  return out;
}

/**
 * `call` over the batches in waves of at most `concurrency` calls in flight; a
 * wave settles fully, then its first failure (in batch order) is returned and no
 * later wave starts. Otherwise every batch's value, in batch order.
 */
export async function runInWaves<T, E>(
  batches: readonly number[][],
  concurrency: number,
  call: (idxs: number[]) => Promise<Result<T, E>>,
): Promise<Result<Array<{ idxs: number[]; value: T }>, E>> {
  const out: Array<{ idxs: number[]; value: T }> = [];
  for (let b = 0; b < batches.length; b += concurrency) {
    const slice = batches.slice(b, b + concurrency);
    const settled = await Promise.all(slice.map((idxs) => call(idxs)));
    for (const [j, res] of settled.entries()) {
      if (!res.ok) return res;
      out.push({ idxs: slice[j], value: res.value });
    }
  }
  return { ok: true, value: out };
}

/** Each result with its new score, sorted descending; ties keep input order. */
export function sortByScore(
  results: RagResult[],
  score: readonly number[],
): RagResult[] {
  return results
    .map((r, i) => ({ r: { ...r, score: score[i] }, i }))
    .sort((x, y) => y.r.score - x.r.score || x.i - y.i)
    .map((x) => x.r);
}
