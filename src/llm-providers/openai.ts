/**
 * OpenAI LLM Provider
 */

import axios, { type AxiosInstance } from 'axios';
import type { LLMProviderConfig, LLMResponse, Message } from '../types.js';
import { BaseLLMProvider } from './base.js';

export interface OpenAIConfig extends LLMProviderConfig {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  organization?: string;
  project?: string;
}

export class OpenAIProvider extends BaseLLMProvider<OpenAIConfig> {
  readonly client: AxiosInstance;
  readonly model: string;

  constructor(config: OpenAIConfig) {
    super(config);
    this.validateConfig();

    this.model = config.model || 'gpt-4o-mini';

    const headers: Record<string, string> = {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    };

    // Add organization header if provided
    if (config.organization) {
      headers['OpenAI-Organization'] = config.organization;
    }

    // Add project header if provided
    if (config.project) {
      headers['OpenAI-Project'] = config.project;
    }

    this.client = axios.create({
      baseURL: config.baseURL || 'https://api.openai.com/v1',
      headers,
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
        max_tokens: this.config.maxTokens || 2000,
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
      throw new Error(`OpenAI API error: ${message}`);
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
          max_tokens: this.config.maxTokens || 2000,
          stream: true,
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
          if (!trimmed || !trimmed.startsWith('data: ')) continue;

          const data = trimmed.slice(6);
          if (data === '[DONE]') break;

          try {
            const parsed = JSON.parse(data);
            const choice = parsed.choices[0];
            if (choice.delta) {
              yield {
                content: choice.delta.content || '',
                finishReason: choice.finish_reason,
                raw: parsed,
              };
            }
          } catch (_e) {
            // Ignore parse errors for incomplete chunks
          }
        }
      }
    } catch (error: unknown) {
      const message = axios.isAxiosError(error)
        ? (error.response?.data as { error?: { message?: string } })?.error
            ?.message || error.message
        : error instanceof Error
          ? error.message
          : String(error);
      throw new Error(`OpenAI Streaming error: ${message}`);
    }
  }

  /**
   * Format messages for OpenAI API with strict protocol enforcement.
   */
  private formatMessages(messages: Message[]): Array<Record<string, unknown>> {
    const formatted: Array<Record<string, unknown>> = [];

    for (const msg of messages) {
      if (msg.role === 'tool' && !msg.tool_call_id) {
        continue;
      }

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
      }

      if (msg.role === 'tool') {
        entry.tool_call_id = msg.tool_call_id;
        entry.content =
          typeof msg.content === 'string'
            ? msg.content
            : JSON.stringify(msg.content ?? '');
      }

      formatted.push(entry);
    }

    return formatted;
  }
}
