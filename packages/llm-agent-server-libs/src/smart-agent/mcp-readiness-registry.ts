import type { IMcpClient } from '@mcp-abap-adt/llm-agent';

export type ReadinessScope = 'global' | 'worker';

export interface ReadinessSlot {
  id: string;
  scope: ReadinessScope;
  /** Opaque MCP target config (the monitor's `connect` knows how to use it).
   *  Absent for DI-only live clients that have no reconnect config. */
  config?: unknown;
  client?: IMcpClient;
  healthy: boolean;
  lastAttempt: number;
}

/**
 * Registry of configured MCP targets driving SmartServer readiness. A target with
 * no healthy client ⇒ NOT ready. Built from CONFIG (not from successful connects),
 * so a down-at-boot target is a DOWN slot, not a missing one — which is what makes
 * "cold-MCP startup → NOT_READY (no throw), recover later" implementable.
 */
export class McpReadinessRegistry {
  private readonly slots = new Map<string, ReadinessSlot>();

  /** Register a configured target whose client may not be connected yet.
   *  Idempotent on `id` (the worker setup runs on both the primary build and the
   *  per-session rebuild — re-`addTarget` with the same id must keep ONE slot). */
  addTarget(id: string, config: unknown, scope: ReadinessScope): void {
    if (this.slots.has(id)) return;
    this.slots.set(id, { id, scope, config, healthy: false, lastAttempt: 0 });
  }

  /** Register an already-live DI client (no lazy connect needed). */
  addLiveClient(id: string, client: IMcpClient, scope: ReadinessScope): void {
    this.slots.set(id, { id, scope, client, healthy: true, lastAttempt: 0 });
  }

  markHealthy(id: string, client: IMcpClient): void {
    const s = this.slots.get(id);
    if (s) {
      s.client = client;
      s.healthy = true;
    }
  }

  markDown(id: string): void {
    const s = this.slots.get(id);
    if (s) s.healthy = false;
  }

  allHealthy(): boolean {
    for (const s of this.slots.values()) if (!s.healthy) return false;
    return true;
  }

  list(): ReadinessSlot[] {
    return [...this.slots.values()];
  }

  /** Live execution clients for GLOBAL targets — the source of truth `callMcp`
   *  reads so a monitor-recovered client is used without a restart. Worker targets
   *  are excluded: worker clients drive readiness + worker INJECTION (the worker
   *  hoist), not the top-level callMcp. */
  liveClients(): IMcpClient[] {
    const out: IMcpClient[] = [];
    for (const s of this.slots.values()) {
      if (s.scope === 'global' && s.healthy && s.client) out.push(s.client);
    }
    return out;
  }
}
