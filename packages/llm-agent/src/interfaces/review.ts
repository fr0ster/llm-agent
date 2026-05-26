import type { DagPlan } from './dag-plan.js';
import type { PlannerCatalogEntry } from './planner.js';

export interface ReviewInput {
  prompt: string;
  plan: DagPlan;
  agents: PlannerCatalogEntry[];
  sessionId: string;
  signal?: AbortSignal;
}

export type ReviewVerdict = { pass: true } | { pass: false; feedback: string };

export interface IReviewStrategy {
  readonly name: string;
  review(input: ReviewInput): Promise<ReviewVerdict>;
}
