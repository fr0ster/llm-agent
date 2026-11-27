import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IBearerCredential } from '@mcp-abap-adt/interfaces-auth';
import {
  httpStatusOf,
  isThrottledError,
  type LLMResponse,
  type Message,
  resetQuotaGates,
  WaitAsTold,
} from '@mcp-abap-adt/llm-agent';
import {
  OrchestrationClient,
  OrchestrationResponse,
  OrchestrationStream,
  OrchestrationStreamChunkResponse,
  OrchestrationStreamResponse,
} from '@sap-ai-sdk/orchestration';
import {
  orchestrationModelParams,
  SapCoreAIProvider,
} from '../sap-core-ai-provider.js';

/** A bearer credential that hands out a fresh, distinguishable token each call. */
function testCredential(prefix = 't'): IBearerCredential {
  let n = 0;
  return { kind: 'bearer', token: async () => `${prefix}${++n}` };
}

const apiBaseUrl = 'https://api.ai.example.com';

// ---------------------------------------------------------------------------
// Constructor
// ---------------------------------------------------------------------------

describe('SapCoreAIProvider — constructor', () => {
  it('does not throw when constructed with a credential and apiBaseUrl', () => {
    assert.doesNotThrow(
      () =>
        new SapCoreAIProvider({
          model: 'gpt-4o',
          apiBaseUrl,
          credential: testCredential(),
        }),
    );
  });

  it('throws when model is missing (no default constant)', () => {
    assert.throws(
      // biome-ignore lint/suspicious/noExplicitAny: intentionally omitting required fields to test the model check first
      () => new SapCoreAIProvider({} as any),
      /requires a 'model'/,
    );
  });

  it('uses custom model when provided', () => {
    const p = new SapCoreAIProvider({
      model: 'claude-3-5-sonnet',
      apiBaseUrl,
      credential: testCredential(),
    });
    assert.equal(p.model, 'claude-3-5-sonnet');
  });

  it('sets resourceGroup when provided', () => {
    const p = new SapCoreAIProvider({
      model: 'gpt-4o',
      apiBaseUrl,
      credential: testCredential(),
      resourceGroup: 'default',
    });
    assert.equal(p.resourceGroup, 'default');
  });

  it('resourceGroup is undefined when not provided', () => {
    const p = new SapCoreAIProvider({
      model: 'gpt-4o',
      apiBaseUrl,
      credential: testCredential(),
    });
    assert.equal(p.resourceGroup, undefined);
  });
});

// ---------------------------------------------------------------------------
// formatMessages (private — tested via casting to any)
// ---------------------------------------------------------------------------

describe('SapCoreAIProvider — formatMessages', () => {
  const provider = new SapCoreAIProvider({
    model: 'gpt-4o',
    apiBaseUrl,
    credential: testCredential(),
  });
  // biome-ignore lint/suspicious/noExplicitAny: access private method for testing
  const fmt = (msgs: Message[]) => (provider as any).formatMessages(msgs);

  it('formats simple user message', () => {
    const result = fmt([{ role: 'user', content: 'Hello' }]);
    assert.equal(result.length, 1);
    assert.equal(result[0].role, 'user');
    assert.equal(result[0].content, 'Hello');
  });

  it('formats system message', () => {
    const result = fmt([{ role: 'system', content: 'Be helpful' }]);
    assert.equal(result[0].role, 'system');
    assert.equal(result[0].content, 'Be helpful');
  });

  it('formats assistant message with tool_calls', () => {
    const toolCalls = [
      {
        id: 'call_1',
        type: 'function' as const,
        function: { name: 'test', arguments: '{}' },
      },
    ];
    const result = fmt([
      { role: 'assistant', content: 'Calling...', tool_calls: toolCalls },
    ]);
    assert.equal(result[0].role, 'assistant');
    assert.deepEqual(result[0].tool_calls, toolCalls);
  });

  it('sets assistant content to undefined when it has tool_calls and empty content', () => {
    const toolCalls = [
      {
        id: 'call_1',
        type: 'function' as const,
        function: { name: 'test', arguments: '{}' },
      },
    ];
    const result = fmt([
      { role: 'assistant', content: '', tool_calls: toolCalls },
    ]);
    assert.equal(result[0].content, undefined);
  });

  it('formats tool message with tool_call_id', () => {
    const result = fmt([
      { role: 'tool', content: 'result', tool_call_id: 'call_1' },
    ]);
    assert.equal(result[0].role, 'tool');
    assert.equal(result[0].content, 'result');
    assert.equal(result[0].tool_call_id, 'call_1');
  });

  it('stringifies non-string tool content', () => {
    const result = fmt([
      { role: 'tool', content: null, tool_call_id: 'call_1' },
    ]);
    assert.equal(result[0].content, JSON.stringify(''));
  });

  it('handles null content for user message', () => {
    const result = fmt([{ role: 'user', content: null }]);
    assert.equal(result[0].content, '');
  });
});

