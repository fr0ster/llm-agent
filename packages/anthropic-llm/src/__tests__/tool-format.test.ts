import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type LLMResponse,
  type Message,
  staticApiKey,
} from '@mcp-abap-adt/llm-agent';
import { AnthropicProvider } from '../anthropic-provider.js';

const provider = () =>
  new AnthropicProvider({ model: 'test', credential: staticApiKey('test') });
const schema = { type: 'object', properties: { query: { type: 'string' } } };
const tools = [
  {
    type: 'function',
    function: { name: 'search', description: 'Search', parameters: schema },
  },
  { name: 'lookup', description: 'Lookup', inputSchema: schema },
];
const history: Message[] = [
  { role: 'system', content: 'Instructions' },
  { role: 'user', content: 'Find it' },
  {
    role: 'assistant',
    content: 'Searching',
    tool_calls: [
      {
        id: 'one',
        type: 'function',
        function: { name: 'search', arguments: '{"query":"a"}' },
      },
      {
        id: 'two',
        type: 'function',
        function: { name: 'lookup', arguments: '{}' },
      },
    ],
  },
  { role: 'tool', tool_call_id: 'one', content: 'first' },
  { role: 'tool', tool_call_id: 'two', content: 'second' },
];
const expectedMessages = [
  { role: 'user', content: 'Find it' },
  {
    role: 'assistant',
    content: [
      { type: 'text', text: 'Searching' },
      { type: 'tool_use', id: 'one', name: 'search', input: { query: 'a' } },
      { type: 'tool_use', id: 'two', name: 'lookup', input: {} },
    ],
  },
  {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 'one', content: 'first' },
      { type: 'tool_result', tool_use_id: 'two', content: 'second' },
    ],
  },
];
interface RequestBody {
  system: string;
  tools: object[];
  messages: object[];
}

async function assertHistoryRequest(messages: Message[], expected: object[]) {
  const original = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const body = JSON.parse(await request.text()) as RequestBody & {
      stream?: boolean;
    };
    assert.deepEqual(body.messages, expected);
    requests++;
    return body.stream
      ? new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n')
      : Response.json({ content: [], stop_reason: 'end_turn' });
  };
  try {
    const p = provider();
    p.client.defaults.adapter = 'fetch';
    await p.chat(messages);
    for await (const chunk of p.streamChat(messages)) void chunk;
    assert.equal(requests, 2);
  } finally {
    globalThis.fetch = original;
  }
}

test('malformed and empty arguments reach HTTP safely in both history shapes', async () => {
  for (const argumentsJson of ['{"query":', '']) {
    for (const normalized of [false, true]) {
      const assistant = {
        role: 'assistant' as const,
        content: null,
        ...(normalized
          ? {
              toolCalls: [
                { id: 'a', name: 'search', arguments: argumentsJson },
              ],
            }
          : {
              tool_calls: [
                {
                  id: 'a',
                  type: 'function' as const,
                  function: { name: 'search', arguments: argumentsJson },
                },
              ],
            }),
      };
      await assertHistoryRequest(
        [assistant],
        [
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'a',
                name: 'search',
                input:
                  argumentsJson === ''
                    ? {}
                    : { _unparsed_arguments: argumentsJson },
              },
            ],
          },
        ],
      );
    }
  }
});

test('tool turn collects interleaved results in tool-use order before text and stops at the next assistant', async () => {
  const assistant = history[2];
  assert.ok(assistant);
  await assertHistoryRequest(
    [
      { role: 'tool', tool_call_id: 'orphan', content: 'Standalone orphan' },
      assistant,
      { role: 'tool', tool_call_id: 'two', content: 'second' },
      { role: 'user', content: 'Please summarize' },
      { role: 'tool', tool_call_id: 'foreign', content: 'Foreign result' },
      { role: 'tool', tool_call_id: 'one', content: 'first' },
      { role: 'user', content: 'Keep it short' },
      { role: 'assistant', content: 'Summary' },
      { role: 'tool', tool_call_id: 'one', content: 'Stale result' },
    ],
    [
      { role: 'user', content: 'Standalone orphan' },
      expectedMessages[1],
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'one', content: 'first' },
          { type: 'tool_result', tool_use_id: 'two', content: 'second' },
          { type: 'text', text: 'Please summarize' },
          { type: 'text', text: 'Foreign result' },
          { type: 'text', text: 'Keep it short' },
        ],
      },
      { role: 'assistant', content: 'Summary' },
      { role: 'user', content: 'Stale result' },
    ],
  );
});
function checkRequest(body: RequestBody) {
  assert.equal(body.system, 'Instructions');
  assert.deepEqual(body.tools, [
    { name: 'search', description: 'Search', input_schema: schema },
    { name: 'lookup', description: 'Lookup', input_schema: schema },
  ]);
  assert.deepEqual(body.messages, expectedMessages);
}

