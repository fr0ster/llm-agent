/**
 * Shared config utilities for SmartServer.
 */

import path from 'node:path';
import {
  ConfigFieldError,
  checkDocument,
  checkSkills,
  checkStartConfig,
  FieldCheck,
  present,
  SERVER_MODES,
  START_NUMBER_RULES,
} from './config-fields.js';
import {
  assertNoLegacyPipelineConfig,
  assertNoLegacyRagShape,
  validateResolvedConfig,
} from './config-validator.js';
import { normalizeLlmConfig } from './llm-config-map.js';
import {
  resolveAgentSection,
  resolveDecisionSection,
  resolveLlmSection,
  resolveMcpSection,
  resolvePipelineSelection,
  resolvePromptsSection,
  resolveRagSection,
} from './resolve-config-sections.js';
import { parseSkillPluginsConfig } from './skill-plugins-config.js';
import type {
  SmartServerConfig,
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
  /** The CLI's log file — over `log` and `env.LOG_FILE`; validated, read back as `logFile`. */
  'log-file'?: string | boolean;
  /** The CLI logs to stdout: `env.LOG_FILE` is not the source used, so it is not read. */
  'log-stdout'?: boolean;
  'plugin-dir'?: string;
  mode?: string | boolean;
}

/** `fn` for worker `name`'s file: a field error names the worker and its file (spec D83 (5), (14)). */
function inWorker<T>(name: string, file: string, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof ConfigFieldError) {
      throw new ConfigFieldError(
        err.issues.map((i) => `subagent '${name}' (${file}): ${i}`),
      );
    }
    throw err;
  }
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
  // Strategies are server-wide (§13.4): never silently ignored in a worker.
  if ((get(subYaml, 'rag', 'retrieval') ?? undefined) !== undefined) {
    throw new Error(
      `subagent '${name}' rag.retrieval: strategies are server-wide — set them in the main config's rag.retrieval`,
    );
  }
  const { llm: rawLlm, ...withoutLlm } = subYaml;
  const llm = parseWorkerLlm(name, rawLlm);
  const resolved = inWorker(name, subConfigPath, () =>
    resolveSmartServerConfig(args, withoutLlm, env, {
      configPath: subConfigPath,
      requireLlmSection: false,
    }),
  );
  // The log file is the process's (the CLI's), never a worker's.
  const { llm: _none, logFile: _logFile, ...rest } = resolved;
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

    // Spec D83 (14): the worker's document is a mapping before anything of it
    // is read (30.1.0: an empty file was a TypeError, a string or a list was
    // read as a worker with no fields).
    const subYaml = inWorker(name, subConfigPath, () =>
      checkDocument(loadYamlConfig(subConfigPath, env)),
    );
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

/**
 * The start config `resolveSmartServerConfig` returns: the server's config
 * without its logger, and the validated log file the CLI opens for it
 * (`undefined` when none is written — the CLI's default applies). Internal —
 * not a new exported name.
 */
type ResolvedSmartServerConfig = Omit<SmartServerConfig, 'log'> & {
  readonly logFile?: string;
};

