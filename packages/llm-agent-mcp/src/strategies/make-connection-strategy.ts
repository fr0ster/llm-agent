import type {
  ConnectionStrategyOptions,
  McpClientFactory,
  McpConnectionConfig,
} from '@mcp-abap-adt/llm-agent';
import { PeriodicConnectionStrategy } from './periodic-connection-strategy.js';

export interface MakeConnectionStrategyOptions
  extends ConnectionStrategyOptions {
  /** Background probe / reconnect interval (ms). Default 10000. */
  intervalMs?: number;
}

/**
 * Build the default resilient MCP connection strategy: a
 * {@link PeriodicConnectionStrategy} that connects each configured target, probes
 * health on an interval, lazily reconnects a dropped one, and reports
 * `isReady()` (it implements `IReadinessReporter`). One small factory so consumers
 * (the builder, a server) don't hand-roll the strategy or duplicate readiness.
 */
export function makeConnectionStrategy(
  configs: McpConnectionConfig[],
  options?: MakeConnectionStrategyOptions,
  factory?: McpClientFactory,
): PeriodicConnectionStrategy {
  const intervalMs = options?.intervalMs ?? 10000;
  return new PeriodicConnectionStrategy(configs, intervalMs, options, factory);
}
