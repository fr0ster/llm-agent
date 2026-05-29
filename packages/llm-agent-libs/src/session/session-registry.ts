import { OrchestratorError } from '@mcp-abap-adt/llm-agent';
import type { SessionGraph } from './session-graph.js';
import type { SessionGraphIdentity } from './session-graph-factory.js';

/** Minimal seam over SessionGraphFactory so the registry is unit-testable. */
export interface SessionGraphSource {
  build(identity: SessionGraphIdentity): Promise<SessionGraph>;
}

export interface SessionRegistryOptions {
  /** Idle time before an unpinned graph is evicted. */
  idleTtlMs: number;
  /** Max live sessions before LRU eviction of unpinned graphs (drain if pinned). */
  maxSessions: number;
  factory: SessionGraphSource;
}

export class SessionRegistry {
  private readonly graphs = new Map<string, SessionGraph>();
  /**
   * Graphs detached from `graphs` because they were pinned at the moment
   * `invalidateAll()` was called. We cannot dispose mid-run, so we move them
   * here to drain — once their last in-flight `release()` lands, dispose
   * fires. They are NOT served to new `acquire()` calls, which forces those
   * to mint a fresh graph using the just-applied config. Keyed by sessionId
   * so `release()` can find them after `graphs.get(sessionId)` misses.
   */
  private readonly draining = new Map<string, SessionGraph>();
  /** Single-flight guard: in-flight builds keyed by sessionId (review HIGH #2). */
  private readonly pendingBuilds = new Map<string, Promise<SessionGraph>>();
  private readonly pending: Promise<void>[] = [];
  /**
   * Set by `disposeAll` BEFORE any await. While closed the registry refuses new
   * `acquire` calls so a post-shutdown caller cannot orphan a fresh graph past
   * disposal. Defense-in-depth — the server's `close()` drains HTTP first, so
   * in practice no acquire arrives after disposeAll.
   */
  private _closed = false;
  /**
   * Monotonic counter bumped by `invalidateAll()` (Fix #19). Each acquire
   * captures the value BEFORE awaiting the build; if the counter has moved
   * by the time the build resolves, the in-flight build is treated as
   * orphaned — its `.then()` disposes the resolved graph instead of
   * publishing it, and the awaiting acquire rejects. Closes the race where
   * a build started before invalidate would otherwise publish a graph built
   * with the OLD config after the invalidate completed.
   */
  private _generation = 0;

  constructor(private readonly opts: SessionRegistryOptions) {}

  get size(): number {
    return this.graphs.size;
  }

