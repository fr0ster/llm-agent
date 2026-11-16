// biome-ignore-all lint/complexity/useLiteralKeys: bracket access retains static types when inspecting private SDK boundaries in tests.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  IUsageRecorder,
  Message,
  UsageInput,
} from '@mcp-abap-adt/llm-agent';
import {
  type ChatCompletionTool,
  type ChatMessage,
  OrchestrationResponse,
  OrchestrationStream,
  OrchestrationStreamChunkResponse,
  OrchestrationStreamResponse,
} from '@sap-ai-sdk/orchestration';
import {
  type SapCoreAIConfig,
  SapCoreAIProvider,
} from '../sap-core-ai-provider.js';

const destination = {
  url: 'https://example.invalid',
  authentication: 'NoAuthentication' as const,
  headers: {},
};
const config = (
  model: string,
  promptCaching?: SapCoreAIConfig['promptCaching'],
): SapCoreAIConfig => ({
  model,
  promptCaching,
  apiBaseUrl: destination.url,
  credential: { kind: 'bearer', token: async () => 'test' },
});

for (const model of ['anthropic--claude-4-opus', 'claude-opus-4-7', 'gpt-4o']) {
  for (const mode of [undefined, false, true]) {
    for (const override of [undefined, false, true]) {
      test(`prompt caching: ${model}, ${mode ?? 'default'}, override=${override}`, () => {
        const provider = new SapCoreAIProvider(config(model, mode));
        const messages: Message[] = [
          { role: 'system', content: 'stable policy' },
          { role: 'user', content: 'variable request' },
        ];
        const tools = [
          {
            type: 'function',
            function: {
              name: 'read',
              description: 'Read',
              parameters: { type: 'object' },
            },
          },
        ];
        const before = structuredClone({ messages, tools });
        const client = provider['createClient'](
          provider['formatMessages'](messages),
          tools,
          destination,
          { promptCaching: override },
        );
        const orch = client['config'];
        assert.ok(
          typeof orch === 'object' &&
            !Array.isArray(orch) &&
            'promptTemplating' in orch,
        );
        const prompt = orch.promptTemplating.prompt;
        assert.ok(prompt && typeof prompt === 'object' && 'template' in prompt);
        const enabled = model !== 'gpt-4o' && (override ?? mode ?? true);
        assert.deepEqual(
          prompt.template,
          enabled
            ? [
                messages[0],
                {
                  role: 'user',
                  content: [
                    {
                      type: 'text',
                      text: 'variable request',
                      cache_control: { type: 'ephemeral' },
                    },
                  ],
                },
              ]
            : messages,
        );
        assert.equal(
          JSON.stringify(prompt.tools).includes('cache_control'),
          false,
        );
        assert.equal(
          JSON.stringify(prompt).match(/"cache_control":/g)?.length ?? 0,
          enabled ? 1 : 0,
        );
        assert.deepEqual({ messages, tools }, before);
      });
    }
  }
}

const tools: ChatCompletionTool[] = ['read', 'write'].map((name) => ({
  type: 'function',
  function: { name, parameters: { type: 'object' } },
}));
const cachedText = (text: string) => [
  {
    type: 'text' as const,
    text,
    cache_control: { type: 'ephemeral' as const },
  },
];
const toolCalls = [
  {
    id: 'call_1',
    type: 'function' as const,
    function: { name: 'read', arguments: '{}' },
  },
];
const system: ChatMessage = { role: 'system', content: 'policy' };
const user: ChatMessage = { role: 'user', content: 'question' };
const emptyAssistant: ChatMessage = {
  role: 'assistant',
  tool_calls: toolCalls,
};