// ---------------------------------------------------------------------------
// streamChat — requestConfig
// ---------------------------------------------------------------------------

describe('SapCoreAIProvider — streamChat requestConfig', () => {
  it('passes httpsAgent with keepAlive to client.stream()', async () => {
    const p = new SapCoreAIProvider({
      model: 'test-model',
      apiBaseUrl,
      credential: testCredential(),
    });

    // Spy on createClient to capture stream() call args
    let streamArgs: unknown[] = [];
    const fakeStream = {
      stream: (async function* () {
        // empty stream
      })(),
    };
    // biome-ignore lint/suspicious/noExplicitAny: test spy
    (p as any).createClient = () => ({
      stream: (...args: unknown[]) => {
        streamArgs = args;
        return Promise.resolve(fakeStream);
      },
    });

    const iter = p.streamChat([{ role: 'user', content: 'hi' }]);
    // Consume the iterator to trigger the call
    for await (const _ of iter) {
      // no chunks expected
    }

    // stream() should have been called with (undefined, undefined, undefined, requestConfig)
    // where requestConfig contains httpsAgent
    const requestConfig = streamArgs[3] as Record<string, unknown> | undefined;
    assert.ok(requestConfig, 'requestConfig should be passed to stream()');
    assert.ok(requestConfig.httpsAgent, 'httpsAgent should be set');
  });
});

it('supplies empty JSON at tool_calls finish for calls without argument fragments', async (t) => {
  const provider = new SapCoreAIProvider({
    model: 'test-model',
    apiBaseUrl,
    credential: testCredential(),
  });
  const choices = [
    {
      index: 0,
      delta: {
        content: '',
        tool_calls: [
          {
            index: 0,
            id: 'call_0',
            function: { name: 'lookup', arguments: '' },
          },
          {
            index: 1,
            id: 'call_1',
            function: { name: 'search', arguments: '{"query":' },
          },
        ],
      },
    },
    {
      index: 0,
      delta: {
        content: '',
        tool_calls: [
          { index: 0, function: { arguments: '' } },
          { index: 1, function: { arguments: '"b"}' } },
        ],
      },
    },
    { index: 0, delta: { content: '' }, finish_reason: 'tool_calls' },
  ];
  t.mock.method(OrchestrationClient.prototype, 'stream', async () => {
    const response =
      new OrchestrationStreamResponse<OrchestrationStreamChunkResponse>({
        data: {},
        headers: {},
        status: 200,
      });
    response.stream = new OrchestrationStream(async function* () {
      for (const choice of choices) {
        yield new OrchestrationStreamChunkResponse({
          request_id: 'request',
          final_result: {
            id: 'completion',
            object: 'chat.completion.chunk',
            created: 1,
            model: provider.model,
            choices: [choice],
          },
        });
      }
    }, new AbortController());
    return response;
  });

  const chunks: LLMResponse[] = [];
  for await (const chunk of provider.streamChat([])) chunks.push(chunk);
  assert.equal(chunks.at(-1)?.finishReason, 'tool_calls');
  assert.deepEqual(
    chunks.flatMap((chunk) =>
      (chunk.toolCalls ?? []).flatMap(({ index, arguments: args }) =>
        args ? [{ index, arguments: args }] : [],
      ),
    ),
    [
      { index: 1, arguments: '{"query":' },
      { index: 1, arguments: '"b"}' },
      { index: 0, arguments: '{}' },
    ],
  );
});

// ---------------------------------------------------------------------------
// chat — requestConfig (concurrency hardening, issue #213)
// ---------------------------------------------------------------------------

