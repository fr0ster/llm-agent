import assert from 'node:assert/strict';
import { it } from 'node:test';
import {
  type IUsageRecorder,
  type Message,
  requestShape,
  resetQuotaGates,
  staticApiKey,
  type UsageInput,
  WaitAsTold,
} from '@mcp-abap-adt/llm-agent';
import { AnthropicProvider } from '../anthropic-provider.js';

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
  return new AnthropicProvider({
    credential: staticApiKey('secret'),
    model: 'claude',
    usage,
    whenThrottled: new WaitAsTold(),
  });
}
const start =
  'event: message_start\ndata: {"message":{"usage":{"input_tokens":17,"cache_read_input_tokens":4}}}\n\n';
const delta =
  'event: content_block_delta\ndata: {"delta":{"type":"text_delta","text":"hello"}}\n\n';
const end =
  'event: message_delta\ndata: {"usage":{"output_tokens":9},"delta":{"stop_reason":"end_turn"}}\n\n';
it('records exact usage and per-call override of a bound recorder', async () => {
  const records: Record[] = [];
  const overrides: Record[] = [];
  const p = create(recorder(records));
  p.client.post = (async () => ({
    data: {
      content: [{ type: 'text', text: 'answer' }],
      usage: { input_tokens: 5, output_tokens: 3, cache_read_input_tokens: 2 },
    },
  })) as typeof p.client.post;
  await p.chat([{ role: 'user', content: 'private prompt' }]);
  await p.chat([], undefined, { usage: recorder(overrides) });
  assert.equal(records.length, 1);
  assert.equal(overrides.length, 1);
  assert.equal(records[0].inputTokens, 5);
  assert.equal(records[0].outputTokens, 3);
  assert.equal(records[0].cachedInputTokens, 2);
  assert.ok(!JSON.stringify(records).includes('private prompt'));
});
it('records each physical throttle attempt', async () => {
  resetQuotaGates();
  const records: Record[] = [];
  const p = create(recorder(records));
  let calls = 0;
  p.client.post = (async () => {
    if (calls++ === 0)
      throw Object.assign(new Error('private body'), {
        status: 429,
        response: { status: 429, headers: { 'retry-after': '0.001' } },
      });
    return { data: { content: [] } };
  }) as typeof p.client.post;
  await p.chat([]);
  assert.deepEqual(
    records.map((r) => [r.providerAttempt, r.outcome]),
    [
      [0, 'error'],
      [1, 'ok'],
    ],
  );
  assert.equal(records[0].operationId, records[1].operationId);
  assert.equal(records[0].errorCode, '429');
});
it('accumulates message_start and message_delta counts on complete streams', async (t) => {
  const records: Record[] = [];
  const p = create(recorder(records));
  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response(start + delta + end),
  );
  for await (const _ of p.streamChat([])) {
    /* drain */
  }
  assert.equal(records.length, 1);
  assert.equal(records[0].outcome, 'ok');
  assert.equal(records[0].inputTokens, 17);
  assert.equal(records[0].outputTokens, 9);
  assert.equal(records[0].cachedInputTokens, 4);
  assert.equal(records[0].tokensSource, 'provider');
  assert.ok(records[0].firstTokenMs !== undefined);
});
it('keeps only known token counts on early close after message_start', async (t) => {
  const records: Record[] = [];
  const p = create(recorder(records));
  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response(start + delta + end),
  );
  for await (const _ of p.streamChat([])) {
    break;
  }
  assert.equal(records.length, 1);
  assert.equal(records[0].outcome, 'aborted');
  assert.equal(records[0].closedEarly, true);
  assert.equal(records[0].inputTokens, 17);
  assert.equal(records[0].outputTokens, undefined);
});
it('records a stream throttle and subsequent early close once each', async (t) => {
  resetQuotaGates();
  const records: Record[] = [];
  const p = create(recorder(records));
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () =>
    calls++ === 0
      ? new Response('', { status: 429, headers: { 'retry-after': '0.001' } })
      : new Response(start + end),
  );
  for await (const _ of p.streamChat([])) {
    break;
  }
  assert.deepEqual(
    records.map((r) => [r.providerAttempt, r.outcome]),
    [
      [0, 'error'],
      [1, 'aborted'],
    ],
  );
  assert.equal(records[1].closedEarly, true);
  assert.equal(records[0].errorCode, '429');
  assert.equal(records[0].operationId, records[1].operationId);
});
it('records stream error and partial provider counts without provider message text', async (t) => {
  const records: Record[] = [];
  const p = create(recorder(records));
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(
        start +
          'event: error\ndata: {"error":{"message":"sensitive message"}}\n\n',
      ),
  );
  await assert.rejects(async () => {
    for await (const _ of p.streamChat([])) {
      /* drain */
    }
  });
  assert.equal(records[0].outcome, 'error');
  assert.equal(records[0].inputTokens, 17);
  assert.ok(!JSON.stringify(records).includes('sensitive message'));
});
it('records thrown errors and in-flight aborts', async () => {
  for (const abort of [false, true]) {
    const records: Record[] = [];
    const p = create(recorder(records));
    const controller = new AbortController();
    p.client.post = (async () => {
      if (abort) controller.abort();
      throw Object.assign(new Error('sensitive message'), {
        code: abort ? 'ERR_CANCELED' : 'E_NETWORK',
      });
    }) as typeof p.client.post;
    await assert.rejects(p.chat([], undefined, { signal: controller.signal }));
    assert.equal(records.length, 1);
    assert.equal(records[0].outcome, abort ? 'aborted' : 'error');
    assert.equal(records[0].errorCode, abort ? 'ERR_CANCELED' : 'E_NETWORK');
  }
});
it('preserves response without a recorder', async () => {
  const p = create();
  p.client.post = (async () => ({
    data: { content: [{ type: 'text', text: 'answer' }] },
  })) as typeof p.client.post;
  assert.equal((await p.chat([])).content, 'answer');
});

