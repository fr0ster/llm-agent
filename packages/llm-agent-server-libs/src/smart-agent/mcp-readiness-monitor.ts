import type { IMcpClient } from '@mcp-abap-adt/llm-agent';
import type { McpReadinessRegistry } from './mcp-readiness-registry.js';

export interface McpReadinessMonitorDeps {
  /** Lazily (re)connect a slot's opaque config to a live client. Throws if still
   *  down. */
  connect: (config: unknown) => Promise<IMcpClient>;
  /** Called after a GLOBAL slot transitions DOWN→UP, so the server can refresh the
   *  vectorized tool catalog (toolsRag) over the now-live clients. */
  onGlobalRecovered?: () => Promise<void>;
  /** Called after a WORKER slot transitions DOWN→UP, so the server can invalidate
   *  the worker cache (next session rebuild injects the recovered client). */
  onWorkerRecovered?: (id: string) => void;
  cooldownMs?: number;
  intervalMs?: number;
}

/**
 * Periodic readiness probe over the SmartServer-owned MCP target registry. Drives
 * the `_ready` signal: probes live clients via `healthCheck()` (→ `ping()`, a LIVE
 * round-trip — never the cached `listTools()`), and lazily (re)connects DOWN targets
 * on a cooldown. `tick()` is one pass; the timer just calls it on an interval so
 * tests are deterministic.
 */
export class McpReadinessMonitor {
  private timer?: ReturnType<typeof setInterval>;
  private readonly cooldownMs: number;
  private readonly intervalMs: number;

  constructor(
    private readonly registry: McpReadinessRegistry,
    private readonly deps: McpReadinessMonitorDeps,
  ) {
    this.cooldownMs = deps.cooldownMs ?? 30000;
    this.intervalMs = deps.intervalMs ?? 10000;
  }

  isReady(): boolean {
    return this.registry.allHealthy();
  }

  /** One monitoring pass. The timer calls this; tests call it directly (passing an
   *  explicit `now` for deterministic cooldown). */
  async tick(now = Date.now()): Promise<void> {
    for (const slot of this.registry.list()) {
      const wasDown = !slot.healthy;
      if (slot.client) {
        // healthCheck is OPTIONAL on IMcpClient. A client WITHOUT it is ASSUMED
        // healthy (per the interface contract) — never marked down on a missing
        // probe, else a DI/plugin client without a probe wedges readiness down
        // forever with no config to reconnect.
        if (typeof slot.client.healthCheck !== 'function') {
          this.registry.markHealthy(slot.id, slot.client);
          continue;
        }
        const hc = await slot.client.healthCheck();
        if (hc?.ok) {
          this.registry.markHealthy(slot.id, slot.client);
          if (wasDown) await this._fireRecovered(slot.id, slot.scope);
          continue;
        }
        this.registry.markDown(slot.id);
        // fall through to a reconnect attempt
      }
      if (
        !slot.healthy &&
        slot.config !== undefined &&
        now - slot.lastAttempt >= this.cooldownMs
      ) {
        slot.lastAttempt = now;
        try {
          const client = await this.deps.connect(slot.config);
          this.registry.markHealthy(slot.id, client);
          if (wasDown) await this._fireRecovered(slot.id, slot.scope);
        } catch {
          this.registry.markDown(slot.id);
        }
      }
    }
  }

  private async _fireRecovered(
    id: string,
    scope: 'global' | 'worker',
  ): Promise<void> {
    if (scope === 'global') await this.deps.onGlobalRecovered?.();
    else this.deps.onWorkerRecovered?.(id);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
