/**
 * Shared config utilities for SmartServer.
 */

import fs from 'node:fs';
import path from 'node:path';
import type {
  ILlm,
  ISubAgentContextBuilder,
  IToolSelectionStrategy,
} from '@mcp-abap-adt/llm-agent';
import {
  AutoActivation,
  ExplicitActivation,
  HybridDispatch,
  OneShotPlanning,
  ReplanOnErrorPlanning,
  ScoreThresholdToolSelection,
  SelfDispatch,
  SkillStepsPlanning,
  SubAgentDispatch,
  TopKToolSelection,
} from '@mcp-abap-adt/llm-agent-libs';
import { parse as parseYaml } from 'yaml';
import type {
  SmartServerConfig,
  SmartServerMode,
  SmartServerSubAgentConfig,
} from './smart-server.js';

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
  reviewer?: { type?: string; plannerLlm?: 'main' | 'planner' | 'helper' };
  errorStrategy?: { type?: string; maxReplans?: number };
}

const LINEAR_ONLY = [
  'planning',
  'dispatch',
  'maxSteps',
  'maxRetriesPerStep',
  'failPolicy',
  'maxLayer',
  'plannerLlm',
];
const DAG_ONLY = ['planner', 'interpreter', 'reviewer', 'errorStrategy'];

/** Validate a `{ type?: 'llm'; plannerLlm?: main|planner|helper }` role block. */
function assertLlmRoleShape(label: string, role: unknown): void {
  if (typeof role !== 'object' || role === null || Array.isArray(role)) {
    throw new Error(
      `coordinator.${label} must be an object (e.g. { type: llm }), got: ${JSON.stringify(role)}`,
    );
  }
  const kind = (role as { type?: unknown }).type;
  if (kind !== undefined && kind !== 'llm') {
    throw new Error(
      `coordinator.${label}: unknown type '${String(kind)}' (only 'llm' is supported)`,
    );
  }
  const sel = (role as { plannerLlm?: unknown }).plannerLlm;
  if (
    sel !== undefined &&
    sel !== 'main' &&
    sel !== 'planner' &&
    sel !== 'helper'
  ) {
    throw new Error(
      `coordinator.${label}.plannerLlm must be one of main | planner | helper, got: ${String(sel)}`,
    );
  }
}

function assertErrorStrategyShape(es: unknown): void {
  if (typeof es !== 'object' || es === null || Array.isArray(es)) {
    throw new Error(
      `coordinator.errorStrategy must be an object (e.g. { type: replan }), got: ${JSON.stringify(es)}`,
    );
  }
  const type = (es as { type?: unknown }).type;
  if (
    type !== undefined &&
    type !== 'abort' &&
    type !== 'replan' &&
    type !== 'reviewer'
  ) {
    throw new Error(
      `coordinator.errorStrategy: unknown type '${String(type)}' (only 'abort' | 'replan' | 'reviewer')`,
    );
  }
  const mr = (es as { maxReplans?: unknown }).maxReplans;
  if (mr !== undefined && (typeof mr !== 'number' || mr < 0)) {
    throw new Error(
      `coordinator.errorStrategy.maxReplans must be a non-negative number, got: ${String(mr)}`,
    );
  }
}

/** Fail-loud guard: a coordinator block is either DAG (has `planner`) or linear,
 *  never mixed. `activation` is shared and always allowed. */