  /**
   * Lazy-build + pin. Async because factory.build is async. SINGLE-FLIGHT: two
   * concurrent acquires for the SAME new sessionId await the SAME build promise
   * and receive the identical graph (never two graphs for one session). Each
   * in-flight request increments the refcount (spec A.4).
   */
  async acquire(sessionId: string): Promise<SessionGraph> {
    if (this._closed) {
      throw new OrchestratorError(
        'SessionRegistry is closed; cannot acquire',
        'SESSION_REGISTRY_CLOSED',
      );
    }
    // Capture generation BEFORE awaiting the build (Fix #19). If
    // invalidateAll() bumps the counter mid-build, the build's `.then()`
    // disposes the resolved graph instead of publishing it, and the
    // post-await check below rejects this acquire.
    const gen = this._generation;
    let g = this.graphs.get(sessionId);
    if (!g) {
      let build = this.pendingBuilds.get(sessionId);
      if (!build) {
        const buildGen = gen;
        // Forward reference so .then/.catch can identify "are we still the
        // entry in pendingBuilds?" (Fix #20). Without this, a stale
        // invalidated build A would unconditionally delete the pendingBuilds
        // slot — evicting a NEWER in-flight build B that took A's place
        // after `invalidateAll()` cleared pendingBuilds.
        let self: Promise<SessionGraph>;
        const clearIfMine = () => {
          if (this.pendingBuilds.get(sessionId) === self) {
            this.pendingBuilds.delete(sessionId);
          }
        };
        build = this.opts.factory
          .build({ sessionId })
          .then((graph) => {
            if (this._generation !== buildGen) {
              // Orphaned by invalidateAll(); dispose async and do NOT
              // publish into `graphs` (which would be a stale-config graph).
              this.pending.push(graph.dispose());
              clearIfMine();
              throw new OrchestratorError(
                'Session graph invalidated mid-build',
                'SESSION_INVALIDATED',
              );
            }
            this.graphs.set(sessionId, graph);
            clearIfMine();
            this.enforceCap();
            return graph;
          })
          .catch((err) => {
            // Clear the in-flight entry so a later request can retry the build
            // — but ONLY if we are still the current entry (Fix #20).
            clearIfMine();
            throw err;
          });
        self = build;
        this.pendingBuilds.set(sessionId, build);
      }
      g = await build;
    }
    // Re-check after the await: disposeAll() may have completed during the
    // build's then-callback, which inserts the graph and then disposes it.
    // Without this re-check the post-await continuation would acquire() on a
    // disposed graph (SessionGraph.acquire() also guards via _disposed —
    // defense in depth).
    if (this._closed) {
      throw new OrchestratorError(
        'SessionRegistry is closed; cannot acquire',
        'SESSION_REGISTRY_CLOSED',
      );
    }
    // Mid-build invalidate check (Fix #19). If we awaited an existing
    // pending build whose `.then()` had not yet observed the bump (different
    // task ordering than the throw path above), still refuse to publish.
    if (this._generation !== gen) {
      throw new OrchestratorError(
        'Session graph invalidated mid-build',
        'SESSION_INVALIDATED',
      );
    }
    g.acquire();
    return g;
  }

  /**
   * Release one in-flight request. Non-creating lookup: an unknown/removed
   * sessionId is a no-op (never resurrect). Disposes a marked graph once idle.
   */
  release(sessionId: string, graph?: SessionGraph): void {
    // When the caller passes the exact graph reference they acquired (recent
    // change required by `invalidateAll`), use it directly — a draining graph
    // and a freshly-built replacement may coexist under the same sessionId,
    // and only the original graph instance must be decremented.
    if (graph) {
      graph.release();
      if (!graph.isPinned) {
        const drain = this.draining.get(sessionId);
        if (drain === graph) {
          this.draining.delete(sessionId);
          this.pending.push(graph.dispose());
          return;
        }
        if (graph.markedForDisposal) {
          const live = this.graphs.get(sessionId);
          if (live === graph) this.graphs.delete(sessionId);
          this.pending.push(graph.dispose());
        }
      }
      return;
    }
    // Legacy by-sessionId path — preserved for callers that haven't been
    // updated. When a draining entry exists it wins (those graphs are
    // detached and otherwise unreachable for release).
    const drain = this.draining.get(sessionId);
    if (drain) {
      drain.release();
      if (!drain.isPinned) {
        this.draining.delete(sessionId);
        this.pending.push(drain.dispose());
      }
      return;
    }
    const g = this.graphs.get(sessionId);
    if (!g) return;
    g.release();
    if (g.markedForDisposal && !g.isPinned) {
      this.graphs.delete(sessionId);
      this.pending.push(g.dispose());
    }
  }

  /** Evict every unpinned graph idle longer than idleTtlMs. */
  async evictIdle(): Promise<void> {
    const now = Date.now();
    for (const [id, g] of this.graphs) {
      if (!g.isPinned && now - g.lastUsedMs >= this.opts.idleTtlMs) {
        this.evictNow(id, g);
      }
    }
    await this.flushEvictions();
  }

  /** Resolve all in-flight dispose() calls (test + shutdown helper). */
  async flushEvictions(): Promise<void> {
    await Promise.all(this.pending.splice(0));
  }

