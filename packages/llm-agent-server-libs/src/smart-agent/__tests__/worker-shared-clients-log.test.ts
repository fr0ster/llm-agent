/**
 * Spec §10.5.12 U10 — a worker without its own MCP clients / tools store runs
 * on the parent's (kept, a consumer's choice), and each wire of such a worker
 * logs one `worker_uses_shared_clients` line naming what it shares.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IMcpClient, IRag } from '@mcp-abap-adt/llm-agent';
import { NoopRequestLogger } from '@mcp-abap-adt/llm-agent-libs';
import { InMemoryRag, SimpleRagRegistry } from '@mcp-abap-adt/llm-agent-rag';
import { SmartServer, type SmartServerConfig } from '../smart-server.js';
import { constructionSeams } from './construction-seams.js';

function client(label: string): IMcpClient & { lists: number } {
  const c = {
    label,
    lists: 0,
    async listTools() {
      c.lists++;
      return {
        ok: true as const,
        value: [
          {
            name: `${label}Tool`,
            description: `a ${label} tool`,
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      };
    },
    async callTool() {
      return { ok: true as const, value: { content: 'ok' } };
    },
  };
  return c as unknown as IMcpClient & { lists: number };
}

type Wire = (
  name: string,
  subCfg: unknown,
  logger: unknown,
  factories: Record<string, unknown>,
  injected: unknown,
) => Promise<unknown>;

async function withServer(
  workers: { name: string; config: Record<string, unknown> }[],
  run: (
    wire: (
      name: string,
      parent: IMcpClient,
      toolsRag: IRag,
    ) => Promise<{ process: (q: string) => Promise<unknown> }>,
    events: Record<string, unknown>[],
  ) => Promise<void>,
): Promise<void> {
  const events: Record<string, unknown>[] = [];
  const cfg = {
    port: 0,
    llm: { model: 'stub' },
    skipModelValidation: true,
    log: (e: Record<string, unknown>) => {
      events.push(e);
    },
    subAgentConfigs: workers,
  } as unknown as SmartServerConfig;
  const server = new SmartServer(cfg, constructionSeams);
  const built = await server._buildEmbeddedAgent();
  try {
    const buildSubAgent = (server as unknown as { buildSubAgent: Wire })
      .buildSubAgent;
    const wire = async (name: string, parent: IMcpClient, toolsRag: IRag) => {
      return (await buildSubAgent.call(
        server,
        name,
        workers.find((w) => w.name === name)?.config,
        { log: () => {} },
        {},
        {
          ragRegistry: new SimpleRagRegistry(),
          toolsRag,
          mcpClients: [parent],
          requestLogger: new NoopRequestLogger(),
        },
      )) as { process: (q: string) => Promise<unknown> };
    };
    // Only the per-session wires below are counted.
    events.length = 0;
    await run(wire, events);
  } finally {
    await built.close();
  }
}

const shared = (events: Record<string, unknown>[]) =>
  events.filter((e) => e.event === 'worker_uses_shared_clients');

describe('U10: a worker on the parent’s clients is logged', () => {
  it('neither clients nor a store of its own → one event per wire naming both', async () => {
    await withServer(
      [{ name: 'plain', config: { skipModelValidation: true } }],
      async (wire, events) => {
        const parent = client('parent');
        await wire('plain', parent, new InMemoryRag());
        assert.deepEqual(shared(events), [
          {
            event: 'worker_uses_shared_clients',
            worker: 'plain',
            shared: ['toolsRag', 'mcpClients'],
          },
        ]);
        const worker = await wire('plain', parent, new InMemoryRag());
        assert.equal(shared(events).length, 2, 'one line per wire');
        await worker.process('list what you can do');
        assert.ok(
          parent.lists > 0,
          'the worker still runs on the parent’s clients',
        );
      },
    );
  });

  it('its own store but no clients → shared: [mcpClients]', async () => {
    await withServer(
      [
        {
          name: 'own-store',
          config: {
            skipModelValidation: true,
            rag: { store: { type: 'in-memory' } },
          },
        },
      ],
      async (wire, events) => {
        await wire('own-store', client('parent'), new InMemoryRag());
        assert.deepEqual(shared(events), [
          {
            event: 'worker_uses_shared_clients',
            worker: 'own-store',
            shared: ['mcpClients'],
          },
        ]);
      },
    );
  });

  it('its own clients and store → no event', async () => {
    const own = client('own');
    await withServer(
      [
        {
          name: 'own-all',
          config: {
            skipModelValidation: true,
            rag: { store: { type: 'in-memory' } },
            mcpClients: [own],
          },
        },
      ],
      async (wire, events) => {
        const parent = client('parent');
        const worker = await wire('own-all', parent, new InMemoryRag());
        assert.deepEqual(shared(events), []);
        await worker.process('list what you can do');
        assert.ok(own.lists > 0, 'the worker runs on its own clients');
        assert.equal(parent.lists, 0, 'the parent’s clients are not used');
      },
    );
  });
});
