import { randomUUID } from 'node:crypto';
import { RagError } from '../interfaces/types.js';
// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------
function tokenize(text) {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((t) => t.length > 1);
}
function embed(text) {
    const tokens = tokenize(text);
    const freq = new Map();
    for (const t of tokens)
        freq.set(t, (freq.get(t) ?? 0) + 1);
    const norm = Math.sqrt([...freq.values()].reduce((s, v) => s + v * v, 0));
    if (norm === 0)
        return freq;
    for (const [k, v] of freq)
        freq.set(k, v / norm);
    return freq;
}
function cosineSimilarity(a, b) {
    let dot = 0;
    for (const [term, wa] of a) {
        const wb = b.get(term);
        if (wb !== undefined)
            dot += wa * wb;
    }
    return dot; // both are unit vectors → dot = cosine
}
// ---------------------------------------------------------------------------
// InMemoryRag
// ---------------------------------------------------------------------------
export class InMemoryRag {
    records = [];
    dedupThreshold;
    namespace;
    queryPreprocessors;
    documentEnrichers;
    constructor(config) {
        this.dedupThreshold = config?.dedupThreshold ?? 0.92;
        this.namespace = config?.namespace;
        this.queryPreprocessors = config?.queryPreprocessors ?? [];
        this.documentEnrichers = config?.documentEnrichers ?? [];
    }
    async upsert(text, metadata, options) {
        if (options?.signal?.aborted) {
            return { ok: false, error: new RagError('Aborted', 'ABORTED') };
        }
        let enrichedText = text;
        for (const enricher of this.documentEnrichers) {
            const eResult = await enricher.enrich(enrichedText, options);
            if (eResult.ok)
                enrichedText = eResult.value;
        }
        const embedding = embed(enrichedText);
        const effectiveNamespace = metadata.namespace ?? this.namespace;
        const resolvedMetadata = {
            ...metadata,
            namespace: effectiveNamespace,
        };
        // Idempotent upsert: if metadata.id matches, replace in-place
        if (metadata.id) {
            const idx = this.records.findIndex((r) => r.metadata.id === metadata.id);
            if (idx !== -1) {
                this.records[idx].text = enrichedText;
                this.records[idx].embedding = embedding;
                this.records[idx].metadata = {
                    ...this.records[idx].metadata,
                    ...resolvedMetadata,
                };
                return { ok: true, value: undefined };
            }
        }
        // Filter existing records by same namespace
        const candidates = this.namespace !== undefined
            ? this.records.filter((r) => r.metadata.namespace === this.namespace)
            : this.records;
        // Find record with cosine similarity >= dedupThreshold
        let dupRecord;
        for (const r of candidates) {
            if (cosineSimilarity(embedding, r.embedding) >= this.dedupThreshold) {
                dupRecord = r;
                break;
            }
        }
        if (dupRecord !== undefined) {
            // Update existing record
            dupRecord.text = enrichedText;
            dupRecord.embedding = embedding;
            dupRecord.metadata = { ...dupRecord.metadata, ...resolvedMetadata };
        }
        else {
            // Push new record
            this.records.push({
                id: randomUUID(),
                text: enrichedText,
                embedding,
                metadata: resolvedMetadata,
            });
        }
        return { ok: true, value: undefined };
    }
    async query(embedding, k, options) {
        if (options?.signal?.aborted) {
            return { ok: false, error: new RagError('Aborted', 'ABORTED') };
        }
        const text = embedding.text;
        let searchText = text;
        for (const pp of this.queryPreprocessors) {
            const ppResult = await pp.process(searchText, options);
            if (ppResult.ok)
                searchText = ppResult.value;
        }
        const queryEmbedding = embed(searchText);
        const nowSecs = Date.now() / 1000;
        // Filter: namespace match + TTL not expired
        const candidates = this.records.filter((r) => {
            if (this.namespace !== undefined &&
                r.metadata.namespace !== this.namespace)
                return false;
            if (r.metadata.ttl !== undefined && r.metadata.ttl < nowSecs)
                return false;
            return true;
        });
        // Compute cosine similarity for each candidate
        const scored = candidates.map((r) => ({
            text: r.text,
            metadata: r.metadata,
            score: cosineSimilarity(queryEmbedding, r.embedding),
        }));
        // Sort desc by score, take top k
        scored.sort((a, b) => b.score - a.score);
        const results = scored.slice(0, k);
        return { ok: true, value: results };
    }
    async getById(id, _options) {
        const record = this.records.find((r) => r.metadata.id === id);
        if (!record)
            return { ok: true, value: null };
        return {
            ok: true,
            value: { text: record.text, metadata: record.metadata, score: 1 },
        };
    }
    async healthCheck() {
        return { ok: true, value: undefined };
    }
    clear() {
        this.records.length = 0;
    }
    writer() {
        return {
            upsertRaw: async (id, text, metadata, options) => {
                const res = await this.upsert(text, { ...metadata, id }, options);
                return res.ok ? { ok: true, value: undefined } : res;
            },
            deleteByIdRaw: async (id) => {
                const idx = this.records.findIndex((r) => r.metadata.id === id);
                if (idx === -1)
                    return { ok: true, value: false };
                this.records.splice(idx, 1);
                return { ok: true, value: true };
            },
            clearAll: async () => {
                this.records.length = 0;
                return { ok: true, value: undefined };
            },
        };
    }
}
//# sourceMappingURL=in-memory-rag.js.map