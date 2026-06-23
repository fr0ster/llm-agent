import type { IMcpClient } from '@mcp-abap-adt/llm-agent';
import type { PlannerKind } from '../smart-agent/controller/types.js';
import type {
  SmartServerConfig,
  SmartServerLlmConfig,
  SmartServerMcpConfig,
} from '../smart-agent/smart-server.js';

export interface BuilderLlmInput {
  provider: 'sap-ai-sdk' | 'openai' | 'anthropic' | 'deepseek' | 'ollama';
  model?: string;
  apiKey?: string;
  url?: string;
  temperature?: number;
  maxTokens?: number;
}
export interface BuilderSkillSourceInput {
  github: string;
  enabled: readonly string[];
  collection?: string;
  ref?: string;
  token?: string;
}
export interface BuilderEmbedderInput {
  provider: string;
  model?: string;
  scenario?: string;
  resourceGroup?: string;
}
type Role = 'evaluator' | 'planner' | 'executor';

const KEYLESS = new Set(['sap-ai-sdk', 'ollama']);
const ENV_KEY: Record<string, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
};

function toLlmConfig(input: BuilderLlmInput): SmartServerLlmConfig {
  let apiKey = input.apiKey ?? '';
  if (!KEYLESS.has(input.provider) && apiKey === '') {
    apiKey = process.env[ENV_KEY[input.provider] ?? ''] ?? '';
    if (apiKey === '') {
      throw new Error(
        `ControllerSkillPipelineBuilder: provider '${input.provider}' needs an apiKey — ` +
          `pass it to .withLlm()/.withRoleLlm() or set ${ENV_KEY[input.provider]}`,
      );
    }
  }
  return {
    provider: input.provider,
    apiKey,
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.url !== undefined ? { url: input.url } : {}),
    ...(input.temperature !== undefined
      ? { temperature: input.temperature }
      : {}),
    ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
  } as SmartServerLlmConfig;
}

export class ControllerSkillPipelineBuilder {
  private _llm?: BuilderLlmInput;
  private _roleLlm: Partial<Record<Role, BuilderLlmInput>> = {};
  private _mcp: SmartServerMcpConfig[] = [];
  // will be read by build() in the next task
  private _mcpClients?: IMcpClient[];
  private _skill?: BuilderSkillSourceInput;
  private _embedder?: BuilderEmbedderInput;
  private _budgets: Record<string, unknown> = {};
  private _targetState: Record<string, unknown> = {};
  private _plannerKind: PlannerKind = 'smart-executor';

  withLlm(cfg: BuilderLlmInput): this {
    this._llm = cfg;
    return this;
  }
  withRoleLlm(role: Role, cfg: BuilderLlmInput): this {
    this._roleLlm[role] = cfg;
    return this;
  }
  withMcp(cfg: { url: string; headers?: Record<string, string> }): this {
    this._mcp.push({
      type: 'http',
      url: cfg.url,
      ...(cfg.headers ? { headers: cfg.headers } : {}),
    } as SmartServerMcpConfig);
    return this;
  }
  withMcpClients(clients: IMcpClient[]): this {
    this._mcpClients = clients;
    return this;
  }
  /**
   * Pre-built MCP clients accumulated via {@link withMcpClients}. Consumed by
   * `build()` in the next task; exposed here as a protected accessor so the
   * field is `read` (satisfies `noUnusedLocals`, which flags unused private
   * members under TS 5.x) ahead of that task.
   */
  protected get mcpClients(): IMcpClient[] | undefined {
    return this._mcpClients;
  }
  withSkillSource(cfg: BuilderSkillSourceInput): this {
    this._skill = cfg;
    return this;
  }
  withEmbedder(cfg: BuilderEmbedderInput): this {
    this._embedder = cfg;
    return this;
  }
  withBudgets(b: Record<string, unknown>): this {
    this._budgets = { ...this._budgets, ...b };
    return this;
  }
  withTargetState(t: Record<string, unknown>): this {
    this._targetState = { ...this._targetState, ...t };
    return this;
  }
  withPlanner(kind: PlannerKind): this {
    this._plannerKind = kind;
    return this;
  }

  toConfig(): SmartServerConfig {
    if (!this._llm && Object.keys(this._roleLlm).length === 0) {
      throw new Error(
        'ControllerSkillPipelineBuilder: call .withLlm() (or .withRoleLlm() for all roles) before building',
      );
    }
    if (!this._skill) {
      throw new Error(
        'ControllerSkillPipelineBuilder: call .withSkillSource() before building',
      );
    }
    if (!this._embedder) {
      throw new Error(
        'ControllerSkillPipelineBuilder: call .withEmbedder() before building (skills need an embedder)',
      );
    }
    const base = this._llm ? toLlmConfig(this._llm) : undefined;
    const roleCfg = (r: Role): SmartServerLlmConfig => {
      const ovr = this._roleLlm[r];
      if (ovr) return toLlmConfig(ovr);
      if (base) return base;
      throw new Error(
        `ControllerSkillPipelineBuilder: no LLM for role '${r}' (set .withLlm() or .withRoleLlm('${r}', …))`,
      );
    };
    const collection = this._skill.collection ?? 'sap';
    return {
      llm: { main: base ?? roleCfg('executor') },
      pipeline: {
        name:
          this._plannerKind === 'weak-executor'
            ? 'controller-weak'
            : 'controller',
        config: {
          subagents: {
            evaluator: roleCfg('evaluator'),
            planner: roleCfg('planner'),
            executor: roleCfg('executor'),
          },
          ...(Object.keys(this._targetState).length
            ? { targetState: this._targetState }
            : {}),
          ...(Object.keys(this._budgets).length
            ? { budgets: this._budgets }
            : {}),
        },
      },
      rag: {
        type: 'in-memory',
        embedder: this._embedder.provider,
        ...(this._embedder.model ? { model: this._embedder.model } : {}),
        ...(this._embedder.scenario
          ? { scenario: this._embedder.scenario }
          : {}),
        ...(this._embedder.resourceGroup
          ? { resourceGroup: this._embedder.resourceGroup }
          : {}),
      },
      ...(this._mcp.length ? { mcp: this._mcp } : {}),
      skillPlugins: {
        store: { type: 'in-memory' },
        embedder: {
          provider: this._embedder.provider,
          ...(this._embedder.model ? { model: this._embedder.model } : {}),
        },
        controllerSkillGroup: collection,
        sources: [
          {
            id: 'skills',
            github: this._skill.github,
            enabled: this._skill.enabled,
            ...(this._skill.ref ? { ref: this._skill.ref } : {}),
            ...(this._skill.token ? { token: this._skill.token } : {}),
            strategy: 'single-collection',
            strategyConfig: { collection },
          },
        ],
      },
    } as unknown as SmartServerConfig;
  }
}
