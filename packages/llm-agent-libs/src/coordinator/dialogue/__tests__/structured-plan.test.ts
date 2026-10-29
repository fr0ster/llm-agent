import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DialoguePlan, TaskEvent } from '@mcp-abap-adt/llm-agent';
import { DialogueSession } from '../dialogue-session.js';
import { InMemoryDialogueStateStore } from '../in-memory-dialogue-state-store.js';
import { runInPlannerScope } from '../planner-scope.js';
import { PlannerToolsClient } from '../planner-tools-client.js';
import {
  applyTaskEvent,
  mergePlan,
  planView,
  readySteps,
  recomputePlanStatus,
} from '../structured-plan.js';
import { TaskBoard } from '../task-board.js';

function getPlan(session: DialogueSession): DialoguePlan {
  const plan = session.snapshot().plan;
  assert.ok(typeof plan === 'object');
  return plan;
}

const tools = new PlannerToolsClient();
const tick = () => new Promise<void>((r) => setImmediate(r));
async function call(name: string, args: Record<string, unknown>) {
  const result = await tools.callTool(name, args);
  assert.ok(result.ok);
  return result.value;
}
const steps = [
  { id: 's1', goal: 'first' },
  { id: 's2', goal: 'second', dependsOn: ['s1'] },
];
function outcome(
  id: string,
  kind: TaskEvent['kind'] | 'interrupted',
  output?: string,
): TaskEvent {
  return {
    kind: kind === 'interrupted' ? 'failed' : kind,
    task: {
      id,
      worker: 'w',
      goal: 'work',
      state: kind === 'started' || kind === 'long_running' ? 'running' : kind,
      createdAt: 0,
      output,
    },
  };
}

test('step merge retains state and task links, new ids pending, dependency validation and bounded view', () => {
  let plan = mergePlan(undefined, steps, 'active');
  plan.steps[0].state = 'done';
  plan.steps[0].taskIds.push('t1');
  plan = mergePlan(plan, [...steps].reverse(), 'active');
  assert.equal(plan.steps[1].state, 'done');
  assert.deepEqual(plan.steps[1].taskIds, ['t1']);
  assert.deepEqual(
    readySteps(plan).map((s) => s.id),
    ['s2'],
  );
  plan.steps[1].state = 'skipped';
  assert.deepEqual(readySteps(plan), []);
  assert.doesNotMatch(planView(plan), /s2 ready/);
  assert.throws(() =>
    mergePlan(plan, [{ id: 's', goal: 'x', dependsOn: ['missing'] }], 'active'),
  );
  assert.throws(() =>
    mergePlan(
      plan,
      [
        { id: 's', goal: 'x', dependsOn: ['z'] },
        { id: 'z', goal: 'y', dependsOn: ['s'] },
      ],
      'active',
    ),
  );
  const big = mergePlan(
    undefined,
    Array.from({ length: 50 }, (_, i) => ({ id: `s${i}`, goal: 'goal' })),
    'active',
  );
  big.steps.slice(0, 15).forEach((s) => {
    s.state = 'done';
  });
  const view = planView(big);
  assert.match(view, /10 done steps collapsed/);
  assert.equal(view.split('\n').filter((l) => /^s\d/.test(l)).length, 40);
  assert.doesNotMatch(view, /\[tasks\]/);
});

