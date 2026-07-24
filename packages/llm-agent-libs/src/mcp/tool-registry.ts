import type {
  CallOptions,
  IMcpClient,
  IRag,
  IRequestLogger,
  IToolRecordKey,
  McpTool,
} from '@mcp-abap-adt/llm-agent';
import type { IMcpConnectionStrategy } from '../interfaces/mcp-connection-strategy.js';
import type { ILogger } from '../logger/index.js';
import { NoopRequestLogger } from '../logger/noop-request-logger.js';
import { vectorizeMcpTools } from './vectorize-mcp-tools.js';

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
  private readonly requestLogger: IRequestLogger;
  private readonly logger?: ILogger;
  private readonly toolRecordKey?: IToolRecordKey;
  constructor(
    initialClients: IMcpClient[],
    private readonly connectionStrategy: IMcpConnectionStrategy | undefined,
    private readonly ragStores: Record<string, IRag>,
    deps?: {
      requestLogger?: IRequestLogger;
      logger?: ILogger;
      toolRecordKey?: IToolRecordKey;
    },
  ) {
    this.activeClients = [...initialClients];
    this.requestLogger = deps?.requestLogger ?? new NoopRequestLogger();
    this.logger = deps?.logger;
    this.toolRecordKey = deps?.toolRecordKey;
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
    _opts?: CallOptions,
  ): Promise<void> {
    const toolsRag = this.ragStores.tools ?? Object.values(this.ragStores)[0];
    if (!toolsRag) return;
    // Reuse the single startup vectorization path so reconnect gets the same
    // IToolRecordKey, the name stored in metadata, and batch/bulk writing —
    // rather than a second hand-rolled loop that hardcoded `tool:${name}` and
    // reintroduced the #240 collision on multi-server reconnects.
    await vectorizeMcpTools(
      clients,
      toolsRag,
      this.requestLogger,
      this.logger,
      this.toolRecordKey,
    );
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
