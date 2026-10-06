/**
 * Per-section config builders extracted from resolveSmartServerConfig.
 * Internal module — not re-exported by the package barrel.
 */

import {
  type IThrottleStrategy,
  ReportThrottling,
  WaitAsTold,
} from '@mcp-abap-adt/llm-agent';
import {
  checkKnowledgeSeed,
  checkMcpList,
  checkMcpMaps,
  checkRetry,
  checkToolSelection,
  EMBEDDER_SCENARIOS,
  type FieldCheck,
  LLM_CALL_STRATEGIES,
  MCP_KEYS,
  MCP_TYPES,
  present,
  START_NUMBER_RULES,
  STREAM_MODES,
  type StartConfigFields,
  TOOLS_VALIDATION_MODES,
} from './config-fields.js';
import {
  parseIntegerField,
  type SmartServerDecisionConfig,
  type SmartServerRetrievalConfig,
} from './decision-config.js';
import { isFlatLlmConfig } from './llm-config-map.js';
import type {
  BuiltInEmbedderProvider,
  SmartServerEmbedderConfig,
  SmartServerRagStoreConfig,
} from './rag-config.js';
import type {
  SmartServerAgentConfig,
  SmartServerConfig,
  SmartServerLlmConfig,
} from './smart-server.js';
import type { YamlConfig } from './yaml-loader.js';
import { get } from './yaml-loader.js';

const R = START_NUMBER_RULES;

export function resolveLlmSection(
  yaml: YamlConfig,
  check: FieldCheck,
): SmartServerConfig['llm'] {
  const raw = get(yaml, 'llm');
  // Spec D83 (12): `llm: x` / `llm: [a]` / `llm: false` is an error — 30.1.0
  // read a scalar or a list as a map of roles and a falsy value as no llm; a
  // key with no value is `llm has no value` (D83 (13)); not written, it is
  // validateResolvedConfig's `llm: required`.
  if (!present(raw)) return undefined;
  const s = check.section('llm', raw);
  if (s === undefined) return undefined; // recorded — done() throws before the config is used
  // The one flat-vs-map discriminator (normalizeLlmConfig's, the validator's):
  // a flat block that lost its provider is still flat — `llm.provider: required`.
  if (!isFlatLlmConfig(s)) return validateLlmMap(s, check);
  return {
    provider: s.provider as
      | 'deepseek'
      | 'openai'
      | 'anthropic'
      | 'sap-ai-sdk'
      | 'ollama'
      | undefined,
    // A name the composition root resolves — never a value. Its shape is
    // checked by the validator, which reads the raw YAML.
    ...(typeof s.credentialRef === 'string'
      ? { credentialRef: s.credentialRef }
      : {}),
    // Spec D83 (9): checked, never cast — `""` is an error, not "unset".
    ...(s.url !== undefined ? { url: check.text('llm.url', s.url) } : {}),
    ...(s.model !== undefined
      ? { model: check.text('llm.model', s.model) }
      : {}),
    ...(s.resourceGroup !== undefined
      ? { resourceGroup: check.text('llm.resourceGroup', s.resourceGroup) }
      : {}),
    // Unset stays unset: the provider then sends no temperature and the model
    // applies its own default. Set, it is checked (spec D83 (7)).
    ...(s.temperature !== undefined
      ? {
          temperature: check.number(
            'llm.temperature',
            R.temperature,
            s.temperature,
          ),
        }
      : {}),
    ...(s.classifierTemperature !== undefined
      ? {
          classifierTemperature: check.number(
            'llm.classifierTemperature',
            R.temperature,
            s.classifierTemperature,
          ),
        }
      : {}),
    // Both of these are declared on SmartServerLlmConfig and were missing
    // from this allow-list, which is exactly the disappearing act the
    // comment on positiveIntOption warns about: the key is accepted in
    // YAML, read by nobody, and the default applies in silence.
    ...positiveIntOption(s.maxTokens, 'llm.maxTokens', check),
    ...whenThrottledOption(s.whenThrottled, 'llm.whenThrottled', check),
  };
}

