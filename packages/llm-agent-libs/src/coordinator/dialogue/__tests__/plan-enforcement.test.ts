import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DialoguePlan, TaskEvent } from '@mcp-abap-adt/llm-agent';
import { SmartAgent } from '../../../agent.js';
import { SmartAgentSubAgent } from '../../../subagent/smart-agent-subagent.js';
import { makeAssembler, makeDefaultDeps } from '../../../testing/index.js';
import { DialogueSession } from '../dialogue-session.js';
import { runInPlannerScope } from '../planner-scope.js';
import { PlannerToolsClient } from '../planner-tools-client.js';
import { applyTaskEvent, mergePlan, planView } from '../structured-plan.js';
import { TaskBoard } from '../task-board.js';

const tools = new PlannerToolsClient();
const batch = {
  id: 'batch',
  goal: 'Store results',
  items: ['a', 'b'],
  check: { by: 'checker' as const, goal: 'Verify storage' },
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
          plan = p as DialoguePlan;
        },
      },
      async () => {
        const task = board.start({ worker: 'w', goal: 'held' });
        assert.ok(task.ok);
        const step = plan.steps[0];
        step.taskIds = ['old-work', task.value.id];
        step.workTaskId = attempt === 'work' ? task.value.id : 'old-work';
        if (attempt === 'check' && step.check)
          step.check.taskId = task.value.id;
        step.state = attempt === 'work' ? 'running' : 'checking';
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
        assert.equal(plan.steps[0].check?.taskId, undefined);
        assert.equal(plan.steps[0].check?.verdict, undefined);
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

test('checker ownership changes require a separate fresh verdict', () => {
  let plan = mergePlan(undefined, [batch], 'active');
  Object.assign(plan.steps[0], {
    state: 'checking',
    taskIds: ['work', 'check'],
    workTaskId: 'work',
    successfulWorkTaskId: 'work',
    check: { ...batch.check, taskId: 'check', verdict: 'pass' },
  });
  const changed = { ...batch, check: { by: 'planner', goal: 'Inspect' } };
  assert.throws(
    () =>
      mergePlan(
        plan,
        [
          {
            ...changed,
            state: 'done',
            note: 'Looks good',
          },
        ],
        'active',
      ),
    /fresh check/,
  );
  plan = mergePlan(plan, [changed], 'active');
  assert.equal(plan.steps[0].check?.verdict, undefined);
  assert.equal(plan.steps[0].check?.taskId, undefined);
  applyTaskEvent(plan, event('check', '{"verdict":"pass","count":2}'));
  assert.equal(plan.steps[0].state, 'checking');
  plan = mergePlan(
    plan,
    [{ ...changed, state: 'done', note: 'Inspected' }],
    'active',
  );
  assert.equal(plan.steps[0].check?.verdict, 'pass');
  plan = mergePlan(plan, [batch], 'active');
  assert.equal(plan.steps[0].state, 'done');
  assert.equal(plan.steps[0].check?.verdict, undefined);
});

for (const kind of ['failed', 'stopped'] as const) {
  test(`budget exhaustion preserves ${kind} work outcome`, () => {
    const plan = mergePlan(undefined, [{ id: 'work', goal: 'Work' }], 'active');
    plan.steps[0].taskIds = ['task'];
    const result = event('task');
    result.kind = kind;
    result.task.state = kind;
    result.task.error = 'Original failure';
    result.task.budgetExhausted = true;
    applyTaskEvent(plan, result);
    assert.equal(plan.steps[0].state, 'failed');
    assert.equal(plan.steps[0].note, 'Original failure');
    assert.equal(plan.steps[0].check, undefined);
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
            assert.equal(
              (session.snapshot().plan as DialoguePlan).scopeConsent,
              undefined,
            );
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

test('items require a check, successful work and a passing checker verdict; short count overrides pass', () => {
  assert.throws(
    () =>
      mergePlan(
        undefined,
        [{ id: 'b', goal: 'batch', items: ['a'] }],
        'active',
      ),
    /require a check/,
  );
  const plan = mergePlan(undefined, [batch], 'active');
  assert.throws(
    () => mergePlan(plan, [{ ...batch, state: 'done' }], 'active'),
    /passing check/,
  );
  const step = plan.steps[0];
  step.workTaskId = 'w';
  step.taskIds = ['w'];
  step.state = 'running';
  applyTaskEvent(plan, event('w'));
  assert.equal(step.state, 'checking');
  assert.throws(
    () =>
      mergePlan(
        plan,
        [{ ...batch, state: 'done', note: 'trust me' }],
        'active',
      ),
    /passing checker/,
  );
  step.check!.taskId = 'c';
  step.taskIds.push('c');
  applyTaskEvent(plan, event('c', '{"verdict":"pass","count":1}'));
  assert.equal(step.state, 'failed');
  assert.equal(step.check!.verdict, 'fail');
  assert.match(step.note!, /Count 1\/2/);
  applyTaskEvent(plan, event('c', '{"verdict":"pass","count":2}'));
  assert.equal(step.state, 'done');
  assert.match(planView(plan), /items: 2/);
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
  assert.equal(step.check?.taskId, undefined);
  assert.match(planView(plan), /budget 30\/30; split/);
  await board.stopAll();
});

test('checker goal includes immutable expected ids/count and configured batch limit rejects oversized updates', async () => {
  let plan: DialoguePlan | undefined;
  const board = new TaskBoard({
    workers: new Map([
      [
        'checker',
        {
          name: 'checker',
          capabilities: { contextPolicy: 'optional' },
          async run(input) {
            assert.match(input.task, /exactly 2 items/);
            assert.match(input.task, /\["a","b"\]/);
            return { output: '{"verdict":"pass","count":2}' };
          },
        },
      ],
    ]),
    onEvent() {},
  });
  await runInPlannerScope(
    {
      board,
      maxItemsPerStep: 1,
      getPlan: () => plan,
      setPlan: (p) => {
        plan = p as DialoguePlan;
      },
    },
    async () => {
      const refused = await update({ steps: [batch] });
      assert.equal(refused.isError, true);
      assert.match(JSON.stringify(refused), /split/);
      assert.equal(plan, undefined);
    },
  );
  plan = mergePlan(undefined, [batch], 'active');
  plan.steps[0].state = 'checking';
  await runInPlannerScope(
    { board, getPlan: () => plan, setPlan() {} },
    async () => {
      const result = await tools.callTool('delegate_task', {
        step_id: 'batch',
        worker: 'checker',
        goal: 'Verify',
      });
      assert.ok(result.ok);
      assert.equal(result.value.isError, undefined);
    },
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(board.list()[0].state, 'done');
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

test('batch check cannot be bypassed with state overrides or changed completed membership', () => {
  const plan = mergePlan(undefined, [batch], 'active');
  for (const state of ['running', 'checking', 'done'])
    assert.throws(() => mergePlan(plan, [{ ...batch, state }], 'active'));
  Object.assign(plan.steps[0], {
    state: 'done',
    check: { ...batch.check, verdict: 'pass' },
  });
  assert.throws(
    () => mergePlan(plan, [{ ...batch, items: ['a', 'b', 'c'] }], 'active'),
    /fresh work/,
  );
  const reopened = mergePlan(
    plan,
    [{ ...batch, items: ['a', 'b', 'c'], state: 'pending' }],
    'active',
  );
  assert.equal(reopened.steps[0].state, 'pending');
});

for (const by of [undefined, 'planner', 'checker'] as const) {
  test(`exhausted non-item work enters checking with ${by ?? 'no'} existing check`, () => {
    const plan = mergePlan(
      undefined,
      [
        {
          id: 's',
          goal: 'Work',
          ...(by ? { check: { by, goal: 'Inspect' } } : {}),
        },
      ],
      'active',
    );
    const step = plan.steps[0];
    step.workTaskId = 'w';
    step.taskIds = ['w'];
    step.state = 'running';
    const done = event('w', 'partial');
    Object.assign(done.task, {
      budgetExhausted: true,
      toolCalls: 3,
      maxToolCalls: 3,
    });
    applyTaskEvent(plan, done);
    const note =
      'Worker hit the tool-call budget 3/3; verify the result is complete or split the step';
    assert.equal(step.state, 'checking');
    assert.deepEqual(step.check, {
      by: by ?? 'planner',
      goal: by ? 'Inspect' : note,
    });
    assert.equal(step.note, note);
    assert.ok(planView(plan).includes(` \u00b7 ${note}`));
    assert.ok(!planView(plan).includes(` ? ${note}`));
  });
}

for (const verdict of ['pass', 'fail']) {
  test(`item checker ${verdict} without count fails`, () => {
    const plan = mergePlan(undefined, [batch], 'active');
    const step = plan.steps[0];
    step.workTaskId = 'w';
    step.successfulWorkTaskId = 'w';
    step.taskIds = ['w', 'c'];
    step.check!.taskId = 'c';
    applyTaskEvent(
      plan,
      event('c', JSON.stringify({ verdict, note: 'Checked' })),
    );
    assert.equal(step.state, 'failed');
    assert.equal(step.check!.verdict, 'fail');
    assert.equal(step.note, 'checker did not report count for 2 items');
  });
}

for (const items of [undefined, ['a', 'b']]) {
  test(`completion invariants preserve failed work across ownership changes (${items ? 'items' : 'no items'})`, () => {
    const input = { ...batch, items };
    let plan = mergePlan(undefined, [input], 'active');
    const step = plan.steps[0];
    Object.assign(step, { workTaskId: 'w', taskIds: ['w'], state: 'running' });
    const failed = event('w');
    if (items) failed.task.budgetExhausted = true;
    else {
      failed.kind = 'failed';
      failed.task.state = 'failed';
    }
    applyTaskEvent(plan, failed);
    const changed = { ...input, check: { by: 'planner', goal: 'Inspect' } };
    plan = mergePlan(plan, [changed], 'active');
    assert.equal(plan.steps[0].state, 'failed');
    assert.equal(plan.steps[0].check?.taskId, undefined);
    assert.equal(plan.steps[0].check?.verdict, undefined);
    for (const state of ['checking', 'done'])
      assert.throws(() =>
        mergePlan(plan, [{ ...changed, state, note: 'Approved' }], 'active'),
      );
    plan = mergePlan(plan, [{ ...changed, state: 'pending' }], 'active');
    assert.throws(() =>
      mergePlan(
        plan,
        [{ ...changed, state: 'done', note: 'Approved' }],
        'active',
      ),
    );
    Object.assign(plan.steps[0], {
      workTaskId: 'retry',
      taskIds: ['w', 'retry'],
      state: 'running',
    });
    applyTaskEvent(plan, event('retry'));
    plan = mergePlan(
      plan,
      [{ ...changed, state: 'done', note: 'Verified retry' }],
      'active',
    );
    assert.equal(plan.steps[0].state, 'done');
  });

  test(`done requires current successful work and current checker (${items ? 'items' : 'no items'})`, () => {
    const input = { ...batch, items };
    let plan = mergePlan(undefined, [input], 'active');
    Object.assign(plan.steps[0], {
      workTaskId: 'w',
      taskIds: ['w'],
      state: 'checking',
    });
    const close = () =>
      mergePlan(
        plan,
        [{ ...input, state: 'done', note: 'Verified' }],
        'active',
      );
    assert.throws(close, /successful current work/);
    const done = event('w');
    done.task.budgetExhausted = !items;
    applyTaskEvent(plan, done);
    assert.throws(close, /passing checker/);
    const check = plan.steps[0].check;
    assert.ok(check);
    check.verdict = 'pass';
    check.taskId = 'stale';
    assert.throws(close, /current check attempt/);
    plan.steps[0].taskIds.push('c');
    check.taskId = 'c';
    applyTaskEvent(
      plan,
      event('c', JSON.stringify({ verdict: 'pass', count: 2 })),
    );
    plan = close();
    assert.equal(plan.steps[0].state, 'done');
  });
}

for (const state of [
  'pending',
  'running',
  'checking',
  'done',
  'failed',
  'blocked',
  'skipped',
] as const) {
  test(`ownership changes preserve ${state} and invalidate the old checker`, () => {
    const plan = mergePlan(undefined, [batch], 'active');
    Object.assign(plan.steps[0], {
      state,
      note: 'Existing note',
      workTaskId: 'w',
      successfulWorkTaskId: 'w',
      taskIds: ['w', 'c'],
      check: { ...batch.check, taskId: 'c', verdict: 'pass' },
    });
    const changed = mergePlan(
      plan,
      [{ ...batch, check: { by: 'planner', goal: 'Inspect' } }],
      'active',
    );
    assert.equal(changed.steps[0].state, state);
    assert.equal(changed.steps[0].check?.taskId, undefined);
    assert.equal(changed.steps[0].check?.verdict, undefined);
    assert.equal(
      changed.steps[0].successfulWorkTaskId,
      state === 'pending' ? undefined : 'w',
    );
    applyTaskEvent(changed, event('c', '{"verdict":"pass","count":2}'));
    assert.equal(changed.steps[0].state, state);
  });
}

test('exhausted non-item work without a check can close through planner inspection', () => {
  let plan = mergePlan(undefined, [{ id: 's', goal: 'Work' }], 'active');
  Object.assign(plan.steps[0], { workTaskId: 'w', taskIds: ['w'] });
  const done = event('w');
  done.task.budgetExhausted = true;
  applyTaskEvent(plan, done);
  assert.throws(
    () => mergePlan(plan, [{ id: 's', goal: 'Work', state: 'done' }], 'active'),
    /note/,
  );
  plan = mergePlan(
    plan,
    [{ id: 's', goal: 'Work', state: 'done', note: 'Verified complete' }],
    'active',
  );
  assert.equal(plan.steps[0].state, 'done');
});

test('reopening clears checker evidence and ignores its late passing result', () => {
  let plan = mergePlan(undefined, [batch], 'active');
  Object.assign(plan.steps[0], {
    state: 'checking',
    taskIds: ['w', 'c'],
    workTaskId: 'w',
    successfulWorkTaskId: 'w',
    check: { ...batch.check, taskId: 'c', verdict: 'pass' },
  });
  plan = mergePlan(plan, [{ ...batch, state: 'pending' }], 'active');
  assert.equal(plan.steps[0].successfulWorkTaskId, undefined);
  assert.equal(plan.steps[0].check?.taskId, undefined);
  assert.equal(plan.steps[0].check?.verdict, undefined);
  applyTaskEvent(plan, event('c', '{"verdict":"pass","count":2}'));
  assert.equal(plan.steps[0].state, 'pending');
});

for (const marker of [undefined, 'older']) {
  test(`checker events require successful current work: ${marker}`, () => {
    const plan = mergePlan(undefined, [batch], 'active');
    Object.assign(plan.steps[0], {
      state: 'checking',
      taskIds: ['w', 'c'],
      workTaskId: 'w',
      successfulWorkTaskId: marker,
      check: { ...batch.check, taskId: 'c' },
    });
    applyTaskEvent(plan, event('c', '{"verdict":"pass","count":2}'));
    assert.equal(plan.steps[0].state, 'checking');
    assert.equal(plan.steps[0].check?.verdict, undefined);
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
    test(
      'legacy marker migration verifies work outcome: ' +
        state +
        '/' +
        budgetExhausted,
      async () => {
        const input = {
          ...batch,
          check: { by: 'planner' as const, goal: 'Inspect' },
        };
        const plan = mergePlan(undefined, [input], 'active');
        Object.assign(plan.steps[0], {
          state: 'checking',
          taskIds: ['w'],
          workTaskId: 'w',
        });
        const task = { ...event('w').task, state, budgetExhausted };
        const close = () =>
          mergePlan(
            plan,
            [{ ...input, state: 'done', note: 'Verified' }],
            'active',
            undefined,
            { getTask: () => task },
          );
        if (state === 'done' && !budgetExhausted) {
          assert.equal(close().steps[0].successfulWorkTaskId, 'w');
        } else assert.throws(close, /successful current work/);
        const session = await DialogueSession.open({
          id: 'legacy',
          store: {
            load: async () => ({
              plan,
              tasks: [task],
              conversation: [],
              pending: [],
              savedAt: 0,
            }),
            save: async () => {},
            delete: async () => {},
          },
          board: { workers: new Map() },
          planner: {
            process: async () => ({ ok: true, value: { content: 'ok' } }),
          },
        });
        const restored = session.snapshot().plan as DialoguePlan;
        assert.equal(
          restored.steps[0].successfulWorkTaskId,
          state === 'done' && !budgetExhausted ? 'w' : undefined,
        );
        if (state === 'done' && !budgetExhausted) {
          assert.equal(
            mergePlan(
              restored,
              [{ ...input, state: 'done', note: 'Verified' }],
              'active',
            ).steps[0].state,
            'done',
          );
        }
        await session.close();
      },
    );
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
