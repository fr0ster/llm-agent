import type { CircuitState } from '@mcp-abap-adt/llm-agent';
import type { MetricsSnapshot } from '../metrics/in-memory-metrics.js';

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
