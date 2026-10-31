import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ISubAgent, Message } from '@mcp-abap-adt/llm-agent';
import { SmartAgent } from '../../../agent.js';
import { ContextAssembler } from '../../../context/context-assembler.js';
import { DefaultPipeline } from '../../../pipeline/default-pipeline.js';
import { SmartAgentSubAgent } from '../../../subagent/smart-agent-subagent.js';
import { makeDefaultDeps } from '../../../testing/index.js';
import { DialogueSession } from '../dialogue-session.js';
import { InMemoryDialogueStateStore } from '../in-memory-dialogue-state-store.js';
import { formatRequestTime, REQUEST_TIME_GUIDANCE } from '../index.js';
import { DIALOGUE_PLANNER_SYSTEM } from '../planner-prompt.js';
import { runInPlannerScope } from '../planner-scope.js';
import { PlannerToolsClient } from '../planner-tools-client.js';
import { TaskBoard } from '../task-board.js';

const openedAt = Date.parse('2026-10-29T15:39:59.999Z');
const tools = new PlannerToolsClient();
const flush = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));
const lines = (messages: Message[]): string[] =>
  messages.flatMap((message) =>
    (message.content ?? '')
      .split('\n')
      .filter((line) => line.startsWith('[request time]')),
  );

for (const [instant, zone, expected] of [
  [openedAt, 'UTC', '2026-10-29 15:39 +00:00 (UTC)'],
  [openedAt, 'Asia/Tbilisi', '2026-10-29 19:39 +04:00 (Asia/Tbilisi)'],
  [openedAt, 'Asia/Kolkata', '2026-10-29 21:09 +05:30 (Asia/Kolkata)'],
  [
    Date.parse('2026-03-08T06:59:59Z'),
    'America/New_York',
    '2026-03-08 01:59 -05:00 (America/New_York)',
  ],
  [
    Date.parse('2026-03-08T07:00:00Z'),
    'America/New_York',
    '2026-03-08 03:00 -04:00 (America/New_York)',
  ],
  [
    Date.parse('2026-11-01T05:59:59Z'),
    'America/New_York',
    '2026-11-01 01:59 -04:00 (America/New_York)',
  ],
  [
    Date.parse('2026-11-01T06:00:00Z'),
    'America/New_York',
    '2026-11-01 01:00 -05:00 (America/New_York)',
  ],
  [
    Date.parse('2026-10-29T23:59:59Z'),
    'Asia/Tbilisi',
    '2026-10-30 03:59 +04:00 (Asia/Tbilisi)',
  ],
] as const) {
  test(`formatter: ${expected}`, () => {
    assert.equal(
      formatRequestTime(instant, zone),
      `[request time] ${expected}`,
    );
  });
}

test('default UTC and invalid zones', async () => {
  assert.equal(formatRequestTime(openedAt), formatRequestTime(openedAt, 'UTC'));
  assert.throws(() => formatRequestTime(openedAt, 'invalid/zone'), RangeError);
  let loaded = false;
  await assert.rejects(
    DialogueSession.open({
      id: 'invalid',
      timeZone: 'invalid/zone',
      store: {
        async load() {
          loaded = true;
          return undefined;
        },
        async save() {},
        async delete() {},
      },
      board: { workers: new Map() },
      planner: {
        async process() {
          throw new Error('must not run');
        },
      },
    }),
    { name: 'RangeError', message: /timeZone.*invalid\/zone/ },
  );
  assert.equal(loaded, false);
});

