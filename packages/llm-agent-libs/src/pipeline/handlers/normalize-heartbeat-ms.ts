/**
 * Node clamps a `setTimeout` delay greater than this (2^31 - 1 ms, ~24.8 days)
 * to 1ms and emits a TimeoutOverflowWarning. A value above it must NOT be used
 * as a timer interval — with the keep-alive's auto re-arm it would spin a busy
 * loop, the same failure `0`/`NaN` cause at the low end.
 */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * The single authority for `heartbeatIntervalMs` semantics, shared by the flat
 * tool-loop and the transport SSE keep-alive.
 *
 * @returns a finite positive interval in ms within Node's supported timer range,
 * or `null` when keep-alive is disabled. Never returns `0`, a negative, `NaN`,
 * `±Infinity`, or a value above `MAX_TIMER_MS` — all of which would spin
 * `setTimeout` at (near) zero delay.
 */
export function normalizeHeartbeatMs(raw: number | undefined): number | null {
  if (raw === undefined) return 5000;
  if (Number.isFinite(raw) && raw > 0 && raw <= MAX_TIMER_MS) return raw;
  return null;
}
