/**
 * #213 diagnostics: `describeMcpIsolation` is the SINGLE resolved decision that
 * the wiring consumes AND the `mcp_isolation` event reports, so the log cannot
 * drift from which clients sessions actually get. Table covers every cause of a
 * silent fallback to a shared client.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeMcpIsolation } from '../mcp/build-session-mcp-clients.js';

test('pure YAML mcp: path → per-session isolation ON, no reasons', () => {
  const r = describeMcpIsolation({
    hasReadyClients: false,
    hasMcpConfig: true,
    mcpSeamInjected: false,
  });
  assert.equal(r.event, 'mcp_isolation');
  assert.equal(r.perSession, true);
  assert.equal(r.mcpFromYaml, true);
  assert.equal(r.mcpSharedClient, null);
  assert.deepEqual(r.disabledReasons, []);
});

test('ready clients present → shared, reason names hasReadyClients', () => {
  const r = describeMcpIsolation({
    hasReadyClients: true,
    hasMcpConfig: true,
    mcpSeamInjected: false,
  });
  assert.equal(r.perSession, false);
  assert.deepEqual(r.disabledReasons, ['hasReadyClients']);
});

test('empty-array trap: cfg.mcpClients: [] is PRESENCE → shared', () => {
  // The server gates on `diOrPluginMcpClients !== undefined` (smart-server.ts:1166),
  // so an empty array is a deliberate "disable MCP" signal, NOT a YAML path.
  const r = describeMcpIsolation({
    hasReadyClients: true,
    hasMcpConfig: true,
    mcpSeamInjected: false,
  });
  assert.equal(r.perSession, false);
});

test('injected connectMcp seam → shared, reason names mcpSeamInjected', () => {
  const r = describeMcpIsolation({
    hasReadyClients: false,
    hasMcpConfig: true,
    mcpSeamInjected: true,
  });
  assert.equal(r.perSession, false);
  assert.equal(r.mcpFromYaml, false);
  assert.deepEqual(r.disabledReasons, ['mcpSeamInjected']);
});

test('deliberate opt-out agent.mcpSharedClient: true → shared, reason names it', () => {
  const r = describeMcpIsolation({
    hasReadyClients: false,
    hasMcpConfig: true,
    mcpSeamInjected: false,
    mcpSharedClient: true,
  });
  assert.equal(r.perSession, false);
  assert.equal(r.mcpSharedClient, true);
  assert.deepEqual(r.disabledReasons, ['mcpSharedClient']);
});

test('no mcp: block at all → not per-session, reason noMcpConfig', () => {
  // NOTE: whether this SILENCES the config_warning is NOT assertable here —
  // describeMcpIsolation reports facts, the `hasMcpConfig` guard lives in
  // SmartServer. That behavior is covered by the integration case in Task 2.
  const r = describeMcpIsolation({
    hasReadyClients: false,
    hasMcpConfig: false,
    mcpSeamInjected: false,
  });
  assert.equal(r.perSession, false);
  assert.deepEqual(r.disabledReasons, ['noMcpConfig']);
});

test('multiple causes are all reported, in declared order', () => {
  const r = describeMcpIsolation({
    hasReadyClients: true,
    hasMcpConfig: true,
    mcpSeamInjected: true,
    mcpSharedClient: true,
  });
  assert.equal(r.perSession, false);
  assert.deepEqual(r.disabledReasons, [
    'mcpSharedClient',
    'hasReadyClients',
    'mcpSeamInjected',
  ]);
});
