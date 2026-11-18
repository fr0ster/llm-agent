import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import type { SessionConfig, SessionEvent } from '@github/copilot-sdk';
import {
  type LlmTool,
  type Message,
  type Result,
  setThrottleObserver,
  type ThrottleEvent,
} from '@mcp-abap-adt/llm-agent';
import {
  CopilotProvider,
  type CopilotSdkClient,
  type CopilotSdkSession,
} from './index.js';
import { deferred } from './turn.js';

type Event = {
  [Type in SessionEvent['type']]: Pick<
    Extract<SessionEvent, { type: Type }>,
    'type' | 'data'
  >;
}[SessionEvent['type']];

class FakeSession implements CopilotSdkSession {
  readonly prompts: string[] = [];
  readonly rewinds: string[] = [];
  readonly results: Array<
    Parameters<CopilotSdkSession['rpc']['tools']['handlePendingToolCall']>[0]
  > = [];
  readonly sent = deferred<void>();
  aborts = 0;
  disconnects = 0;
  private listener?: (event: SessionEvent) => void;
  private disconnected?: () => void;
  private nextEventId = 0;

  constructor(
    readonly config: SessionConfig,
    private readonly client: FakeClient,
  ) {}

  readonly rpc: CopilotSdkSession['rpc'] = {
    history: {
      rewind: async ({ eventId, mode }) => {
        assert.equal(mode, 'conversation');
        this.rewinds.push(eventId);
        return { outcome: 'success', restoredFiles: [], skippedFiles: [] };
      },
    },
    tools: {
      handlePendingToolCall: async (request) => {
        this.results.push(request);
        this.client.onToolResult?.(this);
        return { success: true };
      },
    },
  };

  async send({ prompt }: { prompt: string }): Promise<string> {
    this.prompts.push(prompt);
    this.emit({ type: 'user.message', data: { content: prompt } });
    this.sent.resolve();
    this.client.onSend(this);
    return 'sent';
  }

  on(listener: (event: SessionEvent) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }

  onDisconnect(listener: () => void): void {
    this.disconnected = listener;
  }

  async abort(): Promise<void> {
    this.aborts++;
  }

  async disconnect(): Promise<void> {
    this.disconnects++;
    this.disconnected?.();
  }

  emit(event: Event): void {
    const envelope = {
      id: `event-${++this.nextEventId}`,
      parentId: null,
      timestamp: '2026-11-18T00:00:00Z',
      ephemeral: true as const,
    };
    this.listener?.({ ...envelope, ...event });
  }

  finish(content = 'done'): void {
    this.emit({
      type: 'assistant.message',
      data: { content, messageId: 'response' },
    });
    this.emit({ type: 'session.idle', data: {} });
  }

  tool(id: string): void {
    this.emit({
      type: 'external_tool.requested',
      data: {
        requestId: `request-${id}`,
        toolCallId: id,
        sessionId: 'session',
        toolName: 'weather',
        arguments: { city: 'Kyiv' },
      },
    });
  }
}

class FakeClient implements CopilotSdkClient {
  readonly sessions: FakeSession[] = [];
  readonly modelKeys: string[] = [];
  readonly created = deferred<FakeSession>();
  starts = 0;
  stops = 0;
  connected = false;
  createError?: Error;
  beforeCreate?: () => Promise<void>;
  onSend = (session: FakeSession): void => session.finish();
  onToolResult?: (session: FakeSession) => void;

  readonly factory = () => this;

  isConnected(): boolean {
    return this.connected;
  }

  async start(): Promise<void> {
    this.starts++;
    this.connected = true;
  }

  async stop(): Promise<void> {
    this.stops++;
    this.connected = false;
  }

  async createSession(config: SessionConfig): Promise<FakeSession> {
    if (this.createError) throw this.createError;
    await this.beforeCreate?.();
    const session = new FakeSession(config, this);
    this.sessions.push(session);
    this.created.resolve(session);
    return session;
  }

  async listModels(apiKey: string): ReturnType<CopilotSdkClient['listModels']> {
    this.modelKeys.push(apiKey);
    return [
      {
        id: 'test-model',
        name: 'Test model',
        capabilities: {
          limits: {
            max_context_window_tokens: 1000000,
            max_output_tokens: 128000,
          },
        },
      },
    ];
  }
}

