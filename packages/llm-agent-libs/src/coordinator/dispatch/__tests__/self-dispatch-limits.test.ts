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
