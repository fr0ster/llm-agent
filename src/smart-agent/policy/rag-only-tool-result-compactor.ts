import type { Message } from '../../types.js';
import type { IToolResultCompactor } from '../interfaces/tool-result-compactor.js';

/**
 * Removes all old tool results from context between iterations.
 * Only the last `keep` tool results are preserved.
 * Older tool results are replaced with a minimal placeholder.
 *
 * Use this when history is managed entirely via RAG — the tool-loop
 * context contains only recent actions, everything else is retrieved
 * from RAG stores at assembly time.
 */
export class RagOnlyToolResultCompactor implements IToolResultCompactor {
  private readonly keep: number;

  constructor(opts?: { keep?: number }) {
    this.keep = opts?.keep ?? 1;
  }

  compact(messages: Message[], _currentIteration: number): Message[] {
    const toolIndices: number[] = [];
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role === 'tool') {
        toolIndices.push(i);
      }
    }

    if (toolIndices.length <= this.keep) return messages;

    const cutoff = toolIndices[toolIndices.length - this.keep];
    const compactSet = new Set(toolIndices.filter((idx) => idx < cutoff));

    return messages.map((msg, i) => {
      if (!compactSet.has(i)) return msg;
      return { ...msg, content: '[result removed — available via history]' };
    });
  }
}
