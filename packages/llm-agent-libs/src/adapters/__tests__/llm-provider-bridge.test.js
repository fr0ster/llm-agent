import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LlmProviderBridge } from '../llm-provider-bridge.js';

class StubProvider {
  chunks;
  model = 'stub';
  constructor(chunks) {
    this.chunks = chunks;
  }
  async chat() {
    return { content: '' };
  }
  async *streamChat(_m) {
    for (const c of this.chunks) yield c;
  }
  async getModels() {
    return [];
  }
  async getEmbeddingModels() {
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
    const out = [];
    for await (const c of bridge.streamWithTools(
      [{ role: 'user', content: 'hi' }],
      [],
    )) {
      out.push(c);
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
    const out = [];
    for await (const c of bridge.streamWithTools(
      [{ role: 'user', content: 'hi' }],
      [],
    )) {
      out.push(c);
    }
    assert.equal(
      out.find((c) => c.type === 'tool_calls'),
      undefined,
    );
  });
});
//# sourceMappingURL=llm-provider-bridge.test.js.map
