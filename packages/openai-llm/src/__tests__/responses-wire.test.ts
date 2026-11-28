import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LlmError, type Message } from '@mcp-abap-adt/llm-agent';
import { requestBody as chatRequest } from '../chat-wire.js';
import {
  chatResponse,
  type OpenAIResponse,
  type OpenAIResponseEvent,
  OpenAIResponsesStreamMapper,
  requestBody,
} from '../responses-wire.js';

const model = 'gpt-6.1-sol';
const messages: Message[] = [
  { role: 'system', content: 'Keep it short.' },
  { role: 'user', content: 'Look up the result.' },
];
const tools = [
  {
    type: 'function',
    function: {
      name: 'lookup',
      description: 'Look up the result',
      parameters: { type: 'object' },
    },
  },
];
const reasoning = {
  type: 'reasoning' as const,
  id: 'rs_1',
  encrypted_content: 'encrypted-reasoning',
  summary: [],
};
const toolCall = {
  type: 'function_call' as const,
  id: 'fc_1',
  call_id: 'call_1',
  name: 'lookup',
  arguments: '{"id":1}',
  status: 'completed',
};
const message = {
  type: 'message' as const,
  id: 'msg_1',
  role: 'assistant' as const,
  content: [{ type: 'output_text' as const, text: 'Checking.' }],
};
const usage = {
  input_tokens: 16,
  input_tokens_details: { cached_tokens: 8, cache_write_tokens: 2 },
  output_tokens: 4,
  output_tokens_details: { reasoning_tokens: 3 },
  total_tokens: 20,
};
const expectedUsage = {
  promptTokens: 16,
  completionTokens: 4,
  cachedInputTokens: 8,
  cacheCreationInputTokens: 2,
  reasoningTokens: 3,
  totalTokens: 20,
};

test('builds stateless Responses requests and omits unset reasoning effort', () => {
  assert.deepEqual(
    requestBody(
      model,
      messages,
      tools,
      { reasoningEffort: 'high', maxTokens: 64 },
      true,
    ),
    {
      model,
      input: messages,
      tools: [{ type: 'function', ...tools[0].function, strict: false }],
      reasoning: { effort: 'high' },
      max_output_tokens: 64,
      store: false,
      include: ['reasoning.encrypted_content'],
      stream: true,
    },
  );
  assert.equal(
    'reasoning' in requestBody(model, messages, tools, {}, false),
    false,
  );
  assert.equal(
    'reasoning_effort' in chatRequest(model, messages, undefined, {}),
    false,
  );
  assert.equal(
    chatRequest(model, messages, undefined, { reasoningEffort: 'none' })
      .reasoning_effort,
    'none',
  );
});

test('rejects the unsupported stop option in Responses requests', () => {
  for (const stream of [false, true]) {
    assert.throws(
      () => requestBody(model, messages, tools, { stop: ['END'] }, stream),
      (error: Error) =>
        error instanceof LlmError && /\bstop\b/.test(error.message),
    );
  }
});

test('sends exactly the sampling options supplied for every model and reasoning effort', () => {
  for (const name of [model, 'gpt-5', 'o3-mini', 'deployment-alias']) {
    for (const reasoningEffort of [undefined, 'high', 'none'] as const) {
      const options = { reasoningEffort };
      const body = requestBody(
        name,
        messages,
        tools,
        { ...options, temperature: 0, topP: 0.8 },
        false,
      );
      assert.equal(body.temperature, 0);
      assert.equal(body.top_p, 0.8);
      assert.equal(
        'temperature' in
          requestBody(name, messages, tools, { ...options, topP: 0.8 }, false),
        false,
      );
      assert.equal(
        'top_p' in
          requestBody(
            name,
            messages,
            tools,
            { ...options, temperature: 0 },
            false,
          ),
        false,
      );
    }
  }
});

