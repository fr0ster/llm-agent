import type { KnowledgeEntry } from '@mcp-abap-adt/llm-agent';
import type { PlanDecisionRecord, StepStartClaim } from './artifacts.js';
import type { Outcome } from './outcome.js';
import { projectStepState, resolveByPrecedence } from './outcome.js';
import type { InFlightStep, PendingMarker } from './types.js';

export type StepState =
  | 'planned'
  | 'executing'
  | 'awaiting-external'
  | 'done'
  | 'partial'
  | 'failed';

export interface BoardEntry {
  stepId: string;
  name: string;
  instructions: string;
  state: StepState;
  digest?: string;
  seq?: number;
  attempt?: number;
}

export interface BoardInputs {
  structure: PlanDecisionRecord[];
  stepResults: readonly KnowledgeEntry[];
  claims: StepStartClaim[];
  inFlight?: InFlightStep;
  /** The run-level pending marker — it lives on the SessionBundle, NOT on
   *  InFlightStep. Passed in so the board can refine the current in-flight step's
   *  transient state to `awaiting-external` when the run is suspended on an
   *  external tool. */
  pending?: PendingMarker;
}

/** Rebuild the step-state board from artifacts (§F), sources 1–3. */
export function reconstructBoard(input: BoardInputs): Map<string, BoardEntry> {
  const board = new Map<string, BoardEntry>();

  // (1) Structure ← plan-decision steps (later decisions append/replace).
  for (const dec of input.structure) {
    for (const s of dec.steps) {
      if (!s.stepId) continue;
      board.set(s.stepId, {
        stepId: s.stepId,
        name: s.name,
        instructions: s.instructions,
        state: 'planned',
      });
    }
  }

  const resultsByStep = new Map<string, KnowledgeEntry[]>();
  for (const e of input.stepResults) {
    if (e.metadata.artifactType !== 'step-result') continue;
    const id = e.metadata.stepId;
    if (!id) continue;
    const bucket = resultsByStep.get(id);
    if (bucket) bucket.push(e);
    else resultsByStep.set(id, [e]);
  }
  const claimsByStep = new Map<string, StepStartClaim[]>();
  for (const c of input.claims) {
    const bucket = claimsByStep.get(c.stepId);
    if (bucket) bucket.push(c);
    else claimsByStep.set(c.stepId, [c]);
  }

  // (2)+(3) Terminal / transient state, attempt-scoped (§F).
  for (const [stepId, entry] of board) {
    const results = resultsByStep.get(stepId) ?? [];
    const claims = claimsByStep.get(stepId) ?? [];
    const maxResultAttempt = results.reduce(
      (m, e) => Math.max(m, e.metadata.attempt ?? 0),
      -1,
    );
    const maxClaimAttempt = claims.reduce((m, c) => Math.max(m, c.attempt), -1);
    const inFlightForStep =
      input.inFlight && input.inFlight.step?.stepId === stepId
        ? input.inFlight
        : undefined;
    const maxAttempt = Math.max(
      maxResultAttempt,
      maxClaimAttempt,
      inFlightForStep ? inFlightForStep.attempt : -1,
    );

    if (maxAttempt < 0) continue; // never started → stays 'planned'

    const settledForCurrent = results.filter(
      (e) => (e.metadata.attempt ?? 0) === maxAttempt,
    );
    if (settledForCurrent.length === 0) {
      entry.state =
        inFlightForStep?.phase === 'executing' &&
        input.pending?.kind === 'external-tool'
          ? 'awaiting-external'
          : 'executing';
      entry.attempt = maxAttempt;
      continue;
    }
    const outcomes: Outcome[] = settledForCurrent
      .slice()
      .sort(
        (a, b) =>
          (a.metadata.writeOrdinal ?? 0) - (b.metadata.writeOrdinal ?? 0),
      )
      .map((e) => ({
        status: (e.metadata.status ?? 'failed') as Outcome['status'],
        approved: e.content,
        remainder: e.metadata.remainder ?? '',
        note: e.metadata.note ?? '',
      }));
    const resolved = resolveByPrecedence(outcomes);
    if (!resolved) continue;
    entry.state = projectStepState(resolved.status);
    entry.attempt = maxAttempt;
    const winner = settledForCurrent
      .filter((e) => (e.metadata.status ?? 'failed') === resolved.status)
      .reduce<(typeof settledForCurrent)[number] | undefined>(
        (best, e) =>
          !best ||
          (e.metadata.writeOrdinal ?? 0) >= (best.metadata.writeOrdinal ?? 0)
            ? e
            : best,
        undefined,
      );
    entry.digest = winner?.metadata.digest;
  }
  return board;
}
