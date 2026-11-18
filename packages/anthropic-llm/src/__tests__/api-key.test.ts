import assert from 'node:assert/strict';
import { test } from 'node:test';
import { staticApiKey } from '@mcp-abap-adt/llm-agent';
import { AnthropicProvider } from '../anthropic-provider.js';

test('uses the per-call key across chat, streaming and model discovery', async (t) => {
  const provider = new AnthropicProvider({
    maxTokens: 100,
    model: 'test-model',
    credential: staticApiKey('configured-key'),
  });
  const seen: string[] = [];
  provider.client.defaults.adapter = async (config) => {
    seen.push(String(config.headers.get('x-api-key')));
    return {
      config,
      status: 200,
      statusText: 'OK',
      headers: {},
      data: {
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        data: [],
      },
    };
  };
  t.mock.method(
    globalThis,
    'fetch',
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(String(new Headers(init?.headers).get('x-api-key')));
      return new Response('data: [DONE]\n\n');
    },
  );
  const messages = [{ role: 'user', content: 'hello' }] satisfies Parameters<
    typeof provider.chat
  >[0];
  const override = { apiKey: 'call-key' };
  await Promise.all([
    provider.chat(messages, [], override),
    provider.chat(messages),
  ]);
  assert.deepEqual(seen.splice(0).sort(), ['call-key', 'configured-key']);

  for (const options of [override, undefined]) {
    for await (const _chunk of provider.streamChat(messages, [], options)) {
      // Drain the stream.
    }
    await provider.getModels(options);
  }
  assert.deepEqual(seen, [
    'call-key',
    'call-key',
    'configured-key',
    'configured-key',
  ]);
  assert.equal(provider.client.defaults.headers.common['x-api-key'], undefined);
});

test('withholds an error response echoing a per-call key', async (t) => {
  const provider = new AnthropicProvider({
    maxTokens: 100,
    model: 'test-model',
    credential: staticApiKey('configured-key'),
  });
  const apiKey = 'sensitive-test-key';
  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response(apiKey, { status: 401 }),
  );
  await assert.rejects(
    async () => {
      for await (const _chunk of provider.streamChat([], [], { apiKey })) {
        // Drain the stream.
      }
    },
    (error: Error) =>
      !error.message.includes(apiKey) && error.cause === undefined,
  );
});