/**
 * The named-map form (`llm.main`, `llm.helper`, …) reaches the config by a cast,
 * so nothing in it was ever checked. A misspelled key under one role's
 * `whenThrottled` therefore failed exactly where a config error is least
 * visible: nowhere, with the default quietly in force.
 *
 * Only the blocks this module understands are validated. The rest of each entry
 * is passed through as before — this closes the gap the flat branch already
 * covers, it does not turn the map into a schema.
 */
function validateLlmMap(
  map: Readonly<Record<string, unknown>>,
  check: FieldCheck,
): Record<string, SmartServerLlmConfig> {
  const out: Record<string, SmartServerLlmConfig> = {};
  for (const [role, entry] of Object.entries(map)) {
    // Spec D83 (12), (13): every role is a mapping — a scalar or a list is an
    // error (30.1.0 passed it through), a role with no value is
    // `llm.<role> has no value`.
    const e = check.section(`llm.${role}`, entry);
    if (e === undefined) continue;
    const at = `llm.${role}`;
    // The normalised values are written back, not merely checked. `${ENV_VAR}`
    // substitution leaves numbers as strings, and the resolved config is typed
    // as though they were numbers: the built-in strategy happens to coerce them
    // in arithmetic, a custom one would be handed a string and told it was a
    // number. Validating without keeping the result is checking the door and
    // then walking through the window.
    out[role] = {
      ...(e as SmartServerLlmConfig),
      ...(e.url !== undefined ? { url: check.text(`${at}.url`, e.url) } : {}),
      ...(e.model !== undefined
        ? { model: check.text(`${at}.model`, e.model) }
        : {}),
      ...(e.resourceGroup !== undefined
        ? {
            resourceGroup: check.text(`${at}.resourceGroup`, e.resourceGroup),
          }
        : {}),
      ...(e.temperature !== undefined
        ? {
            temperature: check.number(
              `${at}.temperature`,
              R.temperature,
              e.temperature,
            ),
          }
        : {}),
      ...(e.classifierTemperature !== undefined
        ? {
            classifierTemperature: check.number(
              `${at}.classifierTemperature`,
              R.temperature,
              e.classifierTemperature,
            ),
          }
        : {}),
      ...(e.whenThrottled !== undefined
        ? whenThrottledOption(e.whenThrottled, `${at}.whenThrottled`, check)
        : {}),
      ...(e.maxTokens !== undefined
        ? positiveIntOption(e.maxTokens, `${at}.maxTokens`, check)
        : {}),
    };
  }
  return out;
}

/**
 * Read an optional positive-integer YAML key, failing fast on a bad value.
 *
 * Silently coercing (`Number('many') === NaN`) would surface much later as an
 * unexplained default, which is the failure mode this section is prone to: it
 * projects YAML through an explicit allow-list, so anything unlisted or
 * unparsed disappears without a word.
 */
function positiveIntOption(
  value: unknown,
  key: string,
  check: FieldCheck,
): Record<string, number> {
  if (value === undefined) return {};
  const n = check.number(key, R.count, value);
  return n === undefined ? {} : { [key.split('.').pop() as string]: n };
}

/**
 * Read the optional `llm.whenThrottled` value: the name of a shipped strategy,
 * or that name with the strategy's own options.
 *
 * No duration, and no attempt cap outside the strategy. How long anyone waits
 * and how often they come back belong to the strategy the operator chose;
 * a number out here would overrule it.
 */
