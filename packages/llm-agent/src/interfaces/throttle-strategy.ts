/**
 * What a provider does when a server throttles it.
 *
 * Throttling, and specifically the SERVER'S. Client-side throttling is spacing
 * calls out on our own initiative, and this library does none of it: it sets no
 * default interval. A consumer may explicitly opt into fallback backoff. The
 * server names a delay — `Retry-After` is either seconds or an HTTP-date, and
 * both reduce to a delay from now — and we either observe it or report it.
 * Where the server names nothing, there is no throttling to observe.
 *
 * The library establishes facts and decides nothing. This is a 429. The server
 * named this interval, or named none. The quota is shut until then. What to do
 * about it — wait, give up, count attempts, give up after the third — belongs
 * entirely to the consumer, because the consumer is the only one who knows who
 * is waiting at the other end.
 *
 * So `whenThrottled` is not a policy object with the library's numbers in it.
 * It is the strategy itself. Anything a strategy wants to bound, it bounds on
 * its own terms: a `maxAttempts` sitting outside would silently overrule a
 * strategy that had already decided to keep going.
 *
 * Two ship; fallback backoff is explicitly opt-in:
 *
 * - `ReportThrottling` — never waits. Returns the failure with what the server
 *   said, and the caller decides. This is what happens when nothing is set.
 * - `WaitAsTold` — waits exactly the interval the server named, and reports
 *   when it named none, unless the consumer configures fallback backoff.
 */

import { exponentialBackoffMs } from './wait-strategy.js';

/** What the strategy is told. All of it observed, none of it assumed. */
export interface ThrottleContext {
  /**
   * Where this came from, which changes what the interval means.
   *
   * `response` — a server just refused the call. `retryAfterSeconds` is what it
   * said, and absent means it said nothing.
   *
   * `gate` — no request was sent, because the quota was already recorded as
   * shut. `retryAfterSeconds` is what is left of OUR record, not a fresh
   * statement from the server. A strategy that treats the two alike will be
   * wrong about at least one of them.
   */
  source: 'response' | 'gate';
  /** 1-based. The attempt just refused, or 0 for a `gate` decision. */
  attempt: number;
  /** The interval, read as `source` says. */
  retryAfterSeconds?: number;
  /** How long this call has already spent waiting. */
  waitedMs: number;
}

export interface ThrottleDecision {
  /**
   * How long this quota is shut, as far as we can tell.
   *
   * Recorded whether or not THIS caller waits: it is what the server said, and
   * the next caller deserves to know it even if this one is leaving.
   */
  waitMs: number;
  /** Whether this caller sits it out and tries again. */
  retry: boolean;
  /** When not retrying, why — free text from a consumer's own strategy. */
  reason?: string;
}

export interface IThrottleStrategy {
  readonly name: string;
  decide(ctx: ThrottleContext): ThrottleDecision;
}

/** Seconds the server named, in milliseconds, or 0 when it named none. */
function servedWaitMs(retryAfterSeconds: number | undefined): number {
  return retryAfterSeconds !== undefined && Number.isFinite(retryAfterSeconds)
    ? retryAfterSeconds * 1000
    : 0;
}

/**
 * Never wait. What happens when nothing is configured.
 *
 * The failure goes up carrying what the server said, and the caller — who knows
 * whether anyone is waiting on the other end — decides whether to sit it out.
 * The quota is still recorded as shut, so the next call does not spend a
 * request discovering it.
 */
export class ReportThrottling implements IThrottleStrategy {
  readonly name = 'report';

  decide({ retryAfterSeconds }: ThrottleContext): ThrottleDecision {
    return {
      waitMs: servedWaitMs(retryAfterSeconds),
      retry: false,
      reason: 'reported',
    };
  }
}

/**
 * Wait exactly as long as the server asked, and only then.
 *
 * For a caller with nobody waiting on it — a batch job, a CLI — that would
 * rather have the answer late than not at all.
 *
 * By default, when the server names no interval this reports instead of
 * guessing. A missing `Retry-After` is itself a signal: SAP AI Core documents the header, so its
 * absence says something is not as expected, and a number invented here would
 * be an estimate of a system we cannot see.
 *
 * `maxAttempts` is the strategy's own, because choosing this strategy is the
 * consumer's act and so is bounding it. Omit it and the strategy keeps
 * returning for as long as the server keeps naming an interval; bound that with
 * an `AbortSignal`, which is a deadline from the caller's own clock.
 *
 * Set `fallbackBackoffMs` to opt into exponential backoff when Retry-After is
 * absent: the base delay doubles per refusal, independently of the normal retry
 * limit. With this option, explicit Retry-After: 0 also retries immediately.
 * Omit maxAttempts for unlimited 429 handling, cancelled only by the caller.
 */
export class WaitAsTold implements IThrottleStrategy {
  readonly name = 'wait-as-told';
  private readonly maxAttempts: number;
  private readonly fallbackBackoffMs?: number;

  constructor(
    options: { maxAttempts?: number; fallbackBackoffMs?: number } = {},
  ) {
    this.maxAttempts = options.maxAttempts ?? Number.POSITIVE_INFINITY;
    this.fallbackBackoffMs = options.fallbackBackoffMs;
    if (
      this.fallbackBackoffMs !== undefined &&
      (!Number.isFinite(this.fallbackBackoffMs) || this.fallbackBackoffMs < 0)
    ) {
      throw new RangeError('fallbackBackoffMs must be finite and nonnegative');
    }
  }

  decide({ attempt, retryAfterSeconds }: ThrottleContext): ThrottleDecision {
    const waitMs =
      retryAfterSeconds === undefined && this.fallbackBackoffMs !== undefined
        ? exponentialBackoffMs(this.fallbackBackoffMs, attempt - 1)
        : servedWaitMs(retryAfterSeconds);
    if (waitMs <= 0 && this.fallbackBackoffMs === undefined) {
      return { waitMs: 0, retry: false, reason: 'no-interval' };
    }
    if (attempt >= this.maxAttempts) {
      return { waitMs, retry: false, reason: 'attempts' };
    }
    return { waitMs, retry: true };
  }
}