test('delegation assigns work and checking to separate steps and enforces worker roles', async () => {
  const plan = mergePlan(
    undefined,
    [
      steps[0],
      { id: 'verify', goal: 'verify', worker: 'checker', dependsOn: ['s1'] },
    ],
    'active',
  );
  const contexts: string[] = [];
  const actions: string[] = [];
  const board = new TaskBoard({
    workers: new Map(
      ['w', 'checker'].map((name) => [
        name,
        {
          name,
          capabilities: { contextPolicy: 'optional' as const },
          async run(input: { context?: string }) {
            contexts.push(input.context ?? '');
            return { output: name === 'checker' ? 'PASS' : 'work result' };
          },
        },
      ]),
    ),
    onEvent: (e) => applyTaskEvent(plan, e),
  });
  await runInPlannerScope(
    {
      board,
      getPlan: () => plan,
      setPlan() {},
      recordAction: (a) => actions.push(a),
    },
    async () => {
      for (const args of [
        { worker: 'w', goal: 'x' },
        { worker: 'checker', goal: 'x', step_id: 's1' },
        { worker: 'w', goal: 'x', step_id: 'verify' },
        { worker: 'checker', goal: 'x', step_id: 'verify' },
      ])
        assert.equal((await call('delegate_task', args)).isError, true);
      assert.equal(
        (
          await call('delegate_task', {
            worker: 'w',
            goal: 'work',
            step_id: 's1',
          })
        ).isError,
        undefined,
      );
      await tick();
      assert.equal(plan.steps[0].state, 'done');
      assert.equal(
        (
          await call('delegate_task', {
            worker: 'checker',
            goal: 'verify',
            step_id: 'verify',
          })
        ).isError,
        undefined,
      );
      await tick();
      assert.equal(plan.steps[1].state, 'done');
      assert.equal(plan.steps[1].verdict, 'pass');
      assert.deepEqual(
        plan.steps.map((step) => step.taskIds),
        [['t1'], ['t2']],
      );
      assert.match(
        contexts[1],
        /\[result to check: step s1 \(task t1\)\]\nwork result/,
      );
      assert.ok(actions.includes('started t2 for verify (checker)'));
    },
  );
  await board.stopAll();
});

for (const output of [
  'PASS',
  'FAIL',
  '{"verdict":"pass"}',
  '{"verdict":"fail","note":"reason"}',
  'invalid',
]) {
  test(`separate checker result ${output}`, () => {
    const plan = mergePlan(
      undefined,
      [{ id: 'verify', goal: 'verify', worker: 'checker' }],
      'active',
    );
    plan.steps[0].taskIds = ['t1'];
    applyTaskEvent(plan, outcome('t1', 'done', output));
    assert.equal(
      plan.steps[0].state,
      output === 'PASS' || output === '{"verdict":"pass"}' ? 'done' : 'failed',
    );
    if (output === 'invalid')
      assert.match(plan.steps[0].note ?? '', /unusable verdict/);
  });
}

for (const maxCorrections of [0, 1, 2]) {
  test(`user turn correction bound ${maxCorrections}, accepted content only, warning excludes content`, async () => {
    let calls = 0;
    const streamed: string[] = [];
    const warnings: string[] = [];
    const s = await DialogueSession.open({
      id: 'user',
      maxCorrections,
      logger: { warn: (w) => warnings.push(w) },
      board: { workers: new Map() },
      planner: {
        async process(messages, opts) {
          calls++;
          for (let i = 1; i < messages.length; i++)
            assert.notEqual(messages[i].role, messages[i - 1].role);
          if (calls === 1) await call('update_plan', { steps });
          else
            assert.match(
              String(messages.at(-1)?.content),
              /\[check\] Steps s1: first are ready/,
            );
          opts.onPartial?.({ kind: 'content', delta: `secret ${calls}` });
          return { ok: true, value: { content: `secret ${calls}` } };
        },
      },
    });
    await s.send('go', {
      onPartial: (c) => {
        if (c.kind === 'content') streamed.push(c.delta);
      },
    });
    assert.equal(calls, 1 + maxCorrections);
    assert.deepEqual(streamed, [`secret ${calls}`]);
    assert.equal(warnings.length, maxCorrections ? 1 : 0);
    assert.ok(warnings.every((w) => !w.includes('secret')));
    await s.close();
  });
}

