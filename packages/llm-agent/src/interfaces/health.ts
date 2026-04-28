import type { CircuitState } from '../resilience/circuit-breaker.js';
import type { MetricsSnapshot } from './metrics.js';

export interface HealthComponentStatus {
  llm: boolean;
  rag: boolean;
  mcp: Array<{ name: string; ok: boolean; error?: string }>;
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
