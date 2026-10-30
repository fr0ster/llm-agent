import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DialoguePlan, TaskEvent } from '@mcp-abap-adt/llm-agent';
import { SmartAgent } from '../../../agent.js';
import { SmartAgentSubAgent } from '../../../subagent/smart-agent-subagent.js';
import { makeAssembler, makeDefaultDeps } from '../../../testing/index.js';
import { DialogueSession } from '../dialogue-session.js';
import { runInPlannerScope } from '../planner-scope.js';
import { PlannerToolsClient } from '../planner-tools-client.js';
import {
  applyTaskEvent,
  mergePlan as mergeStructuredPlan,
  planView,
} from '../structured-plan.js';
import { TaskBoard } from '../task-board.js';

import { profileHost } from './profile-test-host.js';

function mergePlan(
  ...args: Parameters<typeof mergeStructuredPlan>
): DialoguePlan {
  return mergeStructuredPlan(args[0], args[1], args[2], args[3], {
    resolveResult: (name) => (name === 'audit' ? 'verdict' : 'report'),
    ...args[4],
  });
}

const tools = new PlannerToolsClient();
const batch = {
  id: 'batch',
  goal: 'Store results',
  items: ['a', 'b'],
};

for (const attempt of ['work', 'check'] as const) {
  test(`membership changes reject active ${attempt} and invalidate settled attempts`, async () => {
    let plan = mergePlan(undefined, [batch], 'active');
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
      onEvent: (e) => applyTaskEvent(plan, e),
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
        const task = board.start({ worker: 'w', goal: 'held' });
        assert.ok(task.ok);
        const step = plan.steps[0];
        step.taskIds = ['old-work', task.value.id];
        step.workTaskId = attempt === 'work' ? task.value.id : 'old-work';
        step.worker = attempt === 'check' ? 'audit' : 'w';
        step.result = attempt === 'check' ? 'verdict' : 'report';
        step.workTaskId = task.value.id;
        step.state = 'running';
        plan.scopeConsent = true;
        const changed = {
          ...batch,
          items: ['a', 'replacement'],
          state: 'pending',
        };
        const before = structuredClone(plan);
        assert.equal((await update({ steps: [changed] })).isError, true);
        assert.deepEqual(plan, before);
        assert.equal(
          (await update({ steps: [{ ...batch, state: 'pending' }] })).isError,
          true,
        );
        assert.deepEqual(plan, before);
        await new Promise<void>((r) => setImmediate(r));
        assert.equal((await update({ steps: [changed] })).isError, true);
        finish({ output: '{"verdict":"pass","count":2}' });
        await new Promise<void>((r) => setImmediate(r));
        assert.equal((await update({ steps: [changed] })).isError, undefined);
        assert.deepEqual(plan.steps[0].taskIds, []);
        assert.equal(plan.steps[0].workTaskId, undefined);
        assert.equal(plan.steps[0].verdict, undefined);
        applyTaskEvent(
          plan,
          event(task.value.id, '{"verdict":"pass","count":2}'),
          new Map([[task.value.id, batch.id]]),
        );
        assert.equal(plan.steps[0].state, 'pending');
      },
    );
    await board.stopAll();
  });
}

test('audit role cannot change while retaining successful evidence', () => {
  const plan = mergePlan(
    undefined,
    [{ id: 'verify', goal: 'Verify', worker: 'audit' }],
    'active',
  );
  Object.assign(plan.steps[0], {
    state: 'failed',
    taskIds: ['check'],
    workTaskId: 'check',
    verdict: 'fail',
  });
  assert.throws(
    () =>
      mergePlan(
        plan,
        [{ id: 'verify', goal: 'Verify', worker: 'w', state: 'done' }],
        'active',
      ),
    /reopening/,
  );
  const reopened = mergePlan(
    plan,
    [{ id: 'verify', goal: 'Verify', worker: 'audit', state: 'pending' }],
    'active',
  );
  assert.equal(reopened.steps[0].verdict, undefined);
  assert.equal(reopened.steps[0].successfulWorkTaskId, undefined);
});

