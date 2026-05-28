import type { ContextPath } from './context-path.js';
import type { DagPlan } from './dag-plan.js';

export interface PlannerCatalogEntry {
  name: string;
  description?: string;
}

export interface PlannerInput {
  prompt: string;
  agents: PlannerCatalogEntry[];
  sessionId: string;
  signal?: AbortSignal;
  ancestorContext?: ContextPath;
  reviewerFeedback?: string;
}

export interface IPlanner {
  readonly name: string;
  /** Optional model identifier (best-effort), surfaced to the coordinator so
   *  per-role LLM usage can be attributed to a specific model in the request
   *  logger. Non-LLM planners may omit it. */
  readonly model?: string;
  plan(input: PlannerInput): Promise<DagPlan>;
}