test('event correction, waiting_user suppression/reset, auto done, structured snapshot restore', async () => {
  let resolve!: (v: { output: string }) => void;
  const work = new Promise<{ output: string }>((r) => {
    resolve = r;
  });
  const store = new InMemoryDialogueStateStore();
  let calls = 0;
  const s = await DialogueSession.open({
    id: 'events',
    store,
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
      async process(messages) {
        calls++;
        if (calls === 1) {
          await call('update_plan', { steps });
          await call('delegate_task', {
            step_id: 's1',
            worker: 'w',
            goal: 'first',
          });
        } else if (calls === 3) {
          assert.match(
            String(messages.at(-1)?.content),
            /\[check\] Steps s2: second are ready/,
          );
          await call('update_plan', {
            steps,
            status: 'waiting_user',
            question: 'Proceed?',
          });
        } else if (calls === 4) {
          assert.match(String(messages.at(-1)?.content), /status: active/);
          await call('update_plan', {
            steps: [
              steps[0],
              { ...steps[1], state: 'skipped', note: 'unnecessary' },
            ],
          });
        }
        return { ok: true, value: { content: 'ok' } };
      },
    },
  });
  await s.send('go');
  resolve({ output: 'finished' });
  await tick();
  await tick();
  assert.equal(calls, 3);
  assert.equal(getPlan(s).status, 'waiting_user');
  const restored = await DialogueSession.open({
    id: 'events',
    store,
    board: { workers: new Map() },
    planner: {
      async process() {
        return { ok: true, value: { content: 'ok' } };
      },
    },
  });
  assert.deepEqual(getPlan(restored).steps[0].taskIds, ['t1']);
  await s.send('yes');
  assert.equal(getPlan(s).status, 'done');
  await restored.close();
  await s.close();
});

test('waiting_user ends user turn without correction; new user resets status', async () => {
  let calls = 0;
  const s = await DialogueSession.open({
    id: 'wait',
    board: { workers: new Map() },
    planner: {
      async process(messages) {
        calls++;
        if (calls === 2)
          assert.match(String(messages.at(-1)?.content), /status: active/);
        await call('update_plan', {
          steps,
          status: 'waiting_user',
          question: 'Which one?',
        });
        return { ok: true, value: { content: 'Which one?' } };
      },
    },
  });
  await s.send('go');
  assert.equal(calls, 1);
  await s.send('second');
  assert.equal(calls, 2);
  await s.close();
});

test('structured restore preserves separate checker history and interrupts its unfinished attempt', async () => {
  const store = new InMemoryDialogueStateStore();
  const plan = mergePlan(
    undefined,
    [
      steps[0],
      { id: 'verify', goal: 'verify', worker: 'checker', dependsOn: ['s1'] },
    ],
    'active',
  );
  Object.assign(plan.steps[0], {
    state: 'done',
    taskIds: ['t1'],
    workTaskId: 't1',
  });
  Object.assign(plan.steps[1], {
    state: 'running',
    taskIds: ['t2'],
    workTaskId: 't2',
    checkedTaskIds: { s1: 't1' },
  });
  await store.save('restore-check', {
    plan,
    tasks: [
      outcome('t1', 'done').task,
      { ...outcome('t2', 'started').task, worker: 'checker' },
    ],
    conversation: [],
    pending: [],
    savedAt: 0,
  });
  const session = await DialogueSession.open({
    id: 'restore-check',
    store,
    board: { workers: new Map() },
    planner: {
      async process() {
        return { ok: true, value: { content: 'ok' } };
      },
    },
  });
  const restored = session.snapshot().plan;
  assert.ok(typeof restored === 'object');
  assert.equal(restored.steps[0].state, 'done');
  assert.equal(restored.steps[1].state, 'failed');
  assert.deepEqual(session.snapshot().taskSteps, { t1: 's1', t2: 'verify' });
  assert.equal(session.snapshot().tasks[1].state, 'interrupted');
  await session.close();
});

