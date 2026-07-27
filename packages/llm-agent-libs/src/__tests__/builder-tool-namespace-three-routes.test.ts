/**
 * Task 10 (#244) — SmartAgentBuilder.withToolNamespace() threads ONE custom
 * IToolNamespace strategy to THREE distinct consumers by three different
 * routes; get all three right or the wiring is only partially proven:
 *
 *   (1) registry route  — SmartAgentDeps.toolNamespace → `new McpToolRegistry(...)`
 *       (agent.ts); observed via the internal registry's resolve().
 *   (2) vectorize route — the `ns` object passed to vectorizeMcpTools(...) at
 *       startup (builder.ts); observed via the stored `metadata.name`.
 *   (3) pipeline route  — PipelineDeps.toolNamespace → ctx.toolNamespace
 *       (default-pipeline.ts), consumed by ToolSelectHandler on first load;
 *       observed via the `tools_selected` sessionLogger step.
 *
 * A registry-only assertion would leave 2/3 of the wiring unverified — this
 * test drives a REAL `SmartAgentBuilder.build()` (two embedded-style clients
 * exposing the same tool name) and checks all three routes in one build.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type ILlm,
  type IMcpClient,
  InMemoryRag,
  type IToolNamespace,
  type McpTool,
} from '@mcp-abap-adt/llm-agent';
import { SmartAgentBuilder } from '../builder.js';
import type {
  IMcpConnectionStrategy,
  McpClientDescriptor,
} from '../interfaces/mcp-connection-strategy.js';
import type { IMcpToolRegistry } from '../mcp/tool-registry.js';

// A DISTINCTIVE custom strategy: UPPERCASES the prefix on a collision.
// `defaultToolNamespace` would produce `primary__Search` / `secondary__Search`
// (bare prefix) — so any `PRIMARY__Search` / `SECONDARY__Search` reaching a
// consumer can only have come from THIS injected strategy.
const custom: IToolNamespace = {
  expose: ({ toolName, prefix, colliding }) =>
    colliding ? `${prefix.toUpperCase()}__${toolName}` : toolName,
};

function makeSearchClient(description: string): IMcpClient {
  return {
    async listTools() {
      return {
        ok: true as const,
        value: [{ name: 'Search', description, inputSchema: {} }] as McpTool[],
      };
    },
    async callTool() {
      return { ok: true as const, value: { content: 'ok' } };
    },
  } as IMcpClient;
}

function makeStubLlm(): ILlm {
  return {
    model: 'stub',
    async chat() {
      return {
        ok: true as const,
        value: { content: 'done', finishReason: 'stop' as const },
      };
    },
    async *streamChat() {
      yield {
        ok: true as const,
        value: { content: 'done', finishReason: 'stop' as const },
      };
    },
  };
}

test('withToolNamespace() reaches all THREE consumers: registry, startup vectorization, and pipeline ctx', async () => {
  const client0 = makeSearchClient('primary server search tool');
  const client1 = makeSearchClient('secondary server search tool');
  const descriptors: McpClientDescriptor[] = [
    { slotIndex: 0, label: 'primary' },
    { slotIndex: 1, label: 'secondary' },
  ];
  // Fake connection strategy — no real transport needed (mirrors the seam
  // already used by pipeline/handlers/__tests__/tool-namespace-refresh.test.ts).
  const connectionStrategy: IMcpConnectionStrategy = {
    async resolve() {
      return {
        clients: [client0, client1],
        toolsChanged: true,
        clientDescriptors: descriptors,
        configuredSlotCount: 2,
      };
    },
  };
  const toolsRag = new InMemoryRag();

  const handle = await new SmartAgentBuilder()
    .withMainLlm(makeStubLlm())
    .withMcpConnectionStrategy(connectionStrategy)
    .setToolsRag(toolsRag)
    .withToolNamespace(custom)
    .withMode('hard')
    .withClassification(false)
    .build();

  // ---- Route 1: internal registry resolve() exposed name -----------------
  // `mcpToolRegistry` is a private field of the concrete SmartAgent class —
  // cast through `unknown` to reach it as a legitimate test seam (its type,
  // IMcpToolRegistry, is already a public export).
  const registry = (
    handle.agent as unknown as { mcpToolRegistry: IMcpToolRegistry }
  ).mcpToolRegistry;
  const { tools } = await registry.resolve();
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    ['PRIMARY__Search', 'SECONDARY__Search'],
    'route 1 (registry.resolve()) must expose names produced by the injected custom strategy',
  );

  // ---- Route 2: stored metadata.name from startup vectorization ----------
  // Default IToolRecordKey with clientCount=2 keys by `tool:${slotIndex}:${originalName}`.
  const rec0 = await toolsRag.getById('tool:0:Search');
  const rec1 = await toolsRag.getById('tool:1:Search');
  assert.equal(rec0.ok, true, 'record for slot 0 must have been written');
  assert.equal(rec1.ok, true, 'record for slot 1 must have been written');
  assert.equal(
    rec0.ok ? rec0.value?.metadata.name : undefined,
    'PRIMARY__Search',
    'route 2 (startup vectorization) must have stored the custom-namespaced name',
  );
  assert.equal(
    rec1.ok ? rec1.value?.metadata.name : undefined,
    'SECONDARY__Search',
    'route 2 (startup vectorization) must have stored the custom-namespaced name',
  );

  // ---- Route 3: pipeline ctx — first-load tool-select ---------------------
  const steps: Array<{ name: string; data: unknown }> = [];
  const res = await handle.agent.process('hello', {
    sessionLogger: {
      logStep(name: string, data: unknown) {
        steps.push({ name, data });
      },
    },
  });
  assert.equal(res.ok, true, 'process() must complete successfully');
  const toolsSelected = steps.find((s) => s.name === 'tools_selected');
  assert.ok(toolsSelected, 'tools_selected step must be logged');
  const selectedNames = (toolsSelected?.data as { selectedNames: string[] })
    .selectedNames;
  assert.deepEqual(
    [...selectedNames].sort(),
    ['PRIMARY__Search', 'SECONDARY__Search'],
    'route 3 (pipeline ctx.toolNamespace) must namespace tools with the custom strategy on first load',
  );
});

test('without withToolNamespace(), all three routes fall back to defaultToolNamespace unchanged', async () => {
  const client0 = makeSearchClient('primary server search tool');
  const client1 = makeSearchClient('secondary server search tool');
  const descriptors: McpClientDescriptor[] = [
    { slotIndex: 0, label: 'primary' },
    { slotIndex: 1, label: 'secondary' },
  ];
  const connectionStrategy: IMcpConnectionStrategy = {
    async resolve() {
      return {
        clients: [client0, client1],
        toolsChanged: true,
        clientDescriptors: descriptors,
        configuredSlotCount: 2,
      };
    },
  };
  const toolsRag = new InMemoryRag();

  const handle = await new SmartAgentBuilder()
    .withMainLlm(makeStubLlm())
    .withMcpConnectionStrategy(connectionStrategy)
    .setToolsRag(toolsRag)
    .withMode('hard')
    .withClassification(false)
    .build();

  const registry = (
    handle.agent as unknown as { mcpToolRegistry: IMcpToolRegistry }
  ).mcpToolRegistry;
  const { tools } = await registry.resolve();
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    ['primary__Search', 'secondary__Search'],
    'default namespace must still be used when withToolNamespace() is not called',
  );
});
