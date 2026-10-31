import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  AnySignal,
  DialogueSignals,
  DialogueState,
  ISignalEmitter,
} from '@mcp-abap-adt/llm-agent';
import { createSignalBus } from '../../../../../llm-signals/src/index.js';
import { DialogueSession } from '../dialogue-session.js';
import { PlannerToolsClient } from '../planner-tools-client.js';
import { TaskBoard } from '../task-board.js';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const tools = new PlannerToolsClient();
const reply = { ok: true as const, value: { content: 'ok' } };
function harness() {
  const bus = createSignalBus<DialogueSignals>();
  const signals: AnySignal<DialogueSignals>[] = [];
  bus.onAny((s) => {
    signals.push(s);
  });
  return { bus, signals };
}
test('open restores every task before activity and plan, including interrupted tasks', async () => {
  for (const restore of [false, true]) {
    const { bus, signals } = harness();
    const state: DialogueState = {
      conversation: [],
      pending: [],
      savedAt: 1,
      tasks: [
        { id: 'a', worker: 'w', goal: 'a', state: 'done', createdAt: 1 },
        { id: 'b', worker: 'w', goal: 'b', state: 'running', createdAt: 1 },
      ],
      plan: { version: 1, status: 'active', steps: [] },
    };
    const session = await DialogueSession.open({
      id: 's',
      signals: bus,
      board: { workers: new Map() },
      planner: {
        async process() {
          return reply;
        },
      },
      store: restore
        ? {
            async load() {
              return state;
            },
            async save() {},
            async delete() {},
          }
        : undefined,
    });
    assert.deepEqual(
      signals.map((s) => s.name),
      restore
        ? [
            'dialogue.task.state',
            'dialogue.task.state',
            'dialogue.activity',
            'dialogue.plan.changed',
          ]
        : ['dialogue.activity'],
    );
    if (restore) {
      assert.equal(
        bus.last('dialogue.task.state', 's', 'b')?.payload.task.state,
        'interrupted',
      );
      assert.equal(
        bus.last('dialogue.task.state', 's', 'a')?.payload.previous,
        undefined,
      );
    }
    await session.close();
    assert.equal(signals.at(-1)?.name, 'dialogue.session.closed');
    assert.deepEqual(bus.lastAll('s'), []);
  }
});
test('settled occurs after final persistence, failed planners settle, pending saves do not', async () => {
  const { bus, signals } = harness();
  const order: string[] = [];
  bus.on('dialogue.turn.settled', () => {
    order.push('settled');
  });
  let fail = false;
  const session = await DialogueSession.open({
    id: 's',
    signals: bus,
    board: { workers: new Map() },
    planner: {
      async process() {
        if (fail) throw Error('planner');
        return reply;
      },
    },
    store: {
      async load() {
        return undefined;
      },
      async save() {
        order.push('save');
        throw Error('store');
      },
      async delete() {},
    },
  });
  await session.send('hello');
  assert.deepEqual(order, ['save', 'settled']);
  session.takePending();
  await tick();
  assert.equal(
    signals.filter((s) => s.name === 'dialogue.turn.settled').length,
    1,
  );
  fail = true;
  await assert.rejects(session.send('fail'));
  assert.deepEqual(order, ['save', 'settled', 'save', 'save', 'settled']);
  const settled = bus.last('dialogue.turn.settled', 's')?.payload;
  assert.equal(settled?.outcome, 'failed');
  assert.equal(settled?.messageId, undefined);
  await session.close();
});
test('close cuts a turn without settlement and retires after final signal', async () => {
  const { bus, signals } = harness();
  const entered = deferred<void>();
  const finish = deferred<void>();
  let retainedAtClose = false;
  bus.on('dialogue.session.closed', () => {
    retainedAtClose = bus.last('dialogue.activity', 's') !== undefined;
  });
  const session = await DialogueSession.open({
    id: 's',
    signals: bus,
    board: { workers: new Map() },
    planner: {
      async process() {
        entered.resolve();
        await finish.promise;
        return reply;
      },
    },
  });
  const send = session.send('hello');
  await entered.promise;
  const close = session.close();
  finish.resolve();
  await close;
  await send;
  assert.equal(
    signals.filter((s) => s.name === 'dialogue.turn.settled').length,
    0,
  );
  assert.ok(retainedAtClose);
  assert.deepEqual(bus.lastAll('s'), []);
});
test('real board emits queued tasks before pool execution, cancellation and all transitions', async () => {
  const { bus } = harness();
  const released = deferred<() => void>();
  const board = new TaskBoard({
    source: 's',
    signals: bus,
    onEvent() {},
    pool: {
      acquire() {
        return released.promise;
      },
    },
    workers: new Map([
      [
        'w',
        {
          name: 'w',
          capabilities: { contextPolicy: 'optional' },
          async run() {
            return { output: 'done' };
          },
        },
      ],
    ]),
  });
  board.start({ worker: 'w', goal: 'a' });
  board.start({ worker: 'w', goal: 'b' });
  assert.deepEqual(
    bus
      .lastAll('s')
      .map((s) => s.name === 'dialogue.task.state' && s.payload.task.state),
    ['queued', 'queued'],
  );
  board.stop('t2');
  assert.equal(
    bus.last('dialogue.task.state', 's', 't2')?.payload.previous,
    'queued',
  );
  released.resolve(() => {});
  await tick();
  assert.equal(
    bus.last('dialogue.task.state', 's', 't1')?.payload.task.state,
    'done',
  );
  assert.equal(
    bus.last('dialogue.task.state', 's', 't1')?.payload.previous,
    'running',
  );
  await board.stopAll();
});
test('event turns settle after onMessage and NO_MESSAGE still settles', async () => {
  for (const silent of [false, true]) {
    const { bus, signals } = harness();
    const worker = deferred<{ output: string }>();
    const order: string[] = [];
    bus.on('dialogue.turn.settled', (s) => {
      if (s.payload.trigger === 'event') order.push('settled');
    });
    let calls = 0;
    const session = await DialogueSession.open({
      id: 's',
      signals: bus,
      onMessage() {
        order.push('message');
      },
      board: {
        workers: new Map([
          [
            'w',
            {
              name: 'w',
              capabilities: { contextPolicy: 'optional' },
              run() {
                return worker.promise;
              },
            },
          ],
        ]),
      },
      planner: {
        async process() {
          if (++calls === 1) {
            await tools.callTool('delegate_task', {
              worker: 'w',
              goal: 'task',
            });
            return reply;
          }
          return {
            ok: true,
            value: { content: silent ? 'NO_MESSAGE' : 'finished' },
          };
        },
      },
    });
    await session.send('go');
    worker.resolve({ output: 'done' });
    await tick();
    await tick();
    assert.deepEqual(order, silent ? ['settled'] : ['message', 'settled']);
    assert.equal(
      signals.filter((s) => s.name === 'dialogue.turn.started').length,
      2,
    );
    await session.close();
  }
});
test('plan total changes emit and ready stays visible after corrections are exhausted; payloads are copies', async () => {
  const { bus, signals } = harness();
  const emitter: ISignalEmitter<DialogueSignals> = {
    emit(name, payload, source, key) {
      bus.emit(name, structuredClone(payload), source, key);
      if (name === 'dialogue.task.state')
        (payload as DialogueSignals['dialogue.task.state']).task.goal =
          'mutated';
    },
    retire(source) {
      bus.retire(source);
    },
  };
  let calls = 0;
  const session = await DialogueSession.open({
    id: 's',
    signals: emitter,
    maxCorrections: 1,
    board: { workers: new Map() },
    planner: {
      async process() {
        calls++;
        await tools.callTool('plan_update', {
          steps: [
            { id: 'a', goal: 'a' },
            ...(calls > 1 ? [{ id: 'b', goal: 'b' }] : []),
          ],
        });
        return reply;
      },
    },
  });
  await session.send('go');
  assert.equal(calls, 2);
  assert.equal(bus.last('dialogue.activity', 's')?.payload.ready, 2);
  assert.deepEqual(
    signals
      .filter((s) => s.name === 'dialogue.plan.changed')
      .map((s) => s.payload.total),
    [1, 2],
  );
  assert.equal(
    signals.filter((s) => s.name === 'dialogue.turn.settled').length,
    1,
  );
  await session.close();
  const board = new TaskBoard({
    source: 'b',
    signals: emitter,
    onEvent() {},
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
  });
  board.start({ worker: 'w', goal: 'original' });
  await tick();
  assert.equal(board.get('t1')?.goal, 'original');
  await board.stopAll();
});

