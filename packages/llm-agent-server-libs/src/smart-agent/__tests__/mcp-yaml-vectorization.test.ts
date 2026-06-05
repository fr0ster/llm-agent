/**
 * Regression test for the YAML `mcp:` tool-vectorization fix (PR #173).
 *
 * Background: collapsing the double MCP connection (inject the shared clients
 * into the startup builder via `withMcpClients`) regressed tool vectorization —
 * `SmartAgentBuilder.build()` only writes `tool:<name>` docs into the agent's
 * `toolsRag` (an `IRag`) when it CONNECTS from `cfg.mcp` itself; for INJECTED
 * clients it skips that step. So a YAML `mcp:` + `smart`/`flat` pipeline ended up
 * with an empty `toolsRag` and `ToolSelectHandler` selected NO MCP tools.
 *
 * The fix reverses the direction for the YAML-only case: the startup builder
 * CONNECTS + VECTORIZES from `cfg.mcp` (so `toolsRag` is seeded), and `start()`
 * HARVESTS the builder's connected set into `_sharedMcpClients` for `ctx.callMcp`
 * — keeping EXACTLY ONE connection.
 *
 * These tests prove BOTH invariants end-to-end against a minimal in-process MCP
 * streamable-HTTP server (no stdio spawn, no external network — a localhost
 * ephemeral port):
 *   1. After startup the agent's `toolsRag` CONTAINS the MCP tool docs
 *      (`tool:<name>`), i.e. vectorization is restored for the YAML path.
 *   2. The MCP server observed EXACTLY ONE `initialize` — single-connect is
 *      preserved (no regression of the double-connect fix).
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import type { IMcpClient, IRag } from '@mcp-abap-adt/llm-agent';
import { SmartServer } from '../smart-server.js';

// ---------------------------------------------------------------------------
// Minimal in-process MCP streamable-HTTP server (hermetic — no SDK, no spawn).
// Implements just enough of the JSON-RPC handshake the SDK client drives:
// `initialize` (with a session id), the `notifications/initialized` ACK, and
// `tools/list`. Counts `initialize` calls to assert single-connect.
// ---------------------------------------------------------------------------

interface McpStub {
  url: string;
  initializeCount: () => number;
  listToolsCount: () => number;
  close: () => Promise<void>;
}

async function startMcpStub(toolNames: string[]): Promise<McpStub> {
  let initializeCount = 0;
  let listToolsCount = 0;

  const reply = (
    res: http.ServerResponse,
    id: unknown,
    result: unknown,
  ): void => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
  };

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      let msg: { method?: string; id?: unknown };
      try {
        msg = JSON.parse(body);
      } catch {
        res.writeHead(202);
        res.end();
        return;
      }
      if (msg.method === 'initialize') {
        initializeCount += 1;
        res.setHeader('mcp-session-id', 'session-1');
        reply(res, msg.id, {
          protocolVersion: '2025-11-25',
          capabilities: { tools: {} },
          serverInfo: { name: 'mcp-stub', version: '1.0.0' },
        });
        return;
      }
      if (msg.method?.startsWith('notifications/')) {
        res.writeHead(202);
        res.end();
        return;
      }
      if (msg.method === 'tools/list') {
        listToolsCount += 1;
        reply(res, msg.id, {
          tools: toolNames.map((name) => ({
            name,
            description: `Tool ${name}`,
            inputSchema: { type: 'object', properties: {} },
          })),
        });
        return;
      }
      if (msg.method === 'tools/call') {
        reply(res, msg.id, { content: [{ type: 'text', text: 'ok' }] });
        return;
      }
      res.writeHead(202);
      res.end();
    });
  });

  // Reject (not hang/throw-uncaught) if the environment forbids binding a local
  // socket — some sandboxes block `listen` with EPERM/EACCES. The tests below
  // turn that rejection into a clean `t.skip()` rather than a false failure.
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp/stream/http`,
    initializeCount: () => initializeCount,
    listToolsCount: () => listToolsCount,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

/** White-box reach into the server's captured tools store + shared clients. */
type Internals = {
  _toolsRag?: IRag;
  _sharedMcpClients?: IMcpClient[];
};

