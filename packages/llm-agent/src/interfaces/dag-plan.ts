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
}