export function assertCoordinatorConfigShape(
  coord: Record<string, unknown>,
): void {
  const isDag = coord.planner !== undefined;
  if (isDag) {
    assertLlmRoleShape('planner', coord.planner);
    if (coord.reviewer !== undefined) {
      assertLlmRoleShape('reviewer', coord.reviewer);
    }
    if (coord.errorStrategy !== undefined) {
      assertErrorStrategyShape(coord.errorStrategy);
    }
    for (const f of LINEAR_ONLY) {
      if (coord[f] !== undefined) {
        throw new Error(
          `coordinator: '${f}' is a linear-only field and cannot be combined with 'planner' (DAG mode)`,
        );
      }
    }
  } else {
    for (const f of DAG_ONLY) {
      if (coord[f] !== undefined) {
        throw new Error(
          `coordinator: '${f}' is a DAG-only field; a linear coordinator uses 'planning'/'dispatch'`,
        );
      }
    }
  }
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

export type YamlConfig = Record<string, unknown>;

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

export const YAML_TEMPLATE = `port: 4004
host: 0.0.0.0

# Request routing mode:
#   hard        — Fully managed context. Ignores client history/system prompt. Uses RAG + internal MCP tools only.
#   pass        — Transparent proxy. Logs everything but modifies nothing.
#   smart       — Hybrid. Preserves client history but enriches it with RAG context and MCP tools based on analysis. (default)
mode: smart

llm:
  provider: deepseek                  # deepseek | openai | anthropic | sap-ai-sdk | ollama
  apiKey: \${DEEPSEEK_API_KEY}        # not required for ollama / sap-ai-sdk
  model: deepseek-chat
  temperature: 0.7
  classifierTemperature: 0.1

rag:
  type: in-memory                     # in-memory | qdrant | hana-vector | pg-vector
  embedder: ollama                    # Embedder to use: ollama | openai | sap-ai-core | <custom>
  url: http://localhost:11434
  model: bge-m3
  # resourceGroup: default            # SAP AI Core resource group (sap-ai-core embedder)
  # scenario: orchestration           # SAP AI Core scenario: orchestration (default) | foundation-models
  # collectionName: llm-agent         # Collection/table name (qdrant | hana-vector | pg-vector)
  dedupThreshold: 0.92
  vectorWeight: 0.7                   # Semantic similarity weight (0..1)
  keywordWeight: 0.3                  # Lexical matching weight (0..1)

mcp:
  # type: none | http | stdio
  # To disable MCP, set type to 'none'
  type: http
  url: http://localhost:3001/mcp/stream/http

agent:
  externalToolsValidationMode: permissive  # permissive | strict
  maxIterations: 10
  maxToolCalls: 30
  toolUnavailableTtlMs: 600000       # Temporary tool blacklist TTL (ms)
  ragQueryK: 10
  # contextBudgetTokens: 4000          # Max tokens for RAG context in system prompt (0 = no limit)
  # semanticHistoryEnabled: false      # Enable semantic history via RAG
  # historyRecencyWindow: 4            # Last N messages from client history in LLM context
  # historyTurnSummaryPrompt: "..."    # LLM prompt for turn summarization
  showReasoning: false                # Explain strategy at start of response
  historyAutoSummarizeLimit: 10       # History length to trigger compression
  queryExpansionEnabled: false        # Expand RAG queries with LLM-generated synonyms
  toolResultCacheTtlMs: 300000       # Tool result cache TTL (ms); 0 to disable
  sessionTokenBudget: 0              # Multi-turn token budget; 0 to disable
  # ragTranslateEnabled: true        # Translate non-ASCII RAG queries to English (default: true)
  # classificationEnabled: false     # Enable for custom pipelines with multi-store routing
  # toolReselectPerIteration: false  # Re-select tools via RAG on each tool-loop iteration
  # llmCallStrategy: streaming       # streaming | non-streaming | fallback
  # streamMode: full                 # full | final — streaming behavior for tool loops
  # heartbeatIntervalMs: 5000       # SSE heartbeat interval during tool execution (ms)
  # healthTimeoutMs: 5000            # Health check probe timeout (ms); increase for slow providers (SAP AI Core: 15000)
  # retry:                           # LLM retry config for 429/5xx errors
  #   maxAttempts: 3
  #   backoffMs: 1000
  #   retryOn: [429, 500, 502, 503]
  #   retryOnMidStream: ['SSE stream']  # Substrings triggering mid-stream retry

# --- Advanced Multi-Model Pipeline (optional) -------------------------------
# Use this section to assign different models for different internal tasks.
# pipeline:
#   llm:
#     main:
#       provider: deepseek            # deepseek | openai | anthropic | sap-ai-sdk
#       apiKey: \${DEEPSEEK_API_KEY}
#       model: deepseek-chat
#       temperature: 0.7
#       streaming: true               # false to disable streaming for this provider
#     classifier:                     # optional; if absent, main config is reused
#       provider: deepseek
#       apiKey: \${DEEPSEEK_API_KEY}
#       model: deepseek-chat
#       temperature: 0.1
#     helper:                         # optional; if absent, main config is reused
#       provider: deepseek
#       apiKey: \${DEEPSEEK_API_KEY}
#       model: deepseek-chat
#       temperature: 0.1
#
#   rag:
#     tools:
#       type: qdrant
#       url: http://qdrant:6333
#       embedder: openai              # ollama | openai | <custom registered name>
#       model: text-embedding-3-small
#       apiKey: \${OPENAI_API_KEY}
#     history:
#       type: in-memory
#
#   mcp:
#     - type: http
#       url: http://localhost:3001/mcp/stream/http

# --- Structured Pipeline (optional) -------------------------------------------
# Replaces the hardcoded orchestration flow with a YAML-defined stage tree.
# When absent, the default flow runs unchanged (full backwards compatibility).
#
# pipeline:
#   version: "1"
#   stages:
#     - id: classify
#       type: classify
#     - id: summarize
#       type: summarize
#     - id: rag-retrieval
#       type: parallel
#       when: "shouldRetrieve"
#       stages:
#         - { id: translate, type: translate }
#         - { id: expand, type: expand }
#       after:
#         - id: rag-queries
#           type: parallel
#           stages:
#             - { id: tools, type: rag-query, config: { store: tools, k: 10 } }
#             - { id: history, type: rag-query, config: { store: history, k: 5 } }
#         - { id: rerank, type: rerank }
#         - { id: tool-select, type: tool-select }
#     - id: assemble
#       type: assemble
#     - id: tool-loop
#       type: tool-loop

# prompts:
#   system: "You are a helpful assistant specialized in SAP ABAP development."
#   classifier: |
#     You are an intent classifier... (see source for full default prompt)
#   reasoning: |
#     IMPORTANT: Always start your response with a brief <reasoning> block...
#   ragTranslate: |
#     Translate the user request to English for search purposes...
#   historySummary: |
#     Summarize the conversation so far...

log: smart-server.log                 # path to log file; omit for stdout
# logDir: sessions                    # Directory for detailed session debug logs
# pluginDir: ./my-plugins             # Additional plugin directory (loaded after defaults)

# subagents:                          # Optional: nested agents callable from pipeline
#   - name: code-reviewer             # Used as stage config: { agent: code-reviewer }
#     description: |                  # Optional. Shown to the Coordinator planner LLM
#       Reviews code and returns      # so it can pick this agent for the right step.
#       structured JSON.
#     config: ./agents/code-reviewer.yaml

# coordinator:                        # Optional: enable autonomous plan-execute loop
#   planning: one-shot                # one-shot | replan-on-error | skill-steps
#   dispatch: subagent                # subagent | self | hybrid
#   activation: explicit              # explicit (default) | auto
#   plannerLlm: main                  # main | planner | helper (unused by skill-steps)
#   maxSteps: 12
#   maxRetriesPerStep: 1
#   failPolicy: abort                 # abort | continue
#   maxLayer: 1                       # DEPRECATED — accepted but ignored (nested
#                                     # dispatch removed; subagents are leaves)
`;

export function resolveEnvVars(
  value: unknown,
  env: NodeJS.ProcessEnv = process.env,
): unknown {
  if (typeof value === 'string')
    return value.replace(
      /\$\{([^}:]+)(?::-(.*?))?\}/g,
      (_, name, fallback) => env[name] || fallback || '',
    );
  if (Array.isArray(value)) return value.map((v) => resolveEnvVars(v, env));
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        resolveEnvVars(v, env),
      ]),
    );
  return value;
}

