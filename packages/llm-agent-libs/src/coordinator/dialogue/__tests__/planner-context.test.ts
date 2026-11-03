import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  DialoguePlan,
  DialogueState,
  Message,
  PlannerRequestRecord,
} from '@mcp-abap-adt/llm-agent';
import { DialogueSession } from '../dialogue-session.js';
import { InMemoryDialogueStateStore } from '../in-memory-dialogue-state-store.js';
import {
  appendRequestMessage,
  DefaultPlannerContextBuilder,
} from '../planner-context-builder.js';
import { PlannerToolsClient } from '../planner-tools-client.js';

const tools = new PlannerToolsClient();
const builder = new DefaultPlannerContextBuilder();
const record = (): PlannerRequestRecord => ({
  id: 'r1',
  openedAt: 1,
  text: 'first',
  transcript: [{ role: 'user', content: 'first' }],
});
const project = (open: PlannerRequestRecord): Message[] =>
  builder.build({ open, memory: [], knowledge: [], notes: [] });
const size = (messages: readonly Message[]): number =>
  messages.reduce((sum, message) => sum + (message.content?.length ?? 0), 0);
const tick = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

function state(plan?: DialoguePlan): DialogueState {
  return {
    conversation: [{ role: 'user', content: 'legacy input' }],
    plan,
    tasks: [],
    pending: [],
    savedAt: 1,
  };
}

test('builder preserves fresh messages, omits empty blocks, adds notes and does not mutate input', () => {
  const open = record();
  const before = structuredClone(open);
  assert.deepEqual(project(open), open.transcript);
  assert.deepEqual(
    builder.build({ open, memory: [], knowledge: [], notes: ['[plan] none'] }),
    [{ role: 'user', content: '[plan] none\nfirst' }],
  );
  assert.deepEqual(open, before);
  assert.deepEqual(builder.build({ memory: [], knowledge: [], notes: [] }), []);
});

test('projection preserves assistant replies and user inputs verbatim', () => {
  const open = record();
  open.transcript[0].content = `FIRST${'a'.repeat(30_000)}`;
  for (let i = 0; i < 12; i++)
    appendRequestMessage(open, {
      role: i % 2 ? 'assistant' : 'user',
      content: `middle ${i} ${'b'.repeat(10_000)}`,
    });
  appendRequestMessage(open, {
    role: 'user',
    content: `NOTE${'c'.repeat(30_000)}`,
  });
  appendRequestMessage(open, { role: 'user', content: 'LATEST' });
  const before = structuredClone(open);
  const messages = project(open);
  const text = messages.map((message) => message.content).join('');
  for (const message of open.transcript ?? [])
    assert.ok(text.includes(message.content ?? ''));
  assert.match(text, /^FIRST/);
  assert.ok(text.includes(open.transcript?.[0].content ?? ''));
  assert.ok(text.includes(`middle 11 ${'b'.repeat(10_000)}`));
  assert.match(text, /NOTE/);
  assert.match(text, /LATEST$/);
  for (let i = 1; i < messages.length; i++)
    assert.notEqual(messages[i].role, messages[i - 1].role);
  assert.deepEqual(open, before);
});

