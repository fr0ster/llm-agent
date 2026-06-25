import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isMcpUnavailable } from '@mcp-abap-adt/llm-agent';
import { McpClientAdapter } from '../adapter.js';

function adapterThatThrows(err: unknown): McpClientAdapter {
  const stub = {
    callTool: async () => {
      throw err;
    },
    listTools: async () => {
      throw err;
    },
    ping: async () => {
      throw err;
    },
  };
  return new McpClientAdapter(stub as never);
}

test('callTool transport error → unavailable McpError', async () => {
  const a = adapterThatThrows(new Error('Not connected'));
  const r = await a.callTool('GetTable', {});
  assert.equal(r.ok, false);
  assert.equal(isMcpUnavailable(r.ok ? undefined : r.error), true);
});

test('callTool MCP -32001 timeout → unavailable McpError', async () => {
  const a = adapterThatThrows(new Error('MCP error -32001: Request timed out'));
  const r = await a.callTool('GetTable', {});
  assert.equal(r.ok, false);
  assert.equal(isMcpUnavailable(r.ok ? undefined : r.error), true);
});

test('callTool that RETURNS { error: "Not connected" } → ok:false (not isError text)', async () => {
  // The real wrapper returns { result:null, error } after a failed reconnect; the
  // adapter must escalate a CONNECTION-LOSS signature even on the returned path.
  const stub = {
    callTool: async () => ({
      toolCallId: '1',
      name: 'GetTable',
      result: null,
      error: 'Not connected',
    }),
  };
  const a = new McpClientAdapter(stub as never);
  const r = await a.callTool('GetTable', {});
  assert.equal(r.ok, false, 'returned availability error must be ok:false');
  assert.equal(isMcpUnavailable(r.ok ? undefined : r.error), true);
});

// A RETURNED tool error that merely CONTAINS transport/timeout/HTTP words is
// DOMAIN feedback (the tool ran) — it must stay ok:true/isError, NOT escalate.
const RETURNED_DOMAIN_ERRORS = [
  'Transport request ZDEVK900123 not found',
  'Business network id is invalid',
  'request timed out waiting for user approval',
  'access forbidden for user JDOE',
];
for (const err of RETURNED_DOMAIN_ERRORS) {
  test(`callTool RETURNS domain error "${err.slice(0, 24)}…" → ok:true/isError`, async () => {
    const stub = {
      callTool: async () => ({ toolCallId: '1', name: 'X', result: null, error: err }),
    };
    const a = new McpClientAdapter(stub as never);
    const r = await a.callTool('X', {});
    assert.equal(r.ok, true, `${err} must stay tool feedback`);
    assert.equal(r.ok && r.value.isError, true);
  });
}
