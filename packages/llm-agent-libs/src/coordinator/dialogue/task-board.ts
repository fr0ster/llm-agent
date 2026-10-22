import type {
  IConcurrencyPool,
  ISubAgent,
  ISubAgentInput,
  ISubAgentResult,
  Result,
  TaskEvent,
  TaskRecord,
  TaskRequest,
} from '@mcp-abap-adt/llm-agent';
import { SemaphorePool } from './semaphore-pool.js';

export const TASK_OUTPUT_CHAR_LIMIT = 4000;
export function cutTaskOutput(output: string): string {
  return output.length <= TASK_OUTPUT_CHAR_LIMIT
    ? output
    : `${output.slice(0, TASK_OUTPUT_CHAR_LIMIT)}\n[cut: ${output.length - TASK_OUTPUT_CHAR_LIMIT} characters omitted]`;
}
export interface TaskBoardOptions {
  workers: ReadonlyMap<string, ISubAgent>;
  maxConcurrent?: number;
  maxTasks?: number;
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
}
export class TaskBoard {
  private readonly records = new Map<string, TaskRecord>();
  private readonly entries = new Map<string, Entry>();
  private readonly running = new Set<Promise<void>>();
  private readonly boardPool: SemaphorePool;
  private readonly maxTasks: number;
  private counter = 0;
  constructor(private readonly opts: TaskBoardOptions) {
    this.boardPool = new SemaphorePool(opts.maxConcurrent ?? 3);
    this.maxTasks = opts.maxTasks ?? 50;
    if (!Number.isInteger(this.maxTasks) || this.maxTasks < 1)
      throw new Error('maxTasks must be a positive integer');
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
    const entry = { task, request: req, stop: new AbortController() };
    this.records.set(id, task);
    this.entries.set(id, entry);
    // The board semaphore owns the FIFO queue, including cancellation.
    const promise = this.execute(entry);
    this.running.add(promise);
    void promise.finally(() => this.running.delete(promise));
    return { ok: true, value: { ...task } };
  }
  private now(): number {
    return (this.opts.now ?? Date.now)();
  }
  private emit(kind: TaskEvent['kind'], task: TaskRecord): void {
    try {
      this.opts.onEvent({ kind, task: { ...task } });
    } catch {
      /* Observers cannot affect execution. */
    }
  }
  private async execute(entry: Entry): Promise<void> {
    const { task, request, stop } = entry;
    let releaseBoard: (() => void) | undefined;
    let releasePool: (() => void) | undefined;
    let kind: TaskEvent['kind'] = 'failed';
    try {
      releaseBoard = await this.boardPool.acquire(stop.signal);
      releasePool = await this.opts.pool?.acquire(stop.signal);
      if (stop.signal.aborted) return;
      task.state = 'running';
      task.startedAt = this.now();
      this.emit('started', task);
      const worker = this.opts.workers.get(task.worker);
      if (!worker) throw new Error(`unknown worker ${task.worker}`);
      const run = () =>
        worker.run({
          ...this.opts.baseInput?.(),
          task: request.goal,
          context: request.context,
          history: request.history,
          stopSignal: stop.signal,
        });
      const result = await (this.opts.wrapRun
        ? this.opts.wrapRun({ ...task }, run)
        : run());
      task.output = cutTaskOutput(result.output);
      if (result.errorClass === 'epicfail') {
        task.error = task.output || 'worker epicfail';
        kind = 'failed';
      } else if (result.status === 'awaiting-external') {
        task.error =
          'external tool calls are not supported in background tasks';
        kind = 'failed';
      } else kind = result.stopped === true ? 'stopped' : 'done';
    } catch (error) {
      if (task.state === 'stopped') kind = 'stopped';
      else {
        kind = 'failed';
        task.error = error instanceof Error ? error.message : String(error);
      }
    } finally {
      releasePool?.();
      releaseBoard?.();
      this.entries.delete(task.id);
      if (task.state !== 'stopped') {
        task.state = kind;
        task.finishedAt = this.now();
        this.emit(kind, task);
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
      this.emit('stopped', entry.task);
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
    const interrupted: string[] = [];
    for (const record of records) {
      const task = { ...record };
      if (task.state === 'running' || task.state === 'queued') {
        task.state = 'interrupted';
        task.finishedAt = this.now();
        interrupted.push(task.id);
      }
      this.records.set(task.id, task);
      const match = /^t(\d+)$/.exec(task.id);
      if (match) this.counter = Math.max(this.counter, Number(match[1]));
    }
    return interrupted;
  }
}
