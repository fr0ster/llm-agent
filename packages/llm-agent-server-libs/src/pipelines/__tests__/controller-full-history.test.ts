import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ILlm, Message } from '@mcp-abap-adt/llm-agent';
import { symmetricEmbedder } from '@mcp-abap-adt/llm-agent';
import { testCallOptions } from '../../../../llm-agent-libs/src/testing/index.js';
import { controllerPlugin, fakeControllerServerCtx } from './fixtures.js';

for (const name of ['controller', 'controller-weak']) {
  test(`${name}: default sends six complete tool rounds to the executor model`, async () => {
    const inputs: Message[][] = [];
    const executor: ILlm = {
      async chat(messages) {
        inputs.push(structuredClone(messages));
        const round = inputs.length;
        assert.ok(round <= 7);
        return {
          ok: true,
          value:
            round <= 6
              ? {
                  content: `ASSISTANT-${round}`,
                  toolCalls: [
                    { id: `call-${round}`, name: 'Work', arguments: { round } },
                  ],
                  finishReason: 'tool_calls',
                }
              : { content: 'DONE', finishReason: 'stop' },
        };
      },
      async *streamChat() {},
    };
    let plans = 0;
    const planner: ILlm = {
      async chat() {
        return {
          ok: true,
          value: {
            content:
              ++plans === 1
                ? JSON.stringify({
                    plan: [{ name: 's1', instructions: 'work' }],
                  })
                : 'FINAL',
            finishReason: 'stop',
          },
        };
      },
      async *streamChat() {},
    };
    const evaluator: ILlm = {
      async chat() {
        return {
          ok: true,
          value: { content: 'Goal: work', finishReason: 'stop' },
        };
      },
      async *streamChat() {},
    };
    const rag = {
      write: async () => {},
      query: async () => [],
      list: async () => [],
      fingerprint: () => 'history',
    };
    let executions = 0;
    const instance = await controllerPlugin(
      name,
      name === 'controller-weak' ? 'weak-executor' : 'smart-executor',
    ).build({
      ...fakeControllerServerCtx(),
      embedder: symmetricEmbedder({ embed: async () => ({ vector: [1] }) }),
      resolveLlm: async (role) =>
        role === 'executor'
          ? executor
          : role === 'planner'
            ? planner
            : evaluator,
      knowledgeRagFor: () => rag,
      toolsRag: {
        query: async () => [
          { name: 'Work', description: 'work', inputSchema: {} },
        ],
        lookup: (toolName) =>
          toolName === 'Work'
            ? { name: 'Work', description: 'work', inputSchema: {} }
            : undefined,
      },
      mcpClients: [
        {
          async listTools() {
            return {
              ok: true,
              value: [{ name: 'Work', description: 'work', inputSchema: {} }],
            };
          },
          async callTool() {
            return { ok: true, value: { content: `RESULT-${++executions}` } };
          },
        },
      ],
    });
    try {
      const result = await instance.agent.process('work', testCallOptions());
      assert.ok(result.ok);
      assert.equal(inputs.length, 7, JSON.stringify({ result, plans }));
      assert.equal(executions, 6);
      const history = inputs[6].filter(
        (message) => message.tool_calls?.length || message.role === 'tool',
      );
      assert.equal(history.length, 12);
      const ids = history.flatMap((message) =>
        (message.tool_calls ?? []).map((call) => call.id),
      );
      assert.equal(new Set(ids).size, 6);
      for (let round = 1; round <= 6; round++) {
        const assistant = history[(round - 1) * 2];
        const tool = history[(round - 1) * 2 + 1];
        assert.equal(assistant.role, 'assistant');
        assert.equal(assistant.content, `ASSISTANT-${round}`);
        const id = assistant.tool_calls?.[0].id;
        assert.ok(id);
        assert.match(id, /^tc:[0-9a-f-]{36}:0$/);
        assert.deepEqual(assistant.tool_calls, [
          {
            id,
            type: 'function',
            function: { name: 'Work', arguments: JSON.stringify({ round }) },
          },
        ]);
        assert.equal(tool.role, 'tool');
        assert.equal(tool.tool_call_id, id);
        assert.equal(tool.content, `RESULT-${round}`);
      }
    } finally {
      await instance.close();
    }
  });
}

