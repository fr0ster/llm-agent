import type { Message } from '../types.js';
import type { TokenUsage } from './types.js';

export type TaskState =
  | 'queued'
  | 'running'
  | 'done'
  | 'failed'
  | 'stopped'
  | 'interrupted';
export interface TaskRequest {
  worker: string;
  goal: string;
  context?: string;
  history?: Message[];
}
export interface TaskRecord {
  usage?: TokenUsage;
  id: string;
  worker: string;
  goal: string;
  state: TaskState;
  budgetExhausted?: boolean;
  toolCalls?: number;
  maxToolCalls?: number;
  output?: string;
  error?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
}
export interface TaskEvent {
  kind: 'started' | 'done' | 'failed' | 'stopped';
  task: TaskRecord;
}
export interface IConcurrencyPool {
  acquire(signal?: AbortSignal): Promise<() => void>;
}
export interface PlannerMessageUsage {
  planner?: TokenUsage;
  tasks?: Array<{ id: string; worker: string; usage: TokenUsage }>;
}
export interface PlannerMessage {
  usage?: PlannerMessageUsage;
  id: string;
  text: string;
  createdAt: number;
  trigger: 'user' | 'event';
}
export interface PlanStep {
  id: string;
  goal: string;
  items?: string[];
  dependsOn?: string[];
  worker?: string;
  state:
    | 'pending'
    | 'running'
    | 'checking'
    | 'done'
    | 'failed'
    | 'skipped'
    | 'blocked';
  check?: {
    by: 'planner' | 'checker';
    goal: string;
    verdict?: 'pass' | 'fail';
    taskId?: string;
  };
  /** Current work attempt, tracked separately from check.taskId. */
  workTaskId?: string;
  /** Current work task observed completing successfully; absent for budget-failed items. */
  successfulWorkTaskId?: string;
  taskIds: string[];
  note?: string;
}
export interface Plan {
  /** One update may use consent after a user answers a waiting_user question. */
  scopeConsent?: boolean;
  version: 1;
  steps: PlanStep[];
  status: 'active' | 'waiting_user' | 'done';
  question?: string;
  /** Transitional free-text plan; not an executable step. */
  note?: string;
}
export interface DialogueState {
  conversation: Message[];
  plan?: string | Plan;
  planStatus?: 'active' | 'waiting_user' | 'done';
  tasks: TaskRecord[];
  /** Task ID to owning step ID, including steps removed from the plan. */
  taskSteps?: Record<string, string>;
  pending: PlannerMessage[];
  savedAt: number;
}
export interface IDialogueStateStore {
  load(id: string): Promise<DialogueState | undefined>;
  save(id: string, s: DialogueState): Promise<void>;
  delete(id: string): Promise<void>;
}
