import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  beginLlmRequest,
  type ISubAgent,
  type ISubAgentInput,
  type ISubAgentResult,
  type IUsageRecorder,
  startOperation,
  type UsageContext,
  type UsageInput,
} from '@mcp-abap-adt/llm-agent';
import { DialogueSession } from '../dialogue-session.js';
import { currentPlannerScope } from '../planner-scope.js';
import { TaskBoard } from '../task-board.js';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function recorder() {
  const records: UsageInput[] = [];
  const scoped = (context: UsageContext): IUsageRecorder => ({
    record(input) {
      records.push({ ...input, context: { ...context, ...input.context } });
    },
    with(next) {
      return scoped({ ...context, ...next });
    },
  });
  return { usage: scoped({ sessionId: 's' }), records };
}
function worker(
  run: (input: ISubAgentInput) => Promise<ISubAgentResult>,
): ISubAgent {
  return { name: 'w', capabilities: { contextPolicy: 'optional' }, run };
}
function start(board: TaskBoard) {
  const result = board.start({ worker: 'w', goal: 'private goal' });
  assert.ok(result.ok);
  return result.value.id;
}
function llm(usage?: IUsageRecorder) {
  beginLlmRequest({ usage }, startOperation(), {
    provider: 'fake',
    model: 'fake',
    stream: false,
    granularity: 'request',
    retriesVisible: true,
  }).end({ outcome: 'ok' });
}

test('records every terminal transition exactly once with timing and no content', async () => {
  for (const state of ['done', 'failed', 'queued', 'running'] as const) {
    const { usage, records } = recorder();
    let clock = 10;
    const board = new TaskBoard({
      usage,
      now: () => clock++,
      maxConcurrent: 1,
      onEvent() {},
      workers: new Map([
        [
          'w',
          worker(async (input) => {
            if (state === 'running' || state === 'queued') {
              await new Promise<void>((resolve) =>
                input.stopSignal?.addEventListener('abort', () => resolve(), {
                  once: true,
                }),
              );
              return { output: 'private result', stopped: true };
            }
            if (state === 'failed') throw new Error('private error');
            return {
              output: 'private result',
              toolCallCount: 2,
              budgetExhausted: true,
            };
          }),
        ],
      ]),
    });
    const first = start(board);
    let id = first;
    if (state === 'queued') {
      id = start(board);
      board.stop(id);
    }
    await tick();
    if (state === 'running') board.stop(id);
    await tick();
    const ends = records.filter((r) => r.kind === 'task' && r.taskId === id);
    assert.equal(ends.length, 1);
    const end = ends[0];
    assert.equal(end.kind, 'task');
    if (end.kind !== 'task') throw new Error('missing task record');
    assert.equal(
      end.state,
      state === 'queued' || state === 'running' ? 'stopped' : state,
    );
    assert.equal(
      end.outcome,
      state === 'done' ? 'ok' : state === 'failed' ? 'error' : 'aborted',
    );
    assert.deepEqual(end.context, { sessionId: 's', taskId: id, role: 'w' });
    assert.equal(end.endKnown, true);
    assert.equal(
      end.queuedMs,
      (board.get(id)?.startedAt ?? end.at ?? 0) -
        (board.get(id)?.createdAt ?? 0),
    );
    if (state === 'queued') assert.equal(end.runMs, undefined);
    else
      assert.equal(end.runMs, (end.at ?? 0) - (board.get(id)?.startedAt ?? 0));
    if (state === 'done') {
      assert.equal(end.toolCalls, 2);
      assert.equal(end.budgetExhausted, true);
    }
    assert.ok(!JSON.stringify(records).includes('private'));
    await board.stopAll();
    assert.equal(
      records.filter((r) => r.kind === 'task' && r.taskId === id).length,
      1,
    );
  }
});

test('restore uses stable session identities, records only interrupted transitions once', async () => {
  const { usage, records } = recorder();
  const tasks = [
    {
      id: 't1',
      worker: 'w',
      goal: '',
      state: 'running' as const,
      createdAt: 1,
      startedAt: 2,
    },
    { id: 't2', worker: 'w', goal: '', state: 'done' as const, createdAt: 1 },
  ];
  for (const id of ['a', 'a', 'b']) {
    const session = await DialogueSession.open({
      id,
      usage,
      board: { workers: new Map() },
      planner: {
        async process() {
          return { ok: true, value: { content: '' } };
        },
      },
      store: {
        async load() {
          return { tasks, conversation: [], pending: [], savedAt: 1 };
        },
        async save() {},
        async delete() {},
      },
    });
    await session.close();
  }
  assert.deepEqual(
    records.map((r) => r.id),
    ['task:a:t1:interrupted', 'task:a:t1:interrupted', 'task:b:t1:interrupted'],
  );
  for (const record of records) {
    assert.equal(record.kind, 'task');
    if (record.kind === 'task') {
      assert.equal(record.endKnown, false);
      assert.equal(record.runMs, undefined);
    }
  }
  const board = new TaskBoard({
    usage,
    boardId: 'c',
    workers: new Map(),
    onEvent() {},
  });
  board.restore(tasks);
  board.restore(tasks);
  board.restore(board.list());
  assert.equal(
    records.filter((r) => r.id === 'task:c:t1:interrupted').length,
    1,
  );
});

test('concurrent workers keep the originating turn and their own task context', async () => {
  const { usage, records } = recorder();
  const releases: (() => void)[] = [];
  const session = await DialogueSession.open({
    id: 's',
    usage,
    board: {
      workers: new Map([
        [
          'w',
          worker(async (input) => {
            await new Promise<void>((resolve) => releases.push(resolve));
            llm(input.usage);
            return { output: '' };
          }),
        ],
      ]),
    },
    planner: {
      async process(_messages, opts) {
        llm(opts.usage);
        if (releases.length === 0) {
          const board = currentPlannerScope()?.board;
          assert.ok(board);
          start(board);
          start(board);
        }
        return { ok: true, value: { content: 'ok' } };
      },
    },
  });
  await session.send('first');
  await tick();
  assert.equal(releases.length, 2);
  await session.send('second');
  for (const release of releases.reverse()) release();
  await tick();
  await session.close();
  const planners = records.filter(
    (r) => r.kind === 'llm.call' && r.context.role === 'planner',
  );
  assert.ok(planners[0].context.turnId);
  assert.notEqual(planners[0].context.turnId, planners[1].context.turnId);
  const workers = records.filter(
    (r) => r.kind === 'llm.call' && r.context.role === 'w',
  );
  assert.deepEqual(workers.map((r) => r.context.taskId).sort(), ['t1', 't2']);
  for (const record of records.filter((r) => r.context.taskId))
    assert.equal(record.context.turnId, planners[0].context.turnId);
});

test('tasks and dialogue work without a recorder', async () => {
  const board = new TaskBoard({
    workers: new Map([
      [
        'w',
        worker(async (input) => {
          assert.equal(input.usage, undefined);
          return { output: 'ok' };
        }),
      ],
    ]),
    onEvent() {},
  });
  const id = start(board);
  await tick();
  assert.equal(board.get(id)?.state, 'done');
  const session = await DialogueSession.open({
    id: 's',
    board: { workers: new Map() },
    planner: {
      async process(_messages, opts) {
        assert.equal(opts.usage, undefined);
        return { ok: true, value: { content: 'ok' } };
      },
    },
  });
  assert.equal((await session.send('hi')).text, 'ok');
  await session.close();
});
