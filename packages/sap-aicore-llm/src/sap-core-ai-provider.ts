/**
 * SAP AI SDK LLM Provider
 *
 * Implementation of LLMProvider interface using @sap-ai-sdk/orchestration.
 * Authentication is an `IBearerCredential` resolved fresh for every call —
 * see `buildDestination`. No environment variable is read here; a caller that
 * has only a service key turns it into `{ credential, apiBaseUrl }` with
 * `serviceKeyCredential` from `@mcp-abap-adt/sap-aicore-auth`.
 *
 * Architecture:
 * - Agent → SapCoreAIProvider → OrchestrationClient → SAP AI Core → External LLM
 */

import https from 'node:https';
import type { IBearerCredential } from '@mcp-abap-adt/interfaces-auth';
import type {
  IModelInfo,
  LLMCallOptions,
  LLMProviderConfig,
  LLMResponse,
  Message,
} from '@mcp-abap-adt/llm-agent';
import { BaseLLMProvider, LlmError } from '@mcp-abap-adt/llm-agent';
import {
  type ChatMessage,
  OrchestrationClient,
} from '@sap-ai-sdk/orchestration';

/** The constructed-destination shape the SAP AI SDK documents. */
export interface SapCoreAIDestination {
  url: string;
  authentication: 'NoAuthentication';
  headers: Record<string, string>;
}

/** The fields of an AI Core model-catalog entry the provider reads. */
export interface SapCoreAICatalogModel {
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
}

