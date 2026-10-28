import { randomUUID } from 'node:crypto';
import type {
  DialogueSignals,
  IConcurrencyPool,
  ISignalEmitter,
  ISubAgent,
  ISubAgentInput,
  ISubAgentResult,
  IUsageRecorder,
  Result,
  TaskEvent,
  TaskRecord,
  TaskRequest,
  TaskState,
} from '@mcp-abap-adt/llm-agent';
import { SemaphorePool } from './semaphore-pool.js';

export const TASK_OUTPUT_CHAR_LIMIT = 4000;
export function cutTaskOutput(output: string): string {
  return output.length <= TASK_OUTPUT_CHAR_LIMIT
    ? output
    : `${output.slice(0, TASK_OUTPUT_CHAR_LIMIT)}\n[cut: ${output.length - TASK_OUTPUT_CHAR_LIMIT} characters omitted]`;
}
export interface TaskBoardOptions {
  usage?: IUsageRecorder;
  boardId?: string;
  logger?: { warn(message: string): void };
  signals?: ISignalEmitter<DialogueSignals>;
  source?: string;
  onStateChange?: () => void;
  workers: ReadonlyMap<string, ISubAgent>;
  maxConcurrent?: number;
  maxTasks?: number;
  /** After stop(), abort in-flight work after this grace period. Default: 60,000 ms;
   * zero aborts immediately; negative or NaN values use the default. */
  hardStopAfterMs?: number;
  /** Schedule once and return cancellation. Defaults to an unref'ed timeout. */
  scheduleTimer?: (callback: () => void, delayMs: number) => () => void;
  pool?: IConcurrencyPool;
  onEvent: (event: TaskEvent) => void;
  wrapRun?: (
    task: TaskRecord,
    run: () => Promise<ISubAgentResult>,
  ) => Promise<ISubAgentResult>;
  baseInput?: () => Partial<ISubAgentInput>;
  now?: () => number;
  newId?: () => string;
}
interface Entry {
  task: TaskRecord;
  request: TaskRequest;
  stop: AbortController;
  hard: AbortController;
  cancelHardStop?: () => void;
}
export class TaskBoard {
  private readonly records = new Map<string, TaskRecord>();
  private readonly entries = new Map<string, Entry>();
  private readonly running = new Set<Promise<void>>();
  private readonly boardPool: SemaphorePool;
  private readonly maxTasks: number;
  private counter = 0;
  private readonly hardStopAfterMs: number;
  private readonly boardId: string;
  private readonly originUsage = new Map<string, IUsageRecorder>();
  originRecorder(taskId: string): IUsageRecorder | undefined {
    return this.originUsage.get(taskId);
  }
  private readonly taskUsage = new Map<string, IUsageRecorder>();
  private readonly interruptedRecorded = new Set<string>();
  constructor(private readonly opts: TaskBoardOptions) {
    this.hardStopAfterMs =
      Number.isFinite(opts.hardStopAfterMs) && (opts.hardStopAfterMs ?? -1) >= 0
        ? (opts.hardStopAfterMs ?? 60_000)
        : 60_000;
    this.boardId = opts.boardId ?? randomUUID();
    this.boardPool = new SemaphorePool(opts.maxConcurrent ?? 3);
    this.maxTasks = opts.maxTasks ?? 50;
    if (!Number.isInteger(this.maxTasks) || this.maxTasks < 1)
      throw new Error('maxTasks must be a positive integer');
  }
  workerBudgetNotes(): string[] {
    return [...this.opts.workers].flatMap(([name, worker]) =>
      worker.capabilities.maxToolCalls === undefined
        ? []
        : [
            `[environment] ${name} worker tool-call budget: ${worker.capabilities.maxToolCalls} calls per task`,
          ],
    );
  }
  workerNames(): string[] {
    return [...this.opts.workers.keys()];
  }
  start(req: TaskRequest): Result<TaskRecord, string> {
    if (!this.opts.workers.has(req.worker))
      return { ok: false, error: `unknown worker ${req.worker}` };
    if (this.records.size >= this.maxTasks)
      return { ok: false, error: `task limit ${this.maxTasks} reached` };
    const id = this.opts.newId?.() ?? `t${++this.counter}`;
    if (this.records.has(id))
      return { ok: false, error: `duplicate task id ${id}` };
    const task: TaskRecord = {
      id,
      worker: req.worker,
      goal: req.goal,
      state: 'queued',
      createdAt: this.now(),
    };
    const entry: Entry = {
      task,
      request: req,
      stop: new AbortController(),
      hard: new AbortController(),
    };
    try {
      const origin = this.opts.usage;
      if (origin) this.originUsage.set(id, origin);
      const usage = origin?.with({ taskId: id, role: req.worker });
      if (usage) this.taskUsage.set(id, usage);
    } catch {
      /* Recording cannot affect task execution. */
    }
    this.records.set(id, task);
    this.entries.set(id, entry);
    this.signalState(task);
    // The board semaphore owns the FIFO queue, including cancellation.
    const promise = this.execute(entry);
    this.running.add(promise);
    void promise.finally(() => this.running.delete(promise));
    return { ok: true, value: { ...task } };
  }
  private now(): number {
    return (this.opts.now ?? Date.now)();
  }
  private signalState(task: TaskRecord, previous?: TaskState): void {
    try {
      this.opts.signals?.emit(
        'dialogue.task.state',
        structuredClone({
          task,
          ...(previous === undefined ? {} : { previous }),
        }),
        this.opts.source ?? '',
        task.id,
      );
    } catch {
      try {
        this.opts.logger?.warn(
          'Dialogue signal emit failed: dialogue.task.state',
        );
      } catch {
        /* Logging cannot affect execution. */
      }
    }
    this.opts.onStateChange?.();
  }
  private emit(
    kind: Exclude<TaskEvent['kind'], 'long_running'>,
    task: TaskRecord,
    previous: TaskState,
  ): void {
    if (kind !== 'started') this.recordTask(task);
    this.signalState(task, previous);
    try {
      this.opts.onEvent({ kind, task: { ...task } });
    } catch {
      /* Observers cannot affect execution. */
    }
  }
  private recordTask(task: TaskRecord, interrupted = false): void {
    try {
      const usage =
        this.taskUsage.get(task.id) ??
        this.opts.usage?.with({ taskId: task.id, role: task.worker });
      usage?.record({
        kind: 'task',
        context: {},
        ...(interrupted
          ? { id: `task:${this.boardId}:${task.id}:interrupted` }
          : {}),
        at: task.finishedAt,
        taskId: task.id,
        worker: task.worker,
        state: task.state,
        outcome:
          task.state === 'done'
            ? 'ok'
            : task.state === 'failed'
              ? 'error'
              : 'aborted',
        queuedMs:
          (task.startedAt ?? task.finishedAt ?? task.createdAt) -
          task.createdAt,
        ...(!interrupted &&
        task.startedAt !== undefined &&
        task.finishedAt !== undefined
          ? { runMs: task.finishedAt - task.startedAt }
          : {}),
        endKnown: !interrupted,
        toolCalls: task.toolCalls,
        budgetExhausted: task.budgetExhausted,
      });
    } catch {
      /* Recording cannot affect task execution. */
    }
    this.taskUsage.delete(task.id);
  }
  private async execute(entry: Entry): Promise<void> {
    const { task, request, stop, hard } = entry;
    let removeAbortListener: (() => void) | undefined;
    let releaseBoard: (() => void) | undefined;
    let releasePool: (() => void) | undefined;
    let kind: 'done' | 'failed' | 'stopped' = 'failed';
    try {
      releaseBoard = await this.boardPool.acquire(stop.signal);
      releasePool = await this.opts.pool?.acquire(stop.signal);
      if (stop.signal.aborted) return;
      task.state = 'running';
      task.startedAt = this.now();
      this.emit('started', task, 'queued');
      const worker = this.opts.workers.get(task.worker);
      if (!worker) throw new Error(`unknown worker ${task.worker}`);
      if (worker.capabilities?.maxToolCalls !== undefined)
        task.maxToolCalls = worker.capabilities.maxToolCalls;
      const baseInput = this.opts.baseInput?.();
      const run = () => {
        if (hard.signal.aborted) throw hard.signal.reason;
        return worker.run({
          ...baseInput,
          ...(this.taskUsage.has(task.id)
            ? { usage: this.taskUsage.get(task.id) }
            : {}),
          task: request.goal,
          context: request.context,
          history: request.history,
          signal: baseInput?.signal
            ? AbortSignal.any([baseInput.signal, hard.signal])
            : hard.signal,
          stopSignal: stop.signal,
          onToolsSelected: (selected, available) => {
            if (hard.signal.aborted || task.state !== 'running') return;
            task.toolsSelected = selected;
            task.toolsAvailable = available;
            try {
              baseInput?.onToolsSelected?.(selected, available);
            } catch {
              /* Observers cannot affect execution. */
            }
          },
          onToolCallCount: (count, max) => {
            if (hard.signal.aborted || task.state !== 'running') return;
            task.toolCalls = count;
            if (max !== undefined) task.maxToolCalls = max;
            try {
              baseInput?.onToolCallCount?.(count, max);
            } catch {
              /* Observers cannot affect execution. */
            }
          },
        });
      };
      const aborted = new Promise<never>((_, reject) => {
        const onAbort = () => reject(hard.signal.reason);
        hard.signal.addEventListener('abort', onAbort, { once: true });
        removeAbortListener = () =>
          hard.signal.removeEventListener('abort', onAbort);
        if (hard.signal.aborted) onAbort();
      });
      const result = await Promise.race([
        Promise.resolve().then(() =>
          this.opts.wrapRun ? this.opts.wrapRun({ ...task }, run) : run(),
        ),
        aborted,
      ]);
      if (hard.signal.aborted) throw hard.signal.reason;
      if (result.usage) task.usage = result.usage;
      task.output = cutTaskOutput(result.output);
      task.budgetExhausted = result.budgetExhausted;
      if (result.toolCallCount !== undefined)
        task.toolCalls = result.toolCallCount;
      if (result.maxToolCalls !== undefined)
        task.maxToolCalls = result.maxToolCalls;
      if (result.errorClass === 'epicfail') {
        task.error = task.output || 'worker epicfail';
        kind = 'failed';
      } else if (result.status === 'awaiting-external') {
        task.error =
          'external tool calls are not supported in background tasks';
        kind = 'failed';
      } else kind = result.stopped === true ? 'stopped' : 'done';
    } catch (error) {
      if (hard.signal.aborted) {
        kind = 'stopped';
        task.error = `stopped: in-flight work aborted after ${this.hardStopAfterMs} ms`;
      } else if (task.state === 'stopped') kind = 'stopped';
      else {
        kind = 'failed';
        task.error = error instanceof Error ? error.message : String(error);
      }
    } finally {
      entry.cancelHardStop?.();
      removeAbortListener?.();
      releasePool?.();
      releaseBoard?.();
      this.entries.delete(task.id);
      if (task.state !== 'stopped') {
        const previous = task.state;
        task.state = kind;
        task.finishedAt = this.now();
        this.emit(kind, task, previous);
      }
    }
  }
  stop(taskId: string): boolean {
    const entry = this.entries.get(taskId);
    if (!entry || entry.stop.signal.aborted) return false;
    entry.stop.abort();
    if (entry.task.state === 'queued') {
      entry.task.state = 'stopped';
      entry.task.finishedAt = this.now();
      this.emit('stopped', entry.task, 'queued');
    } else if (entry.task.state === 'running') {
      const abort = () => {
        if (entry.task.state === 'running') entry.hard.abort();
      };
      if (this.hardStopAfterMs === 0) abort();
      else if (this.opts.scheduleTimer)
        entry.cancelHardStop = this.opts.scheduleTimer(
          abort,
          this.hardStopAfterMs,
        );
      else {
        const timer = setTimeout(abort, this.hardStopAfterMs);
        timer.unref();
        entry.cancelHardStop = () => clearTimeout(timer);
      }
    }
    return true;
  }
  async stopAll(): Promise<void> {
    for (const id of this.entries.keys()) this.stop(id);
    await Promise.all([...this.running]);
  }
  get(id: string): TaskRecord | undefined {
    const task = this.records.get(id);
    return task && { ...task };
  }
  list(): TaskRecord[] {
    return [...this.records.values()].map((task) => ({ ...task }));
  }
  restore(records: TaskRecord[]): string[] {
    if (this.entries.size)
      throw new Error('cannot restore while tasks are active');
    this.originUsage.clear();
    const interrupted: string[] = [];
    for (const record of records) {
      const task = { ...record };
      if (task.state === 'running' || task.state === 'queued') {
        task.state = 'interrupted';
        task.finishedAt = this.now();
        interrupted.push(task.id);
        if (!this.interruptedRecorded.has(task.id)) {
          this.interruptedRecorded.add(task.id);
          this.recordTask(task, true);
        }
      }
      this.records.set(task.id, task);
      const match = /^t(\d+)$/.exec(task.id);
      if (match) this.counter = Math.max(this.counter, Number(match[1]));
    }
    return interrupted;
  }
}
