import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  AgentProfileError,
  AgentPrompts,
  DialoguePlan,
  IAgentProfileRunner,
  IAgentProfileSource,
  ISmartAgent,
  ISubAgent,
  Result,
  TaskRecord,
  TaskRequest,
  WorkerProfile,
  WorkerToolPolicy,
} from '@mcp-abap-adt/llm-agent';
import { InMemoryRag } from '@mcp-abap-adt/llm-agent';
import { z } from 'zod';
import { ContextAssembler } from '../../../context/context-assembler.js';
import { REQUEST_TIME_GUIDANCE } from '../../../context/request-time.js';
import type { PipelineContext } from '../../../pipeline/context.js';
import { AssembleHandler } from '../../../pipeline/handlers/assemble.js';
import { SkillSelectHandler } from '../../../pipeline/handlers/skill-select.js';
import { NoopTracer } from '../../../tracer/noop-tracer.js';
import {
  DialogueSession,
  type DialogueSessionOptions,
} from '../dialogue-session.js';
import { InMemoryDialogueStateStore } from '../in-memory-dialogue-state-store.js';
import { runInPlannerScope } from '../planner-scope.js';
import { PlannerToolsClient } from '../planner-tools-client.js';
import { ProfileResolver } from '../profile-resolver.js';
import {
  applyTaskEvent,
  deliveryChecksPassed,
  mergePlan,
  readySteps,
} from '../structured-plan.js';
import { TaskBoard } from '../task-board.js';

const parsedProfileSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  result: z.enum(['report', 'verdict']),
  systemPrompt: z.string(),
  tools: z.union([
    z.literal('all'),
    z.literal('read-only'),
    z
      .object({
        allow: z.array(z.string()).optional(),
        deny: z.array(z.string()).optional(),
      })
      .strict(),
  ]),
});
function parseProfile(text: string): WorkerProfile {
  const value: unknown = JSON.parse(text);
  const parsed = parsedProfileSchema.safeParse(value);
  assert.ok(parsed.success, 'RAG record must contain a valid worker profile');
  return parsed.data;
}

