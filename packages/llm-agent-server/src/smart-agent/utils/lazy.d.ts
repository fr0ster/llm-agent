/**
 * Generic lazy initialization wrapper.
 *
 * Returns a `T` proxy that defers construction of the real instance
 * to the first method call.  If the factory fails, the proxy can
 * optionally delegate to a `fallback` instance and retry on the
 * next call (respecting `retryIntervalMs`).
 *
 * Designed for async-method interfaces (`IMcpClient`, `IRag`,
 * `IEmbedder`, `ISkillManager`, `ILlm`, etc.).
 *
 * @example
 * ```ts
 * import { lazy, type IMcpClient } from '@anthropic/llm-agent';
 *
 * const mcp = lazy<IMcpClient>(() => connectMcp(url), {
 *   retryIntervalMs: 10_000,
 *   onError: (err) => console.warn('MCP init failed, will retry', err),
 * });
 *
 * // First call triggers connect(); subsequent calls reuse the instance.
 * const tools = await mcp.listTools();
 * ```
 */
export interface LazyOptions<T extends object> {
    /**
     * Minimum milliseconds between retry attempts after a failed init.
     * Default: `5_000`.
     */
    retryIntervalMs?: number;
    /** Called every time the factory throws / rejects. */
    onError?: (error: unknown) => void;
    /**
     * Optional fallback instance used while the real one is unavailable.
     * When provided, method calls are delegated to this fallback instead
     * of propagating the factory error.
     */
    fallback?: T;
}
/**
 * Create a lazy-initializing proxy for interface `T`.
 *
 * @param factory  Sync or async function that produces the real instance.
 * @param options  Retry interval, error callback, optional fallback.
 * @returns A `T`-shaped proxy.
 */
export declare function lazy<T extends object>(factory: () => T | Promise<T>, options?: LazyOptions<T>): T;
export declare class LazyInitError extends Error {
    constructor(message: string);
}
//# sourceMappingURL=lazy.d.ts.map