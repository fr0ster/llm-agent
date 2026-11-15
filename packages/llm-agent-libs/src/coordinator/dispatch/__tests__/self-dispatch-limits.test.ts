import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  ICoordinatorContext,
  ILlm,
  Plan,
  PlanStep,
} from '@mcp-abap-adt/llm-agent';
import { SmartAgentBuilder } from '../../../builder.js';
import { unwrapBuilderResult } from '../../../builder-types.js';
import {
  makeLlm,
  makeMcpClient,
  makeRag,
  testCallOptions,
  testRequestAccess,
} from '../../../testing/index.js';
import { SelfDispatch } from '../self.js';

for (const maxToolCalls of [undefined, 0, 1]) {
  test(`builder coordinator without MCP reports tool budget ${maxToolCalls ?? 'unlimited'}`, async () => {
    let calls = 0;
    const llm: ILlm = {
      ...makeLlm([]),
      async chat(_messages, tools) {
        calls++;
        assert.deepEqual(tools, []);
        return { ok: true, value: { content: 'done', finishReason: 'stop' } };
      },
    };
    const plan = (): Plan => ({
      source: 'planner-llm',
      createdAt: 0,
      steps: [],
    });
    const handle = await new SmartAgentBuilder({ skipModelValidation: true })
      .withRagAccess(testRequestAccess)
      .withMainLlm(llm)
      .withMaxToolCalls(maxToolCalls)
      .withCoordinator({
        planning: {
          name: 'scripted',
          buildInitialPlan: async () => plan(),
          shouldReplan: () => false,
          rebuildPlan: async () => plan(),
        },
      })
      .build()
      .then(unwrapBuilderResult);
    try {
      const result = await handle.agent.process('Work', testCallOptions());
      assert.equal(result.ok, true);
      assert.equal(calls, 1);
      if (result.ok) {
        assert.match(result.value.content, /done/);
        assert.equal(result.value.toolCallCount, 0);
        assert.equal(
          result.value.budgetExhausted,
          maxToolCalls === 0 ? true : undefined,
        );
        if (maxToolCalls === 0) assert.equal(result.value.maxToolCalls, 0);
      }
    } finally {
      await handle.close();
    }
  });
}

for (const maxIterations of [undefined, 3]) {
  test(`builder coordinator fallback uses agent limit: ${maxIterations ?? 'unlimited'}`, async () => {
    let calls = 0;
    const llm: ILlm = {
      ...makeLlm([]),
      async chat(_messages, tools) {
        calls++;
        if (calls <= 8 && tools?.length) {
          return {
            ok: true,
            value: {
              content: '',
              finishReason: 'tool_calls',
              toolCalls: [
                {
                  id: `c${calls}`,
                  name: tools[0].name,
                  arguments: { round: calls },
                },
              ],
            },
          };
        }
        return { ok: true, value: { content: 'done', finishReason: 'stop' } };
      },
    };
    const plan = (): Plan => ({
      source: 'planner-llm',
      createdAt: 0,
      steps: [],
    });
    const client = makeMcpClient([
      { name: 'Work', description: 'Work', inputSchema: {} },
    ]);
    const builder = new SmartAgentBuilder({ skipModelValidation: true })
      .withRagAccess(testRequestAccess)
      .withMainLlm(llm)
      .withMcpClients([client])
      .setToolsRag(
        makeRag([{ text: 'Work', score: 1, metadata: { id: 'tool:Work' } }]),
      )
      .withCoordinator({
        planning: {
          name: 'scripted',
          buildInitialPlan: async () => plan(),
          shouldReplan: () => false,
          rebuildPlan: async () => plan(),
        },
      });
    if (maxIterations !== undefined) builder.withMaxIterations(maxIterations);
    const handle = await builder.build().then(unwrapBuilderResult);
    try {
      const result = await handle.agent.process('Work', testCallOptions());
      assert.equal(result.ok, true);
      if (result.ok) assert.match(result.value.content, /done/);
      assert.equal(calls, (maxIterations ?? 8) + 1);
      assert.equal(client.callCount, maxIterations ?? 8);
    } finally {
      await handle.close();
    }
  });
}