test('waiting_user suppresses corrections on an event turn with ready steps', async () => {
  let resolve!: (v: { output: string }) => void;
  const work = new Promise<{ output: string }>((r) => {
    resolve = r;
  });
  let calls = 0;
  const session = await DialogueSession.open({
    id: 'event-wait',
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
        if (++calls === 1) {
          await call('update_plan', {
            steps,
            status: 'waiting_user',
            question: 'Continue after this?',
          });
          await call('delegate_task', {
            step_id: 's1',
            worker: 'w',
            goal: 'first',
          });
        }
        return { ok: true, value: { content: 'ok' } };
      },
    },
  });
  await session.send('go');
  resolve({ output: 'done' });
  await tick();
  await tick();
  assert.equal(calls, 2);
  assert.deepEqual(
    readySteps(getPlan(session)).map((s) => s.id),
    ['s2'],
  );
  await session.close();
});

test('late checker events never overwrite the work step or a newer checker attempt', () => {
  const plan = mergePlan(
    undefined,
    [
      steps[0],
      { id: 'verify', goal: 'verify', worker: 'checker', dependsOn: ['s1'] },
    ],
    'active',
  );
  Object.assign(plan.steps[0], {
    workTaskId: 'work',
    taskIds: ['work'],
    state: 'running',
  });
  Object.assign(plan.steps[1], {
    workTaskId: 'new',
    taskIds: ['old', 'new'],
    state: 'running',
  });
  applyTaskEvent(plan, outcome('old', 'done', 'PASS'));
  assert.equal(plan.steps[1].state, 'running');
  applyTaskEvent(plan, outcome('work', 'failed'));
  applyTaskEvent(plan, outcome('new', 'done', 'FAIL'));
  assert.equal(plan.steps[0].state, 'failed');
  assert.equal(plan.steps[1].state, 'pending');
  assert.match(plan.steps[1].note ?? '', /Checked results changed/);
});

for (const currentInterrupted of [false, true]) {
  test(`restore reconciles current attempts and recomputes status (current interrupted: ${currentInterrupted})`, async () => {
    const store = new InMemoryDialogueStateStore();
    const plan = mergePlan(undefined, [steps[0]], 'done');
    Object.assign(plan.steps[0], { state: 'done', taskIds: ['t1', 't2'] });
    await store.save('attempts', {
      plan,
      tasks: [
        outcome('t1', 'started').task,
        outcome('t2', currentInterrupted ? 'started' : 'done').task,
      ],
      conversation: [],
      pending: [],
      savedAt: 0,
    });
    const session = await DialogueSession.open({
      id: 'attempts',
      store,
      board: { workers: new Map() },
      planner: {
        async process() {
          return { ok: true, value: { content: 'ok' } };
        },
      },
    });
    const restored = session.snapshot().plan;
    assert.ok(typeof restored === 'object');
    assert.equal(
      restored.steps[0].state,
      currentInterrupted ? 'failed' : 'done',
    );
    assert.equal(restored.status, currentInterrupted ? 'active' : 'done');
    await session.close();
  });
}

test('skipped dependencies block delegation until the planner revises dependsOn', async () => {
  let plan = mergePlan(undefined, steps, 'active');
  plan.steps[0].state = 'skipped';
  const board = new TaskBoard({
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
    onEvent() {},
  });
  await runInPlannerScope(
    {
      board,
      getPlan: () => plan,
      setPlan(p) {
        assert.ok(typeof p === 'object');
        plan = p;
      },
    },
    async () => {
      assert.equal(
        (
          await call('delegate_task', {
            worker: 'w',
            goal: 'second',
            step_id: 's2',
          })
        ).isError,
        true,
      );
      await call('update_plan', {
        steps: [
          { ...steps[0], state: 'skipped', note: 'unnecessary' },
          { ...steps[1], dependsOn: [] },
        ],
      });
      assert.match(planView(plan), /s2 ready/);
      assert.equal(
        (
          await call('delegate_task', {
            worker: 'w',
            goal: 'second',
            step_id: 's2',
          })
        ).isError,
        undefined,
      );
    },
  );
  await board.stopAll();
});

