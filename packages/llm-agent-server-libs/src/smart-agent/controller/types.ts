import type {
  CallOptions,
  LlmUsage,
  Message,
  StreamToolCall,
} from '@mcp-abap-adt/llm-agent';
import type { SmartServerLlmConfig } from '../smart-server.js';
import type { PlanDecision } from './artifacts.js';

export type SubagentResult =
  | { kind: 'content'; content: string; usage?: LlmUsage }
  | { kind: 'tool_call'; toolCalls: StreamToolCall[]; usage?: LlmUsage }
  | { kind: 'error'; error: string; usage?: LlmUsage };

export interface Step {
  /** Stable plan-time identity (§F). 1:1 with a board entry; assigned at
   *  create-plan or fan-out. Optional only so older call-sites compile during
   *  the migration; the planner/handler always set it. */
  stepId?: string;
  name: string;
  instructions: string;
  type?: string;
  /** Marks a discovery step whose result enumerates remaining work (§D). */
  discovery?: true;
  /** When this step REPLACES a failed step on replan, the superseded `stepId` (§F). */
  supersedesStepId?: string;
  /** Plain-language references this step depends on (English — planner invariant).
   *  Decided by the reviewer, not the doer; drives the per-reference evidence map. */
  requires?: string[];
}

/** Contract cap on a step's dependency references. */
export const MAX_REQUIRES = 8;
/** A reference is a SHORT phrase, not a payload. */
export const MAX_REQUIRE_CHARS = 200;
/** Validate a step's optional `requires`. `undefined` for absent OR `[]` (a step
 *  with no deps — normalize to undefined; downstream falls back to whole-step
 *  recall); the trimmed array when valid; `false` (→ parse failure / retry) when
 *  malformed: a non-array, > MAX_REQUIRES entries, a non-string entry, or an entry
 *  empty / > MAX_REQUIRE_CHARS after trim (a huge reference must not reach the
 *  semantic query / embedder). */
export function validateRequires(v: unknown): string[] | undefined | false {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) return false;
  if (v.length === 0) return undefined;
  if (v.length > MAX_REQUIRES) return false;
  const out: string[] = [];
  for (const r of v) {
    if (typeof r !== 'string') return false;
    const t = r.trim();
    if (t.length === 0 || t.length > MAX_REQUIRE_CHARS) return false;
    out.push(t);
  }
  return out;
}

export type NextStep =
  | { kind: 'next'; step: Step }
  | { kind: 'done'; result: string }
  | { kind: 'rewind'; reason: string };

export type PendingMarker =
  | {
      kind: 'external-tool';
      extId: string;
      toolName: string;
      args: unknown;
      position: string;
    }
  | {
      kind: 'clarify';
      question: string;
      position: string;
      /** For goal-confirmation clarifies: the target the evaluator proposed, so
       *  a plain confirmation ("yes") commits IT rather than the literal answer. */
      proposedTarget?: string;
    };

export type RunState = 'idle' | 'active' | 'suspended' | 'terminal';
export type RunPhase = 'evaluating' | 'planning' | 'executing' | 'finalizing';

/** Controller-level (non-reviewer) failure that drives a replan with no reviewable
 *  artifact (e.g. the maxToolCalls budget). Persisted atomically with
 *  inFlightStep.phase='awaiting-replan' so a crash before the replan keeps the
 *  reason; fed to the planner, then cleared when the revised step is set. */
export interface ControlFailure {
  reason: 'maxToolCalls';
  seq: number;
}

export interface InFlightStep {
  seq: number;
  step: Step;
  /** Fresh-execution counter (first dispatch / revised replan step). Part of the
   *  artifact identity (runId, seq, attempt). */
  attempt: number;
  /** Crash-replay counter of ONE attempt; reset on commit / fresh attempt. */
  resumeCount: number;
  phase: 'executing' | 'awaiting-replan';
  /** Durable executor message log for this seq — the suspend/resume + crash-replay
   *  rebuild source; external tool results are appended here. */
  transcript: Message[];
  /** Durable external round-trip count; ++ persisted BEFORE each surfaced call. */
  toolCallCount: number;
  /** Why a controller-level replan (no reviewable artifact) — fed to the planner. */
  controlFailure?: ControlFailure;
}

export interface SessionBundle {
  goal: string;
  plannerPrivate: string;
  budgets: { stepsUsed: number; rewindsUsed: number };
  plan?: Step[];
  planCursor?: number;
  /** Plan decisions the planner produced this turn (create/replan), NOT yet
   *  persisted. The controller drains + `writePlanDecision`s them after
   *  `planner.next()` returns and BEFORE dispatch (§A: planner constructs, controller
   *  persists; §F: every decision is a durable artifact). Cleared once drained, and
   *  on `resetRun`. */
  pendingPlanDecisions?: PlanDecision[];
  pending?: PendingMarker;
  /** Last reviewed step outcome that drives the planner transition. */
  lastOutcome?: 'advanced' | 'failed' | 'partial';

