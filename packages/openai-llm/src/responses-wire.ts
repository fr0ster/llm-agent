import {
  type LLMCallOptions,
  type LLMProvider,
  type LLMResponse,
  LlmError,
  type LlmRequestFacts,
  type LlmUsage,
  type Message,
  type MessageMetadataValue,
  type ProviderOutput,
} from '@mcp-abap-adt/llm-agent';
import type { OpenAIErrorResponse } from './chat-wire.js';

const PROTOCOL = 'openai.responses';

type FunctionCall = {
  type: 'function_call';
  id?: string;
  call_id: string;
  name: string;
  arguments: string;
  status?: string;
};

type OutputItem =
  | FunctionCall
  | {
      type: 'reasoning';
      id: string;
      encrypted_content?: string | null;
      summary?: Array<{ type: 'summary_text'; text: string }>;
      status?: string;
    }
  | {
      type: 'message';
      id?: string;
      role: 'assistant';
      status?: string;
      phase?: string | null;
      content: Array<
        | { type: 'output_text'; text: string }
        | { type: 'refusal'; refusal: string }
      >;
    };

type InputItem =
  | OutputItem
  | { role: Exclude<Message['role'], 'tool'>; content: string }
  | { type: 'function_call_output'; call_id: string; output: string };

type FunctionDefinition = {
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, MessageMetadataValue>;
  };
};

interface ResponsesUsage {
  input_tokens: number;
  input_tokens_details?: {
    cached_tokens?: number;
    cache_write_tokens?: number;
  };
  output_tokens: number;
  output_tokens_details?: { reasoning_tokens?: number };
  total_tokens: number;
}

export interface OpenAIResponse extends OpenAIErrorResponse {
  status?: string;
  output?: OutputItem[];
  usage?: ResponsesUsage | null;
}

export type OpenAIResponseEvent =
  | {
      type: 'response.output_text.delta' | 'response.refusal.delta';
      delta: string;
    }
  | {
      type: 'response.output_item.added' | 'response.output_item.done';
      output_index: number;
      item: OutputItem;
    }
  | {
      type: 'response.function_call_arguments.delta';
      output_index: number;
      delta: string;
    }
  | {
      type: 'response.function_call_arguments.done';
      output_index: number;
      arguments: string;
    }
  | {
      type: 'response.completed' | 'response.incomplete' | 'response.failed';
      response: OpenAIResponse;
    }
  | { type: 'error'; message?: string; code?: string | null };

function formatInput(messages: Message[]): InputItem[] {
  const input: InputItem[] = [];
  const callIds = new Map<string, string>();
  for (const message of messages) {
    if (message.role === 'tool') {
      if (message.tool_call_id) {
        input.push({
          type: 'function_call_output',
          call_id: callIds.get(message.tool_call_id) ?? message.tool_call_id,
          output:
            typeof message.content === 'string'
              ? message.content
              : JSON.stringify(message.content ?? ''),
        });
      }
      continue;
    }

    const calls = message.role === 'assistant' ? message.tool_calls : undefined;
    const history = message.providerOutput;
    if (
      message.role === 'assistant' &&
      history?.protocol === PROTOCOL &&
      history.items.length
    ) {
      const items = history.items as readonly OutputItem[];
      let callIndex = 0;
      for (const item of items) {
        if (item.type === 'function_call') {
          const call = calls?.[callIndex++];
          if (call) callIds.set(call.id, item.call_id);
        }
        input.push(item);
      }
      continue;
    }

    if (message.content || !calls?.length)
      input.push({ role: message.role, content: message.content ?? '' });
    for (const call of calls ?? []) {
      input.push({
        type: 'function_call',
        call_id: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
      });
    }
  }
  return input;
}

export function requestBody(
  model: string,
  messages: Message[],
  tools: Parameters<LLMProvider['chat']>[1],
  options: LLMCallOptions,
  stream: boolean,
) {
  if (options.stop !== undefined)
    throw new LlmError(
      'The OpenAI Responses API does not support the stop option',
    );

  // GPT-6 and earlier reasoning models restrict sampling controls in reasoning mode.
  const samplingSupported =
    options.reasoningEffort === 'none' ||
    !/^(?:gpt-[56](?:[.-]|$)|o\d)/i.test(model);
  return {
    model,
    input: formatInput(messages),
    ...(tools?.length
      ? {
          tools: tools.map((tool) => ({
            ...(tool as FunctionDefinition).function,
            type: 'function' as const,
            strict: false,
          })),
        }
      : {}),
    ...(options.reasoningEffort !== undefined
      ? { reasoning: { effort: options.reasoningEffort } }
      : {}),
    ...(options.maxTokens !== undefined
      ? { max_output_tokens: options.maxTokens }
      : {}),
    ...(samplingSupported && options.temperature !== undefined
      ? { temperature: options.temperature }
      : {}),
    ...(samplingSupported && options.topP !== undefined
      ? { top_p: options.topP }
      : {}),
    store: false,
    include: ['reasoning.encrypted_content'],
    ...(stream ? { stream: true } : {}),
  };
}

