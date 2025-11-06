/**
 * Main exports for LLM Agent
 */

// Legacy Agent (kept for backward compatibility, but deprecated)
export { Agent, type AgentConfig } from './agent.js';

// New Agent implementations (recommended)
export { BaseAgent, type BaseAgentConfig } from './agents/base.js';
export { OpenAIAgent, type OpenAIAgentConfig } from './agents/openai-agent.js';
export { AnthropicAgent, type AnthropicAgentConfig } from './agents/anthropic-agent.js';
export { DeepSeekAgent, type DeepSeekAgentConfig } from './agents/deepseek-agent.js';
export { PromptBasedAgent, type PromptBasedAgentConfig } from './agents/prompt-based-agent.js';

// LLM Providers
export { OpenAIProvider, type OpenAIConfig } from './llm-providers/openai.js';
export { DeepSeekProvider, type DeepSeekConfig } from './llm-providers/deepseek.js';
export { AnthropicProvider, type AnthropicConfig } from './llm-providers/anthropic.js';
export { BaseLLMProvider, type LLMProvider } from './llm-providers/base.js';

// MCP Client
export { MCPClientWrapper, type MCPClientConfig, type TransportType } from './mcp/client.js';
export type {
  Message,
  ToolCall,
  ToolResult,
  AgentResponse,
  LLMResponse,
  LLMProviderConfig,
} from './types.js';

