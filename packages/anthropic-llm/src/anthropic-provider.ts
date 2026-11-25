/**
 * Anthropic (Claude) LLM Provider
 */

import { createHmac, randomBytes } from 'node:crypto';
import { addAbortListener } from 'node:events';
import type { IApiKeyCredential } from '@mcp-abap-adt/interfaces-auth';
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
  LlmError,
  MODEL_CONTEXT_EXCEEDED,
  requestShape,
  startOperation,
} from '@mcp-abap-adt/llm-agent';
import axios, { type AxiosInstance } from 'axios';
import {
  type AnthropicChatResponse,
  type AnthropicErrorResponse,
  type AnthropicStreamEvent,
  AnthropicStreamMapper,
  chatResponse,
  contextOverflow,
  formatMessages,
  isContextOverflow,
  isContextOverflowBody,
  requestBody,
  shapeMessages,
  tokenFacts,
  type WireMessage,
} from './messages-wire.js';

export interface AnthropicConfig extends LLMProviderConfig {
  /**
   * Asked for fresh on every request — never cached — so a rotating key
   * rotates and a resolved-once secret is never frozen for the object's
   * lifetime. Required: this provider cannot authenticate without one.
   *
   * Quota scoping (`quotaCredential`) keys on this object's IDENTITY, not its
   * secret: two calls to `staticApiKey(key)` create two credential objects
   * and therefore two separate rate-limit buckets, even for the same key.
   * Reuse one credential object — or set `quotaScope` explicitly — to make
   * two providers share a gate.
   */
  credential: IApiKeyCredential;
  model?: string;
  temperature?: number;
  /** Automatic prompt caching: enabled by default; false omits the directive. */
  promptCaching?: LLMCallOptions['promptCaching'];
  maxTokens?: number;
}

interface ModelResponse {
  id: string;
  owned_by?: string;
  max_tokens?: number;
}

interface ModelsListResponse {
  data: ModelResponse[];
  has_more: boolean;
  first_id: string | null;
  last_id: string | null;
}

interface ModelAuth {
  headers: Record<string, string>;
  fingerprint: string;
}

const fingerprintKey = randomBytes(32);

function isModelOutputLimit(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0;
}

export class AnthropicProvider extends BaseLLMProvider<AnthropicConfig> {
  readonly client: AxiosInstance;
  readonly model: string;
  private readonly modelMaxTokens = new Map<string, number>();
  private readonly modelLookups = new Map<
    string,
    { limit: Promise<number>; controller: AbortController; callers: number }
  >();

