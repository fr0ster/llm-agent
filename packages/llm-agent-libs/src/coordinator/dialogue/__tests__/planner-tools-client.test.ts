import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  DialoguePlan,
  IPlanAuthor,
  McpContentBlock,
} from '@mcp-abap-adt/llm-agent';
import { PlannerToolsClient, runInPlannerScope, TaskBoard } from '../index.js';
import { profileHost } from './profile-test-host.js';

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
test('offers JSON Schema tools and worker enum within scope', async () => {
  const f = setup();
  const result = await runInPlannerScope(f.scope, () => client.listTools());
  assert.ok(result.ok);
  assert.equal(
    result.value.find((tool) => tool.name === 'delegate_task')?.description,
    'Delegate a result to a worker: goal = the result, context = constraints, facts and the done criterion; an independent check uses a separate verdict profile.\n[{"name":"w","description":"w","result":"report"}]',
  );
  assert.deepEqual(
    result.value.map((tool) => tool.name),
    [
      'new_request',
      'delegate_task',
      'search_knowledge',
      'stop_task',
      'deliver',
      'get_task',
      'list_tasks',
      'plan_get',
      'plan_update',
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
    // Running tasks carry activity facts for supervision.
    assert.deepEqual(Object.keys(listed[0]).sort(), [
      'currentAction',
      'goal',
      'id',
      'idleMs',
      'lastActivityAt',
      'state',
      'worker',
    ]);
    assert.equal(listed[0].id, 't1');
    assert.match(
      (await call('get_task', { task_id: 't1' })).json.notice,
      /goal: g/,
    );
    assert.deepEqual((await call('stop_task', { task_id: 'missing' })).json, {
      stopped: false,
    });
    assert.deepEqual((await call('plan_update', { plan: 'the plan' })).json, {
      ok: true,
    });
    assert.equal(f.getPlan(), 'the plan');
  });
  await f.board.stopAll();
});
test('queued stop succeeds and get_task leaves retained output unchanged', async () => {
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
    assert.match(
      (await call('get_task', { task_id: 'saved' })).json.notice,
      /truncated/,
    );
    assert.equal(
      f.board.get('saved')?.output,
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
        await call('plan_update', { plan: String(index) });
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

test('plan_update validates status, defaults to active and advertises the enum', async () => {
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
        (tool) => tool.name === 'plan_update',
      )?.inputSchema;
      assert.ok(schema);
      assert.deepEqual(
        (schema.properties as Record<string, { enum?: string[] }>).status.enum,
        ['active', 'waiting_user', 'done'],
      );
      for (const status of [undefined, 'active', 'waiting_user', 'done']) {
        assert.equal(
          (
            await call('plan_update', {
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
          (await call('plan_update', { plan: 'next', status })).error,
          true,
        );
      assert.equal(updates.length, 4);
    },
  );
});

test('legacy plan_update preserves the string-only setter contract', async () => {
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
        (await call('plan_update', { plan: 'legacy text' })).error,
        undefined,
      );
    },
  );
  assert.equal(stored, 'LEGACY TEXT');
  await f.board.stopAll();
});

test('plan_get pages full steps in plan order and validates filters and pagination', async () => {
  const f = setup();
  await runInPlannerScope(f.scope, async () => {
    assert.equal((await call('plan_get')).json.plan, null);
    await call('plan_update', {
      steps: Array.from({ length: 55 }, (_, i) => ({
        id: `s${i}`,
        goal: `full goal ${i} ${'x'.repeat(300)}`,
        ...(i ? { dependsOn: ['s0'] } : {}),
        check: { by: 'planner', goal: 'full check' },
      })),
    });
    const plan = f.getPlan() as DialoguePlan;
    plan.steps[54].state = 'failed';
    const page = (await call('plan_get', { offset: 40, limit: 20 })).json;
    assert.equal(page.total, 55);
    assert.deepEqual(
      page.steps,
      JSON.parse(JSON.stringify(plan.steps.slice(40))),
    );
    assert.deepEqual(
      (await call('plan_get', { state: 'ready' })).json.steps,
      JSON.parse(JSON.stringify([plan.steps[0]])),
    );
    assert.deepEqual(
      (await call('plan_get', { state: 'failed' })).json.steps,
      JSON.parse(JSON.stringify([plan.steps[54]])),
    );
    assert.equal((await call('plan_get', { state: 'pending' })).json.total, 54);
    assert.deepEqual((await call('plan_get', { offset: 100 })).json.steps, []);
    for (const args of [
      { state: 'invalid' },
      { error_offset: -1 },
      { error_limit: 0 },
      { error_limit: 1.5 },
      { offset: -1 },
      { offset: 0.5 },
      { limit: 0 },
      { limit: '2' },
    ])
      assert.equal((await call('plan_get', args)).error, true);
    plan.scopeConsent = true;
    await call('plan_update', { plan: 'legacy plan' });
    assert.equal((await call('plan_get')).json.plan, 'legacy plan');
  });
});

test('dependency and audit results are appended after briefs with a total bound', async () => {
  const contexts: (string | undefined)[] = [];
  const board = new TaskBoard({
    ...profileHost(
      new Map(
        ['w', 'audit'].map((name) => [
          name,
          {
            name,
            capabilities: { contextPolicy: 'optional' as const },
            async run(input: import('@mcp-abap-adt/llm-agent').ISubAgentInput) {
              contexts.push(input.context);
              return { output: 'ok' };
            },
          },
        ]),
      ),
    ),
    taskOutputChars: 130_000,
    onEvent() {},
  });
  board.restore([
    {
      id: 'a',
      worker: 'w',
      goal: 'a',
      state: 'done',
      output: 'alpha',
      createdAt: 0,
    },
    {
      id: 'b',
      worker: 'w',
      goal: 'b',
      state: 'done',
      output: 'beta',
      createdAt: 0,
    },
    {
      id: 'big',
      worker: 'w',
      goal: 'big',
      state: 'done',
      output: 'x'.repeat(120_000),
      createdAt: 0,
    },
  ]);
  const plan: DialoguePlan = {
    version: 1,
    status: 'active',
    steps: [
      {
        id: 'a',
        goal: 'a',
        state: 'done',
        taskIds: ['a'],
        workTaskId: 'a',
        successfulWorkTaskId: 'a',
      },
      {
        id: 'b',
        goal: 'b',
        state: 'done',
        taskIds: ['b'],
        workTaskId: 'b',
        successfulWorkTaskId: 'b',
      },
      {
        id: 'big',
        goal: 'big',
        state: 'done',
        taskIds: ['big'],
        workTaskId: 'big',
        successfulWorkTaskId: 'big',
      },
      {
        id: 'next',
        goal: 'next',
        state: 'pending',
        taskIds: [],
        dependsOn: ['b', 'a'],
      },
      {
        id: 'check',
        goal: 'check',
        state: 'pending',
        taskIds: [],
        worker: 'audit',
        result: 'verdict',
        dependsOn: ['a'],
      },
      { id: 'independent', goal: 'independent', state: 'pending', taskIds: [] },
      {
        id: 'overflow',
        goal: 'overflow',
        state: 'pending',
        taskIds: [],
        dependsOn: ['big'],
      },
    ],
  };
  await runInPlannerScope(
    { board, getPlan: () => plan, setPlan() {} },
    async () => {
      assert.equal(
        (
          await call('delegate_task', {
            worker: 'w',
            goal: 'next',
            step_id: 'next',
            context: 'brief',
          })
        ).error,
        undefined,
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(
        contexts[0],
        'brief\n\n[result of step b (task b)]\nbeta\n\n[result of step a (task a)]\nalpha',
      );
      assert.equal(
        (
          await call('delegate_task', {
            worker: 'audit',
            result: 'verdict',
            goal: 'verify',
            step_id: 'check',
          })
        ).error,
        undefined,
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.match(
        contexts[1] ?? '',
        /^The tool trace is evidence of what was actually done[^\n]*\n\n\[result to check: step a \(task a\)\]\nalpha\n\[tools used by task a\]\ntool trace unavailable$/,
      );
      await call('delegate_task', {
        worker: 'w',
        goal: 'independent',
        step_id: 'independent',
        context: 'brief',
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(contexts[2], 'brief');
      const overflow = await call('delegate_task', {
        worker: 'w',
        goal: 'overflow',
        step_id: 'overflow',
      });
      assert.equal(overflow.error, true);
      assert.match(overflow.json.error, /step big.*120000/);
    },
  );
});

function planningAuthor(plan: DialoguePlan): IPlanAuthor {
  return {
    async create() {
      return { ok: true, value: plan };
    },
    async revise() {
      return { ok: true, value: plan };
    },
  };
}
const authorPlan: DialoguePlan = {
  version: 1,
  status: 'active',
  steps: [{ id: 's1', goal: 'read', state: 'pending', taskIds: [] }],
};

test('plan_create stores the author plan and lists planning tools only with an author', async () => {
  const f = setup();
  await runInPlannerScope(f.scope, async () => {
    const listed = await client.listTools();
    assert.ok(listed.ok);
    assert.ok(
      !listed.value.some((tool) =>
        ['plan_create', 'plan_revise'].includes(tool.name),
      ),
    );
    for (const name of ['plan_create', 'plan_revise']) {
      assert.deepEqual(await call(name), {
        error: true,
        json: { error: 'plan author is unavailable' },
      });
    }
  });
  await runInPlannerScope(
    { ...f.scope, planAuthor: planningAuthor(authorPlan) },
    async () => {
      const listed = await client.listTools();
      assert.ok(listed.ok);
      for (const name of [
        'plan_create',
        'plan_revise',
        'plan_get',
        'plan_update',
      ])
        assert.ok(listed.value.some((tool) => tool.name === name));
      assert.equal(
        (await call('plan_create', { goal: 'read', references: ['r1'] })).error,
        undefined,
      );
      const plan = f.getPlan();
      assert.ok(typeof plan === 'object');
      assert.equal(plan.steps[0].id, 's1');
    },
  );
});

test('plan_revise merges and stores finished work even when author reopens it', async () => {
  const f = setup();
  const done: DialoguePlan = {
    ...authorPlan,
    steps: [
      {
        ...authorPlan.steps[0],
        state: 'done',
        taskIds: ['t1'],
        successfulWorkTaskId: 't1',
      },
    ],
  };
  f.setPlan(done);
  await runInPlannerScope(
    { ...f.scope, planAuthor: planningAuthor(authorPlan) },
    async () => {
      assert.equal(
        (await call('plan_revise', { change: 'continue' })).error,
        undefined,
      );
      const plan = f.getPlan();
      assert.ok(typeof plan === 'object');
      assert.equal(plan.steps[0].state, 'done');
      assert.deepEqual(plan.steps[0].taskIds, ['t1']);
      assert.equal(plan.steps[0].successfulWorkTaskId, 't1');
    },
  );
});

test('plan_revise requires a structured plan and author errors leave it unchanged', async () => {
  const f = setup();
  const author: IPlanAuthor = {
    async create() {
      return { ok: false, error: { code: 'invalid', message: 'bad JSON' } };
    },
    async revise() {
      return { ok: false, error: { code: 'invalid', message: 'bad JSON' } };
    },
  };
  await runInPlannerScope({ ...f.scope, planAuthor: author }, async () => {
    assert.equal((await call('plan_revise', { change: 'revise' })).error, true);
    f.setPlan(authorPlan);
    for (const [name, args] of [
      ['plan_create', { goal: 'new' }],
      ['plan_revise', { change: 'revise' }],
    ] as const) {
      const result = await call(name, args);
      assert.equal(result.error, true);
      assert.match(result.json.error, /invalid/);
      assert.equal(f.getPlan(), authorPlan);
    }
  });
});

test('plan_create is refused while an attempt is reserved, like new_request', async () => {
  const f = setup();
  const host = profileHost(new Map());
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = () => {};
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const board = new TaskBoard({ ...host, onEvent() {} });
  board.resolveWorker = async () => {
    entered();
    await gate;
    throw new Error('reservation released');
  };
  await runInPlannerScope(
    {
      ...f.scope,
      board,
      newRequest() {},
      planAuthor: planningAuthor(authorPlan),
    },
    async () => {
      const pending = call('delegate_task', { worker: 'w', goal: 'read' });
      await ready;
      for (const name of ['new_request', 'plan_create']) {
        const result = await call(
          name,
          name === 'plan_create' ? { goal: 'new' } : {},
        );
        assert.equal(result.error, true);
        assert.match(result.json.error, /being reserved/);
        assert.equal(f.getPlan(), undefined);
      }
      release();
      await pending;
    },
  );
});

test('invalid authored steps and stale author results leave the plan unchanged', async () => {
  const f = setup();
  f.setPlan(authorPlan);
  const invalid: DialoguePlan = {
    ...authorPlan,
    steps: [authorPlan.steps[0], authorPlan.steps[0]],
  };
  await runInPlannerScope(
    { ...f.scope, planAuthor: planningAuthor(invalid) },
    async () => {
      assert.equal((await call('plan_create', { goal: 'new' })).error, true);
      assert.equal(f.getPlan(), authorPlan);
    },
  );
  const newer: DialoguePlan = {
    ...authorPlan,
    status: 'waiting_user',
    question: 'Continue?',
  };
  const author: IPlanAuthor = {
    async create() {
      f.setPlan(newer);
      return { ok: true, value: authorPlan };
    },
    async revise() {
      f.setPlan(newer);
      return { ok: true, value: authorPlan };
    },
  };
  await runInPlannerScope({ ...f.scope, planAuthor: author }, async () => {
    assert.equal((await call('plan_create', { goal: 'new' })).error, true);
    assert.equal(f.getPlan(), newer);
  });
});

test('plan_create refuses active tasks without calling the author', async () => {
  const f = setup();
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = () => {};
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const board = new TaskBoard({
    workers: new Map([
      [
        'w',
        {
          name: 'w',
          capabilities: { contextPolicy: 'optional' as const },
          async run() {
            entered();
            await gate;
            return { output: 'ok' };
          },
        },
      ],
    ]),
    onEvent() {},
  });
  let authorCalls = 0;
  const author: IPlanAuthor = {
    ...planningAuthor(authorPlan),
    async create() {
      authorCalls++;
      return { ok: true, value: authorPlan };
    },
  };
  try {
    await runInPlannerScope(
      { ...f.scope, board, planAuthor: author },
      async () => {
        const delegated = await call('delegate_task', {
          worker: 'w',
          goal: 'read',
        });
        assert.equal(delegated.error, undefined);
        await ready;
        assert.equal(board.get(delegated.json.task_id)?.state, 'running');
        f.setPlan(authorPlan);
        assert.equal((await call('plan_create', { goal: 'new' })).error, true);
        assert.equal(authorCalls, 0);
        assert.equal(f.getPlan(), authorPlan);
      },
    );
  } finally {
    release();
    await board.stopAll();
  }
});

test('plan_create refuses a task started while the author is pending', async () => {
  const f = setup();
  let releaseAuthor = () => {};
  const authorGate = new Promise<void>((resolve) => {
    releaseAuthor = resolve;
  });
  let authorEntered = () => {};
  const authorReady = new Promise<void>((resolve) => {
    authorEntered = resolve;
  });
  let releaseWorker = () => {};
  const workerGate = new Promise<void>((resolve) => {
    releaseWorker = resolve;
  });
  const board = new TaskBoard({
    workers: new Map([
      [
        'w',
        {
          name: 'w',
          capabilities: { contextPolicy: 'optional' as const },
          async run() {
            await workerGate;
            return { output: 'ok' };
          },
        },
      ],
    ]),
    onEvent() {},
  });
  const author: IPlanAuthor = {
    ...planningAuthor(authorPlan),
    async create() {
      authorEntered();
      await authorGate;
      return { ok: true, value: authorPlan };
    },
  };
  try {
    await runInPlannerScope(
      { ...f.scope, board, planAuthor: author },
      async () => {
        const previous = f.getPlan();
        const pending = call('plan_create', { goal: 'new' });
        await authorReady;
        const delegated = await call('delegate_task', {
          worker: 'w',
          goal: 'read',
        });
        assert.equal(delegated.error, undefined);
        const state = board.get(delegated.json.task_id)?.state;
        assert.ok(state === 'queued' || state === 'running');
        releaseAuthor();
        assert.deepEqual(await pending, {
          error: true,
          json: {
            error:
              'Cannot create a plan while tasks are active; stop them first or wait for them to settle',
          },
        });
        assert.equal(f.getPlan(), previous);
      },
    );
  } finally {
    releaseAuthor();
    releaseWorker();
    await board.stopAll();
  }
});

test('get_task returns a bounded notice, rejects removed views and preserves explicit trace', async () => {
  const f = setup();
  const toolTrace = { complete: true, omittedCount: 0, entries: [] };
  f.board.restore([
    {
      id: 'large',
      worker: 'w',
      goal: 'g'.repeat(400),
      state: 'done',
      createdAt: 1,
      result: 'verdict',
      summary: 's'.repeat(900),
      output: JSON.stringify({ verdict: 'pass' }),
      error: 'e'.repeat(2000),
      resultRef: { collection: 'task-results', record: 'large', chars: 70000 },
      toolTrace,
    },
  ]);
  await runInPlannerScope(f.scope, async () => {
    const tools = await client.listTools();
    assert.ok(tools.ok);
    const schema = tools.value.find(
      (tool) => tool.name === 'get_task',
    )?.inputSchema;
    assert.deepEqual(Object.keys(schema?.properties ?? {}).sort(), [
      'include_trace',
      'task_id',
    ]);
    const result = (await call('get_task', { task_id: 'large' })).json;
    assert.deepEqual(Object.keys(result), ['notice']);
    assert.match(result.notice, /kind: verdict; verdict: pass/);
    assert.match(result.notice, /chars: 70000; result: task-results\/large/);
    assert.equal(
      result.notice.split('summary: ')[1].split('; chars:')[0].length,
      600,
    );
    assert.equal(
      result.notice.split('goal: ')[1].split('; error:')[0].length,
      200,
    );
    assert.equal(result.notice.split('; error: ')[1].length, 600);
    assert.ok(!result.notice.includes('get_task'));
    const listed = (await call('list_tasks')).json;
    assert.equal(listed[0].goal.length, 200);
    assert.match(listed[0].goal, /truncated, 400 chars/);
    assert.deepEqual(
      (await call('get_task', { task_id: 'large', include_trace: true })).json
        .toolTrace,
      toolTrace,
    );
    for (const args of [
      { view: 'full' },
      { view: 'compact' },
      { offset: 0 },
      { limit: 20 },
      { error_offset: 0 },
      { error_limit: 20 },
      { include_trace: 'yes' },
    ]) {
      assert.equal(
        (await call('get_task', { task_id: 'large', ...args })).error,
        true,
      );
    }
  });
  await f.board.stopAll();
});

for (const state of ['queued', 'running'] as const) {
  test(`get_task preserves ${state} supervision metadata without result text`, async () => {
    const f = setup();
    f.board.get = () => ({
      id: 'active',
      worker: 'w',
      goal: 'g'.repeat(500),
      state,
      result: 'report',
      createdAt: 0,
      lastActivityAt: 0,
      idleMs: 99,
      currentAction: 'tool action '.repeat(30),
      budgetExhausted: false,
      toolCalls: 2,
      maxToolCalls: 5,
      output: 'private output',
      error: 'private error',
    });
    await runInPlannerScope(f.scope, async () => {
      const { notice, ...metadata } = (
        await call('get_task', { task_id: 'active' })
      ).json;
      assert.match(notice, new RegExp(`task active \\(w\\) ${state}`));
      assert.deepEqual(metadata, {
        id: 'active',
        worker: 'w',
        goal: `${'g'.repeat(177)} [truncated, 500 chars]`,
        state,
        result: 'report',
        lastActivityAt: 0,
        idleMs: 99,
        currentAction: `${'tool action '.repeat(30).slice(0, 97)} [truncated, 360 chars]`,
        budgetExhausted: false,
        toolCalls: 2,
        maxToolCalls: 5,
        outputLength: 14,
        errorLength: 13,
      });
    });
  });
}

test('task without store keeps compact outcome in notice and budget note', async () => {
  const f = setup();
  f.board.restore([
    {
      id: 'legacy',
      worker: 'w',
      goal: 'g',
      state: 'done',
      createdAt: 1,
      output: 'compact outcome '.repeat(100),
      budgetExhausted: true,
      toolCalls: 5,
      maxToolCalls: 5,
    },
  ]);
  await runInPlannerScope(f.scope, async () => {
    const { notice } = (await call('get_task', { task_id: 'legacy' })).json;
    assert.match(notice, /summary: compact outcome/);
    assert.equal(notice.split('summary: ')[1].split('; chars:')[0].length, 600);
    assert.match(notice, /chars: 1600; result: not stored/);
    assert.match(notice, /worker hit the tool-call budget 5\/5/);
  });
  await f.board.stopAll();
});

for (const output of ['PASS', ' fail ', '{"verdict":"pass"}']) {
  test(`get_task notice reads shared verdict: ${output}`, async () => {
    const f = setup();
    f.board.restore([
      {
        id: 'verdict',
        worker: 'w',
        goal: 'check',
        state: 'done',
        createdAt: 1,
        result: 'verdict',
        output,
      },
    ]);
    await runInPlannerScope(f.scope, async () => {
      const { notice } = (await call('get_task', { task_id: 'verdict' })).json;
      assert.match(
        notice,
        output.trim() === 'fail' ? /verdict: fail/ : /verdict: pass/,
      );
    });
    await f.board.stopAll();
  });
}

test('status-only update preserves structured steps', async () => {
  const f = setup();
  const plan: DialoguePlan = {
    version: 1,
    status: 'active',
    steps: [{ id: 'report', goal: 'Report', state: 'pending', taskIds: [] }],
  };
  f.setPlan(plan);
  const steps = structuredClone(plan.steps);
  await runInPlannerScope(f.scope, async () => {
    for (const args of [
      { status: 'active' },
      { status: 'waiting_user', question: 'q' },
      { status: 'done' },
    ]) {
      assert.ok(!(await call('plan_update', args)).error);
      const updated = f.getPlan();
      assert.ok(updated && typeof updated === 'object');
      assert.deepEqual(updated.steps, steps);
      assert.equal(
        updated.status,
        args.status === 'done' ? 'active' : args.status,
      );
      assert.equal(updated.question, args.question);
    }
    assert.ok((await call('plan_update', { status: 'waiting_user' })).error);
    assert.ok(
      (await call('plan_update', { status: 'waiting_user', question: ' ' }))
        .error,
    );
    const updated = f.getPlan();
    assert.ok(updated && typeof updated === 'object');
    updated.steps[0].state = 'done';
    const settled = structuredClone(updated.steps);
    assert.ok(!(await call('plan_update', { status: 'done' })).error);
    const done = f.getPlan();
    assert.ok(done && typeof done === 'object');
    assert.equal(done.status, 'done');
    assert.deepEqual(done.steps, settled);
  });
});
