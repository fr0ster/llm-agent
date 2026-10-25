import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type IUsageRecorder,
  resetQuotaGates,
  type UsageInput,
  WaitAsTold,
} from '@mcp-abap-adt/llm-agent';
import { SapCoreAIProvider } from '../sap-core-ai-provider.js';

const messages = [{ role: 'user' as const, content: 'private prompt' }];
const tokenUsage = { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 };
const response = {
  getContent: () => 'private output',
  getFinishReason: () => 'stop',
  getToolCalls: () => undefined,
  getTokenUsage: () => tokenUsage,
};
function setup() {
  const records: UsageInput[] = [];
  const usage: IUsageRecorder = {
    record: (r) => records.push(r),
    with: () => usage,
  };
  const provider = new SapCoreAIProvider({
    model: 'test',
    apiBaseUrl: 'https://example.invalid',
    credential: { kind: 'bearer', token: async () => 'secret' },
    usage,
    whenThrottled: new WaitAsTold(),
  });
  return { provider, records };
}

test('SAP SDK chat records bound usage and per-call overrides without content', async () => {
  const { provider, records } = setup();
  Object.defineProperty(provider, 'createClient', {
    value: () => ({ chatCompletion: async () => response }),
  });
  await provider.chat(messages);
  const record = records[0];
  if (record.kind !== 'llm.call') throw new Error('wrong kind');
  assert.equal(record.inputTokens, 5);
  assert.equal(record.outputTokens, 3);
  assert.equal(record.granularity, 'request');
  assert.equal(record.retriesVisible, true);
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

test('SAP records each retry, including retries preceding early stream close', async () => {
  for (const stream of [false, true]) {
    resetQuotaGates();
    const { provider, records } = setup();
    let attempt = 0;
    const call = async () => {
      if (attempt++ === 0)
        throw {
          status: 429,
          response: { status: 429, headers: { 'retry-after': '0.001' } },
        };
      return stream
        ? {
            stream: (async function* () {
              yield {
                getDeltaContent: () => 'hello',
                getFinishReason: () => undefined,
                getTokenUsage: () => tokenUsage,
              };
            })(),
          }
        : response;
    };
    Object.defineProperty(provider, 'createClient', {
      value: () => ({ chatCompletion: call, stream: call }),
    });
    if (stream) {
      for await (const _ of provider.streamChat(messages)) break;
    } else await provider.chat(messages);
    assert.equal(records.length, 2);
    const calls = records.filter((r) => r.kind === 'llm.call');
    assert.deepEqual(
      calls.map((r) => r.providerAttempt),
      [0, 1],
    );
    assert.deepEqual(
      calls.map((r) => r.outcome),
      ['error', stream ? 'aborted' : 'ok'],
    );
    assert.equal(calls[0].operationId, calls[1].operationId);
    if (stream) {
      assert.equal(calls[1].closedEarly, true);
      assert.equal(calls[1].inputTokens, 5);
    }
  }
});

test('SAP stream completes and preserves known usage on stream failure', async () => {
  for (const failed of [false, true]) {
    const { provider, records } = setup();
    Object.defineProperty(provider, 'createClient', {
      value: () => ({
        stream: async () => ({
          stream: (async function* () {
            yield {
              getDeltaContent: () => 'hello',
              getFinishReason: () => 'stop',
              getTokenUsage: () => tokenUsage,
            };
            if (failed) throw new Error('private failure');
          })(),
        }),
      }),
    });
    const run = async () => {
      for await (const _ of provider.streamChat(messages)) {
      }
    };
    if (failed) await assert.rejects(run());
    else await run();
    assert.equal(records.length, 1);
    const record = records[0];
    if (record.kind !== 'llm.call') throw new Error('wrong kind');
    assert.equal(record.outcome, failed ? 'error' : 'ok');
    assert.equal(record.inputTokens, 5);
    assert.equal(record.outputTokens, 3);
    assert.ok(record.firstTokenMs !== undefined);
  }
});

test('SAP thrown errors and aborts are recorded with safe codes', async () => {
  for (const aborted of [false, true]) {
    const { provider, records } = setup();
    const controller = new AbortController();
    Object.defineProperty(provider, 'createClient', {
      value: () => ({
        chatCompletion: async () => {
          if (aborted) controller.abort();
          throw Object.assign(new Error('private error'), { code: 'E_SAP' });
        },
      }),
    });
    await assert.rejects(
      provider.chat(messages, undefined, { signal: controller.signal }),
    );
    assert.equal(records.length, 1);
    assert.equal(records[0].outcome, aborted ? 'aborted' : 'error');
    assert.equal(records[0].errorCode, 'E_SAP');
    assert.doesNotMatch(JSON.stringify(records), /private/);
  }
});

test('SAP returned SDK error envelopes are recorded without content', async () => {
  const { provider, records } = setup();
  Object.defineProperty(provider, 'createClient', {
    value: () => ({
      chatCompletion: async () => ({
        ...response,
        _data: { error: { message: 'private failure' } },
      }),
    }),
  });
  await provider.chat(messages);
  assert.equal(records[0].outcome, 'error');
  assert.doesNotMatch(JSON.stringify(records), /private/);
});

test('SAP empty usage stays unknown and preserves earlier counts in streams', async () => {
  const { provider, records } = setup();
  Object.defineProperty(provider, 'createClient', {
    configurable: true,
    value: () => ({
      chatCompletion: async () => ({ ...response, getTokenUsage: () => ({}) }),
    }),
  });
  await provider.chat(messages);
  assert.equal(
    records[0].kind === 'llm.call' && records[0].tokensSource,
    'unknown',
  );
  Object.defineProperty(provider, 'createClient', {
    value: () => ({
      stream: async () => ({
        stream: (async function* () {
          for (const usage of [{ prompt_tokens: 5 }, {}])
            yield {
              getDeltaContent: () => '',
              getFinishReason: () => undefined,
              getTokenUsage: () => usage,
            };
        })(),
      }),
    }),
  });
  for await (const _ of provider.streamChat(messages)) {
  }
  const record = records[1];
  if (record.kind !== 'llm.call') throw new Error('wrong kind');
  assert.equal(record.tokensSource, 'provider');
  assert.equal(record.inputTokens, 5);
});

test('SAP stream AbortError without a signal is aborted', async () => {
  const { provider, records } = setup();
  Object.defineProperty(provider, 'createClient', {
    value: () => ({
      stream: async () => ({
        stream: (async function* () {
          yield {
            getDeltaContent: () => 'hello',
            getFinishReason: () => undefined,
            getTokenUsage: () => undefined,
          };
          throw Object.assign(new Error('private'), { name: 'AbortError' });
        })(),
      }),
    }),
  });
  await assert.rejects(async () => {
    for await (const _ of provider.streamChat(messages)) {
    }
  });
  assert.equal(records.length, 1);
  assert.equal(records[0].outcome, 'aborted');
});

test('SAP explicitly disables SDK retry middleware for chat and streams', async () => {
  const { provider } = setup();
  const configs: unknown[] = [];
  Object.defineProperty(provider, 'createClient', {
    value: () => ({
      chatCompletion: async (_request: unknown, config: unknown) => {
        configs.push(config);
        return response;
      },
      stream: async (
        _request: unknown,
        _signal: unknown,
        _options: unknown,
        config: unknown,
      ) => {
        configs.push(config);
        return { stream: (async function* () {})() };
      },
    }),
  });
  await provider.chat(messages);
  for await (const _ of provider.streamChat(messages)) {
  }
  assert.equal(configs.length, 2);
  for (const config of configs)
    assert.deepEqual((config as { middleware: unknown[] }).middleware, []);
});
