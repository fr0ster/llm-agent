import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { type TestContext, test } from 'node:test';
import {
  addTokenUsage,
  type IUsageRecorder,
  type LLMResponse,
  LlmError,
  MODEL_CONTEXT_EXCEEDED,
  staticApiKey,
  type UsageInput,
} from '@mcp-abap-adt/llm-agent';
import { OpenAIProvider } from '@mcp-abap-adt/openai-llm';
import {
  type SapAiCoreFoundationConfig,
  SapAiCoreFoundationProvider,
} from '../sap-ai-core-foundation-provider.js';

const api = 'https://ai.example.test';
const deploymentUrl = `${api}/v2/inference/deployments/`;
const openAIModel = 'gpt-6.1-sol';
const anthropicModel = 'anthropic--claude-4.6-sonnet';
const completionPath = '/chat/completions?api-version=2024-10-21';
const messages = [
  { role: 'system' as const, content: 'Keep it short.' },
  { role: 'user' as const, content: 'Say hello.' },
];
const tools = [
  {
    type: 'function',
    function: { name: 'lookup', parameters: { type: 'object' } },
  },
];
const openAIUsage = {
  prompt_tokens: 16,
  completion_tokens: 4,
  total_tokens: 20,
  prompt_tokens_details: { cached_tokens: 8, cache_write_tokens: 2 },
};
const anthropicUsage = {
  input_tokens: 6,
  output_tokens: 4,
  cache_read_input_tokens: 8,
  cache_creation_input_tokens: 2,
};
const expectedUsage = {
  promptTokens: 16,
  completionTokens: 4,
  totalTokens: 20,
  cachedInputTokens: 8,
  cacheCreationInputTokens: 2,
};

function provider(
  model = openAIModel,
  config: Partial<SapAiCoreFoundationConfig> = {},
) {
  return new SapAiCoreFoundationProvider({
    credential: { kind: 'bearer', token: async () => 'test-token' },
    apiBaseUrl: `${api}/`,
    resourceGroup: 'test-group',
    model,
    ...config,
  });
}
function deployment(model: string, id: string, configurationId?: string) {
  return {
    scenarioId: 'foundation-models',
    configurationId,
    deploymentUrl: `${deploymentUrl + id}/`,
    details: { resources: { backendDetails: { model: { name: model } } } },
  };
}
function list(openAIConfigurationId?: string) {
  return Response.json({
    resources: [
      deployment(openAIModel, 'openai', openAIConfigurationId),
      deployment(anthropicModel, 'claude', 'claude-config'),
    ],
  });
}
function mockHttp(
  t: TestContext,
  handler: (url: URL, init?: RequestInit) => Response | Promise<Response>,
) {
  t.mock.method(globalThis, 'fetch', (input: string, init?: RequestInit) =>
    handler(new URL(input), init),
  );
}
function mockResponsesHttp(
  t: TestContext,
  handler: (url: URL, init?: RequestInit) => Response,
) {
  mockHttp(t, (url, init) => {
    if (url.pathname === '/v2/lm/deployments') return list('openai-config');
    if (url.pathname === '/v2/lm/configurations/openai-config')
      return Response.json({ executableId: 'azure-openai' });
    return handler(url, init);
  });
}
function bodyOf<T extends object>(init?: RequestInit): T {
  assert.equal(typeof init?.body, 'string');
  return JSON.parse(String(init?.body));
}
function sseFrames(...payloads: Array<object | '[DONE]'>) {
  return payloads
    .map(
      (payload) =>
        'data: ' +
        (payload === '[DONE]' ? payload : JSON.stringify(payload)) +
        '\r\n\r\n',
    )
    .join('');
}
function sse(text: string) {
  const bytes = new TextEncoder().encode(text);
  // Split UTF-8 code points and SSE delimiters across transport chunks.
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    }),
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
}
const awsContentType = 'application/vnd.amazon.eventstream';

function awsFrame(
  payload: object,
  headers: Record<string, string> = {
    ':message-type': 'event',
    ':event-type': 'chunk',
    ':content-type': 'application/json',
  },
) {
  const encodedHeaders = Buffer.concat(
    Object.entries(headers).map(([name, value]) => {
      const key = Buffer.from(name);
      const bytes = Buffer.from(value);
      const valueLength = Buffer.alloc(2);
      valueLength.writeUInt16BE(bytes.length);
      return Buffer.concat([
        Buffer.of(key.length),
        key,
        Buffer.of(7),
        valueLength,
        bytes,
      ]);
    }),
  );
  const json = Buffer.from(JSON.stringify(payload));
  const frame = Buffer.alloc(16 + encodedHeaders.length + json.length);
  frame.writeUInt32BE(frame.length, 0);
  frame.writeUInt32BE(encodedHeaders.length, 4);
  const checksum = (end: number) => {
    let crc = -1;
    for (const byte of frame.subarray(0, end)) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++)
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    return ~crc >>> 0;
  };
  frame.writeUInt32BE(checksum(8), 8);
  encodedHeaders.copy(frame, 12);
  json.copy(frame, 12 + encodedHeaders.length);
  frame.writeUInt32BE(checksum(frame.length - 4), frame.length - 4);
  return frame;
}

function awsResponse(...parts: Uint8Array[]) {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of parts) controller.enqueue(part);
        controller.close();
      },
    }),
    { headers: { 'Content-Type': awsContentType } },
  );
}

function bedrockFrame(event: object) {
  return awsFrame({
    bytes: Buffer.from(JSON.stringify(event)).toString('base64'),
  });
}

async function collect(stream: AsyncIterable<LLMResponse>) {
  const chunks: LLMResponse[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

function captureUsage() {
  const records: UsageInput[] = [];
  const usage: IUsageRecorder = {
    record: (record) => records.push(record),
    with: () => usage,
  };
  return { records, usage };
}

test('resolves running deployments per model and refreshes stale URLs on 404', async (t) => {
  const calls: string[] = [];
  let listings = 0;
  mockHttp(t, (url, init) => {
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('AI-Resource-Group'), 'test-group');
    assert.equal(headers.get('authorization'), 'Bearer test-token');
    calls.push(url.pathname);
    if (url.pathname === '/v2/lm/deployments') {
      assert.equal(url.searchParams.get('status'), 'RUNNING');
      listings++;
      return Response.json({
        resources: [
          deployment(openAIModel, listings === 1 ? 'stale' : 'replacement'),
          deployment('o4-mini', 'other'),
        ],
      });
    }
    assert.equal(url.search, '?api-version=2024-10-21');
    if (url.pathname.includes('/stale/'))
      return new Response(null, { status: 404 });
    return Response.json({
      choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }],
    });
  });
  const llm = provider();
  await llm.chat(messages);
  await llm.chat(messages);
  await llm.chat(messages, undefined, { model: 'o4-mini' });
  await llm.chat(messages);
  assert.deepEqual(calls, [
    '/v2/lm/deployments',
    '/v2/inference/deployments/stale/chat/completions',
    '/v2/lm/deployments',
    '/v2/inference/deployments/replacement/chat/completions',
    '/v2/inference/deployments/replacement/chat/completions',
    '/v2/lm/deployments',
    '/v2/inference/deployments/other/chat/completions',
    '/v2/inference/deployments/replacement/chat/completions',
  ]);
});

