import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DialoguePlan, TaskEvent } from '@mcp-abap-adt/llm-agent';
import { DialogueSession } from '../dialogue-session.js';
import { InMemoryDialogueStateStore } from '../in-memory-dialogue-state-store.js';
import { runInPlannerScope } from '../planner-scope.js';
import { PlannerToolsClient } from '../planner-tools-client.js';
import {
  applyTaskEvent,
  deliveryChecksPassed,
  mergePlan as mergeStructuredPlan,
  readySteps,
} from '../structured-plan.js';
import { TaskBoard } from '../task-board.js';

import { profileHost } from './profile-test-host.js';

function mergePlan(
  ...args: Parameters<typeof mergeStructuredPlan>
): DialoguePlan {
  return mergeStructuredPlan(args[0], args[1], args[2], args[3], {
    resolveResult: (name) =>
      name === 'audit' || name === 'checker' ? 'verdict' : 'report',
    ...args[4],
  });
}

const steps = [
  { id: 'work', goal: 'Produce result', worker: 'writer' },
  {
    id: 'check',
    goal: 'Verify result',
    worker: 'audit',
    dependsOn: ['work'],
  },
];
function done(id: string, output: string): TaskEvent {
  return {
    kind: 'done',
    task: {
      id,
      worker: 'writer',
      goal: 'work',
      state: 'done',
      createdAt: 0,
      output,
    },
  };
}
function finish(
  plan: DialoguePlan,
  stepId: string,
  taskId: string,
  output: string,
): void {
  const step = plan.steps.find((s) => s.id === stepId);
  assert.ok(step);
  if (step.worker === 'audit')
    step.checkedTaskIds = Object.fromEntries(
      (step.dependsOn ?? []).map((id) => [
        id,
        plan.steps.find((s) => s.id === id)?.successfulWorkTaskId ?? 'missing',
      ]),
    );
  step.taskIds.push(taskId);
  step.workTaskId = taskId;
  applyTaskEvent(plan, done(taskId, output));
}

