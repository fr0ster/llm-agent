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
  expectedTools?: string[];
  status: 'pending' | 'in_progress' | 'done' | 'failed';
}

export interface Plan {
  steps: PlanStep[];
  rationale?: string;
  createdAt: number;
  source: 'planner-llm' | 'skill-steps' | 'manual';
}

export interface StepResult {
  stepId: string;
  output: string;
  toolCalls?: ISubAgentResult['toolCalls'];
  usage?: LlmUsage;
  durationMs: number;
  ok: boolean;
  error?: string;
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
}

export type SubAgentWithDescription = ISubAgent & { description: string };
