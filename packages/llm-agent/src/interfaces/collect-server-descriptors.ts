import type { McpClientDescriptor } from './mcp-connection-strategy.js';
import type { IMcpServer } from './mcp-server.js';

/**
 * Descriptors are all or none. A partly-filled set is a caller bug: dropping it
 * would silently re-namespace every tool from its `label` to `s${slotIndex}`,
 * so it throws instead. Returns `undefined` when no server carries one — array
 * position is then the pairing, exactly as today.
 *
 * `seam` names the caller in the message (e.g. `withMcpServers`).
 */
export function collectServerDescriptors(
  servers: readonly IMcpServer[],
  seam: string,
): readonly McpClientDescriptor[] | undefined {
  const descriptors = servers
    .map((s) => s.descriptor)
    .filter((d): d is McpClientDescriptor => d !== undefined);
  if (descriptors.length === 0) return undefined;
  if (descriptors.length !== servers.length)
    throw new Error(
      `${seam}: ${descriptors.length} of ${servers.length} servers carry a descriptor — descriptors are all or none`,
    );
  return descriptors;
}
