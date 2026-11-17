import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ILlm, IMcpClient, Message } from '@mcp-abap-adt/llm-agent';
import { NoopToolCache } from '@mcp-abap-adt/llm-agent';
import { SmartAgent } from '../agent.js';
import { SmartAgentBuilder } from '../builder.js';
import { unwrapBuilderResult } from '../builder-types.js';
import { DefaultPipeline } from '../pipeline/default-pipeline.js';
import {
  makeAssembler,
  makeDefaultDeps,
  testCallOptions,
  testRequestAccess,
} from '../testing/index.js';

import { assertUniqueToolHistory } from './tool-history-assertions.js';

for (const path of ['direct', 'pipeline', 'builder'] as const) {
  test(`${path}: default sends all six assistant messages, arguments and results to the model`, async () => {
    const inputs: Message[][] = [];
    const llm: ILlm = {
      async chat() {
        throw new Error('Expected streaming');
      },
      async *streamChat(messages) {
        inputs.push(structuredClone(messages));
        const round = inputs.length;
        assert.ok(round <= 7);
        yield {
          ok: true,
          value:
            round <= 6
              ? {
                  content: `ASSISTANT-${round}`,
                  toolCalls: [
                    {
                      index: 0,
                      id: `call-${round}`,
                      name: 'Work',
                      arguments: JSON.stringify({ round }),
                    },
                  ],
                  finishReason: 'tool_calls',
                }
              : { content: 'DONE', finishReason: 'stop' },
        };
      },
    };
    let executions = 0;
    const client: IMcpClient = {
      async listTools() {
        return {
          ok: true,
          value: [{ name: 'Work', description: 'Work', inputSchema: {} }],
        };
      },
      async callTool() {
        return { ok: true, value: { content: `RESULT-${++executions}` } };
      },
    };
    const config = { refreshToolsPerIteration: false };
    const { deps } = makeDefaultDeps({
      assembler: makeAssembler([{ role: 'user', content: 'go' }]),
      mcpClients: [client],
    });
    deps.mainLlm = llm;
    deps.toolCache = new NoopToolCache();
    if (path === 'pipeline') {
      const pipeline = new DefaultPipeline();
      pipeline.initialize({ ...deps, agentConfig: config });
      deps.pipeline = pipeline;
    }
    const handle =
      path === 'builder'
        ? await new SmartAgentBuilder({
            skipModelValidation: true,
            agent: config,
          })
            .withRagAccess(testRequestAccess)
            .withMainLlm(llm)
            .withMcpClients([client])
            .withToolCache(new NoopToolCache())
            .build()
            .then(unwrapBuilderResult)
        : undefined;
    try {
      const result = await (
        handle?.agent ?? new SmartAgent(deps, config)
      ).process('go', testCallOptions());
      assert.ok(result.ok);
      assert.equal(inputs.length, 7);
      assert.equal(executions, 6);
      for (let iteration = 1; iteration <= 6; iteration++) {
        const history = inputs[iteration].filter(
          (message) => message.role === 'tool' || message.tool_calls?.length,
        );
        assertUniqueToolHistory(history);
        const expected: Message[] = [];
        for (let round = 1; round <= iteration; round++) {
          const id = history[(round - 1) * 2].tool_calls?.[0].id;
          assert.ok(id);
          expected.push(
            {
              role: 'assistant',
              content: `ASSISTANT-${round}`,
              tool_calls: [
                {
                  id,
                  type: 'function',
                  function: {
                    name: 'Work',
                    arguments: JSON.stringify({ round }),
                  },
                },
              ],
            },
            {
              role: 'tool',
              tool_call_id: id,
              content: `RESULT-${round}`,
            },
          );
        }
        assert.deepEqual(history, expected);
      }
    } finally {
      await handle?.close();
    }
  });
}