test('failed check leads to a fix and a new check with independent results', async () => {
  let plan = mergePlan(undefined, steps, 'active');
  finish(plan, 'work', 'original', 'draft');
  finish(plan, 'check', 'bad-check', 'FAIL');
  assert.equal(deliveryChecksPassed(plan, 'work'), false);
  const revised = [
    ...steps,
    {
      id: 'fix',
      goal: 'Correct the gap',
      worker: 'writer',
      dependsOn: ['work'],
    },
    {
      id: 'recheck',
      goal: 'Check corrected result',
      worker: 'audit',
      dependsOn: ['fix'],
    },
  ];
  plan = mergePlan(plan, revised, 'active');
  assert.deepEqual(
    readySteps(plan).map((s) => s.id),
    ['fix'],
  );
  finish(plan, 'fix', 'fixed', 'corrected result');
  let context = '';
  const board = new TaskBoard({
    ...profileHost(
      new Map([
        [
          'audit',
          {
            name: 'audit',
            capabilities: { contextPolicy: 'optional' as const },
            async run(input: { context?: string }) {
              context = input.context ?? '';
              return { output: 'PASS' };
            },
          },
        ],
      ]),
    ),
    onEvent: (e) => applyTaskEvent(plan, e),
  });
  board.restore([done('fixed', 'corrected result').task]);
  await runInPlannerScope(
    { board, getPlan: () => plan, setPlan() {} },
    async () => {
      const result = await new PlannerToolsClient().callTool('delegate_task', {
        step_id: 'recheck',
        worker: 'audit',
        goal: 'Check corrected result',
      });
      assert.ok(result.ok);
      assert.equal(result.value.isError, undefined);
    },
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.match(
    context,
    /\[result to check: step fix \(task fixed\)\]\ncorrected result/,
  );
  assert.equal(plan.steps[1].state, 'failed');
  assert.equal(plan.steps[3].verdict, 'pass');
  assert.deepEqual(plan.steps[3].checkedTaskIds, { fix: 'fixed' });
  assert.equal(deliveryChecksPassed(plan, 'fix'), true);
  await board.stopAll();
});

test('delivery permits unchecked results and requires passing current attempts of all checks', () => {
  const plan = mergePlan(undefined, steps, 'active');
  finish(plan, 'work', 'work-task', 'result');
  assert.equal(deliveryChecksPassed(plan, 'work'), false);
  finish(plan, 'check', 'check-task', 'PASS');
  assert.equal(deliveryChecksPassed(plan, 'work'), true);
  finish(plan, 'check', 'check-retry', 'FAIL');
  assert.equal(deliveryChecksPassed(plan, 'work'), false);
  applyTaskEvent(plan, done('check-task', 'PASS'));
  assert.equal(deliveryChecksPassed(plan, 'work'), false);
  const unchecked = mergePlan(undefined, [steps[0]], 'active');
  assert.equal(deliveryChecksPassed(unchecked, 'work'), true);
  const two = mergePlan(
    undefined,
    [...steps, { ...steps[1], id: 'second-check' }],
    'active',
  );
  finish(two, 'work', 'source', 'result');
  finish(two, 'check', 'passing', 'PASS');
  assert.equal(deliveryChecksPassed(two, 'work'), true);
  finish(two, 'second-check', 'failing', 'FAIL');
  assert.equal(deliveryChecksPassed(two, 'work'), false);
});

test('audit refuses a source result produced by the audit worker', async () => {
  const plan = mergePlan(undefined, steps, 'active');
  Object.assign(plan.steps[0], {
    state: 'done',
    taskIds: ['source'],
    successfulWorkTaskId: 'source',
  });
  const board = new TaskBoard({
    ...profileHost(
      new Map([
        [
          'audit',
          {
            name: 'audit',
            capabilities: { contextPolicy: 'optional' },
            async run() {
              throw new Error('must not run');
            },
          },
        ],
      ]),
    ),
    onEvent() {},
  });
  board.restore([{ ...done('source', 'result').task, worker: 'audit' }]);
  await runInPlannerScope(
    { board, getPlan: () => plan, setPlan() {} },
    async () => {
      const result = await new PlannerToolsClient().callTool('delegate_task', {
        step_id: 'check',
        worker: 'audit',
        goal: 'Verify',
      });
      assert.ok(result.ok);
      assert.equal(result.value.isError, true);
      assert.match(
        JSON.stringify(result.value.content),
        /worker that did the work never checks it/,
      );
      assert.equal(board.list().length, 1);
    },
  );
});

for (const legacyState of ['checking', 'done', 'failed'] as const) {
  test(`restore drops legacy check metadata and migrates ${legacyState}`, async () => {
    const plan = mergePlan(undefined, [steps[0]], 'active');
    // Model the old wire format without adding legacy fields to the public API.
    Object.assign(plan.steps[0], {
      state: legacyState,
      taskIds: ['work-task', 'legacy-check'],
      check: { by: 'checker', goal: 'Verify', taskId: 'legacy-check' },
    });
    const store = new InMemoryDialogueStateStore();
    await store.save('legacy', {
      plan,
      tasks: [
        done('work-task', 'result').task,
        { ...done('legacy-check', 'PASS').task, worker: 'checker' },
      ],
      conversation: [],
      pending: [],
      savedAt: 0,
    });
    const session = await DialogueSession.open({
      id: 'legacy',
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
    const step = restored.steps[0];
    assert.equal('check' in step, false);
    assert.equal(step.state, legacyState === 'checking' ? 'done' : legacyState);
    assert.equal(step.successfulWorkTaskId, 'work-task');
    assert.deepEqual(step.taskIds, ['work-task', 'legacy-check']);
    if (legacyState === 'checking')
      assert.match(step.note ?? '', /Legacy check was not run/);
    await session.close();
  });
}

test('new successful source results reset checks and require a fresh bound verdict', () => {
  const plan = mergePlan(undefined, steps, 'active');
  finish(plan, 'work', 'v1', 'first');
  finish(plan, 'check', 'c1', 'PASS');
  assert.equal(deliveryChecksPassed(plan, 'work'), true);
  const saved = structuredClone(plan);
  finish(plan, 'work', 'v2', 'changed');
  assert.equal(plan.steps[1].state, 'pending');
  assert.equal(plan.steps[1].verdict, undefined);
  assert.match(plan.steps[1].note ?? '', /delegate this check again/);
  assert.equal(deliveryChecksPassed(plan, 'work'), false);
  applyTaskEvent(plan, done('c1', 'PASS'));
  assert.equal(plan.steps[1].state, 'pending');
  saved.steps[0].successfulWorkTaskId = 'v2';
  assert.equal(deliveryChecksPassed(saved, 'work'), false);
  finish(plan, 'check', 'c2', 'PASS');
  assert.deepEqual(plan.steps[1].checkedTaskIds, { work: 'v2' });
  assert.equal(deliveryChecksPassed(plan, 'work'), true);
});

for (const malformed of [
  '{"verdict":"fail","note":12}',
  '{"verdict":"pass","count":"2"}',
  '{"verdict":"pass","count":-1}',
  '{"verdict":"pass","count":1.5}',
  '{"verdict":"invalid"}',
]) {
  for (const output of [
    `${malformed} {"verdict":"pass"}`,
    `{"verdict":"pass"} ${malformed}`,
  ]) {
    test(`malformed candidate invalidates the whole verdict: ${output}`, () => {
      const plan = mergePlan(undefined, steps, 'active');
      finish(plan, 'work', 'source', 'result');
      finish(plan, 'check', 'check-task', output);
      assert.equal(plan.steps[1].state, 'failed');
      assert.equal(plan.steps[1].verdict, 'fail');
      assert.match(plan.steps[1].note ?? '', /unusable verdict/);
    });
  }
}

for (const plan of [
  undefined,
  'Legacy text plan',
  {
    version: 1 as const,
    status: 'active' as const,
    steps: [],
    note: 'Legacy text plan',
  },
]) {
  test(`legacy checker delegation remains supported: ${JSON.stringify(plan)}`, async () => {
    const board = new TaskBoard({
      workers: new Map([
        [
          'checker',
          {
            name: 'checker',
            capabilities: { contextPolicy: 'optional' as const },
            async run() {
              return { output: 'PASS' };
            },
          },
        ],
      ]),
      onEvent() {},
    });
    try {
      await runInPlannerScope(
        { board, getPlan: () => plan, setPlan() {} },
        async () => {
          const result = await new PlannerToolsClient().callTool(
            'delegate_task',
            { worker: 'checker', goal: 'Verify legacy work' },
          );
          assert.ok(result.ok);
          assert.equal(result.value.isError, undefined);
          assert.equal(board.list().length, 1);
        },
      );
    } finally {
      await board.stopAll();
    }
  });
}

test('a running multi-source check cannot pass after either source changes', () => {
  const plan = mergePlan(
    undefined,
    [
      steps[0],
      { id: 'other', goal: 'Other result' },
      { ...steps[1], dependsOn: ['work', 'other'] },
    ],
    'active',
  );
  finish(plan, 'work', 'v1', 'first');
  finish(plan, 'other', 'o1', 'other');
  const check = plan.steps[2];
  Object.assign(check, {
    state: 'running',
    taskIds: ['c1'],
    workTaskId: 'c1',
    checkedTaskIds: { work: 'v1', other: 'o1' },
  });
  finish(plan, 'other', 'o2', 'changed');
  assert.equal(check.state, 'pending');
  applyTaskEvent(plan, done('c1', 'PASS'));
  assert.equal(check.state, 'pending');
  assert.equal(deliveryChecksPassed(plan, 'work'), false);
  finish(plan, 'check', 'c2', 'PASS');
  assert.equal(deliveryChecksPassed(plan, 'work'), true);
  assert.equal(deliveryChecksPassed(plan, 'other'), true);
});
