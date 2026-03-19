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

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const DEFAULT_RETRY_INTERVAL_MS = 5_000;

/**
 * Create a lazy-initializing proxy for interface `T`.
 *
 * @param factory  Sync or async function that produces the real instance.
 * @param options  Retry interval, error callback, optional fallback.
 * @returns A `T`-shaped proxy.
 */
export function lazy<T extends object>(
  factory: () => T | Promise<T>,
  options?: LazyOptions<T>,
): T {
  const retryIntervalMs = options?.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS;
  const onError = options?.onError;
  const fallback = options?.fallback;

  let instance: T | null = null;
  let initPromise: Promise<void> | null = null;
  let lastFailureTs = 0;

  // -----------------------------------------------------------------------
  // Init logic with mutex + retry gate
  // -----------------------------------------------------------------------

  async function doInit(): Promise<void> {
    const now = Date.now();
    if (now - lastFailureTs < retryIntervalMs) {
      throw new LazyInitError(
        `Lazy init: retry suppressed (next attempt in ${retryIntervalMs - (now - lastFailureTs)} ms)`,
      );
    }
    try {
      const result = factory();
      instance = result instanceof Promise ? await result : result;
    } catch (err) {
      lastFailureTs = Date.now();
      onError?.(err);
      throw err;
    }
  }

  async function ensureInitialized(): Promise<void> {
    if (instance) return;

    // Mutex: if another call is already initializing, piggy-back.
    if (initPromise) {
      await initPromise;
      return;
    }

    initPromise = doInit();
    try {
      await initPromise;
    } finally {
      initPromise = null;
    }
  }

  // -----------------------------------------------------------------------
  // Proxy handler
  // -----------------------------------------------------------------------

  const handler: ProxyHandler<object> = {
    get(_target, prop, _receiver) {
      // Fast path: instance is ready — delegate directly.
      if (instance) {
        const val = (instance as Record<string | symbol, unknown>)[prop];
        return typeof val === 'function' ? val.bind(instance) : val;
      }

      // Slow path: return an async wrapper that initializes first.
      // This works for async methods; for sync properties on an
      // uninitialized proxy it will return a Promise (type mismatch),
      // which is acceptable for the intended interface patterns.
      return async (...args: unknown[]) => {
        try {
          await ensureInitialized();
        } catch {
          // Init failed — delegate to fallback if available.
          if (fallback) {
            const fn = (fallback as Record<string | symbol, unknown>)[prop];
            if (typeof fn === 'function') {
              return fn.apply(fallback, args);
            }
            return fn;
          }
          throw new LazyInitError(
            `Lazy init failed and no fallback provided (property: ${String(prop)})`,
          );
        }
        const fn = (instance as Record<string | symbol, unknown>)[prop];
        if (typeof fn === 'function') {
          return fn.apply(instance, args);
        }
        return fn;
      };
    },
  };

  // Use an empty object as the proxy target — all access goes through
  // the handler which delegates to `instance` or `fallback`.
  return new Proxy<T>({} as T, handler);
}

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export class LazyInitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LazyInitError';
  }
}
