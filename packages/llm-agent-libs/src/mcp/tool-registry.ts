import type {
  CallOptions,
  IMcpClient,
  IRag,
  McpTool,
} from '@mcp-abap-adt/llm-agent';
import type { IMcpConnectionStrategy } from '../interfaces/mcp-connection-strategy.js';

export interface ToolRegistryResult {
  tools: McpTool[];
  toolClientMap: Map<string, IMcpClient>;
}

export interface IMcpToolRegistry {
  resolve(opts?: CallOptions): Promise<ToolRegistryResult>;
  resolveActiveClients(opts?: CallOptions): Promise<void>;
  getActiveClients(): IMcpClient[];
}

export class McpToolRegistry implements IMcpToolRegistry {
  private activeClients: IMcpClient[];
  constructor(
    initialClients: IMcpClient[],
    private readonly connectionStrategy: IMcpConnectionStrategy | undefined,
    private readonly ragStores: Record<string, IRag>,
  ) {
    this.activeClients = [...initialClients];
  }

  getActiveClients(): IMcpClient[] {
    return this.activeClients;
  }

  async resolveActiveClients(opts?: CallOptions): Promise<void> {
    if (!this.connectionStrategy) return;
    const result = await this.connectionStrategy.resolve(
      this.activeClients,
      opts,
    );
    this.activeClients = result.clients;
    if (result.toolsChanged) {
      await this.revectorizeTools(result.clients, opts);
    }
  }

  private async revectorizeTools(
    clients: IMcpClient[],
    opts?: CallOptions,
  ): Promise<void> {
    const toolsRag = this.ragStores.tools ?? Object.values(this.ragStores)[0];
    if (!toolsRag) return;
    for (const client of clients) {
      const result = await client.listTools(opts);
      if (!result.ok) continue;
      for (const tool of result.value) {
        const text = `Tool: ${tool.name} — ${tool.description}`;
        await toolsRag.writer?.()?.upsertRaw(`tool:${tool.name}`, text, {});
      }
    }
  }

  async resolve(opts?: CallOptions): Promise<ToolRegistryResult> {
    await this.resolveActiveClients(opts);
    const tools: McpTool[] = [];
    const toolClientMap = new Map<string, IMcpClient>();
    const settled = await Promise.allSettled(
      this.activeClients.map(async (client) => ({
        client,
        result: await client.listTools(opts),
      })),
    );
    for (const e of settled) {
      if (e.status === 'fulfilled' && e.value.result.ok) {
        for (const t of e.value.result.value) {
          if (!toolClientMap.has(t.name)) {
            tools.push(t);
            toolClientMap.set(t.name, e.value.client);
          }
        }
      }
    }
    return { tools, toolClientMap };
  }
}