function whenThrottledOption(
  value: unknown,
  path: string,
  check: FieldCheck,
): { whenThrottled?: IThrottleStrategy } {
  if (value === undefined) return {};
  // Spec D83 (13): a key written with no value is that, never "no strategy".
  if (value === null) {
    check.refuse(path, 'has no value', value);
    return {};
  }

  const named = (name: unknown, options: { maxAttempts?: number } = {}) => {
    if (name === 'report') {
      // `report` never retries, so an attempt cap beside it has nothing to cap.
      // Accepting it and dropping it is the worse failure: a value that passes
      // validation and does nothing reads as configured, and stays wrong until
      // someone measures.
      if (options.maxAttempts !== undefined) {
        throw new Error(
          `Invalid ${path}.maxAttempts: 'report' never retries, so there is nothing to limit. Use 'wait-as-told' if you meant to retry.`,
        );
      }
      return new ReportThrottling();
    }
    if (name === 'wait-as-told') return new WaitAsTold(options);
    throw new Error(
      `Invalid ${path}: expected 'report' or 'wait-as-told', got ${JSON.stringify(name)}. Anything else is code, and is passed to the provider directly.`,
    );
  };

  if (typeof value === 'string') return { whenThrottled: named(value) };

  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(
      `Invalid ${path}: expected a strategy name or a mapping, got ${JSON.stringify(value)}`,
    );
  }

  const raw = value as Record<string, unknown>;
  const options: { maxAttempts?: number } = {};
  for (const [key, v] of Object.entries(raw)) {
    // Spec D83 (13): a `null` reaches its check (`has no value`), never skipped.
    if (key === 'strategy' || v === undefined) continue;
    // A count, not a duration: fractional attempts do not exist, and zero of
    // them is not "none" — the first attempt is included in the total, so 0
    // behaves as 1 and 1.5 as 2. Silently meaning something other than what it
    // says is the whole failure mode this block exists to prevent.
    if (key === 'maxAttempts') {
      const n = check.number(`${path}.maxAttempts`, R.count, v);
      if (n !== undefined) options.maxAttempts = n;
      continue;
    }
    throw new Error(
      `Unknown ${path} key '${key}'. Known keys: strategy, maxAttempts.`,
    );
  }
  if (raw.strategy === null) {
    check.refuse(`${path}.strategy`, 'has no value', null);
    return {};
  }
  return { whenThrottled: named(raw.strategy, options) };
}

/**
 * Project `rag.store` per arm. Every field is checked (spec D83 (7)): a value
 * substituted from `${VAR}` arrives as a string and is parsed by the shared
 * grammar, never coerced. A missing or unknown `type` is passed through
 * untouched for validateResolvedConfig to report beside every other issue.
 */
function resolveRagStore(
  raw: unknown,
  args: Record<string, unknown>,
  fields: StartConfigFields,
  check: FieldCheck,
): SmartServerRagStoreConfig {
  // Spec D83 (12): a present store is a mapping — an absent one stays `{}`,
  // which validateResolvedConfig reports as `rag.store: required`.
  const s = present(raw) ? (check.section('rag.store', raw) ?? {}) : {};
  const text = (k: string): string | undefined =>
    s[k] !== undefined ? check.text(`rag.store.${k}`, s[k]) : undefined;
  const num = (k: string, rule: (typeof R)[keyof typeof R]) =>
    s[k] !== undefined ? check.number(`rag.store.${k}`, rule, s[k]) : undefined;
  // Spec D83 (9): the override is checked like `args.host`, never cast.
  const collectionName =
    args['rag-collection-name'] !== undefined
      ? check.text('args.rag-collection-name', args['rag-collection-name'])
      : text('collectionName');
  const ref =
    typeof s.credentialRef === 'string'
      ? { credentialRef: s.credentialRef }
      : {};
  const connectionString = text('connectionString');
  const host = text('host');
  const port = num('port', R.storePort);
  const schema = text('schema');
  const poolMax = num('poolMax', R.count);
  const connectTimeout = num('connectTimeout', R.connectTimeout);
  const dimension = num('dimension', R.count);
  const autoCreateSchema =
    s.autoCreateSchema !== undefined
      ? check.flag('rag.store.autoCreateSchema', s.autoCreateSchema)
      : undefined;
  const database = text('database');
  const timeoutMs = num('timeoutMs', R.timerMs);
  const url =
    s.url !== undefined ? (check.text('rag.store.url', s.url) ?? '') : '';
  const dedupThreshold = check.numberOr(
    'rag.store.dedupThreshold',
    R.unitInterval,
    s.dedupThreshold,
    0.92,
  );
  const address = {
    ...(connectionString !== undefined ? { connectionString } : {}),
    ...(host !== undefined ? { host } : {}),
    ...(port !== undefined ? { port } : {}),
    ...(schema !== undefined ? { schema } : {}),
    ...(poolMax !== undefined ? { poolMax } : {}),
    ...(connectTimeout !== undefined ? { connectTimeout } : {}),
    ...(dimension !== undefined ? { dimension } : {}),
    ...(autoCreateSchema !== undefined ? { autoCreateSchema } : {}),
  };
  switch (s.type) {
    case 'in-memory':
      return {
        type: 'in-memory',
        ...(collectionName !== undefined ? { collectionName } : {}),
        dedupThreshold,
        // The fields of the config field rules arrive validated (spec D83 (5)).
        vectorWeight: fields.vectorWeight ?? 0.7,
        keywordWeight: fields.keywordWeight ?? 0.3,
        ...ref,
      };
    case 'qdrant':
      return {
        type: 'qdrant',
        // The stand-in until done(); checkRag reports a missing qdrant url.
        url,
        // main's makeRag defaulted this; the typed arm requires it, so the default
        // lives at the boundary that fills the arm
        collectionName: collectionName ?? 'llm-agent',
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...ref,
      };
    case 'pg-vector':
      return {
        type: 'pg-vector',
        collectionName: collectionName ?? '',
        ...address,
        ...(database !== undefined ? { database } : {}),
        ...ref,
      };
    case 'hana-vector':
      return {
        type: 'hana-vector',
        collectionName: collectionName ?? '',
        ...address,
        ...ref,
      };
    default:
      return s as unknown as SmartServerRagStoreConfig;
  }
}

