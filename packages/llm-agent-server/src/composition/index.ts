import type { BuildAgentDeps } from '@mcp-abap-adt/llm-agent-server-libs';
import { createBuildSkillHost } from './build-skill-host.js';
import { envCredentialEntries, memoizeCredentials } from './credential-for.js';
import { createLookup } from './lookup.js';
import { createMakeLlm } from './make-llm.js';
import { createMakeRag } from './make-rag.js';
import { createResolveEmbedder } from './resolve-embedder.js';

export { createModelResolver } from './model-resolver.js';

export type CompositionDeps = Pick<
  BuildAgentDeps,
  'makeLlm' | 'resolveEmbedder' | 'makeRag'
> & {
  buildSkillHost: NonNullable<BuildAgentDeps['buildSkillHost']>;
};

/**
 * The three construction seams the library no longer defaults (§4.6.3, §4.6.4)
 * and the skill-store wrapper, over ONE memoized registry, so an account named
 * by an LLM, a store, an embedder and a skill store is one credential object and
 * one quota bucket (§4.6.5).
 */
export function buildCompositionDeps(
  env: NodeJS.ProcessEnv = process.env,
): CompositionDeps {
  const lookup = createLookup(memoizeCredentials(envCredentialEntries(env)));
  return {
    makeLlm: createMakeLlm(lookup),
    resolveEmbedder: createResolveEmbedder(lookup),
    makeRag: createMakeRag(lookup),
    buildSkillHost: createBuildSkillHost(lookup),
  };
}