for (const name of ['controller', 'controller-weak']) {
  test(`${name}: actual responses assign repeated external calls distinct suspension IDs`, async () => {
    const inputs: Message[][] = [];
    const executor: ILlm = {
      async chat(messages) {
        inputs.push(structuredClone(messages));
        assert.ok(inputs.length <= 3);
        return {
          ok: true,
          value:
            inputs.length <= 2
              ? {
                  content: 'SAME_ASSISTANT',
                  toolCalls: [
                    {
                      id: 'same-model-id',
                      name: 'Lookup',
                      arguments: { key: 'SAME' },
                    },
                  ],
                  finishReason: 'tool_calls',
                }
              : { content: 'DONE', finishReason: 'stop' },
        };
      },
      async *streamChat() {},
    };
    let plans = 0;
    const planner: ILlm = {
      async chat() {
        return {
          ok: true,
          value: {
            content:
              ++plans === 1
                ? JSON.stringify({
                    plan: [{ name: 's1', instructions: 'work' }],
                  })
                : 'FINAL',
            finishReason: 'stop',
          },
        };
      },
      async *streamChat() {},
    };
    const evaluator: ILlm = {
      async chat() {
        return {
          ok: true,
          value: { content: 'Goal: work', finishReason: 'stop' },
        };
      },
      async *streamChat() {},
    };
    const instance = await controllerPlugin(
      name,
      name === 'controller-weak' ? 'weak-executor' : 'smart-executor',
    ).build({
      ...fakeControllerServerCtx(),
      embedder: symmetricEmbedder({ embed: async () => ({ vector: [1] }) }),
      resolveLlm: async (role) =>
        role === 'executor'
          ? executor
          : role === 'planner'
            ? planner
            : evaluator,
      knowledgeRagFor: () => ({
        write: async () => {},
        query: async () => [],
        list: async () => [],
        fingerprint: () => 'external-resume',
      }),
    });
    try {
      const options = {
        ...testCallOptions(),
        externalTools: [{ name: 'Lookup', description: '', inputSchema: {} }],
      };
      const first = await instance.agent.process('work', options);
      assert.ok(first.ok);
      assert.equal(first.value.stopReason, 'tool_calls');
      assert.equal(first.value.toolCalls?.length, 1);
      const firstId = first.value.toolCalls[0].id;
      assert.match(firstId, /^ext:[0-9a-f-]{36}:0$/);
      const second = await instance.agent.process('work', {
        ...options,
        externalResults: new Map([[firstId, 'OLD_RESULT']]),
      });
      assert.ok(second.ok);
      assert.equal(second.value.stopReason, 'tool_calls');
      assert.equal(second.value.toolCalls?.length, 1);
      const secondId = second.value.toolCalls[0].id;
      assert.match(secondId, /^ext:[0-9a-f-]{36}:0$/);
      assert.notEqual(secondId, firstId);
      assert.equal(inputs.length, 2);
      const stillPending = await instance.agent.process('work', {
        ...options,
        externalResults: new Map([[firstId, 'WRONG_OLD_RESULT']]),
      });
      assert.ok(stillPending.ok);
      assert.equal(stillPending.value.toolCalls?.[0].id, secondId);
      assert.equal(
        inputs.length,
        2,
        'an unmatched old ID cannot resume the executor',
      );
      const final = await instance.agent.process('work', {
        ...options,
        externalResults: new Map([
          [firstId, 'OLD_RESULT'],
          [secondId, 'NEW_RESULT'],
        ]),
      });
      assert.ok(final.ok);
      assert.equal(final.value.stopReason, 'stop');
      assert.equal(inputs.length, 3);
      const results = inputs[2].filter((message) => message.role === 'tool');
      assert.deepEqual(
        results.map((message) => message.content),
        ['OLD_RESULT', 'NEW_RESULT'],
      );
      assert.deepEqual(
        results.map((message) => message.tool_call_id),
        [firstId, secondId],
      );
    } finally {
      await instance.close();
    }
  });
}
