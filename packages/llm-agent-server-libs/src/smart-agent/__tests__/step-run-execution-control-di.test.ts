/**
 * DI seam: stepExecutionControl / runExecutionControl threaded through SmartServer.
 *
 * Proves the FULL chain:
 *   BuildAgentDeps { stepExecutionControl, runExecutionControl }
 *     → SmartServer constructor stores them on _stepExecutionControl / _runExecutionControl
 *     → buildServerCtx conditional-spread includes them in the createServerPipelineContext call
 *     → returned IPipelineContext ctx carries the injected values verbatim
 *
 * The existing controller-step-control-wiring.test.ts (test (b)) already covers
 * the composition-plugin path (ctx → ControllerFactory deps). THIS file (test (a))
 * covers the SmartServer constructor → buildServerCtx seam that test (b) bypasses
 * via fakeControllerServerCtx(). If the conditional-spread lines in buildServerCtx
 * are removed, these tests fail even though test (b) stays green.
 *
 * No HTTP I/O. buildServerCtx is called directly via private-cast after stubbing the
 * two internals that require _buildInfra:
 *   _workers.build   — stubbed to return an empty Map (no sub-agents configured)
 *   _stepperKnowledgeBackend — pre-set so buildKnowledgeBackend() is a no-op
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  IRunExecutionControl,
  IStepExecutionControl,
  IWaitStrategy,
} from '@mcp-abap-adt/llm-agent';
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

// ── Sentinel factories ─────────────────────────────────────────────────────────
function sentinelStepControl(): IStepExecutionControl {
  return {
    beginStep: () => ({
      signal: new AbortController().signal,
      shouldContinueRound: () => ({ continue: true as const }),
      canExecuteTool: () => ({ continue: true as const }),
      dispose: () => {},
    }),
  };
}

function sentinelRunControl(): IRunExecutionControl {
  return {
    beginRun: () => ({
      signal: new AbortController().signal,
      shouldContinue: () => ({ continue: true as const }),
      dispose: () => {},
    }),
  };
}

function sentinelWaitStrategy(): IWaitStrategy {
  return {
    name: 'sentinel-wait',
    wait: async () => 'elapsed' as const,
  };
}

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

// ── Test (a) — SmartServer constructor → buildServerCtx conditional-spread ────

test('(a) YES injection: buildServerCtx ctx carries consumer-injected stepExecutionControl', async () => {
  const custom = sentinelStepControl();
  const server = new SmartServer(MINIMAL_CFG, { stepExecutionControl: custom });
  const ctx = await callBuildServerCtx(server);
  assert.strictEqual(
    ctx.stepExecutionControl,
    custom,
    'ctx.stepExecutionControl must be the consumer-injected sentinel (not a default or undefined)',
  );
});

test('(a) YES injection: buildServerCtx ctx carries consumer-injected runExecutionControl', async () => {
  const customRun = sentinelRunControl();
  const server = new SmartServer(MINIMAL_CFG, {
    runExecutionControl: customRun,
  });
  const ctx = await callBuildServerCtx(server);
  assert.strictEqual(
    ctx.runExecutionControl,
    customRun,
    'ctx.runExecutionControl must be the consumer-injected sentinel (not a default or undefined)',
  );
});

test('(a) NO injection: buildServerCtx ctx omits stepExecutionControl and runExecutionControl', async () => {
  const server = new SmartServer(MINIMAL_CFG);
  const ctx = await callBuildServerCtx(server);
  assert.equal(
    ctx.stepExecutionControl,
    undefined,
    'no injection → ctx must NOT carry stepExecutionControl (pipeline uses its own default)',
  );
  assert.equal(
    ctx.runExecutionControl,
    undefined,
    'no injection → ctx must NOT carry runExecutionControl (pipeline uses its own default)',
  );
});

test('(a) sanity: injected sentinels are distinct from each other (referential identity guard)', async () => {
  const step = sentinelStepControl();
  const run = sentinelRunControl();
  const server = new SmartServer(MINIMAL_CFG, {
    stepExecutionControl: step,
    runExecutionControl: run,
  });
  const ctx = await callBuildServerCtx(server);
  assert.strictEqual(ctx.stepExecutionControl, step);
  assert.strictEqual(ctx.runExecutionControl, run);
  // Cross-check: injected step-control is NOT in the run-control slot and vice-versa.
  assert.notStrictEqual(ctx.stepExecutionControl, run);
  assert.notStrictEqual(ctx.runExecutionControl, step);
});

test('(a) YES injection: buildServerCtx ctx carries consumer-injected waitStrategy', async () => {
  const custom = sentinelWaitStrategy();
  const server = new SmartServer(MINIMAL_CFG, { waitStrategy: custom });
  const ctx = await callBuildServerCtx(server);
  assert.strictEqual(
    ctx.waitStrategy,
    custom,
    'ctx.waitStrategy must be the consumer-injected sentinel (not a default or undefined)',
  );
});

test('(a) NO injection: buildServerCtx ctx omits waitStrategy', async () => {
  const server = new SmartServer(MINIMAL_CFG);
  const ctx = await callBuildServerCtx(server);
  assert.equal(
    ctx.waitStrategy,
    undefined,
    'no injection → ctx must NOT carry waitStrategy (the handler defaults to DefaultWaitStrategy)',
  );
});
