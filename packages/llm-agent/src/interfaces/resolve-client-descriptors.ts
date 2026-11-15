import type { McpClientDescriptor } from './mcp-connection-strategy.js';

/** Resolve slots before filtering unavailable clients or listing their tools. */
export function resolveClientDescriptors(
  clientCount: number,
  descriptors: readonly (McpClientDescriptor | undefined)[] | undefined,
  seam: string,
): readonly McpClientDescriptor[] {
  const slots = Array.from(
    { length: clientCount },
    (_, i) => descriptors?.[i] ?? { slotIndex: i },
  );
  for (const slot of slots) {
    if (slot.label !== undefined && slot.label.trim().length === 0)
      throw new Error(`${seam}: MCP descriptor label must not be empty`);
    if (clientCount > 1 && slot.label === undefined)
      throw new Error(
        `${seam}: Multiple MCP clients require a descriptor label for every client. ` +
          'withMcpClients() does not carry labels; use withMcpServers() with descriptors carrying label, or named mcp: entries.',
      );
  }
  return slots;
}
