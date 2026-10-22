import { randomUUID } from 'node:crypto';
import type {
  DialogueState,
  IDialogueStateStore,
  Message,
  OnPartial,
  PlannerMessage,
  Result,
  TaskEvent,
} from '@mcp-abap-adt/llm-agent';
import { runInPlannerScope } from './planner-scope.js';
import { TaskBoard, type TaskBoardOptions } from './task-board.js';

export const DIALOGUE_HISTORY_LIMIT = 200;
export interface PlannerTurnOptions {
  sessionId?: string;
  onPartial?: OnPartial;
  signal?: AbortSignal;
  trace?: { traceId: string };
}
export interface PlannerAgent {
  process(
    input: Message[],
    opts: PlannerTurnOptions,
  ): Promise<Result<{ content: string }, Error>>;
}
export interface DialogueSessionOptions {
  id: string;
  planner: PlannerAgent;
  board: Omit<TaskBoardOptions, 'onEvent'>;
  store?: IDialogueStateStore;
  onMessage?: (message: PlannerMessage) => void;
  now?: () => number;
  logger?: { warn(message: string): void };
}
interface UserTurn {
  text: string;
  opts: Omit<PlannerTurnOptions, 'sessionId'>;
  resolve(message: PlannerMessage): void;
  reject(error: unknown): void;
}

export class DialogueSession {
  private readonly board: TaskBoard;
  private conversation: Message[] = [];
  private plan?: string;
  private pending: PlannerMessage[] = [];
  private readonly users: UserTurn[] = [];
  private events: TaskEvent[] = [];
  private restart?: string;
  private closing = false;
  private active?: Promise<void>;
  private closePromise?: Promise<void>;
  private savedAt = 0;

  private constructor(private readonly opts: DialogueSessionOptions) {
    this.board = new TaskBoard({
      ...opts.board,
      onEvent: (event) => {
        // Only outcomes wake the planner; a start is visible via list_tasks.
        if (this.closing || event.kind === 'started') return;
        this.events.push(event);
        this.schedule();
      },
    });
  }
  static async open(opts: DialogueSessionOptions): Promise<DialogueSession> {
    const session = new DialogueSession(opts);
    const state = await opts.store?.load(opts.id);
    if (state) {
      session.conversation = structuredClone(
        state.conversation.slice(-DIALOGUE_HISTORY_LIMIT),
      );
      session.plan = state.plan;
      session.pending = structuredClone(state.pending);
      session.savedAt = state.savedAt;
      const ids = session.board.restore(state.tasks);
      if (ids.length)
        session.restart = `[restart] interrupted tasks: ${ids.join(', ')} — their real state is unknown; check before continuing`;
    }
    return session;
  }
  send(
    text: string,
    opts: Omit<PlannerTurnOptions, 'sessionId'> = {},
  ): Promise<PlannerMessage> {
    if (this.closing)
      return Promise.reject(new Error('dialogue session closed'));
    return new Promise((resolve, reject) => {
      this.users.push({ text, opts, resolve, reject });
      this.schedule();
    });
  }
  private schedule(): void {
    if (this.active || this.closing) return;
    // Defer draining so synchronous task events are batched together.
    this.active = Promise.resolve()
      .then(() => this.drain())
      .finally(() => {
        this.active = undefined;
        if (!this.closing && (this.users.length || this.events.length))
          this.schedule();
      });
  }
  private async drain(): Promise<void> {
    while (!this.closing && (this.users.length || this.events.length)) {
      const user = this.users.shift();
      const events = user ? [] : this.events.splice(0);
      const text = user
        ? user.text
        : `[task events]\n${events.map(({ kind, task }) => `task ${task.id} (${task.worker}) ${kind}: ${task.goal} — ${task.error ?? task.output ?? ''}`).join('\n')}`;
      try {
        const message = await this.turn(text, user);
        user?.resolve(message);
      } catch (error) {
        user?.reject(error);
        if (!user) this.warn(`Dialogue event turn failed: ${String(error)}`);
      }
    }
  }
  private async turn(text: string, user?: UserTurn): Promise<PlannerMessage> {
    const input = this.restart ? `${this.restart}\n${text}` : text;
    this.restart = undefined;
    this.conversation.push({ role: 'user', content: input });
    this.trim();
    try {
      const result = await runInPlannerScope(
        {
          board: this.board,
          getPlan: () => this.plan,
          setPlan: (plan) => {
            this.plan = plan;
          },
          history: () => structuredClone(this.conversation),
        },
        () =>
          this.opts.planner.process(structuredClone(this.conversation), {
            ...user?.opts,
            sessionId: this.opts.id,
          }),
      );
      if (!result.ok) throw result.error;
      const message: PlannerMessage = {
        id: randomUUID(),
        text: result.value.content,
        createdAt: this.now(),
        trigger: user ? 'user' : 'event',
      };
      this.conversation.push({ role: 'assistant', content: message.text });
      this.trim();
      if (!user && !this.closing && message.text.trim() !== 'NO_MESSAGE') {
        this.pending.push(message);
        try {
          this.opts.onMessage?.({ ...message });
        } catch (error) {
          this.warn(`Dialogue onMessage failed: ${String(error)}`);
        }
      }
      return message;
    } finally {
      if (!this.closing) {
        this.savedAt = this.now();
        try {
          await this.opts.store?.save(this.opts.id, this.snapshot());
        } catch (error) {
          this.warn(`Dialogue state save failed: ${String(error)}`);
        }
      }
    }
  }
  private trim(): void {
    this.conversation = this.conversation.slice(-DIALOGUE_HISTORY_LIMIT);
  }
  private now(): number {
    return (this.opts.now ?? Date.now)();
  }
  private warn(message: string): void {
    try {
      this.opts.logger?.warn(message);
    } catch {
      /* Logging cannot break a turn. */
    }
  }
  takePending(): PlannerMessage[] {
    return structuredClone(this.pending.splice(0));
  }
  snapshot(): DialogueState {
    return structuredClone({
      conversation: this.conversation,
      plan: this.plan,
      tasks: this.board.list(),
      pending: this.pending,
      savedAt: this.savedAt,
    });
  }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.events = [];
    for (const user of this.users.splice(0))
      user.reject(new Error('dialogue session closed'));
    this.closePromise = this.finishClose();
    return this.closePromise;
  }
  private async finishClose(): Promise<void> {
    // Stop immediately, then stop again for tasks delegated by the settling turn.
    await Promise.all([this.board.stopAll(), this.active]);
    await this.board.stopAll();
    this.events = [];
    this.pending = [];
    await this.opts.store?.delete(this.opts.id);
  }
}