for (const by of ['w', 'checker'] as const) {
  test(`skips ignore work and check outcomes (${by})`, () => {
    const plan = mergePlan(undefined, [steps[0]], 'done');
    Object.assign(plan.steps[0], {
      state: 'skipped',
      note: 'no longer needed',
      taskIds: ['t1', 't2'],
      workTaskId: 't1',
      worker: by,
    });
    const before = structuredClone(plan);
    delete before.question;
    for (const id of ['t1', 't2']) {
      for (const kind of [
        'done',
        'failed',
        'stopped',
        'interrupted',
      ] as const) {
        applyTaskEvent(
          plan,
          outcome(id, kind, '{"verdict":"pass","note":"checked"}'),
        );
        recomputePlanStatus(plan);
        assert.deepEqual(plan, before);
      }
    }
  });

  test(`restore preserves skipped steps and injects current attempts and check instructions (${by})`, async () => {
    const store = new InMemoryDialogueStateStore();
    const plan = mergePlan(undefined, [steps[0]], 'done');
    Object.assign(plan.steps[0], {
      state: 'skipped',
      note: 'no longer needed',
      taskIds: ['t1', 't2', 't3', 't4'],
      workTaskId: 't3',
      worker: by,
    });
    await store.save('skip-restore', {
      plan,
      tasks: ['t1', 't2', 't3', 't4'].map((id) => outcome(id, 'started').task),
      conversation: [],
      pending: [],
      savedAt: 0,
    });
    let injected = false;
    const session = await DialogueSession.open({
      id: 'skip-restore',
      // Today's restore path; prepared mode resets a done plan at the first request boundary.
      plannerContext: 'conversation',
      store,
      board: { workers: new Map() },
      planner: {
        async process(messages) {
          const view = messages
            .map((message) => String(message.content))
            .join('\n');
          assert.match(view, /s1 skipped first \(work t3, 3 older attempts\)/);
          assert.match(view, /no longer needed/);
          injected = true;
          return { ok: true, value: { content: 'ok' } };
        },
      },
    });
    delete plan.question;
    assert.deepEqual(session.snapshot().plan, plan);
    await session.send('show plan');
    assert.equal(injected, true);
    assert.deepEqual(session.snapshot().plan, plan);
    await session.close();
  });
}

test('active work cannot be replaced, even after a stop request, and dependents wait', async () => {
  const plan = mergePlan(undefined, steps, 'active');
  let finish!: (value: { output: string; stopped?: true }) => void;
  const board = new TaskBoard({
    workers: new Map([
      [
        'w',
        {
          name: 'w',
          capabilities: { contextPolicy: 'optional' as const },
          run: () =>
            new Promise<{ output: string; stopped?: true }>((resolve) => {
              finish = resolve;
            }),
        },
      ],
    ]),
    onEvent: (event) => applyTaskEvent(plan, event),
  });
  await runInPlannerScope(
    { board, getPlan: () => plan, setPlan() {} },
    async () => {
      // Start directly so the duplicate call observes the queued state before yielding.
      const first = board.start({ worker: 'w', goal: 'first' });
      assert.ok(first.ok);
      Object.assign(plan.steps[0], {
        state: 'running',
        workTaskId: first.value.id,
        taskIds: [first.value.id],
      });
      const delegate = (step_id = 's1') =>
        call('delegate_task', { worker: 'w', goal: 'retry', step_id });
      const queued = await delegate();
      assert.equal(queued.isError, true);
      assert.match(
        JSON.stringify(queued.content),
        /queued; stop it first with stop_task or wait/,
      );
      await tick();
      assert.equal(board.get('t1')?.state, 'running');
      assert.equal((await delegate()).isError, true);
      await call('stop_task', { task_id: 't1' });
      assert.equal((await delegate()).isError, true);
      assert.equal((await delegate('s2')).isError, true);
      assert.equal(plan.steps[0].workTaskId, 't1');
      assert.deepEqual(plan.steps[0].taskIds, ['t1']);
      assert.equal(board.list().length, 1);
      finish({ output: 'stopped', stopped: true });
      await tick();
      assert.equal((await delegate()).isError, undefined);
      await tick();
      assert.equal(plan.steps[0].workTaskId, 't2');
      assert.equal((await delegate('s2')).isError, true);
      finish({ output: 'retry complete' });
      await tick();
      assert.equal((await delegate('s2')).isError, undefined);
      await tick();
      finish({ output: 'dependent complete' });
      await tick();
    },
  );
  await board.stopAll();
});

