import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  ILlm,
  LlmError,
  LlmResponse,
  LlmStreamChunk,
  LlmTool,
  Message,
  Result,
} from '@mcp-abap-adt/llm-agent';
import { SmartAgentBuilder } from '../builder.js';
import { unwrapBuilderResult } from '../builder-types.js';
import { DefaultPipeline } from '../pipeline/default-pipeline.js';
import {
  makeRag,
  testCallOptions,
  testRequestAccess,
} from '../testing/index.js';

function scenario() {
  let rounds = 0;
  let toolCalls = 0;
  const llm: ILlm = {
    async chat(): Promise<Result<LlmResponse, LlmError>> {
      throw new Error('The scenario uses streaming');
    },
    async *streamChat(
      _messages: Message[],
      tools?: LlmTool[],
    ): AsyncIterable<Result<LlmStreamChunk, LlmError>> {
      rounds++;
      if (rounds <= 12 && tools?.length) {
        yield {
          ok: true,
          value: {
            content: '',
            toolCalls: Array.from({ length: 3 }, (_, index) => ({
              index,
              id: `call-${rounds}-${index}`,
              name: tools[0].name,
              arguments: JSON.stringify({ round: rounds, index }),
            })),
            finishReason: 'tool_calls',
          },
        };
      } else {
        yield { ok: true, value: { content: 'done', finishReason: 'stop' } };
      }
    },
  };
  const client = {
    async listTools() {
      return {
        ok: true as const,
        value: [{ name: 'Work', description: 'Work', inputSchema: {} }],
      };
    },
    async callTool() {
      toolCalls++;
      return { ok: true as const, value: { content: 'completed' } };
    },
  };
  return { llm, client, rounds: () => rounds, toolCalls: () => toolCalls };
}

for (const pipeline of [false, true]) {
  for (const limit of ['default', 'iterations', 'tools'] as const) {
    test(`${pipeline ? 'standalone DefaultPipeline' : 'default build'}: ${limit} tool-loop limits`, async () => {
      const run = scenario();
      const toolsRag = makeRag([
        { text: 'Work', score: 1, metadata: { id: 'tool:Work' } },
      ]);
      const builder = new SmartAgentBuilder({ skipModelValidation: true })
        .withRagAccess(testRequestAccess)
        .withMainLlm(run.llm)
        .withMcpClients([run.client])
        .setToolsRag(toolsRag);
      if (limit === 'iterations') builder.withMaxIterations(10);
      if (limit === 'tools') builder.withMaxToolCalls(30);
      const handle = await builder.build().then(unwrapBuilderResult);
      try {
        const chunks: LlmStreamChunk[] = [];
        if (pipeline) {
          const standalone = new DefaultPipeline();
          standalone.initialize({
            mainLlm: run.llm,
            toolsRag,
            mcpClients: [run.client],
            ragAccess: testRequestAccess,
            ...(limit === 'default'
              ? {}
              : {
                  agentConfig: {
                    maxIterations: limit === 'iterations' ? 10 : Infinity,
                    ...(limit === 'tools' ? { maxToolCalls: 30 } : {}),
                  },
                }),
          });
          const result = await standalone.execute(
            'complete the work',
            [],
            testCallOptions(),
            (chunk) => {
              assert.equal(chunk.ok, true);
              if (chunk.ok) chunks.push(chunk.value);
            },
          );
          assert.equal(result.error, undefined);
        } else {
          assert.equal(
            handle.agent.getAgentConfig().maxIterations,
            limit === 'iterations' ? 10 : Infinity,
          );
          assert.equal(
            handle.agent.maxToolCalls,
            limit === 'tools' ? 30 : undefined,
          );
          for await (const chunk of handle.agent.streamProcess(
            'complete the work',
            testCallOptions(),
          )) {
            assert.equal(chunk.ok, true);
            if (chunk.ok) chunks.push(chunk.value);
          }
        }
        if (limit === 'default') {
          assert.equal(run.rounds(), 13);
          assert.equal(run.toolCalls(), 36);
          assert.ok(chunks.some((chunk) => chunk.content === 'done'));
          assert.ok(chunks.every((chunk) => !chunk.budgetExhausted));
        } else if (limit === 'iterations') {
          assert.equal(run.rounds(), 10);
          assert.equal(run.toolCalls(), 30);
          assert.equal(chunks.at(-1)?.finishReason, 'length');
        } else {
          assert.equal(run.rounds(), 11);
          assert.equal(run.toolCalls(), 30);
          const exhausted = chunks.find((chunk) => chunk.budgetExhausted);
          assert.ok(exhausted);
          assert.equal(exhausted.maxToolCalls, 30);
          assert.equal(exhausted.toolCallCount, 30);
        }
      } finally {
        await handle.close();
      }
    });
  }
}
