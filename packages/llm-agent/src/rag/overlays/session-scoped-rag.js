import { OverlayRag } from './overlay-rag.js';
export class SessionScopedRag extends OverlayRag {
    sessionId;
    ttlMs;
    constructor(base, overlay, sessionId, ttlMs) {
        super(base, overlay);
        this.sessionId = sessionId;
        this.ttlMs = ttlMs;
    }
    filterOverlay(results) {
        const cutoff = this.ttlMs !== undefined ? Date.now() - this.ttlMs : undefined;
        return results.filter((r) => this.matches(r, cutoff));
    }
    overlayAllows(result) {
        const cutoff = this.ttlMs !== undefined ? Date.now() - this.ttlMs : undefined;
        return this.matches(result, cutoff);
    }
    matches(result, cutoffMs) {
        if (result.metadata.sessionId !== this.sessionId)
            return false;
        if (cutoffMs !== undefined) {
            const createdMs = typeof result.metadata.createdAt === 'number'
                ? result.metadata.createdAt
                : undefined;
            if (createdMs !== undefined && createdMs < cutoffMs)
                return false;
        }
        return true;
    }
}
//# sourceMappingURL=session-scoped-rag.js.map