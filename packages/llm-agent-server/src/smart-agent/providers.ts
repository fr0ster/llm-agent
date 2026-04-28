/**
 * Provider resolution — the composition root for concrete LLM implementations.
 *
 * This module is the ONLY place that knows about concrete LLM providers.
 * Embedder and RAG factories live in @mcp-abap-adt/llm-agent-rag.
 */

import { AnthropicProvider } from '@mcp-abap-adt/anthropic-llm';
import { DeepSeekProvider } from '@mcp-abap-adt/deepseek-llm';
import type { ILlm } from '@mcp-abap-adt/llm-agent';
import { OpenAIProvider } from '@mcp-abap-adt/openai-llm';
import {
  type SapAICoreCredentials,
  SapCoreAIProvider,
} from '@mcp-abap-adt/sap-aicore-llm';
import { LlmAdapter } from './adapters/llm-adapter.js';
import { LlmProviderBridge } from './adapters/llm-provider-bridge.js';
import { NonStreamingLlm } from './adapters/non-streaming-llm.js';
import type { IModelResolver } from './interfaces/model-resolver.js';

// ---------------------------------------------------------------------------
// LLM provider resolution
// ---------------------------------------------------------------------------

export interface LlmProviderConfig {
  provider: 'deepseek' | 'openai' | 'anthropic' | 'sap-ai-sdk';
  apiKey?: string;
  /** Custom base URL for OpenAI-compatible endpoints (Azure OpenAI, Ollama, vLLM, etc.). */
  baseURL?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  resourceGroup?: string;
  credentials?: SapAICoreCredentials;
  /** When false, streamChat() is replaced with chat() yielding a single chunk. Default: true. */
  streaming?: boolean;
}

/**
 * Create an ILlm from a declarative provider config.
 * This is the only function that knows about concrete LLM implementations.
 */
export function makeLlm(cfg: LlmProviderConfig, temperature: number): ILlm {
  // Coerce numeric fields that may arrive as strings from ${ENV_VAR} substitution
  const maxTokens = cfg.maxTokens != null ? Number(cfg.maxTokens) : undefined;

  let llm: ILlm;

  switch (cfg.provider) {
    case 'deepseek': {
      const provider = new DeepSeekProvider({
        apiKey: cfg.apiKey,
        baseURL: cfg.baseURL,
        model: cfg.model,
        temperature,
        maxTokens,
      });
      llm = new LlmAdapter(new LlmProviderBridge(provider), {
        model: provider.model,
        getModels: () => provider.getModels?.() ?? Promise.resolve([]),
        getEmbeddingModels: () =>
          provider.getEmbeddingModels?.() ?? Promise.resolve([]),
      });
      break;
    }
    case 'openai': {
      const provider = new OpenAIProvider({
        apiKey: cfg.apiKey,
        baseURL: cfg.baseURL,
        model: cfg.model,
        temperature,
        maxTokens,
      });
      llm = new LlmAdapter(new LlmProviderBridge(provider), {
        model: provider.model,
        getModels: () => provider.getModels?.() ?? Promise.resolve([]),
        getEmbeddingModels: () =>
          provider.getEmbeddingModels?.() ?? Promise.resolve([]),
      });
      break;
    }
    case 'anthropic': {
      const provider = new AnthropicProvider({
        apiKey: cfg.apiKey,
        baseURL: cfg.baseURL,
        model: cfg.model,
        temperature,
        maxTokens,
      });
      llm = new LlmAdapter(new LlmProviderBridge(provider), {
        model: provider.model,
        getModels: () => provider.getModels?.() ?? Promise.resolve([]),
        getEmbeddingModels: () =>
          provider.getEmbeddingModels?.() ?? Promise.resolve([]),
      });
      break;
    }
    case 'sap-ai-sdk': {
      const provider = new SapCoreAIProvider({
        apiKey: cfg.apiKey,
        model: cfg.model,
        temperature,
        maxTokens,
        resourceGroup: cfg.resourceGroup,
        credentials: cfg.credentials,
        log: {
          debug: (msg: string, meta?: Record<string, unknown>) =>
            process.stderr.write(
              `[sap-ai-sdk:debug] ${msg} ${meta ? JSON.stringify(meta) : ''}\n`,
            ),
          error: (msg: string, meta?: Record<string, unknown>) =>
            process.stderr.write(
              `[sap-ai-sdk:error] ${msg} ${meta ? JSON.stringify(meta) : ''}\n`,
            ),
        },
      });
      llm = new LlmAdapter(new LlmProviderBridge(provider), {
        model: provider.model,
        getModels: () => provider.getModels?.() ?? Promise.resolve([]),
        getEmbeddingModels: () =>
          provider.getEmbeddingModels?.() ?? Promise.resolve([]),
      });
      break;
    }
    default: {
      const _exhaustive: never = cfg.provider;
      throw new Error(`Unknown LLM provider: ${_exhaustive}`);
    }
  }

  // Wrap with non-streaming adapter when streaming is disabled for this provider
  if (cfg.streaming === false) {
    llm = new NonStreamingLlm(llm);
  }

  return llm;
}

/**
 * Create a default DeepSeek-based ILlm from simple config (apiKey + model).
 * Used by the flat YAML / CLI path.
 */
export function makeDefaultLlm(
  apiKey: string,
  model: string,
  temperature: number,
): ILlm {
  return makeLlm({ provider: 'deepseek', apiKey, model }, temperature);
}

/**
 * Default IModelResolver — delegates to makeLlm() with the given provider settings.
 * Returns fully constructed ILlm instances ready for use with SmartAgent.reconfigure().
 */
export class DefaultModelResolver implements IModelResolver {
  constructor(
    private readonly providerConfig: Omit<LlmProviderConfig, 'model'>,
    private readonly defaults: { temperature?: number } = {},
  ) {}

  async resolve(
    modelName: string,
    role: 'main' | 'classifier' | 'helper',
  ): Promise<ILlm> {
    const temperature =
      this.defaults.temperature ?? (role === 'main' ? 0.7 : 0.1);
    return makeLlm({ ...this.providerConfig, model: modelName }, temperature);
  }
}
