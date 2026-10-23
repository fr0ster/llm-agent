import assert from 'node:assert/strict';

import { test } from 'node:test';

import type { Message } from '@mcp-abap-adt/llm-agent';

import { DialogueSession } from '../dialogue-session.js';

import { InMemoryDialogueStateStore } from '../in-memory-dialogue-state-store.js';

import { PlannerToolsClient } from '../planner-tools-client.js';

function deferred<T = void>() {
  let resolve!: (value: T) => void;

  const promise = new Promise<T>((r) => {
    resolve = r;
  });

  return { promise, resolve };
}

const tick = () => new Promise<void>((r) => setImmediate(r));

const tools = new PlannerToolsClient();

test('several completions during a busy user turn are listed once in order; silent event reply stays in history', async () => {
  const release = deferred();

  const entered = deferred();

  const workers = [
    deferred<{ output: string }>(),

    deferred<{ output: string }>(),
  ];

  const inputs: Message[][] = [];

  let runs = 0;

  let pushes = 0;

  const s = await DialogueSession.open({
    id: 'batch',

    onMessage() {
      pushes++;
    },

    board: {
      workers: new Map([
        [
          'w',

          {
            name: 'w',

            capabilities: { contextPolicy: 'optional' },

            run: () => workers[runs++].promise,
          },
        ],
      ]),
    },

    planner: {
      async process(messages) {
        inputs.push(messages);

        if (inputs.length === 1) {
          await tools.callTool('update_plan', { plan: 'parallel work' });

          await tools.callTool('delegate_task', { worker: 'w', goal: 'first' });

          await tools.callTool('delegate_task', {
            worker: 'w',

            goal: 'second',
          });

          await tick();

          entered.resolve();

          await release.promise;

          return { ok: true, value: { content: 'accepted' } };
        }

        await tools.callTool('update_plan', {
          plan: 'parallel work',

          status: 'done',
        });

        return { ok: true, value: { content: '  NO_MESSAGE\n' } };
      },
    },
  });

  const sent = s.send('go');

  await entered.promise;

  workers[1].resolve({ output: 'second output' });

  await tick();

  workers[0].resolve({ output: 'first output' });

  await tick();

  release.resolve();

  await sent;

  await tick();

  assert.equal(inputs.length, 2);

  assert.match(String(inputs[1].at(-1)?.content), /\[plan\]\nparallel work/);

  const note = String(inputs[1].at(-1)?.content);

  assert.equal((note.match(/task t\d+ \(w\) done:/g) ?? []).length, 2);

  assert.ok(
    note.indexOf('task t2 (w) done') < note.indexOf('task t1 (w) done'),
  );

  assert.equal(pushes, 0);

  assert.deepEqual(s.takePending(), []);

  assert.equal(s.snapshot().conversation.at(-2)?.content, '  NO_MESSAGE\n');

  await s.close();
});

test('planner errors reject only their send and the next queued turn still runs', async () => {
  let calls = 0;

  const s = await DialogueSession.open({
    id: 'error',

    board: { workers: new Map() },

    planner: {
      async process() {
        if (++calls === 1)
          return { ok: false, error: new Error('planner failed') };

        return { ok: true, value: { content: 'recovered' } };
      },
    },
  });

  const first = assert.rejects(s.send('first'), /planner failed/);

  const second = s.send('second');

  await first;

  assert.equal((await second).text, 'recovered');

  await s.close();
});

test('send answers in scope, records plan, forwards options and preserves user NO_MESSAGE', async () => {
  const signal = new AbortController().signal;

  const s = await DialogueSession.open({
    id: 's',

    board: { workers: new Map() },

    planner: {
      async process(messages, opts) {
        assert.equal(messages.at(-1)?.content, '[tasks]\nnone\nhello');

        assert.equal(opts.signal, signal);

        await tools.callTool('update_plan', { plan: 'plan' });

        return { ok: true, value: { content: 'NO_MESSAGE' } };
      },
    },
  });

  assert.equal((await s.send('hello', { signal })).text, 'NO_MESSAGE');

  assert.equal(s.snapshot().plan, 'plan');

  assert.equal(s.snapshot().conversation.length, 3);

  await s.close();
});

