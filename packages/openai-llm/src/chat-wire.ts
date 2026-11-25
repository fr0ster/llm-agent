import type {
  LLMCallOptions,
  LLMProvider,
  LLMResponse,
  LlmRequestFacts,
  LlmUsage,
  Message,
} from '@mcp-abap-adt/llm-agent';

/** One message as the OpenAI chat completions payload carries it. */
export interface OpenAIWireMessage {
  role: Message['role'];
  content: string | null;
  tool_calls?: Message['tool_calls'];
  tool_call_id?: string;
}

export interface OpenAIErrorResponse {
  error?: { message?: string; code?: string | null };
}

interface OpenAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
    cache_write_tokens?: number;
  };
  prompt_cache_hit_tokens?: number;
}

export interface OpenAIChatResponse extends OpenAIErrorResponse {
  choices?: Array<{
    message: { content: string | null; tool_calls?: Message['tool_calls'] };
    finish_reason?: string | null;
  }>;
  usage?: OpenAIUsage | null;
}

export interface OpenAIChatEvent extends OpenAIErrorResponse {
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: OpenAIUsage | null;
}

export function isContextOverflow(
  error: OpenAIErrorResponse['error'],
): boolean {
  return error?.code === 'context_length_exceeded';
}

export function tokenLimitParam(
  model: string,
  maxTokens: number,
): Record<string, number> {
  return /^(o\d|gpt-(?:[5-9]|\d{2,})(?:[.-]|$))/i.test(model)
    ? { max_completion_tokens: maxTokens }
    : { max_tokens: maxTokens };
}

export function formatMessages(messages: Message[]): OpenAIWireMessage[] {
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

export function requestBody(
  model: string,
  messages: OpenAIWireMessage[],
  tools: Parameters<LLMProvider['chat']>[1],
  options: LLMCallOptions,
  limit: (
    model: string,
    maxTokens: number,
  ) => Record<string, number> = tokenLimitParam,
) {
  return {
    model,
    messages,
    ...(tools?.length ? { tools, tool_choice: 'auto' } : {}),
    ...(options.temperature !== undefined
      ? { temperature: options.temperature }
      : {}),
    ...(options.maxTokens !== undefined ? limit(model, options.maxTokens) : {}),
    ...(options.topP !== undefined ? { top_p: options.topP } : {}),
    ...(options.stop ? { stop: options.stop } : {}),
  };
}

export function streamParams() {
  return { stream: true, stream_options: { include_usage: true } };
}

export function chatResponse(raw: OpenAIChatResponse): LLMResponse {
  const choice = raw.choices?.[0];
  if (!choice)
    throw new Error('OpenAI chat response is missing a completion choice');
  const toolCalls = choice.message.tool_calls?.map((call, index) => ({
    index,
    id: call.id,
    name: call.function.name,
    arguments: call.function.arguments || '{}',
  }));
  return {
    content: choice.message.content || '',
    finishReason: choice.finish_reason ?? undefined,
    raw,
    usage: raw.usage ? normalizedUsage(raw.usage) : undefined,
    ...(toolCalls?.length ? { toolCalls } : {}),
  };
}

function normalizedUsage(usage: OpenAIUsage): LlmUsage {
  return {
    ...cacheUsage(usage),
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
  };
}

function cacheUsage(usage: OpenAIUsage) {
  const cached =
    usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens;
  const created = usage.prompt_tokens_details?.cache_write_tokens;
  return {
    ...(cached !== undefined ? { cachedInputTokens: cached } : {}),
    ...(created !== undefined ? { cacheCreationInputTokens: created } : {}),
  };
}

export function tokenFacts(
  usage?: OpenAIUsage | null,
): Partial<LlmRequestFacts> {
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

export class OpenAIStreamMapper {
  private readonly toolArgumentsReceived = new Map<number, boolean>();

  *map(raw: OpenAIChatEvent): Iterable<LLMResponse> {
    const choice = raw.choices?.[0];
    if (choice && (choice.delta || choice.finish_reason)) {
      const toolCalls = (choice.delta?.tool_calls ?? []).map((call) => ({
        index: call.index,
        id: call.id,
        name: call.function?.name,
        arguments: call.function?.arguments,
      }));
      for (const call of toolCalls) {
        this.toolArgumentsReceived.set(
          call.index,
          Boolean(call.arguments) ||
            this.toolArgumentsReceived.get(call.index) === true,
        );
      }
      const remaining = choice.finish_reason ? this.finish() : [];
      const deltas = [...toolCalls, ...remaining];
      yield {
        content: choice.delta?.content || '',
        finishReason: choice.finish_reason ?? undefined,
        raw,
        ...(deltas.length ? { toolCalls: deltas } : {}),
      };
    }
    // Some OpenAI-compatible providers attach usage to the final delta.
    if (raw.usage)
      yield { content: '', raw, usage: normalizedUsage(raw.usage) };
  }

  finish() {
    const remaining = [...this.toolArgumentsReceived]
      .filter(([, hasArguments]) => !hasArguments)
      .map(([index]) => ({ index, arguments: '{}' }));
    this.toolArgumentsReceived.clear();
    return remaining;
  }
}