for (const kind of ['failed', 'stopped'] as const) {
  test(`budget exhaustion preserves ${kind} work outcome`, () => {
    const plan = mergePlan(undefined, [{ id: 'work', goal: 'Work' }], 'active');
    plan.steps[0].taskIds = ['task'];

    plan.steps[0].workTaskId = 'task';
    const result = event('task');
    result.kind = kind;
    result.task.state = kind;
    result.task.error = 'Original failure';
    result.task.budgetExhausted = true;
    applyTaskEvent(plan, result);
    assert.equal(plan.steps[0].state, 'failed');
    assert.equal(plan.steps[0].note, 'Original failure');
    assert.equal('check' in plan.steps[0], false);
  });
}
async function update(args: Record<string, unknown>) {
  const result = await tools.callTool('update_plan', args);
  assert.ok(result.ok);
  return result.value;
}
function event(id: string, output = ''): TaskEvent {
  return {
    kind: 'done',
    task: {
      id,
      worker: 'w',
      goal: 'work',
      state: 'done',
      createdAt: 0,
      output,
    },
  };
}

for (const change of ['skip', 'remove', 'reduce', 'replace'] as const) {
  test(`scope ${change} needs a user response after a waiting question; consent is consumed`, async () => {
    let turn = 0;
    const narrowed =
      change === 'remove'
        ? []
        : [
            {
              ...batch,
              ...(change === 'skip'
                ? { state: 'skipped', note: 'User agreed' }
                : {}),
              ...(change === 'reduce' ? { items: ['a'] } : {}),
              ...(change === 'replace' ? { items: ['a', 'c'] } : {}),
            },
          ];
    const session = await DialogueSession.open({
      id: change,
      maxCorrections: 0,
      board: { workers: new Map() },
      planner: {
        async process() {
          turn++;
          if (turn === 1) {
            assert.equal((await update({ steps: [batch] })).isError, undefined);
            assert.equal((await update({ steps: narrowed })).isError, true);
            assert.equal(
              (
                await update({
                  steps: [batch],
                  status: 'waiting_user',
                  question: 'May I narrow scope?',
                })
              ).isError,
              undefined,
            );
            assert.equal((await update({ steps: narrowed })).isError, true);
          } else {
            assert.equal(
              (await update({ steps: narrowed })).isError,
              undefined,
            );
            const current = session.snapshot().plan;
            assert.ok(typeof current === 'object');
            assert.equal(current.scopeConsent, undefined);
          }
          return { ok: true, value: { content: 'reply' } };
        },
      },
    });
    await session.send('Start');
    await session.send('Yes');
    await session.close();
  });
}

test('batch work completes independently; a short audit count fails its separate step', () => {
  const plan = mergePlan(
    undefined,
    [
      batch,
      { id: 'verify', goal: 'Verify', worker: 'audit', dependsOn: ['batch'] },
    ],
    'active',
  );
  const [work, check] = plan.steps;
  work.taskIds = ['w'];

  work.workTaskId = 'w';
  applyTaskEvent(plan, event('w', 'stored'));
  assert.equal(work.state, 'done');
  assert.throws(
    () =>
      mergePlan(
        plan,
        [
          batch,
          {
            id: 'verify',
            goal: 'Verify',
            worker: 'audit',
            dependsOn: ['batch'],
            state: 'done',
          },
        ],
        'active',
      ),
    /successful current/,
  );
  check.taskIds = ['c'];

  check.workTaskId = 'c';
  check.checkedTaskIds = { batch: 'w' };
  applyTaskEvent(plan, event('c', '{"verdict":"pass","count":1}'));
  assert.equal(check.state, 'failed');
  assert.equal(check.verdict, 'fail');
  assert.equal(work.state, 'done');
  assert.match(check.note ?? '', /Count 1\/2/);
});

