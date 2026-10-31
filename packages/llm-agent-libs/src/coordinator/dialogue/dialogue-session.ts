import { randomUUID } from 'node:crypto';
import type {
  CallOptions,
  DialogueSignals,
  DialogueState,
  IAgentProfileRunner,
  IAgentProfileSource,
  IDialogueStateStore,
  IPlanAuthor,
  IPlannerContextBuilder,
  ISignalEmitter,
  IUsageRecorder,
  McpError,
  McpToolResult,
  Message,
  OnPartial,
  DialoguePlan as Plan,
  PlannerMessage,
  PlannerRequestRecord,
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
import { DIALOGUE_COORDINATOR_SYSTEM } from './coordinator-prompt.js';
import {
  appendRequestMessage,
  boundRequestTranscript,
  DefaultPlannerContextBuilder,
  renderPlannerRetrieval,
} from './planner-context-builder.js';
import { PlannerMemoryWriter } from './planner-memory.js';
import {
  composePlannerPrompt,
  DIALOGUE_PLANNER_SYSTEM,
} from './planner-prompt.js';
import {
  type PlannerRetrievalOptions,
  retrievePlannerContext,
  validateRetrievalOptions,
} from './planner-retrieval.js';
import { type PlannerScope, runInPlannerScope } from './planner-scope.js';
import { PlannerToolsClient } from './planner-tools-client.js';
import { formatRequestTime, validateTimeZone } from './request-time.js';
import {
  applyTaskEvent,
  checkSourcesCurrent,
  currentAttemptIds,
  deliveryChecksPassed,
  planView,
  readySteps,
  recomputePlanStatus,
  resetStaleCheck,
  restoreLegacyStep,
  restoreSuccessfulWork,
  resultKind,
} from './structured-plan.js';
import { TaskBoard, type TaskBoardOptions } from './task-board.js';

export const DIALOGUE_HISTORY_LIMIT = 200;
export interface PlannerTurnOptions {
  toolRoundGuard?: CallOptions['toolRoundGuard'];
  usage?: IUsageRecorder;
  sessionId?: string;
  onPartial?: OnPartial;
  /** Live executed tool-call count; observer exceptions never interrupt execution. */
  onToolCallCount?: (count: number, max?: number) => void;
  /** Reports tool definitions offered per round and all available MCP plus external
   * tools before selection/filters, only when either count changes. Fire-and-forget;
   * observer exceptions never interrupt execution. */
  onToolsSelected?: (selected: number, available: number) => void;
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
export interface DialogueSessionOptions extends PlannerRetrievalOptions {
  /** IANA time zone for request time formatting. Default: UTC. */
  timeZone?: string;
  /** Request-scoped prepared context by default; conversation preserves legacy planner input. */
  plannerContext?: 'prepared' | 'conversation';
  /** Overrides the default builder in prepared mode only. */
  plannerContextBuilder?: IPlannerContextBuilder;
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
  /** After stop(), abort in-flight work after this grace period. Default: 60,000 ms;
   * zero aborts immediately; negative or NaN values use the default. */
  hardStopAfterMs?: number;
  maxItemsPerStep?: number;
  taskOutputChars?: number;
  planner?: PlannerAgent;
  planAuthor?: IPlanAuthor;
  profileSource?: IAgentProfileSource;
  profileRunner?: IAgentProfileRunner;
  profileTimeoutMs?: number;
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
  private readonly resultEvents: string[] = [];
  private readonly signals: ISignalEmitter<DialogueSignals>;
  private turnActive = false;
  private externalCoordinator = false;
  // Outcomes deferred while no coordinator turn runs accompany the next user.
  private deferredEvents: TaskEvent[] = [];
  private toolActive?: Promise<Result<McpToolResult, McpError>>;
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
    this.updateRequestPlan();
    this.updateWaitClock();
    const activity = {
      turnActive: this.turnActive,
      queuedInputs:
        this.users.length + this.events.length + this.deferredEvents.length,
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
  private readonly memoryWriter?: PlannerMemoryWriter;
  private readonly taskRequests = new Map<string, string>();
  private requests: PlannerRequestRecord[] = [];
  private requestSeq = 0;
  private readonly contextBuilder: IPlannerContextBuilder;
  private get openRequest(): PlannerRequestRecord | undefined {
    return this.requests.find((record) => record.closedAt === undefined);
  }
  private updateRequestPlan(): void {
    const open = this.openRequest;
    if (!open) return;
    open.plan = this.plan
      ? {
          status: this.plan.status,
          steps: this.plan.steps.length,
          done: this.plan.steps.filter((step) => step.state === 'done').length,
          failed: this.plan.steps.filter((step) => step.state === 'failed')
            .length,
          skipped: this.plan.steps.filter((step) => step.state === 'skipped')
            .length,
        }
      : undefined;
  }
  private beginRequest(text: string, user: boolean): PlannerRequestRecord {
    let open = this.openRequest;
    const automatic =
      user &&
      this.plan?.status !== 'waiting_user' &&
      (!this.plan ||
        (!this.plan.steps.length && !this.plan.note) ||
        this.plan.status === 'done') &&
      open?.lastTurnOk === true &&
      !this.events.length &&
      !this.board
        .list()
        .some((task) => task.state === 'queued' || task.state === 'running');
    if (open && automatic) {
      this.updateRequestPlan();
      open.closedAt = this.now();
      delete open.transcript;
      // Preserve the notes sent with raw conversation history.
      if (this.opts.plannerContext !== 'conversation') this.plan = undefined;
      open = undefined;
    }
    if (!open) {
      open = {
        id: `r${++this.requestSeq}`,
        openedAt: this.now(),
        text: text.slice(0, 20_000),
        transcript: [],
      };
      this.requests.push(open);
    }
    this.retainRequests();
    return open;
  }
  private retainRequests(): void {
    for (const record of this.requests) {
      record.text = record.text.slice(0, 20_000);
      if (record.closedAt !== undefined) delete record.transcript;
    }
    while (this.requests.length > 200) {
      const index = this.requests.findIndex(
        (record) => record.closedAt !== undefined,
      );
      if (index < 0) break;
      this.requests.splice(index, 1);
    }
  }
  private indexReply(
    message: PlannerMessage,
    request: PlannerRequestRecord,
  ): void {
    if (message.text.trim() === 'NO_MESSAGE') return;
    this.memoryWriter?.enqueue(
      'planner-reply',
      request.id,
      message.id,
      message.text,
      { usage: this.turnUsage },
    );
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
                ...(task.state !== 'running' || task.toolsSelected === undefined
                  ? {}
                  : { toolsSelected: task.toolsSelected }),
                ...(task.state !== 'running' ||
                task.toolsAvailable === undefined
                  ? {}
                  : { toolsAvailable: task.toolsAvailable }),
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
    validateTimeZone(opts.timeZone ?? 'UTC');
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
    validateRetrievalOptions(opts);
    if (opts.plannerMemory)
      this.memoryWriter = new PlannerMemoryWriter(
        opts.id,
        opts.plannerMemory,
        (message) => this.warn(message),
      );
    this.contextBuilder =
      opts.plannerContextBuilder ?? new DefaultPlannerContextBuilder();
    this.signals = opts.signals ?? { emit() {}, retire() {} };
    const session = this;
    this.board = new TaskBoard({
      ...opts.board,
      profileSource: opts.profileSource ?? opts.board.profileSource,
      profileRunner: opts.profileRunner ?? opts.board.profileRunner,
      profileTimeoutMs: opts.profileTimeoutMs ?? opts.board.profileTimeoutMs,
      taskOutputChars: opts.taskOutputChars ?? opts.board.taskOutputChars,
      hardStopAfterMs: opts.hardStopAfterMs ?? opts.board.hardStopAfterMs,
      scheduleTimer: opts.scheduleTimer ?? opts.board.scheduleTimer,
      boardId: opts.id,
      get usage() {
        return session.turnUsage ?? opts.usage ?? opts.board.usage;
      },
      logger: opts.logger ?? opts.board.logger,
      signals: this.signals,
      source: opts.id,
      onStateChange: () => this.changed(),
      onEvent: (event) => {
        const owner =
          this.taskRequests.get(event.task.id) ?? this.openRequest?.id;
        if (owner) {
          this.taskRequests.set(event.task.id, owner);
          if (
            event.kind === 'done' ||
            event.kind === 'failed' ||
            event.kind === 'stopped'
          )
            this.memoryWriter?.enqueue(
              'planner-task',
              owner,
              event.task.id,
              `${event.task.goal}: ${event.task.output ?? event.task.error ?? ''}`,
              {
                usage:
                  this.board.originRecorder(event.task.id) ??
                  this.turnUsage ??
                  opts.usage,
              },
            );
        }
        if (owner === this.openRequest?.id) {
          applyTaskEvent(this.plan, event, this.taskSteps);
        }
        recomputePlanStatus(this.plan);
        this.changed();
        // Only outcomes wake the planner; a start is visible via list_tasks.
        if (this.closing || event.kind === 'started') return;
        if (event.kind !== 'long_running') this.outcomeVersion++;
        if (this.externalCoordinator) this.deferredEvents.push(event);
        else this.events.push(event);
        this.changed();
        if (this.externalCoordinator) void this.persist();
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
      session.deferredEvents = structuredClone(state.pendingEvents ?? []);
      session.requests = (
        state.requests ?? [
          {
            id: 'r1',
            openedAt: state.savedAt,
            text:
              state.conversation
                .find((message) => message.role === 'user')
                ?.content?.slice(0, 20_000) ?? '',
            transcript: [],
            legacy: true,
            lastTurnOk: true,
          },
        ]
      ).map((record) => ({
        id: record.id,
        openedAt: record.openedAt,
        ...(record.closedAt === undefined
          ? { transcript: structuredClone(record.transcript ?? []) }
          : { closedAt: record.closedAt }),
        text: record.text.slice(0, 20_000),
        plan: structuredClone(record.plan),
        lastTurnOk: record.lastTurnOk,
        ...(record.legacy ? { legacy: true as const } : {}),
      }));
      if (state.requests === undefined) {
        const legacy = session.requests[0];
        for (const message of state.conversation)
          appendRequestMessage(legacy, message);
      }
      for (const record of session.requests) {
        record.text = record.text.slice(0, 20_000);
        boundRequestTranscript(record);
      }
      session.requestSeq = Math.max(
        state.requestSeq ?? 0,
        ...session.requests.map((record) => Number(record.id.slice(1)) || 0),
      );
      session.retainRequests();
      session.savedAt = state.savedAt;
      for (const [id, owner] of Object.entries(state.taskRequests ?? {}))
        session.taskRequests.set(id, owner);
      for (const task of state.tasks) {
        if (!session.taskRequests.has(task.id) && session.openRequest)
          session.taskRequests.set(task.id, session.openRequest.id);
      }
      const ids = session.board.restore(state.tasks);
      if (state.taskSteps !== undefined) {
        for (const [id, stepId] of Object.entries(state.taskSteps))
          session.taskSteps.set(id, stepId);
      } else {
        for (const step of session.plan?.steps ?? [])
          for (const id of step.taskIds) session.taskSteps.set(id, step.id);
      }
      for (const step of session.plan?.steps ?? []) {
        restoreLegacyStep(step);
        restoreSuccessfulWork(step, (id) => session.board.get(id));
        if (
          step.state !== 'skipped' &&
          currentAttemptIds(step).some((id) => ids.includes(id))
        ) {
          step.state = 'failed';
          step.note = 'interrupted by restart';
        }
      }
      // Source markers must all be restored before validating dependent evidence.
      if (session.plan) {
        for (const step of session.plan.steps) {
          if (
            resultKind(step) === 'verdict' &&
            step.state !== 'skipped' &&
            !checkSourcesCurrent(session.plan, step)
          )
            resetStaleCheck(step);
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
      this.externalCoordinator = false;
      this.users.push({ text, opts, resolve, reject });
      this.changed();
      this.schedule();
    });
  }
  private createPlannerScope(
    request: PlannerRequestRecord | undefined,
    options: CallOptions = {},
  ): PlannerScope {
    return {
      planAuthor: this.opts.planAuthor,
      newRequest: () => {
        throw new Error('not available outside a coordinator turn');
      },
      deliver: () => {
        throw new Error('not available outside a coordinator turn');
      },
      ownTask: (id) => {
        const owner =
          request ??
          this.openRequest ??
          this.beginRequest(this.board.get(id)?.goal ?? '', false);
        this.taskRequests.set(id, owner.id);
      },
      recordAction: () => this.changed(),
      board: this.board,
      signal: options.signal,
      requestStartedAt: request?.openedAt,
      maxItemsPerStep: this.opts.maxItemsPerStep,
      taskSteps: this.taskSteps,
      getPlan: () => this.plan,
      setPlan: (plan, status = 'active', question) => {
        this.plan =
          typeof plan === 'string'
            ? { version: 1, steps: [], note: plan, status, question }
            : plan;
        this.changed();
      },
      searchKnowledge: async (query, collection, k) => {
        const sources = this.opts.plannerKnowledge ?? [];
        if (
          collection !== undefined &&
          !sources.some((source) => source.name === collection)
        )
          throw new Error(`unknown knowledge collection ${collection}`);
        const result = await retrievePlannerContext(
          {
            ...this.opts,
            plannerMemory: undefined,
            plannerKnowledge: sources.filter(
              (source) =>
                collection === undefined || source.name === collection,
            ),
            knowledgeK: k,
          },
          this.opts.id,
          request?.id ?? this.opts.id,
          query,
          false,
          options,
          (message) => this.warn(message),
        );
        return renderPlannerRetrieval({
          memory: [],
          knowledge: result.knowledge,
          notes: [],
        }).join('\n');
      },
    };
  }
  callTool(
    name: string,
    args: Record<string, unknown>,
    opts: { signal?: AbortSignal } = {},
  ): Promise<Result<McpToolResult, McpError>> {
    const refuse = (
      message: string,
    ): Promise<Result<McpToolResult, McpError>> =>
      Promise.resolve({
        ok: true,
        value: { isError: true, content: [{ type: 'text', text: message }] },
      });
    if (opts.signal?.aborted) return refuse('aborted');
    if (this.turnActive || this.active || this.users.length)
      return refuse('session is busy with a coordinator turn');
    if (this.toolActive) return refuse('session is busy with a tool call');
    if (this.closing) return refuse('dialogue session closed');
    if (name === 'new_request' || name === 'deliver')
      return refuse('not available outside a coordinator turn');
    this.externalCoordinator = true;
    const operation = runInPlannerScope(
      this.createPlannerScope(this.openRequest, opts),
      () => new PlannerToolsClient().callTool(name, args),
    );
    this.toolActive = operation.finally(async () => {
      this.changed();
      if (!opts.signal?.aborted) await this.persist();
      this.toolActive = undefined;
      if (this.users.length) this.schedule();
    });
    return this.toolActive;
  }
  private schedule(): void {
    if (this.active || this.toolActive || this.closing) return;
    if (this.externalCoordinator && !this.users.length) return;
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
    while (
      !this.closing &&
      (this.users.length || (!this.externalCoordinator && this.events.length))
    ) {
      const user = this.users.shift();
      const events = this.liveEvents(
        user ? this.deferredEvents.splice(0) : this.events.splice(0),
      );
      if (!user && !events.length) continue;
      const notes = this.eventNotes(events);
      const text = user ? [user.text, notes].filter(Boolean).join('\n') : notes;
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
    const previousRequest = this.openRequest;
    const previousPlan = this.plan;
    const waitingAtEntry = this.plan?.status === 'waiting_user';
    let request = this.beginRequest(
      text,
      user !== undefined && consumed.length === 0,
    );
    const entryTurnOk = request.lastTurnOk;
    request.lastTurnOk = false;
    const turnStartedAt = this.now();
    const origin = consumed
      .filter((event) => event.kind !== 'started')
      .map((event) => this.board.originRecorder(event.task.id))
      .find((recorder) => recorder !== undefined);
    this.turnUsage = scopedUsage(
      origin ?? user?.opts.usage ?? this.opts.usage ?? this.opts.board.usage,
      { turnId: randomUUID() },
    );
    if (previousRequest && previousRequest !== request) {
      this.memoryWriter?.enqueue(
        'planner-plan',
        previousRequest.id,
        previousRequest.id,
        previousPlan?.steps
          .map((step) => `${step.goal} — ${step.state} — ${step.note ?? ''}`)
          .join('\n') ?? '',
        { usage: this.turnUsage },
      );
    }
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
      const projected = new DefaultPlannerContextBuilder().build({
        open: request,
        memory: [],
        knowledge: [],
        notes: [],
      });
      const elided = projected.some((message) =>
        /\[(?:elided|cut:|stored cut:|dropped) /.test(message.content ?? ''),
      );
      let retrieved = await retrievePlannerContext(
        this.opts,
        this.opts.id,
        request.id,
        user
          ? text
          : `${request.transcript?.[0]?.content ?? request.text}\n${text}`,
        elided,
        { usage: this.turnUsage, signal: user?.opts.signal },
        (message) => this.warn(message),
      );
      let reply = '';
      const deliveries: string[] = [];
      let plannerUsage: TokenUsage | undefined;
      const actions: string[] = [];
      let started = false;
      const waitStop = new AbortController();
      const stopSignal = user?.opts.stopSignal
        ? AbortSignal.any([user.opts.stopSignal, waitStop.signal])
        : waitStop.signal;
      let lastReadVersion: number | undefined;
      let partialText = '';
      let callIndex = 0;
      let didRestart = false;
      for (let correction = 0; ; correction++) {
        const callStop = new AbortController();
        let restarting = false;
        let delivered = false;
        let toolCount = 0;
        let reserved = false;
        let roundCount = 0;
        let restartDelivered = false;
        const startRequest = (fromTool = false) => {
          if (
            !user ||
            callIndex !== 0 ||
            didRestart ||
            waitingAtEntry ||
            toolCount !== (fromTool ? 1 : 0)
          )
            throw new Error(
              'new_request requires the first tool of the first planner call in a user turn, once, and never an answer to waiting_user',
            );
          this.updateRequestPlan();
          request.closedAt = this.now();
          delete request.transcript;
          request.lastTurnOk = entryTurnOk;
          this.memoryWriter?.enqueue(
            'planner-plan',
            request.id,
            request.id,
            this.plan?.steps
              .map(
                (step) => `${step.goal} — ${step.state} — ${step.note ?? ''}`,
              )
              .join('\n') ?? '',
            { usage: this.turnUsage },
          );
          this.plan = undefined;
          request = this.beginRequest(text, false);
          request.lastTurnOk = false;
          appendRequestMessage(request, { role: 'user', content: text });
          partialText = '';
          contentPartials.length = 0;
          lastReadVersion = undefined;
          didRestart = true;
          restarting = true;
          callStop.abort();
          this.retainRequests();
          this.changed();
        };
        let planner = this.opts.planner;
        let profileNote: string | undefined;
        if (this.board.profiles) {
          const discovery = await this.board.profiles.discovery({
            signal: user?.opts.signal,
          });
          profileNote = `[worker profiles] ${JSON.stringify(discovery.profiles)}`;
          const runner =
            this.opts.profileRunner ?? this.opts.board.profileRunner;
          if (!runner) throw new Error('profileRunner is required');
          planner = await this.board.profiles.call(
            (options) =>
              runner.preparePlanner(
                {
                  systemPrompt: composePlannerPrompt(
                    this.opts.planAuthor
                      ? (discovery.prompts.coordinator ??
                          DIALOGUE_COORDINATOR_SYSTEM)
                      : (discovery.prompts.planner ?? DIALOGUE_PLANNER_SYSTEM),
                  ),
                },
                options,
              ),
            { signal: user?.opts.signal },
          );
        }
        if (!planner) throw new Error('planner is required');
        const callPlanner = planner;
        const notes = [
          ...(profileNote === undefined ? [] : [profileNote]),
          planView(this.plan),
          ...this.board.workerBudgetNotes(),
          ...(this.opts.maxItemsPerStep === undefined
            ? []
            : [
                `[environment] maxItemsPerStep: ${this.opts.maxItemsPerStep}; split larger batches`,
              ]),
        ];
        const messages =
          this.opts.plannerContext === 'conversation'
            ? structuredClone(this.conversation)
            : this.contextBuilder.build({
                open: structuredClone(request),
                ...retrieved,
                memoryCharBudget: this.opts.memoryCharBudget,
                knowledgeCharBudget: this.opts.knowledgeCharBudget,
                notes,
              });
        if (this.opts.plannerContext === 'conversation') {
          const last = messages.at(-1);
          const line = formatRequestTime(request.openedAt, this.opts.timeZone);
          if (last)
            last.content = `${line}\n${notes.join('\n')}\n${last.content}`;
          else messages.push({ role: 'user', content: line });
        } else {
          const line = formatRequestTime(request.openedAt, this.opts.timeZone);
          const firstUser = messages.find((message) => message.role === 'user');
          if (firstUser) firstUser.content = `${line}\n${firstUser.content}`;
          else messages.push({ role: 'user', content: line });
        }
        const resultEvents = this.resultEvents.splice(0);
        if (resultEvents.length) {
          const last = messages.at(-1);
          if (last) last.content += `\n${resultEvents.join('\n')}`;
          else
            messages.push({ role: 'user', content: resultEvents.join('\n') });
        }
        const contentPartials: StreamChunk[] = [];
        const result = await runInPlannerScope(
          {
            ...this.createPlannerScope(request, {
              ...user?.opts,
              usage: this.turnUsage,
            }),
            beforeTool: (name) => {
              if (
                (reserved || restarting) &&
                (name !== 'new_request' || !reserved || restartDelivered)
              )
                throw new Error(
                  'new request started; continue in the next call',
                );
              if (!reserved && !restarting) toolCount++;
            },
            newRequest: () => {
              if (reserved && !restartDelivered) {
                startRequest();
                restartDelivered = true;
                return;
              }
              startRequest(true);
              restartDelivered = true;
            },
            deliver: (id, note) => {
              if (delivered)
                throw new Error('only one deliver per planner call');
              const task = this.board.get(id);
              if (!task || this.taskRequests.get(id) !== request.id)
                throw new Error(
                  `task ${id} does not belong to the current request`,
                );
              if (task.state !== 'done')
                throw new Error(`task ${id} is not done`);
              const stepId = this.taskSteps.get(id);
              if (
                stepId &&
                this.plan?.steps.find((step) => step.id === stepId)?.state !==
                  'done'
              )
                throw new Error(
                  `step ${stepId} is not done (check may be pending)`,
                );
              if (
                stepId &&
                this.plan &&
                !deliveryChecksPassed(this.plan, stepId)
              )
                throw new Error(
                  `step ${stepId} requires passing latest check steps before delivery`,
                );
              deliveries.push(
                `${note ? `${note}\n\n` : ''}${task.output ?? ''}`,
              );
              delivered = true;
              partialText = '';
              contentPartials.length = 0;
            },
            statusRead: () => {
              if (waitStop.signal.aborted) return;
              if (lastReadVersion === this.outcomeVersion) {
                actions.push('wait (turn ended: tasks running)');
                waitStop.abort();
              }
              lastReadVersion = this.outcomeVersion;
            },
            recordAction: (action, didStart) => {
              actions.push(action);
              started ||= didStart === true;
              this.changed();
            },
          },
          () =>
            callPlanner.process(messages, {
              ...user?.opts,
              toolRoundGuard: (calls) => {
                const firstRound = roundCount++ === 0;
                if (
                  firstRound &&
                  toolCount === 0 &&
                  user &&
                  callIndex === 0 &&
                  !didRestart &&
                  !waitingAtEntry &&
                  calls[0]?.name === 'new_request' &&
                  Object.keys(calls[0].arguments).length === 0
                ) {
                  reserved = true;
                  // Reserve the boundary now; the tool handler performs the effect.
                }
                if (reserved || restarting) {
                  return new Map(
                    calls.flatMap((_, index) =>
                      reserved && firstRound && index === 0
                        ? []
                        : [
                            [
                              index,
                              'new request started; continue in the next call',
                            ] as const,
                          ],
                    ),
                  );
                }
                return new Map(
                  calls.flatMap((call, index) =>
                    call.name === 'new_request'
                      ? [
                          [
                            index,
                            'new_request requires the first tool of the first planner call in a user turn, once, and never an answer to waiting_user',
                          ] as const,
                        ]
                      : [],
                  ),
                );
              },
              stopSignal: AbortSignal.any([stopSignal, callStop.signal]),
              sessionId: this.opts.id,
              usage: scopedUsage(this.turnUsage, { role: 'planner' }),
              onPartial: (chunk) => {
                if (restarting) return;
                if (chunk.kind === 'content') {
                  if (delivered) return;
                  contentPartials.push(chunk);
                  partialText += chunk.delta;
                } else user?.opts.onPartial?.(chunk);
              },
            }),
        ).catch((error: Error) => {
          if (
            (!waitStop.signal.aborted && !restarting) ||
            user?.opts.signal?.aborted
          )
            throw error;
          return {
            ok: true as const,
            value: { content: partialText, usage: undefined },
          };
        });
        callIndex++;
        if (result.ok)
          plannerUsage = addTokenUsage(plannerUsage, result.value.usage);
        if (restarting) {
          retrieved = await retrievePlannerContext(
            this.opts,
            this.opts.id,
            request.id,
            text,
            false,
            { usage: this.turnUsage, signal: user?.opts.signal },
            (message) => this.warn(message),
          );
          correction--;
          continue;
        }
        const waiting = waitStop.signal.aborted && !user?.opts.signal?.aborted;
        if (!result.ok && !waiting) throw result.error;

        reply = deliveries.length
          ? deliveries.join('\n\n')
          : result.ok
            ? result.value.content
            : partialText;
        if (waiting && !deliveries.length && !reply.trim())
          reply = partialText.trim()
            ? partialText
            : `Waiting for ${this.board
                .list()
                .filter(
                  (task) => task.state === 'queued' || task.state === 'running',
                )
                .map((task) => `${task.id} (${task.worker})`)
                .join(', ')}.`;
        appendRequestMessage(request, { role: 'assistant', content: reply });
        appendRequestMessage(request, {
          role: 'user',
          content: `[actions] ${actions.join(', ') || 'none'}`,
        });
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
              step.state === 'running' &&
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
          if (deliveries.length)
            user?.opts.onPartial?.({ kind: 'content', delta: reply });
          else
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
              `Step ${step.id} is running and nothing runs: its task finished; review get_task and continue`,
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
      request.lastTurnOk = true;
      this.indexReply(message, request);
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
      if (user)
        this.memoryWriter?.enqueue(
          'planner-input',
          request.id,
          randomUUID(),
          text,
          { usage: this.turnUsage },
        );
      if (!this.closing) await this.persist();
    }
  }
  private eventNotes(events: TaskEvent[]): string {
    return events
      .map(({ kind, task }) => {
        const requestId = this.taskRequests.get(task.id);
        const label =
          requestId && requestId !== this.openRequest?.id
            ? `[task events] from ${requestId}:`
            : '[task events]';
        if (kind === 'long_running') {
          const seconds = Math.floor(
            Math.max(0, this.now() - (task.startedAt ?? task.createdAt)) / 1000,
          );
          const elapsed = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
          const calls =
            task.toolCalls === undefined
              ? ''
              : ` (${task.toolCalls}${task.maxToolCalls === undefined ? '' : `/${task.maxToolCalls}`} tool calls)`;
          return `${label} ${task.id} (${task.worker}) is still running after ${elapsed}${calls}: check it and decide: keep waiting, stop_task, or re-delegate`;
        }
        if (task.output !== undefined)
          this.resultEvents.push(
            `${label} task ${task.id} (${task.worker}) ${kind} result:\n${task.output}`,
          );
        const owner = this.taskSteps.get(task.id);
        const removed =
          owner !== undefined &&
          !this.plan?.steps.some((step) => step.id === owner);
        return `${label !== '[task events]' ? label : removed ? '[actions]' : '[task events]'} task ${task.id}${owner ? ` for ${owner}` : ''} (${task.worker}) ${kind}: ${task.goal} — ${(task.error !== task.output ? task.error : undefined) ?? (task.output === undefined ? '' : '(result reported once; use get_task to read again)')}${task.budgetExhausted ? `; worker hit the tool-call budget ${task.toolCalls ?? '?'}/${task.maxToolCalls ?? '?'}` : ''}`;
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
    const open = this.openRequest;
    if (open) appendRequestMessage(open, { role: 'user', content: text });
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
      requests: this.requests,
      requestSeq: this.requestSeq,
      conversation: this.conversation,
      plan: this.plan,
      planStatus: this.plan?.status,
      tasks: this.board.list(),
      taskSteps: Object.fromEntries(this.taskSteps),
      taskRequests: Object.fromEntries(this.taskRequests),
      pending: this.pending,
      pendingEvents: this.deferredEvents,
      savedAt: this.savedAt,
    });
  }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.events = [];
    this.deferredEvents = [];
    for (const user of this.users.splice(0))
      user.reject(new Error('dialogue session closed'));
    this.changed();
    this.closePromise = this.finishClose();
    return this.closePromise;
  }
  private async finishClose(): Promise<void> {
    // Stop immediately, then stop again for tasks delegated by the settling turn.
    await Promise.all([this.board.stopAll(), this.active, this.toolActive]);
    await this.board.stopAll();
    await this.memoryWriter?.close();
    this.events = [];
    this.deferredEvents = [];
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
