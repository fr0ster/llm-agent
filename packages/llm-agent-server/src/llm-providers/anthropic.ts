/**
 * Anthropic (Claude) LLM Provider
 */

import axios, { type AxiosInstance } from 'axios';
import type { IModelInfo } from '../smart-agent/interfaces/model-provider.js';
import type {
  LLMCallOptions,
  LLMProviderConfig,
  LLMResponse,
  Message,
} from '../types.js';
import { BaseLLMProvider } from './base.js';

export interface AnthropicConfig extends LLMProviderConfig {
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export class AnthropicProvider extends BaseLLMProvider<AnthropicConfig> {
  readonly client: AxiosInstance;
  readonly model: string;

  constructor(config: AnthropicConfig) {
    super(config);
    this.validateConfig();

    this.model = config.model || 'claude-3-5-sonnet-20241022';

    this.client = axios.create({
      baseURL: config.baseURL || 'https://api.anthropic.com/v1',
      headers: {
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
    });
  }

  async chat(
    messages: Message[],
    tools?: unknown[],
    options?: LLMCallOptions,
  ): Promise<LLMResponse> {
    try {
      const systemMessage = messages.find((m) => m.role === 'system');
      const conversationMessages = messages.filter((m) => m.role !== 'system');

      const requestBody: Record<string, unknown> = {
        model: options?.model ?? this.model,
        messages: this.formatMessages(conversationMessages),
        max_tokens: options?.maxTokens ?? this.config.maxTokens ?? 4096,
        temperature: options?.temperature ?? this.config.temperature ?? 0.7,
        ...(options?.topP !== undefined ? { top_p: options.topP } : {}),
        ...(options?.stop ? { stop_sequences: options.stop } : {}),
      };

      if (systemMessage) {
        requestBody.system = systemMessage.content;
      }

      if (tools && tools.length > 0) {
        requestBody.tools = tools;
      }

      const response = await this.client.post('/messages', requestBody);

      // Handle multi-block response (text + tool_use)
      const content = response.data.content as Array<{
        type?: string;
        text?: string;
      }>;
      let textContent = '';
      for (const block of content) {
        if (block.type === 'text') textContent += block.text;
      }

      const rawUsage = response.data.usage;
      const usage = rawUsage
        ? {
            prompt_tokens: rawUsage.input_tokens ?? 0,
            completion_tokens: rawUsage.output_tokens ?? 0,
            total_tokens:
              (rawUsage.input_tokens ?? 0) + (rawUsage.output_tokens ?? 0),
          }
        : undefined;

      return {
        content: textContent,
        finishReason: response.data.stop_reason,
        raw: response.data,
        usage,
      };
    } catch (error: unknown) {
      const message = axios.isAxiosError(error)
        ? (error.response?.data as { error?: { message?: string } })?.error
            ?.message || error.message
        : error instanceof Error
          ? error.message
          : String(error);
      throw new Error(`Anthropic API error: ${message}`);
    }
  }

  async *streamChat(
    messages: Message[],
    tools?: unknown[],
    options?: LLMCallOptions,
  ): AsyncIterable<LLMResponse> {
    const systemMessage = messages.find((m) => m.role === 'system');
    const conversationMessages = messages.filter((m) => m.role !== 'system');

    const requestBody: Record<string, unknown> = {
      model: options?.model ?? this.model,
      messages: this.formatMessages(conversationMessages),
      max_tokens: options?.maxTokens ?? this.config.maxTokens ?? 4096,
      temperature: options?.temperature ?? this.config.temperature ?? 0.7,
      stream: true,
      ...(options?.topP !== undefined ? { top_p: options.topP } : {}),
      ...(options?.stop ? { stop_sequences: options.stop } : {}),
    };

    if (systemMessage) {
      requestBody.system = systemMessage.content;
    }

    if (tools && tools.length > 0) {
      requestBody.tools = tools;
    }

    const baseURL = this.config.baseURL || 'https://api.anthropic.com/v1';
    const response = await fetch(`${baseURL}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.config.apiKey ?? '',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => '');
      throw new Error(
        `Anthropic streaming error: HTTP ${response.status} — ${text}`,
      );
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        let eventType = '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) {
            eventType = '';
            continue;
          }
          if (trimmed.startsWith('event: ')) {
            eventType = trimmed.slice(7);
            continue;
          }
          if (!trimmed.startsWith('data: ')) continue;

          const data = trimmed.slice(6);
          try {
            const parsed = JSON.parse(data);
            if (
              eventType === 'content_block_delta' &&
              parsed.delta?.type === 'text_delta'
            ) {
              yield { content: parsed.delta.text || '', raw: parsed };
            } else if (eventType === 'message_start' && parsed.message?.usage) {
              const u = parsed.message.usage;
              yield {
                content: '',
                raw: parsed,
                usage: {
                  prompt_tokens: u.input_tokens ?? 0,
                  completion_tokens: u.output_tokens ?? 0,
                  total_tokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0),
                },
              };
            } else if (eventType === 'message_delta') {
              const u = parsed.usage;
              yield {
                content: '',
                finishReason: parsed.delta?.stop_reason,
                raw: parsed,
                usage: u
                  ? {
                      prompt_tokens: 0,
                      completion_tokens: u.output_tokens ?? 0,
                      total_tokens: u.output_tokens ?? 0,
                    }
                  : undefined,
              };
            } else if (eventType === 'error') {
              const error = parsed.error as { message?: string } | undefined;
              throw new Error(
                `Anthropic stream error: ${error?.message ?? 'unknown'}`,
              );
            } else {
              yield { content: '', raw: parsed };
            }
          } catch (e) {
            if (
              e instanceof Error &&
              e.message.startsWith('Anthropic stream error:')
            ) {
              throw e;
            }
            /* incomplete JSON — skip */
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  async getModels(): Promise<IModelInfo[]> {
    const response = await this.client.get('/models');
    return (response.data.data as Array<{ id: string; owned_by?: string }>).map(
      (m) => ({ id: m.id, owned_by: m.owned_by }),
    );
  }

  async getEmbeddingModels(): Promise<IModelInfo[]> {
    return [];
  }

  /**
   * Format messages for Anthropic API
   */
  private formatMessages(messages: Message[]): Array<Record<string, unknown>> {
    return messages.map((msg) => ({
      role: msg.role === 'assistant' ? 'assistant' : 'user',
      content: msg.content,
    }));
  }
}