test('maps output and usage and replays exact output items with the original call ID', () => {
  const raw: OpenAIResponse = {
    status: 'completed',
    output: [reasoning, message, toolCall],
    usage,
  };
  const mapped = chatResponse(raw);
  assert.equal(mapped.content, 'Checking.');
  assert.equal(mapped.finishReason, 'tool_calls');
  assert.deepEqual(mapped.toolCalls, [
    { index: 2, id: 'call_1', name: 'lookup', arguments: '{"id":1}' },
  ]);
  assert.deepEqual(mapped.usage, expectedUsage);

  const assistant: Message = {
    role: 'assistant',
    content: mapped.content,
    providerOutput: mapped.providerOutput,
    tool_calls: [
      {
        id: 'tc:local:0',
        type: 'function',
        function: { name: 'lookup', arguments: '{"id":1}' },
      },
    ],
  };
  const result: Message = {
    role: 'tool',
    tool_call_id: 'tc:local:0',
    content: 'Found',
  };
  assert.deepEqual(
    requestBody(model, [...messages, assistant, result], tools, {}, false)
      .input,
    [
      ...messages,
      reasoning,
      message,
      toolCall,
      { type: 'function_call_output', call_id: 'call_1', output: 'Found' },
    ],
  );
  const { providerOutput: _providerOutput, ...legacy } = assistant;
  assert.deepEqual(
    requestBody(model, [legacy, result], tools, {}, false).input,
    [
      { role: 'assistant', content: 'Checking.' },
      {
        type: 'function_call',
        call_id: 'tc:local:0',
        name: 'lookup',
        arguments: '{"id":1}',
      },
      { type: 'function_call_output', call_id: 'tc:local:0', output: 'Found' },
    ],
  );
});

test('maps interleaved text and tool events and keeps finished reasoning items', () => {
  const secondCall = {
    ...toolCall,
    id: 'fc_2',
    call_id: 'call_2',
    arguments: '{}',
  };
  const events: OpenAIResponseEvent[] = [
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { ...reasoning, encrypted_content: null },
    },
    { type: 'response.output_item.done', output_index: 0, item: reasoning },
    { type: 'response.output_text.delta', delta: 'Checking.' },
    { type: 'response.output_item.done', output_index: 1, item: message },
    {
      type: 'response.output_item.added',
      output_index: 2,
      item: { ...toolCall, arguments: '' },
    },
    {
      type: 'response.function_call_arguments.delta',
      output_index: 2,
      delta: '{"id":',
    },
    { type: 'response.output_item.done', output_index: 3, item: secondCall },
    {
      type: 'response.function_call_arguments.delta',
      output_index: 2,
      delta: '1}',
    },
    {
      type: 'response.function_call_arguments.done',
      output_index: 2,
      arguments: toolCall.arguments,
    },
    { type: 'response.output_item.done', output_index: 2, item: toolCall },
    { type: 'response.completed', response: { usage } },
  ];
  const mapper = new OpenAIResponsesStreamMapper();
  const chunks = events.flatMap((event) => [...mapper.map(event)]);
  const calls = chunks.flatMap((chunk) => chunk.toolCalls ?? []);
  assert.equal(chunks.map((chunk) => chunk.content).join(''), 'Checking.');
  for (const [index, call] of [
    [2, toolCall],
    [3, secondCall],
  ] as const) {
    const deltas = calls.filter((delta) => delta.index === index);
    assert.equal(deltas[0].id, call.call_id);
    assert.equal(deltas[0].name, call.name);
    assert.equal(
      deltas.map((delta) => delta.arguments).join(''),
      call.arguments,
    );
  }
  assert.equal(chunks.at(-1)?.finishReason, 'tool_calls');
  assert.deepEqual(chunks.at(-1)?.usage, expectedUsage);
  assert.deepEqual(chunks.at(-1)?.providerOutput?.items, [
    reasoning,
    message,
    toolCall,
    secondCall,
  ]);
});
