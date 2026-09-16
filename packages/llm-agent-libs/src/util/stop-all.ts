/**
 * Unwind helper for "stop everything already started, keep going regardless
 * of what any individual stop does". Shared by `SmartAgentBuilder.build()`
 * (both its build-time unwind AND its routine `handle.close()`) and
 * `SessionGraphFactory.build()` — every one of them starts a batch of MCP
 * servers/close handles and must not leak a live child process when one of
 * them fails to stop, or when something else in the same teardown throws.
 *
 * `onError`, when given, is called with each individual failure — use it to
 * surface stops that fail during ROUTINE teardown (nothing else will report
 * them). Omit it on a build-time unwind, where the ORIGINAL failure that
 * triggered the unwind is what the caller needs to see and there is nothing
 * useful to log a stop failure against yet.
 *
 * Internal only: never re-export this from a package's public index. It is a
 * plumbing detail of the call sites above, not a consumer-facing seam.
 */
export async function stopAll(
  fns: ReadonlyArray<() => Promise<void>>,
  onError?: (err: unknown) => void,
): Promise<void> {
  for (const fn of fns) {
    try {
      await fn();
    } catch (err) {
      // Swallowed here either way: a partial batch must still finish
      // stopping the rest. `onError` is the caller's chance to surface it.
      onError?.(err);
    }
  }
}
