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
import {
  chatResponse,
  formatMessages,
  isContextOverflow,
  type OpenAIChatEvent,
  type OpenAIChatResponse,
  type OpenAIErrorResponse,
  OpenAIStreamMapper,
  type OpenAIWireMessage,
  requestBody,
  streamParams,
  tokenFacts,
  tokenLimitParam,
} from './chat-wire.js';

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
          const response = await this.client.post<OpenAIChatResponse>(
            '/chat/completions',
            requestBody(
              model,
              sent,
              tools,
              { ...options, temperature, maxTokens },
              this.getTokenLimitParam.bind(this),
            ),
            { signal: options?.signal, headers },
          );
          const result = chatResponse(response.data);
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
              ...requestBody(
                model,
                sent,
                tools,
                { ...options, temperature, maxTokens },
                this.getTokenLimitParam.bind(this),
              ),
              ...streamParams(),
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
      const mapper = new OpenAIStreamMapper();

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
            const parsed: OpenAIChatEvent = JSON.parse(data);
            if (parsed.error) {
              returnedError = true;
              const error: OpenAIErrorResponse['error'] = parsed.error;
              if (error && isContextOverflow(error)) {
                throw new LlmError(
                  options?.apiKey === undefined
                    ? (error.message ?? 'context_length_exceeded')
                    : 'context_length_exceeded',
                  MODEL_CONTEXT_EXCEEDED,
                );
              }
            }
            if (parsed.usage) facts = { ...facts, ...tokenFacts(parsed.usage) };
            for (const mapped of mapper.map(parsed)) {
              if (mapped.content || mapped.toolCalls?.length)
                request.firstToken();
              yield mapped;
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
        isContextOverflow(providerError)) ||
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
   * o-series and GPT-5+ models require max_completion_tokens;
   * legacy models use max_tokens.
   */
  protected getTokenLimitParam(
    model: string,
    maxTokens: number,
  ): Record<string, number> {
    return tokenLimitParam(model, maxTokens);
  }

  protected formatMessages(messages: Message[]): OpenAIWireMessage[] {
    return formatMessages(messages);
  }
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  return (
    ('name' in error && error.name === 'AbortError') ||
    ('code' in error && error.code === 'ERR_CANCELED')
  );
}

export type { OpenAIWireMessage } from './chat-wire.js';
