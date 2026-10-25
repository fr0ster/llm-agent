import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import {
  type IUsageRecorder,
  resetQuotaGates,
  staticApiKey,
  type UsageInput,
  WaitAsTold,
} from '@mcp-abap-adt/llm-agent';
import { OpenAIProvider } from '../openai-provider.js';

function setup() {
  const records: UsageInput[] = [];
  const usage: IUsageRecorder = {
    record: (r) => records.push(r),
    with: () => usage,
  };
  const provider = new OpenAIProvider({
    model: 'test',
    credential: staticApiKey('secret'),
    usage,
    whenThrottled: new WaitAsTold(),
  });
  return { provider, records, usage };
}
const messages = [{ role: 'user' as const, content: 'private prompt' }];
const response = {
  data: {
    choices: [{ message: { content: 'private result' } }],
    usage: {
      prompt_tokens: 5,
      completion_tokens: 3,
      prompt_tokens_details: { cached_tokens: 2 },
    },
  },
};

test('records exact usage, bound recorder, override and no content', async () => {
  const { provider, records } = setup();
  Object.defineProperty(provider.client, 'post', {
    value: async () => response,
  });
  await provider.chat(messages);
  assert.equal(records.length, 1);
  assert.equal(records[0].kind, 'llm.call');
  if (records[0].kind !== 'llm.call') throw new Error('wrong kind');
  assert.equal(records[0].inputTokens, 5);
  assert.equal(records[0].cachedInputTokens, 2);
  assert.equal(records[0].outputTokens, 3);
  assert.equal(records[0].tokensSource, 'provider');
  assert.doesNotMatch(JSON.stringify(records), /private|secret/);
  const override: UsageInput[] = [];
  const usage: IUsageRecorder = {
    record: (r) => override.push(r),
    with: () => usage,
  };
  await provider.chat(messages, undefined, { usage });
  assert.equal(records.length, 1);
  assert.equal(override.length, 1);
});

test('retry records each attempt for chat and early-close stream', async () => {
  for (const stream of [false, true]) {
    resetQuotaGates();
    const { provider, records } = setup();
    let attempts = 0;
    Object.defineProperty(provider.client, 'post', {
      value: async () => {
        if (attempts++ === 0)
          throw {
            response: { status: 429, headers: { 'retry-after': '0.001' } },
            status: 429,
          };
        return stream
          ? {
              data: Readable.from([
                'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n',
                'data: [DONE]\n\n',
              ]),
            }
          : response;
      },
    });
    if (stream) {
      for await (const _ of provider.streamChat(messages)) break;
    } else await provider.chat(messages);
    assert.equal(records.length, 2);
    assert.deepEqual(
      records.map((r) => r.outcome),
      ['error', stream ? 'aborted' : 'ok'],
    );
    const calls = records.filter((r) => r.kind === 'llm.call');
    assert.deepEqual(
      calls.map((r) => r.providerAttempt),
      [0, 1],
    );
    assert.equal(calls[0].operationId, calls[1].operationId);
    if (stream) assert.equal(calls[1].closedEarly, true);
  }
});

test('records returned errors, throws and aborts without leaking error messages', async () => {
  for (const mode of ['returned', 'throw', 'abort']) {
    const { provider, records } = setup();
    const controller = new AbortController();
    Object.defineProperty(provider.client, 'post', {
      value: async () => {
        if (mode === 'returned')
          return { data: { error: { message: 'private failure' } } };
        if (mode === 'abort') controller.abort();
        throw Object.assign(new Error('private failure'), { code: 'E_FAILED' });
      },
    });
    await assert.rejects(
      provider.chat(messages, undefined, { signal: controller.signal }),
    );
    assert.equal(records.length, 1);
    assert.equal(records[0].outcome, mode === 'abort' ? 'aborted' : 'error');
    assert.doesNotMatch(JSON.stringify(records), /private/);
  }
});

