// biome-ignore-all lint/complexity/useLiteralKeys: bracket access preserves the private SDK seam's static types.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Message } from '@mcp-abap-adt/llm-agent';
import type {
  ChatCompletionTool,
  ChatMessage,
} from '@sap-ai-sdk/orchestration';
import { SapCoreAIProvider } from '../sap-core-ai-provider.js';

const id = 'ext:f93572aa19e33895';
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

const collisionIds = [
  id,
  'ext_history',
  'toolu_history_0',
  'ext:history',
  'ext/history',
  'ext:雪',
  'valid\n',
];
const collisionHistory: Message[] = [
  { role: 'user', content: 'start' },
  {
    role: 'assistant',
    content: 'parallel calls',
    tool_calls: collisionIds.map((toolId) => ({
      id: toolId,
      type: 'function',
      function: { name: 'lookup', arguments: '{}' },
    })),
  },
  ...collisionIds.map((toolId) => ({
    role: 'tool' as const,
    tool_call_id: toolId,
    content: `result:${toolId}`,
  })),
];

function validateToolIds(template: ChatMessage[], claude: boolean): string[] {
  const calls = template.flatMap((message) =>
    message.role === 'assistant'
      ? (message.tool_calls?.map((call) => call.id) ?? [])
      : [],
  );
  const results = template.flatMap((message) =>
    message.role === 'tool' ? [message.tool_call_id] : [],
  );
  for (const toolId of [...calls, ...results]) {
    assert.equal(typeof toolId, 'string');
    assert.ok(toolId.length > 0);
    if (claude) {
      assert.match(toolId, /^[a-zA-Z0-9_-]+$/);
      assert.doesNotMatch(toolId, /[^a-zA-Z0-9_-]/);
    }
  }
  assert.deepEqual(results, calls);
  return calls;
}

for (const inputHistory of [history, collisionHistory]) {
  for (const promptCaching of [false, true]) {
    for (const model of ['gpt-4o', 'anthropic--claude-4-opus']) {
      for (const stream of [false, true]) {
        for (const tools of [undefined, [], [definition]]) {
          test(`completed external history at SDK boundary model=${model} stream=${stream} tools=${tools?.length} messages=${inputHistory.length} caching=${promptCaching}`, async () => {
            const provider = new SapCoreAIProvider({
              model,
              promptCaching,
              apiBaseUrl: 'https://example.invalid',
              credential: { kind: 'bearer', token: async () => 'test' },
            });
            const snapshot = structuredClone(inputHistory);
            const captured: string[][] = [];
            const create = provider['createClient'].bind(provider);
            let requests = 0;
            provider['createClient'] = (
              messages,
              inputTools,
              destination,
              options,
            ) => {
              const client = create(messages, inputTools, destination, options);
              requests++;
              const config = client['config'];
              assert.ok(
                typeof config === 'object' &&
                  !Array.isArray(config) &&
                  'promptTemplating' in config,
              );
              const prompt = config.promptTemplating.prompt;
              assert.ok(
                prompt && typeof prompt === 'object' && 'template' in prompt,
              );
              const claude = model.includes('claude');
              const mappedIds = validateToolIds(prompt.template, claude);
              captured.push(mappedIds);
              const logicalIds = snapshot.flatMap(
                (message) => message.tool_calls?.map((call) => call.id) ?? [],
              );
              assert.equal(new Set(mappedIds).size, logicalIds.length);
              const mapping = new Map(
                logicalIds.map((toolId, index) => [toolId, mappedIds[index]]),
              );
              for (const [logicalId, mappedId] of mapping) {
                if (!claude || !/[^a-zA-Z0-9_-]/.test(logicalId))
                  assert.equal(mappedId, logicalId);
                else assert.notEqual(mappedId, logicalId);
              }
              assert.deepEqual(
                prompt.template,
                snapshot.map((message, index) => ({
                  ...message,
                  ...(message.tool_calls
                    ? {
                        tool_calls: message.tool_calls.map((call) => ({
                          ...call,
                          id: mapping.get(call.id),
                        })),
                      }
                    : {}),
                  ...(message.tool_call_id
                    ? { tool_call_id: mapping.get(message.tool_call_id) }
                    : {}),
                  ...(claude && promptCaching && index === snapshot.length - 1
                    ? {
                        content: [
                          {
                            type: 'text',
                            text: message.content,
                            cache_control: { type: 'ephemeral' },
                          },
                        ],
                      }
                    : {}),
                })),
              );
              const historicalOnly = model.includes('claude') && !tools?.length;
              if (historicalOnly) {
                assert.deepEqual(
                  prompt.tools?.map(
                    (tool: ChatCompletionTool) => tool.function.name,
                  ),
                  ['lookup'],
                );
                assert.equal(
                  config.promptTemplating.model.params?.tool_choice,
                  'none',
                );
              } else {
                assert.deepEqual(
                  prompt.tools,
                  tools?.length ? tools : undefined,
                );
              }
              // Stop at the real SDK request boundary without sending a network request.
              throw new Error('SDK_REQUEST_CAPTURED');
            };
            for (let attempt = 0; attempt < 2; attempt++) {
              if (stream) {
                await assert.rejects(async () => {
                  for await (const chunk of provider.streamChat(
                    inputHistory,
                    tools,
                  ))
                    void chunk;
                }, /SDK_REQUEST_CAPTURED/);
              } else {
                await assert.rejects(
                  provider.chat(inputHistory, tools),
                  /SDK_REQUEST_CAPTURED/,
                );
              }
            }
            assert.equal(requests, 2);
            assert.deepEqual(captured[0], captured[1]);
            assert.deepEqual(inputHistory, snapshot);
          });
        }
      }
    }
  }
}
