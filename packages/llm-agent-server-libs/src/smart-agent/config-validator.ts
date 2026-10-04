import { parseIntegerField } from './decision-config.js';
import {
  type LlmConfigMap,
  llmKeySet,
  normalizeLlmConfig,
} from './llm-config-map.js';
import { isBuiltInEmbedderProvider } from './rag-config.js';
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
        .join('\n')}\nFix these fields in your YAML and restart.`,
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

/** A secret arriving from the file is refused, not ignored (§4.6.3). */
function checkNoSecret(
  label: string,
  section: Record<string, unknown> | undefined,
  issues: string[],
): void {
  if (section?.apiKey !== undefined) {
    issues.push(
      `${label}.apiKey: secrets are no longer read from configuration — remove it and, if this role needs an account other than the default, name it with ${label}.credentialRef (your composition root resolves the name).`,
    );
  }
}

function checkDecision(yaml: YamlConfig, issues: string[]): void {
  const d = get(yaml, 'decision') as Record<string, unknown> | undefined;
  if (d !== undefined && d !== null) {
    checkNoSecret('decision', d, issues);
    checkCredentialRef('decision', d.credentialRef, issues);
    if (d.provider !== 'typesafe') {
      issues.push(
        `decision.provider: must be 'typesafe' (got ${JSON.stringify(d.provider)})`,
      );
    }
    for (const key of ['model', 'baseUrl'] as const) {
      const v = d[key];
      if (
        v !== undefined &&
        v !== null &&
        (typeof v !== 'string' || !v.trim())
      ) {
        issues.push(`decision.${key}: must be a non-empty string`);
      }
    }
    const timeoutMs = parseIntegerField(d.timeoutMs);
    if (
      timeoutMs === 'invalid' ||
      (timeoutMs !== undefined && timeoutMs <= 0)
    ) {
      issues.push(
        'decision.timeoutMs: must be a positive integer (milliseconds)',
      );
    }
    const maxRetries = parseIntegerField(d.maxRetries);
    if (
      maxRetries === 'invalid' ||
      (maxRetries !== undefined && maxRetries < 0)
    ) {
      issues.push('decision.maxRetries: must be a non-negative integer');
    }
  }
}

const RETRIEVAL_STRATEGIES = ['embedding', 'rerank', 'rerank-all'] as const;
const RETRIEVAL_RERANKERS = ['decision', 'llm'] as const;
const RETRIEVAL_FIELDS: readonly string[] = [
  'strategy',
  'reranker',
  'llm',
  'question',
  'task',
  'overfetch',
  'maxCandidates',
];
const RERANK_ONLY_FIELDS = [
  'reranker',
  'llm',
  'question',
  'task',
  'overfetch',
  'maxCandidates',
] as const;
const RETRIEVAL_QUESTIONS = ['tool', 'passage'] as const;

/**
 * The keys `rag.retrieval.<store>.llm` may name, decided by the same helpers
 * the runtime uses: a flat `llm:` block normalizes to `{ main }`. A map
 * without `main` is reported by the llm: checks; here its keys stand as is.
 */
function retrievalLlmKeys(rawLlm: unknown): ReadonlySet<string> {
  if (!rawLlm || typeof rawLlm !== 'object' || Array.isArray(rawLlm)) {
    return new Set();
  }
  try {
    return llmKeySet(normalizeLlmConfig(rawLlm as LlmConfigMap));
  } catch {
    return new Set(Object.keys(rawLlm));
  }
}

/** `rag.retrieval` — per-store strategies (§13.4); validated on the raw YAML. */
function checkRetrieval(
  yaml: YamlConfig,
  rag: Record<string, unknown>,
  issues: string[],
): void {
  const raw = rag.retrieval;
  if (raw === undefined || raw === null) return;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    issues.push('rag.retrieval: must be a mapping of store key → strategy');
    return;
  }
  const llmKeys = retrievalLlmKeys(get(yaml, 'llm'));
  for (const [key, entry] of Object.entries(raw as Record<string, unknown>)) {
    const label = `rag.retrieval.${key}`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      issues.push(`${label}: must be a mapping`);
      continue;
    }
    const e = entry as Record<string, unknown>;
    const strategy = e.strategy ?? 'embedding';
    if (
      !(RETRIEVAL_STRATEGIES as readonly string[]).includes(strategy as string)
    ) {
      issues.push(
        `${label}.strategy: must be one of ${RETRIEVAL_STRATEGIES.join(' | ')} (got ${JSON.stringify(strategy)})`,
      );
    }
    for (const field of Object.keys(e)) {
      if (!RETRIEVAL_FIELDS.includes(field)) {
        issues.push(`${label}.${field}: unknown key`);
      }
    }
    const isSet = (f: string) => e[f] != null;
    const reranked = strategy === 'rerank' || strategy === 'rerank-all';
    if (!reranked) {
      for (const f of RERANK_ONLY_FIELDS) {
        if (isSet(f)) {
          issues.push(
            `${label}.${f}: only applies to strategy rerank / rerank-all`,
          );
        }
      }
    } else {
      if (strategy === 'rerank-all' && isSet('overfetch')) {
        issues.push(`${label}.overfetch: only applies to strategy rerank`);
      }
      if (strategy === 'rerank' && isSet('maxCandidates')) {
        issues.push(
          `${label}.maxCandidates: only applies to strategy rerank-all`,
        );
      }
      if (e.reranker === 'decision' && isSet('llm')) {
        issues.push(`${label}.llm: only applies to reranker: llm`);
      }
    }
    if (isSet('question') && isSet('task')) {
      issues.push(`${label}: set question or task, not both`);
    }
    if (
      e.question != null &&
      !(RETRIEVAL_QUESTIONS as readonly string[]).includes(e.question as string)
    ) {
      issues.push(
        `${label}.question: must be one of ${RETRIEVAL_QUESTIONS.join(' | ')} (got ${JSON.stringify(e.question)})`,
      );
    }
    if (e.task != null && (typeof e.task !== 'string' || !e.task.trim())) {
      issues.push(`${label}.task: must be a non-empty string`);
    }
    const overfetch = parseIntegerField(e.overfetch);
    if (
      overfetch === 'invalid' ||
      (overfetch !== undefined && overfetch <= 0)
    ) {
      issues.push(`${label}.overfetch: must be a positive integer`);
    }
    const maxCandidates = parseIntegerField(e.maxCandidates);
    if (
      maxCandidates === 'invalid' ||
      (maxCandidates !== undefined && maxCandidates <= 0)
    ) {
      issues.push(`${label}.maxCandidates: must be a positive integer`);
    }
    if (strategy !== 'rerank' && strategy !== 'rerank-all') continue;
    if (strategy === 'rerank-all' && maxCandidates === undefined) {
      issues.push(`${label}.maxCandidates: required for strategy: rerank-all`);
    }
    if (e.reranker == null) {
      issues.push(
        `${label}.reranker: required for strategy: ${strategy} (decision | llm)`,
      );
    } else if (
      !(RETRIEVAL_RERANKERS as readonly string[]).includes(e.reranker as string)
    ) {
      issues.push(
        `${label}.reranker: must be one of ${RETRIEVAL_RERANKERS.join(' | ')} (got ${JSON.stringify(e.reranker)})`,
      );
    } else if (e.reranker === 'decision') {
      if (get(yaml, 'decision') == null) {
        issues.push(`${label}.reranker: decision requires a decision: section`);
      }
    } else if (typeof e.llm !== 'string' || !e.llm) {
      issues.push(
        `${label}.llm: required for reranker: llm (a key of the llm: map)`,
      );
    } else if (!llmKeys.has(e.llm)) {
      issues.push(`${label}.llm: "${e.llm}" is not a key of the llm: map`);
    }
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
  checkNoSecret(label, role, issues);
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

const IN_MEMORY_ONLY_KEYS = [
  'dedupThreshold',
  'vectorWeight',
  'keywordWeight',
] as const;

function checkRag(
  rag: Record<string, unknown>,
  issues: string[],
  skipRuntime = false,
): void {
  for (const key of Object.keys(rag)) {
    if (key !== 'store' && key !== 'embedder' && key !== 'retrieval') {
      issues.push(
        `rag.${key}: unknown key — rag holds store:, embedder: and retrieval:`,
      );
    }
  }
  const store = rag.store;
  if (
    store === undefined ||
    store === null ||
    typeof store !== 'object' ||
    Array.isArray(store)
  ) {
    issues.push(
      'rag.store: required (a mapping with type: in-memory | qdrant | hana-vector | pg-vector)',
    );
    return;
  }
  const s = store as Record<string, unknown>;
  const ragType = s.type as string | undefined;
  if (!ragType) {
    issues.push(
      'rag.store.type: required (one of: in-memory, qdrant, hana-vector, pg-vector)',
    );
  } else if (ragType === 'ollama' || ragType === 'openai') {
    issues.push(
      `rag.store.type: "${ragType}" is an embedder, not a store — use \`store: { type: in-memory }\` with \`embedder: { provider: ${ragType} }\` (or a real store: qdrant, hana-vector, pg-vector)`,
    );
  } else if (!(VALID_RAG_TYPES as readonly string[]).includes(ragType)) {
    issues.push(
      `rag.store.type: "${ragType}" is invalid (one of: in-memory, qdrant, hana-vector, pg-vector)`,
    );
  } else {
    if (ragType === 'qdrant' && !s.url) {
      issues.push('rag.store.url: required for rag.store.type qdrant');
    }
    if (
      (ragType === 'hana-vector' || ragType === 'pg-vector') &&
      !s.collectionName
    ) {
      issues.push(
        `rag.store.collectionName: required for rag.store.type ${ragType}`,
      );
    }
    if (ragType !== 'in-memory') {
      for (const k of IN_MEMORY_ONLY_KEYS) {
        if (s[k] !== undefined) {
          issues.push(
            `rag.store.${k}: read only by the in-memory store — remove it (a ${ragType} store never read it)`,
          );
        }
      }
    }
  }
  checkCredentialRef('rag.store', s.credentialRef, issues);

  const rawEmbedder = rag.embedder;
  if (
    rawEmbedder !== undefined &&
    (rawEmbedder === null ||
      typeof rawEmbedder !== 'object' ||
      Array.isArray(rawEmbedder))
  ) {
    issues.push('rag.embedder: must be a mapping (provider, model, …)');
    return;
  }
  const e = rawEmbedder as Record<string, unknown> | undefined;
  const provider = e?.provider as string | undefined;
  const factory = e?.factory;
  if (provider !== undefined && factory !== undefined) {
    issues.push(
      'rag.embedder: name either provider (a built-in) or factory (one you registered), not both',
    );
  } else if (factory !== undefined) {
    if (typeof factory !== 'string' || factory.length === 0) {
      issues.push(
        'rag.embedder.factory: must be a non-empty string naming a registered factory',
      );
    }
    // A consumer factory receives EmbedderFactoryConfig only (url, model, timeoutMs) and
    // closes over its own credential, so these would be dropped without a word.
    for (const k of [
      'credentialRef',
      'resourceGroup',
      'scenario',
      'asymmetric',
    ] as const) {
      if (e?.[k] !== undefined) {
        issues.push(
          `rag.embedder.${k}: not read for a factory — a consumer factory closes over its own ` +
            'configuration and credential; remove it',
        );
      }
    }
  } else if (provider === 'deepseek' || provider === 'anthropic') {
    issues.push(
      `rag.embedder.provider: "${provider}" provider has no embedder; embedding-capable providers are ollama, openai, sap-ai-core`,
    );
  } else if (provider !== undefined && !isBuiltInEmbedderProvider(provider)) {
    issues.push(
      `rag.embedder.provider: "${provider}" is not a built-in embedder (openai, sap-ai-core, sap-aicore, ollama) — ` +
        'an embedder you registered in extraFactories is named with rag.embedder.factory',
    );
  }
  if (e && factory === undefined)
    checkCredentialRef('rag.embedder', e.credentialRef, issues);
  if (e?.asymmetric !== undefined) {
    // `${VAR}` substitution leaves a string, so 'true'/'false' count too.
    const asymmetric =
      e.asymmetric === true || e.asymmetric === 'true'
        ? true
        : e.asymmetric === false || e.asymmetric === 'false'
          ? false
          : undefined;
    if (asymmetric === undefined) {
      issues.push('rag.embedder.asymmetric: must be true or false');
    } else if (
      asymmetric &&
      factory === undefined &&
      provider !== 'sap-ai-core' &&
      provider !== 'sap-aicore'
    ) {
      // Only SAP AI Core's embedder has a document/query pair; on any other
      // provider the key would be dropped without a word.
      issues.push(
        `rag.embedder.asymmetric: supported for provider sap-ai-core only, not "${provider ?? 'ollama'}"`,
      );
    } else if (asymmetric && e.scenario === 'foundation-models') {
      issues.push(
        "rag.embedder.asymmetric: needs scenario 'orchestration' — the foundation-models scenario takes no input type",
      );
    }
  }
  const usesEmbedder =
    ragType === 'qdrant' ||
    ragType === 'hana-vector' ||
    ragType === 'pg-vector' ||
    (ragType === 'in-memory' && e !== undefined);
  // Every built-in constructor requires a model; a factory decides for itself.
  if (!skipRuntime && usesEmbedder && factory === undefined && !e?.model) {
    issues.push(
      'rag.embedder.model: required when an embedder is used (e.g. bge-m3 for ollama)',
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

/** Keys of the flat `rag:` shape this major removed (the `embedder: <name>` string
 *  form is caught separately — `embedder` is also the new section's name). */
const LEGACY_FLAT_RAG_KEYS = [
  'type',
  'url',
  'model',
  'collectionName',
  'dedupThreshold',
  'vectorWeight',
  'keywordWeight',
  'connectionString',
  'host',
  'port',
  'database',
  'schema',
  'dimension',
  'autoCreateSchema',
  'poolMax',
  'connectTimeout',
  'maxBatchSize',
  'resourceGroup',
  'scenario',
  'timeoutMs',
  'apiKey',
  'user',
  'password',
] as const;

const SECRET_FIELDS = ['apiKey', 'user', 'password'] as const;

/**
 * Fail-loud migration guard for the store/embedder split (spec §4.6.4). A flat key
 * silently dropped would leave a store the operator believes configured, and a
 * secret silently dropped would leave one they believe authenticated.
 */
export function assertNoLegacyRagShape(yaml: YamlConfig): void {
  const rag = (yaml as { rag?: unknown }).rag;
  if (rag === null || typeof rag !== 'object' || Array.isArray(rag)) return;
  const r = rag as Record<string, unknown>;
  const flat: string[] = LEGACY_FLAT_RAG_KEYS.filter((k) => r[k] !== undefined);
  if (typeof r.embedder === 'string') flat.push('embedder: <name>');
  if (flat.length > 0) {
    throw new Error(
      `The flat 'rag:' section is no longer supported (found: ${flat.join(', ')}). ` +
        'It described two independently authenticated targets as one, so it splits: ' +
        'rag.store holds type, url, collectionName, connectionString/host/port/database/schema ' +
        'and the pool/schema settings — plus dedupThreshold, vectorWeight and keywordWeight, ' +
        'for type in-memory only; rag.embedder holds provider (a built-in: openai, sap-ai-core, ' +
        'ollama — was rag.embedder) or factory (a consumer-registered embedder), model, url, ' +
        'resourceGroup, scenario and maxBatchSize. apiKey, user and password do not move: remove ' +
        'them and name the account with rag.store.credentialRef or rag.embedder.credentialRef.',
    );
  }
  for (const section of ['store', 'embedder'] as const) {
    const s = r[section];
    if (s === null || typeof s !== 'object' || Array.isArray(s)) continue;
    const secrets = SECRET_FIELDS.filter(
      (k) => (s as Record<string, unknown>)[k] !== undefined,
    );
    if (secrets.length > 0) {
      throw new Error(
        `${secrets.map((k) => `rag.${section}.${k}`).join(', ')}: secrets are no longer read ` +
          `from configuration — remove ${secrets.length > 1 ? 'them' : 'it'} and name the ` +
          `account with rag.${section}.credentialRef (your composition root resolves the name).`,
      );
    }
  }
  const embedder = r.embedder;
  if (
    embedder !== null &&
    typeof embedder === 'object' &&
    (embedder as Record<string, unknown>).apiBaseUrl !== undefined
  ) {
    throw new Error(
      "rag.embedder.apiBaseUrl: SAP AI Core's address comes from the credential entry — the same " +
        'service key (<REF>_SERVICE_KEY in the shipped server) that holds the credential — and is ' +
        'never also written in YAML. Remove it; name the account with rag.embedder.credentialRef ' +
        'if it is not the default one.',
    );
  }
}

export function validateResolvedConfig(
  _resolved: Omit<SmartServerConfig, 'log'>,
  yaml: YamlConfig,
  _env: NodeJS.ProcessEnv,
  opts: {
    skipProviderRuntimeChecks?: boolean;
    requireLlmSection?: boolean;
  } = {},
): void {
  const issues: string[] = [];
  const skip = opts.skipProviderRuntimeChecks === true;

  const rawLlm = get(yaml, 'llm') as Record<string, unknown> | undefined;
  if (rawLlm === undefined) {
    // A DAG worker file names keys of the MAIN file's llm: map (§4.6.7) and is
    // resolved with its own llm: stripped, so it has no section to require.
    if (opts.requireLlmSection !== false) {
      issues.push('llm: required (top-level llm.main or a flat llm block)');
    }
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

  const rawRag = get(yaml, 'rag');
  if (rawRag !== undefined && rawRag !== null) {
    if (typeof rawRag !== 'object' || Array.isArray(rawRag)) {
      issues.push(
        'rag: must be a mapping with store: and, optionally, embedder:',
      );
    } else {
      checkRag(rawRag as Record<string, unknown>, issues, skip);
      checkRetrieval(yaml, rawRag as Record<string, unknown>, issues);
    }
  }
  // NOTE: the legacy `pipeline.rag.{name}` multistore was removed with the
  // `pipeline: {name,config}` migration; the top-level `rag:` block is the sole
  // RAG source, validated above.

  checkDecision(yaml, issues);
  if (get(yaml, 'reranker') !== undefined) {
    issues.push(
      'reranker: removed — use rag.retrieval.<store>: { strategy: rerank, reranker: decision }',
    );
  }

  if (issues.length > 0) throw new ConfigValidationError([...new Set(issues)]);
}
