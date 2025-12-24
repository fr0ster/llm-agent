/**
 * LLM Provider exports
 *
 * NOTE: All LLM providers are accessed through SAP AI Core.
 * Direct integrations with OpenAI/Anthropic/DeepSeek are removed.
 * Use SapCoreAIProvider with appropriate model names to access different providers.
 */

export { type AnthropicConfig, AnthropicProvider } from './anthropic.js';
export { BaseLLMProvider, type LLMProvider } from './base.js';
export { type DeepSeekConfig, DeepSeekProvider } from './deepseek.js';
// Legacy exports (deprecated - use SapCoreAIProvider instead)
// These are kept for backward compatibility but will be removed in future versions
export { type OpenAIConfig, OpenAIProvider } from './openai.js';
export { type SapCoreAIConfig, SapCoreAIProvider } from './sap-core-ai.js';
