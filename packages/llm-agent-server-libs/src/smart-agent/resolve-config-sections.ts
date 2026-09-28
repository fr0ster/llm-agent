/**
 * Per-section config builders extracted from resolveSmartServerConfig.
 * Internal module — not re-exported by the package barrel.
 */

import {
  type IThrottleStrategy,
  ReportThrottling,
  WaitAsTold,
} from '@mcp-abap-adt/llm-agent';
import { normalizeHeartbeatMs } from '@mcp-abap-adt/llm-agent-libs';
import { optionalNumber } from './llm-config-map.js';
import type {
  BuiltInEmbedderProvider,
  SmartServerEmbedderConfig,
  SmartServerRagStoreConfig,
} from './rag-config.js';
import type {
  SmartServerAgentConfig,
  SmartServerConfig,
  SmartServerLlmConfig,
  SmartServerMcpConfig,
} from './smart-server.js';
import type { YamlConfig } from './yaml-loader.js';
import { get } from './yaml-loader.js';

export function resolveLlmSection(yaml: YamlConfig): SmartServerConfig['llm'] {
  return get(yaml, 'llm')
    ? typeof get(yaml, 'llm', 'provider') === 'string'
      ? {
          provider: get(yaml, 'llm', 'provider') as
            | 'deepseek'
            | 'openai'
            | 'anthropic'
            | 'sap-ai-sdk'
            | 'ollama'
            | undefined,
          // A name the composition root resolves — never a value. Its shape is
          // checked by the validator, which reads the raw YAML.
          ...(typeof get(yaml, 'llm', 'credentialRef') === 'string'
            ? { credentialRef: get(yaml, 'llm', 'credentialRef') as string }
            : {}),
          url: get(yaml, 'llm', 'url') as string | undefined,
          model: get(yaml, 'llm', 'model') as string | undefined,
          // Unset stays unset: the provider then sends no temperature and
          // the model applies its own default.
          temperature: optionalNumber(get(yaml, 'llm', 'temperature')),
          classifierTemperature: optionalNumber(
            get(yaml, 'llm', 'classifierTemperature'),
          ),
          // Both of these are declared on SmartServerLlmConfig and were missing
          // from this allow-list, which is exactly the disappearing act the
          // comment on positiveIntOption warns about: the key is accepted in
          // YAML, read by nobody, and the default applies in silence.
          ...positiveIntOption(get(yaml, 'llm', 'maxTokens'), 'llm.maxTokens'),
          ...whenThrottledOption(get(yaml, 'llm', 'whenThrottled')),
        }
      : validateLlmMap(get(yaml, 'llm') as Record<string, SmartServerLlmConfig>)
    : undefined;
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
  map: Record<string, SmartServerLlmConfig>,
): Record<string, SmartServerLlmConfig> {
  const out: Record<string, SmartServerLlmConfig> = {};
  for (const [role, entry] of Object.entries(map ?? {})) {
    if (!entry || typeof entry !== 'object') {
      out[role] = entry;
      continue;
    }
    const raw = entry as unknown as Record<string, unknown>;
    // The normalised values are written back, not merely checked. `${ENV_VAR}`
    // substitution leaves numbers as strings, and the resolved config is typed
    // as though they were numbers: the built-in strategy happens to coerce them
    // in arithmetic, a custom one would be handed a string and told it was a
    // number. Validating without keeping the result is checking the door and
    // then walking through the window.
    out[role] = {
      ...(entry as SmartServerLlmConfig),
      ...(raw.whenThrottled !== undefined
        ? whenThrottledOption(raw.whenThrottled, `llm.${role}.whenThrottled`)
        : {}),
      ...(raw.maxTokens !== undefined
        ? positiveIntOption(raw.maxTokens, `llm.${role}.maxTokens`)
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
): Record<string, number> {
  if (value === undefined) return {};
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new Error(
      `Invalid ${key}: expected a positive integer, got ${JSON.stringify(value)}`,
    );
  }
  return { [key.split('.').pop() as string]: n };
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
  path = 'llm.whenThrottled',
): { whenThrottled?: IThrottleStrategy } {
  if (value === undefined || value === null) return {};

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
    if (key === 'strategy' || v === undefined || v === null) continue;
    // A count, not a duration: fractional attempts do not exist, and zero of
    // them is not "none" — the first attempt is included in the total, so 0
    // behaves as 1 and 1.5 as 2. Silently meaning something other than what it
    // says is the whole failure mode this block exists to prevent.
    if (key === 'maxAttempts') {
      const n = Number(v);
      if (!Number.isSafeInteger(n) || n < 1) {
        throw new Error(
          `Invalid ${path}.maxAttempts: expected a positive integer, got ${JSON.stringify(v)}`,
        );
      }
      options.maxAttempts = n;
      continue;
    }
    throw new Error(
      `Unknown ${path} key '${key}'. Known keys: strategy, maxAttempts.`,
    );
  }
  return { whenThrottled: named(raw.strategy, options) };
}

const has = (v: unknown): boolean => v !== undefined && v !== null;

/**
 * Project `rag.store` per arm. A value substituted from `${VAR}` arrives as a string,
 * so numbers are coerced here rather than handed on typed as what they are not. A
 * missing or unknown `type` is passed through untouched for validateResolvedConfig
 * to report beside every other issue.
 */
function resolveRagStore(
  raw: unknown,
  args: Record<string, unknown>,
): SmartServerRagStoreConfig {
  const s = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<
    string,
    unknown
  >;
  const collectionName =
    (args['rag-collection-name'] as string | undefined) ??
    (has(s.collectionName) ? String(s.collectionName) : undefined);
  const ref =
    typeof s.credentialRef === 'string'
      ? { credentialRef: s.credentialRef }
      : {};
  const address = {
    ...(has(s.connectionString)
      ? { connectionString: String(s.connectionString) }
      : {}),
    ...(has(s.host) ? { host: String(s.host) } : {}),
    ...(has(s.port) ? { port: Number(s.port) } : {}),
    ...(has(s.schema) ? { schema: String(s.schema) } : {}),
    ...(has(s.poolMax) ? { poolMax: Number(s.poolMax) } : {}),
    ...(has(s.connectTimeout)
      ? { connectTimeout: Number(s.connectTimeout) }
      : {}),
    ...(has(s.dimension) ? { dimension: Number(s.dimension) } : {}),
    ...(has(s.autoCreateSchema)
      ? {
          autoCreateSchema:
            s.autoCreateSchema === true || s.autoCreateSchema === 'true',
        }
      : {}),
  };
  switch (s.type) {
    case 'in-memory':
      return {
        type: 'in-memory',
        ...(collectionName !== undefined ? { collectionName } : {}),
        dedupThreshold: Number(s.dedupThreshold ?? 0.92),
        vectorWeight: Number(s.vectorWeight ?? 0.7),
        keywordWeight: Number(s.keywordWeight ?? 0.3),
        ...ref,
      };
    case 'qdrant':
      return {
        type: 'qdrant',
        url: String(s.url ?? ''),
        // main's makeRag defaulted this; the typed arm requires it, so the default
        // lives at the boundary that fills the arm
        collectionName: collectionName ?? 'llm-agent',
        ...(has(s.timeoutMs) ? { timeoutMs: Number(s.timeoutMs) } : {}),
        ...ref,
      };
    case 'pg-vector':
      return {
        type: 'pg-vector',
        collectionName: collectionName ?? '',
        ...address,
        ...(has(s.database) ? { database: String(s.database) } : {}),
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
  raw: Record<string, unknown>,
): SmartServerEmbedderConfig {
  const common = {
    ...(has(raw.model) ? { model: String(raw.model) } : {}),
    ...(has(raw.url) ? { url: String(raw.url) } : {}),
    // Left absent when unset so the provider's declared cap wins; see
    // composeResilientEmbedder's precedence (YAML → provider → default).
    ...positiveIntOption(raw.maxBatchSize, 'rag.embedder.maxBatchSize'),
  };
  if (has(raw.factory)) {
    // credentialRef/resourceGroup/scenario beside a factory are refused by checkRag.
    return { factory: String(raw.factory), ...common };
  }
  return {
    // No provider means ollama, the default this section always had. An unknown
    // name is refused by checkRag in the same resolveSmartServerConfig call, before
    // anything reads the value — as `resolveRagStore`'s pass-through default is.
    provider: (has(raw.provider)
      ? String(raw.provider)
      : 'ollama') as BuiltInEmbedderProvider,
    ...common,
    ...(has(raw.resourceGroup)
      ? { resourceGroup: String(raw.resourceGroup) }
      : {}),
    ...(has(raw.scenario)
      ? {
          scenario: String(raw.scenario) as
            | 'orchestration'
            | 'foundation-models',
        }
      : {}),
    ...(typeof raw.credentialRef === 'string'
      ? { credentialRef: raw.credentialRef }
      : {}),
  };
}

export function resolveRagSection(
  yaml: YamlConfig,
  args: Record<string, unknown>,
): SmartServerConfig['rag'] {
  if (!get(yaml, 'rag')) return undefined;
  const embedder = get(yaml, 'rag', 'embedder');
  return {
    store: resolveRagStore(get(yaml, 'rag', 'store'), args),
    ...(embedder !== null &&
    typeof embedder === 'object' &&
    !Array.isArray(embedder)
      ? { embedder: resolveRagEmbedder(embedder as Record<string, unknown>) }
      : {}),
  };
}

/** Namespace-prefix label charset — mirrors IToolNamespace's exposed-name
 *  validation so a bad label fails at config parse, not at tool-listing time. */
const MCP_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * Validate `mcp[].name`: non-empty charset `^[a-zA-Z0-9_-]+$`, unique across
 * all configured servers. Servers without a `name` are left alone — the
 * namespace strategy falls back to `s${slotIndex}` for them.
 */
function validateMcpNames(entries: SmartServerMcpConfig[]): void {
  const seen = new Set<string>();
  entries.forEach((entry, index) => {
    const name = entry.name;
    if (name === undefined) return;
    if (typeof name !== 'string' || !MCP_NAME_PATTERN.test(name)) {
      throw new Error(
        `Invalid mcp[${index}].name: ${JSON.stringify(name)} — must be non-empty and match ^[a-zA-Z0-9_-]+$`,
      );
    }
    if (seen.has(name)) {
      throw new Error(
        `Duplicate mcp[].name: "${name}" is used by more than one server — labels must be unique.`,
      );
    }
    seen.add(name);
  });
}

export function resolveMcpSection(
  yaml: YamlConfig,
  args: Record<string, unknown>,
): SmartServerConfig['mcp'] {
  const rawMcp = yaml.mcp;
  const mcpIsArray = Array.isArray(rawMcp);
  if (mcpIsArray) {
    validateMcpNames(rawMcp as SmartServerMcpConfig[]);
  }
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

  return mcpIsArray
    ? (rawMcp as SmartServerMcpConfig[])
    : mcpType
      ? {
          type: mcpType,
          url: mcpUrl || undefined,
          command: mcpCommand || undefined,
          args:
            (args['mcp-args'] as string) || get(yaml, 'mcp', 'args')
              ? String(args['mcp-args'] || get(yaml, 'mcp', 'args')).split(' ')
              : undefined,
          headers:
            (get(yaml, 'mcp', 'headers') as Record<string, string>) ||
            undefined,
          ...(get(yaml, 'mcp', 'timeout') !== undefined
            ? { timeout: Number(get(yaml, 'mcp', 'timeout')) }
            : {}),
          ...(get(yaml, 'mcp', 'toolTimeouts') !== undefined
            ? {
                toolTimeouts: get(yaml, 'mcp', 'toolTimeouts') as Record<
                  string,
                  number
                >,
              }
            : {}),
        }
      : undefined;
}

export function resolveAgentSection(
  yaml: YamlConfig,
  args: Record<string, unknown>,
): SmartServerAgentConfig {
  return {
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
      ? (() => {
          const n = Number(get(yaml, 'agent', 'heartbeatIntervalMs'));
          if (normalizeHeartbeatMs(n) === null) {
            console.warn(
              `[config] agent.heartbeatIntervalMs=${get(yaml, 'agent', 'heartbeatIntervalMs')} is invalid or <= 0 — SSE keep-alive and tool-loop heartbeat are DISABLED.`,
            );
          }
          return { heartbeatIntervalMs: n };
        })()
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
    ...(get(yaml, 'agent', 'mcpSharedClient') !== undefined
      ? { mcpSharedClient: Boolean(get(yaml, 'agent', 'mcpSharedClient')) }
      : {}),
  };
}

export function resolvePromptsSection(
  yaml: YamlConfig,
): SmartServerConfig['prompts'] {
  const promptSystem = (get(yaml, 'prompts', 'system') as string) ?? null;
  const promptClassifier =
    (get(yaml, 'prompts', 'classifier') as string) ?? null;
  const promptReasoning = get(yaml, 'prompts', 'reasoning') ?? null;
  const promptRagTranslate = get(yaml, 'prompts', 'ragTranslate') ?? null;
  const promptHistorySummary = get(yaml, 'prompts', 'historySummary') ?? null;

  return promptSystem ||
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
    : undefined;
}

export function resolvePipelineSelection(yaml: YamlConfig): {
  pipeline?: SmartServerConfig['pipeline'];
} {
  // Pipeline selection: `pipeline: { name, config }`. `name` is required;
  // `config` is the selected plugin's section, parsed at startup by the server
  // (built-ins) or by the plugin's factory (dynamic). A bare string
  // (`pipeline: stepper`) is accepted as shorthand for `{ name: <string> }`.
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
}
