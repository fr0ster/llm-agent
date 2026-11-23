/**
 * OpenAI LLM Provider
 */

import { Readable } from 'node:stream';
import { text } from 'node:stream/consumers';
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
  type LlmRequestFacts,
  type LlmRequestHandle,
  MODEL_CONTEXT_EXCEEDED,
  requestShape,
  startOperation,
} from '@mcp-abap-adt/llm-agent';
import axios, { type AxiosInstance } from 'axios';

interface OpenAIErrorResponse {
  error?: { message?: string; code?: string | null };
}

interface OpenAIModel {
  id: string;
  owned_by?: string;
}

export interface OpenAIConfig extends LLMProviderConfig {
  /**
   * Asked for fresh on every request — never cached — so a rotating key
   * rotates and a resolved-once secret is never frozen for the object's
   * lifetime. `LLMProviderConfig` carries no credential field any more (each
   * provider is typed for what its own target speaks), so this one is
   * required here: this provider cannot authenticate without it.
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
  maxTokens?: number;
  organization?: string;
  project?: string;
}

export class OpenAIProvider extends BaseLLMProvider<OpenAIConfig> {
  readonly client: AxiosInstance;
  readonly model: string;
  protected readonly providerName: string = 'OpenAI';

  /**
   * Every direct instantiation authenticates. Ollama overrides this to
   * `false` — its target ignores the key locally, though a gateway in front
   * of it may still require one — without duplicating this constructor.
   *
   * Called from the constructor below, before it returns — so an override
   * MUST be a constant (as both existing overrides are) and must never read
   * instance state: `this` is not fully constructed yet at that point, and a
   * field read here could see it half-initialized.
   *
   * `OllamaConfig`/`DeepSeekConfig` reach this constructor through an
   * `as OpenAIConfig` cast (see their own files), which is what lets a
   * possibly-`undefined` `credential` satisfy a field typed here as
   * required. This hook, not the type, is what actually keeps a subclass
   * honest about whether that's allowed.
   */
  protected requiresCredential(): boolean {
    return true;
  }

  constructor(config: OpenAIConfig) {
    super(config);

    if (this.requiresCredential() && !config.credential) {
      throw new Error("OpenAI provider requires a 'credential'");
    }
    if (!config.model) {
      throw new Error("OpenAI provider requires a 'model'");
    }
    this.model = config.model;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    // Add organization header if provided
    if (config.organization) {
      headers['OpenAI-Organization'] = config.organization;
    }

    // Add project header if provided
    if (config.project) {
      headers['OpenAI-Project'] = config.project;
    }

    this.client = axios.create({
      baseURL: config.baseURL || 'https://api.openai.com/v1',
      headers,
    });
  }

  /**
   * `Authorization`, resolved fresh for this one request — never baked into
   * `client.defaults.headers`, which would freeze whatever secret the
   * credential returned at construction time.
   *
   * BEHAVIOUR CHANGE for Ollama: it used to send `Authorization: Bearer
   * <key or the literal 'ollama'>` on every request unconditionally — a
   * dummy value existed only because the OpenAI SDK this class no longer
   * goes through demanded a non-empty key. Now, with no credential
   * configured, no header is sent at all. That is a real change for exactly
   * the case the credential stayed optional for: an Ollama instance sitting
   * behind a gateway that DOES check auth silently stops being authorized
   * (`requiresCredential() === false`, so nothing throws either). Correct,
   * because the SDK's constraint that produced the dummy is gone — but it
   * is not "the same as before", so it is not described that way here.
   */
  private async authHeader(apiKey?: string): Promise<Record<string, string>> {
    if (apiKey !== undefined) return { Authorization: `Bearer ${apiKey}` };
    const credential = this.config.credential;
    if (!credential) return {};
    return { Authorization: `Bearer ${await credential.secret()}` };
  }

  /** Quota isolation (base class): this provider's account is its credential. */
  protected override quotaCredential(): object | undefined {
    return this.config.credential;
  }

  /**
   * OpenAI meters per organization and per project, and an account reaching a
   * different `baseURL` (Azure, a gateway, a local vLLM) is a different quota
   * again. The base scope covers the endpoint and the credential; these two
   * split one credential's traffic the way OpenAI bills it.
   */
  protected override quotaScope(): string {
    return [
      super.quotaScope(),
      this.config.organization ?? '',
      this.config.project ?? '',
    ].join('|');
  }