test('chat converts tools and history and returns normalized tool calls', async () => {
  const p = provider();
  // Axios uses its fetch adapter so both request paths exercise fake fetch.
  p.client.defaults.adapter = 'fetch';
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    checkRequest(JSON.parse(await request.text()) as RequestBody);
    return Response.json({
      content: [
        { type: 'text', text: 'Checking' },
        {
          type: 'tool_use',
          id: 'three',
          name: 'search',
          input: { query: 'b' },
        },
      ],
      stop_reason: 'tool_use',
    });
  };
  try {
    const response = await p.chat(history, tools);
    assert.equal(response.content, 'Checking');
    assert.equal(response.finishReason, 'tool_calls');
    assert.deepEqual(response.toolCalls, [
      { index: 0, id: 'three', name: 'search', arguments: '{"query":"b"}' },
    ]);
  } finally {
    globalThis.fetch = original;
  }
});

test('stream converts tools/history and assembles fragmented parallel tool calls', async () => {
  const original = globalThis.fetch;
  const events = [
    {
      type: 'content_block_start',
      index: 1,
      content_block: {
        type: 'tool_use',
        id: 'three',
        name: 'search',
        input: {},
      },
    },
    {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: '{"query":' },
    },
    {
      type: 'content_block_start',
      index: 2,
      content_block: {
        type: 'tool_use',
        id: 'four',
        name: 'lookup',
        input: {},
      },
    },
    {
      type: 'content_block_delta',
      index: 2,
      delta: { type: 'input_json_delta', partial_json: '{}' },
    },
    { type: 'content_block_stop', index: 2 },
    {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: '"b"}' },
    },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
  ];
  const encoded = new TextEncoder().encode(
    events
      .map(
        (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join(''),
  );
  globalThis.fetch = async (_input, init) => {
    checkRequest(JSON.parse(String(init?.body)) as RequestBody);
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          // Split inside event names and JSON strings, including across reads.
          for (let i = 0; i < encoded.length; i += 13)
            controller.enqueue(encoded.slice(i, i + 13));
          controller.close();
        },
      }),
    );
  };
  try {
    const calls = new Map<
      number,
      { id: string; name: string; arguments: string }
    >();
    let finish: string | undefined;
    for await (const chunk of provider().streamChat(history, tools)) {
      finish = chunk.finishReason ?? finish;
      for (const delta of chunk.toolCalls ?? []) {
        const call = calls.get(delta.index) ?? {
          id: '',
          name: '',
          arguments: '',
        };
        call.id += delta.id ?? '';
        call.name += delta.name ?? '';
        call.arguments += delta.arguments ?? '';
        calls.set(delta.index, call);
      }
    }
    assert.equal(finish, 'tool_calls');
    assert.deepEqual(
      [...calls.values()],
      [
        { id: 'three', name: 'search', arguments: '{"query":"b"}' },
        { id: 'four', name: 'lookup', arguments: '{}' },
      ],
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('chat and stream surface HTTP status, error type, and message', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json(
      {
        error: {
          type: 'invalid_request_error',
          message: 'Invalid tool schema',
        },
      },
      { status: 400 },
    );
  try {
    const p = provider();
    p.client.defaults.adapter = 'fetch';
    await assert.rejects(
      p.chat(history, tools),
      /HTTP 400.*invalid_request_error.*Invalid tool schema/,
    );
    await assert.rejects(async () => {
      for await (const chunk of p.streamChat(history, tools)) void chunk;
    }, /HTTP 400.*invalid_request_error.*Invalid tool schema/);
  } finally {
    globalThis.fetch = original;
  }
});

test('stream error events preserve the Anthropic error type', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      'event: error\ndata: {"error":{"type":"overloaded_error","message":"Busy"}}\n\n',
    );
  try {
    await assert.rejects(async () => {
      const chunks: LLMResponse[] = [];
      for await (const chunk of provider().streamChat([])) chunks.push(chunk);
    }, /overloaded_error: Busy/);
  } finally {
    globalThis.fetch = original;
  }
});

test('normalized history and tool blocks without JSON deltas retain their input', async () => {
  const original = globalThis.fetch;
  const assistant = {
    role: 'assistant' as const,
    content: null,
    toolCalls: [{ id: 'old', name: 'search', arguments: { query: 'old' } }],
  };
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as RequestBody;
    assert.deepEqual(body.messages, [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'old',
            name: 'search',
            input: { query: 'old' },
          },
        ],
      },
    ]);
    const events = [
      {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          id: 'new',
          name: 'lookup',
          input: {},
        },
      },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
    ];
    return new Response(
      events
        .map(
          (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        )
        .join(''),
    );
  };
  try {
    let argumentsJson = '';
    for await (const chunk of provider().streamChat([assistant])) {
      for (const call of chunk.toolCalls ?? [])
        argumentsJson += call.arguments ?? '';
    }
    assert.equal(argumentsJson, '{}');
  } finally {
    globalThis.fetch = original;
  }
});
