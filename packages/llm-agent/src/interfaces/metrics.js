/**
 * Metrics interfaces — modeled after OTEL-compatible counters and histograms.
 *
 * Consumers implement `IMetrics` to plug in Prometheus, OTEL, or any metrics
 * backend. The library ships `NoopMetrics` (zero overhead) and `InMemoryMetrics`
 * (useful for testing and diagnostics).
 */
export {};
//# sourceMappingURL=metrics.js.map