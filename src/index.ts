/**
 * Main exports for LLM Agent
 */

// Legacy Agent (kept for backward compatibility, but deprecated)
export { Agent, type AgentConfig } from './agent.js';

// New Agent implementations (recommended)
export { BaseAgent, type BaseAgentConfig } from './agents/base.js';
export { PromptBasedAgent, type PromptBasedAgentConfig } from './agents/prompt-based-agent.js';
export { SapCoreAIAgent, type SapCoreAIAgentConfig } from './agents/sap-core-ai-agent.js';

// LLM Providers
// NOTE: All LLM providers are accessed through SAP AI Core
export { SapCoreAIProvider, type SapCoreAIConfig } from './llm-providers/sap-core-ai.js';
export { BaseLLMProvider, type LLMProvider } from './llm-providers/base.js';

// Legacy exports (deprecated - use SapCoreAIProvider instead)
// These are kept for backward compatibility but will be removed in future versions
export { OpenAIAgent, type OpenAIAgentConfig } from './agents/openai-agent.js';
export { AnthropicAgent, type AnthropicAgentConfig } from './agents/anthropic-agent.js';
export { DeepSeekAgent, type DeepSeekAgentConfig } from './agents/deepseek-agent.js';
export { OpenAIProvider, type OpenAIConfig } from './llm-providers/openai.js';
export { DeepSeekProvider, type DeepSeekConfig } from './llm-providers/deepseek.js';
export { AnthropicProvider, type AnthropicConfig } from './llm-providers/anthropic.js';

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

