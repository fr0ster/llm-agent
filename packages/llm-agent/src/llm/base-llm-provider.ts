/**
 * Base interface for LLM providers
 */

import type {
  IModelInfo,
  LLMCallOptions,
  LLMProviderConfig,
  LLMResponse,
  Message,
} from '@mcp-abap-adt/llm-agent';
import {
  preserveRateLimit,
  type RateLimitRetryOptions,
  runWithRateLimitRetry,
} from './rate-limit.js';

export interface LLMProvider {
  /**
   * Send a chat message and get response
   */
  chat(
    messages: Message[],
    tools?: unknown[],
    options?: LLMCallOptions,
  ): Promise<LLMResponse>;

  /**
   * Stream chat response
   */
  streamChat(
    messages: Message[],
    tools?: unknown[],
    options?: LLMCallOptions,
  ): AsyncIterable<LLMResponse>;

  /**
   * Get available models
   */
  getModels?(): Promise<string[] | IModelInfo[]>;

  /**
   * Get embedding models. Best-effort; may return empty array.
   */
  getEmbeddingModels?(): Promise<string[] | IModelInfo[]>;
}

export abstract class BaseLLMProvider<
  C extends LLMProviderConfig = LLMProviderConfig,
> implements LLMProvider
{
  readonly config: C;

  constructor(config: C) {
    this.config = config;
  }

  abstract chat(
    messages: Message[],
    tools?: unknown[],
    options?: LLMCallOptions,
  ): Promise<LLMResponse>;

  abstract streamChat(
    messages: Message[],
    tools?: unknown[],
    options?: LLMCallOptions,
  ): AsyncIterable<LLMResponse>;

  /**
   * Validate configuration
   */
  protected validateConfig(): void {
    if (!this.config.apiKey) {
      throw new Error('API key is required');
    }
  }

  // --- Rate limiting (issue #282) -----------------------------------------
  //
  // The policy is shared (see `rate-limit.ts`); a provider supplies only the
  // two facts the policy cannot know. The defaults below read an AxiosError,
  // which covers every provider here: anthropic and openai use axios directly,
  // sap-aicore gets one through @sap-ai-sdk, and deepseek and ollama build on
  // the openai provider. A provider on another transport overrides them.

  /** Which quota this call spends. Limits are per model, so the model is in the key. */
  protected rateLimitKey(): string {
    return `${this.constructor.name}:${String(
      (this.config as { model?: unknown }).model ?? 'default',
    )}`;
  }

  /** Is this "too many requests" rather than a real failure? */
  protected isRateLimited(error: unknown): boolean {
    return httpStatusOf(error) === 429;
  }

  /**
   * How long the server asked us to wait.
   *
   * `Retry-After` is seconds in the SAP AI Core contract and is usually seconds
   * elsewhere, but the HTTP spec also allows an HTTP-date, so both are read.
   */
  protected retryAfterSeconds(error: unknown): number | undefined {
    const raw = headerOf(error, 'retry-after');
    if (raw === undefined) return undefined;
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds;
    const when = Date.parse(String(raw));
    if (!Number.isNaN(when)) return Math.max(0, (when - Date.now()) / 1000);
    return undefined;
  }

  /**
   * Keep the 429 visible through the provider's own error wrapping.
   *
   * Providers rethrow their transport error as a readable one. Call this on the
   * way out so the consumer still reads a fact, not a substring.
   */
  protected preserveRateLimit<E extends Error>(
    original: unknown,
    wrapped: E,
  ): E {
    return preserveRateLimit(original, wrapped);
  }

  /** Wrap one provider call in the shared policy. */
  protected withRateLimitRetry<T>(
    fn: () => Promise<T>,
    extra?: {
      signal?: AbortSignal;
      onRetry?: RateLimitRetryOptions['onRetry'];
    },
  ): Promise<T> {
    return runWithRateLimitRetry(fn, {
      key: this.rateLimitKey(),
      policy: this.config.rateLimit,
      isRateLimited: (e: unknown) => this.isRateLimited(e),
      retryAfterSeconds: (e: unknown) => this.retryAfterSeconds(e),
      ...extra,
    });
  }
}

/** Status of an axios-shaped error, or undefined when it is shaped otherwise. */
function httpStatusOf(error: unknown): number | undefined {
  const e = error as {
    response?: { status?: unknown };
    status?: unknown;
    statusCode?: unknown;
  };
  // axios keeps it under response; several SDKs hoist it onto the error itself.
  for (const candidate of [e?.response?.status, e?.status, e?.statusCode]) {
    if (typeof candidate === 'number') return candidate;
  }
  return undefined;
}

/** One response header, case-insensitively, from an axios-shaped error. */
function headerOf(error: unknown, name: string): string | undefined {
  const headers = (error as { response?: { headers?: unknown } })?.response
    ?.headers;
  if (!headers || typeof headers !== 'object') return undefined;
  // AxiosHeaders exposes a get(); a plain object does not.
  const get = (headers as { get?: (n: string) => unknown }).get;
  if (typeof get === 'function') {
    const v = get.call(headers, name);
    return v === undefined || v === null ? undefined : String(v);
  }
  for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
    if (k.toLowerCase() === name)
      return v === undefined || v === null ? undefined : String(v);
  }
  return undefined;
}
