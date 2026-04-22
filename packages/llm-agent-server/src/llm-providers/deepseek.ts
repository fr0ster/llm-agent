/**
 * DeepSeek LLM Provider — extends OpenAI (DeepSeek uses OpenAI-compatible API).
 */

import type {
  IModelInfo,
  LLMProviderConfig,
  Message,
} from '@mcp-abap-adt/llm-agent';
import { type OpenAIConfig, OpenAIProvider } from './openai.js';

export interface DeepSeekConfig extends LLMProviderConfig {
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export class DeepSeekProvider extends OpenAIProvider {
  protected override readonly providerName: string = 'DeepSeek';

  constructor(config: DeepSeekConfig) {
    super({
      ...config,
      baseURL: config.baseURL || 'https://api.deepseek.com/v1',
      model: config.model || 'deepseek-chat',
    } as OpenAIConfig);
  }

  /**
   * DeepSeek always uses max_tokens (no gpt-5/o1/o3 distinction).
   */
  protected override getTokenLimitParam(
    _model: string,
    maxTokens: number,
  ): Record<string, number> {
    return { max_tokens: maxTokens };
  }

  override async getEmbeddingModels(): Promise<IModelInfo[]> {
    return [];
  }

  /**
   * Stricter formatMessages — tracks known tool_call_ids and drops orphans.
   */
  protected override formatMessages(
    messages: Message[],
  ): Array<Record<string, unknown>> {
    const formatted: Array<Record<string, unknown>> = [];
    const knownToolCallIds = new Set<string>();

    for (const msg of messages) {
      const entry: Record<string, unknown> = {
        role: msg.role,
        content: msg.content ?? '',
      };

      if (
        msg.role === 'assistant' &&
        msg.tool_calls &&
        msg.tool_calls.length > 0
      ) {
        entry.tool_calls = msg.tool_calls;
        entry.content = msg.content || null;
        for (const tc of msg.tool_calls) if (tc.id) knownToolCallIds.add(tc.id);
      }

      if (msg.role === 'tool') {
        if (!msg.tool_call_id || !knownToolCallIds.has(msg.tool_call_id))
          continue;
        entry.tool_call_id = msg.tool_call_id;
        entry.content =
          typeof msg.content === 'string'
            ? msg.content
            : JSON.stringify(msg.content ?? '');
      }

      // Final safety check: non-assistant roles MUST have string content
      if (entry.role !== 'assistant' && entry.content === null)
        entry.content = '';

      formatted.push(entry);
    }
    return formatted;
  }
}
