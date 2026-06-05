/**
 * F1 + F2 regression tests for `buildSharedPipelineInfra`:
 *
 *   F1 — the YAML `mcp:` block must be connected EXACTLY ONCE and shared. The
 *        single connected set lives on `_sharedMcpClients`; the startup builder
 *        receives THAT set via `withMcpClients` (suppressing a second
 *        auto-connect in `SmartAgentBuilder.build()`).
 *
 *   F2 — the production `toolsRag.lookup(name)` (a SYNC contract) must return a
 *        tool schema BEFORE any `query()` runs, because the catalog is now
 *        eagerly populated at startup.
 *
 * Both tests drive the REAL private `buildSharedPipelineInfra` method (cast to
 * reach it) against fake IMcpClient instances — no HTTP listen, no real stdio
 * process, fully hermetic.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  IMcpClient,
  IToolsRagHandle,
  LlmTool,
} from '@mcp-abap-adt/llm-agent';
import { SmartServer } from '../smart-server.js';

function fakeMcpClient(tools: string[]): IMcpClient {
  return {
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
    async callTool() {
      return { ok: true as const, value: { content: 'ok' } };
    },
  };
}

/** Reach the private method + private fields without changing visibility. */
type Internals = {
  buildSharedPipelineInfra(input: {
    toolsRag: undefined;
    resolvedEmbedder: undefined;
    mcpClients: IMcpClient[] | undefined;
  }): Promise<void>;
  _sharedMcpClients?: IMcpClient[];
  _toolsRagHandle?: IToolsRagHandle;
};

// ---------------------------------------------------------------------------
// F1 — single connection / shared client identity
// ---------------------------------------------------------------------------

test('F1: DI/plugin clients are shared verbatim — _sharedMcpClients is the SAME instance fed to the builder', async () => {
  const di = [fakeMcpClient(['ReadProgram'])];
  const server = new SmartServer({}) as unknown as Internals;

  await server.buildSharedPipelineInfra({
    toolsRag: undefined,
    resolvedEmbedder: undefined,
    mcpClients: di,
  });

  // The single connected set the callMcp bridge uses === the array `start()`
  // hands to the builder via `withMcpClients`. Same instance ⇒ one connection.
  assert.strictEqual(
    server._sharedMcpClients,
    di,
    'shared clients must be the exact DI array (no re-connect / re-wrap)',
  );
});

test('F1: YAML-only path (no DI clients, no mcp config) yields an empty shared set and never connects', async () => {
  // `connectMcpClientsFromConfig(undefined)` returns [] — proves the YAML path
  // does not spawn anything when there is nothing to connect. The `start()`
  // mapping turns an empty shared set into `undefined` (no withMcpClients call),
  // and with no `cfg.mcp` the builder also has nothing to connect ⇒ zero
  // connections total.
  const server = new SmartServer({}) as unknown as Internals;

  await server.buildSharedPipelineInfra({
    toolsRag: undefined,
    resolvedEmbedder: undefined,
    mcpClients: undefined,
  });

  assert.deepEqual(
    server._sharedMcpClients,
    [],
    'no DI clients + no mcp config ⇒ empty shared set',
  );
});

// ---------------------------------------------------------------------------
// F2 — eager catalog: lookup() works BEFORE any query()
// ---------------------------------------------------------------------------

test('F2: toolsRag.lookup(name) returns the schema BEFORE any query() (eager catalog)', async () => {
  const di = [fakeMcpClient(['ReadProgram', 'GetTable'])];
  const server = new SmartServer({}) as unknown as Internals;

  await server.buildSharedPipelineInfra({
    toolsRag: undefined,
    resolvedEmbedder: undefined,
    mcpClients: di,
  });

  const handle = server._toolsRagHandle;
  assert.ok(handle, 'toolsRag handle must be built');

  // CRITICAL: no query() has run yet. Pre-fix this returned undefined because
  // catalogCache was only populated lazily inside query().
  const tool = handle.lookup('ReadProgram') as LlmTool | undefined;
  assert.ok(tool, 'lookup must return a tool BEFORE any query()');
  assert.equal(tool?.name, 'ReadProgram');

  assert.equal(
    handle.lookup('NonExistent'),
    undefined,
    'unknown tool still returns undefined',
  );
});