test('view prioritizes actionable steps, counts every hidden state, and preserves all actionable details', () => {
  const plan = mergePlan(
    undefined,
    [
      ...Array.from({ length: 45 }, (_, i) => ({
        id: `failed${i}`,
        goal: 'failed goal',
      })),
      {
        id: 'ready',
        goal: 'action goal',
        worker: 'checker',
      },
      { id: 'running', goal: 'running goal' },
      { id: 'checking', goal: 'checking goal' },
      { id: 'pending', goal: 'pending goal', dependsOn: ['failed0'] },
      { id: 'blocked', goal: 'blocked goal' },
    ],
    'active',
  );
  plan.steps.slice(0, 45).forEach((s) => {
    s.state = 'failed';
  });
  plan.steps[46].state = 'running';
  plan.steps[47].state = 'running';
  plan.steps[49].state = 'blocked';
  const view = planView(plan);
  assert.match(view, /ready ready action goal/);
  assert.match(view, /running running running goal/);
  assert.match(view, /checking running checking goal/);
  assert.match(view, /pending pending pending goal \(depends on failed0\)/);
  assert.match(view, /9 failed steps collapsed/);
  assert.match(view, /1 blocked steps collapsed/);
  assert.equal(
    view
      .split('\n')
      .filter((line) =>
        /^(failed|ready|running|checking|pending|blocked)/.test(line),
      ).length,
    40,
  );
  plan.steps.forEach((s) => {
    s.state = 'running';
  });
  assert.equal(planView(plan).split('\n').length, 42);
  assert.match(planView(plan), /10 running steps collapsed; use get_plan/);
});

for (const state of ['failed', 'stopped', 'interrupted'] as const) {
  test(`settled ${state} work permits retry`, async () => {
    const plan = mergePlan(undefined, [steps[0]], 'active');
    Object.assign(plan.steps[0], {
      state: 'failed',
      workTaskId: 't1',
      taskIds: ['t1'],
    });
    const board = new TaskBoard({
      workers: new Map([
        [
          'w',
          {
            name: 'w',
            capabilities: { contextPolicy: 'optional' as const },
            async run() {
              return { output: 'ok' };
            },
          },
        ],
      ]),
      onEvent: (event) => applyTaskEvent(plan, event),
    });
    board.restore([outcome('t1', state).task]);
    await runInPlannerScope(
      { board, getPlan: () => plan, setPlan() {} },
      async () => {
        assert.equal(
          (
            await call('delegate_task', {
              worker: 'w',
              goal: 'retry',
              step_id: 's1',
            })
          ).isError,
          undefined,
        );
        assert.equal(plan.steps[0].workTaskId, 't2');
      },
    );
    await tick();
    await board.stopAll();
  });
}

test('corrective notes include normalized and bounded ready goals', async () => {
  let calls = 0;
  const session = await DialogueSession.open({
    id: 'trim-goal',
    maxCorrections: 1,
    board: { workers: new Map() },
    planner: {
      async process(messages) {
        if (++calls === 1)
          await call('update_plan', {
            steps: [
              { id: 'ready', goal: `  useful\n   goal ${'x'.repeat(300)}  ` },
            ],
          });
        else {
          const note = String(messages.at(-1)?.content);
          assert.ok(
            note.includes(
              `[check] Steps ready: ${`useful goal ${'x'.repeat(300)}`.slice(0, 200)} are ready`,
            ),
          );
          assert.ok(
            !note.slice(note.indexOf('[check]')).includes('x'.repeat(201)),
          );
        }
        return { ok: true, value: { content: 'ok' } };
      },
    },
  });
  await session.send('go');
  assert.equal(calls, 2);
  await session.close();
});

