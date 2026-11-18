import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import {
  type HistoryEntry,
  type Message,
  staticApiKey,
  type ToolCallRecord,
} from '@mcp-abap-adt/llm-agent';
import { AnthropicProvider } from '../../../../anthropic-llm/src/anthropic-provider.js';
import { DeepSeekProvider } from '../../../../deepseek-llm/src/deepseek-provider.js';
import { OllamaProvider } from '../../../../ollama-llm/src/ollama-provider.js';
import { OpenAIProvider } from '../../../../openai-llm/src/openai-provider.js';
import { SapCoreAIProvider } from '../../../../sap-aicore-llm/src/sap-core-ai-provider.js';
import { ContextAssembler } from '../context-assembler.js';

const fullContent = `${'before\n'.repeat(2000)}FULL_CONTENT_SENTINEL${'\nafter'.repeat(2000)}`;
const contents: ToolCallRecord['result']['content'][] = [
  fullContent,
  { nested: { text: 'FULL_CONTENT_SENTINEL' }, values: [0, false, null] },
  [
    { type: 'text', text: 'FULL_CONTENT_SENTINEL' },
    { type: 'text', text: 'SECOND_BLOCK_SENTINEL' },
  ],
  '',
];
const definition = {
  type: 'function',
  function: {
    name: 'current_tool',
    parameters: { type: 'object', properties: {} },
  },
};

interface Block {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: object;
  tool_use_id?: string;
  content?: string;
}

interface WireMessage {
  role: string;
  content?: string | null | Block[];
  tool_calls?: Message['tool_calls'];
  tool_call_id?: string;
}

interface WirePrompt {
  template?: WireMessage[];
  tools?: (typeof definition)[];
}

interface WirePayload {
  messages?: WireMessage[];
  tools?: { name: string }[];
  tool_choice?: { type: string };
  config?: {
    modules: {
      prompt_templating: {
        prompt: WirePrompt;
        model: { params?: { tool_choice?: string } };
      };
    };
  };
}

const providers = [
  {
    name: 'OpenAI',
    anthropic: false,
    sap: false,
    create: (url: string) =>
      new OpenAIProvider({
        model: 'test',
        baseURL: url,
        credential: staticApiKey('test'),
      }),
  },
  {
    name: 'DeepSeek',
    anthropic: false,
    sap: false,
    create: (url: string) =>
      new DeepSeekProvider({
        model: 'test',
        baseURL: url,
        credential: staticApiKey('test'),
      }),
  },
  {
    name: 'Ollama',
    anthropic: false,
    sap: false,
    create: (url: string) =>
      new OllamaProvider({ model: 'test', baseURL: url }),
  },
  {
    name: 'Anthropic',
    anthropic: true,
    sap: false,
    create: (url: string) =>
      new AnthropicProvider({
        model: 'test',
        maxTokens: 100,
        baseURL: url,
        credential: staticApiKey('test'),
      }),
  },
  ...['gpt-4o', 'anthropic--claude-4-opus'].map((model) => ({
    name: `SAP ${model}`,
    anthropic: model.includes('claude'),
    sap: true,
    create: (url: string) =>
      new SapCoreAIProvider({
        model,
        apiBaseUrl: url,
        credential: { kind: 'bearer', token: async () => 'test' },
      }),
  })),
];

/** Validate declaration/result adjacency and compare every visible byte in order. */
function validateConversation(
  messages: WireMessage[],
  safeIds: boolean,
): string[] {
  const events: string[] = [];
  const ids: string[] = [];
  let pendingId: string | undefined;
  const declare = (
    id: string | undefined,
    name: string | undefined,
    args: string,
  ) => {
    assert.equal(pendingId, undefined);
    assert.ok(id);
    assert.ok(!ids.includes(id), 'each record has a unique ID');
    if (safeIds) assert.match(id, /^[a-zA-Z0-9_-]+$/);
    ids.push(id);
    pendingId = id;
    events.push(`call:${name}:${args}`);
  };
  const resolve = (id: string | undefined, content: string | undefined) => {
    assert.ok(pendingId);
    assert.equal(id, pendingId);
    assert.equal(typeof content, 'string');
    events.push(`result:${content}`);
    pendingId = undefined;
  };
  for (const message of messages) {
    if (message.role === 'system') continue;
    if (message.role === 'tool') {
      assert.equal(typeof message.content, 'string');
      assert.ok(typeof message.content === 'string');
      resolve(message.tool_call_id, message.content);
      continue;
    }
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block.type === 'tool_use') {
          assert.equal(message.role, 'assistant');
          declare(block.id, block.name, JSON.stringify(block.input));
        } else if (block.type === 'tool_result') {
          assert.equal(message.role, 'user');
          resolve(block.tool_use_id, block.content);
        } else if (block.text) {
          assert.equal(pendingId, undefined);
          events.push(`${message.role}:${block.text}`);
        }
      }
    } else if (message.content) {
      assert.equal(pendingId, undefined);
      events.push(`${message.role}:${message.content}`);
    }
    for (const call of message.tool_calls ?? []) {
      assert.equal(message.role, 'assistant');
      declare(call.id, call.function.name, call.function.arguments);
    }
  }
  assert.equal(pendingId, undefined);
  assert.equal(ids.length, contents.length);
  return events;
}

