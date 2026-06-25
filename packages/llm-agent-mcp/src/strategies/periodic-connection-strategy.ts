import type {
  ConnectionStrategyOptions,
  IMcpClient,
  IMcpConnectionStrategy,
  IReadinessReporter,
  McpClientFactory,
  McpConnectionConfig,
  McpConnectionResult,
} from '@mcp-abap-adt/llm-agent';
import { LazyConnectionStrategy } from './lazy-connection-strategy.js';

export class PeriodicConnectionStrategy
  implements IMcpConnectionStrategy, IReadinessReporter
{
  private readonly _lazy: LazyConnectionStrategy;
  private _cachedResult: McpConnectionResult;
  private _changed: boolean;
  private readonly _interval: ReturnType<typeof setInterval>;

  constructor(
    configs: McpConnectionConfig[],
    intervalMs: number,
    options?: ConnectionStrategyOptions,
    factory?: McpClientFactory,
  ) {
    // cooldownMs = 0 because the interval itself is the rate limiter
    this._lazy = new LazyConnectionStrategy(
      configs,
      { ...options, cooldownMs: 0 },
      factory,
    );
    this._cachedResult = { clients: [], toolsChanged: false };
    this._changed = false;

    this._interval = setInterval(() => {
      void this._probe();
    }, intervalMs);

    // Run first probe immediately
    void this._probe();
  }

  private async _probe(): Promise<void> {
    const result = await this._lazy.resolve(this._cachedResult.clients);
    if (result.clients !== this._cachedResult.clients) {
      this._cachedResult = result;
      this._changed = true;
    }
  }

  /** Readiness delegates to the wrapped lazy strategy (its slot health is updated
   *  by the periodic probe). */
  isReady(): boolean {
    return this._lazy.isReady();
  }

  async resolve(_currentClients?: IMcpClient[]): Promise<McpConnectionResult> {
    if (this._changed) {
      this._changed = false;
      return {
        clients: this._cachedResult.clients,
        toolsChanged: this._cachedResult.toolsChanged,
      };
    }
    return { clients: this._cachedResult.clients, toolsChanged: false };
  }

  async dispose(): Promise<void> {
    clearInterval(this._interval);
    await this._lazy.dispose();
  }
}
