import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IEmbedder } from '@mcp-abap-adt/llm-agent';
import { wrapEmbedder } from '../adapters/usage-logging-embedder.js';
import { SmartAgent } from '../agent.js';
import { makeDefaultDeps } from '../testing/index.js';

test('new SmartAgent(deps) wraps deps.embedder for usage metering', async () => {
  const plain: IEmbedder = { embed: async () => ({ vector: [1, 2, 3] }) };
  const { deps } = makeDefaultDeps();
  deps.embedder = plain;

  // Constructing the agent wraps the embedder in place.
  new SmartAgent(deps, { mode: 'smart' });

  // It is now a different (wrapped) instance...
  assert.notEqual(deps.embedder, plain, 'embedder should be wrapped');
  // ...idempotent (re-wrapping returns the same wrapped instance)...
  assert.equal(wrapEmbedder(deps.embedder as IEmbedder), deps.embedder);
  // ...and still delegates to the original embedder.
  assert.deepEqual(
    (await (deps.embedder as IEmbedder).embed('x')).vector,
    [1, 2, 3],
  );
});

test('a builder-prewrapped embedder is not double-wrapped by the ctor', () => {
  const plain: IEmbedder = { embed: async () => ({ vector: [9] }) };
  const prewrapped = wrapEmbedder(plain);
  const { deps } = makeDefaultDeps();
  deps.embedder = prewrapped;

  new SmartAgent(deps, { mode: 'smart' });

  // Idempotent: the ctor's wrapEmbedder returns the already-wrapped instance.
  assert.equal(deps.embedder, prewrapped);
});
