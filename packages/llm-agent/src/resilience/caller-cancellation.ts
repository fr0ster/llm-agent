/**
 * Whether a signal was aborted by the caller (a client disconnect, a user
 * cancel) rather than by a timeout. A caller's cancellation says nothing about
 * the health of the callee, so circuit breakers neither count it as a failure
 * nor as a success. A timeout is aborted with a `TimeoutError` reason and IS a
 * failure.
 */
export function isCallerCancellation(signal: AbortSignal | undefined): boolean {
  if (!signal?.aborted) return false;
  return (
    (signal.reason as { name?: unknown } | undefined)?.name !== 'TimeoutError'
  );
}
