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

import {
  type IThrottleStrategy,
  ReportThrottling,
  type ThrottleDecision,
} from '../interfaces/throttle-strategy.js';
import { DefaultWaitStrategy } from '../interfaces/wait-strategy.js';

/** Nothing waits unless the consumer says so. */
const defaultStrategy = new ReportThrottling();

/** An error annotated by this module, so consumers read a fact instead of prose. */
export interface ThrottledError extends Error {
  throttled: true;
  /** What the server asked for, when it asked. */
  retryAfterSeconds?: number;
  /** How many attempts were spent before giving up. */
  attempts: number;
  /**
   * Which cap ended it, when it ended here. `attempts` and `budget` are fixed
   * by opposite settings, so a consumer that cannot tell them apart cannot act
   * on either. `gate` means the pause was already longer than the budget and no
   * request was sent at all.
   */
  reason?: ThrottleDecision['reason'];
}

export function isThrottledError(e: unknown): e is ThrottledError {
  return (
    typeof e === 'object' &&
    e !== null &&
    (e as { throttled?: unknown }).throttled === true
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
 * wake in the same millisecond and rebuild the herd the penalty broke up.
 *
 * It is added to a wait, never to a budget: a wait capped at exactly the budget
 * simply loses the spread, which costs nothing — a caller whose budget ends
 * with the pause is leaving either way.
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
export class QuotaGate {
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
      // A timer that lands a hair early is simply waited out again on the next
      // turn, which is why the cap needs no padding to be safe.
      await sleep(
        Math.min(left + Math.random() * WAKE_SPREAD_MS, budget),
        signal,
      );
    }
  }
}