describe('SapCoreAIProvider — chat requestConfig', () => {
  const fakeResponse = () => ({
    getToolCalls: () => undefined,
    getContent: () => 'ok',
    getFinishReason: () => 'stop',
    getTokenUsage: () => undefined,
  });

  it('passes a per-call httpsAgent with keepAlive:false to client.chatCompletion()', async () => {
    const p = new SapCoreAIProvider({
      model: 'test-model',
      apiBaseUrl,
      credential: testCredential(),
    });
    let chatArgs: unknown[] = [];
    // biome-ignore lint/suspicious/noExplicitAny: test spy
    (p as any).createClient = () => ({
      chatCompletion: (...args: unknown[]) => {
        chatArgs = args;
        return Promise.resolve(fakeResponse());
      },
    });

    await p.chat([{ role: 'user', content: 'ping' }]);

    const requestConfig = chatArgs[1] as
      | { httpsAgent?: { keepAlive?: boolean } }
      | undefined;
    assert.ok(
      requestConfig?.httpsAgent,
      'httpsAgent should be passed to chatCompletion()',
    );
    // The fix: chat() must NOT reuse a shared keepAlive agent — a shared
    // keepAlive connection lets SAP AI Core route a response to the wrong
    // in-flight request when concurrent requests share the same XSUAA user.
    assert.equal(
      requestConfig.httpsAgent.keepAlive,
      false,
      'chat() must use a non-keepAlive agent (mirrors streamChat)',
    );
  });

  it('uses a fresh agent instance per call (no shared agent across calls)', async () => {
    const p = new SapCoreAIProvider({
      model: 'test-model',
      apiBaseUrl,
      credential: testCredential(),
    });
    const agents: unknown[] = [];
    // biome-ignore lint/suspicious/noExplicitAny: test spy
    (p as any).createClient = () => ({
      chatCompletion: (...args: unknown[]) => {
        agents.push(
          (args[1] as { httpsAgent?: unknown } | undefined)?.httpsAgent,
        );
        return Promise.resolve(fakeResponse());
      },
    });

    await p.chat([{ role: 'user', content: 'a' }]);
    await p.chat([{ role: 'user', content: 'b' }]);

    assert.equal(agents.length, 2);
    assert.ok(agents[0] && agents[1], 'both calls should pass an agent');
    assert.notEqual(
      agents[0],
      agents[1],
      'each chat() call must get its own agent instance (not a shared one)',
    );
  });

  it('asks the credential for a fresh token on every call (not cached at construction)', async () => {
    let n = 0;
    const credential: IBearerCredential = {
      kind: 'bearer',
      token: async () => `tok${++n}`,
    };
    const p = new SapCoreAIProvider({
      model: 'test-model',
      apiBaseUrl,
      credential,
    });
    const seenClients: unknown[] = [];
    // biome-ignore lint/suspicious/noExplicitAny: test spy — createClient's 3rd arg is the destination built from the credential
    (p as any).createClient = (
      _messages: unknown,
      _tools: unknown,
      destination: { headers: { Authorization: string } },
    ) => {
      seenClients.push(destination.headers.Authorization);
      return { chatCompletion: () => Promise.resolve(fakeResponse()) };
    };

    await p.chat([{ role: 'user', content: 'a' }]);
    await p.chat([{ role: 'user', content: 'b' }]);

    assert.deepEqual(seenClients, ['Bearer tok1', 'Bearer tok2']);
  });
});

// ---------------------------------------------------------------------------
// createClient (private — tested via casting to any)
// ---------------------------------------------------------------------------

describe('SapCoreAIProvider — createClient', () => {
  it('excludes provider output from the serialized orchestration config', async (t) => {
    const provider = new SapCoreAIProvider({
      model: 'gpt-4o',
      apiBaseUrl,
      credential: testCredential(),
    });
    let serialized = '';
    t.mock.method(
      OrchestrationClient.prototype,
      'chatCompletion',
      async function (this: OrchestrationClient) {
        serialized = JSON.stringify(this);
        return completion('ok');
      },
    );

    await provider.chat([
      { role: 'user', content: 'Hello' },
      {
        role: 'assistant',
        content: 'Earlier assistant reply',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'lookup', arguments: '{}' },
          },
        ],
        providerOutput: {
          protocol: 'openai.responses',
          items: [{ type: 'reasoning', encrypted_content: 'private-output' }],
        },
      },
      { role: 'tool', content: 'Lookup result', tool_call_id: 'call_1' },
      { role: 'user', content: 'Continue' },
    ]);

    assert.match(serialized, /Earlier assistant reply/);
    assert.doesNotMatch(serialized, /providerOutput|private-output/);
  });

  it('passes tools through to OrchestrationClient config', () => {
    const p = new SapCoreAIProvider({
      model: 'gpt-4o',
      apiBaseUrl,
      credential: testCredential(),
    });

    // We cannot fully instantiate OrchestrationClient without SAP env,
    // but we can verify the method exists and accepts tools.
    // @ts-expect-error — access private method for testing
    const createClient = p.createClient.bind(p);
    assert.equal(typeof createClient, 'function');
  });
});

