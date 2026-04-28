import { LazyConnectionStrategy } from './lazy-connection-strategy.js';
export class PeriodicConnectionStrategy {
    _lazy;
    _cachedResult;
    _changed;
    _interval;
    constructor(configs, intervalMs, options, factory) {
        // cooldownMs = 0 because the interval itself is the rate limiter
        this._lazy = new LazyConnectionStrategy(configs, { ...options, cooldownMs: 0 }, factory);
        this._cachedResult = { clients: [], toolsChanged: false };
        this._changed = false;
        this._interval = setInterval(() => {
            void this._probe();
        }, intervalMs);
        // Run first probe immediately
        void this._probe();
    }
    async _probe() {
        const result = await this._lazy.resolve(this._cachedResult.clients);
        if (result.clients !== this._cachedResult.clients) {
            this._cachedResult = result;
            this._changed = true;
        }
    }
    async resolve(_currentClients) {
        if (this._changed) {
            this._changed = false;
            return {
                clients: this._cachedResult.clients,
                toolsChanged: this._cachedResult.toolsChanged,
            };
        }
        return { clients: this._cachedResult.clients, toolsChanged: false };
    }
    async dispose() {
        clearInterval(this._interval);
        await this._lazy.dispose();
    }
}
//# sourceMappingURL=periodic-connection-strategy.js.map