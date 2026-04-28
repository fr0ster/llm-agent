export class OverlayRag {
    base;
    overlay;
    constructor(base, overlay) {
        this.base = base;
        this.overlay = overlay;
    }
    async query(embedding, k, options) {
        const [baseRes, overlayRes] = await Promise.all([
            this.base.query(embedding, k, options),
            this.overlay.query(embedding, k, options),
        ]);
        if (!baseRes.ok)
            return baseRes;
        if (!overlayRes.ok)
            return overlayRes;
        const overlayList = this.filterOverlay(overlayRes.value);
        const overlayKeys = new Set(overlayList
            .map((r) => r.metadata.canonicalKey)
            .filter((key) => typeof key === 'string'));
        const baseKept = baseRes.value.filter((r) => {
            const key = r.metadata.canonicalKey;
            return typeof key !== 'string' || !overlayKeys.has(key);
        });
        const merged = [...overlayList, ...baseKept]
            .sort((a, b) => b.score - a.score)
            .slice(0, k);
        return { ok: true, value: merged };
    }
    async getById(id, options) {
        const o = await this.overlay.getById(id, options);
        if (!o.ok)
            return o;
        if (o.value !== null && this.overlayAllows(o.value))
            return o;
        return this.base.getById(id, options);
    }
    async healthCheck(options) {
        const [a, b] = await Promise.all([
            this.base.healthCheck(options),
            this.overlay.healthCheck(options),
        ]);
        if (!a.ok)
            return a;
        return b;
    }
    /** Hook for subclasses to drop overlay rows (e.g. by sessionId). */
    filterOverlay(results) {
        return results;
    }
    overlayAllows(_result) {
        return true;
    }
}
//# sourceMappingURL=overlay-rag.js.map