it('records returned API error envelopes without copying provider messages', async () => {
  const records: Record[] = [];
  const p = create(recorder(records));
  p.client.post = (async () => ({
    data: {
      content: [],
      error: { type: 'overloaded_error', message: 'private provider body' },
    },
  })) as typeof p.client.post;
  await p.chat([]);
  assert.equal(records.length, 1);
  assert.equal(records[0].outcome, 'error');
  assert.equal(records[0].errorCode, 'overloaded_error');
  assert.ok(!JSON.stringify(records).includes('private provider body'));
});

it('treats an empty usage object as unknown token counts', async () => {
  const records: Record[] = [];
  const p = create(recorder(records));
  p.client.post = (async () => ({
    data: { content: [], usage: {} },
  })) as typeof p.client.post;
  await p.chat([]);
  assert.equal(records[0].tokensSource, 'unknown');
  assert.equal(records[0].inputTokens, undefined);
  assert.equal(records[0].outputTokens, undefined);
});

it('request shape matches captured payload on success, errors, retries and early close', async (t) => {
  for (const stream of [false, true]) {
    for (const mode of ['ok', 'error', 'retry', 'early']) {
      resetQuotaGates();
      const records: Record[] = [];
      const provider = create(recorder(records));
      const input: Message[] = [
        { role: 'system', content: 'first' },
        { role: 'system', content: 'second omitted only on Anthropic' },
        { role: 'user', content: 'question' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call',
              type: 'function',
              function: { name: 'lookup', arguments: '{}' },
            },
          ],
        },
        { role: 'tool', content: 'orphan' },
        { role: 'tool', content: 'result', tool_call_id: 'call' },
      ];
      const tools = [
        {
          type: 'function',
          function: { name: 'lookup', parameters: { type: 'object' } },
        },
      ];
      const payloads: Array<{
        messages: Message[];
        tools?: unknown[];
        system?: string;
      }> = [];
      let attempts = 0;
      const fail = () => {
        if (mode === 'error') throw new Error('transport failed');
        if (mode === 'retry' && attempts++ === 0)
          throw {
            status: 429,
            response: { status: 429, headers: { 'retry-after': '0.001' } },
          };
      };
      if (stream) {
        t.mock.method(
          globalThis,
          'fetch',
          async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
            payloads.push(JSON.parse(String(init?.body)));
            if (mode === 'retry' && attempts++ === 0)
              return new Response('', {
                status: 429,
                headers: { 'retry-after': '0.001' },
              });
            if (mode === 'error') throw new Error('transport failed');
            return new Response(start + delta + end);
          },
        );
      } else {
        provider.client.post = (async (
          _url: string,
          body: (typeof payloads)[number],
        ) => {
          payloads.push(body);
          fail();
          return { data: { content: [] } };
        }) as typeof provider.client.post;
      }
      let shapeComputations = 0;
      const stringify = JSON.stringify;
      const stringifySpy = t.mock.method(
        JSON,
        'stringify',
        (...args: Parameters<typeof JSON.stringify>) => {
          if (args[0] === tools) shapeComputations++;
          return stringify(...args);
        },
      );
      const run = async () => {
        if (stream) {
          for await (const _ of provider.streamChat(input, tools)) {
            if (mode === 'early') break;
          }
        } else await provider.chat(input, tools);
      };
      if (mode === 'error') await assert.rejects(run());
      else await run();
      stringifySpy.mock.restore();
      assert.equal(
        shapeComputations,
        1,
        'shape is computed once across all attempts',
      );
      assert.equal(records.length, mode === 'retry' ? 2 : 1);
      assert.equal(payloads.length, records.length);
      for (let i = 0; i < records.length; i++) {
        const payload = payloads[i];
        const sent = [
          ...(payload.system !== undefined
            ? [{ role: 'system' as const, content: payload.system }]
            : []),
          ...payload.messages,
        ];
        const expected = requestShape(sent, payload.tools);
        const record = records[i];
        if (record.kind !== 'llm.call') throw new Error('wrong kind');
        for (const key of Object.keys(expected) as Array<keyof typeof expected>)
          assert.equal(record[key], expected[key], key);
        assert.equal(record.inputMessages, 5);
        assert.equal(record.systemMessages, 1);
      }
      if (stream && mode === 'early') {
        const record = records[0];
        if (record.kind === 'llm.call') assert.equal(record.closedEarly, true);
      }
    }
  }
});
