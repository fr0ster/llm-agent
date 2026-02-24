/**
 * Base Agent - Abstract class for LLM-specific agent implementations
 *
 * Each LLM provider has different ways of handling tools:
 * - OpenAI: function calling via tools parameter
 * - Anthropic: tools in messages
 * - DeepSeek: function calling or prompt-based
 *
 * This base class provides common logic, subclasses implement LLM-specific tool handling.
 */

import type { LLMProvider } from '../llm-providers/base.js';
import { type MCPClientConfig, MCPClientWrapper } from '../mcp/client.js';
import type { AgentResponse, AgentStreamChunk, Message } from '../types.js';

export interface BaseAgentConfig {
  /**
   * MCP client instance (if provided, will be used directly)
   * If not provided, will be created from mcpConfig
   */
  mcpClient?: MCPClientWrapper;
  /**
   * Direct MCP configuration (used if mcpClient is not provided)
   */
  mcpConfig?: MCPClientConfig;
  /**
   * Reserved for future auto tool execution loops (currently unused).
   */
  maxIterations?: number;
}

/**
 * Base Agent class - provides common logic for all agent implementations
 */
export abstract class BaseAgent {
  protected mcpClient: MCPClientWrapper;
  protected conversationHistory: Message[] = [];
  protected tools: any[] = [];

  constructor(config: BaseAgentConfig) {
    // Initialize MCP client
    if (config.mcpClient) {
      this.mcpClient = config.mcpClient;
    } else if (config.mcpConfig) {
      this.mcpClient = new MCPClientWrapper(config.mcpConfig);
    } else {
      throw new Error(
        'MCP client configuration required. Provide either mcpClient or mcpConfig.',
      );
    }
  }

  /**
   * Initialize MCP client connection (call this before using the agent)
   * If connection fails, agent will work in LLM-only mode (no tools)
   */
  async connect(): Promise<void> {
    try {
      await this.mcpClient.connect();
      // Load tools once connected
      this.tools = await this.mcpClient.listTools();
    } catch (error: any) {
      // If connection fails, agent will work without tools (LLM-only mode)
      // Set empty tools array to ensure agent can still process messages
      this.tools = [];
      // Re-throw to let caller know connection failed
      // Caller can decide whether to continue or fail
      throw error;
    }
  }

  /**
   * Process a user message and return agent response
   * Subclasses handle provider-specific tool formatting only.
   * Tool execution is left to the consumer of this library.
   */
  async process(userMessage: string): Promise<AgentResponse> {
    try {
      // Add user message to history
      this.conversationHistory.push({
        role: 'user',
        content: userMessage,
      });

      // Get LLM response with tools (LLM-specific implementation)
      const llmResponse = await this.callLLMWithTools(
        this.conversationHistory,
        this.tools,
      );

      this.conversationHistory.push({
        role: 'assistant',
        content: llmResponse.content,
      });

      return {
        message: llmResponse.content,
        raw: llmResponse.raw,
      };
    } catch (error: any) {
      return {
        message: '',
        error: error.message || 'Agent processing failed',
      };
    }
  }

  /**
   * Call LLM with tools - LLM-specific implementation
   * Subclasses must implement this to handle their specific tool format
   */
  protected abstract callLLMWithTools(
    messages: Message[],
    tools: any[],
  ): Promise<{ content: string; raw?: unknown }>;

  /**
   * Stream LLM response with tools.
   * Optional — subclasses that support HTTP-level streaming implement this.
   * Yields typed chunks; always ends with a { type: 'done' } chunk.
   */
  protected streamLLMWithTools?(
    messages: Message[],
    tools: any[],
  ): AsyncGenerator<AgentStreamChunk, void, unknown>;

