import type { ILlm } from '@mcp-abap-adt/llm-agent';
import type { NormalizedLlmMap } from '../config.js';
import type { SmartServerLlmConfig } from '../smart-server.js';

/** The server's answer to "which LLM?" — lookups only. Nothing here constructs on a
 *  caller's behalf, which is why `makeLlm` is not a member (§4.6.6). */
export interface IRoleLlmResolver {
  /** Default for a role: `main`/`classifier`/`helper` → the held instances; `planner`
   *  → the held helper when there is one; any other name → its `llm:` entry, built
   *  once and held; a name with no entry → the held `main`. */
  resolve(role: string): Promise<ILlm>;
  /** Strict: only an `llm:` entry of exactly this name; rejects, naming the key.
   *  A declared `main`/`classifier`/`helper` key answers with the held instance. */
  resolveNamed(key: string): Promise<ILlm>;
}

export interface RoleLlmResolverDeps {
  getMain(): ILlm | undefined;
  getHelper(): ILlm | undefined;
  getClassifier(): ILlm | undefined;
  getLlmMap(): NormalizedLlmMap | undefined;
  /** Builds one `llm:` entry. Called at most once per key while builds succeed. */
  build(entry: SmartServerLlmConfig): Promise<ILlm>;
}

/**
 * The default implementation's role map (§4.6.6). Held roles are read through LIVE
 * accessors, so a `PUT /v1/config` swap of main/classifier/helper is observed by the
 * next lookup; every other entry is built once per key and held (§4.6.5).
 *
 * One instance is one scope: what it builds lives as long as it does. `SmartServer`
 * constructs one per server — the deployment scope, the only one it ships, because
 * its sessions carry no caller credential. A consumer that builds from a session's
 * credential constructs one per session and drops it with the session.
 */
export class RoleLlmResolver implements IRoleLlmResolver {
  private readonly built = new Map<string, Promise<ILlm>>();

  constructor(private readonly deps: RoleLlmResolverDeps) {}

  async resolve(role: string): Promise<ILlm> {
    if (role === 'main') return this.heldMain(role);
    if (role === 'classifier') {
      const classifier = this.deps.getClassifier();
      if (classifier) return classifier;
    }
    if (role === 'helper' || role === 'planner') {
      const helper = this.deps.getHelper();
      if (helper) return helper;
    }
    const map = this.deps.getLlmMap();
    if (map && Object.hasOwn(map, role)) return this.entry(role, map[role]);
    return this.heldMain(role);
  }

  async resolveNamed(key: string): Promise<ILlm> {
    const map = this.deps.getLlmMap();
    if (!map || !Object.hasOwn(map, key)) {
      throw new Error(
        `llm: has no entry named '${key}' — a key named in configuration is resolved ` +
          `strictly (declared: ${map ? Object.keys(map).join(', ') : 'none'})`,
      );
    }
    // A declared key that names a held role answers with the HELD instance — the one
    // PUT /v1/config swaps — never a second build of the same entry (§4.6.6).
    if (key === 'main') return this.heldMain(key);
    if (key === 'classifier') {
      const classifier = this.deps.getClassifier();
      if (classifier) return classifier;
    }
    if (key === 'helper') {
      const helper = this.deps.getHelper();
      if (helper) return helper;
    }
    return this.entry(key, map[key]);
  }

  private heldMain(asked: string): ILlm {
    const main = this.deps.getMain();
    if (!main) {
      throw new Error(
        `cannot resolve LLM for role '${asked}': no main LLM is held`,
      );
    }
    return main;
  }

  private entry(key: string, cfg: SmartServerLlmConfig): Promise<ILlm> {
    const held = this.built.get(key);
    if (held) return held;
    const building = this.deps.build(cfg);
    this.built.set(key, building);
    building.catch(() => {
      if (this.built.get(key) === building) this.built.delete(key);
    });
    return building;
  }
}
