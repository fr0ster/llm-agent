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

/** Render a `WaitPlan` as the step-result text (and a short machine-checkable
 *  `note`) a `wait` step reports to the board — pure formatting, no I/O. */
export function describeWait(
  plan: WaitPlan,
  step: Step,
): { text: string; note: string } {
  if (plan.kind === 'resume') {
    return plan.deadlinePassed
      ? {
          text: 'Wait deadline had already elapsed during the outage; no additional sleep was performed.',
          note: 'resumed after deadline',
        }
      : {
          text: `Waited the remaining ${plan.remaining} ms of the scheduled pause.`,
          note: '',
        };
  }
  if (plan.kind === 'fresh' && plan.cappedSkip) {
    return {
      text: "No wait performed: the run's total wait budget is spent.",
      note: 'total wait budget spent',
    };
  }
  if (plan.kind === 'fresh' && plan.clamped) {
    return {
      text: `Waited ${plan.applied} ms (requested ${step.waitMs} ms, truncated by a wait bound).`,
      note: 'clamped',
    };
  }
  return {
    text: `Waited ${(plan as { applied: number }).applied} ms for the system to settle.`,
    note: '',
  };
}