/**
 * Start the stub MCP server, or — if the sandbox forbids binding a local socket
 * (EPERM/EACCES) — skip the test cleanly instead of failing. The assertions still
 * run in CI and any environment that permits `listen` (the repo already relies on
 * local `listen` in smart-server-session-lifecycle.test.ts).
 */
async function startStubOrSkip(
  t: { skip: (m?: string) => void },
  names: string[],
): Promise<McpStub | null> {
  try {
    return await startMcpStub(names);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'EPERM' || code === 'EACCES') {
      t.skip(`environment forbids server.listen (${code})`);
      return null;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------

test('YAML mcp: path — build() vectorizes MCP tools into toolsRag AND connects exactly once', async (t) => {
  const stub = await startStubOrSkip(t, ['EchoTool', 'GetTable']);
  if (!stub) return;
  const server = new SmartServer({
    port: 0,
    llm: { apiKey: 'test', model: 'test-model' },
    skipModelValidation: true,
    mode: 'smart',
    // In-memory store needs no embedder — it hashes text internally. The
    // builder seeds `tool:<name>` docs via `toolsRag.writer().upsertRaw`.
    rag: { type: 'in-memory' },
    // YAML-only MCP: no `mcpClients` DI ⇒ the startup builder owns the
    // connection ⇒ it vectorizes.
    mcp: { type: 'http', url: stub.url },
  });

  let handle: Awaited<ReturnType<SmartServer['start']>> | undefined;
  try {
    handle = await server.start();
    const internals = server as unknown as Internals;

    // --- Invariant 1: vectorization restored -------------------------------
    const toolsRag = internals._toolsRag;
    assert.ok(
      toolsRag,
      'toolsRag store must exist (rag: in-memory configured)',
    );

    const echo = await toolsRag.getById('tool:EchoTool');
    assert.ok(echo.ok && echo.value, 'tool:EchoTool must be vectorized');
    const table = await toolsRag.getById('tool:GetTable');
    assert.ok(table.ok && table.value, 'tool:GetTable must be vectorized');

    // --- Invariant 2: single connection ------------------------------------
    // The builder connected once; `_sharedMcpClients` was harvested from the
    // SAME built handle (no second connect).
    assert.equal(
      stub.initializeCount(),
      1,
      'MCP server must observe exactly ONE initialize (single connect)',
    );
    assert.ok(
      internals._sharedMcpClients && internals._sharedMcpClients.length === 1,
      'callMcp bridge reuses the single harvested client set',
    );
  } finally {
    if (handle) await handle.close();
    await stub.close();
  }
});

test('explicit empty mcpClients: [] disables MCP and overrides YAML mcp: (no connect)', async (t) => {
  // DI precedence: an explicitly-provided client set — even an EMPTY array — must
  // override the YAML `mcp:` block. `mcpClients: []` is a deliberate "disable MCP"
  // signal; the startup builder must receive withMcpClients([]) (short-circuit) and
  // NOT auto-connect the YAML block. Regression guard for the `hasDiOrPlugin`
  // presence-vs-length check.
  const stub = await startStubOrSkip(t, ['EchoTool']);
  if (!stub) return;
  const server = new SmartServer({
    port: 0,
    llm: { apiKey: 'test', model: 'test-model' },
    skipModelValidation: true,
    mode: 'smart',
    rag: { type: 'in-memory' },
    // Explicit empty DI set ⇒ MCP disabled, even though a YAML mcp: is present.
    mcpClients: [],
    mcp: { type: 'http', url: stub.url },
  });

  let handle: Awaited<ReturnType<SmartServer['start']>> | undefined;
  try {
    handle = await server.start();
    const internals = server as unknown as Internals;
    // The YAML mcp: must NOT have been connected.
    assert.equal(
      stub.initializeCount(),
      0,
      'explicit mcpClients: [] must override YAML mcp: — zero connections',
    );
    assert.ok(
      internals._sharedMcpClients && internals._sharedMcpClients.length === 0,
      'shared client set is the explicit empty DI array (MCP disabled)',
    );
  } finally {
    if (handle) await handle.close();
    await stub.close();
  }
});