test('budget exhaustion reaches TaskBoard and fails a batch without checking, with split hint', async () => {
  const plan = mergePlan(undefined, [batch], 'active');
  const step = plan.steps[0];
  const events: TaskEvent[] = [];
  const board = new TaskBoard({
    workers: new Map([
      [
        'w',
        {
          name: 'w',
          capabilities: { contextPolicy: 'optional', maxToolCalls: 30 },
          async run() {
            return {
              output: 'partial',
              budgetExhausted: true,
              toolCallCount: 30,
              maxToolCalls: 30,
            };
          },
        },
      ],
    ]),
    onEvent(e) {
      events.push(e);
      applyTaskEvent(plan, e);
    },
  });
  assert.match(board.workerBudgetNotes().join(), /30 calls per task/);
  const started = board.start({ worker: 'w', goal: 'work' });
  assert.ok(started.ok);
  step.workTaskId = started.value.id;
  step.taskIds.push(started.value.id);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(board.get(started.value.id)?.budgetExhausted, true);
  assert.equal(events.at(-1)?.task.toolCalls, 30);
  assert.equal(step.state, 'failed');
  assert.equal(step.verdict, undefined);
  assert.match(planView(plan), /budget 30\/30; split/);
  await board.stopAll();
});

test('audit context includes expected batch ids/count and batch size limit rejects oversized updates', async () => {
  const plan = mergePlan(
    undefined,
    [
      batch,
      { id: 'verify', goal: 'Verify', worker: 'audit', dependsOn: ['batch'] },
    ],
    'active',
  );
  Object.assign(plan.steps[0], {
    state: 'done',
    taskIds: ['work'],
    workTaskId: 'work',
    successfulWorkTaskId: 'work',
  });
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
              return { output: '{"verdict":"pass","count":2}' };
            },
          },
        ],
      ]),
    ),
    onEvent: (e) => applyTaskEvent(plan, e),
  });
  board.restore([event('work', 'stored a and b').task]);
  await runInPlannerScope(
    { board, getPlan: () => plan, setPlan() {}, maxItemsPerStep: 2 },
    async () => {
      assert.equal(
        (await update({ steps: [{ ...batch, items: ['a', 'b', 'c'] }] }))
          .isError,
        true,
      );
      const result = await tools.callTool('delegate_task', {
        worker: 'audit',
        step_id: 'verify',
        goal: 'Verify',
      });
      assert.ok(result.ok);
      assert.equal(result.value.isError, undefined);
    },
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.match(context, /\[result to check: step batch \(task work\)\]/);
  assert.match(
    context,
    /Expected items for step batch: \["a","b"\]; expected count: 2/,
  );
  assert.equal(board.list().at(-1)?.goal, 'Verify');
  assert.equal(plan.steps[1].state, 'done');
  await board.stopAll();
});

for (const maxIterations of [1, 3]) {
  test(`SmartAgent budget flag survives the worker adapter, including last iteration (${maxIterations})`, async () => {
    let executed = 0;
    const { deps } = makeDefaultDeps({
      assembler: makeAssembler([{ role: 'user', content: 'work' }]),
      llmResponses: [
        {
          content: '',
          toolCalls: [
            { id: 'one', name: 'Work', arguments: {} },
            { id: 'two', name: 'Work', arguments: {} },
          ],
          finishReason: 'tool_calls',
        },
        { content: 'partial', finishReason: 'stop' },
      ],
      mcpClients: [
        {
          async listTools() {
            return {
              ok: true,
              value: [{ name: 'Work', description: 'work', inputSchema: {} }],
            };
          },
          async callTool() {
            executed++;
            return { ok: true, value: { content: 'stored' } };
          },
        },
      ],
    });
    const worker = new SmartAgentSubAgent(
      'w',
      new SmartAgent(deps, {
        maxToolCalls: 1,
        maxIterations,
        heartbeatIntervalMs: 0,
      }),
    );
    assert.equal(worker.capabilities.maxToolCalls, 1);
    const result = await worker.run({ task: 'work' });
    assert.equal(result.budgetExhausted, true);
    assert.equal(result.toolCallCount, 1);
    assert.equal(result.maxToolCalls, 1);
    assert.equal(executed, 1);
  });
}