for (const timeZone of [undefined, 'Asia/Tbilisi']) {
  test(`prepared calls, corrections, new requests and restore reuse openedAt (${timeZone})`, async () => {
    const store = new InMemoryDialogueStateStore();
    let now = openedAt;
    const inputs: Message[][] = [];
    const options = {
      id: `time-${timeZone}`,
      timeZone,
      store,
      now: () => now,
      board: { workers: new Map() },
      planner: {
        async process(messages: Message[]) {
          inputs.push(messages);
          now += 86_400_000;
          if (inputs.length === 1) {
            await tools.callTool('plan_update', {
              steps: [{ id: 'work', goal: 'Result' }],
            });
          } else {
            await tools.callTool('plan_update', {
              steps: [{ id: 'work', goal: 'Result' }],
              status: 'waiting_user',
              question: 'Continue?',
            });
          }
          return { ok: true as const, value: { content: 'Reply' } };
        },
      },
    };
    const session = await DialogueSession.open(options);
    await session.send('Start');
    assert.equal(inputs.length, 2);
    await session.send('Continue');
    for (const input of inputs)
      assert.deepEqual(lines(input), [formatRequestTime(openedAt, timeZone)]);
    const saved = session.snapshot();
    assert.equal(saved.requests?.[0].openedAt, openedAt);
    assert.ok(!JSON.stringify(saved).includes('[request time]'));
    await session.close();
    await store.save(options.id, saved);
    const restored = await DialogueSession.open(options);
    await restored.send('Follow up');
    assert.deepEqual(lines(inputs.at(-1) ?? []), [
      formatRequestTime(openedAt, timeZone),
    ]);
    assert.deepEqual(
      Object.keys(restored.snapshot()).sort(),
      Object.keys(saved).sort(),
    );
    await restored.close();

    const freshInputs: Message[][] = [];
    const fresh = await DialogueSession.open({
      id: 'fresh',
      timeZone,
      now: () => now,
      board: { workers: new Map() },
      planner: {
        async process(messages) {
          freshInputs.push(messages);
          return { ok: true, value: { content: 'Done' } };
        },
      },
    });
    const first = now;
    await fresh.send('One');
    now += 86_400_000;
    await fresh.send('Two');
    assert.deepEqual(lines(freshInputs[0]), [
      formatRequestTime(first, timeZone),
    ]);
    assert.deepEqual(lines(freshInputs[1]), [formatRequestTime(now, timeZone)]);
    assert.equal(fresh.snapshot().requests?.length, 2);
    await fresh.close();
  });
}

for (const plannerContext of ['prepared', 'conversation'] as const) {
  test(`custom planner receives one session timestamp without changing history (${plannerContext})`, async () => {
    const store = new InMemoryDialogueStateStore();
    const inputs: Message[][] = [];
    const session = await DialogueSession.open({
      id: `custom-${plannerContext}`,
      plannerContext,
      store,
      timeZone: 'Asia/Tbilisi',
      now: () => openedAt,
      board: { workers: new Map() },
      planner: {
        async process(messages, options) {
          assert.ok(!('requestStartedAt' in options));
          inputs.push(structuredClone(messages));
          assert.deepEqual(lines(messages), [
            formatRequestTime(openedAt, 'Asia/Tbilisi'),
          ]);
          assert.ok(messages.at(-1)?.content?.includes('Start'));
          return { ok: true, value: { content: 'Done' } };
        },
      },
    });
    try {
      await session.send('Start');
      await session.send('Start again');
      assert.equal(inputs.length, 2);
      assert.ok(!JSON.stringify(session.snapshot()).includes('[request time]'));
      assert.ok(
        !JSON.stringify(await store.load(`custom-${plannerContext}`)).includes(
          '[request time]',
        ),
      );
    } finally {
      await session.close();
    }
  });
}

for (const history of [
  [{ role: 'user', content: '[request time] client text' }],
  [
    { role: 'user', content: formatRequestTime(openedAt - 86_400_000) },
    { role: 'assistant', content: 'Old response' },
    { role: 'user', content: 'Current request' },
  ],
] satisfies Message[][]) {
  test(`assembler inserts current time despite existing text: ${history[0].content}`, async () => {
    const before = structuredClone(history);
    const result = await new ContextAssembler().assemble(
      { type: 'action', text: history.at(-1)?.content ?? '' },
      { ragResults: {}, tools: [] },
      history,
      { requestStartedAt: openedAt },
    );
    assert.ok(result.ok);
    assert.deepEqual(lines(result.value), [
      ...(history.length > 1 ? [history[0].content] : []),
      formatRequestTime(openedAt),
      ...(history.length === 1 ? [history[0].content] : []),
    ]);
    assert.deepEqual(history, before);
  });
}

