import type { KnowledgeBackend } from '@mcp-abap-adt/llm-agent-libs';
import type { RunPhase, SessionBundle } from './types.js';

const BUNDLE_ARTIFACT_TYPE = 'controller-bundle';

const EMPTY_BUNDLE: SessionBundle = {
  goal: '',
  plannerPrivate: '',
  budgets: { stepsUsed: 0, rewindsUsed: 0 },
};

function emptyBundle(): SessionBundle {
  return {
    goal: EMPTY_BUNDLE.goal,
    plannerPrivate: EMPTY_BUNDLE.plannerPrivate,
    budgets: { ...EMPTY_BUNDLE.budgets },
  };
}

/**
 * Durably persist the session bundle into the KnowledgeBackend, keyed by
 * sessionId. Uses artifactType 'controller-bundle' as the discriminator.
 * Required metadata fields are filled with deterministic synthetic values
 * since this is an infrastructure record, not a turn-scoped artifact.
 */
export async function persistBundle(
  be: KnowledgeBackend,
  sessionId: string,
  bundle: SessionBundle,
): Promise<void> {
  await be.put(sessionId, {
    content: JSON.stringify(bundle),
    metadata: {
      traceId: sessionId,
      turnId: sessionId,
      stepperId: 'controller',
      task: 'session-bundle',
      artifactType: BUNDLE_ARTIFACT_TYPE,
      createdAt: new Date().toISOString(),
    },
  });
}

/**
 * Retrieve the latest persisted bundle for a session. Returns a fresh empty
 * bundle if none exists or if the stored content cannot be parsed.
 */
export async function hydrateBundle(
  be: KnowledgeBackend,
  sessionId: string,
): Promise<SessionBundle> {
  const entries = await be.scan(sessionId);
  // Scan returns oldest-first; iterate in reverse so the latest bundle wins.
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.metadata.artifactType !== BUNDLE_ARTIFACT_TYPE) continue;
    try {
      return JSON.parse(entry.content) as SessionBundle;
    } catch {
      // malformed entry — keep scanning backwards for a valid one
    }
  }
  return emptyBundle();
}

/**
 * Atomically settle a just-finished step and persist it in ONE write: record the
 * durable `lastOutcome`, advance the planner cursor via `onCommit`, move `nextSeq`
 * (advanced/partial clear the in-flight step and return to 'planning'; 'failed'
 * keeps the seq and marks `awaiting-replan`), and persist. Extracted from
 * `runStep`'s local `settle` so the wait-step path settles through the SAME
 * transition (never a hand-rolled divergence). The return value is the outcome,
 * consumed directly by `runStep` (`return settle(mapped)`).
 */
export async function settleStep(
  be: KnowledgeBackend,
  sessionId: string,
  bundle: SessionBundle,
  outcome: 'advanced' | 'failed' | 'partial',
  onCommit?: (o: 'advanced' | 'failed' | 'partial') => void,
): Promise<'advanced' | 'failed' | 'partial'> {
  bundle.lastOutcome = outcome;
  onCommit?.(outcome);
  if (outcome === 'advanced' || outcome === 'partial') {
    bundle.nextSeq = (bundle.nextSeq ?? 0) + 1;
    bundle.inFlightStep = undefined;
    bundle.runPhase = 'planning';
  } else {
    // 'failed' — keep the same seq, mark awaiting-replan in the SAME persist so
    // recovery routes by durable phase.
    if (bundle.inFlightStep) bundle.inFlightStep.phase = 'awaiting-replan';
    bundle.runPhase = 'executing';
  }
  await persistBundle(be, sessionId, bundle);
  return outcome;
}

/** Atomic fresh-run reset: clears EVERY run-scoped field and starts in
 *  `evaluating`. The caller mints + assigns a fresh `runId` and the new
 *  `originalRequest`. The terminal store (a separate keyed TTL store) is NOT
 *  touched here so a prior run's outcome stays replayable by its `runId`. */
export function resetRun(bundle: SessionBundle, originalRequest: string): void {
  bundle.goal = '';
  bundle.plannerPrivate = '';
  bundle.budgets = { stepsUsed: 0, rewindsUsed: 0 };
  bundle.plan = undefined;
  bundle.planCursor = undefined;
  bundle.pendingPlanDecisions = undefined;
  bundle.pending = undefined;
  bundle.lastOutcome = undefined;
  bundle.runState = 'active';
  bundle.runPhase = 'evaluating' as RunPhase;
  bundle.originalRequest = originalRequest;
  bundle.nextSeq = 0;
  bundle.inFlightStep = undefined;
  bundle.evalCallInFlight = false;
  bundle.plannerCallInFlight = false;
  bundle.finalizeCallInFlight = false;
  bundle.evalResumeCount = 0;
  bundle.plannerResumeCount = 0;
  bundle.finalizeAttempt = 0;
  bundle.legacyFinalAnswer = undefined;
  bundle.writeOrdinal = 0;
}
