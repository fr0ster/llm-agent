import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LlmError, MODEL_CONTEXT_EXCEEDED } from '@mcp-abap-adt/llm-agent';
import { MCPClientWrapper } from '@mcp-abap-adt/llm-agent-mcp';
import { Agent } from '../agent.js';

test('provider rejection retains terminal code and the ordinary AgentResponse', async () => {
  const terminal = new LlmError('Prompt too long', MODEL_CONTEXT_EXCEEDED);
  const wrapped = new Error('Provider wrapper', { cause: terminal });
  let calls = 0;
  const agent = new Agent({
    mcpClient: new MCPClientWrapper({ listToolsHandler: async () => [] }),
    llmProvider: {
      async chat() {
        calls++;
        if (calls === 1) throw wrapped;
        throw new LlmError('Unavailable');
      },
      async *streamChat() {},
    },
  });
  await assert.rejects(
    () => agent.process('read orders'),
    (failure) => failure === terminal,
  );
  assert.equal(calls, 1);
  assert.deepEqual(await agent.process('read reports'), {
    message: '',
    error: 'Unavailable',
  });
  assert.equal(calls, 2);
});
