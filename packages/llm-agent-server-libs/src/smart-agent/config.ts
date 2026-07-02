/**
 * Shared config utilities for SmartServer.
 */

import path from 'node:path';
import type {
  IFinalizer,
  ILlm,
  ISubAgentContextBuilder,
  IToolSelectionStrategy,
} from '@mcp-abap-adt/llm-agent';
import {
  AutoActivation,
  ExplicitActivation,
  HybridDispatch,
  LlmFinalizer,
  OneShotPlanning,
  PassthroughFinalizer,
  ReplanOnErrorPlanning,
  ScoreThresholdToolSelection,
  SelfDispatch,
  SkillStepsPlanning,
  SubAgentDispatch,
  TemplateFinalizer,
  TopKToolSelection,
} from '@mcp-abap-adt/llm-agent-libs';
import type { NormalizedLlmMap } from './llm-config-map.js';
import { resolveLlmConfig } from './llm-config-map.js';
import { parseSkillPluginsConfig } from './skill-plugins-config.js';
import type {
  SmartServerConfig,
  SmartServerLlmConfig,
  SmartServerMode,
  SmartServerSubAgentConfig,
} from './smart-server.js';
import type { YamlConfig } from './yaml-loader.js';
import { loadYamlConfig } from './yaml-loader.js';

export type { LlmConfigMap, NormalizedLlmMap } from './llm-config-map.js';
export {
  normalizeLlmConfig,
  resolveLlmConfig,
  resolveLlmConfigStrict,
  resolveReviewerLlmName,
} from './llm-config-map.js';

export interface YamlCoordinator {
  planning?: 'one-shot' | 'replan-on-error' | 'skill-steps';
  dispatch?: 'subagent' | 'self' | 'hybrid';
  activation?: 'auto' | 'explicit';
  plannerLlm?: 'main' | 'planner' | 'helper';
  maxSteps?: number;
  maxRetriesPerStep?: number;
  failPolicy?: 'abort' | 'continue';
  maxLayer?: number;
  planner?:
    | { type?: string; plannerLlm?: 'main' | 'planner' | 'helper' }
    | Record<string, unknown>;
  interpreter?: { type?: string } | Record<string, unknown>;
  reviewer?: {
    type?: string;
    reviewerLlm?: string;
    plannerLlm?: 'main' | 'planner' | 'helper';
  };
  finalizer?: {
    type?: 'passthrough' | 'llm' | 'template';
    finalizerLlm?: string;
    systemPrompt?: string;
  };
  errorStrategy?: { type?: string; maxReplans?: number };
  stateOracle?: string;
  maxRoundTrips?: number;
}

export function resolveCoordinatorPlanning(name: string, plannerLlm: ILlm) {
  switch (name) {
    case 'one-shot':
      return new OneShotPlanning(plannerLlm);
    case 'replan-on-error':
      return new ReplanOnErrorPlanning(plannerLlm);
    case 'skill-steps':
      // SkillStepsPlanning reads `ctx.activeSkillMeta` (populated by
      // CoordinatorHandler from `ctx.selectedSkills`). No planner LLM
      // needed — the plan comes directly from the skill's `steps:` block.
      return new SkillStepsPlanning();
    default:
      throw new Error(
        `Unknown coordinator.planning strategy: '${name}'. Allowed: one-shot, replan-on-error, skill-steps.`,
      );
  }
}

/**
 * Default coordinator dispatch kind. Omitted → 'hybrid' for ALL planning kinds:
 * agentless steps — the synthesized answer-directly step (#155) and skill steps
 * without an explicit `agent:` — need a self-LLM fallback. Pin 'subagent'
 * explicitly for strict subagent-only routing.
 */
export function resolveCoordinatorDispatchKind(
  explicit?: 'subagent' | 'self' | 'hybrid',
): 'subagent' | 'self' | 'hybrid' {
  return explicit ?? 'hybrid';
}

export function resolveCoordinatorDispatch(
  name: string,
  fallbackLlm?: ILlm,
  contextBuilder?: ISubAgentContextBuilder,
) {
  switch (name) {
    case 'subagent':
      return new SubAgentDispatch(contextBuilder);
    case 'self':
      if (!fallbackLlm) {
        throw new Error(
          'coordinator.dispatch=self requires a planner or main LLM',
        );
      }
      return new SelfDispatch(fallbackLlm);
    case 'hybrid':
      if (!fallbackLlm) {
        throw new Error(
          'coordinator.dispatch=hybrid requires a planner or main LLM',
        );
      }
      return new HybridDispatch(
        new SubAgentDispatch(contextBuilder),
        new SelfDispatch(fallbackLlm),
      );
    default:
      throw new Error(
        `Unknown coordinator.dispatch strategy: '${name}'. Allowed: subagent, self, hybrid.`,
      );
  }
}

