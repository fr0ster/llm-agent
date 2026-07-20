import type { InFlightStep, Step } from './types.js';

export type WaitPlan =
  | { kind: 'fresh'; applied: number; clamped: boolean; cappedSkip: boolean }
  | { kind: 'resume'; remaining: number; deadlinePassed: boolean }
  | { kind: 'torn'; missing: 'waitStartedAt' | 'appliedWaitMs' };

/** A wait step is served by the controller itself — never dispatched to the
 *  executor, the reviewer or an MCP client. */
export function isWaitStep(step: Step): boolean {
  return step.type === 'wait';
}

/**
 * Decide how to serve a wait, branching on BOTH deadline fields.
 *
 * Branching on one field alone is the trap: a torn write that persisted
 * `waitStartedAt` but not `appliedWaitMs` would take the fresh path, reset the
 * deadline and charge the budget twice — silently, in exactly the crash case
 * the durable contract exists to survive.
 */
export function planWait(args: {
  step: Step;
  inFlight: Pick<InFlightStep, 'waitStartedAt' | 'appliedWaitMs'>;
  maxWaitMs: number;
  maxTotalWaitMs: number;
  waitMsUsed: number;
  now: number;
}): WaitPlan {
  const { waitStartedAt, appliedWaitMs } = args.inFlight;
  const hasStart = waitStartedAt !== undefined;
  const hasApplied = appliedWaitMs !== undefined;

  if (hasStart !== hasApplied) {
    return {
      kind: 'torn',
      missing: hasStart ? 'appliedWaitMs' : 'waitStartedAt',
    };
  }

  if (hasStart && hasApplied) {
    // Resume: recompute NOTHING. A later clamp or cap change must not move a
    // deadline that was fixed when the wait started.
    const remaining = Math.max(0, waitStartedAt + appliedWaitMs - args.now);
    return { kind: 'resume', remaining, deadlinePassed: remaining === 0 };
  }

  const requested = args.step.waitMs ?? 0;
  const capRemaining = Math.max(0, args.maxTotalWaitMs - args.waitMsUsed);
  const applied = Math.min(requested, args.maxWaitMs, capRemaining);
  return {
    kind: 'fresh',
    applied,
    // Truncated by EITHER bound, but still sleeping. `clamped` says "shorter
    // than asked", it does not say which bound won.
    clamped: applied > 0 && applied < requested,
    // Only a TRUE skip: no sleep at all. A partial truncation by the cap is a
    // clamp, not a skip — reporting "no wait performed" while sleeping 10 s
    // would be a false artifact.
    cappedSkip: applied === 0 && requested > 0,
  };
}

/** Render a `WaitPlan` as the step-result text a `wait` step reports to the
 *  board — pure formatting, no I/O. */
export function describeWait(plan: WaitPlan, step: Step): string {
  const requested = step.waitMs ?? 0;
  switch (plan.kind) {
    case 'fresh':
      if (plan.cappedSkip) {
        return `wait: skip — total-wait budget exhausted, requested ${requested}ms not served`;
      }
      if (plan.clamped) {
        return `wait: ${plan.applied}ms (clamped from ${requested}ms)`;
      }
      return `wait: ${plan.applied}ms`;
    case 'resume':
      return plan.deadlinePassed
        ? 'wait: resumed, deadline already passed — 0ms remaining'
        : `wait: resumed, ${plan.remaining}ms remaining`;
    case 'torn':
      return `wait: control error — torn durable state, missing ${plan.missing}`;
    default: {
      const _exhaustive: never = plan;
      return _exhaustive;
    }
  }
}
