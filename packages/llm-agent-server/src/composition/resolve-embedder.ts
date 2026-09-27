import type { IEmbedder } from '@mcp-abap-adt/llm-agent';
import {
  type EmbedderResolution,
  type EmbedderResolutionOptions,
  resolveEmbedder as libResolveEmbedder,
} from '@mcp-abap-adt/llm-agent-rag';
import type { SmartServerEmbedderConfig } from '@mcp-abap-adt/llm-agent-server-libs';
import { DEFAULT_EMBEDDER_REF } from './credential-for.js';
import type { Lookup } from './lookup.js';

type BuiltInSection = Exclude<SmartServerEmbedderConfig, { factory: string }>;
type FactorySection = Extract<SmartServerEmbedderConfig, { factory: string }>;

function isFactorySection(
  cfg: SmartServerEmbedderConfig,
): cfg is FactorySection {
  return 'factory' in cfg && typeof cfg.factory === 'string';
}

/** The library's built-in arms require a model; the section may omit it. */
function requireModel(cfg: BuiltInSection): string {
  if (cfg.model === undefined || cfg.model === '') {
    throw new Error(
      `rag.embedder.model is required for provider '${cfg.provider}'`,
    );
  }
  return cfg.model;
}

/**
 * `BuildAgentDeps.resolveEmbedder` (§8 item 4): the embedder's own account, and
 * the conversion from B10's serializable section into B6c's `EmbedderResolution`.
 * Every arm is built from NAMED fields, so `credentialRef` ends here and nothing
 * the section carries rides along unasked. A built-in is named by `provider`; a
 * consumer-registered factory by `factory`, and it goes to the library's factory
 * arm. Ollama and factories send nothing from this root — a consumer factory
 * closes over its own credential (§4.6.2) — so a named ref for them is refused.
 */
export function createResolveEmbedder(
  lookup: Lookup,
  impl: typeof libResolveEmbedder = libResolveEmbedder,
): (
  cfg: SmartServerEmbedderConfig,
  options?: EmbedderResolutionOptions,
) => IEmbedder {
  return (cfg, options) => {
    if (isFactorySection(cfg)) {
      // The factory arm declares no credentialRef; a YAML section may still carry
      // one, and a ref for a target that takes none is refused by name.
      const raw = cfg as FactorySection & { credentialRef?: unknown };
      const ref =
        typeof raw.credentialRef === 'string' ? raw.credentialRef : undefined;
      lookup(
        ref,
        DEFAULT_EMBEDDER_REF,
        `embedder factory '${cfg.factory}'`,
      ).refuseAny();
      const resolution: EmbedderResolution = {
        factory: cfg.factory,
        ...(cfg.model !== undefined ? { model: cfg.model } : {}),
        ...(cfg.url !== undefined ? { url: cfg.url } : {}),
        ...(cfg.maxBatchSize !== undefined
          ? { maxBatchSize: cfg.maxBatchSize }
          : {}),
      };
      return impl(resolution, options);
    }
    const entry = lookup(cfg.credentialRef, DEFAULT_EMBEDDER_REF, cfg.provider);
    const model = requireModel(cfg);
    const batch =
      cfg.maxBatchSize !== undefined ? { maxBatchSize: cfg.maxBatchSize } : {};
    switch (cfg.provider) {
      case 'openai':
        return impl(
          {
            provider: 'openai',
            model,
            ...(cfg.url !== undefined ? { url: cfg.url } : {}),
            ...batch,
            credential: entry.require('api-key'),
          },
          options,
        );
      case 'sap-ai-core':
      case 'sap-aicore':
        return impl(
          {
            provider: cfg.provider,
            model,
            ...(cfg.resourceGroup !== undefined
              ? { resourceGroup: cfg.resourceGroup }
              : {}),
            ...(cfg.scenario !== undefined ? { scenario: cfg.scenario } : {}),
            ...batch,
            credential: entry.require('bearer'),
            apiBaseUrl: entry.requireApiBaseUrl(),
          },
          options,
        );
      case 'ollama':
        entry.refuseAny();
        return impl(
          {
            provider: 'ollama',
            model,
            ...(cfg.url !== undefined ? { url: cfg.url } : {}),
            ...batch,
          },
          options,
        );
    }
  };
}
