/**
 * SAP AI SDK LLM Provider
 *
 * Implementation of LLMProvider interface using @sap-ai-sdk/orchestration.
 * Authentication is handled automatically via AICORE_SERVICE_KEY environment variable.
 *
 * Architecture:
 * - Agent → SapCoreAIProvider → OrchestrationClient → SAP AI Core → External LLM
 */

import {
  type ChatMessage,
  OrchestrationClient,
} from '@sap-ai-sdk/orchestration';
import type { LLMProviderConfig, LLMResponse, Message } from '../types.js';
import { BaseLLMProvider } from './base.js';

export interface SapCoreAIConfig extends LLMProviderConfig {
  /** Model name (e.g. 'gpt-4o', 'claude-3-5-sonnet'). Default: 'gpt-4o' */
  model?: string;
  /** Temperature for generation. Default: 0.7 */
  temperature?: number;
  /** Max tokens for generation. Default: 2000 */
  maxTokens?: number;
  /** SAP AI Core resource group */
  resourceGroup?: string;
  /** Optional logger */
  log?: {
    debug(message: string, meta?: Record<string, unknown>): void;
    error(message: string, meta?: Record<string, unknown>): void;
  };
}

/**
 * SAP AI SDK Provider implementation
 *
 * Uses @sap-ai-sdk/orchestration for authentication and LLM access.
 * A new OrchestrationClient is created per call because tools may change between calls.
 */
export class SapCoreAIProvider extends BaseLLMProvider<SapCoreAIConfig> {
  readonly model: string;
  readonly resourceGroup?: string;
  private log?: SapCoreAIConfig['log'];

  constructor(config: SapCoreAIConfig) {
    super(config);
    // Skip validateConfig() — SAP SDK handles auth via AICORE_SERVICE_KEY env var
    this.model = config.model || 'gpt-4o';
    this.resourceGroup = config.resourceGroup;
    this.log = config.log;
  }

  async chat(messages: Message[], tools?: unknown[]): Promise<LLMResponse> {
    try {
      this.log?.debug('Sending chat request via SAP AI SDK', {
        model: this.model,
        messageCount: messages.length,
        toolCount: tools?.length || 0,
      });

      const client = this.createClient(tools);
      const response = await client.chatCompletion({
        messagesHistory: this.formatMessages(messages),
      });

      const toolCalls = response.getToolCalls();
      const content = response.getContent() || '';
      const finishReason = response.getFinishReason();

      this.log?.debug('Received response from SAP AI SDK', { finishReason });

      return {
        content,
        finishReason,
        raw: {
          choices: [
            {
              message: {
                role: 'assistant',
                content,
                ...(toolCalls ? { tool_calls: toolCalls } : {}),
              },
              finish_reason: finishReason,
            },
          ],
          usage: response.getTokenUsage(),
        },
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.log?.error('SAP AI SDK API error', { error: message });
      throw new Error(`SAP AI SDK API error: ${message}`);
    }
  }

  async *streamChat(
    messages: Message[],
    tools?: unknown[],
  ): AsyncIterable<LLMResponse> {
    try {
      const client = this.createClient(tools);
      const streamResponse = await client.stream({
        messagesHistory: this.formatMessages(messages),
      });

      for await (const chunk of streamResponse.stream) {
        yield {
          content: chunk.getDeltaContent() || '',
          finishReason: chunk.getFinishReason(),
          raw: chunk,
        };
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.log?.error('SAP AI SDK streaming error', { error: message });
      throw new Error(`SAP AI SDK streaming error: ${message}`);
    }
  }

  /**
   * Create an OrchestrationClient with the given tools configuration.
   */
  private createClient(tools?: unknown[]): OrchestrationClient {
    const orchTools = tools?.length
      ? this.convertToOrchestrationTools(tools)
      : undefined;

    // biome-ignore lint/suspicious/noExplicitAny: SDK model type is a string literal union but the API accepts any model name
    const orchConfig: any = {
      promptTemplating: {
        model: {
          name: this.model,
          params: {
            max_tokens: this.config.maxTokens || 2000,
            temperature: this.config.temperature || 0.7,
          },
        },
        ...(orchTools ? { prompt: { tools: orchTools } } : {}),
      },
    };

    return new OrchestrationClient(
      orchConfig,
      this.resourceGroup ? { resourceGroup: this.resourceGroup } : undefined,
    );
  }

  /**
   * Convert MCP tools to OpenAI function calling format expected by the SDK.
   */
  private convertToOrchestrationTools(
    tools: unknown[],
  ): Array<Record<string, unknown>> {
    return tools.map((rawTool) => {
      const tool = rawTool as {
        name?: string;
        description?: string;
        inputSchema?: Record<string, unknown>;
      };
      return {
        type: 'function',
        function: {
          name: tool.name ?? '',
          description: tool.description || '',
          parameters: tool.inputSchema || {
            type: 'object',
            properties: {},
          },
        },
      };
    });
  }

  /**
   * Format messages for the SAP AI SDK (OpenAI-compatible format).
   */
  private formatMessages(messages: Message[]): ChatMessage[] {
    return messages.map((msg): ChatMessage => {
      if (
        msg.role === 'assistant' &&
        msg.tool_calls &&
        msg.tool_calls.length > 0
      ) {
        return {
          role: 'assistant' as const,
          content: msg.content || undefined,
          tool_calls: msg.tool_calls,
        };
      }

      if (msg.role === 'tool' && msg.tool_call_id) {
        return {
          role: 'tool' as const,
          content:
            typeof msg.content === 'string'
              ? msg.content
              : JSON.stringify(msg.content ?? ''),
          tool_call_id: msg.tool_call_id,
        };
      }

      return {
        role: msg.role as 'user' | 'system',
        content: msg.content ?? '',
      };
    });
  }
}