  constructor(config: AnthropicConfig) {
    super(config);

    if (!config.credential) {
      throw new Error("Anthropic provider requires a 'credential'");
    }
    if (!config.model) {
      throw new Error("Anthropic provider requires a 'model'");
    }
    this.model = config.model;

    this.client = axios.create({
      baseURL: config.baseURL || 'https://api.anthropic.com/v1',
      headers: {
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
    });
  }

  /** The resolved endpoint, default filled in — see `quotaEndpoint`. */
  protected override quotaEndpoint(): string {
    return this.client.defaults.baseURL ?? 'default';
  }

  /** Quota isolation (base class): this provider's account is its credential. */
  protected override quotaCredential(): object | undefined {
    return this.config.credential;
  }

  /**
   * `x-api-key`, resolved fresh for this one request — never baked into
   * `client.defaults.headers`, which would freeze whatever secret the
   * credential returned at construction time.
   */
  private async modelAuth(apiKey?: string): Promise<ModelAuth> {
    const secret = apiKey ?? (await this.config.credential.secret());
    const fingerprint = createHmac('sha256', fingerprintKey)
      .update(secret)
      .digest('hex');
    return { headers: { 'x-api-key': secret }, fingerprint };
  }

  private async getModelMetadata<T>(
    path: string,
    auth: ModelAuth,
    options: {
      model?: string;
      signal?: AbortSignal;
      params?: { limit: number; after_id?: string };
    },
  ): Promise<T> {
    const { model, signal, params } = options;
    try {
      const { data } = await this.withThrottleRetry(
        () =>
          this.client.get<T>(path, { headers: auth.headers, signal, params }),
        { model, signal, credentialFingerprint: auth.fingerprint },
      );
      signal?.throwIfAborted();
      return data;
    } catch (error) {
      signal?.throwIfAborted();
      throw this.credentialSafeError(error, 'Anthropic model discovery failed');
    }
  }

  private async fetchModelMaxTokens(
    model: string,
    signal: AbortSignal,
    auth: ModelAuth,
  ): Promise<number> {
    const data = await this.getModelMetadata<ModelResponse>(
      `/models/${encodeURIComponent(model)}`,
      auth,
      { model, signal },
    );
    signal.throwIfAborted();
    if (!isModelOutputLimit(data.max_tokens)) {
      throw new Error(
        `Anthropic model "${model}" did not report max_tokens; set maxTokens explicitly`,
      );
    }
    this.modelMaxTokens.set(`${auth.fingerprint}:${model}`, data.max_tokens);
    this.modelMaxTokens.set(`${auth.fingerprint}:${data.id}`, data.max_tokens);
    return data.max_tokens;
  }

  private async resolveModelRequest(
    model: string,
    options?: LLMCallOptions,
  ): Promise<{ maxTokens: number; auth: ModelAuth }> {
    const { signal, apiKey } = options ?? {};
    signal?.throwIfAborted();
    const auth = await this.modelAuth(apiKey);
    signal?.throwIfAborted();
    const configured = options?.maxTokens ?? this.config.maxTokens;
    if (configured !== undefined) return { maxTokens: configured, auth };
    const key = `${auth.fingerprint}:${model}`;
    const cached = this.modelMaxTokens.get(key);
    if (cached !== undefined) return { maxTokens: cached, auth };

    let lookup = this.modelLookups.get(key);
    if (!lookup) {
      const controller = new AbortController();
      lookup = {
        controller,
        limit: this.fetchModelMaxTokens(model, controller.signal, auth),
        callers: 0,
      };
      this.modelLookups.set(key, lookup);
    }
    lookup.callers++;
    let abortListener: ReturnType<typeof addAbortListener> | undefined;
    try {
      const limit = signal
        ? Promise.race([
            lookup.limit,
            new Promise<never>((_, reject) => {
              abortListener = addAbortListener(signal, () =>
                reject(signal.reason),
              );
            }),
          ])
        : lookup.limit;
      return { maxTokens: await limit, auth };
    } finally {
      abortListener?.[Symbol.dispose]();
      if (--lookup.callers === 0) {
        this.modelLookups.delete(key);
        lookup.controller.abort();
      }
    }
  }

  async chat(
    messages: Message[],
    tools?: unknown[],
    options?: LLMCallOptions,
  ): Promise<LLMResponse> {
    try {
      const model = options?.model ?? this.model;
      const { maxTokens, auth } = await this.resolveModelRequest(
        model,
        options,
      );
      const body = {
        model,
        ...this.formatRequest(messages, tools, maxTokens, options),
      };

      let shape: ReturnType<typeof requestShape> | undefined;
      const response = await this.withThrottleRetry(
        async (handle) => {
          const response = await this.client.post<AnthropicChatResponse>(
            '/messages',
            body,
            {
              signal: options?.signal,
              headers: auth.headers,
            },
          );
          const result = chatResponse(response.data);
          handle.end({
            outcome: response.data.error ? 'error' : 'ok',
            errorCode: response.data.error?.type,
            ...tokenFacts(response.data.usage),
          });
          return result;
        },
        {
          model,
          signal: options?.signal,
          credentialFingerprint: auth.fingerprint,
        },
        {
          opts: options,
          apiKeyOverride: options?.apiKey,
          op: startOperation(options),
          bound: this.config.usage,
          get base(): Parameters<typeof beginLlmRequest>[2] & {
            stream: false;
          } {
            shape ??= requestShape(
              shapeMessages(body.messages, body.system),
              body.tools,
            );
            return {
              ...shape,
              provider: 'anthropic',
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
      const transport = axios.isAxiosError<AnthropicErrorResponse>(error)
        ? error
        : undefined;
      const providerError = transport?.response?.data?.error;
      const overflow =
        transport?.response?.status === 400 && isContextOverflow(providerError);
      if (!overflow) options?.signal?.throwIfAborted();
      if (options?.apiKey !== undefined) {
        if (overflow) throw contextOverflow('Anthropic API error');
        throw this.credentialSafeError(error, 'Anthropic API error');
      }
      const message = transport
        ? `HTTP ${transport.response?.status ?? 'unavailable'} ${providerError?.type ?? transport.code ?? 'error'}: ${providerError?.message ?? transport.message}`
        : error instanceof Error
          ? error.message
          : String(error);
      if (overflow) throw contextOverflow(`Anthropic API error: ${message}`);
      throw this.preserveThrottled(
        error,
        new Error(`Anthropic API error: ${message}`),
      );
    }
  }

  async *streamChat(
    messages: Message[],
    tools?: unknown[],
    options?: LLMCallOptions,
  ): AsyncIterable<LLMResponse> {
    const model = options?.model ?? this.model;
    const { maxTokens, auth } = await this.resolveModelRequest(model, options);
    const body = {
      model,
      ...this.formatRequest(messages, tools, maxTokens, options),
      stream: true,
    };

    const baseURL = this.config.baseURL || 'https://api.anthropic.com/v1';
    type OpenStream = Response & { body: ReadableStream<Uint8Array> };
    let shape: ReturnType<typeof requestShape> | undefined;
    const { response, handle } = await this.withThrottleRetry<OpenStream>(
      async () => {
        const res = await fetch(`${baseURL}/messages`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...auth.headers,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify(body),
          signal: options?.signal,
        });

        if (!res.ok || !res.body) {
          const text =
            options?.apiKey === undefined || res.status === 400
              ? await res.text().catch(() => '')
              : '';
          const message = `Anthropic streaming error: HTTP ${res.status} — ${text}`;
          if (res.status === 400 && isContextOverflowBody(text)) {
            throw contextOverflow(
              options?.apiKey === undefined
                ? message
                : 'Anthropic streaming error',
            );
          }
          // This is the one path on fetch rather than axios. The shared policy
          // reads the status and Retry-After off the axios shape, so give it one;
          // Headers already answers to the same case-insensitive get().
          throw Object.assign(
            new Error(
              options?.apiKey === undefined
                ? message
                : `Anthropic streaming error: HTTP ${res.status} — `,
            ),
            {
              status: res.status,
              response: { status: res.status, headers: res.headers },
            },
          );
        }
        return res as OpenStream;
      },
      {
        model,
        signal: options?.signal,
        credentialFingerprint: auth.fingerprint,
      },
      {
        opts: options,
        apiKeyOverride: options?.apiKey,
        op: startOperation(options),
        bound: this.config.usage,
        get base(): Parameters<typeof beginLlmRequest>[2] & { stream: true } {
          shape ??= requestShape(
            shapeMessages(body.messages, body.system),
            body.tools,
          );
          return {
            ...shape,
            provider: 'anthropic',
            model,
            stream: true,
            granularity: 'request',
            retriesVisible: true,
          };
        },
      },
    ).catch((error: Error) => {
      if (
        options?.apiKey !== undefined &&
        !(error instanceof LlmError && error.code === MODEL_CONTEXT_EXCEEDED)
      ) {
        throw this.credentialSafeError(error, 'Anthropic streaming error');
      }
      throw error;
    });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let eventType = '';
    let completed = false;
    let streamError: Error | string | undefined;
    const mapper = new AnthropicStreamMapper();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          completed = true;
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) {
            eventType = '';
            continue;
          }
          if (trimmed.startsWith('event: ')) {
            eventType = trimmed.slice(7);
            continue;
          }
          if (!trimmed.startsWith('data: ')) continue;

          const data = trimmed.slice(6);
          try {
            const parsed: AnthropicStreamEvent = JSON.parse(data);
            if (eventType === 'error') {
              const error: AnthropicErrorResponse['error'] = parsed.error;
              const message = `Anthropic stream error: ${error?.type ?? 'error'}: ${error?.message ?? 'unspecified'}`;
              if (isContextOverflow(error)) {
                throw contextOverflow(
                  options?.apiKey === undefined
                    ? message
                    : 'Anthropic streaming error',
                );
              }
              throw Object.assign(new Error(message), { code: error?.type });
            }
            if (
              parsed.delta?.text ||
              parsed.content_block?.type === 'tool_use' ||
              parsed.delta?.partial_json
            )
              handle.firstToken();
            const mapped = mapper.map(parsed, eventType);
            if (mapped) yield mapped;
          } catch (e) {
            if (
              (e instanceof LlmError && e.code === MODEL_CONTEXT_EXCEEDED) ||
              (e instanceof Error &&
                e.message.startsWith('Anthropic stream error:'))
            ) {
              throw e;
            }
            /* incomplete JSON — skip */
          }
        }
      }
    } catch (error) {
      streamError = error instanceof Error ? error : String(error);
      if (
        options?.apiKey !== undefined &&
        !(error instanceof LlmError && error.code === MODEL_CONTEXT_EXCEEDED)
      ) {
        throw this.credentialSafeError(error, 'Anthropic streaming error');
      }
      throw error;
    } finally {
      handle.end({
        outcome: streamError
          ? options?.signal?.aborted ||
            (streamError instanceof Error && streamError.name === 'AbortError')
            ? 'aborted'
            : 'error'
          : completed
            ? 'ok'
            : 'aborted',
        error: options?.apiKey === undefined ? streamError : undefined,
        closedEarly: !completed && !streamError,
        ...mapper.tokenFacts(),
      });
      reader.releaseLock();
    }
  }

