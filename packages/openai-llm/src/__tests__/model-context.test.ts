import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { httpStatusOf, LlmError, staticApiKey } from '@mcp-abap-adt/llm-agent';
import { AxiosError } from 'axios';
import { OpenAIProvider } from '../openai-provider.js';

function makeProvider() {
  return new OpenAIProvider({
    model: 'test',
    credential: staticApiKey('test-key'),
  });
}

async function consumeStream(stream: AsyncIterable<object>): Promise<void> {
  for await (const _ of stream) {
    /* consume */
  }
}

const overflow = {
  code: 'context_length_exceeded',
  message: 'This model has a maximum context length.',
};

for (const stream of [false, true]) {
  for (const [status, code, expectedOverflow] of [
    [400, overflow.code, true],
    [400, 'invalid_value', false],
    [413, overflow.code, false],
    [429, overflow.code, false],
  ] as const) {
    test(`HTTP ${status} ${code} preserves classification (stream=${stream})`, async () => {
      const provider = makeProvider();
      let attempts = 0;
      provider.client.defaults.adapter = async (config) => {
        attempts++;
        const body = { error: { ...overflow, code } };
        throw new AxiosError('Request rejected', undefined, config, undefined, {
          config,
          status,
          statusText: 'Request rejected',
          headers: {},
          data: stream ? Readable.from([JSON.stringify(body)]) : body,
        });
      };

      await assert.rejects(
        () =>
          stream ? consumeStream(provider.streamChat([])) : provider.chat([]),
        (error) =>
          error instanceof Error &&
          httpStatusOf(error) === status &&
          (expectedOverflow
            ? error instanceof LlmError &&
              error.code === 'MODEL_CONTEXT_EXCEEDED'
            : !(error instanceof LlmError)),
      );
      assert.equal(attempts, 1);
    });
  }
}

for (const apiKey of [undefined, 'override-key']) {
  test(`SSE context overflow is typed (key override=${apiKey !== undefined})`, async () => {
    const provider = makeProvider();
    provider.client.defaults.adapter = async (config) => ({
      config,
      status: 200,
      statusText: 'OK',
      headers: {},
      data: Readable.from([`data: ${JSON.stringify({ error: overflow })}\n\n`]),
    });

    await assert.rejects(
      () => consumeStream(provider.streamChat([], undefined, { apiKey })),
      (error) =>
        error instanceof LlmError &&
        error.code === 'MODEL_CONTEXT_EXCEEDED' &&
        httpStatusOf(error) === 400 &&
        error.message.includes(overflow.message) === (apiKey === undefined),
    );
  });
}

test('getModels carries context length only when the endpoint reports it', async () => {
  const provider = makeProvider();
  provider.client.defaults.adapter = async (config) => ({
    config,
    status: 200,
    statusText: 'OK',
    headers: {},
    data: {
      data: [
        { id: 'compatible-model', context_length: 32768 },
        { id: 'official-model', owned_by: 'openai' },
      ],
    },
  });
  assert.deepEqual(
    (await provider.getModels()).map((model) => model.contextLength),
    [32768, undefined],
  );
});
