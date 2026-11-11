import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  IClientAdapter,
  ILlm,
  IPlanningStrategy,
  Message,
  Plan,
} from '@mcp-abap-adt/llm-agent';
import { SmartAgentBuilder } from '../builder.js';
import { unwrapBuilderResult } from '../builder-types.js';
import { testCallOptions, testRequestAccess } from '../testing/index.js';

const output = '  Hello\r\n\u0441\u0432\u0456\u0442 \u{1F30D}\n\n';
const llm: ILlm = {
  async chat() {
    assert.fail('Coordinator must bypass the main LLM tool-loop');
  },
  async *streamChat() {
    yield assert.fail('Coordinator must bypass the main LLM tool-loop');
  },
};

for (const route of ['plan', 'direct', 'clarification'] as const) {
  for (const streaming of [false, true]) {
    for (const streamMode of ['full', 'final'] as const) {
      test(`coordinator client adapter: ${route}, streaming=${streaming}, mode=${streamMode}`, async () => {
        let detections = 0;
        let wraps = 0;
        let dispatches = 0;
        const adapter: IClientAdapter = {
          name: 'custom',
          detect(prompt) {
            detections++;
            return prompt.includes('custom client');
          },
          wrapResponse(content) {
            wraps++;
            return `[custom]${content}[/custom]`;
          },
        };
        const planning: IPlanningStrategy = {
          name: 'test-planning',
          async buildInitialPlan(): Promise<Plan> {
            return {
              source: route === 'direct' ? 'planner-llm' : 'manual',
              createdAt: 0,
              steps:
                route === 'plan'
                  ? [{ id: 'step-1', goal: 'Say hello', status: 'pending' }]
                  : [],
              clarification: route === 'clarification' ? output : undefined,
            };
          },
          shouldReplan: () => false,
          async rebuildPlan() {
            assert.fail('Replanning is not expected');
          },
        };
        const handle = unwrapBuilderResult(
          await new SmartAgentBuilder({
            skipModelValidation: true,
            agent: { streamMode, classificationEnabled: false },
          })
            .withRagAccess(testRequestAccess)
            .withMainLlm(llm)
            .withClientAdapter(adapter)
            .withCoordinator({
              planning,
              dispatch: {
                name: 'test-dispatch',
                async dispatch(step) {
                  dispatches++;
                  return { stepId: step.id, output, durationMs: 0, ok: true };
                },
              },
            })
            .build(),
        );
        try {
          const raw = route === 'plan' ? `### step-1\n${output}` : output;
          for (const matched of [false, true, false]) {
            const messages: Message[] = [
              {
                role: 'system',
                content: matched ? 'custom client' : 'ordinary client',
              },
              { role: 'user', content: 'Say hello' },
            ];
            const expected = matched ? `[custom]${raw}[/custom]` : raw;
            if (streaming) {
              const contents: string[] = [];
              const finishes: string[] = [];
              for await (const chunk of handle.agent.streamProcess(
                messages,
                testCallOptions(),
              )) {
                assert.ok(chunk.ok);
                if (!chunk.value.ephemeral && chunk.value.content)
                  contents.push(chunk.value.content);
                if (chunk.value.finishReason)
                  finishes.push(chunk.value.finishReason);
              }
              assert.deepEqual(contents, [expected]);
              assert.deepEqual(finishes, ['stop']);
            } else {
              const result = await handle.agent.process(
                messages,
                testCallOptions(),
              );
              assert.ok(result.ok);
              assert.equal(result.value.content, expected);
            }
          }
          assert.equal(detections, 3);
          assert.equal(wraps, 1);
          assert.equal(dispatches, route === 'clarification' ? 0 : 3);
        } finally {
          await handle.close();
        }
      });
    }
  }
}
