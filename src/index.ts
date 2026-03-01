/**
 * Main exports for LLM Proxy
 */

// Legacy Agent (kept for backward compatibility, but deprecated)
export { Agent, type AgentConfig } from './agent.js';
export {
  AnthropicAgent,
  type AnthropicAgentConfig,
} from './agents/anthropic-agent.js';
// New Agent implementations (recommended)
export { BaseAgent, type BaseAgentConfig } from './agents/base.js';
export {
  DeepSeekAgent,
  type DeepSeekAgentConfig,
} from './agents/deepseek-agent.js';
// Legacy exports (deprecated - use SapCoreAIProvider instead)
// These are kept for backward compatibility but will be removed in future versions
export { OpenAIAgent, type OpenAIAgentConfig } from './agents/openai-agent.js';
export {
  PromptBasedAgent,
  type PromptBasedAgentConfig,
} from './agents/prompt-based-agent.js';
export {
  SapCoreAIAgent,
  type SapCoreAIAgentConfig,
} from './agents/sap-core-ai-agent.js';
export {
  type AnthropicConfig,
  AnthropicProvider,
} from './llm-providers/anthropic.js';
export { BaseLLMProvider, type LLMProvider } from './llm-providers/base.js';
export {
  type DeepSeekConfig,
  DeepSeekProvider,
} from './llm-providers/deepseek.js';
export { type OpenAIConfig, OpenAIProvider } from './llm-providers/openai.js';
// LLM Providers
// NOTE: All LLM providers are accessed through SAP AI Core
export {
  type SapCoreAIConfig,
  SapCoreAIProvider,
} from './llm-providers/sap-core-ai.js';

// MCP Client
export {
  type MCPClientConfig,
  MCPClientWrapper,
  type TransportType,
} from './mcp/client.js';
// Tracer
export { NoopTracer } from './smart-agent/tracer/noop-tracer.js';
export type {
  ISpan,
  ITracer,
  SpanOptions,
  SpanStatus,
} from './smart-agent/tracer/types.js';
export type {
  AgentResponse,
  LLMProviderConfig,
  LLMResponse,
  Message,
  ToolCall,
  ToolResult,
} from './types.js';