test('delegation returns before completion; busy events coalesce; users precede events and keep their own reply', async () => {
  const work1 = deferred<{ output: string }>();

  const work2 = deferred<{ output: string }>();

  const eventEntered = deferred();

  const eventRelease = deferred();

  const inputs: Message[][] = [];

  const delivered: string[] = [];

  const worker = (name: string, run: () => Promise<{ output: string }>) =>
    [
      name,

      { name, capabilities: { contextPolicy: 'optional' as const }, run },
    ] as const;

  const s = await DialogueSession.open({
    id: 's',

    onMessage: (m) => delivered.push(m.text),

    board: {
      workers: new Map([
        worker('w1', () => work1.promise),

        worker('w2', () => work2.promise),
      ]),
    },

    planner: {
      async process(messages) {
        inputs.push(structuredClone(messages));

        if (inputs.length === 1) {
          await tools.callTool('delegate_task', {
            worker: 'w1',

            goal: 'goal one',
          });

          await tools.callTool('delegate_task', {
            worker: 'w2',

            goal: 'goal two',
          });

          return { ok: true, value: { content: 'delegated' } };
        }

        if (inputs.length === 2) {
          eventEntered.resolve();

          await eventRelease.promise;
        }

        return {
          ok: true,

          value: {
            content: String(messages.at(-1)?.content).includes('[task events]')
              ? 'progress'
              : 'user answer',
          },
        };
      },
    },
  });

  // Delegation returns at once; a task start never wakes the planner.

  assert.equal((await s.send('go')).text, 'delegated');

  await tick();

  assert.equal(inputs.length, 1);

  work1.resolve({ output: 'x'.repeat(5000) });

  await eventEntered.promise;

  assert.match(
    String(inputs[1].at(-1)?.content),

    /task t1 \(w1\) done: goal one/,
  );

  const user = s.send('question');

  work2.resolve({ output: 'two' });

  await tick();

  eventRelease.resolve();

  assert.equal((await user).text, 'user answer');

  await tick();

  assert.ok(String(inputs[2].at(-1)?.content).endsWith('question'));

  const note = String(inputs[3].at(-1)?.content);

  assert.match(note, /task t2 \(w2\) done: goal two/);

  assert.doesNotMatch(note, /task t1/);

  assert.equal(
    (String(inputs[1].at(-1)?.content).match(/\[cut:/g) ?? []).length,

    1,
  );

  assert.equal(s.takePending().length, 2);

  assert.deepEqual(s.takePending(), []);

  assert.equal(delivered.length, 2);

  await s.close();
});

test('restore interrupts tasks, restart note appears once and NO_MESSAGE is recorded silently', async () => {
  const store = new InMemoryDialogueStateStore();

  await store.save('s', {
    conversation: [],

    pending: [],

    savedAt: 0,

    tasks: [
      { id: 't1', worker: 'w', goal: 'g', state: 'running', createdAt: 0 },
    ],
  });

  const inputs: Message[][] = [];

  const s = await DialogueSession.open({
    id: 's',

    store,

    board: { workers: new Map() },

    planner: {
      async process(m) {
        inputs.push(m);

        return { ok: true, value: { content: 'ok' } };
      },
    },
  });

  assert.equal(s.snapshot().tasks[0].state, 'interrupted');

  await s.send('first');

  await s.send('second');

  assert.match(
    String(inputs[0].at(-1)?.content),

    /\[restart\] interrupted tasks: t1/,
  );

  assert.ok(String(inputs[1].at(-1)?.content).endsWith('second'));

  assert.equal((await store.load('s'))?.conversation.length, 5);

  await s.close();

  assert.equal(await store.load('s'), undefined);
});

test('close stops tasks, waits for active turn, rejects queued sends and never saves its result', async () => {
  const work = deferred<{
    output: string;

    status: 'complete';

    stopped: true;
  }>();

  const entered = deferred();

  const release = deferred();

  const store = new InMemoryDialogueStateStore();

  let stopped = false;

  let calls = 0;

  const s = await DialogueSession.open({
    id: 's',

    store,

    board: {
      workers: new Map([
        [
          'w',

          {
            name: 'w',

            capabilities: { contextPolicy: 'optional' },

            async run(input) {
              input.stopSignal?.addEventListener('abort', () => {
                stopped = true;
              });

              return work.promise;
            },
          },
        ],
      ]),
    },

    planner: {
      async process() {
        calls++;

        await tools.callTool('delegate_task', { worker: 'w', goal: 'g' });

        await tick();

        entered.resolve();

        await release.promise;

        return { ok: true, value: { content: 'finished' } };
      },
    },
  });

  const active = s.send('go');

  await entered.promise;

  const queued = assert.rejects(s.send('queued'), /dialogue session closed/);

  const closing = s.close();

  await tick();

  assert.equal(stopped, true);

  work.resolve({ output: 'partial', status: 'complete', stopped: true });

  release.resolve();

  await Promise.all([active, queued, closing]);

  assert.equal(calls, 1);

  assert.equal(await store.load('s'), undefined);

  await assert.rejects(s.send('late'), /dialogue session closed/);
});

test('history is bounded, snapshots and memory store are isolated, save errors are swallowed', async () => {
  const store = new InMemoryDialogueStateStore();

  let saves = 0;

  const s = await DialogueSession.open({
    id: 's',

    store: {
      load: (id) => store.load(id),

      delete: (id) => store.delete(id),

      async save() {
        saves++;

        throw new Error('offline');
      },
    },

    board: { workers: new Map() },

    planner: {
      async process() {
        return { ok: true, value: { content: 'ok' } };
      },
    },
  });

  for (let i = 0; i < 110; i++) await s.send(String(i));

  assert.equal(s.snapshot().conversation.length, 199);

  assert.equal(saves, 110);

  const history = s.snapshot().conversation;

  assert.equal(history[0].role, 'user');

  assert.ok(!String(history[0].content).startsWith('[actions]'));

  for (let i = 1; i < history.length; i++)
    assert.notEqual(history[i].role, history[i - 1].role);

  const snapshot = s.snapshot();

  snapshot.conversation.length = 0;

  assert.equal(s.snapshot().conversation.length, 199);

  await store.save('copy', s.snapshot());

  const loaded = await store.load('copy');

  assert.ok(loaded);

  loaded.pending.push({ id: 'x', text: 'x', trigger: 'event', createdAt: 0 });

  assert.deepEqual((await store.load('copy'))?.pending, []);

  await s.close();
});

test('plan tool state is injected before the last input, survives trimming and restore, and is never conversation history', async () => {
  const store = new InMemoryDialogueStateStore();

  const inputs: Message[][] = [];

  const options = {
    id: 'plan',

    store,

    board: { workers: new Map() },

    planner: {
      async process(messages: Message[]) {
        inputs.push(messages);

        if (inputs.length === 1)
          await tools.callTool('update_plan', { plan: 'remember this' });

        return { ok: true as const, value: { content: 'ok' } };
      },
    },
  };

  const s = await DialogueSession.open(options);

  await s.send('set');

  assert.equal(inputs[0].at(-1)?.content, '[tasks]\nnone\nset');

  for (let i = 0; i < 105; i++) await s.send(`next ${i}`);

  for (const input of inputs.slice(1)) {
    assert.match(String(input.at(-1)?.content), /\[plan\]\nremember this/);
  }

  assert.ok(
    s

      .snapshot()

      .conversation.every((m) => !String(m.content).includes('[plan]')),
  );

  const restored = await DialogueSession.open(options);

  await restored.send('restored');

  assert.match(
    String(inputs.at(-1)?.at(-1)?.content),

    /\[plan\]\nremember this/,
  );

  await restored.close();

  await s.close();
});

test('draining pending persists an acknowledgement after an in-flight save without concurrent writes', async () => {
  const backing = new InMemoryDialogueStateStore();

  const entered = deferred();

  const release = deferred();

  let saving = false;

  let saves = 0;

  await backing.save('ack', {
    conversation: [],

    tasks: [],

    savedAt: 0,

    pending: [{ id: 'p', text: 'delivered', trigger: 'event', createdAt: 0 }],
  });

  const options = {
    id: 'ack',

    board: { workers: new Map() },

    store: {
      load: (id: string) => backing.load(id),

      delete: (id: string) => backing.delete(id),

      async save(
        id: string,

        state: import('@mcp-abap-adt/llm-agent').DialogueState,
      ) {
        assert.equal(saving, false, 'saves must be serialized');

        saving = true;

        if (++saves === 1) {
          entered.resolve();

          await release.promise;
        }

        await backing.save(id, state);

        saving = false;
      },
    },

    planner: {
      async process() {
        return { ok: true as const, value: { content: 'ok' } };
      },
    },
  };

  const s = await DialogueSession.open(options);

  const sent = s.send('save');

  await entered.promise;

  assert.equal(s.takePending().length, 1);

  release.resolve();

  await sent;

  await tick();

  assert.equal(saves, 2);

  const reopened = await DialogueSession.open(options);

  assert.deepEqual(reopened.takePending(), []);

  await reopened.close();

  await s.close();
});

test('draining pending saves even without another turn and swallows save failure', async () => {
  const store = new InMemoryDialogueStateStore();

  await store.save('drain', {
    conversation: [],

    tasks: [],

    savedAt: 0,

    pending: [{ id: 'p', text: 'p', trigger: 'event', createdAt: 0 }],
  });

  const options = {
    id: 'drain',

    store,

    board: { workers: new Map() },

    planner: {
      async process() {
        return { ok: true as const, value: { content: 'ok' } };
      },
    },
  };

  const s = await DialogueSession.open(options);

  assert.equal(s.takePending().length, 1);

  await tick();

  const reopened = await DialogueSession.open(options);

  assert.deepEqual(reopened.takePending(), []);

  let warnings = 0;

  await store.save('failed-drain', {
    ...s.snapshot(),

    pending: [{ id: 'failed-ack', text: 'p', trigger: 'event', createdAt: 0 }],
  });

  const failing = await DialogueSession.open({
    ...options,

    id: 'failed-drain',

    logger: {
      warn() {
        warnings++;
      },
    },

    store: {
      ...options.store,

      load: (id) => store.load(id),

      delete: (id) => store.delete(id),

      async save() {
        throw new Error('offline');
      },
    },
  });

  assert.equal(failing.takePending().length, 1);

  await tick();

  assert.equal(warnings, 1);

  await Promise.all([s.close(), reopened.close(), failing.close()]);
});

test('close stops and settles a task delegated by an already in-flight turn without an event turn', async () => {
  const entered = deferred();

  const delegate = deferred();

  const started = deferred();

  const stopped = deferred();

  const settle = deferred();

  let calls = 0;

  let closed = false;

  const s = await DialogueSession.open({
    id: 'close-delegate',

    board: {
      workers: new Map([
        [
          'w',

          {
            name: 'w',

            capabilities: { contextPolicy: 'optional' },

            async run(input) {
              input.stopSignal?.addEventListener('abort', () =>
                stopped.resolve(),
              );

              started.resolve();

              await settle.promise;

              return { output: 'partial', status: 'complete', stopped: true };
            },
          },
        ],
      ]),
    },

    planner: {
      async process() {
        calls++;

        entered.resolve();

        await delegate.promise;

        await tools.callTool('delegate_task', { worker: 'w', goal: 'late' });

        await started.promise;

        return { ok: true, value: { content: 'delegated' } };
      },
    },
  });

  const sent = s.send('go');

  await entered.promise;

  const closing = s.close().then(() => {
    closed = true;
  });

  delegate.resolve();

  await stopped.promise;

  assert.equal(closed, false);

  settle.resolve();

  await Promise.all([sent, closing]);

  await tick();

  assert.equal(s.snapshot().tasks[0].state, 'stopped');

  assert.equal(calls, 1);

  assert.deepEqual(s.takePending(), []);
});

test('open restores queued tasks as interrupted and explains them on the next turn without rerunning', async () => {
  const store = new InMemoryDialogueStateStore();

  await store.save('queued', {
    conversation: [],

    pending: [],

    savedAt: 0,

    tasks: [
      {
        id: 't7',

        worker: 'w',

        goal: 'queued goal',

        state: 'queued',

        createdAt: 0,
      },
    ],
  });

  let runs = 0;

  const s = await DialogueSession.open({
    id: 'queued',

    store,

    board: {
      workers: new Map([
        [
          'w',

          {
            name: 'w',

            capabilities: { contextPolicy: 'optional' },

            async run() {
              runs++;

              return { output: 'unexpected' };
            },
          },
        ],
      ]),
    },

    planner: {
      async process(input) {
        assert.match(
          String(input.at(-1)?.content),

          /\[restart\] interrupted tasks: t7/,
        );

        return { ok: true, value: { content: 'checking' } };
      },
    },
  });

  assert.equal(s.snapshot().tasks[0].state, 'interrupted');

  await s.send('continue');

  assert.equal(runs, 0);

  await s.close();
});

test('tasks snapshot includes only the recent thirty tasks and bounded single-line goals', async () => {
  const store = new InMemoryDialogueStateStore();

  await store.save('board', {
    conversation: [],

    pending: [],

    savedAt: 0,

    tasks: Array.from({ length: 32 }, (_, i) => ({
      id: `t${i + 1}`,

      worker: 'w',

      state: 'done' as const,

      goal: `goal\n${'x'.repeat(100)}`,

      createdAt: i,
    })),
  });

  const s = await DialogueSession.open({
    id: 'board',

    store,

    board: { workers: new Map() },

    planner: {
      async process(messages) {
        const note = String(messages.at(-1)?.content);

        assert.ok(note.startsWith('[tasks]\nt3 (w) done: goal '));

        assert.match(note, /2 older tasks omitted/);

        assert.equal(note.split('\n').length, 33);

        assert.ok(note.split('\n')[1].length < 110);

        return { ok: true, value: { content: 'ok' } };
      },
    },
  });

  await s.send('board');

  await s.close();
});

test('content waits for acceptance while progress stays live; failed drafts never stream', async () => {
  const emitted: import('@mcp-abap-adt/llm-agent').StreamChunk[] = [];
  let fail = true;
  const s = await DialogueSession.open({
    id: 'stream',
    board: { workers: new Map() },
    planner: {
      async process(_messages, opts) {
        opts.onPartial?.({
          kind: 'content',
          delta: fail ? 'rejected' : 'accepted',
        });
        assert.ok(!emitted.some((chunk) => chunk.kind === 'content'));
        opts.onPartial?.({
          kind: 'stepper-done',
          source: { stepperId: 's', name: 'test' },
          ok: true,
        });
        assert.equal(emitted.at(-1)?.kind, 'stepper-done');
        if (fail) return { ok: false, error: new Error('failed draft') };
        return { ok: true, value: { content: 'accepted' } };
      },
    },
  });
  await assert.rejects(
    s.send('go', { onPartial: (chunk) => emitted.push(chunk) }),
    /failed draft/,
  );
  fail = false;
  assert.equal(
    (await s.send('retry', { onPartial: (chunk) => emitted.push(chunk) })).text,
    'accepted',
  );
  assert.deepEqual(
    emitted
      .filter((chunk) => chunk.kind === 'content')
      .map((chunk) => chunk.delta),
    ['accepted'],
  );
  await s.close();
});

for (const status of [undefined, 'active', 'waiting_user', 'done'] as const) {
  test(`event idle uses persisted status ${status}; user prose never triggers checks`, async () => {
    const store = new InMemoryDialogueStateStore();
    await store.save('status', {
      conversation: [
        { role: 'user', content: 'legacy' },
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: 'legacy note' },
        { role: 'user', content: 'adjacent' },
      ],
      plan: 'next',
      ...(status ? { planStatus: status } : {}),
      tasks: [],
      pending: [],
      savedAt: 0,
    });
    const work = deferred<{ output: string }>();
    const inputs: Message[][] = [];
    const warnings: string[] = [];
    const s = await DialogueSession.open({
      id: 'status',
      store,
      logger: { warn: (message) => warnings.push(message) },
      board: {
        workers: new Map([
          [
            'w',
            {
              name: 'w',
              capabilities: { contextPolicy: 'optional' },
              run: () => work.promise,
            },
          ],
        ]),
      },
      planner: {
        async process(messages) {
          inputs.push(messages);
          for (let i = 1; i < messages.length; i++)
            assert.notEqual(messages[i].role, messages[i - 1].role);
          if (inputs.length === 1)
            await tools.callTool('delegate_task', { worker: 'w', goal: 'go' });
          return { ok: true, value: { content: 'NO_MESSAGE t999 secret' } };
        },
      },
    });
    await s.send('go');
    assert.equal(inputs.length, 1);
    assert.equal(s.snapshot().planStatus, status ?? 'active');
    work.resolve({ output: 'done' });
    await tick();
    await tick();
    assert.equal(
      inputs.length,
      status === 'waiting_user' || status === 'done' ? 2 : 4,
    );
    assert.equal(
      warnings.length,
      status === 'waiting_user' || status === 'done' ? 0 : 1,
    );
    assert.ok(
      warnings.every(
        (warning) => !warning.includes('secret') && !warning.includes('t999'),
      ),
    );
    assert.equal((await store.load('status'))?.planStatus, status ?? 'active');
    await s.close();
  });
}