function resolveRagEmbedder(
  raw: Readonly<Record<string, unknown>>,
  check: FieldCheck,
): SmartServerEmbedderConfig {
  // Spec D83 (7): every field checked; `?? ''` / `?? 'ollama'` are the
  // stand-ins until done(), which throws on the recorded issue.
  const common = {
    ...(raw.model !== undefined
      ? { model: check.text('rag.embedder.model', raw.model) ?? '' }
      : {}),
    ...(raw.url !== undefined
      ? { url: check.text('rag.embedder.url', raw.url) ?? '' }
      : {}),
    // Left absent when unset so the provider's declared cap wins; see
    // composeResilientEmbedder's precedence (YAML → provider → default).
    ...positiveIntOption(raw.maxBatchSize, 'rag.embedder.maxBatchSize', check),
  };
  const scenario =
    raw.scenario !== undefined
      ? check.oneOf('rag.embedder.scenario', EMBEDDER_SCENARIOS, raw.scenario)
      : undefined;
  const resourceGroup =
    raw.resourceGroup !== undefined
      ? check.text('rag.embedder.resourceGroup', raw.resourceGroup)
      : undefined;
  const asymmetric = check.flagOr(
    'rag.embedder.asymmetric',
    raw.asymmetric,
    false,
  );
  if (raw.factory !== undefined) {
    // credentialRef/resourceGroup/scenario beside a factory are refused by checkRag.
    return {
      factory: check.text('rag.embedder.factory', raw.factory) ?? '',
      ...common,
    };
  }
  return {
    // No provider means ollama, the default this section always had. An unknown
    // name is refused by checkRag in the same resolveSmartServerConfig call, before
    // anything reads the value — as `resolveRagStore`'s pass-through default is.
    provider: (raw.provider !== undefined
      ? (check.text('rag.embedder.provider', raw.provider) ?? '')
      : 'ollama') as BuiltInEmbedderProvider,
    ...common,
    ...(resourceGroup !== undefined ? { resourceGroup } : {}),
    ...(scenario !== undefined ? { scenario } : {}),
    ...(typeof raw.credentialRef === 'string'
      ? { credentialRef: raw.credentialRef }
      : {}),
    // checkRag keeps its provider / scenario rule for it.
    ...(asymmetric ? { asymmetric: true } : {}),
  };
}

