import type { TaskRecord, TaskState } from './dialogue.js';

export const DIALOGUE_SIGNALS_VERSION = 1;
export interface DialogueSignals {
  /**
   * Additive catalog v1 signal. Successful task output; key = runId and source
   * = dialogue session id. Workers read retained state before each LLM call,
   * including the first. Only the current context's unique runId is accepted,
   * excluding retained and late finishes from previous runs. Per-run retention
   * prevents late old emissions from overwriting the current finish. The final
   * check follows synchronous activity and tools-selected callbacks; an already
   * started LLM call is not interrupted. No bus, noopEmitter,
   * or a foreign emitter without last() keeps the ordinary extra LLM call.
   */
  'dialogue.task.finish': {
    taskId: string;
    runId: string;
    output: string;
    tool?: string;
  };
  /** Additive catalog v1 signal; ticks do not call the planner. */
  'dialogue.wait': {
    tasks: Array<{
      id: string;
      worker: string;
      goal: string;
      state: 'queued' | 'running';
      elapsedMs: number;
      toolCalls?: number;
      /** Tool definitions offered in the latest LLM round. */
      toolsSelected?: number;
      /** Available MCP and external tools before selection/filters. */
      toolsAvailable?: number;
      maxToolCalls?: number;
    }>;
  };
  'dialogue.turn.started': { trigger: 'user' | 'event' };
  'dialogue.turn.settled': {
    trigger: 'user' | 'event';
    outcome: 'ok' | 'failed';
    messageId?: string;
    status?: 'active' | 'waiting_user' | 'done';
  };
  'dialogue.task.state': { task: TaskRecord; previous?: TaskState };
  'dialogue.activity': {
    turnActive: boolean;
    queuedInputs: number;
    running: number;
    ready: number;
  };
  'dialogue.plan.changed': {
    status: 'active' | 'waiting_user' | 'done';
    total: number;
    done: number;
  };
  'dialogue.session.closed': { reason?: string };
}
