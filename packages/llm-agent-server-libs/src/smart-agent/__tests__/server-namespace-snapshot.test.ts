/**
 * #244 Task 6 — the server obtains the ONE authoritative namespaced tool
 * snapshot (`{ namespacedTools, toolProvenance }`) from whichever source
 * applies, and feeds it into the tools-RAG handle catalog:
 *
 *   - yaml-builder path: the startup builder owns the MCP connection itself
 *     (YAML `mcp:`, no ready clients, no injected seam) and already computes
 *     the snapshot; the server harvests it from `agentHandle.namespacedTools`/
 *     `toolProvenance` right after `build()`.
 *   - seam / consumer-builder path: the builder never connects itself (ready
 *     clients or an injected `connectMcp`/`connectMcpWithDescriptors` seam), so
 *     its handle carries no snapshot — the server builds ONE itself via
 *     `resolveAuthoritativeSnapshot()` (`buildNamespacedTools` over
 *     `_sharedMcpClients` + `_sharedMcpClientDescriptors` + the server's
 *     `toolNamespace`), preserving the original per-client index on a partial
 *     `listTools()` failure (`settled.flatMap`, never `filter().map()`).
 *   - `BuildAgentDeps.toolNamespace` is DI'd onto BOTH the startup builder
 *     (`withToolNamespace`) and the server's own fallback build, so a custom
 *     naming rule reaches whichever snapshot source is authoritative.
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import type {
  IMcpClient,
  IToolNamespace,
  IToolsRagHandle,
  McpClientDescriptor,
} from '@mcp-abap-adt/llm-agent';
import { SmartServer } from '../smart-server.js';

// ---------------------------------------------------------------------------
// Minimal in-process MCP streamable-HTTP stub (hermetic — no SDK, no spawn).
// Handshake: `initialize` (with a session id), `notifications/initialized`
// ACK, `tools/list`. Adapted verbatim from mcp-yaml-vectorization.test.ts.
// ---------------------------------------------------------------------------

interface McpStub {
  url: string;
  close: () => Promise<void>;
}

async function startMcpStub(toolNames: string[]): Promise<McpStub> {
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
        res.setHeader('mcp-session-id', `session-${Math.random()}`);
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
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

/** Reject (not hang/throw-uncaught) if the sandbox forbids binding a local
 *  socket — turn it into a clean `t.skip()` rather than a false failure. */
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
// Fake IMcpClient — no network, used for the seam / fallback-build tests.
// ---------------------------------------------------------------------------

