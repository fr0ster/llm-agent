import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildHttpTransportOptions,
  DEFAULT_MCP_REQUEST_TIMEOUT_MS,
  MCPClientWrapper,
  resolveToolTimeout,
} from '../client.js';

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

// ── Task 7 tests — resolveToolTimeout ────────────────────────────────────────

test('resolveToolTimeout: returns DEFAULT_MCP_REQUEST_TIMEOUT_MS (120000) when no config', () => {
  assert.strictEqual(
    resolveToolTimeout('T', {}),
    120_000,
    'must return 120000 when no timeout/toolTimeouts configured',
  );
  assert.strictEqual(
    DEFAULT_MCP_REQUEST_TIMEOUT_MS,
    120_000,
    'DEFAULT_MCP_REQUEST_TIMEOUT_MS must be 120000',
  );
});

test('resolveToolTimeout: returns config.timeout when no per-tool override', () => {
  assert.strictEqual(
    resolveToolTimeout('T', { timeout: 300_000 }),
    300_000,
    'must return config.timeout when no toolTimeouts entry for this tool',
  );
});

test('resolveToolTimeout: per-tool toolTimeouts wins over config.timeout', () => {
  assert.strictEqual(
    resolveToolTimeout('SlowTool', {
      timeout: 120_000,
      toolTimeouts: { SlowTool: 900_000 },
    }),
    900_000,
    'per-tool toolTimeouts entry must override config.timeout',
  );
});

// ── Task 1 tests (amended by Task 7) ─────────────────────────────────────────

test('callTool passes resolveToolTimeout result and resetTimeoutOnProgress to SDK', async () => {
  const configuredTimeout = 300_000;
  const toolTimeouts = { SlowTool: 900_000 };
  const wrapper = new MCPClientWrapper({
    transport: 'stream-http',
    url: 'http://localhost:9/mcp',
    timeout: configuredTimeout,
    toolTimeouts,
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

  // Call with a regular tool — should use config.timeout (300000).
  await wrapper.callTool({ id: '1', name: 'RegularTool', arguments: {} });

  assert.ok(captured !== null, 'callTool spy was not invoked');
  const opts = (captured as { options: unknown }).options as Record<
    string,
    unknown
  >;
  assert.ok(
    opts !== undefined && opts !== null,
    'RequestOptions (3rd arg) must be passed to SDK callTool',
  );
  assert.strictEqual(
    opts.timeout,
    resolveToolTimeout('RegularTool', {
      timeout: configuredTimeout,
      toolTimeouts,
    }),
    'timeout must equal resolveToolTimeout(name, config) — config.timeout for a regular tool',
  );
  assert.strictEqual(
    opts.resetTimeoutOnProgress,
    true,
    'resetTimeoutOnProgress must be true',
  );

  // Call with SlowTool — per-tool override should win (900000).
  captured = null;
  await wrapper.callTool({ id: '2', name: 'SlowTool', arguments: {} });

  assert.ok(captured !== null, 'callTool spy was not invoked for SlowTool');
  const slowOpts = (captured as { options: unknown }).options as Record<
    string,
    unknown
  >;
  assert.strictEqual(
    slowOpts.timeout,
    resolveToolTimeout('SlowTool', {
      timeout: configuredTimeout,
      toolTimeouts,
    }),
    'timeout must equal resolveToolTimeout(name, config) — toolTimeouts override for SlowTool',
  );
  assert.strictEqual(
    slowOpts.resetTimeoutOnProgress,
    true,
    'resetTimeoutOnProgress must be true for SlowTool',
  );
});
