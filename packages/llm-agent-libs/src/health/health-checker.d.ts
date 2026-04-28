import type { CircuitBreaker } from '@mcp-abap-adt/llm-agent';
import type { SmartAgent } from '../agent.js';
import type { InMemoryMetrics } from '../metrics/in-memory-metrics.js';
import type { HealthStatus } from './types.js';
export interface HealthCheckerDeps {
  agent: SmartAgent;
  startTime: number;
  version: string;
  circuitBreakers?: CircuitBreaker[];
  metrics?: InMemoryMetrics;
}
export declare class HealthChecker {
  private readonly agent;
  private readonly startTime;
  private readonly version;
  private readonly circuitBreakers;
  private readonly metrics?;
  constructor(deps: HealthCheckerDeps);
  check(): Promise<HealthStatus>;
}
//# sourceMappingURL=health-checker.d.ts.map
