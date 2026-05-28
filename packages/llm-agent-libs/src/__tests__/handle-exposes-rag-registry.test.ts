import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SimpleRagRegistry } from '@mcp-abap-adt/llm-agent';
import { SmartAgentBuilder } from '../builder.js';
import { makeLlm } from '../testing/index.js';

test('build() exposes the ragRegistry it composed and an mcpClients array', async () => {
  const reg = new SimpleRagRegistry();
  const handle = await new SmartAgentBuilder({})
    .withMainLlm(makeLlm([{ content: 'hello' }]))
    .setRagRegistry(reg)
    .build();
  assert.equal(handle.ragRegistry, reg);
  assert.ok(Array.isArray(handle.mcpClients));
  await handle.close();
});