const ok = <T>(value: T): Result<T, AgentProfileError> => ({ ok: true, value });
const policies: WorkerToolPolicy[] = [
  'all',
  'read-only',
  {},
  { allow: ['read'] },
  { deny: ['write'] },
  { allow: ['read', 'write'], deny: ['write'] },
];
function profile(
  name = 'author',
  result: WorkerProfile['result'] = 'report',
): WorkerProfile {
  return {
    name,
    result,
    description: `Function ${name}`,
    systemPrompt: 'initial instructions',
    tools: 'all',
  };
}
class Source implements IAgentProfileSource {
  records = [
    profile(),
    profile('research'),
    profile('audit', 'verdict'),
    profile('review', 'verdict'),
  ];
  prompts: AgentPrompts = { workerBase: 'base instructions' };
  disabled = new Set<string>();
  async list(): ReturnType<IAgentProfileSource['list']> {
    return ok(
      this.records
        .filter((p) => !this.disabled.has(p.name))
        .map(({ name, description, result }) => ({
          name,
          description,
          result,
        })),
    );
  }
  async get(name: string): ReturnType<IAgentProfileSource['get']> {
    if (this.disabled.has(name))
      return {
        ok: false,
        error: { code: 'disabled', message: `profile ${name} is disabled` },
      };
    const record = this.records.find((p) => p.name === name);
    return record
      ? ok(record)
      : {
          ok: false,
          error: { code: 'missing', message: `profile ${name} is missing` },
        };
  }
  async getPrompts(): ReturnType<IAgentProfileSource['getPrompts']> {
    return ok(this.prompts);
  }
}
function runner(
  run: ISubAgent['run'],
  snapshots: WorkerProfile[] = [],
): IAgentProfileRunner {
  return {
    async createWorker(input) {
      snapshots.push(input.profile);
      return ok({
        name: input.profile.name,
        capabilities: { contextPolicy: 'optional' },
        run,
      });
    },
    async preparePlanner() {
      return {
        ok: false,
        error: {
          code: 'unavailable',
          message: 'not configured in this fixture',
        },
      };
    },
  };
}
function completion(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function assemblyContext(
  overrides: Partial<PipelineContext> = {},
): PipelineContext {
  return {
    textOrMessages: 'goal',
    options: undefined,
    config: { maxIterations: 1 },
    sessionId: 'skills',
    helperLlm: undefined,
    assembler: new ContextAssembler({ systemPromptPreamble: 'host base' }),
    ragStores: {},
    ragRegistry: undefined,
    ragProviderRegistry: undefined,
    mcpClients: [],
    tracer: new NoopTracer(),
    logger: undefined,
    toolPolicy: undefined,
    injectionDetector: undefined,
    skillManager: undefined,
    embedder: undefined,
    toolSelectionStrategy: undefined,
    historyMemory: undefined,
    historySummarizer: undefined,
    inputText: 'goal',
    history: [],
    subprompts: [{ type: 'action', text: 'goal' }],
    toolClientMap: new Map(),
    ragText: '',
    queryEmbedding: undefined,
    ragResults: {},
    mcpTools: [],
    selectedTools: [],
    externalTools: [],
    assembledMessages: [],
    activeTools: [],
    selectedSkills: [],
    skillContent: '',
    skillArgs: '',
    shouldRetrieve: false,
    isAscii: true,
    isSapRequired: false,
    timing: [],
    yield() {},
    get mainLlm(): PipelineContext['mainLlm'] {
      throw new Error('Unexpected dependency: mainLlm');
    },
    get classifierLlm(): PipelineContext['classifierLlm'] {
      throw new Error('Unexpected dependency: classifierLlm');
    },
    get classifier(): PipelineContext['classifier'] {
      throw new Error('Unexpected dependency: classifier');
    },
    get reranker(): PipelineContext['reranker'] {
      throw new Error('Unexpected dependency: reranker');
    },
    get queryExpander(): PipelineContext['queryExpander'] {
      throw new Error('Unexpected dependency: queryExpander');
    },
    get toolCache(): PipelineContext['toolCache'] {
      throw new Error('Unexpected dependency: toolCache');
    },
    get outputValidator(): PipelineContext['outputValidator'] {
      throw new Error('Unexpected dependency: outputValidator');
    },
    get sessionManager(): PipelineContext['sessionManager'] {
      throw new Error('Unexpected dependency: sessionManager');
    },
    get metrics(): PipelineContext['metrics'] {
      throw new Error('Unexpected dependency: metrics');
    },
    get requestLogger(): PipelineContext['requestLogger'] {
      throw new Error('Unexpected dependency: requestLogger');
    },
    get toolAvailabilityRegistry(): PipelineContext['toolAvailabilityRegistry'] {
      throw new Error('Unexpected dependency: toolAvailabilityRegistry');
    },
    get pendingToolResults(): PipelineContext['pendingToolResults'] {
      throw new Error('Unexpected dependency: pendingToolResults');
    },
    get llmCallStrategy(): PipelineContext['llmCallStrategy'] {
      throw new Error('Unexpected dependency: llmCallStrategy');
    },
    ...overrides,
  };
}

test('selected semantic skills stay in request content through SkillSelectHandler and AssembleHandler', async () => {
  const assembler = new ContextAssembler({ systemPromptPreamble: 'host base' });
  const systems: string[] = [];
  for (const body of [
    'first semantic instructions',
    'second semantic instructions',
  ]) {
    const skill = {
      name: 'selected',
      description: 'selected skill',
      meta: { name: 'selected', description: 'selected skill' },
      async getContent() {
        return { ok: true as const, value: body };
      },
      async listResources() {
        return { ok: true as const, value: [] };
      },
      async readResource() {
        return { ok: true as const, value: '' };
      },
    };
    const ctx = assemblyContext({
      assembler,
      config: { maxIterations: 1 },
      subprompts: [{ type: 'action', text: 'goal' }],
      ragResults: {
        facts: [
          { text: 'match', score: 1, metadata: { id: 'skill:selected' } },
        ],
      },
      mcpTools: [],
      activeTools: [],
      history: [],
      assembledMessages: [],
      skillManager: {
        async listSkills() {
          return { ok: true, value: [skill] };
        },
        async getSkill() {
          return { ok: true, value: skill };
        },
        async matchSkills() {
          return { ok: true, value: [skill] };
        },
      },
    });
    const span = new NoopTracer().startSpan('skills');
    assert.equal(await new SkillSelectHandler().execute(ctx, {}, span), true);
    assert.match(ctx.skillContent, new RegExp(body));
    assert.equal(await new AssembleHandler().execute(ctx, {}, span), true);
    const system =
      ctx.assembledMessages.find((m) => m.role === 'system')?.content ?? '';
    systems.push(system);
    assert.ok(!system.includes(body));
    assert.ok(
      ctx.assembledMessages.some(
        (m) => m.role === 'user' && m.content?.includes(body),
      ),
    );
  }
  assert.equal(systems[0], systems[1]);
});

test('skill assembly preserves caller history across repeated empty requests', async () => {
  const ctx = assemblyContext({
    subprompts: [{ type: 'action', text: '' }],
    history: [{ role: 'user', content: 'previous question' }],
    skillContent: 'current skill',
  });
  const original = structuredClone(ctx.history);
  const handler = new AssembleHandler();
  const span = new NoopTracer().startSpan('repeat');
  for (let i = 0; i < 2; i++) {
    assert.equal(await handler.execute(ctx, {}, span), true);
    assert.deepEqual(ctx.history, original);
    assert.equal(
      ctx.assembledMessages
        .map((m) => m.content)
        .join('\n')
        .split('## Active Skills').length - 1,
      1,
    );
  }
});

test('unstructured delegation prevents a new request during profile resolution', async () => {
  const source = new Source();
  const entered = completion();
  const release = completion();
  const get = source.get.bind(source);
  source.get = async (name) => {
    entered.resolve();
    await release.promise;
    return get(name);
  };
  const board = new TaskBoard({
    profileSource: source,
    profileRunner: runner(async () => ({ output: 'done' })),
    onEvent() {},
  });
  let request = 1;
  const owners = new Map<string, number>();
  try {
    await runInPlannerScope(
      {
        board,
        getPlan: () => undefined,
        setPlan() {},
        newRequest() {
          request++;
        },
        ownTask(id) {
          owners.set(id, request);
        },
      },
      async () => {
        const client = new PlannerToolsClient();
        const pending = client.callTool('delegate_task', {
          worker: 'author',
          goal: 'old request',
        });
        await entered.promise;
        try {
          const next = await client.callTool('new_request', {});
          assert.ok(next.ok && next.value.isError);
          assert.match(JSON.stringify(next.value), /being reserved/);
        } finally {
          release.resolve();
          await pending;
        }
        assert.deepEqual([...owners.values()], [1]);
        const next = await client.callTool('new_request', {});
        assert.ok(next.ok && !next.value.isError);
        assert.equal(request, 2);
      },
    );
  } finally {
    release.resolve();
    await board.stopAll();
  }
});

test('concurrent delegation reserves one attempt per step across asynchronous profile resolution', async () => {
  const source = new Source();
  const release = completion();
  const board = new TaskBoard({
    profileSource: source,
    profileRunner: runner(async () => {
      await release.promise;
      return { output: 'done' };
    }),
    onEvent() {},
  });
  const plan = mergePlan(
    undefined,
    [{ id: 'work', goal: 'write', worker: 'author' }],
    'active',
  );
  try {
    await runInPlannerScope(
      { board, getPlan: () => plan, setPlan() {} },
      async () => {
        const client = new PlannerToolsClient();
        const results = await Promise.all(
          [1, 2].map(() =>
            client.callTool('delegate_task', {
              worker: 'author',
              goal: 'write',
              step_id: 'work',
            }),
          ),
        );
        assert.equal(results.filter((r) => r.ok && !r.value.isError).length, 1);
        assert.equal(board.list().length, 1);
        assert.deepEqual(plan.steps[0].taskIds, ['t1']);
      },
    );
  } finally {
    release.resolve();
  }
});

test('delegation reservations reject plan replacement and release after failed resolution', async () => {
  const source = new Source();
  const entered = completion();
  const release = completion();
  const get = source.get.bind(source);
  source.get = async (name) => {
    entered.resolve();
    await release.promise;
    return get(name);
  };
  source.disabled.add('author');
  const board = new TaskBoard({
    profileSource: source,
    profileRunner: runner(async () => ({ output: 'done' })),
    onEvent() {},
  });
  const plan = mergePlan(
    undefined,
    [{ id: 'work', goal: 'write', worker: 'author' }],
    'active',
  );
  await runInPlannerScope(
    {
      board,
      getPlan: () => plan,
      setPlan() {
        assert.fail('reserved plan must be retained');
      },
      newRequest() {
        assert.fail('reserved request must be retained');
      },
    },
    async () => {
      const client = new PlannerToolsClient();
      const pending = client.callTool('delegate_task', {
        worker: 'author',
        goal: 'write',
        step_id: 'work',
      });
      await entered.promise;
      for (const [name, args] of [
        ['update_plan', { steps: [] }],
        ['new_request', {}],
      ] as const) {
        const response = await client.callTool(name, args);
        assert.ok(response.ok && response.value.isError);
        assert.match(JSON.stringify(response.value), /being reserved/);
      }
      release.resolve();
      const failed = await pending;
      assert.ok(failed.ok && failed.value.isError);
      assert.equal(board.list().length, 0);
      source.disabled.clear();
      const retry = await client.callTool('delegate_task', {
        worker: 'author',
        goal: 'retry',
        step_id: 'work',
      });
      assert.ok(retry.ok && !retry.value.isError);
    },
  );
  await board.stopAll();
});

test('plan updates revalidate after a concurrent delegation binds its task', async () => {
  const source = new Source();
  const entered = completion();
  const resolveUpdate = completion();
  const finishTask = completion();
  const get = source.get.bind(source);
  source.get = async (name) => {
    if (name === 'audit') {
      entered.resolve();
      await resolveUpdate.promise;
    }
    return get(name);
  };
  const board = new TaskBoard({
    profileSource: source,
    profileRunner: runner(async () => {
      await finishTask.promise;
      return { output: 'report' };
    }),
    onEvent() {},
  });
  const keep = { id: 'keep', worker: 'audit', goal: 'verify later' };
  const plan = mergePlan(
    undefined,
    [{ id: 'work', worker: 'author', goal: 'write' }, keep],
    'active',
    undefined,
    { resolveResult: (name) => (name === 'audit' ? 'verdict' : 'report') },
  );
  plan.scopeConsent = true;
  try {
    await runInPlannerScope(
      {
        board,
        getPlan: () => plan,
        setPlan() {
          assert.fail('stale plan update must not remove the active step');
        },
      },
      async () => {
        const client = new PlannerToolsClient();
        const pendingUpdate = client.callTool('update_plan', { steps: [keep] });
        await entered.promise;
        const delegated = await client.callTool('delegate_task', {
          worker: 'author',
          goal: 'write',
          step_id: 'work',
        });
        assert.ok(delegated.ok && !delegated.value.isError);
        resolveUpdate.resolve();
        const update = await pendingUpdate;
        assert.ok(update.ok && update.value.isError);
        assert.match(JSON.stringify(update.value), /Plan changed/);
        assert.equal(plan.steps[0].workTaskId, 't1');
      },
    );
  } finally {
    finishTask.resolve();
    await board.stopAll();
  }
});

test('skipped reassignment clears passing evidence for a different function', () => {
  const plan: DialoguePlan = {
    version: 1,
    status: 'done',
    steps: [
      {
        id: 'work',
        goal: 'write',
        worker: 'author',
        result: 'report',
        state: 'done',
        taskIds: ['t1'],
        workTaskId: 't1',
        successfulWorkTaskId: 't1',
      },
      {
        id: 'check',
        goal: 'verify',
        worker: 'audit',
        result: 'verdict',
        dependsOn: ['work'],
        state: 'done',
        taskIds: ['t2'],
        workTaskId: 't2',
        successfulWorkTaskId: 't2',
        checkedTaskIds: { work: 't1' },
        verdict: 'pass',
      },
    ],
  };
  const next = mergePlan(
    plan,
    [
      plan.steps[0],
      {
        ...plan.steps[1],
        worker: 'review',
        state: 'skipped',
        note: 'approved skip',
      },
    ],
    'active',
    undefined,
    {
      consent: true,
      resolveResult: (name) => (name === 'author' ? 'report' : 'verdict'),
    },
  );
  const check = next.steps[1];
  assert.equal(check.verdict, undefined);
  assert.deepEqual(check.taskIds, []);
  assert.equal(check.workTaskId, undefined);
  assert.equal(check.successfulWorkTaskId, undefined);
  assert.equal(check.checkedTaskIds, undefined);
});

test('session-store restore schedules verdicts without exact source bindings for rerun', async () => {
  const store = new InMemoryDialogueStateStore();
  await store.save('restore-evidence', {
    savedAt: 0,
    conversation: [],
    pending: [],
    tasks: [
      {
        id: 't1',
        worker: 'author',
        result: 'report',
        goal: 'write',
        state: 'done',
        createdAt: 0,
        output: 'report',
      },
      {
        id: 't2',
        worker: 'audit',
        result: 'verdict',
        goal: 'verify',
        state: 'done',
        createdAt: 0,
        output: 'PASS',
      },
    ],
    plan: {
      version: 1,
      status: 'done',
      steps: [
        {
          id: 'work',
          goal: 'write',
          worker: 'author',
          result: 'report',
          state: 'done',
          taskIds: ['t1'],
        },
        {
          id: 'check',
          goal: 'verify',
          worker: 'audit',
          result: 'verdict',
          dependsOn: ['work'],
          state: 'done',
          taskIds: ['t2'],
          verdict: 'pass',
        },
      ],
    },
  });
  const session = await DialogueSession.open({
    id: 'restore-evidence',
    store,
    profileSource: new Source(),
    profileRunner: runner(async () => ({ output: '' })),
    board: {},
  });
  try {
    const plan = session.snapshot().plan;
    assert.ok(typeof plan === 'object');
    assert.deepEqual(
      readySteps(plan).map((step) => step.id),
      ['check'],
    );
    assert.equal(plan.status, 'active');
    assert.equal(plan.steps[1].verdict, undefined);
    assert.equal(deliveryChecksPassed(plan, 'work'), false);
  } finally {
    await session.close();
  }
});

test('exact lookup, disabled records, duplicates, malformed policy and mismatched name fail', async () => {
  const source = new Source();
  const resolver = new ProfileResolver(source);
  assert.equal((await resolver.discovery()).profiles.length, 4);
  await assert.rejects(resolver.get('Author'), /missing/);
  source.disabled.add('audit');
  await assert.rejects(resolver.get('audit'), /disabled/);
  assert.equal((await resolver.discovery()).profiles.length, 3);
  source.records.push(profile());
  await assert.rejects(resolver.discovery(), /duplicate/);
  const mismatched: IAgentProfileSource = {
    list: () => source.list(),
    getPrompts: () => source.getPrompts(),
    async get() {
      return ok(profile('other'));
    },
  };
  await assert.rejects(
    new ProfileResolver(mismatched).get('author'),
    /returned name/,
  );
  const malformed: IAgentProfileSource = {
    ...mismatched,
    async get() {
      return ok(
        Object.defineProperty(profile(), 'tools', {
          value: { allow: 'write' },
        }),
      );
    },
  };
  await assert.rejects(new ProfileResolver(malformed).get('author'));
});

test('deadlines, cancellation and exceptions fail closed without stale reads', async () => {
  const source = new Source();
  const unavailable: IAgentProfileSource = {
    list: () => source.list(),
    getPrompts: () => source.getPrompts(),
    get: () => new Promise(() => {}),
  };
  await assert.rejects(
    new ProfileResolver(unavailable, 5).get('author'),
    /deadline/,
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    new ProfileResolver(source).get('author', { signal: controller.signal }),
    /cancelled/,
  );
  const throws: IAgentProfileSource = {
    ...unavailable,
    async get() {
      throw new Error('backend offline');
    },
  };
  await assert.rejects(
    new ProfileResolver(throws).get('author'),
    /backend offline/,
  );
  await new ProfileResolver(source).get('author');
  source.disabled.add('author');
  await assert.rejects(new ProfileResolver(source).get('author'), /disabled/);
});

test('queued tasks refresh prompts and policy; running snapshots are isolated', async () => {
  const source = new Source();
  const firstStarted = completion();
  const release = completion();
  const finished = completion();
  const snapshots: WorkerProfile[] = [];
  const bases: Array<string | undefined> = [];
  let runs = 0;
  const hostRunner = runner(async () => {
    if (++runs === 1) {
      firstStarted.resolve();
      await release.promise;
    }
    return { output: 'result' };
  }, snapshots);
  const board = new TaskBoard({
    profileSource: source,
    profileRunner: {
      ...hostRunner,
      createWorker(input, options) {
        bases.push(input.workerBase);
        return hostRunner.createWorker(input, options);
      },
    },
    maxConcurrent: 1,
    onEvent(event) {
      if (event.kind === 'done' && event.task.id === 't2') finished.resolve();
    },
  });
  assert.ok((await board.startTask({ worker: 'author', goal: 'first' })).ok);
  await firstStarted.promise;
  assert.ok((await board.startTask({ worker: 'author', goal: 'second' })).ok);
  const record = source.records[0];
  assert.ok(record);
  record.systemPrompt = 'edited instructions';
  record.tools = { deny: ['write'] };
  source.prompts.workerBase = 'edited base';
  assert.equal(snapshots[0]?.systemPrompt, 'initial instructions');
  release.resolve();
  await finished.promise;
  assert.equal(snapshots[1]?.systemPrompt, 'edited instructions');
  assert.deepEqual(snapshots[1]?.tools, { deny: ['write'] });
  assert.deepEqual(bases, ['base instructions', 'edited base']);
  assert.equal(board.get('t2')?.result, 'report');
});

test('disabled delegation and runner failure invoke no worker', async () => {
  const source = new Source();
  let runs = 0;
  const failed = completion();
  const board = new TaskBoard({
    profileSource: source,
    profileRunner: {
      ...runner(async () => {
        runs++;
        return { output: '' };
      }),
      async createWorker() {
        return {
          ok: false,
          error: { code: 'unavailable', message: 'runner failed' },
        };
      },
    },
    onEvent(event) {
      if (event.kind === 'failed') failed.resolve();
    },
  });
  source.disabled.add('author');
  assert.equal(
    (await board.startTask({ worker: 'author', goal: 'disabled' })).ok,
    false,
  );
  assert.equal(board.list().length, 0);
  source.disabled.delete('author');
  assert.ok(
    (await board.startTask({ worker: 'author', goal: 'runner failure' })).ok,
  );
  await failed.promise;
  assert.equal(runs, 0);
  assert.match(board.get('t1')?.error ?? '', /profile author/);
});

test('discovery advertises arbitrary report/verdict functions and binds library-resolved roles', async () => {
  const source = new Source();
  const board = new TaskBoard({
    profileSource: source,
    profileRunner: runner(async () => ({ output: 'result' })),
    onEvent() {},
  });
  let plan: DialoguePlan | string | undefined;
  await runInPlannerScope(
    {
      board,
      getPlan: () => plan,
      setPlan(next) {
        plan = next;
      },
    },
    async () => {
      const client = new PlannerToolsClient();
      const tools = await client.listTools();
      assert.ok(tools.ok);
      assert.match(
        tools.value.find((tool) => tool.name === 'delegate_task')
          ?.description ?? '',
        /Function audit/,
      );
      const update = await client.callTool('update_plan', {
        steps: [
          { id: 'work', goal: 'write', worker: 'author' },
          { id: 'check', goal: 'verify', worker: 'audit', dependsOn: ['work'] },
        ],
      });
      assert.ok(update.ok && !update.value.isError);
      assert.ok(typeof plan === 'object');
      assert.equal(plan.steps[1]?.result, 'verdict');
      const mismatch = await client.callTool('delegate_task', {
        worker: 'research',
        goal: 'write',
        step_id: 'work',
      });
      assert.ok(mismatch.ok && mismatch.value.isError);
      source.disabled.add('author');
      const disabled = await client.callTool('delegate_task', {
        worker: 'author',
        goal: 'write',
        step_id: 'work',
      });
      assert.ok(disabled.ok && disabled.value.isError);
      assert.equal(board.list().length, 0);
    },
  );
});

test('arbitrary verdict names retain delivery gates across source retries, stale events and renaming', () => {
  const input = [
    { id: 'work', goal: 'write', worker: 'author' },
    { id: 'check', goal: 'verify', worker: 'audit', dependsOn: ['work'] },
  ];
  const plan = mergePlan(undefined, input, 'active', undefined, {
    resolveResult: (name) => (name === 'audit' ? 'verdict' : 'report'),
  });
  const work = plan.steps[0];
  const check = plan.steps[1];
  assert.ok(work && check);
  work.taskIds = ['t1'];
  work.workTaskId = 't1';
  applyTaskEvent(plan, {
    kind: 'done',
    task: {
      id: 't1',
      worker: 'author',
      result: 'report',
      goal: 'write',
      state: 'done',
      createdAt: 0,
      output: 'PASS',
    },
  });
  assert.equal(work.verdict, undefined);
  check.taskIds = ['t2'];
  check.workTaskId = 't2';
  check.checkedTaskIds = { work: 't1' };
  applyTaskEvent(plan, {
    kind: 'done',
    task: {
      id: 't2',
      worker: 'audit',
      result: 'verdict',
      goal: 'verify',
      state: 'done',
      createdAt: 0,
      output: 'PASS',
    },
  });
  assert.equal(deliveryChecksPassed(plan, 'work'), true);
  assert.throws(
    () =>
      mergePlan(
        plan,
        [input[0], { ...input[1], worker: 'review' }],
        'active',
        undefined,
        { resolveResult: () => 'verdict' },
      ),
    /reopening/,
  );
  work.taskIds.push('t3');
  work.workTaskId = 't3';
  applyTaskEvent(plan, {
    kind: 'done',
    task: {
      id: 't3',
      worker: 'author',
      result: 'report',
      goal: 'write',
      state: 'done',
      createdAt: 0,
      output: 'edited',
    },
  });
  assert.equal(check.state, 'pending');
  assert.equal(check.verdict, undefined);
  assert.equal(deliveryChecksPassed(plan, 'work'), false);
});

test('policy variants remain data; retrieved skills and time never change the static prefix', async () => {
  assert.equal(policies.length, 6);
  const assembler = new ContextAssembler({
    systemPromptPreamble: 'host base\n\nfunction instructions',
  });
  const assemble = (skill: string, time: number) =>
    assembler.assemble(
      { type: 'action', text: 'request goal' },
      {
        ragResults: { skills: [{ text: skill, score: 1, metadata: {} }] },
        tools: [],
      },
      [],
      { requestStartedAt: time },
    );
  const first = await assemble('skill one', 0);
  const second = await assemble('skill two', 100_000);
  assert.ok(first.ok && second.ok);
  assert.equal(first.value[0]?.content, second.value[0]?.content);
  const system = first.value[0]?.content ?? '';
  assert.ok(
    system.indexOf('host base') < system.indexOf('function instructions'),
  );
  assert.ok(
    system.indexOf('function instructions') <
      system.indexOf(REQUEST_TIME_GUIDANCE),
  );
  assert.equal(system.split(REQUEST_TIME_GUIDANCE).length, 2);
  assert.ok(
    !system.includes('skill one') &&
      !system.includes('request goal') &&
      !system.includes('[request time]'),
  );
  assert.match(
    first.value.find((message) => message.role === 'user')?.content ?? '',
    /skill one/,
  );
});

// Public hook type fixture: roots expose the planner contract without implementation imports.
const plannerContract: IAgentProfileRunner['preparePlanner'] =
  async (): Promise<Result<ISmartAgent, AgentProfileError>> => ({
    ok: false,
    error: { code: 'invalid', message: 'fixture' },
  });
void plannerContract;

test('public contracts include every error variant and additive legacy construction', () => {
  const errors: Result<WorkerProfile, AgentProfileError>[] = (
    ['missing', 'disabled', 'unavailable', 'invalid'] as const
  ).map((code) => ({ ok: false, error: { code, message: code } }));
  assert.equal(errors.length, 4);
  const request: TaskRequest = { worker: 'legacy', goal: 'work' };
  const task: TaskRecord = {
    ...request,
    id: 'old',
    state: 'done',
    createdAt: 0,
  };
  const plan: DialoguePlan = {
    version: 1,
    status: 'active',
    steps: [{ id: 'old', goal: 'work', state: 'pending', taskIds: [] }],
  };
  const options: DialogueSessionOptions = {
    id: 'legacy-contract',
    board: { workers: new Map() },
    planner: {
      async process() {
        return { ok: true, value: { content: '' } };
      },
    },
  };
  assert.equal(task.result, undefined);
  assert.equal(plan.steps[0].result, undefined);
  assert.equal(options.profileSource, undefined);
});

test('in-flight cancellation and deadlines ignore late profile settlement and permit a fresh retry', async () => {
  for (const cancel of [false, true]) {
    const source = new Source();
    const started = completion();
    let settle:
      | ((result: Result<WorkerProfile, AgentProfileError>) => void)
      | undefined;
    source.get = () =>
      new Promise((resolve) => {
        settle = resolve;
        started.resolve();
      });
    const controller = new AbortController();
    const resolver = new ProfileResolver(source, cancel ? 1000 : 10);
    const pending = resolver.get('author', { signal: controller.signal });
    const rejected = assert.rejects(pending, /unavailable/);
    await started.promise;
    if (cancel) controller.abort();
    await rejected;
    assert.ok(settle);
    settle(ok(profile('late')));
    source.get = async () => ok({ ...profile(), systemPrompt: 'fresh' });
    assert.equal((await resolver.get('author')).systemPrompt, 'fresh');
  }
});

test('cancelled in-flight delegation cannot queue work after the source settles late', async () => {
  const source = new Source();
  const entered = completion();
  const release = completion();
  let reads = 0;
  source.get = async () => {
    entered.resolve();
    await release.promise;
    reads++;
    return ok(profile());
  };
  let constructions = 0;
  const hostRunner = runner(async () => ({ output: 'must not run' }));
  const board = new TaskBoard({
    profileSource: source,
    profileRunner: {
      ...hostRunner,
      createWorker(input, options) {
        constructions++;
        return hostRunner.createWorker(input, options);
      },
    },
    onEvent() {},
  });
  const controller = new AbortController();
  const pending = board.startTask(
    { worker: 'author', goal: 'cancelled' },
    { signal: controller.signal },
  );
  await entered.promise;
  controller.abort();
  const result = await pending;
  assert.ok(!result.ok);
  release.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(reads, 1);
  assert.equal(board.list().length, 0);
  assert.equal(constructions, 0);
});

test('planner runner failures preserve state for retry and never invoke a planner', async () => {
  for (const throws of [false, true]) {
    const session = await DialogueSession.open({
      id: `runner-${throws}`,
      board: {},
      profileSource: new Source(),
      profileRunner: {
        ...runner(async () => ({ output: '' })),
        async preparePlanner() {
          if (throws) throw new Error('planner construction failed');
          return {
            ok: false,
            error: {
              code: 'unavailable',
              message: 'planner construction failed',
            },
          };
        },
      },
    });
    try {
      await assert.rejects(
        session.send('keep request'),
        /planner construction failed/,
      );
      assert.equal(session.snapshot().tasks.length, 0);
      assert.ok(
        session
          .snapshot()
          .conversation.some((message) =>
            message.content?.includes('keep request'),
          ),
      );
    } finally {
      await session.close();
    }
  }
});

for (const passing of [false, true]) {
  test(`removed-profile session-store round trip preserves roles, bindings, ownership and delivery (${passing})`, async () => {
    const source = new Source();
    source.records = source.records.filter((record) => record.name !== 'audit');
    const store = new InMemoryDialogueStateStore();
    const output = 'Exact report\n  retained whitespace\n';
    const state = {
      savedAt: 1,
      conversation: [{ role: 'user' as const, content: 'request' }],
      pending: [],
      requestSeq: 1,
      requests: [
        {
          id: 'r1',
          openedAt: 0,
          text: 'request',
          transcript: [{ role: 'user' as const, content: 'request' }],
        },
      ],
      taskRequests: { t1: 'r1', t2: 'r1' },
      taskSteps: { t1: 'work', t2: 'verify' },
      tasks: [
        {
          id: 't1',
          worker: 'author',
          result: 'report' as const,
          goal: 'write',
          state: 'done' as const,
          createdAt: 0,
          output,
        },
        {
          id: 't2',
          worker: 'audit',
          result: 'verdict' as const,
          goal: 'verify',
          state: 'done' as const,
          createdAt: 0,
          output: passing ? 'PASS' : 'FAIL',
        },
      ],
      plan: {
        version: 1 as const,
        status: 'active' as const,
        steps: [
          {
            id: 'work',
            goal: 'write',
            worker: 'author',
            result: 'report' as const,
            state: 'done' as const,
            taskIds: ['t1'],
            workTaskId: 't1',
            successfulWorkTaskId: 't1',
          },
          {
            id: 'verify',
            goal: 'verify',
            worker: 'audit',
            result: 'verdict' as const,
            state: passing ? ('done' as const) : ('failed' as const),
            taskIds: ['t2'],
            workTaskId: 't2',
            successfulWorkTaskId: 't2',
            checkedTaskIds: { work: 't1' },
            verdict: passing ? ('pass' as const) : ('fail' as const),
            dependsOn: ['work'],
          },
        ],
      },
    };
    await store.save('removed', state);
    const options: DialogueSessionOptions = {
      id: 'removed',
      store,
      board: {},
      profileSource: source,
      maxCorrections: 0,
      profileRunner: {
        ...runner(async () => ({ output: '' })),
        async preparePlanner() {
          return ok({
            async process() {
              const client = new PlannerToolsClient();
              const delivery = await client.callTool('deliver', {
                task_id: 't1',
              });
              assert.ok(delivery.ok);
              assert.equal(
                delivery.value.isError === true,
                !passing,
                JSON.stringify(delivery.value),
              );
              if (passing) {
                const duplicate = await client.callTool('deliver', {
                  task_id: 't1',
                });
                assert.ok(duplicate.ok && duplicate.value.isError);
              }
              return {
                ok: true,
                value: {
                  content: 'reply',
                  iterations: 1,
                  toolCallCount: 0,
                  stopReason: 'stop',
                },
              };
            },
            async *streamProcess() {},
          });
        },
      },
    };
    const first = await DialogueSession.open(options);
    const snapshot = first.snapshot();
    assert.deepEqual(snapshot.tasks, state.tasks);
    assert.deepEqual(snapshot.taskRequests, state.taskRequests);
    assert.deepEqual(snapshot.taskSteps, state.taskSteps);
    assert.ok(typeof snapshot.plan === 'object');
    assert.deepEqual(snapshot.plan.steps, state.plan.steps);
    assert.ok(!JSON.stringify(snapshot).includes('initial instructions'));
    await first.close();
    // close() removes the live session; persist its captured restart snapshot explicitly.
    await store.save('removed', snapshot);
    const restored = await DialogueSession.open(options);
    try {
      const reply = await restored.send('continue');
      if (passing) assert.equal(reply.text, output);
    } finally {
      await restored.close();
    }
  });
}

test('RAG-backed host integration: exact discovery, prompt/policy edits and disablement reach actual runner assembly', async () => {
  const rag = new InMemoryRag();
  const write = async (
    systemPrompt: string,
    tools: WorkerToolPolicy,
    enabled = true,
  ) => {
    const result = await rag.upsert(
      JSON.stringify({ ...profile('catalogue-function'), systemPrompt, tools }),
      { id: 'profile:catalogue-function', enabled },
    );
    assert.ok(result.ok);
  };
  const records = async () => {
    const page = await rag.scan();
    assert.ok(page.ok);
    return page.value.records.map((record) => ({
      profile: parseProfile(record.text),
      enabled: record.metadata.enabled,
    }));
  };
  const source: IAgentProfileSource = {
    async list() {
      return ok(
        (await records())
          .filter((record) => record.enabled)
          .map((record) => record.profile),
      );
    },
    async get(name) {
      const record = (await records()).find(
        (record) => record.profile.name === name,
      );
      if (!record?.enabled)
        return {
          ok: false,
          error: { code: record ? 'disabled' : 'missing', message: name },
        };
      return ok(record.profile);
    },
    async getPrompts() {
      return ok({ workerBase: 'RAG host base' });
    },
  };
  const systems: string[] = [];
  const permissions: string[][] = [];
  let finish = completion();
  const board = new TaskBoard({
    profileSource: source,
    profileRunner: {
      ...runner(async () => ({ output: '' })),
      async createWorker({ profile: record, workerBase }) {
        const policy = record.tools;
        // This fixture host owns just these two direct tool identities.
        const allowed = ['read', 'write'].filter(
          (tool) =>
            policy === 'all' ||
            (policy === 'read-only'
              ? tool === 'read'
              : (!policy.allow || policy.allow.includes(tool)) &&
                !policy.deny?.includes(tool)),
        );
        permissions.push(allowed);
        return ok({
          name: record.name,
          capabilities: { contextPolicy: 'optional' },
          async run(input) {
            const assembler = new ContextAssembler({
              systemPromptPreamble: [workerBase, record.systemPrompt].join(
                '\n\n',
              ),
            });
            const result = await assembler.assemble(
              { type: 'action', text: input.task },
              { ragResults: {}, tools: [] },
              [],
            );
            assert.ok(result.ok);
            systems.push(
              result.value.find((message) => message.role === 'system')
                ?.content ?? '',
            );
            const execute = (tool: string) => {
              if (!allowed.includes(tool)) throw new Error('denied');
              return tool;
            };
            assert.equal(execute('read'), 'read');
            if (!allowed.includes('write'))
              assert.throws(() => execute('write'), /denied/);
            return { output: 'assembled and executed' };
          },
        });
      },
    },
    onEvent(event) {
      if (event.kind === 'done') finish.resolve();
    },
  });
  await write('revision one', 'all');
  await runInPlannerScope(
    { board, getPlan: () => undefined, setPlan() {} },
    async () => {
      const client = new PlannerToolsClient();
      const discovery = await client.listTools();
      assert.ok(discovery.ok);
      assert.match(JSON.stringify(discovery.value), /catalogue-function/);
      for (const revision of [1, 2]) {
        if (revision === 2) await write('revision two', { deny: ['write'] });
        finish = completion();
        const delegated = await client.callTool('delegate_task', {
          worker: 'catalogue-function',
          goal: 'host integration',
        });
        assert.ok(delegated.ok && !delegated.value.isError);
        await finish.promise;
      }
      await write('disabled revision', 'all', false);
      const disabled = await client.callTool('delegate_task', {
        worker: 'catalogue-function',
        goal: 'must not execute',
      });
      assert.ok(disabled.ok && disabled.value.isError);
      assert.match(
        JSON.stringify(disabled.value),
        /catalogue-function.*disabled/,
      );
    },
  );
  assert.equal(board.list().length, 2);
  assert.match(systems[0], /RAG host base[\s\S]*revision one/);
  assert.match(systems[1], /revision two/);
  assert.deepEqual(permissions, [['read', 'write'], ['read']]);
});

for (const edit of ['prompt', 'policy', 'result'] as const) {
  test(`delegate-time ${edit} edits are resolved before work is queued`, async () => {
    const source = new Source();
    const finished = completion();
    const snapshots: WorkerProfile[] = [];
    const board = new TaskBoard({
      profileSource: source,
      profileRunner: runner(async () => ({ output: 'report' }), snapshots),
      onEvent(event) {
        if (event.kind === 'done') finished.resolve();
      },
    });
    const plan = mergePlan(
      undefined,
      [{ id: 'work', goal: 'work', worker: 'author' }],
      'active',
    );
    await runInPlannerScope(
      { board, getPlan: () => plan, setPlan() {} },
      async () => {
        const client = new PlannerToolsClient();
        await client.listTools();
        if (edit === 'prompt')
          source.records[0].systemPrompt = 'delegate revision';
        if (edit === 'policy')
          source.records[0].tools = { allow: ['read'], deny: ['write'] };
        if (edit === 'result') source.records[0].result = 'verdict';
        const response = await client.callTool('delegate_task', {
          worker: 'author',
          goal: 'work',
          step_id: 'work',
        });
        assert.ok(response.ok);
        if (edit === 'result') {
          assert.equal(response.value.isError, true);
          assert.equal(board.list().length, 0);
        } else {
          assert.ok(!response.value.isError);
          await finished.promise;
          assert.deepEqual(snapshots[0], source.records[0]);
        }
      },
    );
  });
}

for (const report of ['author', 'research']) {
  for (const verdict of ['audit', 'review']) {
    for (const output of [
      'PASS',
      'FAIL',
      'malformed',
      '{"verdict":"pass","count":1}',
      '{"verdict":"pass","count":2}',
    ]) {
      test(`generalized verification ${report}/${verdict}: ${output}`, async () => {
        const source = new Source();
        const finished = completion();
        const board = new TaskBoard({
          profileSource: source,
          profileRunner: runner(async () => ({ output })),
          onEvent(event) {
            applyTaskEvent(plan, event);
            if (event.kind === 'done') finished.resolve();
          },
        });
        const plan = mergePlan(
          undefined,
          [
            {
              id: 'work',
              goal: 'produce',
              worker: report,
              items: ['one', 'two'],
            },
            {
              id: 'verify',
              goal: 'verify',
              worker: verdict,
              dependsOn: ['work'],
            },
          ],
          'active',
          undefined,
          { resolveResult: (name) => (name === report ? 'report' : 'verdict') },
        );
        board.restore([
          {
            id: 'source',
            worker: report,
            result: 'report',
            goal: 'produce',
            state: 'done',
            createdAt: 0,
            output: 'source content',
          },
        ]);
        Object.assign(plan.steps[0], {
          state: 'done',
          taskIds: ['source'],
          workTaskId: 'source',
          successfulWorkTaskId: 'source',
        });
        await runInPlannerScope(
          { board, getPlan: () => plan, setPlan() {} },
          async () => {
            const response = await new PlannerToolsClient().callTool(
              'delegate_task',
              { worker: verdict, goal: 'verify', step_id: 'verify' },
            );
            assert.ok(response.ok && !response.value.isError);
          },
        );
        await finished.promise;
        assert.equal(
          deliveryChecksPassed(plan, 'work'),
          output === '{"verdict":"pass","count":2}',
        );
        assert.equal(plan.steps[0].state, 'done');
        assert.deepEqual(plan.steps[1].checkedTaskIds, { work: 'source' });
      });
    }
  }
}

test('planner text refreshes every call, including empty text, in both context modes', async () => {
  for (const plannerContext of ['prepared', 'conversation'] as const) {
    const source = new Source();
    const systems: string[] = [];
    let discoveries = 0;
    const baseList = source.list.bind(source);
    source.list = async () => {
      discoveries++;
      return baseList();
    };
    const profileRunner: IAgentProfileRunner = {
      ...runner(async () => ({ output: '' })),
      async preparePlanner({ systemPrompt }) {
        systems.push(systemPrompt);
        const agent: ISmartAgent = {
          async process(messages) {
            assert.ok(Array.isArray(messages));
            assert.match(
              messages.map((message) => message.content).join('\n'),
              /\[worker profiles\]/,
            );
            const tools = await new PlannerToolsClient().listTools();
            assert.ok(tools.ok);
            assert.match(
              tools.value.find((tool) => tool.name === 'delegate_task')
                ?.description ?? '',
              /Function review/,
            );
            return {
              ok: true,
              value: {
                content: 'reply',
                iterations: 1,
                toolCallCount: 0,
                stopReason: 'stop',
              },
            };
          },
          async *streamProcess() {},
        };
        return ok(agent);
      },
    };
    const session = await DialogueSession.open({
      id: `profiles-${plannerContext}`,
      plannerContext,
      profileSource: source,
      profileRunner,
      board: {},
      maxCorrections: 0,
    });
    try {
      source.prompts.planner = 'host planner one';
      await session.send('first goal');
      source.prompts.planner = '';
      await session.send('second goal');
      delete source.prompts.planner;
      await session.send('third goal');
      assert.ok(systems[0]?.startsWith('host planner one'));
      assert.ok(!systems[1]?.includes('You lead dialogue'));
      assert.ok(systems[1]?.includes(REQUEST_TIME_GUIDANCE));
      assert.ok(systems[2]?.includes('You lead dialogue'));
      assert.ok(discoveries >= 3);
      for (const system of systems)
        assert.ok(
          !system.includes('[worker profiles]') &&
            !system.includes('first goal'),
        );
    } finally {
      await session.close();
    }
  }
});

test('host obligation contract fixture: unchanged policies reach the runner; host enforcement is not library coverage', async () => {
  const source = new Source();
  const ceiling = new Set(['read', 'write']);
  for (const tools of policies) {
    for (const result of ['report', 'verdict'] as const) {
      source.records = [{ ...profile('function', result), tools }];
      const finished = completion();
      const board = new TaskBoard({
        profileSource: source,
        profileRunner: {
          ...runner(async () => ({ output: '' })),
          async createWorker({ profile: record }) {
            assert.deepEqual(record.tools, tools);
            const policy = record.tools;
            const allowed = [...ceiling].filter((tool) => {
              if (record.result === 'verdict' && tool !== 'read') return false;
              if (policy === 'read-only') return tool === 'read';
              if (policy === 'all') return true;
              return (
                (!policy.allow || policy.allow.includes(tool)) &&
                !policy.deny?.includes(tool)
              );
            });
            // Example host contract only: actual routing enforcement belongs to the host.
            const invoke = (tool: string): void => {
              if (!allowed.includes(tool))
                throw new Error(`tool ${tool} denied`);
            };
            return ok({
              name: record.name,
              capabilities: { contextPolicy: 'optional' },
              async run() {
                assert.throws(() => invoke('admin'), /denied/);
                if (
                  record.result === 'verdict' ||
                  (typeof policy === 'object' &&
                    policy.deny?.includes('write')) ||
                  policy === 'read-only'
                )
                  assert.throws(() => invoke('write'), /denied/);
                return { output: 'verified' };
              },
            });
          },
        },
        onEvent(event) {
          if (event.kind === 'done' || event.kind === 'failed')
            finished.resolve();
        },
      });
      assert.ok(
        (await board.startTask({ worker: 'function', goal: 'exercise policy' }))
          .ok,
      );
      await finished.promise;
      assert.equal(board.get('t1')?.state, 'done');
    }
  }
});

test('a result-kind edit while queued fails the task before constructing its worker', async () => {
  const source = new Source();
  const started = completion();
  const release = completion();
  const failed = completion();
  let constructions = 0;
  const board = new TaskBoard({
    profileSource: source,
    profileRunner: {
      ...runner(async () => ({ output: '' })),
      async createWorker(input) {
        constructions++;
        return ok({
          name: input.profile.name,
          capabilities: { contextPolicy: 'optional' },
          async run() {
            started.resolve();
            await release.promise;
            return { output: 'report' };
          },
        });
      },
    },
    maxConcurrent: 1,
    onEvent(event) {
      if (event.kind === 'failed') failed.resolve();
    },
  });
  assert.ok(
    (await board.startTask({ worker: 'author', goal: 'occupy slot' })).ok,
  );
  await started.promise;
  assert.ok(
    (await board.startTask({ worker: 'research', goal: 'queued report' })).ok,
  );
  const research = source.records.find((record) => record.name === 'research');
  assert.ok(research);
  research.result = 'verdict';
  release.resolve();
  await failed.promise;
  assert.equal(constructions, 1);
  assert.match(board.get('t2')?.error ?? '', /result kind changed/);
  assert.equal(board.get('t2')?.result, 'report');
});

test('corrective planner calls rediscover fresh text and source errors prevent runner calls', async () => {
  const source = new Source();
  source.prompts.planner = 'first planner';
  const systems: string[] = [];
  const profileRunner: IAgentProfileRunner = {
    ...runner(async () => ({ output: '' })),
    async preparePlanner(input) {
      systems.push(input.systemPrompt);
      return ok({
        async process() {
          const update = await new PlannerToolsClient().callTool(
            'update_plan',
            { steps: [{ id: 'pending', goal: 'work' }] },
          );
          assert.ok(update.ok && !update.value.isError);
          source.prompts.planner = 'corrective planner';
          return {
            ok: true,
            value: {
              content: 'reply',
              iterations: 1,
              toolCallCount: 0,
              stopReason: 'stop',
            },
          };
        },
        async *streamProcess() {},
      });
    },
  };
  const session = await DialogueSession.open({
    id: 'corrections',
    profileSource: source,
    profileRunner,
    board: {},
    maxCorrections: 1,
  });
  try {
    await session.send('request');
    assert.equal(systems.length, 2);
    assert.ok(systems[0]?.startsWith('first planner'));
    assert.ok(systems[1]?.startsWith('corrective planner'));
    source.getPrompts = async () => ({
      ok: false,
      error: { code: 'unavailable', message: 'prompt backend offline' },
    });
    await assert.rejects(session.send('retry'), /unavailable/);
    assert.equal(systems.length, 2);
    assert.ok(typeof session.snapshot().plan === 'object');
  } finally {
    await session.close();
  }
});
