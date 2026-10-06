/**
 * OpenAI LLM Provider
 */

import type { IApiKeyCredential } from '@mcp-abap-adt/interfaces-auth';
import type {
  IModelInfo,
  LLMCallOptions,
  LLMProviderConfig,
  LLMResponse,
  Message,
} from '@mcp-abap-adt/llm-agent';
import { BaseLLMProvider, LlmError } from '@mcp-abap-adt/llm-agent';
import axios, { type AxiosInstance } from 'axios';

/**
 * One SSE `data:` payload. Lines are split on `\n` before this is called, so a
 * payload that is not JSON is a whole malformed line — never a partial chunk.
 * Dropping it would end the stream "successfully", truncated (spec §10.5.6
 * L6), so it is an `LLM_ERROR` naming the line's first 200 characters.
 */
function parseStreamData(data: string, line: string) {
  try {
    return JSON.parse(data);
  } catch {
    throw new LlmError(
      `malformed stream line (not JSON): ${line.slice(0, 200)}`,
      'LLM_ERROR',
    );
  }
}

/**
 * The lines of an SSE body, split on `\n` across reads. The final line is
 * yielded even without a trailing `\n`, so a truncated tail reaches the
 * parser (an error) and a complete one is delivered — never dropped.
 */
async function* sseLines(
  stream: AsyncIterable<Buffer | string>,
): AsyncGenerator<string> {
  let buffer = '';
  for await (const chunk of stream) {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    yield* lines;
  }
  if (buffer) yield buffer;
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
  private async authHeader(): Promise<Record<string, string>> {
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

  async chat(
    messages: Message[],
    tools?: unknown[],
    options?: LLMCallOptions,
  ): Promise<LLMResponse> {
    try {
      const model = options?.model ?? this.model;
      // Unset knobs are not sent: the model applies its own default. A
      // forced one breaks models that accept only theirs (gpt-5 and o-series
      // reject any temperature but 1).
      const temperature = options?.temperature ?? this.config.temperature;
      const maxTokens = options?.maxTokens ?? this.config.maxTokens;

      const response = await this.withThrottleRetry(
        async () =>
          this.client.post(
            '/chat/completions',
            {
              model,
              messages: this.formatMessages(messages),
              tools: tools && tools.length > 0 ? tools : undefined,
              tool_choice: tools && tools.length > 0 ? 'auto' : undefined,
              ...(temperature !== undefined ? { temperature } : {}),
              ...(maxTokens !== undefined
                ? this.getTokenLimitParam(model, maxTokens)
                : {}),
              ...(options?.topP !== undefined ? { top_p: options.topP } : {}),
              ...(options?.stop ? { stop: options.stop } : {}),
            },
            { signal: options?.signal, headers: await this.authHeader() },
          ),
        { model, signal: options?.signal },
      );

      const choice = response.data.choices[0];

      const usage = response.data.usage
        ? {
            promptTokens: response.data.usage.prompt_tokens,
            completionTokens: response.data.usage.completion_tokens,
            totalTokens: response.data.usage.total_tokens,
          }
        : undefined;

      return {
        content: choice.message.content || '',
        finishReason: choice.finish_reason,
        raw: response.data,
        usage,
      };
    } catch (error: unknown) {
      const message = axios.isAxiosError(error)
        ? (error.response?.data as { error?: { message?: string } })?.error
            ?.message || error.message
        : error instanceof Error
          ? error.message
          : String(error);
      throw this.preserveThrottled(
        error,
        new Error(`${this.providerName} API error: ${message}`),
      );
    }
  }

  async *streamChat(
    messages: Message[],
    tools?: unknown[],
    options?: LLMCallOptions,
  ): AsyncIterable<LLMResponse> {
    try {
      const model = options?.model ?? this.model;
      // Unset knobs are not sent: the model applies its own default. A
      // forced one breaks models that accept only theirs (gpt-5 and o-series
      // reject any temperature but 1).
      const temperature = options?.temperature ?? this.config.temperature;
      const maxTokens = options?.maxTokens ?? this.config.maxTokens;

      const response = await this.withThrottleRetry(
        async () =>
          this.client.post(
            '/chat/completions',
            {
              model,
              messages: this.formatMessages(messages),
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
              headers: await this.authHeader(),
            },
          ),
        { model, signal: options?.signal },
      );

      for await (const line of sseLines(response.data)) {
        const trimmed = line.trim();
        if (!trimmed?.startsWith('data: ')) continue;

        const data = trimmed.slice(6);
        if (data === '[DONE]') break; // ends the stream

        const parsed = parseStreamData(data, trimmed);
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
              promptTokens: parsed.usage.prompt_tokens,
              completionTokens: parsed.usage.completion_tokens,
              totalTokens: parsed.usage.total_tokens,
            },
          };
        }
      }
    } catch (error: unknown) {
      const message = axios.isAxiosError(error)
        ? (error.response?.data as { error?: { message?: string } })?.error
            ?.message || error.message
        : error instanceof Error
          ? error.message
          : String(error);
      throw this.preserveThrottled(
        error,
        new Error(`${this.providerName} Streaming error: ${message}`),
      );
    }
  }

  async getModels(): Promise<IModelInfo[]> {
    const response = await this.client.get('/models', {
      headers: await this.authHeader(),
    });
    return (response.data.data as Array<{ id: string; owned_by?: string }>).map(
      (m) => ({ id: m.id, owned_by: m.owned_by }),
    );
  }

  async getEmbeddingModels(): Promise<IModelInfo[]> {
    const response = await this.client.get('/models', {
      headers: await this.authHeader(),
    });
    return (response.data.data as Array<{ id: string; owned_by?: string }>)
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
  protected formatMessages(
    messages: Message[],
  ): Array<Record<string, unknown>> {
    const formatted: Array<Record<string, unknown>> = [];

    for (const msg of messages) {
      if (msg.role === 'tool' && !msg.tool_call_id) {
        continue;
      }

      const entry: Record<string, unknown> = {
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