const credentials = { apiKey: 'caller-token' };
const hello: Message[] = [
  { role: 'system', content: 'Be concise' },
  { role: 'user', content: 'Hello' },
];
const tools: LlmTool[] = [
  {
    name: 'weather',
    description: 'Get weather',
    inputSchema: { type: 'object' },
  },
];

function value<T, E extends Error>(result: Result<T, E>): T {
  if (!result.ok) throw result.error;
  return result.value;
}

function error<T, E extends Error>(result: Result<T, E>): E {
  if (result.ok) assert.fail('Expected an error result');
  return result.error;
}

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of stream) items.push(item);
  return items;
}

test('starts one runtime lazily, keeps separate sessions and stops when the last client disposes', async () => {
  const client = new FakeClient();
  const first = new CopilotProvider({ model: 'test-model' }, client.factory);
  const second = new CopilotProvider({}, client.factory);
  assert.equal(client.starts, 0);
  await Promise.all([
    first.chat(hello, [], credentials),
    second.chat(hello, [], credentials),
  ]);
  assert.equal(client.starts, 1);
  assert.equal(client.sessions.length, 2);
  await first.dispose();
  assert.equal(client.sessions[0].disconnects, 1);
  assert.equal(client.stops, 0);
  assert.equal(
    value(await second.chat(hello, [], credentials)).content,
    'done',
  );
  await second.dispose();
  await second.dispose();
  assert.equal(client.sessions[1].disconnects, 1);
  assert.equal(client.stops, 1);
});

test('chat keeps every message of a response split into chunks', async (t) => {
  const client = new FakeClient();
  client.onSend = (session) => {
    for (const [chunkIndex, content] of [
      'First part. ',
      'Second part.',
    ].entries()) {
      session.emit({
        type: 'assistant.message_delta',
        data: { messageId: `m${chunkIndex}`, deltaContent: content },
      });
      session.emit({
        type: 'assistant.message',
        data: {
          content,
          messageId: `m${chunkIndex}`,
          apiCallId: 'call',
          chunkCount: 2,
          chunkIndex,
        },
      });
    }
    session.emit({ type: 'session.idle', data: {} });
  };
  const provider = new CopilotProvider({}, client.factory);
  t.after(() => provider.dispose());
  assert.equal(
    value(await provider.chat(hello, [], credentials)).content,
    'First part. Second part.',
  );
  const streamed = (await collect(provider.streamChat(hello, [], credentials)))
    .map((chunk) => value(chunk).content)
    .join('');
  assert.equal(streamed, 'First part. Second part.');
});

test('reuses the session and rewinds each new turn before rendering the supplied messages', async (t) => {
  const client = new FakeClient();
  const provider = new CopilotProvider({ model: 'test-model' }, client.factory);
  t.after(() => provider.dispose());
  value(await provider.chat(hello, [], credentials));
  const next = [
    ...hello,
    { role: 'assistant', content: 'Earlier' },
    { role: 'user', content: 'Again' },
  ] satisfies Message[];
  value(
    await provider.chat(next, [], { ...credentials, promptCaching: false }),
  );
  value(await provider.chat(hello, [], credentials));
  assert.equal(client.sessions.length, 1);
  const [session] = client.sessions;
  assert.deepEqual(session.rewinds, ['event-1', 'event-4']);
  assert.deepEqual(session.config.systemMessage, {
    mode: 'replace',
    content: 'Be concise',
  });
  assert.deepEqual(session.config.availableTools, []);
  assert.equal(session.config.enableSessionStore, false);
  assert.equal(session.config.model, 'test-model');
  assert.equal(session.prompts[1], JSON.stringify(next.slice(1)));
});

test('replaces the session when system instructions, tools, model or token change', async (t) => {
  const client = new FakeClient();
  const provider = new CopilotProvider({ model: 'test-model' }, client.factory);
  t.after(() => provider.dispose());
  const changed: Message[] = [
    { role: 'system', content: 'Be detailed' },
    hello[1],
  ];
  value(await provider.chat(hello, [], credentials));
  value(await provider.chat(changed, [], credentials));
  value(await provider.chat(changed, tools, credentials));
  value(
    await provider.chat(changed, tools, {
      ...credentials,
      model: 'other-model',
    }),
  );
  value(
    await provider.chat(changed, tools, {
      apiKey: 'next-token',
      model: 'other-model',
    }),
  );
  assert.deepEqual(
    client.sessions.map(({ disconnects }) => disconnects),
    [1, 1, 1, 1, 0],
  );
  assert.equal(client.sessions[2].config.tools?.[0].handler, undefined);
  assert.equal(client.sessions[3].config.model, 'other-model');
  assert.equal(client.sessions[4].config.gitHubToken, 'next-token');
});

