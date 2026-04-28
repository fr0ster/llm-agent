// ---------------------------------------------------------------------------
// In-memory counter (implementation only — types re-exported from @mcp-abap-adt/llm-agent)
// ---------------------------------------------------------------------------
class MemCounter {
  total = 0;
  byAttrs = new Map();
  add(value = 1, attributes) {
    this.total += value;
    if (attributes) {
      const key = Object.entries(attributes)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join(',');
      this.byAttrs.set(key, (this.byAttrs.get(key) ?? 0) + value);
    }
  }
  snapshot() {
    return { total: this.total, byAttributes: new Map(this.byAttrs) };
  }
}
// ---------------------------------------------------------------------------
// In-memory histogram
// ---------------------------------------------------------------------------
class MemHistogram {
  values = [];
  record(value, _attributes) {
    this.values.push(value);
  }
  snapshot() {
    const sorted = [...this.values].sort((a, b) => a - b);
    return {
      count: sorted.length,
      sum: sorted.reduce((a, b) => a + b, 0),
      min: sorted.length > 0 ? sorted[0] : 0,
      max: sorted.length > 0 ? sorted[sorted.length - 1] : 0,
      values: sorted,
    };
  }
  /** Return the p-th percentile (0..100). */
  percentile(p) {
    if (this.values.length === 0) return 0;
    const sorted = [...this.values].sort((a, b) => a - b);
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, idx)];
  }
}
// ---------------------------------------------------------------------------
// InMemoryMetrics
// ---------------------------------------------------------------------------
/**
 * In-memory metrics collector — useful for testing and diagnostics endpoints.
 * Call `snapshot()` to get a point-in-time view of all metrics.
 */
export class InMemoryMetrics {
  requestCount = new MemCounter();
  requestLatency = new MemHistogram();
  toolCallCount = new MemCounter();
  ragQueryCount = new MemCounter();
  classifierIntentCount = new MemCounter();
  llmCallCount = new MemCounter();
  llmCallLatency = new MemHistogram();
  circuitBreakerTransition = new MemCounter();
  toolCacheHitCount = new MemCounter();
  snapshot() {
    return {
      requestCount: this.requestCount.snapshot(),
      requestLatency: this.requestLatency.snapshot(),
      toolCallCount: this.toolCallCount.snapshot(),
      ragQueryCount: this.ragQueryCount.snapshot(),
      classifierIntentCount: this.classifierIntentCount.snapshot(),
      llmCallCount: this.llmCallCount.snapshot(),
      llmCallLatency: this.llmCallLatency.snapshot(),
      circuitBreakerTransition: this.circuitBreakerTransition.snapshot(),
      toolCacheHitCount: this.toolCacheHitCount.snapshot(),
    };
  }
  /** Convenience: get p-th percentile of request latency. */
  requestLatencyPercentile(p) {
    return this.requestLatency.percentile(p);
  }
  /** Convenience: get p-th percentile of LLM call latency. */
  llmCallLatencyPercentile(p) {
    return this.llmCallLatency.percentile(p);
  }
}
//# sourceMappingURL=in-memory-metrics.js.map
