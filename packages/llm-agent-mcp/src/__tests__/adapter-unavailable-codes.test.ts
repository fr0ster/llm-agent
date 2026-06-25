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
  // adapter must escalate an availability signature even on the returned path.
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