export function resolveRagSection(
  yaml: YamlConfig,
  args: Record<string, unknown>,
  fields: StartConfigFields,
  check: FieldCheck,
): SmartServerConfig['rag'] {
  const raw = get(yaml, 'rag');
  // Spec D83 (12): a present rag is a mapping — 30.1.0 read `rag: false` as no
  // RAG and read rag.store / rag.embedder through a scalar or a list.
  if (!present(raw)) return undefined;
  const r = check.section('rag', raw) ?? {};
  return {
    store: resolveRagStore(r.store, args, fields, check),
    ...(present(r.embedder)
      ? {
          embedder: resolveRagEmbedder(
            check.section('rag.embedder', r.embedder) ?? {},
            check,
          ),
        }
      : {}),
    ...resolveRetrieval(r.retrieval, check),
  };
}

/** `rag.retrieval` → entry by entry, named fields only; absent → absent. */
function resolveRetrieval(
  raw: unknown,
  check: FieldCheck,
): {
  retrieval?: Record<string, SmartServerRetrievalConfig>;
} {
  if (!present(raw)) return {};
  // Spec D83 (12): a mapping of store key → mapping (30.1.0: anything else → {}).
  const entries = check.map('rag.retrieval', raw, (f, e) =>
    check.section(f, e),
  );
  if (entries === undefined) return {}; // recorded — done() throws
  const retrieval: Record<string, SmartServerRetrievalConfig> = {};
  for (const [key, r] of Object.entries(entries)) {
    const overfetch = parseIntegerField(r.overfetch);
    const maxCandidates = parseIntegerField(r.maxCandidates);
    retrieval[key] = {
      strategy: (r.strategy ??
        'embedding') as SmartServerRetrievalConfig['strategy'],
      ...(r.reranker != null
        ? { reranker: r.reranker as 'decision' | 'llm' }
        : {}),
      ...(typeof r.llm === 'string' ? { llm: r.llm } : {}),
      ...(r.question != null
        ? { question: r.question as 'tool' | 'passage' }
        : {}),
      ...(typeof r.task === 'string' ? { task: r.task } : {}),
      ...(typeof overfetch === 'number' ? { overfetch } : {}),
      ...(typeof maxCandidates === 'number' ? { maxCandidates } : {}),
    };
  }
  return { retrieval };
}

export function resolveMcpSection(
  yaml: YamlConfig,
  args: Record<string, unknown>,
  check: FieldCheck,
): SmartServerConfig['mcp'] {
  const rawMcp = yaml.mcp;
  // Spec D83 (9), (14): the list form — each entry's shape first, then its
  // fields and `name`, then the labels' uniqueness, all issues of `check`.
  if (Array.isArray(rawMcp)) return checkMcpList(check, rawMcp);
  // Spec D83 (13): `mcp:` with no value is `mcp has no value` (30.1.0: no MCP).
  const s = present(rawMcp)
    ? (check.closed('mcp', rawMcp, MCP_KEYS) ?? {})
    : {};
  // Spec D83 (9): checked — `""` is an error, not "no MCP".
  const url = s.url !== undefined ? check.text('mcp.url', s.url) : undefined;
  const command =
    s.command !== undefined ? check.text('mcp.command', s.command) : undefined;
  const mcpTypeRaw =
    s.type !== undefined
      ? check.oneOf('mcp.type', MCP_TYPES, s.type)
      : url !== undefined
        ? 'http'
        : command !== undefined
          ? 'stdio'
          : null;
  const mcpType =
    mcpTypeRaw === 'none' || mcpTypeRaw === undefined ? null : mcpTypeRaw;
  const rawArgs = args['mcp-args'] ?? s.args;
  const mcpArgs =
    rawArgs !== undefined
      ? check
          .text(
            args['mcp-args'] !== undefined ? 'args.mcp-args' : 'mcp.args',
            rawArgs,
          )
          ?.split(' ')
      : undefined;
  const timeout =
    s.timeout !== undefined
      ? check.number('mcp.timeout', R.timerMs, s.timeout)
      : undefined;
  const maps = checkMcpMaps(check, 'mcp', s);
  return mcpType
    ? {
        type: mcpType,
        url,
        command,
        args: mcpArgs,
        headers: maps.headers,
        ...(timeout !== undefined ? { timeout } : {}),
        ...(maps.toolTimeouts !== undefined
          ? { toolTimeouts: maps.toolTimeouts }
          : {}),
      }
    : undefined;
}

