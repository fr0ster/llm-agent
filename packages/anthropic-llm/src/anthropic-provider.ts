/**
 * Anthropic (Claude) LLM Provider
 */

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
  httpStatusOf,
  requestShape,
  type ShapeMessage,
  startOperation,
} from '@mcp-abap-adt/llm-agent';
import axios, { type AxiosInstance, type AxiosResponse } from 'axios';

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

/** `{ temperature }` when set, nothing otherwise — the model's default applies. */
function temperatureParam(temperature: number | undefined) {
  return temperature !== undefined ? { temperature } : {};
}

function cacheControlParam(caching: AnthropicConfig['promptCaching'] = true) {
  return !caching
    ? {}
    : {
        cache_control: { type: 'ephemeral' },
      };
}

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

function normalizedUsage(usage: AnthropicUsage) {
  const promptTokens =
    (usage.input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0);
  const completionTokens = usage.output_tokens ?? 0;
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    ...(usage.cache_read_input_tokens !== undefined
      ? { cachedInputTokens: usage.cache_read_input_tokens }
      : {}),
    ...(usage.cache_creation_input_tokens !== undefined
      ? { cacheCreationInputTokens: usage.cache_creation_input_tokens }
      : {}),
  };
}

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
function parseToolArguments(argumentsJson: string): Json {
  if (argumentsJson === '') return {};
  try {
    return JSON.parse(argumentsJson) as Json;
  } catch {
    return { _unparsed_arguments: argumentsJson };
  }
}
interface ToolDefinition {
  name?: string;
  description?: string;
  inputSchema?: Json;
  input_schema?: Json;
  function?: { name: string; description?: string; parameters?: Json };
}
type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Json }
  | { type: 'tool_result'; tool_use_id: string; content: string };
