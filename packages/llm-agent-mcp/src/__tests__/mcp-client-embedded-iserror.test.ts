import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MCPClientWrapper } from '../client.js';

// #213 regression: the embedded transport must preserve a tool-level `isError`
// exactly like the stdio/http path. An embedded callToolHandler that returns a
// normal MCP-shaped { content, isError:true } (a locked SAP object) must surface
// isError:true on the ToolResult — otherwise McpClientAdapter marks the failure
// as success and the controller retries the exact loop this work stops.

function embeddedWrapper(
  handler: (name: string, args: unknown) => Promise<unknown>,
): MCPClientWrapper {
  const wrapper = new MCPClientWrapper({
    transport: 'embedded',
    callToolHandler: handler,
  });
  // Force the embedded code path regardless of auto-detection.
  (wrapper as unknown as { detectedTransport: string }).detectedTransport =
    'embedded';
  return wrapper;
}

test('embedded: a tool-result isError:true is preserved on ToolResult', async () => {
  const wrapper = embeddedWrapper(async () => ({
    content: 'ZOBJ is locked by user ALICE',
    isError: true,
  }));

  const res = await wrapper.callTool({
    id: '1',
    name: 'UpdateObj',
    arguments: {},
  });

  assert.strictEqual(
    res.isError,
    true,
    'embedded isError:true must be preserved (not dropped like pre-fix)',
  );
  assert.strictEqual(
    res.result,
    'ZOBJ is locked by user ALICE',
    'content is still unwrapped from the MCP-shaped object',
  );
});

test('embedded: a normal successful result is isError:false', async () => {
  const wrapper = embeddedWrapper(async () => ({ content: 'ok' }));

  const res = await wrapper.callTool({
    id: '2',
    name: 'GetObj',
    arguments: {},
  });

  assert.strictEqual(
    res.isError,
    false,
    'a delivered success is isError:false',
  );
  assert.strictEqual(res.result, 'ok');
});

test('embedded: a bare non-object result is isError:false', async () => {
  const wrapper = embeddedWrapper(async () => 'plain string');

  const res = await wrapper.callTool({ id: '3', name: 'Ping', arguments: {} });

  assert.strictEqual(
    res.isError,
    false,
    'a non-object result cannot be an error',
  );
  assert.strictEqual(res.result, 'plain string');
});