for (const method of ['chat', 'streamChat'] as const) {
  test(`foundation ${method} records each POST when a cached deployment is replaced`, async (t) => {
    const { records, usage } = captureUsage();
    const posts: string[] = [];
    let active = 'original';
    let listings = 0;
    mockHttp(t, (url, init) => {
      if (url.pathname === '/v2/lm/deployments') {
        listings++;
        return Response.json({ resources: [deployment(openAIModel, active)] });
      }
      assert.equal(init?.method, 'POST');
      posts.push(url.href);
      if (url.href !== `${deploymentUrl}${active}${completionPath}`) {
        return new Response(null, { status: 404 });
      }
      return method === 'streamChat'
        ? sse(sseFrames({ choices: [{ delta: { content: 'OK' } }] }, '[DONE]'))
        : Response.json({ choices: [{ message: { content: 'OK' } }] });
    });
    const llm = provider(openAIModel, { usage });
    const run = async () =>
      method === 'streamChat'
        ? (await collect(llm.streamChat(messages)))
            .map((chunk) => chunk.content)
            .join('')
        : (await llm.chat(messages)).content;
    assert.equal(await run(), 'OK');
    active = 'replacement';
    assert.equal(await run(), 'OK');

    assert.equal(listings, 2);
    assert.deepEqual(
      posts,
      ['original', 'original', 'replacement'].map(
        (id) => `${deploymentUrl}${id}${completionPath}`,
      ),
    );
    assert.equal(records.length, posts.length);
    const calls = records.filter((record) => record.kind === 'llm.call');
    assert.deepEqual(
      calls.map((record) => [
        record.outcome,
        record.errorStatus,
        record.providerAttempt,
        record.physicalSeq,
      ]),
      [
        ['ok', undefined, 0, 0],
        ['error', 404, 0, 0],
        ['ok', undefined, 1, 1],
      ],
    );
    assert.notEqual(calls[0].operationId, calls[1].operationId);
    assert.equal(calls[1].operationId, calls[2].operationId);
    assert.ok(calls.every((record) => record.retriesVisible));
  });
}

test('looks through deployment pages and scopes discovery to the configured resource group', async (t) => {
  const groups: string[] = [];
  mockHttp(t, (url, init) => {
    const group = new Headers(init?.headers).get('AI-Resource-Group') ?? '';
    if (url.pathname === '/v2/lm/deployments') {
      groups.push(group);
      if (url.searchParams.get('$skip') === '1') {
        return Response.json({
          count: 2,
          resources: [deployment(openAIModel, group)],
        });
      }
      return Response.json({
        count: 2,
        resources: [
          {
            ...deployment(openAIModel, 'orchestration'),
            scenarioId: 'orchestration',
          },
        ],
      });
    }
    assert.equal(url.href, deploymentUrl + group + completionPath);
    return Response.json({ choices: [{ message: { content: group } }] });
  });
  const first = provider(openAIModel, { resourceGroup: 'first' });
  const second = provider(openAIModel, { resourceGroup: 'second' });
  assert.equal((await first.chat(messages)).content, 'first');
  assert.equal((await second.chat(messages)).content, 'second');
  assert.deepEqual(await first.getModels(), [
    { id: openAIModel, scenarios: ['foundation-models'] },
  ]);
  assert.deepEqual(groups, [
    'first',
    'first',
    'second',
    'second',
    'first',
    'first',
  ]);
});

const responseCall = {
  type: 'function_call',
  id: 'fc_a',
  call_id: 'call_a',
  name: 'lookup',
  arguments: '{"x":1}',
  status: 'completed',
};
const responseReasoning = {
  type: 'reasoning',
  id: 'rs_a',
  summary: [],
  encrypted_content: 'encrypted-reasoning',
};
const responseMessage = {
  type: 'message',
  role: 'assistant',
  content: [{ type: 'output_text', text: 'Checking.' }],
};
const responseUsage = {
  input_tokens: 16,
  input_tokens_details: { cached_tokens: 8, cache_write_tokens: 2 },
  output_tokens: 4,
  output_tokens_details: { reasoning_tokens: 3 },
  total_tokens: 20,
};

test('OpenAI requests with tools use Responses, without tools use Chat Completions', async (t) => {
  mockResponsesHttp(t, (url, init) => {
    if (url.href === `${deploymentUrl}openai${completionPath}`) {
      assert.deepEqual(bodyOf(init), {
        model: openAIModel,
        messages,
        reasoning_effort: 'low',
        max_completion_tokens: 8192,
        stop: ['END'],
      });
      return Response.json({
        choices: [{ message: { content: 'Hello' }, finish_reason: 'stop' }],
        usage: openAIUsage,
      });
    }
    assert.equal(url.href, `${deploymentUrl}openai/responses`);
    assert.deepEqual(bodyOf(init), {
      model: openAIModel,
      input: messages,
      tools: [{ type: 'function', ...tools[0].function, strict: false }],
      reasoning: { effort: 'xhigh' },
      max_output_tokens: 8192,
      store: false,
      include: ['reasoning.encrypted_content'],
    });
    return Response.json({
      status: 'completed',
      output: [responseReasoning, responseMessage, responseCall],
      usage: responseUsage,
    });
  });
  const foundation = provider(openAIModel, {
    reasoningEffort: 'low',
    maxTokens: 8192,
  });
  const chat = await foundation.chat(messages, [], { stop: ['END'] });
  assert.equal(chat.content, 'Hello');
  assert.deepEqual(chat.usage, expectedUsage);

  const result = await foundation.chat(messages, tools, {
    reasoningEffort: 'xhigh',
  });
  assert.equal(result.content, 'Checking.');
  assert.equal(result.finishReason, 'tool_calls');
  assert.deepEqual(result.toolCalls, [
    { index: 2, id: 'call_a', name: 'lookup', arguments: '{"x":1}' },
  ]);
  assert.deepEqual(result.usage, { ...expectedUsage, reasoningTokens: 3 });
  assert.deepEqual(result.providerOutput?.items[0], responseReasoning);
});

