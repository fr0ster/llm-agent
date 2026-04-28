const EMPTY_SUMMARY = {
  byModel: {},
  byComponent: {},
  byCategory: {},
  ragQueries: 0,
  toolCalls: 0,
  totalDurationMs: 0,
};
export class NoopRequestLogger {
  logLlmCall(_entry) {}
  logRagQuery(_entry) {}
  logToolCall(_entry) {}
  startRequest() {}
  endRequest() {}
  getSummary() {
    return { ...EMPTY_SUMMARY, byModel: {}, byComponent: {}, byCategory: {} };
  }
  reset() {}
}
//# sourceMappingURL=noop-request-logger.js.map
