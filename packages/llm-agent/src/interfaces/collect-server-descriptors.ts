import type { McpClientDescriptor } from './mcp-connection-strategy.js';
import type { IMcpServer } from './mcp-server.js';
import { resolveClientDescriptors } from './resolve-client-descriptors.js';

/**
 * Multiple servers require labeled descriptors. A single undescribed server
 * keeps the positional s0 prefix and returns `undefined`.
 *
 * `seam` names the caller in the message (e.g. `withMcpServers`).
 */
export function collectServerDescriptors(
  servers: readonly IMcpServer[],
  seam: string,
): readonly McpClientDescriptor[] | undefined {
  const descriptors = resolveClientDescriptors(
    servers.length,
    servers.map((s) => s.descriptor),
    seam,
  );
  return servers.some((s) => s.descriptor !== undefined)
    ? descriptors
    : undefined;
}
