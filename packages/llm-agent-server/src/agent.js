/**
 * Core Agent Orchestrator
 *
 * Coordinates between LLM provider and MCP tools
 */
import { MCPClientWrapper } from './mcp/client.js';
export class Agent {
    llmProvider;
    mcpClient;
    conversationHistory = [];
    constructor(config) {
        this.llmProvider = config.llmProvider;
        // Initialize MCP client
        if (config.mcpClient) {
            this.mcpClient = config.mcpClient;
        }
        else if (config.mcpConfig) {
            this.mcpClient = new MCPClientWrapper(config.mcpConfig);
        }
        else {
            throw new Error('MCP client configuration required. Provide either mcpClient or mcpConfig.');
        }
    }
    /**
     * Initialize MCP client connection (call this before using the agent)
     */
    async connect() {
        await this.mcpClient.connect();
    }
    /**
     * Process a user message and return agent response
     */
    async process(userMessage) {
        try {
            // Add user message to history
            this.conversationHistory.push({
                role: 'user',
                content: userMessage,
            });
            // Get available tools from MCP
            const tools = await this.mcpClient.listTools();
            // Build system message with tool definitions
            const systemMessage = this.buildSystemMessage(tools);
            // Prepare messages for LLM
            const messages = [
                { role: 'system', content: systemMessage },
                ...this.conversationHistory,
            ];
            // Get LLM response
            const llmResponse = await this.llmProvider.chat(messages);
            // Add assistant response to history
            this.conversationHistory.push({
                role: 'assistant',
                content: llmResponse.content,
            });
            return {
                message: llmResponse.content,
                raw: llmResponse.raw,
            };
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            return {
                message: '',
                error: errorMessage || 'Agent processing failed',
            };
        }
    }
    /**
     * Build system message with tool definitions
     */
    buildSystemMessage(tools) {
        const toolDescriptions = tools
            .map((tool) => {
            return `- ${tool.name}: ${tool.description || 'No description'}`;
        })
            .join('\n');
        return `You are a helpful assistant with access to the following tools:

${toolDescriptions}

If using a tool is required, describe the tool call and its parameters in your response.`;
    }
    /**
     * Clear conversation history
     */
    clearHistory() {
        this.conversationHistory = [];
    }
    /**
     * Get conversation history
     */
    getHistory() {
        return [...this.conversationHistory];
    }
}
//# sourceMappingURL=agent.js.map