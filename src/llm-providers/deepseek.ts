/**
 * DeepSeek LLM Provider
 */

import axios, { type AxiosInstance } from 'axios';
import type { IModelInfo } from '../smart-agent/interfaces/model-provider.js';
import type { LLMProviderConfig, LLMResponse, Message } from '../types.js';
import { BaseLLMProvider } from './base.js';

export interface DeepSeekConfig extends LLMProviderConfig {
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export class DeepSeekProvider extends BaseLLMProvider<DeepSeekConfig> {
  readonly client: AxiosInstance;
  readonly model: string;

  constructor(config: DeepSeekConfig) {
    super(config);
    this.validateConfig();
    this.model = config.model || 'deepseek-chat';
    this.client = axios.create({
      baseURL: config.baseURL || 'https://api.deepseek.com/v1',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
    });
  }

  async chat(messages: Message[], tools?: unknown[]): Promise<LLMResponse> {
    try {
      const response = await this.client.post('/chat/completions', {
        model: this.model,
        messages: this.formatMessages(messages),
        tools: tools && tools.length > 0 ? tools : undefined,
        tool_choice: tools && tools.length > 0 ? 'auto' : undefined,
        temperature: this.config.temperature || 0.7,
        max_tokens: this.config.maxTokens || 4096,
      });
      const choice = response.data.choices[0];
      return {
        content: choice.message.content || '',
        finishReason: choice.finish_reason,
        raw: response.data,
      };
    } catch (error: unknown) {
      const message = axios.isAxiosError(error)
        ? (error.response?.data as { error?: { message?: string } })?.error
            ?.message || error.message
        : error instanceof Error
          ? error.message
          : String(error);
      throw new Error(`DeepSeek API error: ${message}`);
    }
  }

  async *streamChat(
    messages: Message[],
    tools?: unknown[],
  ): AsyncIterable<LLMResponse> {
    try {
      const response = await this.client.post(
        '/chat/completions',
        {
          model: this.model,
          messages: this.formatMessages(messages),
          tools: tools && tools.length > 0 ? tools : undefined,
          tool_choice: tools && tools.length > 0 ? 'auto' : undefined,
          temperature: this.config.temperature || 0.7,
          max_tokens: this.config.maxTokens || 4096,
          stream: true,
          stream_options: { include_usage: true },
        },
        { responseType: 'stream' },
      );

      const stream = response.data;
      let buffer = '';
      for await (const chunk of stream) {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed?.startsWith('data: ')) continue;
          const data = trimmed.slice(6);
          if (data === '[DONE]') break;
          try {
            const parsed = JSON.parse(data);
            const choice = parsed.choices?.[0];
            if (choice?.delta) {
              yield {
                content: choice.delta.content || '',
                finishReason: choice.finish_reason,
                raw: parsed,
              };
            }
            // Usage chunk (stream_options: include_usage)
            if (parsed.usage && !choice) {
              yield {
                content: '',
                raw: parsed,
              };
            }
          } catch (_e) {}
        }
      }
    } catch (error: unknown) {
      const message = axios.isAxiosError(error)
        ? (error.response?.data as { error?: { message?: string } })?.error
            ?.message || error.message
        : error instanceof Error
          ? error.message
          : String(error);
      throw new Error(`DeepSeek Streaming error: ${message}`);
    }
  }

  async getModels(): Promise<IModelInfo[]> {
    const response = await this.client.get('/models');
    return (response.data.data as Array<{ id: string; owned_by?: string }>).map(
      (m) => ({ id: m.id, owned_by: m.owned_by }),
    );
  }

  /**
   * Format messages with strict protocol enforcement.
   * Drops orphaned tool messages and ensures correct content types.
   */
  private formatMessages(messages: Message[]): Array<Record<string, unknown>> {
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
        entry.content = msg.content || null; // Protocol requirement
        for (const tc of msg.tool_calls) if (tc.id) knownToolCallIds.add(tc.id);
      }

      if (msg.role === 'tool') {
        // Drop tool messages that don't have a matching call ID in history
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
