import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  DialoguePlanStep,
  ISubAgentInput,
  ISubAgentResult,
  ITaskResultStore,
  TaskEvent,
  TaskResultEntry,
} from '@mcp-abap-adt/llm-agent';
import { DialogueSession } from '../dialogue-session.js';
import { PlannerToolsClient } from '../planner-tools-client.js';
import { SemaphorePool } from '../semaphore-pool.js';
import { applyTaskEvent } from '../structured-plan.js';
import { TaskBoard, type TaskBoardOptions } from '../task-board.js';
import { taskNotice } from '../task-reference.js';

type PlanStep = DialoguePlanStep;

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function store(put: ITaskResultStore['put']): ITaskResultStore {
  return {
    put,
    async read() {
      return { ok: true, value: '' };
    },
  };
}
const success: ITaskResultStore['put'] = async (entry) => ({
  ok: true,
  value: {
    collection: 'results',
    record: entry.id,
    chars: entry.output.length,
  },
});
const failure: ITaskResultStore['put'] = async () => ({
  ok: false,
  error: { code: 'unavailable', message: 'offline' },
});
function board(
  run: (input: ISubAgentInput) => Promise<ISubAgentResult>,
  options: Partial<TaskBoardOptions> = {},
) {
  return new TaskBoard({
    workers: new Map([
      ['w', { name: 'w', capabilities: { contextPolicy: 'optional' }, run }],
    ]),
    onEvent() {},
    ...options,
  });
}
function start(b: TaskBoard, result: 'report' | 'verdict' = 'report') {
  const task = b.start({ worker: 'w', goal: 'goal', result });
  assert.ok(task.ok);
  return task.value.id;
}

test('put happens before done is published', async () => {
  const order: string[] = [];
  const events: TaskEvent[] = [];
  const gate = deferred<void>();
  const b = board(
    async () => ({ output: 'full', summary: 'brief', budgetExhausted: true }),
    {
      resultStore: store(async (entry, options) => {
        order.push('put');
        await gate.promise;
        order.push('stored');
        return success(entry, options);
      }),
      onEvent(event) {
        order.push(event.kind);
        events.push(event);
      },
    },
  );
  const id = start(b);
  await tick();
  assert.equal(b.get(id)?.state, 'running');
  assert.equal(b.get(id)?.summary, undefined);
  gate.resolve();
  await tick();
  assert.deepEqual(order, ['started', 'put', 'stored', 'done']);
  const done = events.find((event) => event.kind === 'done');
  assert.equal(done?.task.summary, 'brief');
  assert.ok(done?.task.resultRef);
  assert.equal(b.get(id)?.budgetExhausted, true);
});

test('put receives raw uncut output', async () => {
  const entries: TaskResultEntry[] = [];
  const b = board(async () => ({ output: 'a'.repeat(70000) }), {
    resultStore: store(async (entry) => {
      entries.push(entry);
      return success(entry);
    }),
  });
  const id = start(b);
  await tick();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].output.length, 70000);
  assert.equal(entries[0].summary.length, 600);
  assert.match(entries[0].summary, / \[summary truncated\]$/);
  assert.equal(b.get(id)?.summary, entries[0].summary);
  assert.match(b.get(id)?.output ?? '', /cut: 10000/);
});

test('put failure turns done into failed', async () => {
  const b = board(async () => ({ output: 'ok' }), {
    resultStore: store(failure),
  });
  const id = start(b);
  await tick();
  assert.equal(b.get(id)?.state, 'failed');
  assert.match(b.get(id)?.error ?? '', /storage/);
  assert.equal(b.get(id)?.resultRef, undefined);
});

test('stopped with failed put stays stopped without ref', async () => {
  const b = board(async () => ({ output: 'partial', stopped: true }), {
    resultStore: store(failure),
  });
  const id = start(b);
  await tick();
  assert.equal(b.get(id)?.state, 'stopped');
  assert.equal(b.get(id)?.resultRef, undefined);
});

for (const put of [success, failure]) {
  test(`hard stop before put stays stopped with ${put === success ? 'successful' : 'failed'} storage`, async () => {
    const entries: TaskResultEntry[] = [];
    let putSignal: AbortSignal | undefined;
    const b = board(() => new Promise(() => {}), {
      hardStopAfterMs: 0,
      resultStore: store(async (entry, options) => {
        entries.push(entry);
        putSignal = options?.signal;
        return put(entry, options);
      }),
    });
    const id = start(b);
    await tick();
    b.stop(id);
    await tick();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].outcome, 'stopped');
    assert.match(entries[0].output, /stopped: in-flight work aborted/);
    assert.equal(putSignal?.aborted ?? false, false);
    assert.equal(b.get(id)?.state, 'stopped');
    assert.equal(!!b.get(id)?.resultRef, put === success);
  });
}

