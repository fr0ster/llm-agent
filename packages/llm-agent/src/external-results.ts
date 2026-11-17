import type { Message } from './types.js';

const EXT_PREFIX = 'ext:';

export interface ExternalResults {
  /** Validated external-tool results keyed by the returned `ext:` call ID. */
  results: Map<string, string>;
  /** Full history, in its original order. Kept under this name for compatibility. */
  sanitizedMessages: Message[];
}

function isExternalId(id: string): boolean {
  return id.startsWith(EXT_PREFIX);
}

function declaresExternalCall(msg: Message): boolean {
  return (
    msg.role === 'assistant' &&
    (msg.tool_calls ?? []).some((c) => isExternalId(c.id))
  );
}

/**
 * Extract validated external-tool RESULTS from request history into a map keyed
 * by the returned `ext:` call ID, without removing any conversation content.
 * The cache is an additional index, not a replacement for model history.
 * Operates ONLY on the OpenAI-normalized
 * `Message[]` shape (the adapter normalizes Anthropic `tool_result` blocks to
 * `role:'tool'` upstream).
 */
export function buildExternalResults(
  messages: readonly Message[],
): ExternalResults {
  const results = new Map<string, string>();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (declaresExternalCall(msg)) {
      // Declared external ids on this assistant turn.
      const declared = new Set(
        (msg.tool_calls ?? [])
          .map((c) => c.id)
          .filter((id) => isExternalId(id)),
      );
      // Index matching results in the immediately following tool-result run.
      // Internal results may be interleaved with external ones.
      let j = i + 1;
      while (j < messages.length && messages[j].role === 'tool') {
        const id = messages[j].tool_call_id;
        if (id !== undefined && declared.has(id)) {
          results.set(id, messages[j].content ?? '');
        }
        j++;
      }
      i = j - 1;
    }
  }

  return { results, sanitizedMessages: [...messages] };
}
