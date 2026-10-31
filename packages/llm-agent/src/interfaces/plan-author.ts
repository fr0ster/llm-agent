import type { Plan as DialoguePlan } from './dialogue.js';
import type { CallOptions, Result } from './types.js';

export interface PlanBrief {
  goal: string;
  context?: string;
  references?: string[];
}
export interface PlanRevisionInput {
  plan: DialoguePlan;
  change: string;
  brief?: PlanBrief;
}
export interface PlanAuthorError {
  code: 'invalid' | 'unavailable' | 'aborted';
  message: string;
}
export interface IPlanAuthor {
  create(
    brief: PlanBrief,
    options?: CallOptions,
  ): Promise<Result<DialoguePlan, PlanAuthorError>>;
  revise(
    input: PlanRevisionInput,
    options?: CallOptions,
  ): Promise<Result<DialoguePlan, PlanAuthorError>>;
}
