/**
 * OpenAI Agent - Uses OpenAI function calling for tool integration
 *
 * OpenAI supports function calling via the `tools` parameter in chat completions.
 * Tools are passed as JSON schema, and LLM returns function calls in response.
 */

import type { OpenAIConfig, OpenAIProvider } from '../llm-providers/openai.js';
import type { AgentStreamChunk, Message } from '../types.js';
import { BaseAgent, type BaseAgentConfig } from './base.js';

export interface OpenAIAgentConfig extends BaseAgentConfig {
  llmProvider: OpenAIProvider;
}

export class OpenAIAgent extends BaseAgent {
  private llmProvider: OpenAIProvider;

  constructor(config: OpenAIAgentConfig) {
    super(config);
    this.llmProvider = config.llmProvider;
  }

  /**
   * Call OpenAI with tools using function calling
   */
  protected async callLLMWithTools(
    messages: Message[],
    tools: any[],
  ): Promise<{ content: string; raw?: unknown }> {
    // Convert MCP tools to OpenAI function format
    const functions = this.convertToolsToOpenAIFunctions(tools);

    // Format messages for OpenAI
    const formattedMessages = this.formatMessagesForOpenAI(messages);

    // Access OpenAI client and config
    const openaiProvider = this.llmProvider as any;
    const client = openaiProvider.client;
    const model = openaiProvider.model;
    const config = openaiProvider.config;

    // Call OpenAI API with tools
    const response = await client.post('/chat/completions', {
      model,
      messages: formattedMessages,
      tools: functions.length > 0 ? functions : undefined,
      tool_choice: functions.length > 0 ? 'auto' : undefined,
      temperature: config.temperature || 0.7,
      max_tokens: config.maxTokens || 2000,
    });

    const choice = response.data.choices[0];
    const message = choice.message;

    return {
      content: message.content || '',
      raw: response.data,
    };
  }

  /**
   * Convert MCP tools to OpenAI function format
   */
  private convertToolsToOpenAIFunctions(tools: any[]): any[] {
    return tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description || '',
        parameters: tool.inputSchema || {
          type: 'object',
          properties: {},
        },
      },
    }));
  }

  /**
   * Format messages for OpenAI API
   */
  private formatMessagesForOpenAI(messages: Message[]): any[] {
    return messages.map((msg) => ({
      role: msg.role,
      content: msg.content || null, // OpenAI requires null if empty
    }));
  }

  /**
   * Stream LLM response with tools via fetch + SSE parsing.
   * Yields typed AgentStreamChunk objects; always ends with { type: 'done' }.
   */
  protected async *streamLLMWithTools(
    messages: Message[],
    tools: any[],
  ): AsyncGenerator<AgentStreamChunk, void, unknown> {
    const functions = this.convertToolsToOpenAIFunctions(tools);
    const formattedMessages = this.formatMessagesForOpenAI(messages);

    // biome-ignore lint/suspicious/noExplicitAny: accessing private provider fields
    const provider = this.llmProvider as any;
    const baseURL: string = provider.config.baseURL ?? 'https://api.openai.com/v1';
    const apiKey: string = provider.config.apiKey;
    const model: string = provider.model;
    const temperature: number = provider.config.temperature ?? 0.7;
    const maxTokens: number = provider.config.maxTokens ?? 2000;

    const res = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: formattedMessages,
        tools: functions.length > 0 ? functions : undefined,
        tool_choice: functions.length > 0 ? 'auto' : undefined,
        temperature,
        max_tokens: maxTokens,
        stream: true,
        stream_options: { include_usage: true },
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OpenAI streaming error: HTTP ${res.status} — ${text}`);
    }
    if (!res.body) throw new Error('OpenAI streaming error: no response body');

    // index → accumulated tool call
    const toolCallMap = new Map<number, { id: string; name: string; arguments: string }>();
    let finishReason: 'stop' | 'tool_calls' | 'length' | 'error' = 'stop';

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data: ')) continue;

          const data = trimmed.slice(6);
          if (data === '[DONE]') continue;

          // biome-ignore lint/suspicious/noExplicitAny: raw SSE JSON has no stable type
          let chunk: any;
          try {
            chunk = JSON.parse(data);
          } catch {
            continue;
          }

          // usage-only chunk: choices is empty array
          if (Array.isArray(chunk.choices) && chunk.choices.length === 0) {
            const u = chunk.usage;
            if (u) {
              yield {
                type: 'usage',
                promptTokens: (u.prompt_tokens as number) ?? 0,
                completionTokens: (u.completion_tokens as number) ?? 0,
              };
            }
            continue;
          }

          const choice = chunk.choices?.[0];
          if (!choice) continue;
          const delta = choice.delta ?? {};

          // text token
          if (typeof delta.content === 'string' && delta.content.length > 0) {
            yield { type: 'text', delta: delta.content };
          }

          // tool call deltas — accumulate by index
          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const idx: number = tc.index;
              if (!toolCallMap.has(idx)) {
                toolCallMap.set(idx, { id: tc.id ?? '', name: tc.function?.name ?? '', arguments: '' });
              }
              if (tc.function?.arguments) {
                toolCallMap.get(idx)!.arguments += tc.function.arguments as string;
              }
            }
          }

          // finish_reason arrives in a separate empty-delta chunk
          if (choice.finish_reason) {
            finishReason =
              choice.finish_reason === 'tool_calls' ? 'tool_calls'
              : choice.finish_reason === 'length' ? 'length'
              : 'stop';
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    // flush accumulated tool calls before done
    if (toolCallMap.size > 0) {
      const toolCalls = [...toolCallMap.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, tc]) => ({
          id: tc.id,
          name: tc.name,
          arguments: (() => {
            try { return JSON.parse(tc.arguments) as Record<string, unknown>; } catch { return {}; }
          })(),
        }));
      yield { type: 'tool_calls', toolCalls };
    }

    yield { type: 'done', finishReason };
  }
}