  /**
   * The axios client already holds the resolved endpoint, default filled in —
   * and it is the one every request goes to. Subclasses that only change the
   * default (DeepSeek, Ollama) are covered by reading it here.
   */
  protected override quotaEndpoint(): string {
    return this.client.defaults.baseURL ?? 'default';
  }

  // Provider caching is automatic; promptCaching has no request effect.
  async chat(
    messages: Message[],
    tools?: unknown[],
    options?: LLMCallOptions,
  ): Promise<LLMResponse> {
    try {
      const model = options?.model ?? this.model;
      const providerName = this.providerName;
      // Unset knobs are not sent: the model applies its own default. A
      // forced one breaks models that accept only theirs (gpt-5 and o-series
      // reject any temperature but 1).
      const temperature = options?.temperature ?? this.config.temperature;
      const maxTokens = options?.maxTokens ?? this.config.maxTokens;

      const sent = this.formatMessages(messages);
      let headers: Record<string, string>;
      let shape: ReturnType<typeof requestShape> | undefined;
      const response = await this.withThrottleRetry(
        async (handle) => {
          const response = await this.client.post(
            '/chat/completions',
            {
              model,
              messages: sent,
              tools: tools && tools.length > 0 ? tools : undefined,
              tool_choice: tools && tools.length > 0 ? 'auto' : undefined,
              ...(temperature !== undefined ? { temperature } : {}),
              ...(maxTokens !== undefined
                ? this.getTokenLimitParam(model, maxTokens)
                : {}),
              ...(options?.topP !== undefined ? { top_p: options.topP } : {}),
              ...(options?.stop ? { stop: options.stop } : {}),
            },
            { signal: options?.signal, headers },
          );
          const choice = response.data.choices[0];

          const usage = response.data.usage
            ? {
                ...cacheUsage(response.data.usage),
                promptTokens: response.data.usage.prompt_tokens,
                completionTokens: response.data.usage.completion_tokens,
                totalTokens: response.data.usage.total_tokens,
              }
            : undefined;

          const result = {
            content: choice.message.content || '',
            finishReason: choice.finish_reason,
            raw: response.data,
            usage,
          };
          handle.end({
            outcome: response.data.error ? 'error' : 'ok',
            ...tokenFacts(response.data.usage),
          });
          return result;
        },
        { model, signal: options?.signal },
        {
          prepare: async () => {
            headers = await this.authHeader(options?.apiKey);
          },
          opts: options,
          apiKeyOverride: options?.apiKey,
          op: startOperation(options),
          bound: this.config.usage,
          get base(): Parameters<typeof beginLlmRequest>[2] & {
            stream: false;
          } {
            shape ??= requestShape(sent, tools);
            return {
              ...shape,
              provider: providerName,
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
      throw this.requestError(error, false, options?.apiKey !== undefined);
    }
  }

  async *streamChat(
    messages: Message[],
    tools?: unknown[],
    options?: LLMCallOptions,
  ): AsyncIterable<LLMResponse> {
    let request: LlmRequestHandle | undefined;
    let completed = false;
    let returnedError = false;
    let failure: unknown;
    let facts: Partial<LlmRequestFacts> = {};
    try {
      const model = options?.model ?? this.model;
      const providerName = this.providerName;
      // Unset knobs are not sent: the model applies its own default. A
      // forced one breaks models that accept only theirs (gpt-5 and o-series
      // reject any temperature but 1).
      const temperature = options?.temperature ?? this.config.temperature;
      const maxTokens = options?.maxTokens ?? this.config.maxTokens;

      const sent = this.formatMessages(messages);
      let headers: Record<string, string>;
      let shape: ReturnType<typeof requestShape> | undefined;
      const opened = await this.withThrottleRetry(
        async () =>
          this.client.post(
            '/chat/completions',
            {
              model,
              messages: sent,
              tools: tools && tools.length > 0 ? tools : undefined,
              tool_choice: tools && tools.length > 0 ? 'auto' : undefined,
              ...(temperature !== undefined ? { temperature } : {}),
              ...(maxTokens !== undefined
                ? this.getTokenLimitParam(model, maxTokens)
                : {}),
              ...(options?.topP !== undefined ? { top_p: options.topP } : {}),
              ...(options?.stop ? { stop: options.stop } : {}),
              stream: true,
              stream_options: { include_usage: true },
            },
            {
              responseType: 'stream',
              signal: options?.signal,
              headers,
            },
          ),
        { model, signal: options?.signal },
        {
          prepare: async () => {
            headers = await this.authHeader(options?.apiKey);
          },
          opts: options,
          apiKeyOverride: options?.apiKey,
          op: startOperation(options),
          bound: this.config.usage,
          get base(): Parameters<typeof beginLlmRequest>[2] & { stream: true } {
            shape ??= requestShape(sent, tools);
            return {
              ...shape,
              provider: providerName,
              model,
              stream: true,
              granularity: 'request',
              retriesVisible: true,
            };
          },
        },
      );
      request = opened.handle;
      const response = opened.response;

      const stream = response.data;
      let buffer = '';

      for await (const chunk of stream) {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed?.startsWith('data: ')) continue;

          const data = trimmed.slice(6);
          if (data === '[DONE]') break;

          try {
            const parsed = JSON.parse(data);
            if (parsed.error) {
              returnedError = true;
              const error: OpenAIErrorResponse['error'] = parsed.error;
              if (error?.code === 'context_length_exceeded') {
                throw new LlmError(
                  options?.apiKey === undefined
                    ? (error.message ?? error.code)
                    : error.code,
                  MODEL_CONTEXT_EXCEEDED,
                );
              }
            }
            if (parsed.usage) facts = { ...facts, ...tokenFacts(parsed.usage) };
            const choice = parsed.choices?.[0];
            if (choice?.delta) {
              const deltaToolCalls = choice.delta.tool_calls as
                | Array<{
                    index: number;
                    id?: string;
                    function?: { name?: string; arguments?: string };
                  }>
                | undefined;
              const toolCalls = deltaToolCalls?.length
                ? deltaToolCalls.map((tc) => ({
                    index: tc.index,
                    id: tc.id,
                    name: tc.function?.name,
                    arguments: tc.function?.arguments,
                  }))
                : undefined;
              if (choice.delta.content || toolCalls?.length)
                request.firstToken();
              yield {
                content: choice.delta.content || '',
                finishReason: choice.finish_reason,
                raw: parsed,
                ...(toolCalls ? { toolCalls } : {}),
              };
            }
            // Usage chunk. OpenAI emits it as a separate chunk with empty
            // `choices`, but DeepSeek (and some other OpenAI-compatible APIs)
            // attaches `usage` to the FINAL delta chunk that ALSO carries
            // `finish_reason:"stop"` (with empty `delta.content`). Cover both
            // by yielding a usage chunk whenever `parsed.usage` is present —
            // independent of whether the same payload also produced a delta
            // yield above.
            if (parsed.usage) {
              yield {
                content: '',
                raw: parsed,
                usage: {
                  ...cacheUsage(parsed.usage),
                  promptTokens: parsed.usage.prompt_tokens,
                  completionTokens: parsed.usage.completion_tokens,
                  totalTokens: parsed.usage.total_tokens,
                },
              };
            }
          } catch (error) {
            if (
              error instanceof LlmError &&
              error.code === MODEL_CONTEXT_EXCEEDED
            )
              throw error;
            // Ignore parse errors for incomplete chunks
          }
        }
      }
      completed = true;
    } catch (error) {
      failure = error;
      const response = axios.isAxiosError<Readable>(error)
        ? error.response
        : undefined;
      // Axios leaves a rejected streaming request's JSON body as a readable.
      const streamedBody =
        response?.status === 400 && response.data instanceof Readable
          ? await text(response.data)
              .then((payload): OpenAIErrorResponse => JSON.parse(payload))
              .catch(() => undefined)
          : undefined;
      throw this.requestError(
        error,
        true,
        options?.apiKey !== undefined,
        streamedBody,
      );
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
        error: options?.apiKey === undefined ? failure : undefined,
        ...(!completed && !failure ? { closedEarly: true } : {}),
      });
    }
  }