export function resolveCoordinatorActivation(name: string) {
  switch (name) {
    case 'auto':
      return new AutoActivation();
    case 'explicit':
      return new ExplicitActivation();
    default:
      throw new Error(
        `Unknown coordinator.activation strategy: '${name}'. Allowed: auto, explicit.`,
      );
  }
}

export function resolveToolSelectionStrategy(
  name: string,
  params?: { minScore?: number },
): IToolSelectionStrategy {
  switch (name) {
    case 'top-k':
      return new TopKToolSelection();
    case 'threshold': {
      const minScore = params?.minScore;
      if (typeof minScore !== 'number') {
        throw new Error(
          "agent.toolSelection.strategy 'threshold' requires a numeric 'minScore'",
        );
      }
      return new ScoreThresholdToolSelection(minScore);
    }
    default:
      throw new Error(
        `Unknown agent.toolSelection.strategy '${name}'. Allowed: top-k, threshold.`,
      );
  }
}

import {
  assertNoLegacyPipelineConfig,
  validateResolvedConfig,
} from './config-validator.js';

export {
  assertNoLegacyPipelineConfig,
  ConfigValidationError,
} from './config-validator.js';

export type { YamlConfig } from './yaml-loader.js';
export {
  generateConfigTemplate,
  loadYamlConfig,
  resolveEnvVars,
  YAML_TEMPLATE,
} from './yaml-loader.js';

export interface ResolveConfigArgs {
  port?: string | boolean;
  host?: string | boolean;
  'llm-api-key'?: string | boolean;
  'llm-model'?: string | boolean;
  'llm-temperature'?: string | boolean;
  'rag-type'?: string | boolean;
  'rag-url'?: string | boolean;
  'rag-model'?: string | boolean;
  'rag-collection-name'?: string | boolean;
  'rag-vector-weight'?: string | boolean;
  'rag-keyword-weight'?: string | boolean;
  'qdrant-api-key'?: string | boolean;
  'mcp-type'?: string | boolean;
  'mcp-url'?: string | boolean;
  'mcp-command'?: string | boolean;
  'mcp-args'?: string | boolean;
  'prompt-system'?: string | boolean;
  'prompt-classifier'?: string | boolean;
  'agent-show-reasoning'?: boolean;
  'log-dir'?: string;
  'plugin-dir'?: string;
  mode?: string | boolean;
}

export type FinalizerYaml = {
  type?: 'passthrough' | 'llm' | 'template';
  finalizerLlm?: string;
  systemPrompt?: string;
};

/**
 * Build the IFinalizer impl from `coordinator.finalizer:` YAML.
 *
 * Lookup chain for `type: llm`:
 *   resolveLlmConfig(llmMap, cfg.finalizerLlm, pipelineFallback)
 *   → top-level llm.<name> → llm.main → pipelineFallback (pipeline.llm.main)
 *   → ConfigError if all three are missing.
 *
 * Absent block / `type: passthrough` → PassthroughFinalizer.
 * `type: template` → TemplateFinalizer.
 */
export async function buildFinalizer(
  cfg: FinalizerYaml | undefined,
  llmMap: NormalizedLlmMap | undefined,
  pipelineFallback: SmartServerLlmConfig | undefined,
  makeLlm: (config: SmartServerLlmConfig) => Promise<ILlm>,
): Promise<IFinalizer> {
  const kind = cfg?.type ?? 'passthrough';
  if (kind === 'passthrough') return new PassthroughFinalizer();
  if (kind === 'template') return new TemplateFinalizer();
  // kind === 'llm'
  const resolved = resolveLlmConfig(
    llmMap,
    cfg?.finalizerLlm,
    pipelineFallback,
  );
  if (!resolved) {
    throw new Error(
      'coordinator.finalizer (type: llm) requires an LLM config: provide top-level llm.<name>, llm.main, or pipeline.llm.main',
    );
  }
  const llm = await makeLlm(resolved);
  return new LlmFinalizer(llm, {
    systemPrompt: cfg?.systemPrompt,
  });
}

