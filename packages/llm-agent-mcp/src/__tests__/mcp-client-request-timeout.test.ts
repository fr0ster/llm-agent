import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MCPClientWrapper } from '../client.js';

test('callTool passes effectively-unbounded timeout and resetTimeoutOnProgress to SDK', async () => {
  const wrapper = new MCPClientWrapper({
    transport: 'stream-http',
    url: 'http://localhost:9/mcp',
  });

  let captured: { params: unknown; schema: unknown; options: unknown } | null =
    null;

  // Spy: replace the private SDK client with a stub that captures call args.
  (wrapper as unknown as { client: unknown }).client = {
    callTool: (
      params: unknown,
      schema: unknown,
      options: unknown,
    ): Promise<{ content: [] }> => {
      captured = { params, schema, options };
      return Promise.resolve({ content: [] });
    },
  };
  // Ensure the non-embedded code path is taken.
  (wrapper as unknown as { detectedTransport: string }).detectedTransport =
    'stream-http';

  await wrapper.callTool({ id: '1', name: 't', arguments: {} });

  assert.ok(captured !== null, 'callTool spy was not invoked');
  const opts = (captured as { options: unknown }).options as Record<
    string,
    unknown
  >;
  assert.ok(
    opts !== undefined && opts !== null,
    'RequestOptions (3rd arg) must be passed to SDK callTool',
  );
  const timeout = opts.timeout as number;
  assert.ok(
    typeof timeout === 'number' && timeout >= 86_400_000,
    `timeout must be >= 86_400_000 (24h), got ${timeout}`,
  );
  assert.strictEqual(
    opts.resetTimeoutOnProgress,
    true,
    'resetTimeoutOnProgress must be true',
  );
});