  private requestError<T>(
    error: T,
    streaming: boolean,
    redact: boolean,
    streamedBody?: OpenAIErrorResponse,
  ): Error {
    const operation = streaming ? (redact ? 'streaming' : 'Streaming') : 'API';
    const prefix = `${this.providerName} ${operation} error`;
    const transport = axios.isAxiosError<OpenAIErrorResponse | Readable>(error)
      ? error
      : undefined;
    const body = transport?.response?.data;
    const providerError =
      body instanceof Readable ? streamedBody?.error : body?.error;
    const overflow =
      (transport?.response?.status === 400 &&
        providerError?.code === 'context_length_exceeded') ||
      (error instanceof LlmError && error.code === MODEL_CONTEXT_EXCEEDED);
    const providerMessage =
      body instanceof Readable && !overflow
        ? undefined
        : providerError?.message;
    let message = prefix;
    if (!redact) {
      const detail =
        transport?.message ??
        (error instanceof Error ? error.message : String(error));
      message = `${prefix}: ${providerMessage || detail}`;
    }
    if (overflow) {
      return Object.assign(new LlmError(message, MODEL_CONTEXT_EXCEEDED), {
        status: 400,
      });
    }
    return redact
      ? this.credentialSafeError(error, prefix)
      : this.preserveThrottled(error, new Error(message));
  }

