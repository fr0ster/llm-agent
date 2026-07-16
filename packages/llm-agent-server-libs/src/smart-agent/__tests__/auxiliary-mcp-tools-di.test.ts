/**
 * DI seam: auxiliaryMcpTools threaded through SmartServer.
 *
 * Proves the FULL chain:
 *   BuildAgentDeps { auxiliaryMcpTools }
 *     → SmartServer constructor stores it on _auxiliaryMcpTools
 *     → buildServerCtx conditional-spread includes it in the createServerPipelineContext call
 *     → returned IPipelineContext ctx carries the injected value verbatim
 *
 * Mirrors the step-run-execution-control-di.test.ts pattern exactly.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IAuxiliaryMcpTools } from '@mcp-abap-adt/llm-agent';
import {
  InMemoryKnowledgeBackend,
  SessionRequestLogger,
} from '@mcp-abap-adt/llm-agent-libs';
import type { SmartServerConfig } from '../smart-server.js';
import { SmartServer } from '../smart-server.js';

// ── Minimal server config (no LLM creds needed — no start() call) ─────────────
const MINIMAL_CFG = {
  llm: { main: { provider: 'openai', apiKey: 'x', model: 'gpt-4o' } },
} as unknown as SmartServerConfig;

// ── Sentinel ───────────────────────────────────────────────────────────────────
const sentinel: IAuxiliaryMcpTools = {
  async listTools() {
    return { ok: true, value: [] };
  },
  async callTool() {
    return { ok: true, value: { content: 'x' } };
  },
};

// ── Minimal scope for buildServerCtx ──────────────────────────────────────────
function fakeScope() {
  return {
    sessionId: 's1',
    parts: {
      sessionId: 's1',
      mcpClients: [],
      toolsRag: undefined,
      // ragRegistry is only SPREAD into ctx, never called during buildServerCtx itself.
      ragRegistry: {} as never,
      logger: new SessionRequestLogger(),
    },
  };
}

/**
 * Call the private buildServerCtx after stub-wiring the two internals that
 * would otherwise require a live _buildInfra pass:
 *   _workers  — stubbed to { build: async () => new Map() }
 *   _stepperKnowledgeBackend — pre-set to InMemoryKnowledgeBackend so
 *               buildKnowledgeBackend() early-returns without calling makeKnowledgeBackend.
 *
 * Returns the plain ctx object (createServerPipelineContext is just a spread).
 */
async function callBuildServerCtx(
  server: SmartServer,
): Promise<Record<string, unknown>> {
  const s = server as unknown as Record<string, unknown>;
  s._workers = { build: async () => new Map() };
  s._stepperKnowledgeBackend = new InMemoryKnowledgeBackend();
  return (
    server as unknown as {
      buildServerCtx: (
        scope: ReturnType<typeof fakeScope>,
      ) => Promise<Record<string, unknown>>;
    }
  ).buildServerCtx(fakeScope());
}

// ── Tests ──────────────────────────────────────────────────────────────────────

test('(a) YES injection: buildServerCtx ctx carries consumer-injected auxiliaryMcpTools', async () => {
  const server = new SmartServer(MINIMAL_CFG, { auxiliaryMcpTools: sentinel });
  const ctx = await callBuildServerCtx(server);
  assert.equal(ctx.auxiliaryMcpTools, sentinel);
});

test('(b) NO injection: ctx.auxiliaryMcpTools is undefined (pipeline resolves its own default)', async () => {
  const server = new SmartServer(MINIMAL_CFG, {});
  const ctx = await callBuildServerCtx(server);
  assert.equal(ctx.auxiliaryMcpTools, undefined);
});
