/**
 * Unwind helper for "stop everything already started, then let the original
 * failure through". Shared by `SmartAgentBuilder.build()` and
 * `SessionGraphFactory.build()` — both start a batch of MCP servers/close
 * handles and must not leak a live child process when something LATER in the
 * same build throws.
 *
 * Internal only: never re-export this from a package's public index. It is a
 * plumbing detail of the two build() methods above, not a consumer-facing
 * seam.
 */
export async function stopAll(
  fns: ReadonlyArray<() => Promise<void>>,
): Promise<void> {
  for (const fn of fns) {
    try {
      await fn();
    } catch {
      // Swallowed: the original failure is what the caller needs to see,
      // and a partial batch must still finish stopping the rest.
    }
  }
}
