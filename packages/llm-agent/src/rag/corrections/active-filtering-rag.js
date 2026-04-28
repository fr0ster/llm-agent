import { filterActive } from './metadata.js';
function includeInactive(options) {
    return Boolean(options?.ragFilter
        ?.includeInactive);
}
export class ActiveFilteringRag {
    inner;
    constructor(inner) {
        this.inner = inner;
    }
    async query(embedding, k, options) {
        const res = await this.inner.query(embedding, k, options);
        if (!res.ok)
            return res;
        const filtered = filterActive(res.value, (r) => r.metadata, { includeInactive: includeInactive(options) });
        return { ok: true, value: filtered };
    }
    async getById(id, options) {
        const res = await this.inner.getById(id, options);
        if (!res.ok || res.value === null)
            return res;
        const tags = res.value.metadata.tags ?? [];
        const inactive = tags.includes('deprecated') || tags.includes('superseded');
        if (inactive && !includeInactive(options)) {
            return { ok: true, value: null };
        }
        return res;
    }
    healthCheck(options) {
        return this.inner.healthCheck(options);
    }
}
//# sourceMappingURL=active-filtering-rag.js.map