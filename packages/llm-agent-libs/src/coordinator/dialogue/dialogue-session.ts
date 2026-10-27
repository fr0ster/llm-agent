import { randomUUID } from 'node:crypto';
import type {
  DialogueSignals,
  DialogueState,
  IDialogueStateStore,
  ISignalEmitter,
  IUsageRecorder,
  Message,
  OnPartial,
  DialoguePlan as Plan,
  PlannerMessage,
  Result,
  SignalName,
  StreamChunk,
  TaskEvent,
} from '@mcp-abap-adt/llm-agent';
import {
  addTokenUsage,
  type PlannerMessageUsage,
  scopedUsage,
  type TokenUsage,
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
  usage?: IUsageRecorder;
  sessionId?: string;
  onPartial?: OnPartial;
  signal?: AbortSignal;
  stopSignal?: AbortSignal;
  trace?: { traceId: string };
}
export interface PlannerAgent {
  process(
    input: Message[],
    opts: PlannerTurnOptions,
  ): Promise<Result<{ content: string; usage?: TokenUsage }, Error>>;
}
export interface DialogueSessionOptions {
  usage?: IUsageRecorder;
  signals?: ISignalEmitter<DialogueSignals>;
  id: string;
  /** Maximum corrective turns; zero disables end-of-turn checks. Default: 2. */
  maxCorrections?: number;
  /** Wait status interval; zero disables signals. Default: 30,000 ms. */
  waitTickMs?: number;
  /** Running-task wake interval; zero disables wakes. Default: 300,000 ms. */
  longTaskMs?: number;
  /** Schedule once and return cancellation. Defaults to an unref'ed timeout. */
  scheduleTimer?: (callback: () => void, delayMs: number) => () => void;
  maxItemsPerStep?: number;
  planner: PlannerAgent;
  board: Omit<
    TaskBoardOptions,
    'onEvent' | 'signals' | 'source' | 'onStateChange'
  >;
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
  private readonly signals: ISignalEmitter<DialogueSignals>;
  private turnActive = false;
  private turnUsage?: IUsageRecorder;
  private lastActivity?: string;
  private lastPlan?: string;
  private emit<K extends SignalName<DialogueSignals>>(
    name: K,
    payload: DialogueSignals[K],
    key?: string,
  ): void {
    try {
      this.signals.emit(name, structuredClone(payload), this.opts.id, key);
    } catch {
      this.warn(`Dialogue signal emit failed: ${name}`);
    }
  }
  private changed(): void {
    this.updateWaitClock();
    const activity = {
      turnActive: this.turnActive,
      queuedInputs: this.users.length + this.events.length,
      running: this.board
        .list()
        .filter((t) => t.state === 'queued' || t.state === 'running').length,
      ready: readySteps(this.plan).length,
    };
    const encoded = JSON.stringify(activity);
    if (encoded !== this.lastActivity) {
      this.lastActivity = encoded;
      this.emit('dialogue.activity', activity);
    }
    if (this.plan) {
      const plan = {
        status: this.plan.status,
        total: this.plan.steps.length,
        done: this.plan.steps.filter((s) => s.state === 'done').length,
      };
      const encodedPlan = JSON.stringify(plan);
      if (encodedPlan !== this.lastPlan) {
        this.lastPlan = encodedPlan;
        this.emit('dialogue.plan.changed', plan);
      }
    }
  }
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
  private cancelTimer?: () => void;
  private nextTickAt?: number;
  private readonly longNotifiedAt = new Map<string, number>();
  private outcomeVersion = 0;