for (const maxCorrections of [0, 1, 2]) {
  test(`idle bound ${maxCorrections} and silent replies do not imply completion`, async () => {
    const work = deferred<{ output: string }>();
    let calls = 0;
    const s = await DialogueSession.open({
      id: 'bound',
      maxCorrections,
      board: {
        workers: new Map([
          [
            'w',
            {
              name: 'w',
              capabilities: { contextPolicy: 'optional' },
              run: () => work.promise,
            },
          ],
        ]),
      },
      planner: {
        async process() {
          if (++calls === 1) {
            await tools.callTool('update_plan', { plan: '' });
            await tools.callTool('delegate_task', {
              worker: 'w',
              goal: 'first',
            });
          }
          return { ok: true, value: { content: 'NO_MESSAGE' } };
        },
      },
    });
    await s.send('go');
    work.resolve({ output: 'done' });
    await tick();
    await tick();
    assert.equal(calls, 2 + maxCorrections);
    await s.close();
  });
}

test('correction consumes new events, preserves whole-turn actions and counts earlier starts', async () => {
  const first = deferred<{ output: string }>();
  const second = deferred<{ output: string }>();
  const third = deferred<{ output: string }>();
  let runs = 0;
  let calls = 0;
  const inputs: Message[][] = [];
  const s = await DialogueSession.open({
    id: 'events',
    board: {
      workers: new Map([
        [
          'w',
          {
            name: 'w',
            capabilities: { contextPolicy: 'optional' },
            run: () => [first, second, third][runs++].promise,
          },
        ],
      ]),
    },
    planner: {
      async process(messages) {
        inputs.push(messages);
        calls++;
        if (calls === 1) {
          await tools.callTool('update_plan', { plan: 'steps' });
          await tools.callTool('delegate_task', { worker: 'w', goal: 'first' });
          await tools.callTool('delegate_task', {
            worker: 'w',
            goal: 'second',
          });
        } else if (calls === 2) {
          await tools.callTool('update_plan', { plan: 'continue' });
          second.resolve({ output: 'second result' });
          await tick();
        } else if (calls === 3) {
          const note = String(messages.at(-1)?.content);
          assert.match(note, /\[check\]/);
          assert.match(note, /task t2 \(w\) done: second . second result/);
          assert.match(note, /\[actions\] plan updated/);
          await tools.callTool('delegate_task', { worker: 'w', goal: 'third' });
          third.resolve({ output: 'third result' });
          await tick();
        } else {
          await tools.callTool('update_plan', {
            plan: 'complete',
            status: 'done',
          });
        }
        return {
          ok: true,
          value: { content: calls === 2 ? 'draft' : 'accepted' },
        };
      },
    },
  });
  await s.send('go');
  first.resolve({ output: 'first result' });
  await tick();
  await tick();
  await tick();
  assert.equal(calls, 4); // The third task's outcome gets its own event turn, never another correction.
  assert.ok(
    !inputs
      .slice(3)
      .some((messages) =>
        String(messages.at(-1)?.content).includes('task t2 (w) done:'),
      ),
  );
  assert.ok(
    s
      .snapshot()
      .conversation.some((message) =>
        String(message.content).includes(
          '[actions] plan updated, started t3 (w)',
        ),
      ),
  );
  assert.deepEqual(
    s.takePending().map((message) => message.text),
    ['accepted', 'accepted'],
  );
  assert.equal(runs, 3);
  await s.close();
});
