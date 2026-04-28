export class ToolAvailabilityRegistry {
    defaultTtlMs;
    sessions = new Map();
    constructor(defaultTtlMs = 10 * 60 * 1000) {
        this.defaultTtlMs = defaultTtlMs;
    }
    getBlockedToolNames(sessionId, now = Date.now()) {
        const blocked = this.sessions.get(sessionId);
        if (!blocked || blocked.size === 0)
            return new Set();
        this.prune(sessionId, now);
        return new Set(this.sessions.get(sessionId)?.keys() ?? []);
    }
    isBlocked(sessionId, toolName, now = Date.now()) {
        const blocked = this.sessions.get(sessionId);
        if (!blocked)
            return false;
        const entry = blocked.get(toolName);
        if (!entry)
            return false;
        if (entry.blockedUntil <= now) {
            blocked.delete(toolName);
            if (blocked.size === 0)
                this.sessions.delete(sessionId);
            return false;
        }
        return true;
    }
    block(sessionId, toolName, reason, ttlMs = this.defaultTtlMs, now = Date.now()) {
        const blockedUntil = now + ttlMs;
        let blocked = this.sessions.get(sessionId);
        if (!blocked) {
            blocked = new Map();
            this.sessions.set(sessionId, blocked);
        }
        const entry = { toolName, blockedUntil, reason };
        blocked.set(toolName, entry);
        return entry;
    }
    filterTools(sessionId, tools, now = Date.now()) {
        const allowed = [];
        const blocked = [];
        for (const tool of tools) {
            if (this.isBlocked(sessionId, tool.name, now)) {
                blocked.push(tool.name);
            }
            else {
                allowed.push(tool);
            }
        }
        return { allowed, blocked };
    }
    prune(sessionId, now = Date.now()) {
        const blocked = this.sessions.get(sessionId);
        if (!blocked)
            return;
        for (const [name, entry] of blocked.entries()) {
            if (entry.blockedUntil <= now)
                blocked.delete(name);
        }
        if (blocked.size === 0)
            this.sessions.delete(sessionId);
    }
}
export function isToolContextUnavailableError(message) {
    const normalized = message.toLowerCase();
    return (normalized.includes('not available') ||
        normalized.includes('unavailable') ||
        normalized.includes('not found') ||
        normalized.includes('forbidden') ||
        normalized.includes('permission') ||
        normalized.includes('unauthorized') ||
        normalized.includes('disabled') ||
        normalized.includes('not allowed') ||
        normalized.includes('unknown tool'));
}
//# sourceMappingURL=tool-availability-registry.js.map