import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DialoguePlan, McpContentBlock } from '@mcp-abap-adt/llm-agent';
import { PlannerToolsClient, runInPlannerScope, TaskBoard } from '../index.js';

const client = new PlannerToolsClient();
async function call(name: string, args = {}) {
  const result = await client.callTool(name, args);
  assert.ok(result.ok);
  const blocks = result.value.content as McpContentBlock[];
  return {
    error: result.value.isError,
    json: JSON.parse(blocks[0].text ?? ''),
  };
}
function setup(maxTasks = 50) {
  let plan: string | DialoguePlan | undefined;
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
    maxTasks,
    onEvent() {},
  });
  return {
    board,
    getPlan: () => plan,
    setPlan: (value: string | DialoguePlan) => {
      plan = value;
    },
    scope: {
      board,
      getPlan: () => plan,
      setPlan: (value: string | DialoguePlan) => {
        plan = value;
      },
    },
  };
}
test('offers exactly eight JSON Schema tools and worker enum within scope', async () => {
  const f = setup();
  const result = await runInPlannerScope(f.scope, () => client.listTools());
  assert.ok(result.ok);
  assert.equal(
    result.value.find((tool) => tool.name === 'delegate_task')?.description,
    'Delegate a result to a worker: goal = the result, context = constraints, facts and the done criterion; a planned independent check is a separate checker task.',
  );
  assert.deepEqual(
    result.value.map((tool) => tool.name),
    [
      'new_request',
      'delegate_task',
      'search_knowledge',
      'stop_task',
      'get_task',
      'list_tasks',
      'get_plan',
      'update_plan',
    ],
  );
  for (const tool of result.value)
    assert.equal(tool.inputSchema.type, 'object');
  const delegate = result.value.find((tool) => tool.name === 'delegate_task');
  assert.ok(delegate);
  assert.deepEqual(
    (delegate.inputSchema.properties as Record<string, { enum?: string[] }>)
      .worker.enum,
    ['w'],
  );
});
test('no scope, unknown tool, invalid input and worker/limit errors are tool results', async () => {
  assert.deepEqual(await call('list_tasks'), {
    error: true,
    json: { error: 'no planner session' },
  });
  const f = setup(1);
  await runInPlannerScope(f.scope, async () => {
    for (const [name, args] of [
      ['bad', {}],
      ['delegate_task', {}],
      ['get_task', { task_id: 'missing' }],
      ['delegate_task', { worker: 'missing', goal: 'g' }],
    ] as const)
      assert.equal((await call(name, args)).error, true);
    assert.equal(
      (await call('delegate_task', { worker: 'w', goal: 'g' })).error,
      undefined,
    );
    assert.deepEqual(await call('delegate_task', { worker: 'w', goal: 'g' }), {
      error: true,
      json: { error: 'task limit 1 reached' },
    });
  });
});
test('all tool success paths return JSON and plan is stored', async () => {
  const f = setup();
  await runInPlannerScope(f.scope, async () => {
    const delegated = await call('delegate_task', {
      worker: 'w',
      goal: 'g',
      context: 'c',
    });
    assert.deepEqual(delegated.json, { task_id: 't1', state: 'queued' });
    const listed = (await call('list_tasks')).json;
    assert.deepEqual(Object.keys(listed[0]).sort(), [
      'goal',
      'id',
      'state',
      'worker',
    ]);
    assert.equal(listed[0].id, 't1');
    assert.equal((await call('get_task', { task_id: 't1' })).json.goal, 'g');
    assert.deepEqual((await call('stop_task', { task_id: 'missing' })).json, {
      stopped: false,
    });
    assert.deepEqual((await call('update_plan', { plan: 'the plan' })).json, {
      ok: true,
    });
    assert.equal(f.getPlan(), 'the plan');
  });
  await f.board.stopAll();
});
test('queued stop succeeds and get_task preserves the original cut note', async () => {
  const f = setup();
  f.board.restore([
    {
      id: 'saved',
      worker: 'w',
      goal: 'saved',
      state: 'done',
      createdAt: 1,
      output: `${'x'.repeat(4000)}\n[cut: 10 characters omitted]`,
    },
  ]);
  await runInPlannerScope(f.scope, async () => {
    assert.equal(
      (await call('get_task', { task_id: 'saved' })).json.output,
      `${'x'.repeat(4000)}\n[cut: 10 characters omitted]`,
    );
    const id = f.board.start({ worker: 'w', goal: 'queued' });
    assert.ok(id.ok);
    const stopping = call('stop_task', { task_id: id.value.id });
    assert.deepEqual((await stopping).json, { stopped: true });
    assert.equal(f.board.get(id.value.id)?.state, 'stopped');
  });
  await f.board.stopAll();
});

