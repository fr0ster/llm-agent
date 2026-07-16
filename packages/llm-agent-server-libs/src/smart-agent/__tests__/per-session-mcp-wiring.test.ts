import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shouldIsolateMcpPerSession } from '../mcp/build-session-mcp-clients.js';

test('YAML mcp path with no opt-out → isolate per session', () => {
  assert.equal(
    shouldIsolateMcpPerSession({ mcpFromYaml: true, mcpSharedClient: false }),
    true,
  );
  assert.equal(shouldIsolateMcpPerSession({ mcpFromYaml: true }), true);
});

test('YAML mcp path with agent.mcpSharedClient: true → shared', () => {
  assert.equal(
    shouldIsolateMcpPerSession({ mcpFromYaml: true, mcpSharedClient: true }),
    false,
  );
});

test('ready-client path (mcpFromYaml=false) → shared regardless of opt-out', () => {
  assert.equal(
    shouldIsolateMcpPerSession({ mcpFromYaml: false, mcpSharedClient: false }),
    false,
  );
  assert.equal(
    shouldIsolateMcpPerSession({ mcpFromYaml: false, mcpSharedClient: true }),
    false,
  );
});
