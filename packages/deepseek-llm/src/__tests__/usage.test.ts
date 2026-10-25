import assert from 'node:assert/strict';
import { it } from 'node:test';
import {
  type IUsageRecorder,
  resetQuotaGates,
  staticApiKey,
  type UsageInput,
  WaitAsTold,
} from '@mcp-abap-adt/llm-agent';
import { DeepSeekProvider } from '../deepseek-provider.js';

type Record = Extract<UsageInput, { kind: 'llm.call' }>;
function recorder(records: Record[]): IUsageRecorder {
  return {
    record(input) {
      if (input.kind === 'llm.call') records.push(input);
    },
    with() {
      return this;
    },
  };
}
function create(usage?: IUsageRecorder) {
  return new DeepSeekProvider({
    credential: staticApiKey('secret'),
    model: 'deepseek-chat',
    usage,
    whenThrottled: new WaitAsTold(),
  });
}
it('records exact usage, bound recorder and call override through inherited OpenAI requests', async () => {
  const records: Record[] = [];
  const overrides: Record[] = [];
  const p = create(recorder(records));
  p.client.post = (async () => ({
    data: {
      choices: [{ message: { content: 'answer' } }],
      usage: {
        prompt_tokens: 5,
        completion_tokens: 3,
        prompt_tokens_details: { cached_tokens: 2 },
      },
    },
  })) as typeof p.client.post;
  await p.chat([{ role: 'user', content: 'private prompt' }]);
  await p.chat([], undefined, { usage: recorder(overrides) });
  assert.equal(records.length, 1);
  assert.equal(overrides.length, 1);
  assert.equal(records[0].provider.toLowerCase(), 'deepseek');
  assert.equal(records[0].inputTokens, 5);
  assert.equal(records[0].outputTokens, 3);
  assert.equal(records[0].cachedInputTokens, 2);
  assert.equal(records[0].tokensSource, 'provider');
  assert.ok(!JSON.stringify(records).includes('private prompt'));
});
it('records a throttle retry and an early stream close exactly once per request', async (t) => {
  resetQuotaGates();
  const records: Record[] = [];
  const p = create(recorder(records));
  let calls = 0;
  t.mock.method(p.client, 'post', async () => {
    if (calls++ === 0)
      throw Object.assign(new Error('private error'), {
        status: 429,
        response: { status: 429, headers: { 'retry-after': '0.001' } },
      });
    return {
      data: (async function* () {
        yield Buffer.from(
          'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n',
        );
      })(),
    };
  });
  for await (const _ of p.streamChat([])) {
    break;
  }
  assert.equal(records.length, 2);
  assert.deepEqual(
    records.map((r) => [r.providerAttempt, r.outcome]),
    [
      [0, 'error'],
      [1, 'aborted'],
    ],
  );
  assert.equal(records[1].closedEarly, true);
  assert.equal(records[0].operationId, records[1].operationId);
  assert.equal(new Set(records.map((r) => r.physicalSeq)).size, 2);
});
it('records thrown failures and cancellation without leaking messages', async () => {
  for (const aborted of [false, true]) {
    const records: Record[] = [];
    const p = create(recorder(records));
    const controller = new AbortController();

    p.client.post = (async () => {
      if (aborted) controller.abort();
      throw Object.assign(new Error('sensitive provider message'), {
        code: aborted ? 'ERR_CANCELED' : 'E_NETWORK',
      });
    }) as typeof p.client.post;
    await assert.rejects(p.chat([], undefined, { signal: controller.signal }));
    assert.equal(records.length, 1);
    assert.equal(records[0].outcome, aborted ? 'aborted' : 'error');
    assert.ok(!JSON.stringify(records).includes('sensitive provider message'));
  }
});

it('records complete streams with exact counts and stream failures with partial counts', async () => {
  for (const fail of [false, true]) {
    const records: Record[] = [];
    const p = create(recorder(records));
    p.client.post = (async () => ({
      data: (async function* () {
        yield Buffer.from(
          'data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":2}}\n\n',
        );
        if (fail)
          throw Object.assign(new Error('private stream failure'), {
            code: 'E_STREAM',
          });
      })(),
    })) as typeof p.client.post;
    const drain = async () => {
      for await (const _ of p.streamChat([])) {
        /* drain */
      }
    };
    if (fail) await assert.rejects(drain());
    else await drain();
    assert.equal(records.length, 1);
    assert.equal(records[0].outcome, fail ? 'error' : 'ok');
    assert.equal(records[0].inputTokens, 7);
    assert.equal(records[0].outputTokens, 2);
    assert.equal(records[0].tokensSource, 'provider');
    assert.ok(!JSON.stringify(records).includes('private stream failure'));
  }
});
it('records a non-streaming throttle retry and preserves results without a recorder', async () => {
  resetQuotaGates();
  const records: Record[] = [];
  const p = create(recorder(records));
  let calls = 0;
  p.client.post = (async () => {
    if (calls++ === 0)
      throw Object.assign(new Error('private error'), {
        status: 429,
        response: { status: 429, headers: { 'retry-after': '0.001' } },
      });
    return { data: { choices: [{ message: { content: 'answer' } }] } };
  }) as typeof p.client.post;
  assert.equal((await p.chat([])).content, 'answer');
  assert.deepEqual(
    records.map((r) => [r.providerAttempt, r.outcome]),
    [
      [0, 'error'],
      [1, 'ok'],
    ],
  );
  const noRecorder = create();
  noRecorder.client.post = p.client.post;
  assert.equal((await noRecorder.chat([])).content, 'answer');
});

it('records returned error envelopes without provider content', async () => {
  const records: Record[] = [];
  const p = create(recorder(records));
  p.client.post = (async () => ({
    data: {
      choices: [{ message: { content: '' } }],
      error: { code: 'E_PROVIDER', message: 'private body' },
    },
  })) as typeof p.client.post;
  await p.chat([]);
  assert.equal(records.length, 1);
  assert.equal(records[0].outcome, 'error');
  assert.ok(!JSON.stringify(records).includes('private body'));
});