test('runs concurrent calls FIFO and removes a canceled queued call', async (t) => {
  const client = new FakeClient();
  const provider = new CopilotProvider({}, client.factory);
  t.after(() => provider.dispose());
  client.onSend = (session) => {
    if (session.prompts.length > 1) session.finish();
  };
  const prompt = (content: string): Message[] => [{ role: 'user', content }];
  const controller = new AbortController();
  const first = provider.chat(prompt('first'), [], credentials);
  const canceled = provider.chat(prompt('canceled'), [], {
    ...credentials,
    signal: controller.signal,
  });
  const third = provider.chat(prompt('third'), [], credentials);
  const session = await client.created.promise;
  await session.sent.promise;
  controller.abort();
  assert.equal(error(await canceled).code, 'ABORTED');
  assert.deepEqual(session.prompts, [JSON.stringify(prompt('first'))]);
  session.finish();
  value(await first);
  value(await third);
  assert.deepEqual(
    session.prompts,
    ['first', 'third'].map((text) => JSON.stringify(prompt(text))),
  );
});

test('returns a batch of external tools and submits matching results to the same turn', async (t) => {
  const client = new FakeClient();
  const provider = new CopilotProvider({}, client.factory);
  t.after(() => provider.dispose());
  const external = deferred<FakeSession>();
  client.onSend = (session) => {
    session.emit({
      type: 'assistant.message',
      data: {
        content: '',
        messageId: 'response',
        toolRequests: ['a', 'b'].map((toolCallId) => ({
          toolCallId,
          name: 'weather',
        })),
      },
    });
    session.tool('a');
    external.resolve(session);
  };
  client.onToolResult = (session) => {
    if (session.results.length === 2) session.finish('Sunny');
  };
  const stream = collect(provider.streamChat(hello, tools, credentials));
  const session = await external.promise;
  await setImmediate();
  session.tool('b');
  const call = value((await stream)[0]);
  assert.equal(call.finishReason, 'tool_calls');
  assert.deepEqual(
    call.toolCalls,
    ['a', 'b'].map((id) => ({
      id,
      name: 'weather',
      arguments: { city: 'Kyiv' },
    })),
  );
  const messages: Message[] = [
    ...hello,
    { role: 'tool', tool_call_id: 'a', content: '17 C' },
    { role: 'tool', tool_call_id: 'b', content: 'sunny' },
  ];
  assert.equal(
    value(await provider.chat(messages, tools, credentials)).content,
    'Sunny',
  );
  assert.equal(session.prompts.length, 1);
  assert.deepEqual(session.rewinds, []);
  assert.deepEqual(session.results, [
    { requestId: 'request-b', result: 'sunny' },
    { requestId: 'request-a', result: '17 C' },
  ]);
});

test('aborts an abandoned tool round and rewinds when the next call is a new turn', async (t) => {
  const client = new FakeClient();
  const provider = new CopilotProvider({}, client.factory);
  t.after(() => provider.dispose());
  client.onSend = (session) => {
    session.tool('abandoned');
  };
  const first = value(await provider.chat(hello, tools, credentials));
  assert.equal(first.finishReason, 'tool_calls');
  client.onSend = (session) => session.finish();
  value(await provider.chat(hello, tools, credentials));
  assert.equal(client.sessions.length, 1);
  assert.deepEqual(client.sessions[0].rewinds, ['event-1']);
  assert.equal(client.sessions[0].aborts, 1);
});

test('streams deltas and aggregates per-step input, output and cache usage', async (t) => {
  const client = new FakeClient();
  const provider = new CopilotProvider({}, client.factory);
  t.after(() => provider.dispose());
  client.onSend = (session) => {
    for (const deltaContent of ['Hel', 'lo']) {
      session.emit({
        type: 'assistant.message_delta',
        data: { deltaContent, messageId: 'response' },
      });
    }
    session.emit({
      type: 'assistant.usage',
      data: {
        model: 'test-model',
        inputTokens: 10,
        outputTokens: 2,
        cacheReadTokens: 3,
      },
    });
    session.emit({
      type: 'assistant.usage',
      data: {
        model: 'test-model',
        inputTokens: 4,
        outputTokens: 1,
        cacheReadTokens: 2,
        cacheWriteTokens: 6,
      },
    });
    session.finish('Hello');
  };
  const chunks = (
    await collect(provider.streamChat(hello, [], credentials))
  ).map(value);
  assert.deepEqual(chunks, [
    { content: 'Hel' },
    { content: 'lo' },
    {
      content: '',
      finishReason: 'stop',
      usage: {
        promptTokens: 14,
        completionTokens: 3,
        totalTokens: 17,
        cachedInputTokens: 5,
        cacheCreationInputTokens: 6,
      },
    },
  ]);
  assert.deepEqual(
    value(await provider.chat(hello, [], credentials)).usage,
    chunks[2].usage,
  );
});