test('custom prepared builders receive session-composed request time', async () => {
  const session = await DialogueSession.open({
    id: 'custom',
    now: () => openedAt,
    board: { workers: new Map() },
    plannerContextBuilder: {
      build: () => [{ role: 'system', content: 'Custom system' }],
    },
    planner: {
      async process(messages) {
        assert.deepEqual(lines(messages), [formatRequestTime(openedAt)]);
        assert.equal(messages[0].content, 'Custom system');
        return { ok: true, value: { content: 'Done' } };
      },
    },
  });
  await session.send('Start');
  await session.close();
});

test('queued executor and audit capture the delegation request time', async () => {
  let release: () => void = () => {
    throw new Error('not initialized');
  };
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const contexts: string[] = [];
  const worker: ISubAgent = {
    name: 'executor',
    capabilities: { contextPolicy: 'optional' },
    async run(input) {
      const assembled = await new ContextAssembler().assemble(
        { type: 'action', text: input.context ?? input.task },
        { ragResults: {}, tools: [] },
        [],
        { requestStartedAt: input.requestStartedAt },
      );
      assert.ok(assembled.ok);
      contexts.push(
        assembled.value.find((message) => message.role === 'user')?.content ??
          '',
      );
      await pending;
      return { output: 'PASS' };
    },
  };
  const board = new TaskBoard({
    workers: new Map([
      ['executor', worker],
      ['audit', { ...worker, name: 'audit' }],
    ]),
    maxConcurrent: 1,
    onEvent() {},
  });
  let time = openedAt;
  try {
    await runInPlannerScope(
      {
        board,
        get requestStartedAt() {
          return time;
        },
        getPlan: () => undefined,
        setPlan() {},
      },
      async () => {
        for (const name of ['executor', 'audit']) {
          const result = await tools.callTool('delegate_task', {
            worker: name,
            goal: 'Result',
            context: 'Facts',
          });
          assert.ok(result.ok && !result.value.isError);
        }
      },
    );
    await flush();
    time = openedAt + 86_400_000;
    release();
    await flush();
    assert.equal(contexts.length, 2);
    for (const context of contexts)
      assert.equal(context, `${formatRequestTime(openedAt)}\n\nFacts`);
  } finally {
    release();
    await board.stopAll();
  }
});

test('wait-mode completion wake keeps planner and both worker roles on request time', async () => {
  let now = openedAt;
  let finish: () => void = () => {
    throw new Error('not initialized');
  };
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const contexts: string[] = [];
  const worker: ISubAgent = {
    name: 'executor',
    capabilities: { contextPolicy: 'optional' },
    async run(input) {
      const assembled = await new ContextAssembler().assemble(
        { type: 'action', text: input.context ?? input.task },
        { ragResults: {}, tools: [] },
        [],
        { requestStartedAt: input.requestStartedAt },
      );
      assert.ok(assembled.ok);
      contexts.push(
        assembled.value.find((message) => message.role === 'user')?.content ??
          '',
      );
      await pending;
      return { output: 'PASS' };
    },
  };
  const inputs: Message[][] = [];
  let wake: () => void = () => {
    throw new Error('not initialized');
  };
  const woke = new Promise<void>((resolve) => {
    wake = resolve;
  });
  const session = await DialogueSession.open({
    id: 'wait-time',
    now: () => now,
    maxCorrections: 0,
    waitTickMs: 0,
    longTaskMs: 0,
    board: {
      workers: new Map([
        ['executor', worker],
        ['audit', { ...worker, name: 'audit' }],
      ]),
    },
    planner: {
      async process(messages) {
        inputs.push(messages);
        if (inputs.length === 1) {
          await tools.callTool('delegate_task', {
            worker: 'executor',
            goal: 'Result',
          });
          await flush();
          await tools.callTool('list_tasks', {});
          await tools.callTool('list_tasks', {});
        } else if (inputs.length === 2) {
          await tools.callTool('delegate_task', {
            worker: 'audit',
            goal: 'Check result',
          });
          wake();
        }
        return { ok: true, value: { content: 'Started' } };
      },
    },
  });
  try {
    await session.send('Start');
    now += 86_400_000;
    finish();
    await woke;
    await flush();
    assert.ok(inputs.length >= 2);
    for (const input of inputs)
      assert.deepEqual(lines(input), [formatRequestTime(openedAt)]);
    for (const context of contexts)
      assert.ok(context.startsWith(`${formatRequestTime(openedAt)}\n\n`));
  } finally {
    finish();
    await session.close();
  }
});

