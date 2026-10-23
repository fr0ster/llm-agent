import type { Message } from '../types.js';

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
  id: string;
  worker: string;
  goal: string;
  state: TaskState;
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
export interface PlannerMessage {
  id: string;
  text: string;
  createdAt: number;
  trigger: 'user' | 'event';
}
export interface PlanStep {
  id: string;
  goal: string;
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
  taskIds: string[];
  note?: string;
}
export interface Plan {
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
  pending: PlannerMessage[];
  savedAt: number;
}
export interface IDialogueStateStore {
  load(id: string): Promise<DialogueState | undefined>;
  save(id: string, s: DialogueState): Promise<void>;
  delete(id: string): Promise<void>;
}
