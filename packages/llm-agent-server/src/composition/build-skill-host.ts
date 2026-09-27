import type { ISkillPluginHost } from '@mcp-abap-adt/llm-agent';
import {
  type BuildAgentDeps,
  type BuildSkillHostDeps,
  buildSkillHostFromConfig,
  type SkillPluginsConfig,
} from '@mcp-abap-adt/llm-agent-server-libs';
import { DEFAULT_STORE_REF } from './credential-for.js';
import type { Lookup } from './lookup.js';

/**
 * `BuildAgentDeps.buildSkillHost`: the skill store's account. §8 item 4 has a
 * qdrant skill store's `credentialRef` resolved through the same `credentialFor`
 * as every other ref — a named ref must resolve to an api key; an omitted one
 * reads the store default and, finding no entry, stays anonymous — and the
 * credential reaches the library's factory as `storeCredential` (B11), merged
 * into the deps `SmartServer` passes. An in-memory skill store sends nothing and
 * reads no entry.
 */
export function createBuildSkillHost(
  lookup: Lookup,
  impl: typeof buildSkillHostFromConfig = buildSkillHostFromConfig,
): NonNullable<BuildAgentDeps['buildSkillHost']> {
  return async (
    cfg: SkillPluginsConfig,
    deps: BuildSkillHostDeps,
  ): Promise<ISkillPluginHost> => {
    if (cfg.store.type !== 'qdrant') return impl(cfg, deps);
    const { credential } = lookup(
      cfg.store.credentialRef,
      DEFAULT_STORE_REF,
      'skill store (qdrant)',
    ).optional('api-key');
    return impl(
      cfg,
      credential ? { ...deps, storeCredential: credential } : deps,
    );
  };
}
