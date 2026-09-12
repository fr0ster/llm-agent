/**
 * What a provider does when a server throttles it.
 *
 * The seam lives here, beside the other strategies, rather than next to the
 * implementation that ships with it: a consumer programs against this package,
 * and a contract kept in the implementation file is a contract nobody finds.
 *
 * The policy is the numbers; the strategy turns them into a decision. The
 * shared pause per quota is NOT part of it — that is an invariant the runner
 * keeps either way, because one caller declining to wait is its own business
 * and one caller declining to mark the quota closed is everyone's.
 */

export interface ThrottlePolicy {
  /** Total attempts INCLUDING the first. 1 waits out no throttling of its own. */
  maxAttempts: number;
  /** Give up once the accumulated waiting would exceed this. */
  maxTotalWaitMs: number;
  /** First backoff step when the server names no time of its own. */
  baseDelayMs: number;
  /** Ceiling for one computed step, before jitter. */
  maxDelayMs: number;
  /**
   * How the numbers above turn into a decision. Omit for the default.
   *
   * There is no switch to turn throttle handling off, because there is no case
   * where sending another request into a quota the server has just closed is
   * the better answer — that is correctness, not preference. A consumer who
   * wants different mechanics supplies them here, and the shared pause, which
   * is the part other callers depend on, is kept either way.
   */
  strategy?: IThrottleStrategy;
}

/** What the strategy is told about the 429 that just came back. */
export interface ThrottleContext {
  /** 1-based: the attempt that was just refused. */
  attempt: number;
  /** What the server asked us to wait, in seconds, if it said. */
  retryAfterSeconds?: number;
  /** Waiting already spent on this call, the shared pause included. */
  waitedMs: number;
  /** The numbers in force, so a strategy need not close over them. */
  policy: ThrottlePolicy;
}

export interface ThrottleDecision {
  /**
   * How long this quota is closed.
   *
   * Taken by the shared pause whether or not THIS caller retries: the quota is
   * shut regardless of who has budget left, and a caller that gives up with the
   * gate open sends everyone else straight back into the limit.
   */
  waitMs: number;
  /** Whether this caller waits it out and tries again. */
  retry: boolean;
  /** When not retrying, which cap ended it. */
  reason?: 'attempts' | 'budget';
}

export interface IThrottleStrategy {
  readonly name: string;
  decide(ctx: ThrottleContext): ThrottleDecision;
}

export const DEFAULT_THROTTLE_POLICY: Omit<ThrottlePolicy, 'strategy'> = {
  maxAttempts: 5,
  maxTotalWaitMs: 60_000,
  baseDelayMs: 1_000,
  maxDelayMs: 20_000,
};

/**
 * What SAP AI Core documents: the server's own `Retry-After` when it sends one,
 * otherwise exponential backoff with full jitter, capped by attempts and by
 * total waiting.
 */
export class DefaultThrottleStrategy implements IThrottleStrategy {
  readonly name = 'default-throttle';

  decide({
    attempt,
    retryAfterSeconds,
    waitedMs,
    policy,
  }: ThrottleContext): ThrottleDecision {
    const served =
      retryAfterSeconds !== undefined && Number.isFinite(retryAfterSeconds);

    // The server's own number wins. A computed guess is for when it stays
    // silent — it is an estimate of something the server already knows.
    const waitMs = served
      ? (retryAfterSeconds as number) * 1000
      : jittered(policy.baseDelayMs * 2 ** (attempt - 1), policy.maxDelayMs);

    if (attempt >= policy.maxAttempts) {
      return { waitMs, retry: false, reason: 'attempts' };
    }
    if (waitedMs + waitMs > policy.maxTotalWaitMs) {
      return { waitMs, retry: false, reason: 'budget' };
    }
    return { waitMs, retry: true };
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
