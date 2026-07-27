import type { IMcpClient, McpClientDescriptor } from '@mcp-abap-adt/llm-agent';

/**
 * Session MCP clients paired with the stable per-slot descriptors a connection
 * strategy emits (#244). `clientDescriptors[i]` describes `clients[i]` — same
 * index, NOT necessarily the same `slotIndex` (a peer outage can shrink
 * `clients` below the originally configured slot count). `configuredSlotCount`
 * is the number of `mcp[]` entries configured, independent of how many
 * actually connected — used by callers that need to distinguish "fewer
 * clients than configured" from "nothing configured".
 */
export interface McpClientsWithDescriptors {
  clients: IMcpClient[];
  clientDescriptors?: readonly McpClientDescriptor[];
  configuredSlotCount?: number;
}
