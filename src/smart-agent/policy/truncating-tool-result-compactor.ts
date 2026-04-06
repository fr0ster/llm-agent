import type { Message } from '../../types.js';
import type { IToolResultCompactor } from '../interfaces/tool-result-compactor.js';

/**
 * Keeps the last `keep` tool-result messages at full length.
 * Older tool results exceeding `threshold` chars are truncated to `previewLength`
 * chars with a truncation notice.
 */
export class TruncatingToolResultCompactor implements IToolResultCompactor {
  private readonly keep: number;
  private readonly threshold: number;
  private readonly previewLength: number;

  constructor(opts?: {
    keep?: number;
    threshold?: number;
    previewLength?: number;
  }) {
    this.keep = opts?.keep ?? 3;
    this.threshold = opts?.threshold ?? 300;
    this.previewLength = opts?.previewLength ?? 200;
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
      const text = typeof msg.content === 'string' ? msg.content : '';
      if (text.length <= this.threshold) return msg;
      const summary = `${text.slice(0, this.previewLength)}\n… [truncated, ${text.length} chars total]`;
      return { ...msg, content: summary };
    });
  }
}
