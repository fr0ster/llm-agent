/**
 * DeepSeek LLM Provider
 */

import axios, { type AxiosInstance } from 'axios';
import type { LLMProviderConfig, LLMResponse, Message } from '../types.js';
import { BaseLLMProvider } from './base.js';

export interface DeepSeekConfig extends LLMProviderConfig {
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export class DeepSeekProvider extends BaseLLMProvider {
  private client: AxiosInstance;
  private model: string;

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

  async chat(messages: Message[], tools?: any[]): Promise<LLMResponse> {
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
    } catch (error: any) {
      throw new Error(
        `DeepSeek API error: ${error.response?.data?.error?.message || error.message}`,
      );
    }
  }

  async *streamChat(messages: Message[], tools?: any[]): AsyncIterable<LLMResponse> {
    try {
      const body = {
        model: this.model,
        messages: this.formatMessages(messages),
        tools: tools && tools.length > 0 ? tools : undefined,
        tool_choice: tools && tools.length > 0 ? 'auto' : undefined,
        temperature: this.config.temperature || 0.7,
        max_tokens: this.config.maxTokens || 2000,
        stream: true,
      };

      // DEBUG: Log the payload that causes 400
      console.error('[DeepSeek Request]', JSON.stringify(body, null, 2));

      const response = await this.client.post(
        '/chat/completions',
        body,
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
          } catch (e) {
            // Ignore parse errors for incomplete chunks
          }
        }
      }
    } catch (error: any) {
      throw new Error(
        `DeepSeek Streaming error: ${error.response?.data?.error?.message || error.message}`,
      );
    }
  }

  /**
   * Format messages for DeepSeek API
   */
  private formatMessages(messages: Message[]): any[] {
    const formatted: any[] = [];
    
    for (const msg of messages) {
      const entry: any = {
        role: msg.role,
        content: msg.content ?? "",
      };
      
      if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
        // Only include tool_calls that have a name
        const validCalls = msg.tool_calls.filter(tc => tc.function?.name);
        if (validCalls.length > 0) {
          entry.tool_calls = validCalls;
          entry.content = msg.content || null;
        }
      }
      
      if (msg.role === 'tool') {
        if (!msg.tool_call_id) continue; // SKIP broken tool messages
        entry.tool_call_id = msg.tool_call_id;
        entry.content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      }
      
      formatted.push(entry);
    }
    
    return formatted;
  }
}
