import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  IMcpClient,
  IMcpFailureClassifier,
  McpClientDescriptor,
} from '@mcp-abap-adt/llm-agent';
import { McpError } from '@mcp-abap-adt/llm-agent';
import {
  buildNamespacedMcpBridge,
  rebindProvenanceToClients,
} from '../namespaced-bridge.js';

function fakeClient(
  calls: Array<{ name: string; args: unknown }>,
  content = 'ok',
): IMcpClient {
  return {
    async listTools() {
      return { ok: true as const, value: [] };
    },
    async callTool(name: string, args: unknown) {
      calls.push({ name, args });
      return { ok: true as const, value: { content, isError: false } };
    },
  } as unknown as IMcpClient;
}

// ---------------------------------------------------------------------------
// rebindProvenanceToClients
// ---------------------------------------------------------------------------

test('rebind: namespaced entry reaches the matching-slotIndex client with the ORIGINAL name', async () => {
  const client0Calls: Array<{ name: string; args: unknown }> = [];
  const client1Calls: Array<{ name: string; args: unknown }> = [];
  const client0 = fakeClient(client0Calls);
  const client1 = fakeClient(client1Calls);
  const descriptors: McpClientDescriptor[] = [
    { slotIndex: 0 },
    { slotIndex: 1 },
  ];
  const provenance = new Map<
    string,
    { slotIndex: number; originalName: string }
  >([
    ['s0__Search', { slotIndex: 0, originalName: 'Search' }],
    ['s1__Search', { slotIndex: 1, originalName: 'Search' }],
  ]);

  const map = rebindProvenanceToClients(
    provenance,
    [client0, client1],
    descriptors,
  );

  const boundS1 = map.get('s1__Search');
  assert.ok(boundS1);
  await boundS1?.callTool('s1__Search', {});
  // The wrapper must strip namespacing on the wire and hit client 1, not client 0.
  assert.deepEqual(client1Calls, [{ name: 'Search', args: {} }]);
  assert.deepEqual(client0Calls, []);
});

test('rebind: a bare (non-namespaced) exposed name maps to the REAL client (identity ===)', () => {
  const client0 = fakeClient([]);
  const client1 = fakeClient([]);
  const descriptors: McpClientDescriptor[] = [
    { slotIndex: 0 },
    { slotIndex: 1 },
  ];
  const provenance = new Map<
    string,
    { slotIndex: number; originalName: string }
  >([['Unique', { slotIndex: 1, originalName: 'Unique' }]]);

  const map = rebindProvenanceToClients(
    provenance,
    [client0, client1],
    descriptors,
  );

  assert.equal(map.get('Unique'), client1);
});

test('rebind: descriptors absent → client resolved by array index === slotIndex', async () => {
  const client0Calls: Array<{ name: string; args: unknown }> = [];
  const client1Calls: Array<{ name: string; args: unknown }> = [];
  const client0 = fakeClient(client0Calls);
  const client1 = fakeClient(client1Calls);
  const provenance = new Map<
    string,
    { slotIndex: number; originalName: string }
  >([['s1__Search', { slotIndex: 1, originalName: 'Search' }]]);

  const map = rebindProvenanceToClients(provenance, [client0, client1]);

  await map.get('s1__Search')?.callTool('s1__Search', {});
  assert.deepEqual(client1Calls, [{ name: 'Search', args: {} }]);
  assert.deepEqual(client0Calls, []);
});

test('rebind: a slotIndex with no matching client is SKIPPED (no map key, no throw)', () => {
  const client0 = fakeClient([]);
  const descriptors: McpClientDescriptor[] = [{ slotIndex: 0 }];
  const provenance = new Map<
    string,
    { slotIndex: number; originalName: string }
  >([
    ['s0__Search', { slotIndex: 0, originalName: 'Search' }],
    // slot 1 never (re)connected this session — fewer clients than provenance slots.
    ['s1__Search', { slotIndex: 1, originalName: 'Search' }],
  ]);

  assert.doesNotThrow(() => {
    const map = rebindProvenanceToClients(provenance, [client0], descriptors);
    assert.ok(map.has('s0__Search'));
    assert.ok(!map.has('s1__Search'));
  });
});

