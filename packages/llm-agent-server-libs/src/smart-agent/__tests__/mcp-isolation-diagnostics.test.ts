/**
 * #213 diagnostics: `describeMcpIsolation` is the SINGLE resolved decision that
 * the wiring consumes AND the `mcp_isolation` event reports, so the log cannot
 * drift from which clients sessions actually get. Table covers every cause of a
 * silent fallback to a shared client.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import type { IMcpClient } from '@mcp-abap-adt/llm-agent';
import { describeMcpIsolation } from '../mcp/build-session-mcp-clients.js';
import type { SmartServerConfig } from '../smart-server.js';
import { SmartServer } from '../smart-server.js';

test('pure YAML mcp: path → per-session isolation ON, no reasons', () => {
  const r = describeMcpIsolation({
    hasReadyClients: false,
    hasMcpConfig: true,
    mcpSeamInjected: false,
  });
  assert.equal(r.event, 'mcp_isolation');
  assert.equal(r.perSession, true);
  assert.equal(r.mcpFromYaml, true);
  assert.equal(r.mcpSharedClient, null);
  assert.deepEqual(r.disabledReasons, []);
});

test('ready clients present → shared, reason names hasReadyClients', () => {
  const r = describeMcpIsolation({
    hasReadyClients: true,
    hasMcpConfig: true,
    mcpSeamInjected: false,
  });
  assert.equal(r.perSession, false);
  assert.deepEqual(r.disabledReasons, ['hasReadyClients']);
});

test('injected connectMcp seam → shared, reason names mcpSeamInjected', () => {
  const r = describeMcpIsolation({
    hasReadyClients: false,
    hasMcpConfig: true,
    mcpSeamInjected: true,
  });
  assert.equal(r.perSession, false);
  assert.equal(r.mcpFromYaml, false);
  assert.deepEqual(r.disabledReasons, ['mcpSeamInjected']);
});

test('deliberate opt-out agent.mcpSharedClient: true → shared, reason names it', () => {
  const r = describeMcpIsolation({
    hasReadyClients: false,
    hasMcpConfig: true,
    mcpSeamInjected: false,
    mcpSharedClient: true,
  });
  assert.equal(r.perSession, false);
  assert.equal(r.mcpSharedClient, true);
  assert.deepEqual(r.disabledReasons, ['mcpSharedClient']);
});

test('no mcp: block at all → not per-session, reason noMcpConfig', () => {
  // NOTE: whether this SILENCES the config_warning is NOT assertable here —
  // describeMcpIsolation reports facts, the `hasMcpConfig` guard lives in
  // SmartServer. That behavior is covered by the integration case in Task 2.
  const r = describeMcpIsolation({
    hasReadyClients: false,
    hasMcpConfig: false,
    mcpSeamInjected: false,
  });
  assert.equal(r.perSession, false);
  assert.deepEqual(r.disabledReasons, ['noMcpConfig']);
});

test('multiple causes are all reported, in declared order', () => {
  const r = describeMcpIsolation({
    hasReadyClients: true,
    hasMcpConfig: true,
    mcpSeamInjected: true,
    mcpSharedClient: true,
  });
  assert.equal(r.perSession, false);
  assert.deepEqual(r.disabledReasons, [
    'mcpSharedClient',
    'hasReadyClients',
    'mcpSeamInjected',
  ]);
});

// ---------------------------------------------------------------------------
// Minimal in-process MCP streamable-HTTP server, copied verbatim from
// `__tests__/mcp-yaml-vectorization.test.ts` (`startMcpStub`). Needed because
// on the pure-YAML path the STARTUP builder really dials `mcp.url` before the
// per-session lazy-connect wrappers exist.
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

/**
 * Start the stub MCP server, or — if the sandbox forbids binding a local socket
 * (EPERM/EACCES) — skip the test cleanly instead of failing. The assertions still
 * run in CI and any environment that permits `listen`. Mirrors
 * `__tests__/mcp-yaml-vectorization.test.ts`.
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

// --- Integration: SmartServer consumes the decision it logs -----------------

/** Reach the private wiring without changing visibility (pattern:
 *  `__tests__/mcp-single-connect.test.ts:44-53`). Step 5 uses the last two
 *  members — declare the full shape now, it is one type for the whole file. */
type Internals = {
  _buildInfra(): Promise<{ close: () => Promise<void> }>;
  buildSessionAgent(parts: { mcpClients?: IMcpClient[] }): Promise<unknown>;
  _lifecycle?: { acquire(sessionId: string): Promise<unknown> };
};

function fakeMcpClient(): IMcpClient {
  return {
    async listTools() {
      return { ok: true as const, value: [] };
    },
    async callTool() {
      return { ok: true as const, value: { content: 'ok' } };
    },
  };
}