test('stream completion and stream error keep exact usage seen before yielding', async () => {
  for (const mode of ['ok', 'error', 'early']) {
    const { provider, records } = setup();
    Object.defineProperty(provider.client, 'post', {
      value: async () => ({
        data: (async function* () {
          yield Buffer.from(
            'data: {"choices":[{"delta":{"content":"hello"}}],"usage":{"prompt_tokens":5,"completion_tokens":3}}\n\n',
          );
          if (mode === 'error') throw new Error('private failure');
        })(),
      }),
    });
    const run = async () => {
      for await (const _ of provider.streamChat(messages)) {
        if (mode === 'early') break;
      }
    };
    if (mode === 'error') await assert.rejects(run());
    else await run();
    assert.equal(records.length, 1);
    const record = records[0];
    if (record.kind !== 'llm.call') throw new Error('wrong kind');
    assert.equal(record.inputTokens, 5);
    assert.equal(record.outputTokens, 3);
    assert.equal(record.outcome, mode === 'early' ? 'aborted' : mode);
    assert.ok(record.firstTokenMs !== undefined);
  }
});

test('stream returned errors and split usage events are recorded', async () => {
  for (const returnedError of [false, true]) {
    const { provider, records } = setup();
    Object.defineProperty(provider.client, 'post', {
      value: async () => ({
        data: (async function* () {
          yield Buffer.from(
            'data: {"choices":[],"usage":{"prompt_tokens":5,"prompt_tokens_details":{"cached_tokens":2}}}\n\n',
          );
          yield Buffer.from(
            'data: {"choices":[],"usage":{"completion_tokens":3}}\n\n',
          );
          if (returnedError)
            yield Buffer.from(
              'data: {"error":{"message":"private failure"}}\n\n',
            );
        })(),
      }),
    });
    for await (const _ of provider.streamChat(messages)) {
    }
    const record = records[0];
    if (record.kind !== 'llm.call') throw new Error('wrong kind');
    assert.equal(record.outcome, returnedError ? 'error' : 'ok');
    assert.equal(record.inputTokens, 5);
    assert.equal(record.outputTokens, 3);
    assert.equal(record.cachedInputTokens, 2);
    assert.doesNotMatch(JSON.stringify(records), /private/);
  }
});

test('construction recorder covers all three validation-shaped calls without a request recorder', async () => {
  const { provider, records } = setup();
  Object.defineProperty(provider.client, 'post', {
    value: async () => response,
  });
  // Initial builder validation, builder retry validation, and reconfiguration validation.
  for (let probe = 0; probe < 3; probe++)
    await provider.chat(messages, undefined, { maxTokens: 10 });
  assert.equal(records.length, 3);
  assert.deepEqual(
    records.map((r) => r.outcome),
    ['ok', 'ok', 'ok'],
  );
});

test('empty usage stays unknown and does not erase provider usage already received', async () => {
  const { provider, records } = setup();
  Object.defineProperty(provider.client, 'post', {
    configurable: true,
    value: async () => ({ data: { ...response.data, usage: {} } }),
  });
  await provider.chat(messages);
  assert.equal(
    records[0].kind === 'llm.call' && records[0].tokensSource,
    'unknown',
  );
  Object.defineProperty(provider.client, 'post', {
    value: async () => ({
      data: (async function* () {
        yield Buffer.from(
          'data: {"choices":[],"usage":{"prompt_tokens":5}}\n\n',
        );
        yield Buffer.from('data: {"choices":[],"usage":{}}\n\n');
      })(),
    }),
  });
  for await (const _ of provider.streamChat(messages)) {
  }
  const record = records[1];
  if (record.kind !== 'llm.call') throw new Error('wrong kind');
  assert.equal(record.tokensSource, 'provider');
  assert.equal(record.inputTokens, 5);
});

test('stream AbortError and Axios cancellation without a signal are aborted', async () => {
  for (const failure of [
    Object.assign(new Error('private'), { name: 'AbortError' }),
    Object.assign(new Error('private'), { code: 'ERR_CANCELED' }),
  ]) {
    const { provider, records } = setup();
    Object.defineProperty(provider.client, 'post', {
      value: async () => ({
        data: (async function* () {
          yield Buffer.from(
            'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n',
          );
          throw failure;
        })(),
      }),
    });
    await assert.rejects(async () => {
      for await (const _ of provider.streamChat(messages)) {
      }
    });
    assert.equal(records.length, 1);
    assert.equal(records[0].outcome, 'aborted');
  }
});
