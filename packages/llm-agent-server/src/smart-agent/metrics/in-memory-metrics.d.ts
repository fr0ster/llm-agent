import type { CounterSnapshot, HistogramSnapshot, ICounter, IHistogram, IMetrics, MetricsSnapshot } from '@mcp-abap-adt/llm-agent';
export type { CounterSnapshot, HistogramSnapshot, MetricsSnapshot };
declare class MemCounter implements ICounter {
    private total;
    private readonly byAttrs;
    add(value?: number, attributes?: Record<string, string>): void;
    snapshot(): CounterSnapshot;
}
declare class MemHistogram implements IHistogram {
    private readonly values;
    record(value: number, _attributes?: Record<string, string>): void;
    snapshot(): HistogramSnapshot;
    /** Return the p-th percentile (0..100). */
    percentile(p: number): number;
}
/**
 * In-memory metrics collector — useful for testing and diagnostics endpoints.
 * Call `snapshot()` to get a point-in-time view of all metrics.
 */
export declare class InMemoryMetrics implements IMetrics {
    readonly requestCount: MemCounter;
    readonly requestLatency: MemHistogram;
    readonly toolCallCount: MemCounter;
    readonly ragQueryCount: MemCounter;
    readonly classifierIntentCount: MemCounter;
    readonly llmCallCount: MemCounter;
    readonly llmCallLatency: MemHistogram;
    readonly circuitBreakerTransition: MemCounter;
    readonly toolCacheHitCount: MemCounter;
    snapshot(): MetricsSnapshot;
    /** Convenience: get p-th percentile of request latency. */
    requestLatencyPercentile(p: number): number;
    /** Convenience: get p-th percentile of LLM call latency. */
    llmCallLatencyPercentile(p: number): number;
}
//# sourceMappingURL=in-memory-metrics.d.ts.map