test('plain chat skips configuration and later tool requests share the cached lookup', async (t) => {
  let configurationAvailable = false;
  let configurationReads = 0;
  let deploymentReads = 0;
  mockHttp(t, (url, init) => {
    if (url.pathname === '/v2/lm/deployments') {
      deploymentReads++;
      return list('openai-config');
    }
    if (url.pathname === '/v2/lm/configurations/openai-config') {
      assert.equal(init?.method ?? 'GET', 'GET');
      configurationReads++;
      return configurationAvailable
        ? Response.json({ executableId: 'azure-openai' })
        : new Response(null, { status: 403 });
    }
    if (url.href === `${deploymentUrl}openai${completionPath}`) {
      return Response.json({ choices: [{ message: { content: 'Hello' } }] });
    }
    assert.equal(url.href, `${deploymentUrl}openai/responses`);
    return Response.json({ status: 'completed', output: [responseMessage] });
  });

  const foundation = provider();
  assert.equal((await foundation.chat(messages)).content, 'Hello');
  assert.equal((await foundation.chat(messages, [])).content, 'Hello');
  assert.equal(configurationReads, 0);

  configurationAvailable = true;
  const concurrent = await Promise.all([
    foundation.chat(messages, tools),
    foundation.chat(messages, tools),
  ]);
  assert.deepEqual(
    concurrent.map((result) => result.content),
    ['Checking.', 'Checking.'],
  );
  assert.equal((await foundation.chat(messages, tools)).content, 'Checking.');
  assert.equal(configurationReads, 1);
  assert.equal(deploymentReads, 1);
});

test('a failed configuration lookup preserves the HTTP status and can be retried', async (t) => {
  const { signal } = new AbortController();
  let configurationReads = 0;
  mockHttp(t, (url, init) => {
    if (url.pathname === '/v2/lm/deployments') return list('openai-config');
    if (url.pathname === '/v2/lm/configurations/openai-config') {
      assert.equal(init?.signal, signal);
      configurationReads++;
      return configurationReads === 1
        ? new Response(null, { status: 403 })
        : Response.json({ executableId: 'azure-openai' });
    }
    assert.equal(url.href, `${deploymentUrl}openai/responses`);
    return Response.json({ status: 'completed', output: [responseMessage] });
  });

  const foundation = provider();
  await assert.rejects(foundation.chat(messages, tools, { signal }), {
    name: 'LlmError',
    status: 403,
  });
  const result = await foundation.chat(messages, tools, { signal });
  assert.equal(result.content, 'Checking.');
  assert.equal(configurationReads, 2);
});

test('OpenAI tool streams consume data-only Responses SSE and preserve reasoning', async (t) => {
  mockResponsesHttp(t, (url, init) => {
    assert.equal(url.href, `${deploymentUrl}openai/responses`);
    assert.deepEqual(bodyOf(init), {
      model: openAIModel,
      input: messages,
      tools: [{ type: 'function', ...tools[0].function, strict: false }],
      store: false,
      include: ['reasoning.encrypted_content'],
      stream: true,
      reasoning: { effort: 'medium' },
    });
    return sse(
      sseFrames(
        {
          type: 'response.output_item.done',
          output_index: 0,
          item: responseReasoning,
        },
        { type: 'response.output_text.delta', delta: 'Checking.' },
        {
          type: 'response.output_item.added',
          output_index: 1,
          item: { ...responseCall, arguments: '' },
        },
        {
          type: 'response.function_call_arguments.delta',
          output_index: 1,
          delta: '{"x":',
        },
        {
          type: 'response.function_call_arguments.delta',
          output_index: 1,
          delta: '1}',
        },
        {
          type: 'response.function_call_arguments.done',
          output_index: 1,
          arguments: responseCall.arguments,
        },
        {
          type: 'response.output_item.done',
          output_index: 1,
          item: responseCall,
        },
        {
          type: 'response.output_item.done',
          output_index: 2,
          item: responseMessage,
        },
        {
          type: 'response.completed',
          response: { status: 'completed', usage: responseUsage },
        },
      ),
    );
  });
  const { records, usage } = captureUsage();
  const chunks = await collect(
    provider(openAIModel, { usage }).streamChat(messages, tools, {
      reasoningEffort: 'medium',
    }),
  );
  const deltas = chunks.flatMap((chunk) => chunk.toolCalls ?? []);
  assert.equal(chunks.map((chunk) => chunk.content).join(''), 'Checking.');
  assert.deepEqual(deltas[0], { index: 1, id: 'call_a', name: 'lookup' });
  assert.equal(deltas.map((call) => call.arguments).join(''), '{"x":1}');
  assert.equal(chunks.at(-1)?.finishReason, 'tool_calls');
  assert.deepEqual(chunks.at(-1)?.providerOutput?.items, [
    responseReasoning,
    responseCall,
    responseMessage,
  ]);
  assert.deepEqual(chunks.at(-1)?.usage, {
    ...expectedUsage,
    reasoningTokens: 3,
  });
  assert.equal(records.length, 1);
  assert.equal(records[0].outcome, 'ok');
});

test('OpenAI Responses rejects a stream that ends without a terminal event', async (t) => {
  mockResponsesHttp(t, () =>
    sse(sseFrames({ type: 'response.output_text.delta', delta: 'Partial' })),
  );
  await assert.rejects(collect(provider().streamChat(messages, tools)), {
    name: 'LlmError',
    message: 'SAP AI Core Responses stream ended before completion',
  });
});

