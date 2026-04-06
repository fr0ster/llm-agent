/**
 * SAP AI Core Direct Agent — extends BaseAgent using SapAiCoreDirectProvider
 *
 * Sends OpenAI-compatible HTTP requests directly to SAP AI Core deployment
 * endpoints, bypassing OrchestrationClient overhead.
 * Supports native tool calling and streaming.
 */

import type { SapAiCoreDirectProvider } from '../llm-providers/sap-ai-core-direct.js';
import type { AgentStreamChunk, Message } from '../types.js';
import {
  type AgentCallOptions,
  BaseAgent,
  type BaseAgentConfig,
} from './base.js';

export interface SapAiCoreDirectAgentConfig extends BaseAgentConfig {
  llmProvider: SapAiCoreDirectProvider;
}

export class SapAiCoreDirectAgent extends BaseAgent {
  private llmProvider: SapAiCoreDirectProvider;

  constructor(config: SapAiCoreDirectAgentConfig) {
    super(config);
    this.llmProvider = config.llmProvider;
  }

  protected async callLLMWithTools(
    messages: Message[],
    tools: unknown[],
    options?: AgentCallOptions,
  ): Promise<{ content: string; raw?: unknown }> {
    const functions = this.convertToolsToFunctions(tools);

    if (options?.model) {
      this.llmProvider.setModelOverride(options.model);
    }

    const response = await this.llmProvider.chat(
      messages,
      functions.length > 0 ? functions : undefined,
    );

    return {
      content: response.content,
      raw: response.raw,
    };
  }

  protected async *streamLLMWithTools(
    messages: Message[],
    tools: unknown[],
    options?: AgentCallOptions,
  ): AsyncGenerator<AgentStreamChunk, void, unknown> {
    const functions = this.convertToolsToFunctions(tools);

    if (options?.model) {
      this.llmProvider.setModelOverride(options.model);
    }

    const toolCallMap = new Map<
      number,
      { id: string; name: string; arguments: string }
    >();
    let finishReason: 'stop' | 'tool_calls' | 'length' | 'error' = 'stop';

    for await (const chunk of this.llmProvider.streamChat(
      messages,
      functions.length > 0 ? functions : undefined,
    )) {
      if (chunk.content) {
        yield { type: 'text', delta: chunk.content };
      }

      // Accumulate tool call deltas and usage from raw OpenAI-compatible chunk
      if (chunk.raw && typeof chunk.raw === 'object') {
        // biome-ignore lint/suspicious/noExplicitAny: raw provider payload has no stable type
        const raw = chunk.raw as any;

        // Usage-only chunk (stream_options: include_usage)
        if (raw.usage && !raw.choices?.[0]?.delta) {
          yield {
            type: 'usage',
            promptTokens: (raw.usage.prompt_tokens as number) ?? 0,
            completionTokens: (raw.usage.completion_tokens as number) ?? 0,
          };
        }

        const delta = raw.choices?.[0]?.delta;
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
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
}
