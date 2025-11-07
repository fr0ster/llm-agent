/**
 * SAP Core AI Agent - Agent implementation for SAP Core AI
 * 
 * Uses PromptBasedAgent as base since SAP Core AI API format may vary.
 * Can be customized based on actual SAP Core AI API capabilities.
 * 
 * All LLM providers are accessed through SAP AI Core:
 * - OpenAI models → SAP AI Core → OpenAI
 * - Anthropic models → SAP AI Core → Anthropic
 * - DeepSeek models → SAP AI Core → DeepSeek
 * 
 * The model name in SapCoreAIProvider determines which underlying provider to use.
 */

import { PromptBasedAgent, type PromptBasedAgentConfig } from './prompt-based-agent.js';
import type { SapCoreAIProvider } from '../llm-providers/sap-core-ai.js';

export interface SapCoreAIAgentConfig extends Omit<PromptBasedAgentConfig, 'llmProvider'> {
  llmProvider: SapCoreAIProvider;
}

export class SapCoreAIAgent extends PromptBasedAgent {
  constructor(config: SapCoreAIAgentConfig) {
    super(config);
  }

  // Can override methods here if SAP Core AI has specific requirements
  // For now, uses prompt-based approach from base class
  // Future: If SAP Core AI supports function calling, can override callLLMWithTools
}