const cases: {
  name: string;
  messages: ChatMessage[];
  expectedMessage?: { index: number; content: ChatMessage['content'] };
  cacheTool?: boolean;
  noTools?: boolean;
}[] = [
  {
    name: 'last user string in conversation history',
    messages: [system, user, { role: 'assistant', content: 'answer' }, user],
    expectedMessage: { index: 3, content: cachedText('question') },
  },
  {
    name: 'only the last user content block',
    messages: [
      system,
      {
        role: 'user',
        content: [
          { type: 'text', text: 'first' },
          { type: 'text', text: 'last' },
        ],
      },
    ],
    expectedMessage: {
      index: 1,
      content: [{ type: 'text', text: 'first' }, ...cachedText('last')],
    },
  },
  {
    name: 'skip trailing empty text blocks',
    messages: [
      system,
      {
        role: 'user',
        content: [
          { type: 'text', text: 'question' },
          { type: 'text', text: '' },
          { type: 'text', text: '' },
        ],
      },
    ],
    expectedMessage: {
      index: 1,
      content: [
        ...cachedText('question'),
        { type: 'text', text: '' },
        { type: 'text', text: '' },
      ],
    },
  },
  ...(['image_url', 'file'] as const).map((type) => {
    const block =
      type === 'image_url'
        ? { type, image_url: { url: 'https://example.invalid/image.png' } }
        : { type, file: { file_data: 'https://example.invalid/file.pdf' } };
    return {
      name: `skip empty text after ${type}`,
      messages: [
        user,
        {
          role: 'user' as const,
          content: [block, { type: 'text' as const, text: '' }],
        },
      ],
      expectedMessage: {
        index: 1,
        content: [
          { ...block, cache_control: { type: 'ephemeral' as const } },
          { type: 'text' as const, text: '' },
        ],
      },
    };
  }),
  ...(['string', 'blocks'] as const).map((kind) => ({
    name: `whitespace-only ${kind} remains cacheable`,
    messages: [
      user,
      {
        role: 'user' as const,
        content:
          kind === 'string'
            ? ' \t\n'
            : [{ type: 'text' as const, text: ' \t\n' }],
      },
    ],
    expectedMessage: { index: 1, content: cachedText(' \t\n') },
  })),
  ...(['conversation', 'system', 'developer', 'tools'] as const).map(
    (fallback) => ({
      name: `empty text blocks fall back to ${fallback}`,
      messages: [
        ...(fallback === 'conversation'
          ? [system, user]
          : fallback === 'system' || fallback === 'developer'
            ? [{ role: fallback, content: 'policy' }]
            : []),
        {
          role: 'system' as const,
          content: [{ type: 'text' as const, text: '' }],
        },
        {
          role: 'user' as const,
          content: [
            { type: 'text' as const, text: '' },
            { type: 'text' as const, text: '' },
          ],
        },
      ],
      expectedMessage:
        fallback === 'tools'
          ? undefined
          : {
              index: fallback === 'conversation' ? 1 : 0,
              content: cachedText(
                fallback === 'conversation' ? 'question' : 'policy',
              ),
            },
      cacheTool: fallback === 'tools',
    }),
  ),
  {
    name: 'last image block without losing image data',
    messages: [
      user,
      {
        role: 'user',
        content: [
          { type: 'text', text: 'describe' },
          {
            type: 'image_url',
            image_url: { url: 'https://example.invalid/image.png' },
          },
        ],
      },
    ],
    expectedMessage: {
      index: 1,
      content: [
        { type: 'text', text: 'describe' },
        {
          type: 'image_url',
          image_url: { url: 'https://example.invalid/image.png' },
          cache_control: { type: 'ephemeral' },
        },
      ],
    },
  },
  {
    name: 'conversation takes precedence over a later system message',
    messages: [user, system],
    expectedMessage: { index: 0, content: cachedText('question') },
  },
  {
    name: 'assistant string',
    messages: [user, { role: 'assistant', content: 'answer' }],
    expectedMessage: { index: 1, content: cachedText('answer') },
  },
  ...(['string', 'blocks'] as const).flatMap((kind) => {
    const content =
      kind === 'string'
        ? 'result'
        : [{ type: 'text' as const, text: 'result' }];
    return [
      {
        name: `SDK supports tool message ${kind}`,
        messages: [
          system,
          user,
          { role: 'tool' as const, content, tool_call_id: 'call_1' },
        ],
        expectedMessage: { index: 2, content: cachedText('result') },
      },
      {
        name: `SDK supports assistant with tool_calls ${kind}`,
        messages: [
          system,
          user,
          { role: 'assistant' as const, content, tool_calls: toolCalls },
        ],
        expectedMessage: { index: 2, content: cachedText('result') },
      },
    ];
  }),
  {
    name: 'walk back past assistant tool calls without content',
    messages: [system, user, emptyAssistant],
    expectedMessage: { index: 1, content: cachedText('question') },
  },
  {
    name: 'walk back past multiple empty messages',
    messages: [
      system,
      user,
      { role: 'user', content: [] },
      emptyAssistant,
      { role: 'tool', content: [], tool_call_id: 'call_1' },
      { role: 'assistant', content: '', tool_calls: toolCalls },
    ],
    expectedMessage: { index: 1, content: cachedText('question') },
  },
  {
    name: 'fall back to last system string',
    messages: [
      system,
      { role: 'system', content: 'last policy' },
      emptyAssistant,
    ],
    expectedMessage: { index: 1, content: cachedText('last policy') },
  },
  {
    name: 'fall back to last system block',
    messages: [
      system,
      {
        role: 'system',
        content: [
          { type: 'text', text: 'first' },
          { type: 'text', text: 'last policy' },
        ],
      },
      emptyAssistant,
    ],
    expectedMessage: {
      index: 1,
      content: [{ type: 'text', text: 'first' }, ...cachedText('last policy')],
    },
  },
  {
    name: 'walk back past an empty system message',
    messages: [system, { role: 'system', content: [] }, emptyAssistant],
    expectedMessage: { index: 0, content: cachedText('policy') },
  },
  {
    name: 'system without tools or history',
    messages: [system],
    expectedMessage: { index: 0, content: cachedText('policy') },
    noTools: true,
  },
  {
    name: 'developer instructions accept text blocks in SDK',
    messages: [{ role: 'developer', content: 'policy' }, emptyAssistant],
    expectedMessage: { index: 0, content: cachedText('policy') },
  },
  {
    name: 'fall back to last tool when messages have no cacheable content',
    messages: [{ role: 'system', content: [] }, emptyAssistant],
    cacheTool: true,
  },
  { name: 'tools only', messages: [], cacheTool: true },
  { name: 'empty request', messages: [], noTools: true },
  {
    name: 'no cacheable blocks or tools',
    messages: [emptyAssistant],
    noTools: true,
  },
];

