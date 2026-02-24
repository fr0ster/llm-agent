/**
 * LlmAdapter — wraps BaseAgent as ILlm.
 *
 * NOTE: callLLMWithTools() is protected on BaseAgent, so we access it via
 * `(this.agent as any).callLLMWithTools(...)`. This is intentional technical
 * debt: Phase 2 adapts existing code without modifying it. A future phase can
 * make the method public or extract it to a separate interface.
 */

import type { BaseAgent } from '../../agents/base.js';
import type { Message } from '../../types.js';
import type { ILlm } from '../interfaces/llm.js';
import {
  type CallOptions,
  LlmError,
  type LlmResponse,
  type LlmStreamChunk,
  type LlmTool,
  type LlmToolCall,
  type Result,
  type SmartAgentError,
} from '../interfaces/types.js';

// ---------------------------------------------------------------------------
// Module-private helper
// ---------------------------------------------------------------------------

function withAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  makeError: () => SmartAgentError,
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(makeError());
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      signal.addEventListener('abort', () => reject(makeError()), {
        once: true,
      });
    }),
  ]);
}

// ---------------------------------------------------------------------------
// parseProviderResponse
// ---------------------------------------------------------------------------

/**
 * Extracts tool calls and usage from the raw provider response.
 *
 * OpenAI / DeepSeek: raw.choices[0].message.tool_calls, raw.usage
 * Anthropic:         raw.content[].type === 'tool_use', raw.usage
 */
function parseProviderResponse(raw: {
  content: string;
  raw?: unknown;
}): LlmResponse {
  // biome-ignore lint/suspicious/noExplicitAny: raw provider payload has no stable type
  const providerRaw = raw.raw as any;

  if (!providerRaw) {
    return { content: raw.content, finishReason: 'stop' };
  }

  const toolCalls: LlmToolCall[] = [];
  let usage: LlmResponse['usage'] = undefined;

  // Extract usage
  if (providerRaw.usage) {
    usage = {
      promptTokens:
        providerRaw.usage.prompt_tokens ??
        providerRaw.usage.input_tokens ??
        0,
      completionTokens:
        providerRaw.usage.completion_tokens ??
        providerRaw.usage.output_tokens ??
        0,
      totalTokens: providerRaw.usage.total_tokens ?? 0,
    };
    if (usage.totalTokens === 0) {
      usage.totalTokens = usage.promptTokens + usage.completionTokens;
    }
  }

  // OpenAI / DeepSeek format
  if (providerRaw.choices?.[0]?.message?.tool_calls) {
    for (const tc of providerRaw.choices[0].message.tool_calls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.function.arguments);
      } catch {
        args = {};
      }
      toolCalls.push({ id: tc.id, name: tc.function.name, arguments: args });
    }

    return {
      content: raw.content,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
      usage,
      raw: providerRaw,
    };
  }

  // Anthropic format
  if (Array.isArray(providerRaw.content)) {
    for (const block of providerRaw.content) {
      if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          name: block.name,
          arguments: block.input ?? {},
        });
      }
    }

    return {
      content: raw.content,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      finishReason:
        providerRaw.stop_reason === 'tool_use' ? 'tool_calls' : 'stop',
      usage,
      raw: providerRaw,
    };
  }

  return {
    content: raw.content,
    finishReason: 'stop',
    usage,
    raw: providerRaw,
  };
}

/**
 * parseStreamChunk
 *
 * Extracts content delta and other info from a stream chunk.
 */
function parseStreamChunk(raw: {
  content: string;
  raw?: unknown;
}): LlmStreamChunk {
  // biome-ignore lint/suspicious/noExplicitAny: raw provider payload has no stable type
  const providerRaw = raw.raw as any;

  if (!providerRaw) {
    return { content: raw.content };
  }

  // OpenAI / DeepSeek format for chunks
  if (providerRaw.choices?.[0]?.delta) {
    const delta = providerRaw.choices[0].delta;
    const toolCalls: any[] = [];

    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        toolCalls.push({
          index: tc.index,
          id: tc.id,
          name: tc.function?.name,
          arguments: tc.function?.arguments,
        });
      }
    }

    return {
      content: delta.content || '',
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      finishReason: providerRaw.choices[0].finish_reason || undefined,
    };
  }

  return { content: raw.content };
}

// ---------------------------------------------------------------------------
// LlmAdapter
// ---------------------------------------------------------------------------

export class LlmAdapter implements ILlm {
  constructor(private readonly agent: BaseAgent) {}

  async chat(
    messages: Message[],
    tools?: LlmTool[],
    options?: CallOptions,
  ): Promise<Result<LlmResponse, LlmError>> {
    try {
      const mcpTools =
        tools?.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })) ?? [];

      // callLLMWithTools is protected; accessing via type assertion is
      // documented technical debt — see class-level note above.
      const raw = await withAbort(
        // biome-ignore lint/suspicious/noExplicitAny: intentional protected-access workaround
        (this.agent as any).callLLMWithTools(messages, mcpTools, options) as Promise<{
          content: string;
          raw?: unknown;
        }>,
        options?.signal,
        () => new LlmError('Aborted', 'ABORTED'),
      );

      return { ok: true, value: parseProviderResponse(raw) };
    } catch (err) {
      if (err instanceof LlmError) return { ok: false, error: err };
      return { ok: false, error: new LlmError(String(err)) };
    }
  }

  async *streamChat(
    messages: Message[],
    tools?: LlmTool[],
    options?: CallOptions,
  ): AsyncIterable<Result<LlmStreamChunk, LlmError>> {
    try {
      const mcpTools =
        tools?.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })) ?? [];

      // streamLLMWithTools is protected
      // biome-ignore lint/suspicious/noExplicitAny: intentional protected-access workaround
      const stream = (this.agent as any).streamLLMWithTools(
        messages,
        mcpTools,
        options,
      ) as AsyncIterable<{
        content: string;
        raw?: unknown;
      }>;

      for await (const chunk of stream) {
        if (options?.signal?.aborted) {
          throw new LlmError('Aborted', 'ABORTED');
        }
        yield { ok: true, value: parseStreamChunk(chunk) };
      }
    } catch (err) {
      if (err instanceof LlmError) yield { ok: false, error: err };
      else yield { ok: false, error: new LlmError(String(err)) };
    }
  }
}
