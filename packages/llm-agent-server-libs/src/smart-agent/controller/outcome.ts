/** Authoritative per-step verdict, produced ONLY by the reviewer (the executor
 *  never sets status). Persisted in full on the step artifact so a crash between
 *  the artifact write and the bundle persist loses neither `remainder` nor `note`. */
export interface Outcome {
  status: 'ok' | 'exists' | 'failed' | 'partial';
  /** Content to keep: the executor's content for ok/exists, or the validated
   *  accepted extract for partial. */
  approved: string;
  /** What is still missing (drives a partial replan). */
  remainder: string;
  note: string;
}

/** Rank used to collapse multiple artifacts at one (runId, seq) to a single
 *  resolved outcome. ok and exists share the top rank; partial beats failed. */
const RANK: Record<Outcome['status'], number> = {
  ok: 3,
  exists: 3,
  partial: 2,
  failed: 1,
};

/** Resolve many same-`seq` outcomes to one by precedence (ok/exists > partial >
 *  failed); on a rank tie the LAST element wins (latest write). Input order is
 *  assumed chronological (oldest first), matching list()/scan() order.
 *  Returns undefined for an empty list. */
export function resolveByPrecedence(
  outcomes: readonly Outcome[],
): Outcome | undefined {
  let best: Outcome | undefined;
  let bestRank = 0;
  for (const o of outcomes) {
    const r = RANK[o.status];
    if (best === undefined || r >= bestRank) {
      best = o;
      bestRank = r;
    }
  }
  return best;
}
