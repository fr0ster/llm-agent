import { createDefaultMcpClient } from '../mcp-client-factory.js';
export class LazyConnectionStrategy {
    _slots;
    _skipRevectorize;
    _cooldownMs;
    _factory;
    _resolving = null;
    constructor(configs, options, factory) {
        this._skipRevectorize = options?.skipRevectorize ?? false;
        this._cooldownMs = options?.cooldownMs ?? 30000;
        this._factory = factory ?? createDefaultMcpClient;
        this._slots = configs.map((config) => ({
            config,
            lastAttempt: 0,
            healthy: false,
        }));
    }
    resolve(_currentClients) {
        if (this._resolving !== null) {
            return this._resolving;
        }
        this._resolving = this._doResolve().finally(() => {
            this._resolving = null;
        });
        return this._resolving;
    }
    async _doResolve() {
        let anyNewlyHealthy = false;
        for (const slot of this._slots) {
            if (slot.client !== undefined) {
                const healthy = await this._checkHealth(slot.client);
                if (healthy) {
                    slot.healthy = true;
                    continue;
                }
                // Client is unhealthy — clear it and attempt reconnect
                slot.client = undefined;
                slot.closeHandle = undefined;
                slot.healthy = false;
            }
            // No client or just cleared — try reconnect if cooldown expired
            const now = Date.now();
            if (now - slot.lastAttempt >= this._cooldownMs) {
                slot.lastAttempt = now;
                try {
                    const result = await this._factory(slot.config);
                    slot.client = result.client;
                    slot.closeHandle = result.close;
                    slot.healthy = true;
                    anyNewlyHealthy = true;
                }
                catch {
                    slot.healthy = false;
                }
            }
        }
        const clients = this._slots
            .filter((s) => s.healthy && s.client !== undefined)
            .map((s) => s.client);
        const toolsChanged = anyNewlyHealthy && !this._skipRevectorize;
        return { clients, toolsChanged };
    }
    async _checkHealth(client) {
        try {
            if (typeof client.healthCheck === 'function') {
                const result = await client.healthCheck();
                return result.ok;
            }
            const result = await client.listTools();
            return result.ok;
        }
        catch {
            return false;
        }
    }
    async dispose() {
        await Promise.all(this._slots
            .filter((s) => s.closeHandle !== undefined)
            .map((s) => Promise.resolve(s.closeHandle?.())));
    }
}
//# sourceMappingURL=lazy-connection-strategy.js.map