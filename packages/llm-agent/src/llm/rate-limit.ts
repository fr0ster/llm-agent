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

import { DefaultWaitStrategy } from '../interfaces/wait-strategy.js';

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

const waiter = new DefaultWaitStrategy();

/**
 * Sleep, or throw if the signal aborts.
 *
 * Delegated to the shared wait strategy rather than hand-rolled: the listener
 * bookkeeping is where a sleep like this goes wrong. One added per backoff and
 * never removed accumulates on a request- or session-scoped signal until Node
 * warns about the leak — a defect this repository has already fixed once, in
 * the retry decorators. Fixed in one place, it stays fixed for every waiter.
 */
const sleep = async (ms: number, signal?: AbortSignal): Promise<void> => {
  const aborted = (): Error =>
    (signal?.reason as Error | undefined) ?? new Error('Aborted');
  if (signal?.aborted) throw aborted();
  if ((await waiter.wait(ms, signal)) === 'aborted') throw aborted();
};

/**
 * Per-caller spread on waking, so everyone released by one penalty does not
 * wake in the same millisecond and rebuild the herd the penalty broke up. It
 * doubles as the slack on a capped wait: without it, jitter truncated to an
 * exact budget could return a hair early and read as a refusal.
 */
const WAKE_SPREAD_MS = 250;

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
  async waitUntilOpen(
    signal?: AbortSignal,
    maxWaitMs = Number.POSITIVE_INFINITY,
  ): Promise<void> {
    const deadline = Date.now() + maxWaitMs;
    for (;;) {
      const left = this.remaining();
      if (left <= 0) return;
      const budget = deadline - Date.now();
      // Out of the caller's budget with the gate still shut. It is told, not
      // held: `remaining()` still reports the hold, and the caller decides.
      if (budget <= 0) return;
      await sleep(
        Math.min(left + Math.random() * WAKE_SPREAD_MS, budget),
        signal,
      );
    }
  }
}

interface GateEntry {
  gate: RateLimitGate;
  lastUsed: number;
  /** How many calls are holding this gate right now. Never evict above zero. */
  leases: number;
}

const gates = new Map<string, GateEntry>();

/**
 * Keys are open-ended — a per-request model override mints a new one — so the
 * registry is pruned rather than left to grow for the life of the process.
 * Only entries that are both open and long idle are dropped: a held gate is
 * doing its job, and a recently used one may still be someone's in-flight call.
 */
export const GATE_IDLE_TTL_MS = 10 * 60_000;
/**
 * How many quotas the registry keeps. Enforced by evicting gates that are both
 * open and unheld, so a process with more than this many pauses or in-flight
 * calls at once can exceed it — those gates are load-bearing. Evicting an idle
 * one costs nothing: it carries no deadline, and the next call mints an
 * equivalent.
 */
export const GATE_LIMIT = 500;

/** The gate for one quota. Shared across every provider instance in the process. */
export function gateFor(key: string): RateLimitGate {
  const now = Date.now();
  const existing = gates.get(key);
  if (existing) {
    existing.lastUsed = now;
    return existing.gate;
  }
  if (gates.size >= GATE_LIMIT) reclaimGates(now);
  const entry: GateEntry = {
    gate: new RateLimitGate(),
    lastUsed: now,
    leases: 0,
  };
  gates.set(key, entry);
  return entry.gate;
}

/**
 * Hold a gate for the length of one call, and keep it in the registry meanwhile.
 *
 * Being open is not the same as being unused. A request is in flight for as
 * long as it takes the server to answer, and until that answer arrives the gate
 * it belongs to has no pause on it. Evicted in that window, the call would go on
 * to penalise an object the registry no longer knows: the pause would be real
 * and invisible, and the next caller would be handed a fresh open gate and sent
 * straight into a quota that had just closed. Worse than no gate at all, since
 * the penalty is paid and nothing is bought with it.
 *
 * Release in a `finally`. Releasing twice is harmless.
 */
export function leaseRateLimitGate(key: string): {
  gate: RateLimitGate;
  release: () => void;
} {
  const gate = gateFor(key);
  // By identity, not by key: `resetRateLimitGates` may have replaced the entry
  // by the time this is released, and that entry's count is not ours to touch.
  const entry = gates.get(key);
  if (entry) entry.leases += 1;
  let released = false;
  return {
    gate,
    release: () => {
      if (released || !entry) return;
      released = true;
      entry.leases -= 1;
      entry.lastUsed = Date.now();
    },
  };
}

/**
 * Reclaim gates that are open and long idle. Exported so a long-lived host can
 * run it on a timer, and so the reclaim can be tested at a chosen `now` without
 * waiting ten minutes. It frees only what is certainly stale; the size bound is
 * enforced separately, by `reclaimGates`.
 */