export function loadYamlConfig(
  filePath: string,
  env: NodeJS.ProcessEnv = process.env,
): YamlConfig {
  const raw = fs.readFileSync(filePath, 'utf8');
  return resolveEnvVars(parseYaml(raw), env) as YamlConfig;
}

export function generateConfigTemplate(outputPath: string): void {
  fs.writeFileSync(outputPath, YAML_TEMPLATE, 'utf8');
}

const get = (obj: unknown, ...keys: string[]): unknown =>
  keys.reduce<unknown>((o, k) => {
    if (o !== null && typeof o === 'object' && k in o) {
      return (o as Record<string, unknown>)[k];
    }
    return undefined;
  }, obj);

function checkLlmRole(
  label: string,
  role: { provider?: unknown; apiKey?: unknown; model?: unknown } | undefined,
  requireModel: boolean,
  env: NodeJS.ProcessEnv,
  issues: string[],
): void {
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
  if (requireModel && !role?.model) {
    issues.push(`${label}.model: required (string)`);
  }
  if (
    provider === 'openai' ||
    provider === 'anthropic' ||
    provider === 'deepseek'
  ) {
    if (!role?.apiKey) {
      issues.push(
        `${provider} requires ${label}.apiKey to resolve to a non-empty value (typically via \${${provider.toUpperCase()}_API_KEY} env reference).`,
      );
    }
  } else if (provider === 'sap-ai-sdk') {
    if (!env.AICORE_SERVICE_KEY) {
      issues.push(
        'sap-ai-sdk requires the AICORE_SERVICE_KEY env var to be set with the SAP AI Core service-key JSON content. None found.',
      );
    }
  }
  // ollama: no credential check.
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
  if (usesEmbedder && !store.model) {
    issues.push(
      `${label}.model: required when an embedder is used (e.g. bge-m3 for ollama)`,
    );
  }
}