test('planner and library-configured dialogue worker guidance contains no timestamp', async () => {
  assert.ok(DIALOGUE_PLANNER_SYSTEM.includes(REQUEST_TIME_GUIDANCE));
  assert.ok(!DIALOGUE_PLANNER_SYSTEM.includes('[request time]'));
  for (const role of ['executor', 'audit']) {
    const result = await new ContextAssembler({
      systemPromptPreamble: `You are the ${role}.`,
    }).assemble(
      { type: 'action', text: `${formatRequestTime(openedAt)}\nTask` },
      { ragResults: {}, tools: [] },
      [],
    );
    assert.ok(result.ok);
    const system =
      result.value.find((message) => message.role === 'system')?.content ?? '';
    assert.ok(system.includes(REQUEST_TIME_GUIDANCE));
    assert.ok(!system.includes('[request time]'));
  }
});

test('non-dialogue assembler supplies static guidance and the request time', async () => {
  for (const timeZone of [undefined, 'Asia/Tbilisi']) {
    const result = await new ContextAssembler({ timeZone }).assemble(
      { type: 'action', text: 'Task' },
      { ragResults: {}, tools: [] },
      [],
      { requestStartedAt: openedAt },
    );
    assert.ok(result.ok);
    assert.deepEqual(lines(result.value), [
      formatRequestTime(openedAt, timeZone),
    ]);
    const system = result.value.find((message) => message.role === 'system');
    assert.ok(system?.content?.includes(REQUEST_TIME_GUIDANCE));
    assert.ok(!system?.content?.includes('[request time]'));
  }
  assert.throws(() => new ContextAssembler({ timeZone: 'invalid/zone' }), {
    name: 'RangeError',
    message: /timeZone.*invalid\/zone/,
  });
});

for (const plannerContext of ['prepared', 'conversation'] as const) {
  test(`internal planner tool rounds preserve the session zone (mode=${plannerContext})`, async () => {
    let now = openedAt;
    const inputs: Message[][] = [];
    const { deps, llm } = makeDefaultDeps({
      assembler: new ContextAssembler({
        systemPromptPreamble: DIALOGUE_PLANNER_SYSTEM,
        timeZone: 'America/New_York',
      }),
      mcpClients: [new PlannerToolsClient()],
      llmResponses: [
        {
          content: '',
          finishReason: 'tool_calls',
          toolCalls: [{ id: 'one', name: 'plan_get', arguments: {} }],
        },
        {
          content: '',
          finishReason: 'tool_calls',
          toolCalls: [{ id: 'two', name: 'plan_get', arguments: {} }],
        },
        { content: 'Done' },
      ],
    });
    const chat = llm.chat.bind(llm);
    llm.chat = async (messages, options) => {
      inputs.push(structuredClone(messages));
      now += 86_400_000;
      return chat(messages, options);
    };
    const streamChat = llm.streamChat.bind(llm);
    llm.streamChat = async function* (messages, options) {
      inputs.push(structuredClone(messages));
      now += 86_400_000;
      yield* streamChat(messages, options);
    };
    const session = await DialogueSession.open({
      id: 'rounds',
      plannerContext,
      timeZone: 'Asia/Tbilisi',
      now: () => now,
      maxCorrections: 0,
      board: { workers: new Map() },
      planner: new SmartAgent(deps, {
        maxIterations: 5,
        heartbeatIntervalMs: 0,
      }),
    });
    try {
      await session.send('Start');
      assert.equal(inputs.length, 3);
      for (const input of inputs) {
        assert.deepEqual(lines(input), [
          formatRequestTime(openedAt, 'Asia/Tbilisi'),
        ]);
        for (const message of input.filter((entry) => entry.role === 'system'))
          assert.ok(!message.content?.includes('[request time]'));
      }
    } finally {
      await session.close();
    }
  });
}

