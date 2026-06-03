import type { Message } from './types.js';

const EXT_PREFIX = 'ext:';

export interface ExternalResults {
  /** Validated external-tool results keyed by deterministic `ext:` id. */
  results: Map<string, string>;
  /** History with consumed external assistant/tool turns removed, order preserved. */
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
 * by the deterministic `ext:` id, and return the history with the consumed
 * external assistant/tool turns removed. Operates ONLY on the OpenAI-normalized
 * `Message[]` shape (the adapter normalizes Anthropic `tool_result` blocks to
 * `role:'tool'` upstream).
 */
export function buildExternalResults(
  messages: readonly Message[],
): ExternalResults {
  const results = new Map<string, string>();
  const remove = new Array<boolean>(messages.length).fill(false);

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (declaresExternalCall(msg)) {
      // Declared external ids on this assistant turn.
      const declared = new Set(
        (msg.tool_calls ?? [])
          .map((c) => c.id)
          .filter((id) => isExternalId(id)),
      );
      remove[i] = true;

      // Consume the IMMEDIATELY-following consecutive run of role:'tool'
      // messages whose tool_call_id is one of the declared ext ids.
      let j = i + 1;
      while (j < messages.length && messages[j].role === 'tool') {
        const id = messages[j].tool_call_id;
        if (id === undefined || !declared.has(id)) break;
        results.set(id, messages[j].content ?? '');
        remove[j] = true;
        j++;
      }
      i = j - 1;
      continue;
    }

    // A stray role:'tool' with an ext: id that does not immediately follow a
    // declaring assistant external turn is malformed → drop it.
    if (
      msg.role === 'tool' &&
      msg.tool_call_id !== undefined &&
      isExternalId(msg.tool_call_id)
    ) {
      remove[i] = true;
    }
  }

  const sanitizedMessages: Message[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (!remove[i]) sanitizedMessages.push(messages[i]);
  }

  return { results, sanitizedMessages };
}
