import type { SmartAgent } from '../agent.js';
import type { SessionRequestLogger } from '../logger/session-request-logger.js';
import type { PendingToolResultsRegistry } from '../policy/pending-tool-results-registry.js';
import type { ToolAvailabilityRegistry } from '../policy/tool-availability-registry.js';

export interface SessionGraphParts {
  readonly sessionId: string;
  /** sessionId-keyed registries hoisted out of per-request pipeline creation. */
  readonly toolAvailability: ToolAvailabilityRegistry;
  readonly pendingToolResults: PendingToolResultsRegistry;
  /** One token-logger shared by this session's agent + workers. */
  readonly logger: SessionRequestLogger;
  /** The per-session agent (built by SessionGraphFactory). Optional in unit tests. */
  readonly agent?: SmartAgent;
  /** Tears down session RAG + closes per-session resources (factory wires this). */
  readonly dispose: (sessionId: string) => Promise<void>;
}

/**
 * Per-session runtime container. Owns the per-session instances produced by the
 * SessionGraphFactory (agent/pipeline/interpreter/coordinator/workers via the
 * agent), the sessionId-keyed registries, and the session token-logger. Tracks
 * in-flight requests so eviction cannot dispose a graph mid-run; supports a
 * mark-for-disposal "drain" so a pinned graph is torn down once it goes idle.
 */
export class SessionGraph {
  readonly sessionId: string;
  readonly toolAvailability: ToolAvailabilityRegistry;
  readonly pendingToolResults: PendingToolResultsRegistry;
  readonly logger: SessionRequestLogger;
  readonly agent?: SmartAgent;
  private readonly disposeFn: (sessionId: string) => Promise<void>;
  private _active = 0;
  private _lastUsedMs = Date.now();
  private _marked = false;
  private _disposed = false;

  constructor(parts: SessionGraphParts) {
    this.sessionId = parts.sessionId;
    this.toolAvailability = parts.toolAvailability;
    this.pendingToolResults = parts.pendingToolResults;
    this.logger = parts.logger;
    this.agent = parts.agent;
    this.disposeFn = parts.dispose;
  }

  get activeRequests(): number {
    return this._active;
  }
  get isPinned(): boolean {
    return this._active > 0;
  }
  get lastUsedMs(): number {
    return this._lastUsedMs;
  }
  get markedForDisposal(): boolean {
    return this._marked;
  }

  acquire(): void {
    this._active++;
    this._lastUsedMs = Date.now();
  }
  release(): void {
    if (this._active > 0) this._active--;
    this._lastUsedMs = Date.now();
  }

  markForDisposal(): void {
    this._marked = true;
  }

  /**
   * Idempotent. Ordering (review MEDIUM #2):
   *   1) run the dispose hook (session RAG cleanup + any factory teardown);
   *   2) reset the logger in `finally` — runs even if the hook throws, so the
   *      logger is always reset, but the hook's effect (or surfaced failure)
   *      is preserved before the in-memory counters are wiped.
   * Previously the logger was reset BEFORE the hook ran, which made post-hoc
   * inspection of session token counts impossible if the hook failed.
   */
  async dispose(): Promise<void> {
    if (this._disposed) return;
    this._disposed = true;
    try {
      await this.disposeFn(this.sessionId);
    } finally {
      this.logger.reset();
    }
  }
}
