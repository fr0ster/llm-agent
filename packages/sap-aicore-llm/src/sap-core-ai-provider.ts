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
import {
  BaseLLMProvider,
  type beginLlmRequest,
  httpStatusOf,
  type LlmRequestFacts,
  type LlmRequestHandle,
  requestShape,
  retryAfterSecondsOf,
  type ShapeMessage,
  startOperation,
} from '@mcp-abap-adt/llm-agent';
import {
  type ChatCompletionTool,
  type ChatMessage,
  type ChatMessageContent,
  OrchestrationClient,
  type OrchestrationModuleConfig,
  type UserChatMessageContentItem,
} from '@sap-ai-sdk/orchestration';

// Structural Cloud SDK middleware contract; forward the request/response intact.
type HttpMiddleware = (options: {
  fn: (config: object) => Promise<object>;
}) => (config: object) => Promise<object>;

/** Keep HTTP metadata when the SDK replaces an empty error body with a parse error. */
async function withHttpErrorCapture<T>(
  run: (middleware: HttpMiddleware) => Promise<T>,
): Promise<T> {
  // Only the status and Retry-After: never the body, headers or request config.
  let transport: { status: number; retryAfterSeconds?: number } | undefined;
  const middleware: HttpMiddleware = (options) => async (config) => {
    try {
      return await options.fn(config);
    } catch (error) {
      const details =
        typeof error === 'object' && error !== null ? error : undefined;
      const status = httpStatusOf(details);
      if (status !== undefined) {
        transport = { status, retryAfterSeconds: retryAfterSecondsOf(details) };
      }
      throw error;
    }
  };
  try {
    return await run(middleware);
  } catch (error) {
    if (transport) {
      throw Object.assign(
        error instanceof Error ? error : new Error(String(error)),
        transport,
      );
    }
    throw error;
  }
}

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
  allowedScenarios?: { scenarioId: string; executableId?: string }[];
  versions?: {
    isLatest?: boolean;
    deprecated?: boolean;
    capabilities?: string[];
    contextLength?: number;
    streamingSupported?: boolean;
  }[];
}

/** Catalog eligibility for orchestration chat; missing capability/scenario is excluded. */
export function isOrchestrationChatModel(info: IModelInfo): boolean {
  return (
    info.capabilities?.includes('text-generation') === true &&
    info.scenarios?.includes('orchestration') === true &&
    info.deprecated !== true
  );
}