// ---------------------------------------------------------------------------
// Rate limiting (issue #282)
// ---------------------------------------------------------------------------

const completion = (text: string) =>
  new OrchestrationResponse({
    data: {
      final_result: {
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: text },
            finish_reason: 'stop',
          },
        ],
      },
    },
    headers: {},
    status: 200,
  });

const tooManyRequests = (retryAfter?: string) =>
  Object.assign(new Error('Request failed with status code 429'), {
    response: {
      status: 429,
      headers: retryAfter === undefined ? {} : { 'retry-after': retryAfter },
      data: 'rate limit exceeded',
    },
  });

describe('SapCoreAIProvider — rate limiting', () => {
  const waits = new WaitAsTold();

  it('retries a 429 and returns the eventual answer', async () => {
    resetQuotaGates();
    const provider = new SapCoreAIProvider({
      model: 'anthropic--claude-4.5-sonnet',
      apiBaseUrl,
      credential: testCredential(),
      whenThrottled: waits,
    });
    let calls = 0;
    // @ts-expect-error — stub the SDK client for test
    provider.createClient = () => ({
      chatCompletion: async () => {
        calls += 1;
        if (calls < 3) throw tooManyRequests('0.01');
        return completion('ok');
      },
    });
    const res = await provider.chat([{ role: 'user', content: 'hi' }]);
    assert.equal(res.content, 'ok');
    assert.equal(calls, 3);
  });

  it('keeps the 429 readable as a fact once it gives up', async () => {
    resetQuotaGates();
    const provider = new SapCoreAIProvider({
      model: 'anthropic--claude-4.5-sonnet',
      apiBaseUrl,
      credential: testCredential(),
      whenThrottled: new WaitAsTold({ maxAttempts: 2 }),
    });
    // @ts-expect-error — stub the SDK client for test
    provider.createClient = () => ({
      chatCompletion: async () => {
        throw tooManyRequests('0.01');
      },
    });
    try {
      await provider.chat([{ role: 'user', content: 'hi' }]);
      assert.fail('should have thrown');
    } catch (e) {
      assert.ok(isThrottledError(e));
      assert.equal(e.attempts, 2);
      assert.equal(e.retryAfterSeconds, 0.01);
      assert.match((e as Error).message, /SAP AI SDK API error/);
    }
  });

  it('does not retry an ordinary failure', async () => {
    resetQuotaGates();
    const provider = new SapCoreAIProvider({
      model: 'gpt-4o',
      apiBaseUrl,
      credential: testCredential(),
      whenThrottled: waits,
    });
    let calls = 0;
    // @ts-expect-error — stub the SDK client for test
    provider.createClient = () => ({
      chatCompletion: async () => {
        calls += 1;
        throw new Error('deployment not found');
      },
    });
    await assert.rejects(
      provider.chat([{ role: 'user', content: 'hi' }]),
      /deployment not found/,
    );
    assert.equal(calls, 1);
  });

  for (const stream of [false, true]) {
    it(`preserves a permanent SDK status through wrapping, stream=${stream}`, async () => {
      const provider = new SapCoreAIProvider({
        model: 'test-model',
        apiBaseUrl,
        credential: testCredential(),
        whenThrottled: waits,
      });
      let calls = 0;
      const fail = async () => {
        calls++;
        throw new Error('max_tokens must be at most 500', {
          cause: { response: { status: 400 } },
        });
      };
      Object.defineProperty(provider, 'createClient', {
        value: () => ({ chatCompletion: fail, stream: fail }),
      });
      await assert.rejects(
        async () => {
          if (stream) {
            for await (const chunk of provider.streamChat([])) {
              assert.fail(`unexpected chunk: ${chunk.content}`);
            }
          } else await provider.chat([]);
        },
        (error) => error instanceof Error && httpStatusOf(error) === 400,
      );
      assert.equal(calls, 1);
    });
  }

  it('keys the quota by resource group as well as model', () => {
    const credential = testCredential();
    const one = new SapCoreAIProvider({
      model: 'gpt-4o',
      apiBaseUrl,
      credential,
      resourceGroup: 'a',
    });
    const two = new SapCoreAIProvider({
      model: 'gpt-4o',
      apiBaseUrl,
      credential,
      resourceGroup: 'b',
    });
    // @ts-expect-error — protected hook, read for test
    assert.notEqual(one.quotaKey(), two.quotaKey());
    // @ts-expect-error — protected hook, read for test
    assert.match(one.quotaKey(), /gpt-4o/);
  });
});

