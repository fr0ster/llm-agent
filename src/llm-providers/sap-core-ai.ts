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

import type { LLMProviderConfig, LLMResponse, Message } from '../types.js';
import {
  getErrorMessage,
  getNestedApiErrorMessage,
  isRecord,
} from '../utils/errors.js';

interface Logger {
  debug?: (message: string, meta?: Record<string, unknown>) => void;
  error?: (message: string, meta?: Record<string, unknown>) => void;
}

interface SapCoreAIChoice {
  message?: {
    content?: string;
  };
  finish_reason?: string;
}

interface SapCoreAIResponseData {
  choices?: SapCoreAIChoice[];
}

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
    data?: unknown;
  }) => Promise<{ data: unknown }>;

  /**
   * Optional logger instance
   */
  log?: Logger;
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
  private log?: Logger;

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
        this.log.debug?.('Sending chat request to SAP Core AI', {
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

      let response: { data: unknown };

      if (this.httpClient) {
        // Use provided HTTP client (typically SAP Cloud SDK)
        // Ensure URL doesn't have trailing slash (SAP AI Core is strict about this)
        const url = '/v1/chat/completions'.replace(/\/$/, '');
        response = await this.httpClient({
          destinationName: this.destinationName,
          method: 'POST',
          url: url,
          headers: {
            'Content-Type': 'application/json',
          },
          data: requestBody,
        });
      } else {
        // Fallback: use axios (requires direct URL configuration)
        // This is for standalone testing without SAP SDK
        const axios = await import('axios');
        const baseURL =
          process.env.SAP_CORE_AI_URL || 'https://api.ai.core.sap';

        response = await axios.default.post(
          `${baseURL}/v1/chat/completions`,
          requestBody,
          {
            headers: {
              'Content-Type': 'application/json',
            },
          },
        );
      }

      const responseData = this.toResponseData(response.data);
      const choice = responseData.choices?.[0];

      if (!choice) {
        throw new Error('No response from SAP Core AI');
      }

      if (this.log) {
        this.log.debug?.('Received response from SAP Core AI', {
          finishReason: choice.finish_reason,
        });
      }

      return {
        content: choice.message?.content || '',
        finishReason: choice.finish_reason,
        raw: responseData,
      };
    } catch (error: unknown) {
      if (this.log) {
        this.log.error?.('SAP Core AI API error', {
          destination: this.destinationName,
          error: getErrorMessage(error, 'Request failed'),
          response: this.extractResponseData(error),
        });
      }

      throw new Error(
        `SAP Core AI API error: ${getNestedApiErrorMessage(error) || getErrorMessage(error, 'Request failed')}`,
      );
    }
  }

  /**
   * Format messages for SAP Core AI API
   */
  private formatMessages(
    messages: Message[],
  ): Array<{ role: Message['role']; content: string }> {
    return messages.map((msg) => ({
      role: msg.role,
      content: msg.content,
    }));
  }

  private toResponseData(data: unknown): SapCoreAIResponseData {
    if (!isRecord(data)) {
      throw new Error('Invalid response from SAP Core AI');
    }

    return data as SapCoreAIResponseData;
  }

  private extractResponseData(error: unknown): unknown {
    if (!isRecord(error)) {
      return undefined;
    }

    const response = error.response;
    if (!isRecord(response)) {
      return undefined;
    }

    return response.data;
  }
}
