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
    let g = this.graphs.get(sessionId);
    if (!g) {
      let build = this.pendingBuilds.get(sessionId);
      if (!build) {
        build = this.opts.factory
          .build({ sessionId })
          .then((graph) => {
            this.graphs.set(sessionId, graph);
            this.pendingBuilds.delete(sessionId);
            this.enforceCap();
            return graph;
          })
          .catch((err) => {
            // Clear the in-flight entry so a later request can retry the build.
            this.pendingBuilds.delete(sessionId);
            throw err;
          });
        this.pendingBuilds.set(sessionId, build);
      }
      g = await build;
    }
    g.acquire();
    return g;
  }

  /**
   * Release one in-flight request. Non-creating lookup: an unknown/removed
   * sessionId is a no-op (never resurrect). Disposes a marked graph once idle.
   */
  release(sessionId: string): void {
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
