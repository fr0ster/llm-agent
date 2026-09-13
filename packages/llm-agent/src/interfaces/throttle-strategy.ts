/**
 * What a provider does when a server throttles it.
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
 * Two ship, and neither invents a duration:
 *
 * - `ReportThrottling` — never waits. Returns the failure with what the server
 *   said, and the caller decides. This is what happens when nothing is set.
 * - `WaitAsTold` — waits exactly the interval the server named, and reports
 *   when it named none, rather than guessing at milliseconds.
 */

/** What the strategy is told. All of it observed, none of it assumed. */
export interface ThrottleContext {
  /** 1-based. The attempt just refused, or 0 when the quota was known shut. */
  attempt: number;
  /** What the server asked us to wait, in seconds, if it said. */
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
 * When the server names no interval this reports instead of guessing. A missing
 * `Retry-After` is itself a signal: SAP AI Core documents the header, so its
 * absence says something is not as expected, and a number invented here would
 * be an estimate of a system we cannot see.
 *
 * `maxAttempts` is the strategy's own, because choosing this strategy is the
 * consumer's act and so is bounding it. Omit it and the strategy keeps
 * returning for as long as the server keeps naming an interval; bound that with
 * an `AbortSignal`, which is a deadline from the caller's own clock.
 */
export class WaitAsTold implements IThrottleStrategy {
  readonly name = 'wait-as-told';
  private readonly maxAttempts: number;

  constructor(options: { maxAttempts?: number } = {}) {
    this.maxAttempts = options.maxAttempts ?? Number.POSITIVE_INFINITY;
  }

  decide({ attempt, retryAfterSeconds }: ThrottleContext): ThrottleDecision {
    const waitMs = servedWaitMs(retryAfterSeconds);
    if (waitMs <= 0) {
      return { waitMs: 0, retry: false, reason: 'no-interval' };
    }
    if (attempt >= this.maxAttempts) {
      return { waitMs, retry: false, reason: 'attempts' };
    }
    return { waitMs, retry: true };
  }
}
