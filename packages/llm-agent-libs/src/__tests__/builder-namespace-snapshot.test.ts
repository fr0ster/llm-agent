/**
 * Task 2 (#244 server-libs addendum) — the builder computes the authoritative
 * namespaced snapshot `{ tools, provenance }` ONCE and surfaces it on
 * `SmartAgentHandle`, independent of RAG writability, and `vectorizeMcpTools`
 * consumes that SAME view (one `listTools` pass, no divergence).
 *
 * Three things this file proves, mirroring the plan's emphasis:
 *   1. The snapshot (`namespacedTools`/`toolProvenance`) exists on the handle
 *      even when nothing was vectorized (no writable tools RAG).
 *   2. `/health` stays UNCHANGED: no writable store → the builder does NOT
 *      publish any catalog status (holder stays empty/unknown), even though
 *      the snapshot was still built.
 *   3. A middle-client `listTools()` failure (of three configured clients)
 *      must NOT shift the surviving third client's `slotIndex` — provenance
 *      must read `slotIndex: 2`, not `1`.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type ILlm,
  type IMcpClient,
  InMemoryRag,
  isToolCatalogReporter,
  type McpTool,
} from '@mcp-abap-adt/llm-agent';
import { SmartAgentBuilder } from '../builder.js';
import type {
  IMcpConnectionStrategy,
  McpClientDescriptor,
} from '../interfaces/mcp-connection-strategy.js';

function makeSearchClient(): IMcpClient {
  return {
    async listTools() {
      return {
        ok: true as const,
        value: [
          { name: 'Search', description: 'search tool', inputSchema: {} },
        ] as McpTool[],
      };
    },
    async callTool() {
      return { ok: true as const, value: { content: 'ok' } };
    },
  } as IMcpClient;
}

function makeFailingListClient(): IMcpClient {
  return {
    async listTools() {
      throw new Error('listTools failed for this client');
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

test('builder surfaces namespacedTools/toolProvenance even with NO writable tools RAG, and does NOT publish a catalog status', async () => {
  const client0 = makeSearchClient();
  const client1 = makeSearchClient();
  const descriptors: McpClientDescriptor[] = [
    { slotIndex: 0 },
    { slotIndex: 1 },
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

  // Deliberately NO .setToolsRag(...) and NO .withEmbedder(...): the builder's
  // auto-create-InMemoryRag path only fires when an embedder is present, so
  // `toolsRag` stays undefined here — the "no writable store" contract.
  const handle = await new SmartAgentBuilder()
    .withMainLlm(makeStubLlm())
    .withMcpConnectionStrategy(connectionStrategy)
    .withMode('hard')
    .withClassification(false)
    .build();

  // ---- The snapshot exists regardless of RAG writability ------------------
  assert.ok(handle.namespacedTools, 'namespacedTools must be present');
  assert.deepEqual([...handle.namespacedTools].map((t) => t.name).sort(), [
    's0__Search',
    's1__Search',
  ]);
  assert.ok(handle.toolProvenance, 'toolProvenance must be present');
  assert.deepEqual(handle.toolProvenance.get('s1__Search'), {
    slotIndex: 1,
    originalName: 'Search',
  });
  assert.deepEqual(
    handle.mcpClientDescriptors?.map((d) => d.slotIndex),
    [0, 1],
  );
  assert.equal(handle.configuredSlotCount, 2);

  // ---- But NOTHING was vectorized, and /health must reflect that unchanged ---
  assert.ok(
    isToolCatalogReporter(handle.agent),
    'SmartAgent must implement IToolCatalogReporter',
  );
  assert.equal(
    handle.agent.getToolCatalogStatus(),
    undefined,
    'no writable tools RAG → the holder must stay empty/unknown, exactly as before #244 (the builder must not publish a status just because the snapshot was built)',
  );
});

test('health preserved WHEN vectorization runs: a writable tools RAG + a client failure yields summary.complete === false with clientFailures > 0', async () => {
  const good = makeSearchClient();
  const bad = makeFailingListClient();
  const descriptors: McpClientDescriptor[] = [
    { slotIndex: 0 },
    { slotIndex: 1 },
  ];
  const connectionStrategy: IMcpConnectionStrategy = {
    async resolve() {
      return {
        clients: [good, bad],
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

  assert.ok(isToolCatalogReporter(handle.agent));
  const status = handle.agent.getToolCatalogStatus();
  assert.ok(status, 'a writable store must publish a status');
  assert.equal(
    status?.complete,
    false,
    'a client listTools() failure must make the catalog incomplete — not hardcoded true',
  );
  assert.ok(
    (status?.clientFailures ?? 0) > 0,
    'the failing client must be counted',
  );
  // The good client's tool still made it into the snapshot and was vectorized.
  assert.deepEqual(
    [...(handle.namespacedTools ?? [])].map((t) => t.name),
    ['Search'],
  );
});

test('original client index preserved on partial failure: 3 clients, the MIDDLE one fails to list → the surviving third client keeps slotIndex 2, not 1', async () => {
  const client0 = makeSearchClient();
  const client1 = makeFailingListClient(); // middle client fails
  const client2 = makeSearchClient();
  const descriptors: McpClientDescriptor[] = [
    { slotIndex: 0 },
    { slotIndex: 1 },
    { slotIndex: 2 },
  ];
  const connectionStrategy: IMcpConnectionStrategy = {
    async resolve() {
      return {
        clients: [client0, client1, client2],
        toolsChanged: true,
        clientDescriptors: descriptors,
        configuredSlotCount: 3,
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

  // Only slots 0 and 2 produced tools; both expose the same bare "Search"
  // name so — with slot 1 down — there is no collision (only ONE active
  // "Search" per surviving slot at a time isn't true here: both slot 0 and
  // slot 2 expose "Search" simultaneously, which DOES collide) → both get
  // namespaced as s0__Search / s2__Search.
  assert.deepEqual(
    [...(handle.namespacedTools ?? [])].map((t) => t.name).sort(),
    ['s0__Search', 's2__Search'],
  );

  const survivorProvenance = handle.toolProvenance?.get('s2__Search');
  assert.deepEqual(
    survivorProvenance,
    { slotIndex: 2, originalName: 'Search' },
    'the surviving third client must keep its ORIGINAL slotIndex 2, not collapse to 1',
  );

  // The record id/exposed prefix backing storage must also reflect slot 2,
  // not a re-mapped slot 1 — proving `perClient` was built index-preservingly.
  const rec2 = await toolsRag.getById('tool:2:Search');
  assert.equal(rec2.ok, true, 'record for slot 2 must have been written');
  assert.equal(
    rec2.ok ? rec2.value?.metadata.name : undefined,
    's2__Search',
    'the stored exposed name for slot 2 must be s2__Search, not a collapsed s1__Search',
  );

  const status = handle.agent.getToolCatalogStatus
    ? handle.agent.getToolCatalogStatus()
    : undefined;
  assert.equal(status?.clientFailures, 1);
  assert.equal(status?.complete, false);
});
