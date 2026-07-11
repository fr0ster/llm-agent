/**
 * Task 5 / test (c) — SmartServer stores the instance classifier from BuildAgentDeps
 * and passes it to buildMcpBridge (Route B). Focused unit assertions; no HTTP I/O.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IMcpFailureClassifier } from '@mcp-abap-adt/llm-agent';
import type { SmartServerConfig } from '../smart-server.js';
import { SmartServer } from '../smart-server.js';

const MINIMAL_CFG = {
  llm: { main: { provider: 'openai', apiKey: 'x', model: 'gpt-4o' } },
} as unknown as SmartServerConfig;

test('(c) SmartServer: default constructor uses DefaultMcpFailureClassifier (non-null)', () => {
  const server = new SmartServer(MINIMAL_CFG);
  const classifier = (
    server as unknown as { _mcpFailureClassifier: IMcpFailureClassifier }
  )._mcpFailureClassifier;
  assert.ok(classifier, 'default classifier must be non-null');
  assert.equal(
    typeof classifier.classify,
    'function',
    'must implement IMcpFailureClassifier',
  );
});

test('(c) SmartServer: injected classifier from BuildAgentDeps is stored on _mcpFailureClassifier', () => {
  const custom: IMcpFailureClassifier = {
    classify: async () => 'unavailable',
  };
  const server = new SmartServer(MINIMAL_CFG, { mcpFailureClassifier: custom });
  const stored = (
    server as unknown as { _mcpFailureClassifier: IMcpFailureClassifier }
  )._mcpFailureClassifier;
  assert.strictEqual(
    stored,
    custom,
    'injected classifier must be stored on the server instance',
  );
});

test('(c) SmartServer: custom classifier is used by callMcp bridge (Route B)', async () => {
  let classifyCalled = false;
  const spy: IMcpFailureClassifier = {
    classify: async (_err, _probe) => {
      classifyCalled = true;
      // Treat everything as unavailable to make the bridge throw.
      return 'unavailable';
    },
  };

  // Inject a failing MCP client so buildMcpBridge invokes the classifier.
  const { McpError } = await import('@mcp-abap-adt/llm-agent');
  const failingClient = {
    async listTools() {
      return {
        ok: false as const,
        error: new McpError('Not connected', 'MCP_NOT_CONNECTED'),
      };
    },
    async callTool() {
      return { ok: true as const, value: { content: 'x', isError: false } };
    },
  };

  const server = new SmartServer(MINIMAL_CFG, { mcpFailureClassifier: spy });
  // Manually wire _sharedMcpClients (normally set by start()) so callMcp has clients.
  (server as unknown as { _sharedMcpClients: unknown[] })._sharedMcpClients = [
    failingClient as unknown as import('@mcp-abap-adt/llm-agent').IMcpClient,
  ];

  // Drive callMcp via the private method (reflect access for unit testing).
  const callMcp = (
    server as unknown as {
      callMcp: (n: string, a: unknown, s?: AbortSignal) => Promise<string>;
    }
  ).callMcp.bind(server);

  // callMcp → buildMcpBridge(clients, _mcpFailureClassifier) → classifier.classify.
  await assert.rejects(() => callMcp('GetTable', {}));
  assert.equal(
    classifyCalled,
    true,
    'custom classifier must be reached via Route B (callMcp → buildMcpBridge)',
  );
});
