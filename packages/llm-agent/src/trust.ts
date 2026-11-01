import type { Message } from './types.js';

// Model copies can pass through an assembler and then the tool loop. Track only
// those copies, never raw records or text prefixes that tools could themselves emit.
const modelToolMessages = new WeakSet<Message>();

/** Opaque per-class overrides, validated by the application that owns profiles. */
export type TrustMap = Partial<Record<string, number>>;

/** Resolve provenance for informational tool results at the model boundary. */
export type ToolTrust = (
  toolName: string,
) => { source: string; trust: number } | undefined;

export function normalizeTrust(value: number): number | undefined {
  return value >= 0 && value <= 5 && Math.round(value * 10) === value * 10
    ? value
    : undefined;
}

export function formatTrust(value: number): string {
  return String(value);
}

export function escapeTrustName(value: string): string {
  return value.replaceAll('[', '&#91;').replaceAll(']', '&#93;');
}

export function formatTrustTag(
  source: string | undefined,
  trust: number,
): string {
  return `[source: ${escapeTrustName(source ?? 'unknown')}; trust ${formatTrust(trust)}]`;
}

/** Project raw tool text without changing the recorded message. */
export function toModelToolMessage(
  raw: Message,
  toolTrust?: ToolTrust,
  toolName?: string,
): Message {
  if (
    raw.role !== 'tool' ||
    !toolTrust ||
    toolName === undefined ||
    modelToolMessages.has(raw)
  )
    return raw;
  const resolved = toolTrust(toolName);
  if (!resolved) return raw;
  const projected: Message = {
    ...raw,
    content: `${formatTrustTag(resolved.source, resolved.trust)}\n${raw.content ?? ''}`,
  };
  modelToolMessages.add(projected);
  return projected;
}

/** Match raw result IDs to their declarations, including replayed rounds. */
export function toModelToolMessages(
  raw: readonly Message[],
  toolTrust?: ToolTrust,
): Message[] {
  const names = new Map<string, string>();
  return raw.map((message) => {
    for (const call of message.tool_calls ?? []) {
      names.set(call.id, call.function.name);
    }
    return toModelToolMessage(
      message,
      toolTrust,
      message.tool_call_id === undefined
        ? undefined
        : names.get(message.tool_call_id),
    );
  });
}
