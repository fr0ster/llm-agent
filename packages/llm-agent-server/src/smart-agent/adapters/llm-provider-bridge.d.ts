/**
 * LlmProviderBridge — wraps a legacy LLMProvider as BaseAgentLlmBridge.
 *
 * This adapter bridges the old LLMProvider interface (returns LLMResponse directly)
 * to the BaseAgentLlmBridge interface expected by LlmAdapter (returns Result<LlmResponse>).
 *
 * It handles OpenAI-style tool format conversion (MCP tools → { type: 'function', function: {...} }).
 */
import type { AgentStreamChunk, LLMProvider, Message } from '@mcp-abap-adt/llm-agent';
import type { AgentCallOptions, BaseAgentLlmBridge } from './llm-adapter.js';
/**
 * Wraps a LLMProvider as a BaseAgentLlmBridge, enabling LlmAdapter to use it.
 *
 * Usage:
 *   const provider = new OpenAIProvider({ ... });
 *   const bridge = new LlmProviderBridge(provider);
 *   const llm = new LlmAdapter(bridge, { model: provider.model });
 */
export declare class LlmProviderBridge implements BaseAgentLlmBridge {
    private readonly provider;
    constructor(provider: LLMProvider);
    callWithTools(messages: Message[], tools: unknown[], options?: AgentCallOptions): Promise<{
        content: string;
        raw?: unknown;
    }>;
    streamWithTools(messages: Message[], tools: unknown[], options?: AgentCallOptions): AsyncGenerator<{
        content: string;
        raw?: unknown;
    } | AgentStreamChunk, void, unknown>;
}
//# sourceMappingURL=llm-provider-bridge.d.ts.map