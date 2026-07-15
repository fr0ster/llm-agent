import type { CallOptions } from './types.js';

export interface IStepExecutionControl {
  beginStep(ctx: StepControlContext): IStepBudget;
}
export interface StepControlContext {
  readonly stepName: string;
  readonly seq: number;
  readonly attempt: number;
  readonly budgets: StepBudgetsView;
  readonly options?: CallOptions;
}
export interface StepBudgetsView {
  readonly maxToolCalls?: number;
  readonly perStepTimeoutMs?: number;
}
export interface IStepBudget {
  readonly signal: AbortSignal;
  shouldContinueRound(state: StepRoundState): StepControlDecision;
  canExecuteTool(state: StepRoundState): StepControlDecision;
  dispose(): void;
}
export interface StepRoundState {
  readonly round: number;
  readonly toolCallCount: number;
  readonly elapsedMs: number;
}
export type StepControlDecision =
  | { continue: true }
  | { continue: false; reason: string };

export interface IRunExecutionControl {
  beginRun(ctx: RunControlContext): IRunBudget;
}
export interface RunControlContext {
  readonly runId: string;
  readonly options?: CallOptions;
}
export interface IRunBudget {
  readonly signal: AbortSignal;
  shouldContinue(state: RunState): StepControlDecision;
  dispose(): void;
}
export interface RunState {
  readonly stepsUsed: number;
  readonly elapsedMs: number;
}