export interface SapCoreAIConfig extends LLMProviderConfig {
  /**
   * The bearer credential presented to SAP AI Core. Asked for fresh on every
   * call via `buildDestination` — never cached here, so a rotating token
   * (client-credentials exchange, Entra ID, ...) keeps rotating.
   */
  credential: IBearerCredential;
  /**
   * SAP AI Core orchestration/REST base URL. Not part of the credential
   * (§4.6.3) — the address is its own field, the name `parseServiceKey`
   * returns and `sap-aicore-embedder` already used.
   */
  apiBaseUrl: string;
  /** Model name (e.g. 'gpt-4o', 'claude-3-5-sonnet'). Required — the constructor throws if absent (no default). */
  model?: string;
  /** Temperature for generation. Unset: not sent, the model default applies. */
  temperature?: number;
  /** Max tokens for generation. Unset: not sent, the model default applies. */
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
 * Build the constructed-destination the SDK documents —
 * `{ url, authentication: 'NoAuthentication', headers: { Authorization } }`.
 * Not `authTokens`: its TypeScript type is `{ type; value; expiresIn?; error:
 * string | null }` with no `http_header` field, so the shape some blog posts
 * show does not compile.
 *
 * Called from inside the per-call / per-retry-attempt path (never at
 * construction, never cached), which is free: the client is already rebuilt
 * on every call because tools change between them, and a retry must re-ask
 * the credential rather than resend a token that may already be the reason
 * the previous attempt failed.
 */
export async function buildDestination(cfg: {
  apiBaseUrl: string;
  credential: IBearerCredential;
}): Promise<SapCoreAIDestination> {
  return {
    url: cfg.apiBaseUrl,
    authentication: 'NoAuthentication',
    headers: { Authorization: `Bearer ${await cfg.credential.token()}` },
  };
}

/**
 * The orchestration `model.params`. Unset knobs are not sent: the model
 * applies its own default. A forced one breaks models that accept only theirs
 * (gpt-5, o-series and claude-opus-4-7+ reject any temperature but 1).
 */
export function orchestrationModelParams(
  cfg: { maxTokens?: number; temperature?: number },
  hasTools: boolean,
): Record<string, unknown> {
  return {
    ...(cfg.maxTokens !== undefined ? { max_tokens: cfg.maxTokens } : {}),
    ...(cfg.temperature !== undefined ? { temperature: cfg.temperature } : {}),
    ...(hasTools ? { tool_choice: 'auto' } : {}),
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
    // `credential` and `apiBaseUrl` are required fields on SapCoreAIConfig, so
    // an absent one is a compile error, not a runtime check. The credential itself is resolved per call (see buildDestination),
    // never here, so a rotating token keeps rotating.
    if (!config.model) {
      throw new Error("SAP AI Core provider requires a 'model'");
    }
    this.model = config.model;
    this.resourceGroup = config.resourceGroup;
    this.log = config.log;
  }

  async chat(
    messages: Message[],
    tools?: unknown[],
    options?: LLMCallOptions,
  ): Promise<LLMResponse> {
    try {
      this.log?.debug('Sending chat request via SAP AI SDK', {
        model: this.modelOverride ?? this.model,
        messageCount: messages.length,
        toolCount: tools?.length || 0,
        maxTokens: this.config.maxTokens,
        temperature: this.config.temperature,
      });

      const formatted = this.formatMessages(messages);
      // Each non-streaming call gets its own agent to prevent connection
      // multiplexing. A shared keepAlive agent can cause SAP AI Core to route a
      // response to the wrong in-flight request when concurrent requests share
      // the same XSUAA user (mirrors streamChat's per-stream agent below).
      const response = await this.withThrottleRetry(
        async () => {
          // No timeout of ours. Sixty seconds used to sit here, and it was a
          // guess about somebody else's model, prompt and tool loop — a large
          // input legitimately outruns it, and the call then died for a reason
          // that had nothing to do with the server. The deadline belongs to
          // the caller and arrives as `options.signal`.
          //
          // The destination — and with it the credential's token() — is asked
          // fresh on every attempt, inside this closure: a retry re-asks
          // rather than resending a token that may be why the previous
          // attempt failed.
          const destination = await buildDestination({
            apiBaseUrl: this.config.apiBaseUrl,
            credential: this.config.credential,
          });
          const client = this.createClient(formatted, tools, destination);
          const callAgent = new https.Agent({ keepAlive: false });
          return client.chatCompletion(undefined, {
            httpsAgent: callAgent,
            signal: options?.signal,
          });
        },
        { signal: options?.signal },
      );

      const toolCalls = response.getToolCalls();
      const content = response.getContent() || '';
      const finishReason = response.getFinishReason();

      this.log?.debug('Received response from SAP AI SDK', { finishReason });

      const rawUsage = response.getTokenUsage() as
        | {
            prompt_tokens?: number;
            completion_tokens?: number;
            total_tokens?: number;
          }
        | undefined;
      const usage = rawUsage
        ? {
            promptTokens: rawUsage.prompt_tokens ?? 0,
            completionTokens: rawUsage.completion_tokens ?? 0,
            totalTokens:
              rawUsage.total_tokens ??
              (rawUsage.prompt_tokens ?? 0) + (rawUsage.completion_tokens ?? 0),
          }
        : undefined;

      return {
        content,
        finishReason,
        ...(usage ? { usage } : {}),
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
          usage: rawUsage,
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
      throw this.preserveThrottled(
        error,
        new Error(`SAP AI SDK API error: ${detail}`),
      );
    } finally {
      this.modelOverride = undefined;
    }
  }

  async *streamChat(
    messages: Message[],
    tools?: unknown[],
    options?: LLMCallOptions,
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
      // Each stream gets its own agent to prevent connection multiplexing.
      // A shared keepAlive agent can cause SAP AI Core to route SSE chunks
      // to the wrong stream when multiple requests share the same XSUAA user.
      this.log?.debug('SAP AI SDK streamChat opening stream', {
        model,
        keepAlive: false,
      });
      const streamResponse = await this.withThrottleRetry(
        async () => {
          // As above: the caller's signal is the deadline, and the SDK takes
          // it directly. The destination (and the credential's token()) is
          // rebuilt on every attempt, same as chat().
          const destination = await buildDestination({
            apiBaseUrl: this.config.apiBaseUrl,
            credential: this.config.credential,
          });
          const client = this.createClient(formatted, tools, destination);
          this.log?.debug('SAP AI SDK streamChat client created', {
            model,
            toolCount,
          });
          const streamAgent = new https.Agent({ keepAlive: false });
          // The SDK takes the signal as its own second parameter, so an abort
          // ends the stream itself and not only the waiting around it.
          return client.stream(undefined, options?.signal, undefined, {
            httpsAgent: streamAgent,
          });
        },
        { signal: options?.signal },
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
        // SAP AI SDK exposes tool-call deltas via getDeltaToolCalls(); without
        // forwarding them the agent sees finishReason='tool_calls' but no calls
        // to dispatch (regression introduced in the 10.x provider split).
        const sdkToolCalls = chunk.getDeltaToolCalls?.() as
          | Array<{
              index: number;
              id?: string;
              function?: { name?: string; arguments?: string };
            }>
          | undefined;
        const toolCalls = sdkToolCalls?.length
          ? sdkToolCalls.map((tc) => ({
              index: tc.index,
              id: tc.id,
              name: tc.function?.name,
              arguments: tc.function?.arguments,
            }))
          : undefined;
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
          ...(toolCalls ? { toolCalls } : {}),
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
      throw this.preserveThrottled(
        error,
        new Error(`SAP AI SDK streaming error: ${detail}`),
      );
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
      // The configured credential, not the SDK's implicit AICORE_SERVICE_KEY
      // lookup — without it a deployment on `<REF>_SERVICE_KEY` alone could
      // not reach the catalog.
      const destination = await buildDestination({
        apiBaseUrl: this.config.apiBaseUrl,
        credential: this.config.credential,
      });
      const models: IModelInfo[] = [];
      for (const r of await this.queryModelCatalog(destination)) {
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
    } catch (e) {
      // An unreachable catalog is an error, never the configured model as if
      // the catalog had listed it (spec §10.5.6 L5). Nothing is cached, so the
      // next call asks the catalog again.
      throw new LlmError(
        `model catalog unavailable: ${String(e)}`,
        'LLM_ERROR',
      );
    }
  }

  /**
   * One call to the AI Core `foundation-models` model catalog. A seam so a
   * test can supply the catalog without the network.
   */
  protected async queryModelCatalog(
    destination: SapCoreAIDestination,
  ): Promise<SapCoreAICatalogModel[]> {
    const { ScenarioApi } = await import('@sap-ai-sdk/ai-api');
    const result = await ScenarioApi.scenarioQueryModels('foundation-models', {
      'AI-Resource-Group': this.resourceGroup ?? 'default',
    }).execute(destination);
    return result.resources as SapCoreAICatalogModel[];
  }

  async getModels(): Promise<IModelInfo[]> {
    return this._fetchAllModels();
  }

  async getEmbeddingModels(): Promise<IModelInfo[]> {
    const all = await this._fetchAllModels();
    return all.filter((m) => m.capabilities?.includes('embedding'));
  }

  /**
   * Extract detailed error information from SAP AI SDK / axios errors.
   */
  /**
   * AI Core meters per model, and resource groups are isolated from one another
   * — two groups on the same model do not share a limit, so both belong here.
   */
  protected override quotaKey(model?: string): string {
    return `sap-ai-core:${this.quotaScope()}:${
      this.resourceGroup ?? 'default'
    }:${model ?? this.modelOverride ?? this.model}`;
  }

  /**
   * The quota belongs to a service instance, not to the process. Two
   * instances in one process — a tenant each, say — must not share a pause.
   * The base class's default `quotaScope()` already combines `quotaEndpoint()`
   * (below) with the credential object's own identity (`quotaCredential()`),
   * so no override is needed here — only the two hooks it reads.
   */

  /** Two instances at different SAP AI Core base URLs never share a quota. */
  protected override quotaEndpoint(): string {
    return this.config.apiBaseUrl;
  }

  /**
   * The credential this provider authenticates with. Identity-based (see
   * `BaseLLMProvider.credentialScope`) — two providers wrapping the same
   * service key in two separate credential objects are, correctly, two
   * buckets; a consumer that means them to share sets `quotaScope` explicitly.
   */
  protected override quotaCredential(): object | undefined {
    return this.config.credential;
  }

  static extractErrorDetail(error: unknown): string {
    if (error !== null && typeof error === 'object') {
      // biome-ignore lint/suspicious/noExplicitAny: axios error shape is untyped
      const axiosError = error as any;
      // The SAP AI SDK wraps the axios error: the body AI Core sent (with the
      // reason, e.g. "gpt-5 models don't support temperature=0.7") is on
      // `cause`, and the wrapper's own message is only the status line.
      const data =
        axiosError.response?.data ?? axiosError.cause?.response?.data;
      if (data) {
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
   *
   * `destination` is built by the caller via `buildDestination()`, per call —
   * so the client and the token behind it are both fresh every time.
   */
  private createClient(
    messages: ChatMessage[],
    tools: unknown[] | undefined,
    destination: SapCoreAIDestination,
  ): OrchestrationClient {
    // biome-ignore lint/suspicious/noExplicitAny: SDK model type is a string literal union but the API accepts any model name
    const orchConfig: any = {
      promptTemplating: {
        model: {
          name: this.modelOverride ?? this.model,
          params: orchestrationModelParams(this.config, !!tools?.length),
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
      destination,
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