  /**
   * Shared SSE parser for OpenAI-compatible streaming endpoints.
   * Handles text deltas, tool call accumulation, usage chunk, and [DONE] sentinel.
   * Used by OpenAIAgent and DeepSeekAgent (identical wire format).
   */
  protected async *streamOpenAICompatible(
    url: string,
    headers: Record<string, string>,
    // biome-ignore lint/suspicious/noExplicitAny: request body has no stable type
    body: Record<string, any>,
  ): AsyncGenerator<AgentStreamChunk, void, unknown> {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`LLM streaming error: HTTP ${res.status} — ${text}`);
    }
    if (!res.body) throw new Error('LLM streaming error: no response body');

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
          try { chunk = JSON.parse(data); } catch { continue; }

          // usage-only chunk — choices is empty array
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

  /**
   * SSE parser for Anthropic streaming (`POST /messages`).
   *
   * Anthropic SSE uses named events:
   *   event: content_block_start | content_block_delta | message_delta | message_stop | ping
   *   data: { type, ... }
   *
   * Text arrives as content_block_delta / text_delta.
   * Tool input arrives as content_block_delta / input_json_delta — accumulated by block index.
   * Usage and stop_reason arrive in message_start + message_delta.
   */
  protected async *streamAnthropicCompatible(
    url: string,
    headers: Record<string, string>,
    // biome-ignore lint/suspicious/noExplicitAny: request body has no stable type
    body: Record<string, any>,
  ): AsyncGenerator<AgentStreamChunk, void, unknown> {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Anthropic streaming error: HTTP ${res.status} — ${text}`);
    }
    if (!res.body) throw new Error('Anthropic streaming error: no response body');

    // block index → tool accumulator
    const toolBlocks = new Map<number, { id: string; name: string; partialJson: string }>();
    const textIndexes = new Set<number>();
    let inputTokens = 0;
    let outputTokens = 0;
    let finishReason: 'stop' | 'tool_calls' | 'length' | 'error' = 'stop';

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let currentEvent = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();

          if (trimmed.startsWith('event: ')) {
            currentEvent = trimmed.slice(7);
            continue;
          }

          if (!trimmed.startsWith('data: ')) continue;

          // biome-ignore lint/suspicious/noExplicitAny: raw SSE JSON has no stable type
          let evt: any;
          try { evt = JSON.parse(trimmed.slice(6)); } catch { continue; }

          if (currentEvent === 'message_start') {
            inputTokens = (evt.message?.usage?.input_tokens as number) ?? 0;
            continue;
          }

          if (currentEvent === 'content_block_start') {
            const idx: number = evt.index;
            const block = evt.content_block;
            if (block?.type === 'tool_use') {
              toolBlocks.set(idx, { id: block.id ?? '', name: block.name ?? '', partialJson: '' });
            } else if (block?.type === 'text') {
              textIndexes.add(idx);
            }
            continue;
          }

          if (currentEvent === 'content_block_delta') {
            const idx: number = evt.index;
            const delta = evt.delta;
            if (delta?.type === 'text_delta' && typeof delta.text === 'string' && delta.text.length > 0) {
              yield { type: 'text', delta: delta.text };
            } else if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
              const tool = toolBlocks.get(idx);
              if (tool) tool.partialJson += delta.partial_json;
            }
            continue;
          }

          if (currentEvent === 'message_delta') {
            outputTokens = (evt.usage?.output_tokens as number) ?? 0;
            const stopReason: string = evt.delta?.stop_reason ?? '';
            finishReason =
              stopReason === 'tool_use' ? 'tool_calls'
              : stopReason === 'max_tokens' ? 'length'
              : 'stop';
            continue;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    if (inputTokens > 0 || outputTokens > 0) {
      yield { type: 'usage', promptTokens: inputTokens, completionTokens: outputTokens };
    }

    if (toolBlocks.size > 0) {
      const toolCalls = [...toolBlocks.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, tc]) => ({
          id: tc.id,
          name: tc.name,
          arguments: (() => {
            try { return JSON.parse(tc.partialJson) as Record<string, unknown>; } catch { return {}; }
          })(),
        }));
      yield { type: 'tool_calls', toolCalls };
    }

    yield { type: 'done', finishReason };
  }

  /**
   * Clear conversation history
   */
  clearHistory(): void {
    this.conversationHistory = [];
  }

  /**
   * Get conversation history
   */
  getHistory(): Message[] {
    return [...this.conversationHistory];
  }
}
