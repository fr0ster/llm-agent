import type { ILlm } from '@mcp-abap-adt/llm-agent';
import { type NormalizedLlmMap, resolveLlmConfig } from '../config.js';
import type { SmartServerLlmConfig } from '../smart-server.js';

export interface IRoleLlmResolver {
  resolve(role: string): Promise<ILlm>;
  makeLlm(lc: SmartServerLlmConfig): Promise<ILlm>;
}

export interface RoleLlmResolverDeps {
  getMain(): ILlm | undefined;
  getHelper(): ILlm | undefined;
  getClassifier(): ILlm | undefined;
  getLlmMap(): NormalizedLlmMap | undefined;
  getPipelineFallback(): SmartServerLlmConfig | undefined;
  makeLlm(lc: SmartServerLlmConfig): Promise<ILlm>;
}

/**
 * Resolve a per-role LLM through the normalized map → pipelineFallback chain.
 * Reads the role LLM instances through LIVE accessors so a config-reload
 * hot-swap of `main`/`helper`/`classifier` is observed transparently (the
 * SmartServer keeps the fields as source-of-truth).
 */
export class RoleLlmResolver implements IRoleLlmResolver {
  constructor(private readonly deps: RoleLlmResolverDeps) {}

  makeLlm(lc: SmartServerLlmConfig): Promise<ILlm> {
    return this.deps.makeLlm(lc);
  }

  async resolve(role: string): Promise<ILlm> {
    const main = this.deps.getMain();
    const helper = this.deps.getHelper();
    const classifier = this.deps.getClassifier();
    if (role === 'main' && main) return main;
    if ((role === 'helper' || role === 'planner') && helper) return helper;
    if (role === 'classifier' && classifier) return classifier;
    const cfg = resolveLlmConfig(
      this.deps.getLlmMap(),
      role,
      this.deps.getPipelineFallback(),
    );
    if (cfg) return this.deps.makeLlm(cfg);
    if (main) return main;
    throw new Error(`cannot resolve LLM for role '${role}': no config`);
  }
}
