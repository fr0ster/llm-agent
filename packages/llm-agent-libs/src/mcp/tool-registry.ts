import {
  assertClientDescriptors,
  buildNamespacedTools,
  type CallOptions,
  defaultToolNamespace,
  type IMcpClient,
  type IRag,
  type IRequestLogger,
  type IToolNamespace,
  type IToolRecordKey,
  type McpTool,
} from '@mcp-abap-adt/llm-agent';
import type {
  IMcpConnectionStrategy,
  McpClientDescriptor,
} from '../interfaces/mcp-connection-strategy.js';
import { isDebugArea } from '../logger/debug-areas.js';
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
  private activeClientDescriptors: readonly McpClientDescriptor[] = [];
  private configuredSlotCount: number;
  private readonly requestLogger: IRequestLogger;
  private readonly logger?: ILogger;
  private readonly toolRecordKey?: IToolRecordKey;
  private readonly toolNamespace: IToolNamespace;
  constructor(
    initialClients: IMcpClient[],
    private readonly connectionStrategy: IMcpConnectionStrategy | undefined,
    private readonly ragStores: Record<string, IRag>,
    deps?: {
      requestLogger?: IRequestLogger;
      logger?: ILogger;
      toolRecordKey?: IToolRecordKey;
      toolNamespace?: IToolNamespace;
    },
  ) {
    this.activeClients = [...initialClients];
    this.configuredSlotCount = this.activeClients.length;
    this.requestLogger = deps?.requestLogger ?? new NoopRequestLogger();
    this.logger = deps?.logger;
    this.toolRecordKey = deps?.toolRecordKey;
    this.toolNamespace = deps?.toolNamespace ?? defaultToolNamespace;
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
    assertClientDescriptors(
      result.clients,
      result.clientDescriptors,
      result.configuredSlotCount,
    );
    this.activeClientDescriptors =
      result.clientDescriptors ??
      this.activeClients.map((_, i) => ({ slotIndex: i }));
    this.configuredSlotCount =
      result.configuredSlotCount ?? this.activeClients.length;
    if (isDebugArea('mcp')) {
      console.error(
        `[mcp] tool-registry: resolved ${this.activeClients.length} active of ${this.configuredSlotCount} configured slot(s)`,
      );
    }
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
    // Reuse the single startup vectorization path so reconnect gets the same
    // IToolRecordKey, the name stored in metadata, and batch/bulk writing —
    // rather than a second hand-rolled loop that hardcoded `tool:${name}` and
    // reintroduced the #240 collision on multi-server reconnects. `opts` carries
    // the request signal so an aborted reconnect stops promptly.
    await vectorizeMcpTools(
      clients,
      toolsRag,
      this.requestLogger,
      this.logger,
      this.toolRecordKey,
      opts,
      {
        descriptors: this.activeClientDescriptors,
        configuredSlotCount: this.configuredSlotCount,
        toolNamespace: this.toolNamespace,
      },
    );
  }

  async resolve(opts?: CallOptions): Promise<ToolRegistryResult> {
    await this.resolveActiveClients(opts);
    const settled = await Promise.allSettled(
      this.activeClients.map(async (client) => ({
        client,
        result: await client.listTools(opts),
      })),
    );
    const perClient = settled.flatMap((e, i) =>
      e.status === 'fulfilled' && e.value.result.ok
        ? [
            {
              slotIndex: this.activeClientDescriptors[i]?.slotIndex ?? i,
              label: this.activeClientDescriptors[i]?.label,
              client: e.value.client,
              tools: e.value.result.value,
            },
          ]
        : [],
    );
    const { tools, toolClientMap } = buildNamespacedTools(
      perClient,
      this.toolNamespace,
    );
    return { tools, toolClientMap };
  }
}
