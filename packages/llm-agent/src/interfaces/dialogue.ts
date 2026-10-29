import type { Message } from '../types.js';
import type { IQueryEmbedding } from './query-embedding.js';
import type { CallOptions, TokenUsage } from './types.js';

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
}
export interface TaskRecord {
  usage?: TokenUsage;
  id: string;
  worker: string;
  goal: string;
  state: TaskState;
  budgetExhausted?: boolean;
  toolCalls?: number;
  /** Tool definitions offered in the latest LLM round. */
  toolsSelected?: number;
  /** Available MCP and external tools before selection/filters. */
  toolsAvailable?: number;
  maxToolCalls?: number;
  output?: string;
  error?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
}
export interface TaskEvent {
  kind: 'started' | 'done' | 'failed' | 'stopped' | 'long_running';
  task: TaskRecord;
}
export interface IConcurrencyPool {
  acquire(signal?: AbortSignal): Promise<() => void>;
}
export interface PlannerMessageUsage {
  planner?: TokenUsage;
  /**
   * Wall-clock time of the planner turn that produced this message, ms, measured
   * with the session clock from turn start to message creation. Includes
   * corrective planner calls in the same turn; excludes time waiting in the
   * session queue. Present only when the message has token usage.
   */
  plannerMs?: number;
  tasks?: Array<{
    id: string;
    worker: string;
    usage: TokenUsage;
    /** finishedAt - startedAt of the task, ms, clamped at 0; absent when either timestamp is missing. */
    durationMs?: number;
  }>;
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
  requests?: PlannerRequestRecord[];
  requestSeq?: number;
  conversation: Message[];
  plan?: string | Plan;
  planStatus?: 'active' | 'waiting_user' | 'done';
  tasks: TaskRecord[];
  /** Task ID to owning step ID, including steps removed from the plan. */
  taskSteps?: Record<string, string>;
  /** Persisted task ownership, including closed requests. */
  taskRequests?: Record<string, string>;
  pending: PlannerMessage[];
  savedAt: number;
}
export interface IDialogueStateStore {
  load(id: string): Promise<DialogueState | undefined>;
  save(id: string, s: DialogueState): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface PlannerRequestRecord {
  id: string;
  openedAt: number;
  closedAt?: number;
  text: string;
  plan?: {
    status: 'active' | 'waiting_user' | 'done';
    steps: number;
    done: number;
    failed: number;
    skipped: number;
  };
  lastTurnOk?: boolean;
  /** Present only while the request is open. */
  transcript?: Message[];
  legacy?: true;
}
export interface PlannerMemoryEntry {
  kind: 'planner-input' | 'planner-reply' | 'planner-task' | 'planner-plan';
  requestId: string;
  sourceId: string;
  offset: number;
  text: string;
}
export interface PlannerKnowledgeEntry {
  collection: string;
  id: string;
  text: string;
}
/** Read-only planning knowledge collection. */
export interface IPlannerKnowledge {
  readonly name: string;
  readonly embeddingKey?: string;
  search(
    query: { text: string; embedding?: IQueryEmbedding },
    k: number,
    options?: CallOptions,
  ): Promise<PlannerKnowledgeEntry[]>;
}
export interface PlannerContextInput {
  memoryCharBudget?: number;
  knowledgeCharBudget?: number;
  open?: PlannerRequestRecord;
  memory: readonly PlannerMemoryEntry[];
  knowledge: readonly PlannerKnowledgeEntry[];
  notes: string[];
}
export interface IPlannerContextBuilder {
  build(input: PlannerContextInput): Message[];
}
