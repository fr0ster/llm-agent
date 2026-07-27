/**
 * #244 Task 4 — descriptor-producing connectors + seam detection/precedence.
 *
 * Group 1: `buildSessionMcpClients` pairs its clients with stable per-slot
 *   descriptors (`{ slotIndex, label }`) + `configuredSlotCount`.
 * Group 2: `connectMcpClientsWithDescriptorsFromConfig` is the real
 *   descriptor-producing implementation; the exported `connectMcpClientsFromConfig`
 *   stays a bare-array compat wrapper over it (unchanged public contract).
 *   Both are exercised with `undefined`/empty config — the connect-from-config
 *   path itself requires a live transport (see stepper-mcp-from-config.test.ts);
 *   the empty-config path proves the shape without a network dependency.
 * Group 3/4: `BuildAgentDeps.connectMcpWithDescriptors` is detected as an MCP
 *   seam (`_mcpSeamInjected`) and takes precedence over a bare `connectMcp`
 *   when both are injected.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IEmbedder, ILlm } from '@mcp-abap-adt/llm-agent';
import {
  connectMcpClientsFromConfig,
  connectMcpClientsWithDescriptorsFromConfig,
  SmartServer,
  type SmartServerConfig,
} from '../../smart-server.js';
import { buildSessionMcpClients } from '../build-session-mcp-clients.js';

// ---------------------------------------------------------------------------
// Group 1 — buildSessionMcpClients descriptors
// ---------------------------------------------------------------------------

test('buildSessionMcpClients pairs clients with slotIndex+label descriptors', () => {
  const cfgA = {
    type: 'http' as const,
    url: 'http://localhost:9990/a/mcp/stream/http',
    name: 'a',
  };
  const cfgB = {
    type: 'http' as const,
    url: 'http://localhost:9991/b/mcp/stream/http',
    name: 'b',
  };

  const result = buildSessionMcpClients([cfgA, cfgB]);

  assert.equal(result.clients.length, 2);
  assert.deepEqual(result.clientDescriptors, [
    { slotIndex: 0, label: 'a' },
    { slotIndex: 1, label: 'b' },
  ]);
  assert.equal(result.configuredSlotCount, 2);
  assert.equal(typeof result.close, 'function');
});

test('buildSessionMcpClients undefined config → empty descriptors + zero configuredSlotCount', async () => {
  const result = buildSessionMcpClients(undefined);
  assert.deepEqual(result.clients, []);
  assert.deepEqual(result.clientDescriptors, []);
  assert.equal(result.configuredSlotCount, 0);
  await result.close(); // must not throw
});

// ---------------------------------------------------------------------------
// Group 2 — connectMcpClientsWithDescriptorsFromConfig + compat wrapper
// ---------------------------------------------------------------------------

test('connectMcpClientsWithDescriptorsFromConfig returns the McpClientsWithDescriptors shape', async () => {
  const result = await connectMcpClientsWithDescriptorsFromConfig(undefined);
  assert.deepEqual(result, {
    clients: [],
    clientDescriptors: [],
    configuredSlotCount: 0,
  });
});

test('connectMcpClientsFromConfig (compat) still returns a bare IMcpClient[]', async () => {
  const result = await connectMcpClientsFromConfig(undefined);
  assert.deepEqual(result, []);
  assert.ok(Array.isArray(result));
});

// ---------------------------------------------------------------------------
// Group 3/4 — seam detection + precedence
// ---------------------------------------------------------------------------

const cannedLlm = {
  chat: async () => ({ ok: true, value: { content: 'ok', toolCalls: [] } }),
  model: 'stub',
} as unknown as ILlm;
const stubEmbedder = {
  embed: async () => ({ vector: [0] }),
} as unknown as IEmbedder;

const mcpCfg = {
  skipModelValidation: true,
  llm: { main: { provider: 'openai', apiKey: 'x', model: 'gpt-4o' } },
  mcp: {
    type: 'http',
    url: 'http://127.0.0.1:9/should-not-connect/mcp/stream/http',
  },
} as unknown as SmartServerConfig;

test('seam detection: connectMcpWithDescriptors ONLY (no mcpClients/connectMcp) sets _mcpSeamInjected and is the sole provisioning point', async () => {
  let descriptorCalls = 0;
  const server = new SmartServer(mcpCfg, {
    makeLlm: async () => cannedLlm,
    embedder: stubEmbedder,
    connectMcpWithDescriptors: async () => {
      descriptorCalls++;
      return { clients: [], clientDescriptors: [], configuredSlotCount: 0 };
    },
  });

  assert.equal(
    (server as unknown as { _mcpSeamInjected: boolean })._mcpSeamInjected,
    true,
    'injecting connectMcpWithDescriptors alone must set _mcpSeamInjected',
  );

  const built = await server._buildEmbeddedAgent();
  assert.equal(
    descriptorCalls,
    1,
    'the injected connectMcpWithDescriptors must be invoked exactly once — ' +
      'the YAML-builder self-connect path must not run instead',
  );
  await built.close();
});

test('precedence: connectMcpWithDescriptors wins over a bare connectMcp when both are injected', async () => {
  let descriptorCalls = 0;
  let bareCalls = 0;
  const server = new SmartServer(mcpCfg, {
    makeLlm: async () => cannedLlm,
    embedder: stubEmbedder,
    connectMcpWithDescriptors: async () => {
      descriptorCalls++;
      return { clients: [], clientDescriptors: [], configuredSlotCount: 0 };
    },
    connectMcp: async () => {
      bareCalls++;
      return [];
    },
  });

  const built = await server._buildEmbeddedAgent();
  assert.equal(
    descriptorCalls,
    1,
    'connectMcpWithDescriptors must be invoked when both seams are injected',
  );
  assert.equal(
    bareCalls,
    0,
    'the bare connectMcp must NOT run when connectMcpWithDescriptors is present',
  );
  await built.close();
});
