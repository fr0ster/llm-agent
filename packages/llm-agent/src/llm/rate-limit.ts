/**
 * Shared rate-limit handling for every LLM provider.
 *
 * None of the providers handled HTTP 429 (issue #282). Each one let the status
 * collapse into an error message, so consumers were reduced to matching the
 * substring "429" in prose to decide whether to retry.
 *
 * The policy lives here rather than in a provider because the providers differ
 * in SDK but not in the shape of the problem: a shared quota, a documented
 * `Retry-After`, and a herd of concurrent callers that will all rediscover the
 * same limit unless something holds them back together.
 *
 * SAP AI Core states the rules this implements
 * (help.sap.com, Rate Limit Management):
 *
 *   Do not retry immediately after a 429. Use exponential backoff with jitter
 *   to prevent thundering-herd behavior. If the response includes a
 *   `Retry-After` header, use its value as the wait interval. Limit retries by
 *   using a maximum cap (for example, 5 retries or 60 seconds total wait).
 *
 * The same rules fit Anthropic and OpenAI, which return 429 with `Retry-After`
 * as ordinary HTTP. Ollama is local and never rate-limited; it simply never
 * enters this path.
 */

export interface RateLimitPolicy {
  /** Set false to pass every error straight through. */
  enabled: boolean;
  /** Total attempts INCLUDING the first. 1 disables retrying without disabling the gate. */
  maxAttempts: number;
  /** Give up once the accumulated waiting would exceed this. */
  maxTotalWaitMs: number;
  /** First backoff step when the server names no time of its own. */
  baseDelayMs: number;
  /** Ceiling for one computed step, before jitter. */
  maxDelayMs: number;
}

export const DEFAULT_RATE_LIMIT_POLICY: RateLimitPolicy = {
  enabled: true,
  maxAttempts: 5,
  maxTotalWaitMs: 60_000,
  baseDelayMs: 1_000,
  maxDelayMs: 20_000,
};

/** An error annotated by this module, so consumers read a fact instead of prose. */
export interface RateLimitedError extends Error {
  rateLimited: true;
  /** What the server asked for, when it asked. */
  retryAfterSeconds?: number;
  /** How many attempts were spent before giving up. */
  attempts: number;
}

export function isRateLimitedError(e: unknown): e is RateLimitedError {
  return (
    typeof e === 'object' &&
    e !== null &&
    (e as { rateLimited?: unknown }).rateLimited === true
  );
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('Aborted'));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(signal.reason ?? new Error('Aborted'));
      },
      { once: true },
    );
  });

/**
 * One shared pause per quota.
 *
 * A rate limit belongs to the quota, not to the request that happened to
 * discover it. When one call is told to wait, every other call against the same
 * quota is already over the limit too — letting each find that out for itself
 * means N more rejected requests and N more penalties, which is how a limit
 * that should last one window lasts several.
 *
 * Keyed because limits are per model: one model being throttled says nothing
 * about another.
 */
export class RateLimitGate {
  private notBefore = 0;

  /** Hold every caller until the named time. Never shortens an existing hold. */
  penalise(ms: number, now: number = Date.now()): void {
    this.notBefore = Math.max(this.notBefore, now + ms);
  }

  /** Milliseconds still to wait, or 0. */
  remaining(now: number = Date.now()): number {
    return Math.max(0, this.notBefore - now);
  }

  clear(): void {
    this.notBefore = 0;
  }

  /**
   * Wait out any active hold.
   *
   * Re-checked after every wake, because the hold is not fixed at the moment
   * this caller started waiting: another caller's 429 extends it, and a sleeper
   * timed against the old deadline would wake early and spend a request on a
   * quota the server has since said is still closed.
   *
   * The wait is jittered per caller: without that, everyone released by one
   * penalty wakes in the same millisecond and rebuilds the herd the penalty was
   * meant to break up.
   */
  async waitUntilOpen(signal?: AbortSignal): Promise<void> {
    for (;;) {
      const left = this.remaining();
      if (left <= 0) return;
      await sleep(left + Math.random() * 250, signal);
    }
  }
}

interface GateEntry {
  gate: RateLimitGate;
  lastUsed: number;
}

const gates = new Map<string, GateEntry>();

/**
 * Keys are open-ended — a per-request model override mints a new one — so the
 * registry is pruned rather than left to grow for the life of the process.
 * Only entries that are both open and long idle are dropped: a held gate is
 * doing its job, and a recently used one may still be someone's in-flight call.
 */
export const GATE_IDLE_TTL_MS = 10 * 60_000;
export const GATE_SOFT_LIMIT = 500;

/** The gate for one quota. Shared across every provider instance in the process. */
export function gateFor(key: string): RateLimitGate {
  const now = Date.now();
  const existing = gates.get(key);
  if (existing) {
    existing.lastUsed = now;
    return existing.gate;
  }
  if (gates.size >= GATE_SOFT_LIMIT) pruneRateLimitGates(now);
  const entry: GateEntry = { gate: new RateLimitGate(), lastUsed: now };
  gates.set(key, entry);
  return entry.gate;
}

/**
 * Reclaim gates that are open and long idle. Runs on its own when the registry
 * passes the soft limit; exported so a long-lived host can run it on a timer,
 * and so the reclaim can be tested at a chosen `now` without waiting ten
 * minutes.
 */
export function pruneRateLimitGates(now: number = Date.now()): void {
  for (const [key, entry] of gates) {
    if (
      entry.gate.remaining(now) === 0 &&
      now - entry.lastUsed > GATE_IDLE_TTL_MS
    ) {
      gates.delete(key);
    }
  }
}

