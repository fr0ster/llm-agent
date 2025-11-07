/**
 * LLM Provider exports
 * 
 * NOTE: All LLM providers are accessed through SAP AI Core.
 * Direct integrations with OpenAI/Anthropic/DeepSeek are removed.
 * Use SapCoreAIProvider with appropriate model names to access different providers.
 */

export { BaseLLMProvider, type LLMProvider } from './base.js';
export { SapCoreAIProvider, type SapCoreAIConfig } from './sap-core-ai.js';

// Legacy exports (deprecated - use SapCoreAIProvider instead)
// These are kept for backward compatibility but will be removed in future versions
export { OpenAIProvider, type OpenAIConfig } from './openai.js';
export { DeepSeekProvider, type DeepSeekConfig } from './deepseek.js';
export { AnthropicProvider, type AnthropicConfig } from './anthropic.js';