test('rebind: gapped descriptor set — slotIndex 2 routes to the SECOND client (descriptor-array position), not clients[2]', async () => {
  const client0Calls: Array<{ name: string; args: unknown }> = [];
  const client2Calls: Array<{ name: string; args: unknown }> = [];
  const client0 = fakeClient(client0Calls);
  const client2 = fakeClient(client2Calls);
  // Only slots 0 and 2 are active this session (slot 1 filtered out / never
  // (re)connected) — descriptors are NOT contiguous, so `clients[slotIndex]`
  // would be out of range for slotIndex 2 (clients has length 2).
  const descriptors: McpClientDescriptor[] = [
    { slotIndex: 0 },
    { slotIndex: 2 },
  ];
  const provenance = new Map<
    string,
    { slotIndex: number; originalName: string }
  >([
    ['s0__Search', { slotIndex: 0, originalName: 'Search' }],
    ['s2__Search', { slotIndex: 2, originalName: 'Search' }],
  ]);

  const map = rebindProvenanceToClients(
    provenance,
    [client0, client2],
    descriptors,
  );

  const boundS2 = map.get('s2__Search');
  assert.ok(boundS2);
  await boundS2?.callTool('s2__Search', {});
  // Must hit client2 (the SECOND client in the array, at descriptor-array
  // position 1) with the ORIGINAL name, never client0 and never a
  // `clients[2]` out-of-range lookup.
  assert.deepEqual(client2Calls, [{ name: 'Search', args: {} }]);
  assert.deepEqual(client0Calls, []);

  const boundS0 = map.get('s0__Search');
  assert.ok(boundS0);
  await boundS0?.callTool('s0__Search', {});
  assert.deepEqual(client0Calls, [{ name: 'Search', args: {} }]);
});

test('rebind: gapped descriptor set — a provenance slotIndex with NO matching descriptor is SKIPPED (no throw)', () => {
  const client0 = fakeClient([]);
  const client2 = fakeClient([]);
  const descriptors: McpClientDescriptor[] = [
    { slotIndex: 0 },
    { slotIndex: 2 },
  ];
  // slot 1 is referenced by stale provenance but no descriptor carries it
  // this session (it was filtered out / never reconnected).
  const provenance = new Map<
    string,
    { slotIndex: number; originalName: string }
  >([['s1__Search', { slotIndex: 1, originalName: 'Search' }]]);

  assert.doesNotThrow(() => {
    const map = rebindProvenanceToClients(
      provenance,
      [client0, client2],
      descriptors,
    );
    assert.ok(!map.has('s1__Search'));
  });
});

// ---------------------------------------------------------------------------
// buildNamespacedMcpBridge
// ---------------------------------------------------------------------------

test('bridge: unknown name → Tool not found, isError true, no client called', async () => {
  const calls: Array<{ name: string; args: unknown }> = [];
  const client = fakeClient(calls);
  const map = new Map<string, IMcpClient>([['Known', client]]);
  const bridge = buildNamespacedMcpBridge(map);

  const result = await bridge('Unknown', {});
  assert.equal(result.isError, true);
  assert.match(result.text, /Tool not found/);
  assert.deepEqual(calls, []);
});

test('bridge: success returns text + isError:false', async () => {
  const calls: Array<{ name: string; args: unknown }> = [];
  const client = fakeClient(calls, 'hello');
  const map = new Map<string, IMcpClient>([['Known', client]]);
  const bridge = buildNamespacedMcpBridge(map);

  const result = await bridge('Known', { a: 1 });
  assert.deepEqual(result, { text: 'hello', isError: false });
  assert.deepEqual(calls, [{ name: 'Known', args: { a: 1 } }]);
});

test('bridge: classifier deems the error "unavailable" → THROWS (fail loud)', async () => {
  const alwaysUnavailable: IMcpFailureClassifier = {
    classify: async () => 'unavailable',
  };
  const client = {
    async callTool() {
      return {
        ok: false as const,
        error: new McpError('down', 'MCP_NOT_CONNECTED'),
      };
    },
  } as unknown as IMcpClient;
  const map = new Map<string, IMcpClient>([['Flaky', client]]);
  const bridge = buildNamespacedMcpBridge(map, alwaysUnavailable);

  await assert.rejects(() => bridge('Flaky', {}), /down/);
});

test('bridge: classifier deems the error "tool-error" → returns isError:true with message (no throw)', async () => {
  const alwaysToolError: IMcpFailureClassifier = {
    classify: async () => 'tool-error',
  };
  const client = {
    async callTool() {
      return {
        ok: false as const,
        error: new McpError('table not found', 'MCP_ERROR'),
      };
    },
  } as unknown as IMcpClient;
  const map = new Map<string, IMcpClient>([['Bad', client]]);
  const bridge = buildNamespacedMcpBridge(map, alwaysToolError);

  assert.deepEqual(await bridge('Bad', {}), {
    text: 'table not found',
    isError: true,
  });
});
