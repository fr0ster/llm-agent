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
  kind: TaskEvent['kind'],
  output?: string,
): TaskEvent {
  return {
    kind,
    task: {
      id,
      worker: 'w',
      goal: 'work',
      state: kind === 'started' ? 'running' : kind,
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

test('delegation requires step id, refuses dependencies, links work and checker, action notes include steps', async () => {
  let plan = mergePlan(undefined, steps, 'active');
  const actions: string[] = [];
  const board = new TaskBoard({
    workers: new Map(
      ['w', 'checker'].map((name) => [
        name,
        {
          name,
          capabilities: { contextPolicy: 'optional' as const },
          async run() {
            return { output: '{"verdict":"pass"}' };
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
      setPlan: (p) => {
        assert.equal(typeof p, 'object');
        plan = p as DialoguePlan;
      },
      history: () => [],
      recordAction: (a) => actions.push(a),
    },
    async () => {
      assert.equal(
        (await call('delegate_task', { worker: 'w', goal: 'x' })).isError,
        true,
      );
      assert.equal(
        (await call('delegate_task', { step_id: 's2', worker: 'w', goal: 'x' }))
          .isError,
        true,
      );
      assert.equal(
        (await call('delegate_task', { step_id: 's1', worker: 'w', goal: 'x' }))
          .isError,
        undefined,
      );
      assert.equal(plan.steps[0].state, 'running');
      await tick();
      assert.equal(plan.steps[0].state, 'done');
      assert.deepEqual(plan.steps[0].taskIds, ['t1']);
      await call('update_plan', {
        steps: [
          steps[0],
          { ...steps[1], check: { by: 'checker', goal: 'verify' } },
        ],
      });
      await call('delegate_task', { step_id: 's2', worker: 'w', goal: 'x' });
      await tick();
      assert.equal(plan.steps[1].state, 'checking');
      await call('delegate_task', {
        step_id: 's2',
        worker: 'checker',
        goal: 'verify',
      });
      await tick();
      assert.equal(plan.steps[1].state, 'done');
      assert.equal(plan.steps[1].check?.verdict, 'pass');
      assert.deepEqual(plan.steps[1].taskIds, ['t2', 't3']);
      assert.ok(actions.includes('started t3 for s2 (checker)'));
      assert.equal(
        (await call('update_plan', { steps, status: 'waiting_user' })).isError,
        true,
      );
    },
  );
  await board.stopAll();
});

for (const verdict of ['pass', 'fail', 'invalid']) {
  test(`checker ${verdict} and planner verdict override`, () => {
    let plan = mergePlan(
      undefined,
      [{ ...steps[0], check: { by: 'planner', goal: 'inspect' } }],
      'active',
    );
    plan.steps[0].taskIds = ['t1'];
    applyTaskEvent(plan, outcome('t1', 'done', 'work'));
    assert.equal(plan.steps[0].state, 'checking');
    plan = mergePlan(
      plan,
      [{ ...steps[0], state: 'done', note: 'inspected' }],
      'active',
    );
    assert.equal(plan.steps[0].state, 'done');
    assert.equal(plan.steps[0].note, 'inspected');
    plan.steps[0].check = { by: 'checker', goal: 'verify', taskId: 't2' };
    plan.steps[0].taskIds.push('t2');
    applyTaskEvent(
      plan,
      outcome(
        't2',
        'done',
        verdict === 'invalid'
          ? 'PASS'
          : JSON.stringify({ verdict, note: 'reason' }),
      ),
    );
    assert.equal(
      plan.steps[0].state,
      verdict === 'pass' ? 'done' : verdict === 'fail' ? 'failed' : 'checking',
    );
    if (verdict !== 'invalid') assert.equal(plan.steps[0].note, 'reason');
    for (const kind of ['failed', 'stopped'] as const) {
      applyTaskEvent(plan, outcome('t2', kind));
      assert.equal(plan.steps[0].state, 'failed');
    }
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
  assert.equal((s.snapshot().plan as DialoguePlan).status, 'waiting_user');
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
  assert.deepEqual(
    (restored.snapshot().plan as DialoguePlan).steps[0].taskIds,
    ['t1'],
  );
  await s.send('yes');
  assert.equal((s.snapshot().plan as DialoguePlan).status, 'done');
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

test('planner-as-checker closes through update_plan with state and note', async () => {
  let calls = 0;
  const session = await DialogueSession.open({
    id: 'planner-check',
    board: {
      workers: new Map([
        [
          'w',
          {
            name: 'w',
            capabilities: { contextPolicy: 'optional' },
            async run() {
              return { output: 'result to inspect' };
            },
          },
        ],
      ]),
    },
    planner: {
      async process() {
        calls++;
        const checked = [
          { ...steps[0], check: { by: 'planner', goal: 'inspect result' } },
        ];
        if (calls === 1) {
          await call('update_plan', { steps: checked });
          await call('delegate_task', {
            step_id: 's1',
            worker: 'w',
            goal: 'work',
          });
        } else {
          const before = session.snapshot().plan as DialoguePlan;
          assert.equal(before.steps[0].state, 'checking');
          assert.equal(
            (
              await call('update_plan', {
                steps: [{ ...checked[0], state: 'done' }],
              })
            ).isError,
            true,
          );
          await call('get_task', { task_id: before.steps[0].taskIds[0] });
          assert.equal(
            (
              await call('update_plan', {
                steps: [
                  { ...checked[0], state: 'done', note: 'result verified' },
                ],
              })
            ).isError,
            undefined,
          );
        }
        return { ok: true, value: { content: 'ok' } };
      },
    },
  });
  await session.send('go');
  await tick();
  await tick();
  const plan = session.snapshot().plan as DialoguePlan;
  assert.equal(plan.status, 'done');
  assert.equal(plan.steps[0].check?.verdict, 'pass');
  assert.equal(plan.steps[0].note, 'result verified');
  await session.close();
});

test('structured restore preserves checker links and interrupts an unfinished check', async () => {
  const store = new InMemoryDialogueStateStore();
  const plan = mergePlan(
    undefined,
    [{ ...steps[0], check: { by: 'checker', goal: 'verify' } }],
    'active',
  );
  plan.steps[0].state = 'running';
  plan.steps[0].taskIds = ['t1', 't2'];
  if (plan.steps[0].check) plan.steps[0].check.taskId = 't2';
  await store.save('restore-check', {
    plan,
    tasks: [outcome('t1', 'done').task, outcome('t2', 'started').task],
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
  const restored = session.snapshot().plan as DialoguePlan;
  assert.deepEqual(restored.steps[0].taskIds, ['t1', 't2']);
  assert.equal(restored.steps[0].check?.taskId, 't2');
  assert.equal(restored.steps[0].state, 'failed');
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
    readySteps(session.snapshot().plan as DialoguePlan).map((s) => s.id),
    ['s2'],
  );
  await session.close();
});

test('checker cannot overtake work; retries ignore superseded work and check outcomes', async () => {
  const plan = mergePlan(
    undefined,
    [{ ...steps[0], check: { by: 'checker', goal: 'verify' } }],
    'active',
  );
  let finish!: (value: { output: string }) => void;
  const board = new TaskBoard({
    workers: new Map(
      ['w', 'checker'].map((name) => [
        name,
        {
          name,
          capabilities: { contextPolicy: 'optional' as const },
          run: () =>
            name === 'checker'
              ? Promise.resolve({ output: '{"verdict":"pass"}' })
              : new Promise<{ output: string }>((resolve) => {
                  finish = resolve;
                }),
        },
      ]),
    ),
    onEvent: (event) => applyTaskEvent(plan, event),
  });
  await runInPlannerScope(
    { board, getPlan: () => plan, setPlan() {}, history: () => [] },
    async () => {
      const delegate = (worker: string) =>
        call('delegate_task', { worker, goal: 'work', step_id: 's1' });
      assert.equal((await delegate('checker')).isError, true);
      await delegate('w');
      await tick();
      assert.equal((await delegate('checker')).isError, true);
      assert.deepEqual(plan.steps[0].taskIds, ['t1']);
      finish({ output: 'finished' });
      await tick();
      assert.equal(plan.steps[0].state, 'checking');
      await delegate('checker');
      await tick();
      assert.equal(plan.steps[0].state, 'done');
      await delegate('w');
      await tick();
      applyTaskEvent(plan, outcome('t1', 'failed'));
      applyTaskEvent(plan, outcome('t2', 'done', '{"verdict":"pass"}'));
      assert.equal(plan.steps[0].state, 'running');
      assert.match(planView(plan), /\(work t3, 2 older attempts\)/);
      assert.doesNotMatch(planView(plan), /check t2/);
      assert.equal((await delegate('checker')).isError, true);
      finish({ output: 'retry finished' });
      await tick();
      assert.equal(plan.steps[0].state, 'checking');
      await delegate('checker');
      await tick();
      assert.equal(plan.steps[0].state, 'done');
      assert.match(planView(plan), /\(work t3, check t4, 2 older attempts\)/);
      assert.match(planView(plan), /check by checker: verify/);
    },
  );
  await board.stopAll();
});

test('appending a check never hides the current work failure', () => {
  const plan = mergePlan(undefined, [steps[0]], 'active');
  Object.assign(plan.steps[0], {
    workTaskId: 't1',
    taskIds: ['t1', 't2'],
    check: { by: 'checker', goal: 'verify', taskId: 't2' },
  });
  applyTaskEvent(plan, outcome('t2', 'done', '{"verdict":"pass"}'));
  applyTaskEvent(plan, outcome('t1', 'failed'));
  assert.equal(plan.steps[0].state, 'failed');
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
    const restored = session.snapshot().plan as DialoguePlan;
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
        assert.equal(typeof p, 'object');
        plan = p as DialoguePlan;
      },
      history: () => [],
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

for (const by of ['planner', 'checker'] as const) {
  test(`skips ignore work and check outcomes (${by})`, () => {
    const plan = mergePlan(undefined, [steps[0]], 'done');
    Object.assign(plan.steps[0], {
      state: 'skipped',
      note: 'no longer needed',
      taskIds: ['t1', 't2'],
      workTaskId: 't1',
      check: { by, goal: 'verify', taskId: 't2' },
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
      check: { by, goal: '  inspect\n  the result  ', taskId: 't4' },
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
      store,
      board: { workers: new Map() },
      planner: {
        async process(messages) {
          const view = messages
            .map((message) => String(message.content))
            .join('\n');
          assert.match(
            view,
            /s1 skipped first \(work t3, check t4, 2 older attempts\)/,
          );
          assert.ok(
            view.includes(
              `check by ${by}: inspect the result ? no longer needed`,
            ),
          );
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
  let finish!: (value: { output: string; stopped?: boolean }) => void;
  const board = new TaskBoard({
    workers: new Map([
      [
        'w',
        {
          name: 'w',
          capabilities: { contextPolicy: 'optional' as const },
          run: () =>
            new Promise<{ output: string; stopped?: boolean }>((resolve) => {
              finish = resolve;
            }),
        },
      ],
    ]),
    onEvent: (event) => applyTaskEvent(plan, event),
  });
  await runInPlannerScope(
    { board, getPlan: () => plan, setPlan() {}, history: () => [] },
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
        check: { by: 'planner', goal: 'verify action' },
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
  plan.steps[47].state = 'checking';
  plan.steps[49].state = 'blocked';
  const view = planView(plan);
  assert.match(
    view,
    /ready ready action goal; check by planner: verify action/,
  );
  assert.match(view, /running running running goal/);
  assert.match(view, /checking checking checking goal/);
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
      { board, getPlan: () => plan, setPlan() {}, history: () => [] },
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
  plan.steps[1].state = 'checking';
  const view = planView(plan);
  assert.equal(
    view.split('\n').filter((line) => /^ready\d+ ready /.test(line)).length,
    40,
  );
  assert.match(view, /5 pending steps collapsed; use get_plan/);
  assert.match(view, /1 running steps collapsed; use get_plan/);
  assert.match(view, /1 checking steps collapsed; use get_plan/);
  assert.doesNotMatch(view, /^ready40 /m);
});

test('active checker cannot be replaced while queued, running or awaiting cooperative stop', async () => {
  const plan = mergePlan(
    undefined,
    [{ ...steps[0], check: { by: 'checker', goal: 'verify' } }],
    'active',
  );
  const step = plan.steps[0];
  Object.assign(step, {
    state: 'checking',
    workTaskId: 'work',
    taskIds: ['work'],
  });
  let finish!: (value: { output: string; stopped?: boolean }) => void;
  const board = new TaskBoard({
    workers: new Map([
      [
        'checker',
        {
          name: 'checker',
          capabilities: { contextPolicy: 'optional' as const },
          run: () =>
            new Promise<{ output: string; stopped?: boolean }>((resolve) => {
              finish = resolve;
            }),
        },
      ],
    ]),
    onEvent: (event) => applyTaskEvent(plan, event),
  });
  await runInPlannerScope(
    { board, getPlan: () => plan, setPlan() {}, history: () => [] },
    async () => {
      // Start without yielding so the first duplicate observes the queued checker.
      const first = tools.callTool('delegate_task', {
        worker: 'checker',
        goal: 'verify',
        step_id: 's1',
      });
      const delegate = () =>
        call('delegate_task', {
          worker: 'checker',
          goal: 'duplicate',
          step_id: 's1',
        });
      const queued = await delegate();
      assert.equal(queued.isError, true);
      assert.match(JSON.stringify(queued.content), /check attempt t1.*queued/);
      assert.ok((await first).ok);
      await tick();
      assert.equal(board.get('t1')?.state, 'running');
      assert.equal((await delegate()).isError, true);
      await call('stop_task', { task_id: 't1' });
      assert.equal(board.get('t1')?.state, 'running');
      assert.equal((await delegate()).isError, true);
      assert.equal(step.check?.taskId, 't1');
      assert.deepEqual(step.taskIds, ['work', 't1']);
      assert.equal(board.list().length, 1);
      finish({ output: 'stopped', stopped: true });
      await tick();
      assert.equal(step.state, 'failed');
      // A settled checker can be retried after the planner reopens the check.
      step.state = 'checking';
      assert.equal((await delegate()).isError, undefined);
      assert.equal(step.check?.taskId, 't2');
      await tick();
      finish({ output: '{"verdict":"pass"}' });
      await tick();
      assert.equal(step.state, 'done');
      assert.equal(step.check?.verdict, 'pass');
    },
  );
  await board.stopAll();
});