const get = (obj: unknown, ...keys: string[]): unknown =>
  keys.reduce<unknown>((o, k) => {
    if (o !== null && typeof o === 'object' && k in o) {
      return (o as Record<string, unknown>)[k];
    }
    return undefined;
  }, obj);

/**
 * Recursively parse the top-level `subagents:` block from a YAML config.
 *
 * Each entry references a sibling YAML file whose resolved config (sans
 * `subagents:` itself — nested orchestration is rejected) becomes a
 * `SmartServerSubAgentConfig`. Relative `config:` paths are resolved
 * against `configPath`'s directory. A `subagents:` block inside a
 * sub-YAML is rejected to guard against unbounded recursion.
 *
 * Returns `undefined` when the parent YAML has no `subagents:` block or
 * when `configPath` is not provided (relative paths cannot be resolved).
 */
function parseSubAgents(
  yaml: YamlConfig,
  configPath: string | undefined,
  args: ResolveConfigArgs,
  env: NodeJS.ProcessEnv,
): SmartServerSubAgentConfig[] | undefined {
  const raw = (yaml as { subagents?: unknown }).subagents;
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  if (!configPath) {
    throw new Error(
      "subagents: parent YAML must be loaded from a file path so 'config' entries can be resolved",
    );
  }

  const baseDir = path.dirname(path.resolve(configPath));
  const out: SmartServerSubAgentConfig[] = [];
  for (const entry of raw) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      typeof (entry as { name?: unknown }).name !== 'string' ||
      typeof (entry as { config?: unknown }).config !== 'string'
    ) {
      throw new Error(
        `subagents[]: each entry needs 'name' and 'config' (got ${JSON.stringify(entry)})`,
      );
    }
    const name = (entry as { name: string }).name;
    const cfgRel = (entry as { config: string }).config;
    const description = (entry as { description?: unknown }).description;
    if (description !== undefined && typeof description !== 'string') {
      throw new Error(
        `subagents[].description must be a string when present (got ${JSON.stringify(description)})`,
      );
    }
    const subConfigPath = path.isAbsolute(cfgRel)
      ? cfgRel
      : path.resolve(baseDir, cfgRel);

    const subYaml = loadYamlConfig(subConfigPath, env);
    if ((subYaml as { subagents?: unknown }).subagents !== undefined) {
      throw new Error(
        `subagent '${name}' must not define its own 'subagents:' (nested orchestration is not supported)`,
      );
    }

    // Loudly reject fields that the sub-agent builder silently drops today.
    // Keeps the contract honest: if a sub YAML declares these, it gets an
    // error rather than a misleadingly-quiet partial config.
    const unsupported: string[] = [];
    if ((subYaml as { pluginDir?: unknown }).pluginDir !== undefined) {
      unsupported.push('pluginDir');
    }
    if ((subYaml as { plugins?: unknown }).plugins !== undefined) {
      unsupported.push('plugins');
    }
    if ((subYaml as { clientAdapter?: unknown }).clientAdapter !== undefined) {
      unsupported.push('clientAdapter');
    }
    if (
      (subYaml as { circuitBreaker?: unknown }).circuitBreaker !== undefined
    ) {
      unsupported.push('circuitBreaker');
    }
    // A subagent's `pipeline:` (if present) is the new `{name, config}` shape;
    // there are no per-subagent reranker/queryExpander/outputValidator/rag
    // overrides to reject anymore (they were tied to the removed legacy shape).
    if (unsupported.length > 0) {
      throw new Error(
        `subagent '${name}': unsupported fields [${unsupported.join(', ')}]`,
      );
    }

    // Recursive call — we just verified the sub YAML has no `subagents:`, so
    // the parseSubAgents call inside will short-circuit to undefined.
    const subResolved = resolveSmartServerConfig(args, subYaml, env, {
      configPath: subConfigPath,
    });
    out.push({ name, description, config: subResolved });
  }
  return out;
}

export interface ResolveSmartServerConfigOptions {
  /**
   * Filesystem path of the YAML config that produced `yaml`. Required for
   * resolving relative `subagents[].config` paths. When omitted, a `subagents:`
   * block in `yaml` will cause an error.
   */
  configPath?: string;

  /** When true, SKIP provider-runtime validation — credential checks
   *  (apiKey / AICORE_SERVICE_KEY) and `*.model` required — keeping STRUCTURAL
   *  checks. Set by embeddable callers that inject their own makeLlm + embedder.
   *  Default false → server behaviour unchanged. */
  skipProviderRuntimeChecks?: boolean;
}

