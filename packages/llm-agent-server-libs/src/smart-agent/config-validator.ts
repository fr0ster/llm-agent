import type { SmartServerConfig } from './smart-server.js';
import type { YamlConfig } from './yaml-loader.js';
import { get } from './yaml-loader.js';

const VALID_PROVIDERS = [
  'openai',
  'anthropic',
  'deepseek',
  'sap-ai-sdk',
  'ollama',
] as const;

const VALID_RAG_TYPES = [
  'in-memory',
  'qdrant',
  'hana-vector',
  'pg-vector',
] as const;

export class ConfigValidationError extends Error {
  constructor(issues: string[]) {
    super(
      `Configuration error in smart-server.yaml:\n${issues
        .map((i) => `  - ${i}`)
        .join('\n')}\nSet these fields in your YAML and restart.`,
    );
    this.name = 'ConfigValidationError';
  }
}

function checkCredentialRef(
  label: string,
  value: unknown,
  issues: string[],
): void {
  if (
    value !== undefined &&
    (typeof value !== 'string' || value.length === 0)
  ) {
    issues.push(
      `${label}.credentialRef: must be a non-empty string naming a credential (omit it for the default)`,
    );
  }
}

function checkLlmRole(
  label: string,
  role: Record<string, unknown> | undefined,
  requireModel: boolean,
  issues: string[],
  skipRuntime = false,
): void {
  // A secret arriving from the file is refused, not ignored: a key silently dropped
  // would leave an operator believing it was used. A loaded object is not a fresh
  // literal, so no excess-property check ever sees it — this boundary is the only
  // place it can be caught (§4.6.3).
  if (role?.apiKey !== undefined) {
    issues.push(
      `${label}.apiKey: secrets are no longer read from configuration — remove it and, if this role needs an account other than the default, name it with ${label}.credentialRef (your composition root resolves the name).`,
    );
  }
  checkCredentialRef(label, role?.credentialRef, issues);
  const provider = role?.provider as string | undefined;
  if (!provider) {
    issues.push(
      `${label}.provider: required (one of: openai, anthropic, deepseek, sap-ai-sdk, ollama)`,
    );
    return;
  }
  // `as readonly string[]` is required so .includes() accepts an arbitrary
  // string; do not "simplify" — it preserves the const-tuple narrowing.
  if (!(VALID_PROVIDERS as readonly string[]).includes(provider)) {
    issues.push(
      `${label}.provider: "${provider}" is invalid (one of: openai, anthropic, deepseek, sap-ai-sdk, ollama)`,
    );
    return;
  }
  if (skipRuntime) return;
  if (requireModel && !role?.model) {
    issues.push(`${label}.model: required (string)`);
  }
  // No credential check. Whether a key or a service key is held is known only to
  // the composition root, which resolves credentialRef — the api-key and
  // AICORE_SERVICE_KEY rules left with the credential (§4.6.2).
}

function checkRagStore(
  label: string,
  store:
    | {
        type?: unknown;
        url?: unknown;
        collectionName?: unknown;
        embedder?: unknown;
        model?: unknown;
      }
    | undefined,
  issues: string[],
  skipRuntime = false,
): void {
  if (!store) return;
  const ragType = store.type as string | undefined;
  if (!ragType) {
    issues.push(
      `${label}.type: required (one of: in-memory, qdrant, hana-vector, pg-vector)`,
    );
  } else if (ragType === 'ollama' || ragType === 'openai') {
    issues.push(
      `${label}.type: "${ragType}" is an embedder, not a store — use \`type: in-memory\` with \`embedder: ${ragType}\` (or a real store: qdrant, hana-vector, pg-vector)`,
    );
  } else if (!(VALID_RAG_TYPES as readonly string[]).includes(ragType)) {
    issues.push(
      `${label}.type: "${ragType}" is invalid (one of: in-memory, qdrant, hana-vector, pg-vector)`,
    );
  } else {
    if (ragType === 'qdrant' && !store.url) {
      issues.push(`${label}.url: required for ${label}.type qdrant`);
    }
    if (
      (ragType === 'hana-vector' || ragType === 'pg-vector') &&
      !store.collectionName
    ) {
      issues.push(
        `${label}.collectionName: required for ${label}.type ${ragType}`,
      );
    }
  }
  // Blocklist (NOT allowlist): consumers can register custom embedder
  // factories, so only known embedder-less providers are hard-rejected here.
  const embedder = store.embedder as string | undefined;
  if (embedder === 'deepseek' || embedder === 'anthropic') {
    issues.push(
      `${label}.embedder: "${embedder}" provider has no embedder; embedding-capable providers are ollama, openai, sap-ai-core`,
    );
  }
  // Require model when an embedder is used: vector stores always use an
  // embedder; in-memory uses one only when embedder is explicitly set.
  const usesEmbedder =
    ragType === 'qdrant' ||
    ragType === 'hana-vector' ||
    ragType === 'pg-vector' ||
    (ragType === 'in-memory' && embedder != null);
  if (!skipRuntime && usesEmbedder && !store.model) {
    issues.push(
      `${label}.model: required when an embedder is used (e.g. bge-m3 for ollama)`,
    );
  }
}

function validateLlmEntry(
  label: string,
  cfg: Record<string, unknown> | undefined,
  required: boolean,
  issues: string[],
  skipRuntime = false,
): void {
  checkLlmRole(label, cfg, required, issues, skipRuntime);
}

