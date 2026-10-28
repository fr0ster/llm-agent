import type { TaskRecord, TaskState } from './dialogue.js';

export const DIALOGUE_SIGNALS_VERSION = 1;
export interface DialogueSignals {
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
