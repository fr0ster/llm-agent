import type { DagPlan, PlanNode } from './dag-plan.js';
import type { PlannerCatalogEntry } from './planner.js';

export interface ErrorContext {
  /** The composed task the failed node was given (goal + dep outputs + user
   *  input) — so a replan re-plans with full context, not the bare goal. */
  task: string;
  /** Replans still allowed this run (maxReplans - replansUsed), set by the
   *  interpreter. A replan-capable strategy MUST return `{ action: 'abort' }`
   *  with no planner/LLM call when this is <= 0. */
  remainingReplans: number;
  agents: PlannerCatalogEntry[];
  sessionId: string;
  signal?: AbortSignal;
}

export type ErrorReaction =
  | { action: 'abort' }
  | { action: 'replan'; subPlan: DagPlan };

export interface IErrorStrategy {
  readonly name: string;
  /** Replan budget ceiling for an interpret run; the interpreter owns the
   *  counter and reads this once. Omitted → interpreter default ceiling (4). */
  readonly maxReplans?: number;
  onNodeFailure(
    node: PlanNode,
    error: unknown,
    ctx: ErrorContext,
  ): Promise<ErrorReaction>;
}
