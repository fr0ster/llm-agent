import type { ContextPath } from './context-path.js';
import type { DagPlan } from './dag-plan.js';
import type { NodeResult } from './interpreter.js';
import type { PlannerCatalogEntry } from './planner.js';

export interface ReviewInput {
  prompt: string;
  plan: DagPlan;
  agents: PlannerCatalogEntry[];
  sessionId: string;
  signal?: AbortSignal;
  ancestorContext?: ContextPath;
}

export type ReviewVerdict = { pass: true } | { pass: false; feedback: string };

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
  | { action: 'abort' }
  | { action: 'revise'; revisedPlan: DagPlan };

export interface IReviewStrategy {
  readonly name: string;
  review(input: ReviewInput): Promise<ReviewVerdict>;
  /** Decide recovery for an execution failure (slice 4a). OPTIONAL — a reviewer
   *  that omits it cannot drive recovery (the strategy treats that as abort). */
  reviewExecutionFailure?(
    input: ExecutionFailureInput,
  ): Promise<ExecutionReviewDecision>;
}
