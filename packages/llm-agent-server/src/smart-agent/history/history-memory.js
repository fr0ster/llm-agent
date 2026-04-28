export class HistoryMemory {
    maxSize;
    sessions = new Map();
    constructor(opts) {
        this.maxSize = opts?.maxSize ?? 50;
    }
    pushRecent(sessionId, summary) {
        let entries = this.sessions.get(sessionId);
        if (!entries) {
            entries = [];
            this.sessions.set(sessionId, entries);
        }
        entries.push(summary);
        if (entries.length > this.maxSize) {
            entries.splice(0, entries.length - this.maxSize);
        }
    }
    getRecent(sessionId, limit) {
        const entries = this.sessions.get(sessionId) ?? [];
        return entries.slice(-limit);
    }
    clear(sessionId) {
        this.sessions.delete(sessionId);
    }
}
//# sourceMappingURL=history-memory.js.map