test('batch membership changes require reopening and clear result evidence', () => {
  const plan = mergePlan(undefined, [batch], 'active');
  Object.assign(plan.steps[0], {
    state: 'done',
    taskIds: ['work'],
    workTaskId: 'work',
    successfulWorkTaskId: 'work',
  });
  assert.throws(
    () => mergePlan(plan, [{ ...batch, items: ['a', 'b', 'c'] }], 'active'),
    /reopening/,
  );
  const changed = mergePlan(
    plan,
    [{ ...batch, items: ['a', 'b', 'c'], state: 'pending' }],
    'active',
  );
  assert.deepEqual(changed.steps[0].taskIds, []);
  assert.equal(changed.steps[0].successfulWorkTaskId, undefined);
});

for (const items of [undefined, ['a', 'b']]) {
  test(`budget exhaustion ${items ? 'fails batch' : 'retains non-batch result with note'}`, () => {
    const plan = mergePlan(
      undefined,
      [{ id: 'work', goal: 'Work', items }],
      'active',
    );
    plan.steps[0].taskIds = ['w'];

    plan.steps[0].workTaskId = 'w';
    const result = event('w', 'partial');
    result.task.budgetExhausted = true;
    applyTaskEvent(plan, result);
    assert.equal(plan.steps[0].state, items ? 'failed' : 'done');
    assert.match(plan.steps[0].note ?? '', /tool-call budget/);
  });
}

for (const count of [undefined, 0, 1, 2]) {
  test(`batch audit count ${count}`, () => {
    const plan = mergePlan(
      undefined,
      [
        batch,
        {
          id: 'verify',
          goal: 'Verify',
          worker: 'audit',
          dependsOn: ['batch'],
        },
      ],
      'active',
    );
    plan.steps[0].successfulWorkTaskId = 'w';
    plan.steps[1].checkedTaskIds = { batch: 'w' };
    plan.steps[1].taskIds = ['c'];

    plan.steps[1].workTaskId = 'c';
    applyTaskEvent(
      plan,
      event('c', JSON.stringify({ verdict: 'pass', count })),
    );
    assert.equal(plan.steps[1].state, count === 2 ? 'done' : 'failed');
  });
}

for (const state of [
  'done',
  'failed',
  'interrupted',
  'running',
  'stopped',
] as const) {
  for (const budgetExhausted of [false, true]) {
    test(`restore successful result marker ${state}/${budgetExhausted}`, async () => {
      const plan = mergePlan(undefined, [batch], 'active');
      Object.assign(plan.steps[0], {
        state: 'done',
        taskIds: ['w'],
        workTaskId: 'w',
      });
      const session = await DialogueSession.open({
        id: 'legacy',
        store: {
          load: async () => ({
            plan,
            tasks: [{ ...event('w').task, state, budgetExhausted }],
            conversation: [],
            pending: [],
            savedAt: 0,
          }),
          save: async () => {},
          delete: async () => {},
        },
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
        restored.steps[0].successfulWorkTaskId,
        state === 'done' && !budgetExhausted ? 'w' : undefined,
      );
      await session.close();
    });
  }
}

test('unchanged legacy done steps can be explicitly retained without task evidence', () => {
  const plan = mergePlan(undefined, [batch], 'active');
  plan.steps[0].state = 'done';
  assert.equal(
    mergePlan(plan, [{ ...batch, state: 'done' }], 'active').steps[0].state,
    'done',
  );
});