/**
 * Minimal config that reaches the MCP gate without provider credentials.
 * `skipProviderRuntimeChecks` is a `resolveSmartServerConfig`-layer option, not
 * a `SmartServerConfig` field — `new SmartServer(cfg)` bypasses that resolver
 * entirely, so the actual escape hatch here is `skipModelValidation` (mirrors
 * `__tests__/mcp-yaml-vectorization.test.ts`).
 */
function baseConfig(events: Record<string, unknown>[]): SmartServerConfig {
  return {
    port: 0,
    llm: { apiKey: 'test', model: 'test-model' },
    skipModelValidation: true,
    log: (e) => events.push(e),
  } as unknown as SmartServerConfig;
}

test('#213: pure YAML mcp: → mcp_isolation perSession:true, no config_warning', async (t) => {
  const events: Record<string, unknown>[] = [];
  // Pure YAML → the startup builder DIALS. A stub is mandatory here.
  const stub = await startStubOrSkip(t, ['GetTable']);
  if (!stub) return;
  const cfg = {
    ...baseConfig(events),
    mcp: { type: 'stream-http', url: stub.url },
  } as unknown as SmartServerConfig;
  const server = new SmartServer(cfg);
  let infra: { close: () => Promise<void> } | undefined;
  try {
    infra = await (server as unknown as Internals)._buildInfra();
  } finally {
    await infra?.close();
    await stub.close();
  }

  const iso = events.find((e) => e.event === 'mcp_isolation');
  assert.ok(iso, 'mcp_isolation event emitted');
  assert.equal(iso.perSession, true);
  assert.equal(iso.mcpFromYaml, true);
  assert.deepEqual(iso.disabledReasons, []);
  assert.equal(
    events.find((e) => e.event === 'config_warning'),
    undefined,
    'no warning on the healthy per-session path',
  );
});

test('#213: EMPTY-ARRAY TRAP — mcpClients: [] + mcp: is PRESENCE, not length → shared, no YAML dial', async () => {
  // The gate is `diOrPluginMcpClients !== undefined` (smart-server.ts:1166): an
  // empty array is a deliberate "disable MCP / override YAML" signal, so it takes
  // the inject branch and per-session isolation stays OFF. This is asserted HERE,
  // at the server, because presence-vs-length is the server's rule — the pure
  // describeMcpIsolation only ever sees the resolved `hasReadyClients` boolean.
  // The unreachable URL doubles as the proof that the YAML connect never fires:
  // if `[]` were treated as absent, _buildInfra would dial it and throw.
  const events: Record<string, unknown>[] = [];
  const cfg = {
    ...baseConfig(events),
    mcp: { type: 'stream-http', url: 'http://127.0.0.1:9/mcp' },
    mcpClients: [],
  } as unknown as SmartServerConfig;
  const server = new SmartServer(cfg);
  const infra = await (server as unknown as Internals)._buildInfra();
  try {
    const iso = events.find((e) => e.event === 'mcp_isolation');
    assert.ok(iso);
    assert.equal(
      iso.hasReadyClients,
      true,
      'an empty array still counts as present',
    );
    assert.equal(iso.perSession, false);
    assert.deepEqual(iso.disabledReasons, ['hasReadyClients']);
  } finally {
    await infra.close();
  }
});

test('#213: ready clients + mcp: → perSession:false AND config_warning naming hasReadyClients', async () => {
  const events: Record<string, unknown>[] = [];
  const cfg = {
    ...baseConfig(events),
    mcp: { type: 'stream-http', url: 'http://127.0.0.1:9/mcp' },
    mcpClients: [fakeMcpClient()],
  } as unknown as SmartServerConfig;
  const server = new SmartServer(cfg);
  const infra = await (server as unknown as Internals)._buildInfra();
  try {
    const iso = events.find((e) => e.event === 'mcp_isolation');
    assert.ok(iso);
    assert.equal(iso.perSession, false);
    assert.deepEqual(iso.disabledReasons, ['hasReadyClients']);
    const warn = events.find((e) => e.event === 'config_warning');
    assert.ok(warn, 'a silent shared fallback must warn');
    assert.match(String(warn.message), /hasReadyClients/);
  } finally {
    await infra.close();
  }
});

test('#213: injected connectMcp seam + mcp: → perSession:false AND warning names mcpSeamInjected', async () => {
  const events: Record<string, unknown>[] = [];
  const cfg = {
    ...baseConfig(events),
    mcp: { type: 'stream-http', url: 'http://127.0.0.1:9/mcp' },
  } as unknown as SmartServerConfig;
  const server = new SmartServer(cfg, {
    connectMcp: async () => [fakeMcpClient()],
  });
  const infra = await (server as unknown as Internals)._buildInfra();
  try {
    const iso = events.find((e) => e.event === 'mcp_isolation');
    assert.ok(iso);
    assert.equal(iso.perSession, false);
    assert.deepEqual(iso.disabledReasons, ['mcpSeamInjected']);
    const warn = events.find((e) => e.event === 'config_warning');
    assert.ok(warn);
    assert.match(String(warn.message), /mcpSeamInjected/);
  } finally {
    await infra.close();
  }
});

