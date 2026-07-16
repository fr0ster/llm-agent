import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  serverOwnsMcpConnection,
  shouldIsolateMcpPerSession,
} from '../mcp/build-session-mcp-clients.js';

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

// The `mcpFromYaml` derivation itself (previously an untested inline expression
// in smart-server.ts). Server owns the connection ONLY when it must connect
// itself: no ready clients, YAML `mcp:` present, and NO injected seam.
test('serverOwnsMcpConnection: no ready clients + YAML + no seam → true', () => {
  assert.equal(
    serverOwnsMcpConnection({
      hasReadyClients: false,
      hasMcpConfig: true,
      mcpSeamInjected: false,
    }),
    true,
  );
});

test('serverOwnsMcpConnection: injected seam + YAML + no ready clients → false (the bug)', () => {
  // Regression guard: with a `connectMcp` seam the per-session sync factory must
  // NOT be engaged (it would build RAW wrappers bypassing the seam) — stay shared.
  assert.equal(
    serverOwnsMcpConnection({
      hasReadyClients: false,
      hasMcpConfig: true,
      mcpSeamInjected: true,
    }),
    false,
  );
});

test('serverOwnsMcpConnection: ready clients present → false', () => {
  assert.equal(
    serverOwnsMcpConnection({
      hasReadyClients: true,
      hasMcpConfig: true,
      mcpSeamInjected: false,
    }),
    false,
  );
});

test('serverOwnsMcpConnection: no YAML mcp block → false', () => {
  assert.equal(
    serverOwnsMcpConnection({
      hasReadyClients: false,
      hasMcpConfig: false,
      mcpSeamInjected: false,
    }),
    false,
  );
});
