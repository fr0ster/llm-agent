import type { Message } from '../../types.js';
import type { ILlm } from '../interfaces/llm.js';
import type { IToolResultCompactor } from '../interfaces/tool-result-compactor.js';

const SUMMARY_PROMPT = `Summarize this tool result in one line (max 200 chars).
Keep: object names, counts, success/failure status.
Remove: raw XML/JSON bodies, verbose descriptions, duplicate content.
Reply with ONLY the summary line, nothing else.`;

export interface LlmToolResultCompactorConfig {
  /** Results longer than this (chars) are summarized via LLM. Default: 1024. */
  threshold?: number;
  /** Number of recent tool results to keep full. Default: 3. */
  keep?: number;
}

/**
 * Uses a helper LLM to create meaningful summaries of large tool results.
 * Only results exceeding `threshold` chars are summarized.
 * Small results and recent results (last `keep`) pass through unchanged.
 */
export class LlmToolResultCompactor implements IToolResultCompactor {
  private readonly threshold: number;
  private readonly keep: number;

  constructor(
    private readonly llm: ILlm,
    config?: LlmToolResultCompactorConfig,
  ) {
    this.threshold = config?.threshold ?? 1024;
    this.keep = config?.keep ?? 3;
  }

  async compact(
    messages: Message[],
    _currentIteration: number,
  ): Promise<Message[]> {
    const toolIndices: number[] = [];
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role === 'tool') {
        toolIndices.push(i);
      }
    }

    if (toolIndices.length <= this.keep) return messages;

    const cutoff = toolIndices[toolIndices.length - this.keep];
    const compactSet = new Set(toolIndices.filter((idx) => idx < cutoff));

    const result = [...messages];

    for (const idx of compactSet) {
      const msg = result[idx];
      const text = typeof msg.content === 'string' ? msg.content : '';
      if (text.length <= this.threshold) continue;

      const summary = await this.summarize(text);
      result[idx] = { ...msg, content: summary };
    }

    return result;
  }

  private async summarize(text: string): Promise<string> {
    try {
      const chatResult = await this.llm.chat([
        { role: 'system', content: SUMMARY_PROMPT },
        { role: 'user', content: text },
      ]);
      if (chatResult.ok && chatResult.value.content) {
        return chatResult.value.content.slice(0, 300);
      }
    } catch {
      // Fallback to truncation on LLM failure
    }
    return `${text.slice(0, 200)}\n… [truncated, ${text.length} chars]`;
  }
}
