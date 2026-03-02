import type { SmartAgent } from '../agent.js';
import type { InMemoryMetrics } from '../metrics/in-memory-metrics.js';
import type { CircuitBreaker } from '../resilience/circuit-breaker.js';
import type { HealthStatus } from './types.js';

export interface HealthCheckerDeps {
  agent: SmartAgent;
  startTime: number;
  version: string;
  circuitBreakers?: CircuitBreaker[];
  metrics?: InMemoryMetrics;
}

export class HealthChecker {
  private readonly agent: SmartAgent;
  private readonly startTime: number;
  private readonly version: string;
  private readonly circuitBreakers: CircuitBreaker[];
  private readonly metrics?: InMemoryMetrics;

  constructor(deps: HealthCheckerDeps) {
    this.agent = deps.agent;
    this.startTime = deps.startTime;
    this.version = deps.version;
    this.circuitBreakers = deps.circuitBreakers ?? [];
    this.metrics = deps.metrics;
  }

  async check(): Promise<HealthStatus> {
    const healthResult = await this.agent.healthCheck();

    const components = healthResult.ok
      ? healthResult.value
      : { llm: false, rag: false, mcp: [] };

    const cbStatuses =
      this.circuitBreakers.length > 0
        ? this.circuitBreakers.map((cb, i) => ({
            index: i,
            state: cb.state,
          }))
        : undefined;

    const metricsSnapshot = this.metrics?.snapshot();

    // Determine overall status
    const llmOk = components.llm;
    const ragOk = components.rag;
    const mcpAllOk =
      components.mcp.length === 0 || components.mcp.every((m) => m.ok);
    const anyCircuitOpen = this.circuitBreakers.some(
      (cb) => cb.state === 'open',
    );

    let status: 'healthy' | 'degraded' | 'unhealthy';
    if (!llmOk) {
      status = 'unhealthy';
    } else if (!ragOk || !mcpAllOk || anyCircuitOpen) {
      status = 'degraded';
    } else {
      status = 'healthy';
    }

    return {
      status,
      uptime: Date.now() - this.startTime,
      version: this.version,
      timestamp: new Date().toISOString(),
      components,
      ...(cbStatuses ? { circuitBreakers: cbStatuses } : {}),
      ...(metricsSnapshot ? { metrics: metricsSnapshot } : {}),
    };
  }
}