export interface WireMessage {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
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

function isModelOutputLimit(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0;
}

function normalizeStopReason(
  reason: string | null | undefined,
): string | undefined {
  switch (reason) {
    case 'tool_use':
      return 'tool_calls';
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'length';
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    default:
      return reason ?? undefined;
  }
}

function formatTools(
  tools: readonly ToolDefinition[],
  messages: readonly WireMessage[],
) {
  const definitions = tools.map((tool) => {
    const definition = tool.function ?? tool;
    if (!definition.name) throw new Error('Anthropic tool requires a name');
    return {
      name: definition.name,
      ...(definition.description !== undefined
        ? { description: definition.description }
        : {}),
      input_schema: tool.function?.parameters ??
        tool.inputSchema ??
        tool.input_schema ?? { type: 'object', properties: {} },
    };
  });
  const names = new Set(definitions.map((tool) => tool.name));
  // Anthropic requires definitions even for completed historical tool uses.
  // A client may omit tools on resume, or the agent may have reselected them.
  for (const message of messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.content))
      continue;
    for (const block of message.content) {
      if (block.type !== 'tool_use' || names.has(block.name)) continue;
      definitions.push({
        name: block.name,
        description:
          'Historical tool; its result is already in the conversation.',
        input_schema: { type: 'object', properties: {} },
      });
      names.add(block.name);
    }
  }
  return definitions;
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
  private async authHeaders(apiKey?: string): Promise<Record<string, string>> {
    return { 'x-api-key': apiKey ?? (await this.config.credential.secret()) };
  }

  private async fetchModelMaxTokens(
    model: string,
    signal: AbortSignal,
    apiKey?: string,
  ): Promise<number> {
    const { data } = await this.client.get<ModelResponse>(
      `/models/${encodeURIComponent(model)}`,
      { headers: await this.authHeaders(apiKey), signal },
    );
    if (!isModelOutputLimit(data.max_tokens)) {
      throw new Error(
        `Anthropic model "${model}" did not report max_tokens; set maxTokens explicitly`,
      );
    }
    this.modelMaxTokens.set(model, data.max_tokens);
    this.modelMaxTokens.set(data.id, data.max_tokens);
    return data.max_tokens;
  }

  private async resolveMaxTokens(
    model: string,
    options?: LLMCallOptions,
  ): Promise<number> {
    const { signal, apiKey } = options ?? {};
    signal?.throwIfAborted();
    const configured = options?.maxTokens ?? this.config.maxTokens;
    if (configured !== undefined) return configured;
    const cached = this.modelMaxTokens.get(model);
    if (cached !== undefined) return cached;

    let lookup = this.modelLookups.get(model);
    if (!lookup) {
      const controller = new AbortController();
      lookup = {
        controller,
        limit: this.fetchModelMaxTokens(model, controller.signal, apiKey),
        callers: 0,
      };
      this.modelLookups.set(model, lookup);
    }
    lookup.callers++;
    let abortListener: ReturnType<typeof addAbortListener> | undefined;
    try {
      if (!signal) return await lookup.limit;
      const aborted = new Promise<never>((_, reject) => {
        abortListener = addAbortListener(signal, () => reject(signal.reason));
      });
      return await Promise.race([lookup.limit, aborted]);
    } finally {
      abortListener?.[Symbol.dispose]();
      if (--lookup.callers === 0) {
        this.modelLookups.delete(model);
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
      const systemMessages = messages.filter((m) => m.role === 'system');
      const systemContent = systemMessages.map((m) => m.content).join('\n\n');
      const conversationMessages = messages.filter((m) => m.role !== 'system');

      const sent = this.formatMessages(conversationMessages);
      const sentTools = formatTools((tools ?? []) as ToolDefinition[], sent);
      const model = options?.model ?? this.model;
      const requestBody: Record<
        string,
        object | string | number | boolean | null | undefined
      > = {
        model,
        messages: sent,
        max_tokens: await this.resolveMaxTokens(model, options),
        ...temperatureParam(options?.temperature ?? this.config.temperature),
        ...cacheControlParam(
          options?.promptCaching ?? this.config.promptCaching,
        ),
        ...(options?.topP !== undefined ? { top_p: options.topP } : {}),
        ...(options?.stop ? { stop_sequences: options.stop } : {}),
      };

      if (systemMessages.length > 0) {
        requestBody.system = systemContent;
      }

      if (sentTools.length) {
        requestBody.tools = sentTools;
        if (!tools?.length) requestBody.tool_choice = { type: 'none' };
      }

      let headers: Record<string, string>;
      let shape: ReturnType<typeof requestShape> | undefined;
      const response = await this.withThrottleRetry(
        async (handle) => {
          const response = await this.client.post('/messages', requestBody, {
            signal: options?.signal,
            headers,
          });
          // Handle multi-block response (text + tool_use)
          const content = response.data.content as ContentBlock[];
          const toolCalls: NonNullable<LLMResponse['toolCalls']> = [];
          let textContent = '';
          for (const block of content) {
            if (block.type === 'text') textContent += block.text;
            if (block.type === 'tool_use')
              toolCalls.push({
                index: toolCalls.length,
                id: block.id,
                name: block.name,
                arguments: JSON.stringify(block.input),
              });
          }

          const rawUsage = response.data.usage;
          const usage = rawUsage ? normalizedUsage(rawUsage) : undefined;

          const result = {
            content: textContent,
            finishReason: normalizeStopReason(response.data.stop_reason),
            ...(toolCalls.length ? { toolCalls } : {}),
            raw: response.data,
            usage,
          };
          handle.end({
            outcome: response.data.error ? 'error' : 'ok',
            errorCode: response.data.error?.type,
            tokensSource:
              rawUsage?.input_tokens !== undefined ||
              rawUsage?.output_tokens !== undefined ||
              rawUsage?.cache_read_input_tokens !== undefined ||
              rawUsage?.cache_creation_input_tokens !== undefined
                ? 'provider'
                : 'unknown',
            inputTokens: rawUsage?.input_tokens,
            outputTokens: rawUsage?.output_tokens,
            cachedInputTokens: rawUsage?.cache_read_input_tokens,
            cacheCreationInputTokens: rawUsage?.cache_creation_input_tokens,
          });
          return result;
        },
        { model, signal: options?.signal },
        {
          prepare: async () => {
            headers = await this.authHeaders(options?.apiKey);
          },
          opts: options,
          apiKeyOverride: options?.apiKey,
          op: startOperation(options),
          bound: this.config.usage,
          get base(): Parameters<typeof beginLlmRequest>[2] & {
            stream: false;
          } {
            shape ??= requestShape(
              [
                ...(systemMessages.length > 0
                  ? [
                      {
                        role: 'system',
                        content: systemContent,
                      } satisfies ShapeMessage,
                    ]
                  : []),
                ...sent.map((message) => ({
                  role: message.role,
                  content:
                    typeof message.content === 'string'
                      ? message.content
                      : JSON.stringify(message.content),
                })),
              ],
              sentTools,
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
      if (options?.apiKey !== undefined) {
        throw this.credentialSafeError(error, 'Anthropic API error');
      }
      const message = axios.isAxiosError(error)
        ? `HTTP ${error.response?.status ?? 'unavailable'} ${(error.response?.data as { error?: { type?: string } })?.error?.type ?? error.code ?? 'error'}: ${(error.response?.data as { error?: { message?: string } })?.error?.message ?? error.message}`
        : error instanceof Error
          ? error.message
          : String(error);
      throw this.preserveThrottled(
        error,
        Object.assign(new Error(`Anthropic API error: ${message}`), {
          status: httpStatusOf(
            typeof error === 'object' ? (error ?? undefined) : undefined,
          ),
          retryAfterSeconds: this.retryAfterSeconds(error),
        }),
      );
    }
  }

  async *streamChat(
    messages: Message[],
    tools?: unknown[],
    options?: LLMCallOptions,
  ): AsyncIterable<LLMResponse> {
    const systemMessages = messages.filter((m) => m.role === 'system');
    const systemContent = systemMessages.map((m) => m.content).join('\n\n');
    const conversationMessages = messages.filter((m) => m.role !== 'system');

    const sent = this.formatMessages(conversationMessages);
    const sentTools = formatTools((tools ?? []) as ToolDefinition[], sent);
    const model = options?.model ?? this.model;
    const requestBody: Record<
      string,
      object | string | number | boolean | null | undefined
    > = {
      model,
      messages: sent,
      max_tokens: await this.resolveMaxTokens(model, options).catch(
        (error: Error) => {
          if (options?.apiKey !== undefined) {
            throw this.credentialSafeError(
              error,
              'Anthropic model discovery failed',
            );
          }
          throw error;
        },
      ),
      ...temperatureParam(options?.temperature ?? this.config.temperature),
      ...cacheControlParam(options?.promptCaching ?? this.config.promptCaching),
      stream: true,
      ...(options?.topP !== undefined ? { top_p: options.topP } : {}),
      ...(options?.stop ? { stop_sequences: options.stop } : {}),
    };

    if (systemMessages.length > 0) {
      requestBody.system = systemContent;
    }

    if (sentTools.length) {
      requestBody.tools = sentTools;
      if (!tools?.length) requestBody.tool_choice = { type: 'none' };
    }

    const baseURL = this.config.baseURL || 'https://api.anthropic.com/v1';
    type OpenStream = Response & { body: ReadableStream<Uint8Array> };
    let headers: Record<string, string>;
    let shape: ReturnType<typeof requestShape> | undefined;
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
          const text =
            options?.apiKey === undefined
              ? await res.text().catch(() => '')
              : '';
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
          headers = await this.authHeaders(options?.apiKey);
        },
        opts: options,
        apiKeyOverride: options?.apiKey,
        op: startOperation(options),
        bound: this.config.usage,
        get base(): Parameters<typeof beginLlmRequest>[2] & { stream: true } {
          shape ??= requestShape(
            [
              ...(systemMessages.length > 0
                ? [
                    {
                      role: 'system',
                      content: systemContent,
                    } satisfies ShapeMessage,
                  ]
                : []),
              ...sent.map((message) => ({
                role: message.role,
                content:
                  typeof message.content === 'string'
                    ? message.content
                    : JSON.stringify(message.content),
              })),
            ],
            sentTools,
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
      if (options?.apiKey !== undefined) {
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
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let cachedInputTokens: number | undefined;
    let cacheCreationInputTokens: number | undefined;

    // Anthropic streams tool_use as discrete content blocks: a
    // `content_block_start` with type=tool_use carries id+name, then a series
    // of `content_block_delta` with type=input_json_delta carries the JSON
    // arguments in pieces. Map block index → tool-call index to produce
    // normalized LlmToolCallDelta chunks.
    const toolBlockIndices = new Map<number, number>();
    let nextToolIndex = 0;
    const toolInputs = new Map<number, { input: Json; hasDelta: boolean }>();

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
            const parsed = JSON.parse(data);
            const eventUsage = parsed.message?.usage ?? parsed.usage;
            if (eventUsage) {
              inputTokens = eventUsage.input_tokens ?? inputTokens;
              outputTokens = eventUsage.output_tokens ?? outputTokens;
              cachedInputTokens =
                eventUsage.cache_read_input_tokens ?? cachedInputTokens;
              cacheCreationInputTokens =
                eventUsage.cache_creation_input_tokens ??
                cacheCreationInputTokens;
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
              toolInputs.set(blockIndex, {
                input: parsed.content_block.input ?? {},
                hasDelta: false,
              });
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
                const state = toolInputs.get(parsed.index as number);
                if (state) state.hasDelta = true;
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
            } else if (eventType === 'content_block_stop') {
              const blockIndex = parsed.index as number;
              const toolIndex = toolBlockIndices.get(blockIndex);
              const state = toolInputs.get(blockIndex);
              if (toolIndex !== undefined && state && !state.hasDelta) {
                yield {
                  content: '',
                  raw: parsed,
                  toolCalls: [
                    {
                      index: toolIndex,
                      arguments: JSON.stringify(state.input),
                    },
                  ],
                };
              }
              toolInputs.delete(blockIndex);
              toolBlockIndices.delete(blockIndex);
            } else if (eventType === 'message_start' && parsed.message?.usage) {
              const u = parsed.message.usage;
              yield {
                content: '',
                raw: parsed,
                usage: normalizedUsage(u),
              };
            } else if (eventType === 'message_delta') {
              const u = parsed.usage;
              const stopReason = parsed.delta?.stop_reason;
              yield {
                content: '',
                finishReason: normalizeStopReason(stopReason),
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
                  `Anthropic stream error: ${error?.type ?? 'error'}: ${error?.message ?? 'unspecified'}`,
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
      streamError = error instanceof Error ? error : String(error);
      if (options?.apiKey !== undefined) {
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
        inputTokens,
        outputTokens,
        cachedInputTokens,
        cacheCreationInputTokens,
        tokensSource:
          inputTokens !== undefined ||
          outputTokens !== undefined ||
          cachedInputTokens !== undefined ||
          cacheCreationInputTokens !== undefined
            ? 'provider'
            : 'unknown',
      });
      reader.releaseLock();
    }
  }

  async getModels(options?: LLMCallOptions): Promise<IModelInfo[]> {
    const models: IModelInfo[] = [];
    let afterId: string | null = null;
    while (true) {
      const response: AxiosResponse<ModelsListResponse> = await this.client
        .get('/models', {
          headers: await this.authHeaders(options?.apiKey),
          signal: options?.signal,
          params: { limit: 1000, ...(afterId ? { after_id: afterId } : {}) },
        })
        .catch((error: Error) => {
          if (options?.apiKey !== undefined) {
            throw this.credentialSafeError(
              error,
              'Anthropic model discovery failed',
            );
          }
          throw error;
        });
      for (const { id, owned_by, max_tokens: maxOutputTokens } of response.data
        .data) {
        if (isModelOutputLimit(maxOutputTokens)) {
          this.modelMaxTokens.set(id, maxOutputTokens);
          models.push({ id, owned_by, maxOutputTokens });
        } else {
          models.push({ id, owned_by });
        }
      }
      if (!response.data.has_more) return models;
      if (!response.data.last_id)
        throw new Error('Anthropic models list: has_more without last_id');
      afterId = response.data.last_id;
    }
  }

  async getEmbeddingModels(): Promise<IModelInfo[]> {
    return [];
  }

  /**
   * Format messages for Anthropic API
   */
  private formatMessages(messages: Message[]): WireMessage[] {
    const result: WireMessage[] = [];
    let toolUseIds: string[] = [];
    let pendingResults: ContentBlock[] = [];
    let pendingText: ContentBlock[] = [];
    const flush = () => {
      if (pendingResults.length || pendingText.length) {
        result.push({
          role: 'user',
          content: [
            ...toolUseIds.flatMap((id) =>
              pendingResults.filter(
                (block) =>
                  block.type === 'tool_result' && block.tool_use_id === id,
              ),
            ),
            ...pendingText,
          ],
        });
      }
      toolUseIds = [];
      pendingResults = [];
      pendingText = [];
    };
    for (const message of messages) {
      if (message.role === 'assistant') flush();
      if (toolUseIds.length && message.role !== 'assistant') {
        if (
          message.role === 'tool' &&
          message.tool_call_id &&
          toolUseIds.includes(message.tool_call_id)
        ) {
          pendingResults.push({
            type: 'tool_result',
            tool_use_id: message.tool_call_id,
            content: message.content ?? '',
          });
        } else {
          pendingText.push({ type: 'text', text: message.content ?? '' });
        }
        continue;
      }
      const content: ContentBlock[] = [];
      if (message.content)
        content.push({ type: 'text', text: message.content });
      if (message.role === 'assistant') {
        const normalized = message as Message & {
          toolCalls?: Array<{ id: string; name: string; arguments: Json }>;
        };
        for (const call of message.tool_calls ?? []) {
          content.push({
            type: 'tool_use',
            id: call.id,
            name: call.function.name,
            input: parseToolArguments(call.function.arguments),
          });
        }
        if (!message.tool_calls?.length) {
          for (const call of normalized.toolCalls ?? []) {
            content.push({
              type: 'tool_use',
              id: call.id,
              name: call.name,
              input:
                typeof call.arguments === 'string'
                  ? parseToolArguments(call.arguments)
                  : call.arguments,
            });
          }
        }
      }
      if (!content.length) content.push({ type: 'text', text: '' });
      result.push({
        role: message.role === 'assistant' ? 'assistant' : 'user',
        content: content.some((block) => block.type !== 'text')
          ? content
          : (message.content ?? ''),
      });
      toolUseIds = content.flatMap((block) =>
        block.type === 'tool_use' ? [block.id] : [],
      );
    }
    flush();
    const wireId = this.toolCallIdMapper(
      result.flatMap((message) =>
        typeof message.content === 'string'
          ? []
          : message.content.flatMap((block) =>
              block.type === 'tool_use'
                ? [block.id]
                : block.type === 'tool_result'
                  ? [block.tool_use_id]
                  : [],
            ),
      ),
    );
    return result.map((message) => ({
      ...message,
      content:
        typeof message.content === 'string'
          ? message.content
          : message.content.map((block) =>
              block.type === 'tool_use'
                ? { ...block, id: wireId(block.id) }
                : block.type === 'tool_result'
                  ? { ...block, tool_use_id: wireId(block.tool_use_id) }
                  : block,
            ),
    }));
  }
}