function cacheUsage(usage: ResponsesUsage) {
  const cached = usage.input_tokens_details?.cached_tokens;
  const created = usage.input_tokens_details?.cache_write_tokens;
  return {
    ...(cached !== undefined ? { cachedInputTokens: cached } : {}),
    ...(created !== undefined ? { cacheCreationInputTokens: created } : {}),
  };
}

function normalizedUsage(usage: ResponsesUsage): LlmUsage {
  const reasoningTokens = usage.output_tokens_details?.reasoning_tokens;
  return {
    promptTokens: usage.input_tokens,
    completionTokens: usage.output_tokens,
    totalTokens: usage.total_tokens,
    ...cacheUsage(usage),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
  };
}

export function tokenFacts(
  usage?: ResponsesUsage | null,
): Partial<LlmRequestFacts> {
  return usage
    ? {
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        ...cacheUsage(usage),
        tokensSource: 'provider',
      }
    : {};
}

function providerOutput(items: OutputItem[]): ProviderOutput | undefined {
  return items.length ? { protocol: PROTOCOL, items } : undefined;
}

function finishReason(status: string | undefined, hasToolCalls: boolean) {
  if (status === 'incomplete') return 'length';
  return hasToolCalls ? 'tool_calls' : 'stop';
}

export function chatResponse(raw: OpenAIResponse): LLMResponse {
  const output = raw.output ?? [];
  const toolCalls: NonNullable<LLMResponse['toolCalls']> = [];
  let content = '';
  for (const [index, item] of output.entries()) {
    if (item.type === 'function_call') {
      toolCalls.push({
        index,
        id: item.call_id,
        name: item.name,
        arguments: item.arguments || (raw.status === 'incomplete' ? '' : '{}'),
      });
    } else if (item.type === 'message') {
      for (const part of item.content)
        content += part.type === 'output_text' ? part.text : part.refusal;
    }
  }
  return {
    content,
    raw,
    finishReason: finishReason(raw.status, toolCalls.length > 0),
    providerOutput: providerOutput(output),
    ...(raw.usage ? { usage: normalizedUsage(raw.usage) } : {}),
    ...(toolCalls.length ? { toolCalls } : {}),
  };
}

export class OpenAIResponsesStreamMapper {
  private readonly items = new Map<number, OutputItem>();
  private readonly calls = new Set<number>();
  private readonly argumentsSent = new Map<number, number>();

  private argumentsChunk(index: number, delta: string): LLMResponse {
    this.argumentsSent.set(
      index,
      (this.argumentsSent.get(index) ?? 0) + delta.length,
    );
    return { content: '', toolCalls: [{ index, arguments: delta }] };
  }

  private *functionCall(
    index: number,
    item: FunctionCall,
    done: boolean,
  ): Iterable<LLMResponse> {
    if (!this.calls.has(index)) {
      this.calls.add(index);
      yield {
        content: '',
        toolCalls: [{ index, id: item.call_id, name: item.name }],
      };
    }
    const args =
      item.arguments || (done && item.status !== 'incomplete' ? '{}' : '');
    const remaining = args.slice(this.argumentsSent.get(index) ?? 0);
    if (remaining) yield this.argumentsChunk(index, remaining);
  }

  *map(event: OpenAIResponseEvent): Iterable<LLMResponse> {
    switch (event.type) {
      case 'response.output_text.delta':
      case 'response.refusal.delta':
        yield { content: event.delta };
        break;
      case 'response.output_item.added':
      case 'response.output_item.done':
        if (event.type === 'response.output_item.done')
          this.items.set(event.output_index, event.item);
        if (event.item.type === 'function_call')
          yield* this.functionCall(
            event.output_index,
            event.item,
            event.type === 'response.output_item.done',
          );
        break;
      case 'response.function_call_arguments.delta':
        if (event.delta)
          yield this.argumentsChunk(event.output_index, event.delta);
        break;
      case 'response.function_call_arguments.done': {
        const remaining = event.arguments.slice(
          this.argumentsSent.get(event.output_index) ?? 0,
        );
        if (remaining) yield this.argumentsChunk(event.output_index, remaining);
        break;
      }
      case 'response.completed':
      case 'response.incomplete': {
        const { response } = event;
        for (const [index, item] of response.output?.entries() ?? []) {
          const done = this.items.get(index);
          if (done?.type !== 'reasoning' || !done.encrypted_content)
            this.items.set(index, item);
        }
        const entries = [...this.items].sort(([a], [b]) => a - b);
        for (const [index, item] of entries) {
          if (item.type === 'function_call')
            yield* this.functionCall(index, item, true);
        }
        yield {
          content: '',
          finishReason: finishReason(
            event.type === 'response.incomplete'
              ? 'incomplete'
              : response.status,
            this.calls.size > 0,
          ),
          providerOutput: providerOutput(entries.map(([, item]) => item)),
          ...(response.usage ? { usage: normalizedUsage(response.usage) } : {}),
          raw: event,
        };
        break;
      }
    }
  }
}
