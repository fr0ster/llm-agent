import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Message, staticApiKey } from '@mcp-abap-adt/llm-agent';
import { AnthropicProvider, type WireMessage } from '../anthropic-provider.js';

const id = 'ext:f93572aa19e33895';
const wireId = 'toolu_history_0';
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

function validateToolIds(messages: WireMessage[]): string[] {
  const calls: string[] = [];
  const results: string[] = [];
  for (const message of messages) {
    if (typeof message.content === 'string') continue;
    for (const block of message.content) {
      if (block.type === 'tool_use') calls.push(block.id);
      if (block.type === 'tool_result') results.push(block.tool_use_id);
    }
  }
  for (const toolId of [...calls, ...results]) {
    assert.match(toolId, /^[a-zA-Z0-9_-]+$/);
    assert.doesNotMatch(toolId, /[^a-zA-Z0-9_-]/);
  }
  assert.deepEqual(results, calls);
  return calls;
}

for (const stream of [false, true]) {
  for (const tools of [undefined, [], [definition]]) {
    test(`completed external history has definitions stream=${stream} tools=${tools?.length}`, async () => {
      const provider = new AnthropicProvider({
        maxTokens: 100,
        model: 'test',
        credential: staticApiKey('test'),
      });
      provider.client.defaults.adapter = 'fetch';
      const original = globalThis.fetch;
      const snapshot = structuredClone(history);
      let requests = 0;
      globalThis.fetch = async (input, init) => {
        requests++;
        const request =
          input instanceof Request ? input : new Request(input, init);
        const body = JSON.parse(await request.text()) as {
          messages: WireMessage[];
          tools: { name: string; description?: string; input_schema: object }[];
          tool_choice?: { type: string };
        };
        assert.deepEqual(validateToolIds(body.messages), [wireId]);
        assert.deepEqual(body.messages, [
          { role: 'user', content: 'start' },
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'ASSISTANT_HISTORY_SENTINEL' },
              {
                type: 'tool_use',
                id: wireId,
                name: 'lookup',
                input: { query: 'original' },
              },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: wireId,
                content: 'TOOL_HISTORY_SENTINEL',
              },
              { type: 'text', text: 'continue' },
            ],
          },
        ]);
        assert.deepEqual(
          body.tools.map((tool) => tool.name),
          ['lookup'],
        );
        if (tools?.length) {
          assert.deepEqual(body.tools[0], {
            name: 'lookup',
            description: definition.function.description,
            input_schema: definition.function.parameters,
          });
          assert.equal(body.tool_choice, undefined);
        } else {
          assert.deepEqual(body.tools[0].input_schema, {
            type: 'object',
            properties: {},
          });
          assert.deepEqual(body.tool_choice, { type: 'none' });
        }
        return stream
          ? new Response(
              'event: message_stop\ndata: {"type":"message_stop"}\n\n',
            )
          : Response.json({
              content: [{ type: 'text', text: 'done' }],
              stop_reason: 'end_turn',
            });
      };
      try {
        if (stream) {
          for await (const chunk of provider.streamChat(history, tools))
            void chunk;
        } else {
          assert.equal((await provider.chat(history, tools)).content, 'done');
        }
        assert.equal(requests, 1);
        assert.deepEqual(history, snapshot);
      } finally {
        globalThis.fetch = original;
      }
    });
  }
}

for (const stream of [false, true]) {
  for (const normalized of [false, true]) {
    test(`history IDs avoid collisions and stay deterministic stream=${stream} normalized=${normalized}`, async () => {
      // Includes IDs that a lossy colon replacement would alias, a generated-ID
      // collision appearing later, Unicode and a trailing newline.
      const ids = [
        id,
        'ext_history',
        'toolu_history_0',
        'ext:history',
        'ext/history',
        'ext:雪',
        'valid\n',
        'tc:f93572aa-19e3-4895-a211-f03bb683dc12:0',
        'tc:f93572aa-19e3-4895-a211-f03bb683dc12:1',
        'ext:f93572aa-19e3-4895-a211-f03bb683dc12:0',
      ];
      const calls = ids.map((toolId) => ({
        id: toolId,
        type: 'function' as const,
        function: { name: 'lookup', arguments: '{}' },
      }));
      const assistant = normalized
        ? {
            role: 'assistant' as const,
            content: null,
            toolCalls: calls.map((call) => ({
              id: call.id,
              name: call.function.name,
              arguments: {},
            })),
          }
        : { role: 'assistant' as const, content: null, tool_calls: calls };
      const messages: Message[] = [
        { role: 'user', content: 'start' },
        assistant,
        ...ids.map((toolId) => ({
          role: 'tool' as const,
          tool_call_id: toolId,
          content: `result:${toolId}`,
        })),
      ];
      const snapshot = structuredClone(messages);
      const provider = new AnthropicProvider({
        maxTokens: 100,
        model: 'test',
        credential: staticApiKey('test'),
      });
      provider.client.defaults.adapter = 'fetch';
      const original = globalThis.fetch;
      const captured: string[][] = [];
      globalThis.fetch = async (input, init) => {
        const request =
          input instanceof Request ? input : new Request(input, init);
        const body = JSON.parse(await request.text()) as {
          messages: WireMessage[];
        };
        const mapped = validateToolIds(body.messages);
        assert.equal(new Set(mapped).size, ids.length);
        assert.equal(mapped[1], ids[1]);
        assert.equal(mapped[2], ids[2]);
        assert.notEqual(mapped[0], ids[0]);
        for (const message of body.messages) {
          if (typeof message.content === 'string') continue;
          const results = message.content.filter(
            (block) => block.type === 'tool_result',
          );
          if (results.length)
            assert.deepEqual(
              results.map((block) => block.content),
              ids.map((toolId) => `result:${toolId}`),
            );
        }
        captured.push(mapped);
        return stream
          ? new Response(
              'event: message_stop\ndata: {"type":"message_stop"}\n\n',
            )
          : Response.json({
              content: [{ type: 'text', text: 'done' }],
              stop_reason: 'end_turn',
            });
      };
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          if (stream) {
            for await (const chunk of provider.streamChat(messages)) void chunk;
          } else {
            await provider.chat(messages);
          }
        }
        assert.equal(captured.length, 2);
        assert.deepEqual(captured[0], captured[1]);
        assert.deepEqual(messages, snapshot);
      } finally {
        globalThis.fetch = original;
      }
    });
  }
}
