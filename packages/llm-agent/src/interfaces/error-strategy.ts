import type { DagPlan, PlanNode } from './dag-plan.js';
import type { PlannerCatalogEntry } from './planner.js';
import type { IUsageRecorder } from './usage.js';

export interface ErrorContext {
  /** The composed task the failed node was given. */
  task: string;
  /** Replans/revises still allowed this run (the interpreter owns the counter). */
  remainingReplans: number;
  agents: PlannerCatalogEntry[];
  sessionId: string;
  usage?: IUsageRecorder;
  signal?: AbortSignal;
}

export type ErrorReaction =
  | { action: 'abort' }
  | { action: 'replan'; subPlan: DagPlan }; // slice 3: local splice

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
