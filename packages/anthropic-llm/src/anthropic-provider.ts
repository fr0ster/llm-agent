/**
 * Anthropic (Claude) LLM Provider
 */

import type { IApiKeyCredential } from '@mcp-abap-adt/interfaces-auth';
import type {
  IModelInfo,
  LLMCallOptions,
  LLMProviderConfig,
  LLMResponse,
  Message,
} from '@mcp-abap-adt/llm-agent';
import { BaseLLMProvider, startOperation } from '@mcp-abap-adt/llm-agent';
import axios, { type AxiosInstance } from 'axios';

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
  maxTokens?: number;
}

/** `{ temperature }` when set, nothing otherwise — the model's default applies. */
function temperatureParam(temperature: number | undefined) {
  return temperature !== undefined ? { temperature } : {};
}

export class AnthropicProvider extends BaseLLMProvider<AnthropicConfig> {
  readonly client: AxiosInstance;
  readonly model: string;

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
  private async authHeaders(): Promise<Record<string, string>> {
    return { 'x-api-key': await this.config.credential.secret() };
  }

  async chat(
    messages: Message[],
    tools?: unknown[],
    options?: LLMCallOptions,
  ): Promise<LLMResponse> {
    try {
      const systemMessage = messages.find((m) => m.role === 'system');
      const conversationMessages = messages.filter((m) => m.role !== 'system');

      const model = options?.model ?? this.model;
      const requestBody: Record<string, unknown> = {
        model,
        messages: this.formatMessages(conversationMessages),
        // The Messages API requires max_tokens, so it keeps a default;
        // temperature is sent only when set (claude-opus-4-7+ accept only 1).
        max_tokens: options?.maxTokens ?? this.config.maxTokens ?? 4096,
        ...temperatureParam(options?.temperature ?? this.config.temperature),
        ...(options?.topP !== undefined ? { top_p: options.topP } : {}),
        ...(options?.stop ? { stop_sequences: options.stop } : {}),
      };

      if (systemMessage) {
        requestBody.system = systemMessage.content;
      }

      if (tools && tools.length > 0) {
        requestBody.tools = tools;
      }

      let headers: Record<string, string>;
      const response = await this.withThrottleRetry(
        async (handle) => {
          const response = await this.client.post('/messages', requestBody, {
            signal: options?.signal,
            headers,
          });
          // Handle multi-block response (text + tool_use)
          const content = response.data.content as Array<{
            type?: string;
            text?: string;
          }>;
          let textContent = '';
          for (const block of content) {
            if (block.type === 'text') textContent += block.text;
          }

          const rawUsage = response.data.usage;
          const usage = rawUsage
            ? {
                promptTokens: rawUsage.input_tokens ?? 0,
                completionTokens: rawUsage.output_tokens ?? 0,
                totalTokens:
                  (rawUsage.input_tokens ?? 0) + (rawUsage.output_tokens ?? 0),
              }
            : undefined;

          const result = {
            content: textContent,
            finishReason: response.data.stop_reason,
            raw: response.data,
            usage,
          };
          handle.end({
            outcome: response.data.error ? 'error' : 'ok',
            errorCode: response.data.error?.type,
            tokensSource:
              rawUsage?.input_tokens !== undefined ||
              rawUsage?.output_tokens !== undefined ||
              rawUsage?.cache_read_input_tokens !== undefined
                ? 'provider'
                : 'unknown',
            inputTokens: rawUsage?.input_tokens,
            outputTokens: rawUsage?.output_tokens,
            cachedInputTokens: rawUsage?.cache_read_input_tokens,
          });
          return result;
        },
        { model, signal: options?.signal },
        {
          prepare: async () => {
            headers = await this.authHeaders();
          },
          opts: options,
          op: startOperation(options),
          bound: this.config.usage,
          base: {
            provider: 'anthropic',
            model,
            stream: false,
            granularity: 'request',
            retriesVisible: true,
          },
        },
      );

      return response;
    } catch (error: unknown) {
      const message = axios.isAxiosError(error)
        ? (error.response?.data as { error?: { message?: string } })?.error
            ?.message || error.message
        : error instanceof Error
          ? error.message
          : String(error);
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
    const systemMessage = messages.find((m) => m.role === 'system');
    const conversationMessages = messages.filter((m) => m.role !== 'system');

    const model = options?.model ?? this.model;
    const requestBody: Record<string, unknown> = {
      model,
      messages: this.formatMessages(conversationMessages),
      max_tokens: options?.maxTokens ?? this.config.maxTokens ?? 4096,
      ...temperatureParam(options?.temperature ?? this.config.temperature),
      stream: true,
      ...(options?.topP !== undefined ? { top_p: options.topP } : {}),
      ...(options?.stop ? { stop_sequences: options.stop } : {}),
    };

    if (systemMessage) {
      requestBody.system = systemMessage.content;
    }

    if (tools && tools.length > 0) {
      requestBody.tools = tools;
    }

    const baseURL = this.config.baseURL || 'https://api.anthropic.com/v1';
    type OpenStream = Response & { body: ReadableStream<Uint8Array> };
    let headers: Record<string, string>;
    const { response, handle } = await this.withThrottleRetry<OpenStream>(
      async () => {
        const res = await fetch(`${baseURL}/messages`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...headers,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify(requestBody),
          signal: options?.signal,
        });

        if (!res.ok || !res.body) {
          const text = await res.text().catch(() => '');
          const error = new Error(
            `Anthropic streaming error: HTTP ${res.status} — ${text}`,
          ) as Error & {
            status?: number;
            response?: { status: number; headers: Headers };
          };
          // This is the one path on fetch rather than axios. The shared policy
          // reads the status and Retry-After off the axios shape, so give it one;
          // Headers already answers to the same case-insensitive get().
          error.status = res.status;
          error.response = { status: res.status, headers: res.headers };
          throw error;
        }
        return res as OpenStream;
      },
      { model, signal: options?.signal },
      {
        prepare: async () => {
          headers = await this.authHeaders();
        },
        opts: options,
        op: startOperation(options),
        bound: this.config.usage,
        base: {
          provider: 'anthropic',
          model,
          stream: true,
          granularity: 'request',
          retriesVisible: true,
        },
      },
    );

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let completed = false;
    let streamError: unknown;
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let cachedInputTokens: number | undefined;

    // Anthropic streams tool_use as discrete content blocks: a
    // `content_block_start` with type=tool_use carries id+name, then a series
    // of `content_block_delta` with type=input_json_delta carries the JSON
    // arguments in pieces. Map block index → tool-call index to produce
    // normalized LlmToolCallDelta chunks.
    const toolBlockIndices = new Map<number, number>();
    let nextToolIndex = 0;

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

        let eventType = '';
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
            const parsed = JSON.parse(data);
            const eventUsage = parsed.message?.usage ?? parsed.usage;
            if (eventUsage) {
              inputTokens = eventUsage.input_tokens ?? inputTokens;
              outputTokens = eventUsage.output_tokens ?? outputTokens;
              cachedInputTokens =
                eventUsage.cache_read_input_tokens ?? cachedInputTokens;
            }
            if (
              parsed.delta?.text ||
              parsed.content_block?.type === 'tool_use' ||
              parsed.delta?.partial_json
            )
              handle.firstToken();
            if (
              eventType === 'content_block_delta' &&
              parsed.delta?.type === 'text_delta'
            ) {
              yield { content: parsed.delta.text || '', raw: parsed };
            } else if (
              eventType === 'content_block_start' &&
              parsed.content_block?.type === 'tool_use'
            ) {
              const blockIndex = parsed.index as number;
              const toolIndex = nextToolIndex++;
              toolBlockIndices.set(blockIndex, toolIndex);
              yield {
                content: '',
                raw: parsed,
                toolCalls: [
                  {
                    index: toolIndex,
                    id: parsed.content_block.id,
                    name: parsed.content_block.name,
                    arguments: '',
                  },
                ],
              };
            } else if (
              eventType === 'content_block_delta' &&
              parsed.delta?.type === 'input_json_delta'
            ) {
              const toolIndex = toolBlockIndices.get(parsed.index as number);
              if (toolIndex !== undefined) {
                yield {
                  content: '',
                  raw: parsed,
                  toolCalls: [
                    {
                      index: toolIndex,
                      arguments: parsed.delta.partial_json ?? '',
                    },
                  ],
                };
              }
            } else if (eventType === 'message_start' && parsed.message?.usage) {
              const u = parsed.message.usage;
              yield {
                content: '',
                raw: parsed,
                usage: {
                  promptTokens: u.input_tokens ?? 0,
                  completionTokens: u.output_tokens ?? 0,
                  totalTokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0),
                },
              };
            } else if (eventType === 'message_delta') {
              const u = parsed.usage;
              const stopReason = parsed.delta?.stop_reason;
              yield {
                content: '',
                // Normalize Anthropic's 'tool_use' to 'tool_calls' so the
                // downstream bridge / agent sees the canonical finish reason.
                finishReason:
                  stopReason === 'tool_use' ? 'tool_calls' : stopReason,
                raw: parsed,
                usage: u
                  ? {
                      promptTokens: 0,
                      completionTokens: u.output_tokens ?? 0,
                      totalTokens: u.output_tokens ?? 0,
                    }
                  : undefined,
              };
            } else if (eventType === 'error') {
              const error = parsed.error as
                | { message?: string; type?: string }
                | undefined;
              throw Object.assign(
                new Error(
                  `Anthropic stream error: ${error?.message ?? 'unknown'}`,
                ),
                { code: error?.type },
              );
            } else {
              yield { content: '', raw: parsed };
            }
          } catch (e) {
            if (
              e instanceof Error &&
              e.message.startsWith('Anthropic stream error:')
            ) {
              throw e;
            }
            /* incomplete JSON — skip */
          }
        }
      }
    } catch (error) {
      streamError = error;
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
        error: streamError,
        closedEarly: !completed && !streamError,
        inputTokens,
        outputTokens,
        cachedInputTokens,
        tokensSource:
          inputTokens !== undefined ||
          outputTokens !== undefined ||
          cachedInputTokens !== undefined
            ? 'provider'
            : 'unknown',
      });
      reader.releaseLock();
    }
  }

  async getModels(): Promise<IModelInfo[]> {
    const response = await this.client.get('/models', {
      headers: await this.authHeaders(),
    });
    return (response.data.data as Array<{ id: string; owned_by?: string }>).map(
      (m) => ({ id: m.id, owned_by: m.owned_by }),
    );
  }

  async getEmbeddingModels(): Promise<IModelInfo[]> {
    return [];
  }

  /**
   * Format messages for Anthropic API
   */
  private formatMessages(messages: Message[]): Array<Record<string, unknown>> {
    return messages.map((msg) => ({
      role: msg.role === 'assistant' ? 'assistant' : 'user',
      content: msg.content,
    }));
  }
}
