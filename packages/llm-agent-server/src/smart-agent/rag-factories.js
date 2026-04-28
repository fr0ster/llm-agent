import { MissingProviderError } from '@mcp-abap-adt/llm-agent';
const PACKAGE_BY_NAME = {
    qdrant: '@mcp-abap-adt/qdrant-rag',
    'hana-vector': '@mcp-abap-adt/hana-vector-rag',
    'pg-vector': '@mcp-abap-adt/pg-vector-rag',
};
const EXPORT_BY_NAME = {
    qdrant: 'QdrantRag',
    'hana-vector': 'HanaVectorRag',
    'pg-vector': 'PgVectorRag',
};
const prefetched = new Map();
/**
 * Load peer packages for the RAG backend names given. Call once at server
 * startup before any synchronous resolveRag calls. Missing peer throws
 * MissingProviderError up front so startup fails fast.
 */
export async function prefetchRagFactories(names) {
    for (const name of names) {
        if (prefetched.has(name))
            continue;
        const pkg = PACKAGE_BY_NAME[name];
        if (!pkg)
            throw new MissingProviderError('(unknown)', name);
        try {
            const mod = (await import(pkg));
            prefetched.set(name, mod);
        }
        catch {
            throw new MissingProviderError(pkg, name);
        }
    }
}
/** Sync resolve. Caller MUST have awaited prefetchRagFactories(names) first. */
export function resolveRag(name, opts) {
    const mod = prefetched.get(name);
    if (!mod) {
        const pkg = PACKAGE_BY_NAME[name] ?? '(unknown)';
        throw new MissingProviderError(pkg, name);
    }
    const exportName = EXPORT_BY_NAME[name];
    const Cls = mod[exportName];
    if (!Cls) {
        throw new MissingProviderError(PACKAGE_BY_NAME[name] ?? '(unknown)', name);
    }
    return new Cls(opts);
}
/** Test-only: reset the prefetched map. */
export function _resetPrefetchedRagForTests() {
    prefetched.clear();
}
export const ragBackendNames = Object.freeze(Object.keys(PACKAGE_BY_NAME));
//# sourceMappingURL=rag-factories.js.map