for (const route of ['responses', 'chat/completions']) {
  for (const stream of [false, true]) {
    test(`${route} ${stream ? 'stream' : 'chat'} learns a rejected sampling parameter`, async (t) => {
      const useResponses = route === 'responses';
      const parameter = stream ? 'top_p' : 'temperature';
      const bodies: Array<{ temperature?: number; top_p?: number }> = [];
      const { records, usage } = captureUsage();
      mockResponsesHttp(t, (url, init) => {
        assert.equal(url.pathname, `/v2/inference/deployments/openai/${route}`);
        bodies.push(bodyOf(init));
        if (bodies.length === 1) {
          return Response.json(
            {
              error: {
                param: parameter,
                code: stream
                  ? 'unsupported_value'
                  : useResponses
                    ? 'unsupported_parameter'
                    : undefined,
              },
            },
            { status: 400 },
          );
        }
        if (useResponses) {
          const response = { status: 'completed', output: [responseMessage] };
          return stream
            ? sse(
                sseFrames(
                  { type: 'response.output_text.delta', delta: 'Checking.' },
                  { type: 'response.completed', response },
                ),
              )
            : Response.json(response);
        }
        return stream
          ? sse(
              sseFrames(
                {
                  choices: [
                    { delta: { content: 'Checking.' }, finish_reason: 'stop' },
                  ],
                },
                '[DONE]',
              ),
            )
          : Response.json({ choices: [{ message: { content: 'Checking.' } }] });
      });
      const llm = provider(openAIModel, { temperature: 0, usage });
      const routeTools = useResponses ? tools : undefined;
      const options = { topP: 0.8, reasoningEffort: 'high' as const };
      for (let call = 0; call < 2; call++) {
        const content = stream
          ? (await collect(llm.streamChat(messages, routeTools, options)))
              .map((chunk) => chunk.content)
              .join('')
          : (await llm.chat(messages, routeTools, options)).content;
        assert.equal(content, 'Checking.');
      }
      assert.equal(bodies.length, 3);
      assert.equal(bodies[0].temperature, 0);
      assert.equal(bodies[0].top_p, 0.8);
      for (const body of bodies.slice(1)) {
        assert.equal(Object.hasOwn(body, parameter), false);
        assert.equal(stream ? body.temperature : body.top_p, stream ? 0 : 0.8);
      }
      assert.deepEqual(
        records.map(({ outcome }) => outcome),
        ['error', 'ok', 'ok'],
      );
    });
  }
}

for (const method of ['chat', 'streamChat'] as const) {
  test(`foundation ${method} restores sampling when the rejecting deployment is replaced`, async (t) => {
    const posts: Array<{ url: string; temperature?: number }> = [];
    mockHttp(t, (url, init) => {
      if (url.pathname === '/v2/lm/deployments') {
        const id = posts.length === 0 ? 'original' : 'replacement';
        return Response.json({ resources: [deployment(openAIModel, id, id)] });
      }
      if (url.pathname.startsWith('/v2/lm/configurations/'))
        return Response.json({ executableId: 'azure-openai' });

      assert.equal(init?.method, 'POST');
      const { temperature } = bodyOf<{ temperature?: number }>(init);
      posts.push({ url: url.href, temperature });
      if (posts.length === 1) {
        return Response.json(
          { error: { code: 'unsupported_parameter', param: 'temperature' } },
          { status: 400 },
        );
      }
      if (posts.length === 2) return new Response(null, { status: 404 });

      const response = { status: 'completed', output: [responseMessage] };
      return method === 'streamChat'
        ? sse(
            sseFrames(
              { type: 'response.output_text.delta', delta: 'Checking.' },
              { type: 'response.completed', response },
            ),
          )
        : Response.json(response);
    });

    const llm = provider();
    const options = { temperature: 0.5 };
    const content =
      method === 'streamChat'
        ? (await collect(llm.streamChat(messages, tools, options)))
            .map((chunk) => chunk.content)
            .join('')
        : (await llm.chat(messages, tools, options)).content;

    assert.equal(content, 'Checking.');
    assert.deepEqual(posts, [
      { url: `${deploymentUrl}original/responses`, temperature: 0.5 },
      { url: `${deploymentUrl}original/responses`, temperature: undefined },
      { url: `${deploymentUrl}replacement/responses`, temperature: 0.5 },
    ]);
  });
}

test('learns both rejected parameters with at most one repeat and shares the cache across routes', async (t) => {
  let requests = 0;
  mockResponsesHttp(t, (url, init) => {
    requests++;
    const body = bodyOf(init);
    if (requests <= 2) {
      assert.equal(url.pathname, '/v2/inference/deployments/openai/responses');
      const parameter = requests === 1 ? 'temperature' : 'top_p';
      assert.ok(Object.hasOwn(body, parameter));
      assert.equal(Object.hasOwn(body, 'temperature'), requests === 1);
      return Response.json(
        {
          error: { param: parameter, message: `Unsupported ${parameter}` },
        },
        { status: 400 },
      );
    }
    assert.equal(url.href, `${deploymentUrl}openai${completionPath}`);
    assert.equal(Object.hasOwn(body, 'temperature'), false);
    assert.equal(Object.hasOwn(body, 'top_p'), false);
    return Response.json({ choices: [{ message: { content: 'Hello' } }] });
  });
  const llm = provider();
  const options = { temperature: 0.5, topP: 0.8 };
  await assert.rejects(llm.chat(messages, tools, options), {
    name: 'LlmError',
    status: 400,
    message:
      'SAP AI Core foundation request failed (HTTP 400): Unsupported top_p',
  });
  assert.equal(requests, 2);
  assert.equal((await llm.chat(messages, undefined, options)).content, 'Hello');
  assert.equal(requests, 3);
});

test('does not repeat a Responses stream after its first chunk', async (t) => {
  let requests = 0;
  mockResponsesHttp(t, () => {
    requests++;
    return sse(
      sseFrames(
        { type: 'response.output_text.delta', delta: 'Partial' },
        { type: 'error', code: 'unsupported_parameter', param: 'temperature' },
      ),
    );
  });
  const chunks = [];
  await assert.rejects(
    async () => {
      for await (const chunk of provider().streamChat(messages, tools, {
        temperature: 0.5,
      })) {
        chunks.push(chunk.content);
      }
    },
    { name: 'LlmError', message: 'SAP AI Core foundation inference failed' },
  );
  assert.deepEqual(chunks, ['Partial']);
  assert.equal(requests, 1);
});

for (const status of [400, 422]) {
  test(`OpenAI Responses preserves the provider explanation for HTTP ${status}`, async (t) => {
    let requests = 0;
    mockResponsesHttp(t, (url) => {
      requests++;
      assert.equal(url.href, `${deploymentUrl}openai/responses`);
      return Response.json(
        {
          error: {
            code: 'unsupported_value',
            param: 'reasoning.effort',
            message: 'Unsupported reasoning effort',
          },
        },
        { status },
      );
    });
    const foundation = provider();
    await assert.rejects(
      foundation.chat(messages, tools, { temperature: 0.5, topP: 0.8 }),
      {
        name: 'LlmError',
        status,
        message: `SAP AI Core foundation request failed (HTTP ${status}): Unsupported reasoning effort`,
      },
    );
    assert.equal(requests, 1);
  });
}

test('OpenAI Responses omits echoed request data from HTTP 422 errors', async (t) => {
  mockResponsesHttp(t, (url) => {
    assert.equal(url.href, `${deploymentUrl}openai/responses`);
    return Response.json(
      { request: { headers: { Authorization: 'Bearer echoed-token' } } },
      { status: 422 },
    );
  });
  await assert.rejects(provider().chat(messages, tools), {
    name: 'LlmError',
    status: 422,
    message: 'SAP AI Core foundation request failed (HTTP 422)',
  });
});

