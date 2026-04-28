export class SessionManager {
    _totalTokens = 0;
    tokenBudget;
    constructor(opts) {
        this.tokenBudget = opts.tokenBudget;
    }
    get totalTokens() {
        return this._totalTokens;
    }
    addTokens(count) {
        this._totalTokens += count;
    }
    isOverBudget() {
        return this._totalTokens >= this.tokenBudget;
    }
    reset() {
        this._totalTokens = 0;
    }
}
//# sourceMappingURL=session-manager.js.map