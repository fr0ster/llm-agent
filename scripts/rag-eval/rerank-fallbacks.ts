/**
 * Rerank-fallback accounting for rag-eval.
 *
 * A rerank strategy falls back to the embedding order on a reranker failure
 * and still answers `ok`, so the eval would count a fallback as a rerank
 * result. The strategies report each fallback as a `retrieval_rerank_error`
 * step on `CallOptions.sessionLogger`; this module counts those steps per case
 * and turns them into a verdict for the run.
 */

/** The step a rerank strategy logs when it falls back to the embedding order. */
export const RERANK_FALLBACK_STEP = 'retrieval_rerank_error';

/** A `CallOptions.sessionLogger` that counts rerank fallbacks. */
export class RerankFallbackCounter {
  private count = 0;
  /** First fallback reason seen (`code: message`), for the report. */
  firstReason: string | undefined;

  readonly sessionLogger = {
    logStep: (name: string, data: unknown): void => {
      if (name !== RERANK_FALLBACK_STEP) return;
      this.count++;
      if (this.firstReason === undefined) {
        const d = (data ?? {}) as { code?: unknown; message?: unknown };
        this.firstReason = `${String(d.code)}: ${String(d.message)}`;
      }
    },
  };

  /** Fallbacks counted since the previous `take()`; resets the count. */
  take(): number {
    const n = this.count;
    this.count = 0;
    return n;
  }
}

/** What the verdict needs from one arm. */
export interface ArmFallbacks {
  /** `config / arm` as printed. */
  label: string;
  /** A rerank arm (the embedding baseline never reranks). */
  reranks: boolean;
  /** Cases with at least one fallback. */
  fallbackCases: number;
  cases: number;
  firstReason?: string;
}

export interface FallbackVerdict {
  /** True when any rerank arm fell back and fallbacks are not allowed. */
  failed: boolean;
  /** Lines to print (empty when no arm fell back). */
  lines: string[];
}

/**
 * Any fallback in a rerank arm makes its metrics partly embedding metrics; the
 * run fails unless `allowFallback` (`--allow-fallback`).
 */
export function fallbackVerdict(
  arms: readonly ArmFallbacks[],
  allowFallback: boolean,
): FallbackVerdict {
  const hit = arms.filter((a) => a.reranks && a.fallbackCases > 0);
  if (hit.length === 0) return { failed: false, lines: [] };
  const lines = hit.map(
    (a) =>
      `WARNING: ${a.label}: reranker fell back to the embedding order in ${a.fallbackCases}/${a.cases} cases` +
      (a.firstReason ? ` (first: ${a.firstReason})` : '') +
      ' — its metrics are not rerank metrics',
  );
  lines.push(
    allowFallback
      ? '--allow-fallback: exit code not affected'
      : 'FAILED: rerank fallbacks occurred (pass --allow-fallback to accept them)',
  );
  return { failed: !allowFallback, lines };
}
