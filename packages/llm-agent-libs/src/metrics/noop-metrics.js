const noopCounter = {
  add() {},
};
const noopHistogram = {
  record() {},
};
/**
 * No-op metrics implementation — zero overhead.
 * Used as the default when no metrics provider is configured.
 */
export class NoopMetrics {
  requestCount = noopCounter;
  requestLatency = noopHistogram;
  toolCallCount = noopCounter;
  ragQueryCount = noopCounter;
  classifierIntentCount = noopCounter;
  llmCallCount = noopCounter;
  llmCallLatency = noopHistogram;
  circuitBreakerTransition = noopCounter;
  toolCacheHitCount = noopCounter;
}
//# sourceMappingURL=noop-metrics.js.map