test('#213: no mcp: block → perSession:false, reason noMcpConfig, and NO warning', async () => {
  // The `hasMcpConfig` guard is asserted HERE (not in the unit table):
  // describeMcpIsolation reports the reason, SmartServer decides whether to warn.
  // A deployment that runs without MCP must not be nagged about isolation.
  const events: Record<string, unknown>[] = [];
  const server = new SmartServer(baseConfig(events));
  const infra = await (server as unknown as Internals)._buildInfra();
  try {
    const iso = events.find((e) => e.event === 'mcp_isolation');
    assert.ok(iso, 'the event fires even with no MCP at all');
    assert.equal(iso.perSession, false);
    assert.deepEqual(iso.disabledReasons, ['noMcpConfig']);
    assert.equal(
      events.find((e) => e.event === 'config_warning'),
      undefined,
      'no MCP configured → nothing to warn about',
    );
  } finally {
    await infra.close();
  }
});
// NOTE: this case has NO client instance, so unlike the other perSession:false
// cases there is nothing to compare identity against — "no MCP" asserts the
// absent warning, not a shared instance.

test('#213 anti-drift: perSession:true → two sessions RECEIVE distinct client instances', async (t) => {
  const events: Record<string, unknown>[] = [];
  // Pure YAML → the startup builder DIALS before the lifecycle exists.
  const stub = await startStubOrSkip(t, ['GetTable']);
  if (!stub) return;
  const cfg = {
    ...baseConfig(events),
    mcp: { type: 'stream-http', url: stub.url },
  } as unknown as SmartServerConfig;
  const server = new SmartServer(cfg);
  const internals = server as unknown as Internals;

  // Intercept BEFORE _buildInfra installs `buildAgent: (parts) => this.buildSessionAgent(parts)`.
  const captured: (IMcpClient[] | undefined)[] = [];
  internals.buildSessionAgent = async (parts) => {
    captured.push(parts.mcpClients);
    return undefined;
  };

  // MANDATORY try/finally: `stub.close()` (and the infra `close()`) must run
  // even when an assertion throws. A leaked stub/handle keeps the event loop
  // alive and `node --test` HANGS FOREVER instead of reporting the failure.
  let infra: { close: () => Promise<void> } | undefined;
  try {
    infra = await internals._buildInfra();

    const iso = events.find((e) => e.event === 'mcp_isolation');
    assert.equal(
      iso?.perSession,
      true,
      'precondition: the event claims isolation',
    );

    // The event must not be able to lie about what sessions actually get. The
    // PER-SESSION wrappers connect lazily, so acquiring sessions dials nothing —
    // but the stub above is still required for the startup connect, and stays up
    // until both acquires are done.
    await Promise.all([
      internals._lifecycle?.acquire('session-A'),
      internals._lifecycle?.acquire('session-B'),
    ]);
    assert.equal(captured.length, 2, 'both sessions acquired');
    assert.notEqual(
      captured[0],
      captured[1],
      'DISTINCT client arrays per session',
    );
    assert.notEqual(
      captured[0]?.[0],
      captured[1]?.[0],
      'DISTINCT client instances per session',
    );
  } finally {
    await infra?.close();
    await stub.close();
  }
});

test('#213 anti-drift: perSession:false → both sessions receive the SAME shared client', async () => {
  const events: Record<string, unknown>[] = [];
  const shared = fakeMcpClient();
  // Ready clients override YAML → the startup builder never dials, so the
  // unreachable URL is fine here and no stub is needed.
  const cfg = {
    ...baseConfig(events),
    mcp: { type: 'stream-http', url: 'http://127.0.0.1:9/mcp' },
    mcpClients: [shared],
  } as unknown as SmartServerConfig;
  const server = new SmartServer(cfg);
  const internals = server as unknown as Internals;

  const captured: (IMcpClient[] | undefined)[] = [];
  internals.buildSessionAgent = async (parts) => {
    captured.push(parts.mcpClients);
    return undefined;
  };
  const infra = await internals._buildInfra();
  try {
    assert.equal(
      events.find((e) => e.event === 'mcp_isolation')?.perSession,
      false,
      'precondition: the event admits the shared fallback',
    );
    await Promise.all([
      internals._lifecycle?.acquire('session-A'),
      internals._lifecycle?.acquire('session-B'),
    ]);
    assert.equal(captured.length, 2);
    assert.equal(
      captured[0]?.[0],
      captured[1]?.[0],
      'the shared fallback hands both sessions the same instance',
    );
  } finally {
    await infra.close();
  }
});