/** How many quotas are currently tracked. Diagnostics and tests. */
export function rateLimitGateCount(): number {
  return gates.size;
}

/** Test seam — drops every gate. */
export function resetRateLimitGates(): void {
  gates.clear();
}

export interface RateLimitRetryOptions {
  /** Identifies the quota being spent. Limits are per model, so include it. */
  key: string;
  policy?: Partial<RateLimitPolicy>;
  /** Does this error mean "too many requests"? */
  isRateLimited: (error: unknown) => boolean;
  /** What the server asked us to wait, in seconds, if it said. */
  retryAfterSeconds?: (error: unknown) => number | undefined;
  signal?: AbortSignal;
  onRetry?: (info: {
    attempt: number;
    delayMs: number;
    retryAfterSeconds?: number;
  }) => void;
}

/**
 * Run `fn`, respecting the shared pause and retrying a rate limit.
 *
 * Any error that is not a rate limit is rethrown untouched and immediately —
 * this is not a general-purpose retry, and turning a genuine failure into four
 * more of them would be worse than the failure.
 */
export async function runWithRateLimitRetry<T>(
  fn: () => Promise<T>,
  opts: RateLimitRetryOptions,
): Promise<T> {
  const policy = { ...DEFAULT_RATE_LIMIT_POLICY, ...opts.policy };
  const gate = gateFor(opts.key);

  if (!policy.enabled) return fn();

  let attempt = 0;
  let waited = 0;

  for (;;) {
    await gate.waitUntilOpen(opts.signal);
    try {
      return await fn();
    } catch (error) {
      if (!opts.isRateLimited(error)) throw error;

      attempt += 1;
      const retryAfter = opts.retryAfterSeconds?.(error);
      const served = retryAfter !== undefined && Number.isFinite(retryAfter);

      // The server's own number wins. A computed guess is for when it stays
      // silent — it is an estimate of something the server already knows.
      const wait = served
        ? (retryAfter as number) * 1000
        : jittered(policy.baseDelayMs * 2 ** (attempt - 1), policy.maxDelayMs);

      // A few hundred milliseconds of per-caller spread, so the callers this
      // penalty released do not all wake in the same millisecond. It is added
      // to the sleep but NOT charged to the budget: charging it made a plain
      // `Retry-After: 60` cost 60_000..60_250ms against a 60_000ms budget, so
      // the most ordinary answer SAP AI Core gives was refused on the spot.
      const spread = served ? Math.random() * 250 : 0;

      // Hold everyone else too, and hold them whether or not THIS caller has
      // budget left to retry. The pause describes the quota, not one request:
      // giving up with the gate open sends every other caller straight back
      // into a limit the server just said was closed.
      gate.penalise(wait + spread);

      const outOfAttempts = attempt >= policy.maxAttempts;
      const outOfTime = waited + wait > policy.maxTotalWaitMs;
      if (outOfAttempts || outOfTime) {
        throw annotate(error, attempt, retryAfter);
      }

      opts.onRetry?.({
        attempt,
        delayMs: wait + spread,
        retryAfterSeconds: retryAfter,
      });
      await sleep(wait + spread, opts.signal);
      waited += wait;
    }
  }
}

/**
 * Full jitter: a random point in [0, computed], not computed ± a nudge.
 *
 * Scaling a shared delay by a factor near 1 keeps the herd together; drawing
 * from the whole interval is what actually spreads it.
 */
function jittered(computed: number, maxDelayMs: number): number {
  return Math.random() * Math.min(computed, maxDelayMs);
}

const MAX_CAUSE_DEPTH = 5;

/**
 * The rate-limit marker on an error or anywhere in its `cause` chain.
 *
 * Layers above the provider rewrap errors — the ILlm adapter turns anything
 * thrown into an `LlmError` — so the marker is rarely still on the outermost
 * object by the time a retry decorator inspects it. Bounded by depth and a
 * visited set, like `extractStatusCode`, so a cyclic chain cannot hang.
 */
export function findRateLimit(err: unknown): RateLimitedError | undefined {
  const visited = new Set<unknown>();
  let cur: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
    if (typeof cur !== 'object' || cur === null || visited.has(cur))
      return undefined;
    visited.add(cur);
    if (isRateLimitedError(cur)) return cur;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * Carry the rate-limit facts onto a provider's own error.
 *
 * Every provider catches its transport error and rethrows something friendlier.
 * That is fine for a message and fatal for a fact: the 429 would be lost at the
 * exact boundary where the consumer needs it. This moves the facts across.
 */
export function preserveRateLimit<E extends Error>(
  original: unknown,
  wrapped: E,
): E {
  if (!isRateLimitedError(original)) return wrapped;
  const w = wrapped as E & Partial<RateLimitedError>;
  w.rateLimited = true;
  w.attempts = original.attempts;
  if (original.retryAfterSeconds !== undefined) {
    w.retryAfterSeconds = original.retryAfterSeconds;
  }
  return w;
}

function annotate(
  error: unknown,
  attempts: number,
  retryAfterSeconds?: number,
): RateLimitedError {
  const e = (
    error instanceof Error ? error : new Error(String(error))
  ) as RateLimitedError;
  e.rateLimited = true;
  e.attempts = attempts;
  if (retryAfterSeconds !== undefined) e.retryAfterSeconds = retryAfterSeconds;
  return e;
}