for (const mode of [
  'zero',
  'explicit',
  'partial-batch',
  'runtime',
  'reset',
  'multi-step',
] as const) {
  test(`builder SelfDispatch honours ${mode} tool budget and reports exhaustion`, async () => {
    let rounds = 0;
    const limit = mode === 'zero' ? 0 : mode === 'partial-batch' ? 4 : 30;
    const llm: ILlm = {
      ...makeLlm([]),
      async chat(messages, tools) {
        rounds++;
        if (rounds <= 12 && tools?.length) {
          return {
            ok: true,
            value: {
              content: '',
              finishReason: 'tool_calls',
              toolCalls: Array.from({ length: 3 }, (_, index) => ({
                id: `call-${rounds}-${index}`,
                name: tools[0].name,
                arguments: { round: rounds, index },
              })),
            },
          };
        }
        // Every requested tool call, including skipped calls, needs a response.
        const requested = messages.flatMap((message) =>
          'tool_calls' in message ? (message.tool_calls ?? []) : [],
        );
        for (const call of requested) {
          assert.ok(
            messages.some(
              (message) =>
                message.role === 'tool' && message.tool_call_id === call.id,
            ),
          );
        }
        if (mode === 'partial-batch') {
          assert.equal(
            messages.filter(
              (message) =>
                message.role === 'tool' &&
                message.content?.includes('not executed'),
            ).length,
            2,
          );
        }
        return { ok: true, value: { content: 'done', finishReason: 'stop' } };
      },
    };
    const plan = (): Plan => ({
      source: 'planner-llm',
      createdAt: 0,
      steps:
        mode === 'multi-step'
          ? [
              { id: 's1', goal: 'Work', status: 'pending' },
              { id: 's2', goal: 'Work', status: 'pending' },
            ]
          : [],
    });
    const client = makeMcpClient([
      { name: 'Work', description: 'Work', inputSchema: {} },
    ]);
    const builder = new SmartAgentBuilder({ skipModelValidation: true })
      .withRagAccess(testRequestAccess)
      .withMainLlm(llm)
      .withMcpClients([client])
      .setToolsRag(
        makeRag([{ text: 'Work', score: 1, metadata: { id: 'tool:Work' } }]),
      )
      .withCoordinator({
        planning: {
          name: 'scripted',
          buildInitialPlan: async () => plan(),
          shouldReplan: () => false,
          rebuildPlan: async () => plan(),
        },
      });
    if (mode !== 'runtime') builder.withMaxToolCalls(limit);
    if (mode === 'reset') builder.withMaxIterations(1);
    const handle = await builder.build().then(unwrapBuilderResult);
    try {
      if (mode === 'runtime') {
        handle.agent.applyConfigUpdate({ maxToolCalls: limit });
      } else if (mode === 'reset') {
        handle.agent.applyConfigUpdate({
          maxIterations: null,
          maxToolCalls: null,
        });
      }
      let observed = 0;
      const result = await handle.agent.process('Work', {
        ...testCallOptions(),
        onToolCallCount: (count) => {
          observed = count;
        },
      });
      assert.equal(result.ok, true);
      assert.equal(client.callCount, mode === 'reset' ? 36 : limit);
      assert.equal(observed, client.callCount);
      assert.equal(
        rounds,
        mode === 'reset'
          ? 13
          : Math.ceil(limit / 3) + (mode === 'multi-step' ? 2 : 1),
      );
      if (result.ok) {
        assert.match(result.value.content, /done/);
        assert.equal(
          result.value.budgetExhausted,
          mode === 'reset' ? undefined : true,
        );
        if (mode !== 'reset') {
          assert.equal(result.value.toolCallCount, limit);
          assert.equal(result.value.maxToolCalls, limit);
        }
      }
    } finally {
      await handle.close();
    }
  });
}

test('SelfDispatch shares the tool budget across coordinator steps', async () => {
  let toolCalls = 0;
  const llm: ILlm = {
    ...makeLlm([]),
    async chat(messages, tools) {
      if (
        tools?.length &&
        !messages.some((message) => message.role === 'tool')
      ) {
        return {
          ok: true,
          value: {
            content: '',
            finishReason: 'tool_calls',
            toolCalls: [{ id: 'call', name: 'Work', arguments: {} }],
          },
        };
      }
      return { ok: true, value: { content: 'done', finishReason: 'stop' } };
    },
  };
  const options = testCallOptions();
  const ctx: ICoordinatorContext = {
    caller: options.caller,
    sessionId: options.sessionId,
    inputText: 'Work',
    registry: new Map(),
    stepResults: {},
    selectedTools: [{ name: 'Work', description: 'Work', inputSchema: {} }],
    async callTool() {
      toolCalls++;
      return 'completed';
    },
  };
  const dispatch = new SelfDispatch(llm, undefined, undefined, 1);
  const first = await dispatch.dispatch(
    { id: 's1', goal: 'Work', status: 'pending' },
    ctx,
  );
  const second = await dispatch.dispatch(
    { id: 's2', goal: 'Work', status: 'pending' },
    ctx,
  );
  assert.equal(toolCalls, 1);
  for (const result of [first, second]) {
    assert.equal(result.ok, true);
    assert.equal(result.output, 'done');
    assert.equal(result.budgetExhausted, true);
    assert.equal(result.toolCallCount, 1);
    assert.equal(result.maxToolCalls, 1);
  }
});

for (const maxIterations of [undefined, 3]) {
  test(`SelfDispatch tool-loop limit: ${maxIterations ?? 'unlimited'}`, async () => {
    let calls = 0;
    let toolCalls = 0;
    const llm: ILlm = {
      ...makeLlm([]),
      async chat(_messages, tools) {
        calls++;
        if (calls <= 8 && tools?.length) {
          return {
            ok: true,
            value: {
              content: '',
              finishReason: 'tool_calls',
              toolCalls: [{ id: `c${calls}`, name: 'Work', arguments: {} }],
            },
          };
        }
        return { ok: true, value: { content: 'done', finishReason: 'stop' } };
      },
    };
    const options = testCallOptions();
    const ctx: ICoordinatorContext = {
      caller: options.caller,
      sessionId: options.sessionId,
      inputText: 'complete the work',
      registry: new Map(),
      stepResults: {},
      selectedTools: [{ name: 'Work', description: 'Work', inputSchema: {} }],
      async callTool() {
        toolCalls++;
        return 'completed';
      },
    };
    const step: PlanStep = { id: 's1', goal: 'Work', status: 'pending' };
    const result = await new SelfDispatch(
      llm,
      undefined,
      maxIterations,
    ).dispatch(step, ctx);
    assert.equal(result.ok, true);
    assert.equal(result.output, 'done');
    assert.equal(toolCalls, maxIterations ?? 8);
    assert.equal(calls, (maxIterations ?? 8) + 1);
  });
}
