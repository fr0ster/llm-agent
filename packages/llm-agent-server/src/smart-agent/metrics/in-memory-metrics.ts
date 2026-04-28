import type {
  CounterSnapshot,
  HistogramSnapshot,
  ICounter,
  IHistogram,
  IMetrics,
  MetricsSnapshot,
} from '@mcp-abap-adt/llm-agent';

export type { CounterSnapshot, HistogramSnapshot, MetricsSnapshot };

// ---------------------------------------------------------------------------
// In-memory counter (implementation only — types re-exported from @mcp-abap-adt/llm-agent)
// ---------------------------------------------------------------------------

class MemCounter implements ICounter {
  private total = 0;
  private readonly byAttrs = new Map<string, number>();

  add(value = 1, attributes?: Record<string, string>): void {
    this.total += value;
    if (attributes) {
      const key = Object.entries(attributes)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join(',');
      this.byAttrs.set(key, (this.byAttrs.get(key) ?? 0) + value);
    }
  }

  snapshot(): CounterSnapshot {
    return { total: this.total, byAttributes: new Map(this.byAttrs) };
  }
}

// ---------------------------------------------------------------------------
// In-memory histogram
// ---------------------------------------------------------------------------

class MemHistogram implements IHistogram {
  private readonly values: number[] = [];

  record(value: number, _attributes?: Record<string, string>): void {
    this.values.push(value);
  }

  snapshot(): HistogramSnapshot {
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
  percentile(p: number): number {
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
export class InMemoryMetrics implements IMetrics {
  readonly requestCount = new MemCounter();
  readonly requestLatency = new MemHistogram();
  readonly toolCallCount = new MemCounter();
  readonly ragQueryCount = new MemCounter();
  readonly classifierIntentCount = new MemCounter();
  readonly llmCallCount = new MemCounter();
  readonly llmCallLatency = new MemHistogram();
  readonly circuitBreakerTransition = new MemCounter();
  readonly toolCacheHitCount = new MemCounter();

  snapshot(): MetricsSnapshot {
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
  requestLatencyPercentile(p: number): number {
    return this.requestLatency.percentile(p);
  }

  /** Convenience: get p-th percentile of LLM call latency. */
  llmCallLatencyPercentile(p: number): number {
    return this.llmCallLatency.percentile(p);
  }
}
