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

/** Optional token-usage attribution from an LLM-backed reviewer. The
 *  coordinator forwards this into the session request logger so reviewer
 *  spend is captured alongside worker tokens. Non-LLM reviewers omit it. */
export type ReviewVerdict =
  | { pass: true; usage?: LlmUsage }
  | { pass: false; feedback: string; usage?: LlmUsage };

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

export type ExecutionReviewDecision =
  | { action: 'abort'; usage?: LlmUsage }
  | { action: 'revise'; revisedPlan: DagPlan; usage?: LlmUsage };

export interface IReviewStrategy {
  readonly name: string;
  /** Optional model identifier (best-effort), surfaced to the coordinator so
   *  per-role LLM usage can be attributed to a specific model in the request
   *  logger. Non-LLM reviewers may omit it. */
  readonly model?: string;
  review(input: ReviewInput): Promise<ReviewVerdict>;
  /** Decide recovery for an execution failure (slice 4a). OPTIONAL — a reviewer
   *  that omits it cannot drive recovery (the strategy treats that as abort). */
  reviewExecutionFailure?(
    input: ExecutionFailureInput,
  ): Promise<ExecutionReviewDecision>;
}