test('more than forty ready steps stay bounded and precede other active states', () => {
  const plan = mergePlan(
    undefined,
    [
      { id: 'running', goal: 'running' },
      { id: 'checking', goal: 'checking' },
      ...Array.from({ length: 45 }, (_, i) => ({
        id: `ready${i}`,
        goal: 'ready goal',
      })),
    ],
    'active',
  );
  plan.steps[0].state = 'running';
  plan.steps[1].state = 'running';
  const view = planView(plan);
  assert.equal(
    view.split('\n').filter((line) => /^ready\d+ ready /.test(line)).length,
    40,
  );
  assert.match(view, /5 pending steps collapsed; use get_plan/);
  assert.match(view, /2 running steps collapsed; use get_plan/);
  assert.doesNotMatch(view, /^ready40 /m);
});

for (const worker of ['w', 'checker']) {
  test(`active ${worker} step cannot be replaced until its cooperative stop settles`, async () => {
    const plan = mergePlan(
      undefined,
      [
        { id: 'source', goal: 'source' },
        { id: 's1', goal: 'task', worker, dependsOn: ['source'] },
      ],
      'active',
    );
    Object.assign(plan.steps[0], {
      state: 'done',
      taskIds: ['source'],
      successfulWorkTaskId: 'source',
    });
    let finish!: (value: { output: string; stopped?: true }) => void;
    const board = new TaskBoard({
      workers: new Map([
        [
          worker,
          {
            name: worker,
            capabilities: { contextPolicy: 'optional' as const },
            run: () =>
              new Promise<{ output: string; stopped?: true }>((resolve) => {
                finish = resolve;
              }),
          },
        ],
      ]),
      onEvent: (e) => applyTaskEvent(plan, e),
    });
    board.restore([outcome('source', 'done', 'source result').task]);
    await runInPlannerScope(
      { board, getPlan: () => plan, setPlan() {} },
      async () => {
        const delegate = () =>
          call('delegate_task', { worker, goal: 'task', step_id: 's1' });
        const first = tools.callTool('delegate_task', {
          worker,
          goal: 'task',
          step_id: 's1',
        });
        const queued = await delegate();
        assert.equal(queued.isError, true);
        assert.match(JSON.stringify(queued.content), /Task attempt .*queued/);
        assert.ok((await first).ok);
        await tick();
        assert.equal((await delegate()).isError, true);
        const id = plan.steps[1].workTaskId;
        assert.ok(id);
        await call('stop_task', { task_id: id });
        assert.equal((await delegate()).isError, true);
        assert.equal(board.list().length, 2);
        finish({ output: 'stopped', stopped: true });
        await tick();
        assert.equal(plan.steps[1].state, 'failed');
        assert.equal((await delegate()).isError, undefined);
        await tick();
        finish({ output: worker === 'checker' ? 'PASS' : 'work result' });
        await tick();
        assert.equal(plan.steps[1].state, 'done');
      },
    );
    await board.stopAll();
  });
}