test('slow put after cooperative finish outlives the hard-stop timer', async () => {
  const gate = deferred<void>();
  const timers: { fire: () => void; cancelled: boolean }[] = [];
  const entries: TaskResultEntry[] = [];
  let workerSignal: AbortSignal | undefined;
  let putSignal: AbortSignal | undefined;
  const b = board(
    async (input) => {
      workerSignal = input.signal;
      await new Promise<void>((resolve) => {
        input.stopSignal?.addEventListener('abort', () => resolve(), {
          once: true,
        });
      });
      return { output: 'partial', stopped: true };
    },
    {
      stallNoticeMs: undefined,
      hardStopAfterMs: 25,
      scheduleTimer(fire) {
        const timer = { fire, cancelled: false };
        timers.push(timer);
        return () => {
          timer.cancelled = true;
        };
      },
      resultStore: store(async (entry, options) => {
        entries.push(entry);
        putSignal = options?.signal;
        await gate.promise;
        return success(entry, options);
      }),
    },
  );
  const id = start(b);
  await tick();
  b.stop(id);
  await tick();
  assert.equal(timers.length, 1);
  assert.equal(timers[0].cancelled, true);
  for (const timer of timers) if (!timer.cancelled) timer.fire();
  assert.equal(workerSignal?.aborted, false);
  assert.equal(putSignal?.aborted ?? false, false);
  assert.equal(b.get(id)?.state, 'running');
  assert.equal(entries[0].output, 'partial');
  assert.equal(entries[0].outcome, 'stopped');
  gate.resolve();
  await tick();
  assert.equal(b.get(id)?.state, 'stopped');
  assert.ok(b.get(id)?.resultRef);
});

for (const mode of ['signal', 'returned'] as const) {
  test(`abort during put (${mode}) becomes interrupted without ref`, async () => {
    const gate = deferred<void>();
    const session = new AbortController();
    const b = board(async () => ({ output: 'ok' }), {
      baseInput: () => ({ signal: session.signal }),
      resultStore: store(async (entry, options) => {
        await gate.promise;
        return mode === 'returned'
          ? { ok: false, error: { code: 'aborted', message: 'cancelled' } }
          : success(entry, options);
      }),
    });
    const id = start(b);
    await tick();
    if (mode === 'signal') session.abort();
    gate.resolve();
    await tick();
    assert.equal(b.get(id)?.state, 'interrupted');
    assert.equal(b.get(id)?.resultRef, undefined);
  });
}

test('failed task stores error text with outcome failed', async () => {
  const entries: TaskResultEntry[] = [];
  const b = board(
    async () => {
      throw new Error('worker error');
    },
    {
      resultStore: store(async (entry) => {
        entries.push(entry);
        return success(entry);
      }),
    },
  );
  const id = start(b);
  await tick();
  assert.equal(entries[0].output, 'worker error');
  assert.equal(entries[0].outcome, 'failed');
  assert.equal(b.get(id)?.state, 'failed');
  assert.ok(b.get(id)?.resultRef);
});

test('no store preserves legacy behaviour', async () => {
  const b = board(async () => ({ output: 'ok', summary: 'brief' }));
  const id = start(b);
  await tick();
  assert.equal(b.get(id)?.state, 'done');
  assert.equal(b.get(id)?.output, 'ok');
  assert.equal(b.get(id)?.summary, undefined);
  assert.equal(b.get(id)?.resultRef, undefined);
});

test('verdict entry has parsed verdict and verdict summary', async () => {
  const entries: TaskResultEntry[] = [];
  const b = board(
    async () => ({
      output: 'Evidence:\n\n{"verdict":"fail","count":2,"note":"missing item"}',
      summary: 'ignored',
    }),
    {
      resultStore: store(async (entry) => {
        entries.push(entry);
        return success(entry);
      }),
    },
  );
  start(b, 'verdict');
  await tick();
  assert.equal(entries[0].verdict, 'fail');
  assert.equal(entries[0].summary, 'fail; count: 2; note: missing item');
});

