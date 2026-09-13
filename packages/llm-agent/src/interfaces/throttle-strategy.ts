/**
 * What a provider does when a server throttles it.
 *
 * The library establishes facts and never decides how long a caller may be
 * held. A 429 is a fact; the interval the server named is a fact; that the
 * quota is shut until a given moment is a fact. Whether to sit out that
 * interval or to hand the failure to a user is not — it depends on who is
 * waiting at the other end, which the library cannot see. A CLI can happily
 * wait a minute; an HTTP service answering inside a request cannot.
 *
 * So waiting is a strategy, supplied by the consumer, and nothing waits by
 * default. Two are shipped, because between them they cover what anyone
 * actually wants:
 *
 * - `ReportThrottling` — never wait. Return the failure with what the server
 *   said, and let the caller decide.
 * - `WaitAsTold` — wait exactly as long as the server asked, and only then.
 *   When it named no interval, report instead of guessing at milliseconds.
 *
 * Neither invents a duration. A consumer who wants exponential backoff writes
 * it: that is a guess about someone else's server, and a guess belongs to
 * whoever is willing to own it.
 */

export interface ThrottlePolicy {
  /**
   * Total attempts INCLUDING the first. Read only by a strategy that retries.
   *
   * A count, not a duration — the one bound the library can set without
   * knowing anything about the caller.
   */
  maxAttempts: number;
  /** How the facts become a decision. Omit for `ReportThrottling`. */
  strategy?: IThrottleStrategy;
}

/** What the strategy is told. */
export interface ThrottleContext {
  /** 1-based. The attempt just refused, or 0 when the quota was known shut. */
  attempt: number;
  /** What the server asked us to wait, in seconds, if it said. */
  retryAfterSeconds?: number;
  /** Waiting already spent on this call. */
  waitedMs: number;
  /** The numbers in force, so a strategy need not close over them. */
  policy: ThrottlePolicy;
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
  /** When not retrying, why. */
  reason?: 'reported' | 'attempts' | 'no-interval';
}

export interface IThrottleStrategy {
  readonly name: string;
  decide(ctx: ThrottleContext): ThrottleDecision;
}

export const DEFAULT_THROTTLE_POLICY: Omit<ThrottlePolicy, 'strategy'> = {
  maxAttempts: 5,
};

/** Seconds the server named, in milliseconds, or 0 when it named none. */
function servedWaitMs(retryAfterSeconds: number | undefined): number {
  return retryAfterSeconds !== undefined && Number.isFinite(retryAfterSeconds)
    ? retryAfterSeconds * 1000
    : 0;
}

/**
 * Never wait. The default.
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
 * For a caller that has no one waiting on it — a batch job, a CLI — and would
 * rather have the answer late than not at all.
 *
 * When the server named no interval, this reports instead of guessing. A
 * missing `Retry-After` is itself a signal: SAP AI Core documents the header,
 * so its absence says something is not as expected, and a number we invent
 * would be an estimate of a system we cannot see.
 */
export class WaitAsTold implements IThrottleStrategy {
  readonly name = 'wait-as-told';

  decide({
    attempt,
    retryAfterSeconds,
    policy,
  }: ThrottleContext): ThrottleDecision {
    const waitMs = servedWaitMs(retryAfterSeconds);
    if (waitMs <= 0) {
      return { waitMs: 0, retry: false, reason: 'no-interval' };
    }
    if (attempt >= policy.maxAttempts) {
      return { waitMs, retry: false, reason: 'attempts' };
    }
    return { waitMs, retry: true };
  }
}
