/**
 * Prompt-Based Agent - Uses prompt description for tools (fallback for LLMs without function calling)
 *
 * For LLMs that don't support function calling, tools are described in the system prompt.
 * The agent returns the raw response to the consumer for any downstream tool handling.
 */

import type { LLMProvider } from '../llm-providers/base.js';
import type { AgentStreamChunk, Message } from '../types.js';
import { BaseAgent, type BaseAgentConfig } from './base.js';

export interface PromptBasedAgentConfig extends BaseAgentConfig {
  llmProvider: LLMProvider;
}

export class PromptBasedAgent extends BaseAgent {
  private llmProvider: LLMProvider;

  constructor(config: PromptBasedAgentConfig) {
    super(config);
    this.llmProvider = config.llmProvider;
  }

  /**
   * Call LLM with tools described in prompt
   */
  protected async callLLMWithTools(
    messages: Message[],
    tools: any[],
    options?: any,
  ): Promise<{ content: string; raw?: unknown }> {
    // Build system message with tool descriptions
    const systemMessage = this.buildSystemMessageWithTools(tools);

    // Prepare messages with system message
    const messagesWithSystem: Message[] = [
      { role: 'system', content: systemMessage },
      ...messages.filter((m) => m.role !== 'system'),
    ];

    // Call LLM
    const response = await this.llmProvider.chat(messagesWithSystem);

    return {
      content: response.content,
      raw: response.raw,
    };
  }

  protected async *streamLLMWithTools(
    _messages: Message[],
    _tools: any[],
    _options?: any,
  ): AsyncGenerator<AgentStreamChunk, void, unknown> {
    throw new Error('Streaming is not implemented for PromptBasedAgent');
  }

  /**
   * Build system message with tool descriptions
   */
  private buildSystemMessageWithTools(tools: any[]): string {
    const toolDescriptions = tools
      .map((tool) => {
        const params = tool.inputSchema?.properties
          ? Object.entries(tool.inputSchema.properties)
              .map(
                ([name, prop]: [string, any]) =>
                  `  - ${name}: ${prop.description || prop.type || 'any'}`,
              )
              .join('\n')
          : '';

        return `- ${tool.name}: ${tool.description || 'No description'}
${params ? `  Parameters:\n${params}` : ''}`;
      })
      .join('\n\n');

    return `You are a helpful assistant with access to the following tools:

${toolDescriptions}

**How to use tools:**
When you need to use a tool, respond in JSON format:
{"tool": "tool_name", "args": {"param1": "value1", "param2": "value2"}}

Or in text format:
TOOL_CALL: tool_name
ARGUMENTS: {"param1": "value1", "param2": "value2"}

Only include tool usage hints if they are needed to solve the user's request.`;
  }
}
