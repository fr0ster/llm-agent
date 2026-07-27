import type { IMcpClient } from './mcp-client.js';
import type { McpClientDescriptor } from './mcp-connection-strategy.js';

/** Fail-fast on a malformed connection result (a buggy custom strategy). No-op
 *  when descriptors are absent (a non-filtering strategy may omit them). */
export function assertClientDescriptors(
  clients: readonly IMcpClient[],
  descriptors: readonly McpClientDescriptor[] | undefined,
  configuredSlotCount?: number,
): void {
  if (!descriptors) return;
  const nonNegInt = (n: number): boolean => Number.isInteger(n) && n >= 0;
  if (descriptors.length !== clients.length)
    throw new Error(
      `clientDescriptors length ${descriptors.length} !== clients length ${clients.length}`,
    );
  const seen = new Set<number>();
  let max = -1;
  for (const d of descriptors) {
    if (!nonNegInt(d.slotIndex))
      throw new Error(
        `slotIndex must be a non-negative integer, got ${d.slotIndex}`,
      );
    if (seen.has(d.slotIndex))
      throw new Error(
        `duplicate slotIndex ${d.slotIndex} in clientDescriptors`,
      );
    seen.add(d.slotIndex);
    if (d.slotIndex > max) max = d.slotIndex;
  }
  if (configuredSlotCount !== undefined) {
    if (!nonNegInt(configuredSlotCount))
      throw new Error(
        `configuredSlotCount must be a non-negative integer, got ${configuredSlotCount}`,
      );
    if (configuredSlotCount <= max)
      throw new Error(
        `configuredSlotCount ${configuredSlotCount} must be > max slotIndex ${max}`,
      );
  }
}
