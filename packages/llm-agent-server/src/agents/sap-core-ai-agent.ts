/**
 * SAP Core AI Agent — extends BaseAgent with native function calling
 *
 * Uses @sap-ai-sdk/orchestration via SapCoreAIProvider for LLM access.
 * Supports native tool calling (OpenAI function format) and streaming.
 *
 * All LLM providers are accessed through SAP AI Core:
 * - OpenAI models → SAP AI Core → OpenAI
 * - Anthropic models → SAP AI Core → Anthropic
 * - DeepSeek models → SAP AI Core → DeepSeek
 */

import type { AgentStreamChunk, Message } from '@mcp-abap-adt/llm-agent';
import type { SapCoreAIProvider } from '@mcp-abap-adt/sap-aicore-llm';
import {
  type AgentCallOptions,
  BaseAgent,
  type BaseAgentConfig,
} from './base.js';

export interface SapCoreAIAgentConfig extends BaseAgentConfig {
  llmProvider: SapCoreAIProvider;
}

export class SapCoreAIAgent extends BaseAgent {
  private llmProvider: SapCoreAIProvider;

  constructor(config: SapCoreAIAgentConfig) {
    super(config);
    this.llmProvider = config.llmProvider;
  }

  /**
   * Call SAP AI SDK with tools using native function calling.
   */
  protected async callLLMWithTools(
    messages: Message[],
    tools: unknown[],
    options?: AgentCallOptions,
  ): Promise<{ content: string; raw?: unknown }> {
    const functions = this.convertToolsToFunctions(tools);
    const formattedMessages = this.formatMessages(messages);

    if (options?.model) {
      this.llmProvider.setModelOverride(options.model);
    }

    const response = await this.llmProvider.chat(
      formattedMessages,
      functions.length > 0 ? functions : undefined,
    );

    return {
      content: response.content,
      raw: response.raw,
    };
  }

  /**
   * Stream SAP AI SDK response with tool calling support.
   */
  protected async *streamLLMWithTools(
    messages: Message[],
    tools: unknown[],
    options?: AgentCallOptions,
  ): AsyncGenerator<AgentStreamChunk, void, unknown> {
    const functions = this.convertToolsToFunctions(tools);
    const formattedMessages = this.formatMessages(messages);

    if (options?.model) {
      this.llmProvider.setModelOverride(options.model);
    }

    const toolCallMap = new Map<
      number,
      { id: string; name: string; arguments: string }
    >();
    let finishReason: 'stop' | 'tool_calls' | 'length' | 'error' = 'stop';

    for await (const chunk of this.llmProvider.streamChat(
      formattedMessages,
      functions.length > 0 ? functions : undefined,
    )) {
      // Yield text deltas
      if (chunk.content) {
        yield { type: 'text', delta: chunk.content };
      }

      // Accumulate tool call deltas from the raw SDK chunk
      if (chunk.raw && typeof chunk.raw === 'object') {
        // biome-ignore lint/suspicious/noExplicitAny: raw SDK chunk type varies
        const sdkChunk = chunk.raw as any;
        if (typeof sdkChunk.getDeltaToolCalls === 'function') {
          const toolDeltas = sdkChunk.getDeltaToolCalls();
          if (Array.isArray(toolDeltas)) {
            for (const tc of toolDeltas) {
              const index = tc.index as number;
              if (!toolCallMap.has(index)) {
                toolCallMap.set(index, {
                  id: tc.id ?? '',
                  name: tc.function?.name ?? '',
                  arguments: '',
                });
              }
              if (tc.function?.arguments) {
                const accumulated = toolCallMap.get(index);
                if (accumulated) {
                  accumulated.arguments += tc.function.arguments as string;
                }
              }
            }
          }
        }

        // Extract usage from chunk
        if (typeof sdkChunk.getTokenUsage === 'function') {
          const usage = sdkChunk.getTokenUsage();
          if (usage) {
            yield {
              type: 'usage',
              promptTokens: (usage.prompt_tokens as number) ?? 0,
              completionTokens: (usage.completion_tokens as number) ?? 0,
            };
          }
        }
      }

      // Track finish reason
      if (chunk.finishReason) {
        finishReason =
          chunk.finishReason === 'tool_calls'
            ? 'tool_calls'
            : chunk.finishReason === 'length'
              ? 'length'
              : chunk.finishReason === 'error'
                ? 'error'
                : 'stop';
      }
    }

    // Emit accumulated tool calls
    if (toolCallMap.size > 0) {
      const toolCalls = [...toolCallMap.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, tc]) => ({
          id: tc.id,
          name: tc.name,
          arguments: (() => {
            try {
              return JSON.parse(tc.arguments) as Record<string, unknown>;
            } catch {
              return {};
            }
          })(),
        }));
      yield { type: 'tool_calls', toolCalls };
      finishReason = 'tool_calls';
    }

    yield { type: 'done', finishReason };
  }

  /**
   * Convert MCP tools to OpenAI function format.
   */
  private convertToolsToFunctions(
    tools: unknown[],
  ): Array<Record<string, unknown>> {
    return tools.map((rawTool) => {
      const tool = rawTool as {
        name?: string;
        description?: string;
        inputSchema?: Record<string, unknown>;
      };
      return {
        type: 'function',
        function: {
          name: tool.name ?? '',
          description: tool.description || '',
          parameters: tool.inputSchema || {
            type: 'object',
            properties: {},
          },
        },
      };
    });
  }

  /**
   * Format messages for the SAP AI SDK (OpenAI-compatible format).
   */
  private formatMessages(messages: Message[]): Message[] {
    return messages.map((msg) => ({
      role: msg.role,
      content: msg.tool_calls?.length ? null : (msg.content ?? null),
      ...(msg.tool_calls ? { tool_calls: msg.tool_calls } : {}),
      ...(msg.tool_call_id ? { tool_call_id: msg.tool_call_id } : {}),
    }));
  }
}