test('OpenAI Responses accepts a top-level message when the nested message is not a string', async (t) => {
  mockResponsesHttp(t, () =>
    Response.json(
      { error: { message: { code: 42 } }, message: 'Invalid input' },
      { status: 400 },
    ),
  );
  await assert.rejects(provider().chat(messages, tools), {
    name: 'LlmError',
    status: 400,
    message: 'SAP AI Core foundation request failed (HTTP 400): Invalid input',
  });
});

test('uses each deployment configuration once and refreshes the tool protocol on 404', async (t) => {
  const model = 'tool-capable-model';
  const configurationPath = '/v2/lm/configurations/';
  const lookups: string[] = [];
  let active = 'azure';
  mockHttp(t, (url, init) => {
    if (url.pathname === '/v2/lm/deployments') {
      return Response.json({ resources: [deployment(model, active, active)] });
    }
    if (url.pathname.startsWith(configurationPath)) {
      assert.equal(init?.method ?? 'GET', 'GET');
      assert.equal(
        new Headers(init?.headers).get('AI-Resource-Group'),
        'test-group',
      );
      const id = url.pathname.slice(configurationPath.length);
      lookups.push(id);
      return Response.json({
        executableId: id === 'azure' ? 'azure-openai' : 'aicore-mistralai',
      });
    }
    if (url.href === `${deploymentUrl}azure/responses`) {
      assert.deepEqual(
        bodyOf<{ input: typeof messages }>(init).input,
        messages,
      );
      return active === 'azure'
        ? Response.json({ status: 'completed', output: [responseMessage] })
        : new Response(null, { status: 404 });
    }
    assert.equal(url.href, `${deploymentUrl}mistral${completionPath}`);
    assert.deepEqual(bodyOf(init), {
      model,
      messages,
      tools,
      tool_choice: 'auto',
    });
    return Response.json({
      choices: [
        { message: { content: 'Mistral reply' }, finish_reason: 'stop' },
      ],
    });
  });

  const llm = provider(model, { reasoningEffort: 'low' });
  const first = await Promise.all([
    llm.chat(messages, tools),
    llm.chat(messages, tools),
  ]);
  assert.deepEqual(
    first.map((result) => result.content),
    ['Checking.', 'Checking.'],
  );
  active = 'mistral';
  assert.equal((await llm.chat(messages, tools)).content, 'Mistral reply');
  assert.equal((await llm.chat(messages, tools)).content, 'Mistral reply');
  assert.deepEqual(lookups, ['azure', 'mistral']);
});

test('Anthropic chat sends Bedrock messages, remaps historical tools and controls cache breakpoints', async (t) => {
  let calls = 0;
  const { records, usage } = captureUsage();
  mockHttp(t, (url, init) => {
    if (url.pathname === '/v2/lm/deployments') return list();
    assert.equal(url.href, `${deploymentUrl}claude/invoke`);
    const request = bodyOf<{
      anthropic_version: string;
      model?: string;
      max_tokens: number;
      system: string | object[];
      messages: object[];
      tools: object[];
      cache_control?: object;
    }>(init);
    assert.equal(request.anthropic_version, 'bedrock-2023-05-31');
    assert.equal(request.model, undefined);
    assert.equal(request.max_tokens, 300);
    assert.equal(request.cache_control, undefined);
    assert.deepEqual(
      request.system,
      calls++ === 0
        ? 'Keep it short.'
        : [
            {
              type: 'text',
              text: 'Keep it short.',
              cache_control: { type: 'ephemeral' },
            },
          ],
    );
    assert.deepEqual(request.messages, [
      { role: 'user', content: 'Say hello.' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_history_0',
            name: 'lookup',
            input: {},
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_history_0',
            content: 'previous result',
          },
        ],
      },
    ]);
    assert.deepEqual(request.tools, [
      { name: 'lookup', input_schema: { type: 'object' } },
    ]);
    return Response.json({
      content: [
        { type: 'text', text: 'Checking.' },
        { type: 'tool_use', id: 'call_b', name: 'lookup', input: {} },
      ],
      stop_reason: 'tool_use',
      usage: anthropicUsage,
      ...(calls === 2
        ? {
            'amazon-bedrock-invocationMetrics': {
              inputTokenCount: 5,
              outputTokenCount: 3,
            },
          }
        : {}),
    });
  });
  const llm = provider(anthropicModel, {
    maxTokens: 300,
    promptCaching: false,
    usage,
  });
  const history = [
    ...messages,
    {
      role: 'assistant' as const,
      content: null,
      tool_calls: [
        {
          id: 'invalid.id',
          type: 'function' as const,
          function: { name: 'lookup', arguments: '{}' },
        },
      ],
    },
    {
      role: 'tool' as const,
      content: 'previous result',
      tool_call_id: 'invalid.id',
    },
  ];
  assert.deepEqual((await llm.chat(history, tools)).usage, expectedUsage);
  const result = await llm.chat(history, tools, { promptCaching: true });
  assert.equal(result.content, 'Checking.');
  assert.equal(result.finishReason, 'tool_calls');
  assert.deepEqual(result.toolCalls, [
    { index: 0, id: 'call_b', name: 'lookup', arguments: '{}' },
  ]);
  assert.deepEqual(result.usage, expectedUsage);
  assert.equal(records.length, 2);
  for (const record of records) {
    assert.equal(record.kind, 'llm.call');
    assert.equal(record.inputTokens, 6);
    assert.equal(record.outputTokens, 4);
    assert.equal(record.cachedInputTokens, 8);
    assert.equal(record.cacheCreationInputTokens, 2);
  }
});

for (const [label, usageField] of [
  ['missing', undefined],
  ['zero', { input_tokens: 0, output_tokens: 0 }],
  ['partial', { input_tokens: 120, output_tokens: 1 }],
] as const) {
  test(`Anthropic /invoke merges ${label} usage with Bedrock invocation metrics`, async (t) => {
    const { records, usage } = captureUsage();
    mockHttp(t, (url, init) => {
      if (url.pathname === '/v2/lm/deployments') return list();
      assert.equal(url.href, `${deploymentUrl}claude/invoke`);
      assert.equal(init?.method, 'POST');
      return Response.json({
        content: [{ type: 'text', text: 'Hello' }],
        usage: usageField,
        'amazon-bedrock-invocationMetrics': {
          inputTokenCount: 123,
          outputTokenCount: 9,
        },
      });
    });
    const result = await provider(anthropicModel, {
      maxTokens: 300,
      usage,
    }).chat(messages);
    assert.deepEqual(result.usage, {
      promptTokens: 123,
      completionTokens: 9,
      totalTokens: 132,
    });
    assert.equal(records.length, 1);
    const record = records[0];
    assert.equal(record.kind, 'llm.call');
    assert.equal(record.outcome, 'ok');
    assert.equal(record.inputTokens, 123);
    assert.equal(record.outputTokens, 9);
  });
}

