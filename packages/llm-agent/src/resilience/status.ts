/**
 * Resolving an HTTP status from a thrown value.
 *
 * A leaf module on purpose: it imports nothing, so both the retry decorators
 * and the strategies in `interfaces/` can share one classification without a
 * cycle between the two layers. Which statuses are worth repeating is a
 * decision and lives in a strategy; what status this error carries is a fact
 * and lives here.
 */

const MAX_CAUSE_DEPTH = 5;

/**
 * Resolve an HTTP status from an unknown thrown value: own status/statusCode,
 * then the same walking `cause`, bounded by depth and a visited set so a cyclic
 * chain cannot hang. Returns undefined when no numeric status is present.
 */
export function extractStatusCode(err: unknown): number | undefined {
  const visited = new Set<unknown>();
  let cur: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
    if (typeof cur !== 'object' || cur === null || visited.has(cur)) return;
    visited.add(cur);
    const rec = cur as {
      status?: unknown;
      statusCode?: unknown;
      cause?: unknown;
    };
    if (typeof rec.status === 'number') return rec.status;
    if (typeof rec.statusCode === 'number') return rec.statusCode;
    cur = rec.cause;
  }
  return undefined;
}

/**
 * Whether a thrown value matches one of a set of HTTP status codes.
 *
 * A structured status (own `status`/`statusCode`, or the same on `cause`) is
 * authoritative. Only when none is present does it fall back to the message,
 * and there it matches on **word boundaries** — a bare `includes('429')` also
 * fires on `4290`, an id, or a byte count, turning a hard error into a
 * multi-second backoff stall.
 *
 * Shared by the embedder decorator and the LLM failure strategy so the
 * classification cannot drift between them.
 */
export function isRetryableStatus(
  err: unknown,
  retryOn: readonly number[],
): boolean {
  const status = extractStatusCode(err);
  if (status !== undefined) return retryOn.includes(status);
  const msg = err instanceof Error ? err.message : String(err);
  return retryOn.some((code) => new RegExp(`\\b${code}\\b`).test(msg));
}
