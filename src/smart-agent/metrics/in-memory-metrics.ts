import type { ICounter, IHistogram, IMetrics } from './types.js';

// ---------------------------------------------------------------------------
// In-memory counter
// ---------------------------------------------------------------------------

export interface CounterSnapshot {
  total: number;
  byAttributes: Map<string, number>;
}

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

export interface HistogramSnapshot {
  count: number;
  sum: number;
  min: number;
  max: number;
  values: number[];
}

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

export interface MetricsSnapshot {
  requestCount: CounterSnapshot;
  requestLatency: HistogramSnapshot;
  toolCallCount: CounterSnapshot;
  ragQueryCount: CounterSnapshot;
  classifierIntentCount: CounterSnapshot;
  llmCallCount: CounterSnapshot;
  llmCallLatency: HistogramSnapshot;
  circuitBreakerTransition: CounterSnapshot;
}

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
