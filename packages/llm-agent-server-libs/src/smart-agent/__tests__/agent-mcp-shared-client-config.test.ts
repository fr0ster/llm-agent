import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveAgentSection } from '../resolve-config-sections.js';

test('agent.mcpSharedClient absent → not set (per-session default)', () => {
  const a = resolveAgentSection({ agent: {} } as never, {});
  assert.equal(a.mcpSharedClient, undefined);
});

test('agent.mcpSharedClient: true → true', () => {
  const a = resolveAgentSection(
    { agent: { mcpSharedClient: true } } as never,
    {},
  );
  assert.equal(a.mcpSharedClient, true);
});