export function resolveAgentSection(
  yaml: YamlConfig,
  fields: StartConfigFields,
  check: FieldCheck,
): SmartServerAgentConfig {
  const at = (k: string): unknown => get(yaml, 'agent', k);
  const flag = (k: string) =>
    at(k) !== undefined ? { [k]: check.flag(`agent.${k}`, at(k)) } : {};
  const num = (k: string, rule: (typeof R)[keyof typeof R]) =>
    at(k) !== undefined ? { [k]: check.number(`agent.${k}`, rule, at(k)) } : {};
  return {
    // Spec D83 (9): one of the names, never cast.
    externalToolsValidationMode:
      at('externalToolsValidationMode') !== undefined
        ? (check.oneOf(
            'agent.externalToolsValidationMode',
            TOOLS_VALIDATION_MODES,
            at('externalToolsValidationMode'),
          ) ?? 'permissive')
        : 'permissive',
    // The fields of the config field rules arrive validated (spec D83 (5)) —
    // never coerced here; an absent one keeps its 30.1.0 default.
    maxIterations: fields.maxIterations ?? 10,
    maxToolCalls: fields.maxToolCalls ?? 30,
    // Spec U8, D83 (5): a start-only field with no default — set, the server
    // injects HeuristicToolAvailabilityPolicy with this TTL; absent stays absent.
    ...(get(yaml, 'agent', 'toolUnavailableTtlMs') !== undefined
      ? {
          toolUnavailableTtlMs: check.number(
            'agent.toolUnavailableTtlMs',
            START_NUMBER_RULES.toolUnavailableTtlMs,
            get(yaml, 'agent', 'toolUnavailableTtlMs'),
          ),
        }
      : {}),
    ragQueryK: fields.ragQueryK ?? 10,
    // Spec D83 (7): every other field through the start's check.
    ...num('contextBudgetTokens', R.contextBudgetTokens),
    ...flag('semanticHistoryEnabled'),
    ...num('historyRecencyWindow', R.historyRecencyWindow),
    ...(at('historyTurnSummaryPrompt') !== undefined
      ? {
          historyTurnSummaryPrompt: check.text(
            'agent.historyTurnSummaryPrompt',
            at('historyTurnSummaryPrompt'),
          ),
        }
      : {}),
    showReasoning: fields.showReasoning ?? false,
    historyAutoSummarizeLimit: fields.historyAutoSummarizeLimit ?? 10,
    queryExpansionEnabled: fields.queryExpansionEnabled ?? false,
    toolResultCacheTtlMs: fields.toolResultCacheTtlMs ?? 300000,
    sessionTokenBudget: fields.sessionTokenBudget ?? 0,
    ...(fields.classificationEnabled !== undefined
      ? { classificationEnabled: fields.classificationEnabled }
      : {}),
    ...flag('toolReselectPerIteration'),
    ...flag('ragTranslateEnabled'),
    ...flag('refreshToolsPerIteration'),
    ...(at('streamMode') !== undefined
      ? {
          streamMode: check.oneOf(
            'agent.streamMode',
            STREAM_MODES,
            at('streamMode'),
          ),
        }
      : {}),
    ...(at('llmCallStrategy') !== undefined
      ? {
          llmCallStrategy: check.oneOf(
            'agent.llmCallStrategy',
            LLM_CALL_STRATEGIES,
            at('llmCallStrategy'),
          ),
        }
      : {}),
    // An invalid value fails the start; 0 passes and disables the keep-alive
    // at runtime (the libs keep-alive treats it as off), as documented.
    ...num('heartbeatIntervalMs', R.heartbeatIntervalMs),
    ...num('healthTimeoutMs', R.timerMs),
    ...(present(at('retry')) ? { retry: checkRetry(check, at('retry')) } : {}),
    ...(present(at('toolSelection'))
      ? { toolSelection: checkToolSelection(check, at('toolSelection')) }
      : {}),
    ...flag('mcpSharedClient'),
  };
}

