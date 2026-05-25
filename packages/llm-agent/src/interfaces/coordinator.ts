import type { ILlm } from './llm.js';
import type { ISkillMeta } from './skill.js';
import type {
  ISubAgent,
  ISubAgentResult,
  SubAgentRegistry,
} from './subagent.js';
import type { LlmUsage } from './types.js';

export interface PlanStep {
  id: string;
  goal: string;
  agent?: string;
  inputTemplate?: string;
  /**
   * When true, the Coordinator embeds the client request (`ctx.inputText`)
   * verbatim as delimited data inside the composed `task`. Default false —
   * no material is forwarded unless the planner asks for it.
   */
  needsInput?: boolean;
  expectedTools?: string[];
  status: 'pending' | 'in_progress' | 'done' | 'failed';
}

export interface Plan {
  steps: PlanStep[];
  /**
   * Shared objective for the whole plan ("why"), authored once by the planner.
   * Forwarded into every dispatched step's `task` so subagents act as a team.
   */
  objective?: string;
  /**
   * Set by the initial planner when it cannot form an unambiguous plan. When
   * present, the Coordinator streams it to the consumer and dispatches nothing.
   */
  clarification?: string;
  rationale?: string;
  createdAt: number;
  source: 'planner-llm' | 'skill-steps' | 'manual';
}

/**
 * Trace frame for nested-dispatch failures. The parent appends its own
 * frame and passes the result upward without other transformation.
 */
export interface EpicFailTrace {
  layer: number;
  stepId: string;
  agentName: string;
  attempts: Array<{
    kind: 'transient' | 'replan' | 'hint';
    error: string;
    durationMs: number;
  }>;
  originalError: string;
  childTrace?: EpicFailTrace;
}

export interface StepResult {
  stepId: string;
  output: string;
  toolCalls?: ISubAgentResult['toolCalls'];
  usage?: LlmUsage;
  durationMs: number;
  ok: boolean;
  error?: string;
  /**
   * Populated when a child subagent returned `errorClass: 'epicfail'`.
   * Carries the diagnostic trace upward unchanged so consumers see the
   * full chain instead of a flattened error string.
   */
  epicFailTrace?: EpicFailTrace;
}

export interface ICoordinatorContext {
  inputText: string;
  systemPrompt?: string;
  skillContent?: string;
  /**
   * Metadata of the first active skill that declares structured `steps:` in
   * its frontmatter. Populated by CoordinatorHandler from `ctx.selectedSkills`.
   * Consumed by SkillStepsPlanning to derive the plan from the skill itself
   * instead of asking a planner LLM.
   */
  activeSkillMeta?: ISkillMeta;
  registry: SubAgentRegistry;
  plan?: Plan;
  stepResults: Record<string, StepResult>;
  signal?: AbortSignal;
  sessionId: string;
  /**
   * Dispatch depth of the current coordinator. Root coordinator is 0; child
   * subagent coordinators increment per nested dispatch. Forward-declared for
   * Task 4 of the nested-subagent-dispatch foundation plan.
   */
  layer?: number;
}

export interface IPlanningStrategy {
  readonly name: string;
  buildInitialPlan(ctx: ICoordinatorContext): Promise<Plan>;
  shouldReplan(ctx: ICoordinatorContext, lastResult: StepResult): boolean;
  rebuildPlan(ctx: ICoordinatorContext, remaining: PlanStep[]): Promise<Plan>;
}

export interface IDispatchStrategy {
  readonly name: string;
  dispatch(step: PlanStep, ctx: ICoordinatorContext): Promise<StepResult>;
}

export interface IActivationStrategy {
  readonly name: string;
  shouldActivate(ctx: {
    hasSubAgents: boolean;
    hasStructuredSkill: boolean;
  }): boolean;
}

export interface ICoordinatorConfig {
  planning?: IPlanningStrategy;
  dispatch?: IDispatchStrategy;
  activation?: IActivationStrategy;
  plannerLlm?: ILlm;
  maxSteps?: number;
  maxRetriesPerStep?: number;
  failPolicy?: 'abort' | 'continue';
  /**
   * Maximum dispatch depth from this coordinator. Default 1: the
   * coordinator may dispatch children (layer 1), but those children
   * may not dispatch further unless they raise maxLayer themselves.
   */
  maxLayer?: number;
}

export type SubAgentWithDescription = ISubAgent & { description: string };
