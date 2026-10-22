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
  const note = String(inputs[1].at(-1)?.content);
  assert.equal((note.match(/ done:/g) ?? []).length, 2);
  assert.ok(note.indexOf('t2 (w) done') < note.indexOf('t1 (w) done'));
  assert.equal(pushes, 0);
  assert.deepEqual(s.takePending(), []);
  assert.equal(s.snapshot().conversation.at(-1)?.content, '  NO_MESSAGE\n');
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
        assert.equal(messages.at(-1)?.content, 'hello');
        assert.equal(opts.signal, signal);
        await tools.callTool('update_plan', { plan: 'plan' });
        return { ok: true, value: { content: 'NO_MESSAGE' } };
      },
    },
  });
  assert.equal((await s.send('hello', { signal })).text, 'NO_MESSAGE');
  assert.equal(s.snapshot().plan, 'plan');
  assert.equal(s.snapshot().conversation.length, 2);
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
            content: String(messages.at(-1)?.content).startsWith(
              '[task events]',
            )
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
  assert.equal(inputs[2].at(-1)?.content, 'question');
  const note = String(inputs[3].at(-1)?.content);
  assert.match(note, /task t2 \(w2\) done: goal two/);
  assert.doesNotMatch(note, /t1/);
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
    /^\[restart\] interrupted tasks: t1/,
  );
  assert.equal(inputs[1].at(-1)?.content, 'second');
  assert.equal((await store.load('s'))?.conversation.length, 4);
  await s.close();
  assert.equal(await store.load('s'), undefined);
});

test('close stops tasks, waits for active turn, rejects queued sends and never saves its result', async () => {
  const work = deferred<{ output: string; status: 'stopped' }>();
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
  work.resolve({ output: 'partial', status: 'stopped' });
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
  assert.equal(s.snapshot().conversation.length, 200);
  assert.equal(saves, 110);
  const snapshot = s.snapshot();
  snapshot.conversation.length = 0;
  assert.equal(s.snapshot().conversation.length, 200);
  await store.save('copy', s.snapshot());
  const loaded = await store.load('copy');
  assert.ok(loaded);
  loaded.pending.push({ id: 'x', text: 'x', trigger: 'event', createdAt: 0 });
  assert.deepEqual((await store.load('copy'))?.pending, []);
  await s.close();
});
