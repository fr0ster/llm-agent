import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ILlm, Message } from '@mcp-abap-adt/llm-agent';
import { symmetricEmbedder } from '@mcp-abap-adt/llm-agent';
import { LlmAdapter } from '../../../../llm-agent-libs/src/adapters/llm-adapter.js';
import { testCallOptions } from '../../../../llm-agent-libs/src/testing/index.js';
import { makeSubagentClient } from '../../smart-agent/controller/subagent-client.js';
import { controllerPlugin, fakeControllerServerCtx } from './fixtures.js';

for (const name of ['controller', 'controller-weak']) {
  for (const finishReason of ['length', 'stop', 'tool_calls'] as const) {
    for (const external of [false, true]) {
      test(`${name}: ${finishReason} with malformed ${external ? 'external' : 'internal'} arguments never executes`, async () => {
        const inputs: Message[][] = [];
        const incomplete = '{"target":"incomplete';
        const tool = { name: 'Work', description: 'work', inputSchema: {} };
        const executor = new LlmAdapter({
          async callWithTools(messages) {
            inputs.push(structuredClone(messages));
            assert.ok(inputs.length <= 2);
            return {
              content: inputs.length === 1 ? 'PARTIAL' : 'DONE',
              raw: {
                choices: [
                  {
                    finish_reason: inputs.length === 1 ? finishReason : 'stop',
                    message: {
                      tool_calls:
                        inputs.length === 1
                          ? [
                              {
                                id: 'provider-id',
                                function: {
                                  name: tool.name,
                                  arguments: incomplete,
                                },
                              },
                              {
                                id: 'valid-sibling',
                                function: { name: tool.name, arguments: '{}' },
                              },
                            ]
                          : [],
                    },
                  },
                ],
              },
            };
          },
          streamWithTools() {
            assert.fail('chat expected');
          },
        });
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
            write: async (entry) => {
              void entry;
            },
            query: async () => [],
            list: async () => [],
            fingerprint: () => 'invalid-round',
          }),
          toolsRag: {
            query: async () => (external ? [] : [tool]),
            lookup: (toolName) =>
              !external && toolName === tool.name ? tool : undefined,
          },
          mcpClients: [
            {
              async listTools() {
                return { ok: true, value: external ? [] : [tool] };
              },
              async callTool() {
                assert.fail('malformed calls must never execute');
              },
            },
          ],
        });
        try {
          const result = await instance.agent.process('work', {
            ...testCallOptions(),
            externalTools: external ? [tool] : undefined,
          });
          assert.ok(result.ok);
          assert.equal(result.value.toolCalls?.length ?? 0, 0);
          assert.equal(inputs.length, finishReason === 'tool_calls' ? 2 : 1);
          if (finishReason === 'tool_calls') {
            const assistant = inputs[1].find(
              (message) => message.tool_calls?.length,
            );
            assert.equal(assistant?.content, 'PARTIAL');
            assert.equal(
              assistant?.tool_calls?.[0].function.arguments,
              incomplete,
            );
            const error = inputs[1].find((message) => message.role === 'tool');
            assert.equal(error?.tool_call_id, assistant?.tool_calls?.[0].id);
            assert.match(String(error?.content), /Invalid tool arguments/);
          }
        } finally {
          await instance.close();
        }
      });
    }
  }
}

for (const finishReason of ['length', 'stop'] as const) {
  test(`controller subagent retains partial text after ${finishReason} without routing calls`, async () => {
    const llm: ILlm = {
      async chat() {
        return {
          ok: true,
          value: {
            content: 'PARTIAL',
            finishReason,
            toolCalls: [
              {
                id: 'partial',
                name: 'Work',
                arguments: {},
                rawArguments: '{"target":"incomplete',
              },
            ],
          },
        };
      },
      async *streamChat() {},
    };
    assert.deepEqual(await makeSubagentClient(llm).send([]), {
      kind: 'content',
      content: 'PARTIAL',
    });
  });
}
