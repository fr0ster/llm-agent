import type { ICounter, IHistogram, IMetrics } from './types.js';
/**
 * No-op metrics implementation — zero overhead.
 * Used as the default when no metrics provider is configured.
 */
export declare class NoopMetrics implements IMetrics {
    readonly requestCount: ICounter;
    readonly requestLatency: IHistogram;
    readonly toolCallCount: ICounter;
    readonly ragQueryCount: ICounter;
    readonly classifierIntentCount: ICounter;
    readonly llmCallCount: ICounter;
    readonly llmCallLatency: IHistogram;
    readonly circuitBreakerTransition: ICounter;
    readonly toolCacheHitCount: ICounter;
}
//# sourceMappingURL=noop-metrics.d.ts.map