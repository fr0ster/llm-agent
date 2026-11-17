import type {
  IKnowledgeRagHandle,
  KnowledgeEntry,
} from '@mcp-abap-adt/llm-agent';
import {
  type PlanDecisionRecord,
  readClaims,
  readPlanDecisions,
  type StepStartClaim,
} from './artifacts.js';
import type { Outcome } from './outcome.js';
import { projectStepState, resolveByPrecedence } from './outcome.js';
import type {
  InFlightStep,
  PendingMarker,
  SessionBundle,
  Step,
} from './types.js';

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

/** Replay create/replan decisions (writeOrdinal order) into the canonical CURRENT
 *  plan (§F arbitration): a later `create` (a crash-retry of a not-yet-persisted
 *  plan) REPLACES the earlier one; a `replan` replaces the plan tail from its
 *  superseded anchor (steps[0].supersedesStepId) onward. Steps dropped by a
 *  replacement therefore never appear as phantom `planned` entries. */
export function reconstructPlanStructure(
  decisions: PlanDecisionRecord[],
): Step[] {
  const ordered = [...decisions].sort(
    (a, b) => a.writeOrdinal - b.writeOrdinal,
  );
  let plan: Step[] = [];
  for (const dec of ordered) {
    if (dec.kind === 'create') {
      plan = dec.steps;
    } else if (dec.kind === 'replan') {
      const anchor = dec.anchorStepId ?? dec.steps[0]?.supersedesStepId;
      const idx = anchor ? plan.findIndex((s) => s.stepId === anchor) : -1;
      plan =
        idx >= 0
          ? [...plan.slice(0, idx), ...dec.steps]
          : [...plan, ...dec.steps];
    }
    // expand/page kinds are not produced in Phase 2 — ignored (later-phase concern).
  }
  return plan;
}

/** Rebuild the step-state board from artifacts (§F), sources 1–3. */
export function reconstructBoard(input: BoardInputs): Map<string, BoardEntry> {
  const board = new Map<string, BoardEntry>();

  // (1) Structure ← the canonical replayed plan (§F arbitration): a stale create or
  //     a replan-dropped tail never becomes a phantom `planned` entry.
  const canonical = reconstructPlanStructure(input.structure);
  // Lookup over EVERY step ever decided — used to resurrect executed-but-dropped steps.
  const everDecided = new Map<string, Step>();
  for (const dec of input.structure) {
    for (const s of dec.steps) {
      if (s.stepId) everDecided.set(s.stepId, s);
    }
  }
  for (const s of canonical) {
    if (!s.stepId) continue;
    board.set(s.stepId, {
      stepId: s.stepId,
      name: s.name,
      instructions: s.instructions,
      state: 'planned',
    });
  }
  // (1b) Resurrect EXECUTED steps a replacement dropped from the canonical plan: an
  //      executed step is immutable history (§F) and must stay on the board with its
  //      terminal state; an UNEXECUTED dropped step is a phantom and stays out.
  for (const e of input.stepResults) {
    if (e.metadata.artifactType !== 'step-result') continue;
    const id = e.metadata.stepId;
    if (!id || board.has(id)) continue;
    const s = everDecided.get(id);
    if (s) {
      board.set(id, {
        stepId: id,
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
      // Populate seq from the in-flight step first; fall back to the max-attempt claim.
      const maxAttemptClaim = claims.reduce<StepStartClaim | undefined>(
        (best, c) =>
          c.attempt === maxAttempt &&
          (!best || c.writeOrdinal >= best.writeOrdinal)
            ? c
            : best,
        undefined,
      );
      entry.seq = inFlightForStep?.seq ?? maxAttemptClaim?.seq;
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
    entry.seq = winner?.metadata.seq;
  }
  return board;
}

/** Legacy error type retained for source compatibility; rendering no longer caps content. */
export class BoardOverBudgetError extends Error {
  constructor(
    readonly rendered: number,
    readonly cap: number,
  ) {
    super(`rendered board (${rendered} chars) exceeds maxBoardChars (${cap})`);
    this.name = 'BoardOverBudgetError';
  }
}

/** Legacy render settings retained for compatibility; content is not capped. */
export interface BoardBudget {
  /** @deprecated Digests are preserved in full. */
  maxDigestChars: number;
  /** @deprecated Instructions are preserved in full. */
  maxIntentChars: number;
  /** Capacity setting retained for compatibility; rendering never drops entries. */
  maxActiveSteps: number;
  /** @deprecated Board text is preserved in full. */
  maxBoardChars: number;
  /** @deprecated Every terminal digest is preserved in full. */
  keepRecentDigests: number;
}

const TERMINAL: ReadonlySet<StepState> = new Set(['done', 'partial', 'failed']);

/** Validate legacy budget values without enforcing a conversation size limit. */
export function validateBoardBudget(b: BoardBudget): void {
  for (const [k, v] of Object.entries(b)) {
    if (!Number.isInteger(v) || v < 0) {
      throw new Error(
        `BoardBudget.${k} must be a non-negative integer (got ${v})`,
      );
    }
  }
}

/** Render every board entry with its complete intent and digest. */
export function renderBoard(
  board: Map<string, BoardEntry>,
  _budget: BoardBudget,
): string {
  const entries = [...board.values()];
  const actionable = entries
    .filter((entry) => !TERMINAL.has(entry.state))
    .sort(
      (a, b) =>
        (a.seq ?? Number.POSITIVE_INFINITY) -
          (b.seq ?? Number.POSITIVE_INFINITY) ||
        a.stepId.localeCompare(b.stepId),
    )
    .map((entry) => `[${entry.stepId} ${entry.state}] ${entry.instructions}`);
  const terminal = entries
    .filter((entry) => TERMINAL.has(entry.state))
    .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
    .map(
      (entry) =>
        `[seq ${entry.seq ?? 0} ${entry.name} ${entry.state}] ${entry.digest ?? ''}`,
    );
  return [...actionable, ...terminal].join('\n');
}

/** Reconstruct and render the live step-state board from artifacts.
 *  Returns '' when there is no runId (the board has nothing to show yet). */
export async function renderLiveBoard(
  rag: IKnowledgeRagHandle,
  bundle: SessionBundle,
  budget: BoardBudget,
): Promise<string> {
  const runId = bundle.runId;
  if (!runId) return '';
  const [structure, claims] = await Promise.all([
    readPlanDecisions(rag, runId),
    readClaims(rag, runId),
  ]);
  const stepResults = await rag.list({ runId, artifactType: 'step-result' });
  const board = reconstructBoard({
    structure,
    stepResults,
    claims,
    inFlight: bundle.inFlightStep,
    pending: bundle.pending,
  });
  return renderBoard(board, budget);
}
