import assert from 'node:assert/strict';
import { describe, it, test } from 'node:test';
import type {
  AgentStreamChunk,
  IModelInfo,
  LLMProvider,
  LLMResponse,
  Message,
  ProviderOutput,
} from '@mcp-abap-adt/llm-agent';
import { SmartAgent } from '../../agent.js';
import {
  makeAssembler,
  makeDefaultDeps,
  testCallOptions,
} from '../../testing/index.js';
import { LlmAdapter } from '../llm-adapter.js';
import { LlmProviderBridge } from '../llm-provider-bridge.js';

class StubProvider implements LLMProvider {
  readonly model = 'stub';
  constructor(private readonly chunks: LLMResponse[]) {}
  async chat(): Promise<LLMResponse> {
    return { content: '' };
  }
  async *streamChat(_m: Message[]): AsyncIterable<LLMResponse> {
    for (const c of this.chunks) yield c;
  }
  async getModels(): Promise<IModelInfo[]> {
    return [];
  }
  async getEmbeddingModels(): Promise<IModelInfo[]> {
    return [];
  }
}

describe('LlmProviderBridge — streaming tool_calls aggregation (#119)', () => {
  it('aggregates provider-normalized toolCalls deltas across chunks', async () => {
    // Simulates SAP / Anthropic / OpenAI style: provider yields chunks with
    // a normalized `toolCalls` field. The bridge must accumulate by index
    // regardless of provider-specific raw shape.
    const provider = new StubProvider([
      {
        content: '',
        toolCalls: [
          { index: 0, id: 'call_abc', name: 'get_weather', arguments: '' },
        ],
      },
      {
        content: '',
        toolCalls: [{ index: 0, arguments: '{"city":' }],
      },
      {
        content: '',
        toolCalls: [{ index: 0, arguments: '"Kyiv"}' }],
      },
      { content: '', finishReason: 'tool_calls' },
    ]);
    const bridge = new LlmProviderBridge(provider);

    const out: AgentStreamChunk[] = [];
    for await (const c of bridge.streamWithTools(
      [{ role: 'user', content: 'hi' }],
      [],
    )) {
      out.push(c as AgentStreamChunk);
    }

    const toolCallsChunk = out.find((c) => c.type === 'tool_calls');
    assert.ok(toolCallsChunk, 'expected a tool_calls chunk');
    assert.equal(toolCallsChunk.type, 'tool_calls');
    if (toolCallsChunk.type === 'tool_calls') {
      assert.equal(toolCallsChunk.toolCalls.length, 1);
      assert.equal(toolCallsChunk.toolCalls[0].id, 'call_abc');
      assert.equal(toolCallsChunk.toolCalls[0].name, 'get_weather');
      assert.deepEqual(toolCallsChunk.toolCalls[0].arguments, { city: 'Kyiv' });
    }

    const done = out.find((c) => c.type === 'done');
    assert.ok(done && done.type === 'done');
    if (done && done.type === 'done')
      assert.equal(done.finishReason, 'tool_calls');
  });

  it('does not emit tool_calls chunk when provider yields none', async () => {
    const provider = new StubProvider([
      { content: 'hello', finishReason: 'stop' },
    ]);
    const bridge = new LlmProviderBridge(provider);
    const out: AgentStreamChunk[] = [];
    for await (const c of bridge.streamWithTools(
      [{ role: 'user', content: 'hi' }],
      [],
    )) {
      out.push(c as AgentStreamChunk);
    }
    assert.equal(
      out.find((c) => c.type === 'tool_calls'),
      undefined,
    );
  });
});

test('carries provider output and reasoning effort through an agent tool round', async () => {
  const providerOutput: ProviderOutput = {
    protocol: 'openai.responses',
    items: [
      { type: 'reasoning', id: 'rs_1', encrypted_content: 'encrypted' },
      {
        type: 'function_call',
        call_id: 'call_1',
        name: 'Lookup',
        arguments: '{}',
      },
    ],
  };
  const toolResponse: LLMResponse = {
    content: '',
    toolCalls: [{ index: 1, id: 'call_1', name: 'Lookup', arguments: '{}' }],
    finishReason: 'tool_calls',
    providerOutput,
  };
  const requests: Message[][] = [];
  const provider: LLMProvider = {
    async chat(_messages, _tools, options) {
      assert.equal(options?.reasoningEffort, 'low');
      return toolResponse;
    },
    async *streamChat(messages, _tools, options) {
      assert.equal(options?.reasoningEffort, 'high');
      requests.push(structuredClone(messages));
      if (requests.length === 1) yield toolResponse;
      else yield { content: 'Done', finishReason: 'stop' };
    },
  };
  const llm = new LlmAdapter(new LlmProviderBridge(provider));
  const response = await llm.chat([], [], { reasoningEffort: 'low' });
  assert.ok(response.ok);
  assert.deepEqual(response.value.providerOutput, providerOutput);
  assert.deepEqual(response.value.toolCalls, [
    { id: 'call_1', name: 'Lookup', arguments: {} },
  ]);

  const { deps } = makeDefaultDeps({
    assembler: makeAssembler([
      { role: 'user', content: 'Look up the result.' },
    ]),
    mcpClients: [
      {
        async listTools() {
          return {
            ok: true,
            value: [
              { name: 'Lookup', description: 'Look up', inputSchema: {} },
            ],
          };
        },
        async callTool() {
          return { ok: true, value: { content: 'Found' } };
        },
      },
    ],
  });
  deps.mainLlm = llm;
  const result = await new SmartAgent(deps, {
    refreshToolsPerIteration: false,
  }).process('Look up the result.', {
    ...testCallOptions(),
    reasoningEffort: 'high',
  });
  assert.ok(result.ok);
  assert.equal(result.value.content, 'Done');
  assert.equal(requests.length, 2);
  const assistant = requests[1].find((message) => message.role === 'assistant');
  const output = requests[1].find((message) => message.role === 'tool');
  assert.deepEqual(assistant?.providerOutput, providerOutput);
  assert.notEqual(assistant?.tool_calls?.[0].id, 'call_1');
  assert.equal(output?.tool_call_id, assistant?.tool_calls?.[0].id);
  assert.equal(output?.content, 'Found');
});
