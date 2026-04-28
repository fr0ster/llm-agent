import type {
  CallOptions,
  IMcpClient,
  IToolCache,
} from '@mcp-abap-adt/llm-agent';
import type { IMetrics } from '../metrics/types.js';
import type { PendingToolResultsRegistry } from './pending-tool-results-registry.js';
export interface MixedToolCallContext {
  toolClientMap: Map<string, IMcpClient>;
  toolCache: IToolCache;
  metrics: IMetrics;
  options?: CallOptions;
}
export declare function fireInternalToolsAsync(
  content: string,
  internalCalls: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }>,
  registry: PendingToolResultsRegistry,
  sessionId: string,
  ctx: MixedToolCallContext,
): void;
//# sourceMappingURL=mixed-tool-call-handler.d.ts.map
