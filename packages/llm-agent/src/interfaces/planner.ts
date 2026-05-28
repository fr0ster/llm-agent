import type { ContextPath } from './context-path.js';
import type { DagPlan } from './dag-plan.js';
import type { LlmUsage } from './types.js';

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

/** Wrapper returned by `IPlanner.plan`. Splits the pure domain plan from the
 *  optional runtime telemetry, so the plan itself stays free of LLM-overhead
 *  metadata that would otherwise leak into prompts (the reviewer serializes
 *  `input.plan` via JSON.stringify into the critic prompt) or into
 *  persistence. Non-LLM planners may omit `usage`. */
export interface PlannerResult {
  plan: DagPlan;
  usage?: LlmUsage;
}

export interface IPlanner {
  readonly name: string;
  /** Optional model identifier (best-effort), surfaced to the coordinator so
   *  per-role LLM usage can be attributed to a specific model in the request
   *  logger. Non-LLM planners may omit it. */
  readonly model?: string;
  plan(input: PlannerInput): Promise<PlannerResult>;
}
