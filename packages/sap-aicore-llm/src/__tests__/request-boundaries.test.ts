import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IUsageRecorder, UsageInput } from '@mcp-abap-adt/llm-agent';
import { httpStatusOf, LlmError } from '@mcp-abap-adt/llm-agent';
import { SapCoreAIProvider } from '../sap-core-ai-provider.js';

for (const [source, fail] of [
  [
    'HTTP',
    (error: object) =>
      new Error('Request failed with status code 400.', {
        cause: { response: { status: 400, data: { error } } },
      }),
  ],
  [
    'SSE',
    (error: object) =>
      new Error('Error while iterating over SSE stream.', {
        cause: new Error(
          `Error received from the server.\n${JSON.stringify(error)}`,
        ),
      }),
  ],
] as const) {
  for (const [error, overflow] of [
    [{ code: 'context_length_exceeded' }, true],
    [
      { type: 'invalid_request_error', message: 'prompt is too long: 10 > 9' },
      true,
    ],
    [{ code: 'invalid_value', message: 'prompt is too long' }, false],
  ] as const) {
    test(`SAP SDK ${source} classifies the underlying ${JSON.stringify(error)}`, async () => {
      const provider = new SapCoreAIProvider({
        model: 'test',
        apiBaseUrl: 'https://example.invalid',
        credential: { kind: 'bearer', token: async () => 'test-token' },
      });
      Object.defineProperty(provider, 'createClient', {
        value: () => ({
          chatCompletion: async () => {
            throw fail(error);
          },
          stream: async () => ({
            stream: (async function* () {
              yield* [];
              throw fail(error);
            })(),
          }),
        }),
      });
      await assert.rejects(
        async () => {
          if (source === 'HTTP') {
            await provider.chat([]);
          } else {
            for await (const _ of provider.streamChat([])) {
              /* consume */
            }
          }
        },
        (failure) =>
          failure instanceof Error &&
          (overflow
            ? failure instanceof LlmError &&
              failure.code === 'MODEL_CONTEXT_EXCEEDED' &&
              httpStatusOf(failure) === 400
            : !(failure instanceof LlmError)),
      );
    });
  }
}

test('response processing errors count once; rejected credentials never count for chat or stream', async () => {
  const records: UsageInput[] = [];
  const usage: IUsageRecorder = {
    record: (r) => records.push(r),
    with: () => usage,
  };
  let rejectCredential = false;
  let rejectSetup = false;
  let requests = 0;
  const provider = new SapCoreAIProvider({
    model: 'test',
    usage,
    apiBaseUrl: 'https://example.invalid',
    credential: {
      kind: 'bearer' as const,
      token: async () => {
        if (rejectCredential) throw new Error('credential rejected');
        return 'secret';
      },
    },
  });
  Object.assign(provider, {
    createClient: () => {
      if (rejectSetup) throw new Error('setup rejected');
      return {
        chatCompletion: async () => {
          requests++;
          return {
            getContent: () => {
              throw new Error('unusable content');
            },
            getToolCalls: () => undefined,
          };
        },
      };
    },
  });
  await assert.rejects(provider.chat([]));
  assert.equal(requests, 1);
  assert.deepEqual(
    records.map((r) => r.outcome),
    ['error'],
  );
  records.length = 0;
  rejectCredential = true;
  await assert.rejects(provider.chat([]), /credential rejected/);
  await assert.rejects(async () => {
    for await (const _ of provider.streamChat([])) {
      /* consume */
    }
  }, /credential rejected/);
  assert.equal(requests, 1);
  assert.equal(records.length, 0);
  rejectCredential = false;
  rejectSetup = true;
  await assert.rejects(provider.chat([]), /setup rejected/);
  await assert.rejects(async () => {
    for await (const _ of provider.streamChat([])) {
      /* consume */
    }
  }, /setup rejected/);
  assert.equal(records.length, 0);
});
