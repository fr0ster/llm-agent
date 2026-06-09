import type { LlmUsage, StreamToolCall } from '@mcp-abap-adt/llm-agent';
import type { SmartServerLlmConfig } from '../smart-server.js';

export type SubagentResult =
  | { kind: 'content'; content: string; usage?: LlmUsage }
  | { kind: 'tool_call'; toolCalls: StreamToolCall[]; usage?: LlmUsage }
  | { kind: 'error'; error: string; usage?: LlmUsage };

export interface Step {
  name: string;
  instructions: string;
  type?: string;
}

export type NextStep =
  | { kind: 'next'; step: Step }
  | { kind: 'done'; result: string }
  | { kind: 'rewind'; reason: string };

export type PendingMarker =
  | {
      kind: 'external-tool';
      extId: string;
      toolName: string;
      args: unknown;
      position: string;
    }
  | {
      kind: 'clarify';
      question: string;
      position: string;
      /** For goal-confirmation clarifies: the target the evaluator proposed, so
       *  a plain confirmation ("yes") commits IT rather than the literal answer. */
      proposedTarget?: string;
    };

export interface SessionBundle {
  goal: string;
  plannerPrivate: string;
  budgets: { stepsUsed: number; rewindsUsed: number };
  plan?: Step[];
  planCursor?: number;
  pending?: PendingMarker;
  /** Outcome of the last executed step, persisted so a resume after a FAILED step
   *  makes the adaptive planner replan (rather than repeat the step). Set by
   *  runStep.settle() together with the step result + cursor advance. */
  lastOutcome?: 'advanced' | 'failed';
}

/** A controller subagent role: a standalone LLM config plus an OPTIONAL
 *  per-role `hint`. The hint is appended to that role's system prompt and gives
 *  the role extra OPERATIONAL guidance about running within the pipeline — how
 *  to build the plan, how to execute a step, what to be strict about. Its main
 *  purpose is to scaffold WEAKER models: a capable model (Opus / Sonnet) usually
 *  needs none, while a smaller executor/planner model (e.g. gpt-4o-mini) may
 *  need the extra steering. It is NOT a domain description and must NOT prescribe
 *  tool names (the self-describing tool catalog + the agnostic engine prompt
 *  cover those; richer per-situation procedures belong to the skills RAG).
 *  Absent hint → the role runs on the bare agnostic prompt. */
export type ControllerSubagentConfig = SmartServerLlmConfig & { hint?: string };

export interface ControllerConfig {
  subagents: {
    evaluator: ControllerSubagentConfig;
    planner: ControllerSubagentConfig;
    executor: ControllerSubagentConfig;
  };
  targetState: {
    strategy: 'consumer-confirm' | 'semantic-distance' | 'auto';
    distanceThreshold: number;
  };
  sessionMemory: { collection: string };
  planner?: 'incremental' | 'adaptive';
  budgets: {
    maxSteps: number;
    maxRetries: number;
    maxRewinds: number;
    maxToolCalls?: number;
  };
}

export type PlannerKind = 'incremental' | 'adaptive';

export interface PlannerNextInput {
  bundle: SessionBundle;
  prompt: string;
  /** Outcome of the step run since the previous `next()` (undefined on the first
   *  call / after a rewind / on resume). The adaptive planner replans on 'failed';
   *  the incremental planner ignores it. Cursor advance on 'advanced' happens in
   *  commit(), not here. */
  lastOutcome?: 'advanced' | 'failed';
  /** True when re-asking after an unparsable reply (stern format reminder). */
  retrying: boolean;
  /** True on the first call of a turn that just resumed an EXTERNAL-tool result
   *  (the result is now in `bundle.plannerPrivate`). The adaptive planner replans
   *  from the cursor so it incorporates the result via the planner — which reads
   *  plannerPrivate — instead of blindly re-running the suspended step (the
   *  executor prompt does NOT include plannerPrivate). Incremental ignores it. */
  resumedExternal?: boolean;
  logUsage?: (role: string, u?: LlmUsage) => void;
}

export interface IControllerPlanner {
  next(input: PlannerNextInput): Promise<NextStep | null>;
  /** Optional: record a just-finished step's outcome so the planner's durable
   *  bookkeeping (e.g. the adaptive cursor) is updated and can be persisted in the
   *  SAME write that follows. Incremental does not implement it (no-op). */
  commit?(bundle: SessionBundle, outcome: 'advanced' | 'failed'): void;
}
