import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SmartServer } from '../smart-server.js';

test('SmartServer accepts BuildAgentDeps and uses the injected makeLlm', async () => {
  let llmCalls = 0;
  const cannedLlm = {
    chat: async () => ({ content: '', toolCalls: [] }),
    model: 'stub',
  } as unknown as import('@mcp-abap-adt/llm-agent').ILlm;
  const server = new SmartServer(
    {
      llm: { main: { provider: 'openai', apiKey: 'x', model: 'gpt-4o' } },
    } as unknown as import('../smart-server.js').SmartServerConfig,
    {
      makeLlm: async () => {
        llmCalls++;
        return cannedLlm;
      },
    },
  );
  assert.ok(server);
  assert.equal(
    typeof (server as unknown as { _deps: unknown })._deps,
    'object',
  );
  // The constructor only CAPTURES the seam; it must not eagerly build an LLM.
  assert.equal(llmCalls, 0);
});
