/**
 * #244 Task 7 — `_embeddedSessionParts` threads the shared
 * `_sharedMcpClientDescriptors`/`_configuredSlotCount` (captured from whichever
 * descriptor-producing seam won, per Task 4/6) into the assembled
 * `SessionAgentParts`, mirroring what the per-session lifecycle path now does.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IEmbedder, ILlm, IRagRegistry } from '@mcp-abap-adt/llm-agent';
import type { SessionAgentParts } from '@mcp-abap-adt/llm-agent-libs';
import { SmartServer, type SmartServerConfig } from '../smart-server.js';

const cannedLlm = {
  chat: async () => ({ ok: true, value: { content: 'ok', toolCalls: [] } }),
  model: 'stub',
} as unknown as ILlm;
const stubEmbedder = {
  embed: async () => ({ vector: [0] }),
} as unknown as IEmbedder;

const cfg = {
  skipModelValidation: true,
  llm: { main: { provider: 'openai', apiKey: 'x', model: 'gpt-4o' } },
} as unknown as SmartServerConfig;

interface Internals {
  _embeddedSessionParts: (
    mcpClients: unknown,
    ragRegistry: IRagRegistry,
  ) => SessionAgentParts;
}

test('_embeddedSessionParts result carries mcpClientDescriptors/configuredSlotCount matching the shared descriptor-producing seam', async () => {
  const descriptors = [
    { slotIndex: 0, label: 'a' },
    { slotIndex: 1, label: 'b' },
  ];
  const server = new SmartServer(cfg, {
    makeLlm: async () => cannedLlm,
    embedder: stubEmbedder,
    connectMcpWithDescriptors: async () => ({
      clients: [],
      clientDescriptors: descriptors,
      configuredSlotCount: 2,
    }),
  });

  // Populate `_sharedMcpClientDescriptors`/`_configuredSlotCount` via the same
  // path a real request would (buildSharedPipelineInfra inside _buildInfra,
  // reached here via the public embeddable-agent entry point).
  const built = await server._buildEmbeddedAgent();
  try {
    const stubRagRegistry = {} as IRagRegistry;
    const parts = (server as unknown as Internals)._embeddedSessionParts(
      undefined,
      stubRagRegistry,
    );
    assert.deepEqual(parts.mcpClientDescriptors, descriptors);
    assert.equal(parts.configuredSlotCount, 2);
    assert.equal(parts.ragRegistry, stubRagRegistry);
  } finally {
    await built.close();
  }
});
