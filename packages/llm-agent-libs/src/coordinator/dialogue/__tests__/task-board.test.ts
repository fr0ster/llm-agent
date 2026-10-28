import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  ISubAgent,
  ISubAgentInput,
  ISubAgentResult,
  TaskEvent,
} from '@mcp-abap-adt/llm-agent';
import { SemaphorePool, TASK_OUTPUT_CHAR_LIMIT, TaskBoard } from '../index.js';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function fixture(
  run: (input: ISubAgentInput) => Promise<ISubAgentResult>,
  options = {},
) {
  const worker: ISubAgent = {
    name: 'w',
    capabilities: { contextPolicy: 'optional' },
    run,
  };
  return new TaskBoard({
    workers: new Map([['w', worker]]),
    onEvent() {},
    ...options,
  });
}
function start(board: TaskBoard, goal = 'goal') {
  const result = board.start({ worker: 'w', goal });
  assert.ok(result.ok);
  return result.value.id;
}

test('returns immediately, limits concurrency, starts FIFO and removes queued stops', async () => {
  const releases: (() => void)[] = [];
  const goals: string[] = [];
  const board = fixture(
    async (input) => {
      goals.push(input.task);
      await new Promise<void>((resolve) => releases.push(resolve));
      return { output: 'ok' };
    },
    { maxConcurrent: 1 },
  );
  const first = start(board, 'first');
  const second = start(board, 'second');
  const third = start(board, 'third');
  assert.equal(board.get(second)?.state, 'queued');
  assert.equal(board.stop(second), true);
  await tick();
  assert.deepEqual(goals, ['first']);
  releases.shift()?.();
  await tick();
  assert.equal(board.get(first)?.state, 'done');
  assert.deepEqual(goals, ['first', 'third']);
  releases.shift()?.();
  await tick();
  assert.equal(board.get(third)?.state, 'done');
});

test('events are synchronous snapshots with bounded output and deterministic timestamps', async () => {
  const events: TaskEvent[] = [];
  let clock = 10;
  const board = fixture(async () => ({ output: 'a'.repeat(4005) }), {
    now: () => clock++,
    newId: () => 'custom',
    onEvent: (event: TaskEvent) => events.push(event),
  });
  const id = start(board);
  assert.equal(id, 'custom');
  await tick();
  assert.deepEqual(
    events.map((event) => event.kind),
    ['started', 'done'],
  );
  assert.equal(events[0].task.state, 'running');
  assert.equal(
    events[1].task.output,
    `${'a'.repeat(4000)}\n[cut: 5 characters omitted]`,
  );
  assert.deepEqual(
    [
      board.get(id)?.createdAt,
      board.get(id)?.startedAt,
      board.get(id)?.finishedAt,
    ],
    [10, 11, 12],
  );
  const record = board.get(id);
  if (record) record.goal = 'changed';
  assert.equal(board.get(id)?.goal, 'goal');
});

test('wrapper failure and pool acquisition failure free board capacity', async () => {
  let acquisitions = 0;
  let wraps = 0;
  const board = fixture(async () => ({ output: 'ok' }), {
    maxConcurrent: 1,
    pool: {
      async acquire() {
        if (++acquisitions === 1) throw new Error('pool failed');
        return () => {};
      },
    },
    wrapRun: async (_task: unknown, run: () => Promise<ISubAgentResult>) => {
      if (++wraps === 1) throw new Error('wrapper failed');
      return run();
    },
  });
  const ids = [start(board), start(board), start(board)];
  await tick();
  assert.deepEqual(
    ids.map((id) => board.get(id)?.state),
    ['failed', 'failed', 'done'],
  );
  assert.equal(board.get(ids[0])?.error, 'pool failed');
  assert.equal(board.get(ids[1])?.error, 'wrapper failed');
});

test('base input is forwarded and task-specific values override it', async () => {
  let received: ISubAgentInput | undefined;
  const board = fixture(
    async (input) => {
      received = input;
      return { output: '' };
    },
    {
      baseInput: () => ({
        sessionId: 'session',
        task: 'wrong',
        context: 'wrong',
        stopSignal: new AbortController().signal,
      }),
    },
  );
  board.start({
    worker: 'w',
    goal: 'correct',
    context: 'context',
    history: [{ role: 'user', content: 'history' }],
  });
  await tick();
  assert.equal(received?.sessionId, 'session');
  assert.equal(received?.task, 'correct');
  assert.equal(received?.context, 'context');
  assert.deepEqual(received?.history, [{ role: 'user', content: 'history' }]);
});

test('semaphore validates limits, aborts waiters, and releases idempotently in FIFO order', async () => {
  for (const limit of [0, -1, 1.5, Number.NaN])
    assert.throws(() => new SemaphorePool(limit));
  const pool = new SemaphorePool(1);
  const release = await pool.acquire();
  const controller = new AbortController();
  const cancelled = pool.acquire(controller.signal);
  controller.abort();
  await assert.rejects(cancelled);
  await assert.rejects(pool.acquire(controller.signal));
  let secondGranted = false;
  const first = pool.acquire();
  const second = pool.acquire().then((done) => {
    secondGranted = true;
    return done;
  });
  release();
  release();
  const firstRelease = await first;
  assert.equal(secondGranted, false);
  firstRelease();
  (await second)();
});