test('OpenAI SSE handles split UTF-8, argument deltas, usage and the terminal sentinel', async (t) => {
  mockHttp(t, (url, init) => {
    if (url.pathname === '/v2/lm/deployments') return list();
    assert.equal(url.href, `${deploymentUrl}openai${completionPath}`);
    const request = bodyOf<{ stream: boolean; stream_options: object }>(init);
    assert.equal(request.stream, true);
    assert.deepEqual(request.stream_options, { include_usage: true });
    return sse(
      `${sseFrames(
        { choices: [], prompt_filter_results: [] },
        { choices: [{ delta: { content: 'Hello 🌍' } }] },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'empty',
                    function: { name: 'lookup', arguments: '' },
                  },
                  {
                    index: 1,
                    id: 'filled',
                    function: { name: 'lookup', arguments: '{"x":' },
                  },
                ],
              },
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [{ index: 1, function: { arguments: '1}' } }],
              },
            },
          ],
        },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        { choices: [], usage: openAIUsage },
        '[DONE]',
      )}data: must be ignored\r\n\r\n`,
    );
  });
  const chunks = await collect(provider().streamChat(messages));
  assert.equal(chunks.map((chunk) => chunk.content).join(''), 'Hello 🌍');
  assert.equal(
    chunks.find((chunk) => chunk.finishReason)?.finishReason,
    'tool_calls',
  );
  const calls = chunks.flatMap((chunk) => chunk.toolCalls ?? []);
  assert.equal(
    calls
      .filter((call) => call.index === 0)
      .map((call) => call.arguments)
      .join(''),
    '{}',
  );
  assert.equal(
    calls
      .filter((call) => call.index === 1)
      .map((call) => call.arguments)
      .join(''),
    '{"x":1}',
  );
  assert.deepEqual(chunks.at(-1)?.usage, expectedUsage);
});

test('OpenAI SSE retains partial usage across empty chunks like the direct provider', async (t) => {
  const frames = sseFrames(
    {
      choices: [],
      usage: {
        prompt_tokens: 5,
        completion_tokens: 1,
        prompt_tokens_details: { cached_tokens: 3, cache_write_tokens: 1 },
      },
    },
    { choices: [], usage: {} },
    { choices: [], usage: { completion_tokens: 2 } },
    { choices: [], usage: {} },
    '[DONE]',
  );
  mockHttp(t, (url) =>
    url.pathname === '/v2/lm/deployments' ? list() : sse(frames),
  );
  const foundation = captureUsage();
  const direct = captureUsage();
  const directProvider = new OpenAIProvider({
    model: openAIModel,
    credential: staticApiKey('test-key'),
    usage: direct.usage,
  });
  t.mock.method(directProvider.client, 'post', async () => ({
    data: Readable.from([frames]),
  }));
  await collect(
    provider(openAIModel, { usage: foundation.usage }).streamChat(messages),
  );
  await collect(directProvider.streamChat(messages));

  const tokenFacts = (records: UsageInput[]) =>
    records.map((record) => {
      assert.equal(record.kind, 'llm.call');
      return [
        record.outcome,
        record.tokensSource,
        record.inputTokens,
        record.outputTokens,
        record.cachedInputTokens,
        record.cacheCreationInputTokens,
      ];
    });
  assert.deepEqual(tokenFacts(foundation.records), tokenFacts(direct.records));
  assert.deepEqual(tokenFacts(foundation.records), [
    ['ok', 'provider', 5, 2, 3, 1],
  ]);
});

test('OpenAI SSE leaves empty tool arguments intact when generation ends at the token limit', async (t) => {
  mockHttp(t, (url) =>
    url.pathname === '/v2/lm/deployments'
      ? list()
      : sse(
          sseFrames(
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'truncated',
                        function: { name: 'lookup', arguments: '' },
                      },
                    ],
                  },
                },
              ],
            },
            { choices: [{ finish_reason: 'length' }] },
            '[DONE]',
          ),
        ),
  );
  const chunks = await collect(provider().streamChat(messages));
  assert.equal(chunks.at(-1)?.finishReason, 'length');
  assert.deepEqual(
    chunks.flatMap((chunk) => chunk.toolCalls ?? []),
    [{ index: 0, id: 'truncated', name: 'lookup', arguments: '' }],
  );
});

