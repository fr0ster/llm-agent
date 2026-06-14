// Test-side helpers shared by skill-host.integration.test.ts.
// Two purposes: bounded polling (Qdrant writes are async — the production client
// omits wait=true) and pool lifecycle (open pg sockets keep the tsx subprocess
// alive; leaking one would hang run.mjs before `down -v`).

/** Re-invoke `fn` until `predicate(result)` is true or the timeout elapses. */
export async function pollUntil<T>(
  fn: () => Promise<T>,
  opts: { predicate: (v: T) => boolean; timeoutMs?: number; intervalMs?: number; label?: string },
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const intervalMs = opts.intervalMs ?? 100;
  const deadline = Date.now() + timeoutMs;
  let last: T;
  // biome-ignore lint/nursery/noConstantCondition: bounded by the deadline check below
  while (true) {
    last = await fn();
    if (opts.predicate(last)) return last;
    if (Date.now() >= deadline) {
      throw new Error(
        `pollUntil timed out after ${timeoutMs}ms${opts.label ? ` waiting for ${opts.label}` : ''}; last value: ${JSON.stringify(last)}`,
      );
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/**
 * The inverse of pollUntil: re-sample `fn` for the WHOLE window and throw if
 * `predicate` ever breaks. Proves a condition is SUSTAINED — e.g. a retired
 * generation's point count stays at its full value after a pre-grace sweep
 * (a one-shot `count > 0` would pass instantly because the delete simply hadn't
 * propagated yet, proving nothing).
 */
export async function assertHoldsFor<T>(
  fn: () => Promise<T>,
  opts: { predicate: (v: T) => boolean; windowMs?: number; intervalMs?: number; label?: string },
): Promise<void> {
  const windowMs = opts.windowMs ?? 1500;
  const intervalMs = opts.intervalMs ?? 150;
  const deadline = Date.now() + windowMs;
  do {
    const v = await fn();
    if (!opts.predicate(v)) {
      throw new Error(
        `assertHoldsFor: predicate broke${opts.label ? ` for ${opts.label}` : ''}; value: ${JSON.stringify(v)}`,
      );
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  } while (Date.now() < deadline);
}

/** Anything with an async end() — both makePgPool and makePgReadPool qualify. */
export interface Closable {
  end(): Promise<void>;
}

/**
 * Run `body`, then end() EVERY registered pool in a finally — even if `body`
 * throws. `register` is passed into `body` so it adds each pool as it creates it.
 * Guarantees no pg socket outlives the test → the subprocess exits → run.mjs
 * reaches `docker compose down -v`.
 */
export async function withPools<T>(
  body: (register: (pool: Closable) => Closable) => Promise<T>,
): Promise<T> {
  const pools: Closable[] = [];
  const register = (pool: Closable): Closable => {
    pools.push(pool);
    return pool;
  };
  try {
    return await body(register);
  } finally {
    for (const p of pools) {
      try {
        await p.end();
      } catch {
        // best-effort: a failed end() must not mask the body's error
      }
    }
  }
}
