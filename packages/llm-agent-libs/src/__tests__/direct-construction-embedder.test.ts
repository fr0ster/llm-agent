import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type IEmbedder, symmetricEmbedder } from '@mcp-abap-adt/llm-agent';
import { wrapEmbedder } from '../adapters/usage-logging-embedder.js';
import { SmartAgent } from '../agent.js';
import { makeDefaultDeps } from '../testing/index.js';

test('new SmartAgent(deps) uses the query embedder as given', async () => {
  const plain: IEmbedder = { embed: async () => ({ vector: [1, 2, 3] }) };
  // Usage metering wraps the IEmbedder UNDERNEATH the role, not the role.
  const query = symmetricEmbedder(wrapEmbedder(plain));
  const { deps } = makeDefaultDeps();
  deps.embedder = query;

  new SmartAgent(deps, { mode: 'smart' });

  assert.equal(deps.embedder, query, 'the agent does not re-wrap it');
  assert.deepEqual((await query.embedQuery('x')).vector, [1, 2, 3]);
});