export function resolvePromptsSection(
  fields: StartConfigFields,
): SmartServerConfig['prompts'] {
  // Validated (spec D83 (5)): every present prompt is a non-empty string; an
  // empty one failed the start instead of being read as absent.
  const prompts = fields.prompts;
  return prompts !== undefined && Object.keys(prompts).length > 0
    ? { ...prompts }
    : undefined;
}

export function resolvePipelineSelection(
  yaml: YamlConfig,
  check: FieldCheck,
): {
  pipeline?: SmartServerConfig['pipeline'];
} {
  // Pipeline selection: `pipeline: { name, config }`. `name` is required;
  // `config` is the selected plugin's section, parsed at startup by the server
  // (built-ins) or by the plugin's factory (dynamic). A bare string
  // (`pipeline: stepper`) is accepted as shorthand for `{ name: <string> }`.
  const raw = (yaml as { pipeline?: unknown }).pipeline;
  if (raw === undefined) return {};
  // Spec D83 (13): `pipeline:` with no value is that, never "no pipeline".
  if (raw === null) {
    check.refuse('pipeline', 'has no value', raw);
    return {};
  }
  if (typeof raw === 'string') return { pipeline: { name: raw } };
  const obj = raw as { name?: unknown; config?: unknown };
  if (typeof obj.name !== 'string') {
    throw new Error(
      "pipeline: requires a 'name' (one of: flat, linear, dag, stepper, controller, controller-weak, or a registered plugin)",
    );
  }
  // Spec D83 (9), (12): a present section is a mapping — never read as absent.
  const config = present(obj.config)
    ? (check.section('pipeline.config', obj.config) ?? {})
    : undefined;
  // The host key the server seeds every new session from, checked with the
  // stepper's rule whichever pipeline is selected (spec D83 (12)).
  if (config !== undefined && present(config.knowledgeSeed)) {
    checkKnowledgeSeed(
      check,
      'pipeline.config.knowledgeSeed',
      config.knowledgeSeed,
    );
  }
  return {
    pipeline: {
      name: obj.name,
      ...(config !== undefined ? { config: { ...config } } : {}),
    },
  };
}

/**
 * `decision:` → named fields only. An optional field absent in YAML is absent in
 * the result (unset is not sent); a present falsy value (`maxRetries: 0`) is
 * kept. `apiKey` is never copied — the validator refuses it from the raw YAML.
 */
export function resolveDecisionSection(
  yaml: YamlConfig,
  check: FieldCheck,
): SmartServerDecisionConfig | undefined {
  const raw = get(yaml, 'decision');
  if (!present(raw)) return undefined;
  // Spec D83 (12): 30.1.0 read `decision: typesafe` as a section with no provider.
  const d = check.section('decision', raw);
  if (d === undefined) return undefined;
  const out = { provider: d.provider } as SmartServerDecisionConfig;
  // Spec D83 (7), (13): checked — `""` and a key with no value are errors.
  if (d.model !== undefined) out.model = check.text('decision.model', d.model);
  if (d.credentialRef !== undefined) {
    out.credentialRef = d.credentialRef as string;
  }
  if (d.baseUrl !== undefined) {
    out.baseUrl = check.text('decision.baseUrl', d.baseUrl);
  }
  // Invalid values are left out here; the validator (same parser) reports them.
  const timeoutMs = parseIntegerField(d.timeoutMs);
  if (typeof timeoutMs === 'number') out.timeoutMs = timeoutMs;
  const maxRetries = parseIntegerField(d.maxRetries);
  if (typeof maxRetries === 'number') out.maxRetries = maxRetries;
  return out;
}
