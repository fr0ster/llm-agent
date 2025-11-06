/**
 * Anthropic (Claude) LLM Provider
 */

import axios, { AxiosInstance } from 'axios';
import { BaseLLMProvider } from './base.js';
import type { Message, LLMResponse, LLMProviderConfig } from '../types.js';

export interface AnthropicConfig extends LLMProviderConfig {
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export class AnthropicProvider extends BaseLLMProvider {
  private client: AxiosInstance;
  private model: string;

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

  async chat(messages: Message[]): Promise<LLMResponse> {
    try {
      // Anthropic API uses different message format
      const systemMessage = messages.find(m => m.role === 'system');
      const conversationMessages = messages.filter(m => m.role !== 'system');
      
      const requestBody: any = {
        model: this.model,
        messages: this.formatMessages(conversationMessages),
        max_tokens: this.config.maxTokens || 2000,
        temperature: this.config.temperature || 0.7,
      };

      if (systemMessage) {
        requestBody.system = systemMessage.content;
      }

      const response = await this.client.post('/messages', requestBody);

      const content = response.data.content[0];
      
      return {
        content: content.text || '',
        finishReason: response.data.stop_reason,
      };
    } catch (error: any) {
      throw new Error(`Anthropic API error: ${error.response?.data?.error?.message || error.message}`);
    }
  }

  /**
   * Format messages for Anthropic API
   */
  private formatMessages(messages: Message[]): any[] {
    return messages.map(msg => ({
      role: msg.role === 'assistant' ? 'assistant' : 'user',
      content: msg.content,
    }));
  }
}