for (const attempt of ['work', 'check'] as const) {
  test(`update_plan refuses removing active ${attempt} until stop settles`, async () => {
    let plan = mergePlan(undefined, [steps[0]], 'active');
    let finish!: (value: { output: string }) => void;
    const board = new TaskBoard({
      workers: new Map([
        [
          'w',
          {
            name: 'w',
            capabilities: { contextPolicy: 'optional' as const },
            run: () =>
              new Promise<{ output: string }>((resolve) => {
                finish = resolve;
              }),
          },
        ],
      ]),
      onEvent: (event) => applyTaskEvent(plan, event),
    });
    await runInPlannerScope(
      {
        board,
        getPlan: () => plan,
        setPlan: (p) => {
          assert.ok(typeof p === 'object');
          plan = p;
        },
      },
      async () => {
        const first = board.start({ worker: 'w', goal: 'held' });
        assert.ok(first.ok);
        plan.steps[0].taskIds = [first.value.id];
        plan.steps[0].worker = attempt === 'check' ? 'checker' : 'w';
        plan.steps[0].workTaskId = first.value.id;
        plan.scopeConsent = true;
        const original = structuredClone(plan);
        const refuse = async () => {
          for (const replacement of [{ steps: [] }, { plan: 'replacement' }]) {
            const result = await call('update_plan', replacement);
            assert.equal(result.isError, true);
            assert.match(
              JSON.stringify(result.content),
              /Cannot remove step s1.*stop the task first.*or keep the step/,
            );
            assert.deepEqual(plan, original);
          }
        };
        await refuse();
        await tick();
        await refuse();
        await call('stop_task', { task_id: first.value.id });
        await refuse();
        finish({ output: 'settled' });
        await tick();
        assert.equal(
          (await call('update_plan', { steps: [] })).isError,
          undefined,
        );
        assert.equal(
          (await call('update_plan', { steps: [steps[0]] })).isError,
          undefined,
        );
        assert.deepEqual(plan.steps[0].taskIds, []);
        applyTaskEvent(
          plan,
          outcome(first.value.id, 'done'),
          new Map([[first.value.id, 's1']]),
        );
        assert.equal(plan.steps[0].state, 'pending');
        assert.equal(
          (
            await call('delegate_task', {
              worker: 'w',
              goal: 'retry',
              step_id: 's1',
            })
          ).isError,
          undefined,
        );
        await tick();
        finish({ output: 'retry complete' });
        await tick();
      },
    );
    await board.stopAll();
  });
}

for (const remove of [false, true]) {
  test(`session routes outcome with ${remove ? 'removed' : 'retained'} step ownership`, async () => {
    let calls = 0;
    const session = await DialogueSession.open({
      id: `ownership-${remove}`,
      maxCorrections: 0,
      board: {
        workers: new Map([
          [
            'w',
            {
              name: 'w',
              capabilities: { contextPolicy: 'optional' as const },
              async run() {
                return { output: 'original outcome' };
              },
            },
          ],
        ]),
      },
      planner: {
        async process(messages) {
          if (++calls === 1) {
            await call('update_plan', { steps: [steps[0]] });
            await call('delegate_task', {
              step_id: 's1',
              worker: 'w',
              goal: 'first',
            });
            await tick();
            assert.equal(getPlan(session).steps[0].state, 'done');
            if (remove) await call('update_plan', { steps: [] });
            const store = new InMemoryDialogueStateStore();
            // Exercise a JSON persistence boundary after the completed step is removed.
            await store.save(
              'round-trip',
              JSON.parse(JSON.stringify(session.snapshot())),
            );
            const restored = await DialogueSession.open({
              id: 'round-trip',
              store,
              board: { workers: new Map() },
              planner: {
                async process() {
                  return { ok: true, value: { content: 'ok' } };
                },
              },
            });
            assert.deepEqual(restored.snapshot().taskSteps, { t1: 's1' });
            // Verify the persisted ownership through the public snapshot. The event
            // is observed by the original session's next planner turn below.
            assert.equal(
              restored.snapshot().tasks[0].output,
              'original outcome',
            );
            await restored.close();
          } else {
            const text = String(messages.at(-1)?.content);
            assert.match(
              text,
              remove
                ? /\[actions\] task t1 for s1/
                : /\[task events\] task t1 for s1/,
            );
            if (remove) {
              assert.doesNotMatch(text, /\[task events\]/);
              await call('update_plan', { steps: [steps[0]] });
              assert.equal(getPlan(session).steps[0].state, 'pending');
            }
          }
          return { ok: true, value: { content: 'ok' } };
        },
      },
    });
    await session.send('go');
    await tick();
    assert.equal(calls, 2);
    await session.close();
  });
}