for (const scenario of cases) {
  test(`automatic caching: ${scenario.name}`, () => {
    const provider = new SapCoreAIProvider(config('anthropic--claude-4-opus'));
    const messages = structuredClone(scenario.messages);
    const inputTools = scenario.noTools ? undefined : structuredClone(tools);
    const before = structuredClone({ messages, tools: inputTools });
    const client = provider['createClient'](messages, inputTools, destination);
    const orch = client['config'];
    assert.ok(
      typeof orch === 'object' &&
        !Array.isArray(orch) &&
        'promptTemplating' in orch,
    );
    const prompt = orch.promptTemplating.prompt;
    assert.ok(prompt && typeof prompt === 'object' && 'template' in prompt);
    assert.deepEqual(
      prompt.template,
      before.messages.map((message, index) =>
        index === scenario.expectedMessage?.index
          ? { ...message, content: scenario.expectedMessage.content }
          : message,
      ),
    );
    assert.deepEqual(
      prompt.tools,
      before.tools?.map((tool, index) =>
        scenario.cacheTool && index === tools.length - 1
          ? { ...tool, cache_control: { type: 'ephemeral' } }
          : tool,
      ),
    );
    assert.equal(
      JSON.stringify(prompt).match(/"cache_control":/g)?.length ?? 0,
      scenario.expectedMessage || scenario.cacheTool ? 1 : 0,
    );
    assert.deepEqual({ messages, tools: inputTools }, before);
  });
}

for (const model of ['claude-opus-4-7', 'gpt-4o']) {
  for (const enabled of [false, true]) {
    for (const target of ['conversation', 'system', 'tools', 'none']) {
      test(`existing cache markers: ${model}, enabled=${enabled}, target=${target}`, () => {
        const provider = new SapCoreAIProvider(config(model, enabled));
        const marker = { type: 'ephemeral' as const };
        const messages: (ChatMessage & { cache_control: typeof marker })[] = [
          {
            role: 'system',
            content: cachedText(
              target === 'tools' || target === 'none' ? '' : 'policy',
            ),
            cache_control: marker,
          },
          {
            role: 'user',
            content: [
              ...cachedText(
                target === 'conversation' ? 'earlier question' : '',
              ),
              ...cachedText(''),
            ],
            cache_control: marker,
          },
          {
            role: 'user',
            content: [
              ...cachedText(target === 'conversation' ? 'question' : ''),
              ...cachedText(''),
            ],
            cache_control: marker,
          },
        ];
        const inputTools =
          target === 'none'
            ? undefined
            : tools.map((tool) => ({
                ...tool,
                cache_control: marker,
              }));
        const before = structuredClone({ messages, tools: inputTools });
        const client = provider['createClient'](
          messages,
          inputTools,
          destination,
        );
        const orch = client['config'];
        assert.ok(
          typeof orch === 'object' &&
            !Array.isArray(orch) &&
            'promptTemplating' in orch,
        );
        const prompt = orch.promptTemplating.prompt;
        assert.ok(prompt && typeof prompt === 'object' && 'template' in prompt);
        if (enabled && model === 'claude-opus-4-7') {
          const expectedMessages = messages.map(
            ({ cache_control: _marker, ...message }) => ({
              ...message,
              content: Array.isArray(message.content)
                ? message.content.map(
                    ({ cache_control: _marker, ...block }) => block,
                  )
                : message.content,
            }),
          );
          if (target === 'conversation' || target === 'system') {
            const index = target === 'conversation' ? 2 : 0;
            expectedMessages[index] = {
              ...expectedMessages[index],
              content: [
                ...cachedText(
                  target === 'conversation' ? 'question' : 'policy',
                ),
                ...(target === 'conversation'
                  ? [{ type: 'text' as const, text: '' }]
                  : []),
              ],
            };
          }
          assert.deepEqual(prompt.template, expectedMessages);
          assert.deepEqual(
            prompt.tools,
            target === 'tools'
              ? [tools[0], { ...tools[1], cache_control: marker }]
              : target === 'none'
                ? undefined
                : tools,
          );
          assert.equal(
            JSON.stringify(prompt).match(/"cache_control":/g)?.length ?? 0,
            target === 'none' ? 0 : 1,
          );
        } else {
          assert.deepEqual(prompt.template, before.messages);
          assert.deepEqual(prompt.tools, before.tools);
        }
        assert.deepEqual({ messages, tools: inputTools }, before);
      });
    }
  }
}