for (const spec of providers) {
  for (const stream of [false, true]) {
    for (const stableId of [false, true]) {
      for (const tools of [undefined, [], [definition]]) {
        test(`ToolCallRecord reaches HTTP payload: ${spec.name} stream=${stream} stable=${stableId} tools=${tools?.length}`, async (t) => {
          const history: HistoryEntry[] = [
            { role: 'user', content: 'START_SENTINEL' },
          ];
          const expected = ['user:START_SENTINEL'];
          for (const [index, content] of contents.entries()) {
            history.push({
              call: {
                id: stableId ? `stable:record:${index}` : '',
                name: 'lookup',
                arguments: { query: `original-${index}` },
              },
              result: { content },
            });
            expected.push(
              `call:lookup:${JSON.stringify({ query: `original-${index}` })}`,
              `result:${typeof content === 'string' ? content : JSON.stringify(content)}`,
            );
            // Whitespace is model-visible content too.
            history.push({
              role: 'assistant',
              content: index === 0 ? ' \n ' : `BETWEEN_${index}`,
            });
            expected.push(
              `assistant:${index === 0 ? ' \n ' : `BETWEEN_${index}`}`,
            );
          }
          history.push({ role: 'user', content: 'CONTINUE_SENTINEL' });
          expected.push('user:CONTINUE_SENTINEL');
          const snapshot = structuredClone(history);
          const assembled = await new ContextAssembler().assemble(
            { type: 'action', text: 'Continue' },
            { ragResults: {}, tools: [] },
            history,
          );
          assert.ok(assembled.ok);
          const logicalIds = assembled.value.flatMap(
            (message) => message.tool_calls?.map((call) => call.id) ?? [],
          );
          if (stableId) {
            assert.deepEqual(
              logicalIds,
              contents.map((_, index) => `stable:record:${index}`),
            );
          } else {
            for (const id of logicalIds)
              assert.match(id, /^tc:[0-9a-f-]{36}:0$/);
          }
          const payloads: WirePayload[] = [];
          const server = createServer(async (request, reply) => {
            reply.setHeader('content-type', 'application/json');
            if (request.method === 'GET') {
              reply.end(
                JSON.stringify({ resources: [{ id: 'tool-record-test' }] }),
              );
              return;
            }
            request.setEncoding('utf8');
            let body = '';
            for await (const chunk of request) body += chunk;
            payloads.push(JSON.parse(body));
            if (stream) {
              reply.setHeader('content-type', 'text/event-stream');
              reply.end(
                spec.name === 'Anthropic'
                  ? 'event: message_stop\ndata: {"type":"message_stop"}\n\n'
                  : spec.sap
                    ? 'data: {"final_result":{"choices":[{"index":0,"delta":{"content":"done"},"finish_reason":"stop"}]}}\n\n'
                    : 'data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
              );
            } else {
              const completion = {
                choices: [
                  {
                    index: 0,
                    message: { role: 'assistant', content: 'done' },
                    finish_reason: 'stop',
                  },
                ],
              };
              reply.end(
                JSON.stringify(
                  spec.sap
                    ? { final_result: completion }
                    : {
                        ...completion,
                        content: [{ type: 'text', text: 'done' }],
                        stop_reason: 'end_turn',
                      },
                ),
              );
            }
          });
          server.listen(0, '127.0.0.1');
          await once(server, 'listening');
          t.after(async () => {
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) => {
              server.close((error) => (error ? reject(error) : resolve()));
            });
          });
          const address = server.address();
          assert.ok(address && typeof address !== 'string');
          const provider = spec.create(`http://127.0.0.1:${address.port}`);
          if (stream) {
            for await (const chunk of provider.streamChat(
              assembled.value,
              tools,
            ))
              void chunk;
          } else {
            assert.equal(
              (await provider.chat(assembled.value, tools)).content,
              'done',
            );
          }
          assert.equal(payloads.length, 1);
          const payload = payloads[0];
          const prompt = payload.config?.modules.prompt_templating;
          const messages = spec.sap
            ? prompt?.prompt.template
            : payload.messages;
          assert.ok(messages);
          assert.deepEqual(
            validateConversation(messages, spec.anthropic),
            expected,
          );
          assert.ok(JSON.stringify(payload).includes('FULL_CONTENT_SENTINEL'));
          if (spec.anthropic) {
            const names = spec.sap
              ? prompt?.prompt.tools?.map((tool) => tool.function.name)
              : payload.tools?.map((tool) => tool.name);
            assert.deepEqual(
              names,
              tools?.length ? ['current_tool', 'lookup'] : ['lookup'],
            );
            assert.equal(
              spec.sap
                ? prompt?.model.params?.tool_choice
                : payload.tool_choice?.type,
              tools?.length ? (spec.sap ? 'auto' : undefined) : 'none',
            );
          }
          assert.deepEqual(history, snapshot);
        });
      }
    }
  }
}
