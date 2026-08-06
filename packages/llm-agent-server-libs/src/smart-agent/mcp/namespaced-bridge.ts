import type {
  IMcpClient,
  IMcpFailureClassifier,
  McpCallResult,
  McpClientDescriptor,
} from '@mcp-abap-adt/llm-agent';
import { bindToolCallName } from '@mcp-abap-adt/llm-agent';
import { DefaultMcpFailureClassifier } from '@mcp-abap-adt/llm-agent-mcp';
import { mcpContentToText } from '../../mcp/mcp-content.js';

/**
 * Resolve the client that currently owns a given provenance `slotIndex`: the
 * client whose descriptor carries that `slotIndex` (descriptors are index-
 * aligned with `clients`), or — when no descriptors were supplied — the
 * client at that array index directly. Returns `undefined` when nothing
 * matches (fewer session clients than provenance slots, e.g. a slot that
 * never (re)connected).
 */
function resolveSlotClient(
  slotIndex: number,
  clients: readonly IMcpClient[],
  descriptors?: readonly McpClientDescriptor[],
): IMcpClient | undefined {
  if (!descriptors) return clients[slotIndex];
  const idx = descriptors.findIndex((d) => d.slotIndex === slotIndex);
  return idx === -1 ? undefined : clients[idx];
}

/**
 * Rebind a namespaced-tools `provenance` map (exposed name → { slotIndex,
 * originalName }, built once against the SHARED tool catalog's connections)
 * onto a FRESH set of per-session `clients` (#244). Per-session MCP isolation
 * (#213) constructs new client instances per request, so the catalog-time
 * `toolClientMap` — bound to the original clients — cannot be reused as-is;
 * this walks the stable provenance instead and re-resolves each exposed name
 * against the current session's clients.
 *
 * Mirrors `buildNamespacedTools` (`packages/llm-agent/src/interfaces/build-namespaced-tools.ts`):
 * the real client when the exposed name was NOT namespaced (bare — unique
 * tool), the `bindToolCallName` wrapper when it WAS (so `callTool` still
 * targets the tool's original, pre-namespace name on the wire). The
 * discriminator is purely `exposedName === originalName` — this NEVER
 * re-`listTools()` to "discover" a bare name.
 *
 * When no client matches a provenance slot, the entry is SKIPPED (no map
 * key) rather than thrown — a later `map.get` miss surfaces as an ordinary
 * "Tool not found" from `buildNamespacedMcpBridge`, never a hard failure at
 * rebind time.
 */
export function rebindProvenanceToClients(
  provenance: ReadonlyMap<string, { slotIndex: number; originalName: string }>,
  clients: readonly IMcpClient[],
  descriptors?: readonly McpClientDescriptor[],
): Map<string, IMcpClient> {
  const map = new Map<string, IMcpClient>();
  for (const [exposedName, { slotIndex, originalName }] of provenance) {
    const client = resolveSlotClient(slotIndex, clients, descriptors);
    if (!client) continue;
    map.set(
      exposedName,
      exposedName === originalName
        ? client
        : bindToolCallName(client, originalName),
    );
  }
  return map;
}

/**
 * Shared MCP bridge over a pre-resolved exposed-name → owning-client map
 * (#244 addendum §3c). Unlike `buildMcpBridge` (`smart-server.ts`), the owner
 * is already known from `toolClientMap` — no per-call `listTools()` ownership
 * scan is needed, since namespacing has already resolved which client answers
 * for which exposed name at rebind time.
 *
 * The probe + classify/throw-vs-isError branches are otherwise IDENTICAL to
 * `buildMcpBridge`: an availability failure (per the classifier, using the
 * owning client's `healthCheck` as the probe) fails loud — throws — so a
 * transient outage is never mistaken for tool feedback; a tool-level error
 * comes back as `{ isError: true, text: error.message }` for the LLM to see.
 */
export function buildNamespacedMcpBridge(
  toolClientMap: ReadonlyMap<string, IMcpClient>,
  classifier: IMcpFailureClassifier = new DefaultMcpFailureClassifier(),
): (
  name: string,
  args: unknown,
  signal?: AbortSignal,
) => Promise<McpCallResult> {
  return async (name: string, args: unknown, signal?: AbortSignal) => {
    const client = toolClientMap.get(name);
    if (!client) return { text: `Tool not found: ${name}`, isError: true };

    const safeArgs =
      args != null && typeof args === 'object' && !Array.isArray(args)
        ? (args as Record<string, unknown>)
        : {};
    const opts = signal ? { signal } : undefined;
    const probe = client.healthCheck
      ? () => client.healthCheck!(opts).then((r) => (r.ok ? r.value : false))
      : undefined;

    const result = await client.callTool(name, safeArgs, opts);
    if (!result.ok) {
      // Availability failure → fail loud; a tool-level error → LLM feedback
      // text WITH isError:true so the caller can see it failed (#213).
      if ((await classifier.classify(result.error, probe)) === 'unavailable')
        throw result.error;
      return { text: result.error.message, isError: true };
    }
    const { content, isError } = result.value;
    return {
      text: mcpContentToText(content),
      isError: isError ?? false,
    };
  };
}
