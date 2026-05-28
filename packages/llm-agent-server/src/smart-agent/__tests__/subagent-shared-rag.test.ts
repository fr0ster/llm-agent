import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SimpleRagRegistry } from '@mcp-abap-adt/llm-agent';
import { resolveSubAgentRagRegistry } from '../smart-server.js';

test('subagent reuses the injected parent registry instead of a fresh one', () => {
  const parent = new SimpleRagRegistry();
  assert.equal(
    resolveSubAgentRagRegistry({ parentRagRegistry: parent }),
    parent,
  );
});

test('without an injected parent registry, returns undefined (builder allocates its own)', () => {
  assert.equal(
    resolveSubAgentRagRegistry({ parentRagRegistry: undefined }),
    undefined,
  );
});