  /**
   * Dispose every graph (server shutdown). Awaits in-flight builds FIRST so
   * graphs whose build resolves after disposeAll's initial sweep are not
   * orphaned. `allSettled` is intentional: a failed build must not reject
   * disposeAll (the failing build cleared its pendingBuilds slot in its own
   * catch handler, so there is nothing to dispose for it).
   */
  async disposeAll(): Promise<void> {
    // Mark closed BEFORE the first await so concurrent acquire() calls observe
    // the closed state and reject — never start a build that escapes disposal.
    this._closed = true;
    if (this.pendingBuilds.size > 0) {
      await Promise.allSettled([...this.pendingBuilds.values()]);
    }
    for (const [id, g] of this.graphs) {
      this.graphs.delete(id);
      this.pending.push(g.dispose());
    }
    // Drain any graphs detached by a prior `invalidateAll()`.
    for (const [id, g] of this.draining) {
      this.draining.delete(id);
      this.pending.push(g.dispose());
    }
    this.pendingBuilds.clear();
    await this.flushEvictions();
  }

  /**
   * Soft reset — dispose every graph but keep the registry OPEN for new
   * acquires. Used by config-reload (PUT /v1/config + hot-reload) to force
   * the next request to mint a fresh per-session graph that picks up the
   * just-applied config. Unpinned graphs are disposed immediately; pinned
   * graphs are marked for disposal (drained when their last in-flight
   * request releases) — same drain semantics as `enforceCap`.
   *
   * Unlike `disposeAll`, this does NOT set `_closed`, so callers can keep
   * serving traffic after a config change.
   */
  async invalidateAll(): Promise<void> {
    // Bump generation FIRST (Fix #19). Any in-flight build's `.then()` will
    // observe the new value and dispose its result instead of publishing it.
    this._generation++;
    for (const [id, g] of [...this.graphs]) {
      if (g.isPinned) {
        // Detach: move to the draining side-map so a fresh `acquire(id)`
        // builds a NEW graph with the just-applied config, while the
        // original pinned graph keeps serving its current in-flight
        // request until its last `release(id, graph)` lands.
        g.markForDisposal();
        this.graphs.delete(id);
        this.draining.set(id, g);
      } else {
        this.evictNow(id, g);
      }
    }
    // Also abandon any in-flight builds — when they resolve they will insert
    // their graph back into `graphs`, but we want next acquires to rebuild
    // using the new config. Clearing pendingBuilds means the next acquire
    // will start a fresh build; the resolved-but-orphan graph is unpinned
    // and will be evicted by enforceCap (it never gets returned to a caller
    // because the acquire that started it already returned the OLD graph).
    // Defense-in-depth: pendingBuilds is rarely non-empty at config-change
    // time in practice.
    this.pendingBuilds.clear();
    await this.flushEvictions();
  }

  private enforceCap(): void {
    while (this.liveCount() > this.opts.maxSessions) {
      let lruId: string | undefined;
      let lruGraph: SessionGraph | undefined;
      let lruTime = Number.POSITIVE_INFINITY;
      for (const [id, g] of this.graphs) {
        if (g.markedForDisposal) continue; // already draining
        if (g.lastUsedMs < lruTime) {
          lruTime = g.lastUsedMs;
          lruId = id;
          lruGraph = g;
        }
      }
      if (!lruId || !lruGraph) break; // nothing left to mark
      if (lruGraph.isPinned) {
        // DRAIN: cannot dispose mid-run; mark and stop (release() finishes it).
        lruGraph.markForDisposal();
        break;
      }
      this.evictNow(lruId, lruGraph);
    }
  }

  /** Sessions that still count toward the cap (not yet draining). */
  private liveCount(): number {
    let n = 0;
    for (const g of this.graphs.values()) if (!g.markedForDisposal) n++;
    return n;
  }

  private evictNow(sessionId: string, g: SessionGraph): void {
    this.graphs.delete(sessionId);
    this.pending.push(g.dispose());
  }
}
