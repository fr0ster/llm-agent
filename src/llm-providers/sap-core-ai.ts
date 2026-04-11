/**
 * SAP AI SDK LLM Provider
 *
 * Implementation of LLMProvider interface using @sap-ai-sdk/orchestration.
 * Authentication is handled automatically via AICORE_SERVICE_KEY environment variable.
 *
 * Architecture:
 * - Agent → SapCoreAIProvider → OrchestrationClient → SAP AI Core → External LLM
 */

import https from 'node:https';
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
  private readonly httpsAgent: https.Agent;
  private modelsCache: IModelInfo[] | null = null;
  private modelsCacheExpiry = 0;
  private static readonly MODELS_CACHE_TTL_MS = 300_000; // 5 min
  private modelOverride?: string;

  private static summarizeMessages(
    messages: Message[],
  ): Record<string, unknown> {
    const totalChars = messages.reduce((sum, msg) => {
      const content =
        typeof msg.content === 'string'
          ? msg.content
          : JSON.stringify(msg.content ?? '');
      return sum + content.length;
    }, 0);

    return {
      totalChars,
      roles: messages.map((msg, index) => ({
        index,
        role: msg.role,
        contentLength:
          typeof msg.content === 'string'
            ? msg.content.length
            : JSON.stringify(msg.content ?? '').length,
        hasToolCalls: 'tool_calls' in msg && Array.isArray(msg.tool_calls),
        toolCallCount:
          'tool_calls' in msg && Array.isArray(msg.tool_calls)
            ? msg.tool_calls.length
            : 0,
        toolCallId: 'tool_call_id' in msg ? (msg.tool_call_id ?? null) : null,
      })),
      tail: messages.slice(-4).map((msg, index) => {
        const content =
          typeof msg.content === 'string'
            ? msg.content
            : JSON.stringify(msg.content ?? '');
        return {
          index: messages.length - Math.min(messages.length, 4) + index,
          role: msg.role,
          preview:
            content.length > 240
              ? `${content.slice(0, 240)}...[truncated]`
              : content,
          hasToolCalls: 'tool_calls' in msg && Array.isArray(msg.tool_calls),
          toolCallNames:
            'tool_calls' in msg && Array.isArray(msg.tool_calls)
              ? msg.tool_calls.map((tc) => tc.function?.name || '')
              : [],
          toolCallId: 'tool_call_id' in msg ? (msg.tool_call_id ?? null) : null,
        };
      }),
    };
  }

  private static summarizeStreamingError(
    error: unknown,
  ): Record<string, unknown> {
    // biome-ignore lint/suspicious/noExplicitAny: diagnostic error shape from SDK/axios
    const err = error as any;
    const cause = err?.cause;
    return {
      error: SapCoreAIProvider.extractErrorDetail(error),
      name: err?.name,
      message: err?.message,
      cause: cause?.message || cause,
      causeCode: cause?.code,
      status: err?.response?.status,
      responseData:
        typeof err?.response?.data === 'string'
          ? err.response.data
          : err?.response?.data
            ? JSON.stringify(err.response.data)
            : undefined,
    };
  }

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

    this.httpsAgent = new https.Agent({
      keepAlive: true,
      timeout: 60_000,
    });

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
        model: this.modelOverride ?? this.model,
        messageCount: messages.length,
        toolCount: tools?.length || 0,
        maxTokens: this.config.maxTokens,
        temperature: this.config.temperature,
      });

      const formatted = this.formatMessages(messages);
      const client = this.createClient(formatted, tools);
      const response = await client.chatCompletion(undefined, {
        httpsAgent: this.httpsAgent,
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
      const detail = SapCoreAIProvider.extractErrorDetail(error);
      this.log?.error('SAP AI SDK API error', { error: detail });
      // biome-ignore lint/suspicious/noExplicitAny: diagnostic error details
      const axiosErr = error as any;
      if (axiosErr?.response?.data) {
        this.log?.error('SAP AI SDK response body', {
          status: axiosErr.response.status,
          data:
            typeof axiosErr.response.data === 'string'
              ? axiosErr.response.data
              : JSON.stringify(axiosErr.response.data),
        });
      }
      throw new Error(`SAP AI SDK API error: ${detail}`);
    } finally {
      this.modelOverride = undefined;
    }
  }

  async *streamChat(
    messages: Message[],
    tools?: unknown[],
  ): AsyncIterable<LLMResponse> {
    const model = this.modelOverride ?? this.model;
    const messageSummary = SapCoreAIProvider.summarizeMessages(messages);
    const toolCount = tools?.length || 0;
    let streamOpened = false;
    let chunkIndex = 0;
    let emittedContentChunks = 0;
    let emittedContentChars = 0;

    try {
      this.log?.debug('SAP AI SDK streamChat start', {
        model,
        resourceGroup: this.resourceGroup ?? 'default',
        messageCount: messages.length,
        toolCount,
        maxTokens: this.config.maxTokens,
        temperature: this.config.temperature,
        messageSummary,
      });

      const formatted = this.formatMessages(messages);
      this.log?.debug('SAP AI SDK streamChat messages formatted', {
        model,
        formattedMessageCount: formatted.length,
        messageSummary,
      });
      const client = this.createClient(formatted, tools);
      this.log?.debug('SAP AI SDK streamChat client created', {
        model,
        toolCount,
      });
      // Each stream gets its own agent to prevent connection multiplexing.
      // A shared keepAlive agent can cause SAP AI Core to route SSE chunks
      // to the wrong stream when multiple requests share the same XSUAA user.
      const streamAgent = new https.Agent({
        keepAlive: false,
        timeout: 120_000,
      });
      this.log?.debug('SAP AI SDK streamChat opening stream', {
        model,
        keepAlive: false,
        timeoutMs: 120_000,
      });
      const streamResponse = await client.stream(
        undefined,
        undefined,
        undefined,
        { httpsAgent: streamAgent },
      );
      streamOpened = true;
      this.log?.debug('SAP AI SDK streamChat stream opened', {
        model,
        messageCount: messages.length,
        toolCount,
      });

      for await (const chunk of streamResponse.stream) {
        chunkIndex += 1;
        // TokenUsage is only available in the final chunk (final_result.usage)
        const tokenUsage = chunk.getTokenUsage() as
          | {
              prompt_tokens: number;
              completion_tokens: number;
              total_tokens: number;
            }
          | undefined;
        const deltaContent = chunk.getDeltaContent() || '';
        if (deltaContent) {
          emittedContentChunks += 1;
          emittedContentChars += deltaContent.length;
        }
        const finishReason = chunk.getFinishReason();
        this.log?.debug('SAP AI SDK streamChat chunk received', {
          model,
          chunkIndex,
          hasContent: deltaContent.length > 0,
          contentLength: deltaContent.length,
          emittedContentChunks,
          emittedContentChars,
          finishReason,
          usage: tokenUsage
            ? {
                promptTokens: tokenUsage.prompt_tokens || 0,
                completionTokens: tokenUsage.completion_tokens || 0,
                totalTokens: tokenUsage.total_tokens || 0,
              }
            : undefined,
        });
        yield {
          content: deltaContent,
          finishReason,
          raw: chunk,
          ...(tokenUsage
            ? {
                usage: {
                  promptTokens: tokenUsage.prompt_tokens || 0,
                  completionTokens: tokenUsage.completion_tokens || 0,
                  totalTokens: tokenUsage.total_tokens || 0,
                },
              }
            : {}),
        };
      }
      this.log?.debug('SAP AI SDK streamChat completed', {
        model,
        chunkCount: chunkIndex,
        emittedContentChunks,
        emittedContentChars,
      });
    } catch (error: unknown) {
      this.log?.error('SAP AI SDK streaming error', {
        model,
        resourceGroup: this.resourceGroup ?? 'default',
        streamOpened,
        chunkIndex,
        emittedContentChunks,
        emittedContentChars,
        toolCount,
        messageSummary,
        ...SapCoreAIProvider.summarizeStreamingError(error),
      });
      const detail = SapCoreAIProvider.extractErrorDetail(error);
      throw new Error(`SAP AI SDK streaming error: ${detail}`);
    } finally {
      this.modelOverride = undefined;
    }
  }

  /**
   * Fetch all models from SAP AI Core, caching the result for MODELS_CACHE_TTL_MS.
   * Returns ALL models regardless of capability — callers filter as needed.
   */
  private async _fetchAllModels(): Promise<IModelInfo[]> {
    if (this.modelsCache && Date.now() < this.modelsCacheExpiry) {
      return this.modelsCache;
    }
    try {
      const { ScenarioApi } = await import('@sap-ai-sdk/ai-api');
      const result = await ScenarioApi.scenarioQueryModels(
        'foundation-models',
        { 'AI-Resource-Group': this.resourceGroup ?? 'default' },
      ).execute();

      type AiModel = {
        model: string;
        displayName?: string;
        provider?: string;
        versions?: {
          isLatest?: boolean;
          deprecated?: boolean;
          capabilities?: string[];
          contextLength?: number;
          streamingSupported?: boolean;
        }[];
      };

      const models: IModelInfo[] = [];
      for (const r of result.resources as AiModel[]) {
        const latest = r.versions?.find((v) => v.isLatest) ?? r.versions?.[0];
        if (!latest) continue;
        models.push({
          id: r.model,
          displayName: r.displayName,
          owned_by: r.provider,
          provider: r.provider,
          capabilities: latest.capabilities,
          contextLength: latest.contextLength,
          streamingSupported: latest.streamingSupported,
          deprecated: latest.deprecated,
        });
      }

      this.modelsCache = models;
      this.modelsCacheExpiry =
        Date.now() + SapCoreAIProvider.MODELS_CACHE_TTL_MS;
      return models;
    } catch {
      // Fallback to configured model if AI API is not available
      return [{ id: this.model }];
    }
  }

  async getModels(): Promise<IModelInfo[]> {
    return this._fetchAllModels();
  }

  async getEmbeddingModels(): Promise<IModelInfo[]> {
    const all = await this._fetchAllModels();
    return all.filter((m) => m.capabilities?.includes('embeddings'));
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