test('shared pool caps boards and cancelled pool waiters release board slots', async () => {
  const pool = new SemaphorePool(1);
  let finish: (() => void) | undefined;
  const a = fixture(
    async () => {
      await new Promise<void>((r) => {
        finish = r;
      });
      return { output: '' };
    },
    { pool },
  );
  const b = fixture(async () => ({ output: 'b' }), { pool, maxConcurrent: 1 });
  start(a);
  await tick();
  const cancelled = start(b);
  await tick();
  assert.equal(b.get(cancelled)?.state, 'queued');
  b.stop(cancelled);
  const next = start(b);
  finish?.();
  await tick();
  assert.equal(b.get(next)?.state, 'done');
});

test('limits, unknown workers, restore and generated ids', () => {
  const board = fixture(async () => ({ output: '' }), { maxTasks: 1 });
  assert.deepEqual(board.start({ worker: 'missing', goal: '' }), {
    ok: false,
    error: 'unknown worker missing',
  });
  board.restore([
    { id: 't9', worker: 'w', goal: '', state: 'running', createdAt: 1 },
  ]);
  assert.equal(board.get('t9')?.state, 'interrupted');
  assert.deepEqual(board.start({ worker: 'w', goal: '' }), {
    ok: false,
    error: 'task limit 1 reached',
  });
  const other = fixture(async () => ({ output: '' }));
  assert.deepEqual(
    other.restore([
      { id: 't9', worker: 'w', goal: '', state: 'queued', createdAt: 1 },
    ]),
    ['t9'],
  );
  assert.equal(start(other), 't10');
});

for (const [outcome, state] of [
  ['complete', 'done'],
  ['epicfail', 'failed'],
  ['stopped', 'stopped'],
  ['awaiting-external', 'failed'],
  ['throw', 'failed'],
] as const) {
  test(`maps ${outcome}, wraps run, bounds output and isolates events`, async () => {
    let wrapped = 0;
    const board = fixture(
      async () => {
        if (outcome === 'throw') throw new Error('broken');
        return {
          output: 'x'.repeat(4010),
          ...(outcome === 'epicfail'
            ? { errorClass: 'epicfail' as const }
            : outcome === 'stopped'
              ? { status: 'complete' as const, stopped: true as const }
              : { status: outcome }),
        };
      },
      {
        onEvent() {
          throw new Error('listener');
        },
        wrapRun: async (
          _task: unknown,
          run: () => Promise<ISubAgentResult>,
        ) => {
          wrapped++;
          return run();
        },
      },
    );
    const id = start(board);
    await tick();
    assert.equal(board.get(id)?.state, state);
    assert.equal(wrapped, 1);
    if (outcome !== 'throw')
      assert.equal(
        board.get(id)?.output,
        `${'x'.repeat(TASK_OUTPUT_CHAR_LIMIT)}\n[cut: 10 characters omitted]`,
      );
    const next = start(board);
    await tick();
    assert.equal(board.get(next)?.state, state);
  });
}

test('cooperative stop and stopAll wait for workers to settle', async () => {
  let input: ISubAgentInput | undefined;
  let finish: (() => void) | undefined;
  const board = fixture(async (value) => {
    input = value;
    await new Promise<void>((r) => {
      finish = r;
    });
    return { output: 'partial', status: 'complete', stopped: true };
  });
  const id = start(board);
  await tick();
  let settled = false;
  const stopping = board.stopAll().then(() => {
    settled = true;
  });
  assert.equal(input?.stopSignal?.aborted, true);
  await tick();
  assert.equal(settled, false);
  finish?.();
  await stopping;
  assert.equal(board.get(id)?.state, 'stopped');
});

for (const finalCount of [undefined, 5]) {
  test(`task preserves live counts unless result defines them (${finalCount})`, async () => {
    const board = fixture(async (input) => {
      input.onToolCallCount?.(3, 40);
      return finalCount === undefined
        ? { output: 'done' }
        : { output: 'done', toolCallCount: finalCount };
    });
    const id = start(board);
    await tick();
    assert.equal(board.get(id)?.state, 'done');
    assert.equal(board.get(id)?.toolCalls, finalCount ?? 3);
    assert.equal(board.get(id)?.maxToolCalls, 40);
  });
}

test('running tasks expose live tool counts and preserve the base observer', async () => {
  const releases: (() => void)[] = [];
  const worker: ISubAgent = {
    name: 'w',
    capabilities: { contextPolicy: 'optional', maxToolCalls: 40 },
    async run(input) {
      await new Promise<void>((resolve) => releases.push(resolve));
      input.onToolCallCount?.(3, 40);
      input.onToolCallCount?.(4);
      await new Promise<void>((resolve) => releases.push(resolve));
      return { output: 'done', toolCallCount: 5, maxToolCalls: 50 };
    },
  };
  const observed: number[] = [];
  const board = new TaskBoard({
    workers: new Map([['w', worker]]),
    onEvent() {},
    baseInput: () => ({
      onToolCallCount(count) {
        assert.equal(board.list()[0].toolCalls, count);
        observed.push(count);
        throw new Error('observer failed');
      },
    }),
  });
  const id = start(board);
  await tick();
  assert.equal(board.get(id)?.toolCalls, undefined);
  assert.equal(board.get(id)?.maxToolCalls, 40);
  releases.shift()?.();
  await tick();
  assert.equal(board.get(id)?.state, 'running');
  assert.equal(board.get(id)?.toolCalls, 4);
  assert.equal(board.get(id)?.maxToolCalls, 40);
  assert.deepEqual(observed, [3, 4]);
  releases.shift()?.();
  await tick();
  assert.equal(board.get(id)?.state, 'done');
  assert.equal(board.get(id)?.toolCalls, 5);
  assert.equal(board.get(id)?.maxToolCalls, 50);
});
