import { randomUUID } from 'node:crypto';
import type {
  DialogueState,
  IDialogueStateStore,
  Message,
  OnPartial,
  PlannerMessage,
  Result,
  StreamChunk,
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
  /** Maximum corrective turns; zero disables end-of-turn checks. Default: 2. */
  maxCorrections?: number;
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
  private planStatus?: DialogueState['planStatus'];
  private pending: PlannerMessage[] = [];
  private readonly users: UserTurn[] = [];
  private events: TaskEvent[] = [];
  private restart?: string;
  private closing = false;
  private active?: Promise<void>;
  private closePromise?: Promise<void>;
  private savedAt = 0;
  private persistence: Promise<void> = Promise.resolve();

  private constructor(private readonly opts: DialogueSessionOptions) {
    if (
      !Number.isInteger(opts.maxCorrections ?? 2) ||
      (opts.maxCorrections ?? 2) < 0
    )
      throw new Error('maxCorrections must be a non-negative integer');
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
      session.conversation = session.conversation.reduce<Message[]>(
        (messages, message) => {
          const last = messages.at(-1);
          if (last?.role === message.role)
            last.content = `${last.content}\n${message.content}`;
          else messages.push(message);
          return messages;
        },
        [],
      );
      session.trim();
      session.plan = state.plan;
      session.planStatus =
        state.planStatus ?? (state.plan !== undefined ? 'active' : undefined);
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
      const text = user ? user.text : this.eventNotes(events);
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
    this.appendInput(input);
    this.trim();
    try {
      let reply = '';
      const actions: string[] = [];
      let started = false;
      for (let correction = 0; ; correction++) {
        const messages = structuredClone(this.conversation);
        const tasks = this.board.list();
        const notes = [];
        if (this.plan !== undefined)
          notes.push(`[plan]\n${this.plan}\nstatus: ${this.planStatus}`);
        notes.push(
          `[tasks]\n${
            tasks.length
              ? tasks
                  .slice(-30)
                  .map(
                    ({ id, worker, state, goal }) =>
                      `${id} (${worker}) ${state}: ${goal.replace(/\s+/g, ' ').slice(0, 80)}`,
                  )
                  .join('\n')
              : 'none'
          }${tasks.length > 30 ? `\n(${tasks.length - 30} older tasks omitted)` : ''}`,
        );
        const last = messages.at(-1);
        if (last) last.content = `${notes.join('\n')}\n${last.content}`;
        const contentPartials: StreamChunk[] = [];
        const result = await runInPlannerScope(
          {
            board: this.board,
            getPlan: () => this.plan,
            setPlan: (plan, status = 'active') => {
              this.plan = plan;
              this.planStatus = status;
            },
            recordAction: (action, didStart) => {
              actions.push(action);
              started ||= didStart === true;
            },
            history: () => structuredClone(this.conversation),
          },
          () =>
            this.opts.planner.process(messages, {
              ...user?.opts,
              sessionId: this.opts.id,
              onPartial: user?.opts.onPartial
                ? (chunk) => {
                    if (chunk.kind === 'content') contentPartials.push(chunk);
                    else user.opts.onPartial?.(chunk);
                  }
                : undefined,
            }),
        );
        if (!result.ok) throw result.error;
        reply = result.value.content;
        this.conversation.push({ role: 'assistant', content: reply });
        this.conversation.push({
          role: 'user',
          content: `[actions] ${actions.join(', ') || 'none'}`,
        });
        this.trim();
        const idle =
          !user &&
          this.plan !== undefined &&
          this.planStatus === 'active' &&
          !started &&
          this.events.length === 0 &&
          !this.board
            .list()
            .some(
              (task) => task.state === 'queued' || task.state === 'running',
            );
        const needsEvents =
          !user &&
          this.plan !== undefined &&
          this.planStatus === 'active' &&
          !started &&
          this.events.length > 0 &&
          !this.board
            .list()
            .some(
              (task) => task.state === 'queued' || task.state === 'running',
            );
        const enabled = (this.opts.maxCorrections ?? 2) > 0 && !this.closing;
        if (
          !enabled ||
          (!idle && !needsEvents) ||
          correction >= (this.opts.maxCorrections ?? 2)
        ) {
          if (enabled && (idle || needsEvents))
            this.warn(
              'Dialogue correction limit reached: idle or pending events',
            );
          for (const chunk of contentPartials) user?.opts.onPartial?.(chunk);
          break;
        }
        const events = this.events.splice(0);
        this.appendInput(
          '[check] Nothing is running or new task events need review. Delegate the next ready step, or set status waiting_user / done with update_plan.' +
            (events.length ? `\n${this.eventNotes(events)}` : ''),
        );
      }
      const message: PlannerMessage = {
        id: randomUUID(),
        text: reply,
        createdAt: this.now(),
        trigger: user ? 'user' : 'event',
      };
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
      if (!this.closing) await this.persist();
    }
  }
  private eventNotes(events: TaskEvent[]): string {
    return `[task events]\n${events.map(({ kind, task }) => `task ${task.id} (${task.worker}) ${kind}: ${task.goal} — ${task.error ?? task.output ?? ''}`).join('\n')}`;
  }
  private persist(): Promise<void> {
    // Acknowledgements must follow any save that still contains pending replies.
    this.persistence = this.persistence.then(async () => {
      if (!this.closing) {
        this.savedAt = this.now();
        try {
          await this.opts.store?.save(this.opts.id, this.snapshot());
        } catch (error) {
          this.warn(`Dialogue state save failed: ${String(error)}`);
        }
      }
    });
    return this.persistence;
  }
  private appendInput(text: string): void {
    const last = this.conversation.at(-1);
    // Hub notes occupy the next user slot; merge input to preserve role alternation.
    if (last?.role === 'user') last.content = `${last.content}\n${text}`;
    else this.conversation.push({ role: 'user', content: text });
    this.trim();
  }
  private trim(): void {
    // Remove complete reply/note pairs, never leave an orphaned actions note.
    while (this.conversation.length > DIALOGUE_HISTORY_LIMIT)
      this.conversation.splice(0, 2);
    if (this.conversation[0]?.role === 'assistant') this.conversation.shift();
    const first = this.conversation[0];
    if (first && String(first.content).startsWith('[actions]')) {
      const content = String(first.content);
      const newline = content.indexOf('\n');
      if (newline < 0) this.conversation.shift();
      else first.content = content.slice(newline + 1);
    }
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
    const pending = structuredClone(this.pending.splice(0));
    void this.persist();
    return pending;
  }
  snapshot(): DialogueState {
    return structuredClone({
      conversation: this.conversation,
      plan: this.plan,
      planStatus: this.planStatus,
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
    await this.persistence;
    await this.opts.store?.delete(this.opts.id);
  }
}
