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
}

export interface AgentCallOptions {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  stop?: string[];
}

export interface BaseAgentLlmBridge {
  callWithTools(
    messages: Message[],
    tools: unknown[],
    options?: AgentCallOptions,
  ): Promise<{ content: string; raw?: unknown }>;
  streamWithTools(
    messages: Message[],
    tools: unknown[],
    options?: AgentCallOptions,
  ): AsyncGenerator<AgentStreamChunk, void, unknown>;
}

/**
 * Base Agent class - provides common logic for all agent implementations
 */
export abstract class BaseAgent implements BaseAgentLlmBridge {
  protected mcpClient: MCPClientWrapper;
  protected conversationHistory: Message[] = [];
  protected tools: unknown[] = [];

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
    } catch (error: unknown) {
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
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return {
        message: '',
        error: errorMessage || 'Agent processing failed',
      };
    }
  }

  /**
   * Call LLM with tools - LLM-specific implementation
   * Subclasses must implement this to handle their specific tool format
   */
  protected abstract callLLMWithTools(
    messages: Message[],
    tools: unknown[],
    options?: AgentCallOptions,
  ): Promise<{ content: string; raw?: unknown }>;

  /**
   * Stream LLM with tools - LLM-specific implementation
   */
  protected abstract streamLLMWithTools(
    messages: Message[],
    tools: unknown[],
    options?: AgentCallOptions,
  ): AsyncGenerator<AgentStreamChunk, void, unknown>;

  /**
   * Public typed bridge for adapter layer. Keeps provider-specific logic in
   * protected methods while removing adapter-side `any` access.
   */
  async callWithTools(
    messages: Message[],
    tools: unknown[],
    options?: AgentCallOptions,
  ): Promise<{ content: string; raw?: unknown }> {
    return this.callLLMWithTools(messages, tools, options);
  }

  /**
   * Public typed bridge for streaming adapter layer.
   */
  streamWithTools(
    messages: Message[],
    tools: unknown[],
    options?: AgentCallOptions,
  ): AsyncGenerator<AgentStreamChunk, void, unknown> {
    return this.streamLLMWithTools(messages, tools, options);
  }

  /**
   * Shared SSE parser for OpenAI-compatible streaming endpoints.
   * Handles text deltas, tool call accumulation, usage chunks, and done.
   */
  protected async *streamOpenAICompatible(
    url: string,
    headers: Record<string, string>,
    body: Record<string, unknown>,
  ): AsyncGenerator<AgentStreamChunk, void, unknown> {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`LLM streaming error: HTTP ${res.status} - ${text}`);
    }

    if (!res.body) {
      throw new Error('LLM streaming error: no response body');
    }

    const toolCallMap = new Map<
      number,
      { id: string; name: string; arguments: string }
    >();
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

          let chunk: Record<string, unknown>;
          try {
            chunk = JSON.parse(data);
          } catch {
            continue;
          }

          // Extract usage from any chunk that carries it (OpenAI sends it
          // in a separate empty-choices chunk, DeepSeek may include it
          // alongside the last choice).
          const chunkUsage = chunk.usage as
            | { prompt_tokens?: number; completion_tokens?: number }
            | undefined;
          if (chunkUsage) {
            yield {
              type: 'usage',
              promptTokens: (chunkUsage.prompt_tokens as number) ?? 0,
              completionTokens: (chunkUsage.completion_tokens as number) ?? 0,
            };
          }

          if (Array.isArray(chunk.choices) && chunk.choices.length === 0) {
            continue;
          }

          const choice = (
            chunk.choices as Array<Record<string, unknown>>
          )?.[0] as
            | {
                delta?: Record<string, unknown>;
                finish_reason?: string;
              }
            | undefined;
          if (!choice) continue;
          const delta = choice.delta ?? {};

          if (typeof delta.content === 'string' && delta.content.length > 0) {
            yield { type: 'text', delta: delta.content };
          }

          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls as Array<{
              index: number;
              id?: string;
              function?: { name?: string; arguments?: string };
            }>) {
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

          if (choice.finish_reason) {
            finishReason =
              choice.finish_reason === 'tool_calls'
                ? 'tool_calls'
                : choice.finish_reason === 'length'
                  ? 'length'
                  : choice.finish_reason === 'error'
                    ? 'error'
                    : 'stop';
          }
        }
      }
    } finally {
      reader.releaseLock();
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
    }

    yield { type: 'done', finishReason };
  }

  /**
   * SSE parser for Anthropic streaming endpoints.
   * Handles named events (message_start, content_block_delta, etc.),
   * text deltas, tool input accumulation, usage, and done.
   */
  protected async *streamAnthropicSSE(
    url: string,
    headers: Record<string, string>,
    body: Record<string, unknown>,
  ): AsyncGenerator<AgentStreamChunk, void, unknown> {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`LLM streaming error: HTTP ${res.status} - ${text}`);
    }

    if (!res.body) {
      throw new Error('LLM streaming error: no response body');
    }

    const toolCallMap = new Map<
      number,
      { id: string; name: string; argumentsJson: string }
    >();
    let promptTokens = 0;
    let completionTokens = 0;
    let finishReason: 'stop' | 'tool_calls' | 'length' | 'error' = 'stop';
    let currentEvent = '';

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

          if (trimmed.startsWith('event: ')) {
            currentEvent = trimmed.slice(7);
            continue;
          }

          if (!trimmed.startsWith('data: ')) continue;

          const data = trimmed.slice(6);
          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(data);
          } catch {
            continue;
          }

          switch (currentEvent) {
            case 'message_start': {
              const message = parsed.message as
                | { usage?: { input_tokens?: number } }
                | undefined;
              promptTokens = message?.usage?.input_tokens ?? 0;
              break;
            }

            case 'content_block_start': {
              const contentBlock = parsed.content_block as
                | { type?: string; id?: string; name?: string }
                | undefined;
              if (contentBlock?.type === 'tool_use') {
                const index = (parsed.index as number) ?? 0;
                toolCallMap.set(index, {
                  id: contentBlock.id ?? '',
                  name: contentBlock.name ?? '',
                  argumentsJson: '',
                });
              }
              break;
            }

            case 'content_block_delta': {
              const delta = parsed.delta as
                | { type?: string; text?: string; partial_json?: string }
                | undefined;
              if (delta?.type === 'text_delta' && delta.text) {
                yield { type: 'text', delta: delta.text };
              } else if (delta?.type === 'input_json_delta') {
                const index = (parsed.index as number) ?? 0;
                const accumulated = toolCallMap.get(index);
                if (accumulated && delta.partial_json) {
                  accumulated.argumentsJson += delta.partial_json;
                }
              }
              break;
            }

            case 'message_delta': {
              const delta = parsed.delta as
                | { stop_reason?: string }
                | undefined;
              const usage = parsed.usage as
                | { output_tokens?: number }
                | undefined;
              completionTokens = usage?.output_tokens ?? 0;
              if (delta?.stop_reason) {
                finishReason =
                  delta.stop_reason === 'tool_use'
                    ? 'tool_calls'
                    : delta.stop_reason === 'max_tokens'
                      ? 'length'
                      : 'stop';
              }
              break;
            }

            case 'error': {
              const error = parsed.error as
                | { type?: string; message?: string }
                | undefined;
              throw new Error(
                `Anthropic stream error: ${error?.message ?? 'unknown'}`,
              );
            }
          }

          currentEvent = '';
        }
      }
    } finally {
      reader.releaseLock();
    }

    yield { type: 'usage', promptTokens, completionTokens };

    if (toolCallMap.size > 0) {
      const toolCalls = [...toolCallMap.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, tc]) => ({
          id: tc.id,
          name: tc.name,
          arguments: (() => {
            try {
              return JSON.parse(tc.argumentsJson) as Record<string, unknown>;
            } catch {
              return {};
            }
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
