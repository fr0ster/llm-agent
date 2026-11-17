import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Message, staticApiKey } from '@mcp-abap-adt/llm-agent';
import { AnthropicProvider } from '../anthropic-provider.js';

for (const stream of [false, true]) {
  for (const promptCaching of [undefined, false, true]) {
    test(`all system messages reach the request in order: stream=${stream}, caching=${JSON.stringify(promptCaching)}`, async (t) => {
      const provider = new AnthropicProvider({
        model: 'test-model',
        credential: staticApiKey('test'),
      });
      const messages: Message[] = [
        { role: 'system', content: 'First system sentinel' },
        { role: 'user', content: 'Question' },
        { role: 'system', content: 'Second system sentinel' },
        { role: 'assistant', content: 'Reply' },
        { role: 'system', content: 'Summary sentinel' },
      ];
      let body: {
        system?: string;
        messages?: { role: string; content: string }[];
        cache_control?: { type: string; ttl?: string };
      } = {};
      t.mock.method(
        provider.client,
        'post',
        async (_url: string, value: typeof body) => {
          body = value;
          return { data: { content: [], stop_reason: 'end_turn' } };
        },
      );
      t.mock.method(
        globalThis,
        'fetch',
        async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
          body = JSON.parse(String(init?.body));
          return new Response('event: message_stop\ndata: {}\n\n');
        },
      );
      const snapshot = structuredClone(messages);
      if (stream) {
        for await (const _chunk of provider.streamChat(messages, [], {
          promptCaching,
        })) {
          // Consume the response to issue the request.
        }
      } else {
        await provider.chat(messages, [], { promptCaching });
      }
      assert.equal(
        body.system,
        'First system sentinel\n\nSecond system sentinel\n\nSummary sentinel',
      );
      assert.deepEqual(body.messages, [
        { role: 'user', content: 'Question' },
        { role: 'assistant', content: 'Reply' },
      ]);
      assert.deepEqual(
        body.cache_control,
        promptCaching === false ? undefined : { type: 'ephemeral' },
      );
      assert.deepEqual(messages, snapshot);
    });
  }
}
