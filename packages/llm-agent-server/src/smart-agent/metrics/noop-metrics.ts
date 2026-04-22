import type { ICounter, IHistogram, IMetrics } from './types.js';

const noopCounter: ICounter = {
  add() {},
};

const noopHistogram: IHistogram = {
  record() {},
};

/**
 * No-op metrics implementation — zero overhead.
 * Used as the default when no metrics provider is configured.
 */
export class NoopMetrics implements IMetrics {
  readonly requestCount: ICounter = noopCounter;
  readonly requestLatency: IHistogram = noopHistogram;
  readonly toolCallCount: ICounter = noopCounter;
  readonly ragQueryCount: ICounter = noopCounter;
  readonly classifierIntentCount: ICounter = noopCounter;
  readonly llmCallCount: ICounter = noopCounter;
  readonly llmCallLatency: IHistogram = noopHistogram;
  readonly circuitBreakerTransition: ICounter = noopCounter;
  readonly toolCacheHitCount: ICounter = noopCounter;
}