test('returns CREDENTIALS_REJECTED for missing, invalid and expired tokens', async (t) => {
  const client = new FakeClient();
  const provider = new CopilotProvider({}, client.factory);
  t.after(() => provider.dispose());
  assert.equal(error(await provider.chat(hello)).code, 'CREDENTIALS_REJECTED');
  assert.equal(client.starts, 0);
  client.createError = Object.assign(new Error('invalid token'), {
    code: -32603,
  });
  assert.equal(
    error(await provider.chat(hello, [], credentials)).code,
    'CREDENTIALS_REJECTED',
  );
  client.createError = undefined;
  client.onSend = (session) => {
    session.emit({
      type: 'session.error',
      data: { errorType: 'authentication', message: 'credentials expired' },
    });
  };
  assert.equal(
    error(await provider.chat(hello, [], credentials)).code,
    'CREDENTIALS_REJECTED',
  );
  assert.equal(client.sessions[0].prompts.length, 1);
});

test('withholds token echoes in SDK failures and emits no log', async (t) => {
  const client = new FakeClient();
  const provider = new CopilotProvider({}, client.factory);
  t.after(() => provider.dispose());
  const logs = (['log', 'warn', 'error', 'info', 'debug'] as const).map(
    (method) => t.mock.method(console, method, () => {}),
  );
  class ResponseError extends Error {}
  const failure = new ResponseError(`Sensitive header: ${credentials.apiKey}`);
  client.createError = Object.assign(failure, { code: -32603 });
  const result = error(await provider.chat(hello, [], credentials));
  assert.equal(result.code, 'COPILOT_ERROR');
  assert.equal(result.message, 'Copilot SDK ResponseError (-32603)');
  assert.equal(result.cause, undefined);
  assert.ok(logs.every((log) => log.mock.callCount() === 0));
});

test('aborts a running turn and a suspended tool round', async (t) => {
  const client = new FakeClient();
  const provider = new CopilotProvider({}, client.factory);
  t.after(() => provider.dispose());
  const running = new AbortController();
  client.onSend = () => {};
  const result = provider.chat(hello, [], {
    ...credentials,
    signal: running.signal,
  });
  const session = await client.created.promise;
  await session.sent.promise;
  running.abort(new Error('caller cancellation'));
  assert.equal(error(await result).code, 'ABORTED');
  assert.equal(session.aborts, 1);
  assert.equal(session.disconnects, 1);
  const suspended = new AbortController();
  client.onSend = (current) => current.tool('pending');
  value(
    await provider.chat(hello, tools, {
      ...credentials,
      signal: suspended.signal,
    }),
  );
  suspended.abort();
  assert.equal(client.sessions[1].aborts, 1);
  assert.equal(client.sessions[1].disconnects, 1);
});

test('restarts the runtime and replaces sessions after transport disconnect', async (t) => {
  const client = new FakeClient();
  const provider = new CopilotProvider({}, client.factory);
  t.after(() => provider.dispose());
  client.onSend = () => {};
  const interrupted = provider.chat(hello, [], credentials);
  const current = await client.created.promise;
  await current.sent.promise;
  client.connected = false;
  await current.disconnect();
  assert.equal(error(await interrupted).code, 'COPILOT_ERROR');
  client.onSend = (session) => session.finish();
  value(await provider.chat(hello, [], credentials));
  assert.equal(client.starts, 2);
  assert.equal(client.sessions.length, 2);
});