test('explicit new_request refreshes the timestamp from the existing session clock', async () => {
  let now = openedAt;
  let calls = 0;
  const inputs: Message[][] = [];
  const session = await DialogueSession.open({
    id: 'explicit',
    now: () => now,
    maxCorrections: 0,
    board: { workers: new Map() },
    planner: {
      async process(messages) {
        inputs.push(messages);
        calls++;
        if (calls === 1) {
          const result = await tools.callTool('plan_update', {
            plan: 'Keep request active',
          });
          assert.ok(result.ok && !result.value.isError);
        } else if (calls === 2) {
          const result = await tools.callTool('new_request', {});
          assert.ok(result.ok && !result.value.isError);
        }
        return { ok: true, value: { content: 'Reply' } };
      },
    },
  });
  try {
    await session.send('Start');
    now += 86_400_000;
    await session.send('Unrelated work');
    assert.equal(inputs.length, 3);
    assert.deepEqual(lines(inputs[0]), [formatRequestTime(openedAt)]);
    assert.deepEqual(lines(inputs[1]), [formatRequestTime(openedAt)]);
    assert.deepEqual(lines(inputs[2]), [formatRequestTime(now)]);
    assert.deepEqual(
      session.snapshot().requests?.map((request) => request.openedAt),
      [openedAt, now],
    );
  } finally {
    await session.close();
  }
});

for (const pipelineEnabled of [false, true]) {
  test(`ordinary and delegated agent calls keep one request time across tool rounds (pipeline=${pipelineEnabled})`, async (t) => {
    let now = openedAt + 86_400_000;
    t.mock.method(Date, 'now', () => now);
    const inputs: Message[][] = [];
    const { deps, llm } = makeDefaultDeps({
      assembler: new ContextAssembler(),
      mcpClients: [new PlannerToolsClient()],
      llmResponses: [
        {
          content: '',
          finishReason: 'tool_calls',
          toolCalls: [{ id: 'one', name: 'plan_get', arguments: {} }],
        },
        { content: 'Done' },
        { content: 'Worker done' },
      ],
    });
    const chat = llm.chat.bind(llm);
    llm.chat = async (messages, options) => {
      inputs.push(structuredClone(messages));
      now += 86_400_000;
      return chat(messages, options);
    };
    const stream = llm.streamChat.bind(llm);
    llm.streamChat = async function* (messages, options) {
      inputs.push(structuredClone(messages));
      now += 86_400_000;
      yield* stream(messages, options);
    };
    if (pipelineEnabled) {
      const pipeline = new DefaultPipeline();
      pipeline.initialize({
        mainLlm: llm,
        mcpClients: deps.mcpClients,
        assembler: deps.assembler,
        classifier: deps.classifier,
      });
      deps.pipeline = pipeline;
    }
    const agent = new SmartAgent(deps, {
      maxIterations: 5,
      heartbeatIntervalMs: 0,
    });
    const requestStart = now;
    const ordinary = await agent.process('Start');
    assert.ok(ordinary.ok);
    assert.equal(inputs.length, 2);
    for (const messages of inputs) {
      assert.deepEqual(lines(messages), [formatRequestTime(requestStart)]);
      const system = messages.find((message) => message.role === 'system');
      assert.ok(system?.content?.includes(REQUEST_TIME_GUIDANCE));
      assert.ok(!system?.content?.includes('[request time]'));
    }
    const board = new TaskBoard({
      workers: new Map([
        ['executor', new SmartAgentSubAgent('executor', agent)],
      ]),
      onEvent() {},
    });
    try {
      await runInPlannerScope(
        {
          board,
          requestStartedAt: openedAt,
          getPlan: () => undefined,
          setPlan() {},
        },
        async () => {
          const delegated = await tools.callTool('delegate_task', {
            worker: 'executor',
            goal: 'Work',
            context: 'Facts',
          });
          assert.ok(delegated.ok && !delegated.value.isError);
        },
      );
      for (
        let i = 0;
        i < 20 &&
        board
          .list()
          .some((task) => task.state === 'queued' || task.state === 'running');
        i++
      )
        await flush();
      assert.equal(inputs.length, 3);
      assert.deepEqual(lines(inputs[2]), [formatRequestTime(openedAt)]);
    } finally {
      await board.stopAll();
    }
  });
}

