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
  assert.deepEqual(
    readySteps(plan).map((s) => s.id),
    ['s2'],
  );
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
  assert.match(view, /10 older done\/skipped steps collapsed/);
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
              /\[check\] Steps s1 are ready/,
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
            /\[check\] Steps s2 are ready/,
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