test('throwing session emitters preserve successful and failed sends and retirement', async () => {
  for (const throwing of [false, true]) {
    const warnings: string[] = [];
    const retired: string[] = [];
    let fail = false;
    const session = await DialogueSession.open({
      id: 's',
      signals: throwing
        ? {
            emit(name) {
              if (
                name === 'dialogue.turn.started' ||
                name === 'dialogue.session.closed'
              )
                throw Error('private payload contents');
            },
            retire(source) {
              retired.push(source);
              throw Error('private payload contents');
            },
          }
        : undefined,
      logger: {
        warn(message) {
          warnings.push(message);
        },
      },
      board: { workers: new Map() },
      planner: {
        async process() {
          if (fail) throw Error('planner');
          return reply;
        },
      },
    });
    assert.equal((await session.send('hello')).text, 'ok');
    fail = true;
    await assert.rejects(session.send('fail'), /planner/);
    await session.close();
    assert.deepEqual(retired, throwing ? ['s'] : []);
    assert.equal(warnings.length, throwing ? 4 : 0);
    assert.ok(warnings.every((message) => !message.includes('private')));
  }
});

test('throwing initial task signal does not prevent start or worker execution', async () => {
  for (const throwing of [false, true]) {
    let runs = 0;
    let changes = 0;
    const warnings: string[] = [];
    const board = new TaskBoard({
      signals: throwing
        ? {
            emit(name, payload) {
              if (
                name === 'dialogue.task.state' &&
                (payload as DialogueSignals['dialogue.task.state']).task
                  .state === 'queued'
              )
                throw Error('private payload contents');
            },
            retire() {},
          }
        : undefined,
      logger: {
        warn(message) {
          warnings.push(message);
          throw Error('logger');
        },
      },
      onStateChange() {
        changes++;
      },
      onEvent() {},
      now: () => 1,
      workers: new Map([
        [
          'w',
          {
            name: 'w',
            capabilities: { contextPolicy: 'optional' },
            async run() {
              runs++;
              return { output: 'done' };
            },
          },
        ],
      ]),
    });
    const result = board.start({ worker: 'w', goal: 'task' });
    assert.ok(result.ok);
    await tick();
    assert.equal(runs, 1);
    assert.equal(changes, 3);
    assert.equal(board.get('t1')?.state, 'done');
    assert.equal(board.get('t1')?.output, 'done');
    assert.equal(warnings.length, throwing ? 1 : 0);
    assert.ok(warnings.every((message) => !message.includes('private')));
    await board.stopAll();
  }
});
