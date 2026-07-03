/**
 * Shared config utilities for SmartServer.
 */

import path from 'node:path';
import {
  assertNoLegacyPipelineConfig,
  validateResolvedConfig,
} from './config-validator.js';
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
} from './smart-server.js';
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
  ConfigValidationError,
} from './config-validator.js';
export type { LlmConfigMap, NormalizedLlmMap } from './llm-config-map.js';
export {
  normalizeLlmConfig,
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

  const resolved: Omit<SmartServerConfig, 'log'> = {
    port: Number(
      (args.port as string) ?? get(yaml, 'port') ?? env.PORT ?? 4004,
    ),
    host: (args.host as string) ?? get(yaml, 'host') ?? '0.0.0.0',
    llm: resolveLlmSection(yaml, apiKey),
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
