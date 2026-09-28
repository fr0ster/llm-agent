/**
 * Shared config utilities for SmartServer.
 */

import path from 'node:path';
import {
  assertNoLegacyPipelineConfig,
  assertNoLegacyRagShape,
  validateResolvedConfig,
} from './config-validator.js';
import { normalizeLlmConfig } from './llm-config-map.js';
import {
  resolveAgentSection,
  resolveLlmSection,
  resolveMcpSection,
  resolvePipelineSelection,
  resolvePromptsSection,
  resolveRagSection,
} from './resolve-config-sections.js';
import { parseSkillPluginsConfig } from './skill-plugins-config.js';
import type {
  SmartServerConfig,
  SmartServerMode,
  SmartServerSubAgentConfig,
  SmartServerWorkerConfig,
} from './smart-server.js';
import { assertWorkerLlmConfig, parseWorkerLlm } from './worker-llm.js';
import type { YamlConfig } from './yaml-loader.js';
import { get, loadYamlConfig } from './yaml-loader.js';

export type {
  FinalizerYaml,
  YamlCoordinator,
} from '../pipelines/coordinator-resolvers.js';
export {
  buildFinalizer,
  resolveCoordinatorActivation,
  resolveCoordinatorDispatch,
  resolveCoordinatorDispatchKind,
  resolveCoordinatorPlanning,
  resolveToolSelectionStrategy,
} from '../pipelines/coordinator-resolvers.js';
export {
  assertNoLegacyPipelineConfig,
  assertNoLegacyRagShape,
  ConfigValidationError,
} from './config-validator.js';
export type { LlmConfigMap, NormalizedLlmMap } from './llm-config-map.js';
export {
  normalizeLlmConfig,
  optionalNumber,
  resolveLlmConfig,
  resolveLlmConfigStrict,
  resolveReviewerLlmName,
} from './llm-config-map.js';

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
  'llm-model'?: string | boolean;
  'llm-temperature'?: string | boolean;
  'rag-type'?: string | boolean;
  'rag-url'?: string | boolean;
  'rag-model'?: string | boolean;
  'rag-collection-name'?: string | boolean;
  'rag-vector-weight'?: string | boolean;
  'rag-keyword-weight'?: string | boolean;
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

/** Resolve a DAG worker file (§4.6.7): its `llm` is read as keys of the main
 *  file's map, and the rest resolves like a main file minus the llm: section. */
function resolveWorkerConfig(
  name: string,
  args: ResolveConfigArgs,
  subYaml: YamlConfig,
  env: NodeJS.ProcessEnv,
  subConfigPath: string,
): SmartServerWorkerConfig {
  const { llm: rawLlm, ...withoutLlm } = subYaml;
  const llm = parseWorkerLlm(name, rawLlm);
  const { llm: _none, ...rest } = resolveSmartServerConfig(
    args,
    withoutLlm,
    env,
    {
      configPath: subConfigPath,
      requireLlmSection: false,
    },
  );
  return { ...rest, llm };
}

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

    // The worker file names keys of THIS file's llm: map (§4.6.7); the key
    // check runs in resolveSmartServerConfig once this file's map is validated.
    const subResolved = resolveWorkerConfig(
      name,
      args,
      subYaml,
      env,
      subConfigPath,
    );
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

  /** When true, SKIP provider-runtime validation — `*.model` required — keeping
   *  STRUCTURAL checks, which include refusing a secret field. Set by embeddable
   *  callers that inject their own embedder. Default false. */
  skipProviderRuntimeChecks?: boolean;

  /** When false, a missing `llm:` section is not an error. Set only for a DAG
   *  worker file, whose models are keys of the main file's map (§4.6.7). */
  requireLlmSection?: boolean;
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
  assertNoLegacyRagShape(yaml);

  const resolved: Omit<SmartServerConfig, 'log'> = {
    port: Number(
      (args.port as string) ?? get(yaml, 'port') ?? env.PORT ?? 4004,
    ),
    host: (args.host as string) ?? get(yaml, 'host') ?? '0.0.0.0',
    llm: resolveLlmSection(yaml),
    rag: resolveRagSection(yaml, args as Record<string, unknown>),
    mcp: resolveMcpSection(yaml, args as Record<string, unknown>),
    agent: resolveAgentSection(yaml, args as Record<string, unknown>),
    prompts: resolvePromptsSection(yaml),
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
    ...resolvePipelineSelection(yaml),
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
    requireLlmSection: options.requireLlmSection,
  });
  // Worker files named keys of THIS file's llm: map; now that the map is
  // validated, check every named key has an entry (§4.6.7).
  assertWorkerLlmConfig(
    resolved.subAgentConfigs,
    normalizeLlmConfig(resolved.llm),
  );
  return resolved;
}

export type {
  CompositionNode,
  StepperCompositionSpec,
  StepperCoordinatorConfig,
  StepperMode,
} from './stepper-config.js';
export { parseStepperCoordinatorConfig } from './stepper-config.js';
