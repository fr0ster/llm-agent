import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type IEmbedder,
  InMemoryRag,
  type IRagRegistry,
} from '@mcp-abap-adt/llm-agent';
import type { SessionGraphIdentity } from '@mcp-abap-adt/llm-agent-libs';
import { SmartServer, type SmartServerConfig } from '../smart-server.js';
import { constructionSeams } from './construction-seams.js';

const stubEmbedder = {
  embed: async () => ({ vector: [0] }),
} as unknown as IEmbedder;
const cfg = {
  skipModelValidation: true,
  llm: { main: { provider: 'openai', model: 'gpt-4o' } },
} as unknown as SmartServerConfig;

interface Internals {
  _globalRagRegistry: IRagRegistry;
  _sessionRagRegistry: (
    identity: SessionGraphIdentity,
  ) => Promise<IRagRegistry>;
}

test('every session gets its own registry, seeded with the deployment’s globals', async () => {
  const server = new SmartServer(cfg, {
    ...constructionSeams,
    embedder: stubEmbedder,
  });
  const built = await server._buildEmbeddedAgent();
  try {
    const internals = server as unknown as Internals;
    const kb = new InMemoryRag();
    internals._globalRagRegistry.register('kb', kb, undefined, {
      displayName: 'kb',
      scope: 'global',
    });

    const a = await internals._sessionRagRegistry({ sessionId: 'a' });
    const b = await internals._sessionRagRegistry({ sessionId: 'b' });
    assert.notEqual(a, b);
    assert.notEqual(a, internals._globalRagRegistry);
    assert.equal(a.get('kb', 'global'), kb);

    a.register('mine', new InMemoryRag(), undefined, {
      displayName: 'mine',
      scope: 'session',
      sessionId: 'a',
    });
    assert.equal(
      b.get('mine'),
      undefined,
      'one session’s collection is absent from another’s registry',
    );
    assert.equal(
      internals._globalRagRegistry.get('mine'),
      undefined,
      'and from the deployment’s',
    );
  } finally {
    await built.close();
  }
});
