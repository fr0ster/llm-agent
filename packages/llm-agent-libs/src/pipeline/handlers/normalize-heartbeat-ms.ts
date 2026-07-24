/**
 * The single authority for `heartbeatIntervalMs` semantics, shared by the flat
 * tool-loop and the transport SSE keep-alive.
 *
 * @returns a finite positive interval in ms, or `null` when keep-alive is
 * disabled. Never returns `0`, a negative, `NaN`, or `±Infinity` — a value that
 * would spin `setTimeout` at (near) zero delay.
 */
export function normalizeHeartbeatMs(raw: number | undefined): number | null {
  if (raw === undefined) return 5000;
  if (Number.isFinite(raw) && raw > 0) return raw;
  return null;
}