  private updateWaitClock(): void {
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    const tasks = this.board
      .list()
      .filter((task) => task.state === 'queued' || task.state === 'running');
    if (this.closing || !tasks.length) {
      this.nextTickAt = undefined;
      return;
    }
    const now = this.now();
    const tickMs = this.opts.waitTickMs ?? 30_000;
    const longMs = this.opts.longTaskMs ?? 300_000;
    const deadlines: number[] = [];
    if (tickMs > 0) {
      this.nextTickAt ??= now + tickMs;
      deadlines.push(this.nextTickAt);
    }
    if (longMs > 0)
      for (const task of tasks)
        if (task.state === 'running')
          deadlines.push(
            (this.longNotifiedAt.get(task.id) ??
              task.startedAt ??
              task.createdAt) + longMs,
          );
    if (!deadlines.length) return;
    const callback = () => {
      this.cancelTimer = undefined;
      this.waitTick();
    };
    const delay = Math.min(
      2_147_483_647,
      Math.max(0, Math.min(...deadlines) - now),
    );
    if (this.opts.scheduleTimer)
      this.cancelTimer = this.opts.scheduleTimer(callback, delay);
    else {
      const timer = setTimeout(callback, delay);
      timer.unref();
      this.cancelTimer = () => clearTimeout(timer);
    }
  }
  private waitTick(): void {
    if (this.closing) return;
    const now = this.now();
    const tasks: DialogueSignals['dialogue.wait']['tasks'] = this.board
      .list()
      .flatMap((task) =>
        task.state === 'queued' || task.state === 'running'
          ? [
              {
                id: task.id,
                worker: task.worker,
                goal: task.goal,
                state: task.state,
                elapsedMs: Math.max(
                  0,
                  now - (task.startedAt ?? task.createdAt),
                ),
                ...(task.toolCalls === undefined
                  ? {}
                  : { toolCalls: task.toolCalls }),
                ...(task.maxToolCalls === undefined
                  ? {}
                  : { maxToolCalls: task.maxToolCalls }),
              },
            ]
          : [],
      );
    if (
      tasks.length &&
      this.nextTickAt !== undefined &&
      now >= this.nextTickAt
    ) {
      this.nextTickAt = now + (this.opts.waitTickMs ?? 30_000);
      this.emit('dialogue.wait', { tasks });
    }
    const longMs = this.opts.longTaskMs ?? 300_000;
    if (longMs > 0)
      for (const task of this.board.list()) {
        if (
          task.state !== 'running' ||
          now -
            (this.longNotifiedAt.get(task.id) ??
              task.startedAt ??
              task.createdAt) <
            longMs
        )
          continue;
        this.longNotifiedAt.set(task.id, now);
        delete task.usage;
        this.events.push({ kind: 'long_running', task });
      }
    this.changed();
    if (this.events.length) this.schedule();
  }
  private liveEvents(events: TaskEvent[]): TaskEvent[] {
    return events.filter(
      (event) =>
        event.kind !== 'long_running' ||
        this.board.get(event.task.id)?.state === 'running',
    );
  }