  async getModels(options?: LLMCallOptions): Promise<IModelInfo[]> {
    const models: IModelInfo[] = [];
    let afterId: string | null = null;
    while (true) {
      options?.signal?.throwIfAborted();
      const auth = await this.modelAuth(options?.apiKey);
      const page: ModelsListResponse =
        await this.getModelMetadata<ModelsListResponse>('/models', auth, {
          signal: options?.signal,
          params: { limit: 1000, ...(afterId ? { after_id: afterId } : {}) },
        });
      for (const { id, owned_by, max_tokens: maxOutputTokens } of page.data) {
        if (isModelOutputLimit(maxOutputTokens)) {
          this.modelMaxTokens.set(`${auth.fingerprint}:${id}`, maxOutputTokens);
          models.push({ id, owned_by, maxOutputTokens });
        } else {
          models.push({ id, owned_by });
        }
      }
      if (!page.has_more) return models;
      if (!page.last_id)
        throw new Error('Anthropic models list: has_more without last_id');
      afterId = page.last_id;
    }
  }

  async getEmbeddingModels(): Promise<IModelInfo[]> {
    return [];
  }

  /**
   * Format messages for Anthropic API
   */
  private formatMessages(messages: Message[]): WireMessage[] {
    return formatMessages(messages, this.toolCallIdMapper.bind(this));
  }

  private formatRequest(
    messages: Message[],
    tools: Parameters<AnthropicProvider['chat']>[1],
    maxTokens: number,
    options?: LLMCallOptions,
  ) {
    const system = messages.filter((message) => message.role === 'system');
    return requestBody(
      this.formatMessages(
        messages.filter((message) => message.role !== 'system'),
      ),
      system.length
        ? system.map((message) => message.content).join('\n\n')
        : undefined,
      tools,
      {
        ...options,
        maxTokens,
        temperature: options?.temperature ?? this.config.temperature,
        promptCaching: options?.promptCaching ?? this.config.promptCaching,
      },
      'anthropic',
    );
  }
}

export type { WireMessage } from './messages-wire.js';