test('agent deployment timeZone is validated even with a custom assembler', () => {
  const { deps } = makeDefaultDeps();
  assert.throws(
    () => new SmartAgent(deps, { maxIterations: 1, timeZone: 'invalid/zone' }),
    {
      name: 'RangeError',
      message: /timeZone.*invalid\/zone/,
    },
  );
});

test('pass mode adds static guidance to all inputs and request time only when owned', async (t) => {
  t.mock.method(Date, 'now', () => openedAt);
  const inputs: Message[][] = [];
  const { deps, llm } = makeDefaultDeps();
  const stream = llm.streamChat.bind(llm);
  llm.streamChat = async function* (messages, options) {
    inputs.push(structuredClone(messages));
    yield* stream(messages, options);
  };
  const agent = new SmartAgent(deps, {
    mode: 'pass',
    maxIterations: 1,
    timeZone: 'Asia/Tbilisi',
  });
  assert.ok((await agent.process('Task')).ok);
  assert.deepEqual(inputs[0], [
    { role: 'system', content: REQUEST_TIME_GUIDANCE },
    {
      role: 'user',
      content: `${formatRequestTime(openedAt, 'Asia/Tbilisi')}\n\nTask`,
    },
  ]);
  const messages: Message[] = [
    { role: 'system', content: 'Custom guidance' },
    { role: 'user', content: 'Previous' },
    { role: 'assistant', content: 'Reply' },
    { role: 'user', content: 'Current' },
  ];
  const original = structuredClone(messages);
  assert.ok((await agent.process(messages)).ok);
  const expected = structuredClone(original);
  expected[0].content = `Custom guidance\n\n${REQUEST_TIME_GUIDANCE}`;
  assert.deepEqual(inputs[1], expected);
  assert.ok((await agent.process(messages, { requestStartedAt: 0 })).ok);
  expected[3].content = `${formatRequestTime(0, 'Asia/Tbilisi')}\n\nCurrent`;
  assert.deepEqual(inputs[2], expected);
  assert.deepEqual(messages, original);

  const board = new TaskBoard({
    workers: new Map([['executor', new SmartAgentSubAgent('executor', agent)]]),
    onEvent() {},
  });
  try {
    await runInPlannerScope(
      { board, requestStartedAt: 0, getPlan: () => undefined, setPlan() {} },
      async () => {
        const result = await tools.callTool('delegate_task', {
          worker: 'executor',
          goal: 'Work',
          context: 'Facts',
        });
        assert.ok(result.ok && !result.value.isError);
      },
    );
    for (
      let i = 0;
      i < 20 &&
      board
        .list()
        .some((task) => task.state === 'queued' || task.state === 'running');
      i++
    )
      await flush();
    assert.equal(inputs.length, 4);
    assert.deepEqual(lines(inputs[3]), [formatRequestTime(0, 'Asia/Tbilisi')]);
    assert.ok(inputs[3][0].content?.includes(REQUEST_TIME_GUIDANCE));
  } finally {
    await board.stopAll();
  }
});