function fakeMcpClient(tools: string[], opts?: { fail?: boolean }): IMcpClient {
  return {
    async listTools() {
      if (opts?.fail) {
        return { ok: false as const, error: { message: 'listTools failed' } };
      }
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
  } as IMcpClient;
}

/** Reach the private snapshot-resolution surface without changing visibility. */
type Internals = {
  buildSharedPipelineInfra(input: {
    toolsRag: undefined;
    resolvedEmbedder: undefined;
    mcpClients: IMcpClient[] | undefined;
  }): Promise<void>;
  _buildEmbeddedAgent(): Promise<{
    agent: unknown;
    close: () => Promise<void>;
  }>;
  _toolsRagHandle?: IToolsRagHandle;
  _namespacedTools?: readonly { name: string }[];
  _toolProvenance?: ReadonlyMap<
    string,
    { slotIndex: number; originalName: string }
  >;
  _sharedMcpClients?: IMcpClient[];
  _sharedMcpClientDescriptors?: readonly McpClientDescriptor[];
};

// ---------------------------------------------------------------------------
// 1. yaml-builder path — the server exposes the handle's namespacedTools.
// ---------------------------------------------------------------------------

test('yaml path: startup-builder-owned MCP connect → server harvests the handle snapshot, catalog resolves s1__Search', async (t) => {
  const stub0 = await startStubOrSkip(t, ['Search']);
  if (!stub0) return;
  const stub1 = await startMcpStub(['Search']);
  try {
    const server = new SmartServer({
      llm: { apiKey: 'test', model: 'test-model' },
      skipModelValidation: true,
      // Two colliding "Search" servers, YAML-only (no ready clients, no
      // injected seam) ⇒ the startup builder owns the connect + the
      // namespaced-snapshot build itself.
      mcp: [
        { type: 'http', url: stub0.url },
        { type: 'http', url: stub1.url },
      ],
    }) as unknown as Internals;

    const built = await server._buildEmbeddedAgent();
    try {
      assert.ok(
        server._namespacedTools?.some((tt) => tt.name === 's1__Search'),
        'the harvested handle snapshot must contain the namespaced s1__Search tool',
      );
      assert.equal(
        server._toolProvenance?.get('s1__Search')?.slotIndex,
        1,
        'provenance must map s1__Search back to slot 1',
      );
      assert.ok(
        server._toolsRagHandle?.lookup('s1__Search'),
        'the tools-RAG handle catalog must resolve s1__Search',
      );
      assert.ok(
        server._toolsRagHandle?.lookup('s0__Search'),
        'the tools-RAG handle catalog must resolve s0__Search',
      );
    } finally {
      await built.close();
    }
  } finally {
    await stub0.close();
    await stub1.close();
  }
});

// ---------------------------------------------------------------------------
// 2. seam path — server builds the snapshot itself over injected clients.
// ---------------------------------------------------------------------------

test('seam path: connectMcpWithDescriptors colliding Search clients, no builder snapshot → server builds it, catalog resolves s0__Search/s1__Search', async () => {
  const c0 = fakeMcpClient(['Search']);
  const c1 = fakeMcpClient(['Search']);
  const server = new SmartServer(
    {},
    {
      connectMcpWithDescriptors: async () => ({
        clients: [c0, c1],
        clientDescriptors: [{ slotIndex: 0 }, { slotIndex: 1 }],
        configuredSlotCount: 2,
      }),
    },
  ) as unknown as Internals;

  await server.buildSharedPipelineInfra({
    toolsRag: undefined,
    resolvedEmbedder: undefined,
    mcpClients: undefined,
  });

  assert.ok(
    server._toolsRagHandle?.lookup('s0__Search'),
    'server-built snapshot must resolve s0__Search (no handle snapshot existed)',
  );
  assert.ok(
    server._toolsRagHandle?.lookup('s1__Search'),
    'server-built snapshot must resolve s1__Search',
  );
  assert.equal(server._toolProvenance?.get('s0__Search')?.slotIndex, 0);
  assert.equal(server._toolProvenance?.get('s1__Search')?.slotIndex, 1);
});

// ---------------------------------------------------------------------------
// 3. BuildAgentDeps.toolNamespace reaches the yaml-builder snapshot.
// ---------------------------------------------------------------------------

test('custom BuildAgentDeps.toolNamespace reaches the yaml-builder snapshot (assert PRIMARY__ prefix)', async (t) => {
  const stub = await startStubOrSkip(t, ['Search']);
  if (!stub) return;
  try {
    const primaryNamespace: IToolNamespace = {
      expose: ({ toolName }) => `PRIMARY__${toolName}`,
    };
    const server = new SmartServer(
      {
        llm: { apiKey: 'test', model: 'test-model' },
        skipModelValidation: true,
        mcp: { type: 'http', url: stub.url },
      },
      { toolNamespace: primaryNamespace },
    ) as unknown as Internals;

    const built = await server._buildEmbeddedAgent();
    try {
      assert.ok(
        server._namespacedTools?.some((tt) => tt.name === 'PRIMARY__Search'),
        'the custom toolNamespace must reach the yaml-builder snapshot',
      );
      assert.ok(
        server._toolsRagHandle?.lookup('PRIMARY__Search'),
        'the tools-RAG handle catalog must resolve the custom-prefixed name',
      );
    } finally {
      await built.close();
    }
  } finally {
    await stub.close();
  }
});

// ---------------------------------------------------------------------------
// 4. Server-side fallback build preserves the original client index on a
//    middle-client listTools() failure.
// ---------------------------------------------------------------------------

test('fallback build: middle-client listTools() failure keeps the surviving third client at slotIndex 2', async () => {
  const c0 = fakeMcpClient(['A']);
  const c1 = fakeMcpClient(['Broken'], { fail: true });
  const c2 = fakeMcpClient(['B']);
  const server = new SmartServer({}) as unknown as Internals;

  await server.buildSharedPipelineInfra({
    toolsRag: undefined,
    resolvedEmbedder: undefined,
    mcpClients: [c0, c1, c2],
  });

  assert.equal(
    server._toolProvenance?.get('B')?.slotIndex,
    2,
    'the third (surviving) client must keep slotIndex 2 despite the middle client failing — never filter().map()',
  );
  assert.equal(server._toolProvenance?.get('A')?.slotIndex, 0);
  assert.ok(server._toolsRagHandle?.lookup('B'));
  assert.ok(server._toolsRagHandle?.lookup('A'));
});
