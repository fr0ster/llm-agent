/**
 * Rerank-error accounting for rag-eval.
 *
 * A rerank arm's RERANK_ERROR is a failed case; any failed case in a rerank
 * arm fails the run (exit 3).
 */

/** What the verdict needs from one arm. */
export interface ArmRerankErrors {
  /** `config / arm` as printed. */
  label: string;
  /** Cases whose rerank failed. */
  errorCases: number;
  cases: number;
  firstError?: string;
}

export interface RerankErrorVerdict {
  /** True when any rerank arm had a failed case. */
  failed: boolean;
  /** Lines to print (empty when no arm failed). */
  lines: string[];
}

/** Any failed rerank case makes the arm's metrics not comparable; the run fails. */
export function rerankErrorVerdict(
  arms: readonly ArmRerankErrors[],
): RerankErrorVerdict {
  const hit = arms.filter((a) => a.errorCases > 0);
  if (hit.length === 0) return { failed: false, lines: [] };
  const lines = hit.map(
    (a) =>
      `ERROR: ${a.label}: the reranker failed in ${a.errorCases}/${a.cases} cases (first: ${a.firstError}) — those cases count as misses`,
  );
  lines.push('FAILED: rerank errors occurred');
  return { failed: true, lines };
}