/**
 * Fail-loud migration guard for the clean break to `pipeline: { name, config }`.
 *
 * Throws when the raw YAML still carries either:
 *   - a `coordinator:` block (the old runtime dispatch, removed in this major), OR
 *   - a `pipeline:` value in the LEGACY PipelineConfig shape — an object that
 *     carries `mcp`/`rag`/`stages`/`llm` but NO `name`.
 *
 * A new `pipeline: { name, ... }` object or a bare string shorthand
 * (`pipeline: stepper`) passes untouched.
 */
export function assertNoLegacyPipelineConfig(yaml: YamlConfig): void {
  const hasCoordinator =
    (yaml as { coordinator?: unknown }).coordinator !== undefined;

  const rawPipeline = (yaml as { pipeline?: unknown }).pipeline;
  const isLegacyPipeline =
    rawPipeline !== undefined &&
    rawPipeline !== null &&
    typeof rawPipeline === 'object' &&
    !Array.isArray(rawPipeline) &&
    typeof (rawPipeline as { name?: unknown }).name !== 'string' &&
    ['mcp', 'rag', 'stages', 'llm'].some(
      (k) => (rawPipeline as Record<string, unknown>)[k] !== undefined,
    );

  if (hasCoordinator || isLegacyPipeline) {
    throw new Error(
      "Legacy 'coordinator:' / 'pipeline:' config is no longer supported (removed in this major). " +
        'Migrate to: pipeline: { name: <flat|linear|dag|stepper>, config: { ... } }. ' +
        "(Stepper's knowledgeSeed moves under pipeline.config.knowledgeSeed.) " +
        'Pin a version <= 18 for the old behavior.',
    );
  }
}

export function validateResolvedConfig(
  _resolved: Omit<SmartServerConfig, 'log'>,
  yaml: YamlConfig,
  _env: NodeJS.ProcessEnv,
  opts: { skipProviderRuntimeChecks?: boolean } = {},
): void {
  const issues: string[] = [];
  const skip = opts.skipProviderRuntimeChecks === true;

  const rawLlm = get(yaml, 'llm') as Record<string, unknown> | undefined;
  if (rawLlm === undefined) {
    issues.push('llm: required (top-level llm.main or a flat llm block)');
  } else {
    // Checked before the shape is decided: a flat block that lost its provider
    // is read as a map below, and would otherwise report `llm.apiKey.provider`.
    if (rawLlm.apiKey !== undefined) {
      checkLlmRole(
        'llm',
        { apiKey: rawLlm.apiKey, provider: 'openai' },
        false,
        issues,
        true,
      );
    }
    if (typeof rawLlm.provider === 'string') {
      validateLlmEntry('llm', rawLlm, true, issues, skip);
    } else {
      const map = rawLlm as Record<string, Record<string, unknown> | undefined>;
      if (!map.main) {
        issues.push("llm.main: required when 'llm' is a named map");
      } else {
        validateLlmEntry('llm.main', map.main, true, issues, skip);
      }
      for (const [name, entry] of Object.entries(map)) {
        if (name === 'main' || name === 'apiKey') continue;
        validateLlmEntry(`llm.${name}`, entry, true, issues, skip);
      }
    }
  }

  // Pipeline selection shape: `pipeline:` must name a pipeline (string or
  // { name } object). The plugin validates its own `config` dialect at build
  // time — we only enforce the presence of a name here.
  const rawPipeline = (yaml as { pipeline?: unknown }).pipeline;
  if (rawPipeline !== undefined && rawPipeline !== null) {
    const ok =
      typeof rawPipeline === 'string' ||
      (typeof rawPipeline === 'object' &&
        typeof (rawPipeline as { name?: unknown }).name === 'string');
    if (!ok) {
      issues.push(
        "pipeline: requires a 'name' (string, or { name, config }); built-ins: flat, linear, dag, stepper, controller, controller-weak",
      );
    }
  }

  if (get(yaml, 'mcp')) {
    const rawMcpVal = yaml.mcp;
    const mcpEntries = Array.isArray(rawMcpVal)
      ? (rawMcpVal as Array<Record<string, unknown>>)
      : [rawMcpVal as Record<string, unknown>];
    mcpEntries.forEach((entry, i) => {
      const label = Array.isArray(rawMcpVal) ? `mcp[${i}]` : 'mcp';
      const mcpType = entry?.type as string | undefined;
      if (mcpType && !['http', 'stdio', 'none'].includes(mcpType)) {
        issues.push(
          `${label}.type: "${mcpType}" is invalid (one of: http, stdio, none)`,
        );
      }
      if (mcpType === 'http' && !entry?.url) {
        issues.push(`${label}.url: required when ${label}.type is http`);
      }
      if (mcpType === 'stdio' && !entry?.command) {
        issues.push(`${label}.command: required when ${label}.type is stdio`);
      }
    });
  }

  if (get(yaml, 'rag')) {
    checkRagStore(
      'rag',
      get(yaml, 'rag') as Record<string, unknown>,
      issues,
      skip,
    );
  }
  // NOTE: the legacy `pipeline.rag.{name}` multistore was removed with the
  // `pipeline: {name,config}` migration; the top-level `rag:` block is the sole
  // RAG source, validated above.

  if (issues.length > 0) throw new ConfigValidationError([...new Set(issues)]);
}
