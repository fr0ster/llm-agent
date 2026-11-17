import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { type Message, staticApiKey } from '@mcp-abap-adt/llm-agent';
import { OpenAIProvider, type OpenAIWireMessage } from '../openai-provider.js';

const id = 'ext:history';
const history: Message[] = [
  { role: 'user', content: 'start' },
  {
    role: 'assistant',
    content: 'ASSISTANT_HISTORY_SENTINEL',
    tool_calls: [
      {
        id,
        type: 'function',
        function: { name: 'lookup', arguments: '{"query":"original"}' },
      },
    ],
  },
  { role: 'tool', tool_call_id: id, content: 'TOOL_HISTORY_SENTINEL' },
  { role: 'user', content: 'continue' },
];
const definition = {
  type: 'function',
  function: {
    name: 'lookup',
    description: 'Original lookup',
    parameters: { type: 'object', properties: { query: { type: 'string' } } },
  },
};

for (const stream of [false, true]) {
  for (const tools of [undefined, [], [definition]]) {
    test(`completed external history reaches the wire stream=${stream} tools=${tools?.length}`, async (t) => {
      const provider = new OpenAIProvider({
        model: 'test',
        credential: staticApiKey('test'),
      });
      let requests = 0;
      const snapshot = structuredClone(history);
      t.mock.method(
        provider.client,
        'post',
        async (
          _url: string,
          body: {
            messages: OpenAIWireMessage[];
            tools?: (typeof definition)[];
          },
        ) => {
          requests++;
          // Chat Completions IDs are opaque strings, including external keys.
          for (const message of body.messages) {
            for (const call of message.tool_calls ?? []) {
              assert.equal(typeof call.id, 'string');
              assert.ok(call.id.length > 0);
            }
            if (message.role === 'tool') {
              assert.equal(message.tool_call_id, id);
            }
          }
          assert.deepEqual(body.messages, snapshot);
          assert.deepEqual(body.tools, tools?.length ? tools : undefined);
          return {
            data: stream
              ? Readable.from([
                  'data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
                ])
              : {
                  choices: [
                    { message: { content: 'done' }, finish_reason: 'stop' },
                  ],
                },
          };
        },
      );
      if (stream) {
        for await (const chunk of provider.streamChat(history, tools))
          void chunk;
      } else {
        assert.equal((await provider.chat(history, tools)).content, 'done');
      }
      assert.equal(requests, 1);
      assert.deepEqual(history, snapshot);
    });
  }
}
