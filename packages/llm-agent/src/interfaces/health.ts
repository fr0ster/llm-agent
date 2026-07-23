import type { CircuitState } from '../resilience/circuit-breaker.js';
import type { MetricsSnapshot } from './metrics.js';

export interface HealthComponentStatus {
  llm: boolean;
  rag: boolean;
  mcp: Array<{ name: string; ok: boolean; error?: string }>;
  /**
   * Startup MCP tool-catalog vectorization. Counters only — the full `failed`
   * name list stays behind IToolCatalogReporter, since /health sits on a hot
   * polling path. Absent when nothing was vectorized.
   */
  toolCatalog?: {
    vectorized: number;
    total: number;
    complete: boolean;
    clientFailures: number;
  };
}

export interface CircuitBreakerStatus {
  index: number;
  state: CircuitState;
}

export interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  uptime: number;
  version: string;
  timestamp: string;
  components: HealthComponentStatus;
  circuitBreakers?: CircuitBreakerStatus[];
  metrics?: MetricsSnapshot;
}