test('breakpoint moves forward as conversation history grows', () => {
  const provider = new SapCoreAIProvider(config('claude-opus-4-7'));
  const messages: ChatMessage[] = [system, user];
  const templates: ChatMessage[][] = [];
  for (const text of ['question', 'follow-up']) {
    if (text === 'follow-up') {
      messages.push(
        { role: 'assistant', content: 'answer' },
        { role: 'user', content: text },
      );
    }
    const client = provider['createClient'](messages, tools, destination);
    const orch = client['config'];
    assert.ok(
      typeof orch === 'object' &&
        !Array.isArray(orch) &&
        'promptTemplating' in orch,
    );
    const prompt = orch.promptTemplating.prompt;
    assert.ok(prompt && typeof prompt === 'object' && 'template' in prompt);
    assert.deepEqual(prompt.template, [
      ...messages.slice(0, -1),
      { role: 'user', content: cachedText(text) },
    ]);
    assert.equal(JSON.stringify(prompt).match(/"cache_control":/g)?.length, 1);
    assert.ok(prompt.template);
    templates.push(prompt.template);
  }
  assert.deepEqual(templates[0], [
    system,
    { role: 'user', content: cachedText('question') },
  ]);
  assert.ok(!JSON.stringify({ messages, tools }).includes('cache_control'));
});

test('formatting preserves message metadata', () => {
  const provider = new SapCoreAIProvider(config('claude-opus-4-7', true));
  const input = [
    {
      role: 'system' as const,
      content: 'stable',
      metadata: { source: 'policy' },
    },
  ];
  assert.deepEqual(provider['formatMessages'](input), input);
});

for (const stream of [false, true]) {
  test(`normalizes cache read and creation usage, stream=${stream}`, async () => {
    const events: UsageInput[] = [];
    const recorder: IUsageRecorder = {
      record: (event) => {
        events.push(event);
      },
      with: () => recorder,
    };
    const provider = new SapCoreAIProvider({
      ...config('claude-opus-4-7', true),
      usage: recorder,
    });
    const client = provider['createClient']([], [], destination);
    const usage = {
      prompt_tokens: 100,
      completion_tokens: 7,
      total_tokens: 107,
      prompt_tokens_details: { cached_tokens: 60, cache_creation_tokens: 30 },
    };
    const result = {
      id: 'completion',
      object: 'chat.completion',
      created: 1,
      model: provider.model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant' as const, content: 'ok' },
          finish_reason: 'stop',
        },
      ],
      usage,
    };
    client.chatCompletion = async () =>
      new OrchestrationResponse({
        data: {
          request_id: 'request',
          intermediate_results: {},
          final_result: result,
        },
        headers: {},
        status: 200,
      });
    client.stream = async () => {
      const response =
        new OrchestrationStreamResponse<OrchestrationStreamChunkResponse>({
          data: {},
          headers: {},
          status: 200,
        });
      response.stream = new OrchestrationStream(async function* () {
        yield new OrchestrationStreamChunkResponse({
          request_id: 'request',
          final_result: {
            ...result,
            choices: [
              {
                index: 0,
                delta: { role: 'assistant', content: 'ok' },
                finish_reason: 'stop',
              },
            ],
          },
        });
      }, new AbortController());
      return response;
    };
    provider['createClient'] = (_messages, _tools, _destination, options) => {
      assert.equal(options?.promptCaching, false);
      return client;
    };
    if (stream) {
      let sawUsage = false;
      for await (const chunk of provider.streamChat(
        [{ role: 'user', content: 'hello' }],
        undefined,
        { promptCaching: false },
      )) {
        assert.equal(chunk.usage?.cachedInputTokens, 60);
        assert.equal(chunk.usage?.cacheCreationInputTokens, 30);
        sawUsage = true;
      }
      assert.ok(sawUsage);
    } else {
      const response = await provider.chat(
        [{ role: 'user', content: 'hello' }],
        undefined,
        { promptCaching: false },
      );
      assert.equal(response.usage?.cachedInputTokens, 60);
      assert.equal(response.usage?.cacheCreationInputTokens, 30);
    }
    const event = events.find((entry) => entry.kind === 'llm.call');
    assert.ok(event?.kind === 'llm.call');
    assert.equal(event.cachedInputTokens, 60);
    assert.equal(event.cacheCreationInputTokens, 30);
  });
}
