import type { Message } from '../types.js';
import type { ITaskSpec } from './task-spec.js';
import type { LlmUsage } from './types.js';

/** The action performed by an adaptive plan step. */
export type AdaptiveStepKind = 'work' | 'check' | 'ask' | 'revise' | 'answer';
/** A step id or the reserved targets 'next' and 'end'. */
export type BranchTarget = string;
/** Context selected by the controller for a worker. */
export interface StepContextSpec {
  spec?: boolean;
  history?: 'none' | 'last-turn' | 'all';
  results?: string[];
  note?: string;
}
/** Work dispatched to a named worker. */
export interface WorkStep {
  id: string;
  kind: 'work';
  goal: string;
  worker: string;
  context?: StepContextSpec;
  maxRuns?: number;
}
/** A verdict that selects the next branch. */
export interface CheckStep {
  id: string;
  kind: 'check';
  goal: string;
  worker: string;
  targets: string[];
  context?: StepContextSpec;
  onPass: BranchTarget;
  onFail: BranchTarget;
  onPartial?: BranchTarget;
  maxRuns?: number;
}
/** A question that ends the current turn. */
export interface AskStep {
  id: string;
  kind: 'ask';
  question: string;
}
/** A request to replace the remaining plan. */
export interface ReviseStep {
  id: string;
  kind: 'revise';
  reason: string;
  maxRuns?: number;
}
/** An answer from a prior result or literal text. */
export interface AnswerStep {
  id: string;
  kind: 'answer';
  from?: string;
  text?: string;
}
/** All supported adaptive plan steps. */
export type AdaptiveStep =
  | WorkStep
  | CheckStep
  | AskStep
  | ReviseStep
  | AnswerStep;
/** A controller-generated plan for one request. */
export interface AdaptivePlan {
  spec?: ITaskSpec;
  steps: AdaptiveStep[];
  createdAt: number;
}
/** The outcome and explanation of a check. */
export interface Verdict {
  verdict: 'pass' | 'fail' | 'partial';
  reason: string;
}
/** One execution of a step. */
export interface StepRecord {
  stepId: string;
  kind: AdaptiveStepKind;
  run: number;
  status: 'done' | 'failed';
  output: string;
  verdict?: Verdict;
  error?: string;
  durationMs: number;
}
/** The terminal state of a plan run. */
export type RunOutcome = 'answered' | 'asked' | 'stopped' | 'awaiting-external';
/** A persisted plan and its execution results. */
export interface RunRecord {
  runId: string;
  request: string;
  plan: AdaptivePlan;
  steps: StepRecord[];
  outcome: RunOutcome;
  stopReason?: string;
  finishedAt: number;
}
/** Storage for the latest run of a session. */
export interface IRunRecordStore {
  load(sessionId: string): Promise<RunRecord | undefined>;
  save(sessionId: string, record: RunRecord): Promise<void>;
}
/** Limits applied to one plan run. */
export interface AdaptiveBudget {
  maxSteps: number;
  maxRevisions: number;
  maxDurationMs: number;
}
/** A progress event emitted by an adaptive step. */
export interface StepStatus {
  stepId: string;
  kind: AdaptiveStepKind;
  state: 'started' | 'done' | 'failed';
  goal?: string;
  verdict?: Verdict['verdict'];
}
/** Context available to the controller when planning. */
export interface ControllerPlanInput {
  request: string;
  history: Message[];
  workers: { name: string; description?: string }[];
  previousRun?: RunRecord;
  signal?: AbortSignal;
}
/** Plans, checks, revises, and reports on adaptive execution. */
export interface IAdaptiveController {
  readonly name: string;
  readonly model?: string;
  plan(
    input: ControllerPlanInput,
  ): Promise<{ plan: AdaptivePlan; usage?: LlmUsage }>;
  check(input: {
    request: string;
    spec?: ITaskSpec;
    step: CheckStep;
    targets: StepRecord[];
    task?: string;
    history?: Message[];
    signal?: AbortSignal;
  }): Promise<{ verdict: Verdict; usage?: LlmUsage }>;
  revise(input: {
    request: string;
    plan: AdaptivePlan;
    records: StepRecord[];
    reason: string;
    signal?: AbortSignal;
  }): Promise<{ steps: AdaptiveStep[]; usage?: LlmUsage }>;
  report(input: {
    request: string;
    plan: AdaptivePlan;
    records: StepRecord[];
    stopReason: string;
    signal?: AbortSignal;
  }): Promise<{ text: string; usage?: LlmUsage }>;
}
