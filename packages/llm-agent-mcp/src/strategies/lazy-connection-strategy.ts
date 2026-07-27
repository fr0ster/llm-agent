import type {
  ConnectionStrategyOptions,
  ILogger,
  IMcpClient,
  IMcpConnectionStrategy,
  IReadinessReporter,
  McpClientFactory,
  McpConnectionConfig,
  McpConnectionResult,
} from '@mcp-abap-adt/llm-agent';
import { createDefaultMcpClient } from '../factory.js';

interface Slot {
  config: McpConnectionConfig;
  client?: IMcpClient;
  closeHandle?: () => Promise<void> | void;
  lastAttempt: number;
  healthy: boolean;
  /** Bumped every time a NEW client is assigned to this slot (initial connect or
   *  reconnect). Used to detect an in-place client replacement even when the
   *  slot's healthy/unhealthy state is unchanged across a resolve() call. */
  generation: number;
}

export class LazyConnectionStrategy
  implements IMcpConnectionStrategy, IReadinessReporter
{
  private readonly _slots: Slot[];
  private readonly _skipRevectorize: boolean;
  private readonly _cooldownMs: number;
  private readonly _factory: McpClientFactory;
  private readonly _logger?: ILogger;
  private _resolving: Promise<McpConnectionResult> | null = null;
  /** Signature of the last-returned `(slotIndex → generation)` set, used to
   *  detect gain / loss / in-place reconnect across resolve() calls. Baseline
   *  is `''` (matches the all-slots-down signature) so a config with zero
   *  configured or zero currently-connectable slots does not spuriously report
   *  a change on the very first resolve(). */
  private _prevSig = '';

  constructor(
    configs: McpConnectionConfig[],
    options?: ConnectionStrategyOptions,
    factory?: McpClientFactory,
  ) {
    this._skipRevectorize = options?.skipRevectorize ?? false;
    this._cooldownMs = options?.cooldownMs ?? 30000;
    this._factory = factory ?? createDefaultMcpClient;
    this._logger = options?.logger;
    this._slots = configs.map((config) => ({
      config,
      lastAttempt: 0,
      healthy: false,
      generation: 0,
    }));
  }

  resolve(_currentClients?: IMcpClient[]): Promise<McpConnectionResult> {
    if (this._resolving !== null) {
      return this._resolving;
    }

    this._resolving = this._doResolve().finally(() => {
      this._resolving = null;
    });

    return this._resolving;
  }

  /** Readiness = every configured target currently has a healthy connection.
   *  Reflects the health computed by the last `resolve()` pass. No slots (no MCP
   *  configured) ⇒ ready. */
  isReady(): boolean {
    return this._slots.every((s) => s.healthy);
  }

  private async _doResolve(): Promise<McpConnectionResult> {
    for (const slot of this._slots) {
      if (slot.client !== undefined) {
        const healthy = await this._checkHealth(slot.client);
        if (healthy) {
          slot.healthy = true;
          continue;
        }
        // Client is unhealthy — CLOSE the old transport before clearing it, then
        // attempt reconnect. Skipping the close leaks the previous HTTP/stdio
        // connection on every health-failure reconnect (this strategy is now the
        // default YAML `mcp:` lifecycle path). Best-effort: a failing close must
        // not abort the resolve pass.
        const staleClose = slot.closeHandle;
        slot.client = undefined;
        slot.closeHandle = undefined;
        slot.healthy = false;
        if (staleClose) {
          try {
            await staleClose();
          } catch {
            /* best-effort — the transport is already considered dead */
          }
        }
      }

      // No client or just cleared — try reconnect if cooldown expired
      const now = Date.now();
      if (now - slot.lastAttempt >= this._cooldownMs) {
        slot.lastAttempt = now;
        try {
          const result = await this._factory(slot.config);
          slot.client = result.client;
          slot.generation += 1;
          slot.closeHandle = result.close;
          slot.healthy = true;
        } catch (err) {
          slot.healthy = false;
          // Surface WHY a target is down — otherwise operators chase "agent has no
          // tools" with no log line pointing at the cause (unreachable host, bad
          // auth, container-network mismatch, …). Logged through the injected
          // logger, once per (cooled-down) attempt.
          const target =
            slot.config.type === 'stdio'
              ? slot.config.command
              : slot.config.url;
          this._logger?.log({
            type: 'warning',
            traceId: 'mcp-connection-strategy',
            message: `MCP connection failed for ${target}: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }
    }

    const surviving = this._slots
      .map((s, slotIndex) => ({ s, slotIndex }))
      .filter(({ s }) => s.healthy && s.client !== undefined);
    const clients = surviving.map(({ s }) => s.client as IMcpClient);
    const clientDescriptors = surviving.map(({ s, slotIndex }) => ({
      slotIndex,
      ...(s.config.name ? { label: s.config.name } : {}),
    }));
    const configuredSlotCount = this._slots.length;

    // Change detection over (slotIndex → client generation). A new client for a
    // slot bumps its generation, so a slot gained, lost, OR reconnected in place
    // (client replaced, possibly with different tools) all change the
    // signature — a set-only diff over healthy slot indices would miss the
    // in-place reconnect (same index healthy before and after, different client).
    const sig = surviving
      .map(({ s, slotIndex }) => `${slotIndex}:${s.generation}`)
      .join(',');
    const changed = sig !== this._prevSig;
    this._prevSig = sig;
    const toolsChanged = changed && !this._skipRevectorize;

    return { clients, toolsChanged, clientDescriptors, configuredSlotCount };
  }

  private async _checkHealth(client: IMcpClient): Promise<boolean> {
    try {
      if (typeof client.healthCheck === 'function') {
        const result = await client.healthCheck();
        return result.ok;
      }
      const result = await client.listTools();
      return result.ok;
    } catch {
      return false;
    }
  }

  async dispose(): Promise<void> {
    await Promise.all(
      this._slots
        .filter((s) => s.closeHandle !== undefined)
        .map((s) => Promise.resolve(s.closeHandle?.())),
    );
  }
}