test('concurrent async planner scopes remain isolated', async () => {
  const a = setup();
  const b = setup();
  await Promise.all(
    [a, b].map((f, index) =>
      runInPlannerScope(f.scope, async () => {
        await new Promise<void>((resolve) => setImmediate(resolve));
        await call('update_plan', { plan: String(index) });
        await call('delegate_task', { worker: 'w', goal: String(index) });
      }),
    ),
  );
  assert.equal(a.getPlan(), '0');
  assert.equal(b.getPlan(), '1');
  assert.equal(a.board.list()[0].goal, '0');
  assert.equal(b.board.list()[0].goal, '1');
  assert.equal((await call('list_tasks')).error, true);
});

test('update_plan validates status, defaults to active and advertises the enum', async () => {
  const f = setup();
  const updates: Array<{ plan: string | DialoguePlan; status: unknown }> = [];
  await runInPlannerScope(
    {
      ...f.scope,
      setPlan(plan, status) {
        updates.push({ plan, status });
      },
    },
    async () => {
      const listed = await client.listTools();
      assert.ok(listed.ok);
      const schema = listed.value.find(
        (tool) => tool.name === 'update_plan',
      )?.inputSchema;
      assert.ok(schema);
      assert.deepEqual(
        (schema.properties as Record<string, { enum?: string[] }>).status.enum,
        ['active', 'waiting_user', 'done'],
      );
      for (const status of [undefined, 'active', 'waiting_user', 'done']) {
        assert.equal(
          (
            await call('update_plan', {
              plan: 'next',
              ...(status ? { status } : {}),
              ...(status === 'waiting_user' ? { question: 'Continue?' } : {}),
            })
          ).error,
          undefined,
        );
        assert.deepEqual(updates.at(-1), {
          plan: 'next',
          status: status ?? 'active',
        });
      }
      for (const status of ['invalid', 1, false])
        assert.equal(
          (await call('update_plan', { plan: 'next', status })).error,
          true,
        );
      assert.equal(updates.length, 4);
    },
  );
});

test('legacy update_plan preserves the string-only setter contract', async () => {
  const f = setup();
  let stored = '';
  await runInPlannerScope(
    {
      ...f.scope,
      setPlan(value: string) {
        stored = value.toUpperCase();
      },
    },
    async () => {
      assert.equal(
        (await call('update_plan', { plan: 'legacy text' })).error,
        undefined,
      );
    },
  );
  assert.equal(stored, 'LEGACY TEXT');
  await f.board.stopAll();
});

test('get_plan pages full steps in plan order and validates filters and pagination', async () => {
  const f = setup();
  await runInPlannerScope(f.scope, async () => {
    assert.equal((await call('get_plan')).json.plan, null);
    await call('update_plan', {
      steps: Array.from({ length: 55 }, (_, i) => ({
        id: `s${i}`,
        goal: `full goal ${i} ${'x'.repeat(300)}`,
        ...(i ? { dependsOn: ['s0'] } : {}),
        check: { by: 'planner', goal: 'full check' },
      })),
    });
    const plan = f.getPlan() as DialoguePlan;
    plan.steps[54].state = 'failed';
    const page = (await call('get_plan', { offset: 40, limit: 20 })).json;
    assert.equal(page.total, 55);
    assert.deepEqual(
      page.steps,
      JSON.parse(JSON.stringify(plan.steps.slice(40))),
    );
    assert.deepEqual(
      (await call('get_plan', { state: 'ready' })).json.steps,
      JSON.parse(JSON.stringify([plan.steps[0]])),
    );
    assert.deepEqual(
      (await call('get_plan', { state: 'failed' })).json.steps,
      JSON.parse(JSON.stringify([plan.steps[54]])),
    );
    assert.equal((await call('get_plan', { state: 'pending' })).json.total, 54);
    assert.deepEqual((await call('get_plan', { offset: 100 })).json.steps, []);
    for (const args of [
      { state: 'invalid' },
      { offset: -1 },
      { offset: 0.5 },
      { limit: 0 },
      { limit: '2' },
    ])
      assert.equal((await call('get_plan', args)).error, true);
    plan.scopeConsent = true;
    await call('update_plan', { plan: 'legacy plan' });
    assert.equal((await call('get_plan')).json.plan, 'legacy plan');
  });
});
