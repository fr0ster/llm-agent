import type { KnowledgeEntry } from '@mcp-abap-adt/llm-agent';
import type { PlanDecisionRecord, StepStartClaim } from './artifacts.js';
import type { Outcome } from './outcome.js';
import { projectStepState, resolveByPrecedence } from './outcome.js';
import type { InFlightStep, PendingMarker, Step } from './types.js';

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
      const anchor = dec.steps[0]?.supersedesStepId;
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

/** Thrown by renderBoard when the protected (uncompactable) content still exceeds
 *  maxBoardChars (§B): the controller catches it and fails loud / suspends BEFORE
 *  the planner call rather than feeding a lossy board. */
export class BoardOverBudgetError extends Error {
  constructor(
    readonly rendered: number,
    readonly cap: number,
  ) {
    super(`rendered board (${rendered} chars) exceeds maxBoardChars (${cap})`);
    this.name = 'BoardOverBudgetError';
  }
}

/** Board render budget (§B). All bounds are REQUIRED so the cap is guaranteed. */
export interface BoardBudget {
  /** Cap on a non-discovery free-text digest (terminal entries). */
  maxDigestChars: number;
  /** Cap on an actionable entry's rendered intent (never dropped, only trimmed). */
  maxIntentChars: number;
  /** Bound on simultaneously-actionable entries (the §D capacity gate enforces it;
   *  here it sizes the load-time invariant). */
  maxActiveSteps: number;
  /** Hard cap on the whole rendered board. */
  maxBoardChars: number;
  /** Number of most-recent terminal digests kept in full before compaction. */
  keepRecentDigests: number;
}

const TERMINAL: ReadonlySet<StepState> = new Set(['done', 'partial', 'failed']);

/** Validate the board budget at load (§B fail-loud invariant): all knobs are
 *  non-negative integers, and the worst-case actionable block + the kept digests +
 *  headroom fit `maxBoardChars`. A fixed per-line overhead (~24 chars: `[`, stepId8,
 *  space, state, `] `, newline) is folded into the estimate.
 *
 *  The `maxActiveSteps` term is the §D-capacity-gated worst case (fan-out ≤
 *  maxFanOut, one window at a time). In Phase 2 (no §D gate) the actionable count is
 *  NOT bounded by maxActiveSteps — a one-shot plan materialises every future step as
 *  `planned`. So this check is the load-time sizing guide; the HARD runtime
 *  guarantee that the board never exceeds the cap is `renderBoard`'s
 *  `BoardOverBudgetError` throw (the controller catches it → fail-loud). */
export function validateBoardBudget(b: BoardBudget): void {
  for (const [k, v] of Object.entries(b)) {
    if (!Number.isInteger(v) || v < 0) {
      throw new Error(
        `BoardBudget.${k} must be a non-negative integer (got ${v})`,
      );
    }
  }
  const PER_LINE_OVERHEAD = 24;
  const actionableWorstCase =
    b.maxActiveSteps * (PER_LINE_OVERHEAD + b.maxIntentChars);
  const digestsWorstCase =
    b.keepRecentDigests * (PER_LINE_OVERHEAD + b.maxDigestChars);
  const headroom = 256;
  const needed = actionableWorstCase + digestsWorstCase + headroom;
  if (needed > b.maxBoardChars) {
    throw new Error(
      `BoardBudget invariant violated: worst-case board (${needed}) exceeds ` +
        `maxBoardChars (${b.maxBoardChars}). Increase maxBoardChars or reduce ` +
        `maxActiveSteps/maxIntentChars/keepRecentDigests/maxDigestChars.`,
    );
  }
}

/** Render the reconstructed board to ONE bounded text block (§B). Deterministic:
 *  same board ⇒ same output. Actionable (not-terminal) entries are always rendered
 *  individually (stepId + state + bounded intent); terminal entries keep the most
 *  recent K digests in full and compact older ones oldest-first, dropping to an
 *  "omitted" marker if the cap is still exceeded. */
export function renderBoard(
  board: Map<string, BoardEntry>,
  budget: BoardBudget,
): string {
  const entries = [...board.values()];
  if (entries.length === 0) return '';
  const short = (id: string) => id.slice(0, 8);

  const actionable = entries
    .filter((e) => !TERMINAL.has(e.state))
    .sort(
      (a, b) =>
        (a.seq ?? Number.POSITIVE_INFINITY) -
          (b.seq ?? Number.POSITIVE_INFINITY) ||
        a.stepId.localeCompare(b.stepId),
    )
    .map(
      (e) =>
        `[${short(e.stepId)} ${e.state}] ${e.instructions.slice(0, budget.maxIntentChars)}`,
    );

  const terminals = entries
    .filter((e) => TERMINAL.has(e.state))
    .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));

  const cutoff = Math.max(0, terminals.length - budget.keepRecentDigests);
  const recentLines = terminals
    .slice(cutoff)
    .map(
      (e) =>
        `[seq ${e.seq ?? 0} ${e.name} ${e.state}] ${(e.digest ?? '').slice(0, budget.maxDigestChars)}`,
    );
  let olderLines = terminals
    .slice(0, cutoff)
    .map((e) => `[seq ${e.seq ?? 0} ${e.name} ${e.state}]`);

  const assemble = (older: string[], omitted: number): string =>
    [
      ...actionable,
      ...(omitted > 0 ? [`… ${omitted} earlier steps omitted`] : []),
      ...older,
      ...recentLines,
    ].join('\n');

  let text = assemble(olderLines, 0);
  let omitted = 0;
  while (text.length > budget.maxBoardChars && olderLines.length > 0) {
    olderLines = olderLines.slice(1);
    omitted++;
    text = assemble(olderLines, omitted);
  }
  // GUARANTEED cap (§B): older summaries are now exhausted. The remaining content
  // (protected actionable block + K recent digests + omitted marker) is
  // uncompactable — if it STILL exceeds the cap, do NOT return a lossy board; throw
  // so the controller fails loud / suspends BEFORE the planner call.
  if (text.length > budget.maxBoardChars) {
    throw new BoardOverBudgetError(text.length, budget.maxBoardChars);
  }
  return text;
}
