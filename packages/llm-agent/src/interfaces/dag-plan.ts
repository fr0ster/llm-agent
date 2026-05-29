export interface PlanNode {
  id: string;
  goal: string;
  agent?: string;
  dependsOn?: string[];
  needsInput?: boolean;
}

/** Pure domain type: the DAG of work to execute. Runtime telemetry (e.g.
 *  per-role LLM usage) is intentionally NOT here — it would leak into
 *  downstream consumers (notably the reviewer prompt, which serializes the
 *  plan with JSON.stringify). LLM-backed planners return `{plan, usage}`
 *  from `IPlanner.plan`; see planner.ts. */
export interface DagPlan {
  nodes: PlanNode[];
  objective?: string;
  rationale?: string;
  createdAt: number;
}
