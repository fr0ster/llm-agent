import type { DagPlan, PlanNode } from './dag-plan.js';
import type { NodeResult } from './interpreter.js';
import type { PlannerCatalogEntry } from './planner.js';

export interface ErrorContext {
  /** The composed task the failed node was given. */
  task: string;
  /** Replans/revises still allowed this run (the interpreter owns the counter). */
  remainingReplans: number;
  agents: PlannerCatalogEntry[];
  sessionId: string;
  signal?: AbortSignal;
  /** NEW (4a), OPTIONAL — the current plan and completed results, so a
   *  reviewer-driven strategy can replan the remainder against current state.
   *  Optional so external literals don't break; the interpreter always sets them. */
  plan?: DagPlan;
  completedResults?: NodeResult[];
}

export type ErrorReaction =
  | { action: 'abort' }
  | { action: 'replan'; subPlan: DagPlan } // slice 3: local splice
  | { action: 'revise'; revisedPlan: DagPlan }; // slice 4a: whole-remainder swap

export interface IErrorStrategy {
  readonly name: string;
  /** Per-run budget ceiling (replan AND revise consume it). Default 4. */
  readonly maxReplans?: number;
  onNodeFailure(
    node: PlanNode,
    error: unknown,
    ctx: ErrorContext,
  ): Promise<ErrorReaction>;
}