interface GateEntry {
  gate: QuotaGate;
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
export function gateFor(key: string): QuotaGate {
  const now = Date.now();
  const existing = gates.get(key);
  if (existing) {
    existing.lastUsed = now;
    return existing.gate;
  }
  if (gates.size >= GATE_LIMIT) reclaimGates(now);
  const entry: GateEntry = {
    gate: new QuotaGate(),
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
export function leaseQuotaGate(key: string): {
  gate: QuotaGate;
  release: () => void;
} {
  const gate = gateFor(key);
  // By identity, not by key: `resetQuotaGates` may have replaced the entry
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
export function pruneQuotaGates(now: number = Date.now()): void {
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
  pruneQuotaGates(now);
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
export function quotaGateCount(): number {
  return gates.size;
}

/** Test seam — drops every gate. */
export function resetQuotaGates(): void {
  gates.clear();
}

export interface ThrottleRetryOptions {
  /** Identifies the quota being spent. Limits are per model, so include it. */
  key: string;
  /** What to do about a 429. Omit and nothing waits. */
  strategy?: IThrottleStrategy;
  /** Does this error mean "too many requests"? */
  isThrottled: (error: unknown) => boolean;
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
 * What happened, every time a server says 429.
 *
 * Reported for every provider and on every refusal, including the last one —
 * the case an operator most needs to see was the one nothing was written for.
 *
 * The policy travels with the event because the numbers are unreadable without
 * it: `attempt 3` is the end under `maxAttempts: 3` and the middle under 5. And
 * because it answers the question a configuration crossing several layers
 * otherwise leaves open, which is whether it arrived at all.
 */
export interface ThrottleEvent {
  /** The quota: account, endpoint and model. Carries no credential. */
  key: string;
  /** The strategy that made the call. */
  strategy: string;
  /** 1-based, the attempt that was just refused. */
  attempt: number;
  /** Did the server name an interval, and which. Absent means it did not. */
  retryAfterSeconds?: number;
  /** How long the quota is shut, as far as we can tell. */
  waitMs: number;
  /** How long this call has already spent waiting. */
  waitedMs: number;
  /** False on the last one, with `reason` saying which cap ended it. */
  willRetry: boolean;
  reason?: ThrottleDecision['reason'];
}

type ThrottleObserver = (event: ThrottleEvent) => void;

let observer: ThrottleObserver | undefined;

/**
 * Watch every throttling decision in this process.
 *
 * One subscription rather than a logger per provider: only two of five
 * providers had anywhere to put a log line, which is why four of them said
 * nothing. Where the event goes is the consumer's business; that it is emitted
 * at all is not.
 *
 * Pass `undefined` to stop watching. A throwing observer is ignored — a
 * diagnostic must not turn a wait into a failure.
 */
export function setThrottleObserver(fn: ThrottleObserver | undefined): void {
  observer = fn;
}

function emit(event: ThrottleEvent): void {
  if (!observer) return;
  try {
    observer(event);
  } catch {
    // An observer that throws is a broken diagnostic, not a broken request.
  }
}

/**
 * Run `fn`, respecting the shared pause and retrying a rate limit.
 *
 * Any error that is not a rate limit is rethrown untouched and immediately —
 * this is not a general-purpose retry, and turning a genuine failure into four
 * more of them would be worse than the failure.
 */
export async function runWithThrottleRetry<T>(
  fn: () => Promise<T>,
  opts: ThrottleRetryOptions,
): Promise<T> {
  const { gate, release } = leaseQuotaGate(opts.key);
  try {
    return await attemptWithGate(fn, opts, gate);
  } finally {
    release();
  }
}

async function attemptWithGate<T>(
  fn: () => Promise<T>,
  opts: ThrottleRetryOptions,
  gate: QuotaGate,
): Promise<T> {
  const strategy = opts.strategy ?? defaultStrategy;
  let attempt = 0;
  let waited = 0;
  // True when the wait ahead is one this caller already chose, in the catch
  // below. Without it the gate would ask the strategy a second time about a
  // refusal it had just answered, and report the same event twice.
  let servingOwnWait = false;

  for (;;) {
    // A quota known to be shut is not a reason to hold this caller — it is a
    // reason not to spend a request finding out. The strategy decides which:
    // sit out the interval the server named, or leave now with it.
    const shut = gate.remaining();
    if (shut > 0) {
      if (!servingOwnWait) {
        const decision = strategy.decide({
          attempt,
          retryAfterSeconds: shut / 1000,
          waitedMs: waited,
        });
        report(opts, strategy, {
          attempt,
          retryAfterSeconds: shut / 1000,
          waitMs: shut,
          waitedMs: waited,
          decision,
        });
        if (!decision.retry) {
          throw knownShut(shut, attempt, decision.reason);
        }
      }
      const before = Date.now();
      await gate.waitUntilOpen(opts.signal);
      waited += Date.now() - before;
    }
    servingOwnWait = false;

    try {
      return await fn();
    } catch (error) {
      if (!opts.isThrottled(error)) throw error;

      attempt += 1;
      const retryAfter = opts.retryAfterSeconds?.(error);
      const decision = strategy.decide({
        attempt,
        retryAfterSeconds: retryAfter,
        waitedMs: waited,
      });

      // Recorded whether or not THIS caller goes on. What the server said is
      // true for everyone, and a caller that leaves without writing it down
      // sends the next one to discover it again, at the cost of another
      // refusal. Knowing is shared; waiting is not.
      gate.penalise(decision.waitMs);

      report(opts, strategy, {
        attempt,
        retryAfterSeconds: retryAfter,
        waitMs: decision.waitMs,
        waitedMs: waited,
        decision,
      });

      if (!decision.retry) {
        throw annotate(error, attempt, retryAfter, decision.reason);
      }

      opts.onRetry?.({
        attempt,
        delayMs: decision.waitMs,
        retryAfterSeconds: retryAfter,
      });
      servingOwnWait = true;
    }
  }
}

function report(
  opts: ThrottleRetryOptions,
  strategy: IThrottleStrategy,
  info: {
    attempt: number;
    retryAfterSeconds?: number;
    waitMs: number;
    waitedMs: number;
    decision: ThrottleDecision;
  },
): void {
  emit({
    key: opts.key,
    strategy: strategy.name,
    attempt: info.attempt,
    retryAfterSeconds: info.retryAfterSeconds,
    waitMs: info.waitMs,
    waitedMs: info.waitedMs,
    willRetry: info.decision.retry,
    reason: info.decision.reason,
  });
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
export function findThrottled(err: unknown): ThrottledError | undefined {
  const visited = new Set<unknown>();
  let cur: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
    if (typeof cur !== 'object' || cur === null || visited.has(cur))
      return undefined;
    visited.add(cur);
    if (isThrottledError(cur)) return cur;
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
export function preserveThrottled<E extends Error>(
  original: unknown,
  wrapped: E,
): E {
  if (!isThrottledError(original)) return wrapped;
  const w = wrapped as E & Partial<ThrottledError>;
  w.throttled = true;
  w.attempts = original.attempts;
  if (original.retryAfterSeconds !== undefined) {
    w.retryAfterSeconds = original.retryAfterSeconds;
  }
  // Every fact, not a chosen few. Every provider wraps its transport error, so
  // a fact left behind here is a fact no consumer ever sees — which is how the
  // reason for giving up was lost the moment it was added.
  if (original.reason !== undefined) w.reason = original.reason;
  return w;
}

/**
 * The quota is shut and this caller is not waiting it out.
 *
 * No request was sent, because there is nothing to learn from a refusal we can
 * already predict — and a refusal we ask for is a refusal we are charged for.
 * The remaining interval goes up with the error so the caller can decide.
 */
function knownShut(
  remainingMs: number,
  attempts: number,
  reason: ThrottledError['reason'],
): ThrottledError {
  const e = new Error(
    'throttled: the quota is closed and this call is not waiting it out',
  ) as ThrottledError;
  e.throttled = true;
  e.attempts = attempts;
  e.retryAfterSeconds = remainingMs / 1000;
  if (reason !== undefined) e.reason = reason;
  return e;
}

function annotate(
  error: unknown,
  attempts: number,
  retryAfterSeconds?: number,
  reason?: ThrottledError['reason'],
): ThrottledError {
  const e = (
    error instanceof Error ? error : new Error(String(error))
  ) as ThrottledError;
  e.throttled = true;
  e.attempts = attempts;
  if (retryAfterSeconds !== undefined) e.retryAfterSeconds = retryAfterSeconds;
  if (reason !== undefined) e.reason = reason;
  return e;
}
