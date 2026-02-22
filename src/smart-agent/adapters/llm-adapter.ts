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
 * Extracts tool calls from the raw provider response.
 *
 * OpenAI / DeepSeek: raw.choices[0].message.tool_calls
 * Anthropic:         raw.content[].type === 'tool_use'
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
      raw: providerRaw,
    };
  }

  return { content: raw.content, finishReason: 'stop', raw: providerRaw };
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
        (this.agent as any).callLLMWithTools(messages, mcpTools) as Promise<{
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
}
