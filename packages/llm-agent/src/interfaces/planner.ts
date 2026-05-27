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
  plan(input: PlannerInput): Promise<DagPlan>;
}