export function resolveSmartServerConfig(
  args: ResolveConfigArgs = {},
  yaml: YamlConfig = {},
  env: NodeJS.ProcessEnv = process.env,
  options: ResolveSmartServerConfigOptions = {},
): Omit<SmartServerConfig, 'log'> {
  // Clean-break migration guard FIRST — before any pipeline-shape parsing — so a
  // legacy `coordinator:`/`pipeline:` config gets the actionable migration error
  // rather than the generic "pipeline requires a name" diagnostic.
  assertNoLegacyPipelineConfig(yaml);

  // API key derives solely from the top-level `llm:` block now (the legacy
  // `pipeline.llm.main.apiKey` override was removed with the schema migration).
  const apiKey = (get(yaml, 'llm', 'apiKey') as string) ?? '';

  const rawMcp = yaml.mcp;
  const mcpIsArray = Array.isArray(rawMcp);
  const mcpUrl = get(yaml, 'mcp', 'url') as string | undefined;
  const mcpCommand = get(yaml, 'mcp', 'command') as string | undefined;
  const mcpTypeRaw = mcpIsArray
    ? null // array form: type resolved per-entry inside connectMcpClientsFromConfig
    : ((get(yaml, 'mcp', 'type') as string) ??
      (mcpUrl ? 'http' : mcpCommand ? 'stdio' : null));
  const mcpType = (mcpTypeRaw === 'none' ? null : mcpTypeRaw) as
    | 'http'
    | 'stdio'
    | null;

  const promptSystem = (get(yaml, 'prompts', 'system') as string) ?? null;
  const promptClassifier =
    (get(yaml, 'prompts', 'classifier') as string) ?? null;
  const promptReasoning = get(yaml, 'prompts', 'reasoning') ?? null;
  const promptRagTranslate = get(yaml, 'prompts', 'ragTranslate') ?? null;
  const promptHistorySummary = get(yaml, 'prompts', 'historySummary') ?? null;

  const resolved: Omit<SmartServerConfig, 'log'> = {
    port: Number(
      (args.port as string) ?? get(yaml, 'port') ?? env.PORT ?? 4004,
    ),
    host: (args.host as string) ?? get(yaml, 'host') ?? '0.0.0.0',
    llm: get(yaml, 'llm')
      ? typeof get(yaml, 'llm', 'provider') === 'string'
        ? {
            provider: get(yaml, 'llm', 'provider') as
              | 'deepseek'
              | 'openai'
              | 'anthropic'
              | 'sap-ai-sdk'
              | 'ollama'
              | undefined,
            apiKey,
            url: get(yaml, 'llm', 'url') as string | undefined,
            model: get(yaml, 'llm', 'model') as string | undefined,
            temperature: Number(get(yaml, 'llm', 'temperature') ?? 0.7),
            classifierTemperature: Number(
              get(yaml, 'llm', 'classifierTemperature') ?? 0.1,
            ),
          }
        : (get(yaml, 'llm') as Record<string, SmartServerLlmConfig>)
      : undefined,
    rag: get(yaml, 'rag')
      ? {
          type: get(yaml, 'rag', 'type') as
            | 'in-memory'
            | 'qdrant'
            | 'hana-vector'
            | 'pg-vector'
            | undefined,
          embedder: (get(yaml, 'rag', 'embedder') as string) ?? undefined,
          url: get(yaml, 'rag', 'url') as string | undefined,
          model: get(yaml, 'rag', 'model') as string | undefined,
          collectionName:
            (args['rag-collection-name'] as string) ??
            get(yaml, 'rag', 'collectionName') ??
            undefined,
          dedupThreshold: Number(get(yaml, 'rag', 'dedupThreshold') ?? 0.92),
          vectorWeight: Number(get(yaml, 'rag', 'vectorWeight') ?? 0.7),
          keywordWeight: Number(get(yaml, 'rag', 'keywordWeight') ?? 0.3),
          ...(get(yaml, 'rag', 'resourceGroup') !== undefined
            ? { resourceGroup: String(get(yaml, 'rag', 'resourceGroup')) }
            : {}),
          ...(get(yaml, 'rag', 'scenario') !== undefined
            ? {
                scenario: String(get(yaml, 'rag', 'scenario')) as
                  | 'orchestration'
                  | 'foundation-models',
              }
            : {}),
        }
      : undefined,
    mcp: mcpIsArray
      ? // Array form: pass through as-is so connectMcpClientsFromConfig can
        // iterate and connect each entry. Typed as SmartServerMcpConfig[].
        (rawMcp as import('./smart-server.js').SmartServerMcpConfig[])
      : mcpType
        ? {
            type: mcpType,
            url: mcpUrl || undefined,
            command: mcpCommand || undefined,
            args:
              (args['mcp-args'] as string) || get(yaml, 'mcp', 'args')
                ? String(args['mcp-args'] || get(yaml, 'mcp', 'args')).split(
                    ' ',
                  )
                : undefined,
            headers:
              (get(yaml, 'mcp', 'headers') as Record<string, string>) ||
              undefined,
          }
        : undefined,
    agent: {
      externalToolsValidationMode: (get(
        yaml,
        'agent',
        'externalToolsValidationMode',
      ) ?? 'permissive') as string as 'permissive' | 'strict',
      maxIterations: Number(get(yaml, 'agent', 'maxIterations') ?? 10),
      maxToolCalls: Number(get(yaml, 'agent', 'maxToolCalls') ?? 30),
      toolUnavailableTtlMs: Number(
        get(yaml, 'agent', 'toolUnavailableTtlMs') ?? 600000,
      ),
      ragQueryK: Number(get(yaml, 'agent', 'ragQueryK') ?? 10),
      ...(get(yaml, 'agent', 'contextBudgetTokens') !== undefined
        ? {
            contextBudgetTokens: Number(
              get(yaml, 'agent', 'contextBudgetTokens'),
            ),
          }
        : {}),
      ...(get(yaml, 'agent', 'semanticHistoryEnabled') !== undefined
        ? {
            semanticHistoryEnabled: Boolean(
              get(yaml, 'agent', 'semanticHistoryEnabled'),
            ),
          }
        : {}),
      ...(get(yaml, 'agent', 'historyRecencyWindow') !== undefined
        ? {
            historyRecencyWindow: Number(
              get(yaml, 'agent', 'historyRecencyWindow'),
            ),
          }
        : {}),
      ...(get(yaml, 'agent', 'historyTurnSummaryPrompt') !== undefined
        ? {
            historyTurnSummaryPrompt: String(
              get(yaml, 'agent', 'historyTurnSummaryPrompt'),
            ),
          }
        : {}),
      showReasoning: Boolean(
        args['agent-show-reasoning'] ??
          get(yaml, 'agent', 'showReasoning') ??
          false,
      ),
      historyAutoSummarizeLimit: Number(
        get(yaml, 'agent', 'historyAutoSummarizeLimit') ?? 10,
      ),
      queryExpansionEnabled: Boolean(
        get(yaml, 'agent', 'queryExpansionEnabled') ?? false,
      ),
      toolResultCacheTtlMs: Number(
        get(yaml, 'agent', 'toolResultCacheTtlMs') ?? 300000,
      ),
      sessionTokenBudget: Number(get(yaml, 'agent', 'sessionTokenBudget') ?? 0),
      ...(get(yaml, 'agent', 'classificationEnabled') !== undefined
        ? {
            classificationEnabled: Boolean(
              get(yaml, 'agent', 'classificationEnabled'),
            ),
          }
        : {}),
      ...(get(yaml, 'agent', 'toolReselectPerIteration') !== undefined
        ? {
            toolReselectPerIteration: Boolean(
              get(yaml, 'agent', 'toolReselectPerIteration'),
            ),
          }
        : {}),
      ...(get(yaml, 'agent', 'ragTranslateEnabled') !== undefined
        ? {
            ragTranslateEnabled: Boolean(
              get(yaml, 'agent', 'ragTranslateEnabled'),
            ),
          }
        : {}),
      ...(get(yaml, 'agent', 'refreshToolsPerIteration') !== undefined
        ? {
            refreshToolsPerIteration: Boolean(
              get(yaml, 'agent', 'refreshToolsPerIteration'),
            ),
          }
        : {}),
      ...(get(yaml, 'agent', 'streamMode') !== undefined
        ? {
            streamMode: String(get(yaml, 'agent', 'streamMode')) as
              | 'full'
              | 'final',
          }
        : {}),
      ...(get(yaml, 'agent', 'llmCallStrategy') !== undefined
        ? {
            llmCallStrategy: String(get(yaml, 'agent', 'llmCallStrategy')) as
              | 'streaming'
              | 'non-streaming'
              | 'fallback',
          }
        : {}),
      ...(get(yaml, 'agent', 'heartbeatIntervalMs') !== undefined
        ? {
            heartbeatIntervalMs: Number(
              get(yaml, 'agent', 'heartbeatIntervalMs'),
            ),
          }
        : {}),
      ...(get(yaml, 'agent', 'healthTimeoutMs') !== undefined
        ? {
            healthTimeoutMs: Number(get(yaml, 'agent', 'healthTimeoutMs')),
          }
        : {}),
      ...(get(yaml, 'agent', 'retry') !== undefined
        ? {
            retry: get(yaml, 'agent', 'retry') as {
              maxAttempts?: number;
              backoffMs?: number;
              retryOn?: number[];
              retryOnMidStream?: string[];
            },
          }
        : {}),
      ...(get(yaml, 'agent', 'toolSelection') !== undefined
        ? {
            toolSelection: get(yaml, 'agent', 'toolSelection') as {
              strategy: string;
              minScore?: number;
            },
          }
        : {}),
    },
    prompts:
      promptSystem ||
      promptClassifier ||
      promptReasoning ||
      promptRagTranslate ||
      promptHistorySummary
        ? {
            ...(promptSystem ? { system: promptSystem } : {}),
            ...(promptClassifier ? { classifier: promptClassifier } : {}),
            ...(typeof promptReasoning === 'string'
              ? { reasoning: promptReasoning }
              : {}),
            ...(typeof promptRagTranslate === 'string'
              ? { ragTranslate: promptRagTranslate }
              : {}),
            ...(typeof promptHistorySummary === 'string'
              ? { historySummary: promptHistorySummary }
              : {}),
          }
        : undefined,
    mode: (get(yaml, 'mode') as SmartServerMode) ?? undefined,
    logDir: (args['log-dir'] as string) ?? get(yaml, 'logDir') ?? null,
    pluginDir:
      (args['plugin-dir'] as string) ?? get(yaml, 'pluginDir') ?? undefined,
    plugins: (() => {
      const raw = get(yaml, 'plugins');
      if (!Array.isArray(raw)) return undefined;
      const specs = raw.filter((s): s is string => typeof s === 'string');
      return specs.length > 0 ? specs : undefined;
    })(),
    ...(() => {
      const subAgentConfigs = parseSubAgents(
        yaml,
        options.configPath,
        args,
        env,
      );
      return subAgentConfigs ? { subAgentConfigs } : {};
    })(),
    ...(() => {
      // Pipeline selection: `pipeline: { name, config }`. `name` is required;
      // `config` is the plugin's opaque dialect (validated by the plugin's
      // parseConfig at build time). A bare string (`pipeline: stepper`) is
      // accepted as shorthand for `{ name: <string> }`.
      const raw = (yaml as { pipeline?: unknown }).pipeline;
      if (raw === undefined || raw === null) return {};
      if (typeof raw === 'string') return { pipeline: { name: raw } };
      const obj = raw as { name?: unknown; config?: unknown };
      if (typeof obj.name !== 'string') {
        throw new Error(
          "pipeline: requires a 'name' (one of: flat, linear, dag, stepper, controller, controller-weak, or a registered plugin)",
        );
      }
      return {
        pipeline: {
          name: obj.name,
          ...(obj.config && typeof obj.config === 'object'
            ? { config: obj.config as Record<string, unknown> }
            : {}),
        },
      };
    })(),
    ...(yaml.skills
      ? {
          skills: {
            type: (get(yaml, 'skills', 'type') ?? 'claude') as
              | 'claude'
              | 'codex'
              | 'filesystem',
            dirs: get(yaml, 'skills', 'dirs') as string[] | undefined,
            projectRoot: get(yaml, 'skills', 'projectRoot') as
              | string
              | undefined,
          },
        }
      : {}),
    ...(yaml.skillPlugins
      ? { skillPlugins: parseSkillPluginsConfig(yaml.skillPlugins) }
      : {}),
  };
  validateResolvedConfig(resolved, yaml, env, {
    skipProviderRuntimeChecks: options.skipProviderRuntimeChecks,
  });
  return resolved;
}

export type {
  CompositionNode,
  StepperCompositionSpec,
  StepperCoordinatorConfig,
  StepperMode,
} from './stepper-config.js';
export { parseStepperCoordinatorConfig } from './stepper-config.js';
