import assert from 'node:assert/strict';
import { it } from 'node:test';
import {
  type LLMCallOptions,
  type Message,
  staticApiKey,
  type UsageInput,
} from '@mcp-abap-adt/llm-agent';
import { AnthropicProvider } from '../anthropic-provider.js';

const messages: Message[] = [
  { role: 'system', content: 'Stable instructions' },
  { role: 'user', content: 'Question' },
];
const tools = [{ name: 'search', inputSchema: { type: 'object' } }];
const wireUsage = {
  input_tokens: 7,
  output_tokens: 3,
  cache_read_input_tokens: 40,
  cache_creation_input_tokens: 20,
};
const normalized = {
  promptTokens: 67,
  completionTokens: 3,
  totalTokens: 70,
  cachedInputTokens: 40,
  cacheCreationInputTokens: 20,
};

type Setting = LLMCallOptions['promptCaching'];
for (const stream of [false, true]) {
  for (const configured of [undefined, true, false] as const) {
    for (const override of [undefined, true, false] as const) {
      it(`automatic caching stream=${stream} config=${configured} override=${override}`, async (t) => {
        const records: UsageInput[] = [];
        const provider = new AnthropicProvider({
          maxTokens: 100,
          model: 'test-model',
          credential: staticApiKey('test'),
          promptCaching: configured,
          usage: {
            record: (r) => {
              records.push(r);
            },
            with() {
              return this;
            },
          },
        });
        let body: {
          cache_control?: { type: string; ttl?: string };
          system?: string;
        } = {};
        t.mock.method(
          provider.client,
          'post',
          async (_url: string, value: typeof body) => {
            body = value;
            return { data: { content: [], usage: wireUsage } };
          },
        );
        t.mock.method(
          globalThis,
          'fetch',
          async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
            body = JSON.parse(String(init?.body));
            return new Response(
              `event: message_start\ndata: ${JSON.stringify({ message: { usage: wireUsage } })}\n\n`,
            );
          },
        );
        const snapshot = JSON.stringify({ messages, tools });
        if (stream) {
          const chunks = [];
          for await (const chunk of provider.streamChat(messages, tools, {
            promptCaching: override,
          }))
            chunks.push(chunk);
          assert.deepEqual(chunks[0].usage, normalized);
        } else {
          assert.deepEqual(
            (await provider.chat(messages, tools, { promptCaching: override }))
              .usage,
            normalized,
          );
        }
        const effective: Setting = override ?? configured ?? true;
        assert.deepEqual(
          body.cache_control,
          effective ? { type: 'ephemeral' } : undefined,
        );
        assert.equal(body.system, 'Stable instructions');
        assert.equal(JSON.stringify({ messages, tools }), snapshot);
        const record = records[0];
        assert.equal(record.kind, 'llm.call');
        if (record.kind === 'llm.call') {
          assert.equal(record.cachedInputTokens, 40);
          assert.equal(record.cacheCreationInputTokens, 20);
          assert.equal(record.inputTokens, 7);
          assert.equal(record.tokensSource, 'provider');
        }
      });
    }
  }
}

it('keeps creation usage on an early stream close without inventing output tokens', async (t) => {
  const records: UsageInput[] = [];
  const provider = new AnthropicProvider({
    maxTokens: 100,
    model: 'test-model',
    credential: staticApiKey('test'),
    usage: {
      record: (r) => {
        records.push(r);
      },
      with() {
        return this;
      },
    },
  });
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(
        'event: message_start\ndata: {"message":{"usage":{"cache_creation_input_tokens":50}}}\n\n',
      ),
  );
  for await (const _chunk of provider.streamChat(messages)) break;
  const record = records[0];
  assert.equal(record.kind, 'llm.call');
  if (record.kind === 'llm.call') {
    assert.equal(record.cacheCreationInputTokens, 50);
    assert.equal(record.outputTokens, undefined);
    assert.equal(record.tokensSource, 'provider');
    assert.equal(record.outcome, 'aborted');
  }
});
