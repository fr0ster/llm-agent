import { MissingProviderError } from '@mcp-abap-adt/llm-agent';
const PACKAGE_BY_NAME = {
    openai: '@mcp-abap-adt/openai-embedder',
    ollama: '@mcp-abap-adt/ollama-embedder',
    'sap-ai-core': '@mcp-abap-adt/sap-aicore-embedder',
    'sap-aicore': '@mcp-abap-adt/sap-aicore-embedder',
};
const EXPORT_BY_NAME = {
    openai: 'OpenAiEmbedder',
    ollama: 'OllamaEmbedder',
    'sap-ai-core': 'SapAiCoreEmbedder',
    'sap-aicore': 'SapAiCoreEmbedder',
};
const prefetched = new Map();
/**
 * Load peer packages for the factory names given. Call once at server
 * startup before any synchronous resolve calls. Missing peer throws
 * MissingProviderError up front so startup fails fast.
 */
export async function prefetchEmbedderFactories(names) {
    for (const name of names) {
        if (prefetched.has(name))
            continue;
        const packageName = PACKAGE_BY_NAME[name];
        if (!packageName) {
            throw new MissingProviderError('(unknown)', name);
        }
        try {
            const mod = (await import(packageName));
            prefetched.set(name, mod);
        }
        catch {
            throw new MissingProviderError(packageName, name);
        }
    }
}
/** Sync resolve. Caller MUST have awaited prefetchEmbedderFactories(names) first. */
export function resolveEmbedder(name, opts) {
    const mod = prefetched.get(name);
    if (!mod) {
        const packageName = PACKAGE_BY_NAME[name] ?? '(unknown)';
        throw new MissingProviderError(packageName, name);
    }
    const className = EXPORT_BY_NAME[name];
    const Cls = mod[className];
    if (!Cls) {
        throw new MissingProviderError(PACKAGE_BY_NAME[name] ?? '(unknown)', name);
    }
    return new Cls(opts);
}
export const builtInEmbedderFactories = {
    openai: (opts) => resolveEmbedder('openai', opts),
    ollama: (opts) => resolveEmbedder('ollama', opts),
    'sap-ai-core': (opts) => resolveEmbedder('sap-ai-core', opts),
    'sap-aicore': (opts) => resolveEmbedder('sap-aicore', opts),
};
/** Test-only: reset the prefetched map (for unit tests). */
export function _resetPrefetchedForTests() {
    prefetched.clear();
}
//# sourceMappingURL=embedder-factories.js.map