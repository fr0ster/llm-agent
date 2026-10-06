/**
 * What a start has taken so far, so a failed start releases it (spec §17.43
 * D96): every resource the start acquires is registered here the moment it is
 * taken, and the ONE release path — `releaseAll`, run by every failure of the
 * start — gives them back, newest first, before the start rejects.
 *
 * Best-effort, like every teardown: one release that fails does not stop the
 * rest, and it never masks the start's own failure — but it is never silent
 * either: each is logged as `start_release_failed`.
 */
export class StartReleases {
  private readonly entries: Array<{
    what: string;
    release: () => Promise<void> | void;
  }> = [];

  /** Register a resource the start has just taken. */
  add(what: string, release: () => Promise<void> | void): void {
    this.entries.push({ what, release });
  }

  /** Release every registered resource, newest first; each failure is logged. */
  async releaseAll(
    log: (event: Record<string, unknown>) => void,
  ): Promise<void> {
    for (const { what, release } of this.entries.splice(0).reverse()) {
      try {
        await release();
      } catch (err) {
        log({
          event: 'start_release_failed',
          what,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}
