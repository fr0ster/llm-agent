import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  InMemoryRagProvider,
  SimpleRagProviderRegistry,
  SimpleRagRegistry,
} from '@mcp-abap-adt/llm-agent';
import { SessionGraphFactory } from '../session-graph-factory.js';

test('the logger handed to buildAgent is the SAME instance the graph exposes', async () => {
  const providers = new SimpleRagProviderRegistry();
  providers.registerProvider(new InMemoryRagProvider({ name: 'mem' }));
  const reg = new SimpleRagRegistry();
  reg.setProviderRegistry(providers);

  let seenLogger: unknown;
  const factory = new SessionGraphFactory({
    mcpClientFactory: () => [],
    toolsRag: undefined,
    ragRegistry: reg,
    buildAgent: async (parts) => {
      seenLogger = parts.logger;
      return undefined;
    },
  });
  const g = await factory.build({ sessionId: 's1' });
  assert.equal(
    seenLogger,
    g.logger,
    "buildAgent receives the graph's session logger",
  );
});
