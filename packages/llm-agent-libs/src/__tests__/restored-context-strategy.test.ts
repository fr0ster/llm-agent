import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  ILlm,
  Message,
  ToolLoopContextBase,
  ToolRound,
} from '@mcp-abap-adt/llm-agent';
import { SmartAgent } from '../agent.js';
import { LegacyAccumulateContextStrategy } from '../pipeline/context/tool-loop-context/index.js';
import { ToolLoopControlHistory } from '../pipeline/context/tool-loop-control-history.js';
import { DefaultPipeline } from '../pipeline/default-pipeline.js';
import {
  makeAssembler,
  makeClassifier,
  makeDefaultDeps,
  testCallOptions,
} from '../testing/index.js';

const persistedRound: ToolRound = {
  assistant: {
    role: 'assistant',
    content: 'PERSISTED_ASSISTANT',
    tool_calls: [
      {
        id: 'persisted-call',
        type: 'function',
        function: { name: 'Work', arguments: '{"previous":true}' },
      },
    ],
  },
  results: [
    {
      role: 'tool',
      tool_call_id: 'persisted-call',
      content: 'FULL_PERSISTED_RESULT_SENTINEL',
    },
  ],
};
const prefix: Message[] = [{ role: 'user', content: 'continue' }];

for (const pipeline of [false, true]) {
  for (const reprompt of [false, true]) {
    for (const tagged of [false, true]) {
      test(`restored strategy forms the first input and retains round order: pipeline=${pipeline}, reprompt=${reprompt}, tagged=${tagged}`, async () => {
        const persisted = new LegacyAccumulateContextStrategy();
        await persisted.record(
          tagged
            ? new ToolLoopControlHistory().record(persistedRound)
            : persistedRound,
        );
        const snapshot = persisted.snapshot();
        let formCalls = 0;
        let factoryCalls = 0;
        class RestoredStrategy extends LegacyAccumulateContextStrategy {
          override async form(base: ToolLoopContextBase): Promise<Message[]> {
            formCalls++;
            assert.deepEqual(base.prefix, prefix);
            assert.equal(base.queryText, 'continue');
            return super.form(base);
          }
        }
        const inputs: Message[][] = [];
        const llm: ILlm = {
          async chat() {
            throw new Error('Expected streaming');
          },
          async *streamChat(messages) {
            assert.ok(
              formCalls >= 1,
              'form() must precede the first model call',
            );
            inputs.push(structuredClone(messages));
            const iteration = inputs.length;
            assert.ok(iteration <= (reprompt ? 3 : 1));
            yield {
              ok: true,
              value:
                reprompt && iteration === 2
                  ? {
                      content: 'NEW_ASSISTANT',
                      toolCalls: [
                        {
                          index: 0,
                          id: 'new-call',
                          name: 'Work',
                          arguments: '{}',
                        },
                      ],
                      finishReason: 'tool_calls',
                    }
                  : {
                      content:
                        reprompt && iteration === 1 ? 'BAD_REPLY' : 'DONE',
                      finishReason: 'stop',
                    },
            };
          },
        };
        let executions = 0;
        const { deps } = makeDefaultDeps({
          classifier: makeClassifier([{ type: 'action', text: 'continue' }]),
          assembler: makeAssembler(prefix),
          mcpClients: [
            {
              async listTools() {
                return {
                  ok: true,
                  value: [
                    { name: 'Work', description: 'Work', inputSchema: {} },
                  ],
                };
              },
              async callTool() {
                executions++;
                return { ok: true, value: { content: 'NEW_RESULT' } };
              },
            },
          ],
          outputValidator: {
            async validate(content) {
              return {
                ok: true,
                value: { valid: content !== 'BAD_REPLY', reason: 'retry' },
              };
            },
          },
        });
        deps.mainLlm = llm;
        deps.toolLoopContextStrategyFactory = () => {
          factoryCalls++;
          const strategy = new RestoredStrategy();
          strategy.restore(snapshot);
          return strategy;
        };
        const config = { maxIterations: 3, refreshToolsPerIteration: false };
        if (pipeline) {
          const flow = new DefaultPipeline();
          flow.initialize({ ...deps, agentConfig: config });
          deps.pipeline = flow;
        }
        const result = await new SmartAgent(deps, config).process(
          'continue',
          testCallOptions(),
        );
        assert.ok(result.ok);
        assert.equal(result.value.content, 'DONE');
        assert.equal(factoryCalls, 1);
        assert.equal(inputs.length, reprompt ? 3 : 1);
        assert.equal(executions, reprompt ? 1 : 0);
        // origin/main forms prefix + the full restored assistant/tool pair.
        const restoredInput = [
          ...prefix,
          persistedRound.assistant,
          ...persistedRound.results,
        ];
        assert.deepEqual(inputs[0], restoredInput);
        for (const messages of inputs) {
          assert.deepEqual(
            messages.slice(0, restoredInput.length),
            restoredInput,
          );
          const calls = messages.flatMap((message) => message.tool_calls ?? []);
          assert.deepEqual(
            messages
              .filter((message) => message.role === 'tool')
              .map((message) => message.tool_call_id),
            calls.map((call) => call.id),
          );
          assert.equal(
            new Set(calls.map((call) => call.id)).size,
            calls.length,
          );
        }
        if (reprompt) {
          for (const messages of inputs.slice(1)) {
            assert.equal(messages[restoredInput.length]?.content, 'BAD_REPLY');
            assert.equal(messages[restoredInput.length + 1]?.role, 'user');
            assert.match(
              String(messages[restoredInput.length + 1]?.content),
              /rejected by validation/,
            );
          }
          assert.equal(
            inputs[2][restoredInput.length + 2]?.content,
            'NEW_ASSISTANT',
          );
          assert.equal(
            inputs[2][restoredInput.length + 3]?.content,
            'NEW_RESULT',
          );
        }
      });
    }
  }
}
