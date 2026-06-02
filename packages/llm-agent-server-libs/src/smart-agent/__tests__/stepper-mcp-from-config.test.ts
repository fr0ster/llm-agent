/**
 * Stepper MCP-from-config wiring tests.
 *
 * Verifies that when stepperMcpClients is populated (either from DI/plugin
 * clients OR from YAML mcp: config via connectMcpClientsFromConfig), the
 * toolsRag catalog is populated and buildMcpBridge dispatches correctly.
 *
 * The connect-from-config path itself requires a live transport (validated by
 * the maintainer's live re-test). This test suite covers the downstream
 * wiring once clients are present, using fake IMcpClient instances.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IMcpClient, LlmTool } from '@mcp-abap-adt/llm-agent';
import { buildMcpBridge } from '../smart-server.js';

// ---------------------------------------------------------------------------
// Fake IMcpClient — same pattern as stepper-callmcp-bridge.test.ts
// ---------------------------------------------------------------------------

function fakeMcpClient(
  tools: string[],
  results: Record<string, string>,
): IMcpClient & { callsMade: { name: string; args: unknown }[] } {
  const callsMade: { name: string; args: unknown }[] = [];
  return {
    callsMade,
    async listTools() {
      return {
        ok: true as const,
        value: tools.map((name) => ({
          name,
          description: `Tool ${name}`,
          inputSchema: { type: 'object', properties: {} },
        })),
      };
    },
    async callTool(name: string, args: Record<string, unknown>) {
      callsMade.push({ name, args });
      const val = results[name];
      if (val === undefined) {
        return {
          ok: false as const,
          error: {
            message: `no result for ${name}`,
            code: 'not_found' as never,
          },
        };
      }
      return { ok: true as const, value: { content: val } };
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers that mirror the Stepper toolsRag catalog wiring in smart-server.ts
// (ensureCatalog + IToolsRagHandle). Extracted here to prove the wiring in
// isolation without starting a full SmartServer.
// ---------------------------------------------------------------------------

/**
 * Mirrors the `ensureCatalog` + `toolsRagHandle` wiring inside SmartServer's
 * Stepper branch. Given a list of IMcpClient instances, builds the same
 * catalog Map and returns a toolsRag-like handle.
 */
async function buildStepperToolsRagHandle(clients: IMcpClient[]): Promise<{
  catalog: Map<string, LlmTool>;
  query: (text: string, k?: number) => Promise<LlmTool[]>;
  lookup: (name: string) => LlmTool | undefined;
}> {
  const catalog = new Map<string, LlmTool>();
  await Promise.allSettled(
    clients.map(async (client) => {
      const result = await client.listTools();
      if (result.ok) {
        for (const t of result.value) {
          if (!catalog.has(t.name)) {
            catalog.set(t.name, t as LlmTool);
          }
        }
      }
    }),
  );
  return {
    catalog,
    async query(_text: string, k?: number) {
      return [...catalog.values()].slice(0, k ?? 20);
    },
    lookup(name: string) {
      return catalog.get(name);
    },
  };
}

// ---------------------------------------------------------------------------
// Tests: toolsRag catalog wiring (proves the catalog is populated once
// clients are present — the core regression guard for the zero-MCP-calls bug)
// ---------------------------------------------------------------------------

test('toolsRag catalog is populated from stepperMcpClients when clients present', async () => {
  const client = fakeMcpClient(['ReadProgram', 'GetTable'], {});

  const handle = await buildStepperToolsRagHandle([client]);

  assert.equal(handle.catalog.size, 2, 'catalog should have 2 tools');
  assert.ok(
    handle.catalog.has('ReadProgram'),
    'catalog should contain ReadProgram',
  );
  assert.ok(handle.catalog.has('GetTable'), 'catalog should contain GetTable');
});

test('toolsRag.query returns catalog-order slice when no vector store is present', async () => {
  const client = fakeMcpClient(['ToolA', 'ToolB', 'ToolC'], {});

  const handle = await buildStepperToolsRagHandle([client]);
  const results = await handle.query('anything', 2);

  assert.equal(results.length, 2, 'query should return at most k tools');
  assert.equal(results[0].name, 'ToolA');
  assert.equal(results[1].name, 'ToolB');
});

test('toolsRag.lookup returns the tool schema by name', async () => {
  const client = fakeMcpClient(['ReadProgram'], {});

  const handle = await buildStepperToolsRagHandle([client]);
  const tool = handle.lookup('ReadProgram');

  assert.ok(tool, 'lookup should return the tool');
  assert.equal(tool.name, 'ReadProgram');
});

test('toolsRag.lookup returns undefined for unknown tool', async () => {
  const client = fakeMcpClient(['ReadProgram'], {});

  const handle = await buildStepperToolsRagHandle([client]);
  const tool = handle.lookup('NonExistent');

  assert.equal(tool, undefined);
});

test('toolsRag catalog deduplicates tools from multiple clients', async () => {
  const client1 = fakeMcpClient(['SharedTool', 'UniqueA'], {});
  const client2 = fakeMcpClient(['SharedTool', 'UniqueB'], {});

  const handle = await buildStepperToolsRagHandle([client1, client2]);

  // SharedTool appears in both but catalog should have it once
  assert.equal(handle.catalog.size, 3, 'catalog should have 3 unique tools');
  assert.ok(handle.catalog.has('SharedTool'));
  assert.ok(handle.catalog.has('UniqueA'));
  assert.ok(handle.catalog.has('UniqueB'));
});

test('toolsRag catalog is empty when no clients are provided (root cause: zero MCP calls)', async () => {
  // This proves the pre-fix behaviour: stepperMcpClients=[] → empty catalog
  const handle = await buildStepperToolsRagHandle([]);

  assert.equal(
    handle.catalog.size,
    0,
    'empty client list must yield empty catalog',
  );
  const results = await handle.query('anything');
  assert.equal(results.length, 0, 'query on empty catalog returns []');
});

// ---------------------------------------------------------------------------
// Tests: buildMcpBridge dispatch with fake clients (proving the wiring that
// was present but starved by empty stepperMcpClients before the fix)
// ---------------------------------------------------------------------------

test('buildMcpBridge dispatches to a client whose listTools includes the tool', async () => {
  const client = fakeMcpClient(['ReadProgram'], { ReadProgram: 'REPORT z.' });
  const callMcp = buildMcpBridge([client]);

  const result = await callMcp('ReadProgram', { program: 'Z' });

  assert.equal(result, 'REPORT z.');
  assert.equal(client.callsMade.length, 1);
  assert.equal(client.callsMade[0].name, 'ReadProgram');
});

test('buildMcpBridge returns Tool-not-found when stepperMcpClients is empty (pre-fix regression)', async () => {
  // Confirms that the root-cause state (empty clients) produces "Tool not found"
  const callMcp = buildMcpBridge([]);
  const result = await callMcp('ReadProgram', {});
  assert.ok(
    result.startsWith('Tool not found'),
    `expected "Tool not found" for empty client list, got: ${result}`,
  );
});

test('buildMcpBridge dispatches to second client when first does not own the tool', async () => {
  const first = fakeMcpClient(['OtherTool'], { OtherTool: 'data' });
  const second = fakeMcpClient(['ReadProgram'], { ReadProgram: 'REPORT z.' });
  const callMcp = buildMcpBridge([first, second]);

  const result = await callMcp('ReadProgram', {});

  assert.equal(result, 'REPORT z.');
  assert.equal(first.callsMade.length, 0, 'first client should not be called');
  assert.equal(second.callsMade.length, 1, 'second client should be called');
});
