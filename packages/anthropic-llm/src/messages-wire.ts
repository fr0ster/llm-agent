import {
  type LLMCallOptions,
  type LLMProvider,
  type LLMResponse,
  LlmError,
  type LlmRequestFacts,
  type Message,
  MODEL_CONTEXT_EXCEEDED,
  type ShapeMessage,
} from '@mcp-abap-adt/llm-agent';

export interface AnthropicUsage {
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
interface CacheControl {
  type: 'ephemeral';
}

type ContentBlock = (
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Json }
  | { type: 'tool_result'; tool_use_id: string; content: string }
) & { cache_control?: CacheControl };
export interface WireMessage {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

export interface AnthropicErrorResponse {
  error?: { type?: string; message?: string };
}

export function isContextOverflow(
  error: AnthropicErrorResponse['error'],
): boolean {
  return (
    error?.type === 'invalid_request_error' &&
    typeof error.message === 'string' &&
    /\bprompt is too long\b/i.test(error.message)
  );
}

export function isContextOverflowBody(text: string): boolean {
  try {
    const body: AnthropicErrorResponse | null = JSON.parse(text);
    return isContextOverflow(body?.error);
  } catch {
    return false;
  }
}

export function contextOverflow(message: string): LlmError {
  return Object.assign(new LlmError(message, MODEL_CONTEXT_EXCEEDED), {
    status: 400,
  });
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

export function formatMessages(
  messages: Message[],
  toolCallIdMapper: (ids: readonly string[]) => (id: string) => string,
): WireMessage[] {
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
    if (message.content) content.push({ type: 'text', text: message.content });
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
  const wireId = toolCallIdMapper(
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

interface WireTool {
  name: string;
  description?: string;
  input_schema: Json;
  cache_control?: CacheControl;
}

export function requestBody(
  sent: WireMessage[],
  system: string | undefined,
  tools: Parameters<LLMProvider['chat']>[1],
  options: LLMCallOptions & { maxTokens: number },
  provider: 'anthropic' | 'bedrock',
) {
  const sentTools: WireTool[] = formatTools(
    (tools ?? []) as ToolDefinition[],
    sent,
  );
  const cacheControl: CacheControl = { type: 'ephemeral' };
  return {
    messages: sent,
    ...(system !== undefined ? { system } : {}),
    max_tokens: options.maxTokens,
    ...(options.temperature !== undefined
      ? { temperature: options.temperature }
      : {}),
    ...(options.topP !== undefined ? { top_p: options.topP } : {}),
    ...(options.stop ? { stop_sequences: options.stop } : {}),
    ...(sentTools.length
      ? {
          tools: sentTools,
          ...(!tools?.length ? { tool_choice: { type: 'none' } } : {}),
        }
      : {}),
    ...(options.promptCaching !== false
      ? provider === 'bedrock'
        ? cacheBreakpoint(sent, system, sentTools, cacheControl)
        : { cache_control: cacheControl }
      : {}),
  };
}

function cacheBreakpoint(
  messages: WireMessage[],
  system: string | undefined,
  tools: WireTool[],
  cacheControl: CacheControl,
) {
  if (system) {
    return {
      system: [{ type: 'text', text: system, cache_control: cacheControl }],
    };
  }
  const lastTool = tools.at(-1);
  if (lastTool) {
    lastTool.cache_control = cacheControl;
    return {};
  }
  const anchor = messages.at(-2) ?? messages.at(-1);
  if (!anchor) return {};
  const blocks: ContentBlock[] =
    typeof anchor.content === 'string'
      ? [{ type: 'text', text: anchor.content }]
      : anchor.content;
  const last = blocks.at(-1);
  if (!last || (last.type === 'text' && !last.text)) return {};
  return {
    messages: messages.map((message) =>
      message === anchor
        ? {
            ...message,
            content: [
              ...blocks.slice(0, -1),
              { ...last, cache_control: cacheControl },
            ],
          }
        : message,
    ),
  };
}

export function shapeMessages(
  messages: WireMessage[],
  system?: string | Array<{ type: string; text: string }>,
): ShapeMessage[] {
  return [
    ...(system !== undefined
      ? [
          {
            role: 'system' as const,
            content:
              typeof system === 'string' ? system : JSON.stringify(system),
          },
        ]
      : []),
    ...messages.map((message) => ({
      role: message.role,
      content:
        typeof message.content === 'string'
          ? message.content
          : JSON.stringify(message.content),
    })),
  ];
}

export interface AnthropicChatResponse extends AnthropicErrorResponse {
  content: ContentBlock[];
  stop_reason?: string | null;
  usage?: AnthropicUsage;
}

export interface AnthropicStreamEvent extends AnthropicErrorResponse {
  type?: string;
  index?: number;
  content_block?: ContentBlock;
  delta?: {
    type?: string;
    text?: string;
    partial_json?: string;
    stop_reason?: string | null;
  };
  message?: { usage?: AnthropicUsage };
  usage?: AnthropicUsage;
}

export function chatResponse(
  raw: AnthropicChatResponse,
  options?: { defaultToolInput?: boolean },
): LLMResponse {
  const toolCalls: NonNullable<LLMResponse['toolCalls']> = [];
  let textContent = '';
  for (const block of raw.content) {
    if (block.type === 'text') textContent += block.text;
    if (block.type === 'tool_use') {
      toolCalls.push({
        index: toolCalls.length,
        id: block.id,
        name: block.name,
        arguments: JSON.stringify(
          options?.defaultToolInput ? (block.input ?? {}) : block.input,
        ),
      });
    }
  }
  return {
    content: textContent,
    finishReason: normalizeStopReason(raw.stop_reason),
    ...(toolCalls.length ? { toolCalls } : {}),
    raw,
    usage: raw.usage ? normalizedUsage(raw.usage) : undefined,
  };
}

export function tokenFacts(usage?: AnthropicUsage): Partial<LlmRequestFacts> {
  const {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_read_input_tokens: cachedInputTokens,
    cache_creation_input_tokens: cacheCreationInputTokens,
  } = usage ?? {};
  return {
    tokensSource:
      inputTokens !== undefined ||
      outputTokens !== undefined ||
      cachedInputTokens !== undefined ||
      cacheCreationInputTokens !== undefined
        ? 'provider'
        : 'unknown',
    inputTokens,
    outputTokens,
    cachedInputTokens,
    cacheCreationInputTokens,
  };
}

function tokenDelta(current: number | undefined, previous: number | undefined) {
  return current === previous || current === undefined
    ? undefined
    : current - (previous ?? 0);
}

function cumulativeCount(previous?: number, current?: number) {
  return current == null ? previous : Math.max(previous ?? 0, current);
}

type UsageFallback = Pick<AnthropicUsage, 'input_tokens' | 'output_tokens'>;

export function withUsageFallback(
  usage: AnthropicUsage | undefined,
  fallback: UsageFallback,
): AnthropicUsage {
  return {
    ...usage,
    input_tokens:
      usage?.input_tokens ||
      cumulativeCount(usage?.input_tokens, fallback.input_tokens),
    output_tokens:
      usage?.output_tokens ||
      cumulativeCount(usage?.output_tokens, fallback.output_tokens),
  };
}

export class AnthropicStreamMapper {
  private usage: AnthropicUsage = {};
  private nextToolIndex = 0;
  private readonly tools = new Map<
    number,
    { index: number; input: Json; hasArguments: boolean }
  >();

  constructor(private readonly options?: { deltaUsage?: boolean }) {}

  tokenFacts(): Partial<LlmRequestFacts> {
    return tokenFacts(this.usage);
  }

  map(
    raw: AnthropicStreamEvent,
    eventType = raw.type,
    fallbackUsage?: UsageFallback,
  ): LLMResponse | undefined {
    const currentUsage = raw.message?.usage ?? raw.usage;
    let usage: LLMResponse['usage'];
    if (currentUsage || fallbackUsage) {
      const previous = this.usage;
      const merged = {
        input_tokens: cumulativeCount(
          previous.input_tokens,
          currentUsage?.input_tokens,
        ),
        output_tokens: cumulativeCount(
          previous.output_tokens,
          currentUsage?.output_tokens,
        ),
        cache_read_input_tokens: cumulativeCount(
          previous.cache_read_input_tokens,
          currentUsage?.cache_read_input_tokens,
        ),
        cache_creation_input_tokens: cumulativeCount(
          previous.cache_creation_input_tokens,
          currentUsage?.cache_creation_input_tokens,
        ),
      };
      this.usage = fallbackUsage
        ? withUsageFallback(merged, fallbackUsage)
        : merged;
      if (this.options?.deltaUsage) {
        // Bedrock reports cumulative counts. The agent sums usage chunks.
        usage = normalizedUsage({
          input_tokens: tokenDelta(
            this.usage.input_tokens,
            previous.input_tokens,
          ),
          output_tokens: tokenDelta(
            this.usage.output_tokens,
            previous.output_tokens,
          ),
          cache_read_input_tokens: tokenDelta(
            this.usage.cache_read_input_tokens,
            previous.cache_read_input_tokens,
          ),
          cache_creation_input_tokens: tokenDelta(
            this.usage.cache_creation_input_tokens,
            previous.cache_creation_input_tokens,
          ),
        });
      }
    }

    const response = { content: '', raw, ...(usage ? { usage } : {}) };
    const block = raw.content_block;
    const delta = raw.delta;
    const index = raw.index;
    if (
      eventType === 'content_block_start' &&
      block?.type === 'tool_use' &&
      index !== undefined
    ) {
      const toolIndex = this.nextToolIndex++;
      this.tools.set(index, {
        index: toolIndex,
        input: block.input ?? {},
        hasArguments: false,
      });
      return {
        ...response,
        toolCalls: [
          { index: toolIndex, id: block.id, name: block.name, arguments: '' },
        ],
      };
    }
    if (eventType === 'content_block_delta' && delta?.type === 'text_delta') {
      return { ...response, content: delta.text || '' };
    }
    const tool = index !== undefined ? this.tools.get(index) : undefined;
    if (
      eventType === 'content_block_delta' &&
      delta?.type === 'input_json_delta'
    ) {
      if (!tool) return usage ? response : undefined;
      if (delta.partial_json) tool.hasArguments = true;
      return {
        ...response,
        toolCalls: [{ index: tool.index, arguments: delta.partial_json ?? '' }],
      };
    }
    if (eventType === 'content_block_stop') {
      if (index !== undefined) this.tools.delete(index);
      if (!tool || tool.hasArguments) return usage ? response : undefined;
      return {
        ...response,
        toolCalls: [
          { index: tool.index, arguments: JSON.stringify(tool.input) },
        ],
      };
    }
    if (eventType === 'message_delta') {
      if (!this.options?.deltaUsage && raw.usage) {
        const completionTokens = raw.usage.output_tokens ?? 0;
        usage = {
          promptTokens: 0,
          completionTokens,
          totalTokens: completionTokens,
        };
      }
      return {
        ...response,
        finishReason: normalizeStopReason(delta?.stop_reason),
        usage,
      };
    }
    if (
      !this.options?.deltaUsage &&
      eventType === 'message_start' &&
      raw.message?.usage
    )
      return { ...response, usage: normalizedUsage(raw.message.usage) };
    return response;
  }
}
