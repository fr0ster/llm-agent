/**
 * Core Agent Orchestrator
 *
 * Coordinates between LLM provider and MCP tools
 */
import type { AgentResponse, LLMProvider, Message } from '@mcp-abap-adt/llm-agent';
import { type MCPClientConfig, MCPClientWrapper } from './mcp/client.js';
export interface AgentConfig {
    llmProvider: LLMProvider;
    /**
     * MCP client instance (if provided, will be used directly)
     * If not provided, will be created from mcpConfig
     */
    mcpClient?: MCPClientWrapper;
    /**
     * Direct MCP configuration (used if mcpClient is not provided)
     * If both mcpClient and mcpConfig are provided, mcpClient takes precedence
     */
    mcpConfig?: MCPClientConfig;
    maxIterations?: number;
}
export declare class Agent {
    private llmProvider;
    private mcpClient;
    private conversationHistory;
    constructor(config: AgentConfig);
    /**
     * Initialize MCP client connection (call this before using the agent)
     */
    connect(): Promise<void>;
    /**
     * Process a user message and return agent response
     */
    process(userMessage: string): Promise<AgentResponse>;
    /**
     * Build system message with tool definitions
     */
    private buildSystemMessage;
    /**
     * Clear conversation history
     */
    clearHistory(): void;
    /**
     * Get conversation history
     */
    getHistory(): Message[];
}
//# sourceMappingURL=agent.d.ts.map