/**
 * Ollama LLM Provider — extends OpenAI (Ollama exposes an OpenAI-compatible /v1 API).
 */

import type { IModelInfo, LLMProviderConfig } from '@mcp-abap-adt/llm-agent';
import { type OpenAIConfig, OpenAIProvider } from '@mcp-abap-adt/openai-llm';

export interface OllamaConfig extends LLMProviderConfig {
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export class OllamaProvider extends OpenAIProvider {
  protected override readonly providerName: string = 'Ollama';

  constructor(config: OllamaConfig) {
    super({
      ...config,
      baseURL: config.baseURL || 'http://localhost:11434/v1',
      // Ollama ignores the key, but the OpenAI SDK requires a non-empty value.
      apiKey: config.apiKey || 'ollama',
    } as OpenAIConfig);
  }

  /**
   * Ollama always uses max_tokens.
   */
  protected override getTokenLimitParam(
    _model: string,
    maxTokens: number,
  ): Record<string, number> {
    return { max_tokens: maxTokens };
  }

  override async getEmbeddingModels(): Promise<IModelInfo[]> {
    return [];
  }
}
