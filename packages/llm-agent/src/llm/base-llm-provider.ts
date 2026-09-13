/**
 * Base interface for LLM providers
 */

import { createHash } from 'node:crypto';
import type {
  IModelInfo,
  LLMCallOptions,
  LLMProviderConfig,
  LLMResponse,
  Message,
} from '@mcp-abap-adt/llm-agent';
import {
  preserveThrottled,
  runWithThrottleRetry,
  type ThrottleRetryOptions,
} from './throttle.js';

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

  /**
   * Which account and endpoint this call bills to.
   *
   * A quota belongs to an account at an endpoint, so two providers that differ
   * in either one do not share a limit. In a multi-tenant process a key built
   * from the class and the model alone would let one tenant's 429 pause
   * another's for a minute, on a quota that tenant never touched.
   *
   * The credential is reduced to a short digest: the key is an in-memory map
   * key and may reach a log line, so it must identify an account without being
   * the account's secret. Override to add a provider's own account fields
   * (organization, project, resource group) — never the raw secret.
   */
  protected quotaScope(): string {
    return [
      this.canonicalEndpoint(this.quotaEndpoint()),
      this.credentialFingerprint(this.config.apiKey),
    ].join('|');
  }

  /**
   * Reduce spellings of one endpoint to one key.
   *
   * Two callers that reach the same server must land on the same gate, and a
   * URL has more than one way of naming it: a trailing slash, an upper-case
   * host, a port that was already the default. Written differently they would
   * be metered as two quotas and stop coordinating — the same defect as reading
   * the configured URL instead of the resolved one, one level down.
   *
   * The query string is kept verbatim: some endpoints carry a deployment or an
   * API version there, and merging those would be worse than splitting them.
   */
  protected canonicalEndpoint(raw: string): string {
    const trimmed = raw.trim();
    if (!trimmed) return 'default';
    try {
      // `origin` already lower-cases the host and drops a default port.
      const url = new URL(trimmed);
      return `${url.origin}${url.pathname.replace(/\/+$/, '')}${url.search}`;
    } catch {
      // Not absolute (a path, a host:port). Normalise what is safe to.
      return trimmed.replace(/\/+$/, '');
    }
  }

  /**
   * The endpoint this provider actually reaches — the RESOLVED one, not the
   * configured one. A provider left to its default and a provider handed that
   * same default explicitly talk to the same server and share its limit; read
   * from the config alone they would look like two quotas and stop
   * coordinating. Override wherever a default is filled in.
   */
  protected quotaEndpoint(): string {
    return this.config.baseURL ?? 'default';
  }

  /** Available to subclasses building their own scope out of other fields. */
  protected credentialFingerprint(secret: string | undefined): string {
    return fingerprint(secret);
  }

  /**
   * Which quota this call spends. Limits are per model, so the model is in the
   * key — and it must be the model the CALL uses, not the configured default.
   * A per-request override spends a different quota: keyed by the default, one
   * model's 429 would pause another's, and two overrides would share a gate
   * neither of them belongs to.
   */
  protected quotaKey(model?: string): string {
    return `${this.constructor.name}:${this.quotaScope()}:${
      model ?? this.config.model ?? 'default'
    }`;
  }

  /** Is this "too many requests" rather than a real failure? */
  protected isThrottled(error: unknown): boolean {
    return httpStatusOf(error) === 429;
  }

  /**
   * How long the server asked us to wait, or undefined if it did not say.
   *
   * RFC 9110 allows two forms, `delay-seconds` and an HTTP-date, and they are
   * told apart by the fact that a valid date never parses as a number. SAP AI
   * Core documents seconds ("Time in seconds to wait before retrying"); the
   * date form is read because the spec permits it, not because anyone sends it.
   *
   * An empty or blank header is "did not say", not "zero". `Number('')` is 0,
   * so reading it arithmetically would have us report an interval the server
   * never named — a lie in the one place it costs most, since the absence is
   * itself the signal. Anthropic returns a 429 with no `Retry-After` when a
   * spend cap is reached, and that one does not clear by waiting at all.
   */
  protected retryAfterSeconds(error: unknown): number | undefined {
    const raw = headerOf(error, 'retry-after')?.trim();
    if (raw === undefined || raw === '') return undefined;

    // Numeric first, and once it is numeric it is never reconsidered as a date.
    // Node's fallback date parser is lenient enough to read '-5' as the year
    // 2001, which would turn a malformed header into "retry immediately".
    const seconds = Number(raw);
    if (!Number.isNaN(seconds)) {
      return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
    }

    const when = Date.parse(raw);
    if (!Number.isNaN(when)) return Math.max(0, (when - Date.now()) / 1000);
    return undefined;
  }

  /**
   * Keep the 429 visible through the provider's own error wrapping.
   *
   * Providers rethrow their transport error as a readable one. Call this on the
   * way out so the consumer still reads a fact, not a substring.
   */
  protected preserveThrottled<E extends Error>(
    original: unknown,
    wrapped: E,
  ): E {
    return preserveThrottled(original, wrapped);
  }

  /** Wrap one provider call in the shared policy. */
  protected withThrottleRetry<T>(
    fn: () => Promise<T>,
    extra?: {
      /** The model this call actually uses, when it overrides the configured one. */
      model?: string;
      signal?: AbortSignal;
      onRetry?: ThrottleRetryOptions['onRetry'];
    },
  ): Promise<T> {
    return runWithThrottleRetry(fn, {
      key: this.quotaKey(extra?.model),
      strategy: this.config.whenThrottled,
      isThrottled: (e: unknown) => this.isThrottled(e),
      retryAfterSeconds: (e: unknown) => this.retryAfterSeconds(e),
      signal: extra?.signal,
      onRetry: extra?.onRetry,
    });
  }
}

/**
 * A short, stable, non-reversible stand-in for a credential.
 *
 * Enough to tell two accounts apart in a map key; not enough to be the secret
 * if that key is ever printed. An absent credential is its own scope — several
 * providers configured without one are, as far as we can tell, the same one.
 */
function fingerprint(secret: string | undefined): string {
  if (!secret) return 'anonymous';
  return createHash('sha256').update(secret).digest('hex').slice(0, 12);
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