export function pruneRateLimitGates(now: number = Date.now()): void {
  for (const [key, entry] of gates) {
    if (isEvictable(entry, now) && now - entry.lastUsed > GATE_IDLE_TTL_MS) {
      gates.delete(key);
    }
  }
}

/**
 * Safe to forget: nobody is waiting behind it, and no call is holding it.
 *
 * An open, unleased gate carries no state at all — the next call mints an
 * equivalent one and loses nothing.
 */
function isEvictable(entry: GateEntry, now: number): boolean {
  return entry.leases === 0 && entry.gate.remaining(now) === 0;
}

/**
 * Hold the registry at `GATE_LIMIT`.
 *
 * Age alone is not a bound: a burst of per-request model overrides mints keys
 * far faster than the ten-minute idle rule retires them, and the map grows for
 * as long as the burst lasts. So once the stale entries are gone, the least
 * recently used OPEN gates go too, oldest first, until the registry is back
 * under the limit.
 *
 * Only idle gates are evicted: not one holding a pause, which IS the pause, and
 * not one a call is still holding, which may be about to become a pause.
 */
function reclaimGates(now: number): void {
  pruneRateLimitGates(now);
  if (gates.size < GATE_LIMIT) return;

  const evictable = [...gates]
    .filter(([, entry]) => isEvictable(entry, now))
    .sort((a, b) => a[1].lastUsed - b[1].lastUsed);

  for (const [key] of evictable) {
    if (gates.size < GATE_LIMIT) return;
    gates.delete(key);
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
  if (!policy.enabled) return fn();

  const { gate, release } = leaseRateLimitGate(opts.key);
  try {
    return await attemptWithGate(fn, opts, policy, gate);
  } finally {
    release();
  }
}

async function attemptWithGate<T>(
  fn: () => Promise<T>,
  opts: RateLimitRetryOptions,
  policy: RateLimitPolicy,
  gate: RateLimitGate,
): Promise<T> {
  let attempt = 0;
  let waited = 0;

  for (;;) {
    // Waiting at the gate is waiting. Uncounted it was free, so a caller with a
    // ten-millisecond budget could sit out a minute-long pause another caller
    // had earned, its declared budget saying nothing about the time it spent.
    // Decided before the wait, never during it: a hold longer than what is left
    // of the budget is refused outright rather than half-served.
    const hold = gate.remaining();
    if (hold > 0) {
      const budgetLeft = policy.maxTotalWaitMs - waited;
      if (hold > budgetLeft) throw outOfBudgetAtGate(hold, attempt);
      const before = Date.now();
      // Capped as well as pre-checked: a pause that fits when the wait starts
      // can be extended past the budget by someone else's 429 while it runs.
      await gate.waitUntilOpen(opts.signal, budgetLeft + WAKE_SPREAD_MS);
      waited += Date.now() - before;
      const stillShut = gate.remaining();
      if (stillShut > 0) throw outOfBudgetAtGate(stillShut, attempt);
    }

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

      // Hold everyone else too, and hold them whether or not THIS caller has
      // budget left to retry. The pause describes the quota, not one request:
      // giving up with the gate open sends every other caller straight back
      // into a limit the server just said was closed.
      //
      // The gate is given the interval alone. This caller then serves its own
      // backoff there, on the next turn of the loop, rather than sleeping
      // beside it: two mechanisms waiting out one pause double-count it, and
      // the leftover milliseconds between them decide outcomes at the margin.
      // The per-caller spread that keeps the released callers from waking
      // together lives in `waitUntilOpen`, where the waiting is done.
      gate.penalise(wait);

      const outOfAttempts = attempt >= policy.maxAttempts;
      const outOfTime = waited + wait > policy.maxTotalWaitMs;
      if (outOfAttempts || outOfTime) {
        throw annotate(error, attempt, retryAfter);
      }

      opts.onRetry?.({
        attempt,
        delayMs: wait,
        retryAfterSeconds: retryAfter,
      });
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

/**
 * The shared pause outlasts what this caller said it would wait.
 *
 * There is no server error to annotate here — the request was never sent,
 * because sending it into a quota known to be closed is the one thing the gate
 * exists to prevent. It is still a rate limit, and says so, carrying what is
 * left of the pause so the consumer can decide.
 */
function outOfBudgetAtGate(
  remainingMs: number,
  attempts: number,
): RateLimitedError {
  const e = new Error(
    'rate limited: the pause on this quota outlasts the configured wait budget',
  ) as RateLimitedError;
  e.rateLimited = true;
  e.attempts = attempts;
  e.retryAfterSeconds = remainingMs / 1000;
  return e;
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