test('stepId comes from the session map', async () => {
  const entries: TaskResultEntry[] = [];
  const tools = new PlannerToolsClient();
  let delegated = false;
  const session = await DialogueSession.open({
    id: 'results-step',
    maxCorrections: 0,
    resultStore: store(async (entry) => {
      entries.push(entry);
      return success(entry);
    }),
    board: {
      workers: new Map([
        [
          'w',
          {
            name: 'w',
            capabilities: { contextPolicy: 'optional' },
            async run() {
              return { output: 'ok' };
            },
          },
        ],
      ]),
    },
    planner: {
      async process() {
        if (!delegated) {
          delegated = true;
          await tools.callTool('plan_update', {
            steps: [{ id: 'work', goal: 'goal', worker: 'w' }],
          });
          const result = await tools.callTool('delegate_task', {
            worker: 'w',
            goal: 'goal',
            step_id: 'work',
          });
          assert.ok(result.ok);
          assert.ok(!result.value.isError);
          await tick();
        }
        return { ok: true, value: { content: 'NO_MESSAGE' } };
      },
    },
  });
  await session.send('go');
  await tick();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].stepId, 'work');
  await session.close();
});

for (const stopped of [false, true]) {
  test(`thrown storage error preserves ${stopped ? 'stopped' : 'failed'} outcome`, async () => {
    let puts = 0;
    const b = board(
      async () => {
        if (!stopped) throw new Error('worker failed');
        return { output: 'partial', stopped: true };
      },
      {
        resultStore: store(async () => {
          puts++;
          throw new Error('offline');
        }),
      },
    );
    const id = start(b);
    await tick();
    assert.equal(puts, 1);
    assert.equal(b.get(id)?.state, stopped ? 'stopped' : 'failed');
    assert.equal(b.get(id)?.resultRef, undefined);
    if (!stopped) assert.equal(b.get(id)?.error, 'worker failed');
  });
}

test('thrown put failure turns done into failed', async () => {
  const b = board(async () => ({ output: 'ok' }), {
    resultStore: store(async () => {
      throw new Error('offline');
    }),
  });
  const id = start(b);
  await tick();
  assert.equal(b.get(id)?.state, 'failed');
  assert.match(b.get(id)?.error ?? '', /storage.*offline/);
  assert.equal(b.get(id)?.resultRef, undefined);
});

test('epicfail stores uncut error text while keeping the legacy bounded error', async () => {
  const entries: TaskResultEntry[] = [];
  const output = 'e'.repeat(70000);
  const b = board(async () => ({ output, errorClass: 'epicfail' }), {
    resultStore: store(async (entry) => {
      entries.push(entry);
      return success(entry);
    }),
  });
  const id = start(b);
  await tick();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].output, output);
  assert.equal(entries[0].outcome, 'failed');
  assert.match(b.get(id)?.error ?? '', /cut: 10000/);
});

for (const withStore of [false, true]) {
  test(`long verdict output stays consistent with notice and plan (store: ${withStore})`, async () => {
    const b = board(
      async () => ({ output: 'x'.repeat(70000) + '\n\nPASS' }),
      withStore ? { resultStore: store(success) } : {},
    );
    const id = start(b, 'verdict');
    await tick();
    const task = b.get(id)!;
    assert.deepEqual(task.checkerVerdict, { verdict: 'pass' });
    assert.ok(!task.output?.includes('PASS'));
    assert.match(taskNotice(task), /verdict: pass/);
    const step: PlanStep = {
      id: 'check',
      goal: 'check',
      result: 'verdict',
      state: 'running',
      taskIds: [id],
      workTaskId: id,
    };
    applyTaskEvent(
      { version: 1, status: 'active', steps: [step] },
      { kind: 'done', task },
    );
    assert.equal(step.state, 'done');
    assert.equal(step.verdict, 'pass');
  });
}

for (const withStore of [false, true]) {
  test(`rejected raw verdict stays unusable after output truncation (store: ${withStore})`, async () => {
    const b = board(
      async () => ({
        output:
          '{"verdict":"pass"}\n\n' +
          'x'.repeat(70000) +
          '\n\n{"verdict":"fail"}',
      }),
      withStore ? { resultStore: store(success) } : {},
    );
    const id = start(b, 'verdict');
    await tick();
    const task = b.get(id)!;
    assert.deepEqual(task.checkerVerdict, { unusable: true });
    assert.ok(task.output?.includes('{"verdict":"pass"}'));
    assert.ok(!task.output?.includes('{"verdict":"fail"}'));
    assert.match(taskNotice(task), /verdict: unusable/);
    assert.doesNotMatch(taskNotice(task), /verdict: pass/);
    const step: PlanStep = {
      id: 'check',
      goal: 'check',
      result: 'verdict',
      state: 'running',
      taskIds: [id],
      workTaskId: id,
    };
    applyTaskEvent(
      { version: 1, status: 'active', steps: [step] },
      { kind: 'done', task },
    );
    assert.equal(step.state, 'failed');
    assert.equal(step.verdict, 'fail');
    assert.match(step.note ?? '', /unusable verdict/);

    // Legacy records still parse their output, which now rejects embedded JSON.
    const { checkerVerdict: _retained, ...legacy } = task;
    assert.doesNotMatch(taskNotice(legacy), /verdict: pass/);
    applyTaskEvent(
      { version: 1, status: 'active', steps: [step] },
      { kind: 'done', task: legacy },
    );
    assert.equal(step.state, 'failed');
    assert.equal(step.verdict, 'fail');
  });
}

