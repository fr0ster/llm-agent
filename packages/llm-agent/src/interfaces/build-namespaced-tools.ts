import type { IMcpClient } from './mcp-client.js';
import { bindToolCallName, type IToolNamespace } from './tool-namespace.js';
import type { McpTool } from './types.js';

const VALID_TOOL_NAME = /^[a-zA-Z0-9_-]+$/;

export interface NamespaceClientInput {
  slotIndex: number;
  label?: string;
  client: IMcpClient;
  tools: McpTool[];
}

export function buildNamespacedTools(
  perClient: NamespaceClientInput[],
  ns: IToolNamespace,
): {
  tools: McpTool[];
  toolClientMap: Map<string, IMcpClient>;
  /** Per exposed name → its source, so a vectorizer can build the record key from
   *  the ORIGINAL name + stable slotIndex (a flat tools[] index would not identify
   *  the owning client once a client has multiple tools). */
  provenance: Map<string, { slotIndex: number; originalName: string }>;
} {
  // Defence in depth against a buggy custom connection strategy: slotIndex must be unique.
  const slots = new Set<number>();
  for (const pc of perClient) {
    if (slots.has(pc.slotIndex))
      throw new Error(
        `buildNamespacedTools: duplicate slotIndex ${pc.slotIndex} in input`,
      );
    slots.add(pc.slotIndex);
  }
  // Collision = a tool name present in >= 2 clients.
  const counts = new Map<string, number>();
  for (const pc of perClient)
    for (const t of pc.tools) counts.set(t.name, (counts.get(t.name) ?? 0) + 1);

  const tools: McpTool[] = [];
  const toolClientMap = new Map<string, IMcpClient>();
  const provenance = new Map<
    string,
    { slotIndex: number; originalName: string }
  >(); // exposed → source

  for (const pc of perClient) {
    const prefix = pc.label ?? `s${pc.slotIndex}`;
    for (const t of pc.tools) {
      const colliding = (counts.get(t.name) ?? 0) > 1;
      const exposed = ns.expose({ toolName: t.name, prefix, colliding });

      // Per-name validity guard — the builder is the trust boundary for the strategy.
      if (
        typeof exposed !== 'string' ||
        exposed.length === 0 ||
        exposed.length > 64 ||
        !VALID_TOOL_NAME.test(exposed)
      )
        throw new Error(
          `IToolNamespace produced an invalid tool name ${JSON.stringify(exposed)} ` +
            `for tool "${t.name}" on server slot ${pc.slotIndex}${pc.label ? ` (${pc.label})` : ''}; ` +
            `must be non-empty, /^[a-zA-Z0-9_-]+$/, <= 64 chars.`,
        );
      // Global-uniqueness guard — the final exposed set (renamed AND bare) must be unique.
      const prev = provenance.get(exposed);
      if (prev)
        throw new Error(
          `Tool name collision: "${exposed}" is produced by both ` +
            `slot ${prev.slotIndex} tool "${prev.originalName}" and slot ${pc.slotIndex} tool "${t.name}". ` +
            `Set distinct mcp[].name labels.`,
        );
      provenance.set(exposed, {
        slotIndex: pc.slotIndex,
        originalName: t.name,
      });

      tools.push({ ...t, name: exposed });
      toolClientMap.set(
        exposed,
        exposed === t.name ? pc.client : bindToolCallName(pc.client, t.name),
      );
    }
  }
  return { tools, toolClientMap, provenance };
}
