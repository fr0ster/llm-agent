/**
 * SAP Core AI LLM Provider
 * 
 * Implementation of LLMProvider interface for SAP Core AI service.
 * This provider uses SAP Cloud SDK for authentication and destination handling.
 * 
 * All LLM providers (OpenAI, Anthropic, DeepSeek, etc.) are accessed through SAP AI Core.
 * SAP AI Core acts as a proxy/gateway to different LLM providers.
 * 
 * Architecture:
 * - Agent → SAP Core AI Provider → SAP AI Core → External LLM (OpenAI/Anthropic/DeepSeek)
 * - SAP AI Core handles authentication, routing, and provider selection
 */

import type { Message, LLMResponse, LLMProviderConfig } from '../types.js';

export interface SapCoreAIConfig extends LLMProviderConfig {
  /**
   * SAP Destination name for Core AI service
   */
  destinationName: string;
  
  /**
   * Model name (optional, defaults to service default)
   * Model selection determines which underlying LLM provider to use
   * Examples: 'gpt-4o-mini', 'claude-3-5-sonnet', 'deepseek-chat'
   */
  model?: string;
  
  /**
   * Temperature (optional)
   */
  temperature?: number;
  
  /**
   * Max tokens (optional)
   */
  maxTokens?: number;
  
  /**
   * HTTP client function for making requests
   * If not provided, will use axios (requires direct URL configuration)
   * If provided, should use SAP Cloud SDK executeHttpRequest
   */
  httpClient?: (config: {
    destinationName: string;
    method: string;
    url: string;
    headers?: Record<string, string>;
    data?: any;
  }) => Promise<{ data: any }>;
  
  /**
   * Optional logger instance
   */
  log?: any;
}

/**
 * SAP Core AI Provider implementation
 * 
 * Uses SAP Cloud SDK executeHttpRequest for authentication and destination handling.
 * All LLM providers are accessed through SAP AI Core, not directly.
 */
export class SapCoreAIProvider {
  private destinationName: string;
  private model: string;
  private config: SapCoreAIConfig;
  private httpClient: SapCoreAIConfig['httpClient'];
  private log?: any; // Optional logger

  constructor(config: SapCoreAIConfig) {
    if (!config.destinationName) {
      throw new Error('SAP destination name is required for SapCoreAIProvider');
    }
    
    this.destinationName = config.destinationName;
    this.model = config.model || 'gpt-4o-mini'; // Default model
    this.config = config;
    this.httpClient = config.httpClient;
    this.log = config.log;
  }

  async chat(messages: Message[]): Promise<LLMResponse> {
    try {
      if (this.log) {
        this.log.debug('Sending chat request to SAP Core AI', {
          destination: this.destinationName,
          model: this.model,
          messageCount: messages.length,
        });
      }

      // Format messages for SAP Core AI API
      const requestBody = {
        model: this.model,
        messages: this.formatMessages(messages),
        temperature: this.config.temperature || 0.7,
        max_tokens: this.config.maxTokens || 2000,
      };

      let response: { data: any };

      if (this.httpClient) {
        // Use provided HTTP client (typically SAP Cloud SDK)
        response = await this.httpClient({
          destinationName: this.destinationName,
          method: 'POST',
          url: '/v1/chat/completions',
          headers: {
            'Content-Type': 'application/json',
          },
          data: requestBody,
        });
      } else {
        // Fallback: use axios (requires direct URL configuration)
        // This is for standalone testing without SAP SDK
        const axios = await import('axios');
        const baseURL = process.env.SAP_CORE_AI_URL || 'https://api.ai.core.sap';
        
        response = await axios.default.post(
          `${baseURL}/v1/chat/completions`,
          requestBody,
          {
            headers: {
              'Content-Type': 'application/json',
            },
          }
        );
      }

      const choice = response.data.choices?.[0];
      
      if (!choice) {
        throw new Error('No response from SAP Core AI');
      }

      if (this.log) {
        this.log.debug('Received response from SAP Core AI', {
          finishReason: choice.finish_reason,
        });
      }

      return {
        content: choice.message?.content || '',
        finishReason: choice.finish_reason,
      };
    } catch (error: any) {
      if (this.log) {
        this.log.error('SAP Core AI API error', {
          destination: this.destinationName,
          error: error.message,
          response: error.response?.data,
        });
      }
      
      throw new Error(
        `SAP Core AI API error: ${error.response?.data?.error?.message || error.message}`
      );
    }
  }

  /**
   * Format messages for SAP Core AI API
   */
  private formatMessages(messages: Message[]): any[] {
    return messages.map(msg => ({
      role: msg.role,
      content: msg.content,
    }));
  }
}

