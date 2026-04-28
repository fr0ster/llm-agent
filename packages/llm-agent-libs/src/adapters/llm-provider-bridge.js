/**
 * LlmProviderBridge — wraps a legacy LLMProvider as BaseAgentLlmBridge.
 *
 * This adapter bridges the old LLMProvider interface (returns LLMResponse directly)
 * to the BaseAgentLlmBridge interface expected by LlmAdapter (returns Result<LlmResponse>).
 *
 * It handles OpenAI-style tool format conversion (MCP tools → { type: 'function', function: {...} }).
 */
/**
 * Convert MCP-style tools to OpenAI function-call format.
 * This is the same conversion that OpenAIAgent/DeepSeekAgent used to do.
 */
function convertToolsToFunctions(tools) {
  return tools.map((rawTool) => {
    const tool = rawTool;
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
 * Wraps a LLMProvider as a BaseAgentLlmBridge, enabling LlmAdapter to use it.
 *
 * Usage:
 *   const provider = new OpenAIProvider({ ... });
 *   const bridge = new LlmProviderBridge(provider);
 *   const llm = new LlmAdapter(bridge, { model: provider.model });
 */
export class LlmProviderBridge {
  provider;
  constructor(provider) {
    this.provider = provider;
  }
  async callWithTools(messages, tools, options) {
    const functions = convertToolsToFunctions(tools);
    const response = await this.provider.chat(
      messages,
      functions.length > 0 ? functions : undefined,
      options,
    );
    return { content: response.content, raw: response.raw };
  }
  async *streamWithTools(messages, tools, options) {
    const functions = convertToolsToFunctions(tools);
    const toolCallMap = new Map();
    let finishReason = 'stop';
    for await (const chunk of this.provider.streamChat(
      messages,
      functions.length > 0 ? functions : undefined,
      options,
    )) {
      // Yield text deltas
      if (chunk.content) {
        yield { type: 'text', delta: chunk.content };
      }
      // Yield normalized usage from the chunk (provider populates this).
      if (chunk.usage) {
        yield {
          type: 'usage',
          promptTokens: chunk.usage.prompt_tokens ?? 0,
          completionTokens: chunk.usage.completion_tokens ?? 0,
        };
      }
      // Accumulate tool-call deltas from the provider-normalized field.
      // Each provider (OpenAI/DeepSeek, Anthropic, SAP AI SDK) populates
      // chunk.toolCalls with a uniform LlmToolCallDelta shape, so the bridge
      // no longer needs to reach into provider-specific raw payloads.
      if (chunk.toolCalls) {
        for (const tc of chunk.toolCalls) {
          const index = tc.index;
          if (!toolCallMap.has(index)) {
            toolCallMap.set(index, {
              id: tc.id ?? '',
              name: tc.name ?? '',
              arguments: '',
            });
          }
          const accumulated = toolCallMap.get(index);
          if (accumulated) {
            if (tc.id && !accumulated.id) accumulated.id = tc.id;
            if (tc.name && !accumulated.name) accumulated.name = tc.name;
            if (tc.arguments) accumulated.arguments += tc.arguments;
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
              return JSON.parse(tc.arguments);
            } catch {
              return {};
            }
          })(),
        }));
      yield { type: 'tool_calls', toolCalls };
    }
    yield { type: 'done', finishReason };
  }
}
//# sourceMappingURL=llm-provider-bridge.js.map
