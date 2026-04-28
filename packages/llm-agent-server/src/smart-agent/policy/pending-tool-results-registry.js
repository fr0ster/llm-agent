export class PendingToolResultsRegistry {
    ttlMs;
    sessions = new Map();
    constructor(ttlMs = 5 * 60 * 1000) {
        this.ttlMs = ttlMs;
    }
    set(sessionId, entry) {
        this.sessions.set(sessionId, entry);
        if (this.sessions.size > 100)
            this.pruneAll();
    }
    has(sessionId, now = Date.now()) {
        const entry = this.sessions.get(sessionId);
        if (!entry)
            return false;
        if (now - entry.createdAt > this.ttlMs) {
            this.sessions.delete(sessionId);
            return false;
        }
        return true;
    }
    async consume(sessionId, now = Date.now()) {
        const entry = this.sessions.get(sessionId);
        if (!entry)
            return null;
        if (now - entry.createdAt > this.ttlMs) {
            this.sessions.delete(sessionId);
            return null;
        }
        this.sessions.delete(sessionId);
        try {
            const results = await entry.promise;
            return { assistantMessage: entry.assistantMessage, results };
        }
        catch {
            return { assistantMessage: entry.assistantMessage, results: [] };
        }
    }
    get size() {
        return this.sessions.size;
    }
    pruneAll(now = Date.now()) {
        for (const [id, entry] of this.sessions.entries()) {
            if (now - entry.createdAt > this.ttlMs) {
                this.sessions.delete(id);
            }
        }
    }
}
//# sourceMappingURL=pending-tool-results-registry.js.map