  private async fetchModels(options?: LLMCallOptions) {
    try {
      return await this.client.get<{ data: OpenAIModel[] }>('/models', {
        headers: await this.authHeader(options?.apiKey),
        signal: options?.signal,
      });
    } catch (error) {
      if (options?.apiKey !== undefined) {
        throw this.credentialSafeError(
          error,
          `${this.providerName} model discovery failed`,
        );
      }
      throw error;
    }
  }

  async getModels(options?: LLMCallOptions): Promise<IModelInfo[]> {
    const response = await this.fetchModels(options);
    return response.data.data.map(({ id, owned_by }) => ({ id, owned_by }));
  }

  async getEmbeddingModels(options?: LLMCallOptions): Promise<IModelInfo[]> {
    const response = await this.fetchModels(options);
    return response.data.data
      .filter((m) => /embed/i.test(m.id))
      .map((m) => ({ id: m.id, owned_by: m.owned_by }));
  }

  /**
   * Return the appropriate token limit parameter for the model.
   * Newer models (o1, o3, gpt-5+) require max_completion_tokens;
   * legacy models use max_tokens.
   */
  protected getTokenLimitParam(
    model: string,
    maxTokens: number,
  ): Record<string, number> {
    const normalized = model.toLowerCase();
    const needsCompletionTokens = /^(o[13]|gpt-5)/.test(normalized);
    return needsCompletionTokens
      ? { max_completion_tokens: maxTokens }
      : { max_tokens: maxTokens };
  }

  /**
   * Format messages for OpenAI API with strict protocol enforcement.
   */
  protected formatMessages(messages: Message[]): OpenAIWireMessage[] {
    const formatted: OpenAIWireMessage[] = [];

    for (const msg of messages) {
      if (msg.role === 'tool' && !msg.tool_call_id) {
        continue;
      }

      const entry: OpenAIWireMessage = {
        role: msg.role,
        content: msg.content ?? '',
      };

      if (
        msg.role === 'assistant' &&
        msg.tool_calls &&
        msg.tool_calls.length > 0
      ) {
        entry.tool_calls = msg.tool_calls;
        entry.content = msg.content || null;
      }

      if (msg.role === 'tool') {
        entry.tool_call_id = msg.tool_call_id;
        entry.content =
          typeof msg.content === 'string'
            ? msg.content
            : JSON.stringify(msg.content ?? '');
      }

      formatted.push(entry);
    }

    return formatted;
  }
}

function cacheUsage(usage: {
  prompt_tokens_details?: {
    cached_tokens?: number;
    cache_write_tokens?: number;
  };
  prompt_cache_hit_tokens?: number;
}) {
  const cached =
    usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens;
  const created = usage.prompt_tokens_details?.cache_write_tokens;
  return {
    ...(cached !== undefined ? { cachedInputTokens: cached } : {}),
    ...(created !== undefined ? { cacheCreationInputTokens: created } : {}),
  };
}

function tokenFacts(usage?: {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
    cache_write_tokens?: number;
  };
  prompt_cache_hit_tokens?: number;
}): Partial<LlmRequestFacts> {
  return usage &&
    (usage.prompt_tokens !== undefined ||
      usage.completion_tokens !== undefined ||
      usage.prompt_tokens_details?.cached_tokens !== undefined ||
      usage.prompt_cache_hit_tokens !== undefined ||
      usage.prompt_tokens_details?.cache_write_tokens !== undefined)
    ? {
        ...(usage.prompt_tokens !== undefined
          ? { inputTokens: usage.prompt_tokens }
          : {}),
        ...(usage.completion_tokens !== undefined
          ? { outputTokens: usage.completion_tokens }
          : {}),
        ...cacheUsage(usage),
        tokensSource: 'provider',
      }
    : {};
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  return (
    ('name' in error && error.name === 'AbortError') ||
    ('code' in error && error.code === 'ERR_CANCELED')
  );
}

/** One message as the OpenAI chat completions payload carries it. */
export interface OpenAIWireMessage {
  role: Message['role'];
  content: string | null;
  tool_calls?: Message['tool_calls'];
  tool_call_id?: string;
}
