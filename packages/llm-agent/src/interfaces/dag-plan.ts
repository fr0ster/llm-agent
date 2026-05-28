import type { LlmUsage } from './types.js';

export interface PlanNode {
  id: string;
  goal: string;
  agent?: string;
  dependsOn?: string[];
  needsInput?: boolean;
}

export interface DagPlan {
  nodes: PlanNode[];
  objective?: string;
  rationale?: string;
  createdAt: number;
  /** Optional: token usage consumed by the LLM-backed planner that produced
   *  this plan. Populated by LLM-backed planners (e.g. LlmDagPlanner) so the
   *  coordinator can attribute planner overhead to the session/request logger.
   *  Non-LLM planners omit it. */
  usage?: LlmUsage;
}