test('storage bounds retain first and newest, count dropped parts and visibly cut oversized messages', () => {
  const open = record();
  open.transcript = [];
  appendRequestMessage(open, { role: 'user', content: 'a'.repeat(200_000) });
  for (let i = 0; i < 450; i++)
    appendRequestMessage(open, { role: 'user', content: `part ${i}` });
  appendRequestMessage(open, {
    role: 'assistant',
    content: 'z'.repeat(200_000),
  });
  assert.ok(open.transcript.length <= 400);
  assert.ok(size(open.transcript) <= 400_000);
  assert.match(
    open.transcript[0].content ?? '',
    /^a+[[]stored cut: 150000 of 200000 characters\]$/,
  );
  assert.match(
    open.transcript[1].content ?? '',
    /^\[dropped \d+ earlier messages\]$/,
  );
  assert.match(open.transcript.at(-1)?.content ?? '', /^z+[[]stored cut:/);
});

test('size bound drops middle parts without merging independent user inputs', () => {
  const open = record();
  for (let i = 0; i < 10; i++)
    appendRequestMessage(open, {
      role: 'user',
      content: String(i).repeat(100_000),
    });
  appendRequestMessage(open, { role: 'user', content: 'short follow-up' });
  assert.ok(size(open.transcript) <= 400_000);
  assert.equal(open.transcript[0].content, 'first');
  assert.equal(open.transcript.at(-1)?.content, 'short follow-up');
  assert.match(project(open).at(-1)?.content ?? '', /short follow-up$/);
});

for (const status of ['absent', 'done', 'active', 'waiting_user'] as const) {
  test(`synchronous sends apply automatic boundary at consumption: ${status}`, async () => {
    const inputs: Message[][] = [];
    const session = await DialogueSession.open({
      id: status,
      maxCorrections: 0,
      board: { workers: new Map() },
      planner: {
        async process(messages) {
          inputs.push(messages);
          if (inputs.length === 1 && status !== 'absent')
            await tools.callTool('plan_update', {
              plan: 'work',
              status,
              ...(status === 'waiting_user' ? { question: 'Which?' } : {}),
            });
          return {
            ok: true,
            value: {
              content:
                inputs.length === 1
                  ? `OLD_REPLY${'x'.repeat(7_000)}`
                  : 'new reply',
            },
          };
        },
      },
    });
    await Promise.all([session.send('first'), session.send('second')]);
    const separate = status === 'done' || status === 'absent';
    assert.equal(session.snapshot().requests?.length, separate ? 2 : 1);
    assert.equal(
      inputs[1].some((message) => message.content?.includes('OLD_REPLY')),
      !separate,
    );
    if (separate) {
      assert.ok(size(inputs[1]) < 1000);
      assert.equal(
        session.snapshot().requests?.[1].transcript[0].content,
        'second',
      );
      assert.ok(
        !inputs[1].some((message) => message.content?.includes('[actions]')),
      );
    } else if (status === 'waiting_user') {
      assert.equal(
        session.snapshot().plan && typeof session.snapshot().plan === 'object'
          ? session.snapshot().requests?.[0].plan?.status
          : undefined,
        'active',
      );
    }
    await session.close();
  });
}

test('a planless answer followed by a new input opens a new request', async () => {
  const session = await DialogueSession.open({
    id: 'planless',
    board: { workers: new Map() },
    planner: {
      async process() {
        return { ok: true, value: { content: 'reply' } };
      },
    },
  });
  await session.send('first');
  await session.send('second');
  assert.deepEqual(
    session.snapshot().requests?.map((request) => ({
      id: request.id,
      text: request.text,
    })),
    [
      { id: 'r1', text: 'first' },
      { id: 'r2', text: 'second' },
    ],
  );
  await session.close();
});

test('a failed latest turn keeps retries in the same request even after earlier success', async () => {
  let calls = 0;
  const session = await DialogueSession.open({
    id: 'retry',
    board: { workers: new Map() },
    planner: {
      async process() {
        calls++;
        if (calls === 1)
          await tools.callTool('plan_update', {
            plan: 'work',
            status: 'active',
          });
        if (calls === 2) {
          await tools.callTool('plan_update', { plan: 'work', status: 'done' });
          return { ok: false, error: new Error('failure') };
        }
        return { ok: true, value: { content: 'reply' } };
      },
    },
  });
  await session.send('first');
  await assert.rejects(session.send('second'), /failure/);
  assert.equal(session.snapshot().requests?.[0].lastTurnOk, false);
  await session.send('retry');
  assert.equal(session.snapshot().requests?.length, 1);
  assert.equal(session.snapshot().requests?.[0].lastTurnOk, true);
  await session.close();
});

test('corrective calls rebuild context containing intermediate replies, actions and checks', async () => {
  const inputs: Message[][] = [];
  const session = await DialogueSession.open({
    id: 'correct',
    board: { workers: new Map() },
    planner: {
      async process(messages) {
        inputs.push(messages);
        if (inputs.length === 1)
          await tools.callTool('plan_update', {
            steps: [{ id: 's1', goal: 'do work', state: 'pending' }],
          });
        else
          assert.equal(
            (
              await tools.callTool('plan_update', {
                steps: [{ id: 's1', goal: 'do work', state: 'pending' }],
                status: 'waiting_user',
                question: 'Proceed?',
              })
            ).isError,
            undefined,
          );
        return {
          ok: true,
          value: { content: inputs.length === 1 ? 'intermediate' : 'final' },
        };
      },
    },
  });
  await session.send('work');
  assert.equal(inputs.length, 2);
  const text = inputs[1].map((message) => message.content).join('\n');
  assert.match(text, /intermediate/);
  assert.match(text, /\[actions\]/);
  assert.match(text, /\[check\]/);
  await session.close();
});

test('legacy restore opens one bounded legacy request; next done-plan input starts r2; new state round trips', async () => {
  const store = new InMemoryDialogueStateStore();
  await store.save('restore', state({ version: 1, steps: [], status: 'done' }));
  const options = {
    id: 'restore',
    store,
    board: { workers: new Map() },
    planner: {
      async process() {
        return { ok: true as const, value: { content: 'reply' } };
      },
    },
  };
  const session = await DialogueSession.open(options);
  assert.equal(session.snapshot().requests?.[0].legacy, true);
  assert.equal(session.snapshot().requests?.[0].lastTurnOk, true);
  await session.send('new');
  const saved = session.snapshot();
  assert.equal(saved.requests?.[1].id, 'r2');
  const restored = await DialogueSession.open(options);
  assert.deepEqual(restored.snapshot().requests, saved.requests);
  await restored.send('next');
  assert.equal(restored.snapshot().requests?.at(-1)?.id, 'r3');
  await restored.close();
  await session.close();
});

test('conversation mode uses raw merged history and bypasses custom builder', async () => {
  const session = await DialogueSession.open({
    id: 'conversation',
    now: () => Date.parse('2026-10-29T15:39:59.999Z'),
    plannerContext: 'conversation',
    plannerContextBuilder: {
      build() {
        throw new Error('must not build');
      },
    },
    board: { workers: new Map() },
    planner: {
      async process(messages) {
        const raw = session.snapshot().conversation;
        const expected = structuredClone(raw);
        const last = expected.at(-1);
        if (last)
          last.content = `[request time] 2026-10-29 15:39 +00:00 (UTC)\n[plan] status: active\nnone\n${last.content}`;
        assert.deepEqual(messages, expected);
        return { ok: true, value: { content: 'reply' } };
      },
    },
  });
  await session.send('first');
  await session.send('second');
  await session.close();
});

test('events join open request and replies are pending before delivery and save', async () => {
  let finish: (value: { output: string }) => void = () => {
    throw new Error('not initialized');
  };
  const work = new Promise<{ output: string }>((resolve) => {
    finish = resolve;
  });
  const store = new InMemoryDialogueStateStore();
  let calls = 0;
  let delivered = false;
  const session = await DialogueSession.open({
    id: 'events',
    store,
    onMessage(message) {
      assert.ok(
        session.snapshot().pending.some((pending) => pending.id === message.id),
      );
      delivered = true;
    },
    board: {
      workers: new Map([
        [
          'w',
          {
            name: 'w',
            capabilities: { contextPolicy: 'optional' },
            run: () => work,
          },
        ],
      ]),
    },
    planner: {
      async process() {
        if (++calls === 1)
          await tools.callTool('delegate_task', { worker: 'w', goal: 'work' });
        return {
          ok: true,
          value: { content: calls === 1 ? 'started' : 'event reply' },
        };
      },
    },
  });
  await session.send('first');
  await session.send('while running');
  assert.equal(session.snapshot().requests?.length, 1);
  finish({ output: 'result' });
  for (let i = 0; i < 10 && !delivered; i++) await tick();
  assert.equal(delivered, true);
  await tick();
  assert.equal(session.snapshot().requests?.length, 1);
  assert.ok(
    (await store.load('events'))?.pending.some(
      (message) => message.trigger === 'event',
    ),
  );
  await session.close();
});

test('input enqueued in flight cannot change the owning request of the current reply', async () => {
  let release: () => void = () => {
    throw new Error('not initialized');
  };
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let enter: () => void = () => {
    throw new Error('not initialized');
  };
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  let calls = 0;
  const session = await DialogueSession.open({
    id: 'in-flight',
    board: { workers: new Map() },
    planner: {
      async process() {
        if (++calls === 1) {
          enter();
          await held;
        }
        return { ok: true, value: { content: `reply ${calls}` } };
      },
    },
  });
  const first = session.send('first');
  await entered;
  const second = session.send('second');
  assert.equal(session.snapshot().requests?.length, 1);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(
    session.snapshot().requests?.map((request) => request.id),
    ['r1', 'r2'],
  );
  await session.close();
});

test('task outcomes update request counters before a busy planner turn finishes; queued outcomes prevent automatic boundary', async () => {
  let finish: (value: { output: string }) => void = () => {
    throw new Error('not initialized');
  };
  const work = new Promise<{ output: string }>((resolve) => {
    finish = resolve;
  });
  let release: () => void = () => {
    throw new Error('not initialized');
  };
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let enter: () => void = () => {
    throw new Error('not initialized');
  };
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  let calls = 0;
  const session = await DialogueSession.open({
    id: 'queued-event',
    maxCorrections: 0,
    board: {
      workers: new Map([
        [
          'w',
          {
            name: 'w',
            capabilities: { contextPolicy: 'optional' },
            run: () => work,
          },
        ],
      ]),
    },
    planner: {
      async process() {
        calls++;
        if (calls === 1) {
          assert.equal(
            (
              await tools.callTool('plan_update', {
                steps: [{ id: 's', goal: 'work' }],
              })
            ).isError,
            undefined,
          );
          assert.equal(
            (
              await tools.callTool('delegate_task', {
                worker: 'w',
                goal: 'work',
                step_id: 's',
              })
            ).isError,
            undefined,
          );
        } else if (calls === 2) {
          enter();
          await held;
        }
        return { ok: true, value: { content: 'reply' } };
      },
    },
  });
  await session.send('first');
  const busy = session.send('busy');
  await entered;
  const queued = session.send('queued');
  finish({ output: 'done' });
  await tick();
  assert.equal(session.snapshot().requests?.[0].plan?.done, 1);
  assert.equal(session.snapshot().requests?.[0].plan?.status, 'done');
  release();
  await Promise.all([busy, queued]);
  await tick();
  assert.equal(session.snapshot().requests?.length, 1);
  await session.close();
});

test('suppressed event replies stay out of pending delivery', async () => {
  let finish: (value: { output: string }) => void = () => {
    throw new Error('not initialized');
  };
  const work = new Promise<{ output: string }>((resolve) => {
    finish = resolve;
  });
  let calls = 0;
  const session = await DialogueSession.open({
    id: 'silent-event',
    board: {
      workers: new Map([
        [
          'w',
          {
            name: 'w',
            capabilities: { contextPolicy: 'optional' },
            run: () => work,
          },
        ],
      ]),
    },
    planner: {
      async process() {
        if (++calls === 1)
          await tools.callTool('delegate_task', { worker: 'w', goal: 'work' });
        return {
          ok: true,
          value: { content: calls === 1 ? 'started' : 'NO_MESSAGE' },
        };
      },
    },
  });
  await session.send('first');
  finish({ output: 'result' });
  for (let i = 0; i < 10 && calls < 2; i++) await tick();
  await tick();
  assert.equal(calls, 2);
  assert.deepEqual(session.takePending(), []);
  assert.ok(!Object.hasOwn(session.snapshot(), 'messages'));
  await session.close();
});

test('new_request discards the old call, rebuilds retrieval, and keeps only the new request transcript', async () => {
  const store = new InMemoryDialogueStateStore();
  await store.save(
    'boundary',
    state({ version: 1, status: 'active', steps: [], note: 'OLD PLAN' }),
  );
  let calls = 0;
  let searches = 0;
  const partials: string[] = [];
  const session = await DialogueSession.open({
    id: 'boundary',
    store,
    maxCorrections: 0,
    board: { workers: new Map() },
    plannerKnowledge: [
      {
        name: 'guide',
        async search() {
          searches++;
          return [];
        },
      },
    ],
    planner: {
      async process(messages, opts) {
        calls++;
        if (calls === 1) {
          opts.onPartial?.({ kind: 'content', delta: 'DISCARD' });
          const result = await tools.callTool('new_request', {});
          assert.ok(result.ok && !result.value.isError);
          assert.ok(opts.stopSignal?.aborted);
          const rejected = await tools.callTool('plan_update', { plan: 'BAD' });
          assert.ok(rejected.ok && rejected.value.isError);
          return { ok: true, value: { content: 'DISCARD' } };
        }
        const context = messages.map((message) => message.content).join('\n');
        assert.doesNotMatch(context, /legacy input|OLD PLAN|DISCARD/);
        assert.match(context, /new work/);
        const updated = await tools.callTool('plan_update', {
          steps: [{ id: 'new', goal: 'new result' }],
        });
        assert.ok(updated.ok && !updated.value.isError);
        opts.onPartial?.({ kind: 'content', delta: 'new reply' });
        return { ok: true, value: { content: 'new reply' } };
      },
    },
  });
  try {
    const reply = await session.send('new work', {
      onPartial(chunk) {
        if (chunk.kind === 'content') partials.push(chunk.delta);
      },
    });
    assert.equal(reply.text, 'new reply');
    assert.deepEqual(partials, ['new reply']);
    assert.equal(calls, 2);
    assert.equal(searches, 2);
    const snapshot = session.snapshot();
    assert.equal(snapshot.requests?.length, 2);
    assert.equal(snapshot.requests?.[0].transcript, undefined);
    assert.equal(snapshot.requests?.[1].transcript[0].content, 'new work');
    assert.equal(
      typeof snapshot.plan === 'object' && snapshot.plan.steps[0].id,
      'new',
    );
  } finally {
    await session.close();
  }
});

for (const prior of [
  'plan_get',
  'list_tasks',
  'unknown_tool',
  'waiting_user',
] as const) {
  test(`new_request rejects after ${prior}`, async () => {
    const store = new InMemoryDialogueStateStore();
    await store.save(
      prior,
      state({
        version: 1,
        status: prior === 'waiting_user' ? 'waiting_user' : 'active',
        question: 'Answer?',
        steps: [],
        note: 'old',
      }),
    );
    const session = await DialogueSession.open({
      id: prior,
      store,
      maxCorrections: 0,
      board: { workers: new Map() },
      planner: {
        async process() {
          if (prior !== 'waiting_user')
            await tools.callTool(prior, { id: 'r1' });
          const rejected = await tools.callTool('new_request', {});
          assert.ok(rejected.ok && rejected.value.isError);
          return { ok: true, value: { content: 'same request' } };
        },
      },
    });
    try {
      await session.send('answer');
      assert.equal(session.snapshot().requests?.length, 1);
    } finally {
      await session.close();
    }
  });
}

for (const order of [
  ['new_request', 'plan_update', 'delegate_task'],
  ['new_request', 'delegate_task', 'plan_update'],
  ['plan_update', 'new_request', 'delegate_task'],
  ['plan_update', 'delegate_task', 'new_request'],
  ['delegate_task', 'new_request', 'plan_update'],
  ['delegate_task', 'plan_update', 'new_request'],
]) {
  test(`mixed round executes only new_request with dispatch order ${order.join(', ')}`, async () => {
    let calls = 0;
    const session = await DialogueSession.open({
      id: 'mixed',
      maxCorrections: 0,
      board: { workers: new Map() },
      planner: {
        async process(_messages, options) {
          if (calls++ === 0) {
            const round = [
              { name: 'new_request', arguments: {} },
              { name: 'plan_update', arguments: { plan: 'must not execute' } },
              {
                name: 'delegate_task',
                arguments: { worker: 'w', goal: 'must not execute' },
              },
            ];
            const rejected = options.toolRoundGuard?.(round);
            assert.deepEqual(
              [...(rejected ?? [])].map(([index]) => index),
              [1, 2],
            );
            for (const name of order) {
              const call = round.find((item) => item.name === name);
              assert.ok(call);
              // Calling handlers directly also checks defence in depth, regardless of execution order.
              const result = await tools.callTool(call.name, call.arguments);
              assert.ok(result.ok);
              assert.equal(
                result.value.isError === true,
                name !== 'new_request',
              );
              if (name !== 'new_request')
                assert.match(
                  JSON.stringify(result.value),
                  /new request started; continue in the next call/,
                );
            }
            const later = options.toolRoundGuard?.(round);
            assert.deepEqual(
              [...(later ?? [])].map(([index]) => index),
              [0, 1, 2],
            );
          }
          return { ok: true, value: { content: 'reply' } };
        },
      },
    });
    try {
      await session.send('new work');
      assert.equal(session.snapshot().tasks.length, 0);
      assert.equal(session.snapshot().plan, undefined);
      assert.equal(session.snapshot().requests?.length, 2);
      assert.equal(calls, 2);
    } finally {
      await session.close();
    }
  });
}

test('old tasks survive the boundary, wait normally, label events, and preserve reused steps', async () => {
  let finish: (value: { output: string }) => void = () => {
    throw new Error('worker not started');
  };
  const result = new Promise<{ output: string }>((resolve) => {
    finish = resolve;
  });
  const contexts: string[] = [];
  let calls = 0;
  const session = await DialogueSession.open({
    id: 'old-tasks',
    maxCorrections: 0,
    waitTickMs: 0,
    longTaskMs: 0,
    board: {
      workers: new Map([
        [
          'w',
          {
            name: 'w',
            capabilities: { contextPolicy: 'optional' },
            run: () => result,
          },
        ],
      ]),
    },
    planner: {
      async process(messages, opts) {
        calls++;
        contexts.push(messages.map((message) => message.content).join('\n'));
        if (calls === 1) {
          await tools.callTool('plan_update', {
            steps: [{ id: 'same', goal: 'old goal' }],
          });
          await tools.callTool('delegate_task', {
            worker: 'w',
            goal: 'old task',
            step_id: 'same',
          });
        } else if (calls === 2) {
          const boundary = await tools.callTool('new_request', {});
          assert.ok(boundary.ok && !boundary.value.isError);
        } else if (calls === 3) {
          const updated = await tools.callTool('plan_update', {
            steps: [{ id: 'same', goal: 'new goal' }],
          });
          assert.ok(updated.ok && !updated.value.isError);
          await tools.callTool('list_tasks', {});
          assert.equal(opts.stopSignal?.aborted, false);
          await tools.callTool('list_tasks', {});
          assert.equal(opts.stopSignal?.aborted, true);
        } else {
          const rejected = await tools.callTool('new_request', {});
          assert.ok(rejected.ok && rejected.value.isError);
        }
        return { ok: true, value: { content: 'reply' } };
      },
    },
  });
  try {
    await session.send('old work');
    await session.send('new work');
    const before = session.snapshot();
    assert.equal(before.taskRequests?.t1, 'r1');
    finish({ output: 'old result' });
    for (let i = 0; i < 20 && calls < 4; i++) await tick();
    assert.equal(calls, 4);
    assert.match(contexts[3], /\[task events\] from r1:/);
    const after = session.snapshot();
    assert.equal(after.requests?.[0].plan?.done, 0);
    assert.equal(
      typeof after.plan === 'object' && after.plan.steps[0].state,
      'pending',
    );
    const store = new InMemoryDialogueStateStore();
    await store.save('restored-owner', after);
    const restored = await DialogueSession.open({
      id: 'restored-owner',
      store,
      board: { workers: new Map() },
      planner: {
        async process() {
          return { ok: true, value: { content: 'reply' } };
        },
      },
    });
    assert.deepEqual(restored.snapshot().taskRequests, after.taskRequests);
    await restored.close();
  } finally {
    finish({ output: 'cleanup' });
    await session.close();
  }
});

test('a corrective call cannot start a new request', async () => {
  let calls = 0;
  const session = await DialogueSession.open({
    id: 'correction-boundary',
    maxCorrections: 1,
    board: { workers: new Map() },
    planner: {
      async process() {
        calls++;
        if (calls === 1)
          await tools.callTool('plan_update', {
            steps: [{ id: 'ready', goal: 'ready work' }],
          });
        else {
          const rejected = await tools.callTool('new_request', {});
          assert.ok(rejected.ok && rejected.value.isError);
        }
        return { ok: true, value: { content: 'reply' } };
      },
    },
  });
  try {
    await session.send('work');
    assert.equal(calls, 2);
    assert.equal(session.snapshot().requests?.length, 1);
  } finally {
    await session.close();
  }
});

test('new_request closes a failed plan and permits replacement without consent', async () => {
  const store = new InMemoryDialogueStateStore();
  await store.save(
    'failed-boundary',
    state({
      version: 1,
      status: 'active',
      steps: [
        {
          id: 'failed',
          goal: 'old failure',
          state: 'failed',
          taskIds: [],
          dependsOn: [],
        },
      ],
    }),
  );
  let calls = 0;
  const session = await DialogueSession.open({
    id: 'failed-boundary',
    store,
    maxCorrections: 0,
    board: { workers: new Map() },
    planner: {
      async process() {
        calls++;
        const result =
          calls === 1
            ? await tools.callTool('new_request', {})
            : await tools.callTool('plan_update', {
                steps: [{ id: 'replacement', goal: 'unrelated result' }],
              });
        assert.ok(result.ok && !result.value.isError);
        return { ok: true, value: { content: 'reply' } };
      },
    },
  });
  try {
    await session.send('unrelated work');
    const snapshot = session.snapshot();
    assert.equal(
      typeof snapshot.plan === 'object' && snapshot.plan.steps[0].id,
      'replacement',
    );
  } finally {
    await session.close();
  }
});

for (const placement of ['second-call', 'second-round'] as const) {
  test(`round guard rejects new_request as ${placement} before handlers execute`, async () => {
    const session = await DialogueSession.open({
      id: placement,
      maxCorrections: 0,
      board: { workers: new Map() },
      planner: {
        async process(_messages, options) {
          const ordinary = { name: 'plan_get', arguments: {} };
          const boundary = { name: 'new_request', arguments: {} };
          if (placement === 'second-round')
            options.toolRoundGuard?.([ordinary]);
          const round =
            placement === 'second-call' ? [ordinary, boundary] : [boundary];
          const rejected = options.toolRoundGuard?.(round);
          assert.match(
            rejected?.get(round.indexOf(boundary)) ?? '',
            /requires the first tool/,
          );
          return { ok: true, value: { content: 'same request' } };
        },
      },
    });
    try {
      await session.send('keep working');
      assert.equal(session.snapshot().requests?.length, 1);
    } finally {
      await session.close();
    }
  });
}

test('projection preserves corrections, consent, ownership, errors and current plan; history stays complete', () => {
  const open = record();
  appendRequestMessage(open, {
    role: 'user',
    content:
      'Correction: use only approved records. I consent to dropping step B.',
  });
  appendRequestMessage(open, {
    role: 'user',
    internalKind: 'events',
    content: '[task events] from r0: task old (w) running',
  });
  appendRequestMessage(open, {
    role: 'user',
    internalKind: 'events',
    content: '[task events] from r0: task old (w) done; outcome: success',
  });
  appendRequestMessage(open, {
    role: 'user',
    content:
      '[task events] task failed (w) failed: permission denied; needs user action',
  });
  const output = 'delivered report'.repeat(4000);
  appendRequestMessage(open, {
    role: 'assistant',
    content: output,
    plannerReference:
      '[delivered] task old done; output length: 64000; use get_task',
  });
  const before = structuredClone(open);
  const projected = builder.build({
    open,
    memory: [],
    knowledge: [],
    notes: ['[plan] keep A; B skipped with consent'],
  });
  const text = projected.map((message) => message.content).join('\n');
  assert.match(
    text,
    /Correction: use only approved records. I consent to dropping step B./,
  );
  assert.match(text, /from r0: task old.*done/);
  assert.doesNotMatch(text, /task old.*running/);
  assert.match(text, /permission denied; needs user action/);
  assert.match(text, /keep A; B skipped with consent/);
  assert.match(text, /\[delivered\] task old done/);
  assert.ok(!text.includes(output));
  assert.deepEqual(open, before);
  assert.deepEqual(project(structuredClone(open)), project(open));
});

test('restart restores delivered-answer references, complete history and paged task output', async () => {
  const store = new InMemoryDialogueStateStore();
  const output = 'retained report '.repeat(2000);
  const saved = state({
    version: 1,
    steps: [],
    status: 'active',
    note: 'current plan',
  });
  saved.requests = [
    {
      id: 'r1',
      openedAt: 1,
      text: 'first',
      transcript: [
        { role: 'user', content: 'first' },
        {
          role: 'assistant',
          content: output,
          plannerReference: '[delivered] task saved done; use get_task',
        },
        {
          role: 'user',
          content: 'Correction: only approved data. Yes, I consent.',
        },
        {
          role: 'user',
          content:
            '[task events] task broken failed: unresolved permission error',
        },
      ],
    },
  ];
  saved.tasks = [
    {
      id: 'saved',
      worker: 'w',
      goal: 'report',
      state: 'done',
      createdAt: 1,
      output,
    },
  ];
  await store.save('lean-restart', saved);
  const session = await DialogueSession.open({
    id: 'lean-restart',
    store,
    board: { workers: new Map() },
    planner: {
      async process(messages) {
        const text = messages.map((message) => message.content).join('\n');
        assert.ok(!text.includes(output));
        assert.match(text, /\[delivered\] task saved/);
        assert.match(text, /Correction: only approved data. Yes, I consent./);
        assert.match(text, /unresolved permission error/);
        assert.match(text, /current plan/);
        const result = await tools.callTool('get_task', {
          task_id: 'saved',
          view: 'full',
          offset: 10,
          limit: 50,
        });
        assert.ok(result.ok);
        assert.ok(JSON.stringify(result.value).includes(output.slice(10, 60)));
        return { ok: true, value: { content: 'continued' } };
      },
    },
  });
  try {
    await session.send('continue');
    assert.equal(
      session.snapshot().requests?.[0].transcript?.[1].content,
      output,
    );
  } finally {
    await session.close();
  }
});

test('intentional answer compaction does not retrieve the full answer back into context', () => {
  const open = record();
  const output = 'large answer '.repeat(3000);
  appendRequestMessage(open, {
    role: 'assistant',
    content: output,
    plannerReference: '[delivered] task saved; use get_task',
  });
  const projected = builder.build({
    open,
    knowledge: [],
    notes: [],
    memory: [
      {
        kind: 'planner-reply',
        requestId: open.id,
        sourceId: 'saved',
        offset: 0,
        text: output,
      },
    ],
  });
  assert.ok(!JSON.stringify(projected).includes(output));
  assert.ok(!JSON.stringify(projected).includes('session memory'));
});

test('projection retains a long consent request ending in a period after follow-up events', () => {
  const open = record();
  const question = `${'Context. '.repeat(300)}Please confirm removal of step B.`;
  appendRequestMessage(open, { role: 'assistant', content: question });
  appendRequestMessage(open, {
    role: 'user',
    content: '[task events] task a done',
  });
  appendRequestMessage(open, { role: 'user', content: 'yes' });
  assert.ok(JSON.stringify(project(open)).includes(question));
  assert.ok(JSON.stringify(project(structuredClone(open))).includes(question));
});

for (const restart of [false, true]) {
  test(`delivery note survives projection and next turn verbatim (restart: ${restart})`, async () => {
    const store = new InMemoryDialogueStateStore();
    const saved = state({
      version: 1,
      steps: [],
      status: 'active',
      note: 'Review the report and confirm removal of step B.',
    });
    // Resume the request that owns the completed task, before its first delivery.
    saved.requests = [record()];
    saved.requestSeq = 1;
    saved.taskRequests = { saved: 'r1' };
    const output = 'report body '.repeat(2000);
    const note = `${'Review context. '.repeat(40)}Please confirm removal of step B.`;
    saved.tasks = [
      {
        id: 'saved',
        worker: 'w',
        goal: 'report',
        state: 'done',
        createdAt: 1,
        output,
      },
    ];
    await store.save('delivery-note', saved);
    let checked = false;
    let calls = 0;
    const checkContext = (messages: Message[]): void => {
      const text = messages.map((message) => message.content).join('\n');
      assert.ok(text.includes(note));
      assert.ok(text.includes('[delivered]'));
      assert.ok(!text.includes(output));
      checked = true;
    };
    const session = await DialogueSession.open({
      id: 'delivery-note',
      store,
      maxCorrections: 0,
      board: { workers: new Map() },
      planner: {
        async process(messages) {
          if (calls++ > 0) {
            checkContext(messages);
            return { ok: true, value: { content: 'approved' } };
          }
          const delivered = await tools.callTool('deliver', {
            task_id: 'saved',
            note,
          });
          assert.ok(delivered.ok && !delivered.value.isError);
          return { ok: true, value: { content: 'discarded' } };
        },
      },
    });
    let persisted: DialogueState | undefined;
    try {
      const reply = await session.send('report');
      assert.equal(reply.text, `${note}\n\n${output}`);
      const open = session.snapshot().requests?.at(-1);
      assert.ok(open);
      const projected = project(open)
        .map((message) => message.content)
        .join('\n');
      assert.ok(projected.includes(note));
      assert.ok(projected.includes('[delivered]'));
      assert.ok(!projected.includes(output));
      if (restart) {
        persisted = await store.load('delivery-note');
        assert.ok(persisted);
        const persistedRequest = persisted.requests?.at(-1);
        assert.ok(persistedRequest);
        assert.ok(
          project(persistedRequest).some((message) =>
            message.content?.includes(note),
          ),
        );
      } else {
        await session.send('yes');
        assert.ok(checked);
      }
    } finally {
      await session.close();
    }
    if (!restart) return;
    // close() deletes state; restore the checkpoint to model a process restart.
    assert.ok(persisted);
    await store.save('delivery-note', persisted);
    const restored = await DialogueSession.open({
      id: 'delivery-note',
      store,
      maxCorrections: 0,
      board: { workers: new Map() },
      planner: {
        async process(messages) {
          checkContext(messages);
          return { ok: true, value: { content: 'approved' } };
        },
      },
    });
    try {
      await restored.send('yes');
      assert.ok(checked);
    } finally {
      await restored.close();
    }
  });
}

for (const label of ['actions', 'task events']) {
  test(`removed step failure survives later turns and restart (${label})`, async () => {
    const store = new InMemoryDialogueStateStore();
    const saved = state({ version: 1, steps: [], status: 'active' });
    const open = record();
    appendRequestMessage(open, {
      role: 'user',
      content: `[${label}] task broken for removed (w) failed: permission denied; use get_task`,
    });
    appendRequestMessage(open, {
      role: 'assistant',
      content: 'Please resolve access.',
    });
    appendRequestMessage(open, {
      role: 'user',
      internalKind: 'actions',
      content: '[actions] plan updated',
    });
    appendRequestMessage(open, {
      role: 'assistant',
      content: 'Waiting for access.',
    });
    saved.requests = [open];
    saved.requestSeq = 1;
    saved.tasks = [
      {
        id: 'broken',
        worker: 'w',
        goal: 'removed work',
        state: 'failed',
        error: 'permission denied',
        createdAt: 1,
      },
    ];
    saved.taskRequests = { broken: 'r1' };
    saved.taskSteps = { broken: 'removed' };
    await store.save('removed-failure', saved);
    const options = {
      id: 'removed-failure',
      store,
      maxCorrections: 0,
      board: { workers: new Map() },
      planner: {
        async process(messages: Message[]) {
          const text = messages.map((message) => message.content).join('\n');
          assert.match(
            text,
            /task broken for removed .*failed: permission denied/,
          );
          assert.doesNotMatch(text, /\[actions\] plan updated/);
          return { ok: true as const, value: { content: 'Still waiting.' } };
        },
      },
    };
    const session = await DialogueSession.open(options);
    let checkpoint: DialogueState;
    try {
      await session.send('continue');
      checkpoint = session.snapshot();
    } finally {
      await session.close();
    }
    await store.save('removed-failure', checkpoint);
    const restored = await DialogueSession.open(options);
    try {
      await restored.send('continue after restart');
    } finally {
      await restored.close();
    }
  });
}

test('user messages resembling internal notes remain verbatim, including legacy restore', () => {
  const open = record();
  for (const content of [
    '[actions] Do not delete records',
    '[task events] task a failed: keep this constraint',
    '[dropped 12 earlier messages]',
  ]) {
    appendRequestMessage(open, { role: 'user', content });
  }
  for (let i = 0; i < 4; i++)
    appendRequestMessage(open, { role: 'assistant', content: 'later' });
  const text = JSON.stringify(project(structuredClone(open)));
  assert.ok(text.includes('[actions] Do not delete records'));
  assert.ok(text.includes('[task events] task a failed: keep this constraint'));
  assert.ok(text.includes('[dropped 12 earlier messages]'));
});

for (const removed of [false, true]) {
  test(`resolved failures allow automatic request closure (removed: ${removed})`, async () => {
    const store = new InMemoryDialogueStateStore();
    const saved = state({ version: 1, steps: [], status: 'done' });
    const open = record();
    open.lastTurnOk = true;
    appendRequestMessage(open, {
      role: 'user',
      internalKind: 'events',
      content: '[task events] task broken failed: denied',
    });
    saved.requests = [open];
    saved.taskRequests = { broken: 'r1', retry: 'r1' };
    saved.taskSteps = { broken: 'work', retry: 'work' };
    saved.tasks = [
      {
        id: 'broken',
        worker: 'w',
        goal: 'work',
        state: 'failed',
        error: 'denied',
        createdAt: 1,
      },
    ];
    if (!removed) {
      saved.tasks.push({
        id: 'retry',
        worker: 'w',
        goal: 'work',
        state: 'done',
        createdAt: 2,
        output: 'success',
      });
      saved.plan = {
        version: 1,
        status: 'done',
        steps: [
          {
            id: 'work',
            goal: 'work',
            state: 'done',
            taskIds: ['broken', 'retry'],
            dependsOn: [],
          },
        ],
      };
    }
    await store.save('resolved', saved);
    let resolveFailure = false;
    const session = await DialogueSession.open({
      id: 'resolved',
      store,
      maxCorrections: 0,
      board: { workers: new Map() },
      planner: {
        async process() {
          if (resolveFailure) {
            const updated = await tools.callTool('plan_update', {
              steps: [],
              status: 'done',
            });
            assert.ok(updated.ok && !updated.value.isError);
          }
          return { ok: true, value: { content: 'Task broken is resolved.' } };
        },
      },
    });
    try {
      if (removed) {
        await session.send('handle failure');
        assert.equal(session.snapshot().requests?.length, 1);
        assert.equal(
          session.snapshot().requests?.[0].resolvedFailures,
          undefined,
        );
        resolveFailure = true;
        await session.send('resolve the removed step');
        resolveFailure = false;
        assert.ok(
          session.snapshot().requests?.[0].resolvedFailures?.includes('broken'),
        );
      }
      await session.send('unrelated request');
      const requests = session.snapshot().requests;
      assert.equal(requests?.length, 2);
      assert.ok(requests?.[0].closedAt !== undefined);
      assert.equal(requests?.[1].text, 'unrelated request');
      assert.ok(!JSON.stringify(requests?.[1].transcript).includes('denied'));
    } finally {
      await session.close();
    }
  });
}
