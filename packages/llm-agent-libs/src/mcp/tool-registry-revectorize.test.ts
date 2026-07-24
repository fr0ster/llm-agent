import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  IMcpClient,
  IRag,
  IRagBackendWriter,
  LlmTool,
} from '@mcp-abap-adt/llm-agent';
import { toolNameFromRecord } from '@mcp-abap-adt/llm-agent';
import type { IMcpConnectionStrategy } from '../interfaces/mcp-connection-strategy.js';
import { McpToolRegistry } from './tool-registry.js';

function makeTool(name: string): LlmTool {
  return { name, description: `desc ${name}`, parameters: {} };
}

function makeClient(tools: LlmTool[]): IMcpClient {
  return {
    listTools: async () => ({ ok: true as const, value: tools }),
    callTool: async () => ({ ok: true as const, value: { content: [] } }),
  } as unknown as IMcpClient;
}

/** Captures every write so the record ids can be decoded back. */
function capturingRag() {
  const writes: Array<{ id: string; name?: unknown }> = [];
  const writer = {
    async upsertRaw(id: string, _t: string, meta: { name?: unknown }) {
      writes.push({ id, name: meta.name });
      return { ok: true as const, value: undefined };
    },
  } as unknown as IRagBackendWriter;
  const rag = {
    query: async () => ({ ok: true, value: [] }),
    writer: () => writer,
  } as unknown as IRag;
  return { rag, writes };
}

describe('McpToolRegistry reconnect revectorization', () => {
  it('uses the tool-record-key strategy on reconnect — no multi-server collision', async () => {
    const clients = [
      makeClient([makeTool('Search')]),
      makeClient([makeTool('Search')]),
    ];
    // Strategy returns toolsChanged: true, handing back both clients.
    const strategy: IMcpConnectionStrategy = {
      resolve: async () => ({ clients, toolsChanged: true }),
    } as unknown as IMcpConnectionStrategy;

    const { rag, writes } = capturingRag();
    const registry = new McpToolRegistry(clients, strategy, { tools: rag });

    await registry.resolveActiveClients();

    // Two distinct ids via the default strategy — not one tool:Search
    // overwriting the other, and no legacy hardcoded key.
    assert.deepEqual(writes.map((w) => w.id).sort(), [
      'tool:0:Search',
      'tool:1:Search',
    ]);
    // Name is in metadata, so retrieval recovers it regardless of the id.
    for (const w of writes) {
      assert.equal(toolNameFromRecord(w), 'Search');
    }
  });

  it('stops reconnect revectorization when the request signal is aborted', async () => {
    const clients = [makeClient([makeTool('Search')])];
    const strategy: IMcpConnectionStrategy = {
      resolve: async () => ({ clients, toolsChanged: true }),
    } as unknown as IMcpConnectionStrategy;
    const { rag, writes } = capturingRag();
    const registry = new McpToolRegistry(clients, strategy, { tools: rag });

    const ac = new AbortController();
    ac.abort();
    await registry.resolveActiveClients({ signal: ac.signal });

    // Aborted before any work: nothing written, no background run.
    assert.deepEqual(writes, []);
  });
});
