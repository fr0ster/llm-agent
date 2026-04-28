import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { McpError } from '@mcp-abap-adt/llm-agent';
import { McpClientAdapter } from '../mcp-client-adapter.js';

// ---------------------------------------------------------------------------
// Duck-typed mock factory
// ---------------------------------------------------------------------------
function makeClient(overrides) {
  return overrides;
}
const TOOLS_FIXTURE = [
  {
    name: 'tool1',
    description: 'Tool one',
    inputSchema: { type: 'object', properties: {} },
  },
  { name: 'tool2' }, // missing description + inputSchema → defaults applied
];
// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('McpClientAdapter.listTools()', () => {
  it('success — maps raw tools to McpTool[]', async () => {
    const adapter = new McpClientAdapter(
      makeClient({ listTools: async () => TOOLS_FIXTURE }),
    );
    const r = await adapter.listTools();
    assert.ok(r.ok);
    assert.equal(r.value.length, 2);
    assert.equal(r.value[0].name, 'tool1');
    assert.equal(r.value[0].description, 'Tool one');
    assert.equal(r.value[1].description, ''); // default
    assert.deepEqual(r.value[1].inputSchema, {}); // default
  });
  it('error — wraps in McpError', async () => {
    const adapter = new McpClientAdapter(
      makeClient({
        listTools: async () => {
          throw new Error('connection lost');
        },
      }),
    );
    const r = await adapter.listTools();
    assert.ok(!r.ok);
    assert.ok(r.error instanceof McpError);
    assert.ok(r.error.message.includes('connection lost'));
  });
  it('McpError passthrough — same instance returned', async () => {
    const original = new McpError('upstream failure', 'UPSTREAM');
    const adapter = new McpClientAdapter(
      makeClient({
        listTools: async () => {
          throw original;
        },
      }),
    );
    const r = await adapter.listTools();
    assert.ok(!r.ok);
    assert.equal(r.error, original);
    assert.equal(r.error.code, 'UPSTREAM');
  });
  it('pre-aborted signal → ABORTED', async () => {
    const adapter = new McpClientAdapter(
      makeClient({ listTools: async () => [] }),
    );
    const ctrl = new AbortController();
    ctrl.abort();
    const r = await adapter.listTools({ signal: ctrl.signal });
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'ABORTED');
  });
});
describe('McpClientAdapter.callTool()', () => {
  it('success — result exposed as content', async () => {
    const adapter = new McpClientAdapter(
      makeClient({
        callTool: async (tc) => ({
          toolCallId: tc.id,
          name: tc.name,
          result: 'tool output',
        }),
      }),
    );
    const r = await adapter.callTool('my_tool', { param: 'value' });
    assert.ok(r.ok);
    assert.equal(r.value.content, 'tool output');
    assert.ok(!r.value.isError);
  });
  it('tool-level error — error string as content with isError=true', async () => {
    const adapter = new McpClientAdapter(
      makeClient({
        callTool: async (tc) => ({
          toolCallId: tc.id,
          name: tc.name,
          result: null,
          error: 'tool execution failed',
        }),
      }),
    );
    const r = await adapter.callTool('my_tool', {});
    assert.ok(r.ok);
    assert.equal(r.value.content, 'tool execution failed');
    assert.equal(r.value.isError, true);
  });
  it('throws — wraps in McpError', async () => {
    const adapter = new McpClientAdapter(
      makeClient({
        callTool: async () => {
          throw new Error('timeout');
        },
      }),
    );
    const r = await adapter.callTool('my_tool', {});
    assert.ok(!r.ok);
    assert.ok(r.error instanceof McpError);
  });
  it('pre-aborted signal → ABORTED', async () => {
    const adapter = new McpClientAdapter(
      makeClient({
        callTool: async (tc) => ({
          toolCallId: tc.id,
          name: tc.name,
          result: 'ok',
        }),
      }),
    );
    const ctrl = new AbortController();
    ctrl.abort();
    const r = await adapter.callTool('my_tool', {}, { signal: ctrl.signal });
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'ABORTED');
  });
});
//# sourceMappingURL=mcp-client-adapter.test.js.map