function validateResolvedConfig(
  resolved: Omit<SmartServerConfig, 'log'>,
  yaml: YamlConfig,
  env: NodeJS.ProcessEnv,
): void {
  const issues: string[] = [];
  const usingPipeline = !!get(yaml, 'pipeline', 'llm', 'main');

  if (usingPipeline) {
    const llmCfg = get(yaml, 'pipeline', 'llm') as
      | Record<
          string,
          { provider?: unknown; apiKey?: unknown; model?: unknown }
        >
      | undefined;
    checkLlmRole('pipeline.llm.main', llmCfg?.main, true, env, issues);
    if (llmCfg?.classifier) {
      checkLlmRole(
        'pipeline.llm.classifier',
        llmCfg.classifier,
        false,
        env,
        issues,
      );
    }
    if (llmCfg?.helper) {
      checkLlmRole('pipeline.llm.helper', llmCfg.helper, false, env, issues);
    }
  } else {
    checkLlmRole(
      'llm',
      {
        provider: resolved.llm.provider,
        apiKey: resolved.llm.apiKey,
        model: resolved.llm.model,
      },
      true,
      env,
      issues,
    );
  }

  if (get(yaml, 'mcp')) {
    const mcpType = get(yaml, 'mcp', 'type') as string | undefined;
    if (mcpType && !['http', 'stdio', 'none'].includes(mcpType)) {
      issues.push(
        `mcp.type: "${mcpType}" is invalid (one of: http, stdio, none)`,
      );
    }
    if (mcpType === 'http' && !get(yaml, 'mcp', 'url')) {
      issues.push('mcp.url: required when mcp.type is http');
    }
    if (mcpType === 'stdio' && !get(yaml, 'mcp', 'command')) {
      issues.push('mcp.command: required when mcp.type is stdio');
    }
  }

  if (get(yaml, 'rag')) {
    checkRagStore('rag', get(yaml, 'rag') as Record<string, unknown>, issues);
  }
  const pipelineRag = get(yaml, 'pipeline', 'rag') as
    | Record<string, Record<string, unknown>>
    | undefined;
  if (pipelineRag) {
    for (const [name, store] of Object.entries(pipelineRag)) {
      checkRagStore(`pipeline.rag.${name}`, store, issues);
    }
  }

  if (issues.length > 0) throw new ConfigValidationError([...new Set(issues)]);
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
    if ((subYaml as { clientAdapter?: unknown }).clientAdapter !== undefined) {
      unsupported.push('clientAdapter');
    }
    if (
      (subYaml as { circuitBreaker?: unknown }).circuitBreaker !== undefined
    ) {
      unsupported.push('circuitBreaker');
    }
    const subPipeline = (subYaml as { pipeline?: unknown }).pipeline;
    if (subPipeline && typeof subPipeline === 'object') {
      const p = subPipeline as Record<string, unknown>;
      if (p.reranker !== undefined) unsupported.push('pipeline.reranker');
      if (p.queryExpander !== undefined)
        unsupported.push('pipeline.queryExpander');
      if (p.outputValidator !== undefined)
        unsupported.push('pipeline.outputValidator');
      if (
        p.rag !== undefined &&
        p.rag !== null &&
        typeof p.rag === 'object' &&
        !Array.isArray(p.rag)
      ) {
        unsupported.push('pipeline.rag');
      }
    }
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
}

export function resolveSmartServerConfig(
  args: ResolveConfigArgs = {},
  yaml: YamlConfig = {},
  env: NodeJS.ProcessEnv = process.env,
  options: ResolveSmartServerConfigOptions = {},
): Omit<SmartServerConfig, 'log'> {
  const flatApiKey = (get(yaml, 'llm', 'apiKey') as string) ?? '';
  const pipelineApiKey = get(yaml, 'pipeline', 'llm', 'main', 'apiKey') as
    | string
    | undefined;
  const apiKey = flatApiKey || pipelineApiKey || '';

  const mcpUrl = get(yaml, 'mcp', 'url') as string | undefined;
  const mcpCommand = get(yaml, 'mcp', 'command') as string | undefined;
  const mcpTypeRaw =
    (get(yaml, 'mcp', 'type') as string) ??
    (mcpUrl ? 'http' : mcpCommand ? 'stdio' : null);
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
    llm: {
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
    },
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
    mcp: mcpType
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
      const coordinatorYaml = (yaml as { coordinator?: YamlCoordinator })
        .coordinator;
      return coordinatorYaml ? { coordinatorYaml } : {};
    })(),
    ...(yaml.pipeline ? { pipeline: yaml.pipeline } : {}),
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
  };
  validateResolvedConfig(resolved, yaml, env);
  return resolved;
}