  // -- Run scope (execution-result-control design) -----------------------
  runId?: string;
  runState?: RunState;
  runPhase?: RunPhase;
  /** The verbatim request that started this run (finalizer input + identity
   *  fingerprint source). */
  originalRequest?: string;
  nextSeq?: number;
  inFlightStep?: InFlightStep;
  // In-flight markers: persisted true BEFORE the role's LLM call; cleared in the
  // atomic decision/answer write. Recovery charges the matching resume counter
  // ONLY when the marker proves a call was running.
  evalCallInFlight?: boolean;
  plannerCallInFlight?: boolean;
  finalizeCallInFlight?: boolean;
  evalResumeCount?: number;
  plannerResumeCount?: number;
  finalizeAttempt?: number;
  /** Legacy (no-finalizer) answer: the planner's composed done.result, persisted
   *  durably in the same write that enters `finalizing`, so a crash before the
   *  terminal write recovers it (rather than emitting empty). Cleared by reset. */
  legacyFinalAnswer?: string;
  /** Monotonic per-run write ordinal; incremented BEFORE each artifact write so
   *  recall dedup can break createdAt ties by latest-write order. Reset to 0 by
   *  resetRun(); run-scoped ordinals are always comparable (recall filters by
   *  runId). */
  writeOrdinal?: number;
}

/** A controller subagent role: a standalone LLM config plus an OPTIONAL
 *  per-role `hint`. The hint is appended to that role's system prompt and gives
 *  the role extra OPERATIONAL guidance about running within the pipeline — how
 *  to build the plan, how to execute a step, what to be strict about. Its main
 *  purpose is to scaffold WEAKER models: a capable model (Opus / Sonnet) usually
 *  needs none, while a smaller executor/planner model (e.g. gpt-4o-mini) may
 *  need the extra steering. It is NOT a domain description and must NOT prescribe
 *  tool names: the planner plans by intent (it is shown no tool catalog) and the
 *  executor selects the right tool per step; richer per-situation procedures
 *  belong to the skills RAG. Absent hint → the role runs on the bare agnostic
 *  prompt. */
export type ControllerSubagentConfig = SmartServerLlmConfig & { hint?: string };

export interface ControllerConfig {
  subagents: {
    evaluator: ControllerSubagentConfig;
    planner: ControllerSubagentConfig;
    executor: ControllerSubagentConfig;
    /** Optional; default to the planner's config when absent (no breaking change). */
    reviewer?: ControllerSubagentConfig;
    finalizer?: ControllerSubagentConfig;
  };
  targetState: {
    strategy: 'consumer-confirm' | 'semantic-distance' | 'auto';
    distanceThreshold: number;
  };
  sessionMemory: { collection: string };
  budgets: {
    maxSteps: number;
    maxRetries: number;
    maxRewinds: number;
    maxToolCalls?: number;
    /** Durable fresh-attempt cap per step (bounds the non-advancing replan loop). */
    maxStepAttempts?: number;
    /** Durable crash-replay caps (one per LLM-invoking phase). */
    maxStepResumes?: number;
    maxPlannerResumes?: number;
    maxEvalResumes?: number;
    maxFinalizeRetries?: number;
    /** In-process re-ask budget for judge (reviewer) provider/malformed failures. */
    maxReviewRetries?: number;
    /** Board render budget (§B). Defaulted in parseConfig; validated at load. */
    maxDigestChars?: number;
    maxIntentChars?: number;
    maxActiveSteps?: number;
    maxBoardChars?: number;
    keepRecentDigests?: number;
  };
  /** Behaviour when the finalizer's retry budget is exhausted: 'error' → terminal
   *  control error (default); 'best-effort' → compose from approved results with an
   *  explicit incomplete marker. */
  onFinalizeExhausted?: 'error' | 'best-effort';
}

export type PlannerKind = 'smart-executor' | 'weak-executor';

export interface PlannerNextInput {
  bundle: SessionBundle;
  prompt: string;
  /** Outcome of the step run since the previous `next()` (undefined on the first
   *  call / after a rewind / on resume). The adaptive planner replans on 'failed';
   *  the incremental planner ignores it. Cursor advance on 'advanced' happens in
   *  commit(), not here. */
  lastOutcome?: 'advanced' | 'failed' | 'partial';
  /** True when re-asking after an unparsable reply (stern format reminder). */
  retrying: boolean;
  /** True on the first call of a turn that just resumed an EXTERNAL-tool result
   *  (the result is now in `bundle.plannerPrivate`). The adaptive planner replans
   *  from the cursor so it incorporates the result via the planner — which reads
   *  plannerPrivate — instead of blindly re-running the suspended step (the
   *  executor prompt does NOT include plannerPrivate). Incremental ignores it. */
  resumedExternal?: boolean;
  /** The rendered step-state digest board (§B), reconstructed by the controller
   *  from artifacts before each call. When present + non-empty it is the
   *  AUTHORITATIVE step-state context, rendered ADDITIVELY ahead of the
   *  `plannerPrivate` tail (which still carries non-board deltas — clarify answers,
   *  the legacy external result). Empty/absent → the planner uses `plannerPrivate`
   *  alone (board-less path; prompt byte-identical to the pre-board baseline). */
  boardText?: string;
  logUsage?: (role: string, u?: LlmUsage) => void;
  /** Request-scoped call options (request logger / trace / cancellation signal).
   *  Threaded into the skills-recall hook so the recall embedding is metered,
   *  cancellable, and joins the request trace. */
  options?: CallOptions;
}

export interface IControllerPlanner {
  next(input: PlannerNextInput): Promise<NextStep | null>;
  /** Optional: record a just-finished step's outcome so the planner's durable
   *  bookkeeping (e.g. the adaptive cursor) is updated and can be persisted in the
   *  SAME write that follows. Incremental does not implement it (no-op). */
  commit?(
    bundle: SessionBundle,
    outcome: 'advanced' | 'failed' | 'partial',
  ): void;
}
