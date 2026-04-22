/**
 * Metrics interfaces — modeled after OTEL-compatible counters and histograms.
 *
 * Consumers implement `IMetrics` to plug in Prometheus, OTEL, or any metrics
 * backend. The library ships `NoopMetrics` (zero overhead) and `InMemoryMetrics`
 * (useful for testing and diagnostics).
 */

export interface ICounter {
  /** Increment the counter by 1 (or a custom value). */
  add(value?: number, attributes?: Record<string, string>): void;
}

export interface IHistogram {
  /** Record a single observation (e.g. latency in ms). */
  record(value: number, attributes?: Record<string, string>): void;
}

export interface IMetrics {
  /** Total incoming requests to SmartAgent.process / streamProcess. */
  requestCount: ICounter;
  /** Request end-to-end latency (ms). */
  requestLatency: IHistogram;
  /** Number of tool calls executed (internal MCP). */
  toolCallCount: ICounter;
  /** Number of RAG queries executed. Attributes: store (store name), hit (true|false). */
  ragQueryCount: ICounter;
  /** Intent classifier invocation count. Attributes: intent (action|feedback|chat). */
  classifierIntentCount: ICounter;
  /** LLM chat / streamChat invocations. */
  llmCallCount: ICounter;
  /** LLM call latency (ms). */
  llmCallLatency: IHistogram;
  /** Circuit breaker state transitions. Attributes: from, to, target (llm|embedder). */
  circuitBreakerTransition: ICounter;
  /** Tool result cache hits. */
  toolCacheHitCount: ICounter;
}
