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
import type { IModelInfo } from '../smart-agent/interfaces/model-provider.js';
import type { LLMProviderConfig, LLMResponse, Message } from '../types.js';
import { BaseLLMProvider } from './base.js';

/**
 * OAuth2 Client Credentials for programmatic SAP AI Core authentication.
 * When provided, bypasses the AICORE_SERVICE_KEY environment variable.
 */
export interface SapAICoreCredentials {
  /** OAuth2 client ID (e.g. 'sb-xxx...') */
  clientId: string;
  /** OAuth2 client secret */
  clientSecret: string;
  /** Token endpoint URL (e.g. 'https://xxx.authentication.xxx.hana.ondemand.com/oauth/token') */
  tokenServiceUrl: string;
  /** SAP AI Core API base URL (e.g. 'https://api.ai.xxx.aicore.cfapps.xxx.hana.ondemand.com') */
  servicUrl: string;
}

export interface SapCoreAIConfig extends LLMProviderConfig {
  /** Model name (e.g. 'gpt-4o', 'claude-3-5-sonnet'). Default: 'gpt-4o' */
  model?: string;
  /** Temperature for generation. Default: 0.7 */
  temperature?: number;
  /** Max tokens for generation. Default: 16384 */
  maxTokens?: number;
  /** SAP AI Core resource group */
  resourceGroup?: string;
  /**
   * Programmatic OAuth2 credentials for SAP AI Core.
   * When set, the SDK uses these instead of the AICORE_SERVICE_KEY env var.
   */
  credentials?: SapAICoreCredentials;
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
  private readonly destination?: Record<string, unknown>;
  private modelsCache: IModelInfo[] | null = null;
  private modelsCacheExpiry = 0;
  private static readonly MODELS_CACHE_TTL_MS = 60_000;
  private modelOverride?: string;

  /** Set a per-request model override. Cleared after each chat/streamChat call. */
  setModelOverride(model?: string): void {
    this.modelOverride = model;
  }

  constructor(config: SapCoreAIConfig) {
    super(config);
    // Skip validateConfig() — SAP SDK handles auth via AICORE_SERVICE_KEY env var
    this.model = config.model || 'gpt-4o';
    this.resourceGroup = config.resourceGroup;
    this.log = config.log;

    if (config.credentials) {
      this.destination = {
        url: config.credentials.servicUrl,
        authentication: 'OAuth2ClientCredentials',
        clientId: config.credentials.clientId,
        clientSecret: config.credentials.clientSecret,
        tokenServiceUrl: config.credentials.tokenServiceUrl,
      };
    }
  }

  async chat(messages: Message[], tools?: unknown[]): Promise<LLMResponse> {
    try {
      this.log?.debug('Sending chat request via SAP AI SDK', {
        model: this.model,
        messageCount: messages.length,
        toolCount: tools?.length || 0,
      });

      const formatted = this.formatMessages(messages);
      const client = this.createClient(formatted, tools);
      const response = await client.chatCompletion();

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
      const detail = SapCoreAIProvider.extractErrorDetail(error);
      this.log?.error('SAP AI SDK API error', { error: detail });
      throw new Error(`SAP AI SDK API error: ${detail}`);
    } finally {
      this.modelOverride = undefined;
    }
  }

  async *streamChat(
    messages: Message[],
    tools?: unknown[],
  ): AsyncIterable<LLMResponse> {
    try {
      const formatted = this.formatMessages(messages);
      const client = this.createClient(formatted, tools);
      const streamResponse = await client.stream();

      for await (const chunk of streamResponse.stream) {
        yield {
          content: chunk.getDeltaContent() || '',
          finishReason: chunk.getFinishReason(),
          raw: chunk,
        };
      }
    } catch (error: unknown) {
      const detail = SapCoreAIProvider.extractErrorDetail(error);
      this.log?.error('SAP AI SDK streaming error', { error: detail });
      throw new Error(`SAP AI SDK streaming error: ${detail}`);
    } finally {
      this.modelOverride = undefined;
    }
  }

  async getModels(): Promise<IModelInfo[]> {
    if (this.modelsCache && Date.now() < this.modelsCacheExpiry) {
      return this.modelsCache;
    }
    try {
      const { ScenarioApi } = await import('@sap-ai-sdk/ai-api');
      const result = await ScenarioApi.scenarioQueryModels(
        'foundation-models',
        { 'AI-Resource-Group': this.resourceGroup ?? 'default' },
      ).execute();
      const models: IModelInfo[] = (
        result.resources as Array<{
          model: string;
          executableId?: string;
        }>
      ).map((m) => ({
        id: m.model,
        owned_by: m.executableId,
      }));
      this.modelsCache = models;
      this.modelsCacheExpiry =
        Date.now() + SapCoreAIProvider.MODELS_CACHE_TTL_MS;
      return models;
    } catch {
      // Fallback to configured model if AI API is not available
      return [{ id: this.model }];
    }
  }

  /**
   * Extract detailed error information from SAP AI SDK / axios errors.
   */
  private static extractErrorDetail(error: unknown): string {
    if (error !== null && typeof error === 'object') {
      // biome-ignore lint/suspicious/noExplicitAny: axios error shape is untyped
      const axiosError = error as any;
      if (axiosError.response?.data) {
        const data = axiosError.response.data;
        const detail =
          typeof data === 'string' ? data : JSON.stringify(data).slice(0, 500);
        return `${axiosError.message} — ${detail}`;
      }
    }
    return error instanceof Error ? error.message : String(error);
  }

  /**
   * Create an OrchestrationClient with the given tools configuration.
   * Tools are expected in OpenAI function format (already converted by the agent layer).
   */
  private createClient(
    messages: ChatMessage[],
    tools?: unknown[],
  ): OrchestrationClient {
    // biome-ignore lint/suspicious/noExplicitAny: SDK model type is a string literal union but the API accepts any model name
    const orchConfig: any = {
      promptTemplating: {
        model: {
          name: this.modelOverride ?? this.model,
          params: {
            max_tokens: this.config.maxTokens || 16384,
            temperature: this.config.temperature || 0.7,
            ...(tools?.length ? { tool_choice: 'auto' } : {}),
          },
        },
        prompt: {
          template: messages,
          ...(tools?.length ? { tools } : {}),
        },
      },
    };

    return new OrchestrationClient(
      orchConfig,
      this.resourceGroup ? { resourceGroup: this.resourceGroup } : undefined,
      this.destination,
    );
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
