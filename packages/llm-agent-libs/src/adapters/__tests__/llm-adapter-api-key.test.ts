import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BaseAgentLlmBridge } from '@mcp-abap-adt/llm-agent';
import { LlmAdapter } from '../llm-adapter.js';

test('forwards a per-call key to the bridge and model catalog', async () => {
  const keys: Array<string | undefined> = [];
  const bridge: BaseAgentLlmBridge = {
    async callWithTools(_messages, _tools, options) {
      keys.push(options?.apiKey);
      return { content: 'ok' };
    },
    async *streamWithTools(_messages, _tools, options) {
      keys.push(options?.apiKey);
      yield { content: 'ok' };
    },
  };
  const adapter = new LlmAdapter(bridge, {
    model: 'test-model',
    async getModels(options) {
      keys.push(options?.apiKey);
      return ['test-model'];
    },
  });
  const options = { apiKey: 'call-key' };
  assert.equal((await adapter.chat([], undefined, options)).ok, true);
  for await (const chunk of adapter.streamChat([], undefined, options)) {
    assert.equal(chunk.ok, true);
  }
  assert.equal((await adapter.getModels(options)).ok, true);
  assert.equal((await adapter.chat([])).ok, true);
  assert.deepEqual(keys, ['call-key', 'call-key', 'call-key', undefined]);
});
