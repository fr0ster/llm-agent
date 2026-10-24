import { randomUUID } from 'node:crypto';
import type {
  DialogueState,
  IDialogueStateStore,
  Message,
  OnPartial,
  DialoguePlan as Plan,
  PlannerMessage,
  Result,
  StreamChunk,
  TaskEvent,
} from '@mcp-abap-adt/llm-agent';
import { runInPlannerScope } from './planner-scope.js';
import {
  applyTaskEvent,
  currentAttemptIds,
  planView,
  readySteps,
  recomputePlanStatus,
  restoreSuccessfulWork,
} from './structured-plan.js';
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
  maxItemsPerStep?: number;
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
  private plan?: Plan;
  private readonly taskSteps = new Map<string, string>();
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
    if (
      opts.maxItemsPerStep !== undefined &&
      (!Number.isInteger(opts.maxItemsPerStep) || opts.maxItemsPerStep < 1)
    )
      throw new Error('maxItemsPerStep must be a positive integer');
    this.board = new TaskBoard({
      ...opts.board,
      onEvent: (event) => {
        applyTaskEvent(this.plan, event, this.taskSteps);
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
      session.plan =
        typeof state.plan === 'string'
          ? {
              version: 1,
              steps: [],
              note: state.plan,
              status: state.planStatus ?? 'active',
            }
          : structuredClone(state.plan);
      if (session.plan?.status === 'waiting_user' && !session.plan.question)
        session.plan.question =
          'Awaiting user response (restored legacy state)';
      session.pending = structuredClone(state.pending);
      session.savedAt = state.savedAt;
      const ids = session.board.restore(state.tasks);
      if (state.taskSteps !== undefined) {
        for (const [id, stepId] of Object.entries(state.taskSteps))
          session.taskSteps.set(id, stepId);
      } else {
        for (const step of session.plan?.steps ?? [])
          for (const id of step.taskIds) session.taskSteps.set(id, step.id);
      }
      for (const step of session.plan?.steps ?? []) {
        restoreSuccessfulWork(step, (id) => session.board.get(id));
        if (
          step.state !== 'skipped' &&
          currentAttemptIds(step).some((id) => ids.includes(id))
        ) {
          step.state = 'failed';
          step.note = 'interrupted by restart';
        }
      }
      recomputePlanStatus(session.plan);
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
    if (user && this.plan) {
      if (this.plan.status === 'waiting_user' && this.plan.question?.trim())
        this.plan.scopeConsent = true;
      else delete this.plan.scopeConsent;
      this.plan.status = 'active';
      delete this.plan.question;
    }
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
        const notes = [
          planView(this.plan),
          ...this.board.workerBudgetNotes(),
          ...(this.opts.maxItemsPerStep === undefined
            ? []
            : [
                `[environment] maxItemsPerStep: ${this.opts.maxItemsPerStep}; split larger batches`,
              ]),
        ];
        const last = messages.at(-1);
        if (last) last.content = `${notes.join('\n')}\n${last.content}`;
        const contentPartials: StreamChunk[] = [];
        const result = await runInPlannerScope(
          {
            board: this.board,
            maxItemsPerStep: this.opts.maxItemsPerStep,
            taskSteps: this.taskSteps,
            getPlan: () => this.plan,
            setPlan: (plan, status = 'active', question) => {
              this.plan =
                typeof plan === 'string'
                  ? { version: 1, steps: [], note: plan, status, question }
                  : plan;
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
        recomputePlanStatus(this.plan);
        const ready = readySteps(this.plan);
        const stalled =
          this.plan?.steps.filter(
            (step) =>
              (step.state === 'running' || step.state === 'checking') &&
              !currentAttemptIds(step).some((id) => {
                const task = this.board.get(id);
                return task?.state === 'queued' || task?.state === 'running';
              }),
          ) ?? [];
        const canCheck =
          this.plan !== undefined &&
          this.plan.status === 'active' &&
          !started &&
          !this.board
            .list()
            .some((t) => t.state === 'queued' || t.state === 'running');
        const idle = canCheck && (ready.length > 0 || stalled.length > 0);
        const needsEvents = canCheck && this.events.length > 0;
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
        const checks: string[] = [];
        if (idle && ready.length)
          checks.push(
            `Steps ${ready.map((s) => `${s.id}: ${s.goal.replace(/\s+/g, ' ').trim().slice(0, 200)}`).join(', ')} are ready (all dependencies done) and nothing runs. Delegate them or set status waiting_user with your question; skipping or narrowing requires user consent.`,
          );
        if (idle)
          for (const step of stalled)
            checks.push(
              step.state === 'running'
                ? `Step ${step.id} is running and nothing runs: its work finished; review get_task and continue`
                : step.successfulWorkTaskId === undefined ||
                    step.successfulWorkTaskId !== step.workTaskId
                  ? `Step ${step.id} is checking but its current work has not succeeded: re-delegate the work with step_id ${step.id} or ask the user`
                  : step.check?.by === 'checker'
                    ? `Step ${step.id} is checking and no check runs: delegate worker checker with step_id ${step.id}`
                    : `Step ${step.id} is checking and no check runs: close it with update_plan state done or failed plus a note`,
            );
        this.appendInput(
          `[check] ${checks.join('\n') || 'Review new task events before answering.'}` +
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
    return events
      .map(({ kind, task }) => {
        const owner = this.taskSteps.get(task.id);
        const removed =
          owner !== undefined &&
          !this.plan?.steps.some((step) => step.id === owner);
        return `${removed ? '[actions]' : '[task events]'} task ${task.id}${owner ? ` for ${owner}` : ''} (${task.worker}) ${kind}: ${task.goal} — ${task.error ?? task.output ?? ''}${task.budgetExhausted ? `; worker hit the tool-call budget ${task.toolCalls ?? '?'}/${task.maxToolCalls ?? '?'}` : ''}`;
      })
      .join('\n');
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
      planStatus: this.plan?.status,
      tasks: this.board.list(),
      taskSteps: Object.fromEntries(this.taskSteps),
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