test('hung put releases both slots before stop interrupts it', async () => {
  const events: TaskEvent[] = [];
  const signals: AbortSignal[] = [];
  const goals: string[] = [];
  const b = board(
    async (input) => {
      goals.push(input.task);
      return { output: 'ok' };
    },
    {
      maxConcurrent: 1,
      pool: new SemaphorePool(1),
      hardStopAfterMs: 0,
      resultStore: store((_entry, options) => {
        assert.ok(options?.signal);
        signals.push(options.signal);
        return new Promise(() => {});
      }),
      onEvent: (event) => events.push(event),
    },
  );
  const first = start(b);
  const second = start(b);
  await tick();
  assert.equal(goals.length, 2);
  assert.equal(signals.length, 2);
  assert.equal(b.get(first)?.state, 'running');
  assert.equal(b.stop(first), true);
  await tick();
  assert.equal(signals[0].aborted, true);
  assert.equal(b.get(first)?.state, 'interrupted');
  assert.equal(b.get(first)?.resultRef, undefined);
  assert.deepEqual(
    events
      .filter((e) => e.task.id === first)
      .map((e) => [e.kind, e.task.state]),
    [
      ['started', 'running'],
      ['stopped', 'interrupted'],
    ],
  );
  await b.stopAll();
  assert.equal(b.get(second)?.state, 'interrupted');
});

for (const settlement of ['resolve', 'reject'] as const) {
  test(`late put ${settlement} after stopAll cannot change final state`, async () => {
    const gate = deferred<Awaited<ReturnType<ITaskResultStore['put']>>>();
    let reject!: (reason: Error) => void;
    const failure = new Promise<never>((_, r) => {
      reject = r;
    });
    const events: TaskEvent[] = [];
    const b = board(async () => ({ output: 'ok' }), {
      resultStore: store(() =>
        settlement === 'resolve' ? gate.promise : failure,
      ),
      onEvent: (event) => events.push(event),
    });
    const id = start(b);
    await tick();
    await b.stopAll();
    const final = b.get(id);
    assert.equal(final?.state, 'interrupted');
    assert.equal(final?.resultRef, undefined);
    if (settlement === 'resolve')
      gate.resolve({
        ok: true,
        value: {
          collection: 'results',
          record: id,
          chars: 2,
        },
      });
    else reject(new Error('late storage failure'));
    await tick();
    assert.deepEqual(b.get(id), final);
    assert.equal(events.length, 2);
  });
}

test('base signal interrupts a put that ignores cancellation', async () => {
  const controller = new AbortController();
  const b = board(async () => ({ output: 'ok' }), {
    baseInput: () => ({ signal: controller.signal }),
    resultStore: store(() => new Promise(() => {})),
  });
  const id = start(b);
  await tick();
  controller.abort();
  await tick();
  assert.equal(b.get(id)?.state, 'interrupted');
  await b.stopAll();
});

test('session close resolves with a hung result write', async () => {
  const tools = new PlannerToolsClient();
  let delegated = false;
  const session = await DialogueSession.open({
    id: 'hung-result-close',
    resultStore: store(() => new Promise(() => {})),
    board: {
      workers: new Map([
        [
          'w',
          {
            name: 'w',
            capabilities: { contextPolicy: 'optional' },
            async run() {
              return { output: 'ok' };
            },
          },
        ],
      ]),
    },
    planner: {
      async process() {
        if (!delegated) {
          delegated = true;
          const result = await tools.callTool('delegate_task', {
            worker: 'w',
            goal: 'goal',
          });
          assert.ok(result.ok);
          assert.ok(!result.value.isError);
          await tick();
        }
        return { ok: true, value: { content: 'NO_MESSAGE' } };
      },
    },
  });
  await session.send('go');
  await tick();
  await session.close();
  assert.equal(session.snapshot().tasks[0]?.state, 'interrupted');
});

test('stopAll also interrupts a write begun by a cooperatively stopping worker', async () => {
  const b = board(
    async (input) => {
      await new Promise<void>((resolve) => {
        input.stopSignal?.addEventListener('abort', () => resolve(), {
          once: true,
        });
      });
      return { output: 'partial', stopped: true };
    },
    {
      resultStore: store(() => new Promise(() => {})),
    },
  );
  const id = start(b);
  await tick();
  await b.stopAll();
  assert.equal(b.get(id)?.state, 'interrupted');
});