  private constructor(private readonly opts: DialogueSessionOptions) {
    for (const [name, value] of [
      ['waitTickMs', opts.waitTickMs ?? 30_000],
      ['longTaskMs', opts.longTaskMs ?? 300_000],
    ] as const)
      if (!Number.isInteger(value) || value < 0)
        throw new Error(`${name} must be a non-negative integer`);
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
    this.signals = opts.signals ?? { emit() {}, retire() {} };
    const session = this;
    this.board = new TaskBoard({
      ...opts.board,
      boardId: opts.id,
      get usage() {
        return session.turnUsage ?? opts.usage ?? opts.board.usage;
      },
      logger: opts.logger ?? opts.board.logger,
      signals: this.signals,
      source: opts.id,
      onStateChange: () => this.changed(),
      onEvent: (event) => {
        applyTaskEvent(this.plan, event, this.taskSteps);
        this.changed();
        // Only outcomes wake the planner; a start is visible via list_tasks.
        if (this.closing || event.kind === 'started') return;
        if (event.kind !== 'long_running') this.outcomeVersion++;
        this.events.push(event);
        this.changed();
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
    for (const task of session.board.list())
      session.emit('dialogue.task.state', { task }, task.id);
    session.changed();
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
      this.changed();
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
      const events = user ? [] : this.liveEvents(this.events.splice(0));
      if (!user && !events.length) continue;
      const text = user ? user.text : this.eventNotes(events);
      const trigger = user ? 'user' : 'event';
      this.turnActive = true;
      this.changed();
      this.emit('dialogue.turn.started', { trigger });
      try {
        const message = await this.turn(text, user, events);
        if (!this.closing)
          this.emit('dialogue.turn.settled', {
            trigger,
            outcome: 'ok',
            messageId: message.id,
            status: this.plan?.status,
          });
        user?.resolve(message);
      } catch (error) {
        if (!this.closing)
          this.emit('dialogue.turn.settled', {
            trigger,
            outcome: 'failed',
            status: this.plan?.status,
          });
        user?.reject(error);
        if (!user) this.warn(`Dialogue event turn failed: ${String(error)}`);
      } finally {
        this.turnActive = false;
        this.changed();
      }
    }
  }
  private async turn(
    text: string,
    user?: UserTurn,
    consumed: TaskEvent[] = [],
  ): Promise<PlannerMessage> {
    const turnStartedAt = this.now();
    const origin = consumed
      .filter((event) => event.kind !== 'started')
      .map((event) => this.board.originRecorder(event.task.id))
      .find((recorder) => recorder !== undefined);
    this.turnUsage = scopedUsage(
      origin ?? user?.opts.usage ?? this.opts.usage ?? this.opts.board.usage,
      { turnId: randomUUID() },
    );
    if (user && this.plan) {
      if (this.plan.status === 'waiting_user' && this.plan.question?.trim())
        this.plan.scopeConsent = true;
      else delete this.plan.scopeConsent;
      this.plan.status = 'active';
      delete this.plan.question;
      this.changed();
    }
    const input = this.restart ? `${this.restart}\n${text}` : text;
    this.restart = undefined;
    this.appendInput(input);
    this.trim();
    try {
      let reply = '';
      let plannerUsage: TokenUsage | undefined;
      const actions: string[] = [];
      let started = false;
      const waitStop = new AbortController();
      const stopSignal = user?.opts.stopSignal
        ? AbortSignal.any([user.opts.stopSignal, waitStop.signal])
        : waitStop.signal;
      let lastReadVersion: number | undefined;
      let partialText = '';
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
            statusRead: () => {
              if (waitStop.signal.aborted) return;
              if (lastReadVersion === this.outcomeVersion) {
                actions.push('wait (turn ended: tasks running)');
                waitStop.abort();
              }
              lastReadVersion = this.outcomeVersion;
            },
            getPlan: () => this.plan,
            setPlan: (plan, status = 'active', question) => {
              this.plan =
                typeof plan === 'string'
                  ? { version: 1, steps: [], note: plan, status, question }
                  : plan;
              this.changed();
            },
            recordAction: (action, didStart) => {
              actions.push(action);
              started ||= didStart === true;
              this.changed();
            },
            history: () => structuredClone(this.conversation),
          },
          () =>
            this.opts.planner.process(messages, {
              ...user?.opts,
              stopSignal,
              sessionId: this.opts.id,
              usage: scopedUsage(this.turnUsage, { role: 'planner' }),
              onPartial: (chunk) => {
                if (chunk.kind === 'content') {
                  contentPartials.push(chunk);
                  partialText += chunk.delta;
                } else user?.opts.onPartial?.(chunk);
              },
            }),
        ).catch((error: Error) => {
          if (!waitStop.signal.aborted || user?.opts.signal?.aborted)
            throw error;
          return {
            ok: true as const,
            value: { content: partialText, usage: undefined },
          };
        });
        const waiting = waitStop.signal.aborted && !user?.opts.signal?.aborted;
        if (!result.ok && !waiting) throw result.error;
        if (result.ok)
          plannerUsage = addTokenUsage(plannerUsage, result.value.usage);
        reply = result.ok ? result.value.content : partialText;
        if (waiting && !reply.trim())
          reply = partialText.trim()
            ? partialText
            : `Waiting for ${this.board
                .list()
                .filter(
                  (task) => task.state === 'queued' || task.state === 'running',
                )
                .map((task) => `${task.id} (${task.worker})`)
                .join(', ')}.`;
        this.conversation.push({ role: 'assistant', content: reply });
        this.conversation.push({
          role: 'user',
          content: `[actions] ${actions.join(', ') || 'none'}`,
        });
        this.trim();
        recomputePlanStatus(this.plan);
        this.changed();
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
        const enabled =
          (this.opts.maxCorrections ?? 2) > 0 && !this.closing && !waiting;
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
        const events = this.liveEvents(this.events.splice(0));
        consumed.push(...events);
        this.changed();
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
      const tasks: NonNullable<PlannerMessageUsage['tasks']> = [];
      const seen = new Set<string>();
      for (const { task, kind } of consumed) {
        if (kind === 'long_running' || kind === 'started') continue;
        if (task.usage && !seen.has(task.id)) {
          seen.add(task.id);
          tasks.push({
            id: task.id,
            worker: task.worker,
            usage: task.usage,
            ...(typeof task.startedAt === 'number' &&
            typeof task.finishedAt === 'number'
              ? { durationMs: Math.max(0, task.finishedAt - task.startedAt) }
              : {}),
          });
        }
      }
      const createdAt = this.now();
      const message: PlannerMessage = {
        ...(plannerUsage || tasks.length
          ? {
              usage: {
                plannerMs: Math.max(0, createdAt - turnStartedAt),
                ...(plannerUsage ? { planner: plannerUsage } : {}),
                ...(tasks.length ? { tasks } : {}),
              },
            }
          : {}),
        id: randomUUID(),
        text: reply,
        createdAt,
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
        if (kind === 'long_running') {
          const seconds = Math.floor(
            Math.max(0, this.now() - (task.startedAt ?? task.createdAt)) / 1000,
          );
          const elapsed = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
          const calls =
            task.toolCalls === undefined
              ? ''
              : ` (${task.toolCalls}${task.maxToolCalls === undefined ? '' : `/${task.maxToolCalls}`} tool calls)`;
          return `[task events] ${task.id} (${task.worker}) is still running after ${elapsed}${calls}: check it and decide: keep waiting, stop_task, or re-delegate`;
        }
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
    this.changed();
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
    try {
      await this.opts.store?.delete(this.opts.id);
    } finally {
      this.emit('dialogue.session.closed', {});
      try {
        this.signals.retire(this.opts.id);
      } catch {
        this.warn('Dialogue signal retire failed');
      }
    }
  }
}
