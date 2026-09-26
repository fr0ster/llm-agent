import {
  type AnthropicConfig,
  AnthropicProvider,
} from '@mcp-abap-adt/anthropic-llm';
import {
  type DeepSeekConfig,
  DeepSeekProvider,
} from '@mcp-abap-adt/deepseek-llm';
import type { ILlm, LLMProvider } from '@mcp-abap-adt/llm-agent';
import { LlmAdapter, LlmProviderBridge } from '@mcp-abap-adt/llm-agent-libs';
import type { SmartServerLlmConfig } from '@mcp-abap-adt/llm-agent-server-libs';
import { type OllamaConfig, OllamaProvider } from '@mcp-abap-adt/ollama-llm';
import { type OpenAIConfig, OpenAIProvider } from '@mcp-abap-adt/openai-llm';
import type { SapCoreAIConfig } from '@mcp-abap-adt/sap-aicore-llm';
import { DEFAULT_LLM_REF } from './credential-for.js';
import type { Lookup } from './lookup.js';

type ProviderInstance = LLMProvider & { readonly model: string };

type SapCoreAICtor = new (cfg: SapCoreAIConfig) => ProviderInstance;

/** The five constructors, injectable so a test records what each receives. */
export interface LlmProviderCtors {
  openai: new (cfg: OpenAIConfig) => ProviderInstance;
  anthropic: new (cfg: AnthropicConfig) => ProviderInstance;
  deepseek: new (cfg: DeepSeekConfig) => ProviderInstance;
  ollama: new (cfg: OllamaConfig) => ProviderInstance;
  /**
   * A loader, not the constructor: `@mcp-abap-adt/sap-aicore-llm` pulls
   * `@sap-ai-sdk/orchestration`, which installs process `uncaughtException`
   * listeners at import time. Imported statically, every deployment would survive
   * uncaught exceptions; loaded here, only one that selects `sap-ai-sdk` pays.
   */
  'sap-ai-sdk': () => Promise<SapCoreAICtor>;
}

export const SHIPPED_LLM_PROVIDERS: LlmProviderCtors = {
  openai: OpenAIProvider,
  anthropic: AnthropicProvider,
  deepseek: DeepSeekProvider,
  ollama: OllamaProvider,
  'sap-ai-sdk': async () =>
    (await import('@mcp-abap-adt/sap-aicore-llm')).SapCoreAIProvider,
};

/**
 * `BuildAgentDeps.makeLlm` (§8 item 4). Every provider config is built from NAMED
 * fields — nothing spreads `cfg` — so `credentialRef` cannot ride along into a
 * provider (§4.6.4). The knobs the library's `makeLlm` used to forward are
 * forwarded here: without `temperature` the server's main (0.7) and classifier
 * (0.1) roles would collapse onto one provider default.
 */
export function createMakeLlm(
  lookup: Lookup,
  ctors: LlmProviderCtors = SHIPPED_LLM_PROVIDERS,
): (cfg: SmartServerLlmConfig) => Promise<ILlm> {
  return async (cfg) => {
    const entry = lookup(
      cfg.credentialRef,
      DEFAULT_LLM_REF,
      cfg.provider ?? 'llm',
    );
    const knobs = {
      model: cfg.model,
      temperature: cfg.temperature,
      maxTokens: cfg.maxTokens,
      whenThrottled: cfg.whenThrottled,
    };
    const provider: ProviderInstance = await (async () => {
      switch (cfg.provider) {
        case 'openai':
          return new ctors.openai({
            ...knobs,
            baseURL: cfg.url,
            credential: entry.require('api-key'),
          });
        case 'anthropic':
          return new ctors.anthropic({
            ...knobs,
            baseURL: cfg.url,
            credential: entry.require('api-key'),
          });
        case 'deepseek':
          return new ctors.deepseek({
            ...knobs,
            baseURL: cfg.url,
            credential: entry.require('api-key'),
          });
        case 'ollama':
          // Optional, and only from a ref that NAMES one: the LLM role default
          // usually holds a hosted provider's key, and sending it to a local
          // Ollama (or whatever sits at cfg.url) would hand a secret to a target
          // nobody authorized for it.
          return new ctors.ollama({
            ...knobs,
            baseURL: cfg.url,
            ...(cfg.credentialRef === undefined
              ? {}
              : entry.optional('api-key')),
          });
        case 'sap-ai-sdk':
          return new (await ctors['sap-ai-sdk']())({
            ...knobs,
            credential: entry.require('bearer'),
            apiBaseUrl: entry.requireApiBaseUrl(),
          });
        default:
          throw new Error(`unknown llm provider '${String(cfg.provider)}'`);
      }
    })();
    return new LlmAdapter(new LlmProviderBridge(provider), {
      model: provider.model,
      getModels: () => provider.getModels?.() ?? Promise.resolve([]),
      getEmbeddingModels: () =>
        provider.getEmbeddingModels?.() ?? Promise.resolve([]),
    });
  };
}
