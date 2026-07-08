import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildHttpTransportOptions, MCPClientWrapper } from '../client.js';

// ── Task 2 tests ────────────────────────────────────────────────────────────

test('buildHttpTransportOptions: no signal on requestInit', () => {
  const opts = buildHttpTransportOptions({ headers: { A: '1' } });
  assert.strictEqual(
    (opts.requestInit as Record<string, unknown>).signal,
    undefined,
    'requestInit must NOT carry a signal (MCP governs its own timeouts)',
  );
});

test('buildHttpTransportOptions: sets Accept header and merges caller headers', () => {
  const opts = buildHttpTransportOptions({ headers: { A: '1' } });
  assert.strictEqual(
    opts.requestInit.headers.Accept,
    'application/json, text/event-stream',
    'Accept header must be set',
  );
  assert.strictEqual(
    opts.requestInit.headers.A,
    '1',
    'caller header must be merged',
  );
});

test('buildHttpTransportOptions: passes sessionId through verbatim', () => {
  const opts = buildHttpTransportOptions({ sessionId: 'live-123' });
  assert.strictEqual(
    opts.sessionId,
    'live-123',
    'sessionId must be passed through',
  );
});

test('session-resume: live server-assigned sessionId takes priority over config.sessionId', () => {
  const wrapper = new MCPClientWrapper({
    transport: 'stream-http',
    url: 'http://localhost:9/mcp',
    sessionId: 'init',
  });

  // Simulate a server-assigned id captured on a prior connect.
  (wrapper as unknown as { sessionId: string }).sessionId = 'live-999';

  const resolved = (
    wrapper as unknown as { _sessionForConnect(): string | undefined }
  )._sessionForConnect();
  assert.strictEqual(
    resolved,
    'live-999',
    '_sessionForConnect() must return live id',
  );

  // The value the wrapper feeds buildHttpTransportOptions at connect must be the live id,
  // not config.sessionId. Verify via the helper: if the helper receives live-999 it returns it.
  const transportOpts = buildHttpTransportOptions({ sessionId: resolved });
  assert.strictEqual(
    transportOpts.sessionId,
    'live-999',
    'buildHttpTransportOptions must receive the live sessionId, not config.sessionId',
  );
});

// ── Task 1 tests (pre-existing) ──────────────────────────────────────────────

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
