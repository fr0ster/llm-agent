/**
 * OpenAI LLM Provider
 */

import axios, { AxiosInstance } from 'axios';
import { BaseLLMProvider } from './base.js';
import type { Message, LLMResponse, LLMProviderConfig } from '../types.js';

export interface OpenAIConfig extends LLMProviderConfig {
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export class OpenAIProvider extends BaseLLMProvider {
  private client: AxiosInstance;
  private model: string;

  constructor(config: OpenAIConfig) {
    super(config);
    this.validateConfig();
    
    this.model = config.model || 'gpt-4o-mini';
    
    this.client = axios.create({
      baseURL: config.baseURL || 'https://api.openai.com/v1',
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
    });
  }

  async chat(messages: Message[]): Promise<LLMResponse> {
    try {
      const response = await this.client.post('/chat/completions', {
        model: this.model,
        messages: this.formatMessages(messages),
        temperature: this.config.temperature || 0.7,
        max_tokens: this.config.maxTokens || 2000,
      });

      const choice = response.data.choices[0];
      
      return {
        content: choice.message.content || '',
        finishReason: choice.finish_reason,
      };
    } catch (error: any) {
      throw new Error(`OpenAI API error: ${error.response?.data?.error?.message || error.message}`);
    }
  }

  /**
   * Format messages for OpenAI API
   */
  private formatMessages(messages: Message[]): any[] {
    return messages.map(msg => ({
      role: msg.role,
      content: msg.content,
    }));
  }
}

