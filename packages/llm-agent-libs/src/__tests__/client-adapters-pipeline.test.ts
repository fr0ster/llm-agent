import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ClineClientAdapter,
  type IClientAdapter,
  type ILlm,
  type Message,
  NonStreamingLlmCallStrategy,
  StreamingLlmCallStrategy,
} from '@mcp-abap-adt/llm-agent';
import { SmartAgentBuilder } from '../builder.js';
import { unwrapBuilderResult } from '../builder-types.js';
import { testCallOptions, testRequestAccess } from '../testing/index.js';

const llm: ILlm = {
  async chat() {
    return {
      ok: true,
      value: { content: 'Hello world', finishReason: 'stop' },
    };
  },
  async *streamChat() {
    yield { ok: true, value: { content: 'Hello ' } };
    yield { ok: true, value: { content: 'world', finishReason: 'stop' } };
  },
};

for (const streaming of [false, true]) {
  for (const streamMode of ['full', 'final'] as const) {
    test(`pipeline adapters are request-local (streaming=${streaming}, mode=${streamMode})`, async () => {
      const cline = new ClineClientAdapter();
      let detections = 0;
      const custom: IClientAdapter = {
        name: 'custom',
        detect(prompt) {
          detections++;
          return prompt.includes('custom client');
        },
        wrapResponse: (content) => `[custom]${content}[/custom]`,
      };
      const handle = unwrapBuilderResult(
        await new SmartAgentBuilder({
          skipModelValidation: true,
          agent: { streamMode, classificationEnabled: false },
        })
          .withRagAccess(testRequestAccess)
          .withMainLlm(llm)
          .withLlmCallStrategy(
            streaming
              ? new StreamingLlmCallStrategy()
              : new NonStreamingLlmCallStrategy(),
          )
          .withClientAdapter(custom)
          .withClientAdapter(cline)
          .build(),
      );
      try {
        for (const [prompt, expected] of [
          ['You are Cline', cline.wrapResponse('Hello world')],
          ['ordinary client', 'Hello world'],
          ['custom client', '[custom]Hello world[/custom]'],
          ['ordinary client', 'Hello world'],
        ]) {
          const messages: Message[] = [
            { role: 'system', content: prompt },
            { role: 'user', content: 'Say hello' },
          ];
          const options = testCallOptions();
          if (streaming) {
            const contents: string[] = [];
            for await (const chunk of handle.agent.streamProcess(
              messages,
              options,
            )) {
              assert.ok(chunk.ok);
              if (chunk.value.content && !chunk.value.ephemeral)
                contents.push(chunk.value.content);
            }
            assert.equal(contents.join(''), expected);
            if (prompt === 'ordinary client' && streamMode === 'full') {
              assert.deepEqual(contents, ['Hello ', 'world']);
            }
          } else {
            const result = await handle.agent.process(messages, options);
            assert.ok(result.ok);
            assert.equal(result.value.content, expected);
          }
        }
        assert.equal(detections, 4);
      } finally {
        await handle.close();
      }
    });
  }
}
