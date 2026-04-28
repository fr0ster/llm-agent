import type { IEmbedder } from '@mcp-abap-adt/llm-agent';
export type EmbedderFactoryOpts = Record<string, unknown>;
/**
 * Load peer packages for the factory names given. Call once at server
 * startup before any synchronous resolve calls. Missing peer throws
 * MissingProviderError up front so startup fails fast.
 */
export declare function prefetchEmbedderFactories(names: readonly string[]): Promise<void>;
/** Sync resolve. Caller MUST have awaited prefetchEmbedderFactories(names) first. */
export declare function resolveEmbedder(name: string, opts: EmbedderFactoryOpts): IEmbedder;
export declare const builtInEmbedderFactories: Record<string, (opts: EmbedderFactoryOpts) => IEmbedder>;
/** Test-only: reset the prefetched map (for unit tests). */
export declare function _resetPrefetchedForTests(): void;
//# sourceMappingURL=embedder-factories.d.ts.map