test('closes a session that finishes opening after an abort before serving the next call', async (t) => {
  const client = new FakeClient();
  const provider = new CopilotProvider({}, client.factory);
  t.after(() => provider.dispose());
  const opening = deferred<void>();
  const release = deferred<void>();
  let creations = 0;
  client.beforeCreate = async () => {
    creations++;
    opening.resolve();
    await release.promise;
  };
  const controller = new AbortController();
  const first = provider.chat(hello, [], {
    ...credentials,
    signal: controller.signal,
  });
  await opening.promise;
  const second = provider.chat(hello, [], credentials);
  controller.abort();
  assert.equal(error(await first).code, 'ABORTED');
  await setImmediate();
  assert.equal(creations, 1);
  release.resolve();
  value(await second);
  assert.equal(creations, 2);
  assert.equal(client.sessions[0].disconnects, 1);
  assert.deepEqual(client.sessions[0].prompts, []);
});

test('routes model discovery through the shared runtime with each call token', async (t) => {
  const client = new FakeClient();
  const provider = new CopilotProvider({}, client.factory);
  t.after(() => provider.dispose());
  assert.equal(error(await provider.getModels()).code, 'CREDENTIALS_REJECTED');
  assert.deepEqual(value(await provider.getModels(credentials)), [
    {
      id: 'test-model',
      displayName: 'Test model',
      provider: 'copilot',
      contextLength: 1000000,
      maxOutputTokens: 128000,
    },
  ]);
  value(await provider.getModels({ apiKey: 'next-token' }));
  assert.deepEqual(client.modelKeys, [credentials.apiKey, 'next-token']);
  assert.equal(client.starts, 1);
  assert.equal(client.sessions.length, 0);
});

test('preserves a textless token-limit finish in chat and streaming', async (t) => {
  const client = new FakeClient();
  const provider = new CopilotProvider({}, client.factory);
  t.after(() => provider.dispose());
  client.onSend = (session) => {
    session.emit({
      type: 'assistant.usage',
      data: { model: 'test-model', finishReason: 'length' },
    });
    session.emit({ type: 'session.idle', data: {} });
  };
  assert.equal(
    value(await provider.chat(hello, undefined, credentials)).finishReason,
    'length',
  );
  const chunks = [];
  for await (const chunk of provider.streamChat(
    hello,
    undefined,
    credentials,
  )) {
    chunks.push(value(chunk));
  }
  assert.equal(
    chunks.find((chunk) => chunk.finishReason)?.finishReason,
    'length',
  );
});

test('retries rate limits using the SDK retry hint and resets rejected stream text', async (t) => {
  const client = new FakeClient();
  const provider = new CopilotProvider({}, client.factory);
  t.after(() => provider.dispose());
  const observations: ThrottleEvent[] = [];
  setThrottleObserver((event) => observations.push(event));
  t.after(() => setThrottleObserver(undefined));
  client.onSend = (session) => {
    if (client.sessions.length > 1) {
      session.finish('Accepted');
      return;
    }
    session.emit({
      type: 'assistant.message_delta',
      data: { deltaContent: 'Rejected', messageId: 'response' },
    });
    session.emit({
      type: 'session.error',
      data: {
        errorType: 'rate_limit',
        message: 'rate limited',
        eligibleForAutoSwitch: true,
      },
    });
    session.emit({
      type: 'auto_mode_switch.requested',
      data: { requestId: 'switch', retryAfterSeconds: 0 },
    });
  };
  const chunks = (
    await collect(provider.streamChat(hello, [], credentials))
  ).map(value);
  assert.deepEqual(chunks, [
    { content: 'Rejected' },
    { content: '', reset: true },
    { content: 'Accepted', finishReason: 'stop', usage: undefined },
  ]);
  assert.equal(observations[0].retryAfterSeconds, 0);
  assert.equal(observations[0].willRetry, true);
  assert.ok(!observations[0].key.includes(credentials.apiKey));
});

test('uses shared backoff for quota without a retry hint and allows cancellation', async (t) => {
  const client = new FakeClient();
  const provider = new CopilotProvider({}, client.factory);
  t.after(() => provider.dispose());
  const controller = new AbortController();
  const observations: ThrottleEvent[] = [];
  setThrottleObserver((event) => {
    observations.push(event);
    controller.abort();
  });
  t.after(() => setThrottleObserver(undefined));
  client.onSend = (session) => {
    session.emit({
      type: 'session.error',
      data: { errorType: 'quota', message: 'quota reached' },
    });
  };
  const result = await provider.chat(hello, [], {
    apiKey: 'quota-test-token',
    signal: controller.signal,
  });
  assert.equal(error(result).code, 'ABORTED');
  assert.equal(observations[0].waitMs, 2000);
  assert.equal(observations[0].willRetry, true);
  assert.equal(client.sessions.length, 1);
});