export function resolveSmartServerConfig(
  args: ResolveConfigArgs = {},
  input: YamlConfig = {},
  env: NodeJS.ProcessEnv = process.env,
  options: ResolveSmartServerConfigOptions = {},
): ResolvedSmartServerConfig {
  // Spec D83 (14): the document is a mapping before anything of it is read.
  const yaml = checkDocument(input);
  // Clean-break migration guard FIRST — before any pipeline-shape parsing — so a
  // legacy `coordinator:`/`pipeline:` config gets the actionable migration error
  // rather than the generic "pipeline requires a name" diagnostic.
  assertNoLegacyPipelineConfig(yaml);
  assertNoLegacyRagShape(yaml);

  // Every config field the start reads, one check (spec §10.5.9, D83 (5), (7)):
  // the reload table's fields first, then each section reader's own — the
  // reload's and PUT's validator, grammar and error; an invalid value fails the
  // start, never coerced. The CLI's catch writes it to stderr and exits 1, as for
  // any unusable start config.
  const check = new FieldCheck();
  const fields = checkStartConfig(check, yaml, args);
  const R = START_NUMBER_RULES;
  // Every key read from this file, each checked inside the literal — so every
  // field is checked before `done` (spec D83 (7)).
  const own = {
    port: check.numberOr(
      args.port !== undefined
        ? 'args.port'
        : get(yaml, 'port') !== undefined
          ? 'port'
          : 'env.PORT',
      R.port,
      args.port ?? get(yaml, 'port') ?? env.PORT,
      4004,
    ),
    // Spec D83 (9): the cast-read top-level fields, the source used named so.
    host:
      (args.host ?? get(yaml, 'host')) !== undefined
        ? (check.text(
            args.host !== undefined ? 'args.host' : 'host',
            args.host ?? get(yaml, 'host'),
          ) ?? '')
        : '0.0.0.0',
    llm: resolveLlmSection(yaml, check),
    rag: resolveRagSection(
      yaml,
      args as Record<string, unknown>,
      fields,
      check,
    ),
    mcp: resolveMcpSection(yaml, args as Record<string, unknown>, check),
    agent: resolveAgentSection(yaml, fields, check),
    prompts: resolvePromptsSection(fields),
    mode:
      get(yaml, 'mode') !== undefined
        ? check.oneOf('mode', SERVER_MODES, get(yaml, 'mode'))
        : undefined,
    // The override is already applied (checkStartConfig, D83 (5)). Absent: the
    // 30.1.0 value, `null` (its old expression was typed `string` by a cast;
    // `SmartServerConfig.logDir` is unchanged here).
    logDir: fields.logDir ?? (null as unknown as string | undefined),
    // Spec D83 (13), (14): the CLI's log file — a value that is not a
    // non-empty string is an error naming its source (30.1.0 read it through a
    // cast: `log: 5` was a TypeError, `log: ""` stdout). The YAML `log` is the
    // document's, checked always (also under --log-stdout); `--log-file` when
    // given. `LOG_FILE` is the environment: `""` is unset (a deploy template's
    // unset param), and a value is checked only when it is the source used —
    // no `--log-file`, no `log`, no `--log-stdout`.
    ...(() => {
      const yamlLog = get(yaml, 'log');
      const fromYaml =
        yamlLog !== undefined ? check.text('log', yamlLog) : undefined;
      if (args['log-file'] !== undefined)
        return { logFile: check.text('args.log-file', args['log-file']) };
      if (yamlLog !== undefined) return { logFile: fromYaml };
      const envLog = env.LOG_FILE;
      return envLog !== undefined &&
        envLog !== '' &&
        args['log-stdout'] !== true
        ? { logFile: check.text('env.LOG_FILE', envLog) }
        : {};
    })(),
    pluginDir:
      (args['plugin-dir'] ?? get(yaml, 'pluginDir')) !== undefined
        ? check.text(
            args['plugin-dir'] !== undefined ? 'args.plugin-dir' : 'pluginDir',
            args['plugin-dir'] ?? get(yaml, 'pluginDir'),
          )
        : undefined,
    plugins: (() => {
      const raw = get(yaml, 'plugins');
      if (!present(raw)) return undefined;
      const specs = check.list('plugins', raw, (f, v) => check.text(f, v));
      return specs && specs.length > 0 ? specs : undefined; // an empty list stays "no plugins", as in 30.1.0
    })(),
    ...(present(yaml.skills)
      ? { skills: checkSkills(check, yaml.skills) }
      : {}),
    ...resolvePipelineSelection(yaml, check),
    ...(() => {
      const decision = resolveDecisionSection(yaml, check);
      return decision ? { decision } : {};
    })(),
  };
  // Every invalid field of this file in one ConfigFieldError — the only way
  // `own` leaves the check; nothing after this line checks a field of this file.
  const valid = check.done(own);
  // A worker file and `skillPlugins` are parsed only after this file's own
  // fields passed.
  const resolved: ResolvedSmartServerConfig = {
    ...valid,
    ...(() => {
      const subAgentConfigs = parseSubAgents(
        yaml,
        options.configPath,
        args,
        env,
      );
      return subAgentConfigs ? { subAgentConfigs } : {};
    })(),
    // Spec D83 (12): a present skillPlugins reaches its parser, which refuses
    // a wrong shape (30.1.0: `false` → no skill plugins).
    ...(present(yaml.skillPlugins)
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