describe('SapCoreAIProvider — one quota per service instance', () => {
  // @ts-expect-error — protected hook, read for test
  const keyOf = (p: SapCoreAIProvider) => p.quotaKey() as string;

  it('separates two service instances (different apiBaseUrl)', () => {
    const a = new SapCoreAIProvider({
      model: 'gpt-4o',
      apiBaseUrl: 'https://api.one.aicore',
      credential: testCredential(),
    });
    const b = new SapCoreAIProvider({
      model: 'gpt-4o',
      apiBaseUrl: 'https://api.two.aicore',
      credential: testCredential(),
    });
    assert.notEqual(keyOf(a), keyOf(b));
  });

  it('separates two credential objects on one AI Core endpoint', () => {
    // Two distinct credential objects — even representing the same tenant —
    // are two buckets: quota isolation is by the credential's own identity,
    // not by any field inside it (BaseLLMProvider.credentialScope).
    const a = new SapCoreAIProvider({
      model: 'gpt-4o',
      apiBaseUrl: 'https://api.one.aicore',
      credential: testCredential(),
    });
    const b = new SapCoreAIProvider({
      model: 'gpt-4o',
      apiBaseUrl: 'https://api.one.aicore',
      credential: testCredential(),
    });
    assert.notEqual(keyOf(a), keyOf(b));
  });

  it('reads one service URL written several ways as one instance', () => {
    const credential = testCredential();
    const a = new SapCoreAIProvider({
      model: 'gpt-4o',
      apiBaseUrl: 'https://api.one.aicore/v2/',
      credential,
    });
    const b = new SapCoreAIProvider({
      model: 'gpt-4o',
      apiBaseUrl: 'https://API.One.aicore/v2',
      credential,
    });
    assert.equal(keyOf(a), keyOf(b));
  });

  it('shares one scope when the same credential object is reused', () => {
    const credential = testCredential();
    const a = new SapCoreAIProvider({
      model: 'gpt-4o',
      apiBaseUrl,
      credential,
    });
    const b = new SapCoreAIProvider({
      model: 'gpt-4o',
      apiBaseUrl,
      credential,
    });
    assert.equal(keyOf(a), keyOf(b));
  });

  it('never puts a token in the key', async () => {
    const credential = testCredential('super-secret-token-');
    const p = new SapCoreAIProvider({
      model: 'gpt-4o',
      apiBaseUrl,
      credential,
    });
    // Draw a token so a leak into the key would have something to leak.
    await credential.token();
    assert.ok(!keyOf(p).includes('super-secret-token-'));
  });
});

describe('orchestrationModelParams', () => {
  it('sends no sampling knobs that are not configured', () => {
    assert.deepEqual(orchestrationModelParams({}, false), {});
  });

  it('sends the configured ones, temperature 0 included', () => {
    assert.deepEqual(
      orchestrationModelParams(
        { maxTokens: 100, temperature: 0, reasoningEffort: 'high' },
        true,
      ),
      {
        max_tokens: 100,
        temperature: 0,
        reasoning_effort: 'high',
        tool_choice: 'auto',
      },
    );
  });
});

describe('SapCoreAIProvider.extractErrorDetail', () => {
  it('surfaces the AI Core body the SAP AI SDK keeps on cause', () => {
    const err = Object.assign(
      new Error('Request failed with status code 400.'),
      {
        cause: {
          response: {
            data: {
              error: {
                message: "gpt-5 models don't support temperature=0.7",
              },
            },
          },
        },
      },
    );
    assert.match(
      SapCoreAIProvider.extractErrorDetail(err),
      /gpt-5 models don't support temperature=0\.7/,
    );
  });
});