export interface SapCoreAIConfig extends LLMProviderConfig {
  /** Enable prompt caching for Anthropic Claude models. Default: true. */
  promptCaching?: boolean;
  /** Retries before the first response chunk. Default: 1; 0 disables. */
  transientMaxRetries?: number;
  /** Delay in milliseconds unless Retry-After is present. Default: 1500. */
  transientRetryDelayMs?: number;
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
  protected override transientRetry(): { maxRetries: number; delayMs: number } {
    return {
      maxRetries: this.config.transientMaxRetries ?? 1,
      delayMs: this.config.transientRetryDelayMs ?? 1500,
    };
  }

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
    if (
      !Number.isSafeInteger(config.transientMaxRetries ?? 1) ||
      (config.transientMaxRetries ?? 1) < 0 ||
      !Number.isFinite(config.transientRetryDelayMs ?? 1500) ||
      (config.transientRetryDelayMs ?? 1500) < 0
    ) {
      throw new RangeError(
        'Transient retry count and delay must be nonnegative; count must be an integer',
      );
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
    const model = this.modelOverride ?? this.model;
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
      let client: ReturnType<SapCoreAIProvider['createClient']>;
      let shape: ReturnType<typeof requestShape> | undefined;
      const response = await this.withThrottleRetry(
        async (handle) => {
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

          const callAgent = new https.Agent({ keepAlive: false });
          const response = await withHttpErrorCapture((middleware) =>
            client.chatCompletion(undefined, {
              // The SDK forwards this middleware list to its single inference HTTP request.
              // Disable middleware retries so the provider owns every attempt.
              middleware: [middleware],
              httpsAgent: callAgent,
              signal: options?.signal,
            }),
          );
          const toolCalls = response.getToolCalls();
          const content = response.getContent() || '';
          const finishReason = response.getFinishReason();

          this.log?.debug('Received response from SAP AI SDK', {
            finishReason,
          });

          const rawUsage = response.getTokenUsage() as
            | {
                prompt_tokens?: number;
                completion_tokens?: number;
                total_tokens?: number;
                prompt_tokens_details?: {
                  cached_tokens?: number;
                  cache_creation_tokens?: number;
                };
              }
            | undefined;
          const usage = rawUsage
            ? {
                ...cacheUsage(rawUsage),
                promptTokens: rawUsage.prompt_tokens ?? 0,
                completionTokens: rawUsage.completion_tokens ?? 0,
                totalTokens:
                  rawUsage.total_tokens ??
                  (rawUsage.prompt_tokens ?? 0) +
                    (rawUsage.completion_tokens ?? 0),
              }
            : undefined;

          const result = {
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
          handle.end({
            outcome: returnedSdkError(response) ? 'error' : 'ok',
            ...tokenFacts(response.getTokenUsage()),
          });
          return result;
        },
        { signal: options?.signal },
        {
          prepare: async () => {
            const destination = await buildDestination({
              apiBaseUrl: this.config.apiBaseUrl,
              credential: this.config.credential,
            });
            client = this.createClient(formatted, tools, destination, options);
          },
          opts: options,
          op: startOperation(options),
          bound: this.config.usage,
          get base(): Parameters<typeof beginLlmRequest>[2] & {
            stream: false;
          } {
            shape ??= requestShape(formatted.map(shapeMessage), tools);
            return {
              ...shape,
              provider: 'SAP AI Core',
              model,
              stream: false,
              granularity: 'request',
              retriesVisible: true,
            };
          },
        },
      );

      return response;
    } catch (error) {
      const detail = SapCoreAIProvider.extractErrorDetail(error);
      const wrapped = this.preserveThrottled(
        error,
        new Error(`SAP AI SDK API error: ${detail}`),
      );
      this.log?.error('SAP AI SDK API error', {
        status: httpStatusOf(wrapped),
      });
      throw wrapped;
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
    let request: LlmRequestHandle | undefined;
    let completed = false;
    let returnedError = false;
    let failure: unknown;
    let facts: Partial<LlmRequestFacts> = {};
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
      let client: ReturnType<SapCoreAIProvider['createClient']>;
      let shape: ReturnType<typeof requestShape> | undefined;
      const opened = await this.withThrottleRetry(
        async () =>
          withHttpErrorCapture(async (middleware) => {
            // As above: the caller's signal is the deadline, and the SDK takes
            // it directly. The destination (and the credential's token()) is
            // rebuilt on every attempt, same as chat().

            this.log?.debug('SAP AI SDK streamChat client created', {
              model,
              toolCount,
            });
            const streamAgent = new https.Agent({ keepAlive: false });
            // The SDK takes the signal as its own second parameter, so an abort
            // ends the stream itself and not only the waiting around it.
            const response = await client.stream(
              undefined,
              options?.signal,
              undefined,
              {
                middleware: [middleware],
                httpsAgent: streamAgent,
              },
            );
            const iterator = response.stream[Symbol.asyncIterator]();
            try {
              const first = await iterator.next();
              return {
                stream: (async function* () {
                  try {
                    if (!first.done) yield first.value;
                    while (!first.done) {
                      const next = await iterator.next();
                      if (next.done) break;
                      yield next.value;
                    }
                  } finally {
                    await iterator.return?.();
                  }
                })(),
              };
            } catch (error) {
              try {
                await iterator.return?.();
              } catch {
                /* Preserve the request failure. */
              }
              throw error;
            }
          }),
        { signal: options?.signal },
        {
          prepare: async () => {
            const destination = await buildDestination({
              apiBaseUrl: this.config.apiBaseUrl,
              credential: this.config.credential,
            });
            client = this.createClient(formatted, tools, destination, options);
          },
          opts: options,
          op: startOperation(options),
          bound: this.config.usage,
          get base(): Parameters<typeof beginLlmRequest>[2] & { stream: true } {
            shape ??= requestShape(formatted.map(shapeMessage), tools);
            return {
              ...shape,
              provider: 'SAP AI Core',
              model,
              stream: true,
              granularity: 'request',
              retriesVisible: true,
            };
          },
        },
      );
      request = opened.handle;
      const streamResponse = opened.response;
      streamOpened = true;
      this.log?.debug('SAP AI SDK streamChat stream opened', {
        model,
        messageCount: messages.length,
        toolCount,
      });

      for await (const chunk of streamResponse.stream) {
        chunkIndex += 1;
        if (returnedSdkError(chunk)) returnedError = true;
        // TokenUsage is only available in the final chunk (final_result.usage)
        const tokenUsage = chunk.getTokenUsage() as
          | {
              prompt_tokens: number;
              completion_tokens: number;
              total_tokens: number;
              prompt_tokens_details?: {
                cached_tokens?: number;
                cache_creation_tokens?: number;
              };
            }
          | undefined;
        if (tokenUsage) facts = { ...facts, ...tokenFacts(tokenUsage) };
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
        if (deltaContent || toolCalls?.length) request.firstToken();
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
                ...cacheUsage(tokenUsage),
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
                  ...cacheUsage(tokenUsage),
                  promptTokens: tokenUsage.prompt_tokens || 0,
                  completionTokens: tokenUsage.completion_tokens || 0,
                  totalTokens: tokenUsage.total_tokens || 0,
                },
              }
            : {}),
        };
      }
      completed = true;
      this.log?.debug('SAP AI SDK streamChat completed', {
        model,
        chunkCount: chunkIndex,
        emittedContentChunks,
        emittedContentChars,
      });
    } catch (error) {
      failure = error;
      const detail = SapCoreAIProvider.extractErrorDetail(error);
      const wrapped = this.preserveThrottled(
        error,
        new Error(`SAP AI SDK streaming error: ${detail}`),
      );
      this.log?.error('SAP AI SDK streaming error', {
        model,
        resourceGroup: this.resourceGroup ?? 'default',
        streamOpened,
        chunkIndex,
        emittedContentChunks,
        emittedContentChars,
        toolCount,
        messageSummary,
        status: httpStatusOf(wrapped),
      });
      throw wrapped;
    } finally {
      request?.end({
        ...facts,
        outcome: failure
          ? options?.signal?.aborted || isAbortError(failure)
            ? 'aborted'
            : 'error'
          : completed
            ? returnedError
              ? 'error'
              : 'ok'
            : 'aborted',
        error: failure,
        ...(!completed && !failure ? { closedEarly: true } : {}),
      });
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
      const models = await this.getModelCatalog();
      this.modelsCache = models;
      this.modelsCacheExpiry =
        Date.now() + SapCoreAIProvider.MODELS_CACHE_TTL_MS;
      return models;
    } catch {
      // Fallback to configured model if AI API is not available
      return [{ id: this.model }];
    }
  }

  /** Fetch a fresh catalog. Failures propagate unchanged and never update the cache. */
  public async getModelCatalog(): Promise<IModelInfo[]> {
    // Resolve the configured credential rather than the SDK's implicit
    // AICORE_SERVICE_KEY lookup, including on each explicit catalog retry.
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
        scenarios: r.allowedScenarios?.map((scenario) => scenario.scenarioId),
        contextLength: latest.contextLength,
        streamingSupported: latest.streamingSupported,
        deprecated: latest.deprecated,
      });
    }

    return models;
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
    options?: LLMCallOptions,
  ): OrchestrationClient {
    const caching = options?.promptCaching ?? this.config.promptCaching ?? true;
    const anthropic = /(?:^|[/.:-])(?:anthropic|claude)(?:[/.:-]|$)/i.test(
      this.modelOverride ?? this.model,
    );
    let template = messages;
    let cachedTools = tools as ChatCompletionTool[] | undefined;
    if (anthropic) {
      const wireId = this.toolCallIdMapper(
        messages.flatMap((message) =>
          message.role === 'assistant'
            ? (message.tool_calls?.map((call) => call.id) ?? [])
            : message.role === 'tool'
              ? [message.tool_call_id]
              : [],
        ),
      );
      template = messages.map((message) =>
        message.role === 'assistant' && message.tool_calls
          ? {
              ...message,
              tool_calls: message.tool_calls.map((call) => ({
                ...call,
                id: wireId(call.id),
              })),
            }
          : message.role === 'tool'
            ? { ...message, tool_call_id: wireId(message.tool_call_id) }
            : message,
      );
      cachedTools = [...(cachedTools ?? [])];
      const names = new Set(cachedTools.map((tool) => tool.function.name));
      for (const message of messages) {
        if (message.role !== 'assistant') continue;
        for (const call of message.tool_calls ?? []) {
          if (names.has(call.function.name)) continue;
          cachedTools.push({
            type: 'function',
            function: {
              name: call.function.name,
              description:
                'Historical tool; its result is already in the conversation.',
              parameters: { type: 'object', properties: {} },
            },
          });
          names.add(call.function.name);
        }
      }
    }
    if (anthropic && caching) {
      template = template.map(withoutCacheBreakpoints);
      cachedTools = cachedTools?.map(withoutCacheControl);
      let breakpointPlaced = false;
      // Emulate automatic caching with one moving breakpoint. Cache order is
      // tools -> system -> conversation, regardless of template positions.
      for (const system of [false, true]) {
        for (let index = template.length - 1; index >= 0; index--) {
          const message = template[index];
          const isSystem =
            message.role === 'system' || message.role === 'developer';
          if (isSystem !== system) continue;
          const cached = withCacheBreakpoint(message);
          if (!cached) continue;
          template[index] = cached;
          breakpointPlaced = true;
          break;
        }
        if (breakpointPlaced) break;
      }
      if (!breakpointPlaced && cachedTools?.length) {
        cachedTools = cacheLastBlock(cachedTools);
      }
    }
    const orchConfig: OrchestrationModuleConfig = {
      promptTemplating: {
        model: {
          name: this.modelOverride ?? this.model,
          params: {
            ...orchestrationModelParams(this.config, !!tools?.length),
            ...(cachedTools?.length && !tools?.length
              ? { tool_choice: 'none' }
              : {}),
          },
        },
        prompt: {
          template,
          ...(cachedTools?.length ? { tools: cachedTools } : {}),
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
  private formatMessages(
    messages: Message[],
  ): Array<Exclude<ChatMessage, { role: 'developer' }>> {
    return messages.map((msg): Exclude<ChatMessage, { role: 'developer' }> => {
      if (
        msg.role === 'assistant' &&
        msg.tool_calls &&
        msg.tool_calls.length > 0
      ) {
        return {
          ...msg,
          role: 'assistant' as const,
          content: msg.content || undefined,
          tool_calls: msg.tool_calls,
        };
      }

      if (msg.role === 'tool' && msg.tool_call_id) {
        return {
          ...msg,
          role: 'tool' as const,
          content:
            typeof msg.content === 'string'
              ? msg.content
              : JSON.stringify(msg.content ?? ''),
          tool_call_id: msg.tool_call_id,
        };
      }

      return {
        ...msg,
        role: msg.role as 'user' | 'system',
        content: msg.content ?? '',
      };
    });
  }
}

function withoutCacheControl<T extends object>(value: T): T {
  const copy = { ...value };
  if ('cache_control' in copy) delete copy.cache_control;
  return copy;
}

function withoutCacheBreakpoints(message: ChatMessage): ChatMessage {
  const copy = withoutCacheControl(message);
  if (!Array.isArray(copy.content)) return copy;
  if (copy.role === 'user') {
    return { ...copy, content: copy.content.map(withoutCacheControl) };
  }
  return { ...copy, content: copy.content.map(withoutCacheControl) };
}

function cacheLastBlock<
  T extends ChatCompletionTool | UserChatMessageContentItem,
>(blocks: T[]): T[] | undefined {
  for (let index = blocks.length - 1; index >= 0; index--) {
    const block = blocks[index];
    // Whitespace is non-empty for both string content and text blocks.
    if (block.type === 'text' && !block.text?.length) continue;
    return blocks.map((item, position) =>
      position === index
        ? { ...item, cache_control: { type: 'ephemeral' } }
        : item,
    );
  }
  return undefined;
}

function withCacheBreakpoint(message: ChatMessage): ChatMessage | undefined {
  if (!message.content?.length) return undefined;
  if (typeof message.content === 'string') {
    const content: Exclude<ChatMessageContent, string> = [
      {
        type: 'text',
        text: message.content,
        cache_control: { type: 'ephemeral' },
      },
    ];
    // Every SDK message role accepts text blocks, including tool responses and
    // assistant messages with tool calls. Only users accept image/file blocks.
    return { ...message, content };
  }
  // Separate branches keep each role's content type narrowed.
  if (message.role === 'user') {
    const content = cacheLastBlock(message.content);
    return content ? { ...message, content } : undefined;
  }
  const content = cacheLastBlock(message.content);
  return content ? { ...message, content } : undefined;
}

function tokenFacts(usage?: {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
    cache_creation_tokens?: number;
  };
}): Partial<LlmRequestFacts> {
  return usage &&
    (usage.prompt_tokens !== undefined ||
      usage.completion_tokens !== undefined ||
      usage.prompt_tokens_details?.cached_tokens !== undefined ||
      usage.prompt_tokens_details?.cache_creation_tokens !== undefined)
    ? {
        ...(usage.prompt_tokens !== undefined
          ? { inputTokens: usage.prompt_tokens }
          : {}),
        ...(usage.completion_tokens !== undefined
          ? { outputTokens: usage.completion_tokens }
          : {}),
        ...(usage.prompt_tokens_details?.cached_tokens !== undefined
          ? { cachedInputTokens: usage.prompt_tokens_details.cached_tokens }
          : {}),
        ...(usage.prompt_tokens_details?.cache_creation_tokens !== undefined
          ? {
              cacheCreationInputTokens:
                usage.prompt_tokens_details.cache_creation_tokens,
            }
          : {}),
        tokensSource: 'provider',
      }
    : {};
}

function returnedSdkError(response: { _data?: unknown }): boolean {
  return (
    !!response._data &&
    typeof response._data === 'object' &&
    'error' in response._data &&
    !!response._data.error
  );
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  return (
    ('name' in error && error.name === 'AbortError') ||
    ('code' in error && error.code === 'ERR_CANCELED')
  );
}

function shapeMessage(
  message: Exclude<ChatMessage, { role: 'developer' }>,
): ShapeMessage {
  return {
    role: message.role,
    content: typeof message.content === 'string' ? message.content : undefined,
    ...('tool_calls' in message ? { tool_calls: message.tool_calls } : {}),
  };
}

function cacheUsage(usage: {
  prompt_tokens_details?: {
    cached_tokens?: number;
    cache_creation_tokens?: number;
  };
}): { cachedInputTokens?: number; cacheCreationInputTokens?: number } {
  const details = usage.prompt_tokens_details;
  return {
    ...(details?.cached_tokens === undefined
      ? {}
      : { cachedInputTokens: details.cached_tokens }),
    ...(details?.cache_creation_tokens === undefined
      ? {}
      : { cacheCreationInputTokens: details.cache_creation_tokens }),
  };
}
