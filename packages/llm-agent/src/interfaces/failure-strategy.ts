/**
 * What a provider does when a call fails for a reason nobody named an interval
 * for: a `500`, a `502`, a dropped connection, a socket that answers nothing.
 *
 * The sibling of `IThrottleStrategy`, and deliberately not the same seam.
 * Throttling is the SERVER governing the pace: it returns `429`, it names a
 * delay in `Retry-After`, and the only honest thing to do is observe that
 * delay or report it. Here nobody names anything. A `502` says the request
 * failed; it says nothing at all about when the next one might work.
 *
 * So any waiting here rests on a number, and this library has none to give.
 * How long to wait, and how many times, depends on who is waiting at the other
 * end — a batch job and a caller on a sixty-second connection want opposite
 * things, and the difference is invisible from in here. The consumer decides,
 * the same way it decides about throttling.
 *
 * Two ship:
 *
 * - `ReportFailure` — never waits. The failure goes up as it arrived, and the
 *   caller decides. This is what happens when nothing is configured.
 * - `RetryWithBackoff` — the classic policy, with its numbers named by whoever
 *   constructs it rather than defaulted in here.
 */

import { isRetryableStatus } from '../resilience/status.js';

/** What the transport said, for a strategy to decide on. */
export interface FailureContext {
  /** HTTP status, when the failure carried one. */
  status?: number;
  /** Which attempt just failed. 1-based. */
  attempt: number;
  /** How long this call has already spent waiting between attempts. */
  waitedMs: number;
  /** Whether anything was already streamed to the caller before the failure. */
  midStream: boolean;
  /** The failure itself, for a strategy that needs to look closer. */
  error: unknown;
}

/** Wait this long, then either try again or give up. */
export interface FailureDecision {
  waitMs: number;
  retry: boolean;
  /** Why, for the log and for the error the caller finally sees. */
  reason?: string;
}

export interface IFailureStrategy {
  readonly name: string;
  decide(ctx: FailureContext): FailureDecision;
}

/**
 * Never retry. What happens when nothing is configured.
 *
 * The failure goes up untouched, and the caller — who knows whether anyone is
 * waiting on the other end, and whether the work is worth repeating — decides
 * whether to ask again.
 */
export class ReportFailure implements IFailureStrategy {
  readonly name = 'report-failure';

  decide(): FailureDecision {
    return { waitMs: 0, retry: false, reason: 'reported' };
  }
}

/**
 * Try again a fixed number of times, doubling the wait each time.
 *
 * The policy this library used to install on everyone by default. It still
 * ships, because it is a reasonable thing to want; what changed is that its
 * numbers now belong to whoever writes them down. There are no defaults here
 * on purpose — a default would be this library guessing again, one layer in.
 *
 * `statuses` is the set worth repeating. A `500` or `502` is usually the
 * provider having a bad second; a `400` is the request itself, and repeating
 * it just fails again more slowly. A failure carrying no status is not
 * retried: without one there is nothing to tell a blip from a bug.
 *
 * `midStreamHints` opts into the harder case — a stream that failed after it
 * had already yielded. Retrying that replays the whole stream, so it happens
 * only for failures whose message matches one of these, and never by default.
 */
export class RetryWithBackoff implements IFailureStrategy {
  readonly name = 'retry-with-backoff';
  private readonly attempts: number;
  private readonly firstWaitMs: number;
  private readonly statuses: ReadonlySet<number>;
  private readonly midStreamHints: readonly string[];

  constructor(options: {
    /** How many times to try again after the first failure. */
    attempts: number;
    /** The first wait. Each subsequent one doubles it. */
    firstWaitMs: number;
    /** Statuses worth repeating. */
    statuses: readonly number[];
    /** Message fragments that make a mid-stream failure worth replaying. */
    midStreamHints?: readonly string[];
  }) {
    this.attempts = options.attempts;
    this.firstWaitMs = options.firstWaitMs;
    this.statuses = new Set(options.statuses);
    this.midStreamHints = options.midStreamHints ?? [];
  }

  decide({
    status,
    attempt,
    midStream,
    error,
  }: FailureContext): FailureDecision {
    if (attempt > this.attempts) {
      return { waitMs: 0, retry: false, reason: 'attempts' };
    }
    const worthRepeating = midStream
      ? this.matchesHint(error)
      : status !== undefined
        ? this.statuses.has(status)
        : // No structured status: fall back to the shared word-boundary match on
          // the message, because every provider rewraps its transport error and
          // the status is often only in the prose by the time it reaches here.
          isRetryableStatus(error, [...this.statuses]);
    if (!worthRepeating) {
      return {
        waitMs: 0,
        retry: false,
        reason: midStream ? 'mid-stream' : 'not-transient',
      };
    }
    // attempt is 1-based, so the first retry waits exactly firstWaitMs.
    return { waitMs: this.firstWaitMs * 2 ** (attempt - 1), retry: true };
  }

  private matchesHint(error: unknown): boolean {
    if (this.midStreamHints.length === 0) return false;
    const message = error instanceof Error ? error.message : String(error);
    return this.midStreamHints.some((hint) => message.includes(hint));
  }
}
