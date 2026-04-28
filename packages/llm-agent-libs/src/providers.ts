/**
 * Provider resolution — the composition root for concrete LLM implementations.
 *
 * This module is the ONLY place that knows about concrete LLM providers.
 * Embedder and RAG factories live in @mcp-abap-adt/llm-agent-rag.
 *
 * LLM provider packages are optional peers loaded via dynamic import().
 * MissingProviderError is thrown when a required peer is not installed.
 */

import type { ILlm, IModelResolver } from '@mcp-abap-adt/llm-agent';
import { MissingProviderError } from '@mcp-abap-adt/llm-agent';
import type { SapAICoreCredentials } from '@mcp-abap-adt/sap-aicore-llm';
import { LlmAdapter } from './adapters/llm-adapter.js';
import { LlmProviderBridge } from './adapters/llm-provider-bridge.js';
import { NonStreamingLlm } from './adapters/non-streaming-llm.js';

// ---------------------------------------------------------------------------
// LLM provider resolution
// ---------------------------------------------------------------------------

export interface MakeLlmConfig {
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

// ---------------------------------------------------------------------------
// Per-provider dynamic loaders
// ---------------------------------------------------------------------------

function isMissingOptionalPeer(err: unknown, pkg: string): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'ERR_MODULE_NOT_FOUND') return true;
  if (
    err.message.includes(pkg) &&
    err.message.toLowerCase().includes('cannot find')
  )
    return true;
  return false;
}

async function loadOpenAI() {
  const pkg = '@mcp-abap-adt/openai-llm';
  try {
    const mod = await import(pkg);
    return mod.OpenAIProvider as new (opts: {
      apiKey?: string;
      baseURL?: string;
      model?: string;
      temperature?: number;
      maxTokens?: number;
    }) => {
      model: string;
      getModels?: () => Promise<string[]>;
      getEmbeddingModels?: () => Promise<string[]>;
    } & import('@mcp-abap-adt/llm-agent').LLMProvider;
  } catch (err) {
    if (isMissingOptionalPeer(err, pkg))
      throw new MissingProviderError(pkg, 'openai');
    throw err;
  }
}

async function loadDeepSeek() {
  const pkg = '@mcp-abap-adt/deepseek-llm';
  try {
    const mod = await import(pkg);
    return mod.DeepSeekProvider as new (opts: {
      apiKey?: string;
      baseURL?: string;
      model?: string;
      temperature?: number;
      maxTokens?: number;
    }) => {
      model: string;
      getModels?: () => Promise<string[]>;
      getEmbeddingModels?: () => Promise<string[]>;
    } & import('@mcp-abap-adt/llm-agent').LLMProvider;
  } catch (err) {
    if (isMissingOptionalPeer(err, pkg))
      throw new MissingProviderError(pkg, 'deepseek');
    throw err;
  }
}

async function loadAnthropic() {
  const pkg = '@mcp-abap-adt/anthropic-llm';
  try {
    const mod = await import(pkg);
    return mod.AnthropicProvider as new (opts: {
      apiKey?: string;
      baseURL?: string;
      model?: string;
      temperature?: number;
      maxTokens?: number;
    }) => {
      model: string;
      getModels?: () => Promise<string[]>;
      getEmbeddingModels?: () => Promise<string[]>;
    } & import('@mcp-abap-adt/llm-agent').LLMProvider;
  } catch (err) {
    if (isMissingOptionalPeer(err, pkg))
      throw new MissingProviderError(pkg, 'anthropic');
    throw err;
  }
}

async function loadSapAiCore() {
  const pkg = '@mcp-abap-adt/sap-aicore-llm';
  try {
    const mod = await import(pkg);
    return mod.SapCoreAIProvider as new (opts: {
      apiKey?: string;
      model?: string;
      temperature?: number;
      maxTokens?: number;
      resourceGroup?: string;
      credentials?: SapAICoreCredentials;
      log?: {
        debug: (msg: string, meta?: Record<string, unknown>) => void;
        error: (msg: string, meta?: Record<string, unknown>) => void;
      };
    }) => {
      model: string;
      getModels?: () => Promise<string[]>;
      getEmbeddingModels?: () => Promise<string[]>;
    } & import('@mcp-abap-adt/llm-agent').LLMProvider;
  } catch (err) {
    if (isMissingOptionalPeer(err, pkg))
      throw new MissingProviderError(pkg, 'sap-ai-sdk');
    throw err;
  }
}

// ---------------------------------------------------------------------------
// makeLlm — async, dynamic-import based
// ---------------------------------------------------------------------------

/**
 * Create an ILlm from a declarative provider config.
 * This is the only function that knows about concrete LLM implementations.
 * Provider packages are loaded via dynamic import (optional peers).
 */
export async function makeLlm(
  cfg: MakeLlmConfig,
  temperature: number,
): Promise<ILlm> {
  // Coerce numeric fields that may arrive as strings from ${ENV_VAR} substitution
  const maxTokens = cfg.maxTokens != null ? Number(cfg.maxTokens) : undefined;

  let llm: ILlm;

  switch (cfg.provider) {
    case 'deepseek': {
      const DeepSeekProvider = await loadDeepSeek();
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
      const OpenAIProvider = await loadOpenAI();
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
      const AnthropicProvider = await loadAnthropic();
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
      const SapCoreAIProvider = await loadSapAiCore();
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
export async function makeDefaultLlm(
  apiKey: string,
  model: string,
  temperature: number,
): Promise<ILlm> {
  return makeLlm({ provider: 'deepseek', apiKey, model }, temperature);
}

/**
 * Default IModelResolver — delegates to makeLlm() with the given provider settings.
 * Returns fully constructed ILlm instances ready for use with SmartAgent.reconfigure().
 */
export class DefaultModelResolver implements IModelResolver {
  constructor(
    private readonly providerConfig: Omit<MakeLlmConfig, 'model'>,
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