async function checkAnthropicStream(t: TestContext, wire: string) {
  const { records, usage } = captureUsage();
  mockHttp(t, (url, init) => {
    if (url.pathname === '/v2/lm/deployments') return list();
    assert.equal(
      url.href,
      `${deploymentUrl}claude/invoke-with-response-stream`,
    );
    const request = bodyOf<{
      stream?: boolean;
      max_tokens: number;
      system: object[];
    }>(init);
    assert.equal(request.stream, undefined);
    assert.equal(request.max_tokens, 300);
    assert.deepEqual(request.system, [
      {
        type: 'text',
        text: 'Keep it short.',
        cache_control: { type: 'ephemeral' },
      },
    ]);
    const events = [
      {
        type: 'message_start',
        message: {
          usage: { ...anthropicUsage, input_tokens: 0, output_tokens: 1 },
        },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Hello 🌍' },
      },
      {
        type: 'content_block_start',
        index: 1,
        content_block: {
          type: 'tool_use',
          id: 'empty',
          name: 'lookup',
          input: {},
        },
      },
      { type: 'content_block_stop', index: 1 },
      {
        type: 'content_block_start',
        index: 2,
        content_block: {
          type: 'tool_use',
          id: 'filled',
          name: 'lookup',
          input: {},
        },
      },
      {
        type: 'content_block_delta',
        index: 2,
        delta: { type: 'input_json_delta', partial_json: '{"x":1}' },
      },
      { type: 'content_block_stop', index: 2 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use' },
        usage: { output_tokens: anthropicUsage.output_tokens },
      },
      {
        type: 'message_stop',
        usage: { cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        'amazon-bedrock-invocationMetrics': {
          inputTokenCount: 6,
          outputTokenCount: 3,
        },
      },
    ];
    if (wire === 'SSE') return sse(sseFrames(...events));
    const frames = Buffer.concat(events.map(bedrockFrame));
    // Split the prelude, headers and payload, then deliver several frames at once.
    return awsResponse(
      frames.subarray(0, 2),
      frames.subarray(2, 10),
      frames.subarray(10, 23),
      frames.subarray(23, 110),
      frames.subarray(110),
    );
  });
  const chunks = await collect(
    provider(anthropicModel, { maxTokens: 300, usage }).streamChat(
      messages,
      tools,
    ),
  );
  assert.equal(chunks.map((chunk) => chunk.content).join(''), 'Hello 🌍');
  assert.equal(
    chunks.find((chunk) => chunk.finishReason)?.finishReason,
    'tool_calls',
  );
  const calls = chunks.flatMap((chunk) => chunk.toolCalls ?? []);
  assert.deepEqual(calls, [
    { index: 0, id: 'empty', name: 'lookup', arguments: '' },
    { index: 0, arguments: '{}' },
    { index: 1, id: 'filled', name: 'lookup', arguments: '' },
    { index: 1, arguments: '{"x":1}' },
  ]);
  const totals = chunks
    .map((chunk) => chunk.usage)
    .reduce(addTokenUsage, undefined);
  assert.deepEqual(totals, expectedUsage);
  const record = records[0];
  assert.equal(records.length, 1);
  assert.equal(record.kind, 'llm.call');
  assert.equal(record.outcome, 'ok');
  assert.equal(record.tokensSource, 'provider');
  assert.equal(record.inputTokens, 6);
  assert.equal(record.outputTokens, 4);
  assert.equal(record.cachedInputTokens, 8);
  assert.equal(record.cacheCreationInputTokens, 2);
}

for (const wire of ['SSE', 'AWS event stream']) {
  test(`Anthropic ${wire} maps Messages events and emits per-call totals without double-counting`, (t) =>
    checkAnthropicStream(t, wire));

  const finalUsage = { input_tokens: 0, output_tokens: 9 };
  for (const [label, inputTokens, deltaUsage] of [
    ['positive initial input', 123, finalUsage],
    ['zero initial usage', 0, { input_tokens: 0, output_tokens: 0 }],
    ['missing initial input', undefined, finalUsage],
    ['zero final output', 123, { output_tokens: 0 }],
    ['missing final usage', 123, undefined],
  ] as const) {
    test(`Anthropic ${wire} merges ${label} with final Bedrock metrics`, async (t) => {
      const { records, usage } = captureUsage();
      let posts = 0;
      mockHttp(t, (url, init) => {
        if (url.pathname === '/v2/lm/deployments') return list();
        assert.equal(
          url.href,
          `${deploymentUrl}claude/invoke-with-response-stream`,
        );
        assert.equal(init?.method, 'POST');
        posts++;
        const events = [
          {
            type: 'message_start',
            message: {
              usage: {
                input_tokens: inputTokens,
                output_tokens: inputTokens === 0 ? 0 : 1,
              },
            },
          },
          {
            type: 'message_delta',
            usage: deltaUsage,
          },
          {
            type: 'message_stop',
            'amazon-bedrock-invocationMetrics': {
              inputTokenCount: 123,
              outputTokenCount: 9,
            },
          },
        ];
        return wire === 'SSE'
          ? sse(sseFrames(...events))
          : awsResponse(...events.map(bedrockFrame));
      });
      const chunks = await collect(
        provider(anthropicModel, { maxTokens: 300, usage }).streamChat(
          messages,
        ),
      );
      const totals = chunks
        .map((chunk) => chunk.usage)
        .reduce(addTokenUsage, undefined);
      assert.deepEqual(totals, {
        promptTokens: 123,
        completionTokens: 9,
        totalTokens: 132,
      });
      for (const { usage } of chunks) {
        assert.ok((usage?.promptTokens ?? 0) >= 0);
        assert.ok((usage?.completionTokens ?? 0) >= 0);
      }
      assert.equal(posts, 1);
      assert.equal(records.length, 1);
      const record = records[0];
      assert.equal(record.kind, 'llm.call');
      assert.equal(record.outcome, 'ok');
      assert.equal(record.inputTokens, 123);
      assert.equal(record.outputTokens, 9);
    });
  }
}

test('AWS event stream rejects invalid prelude and message CRCs and incomplete frames', async (t) => {
  const valid = awsFrame({
    bytes: Buffer.from(JSON.stringify({ type: 'message_stop' })).toString(
      'base64',
    ),
  });
  const badPrelude = Buffer.from(valid);
  badPrelude[11] ^= 1;
  const badMessage = Buffer.from(valid);
  badMessage[badMessage.length - 1] ^= 1;
  let body: Uint8Array = valid;
  mockHttp(t, (url) =>
    url.pathname === '/v2/lm/deployments' ? list() : awsResponse(body),
  );
  const llm = provider(anthropicModel, { maxTokens: 100 });
  for (const [bytes, message] of [
    [badPrelude, /prelude CRC/],
    [badMessage, /message CRC/],
    [valid.subarray(0, -1), /Incomplete AWS event stream frame/],
  ] as const) {
    body = bytes;
    await assert.rejects(collect(llm.streamChat(messages)), {
      name: LlmError.name,
      message,
    });
  }
});

test('Anthropic preserves typed context overflow from an AWS exception frame', async (t) => {
  const frame = awsFrame(
    { message: 'prompt is too long' },
    {
      ':message-type': 'exception',
      ':exception-type': 'validationException',
      ':content-type': 'application/json',
    },
  );
  mockHttp(t, (url) =>
    url.pathname === '/v2/lm/deployments' ? list() : awsResponse(frame),
  );
  await assert.rejects(
    collect(provider(anthropicModel, { maxTokens: 100 }).streamChat(messages)),
    (error) =>
      error instanceof LlmError && error.code === MODEL_CONTEXT_EXCEEDED,
  );
});

test('foundation reports an unsupported or missing stream content type as a failed request', async (t) => {
  const records: UsageInput[] = [];
  const usage: IUsageRecorder = {
    record: (record) => records.push(record),
    with: () => usage,
  };
  let type: string | undefined;
  mockHttp(t, (url) => {
    if (url.pathname === '/v2/lm/deployments') return list();
    const body = new Uint8Array();
    return new Response(body, {
      headers: type ? { 'Content-Type': type } : {},
    });
  });
  for (const model of [openAIModel, anthropicModel]) {
    const llm = provider(model, { maxTokens: 100, usage });
    for (type of [undefined, 'application/json']) {
      await assert.rejects(
        collect(llm.streamChat(messages)),
        (error) =>
          error instanceof LlmError &&
          /stream content type/.test(error.message),
      );
    }
  }
  assert.deepEqual(
    records.map((record) => [record.kind, record.outcome]),
    Array.from({ length: 4 }, () => ['llm.call', 'error']),
  );
});

test('classifies plain-text HTTP context overflow without exposing the body', async (t) => {
  mockResponsesHttp(
    t,
    () =>
      new Response('maximum context length exceeded: echoed request data', {
        status: 400,
      }),
  );
  await assert.rejects(provider().chat(messages, tools), {
    name: 'LlmError',
    code: MODEL_CONTEXT_EXCEEDED,
    status: 400,
    message: 'SAP AI Core model context exceeded',
  });
});

test('uses only the provider message from a structured HTTP context error', async (t) => {
  const message = 'Maximum context length exceeded';
  mockResponsesHttp(t, () =>
    Response.json(
      { error: { message }, request: 'echoed request data' },
      { status: 400 },
    ),
  );
  await assert.rejects(provider().chat(messages, tools), {
    name: 'LlmError',
    code: MODEL_CONTEXT_EXCEEDED,
    status: 400,
    message,
  });
});

for (const [model, overflow] of [
  [openAIModel, { error: { code: 'context_length_exceeded' } }],
  [
    anthropicModel,
    {
      type: 'error',
      error: { type: 'invalid_request_error', message: 'prompt is too long' },
    },
  ],
] as const) {
  test(
    model +
      ' reports 429 and HTTP context overflow as typed errors for chat and stream',
    async (t) => {
      let status = 429;
      mockHttp(t, (url) => {
        if (url.pathname === '/v2/lm/deployments') return list();
        return Response.json(overflow, {
          status,
          headers: { 'Retry-After': '3' },
        });
      });
      for (const stream of [false, true]) {
        const run = () => {
          const llm = provider(model, { maxTokens: 100 });
          return stream
            ? collect(llm.streamChat(messages))
            : llm.chat(messages);
        };
        status = 429;
        await assert.rejects(run, (error: Error) => {
          assert.ok(error instanceof LlmError);
          assert.equal('status' in error && error.status, 429);
          assert.equal('throttled' in error && error.throttled, true);
          assert.equal(
            'retryAfterSeconds' in error && error.retryAfterSeconds,
            3,
          );
          return true;
        });
        status = 400;
        await assert.rejects(
          run,
          (error: Error) =>
            error instanceof LlmError && error.code === MODEL_CONTEXT_EXCEEDED,
        );
      }
    },
  );

  test(`${model} classifies context overflow inside an active SSE stream`, async (t) => {
    mockHttp(t, (url) =>
      url.pathname === '/v2/lm/deployments' ? list() : sse(sseFrames(overflow)),
    );
    await assert.rejects(
      collect(provider(model, { maxTokens: 100 }).streamChat(messages)),
      (error: Error) =>
        error instanceof LlmError && error.code === MODEL_CONTEXT_EXCEEDED,
    );
  });
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}

for (const stream of [false, true]) {
  test(`foundation gives recognized context overflow precedence over a later abort (stream=${stream})`, async (t) => {
    const controller = new AbortController();
    const response = Response.json(
      { error: { code: 'context_length_exceeded' } },
      { status: 400 },
    );
    const readBody = response.text.bind(response);
    t.mock.method(response, 'text', async () => {
      const body = await readBody();
      controller.abort(new Error('Cancelled'));
      return body;
    });
    mockHttp(t, (url) =>
      url.pathname === '/v2/lm/deployments' ? list() : response,
    );
    const llm = provider();
    const options = { signal: controller.signal };
    await assert.rejects(
      stream
        ? collect(llm.streamChat(messages, undefined, options))
        : llm.chat(messages, undefined, options),
      (error) =>
        error instanceof LlmError && error.code === MODEL_CONTEXT_EXCEEDED,
    );
    assert.equal(controller.signal.aborted, true);
  });

  test(`foundation records no physical request if bearer credential acquisition fails (stream=${stream})`, async (t) => {
    const records: UsageInput[] = [];
    const usage: IUsageRecorder = {
      record: (record) => records.push(record),
      with: () => usage,
    };
    const token = t.mock.fn(async () => {
      throw new Error('Credential rejected');
    });
    const fetch = t.mock.method(globalThis, 'fetch', () => {
      throw new Error('Unexpected HTTP request');
    });
    const llm = provider(openAIModel, {
      credential: { kind: 'bearer', token },
      usage,
    });
    await assert.rejects(
      stream ? collect(llm.streamChat(messages)) : llm.chat(messages),
      LlmError,
    );
    assert.equal(token.mock.callCount(), 1);
    assert.equal(fetch.mock.callCount(), 0);
    assert.deepEqual(records, []);
  });
}

test('abort during credential resolution prevents HTTP requests', async (t) => {
  // Resolve the token after cancellation to verify that no request resumes.
  const pending = deferred<string>();
  const controller = new AbortController();
  const tokenRequested = deferred<void>();
  const llm = provider(openAIModel, {
    credential: {
      kind: 'bearer',
      token() {
        tokenRequested.resolve();
        return pending.promise;
      },
    },
  });
  const fetch = t.mock.method(globalThis, 'fetch', () => {
    throw new Error('Unexpected HTTP request');
  });
  const chat = llm.chat(messages, undefined, { signal: controller.signal });
  await tokenRequested.promise;
  controller.abort();
  await assert.rejects(chat, { name: 'AbortError' });
  pending.resolve('test-token');
  assert.equal(fetch.mock.callCount(), 0);
});

test('abort is passed through to discovery and cancels an open SSE reader', async (t) => {
  const controller = new AbortController();
  let cancelled = false;
  mockHttp(t, (url, init) => {
    assert.equal(init?.signal, controller.signal);
    if (url.pathname === '/v2/lm/deployments') return list();
    return new Response(
      new ReadableStream<Uint8Array>({
        start(stream) {
          stream.enqueue(
            new TextEncoder().encode(
              sseFrames({ choices: [{ delta: { content: 'started' } }] }),
            ),
          );
        },
        cancel() {
          cancelled = true;
        },
      }),
      { headers: { 'Content-Type': 'text/event-stream' } },
    );
  });
  const stream = provider()
    .streamChat(messages, undefined, { signal: controller.signal })
    [Symbol.asyncIterator]();
  assert.equal((await stream.next()).value?.content, 'started');
  const pending = stream.next();
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(cancelled, true);
});

test('Anthropic accepts a per-call maxTokens and reports an explicit error when omitted', async (t) => {
  mockHttp(t, (url, init) => {
    if (url.pathname === '/v2/lm/deployments') return list();
    const request = bodyOf<{ max_tokens: number }>(init);
    assert.equal(request.max_tokens, 123456);
    return Response.json({ content: [{ type: 'text', text: 'OK' }] });
  });
  const llm = provider(anthropicModel);
  await assert.rejects(llm.chat(messages), /require maxTokens/);
  assert.equal(
    (await llm.chat(messages, undefined, { maxTokens: 123456 })).content,
    'OK',
  );
});
