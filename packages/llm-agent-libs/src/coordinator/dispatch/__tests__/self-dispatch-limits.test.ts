import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type ICoordinatorContext,
  type ILlm,
  LlmError,
  McpError,
  type Plan,
  type PlanStep,
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

test('coordinator does not replay a write when self-dispatch is truncated', async () => {
  let calls = 0;
  const llm: ILlm = {
    ...makeLlm([]),
    async chat(_messages, tools) {
      calls++;
      if (calls === 1 || calls === 3) {
        const tool = tools?.[0];
        assert.ok(tool);
        return {
          ok: true,
          value: {
            content: '',
            finishReason: 'tool_calls',
            toolCalls: [
              { id: `write-${calls}`, name: tool.name, arguments: {} },
            ],
          },
        };
      }
      return {
        ok: true,
        value: {
          content: 'partial answer',
          finishReason: calls === 2 ? 'length' : 'stop',
        },
      };
    },
  };
  const client = makeMcpClient([
    { name: 'Write', description: 'Write', inputSchema: {} },
  ]);
  let replanChecks = 0;
  const plan = (): Plan => ({
    source: 'planner-llm',
    createdAt: 0,
    steps: [{ id: 's1', goal: 'Write', status: 'pending' }],
  });
  const handle = await new SmartAgentBuilder({ skipModelValidation: true })
    .withRagAccess(testRequestAccess)
    .withMainLlm(llm)
    .withMcpClients([client])
    .setToolsRag(
      makeRag([{ text: 'Write', score: 1, metadata: { id: 'tool:Write' } }]),
    )
    .withCoordinator({
      maxRetriesPerStep: 1,
      failPolicy: 'continue',
      planning: {
        name: 'scripted',
        buildInitialPlan: async () => plan(),
        shouldReplan: () => {
          replanChecks++;
          return false;
        },
        rebuildPlan: async () => plan(),
      },
    })
    .build()
    .then(unwrapBuilderResult);
  try {
    const result = await handle.agent.process('Write', testCallOptions());
    assert.equal(client.callCount, 1);
    assert.equal(calls, 2);
    assert.equal(replanChecks, 0);
    assert.ok(!result.ok);
    assert.equal(result.error.code, 'LLM_OUTPUT_TRUNCATED');
  } finally {
    await handle.close();
  }
});

for (const mode of ['answer-direct', 'budget', 'provider', 'tool'] as const) {
  test(`coordinator preserves the terminal error from self-dispatch (${mode})`, async () => {
    const tool = { name: 'Write', description: 'Write', inputSchema: {} };
    const withTool = mode === 'budget' || mode === 'tool';
    const providerError = new LlmError(
      'Invalid credentials',
      'CREDENTIALS_REJECTED',
    );
    const toolError = new McpError('Write aborted', 'ABORTED');
    let calls = 0;
    let writes = 0;
    const llm: ILlm = {
      ...makeLlm([]),
      async chat(_messages, tools) {
        calls++;
        if (mode === 'provider') return { ok: false, error: providerError };
        if (withTool && calls === 1) {
          assert.equal(tools?.[0]?.name, tool.name);
          return {
            ok: true,
            value: {
              content: '',
              finishReason: 'tool_calls',
              toolCalls: [{ id: 'write', name: tool.name, arguments: {} }],
            },
          };
        }
        assert.deepEqual(tools, []);
        return {
          ok: true,
          value: { content: 'partial', finishReason: 'length' },
        };
      },
    };
    const client = {
      ...makeMcpClient([tool]),
      async callTool() {
        writes++;
        return mode === 'tool'
          ? { ok: false as const, error: toolError }
          : { ok: true as const, value: { content: 'written' } };
      },
    };
    const builder = new SmartAgentBuilder({ skipModelValidation: true })
      .withRagAccess(testRequestAccess)
      .withMainLlm(llm)
      .withMaxToolCalls(1)
      .withCoordinator({
        maxRetriesPerStep: 1,
        planning: {
          name: 'scripted',
          buildInitialPlan: async () => ({
            source: 'planner-llm',
            createdAt: 0,
            steps:
              mode === 'answer-direct'
                ? []
                : [{ id: 's1', goal: 'Write', status: 'pending' }],
          }),
          shouldReplan: () => assert.fail('terminal error reached replanning'),
          rebuildPlan: () => assert.fail('unexpected replan'),
        },
      });
    if (withTool) {
      builder.withMcpClients([client]).setToolsRag(
        makeRag([
          {
            text: tool.name,
            score: 1,
            metadata: { id: `tool:${tool.name}` },
          },
        ]),
      );
    }
    const handle = await builder.build().then(unwrapBuilderResult);
    try {
      const result = await handle.agent.process('Write', testCallOptions());
      assert.ok(!result.ok);
      if (mode === 'provider') assert.equal(result.error, providerError);
      else if (mode === 'tool') assert.equal(result.error.code, toolError.code);
      else assert.equal(result.error.code, 'LLM_OUTPUT_TRUNCATED');
      assert.equal(calls, mode === 'budget' ? 2 : 1);
      assert.equal(writes, withTool ? 1 : 0);
    } finally {
      await handle.close();
    }
  });
}

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
