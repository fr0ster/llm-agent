export class NoopSessionManager {
  get totalTokens() {
    return 0;
  }
  addTokens() {}
  isOverBudget() {
    return false;
  }
  reset() {}
}
//# sourceMappingURL=noop-session-manager.js.map
