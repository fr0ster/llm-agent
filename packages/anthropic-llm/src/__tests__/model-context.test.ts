import assert from 'node:assert/strict';
import { test } from 'node:test';
import { httpStatusOf, LlmError, staticApiKey } from '@mcp-abap-adt/llm-agent';
import { AxiosError } from 'axios';
import { AnthropicProvider } from '../anthropic-provider.js';

function makeProvider() {
  return new AnthropicProvider({
    model: 'test',
    maxTokens: 100,
    credential: staticApiKey('test-key'),
  });
}

async function consumeStream(stream: AsyncIterable<object>): Promise<void> {
  for await (const _ of stream) {
    /* consume */
  }
}

const overflow = {
  type: 'invalid_request_error',
  message: 'prompt is too long: 210000 tokens > 200000 maximum',
};

for (const contextExceeded of [true, false]) {
  test(`chat preserves ${contextExceeded ? 'overflow' : 'abort'} when the request is aborted during an HTTP 400`, async (t) => {
    const provider = makeProvider();
    const abort = new AbortController();
    const reason = new Error('Cancelled');
    t.mock.method(provider.client, 'post', async () => {
      abort.abort(reason);
      throw Object.assign(new AxiosError('Request rejected'), {
        response: {
          status: 400,
          data: {
            error: contextExceeded
              ? overflow
              : { ...overflow, message: 'Invalid max_tokens' },
          },
        },
      });
    });
    await assert.rejects(
      provider.chat([], undefined, { signal: abort.signal }),
      (error) =>
        contextExceeded
          ? error instanceof LlmError && error.code === 'MODEL_CONTEXT_EXCEEDED'
          : error === reason,
    );
  });
}

for (const stream of [false, true]) {
  for (const [status, error, expectedOverflow] of [
    [400, overflow, true],
    [400, { ...overflow, message: 'Invalid max_tokens' }, false],
    [400, { ...overflow, type: 'other_error' }, false],
    [413, overflow, false],
    [429, overflow, false],
  ] as const) {
    test(`HTTP ${status} ${error.type} "${error.message}" (stream=${stream})`, async (t) => {
      const provider = makeProvider();
      const body = { type: 'error', error };
      let attempts = 0;
      if (stream) {
        t.mock.method(globalThis, 'fetch', async () => {
          attempts++;
          return Response.json(body, { status });
        });
      } else {
        provider.client.defaults.adapter = async (config) => {
          attempts++;
          throw new AxiosError(
            'Request rejected',
            undefined,
            config,
            undefined,
            {
              config,
              status,
              statusText: 'Request rejected',
              headers: {},
              data: body,
            },
          );
        };
      }
      await assert.rejects(
        () =>
          stream ? consumeStream(provider.streamChat([])) : provider.chat([]),
        (failure) =>
          failure instanceof Error &&
          httpStatusOf(failure) === status &&
          failure.message.includes(error.message) &&
          (expectedOverflow
            ? failure instanceof LlmError &&
              failure.code === 'MODEL_CONTEXT_EXCEEDED'
            : !(failure instanceof LlmError)),
      );
      assert.equal(attempts, 1);
    });
  }
}

for (const error of [
  overflow,
  { ...overflow, message: 'Invalid max_tokens' },
]) {
  test(`SSE ${error.type} "${error.message}" preserves classification`, async (t) => {
    const provider = makeProvider();
    t.mock.method(
      globalThis,
      'fetch',
      async () =>
        new Response(
          `event: error\ndata: ${JSON.stringify({ type: 'error', error })}\n\n`,
        ),
    );
    await assert.rejects(
      () => consumeStream(provider.streamChat([])),
      (failure) =>
        failure instanceof Error &&
        failure.message.includes(error.message) &&
        (error === overflow
          ? failure instanceof LlmError &&
            failure.code === 'MODEL_CONTEXT_EXCEEDED' &&
            httpStatusOf(failure) === 400
          : !(failure instanceof LlmError) &&
            'code' in failure &&
            failure.code === error.type &&
            httpStatusOf(failure) === undefined),
    );
  });
}
