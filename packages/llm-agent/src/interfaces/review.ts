import type { ContextPath } from './context-path.js';
import type { DagPlan } from './dag-plan.js';
import type { NodeResult } from './interpreter.js';
import type { PlannerCatalogEntry } from './planner.js';
import type { LlmUsage } from './types.js';

export interface ReviewInput {
  prompt: string;
  plan: DagPlan;
  agents: PlannerCatalogEntry[];
  sessionId: string;
  signal?: AbortSignal;
  ancestorContext?: ContextPath;
}

/** Pure domain verdict from the reviewer. Telemetry (LLM usage) is carried
 *  separately on the wrapper (`ReviewResult`) so it does not contaminate the
 *  verdict object itself. */
export type ReviewVerdict = { pass: true } | { pass: false; feedback: string };

/** Wrapper returned by `IReviewStrategy.review`. Keeps optional LLM-usage
 *  telemetry OUT of the verdict (which is a pure domain decision); the
 *  coordinator forwards `usage` into the session request logger. */
export interface ReviewResult {
  verdict: ReviewVerdict;
  usage?: LlmUsage;
}

/** Input to the reviewer when a node FAILED during execution (slice 4a). */
export interface ExecutionFailureInput {
  objective?: string;
  /** The plan as it stands now. */
  plan: DagPlan;
  /** Completed/failed nodes so far — the reviewer's view of current state. */
  trace: NodeResult[];
  failedNodeId: string;
  error: string;
  agents: PlannerCatalogEntry[];
  sessionId: string;
  signal?: AbortSignal;
  ancestorContext?: ContextPath;
}

/** Pure domain recovery decision. Telemetry is carried on the wrapper. */
export type ExecutionReviewDecision =
  | { action: 'abort' }
  | { action: 'revise'; revisedPlan: DagPlan };

export interface ExecutionReviewResult {
  decision: ExecutionReviewDecision;
  usage?: LlmUsage;
}

export interface IReviewStrategy {
  readonly name: string;
  /** Optional model identifier (best-effort), surfaced to the coordinator so
   *  per-role LLM usage can be attributed to a specific model in the request
   *  logger. Non-LLM reviewers may omit it. */
  readonly model?: string;
  review(input: ReviewInput): Promise<ReviewResult>;
  /** Decide recovery for an execution failure (slice 4a). OPTIONAL — a reviewer
   *  that omits it cannot drive recovery (the strategy treats that as abort). */
  reviewExecutionFailure?(
    input: ExecutionFailureInput,
  ): Promise<ExecutionReviewResult>;
}
