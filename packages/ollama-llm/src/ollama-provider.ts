/**
 * Ollama LLM Provider — extends OpenAI (Ollama exposes an OpenAI-compatible /v1 API).
 */

import type { IApiKeyCredential } from '@mcp-abap-adt/interfaces-auth';
import type { IModelInfo, LLMProviderConfig } from '@mcp-abap-adt/llm-agent';
import { type OpenAIConfig, OpenAIProvider } from '@mcp-abap-adt/openai-llm';

export interface OllamaConfig extends LLMProviderConfig {
  /**
   * Optional, unlike the other three providers: a local Ollama server
   * ignores it, though a gateway placed in front of it may still require
   * one — the design replaces plain keys with typed credentials rather than
   * removing the capability. Forwarded to `OpenAIProvider` through the
   * `super({ ...config })` call below, unchanged.
   */
  credential?: IApiKeyCredential;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export class OllamaProvider extends OpenAIProvider {
  protected override readonly providerName: string = 'Ollama';

  /** Ollama's credential is optional — see `OllamaConfig.credential`. */
  protected override requiresCredential(): boolean {
    return false;
  }

  constructor(config: OllamaConfig) {
    super({
      ...config,
      baseURL: config.baseURL || 'http://localhost:11434/v1',
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
