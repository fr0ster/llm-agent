import {
  buildNamespacedTools,
  type CallOptions,
  type IMcpClient,
  type IToolNamespace,
  OrchestratorError,
} from '@mcp-abap-adt/llm-agent';
import type { McpClientDescriptor } from '../interfaces/mcp-connection-strategy.js';

/** Lists every client's tools; any client that fails, or fewer clients than configured, is MCP_UNAVAILABLE (spec §10.5.3 M4–M6 — one rule for the three sites). */
export async function listClientTools(
  clients: readonly IMcpClient[],
  opts: {
    /** The stage or component that lists — the message's prefix (e.g. `tool-select`). */
    stage?: string;
    descriptors?: readonly McpClientDescriptor[];
    configuredSlotCount?: number;
    toolNamespace: IToolNamespace;
    options?: CallOptions;
  },
): Promise<ReturnType<typeof buildNamespacedTools>> {
  const settled = await Promise.allSettled(
    clients.map((client) => client.listTools(opts.options)),
  );
  const slotOf = (i: number): number => opts.descriptors?.[i]?.slotIndex ?? i;
  const nameOf = (i: number): string => {
    const label = opts.descriptors?.[i]?.label;
    return `client ${slotOf(i)}${label ? ` "${label}"` : ''}`;
  };

  const failures: string[] = [];
  const perClient: Parameters<typeof buildNamespacedTools>[0] = [];
  settled.forEach((entry, i) => {
    if (entry.status === 'rejected') {
      const err = entry.reason;
      const code =
        err && typeof (err as { code?: unknown }).code === 'string'
          ? (err as { code: string }).code
          : 'MCP_ERROR';
      const message = err instanceof Error ? err.message : String(err);
      failures.push(`${nameOf(i)} ${code}: ${message}`);
      return;
    }
    if (!entry.value.ok) {
      failures.push(
        `${nameOf(i)} ${entry.value.error.code}: ${entry.value.error.message}`,
      );
      return;
    }
    perClient.push({
      slotIndex: slotOf(i),
      label: opts.descriptors?.[i]?.label,
      client: clients[i],
      tools: entry.value.value,
    });
  });

  const configured = opts.configuredSlotCount ?? clients.length;
  if (clients.length < configured) {
    const present = new Set(clients.map((_, i) => slotOf(i)));
    const missing: number[] = [];
    for (let slot = 0; slot < configured; slot++) {
      if (!present.has(slot)) missing.push(slot);
    }
    failures.push(
      missing.length > 0
        ? missing.map((slot) => `slot ${slot} not connected`).join('; ')
        : `${configured - clients.length} of ${configured} configured slot(s) not connected`,
    );
  }

  if (failures.length > 0) {
    throw new OrchestratorError(
      `${opts.stage ? `${opts.stage}: ` : ''}MCP tools unavailable: ${failures.join('; ')}`,
      'MCP_UNAVAILABLE',
    );
  }
  return buildNamespacedTools(perClient, opts.toolNamespace);
}
