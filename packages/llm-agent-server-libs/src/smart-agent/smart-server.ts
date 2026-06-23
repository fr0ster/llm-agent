/**
 * SmartServer — embeddable OpenAI-compatible HTTP server backed by SmartAgent.
 */

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import http from 'node:http';
import { createRequire } from 'node:module';
import { resolve as pathResolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  CallOptions,
  EmbedderFactory,
  IClientAdapter,
  IEmbedder,
  IKnowledgeRagHandle,
  ILlm,
  ILlmApiAdapter,
  ILogger,
  IMcpClient,
  IModelProvider,
  IModelResolver,
  IPipelineInstance,
  IPipelinePlugin,
  IRagRegistry,
  IRequestLogger,
  ISkillManager,
  ISkillPluginHost,
  IToolsRagHandle,
  LlmTool,
  LoadedPlugins,
  Message,
  NormalizedRequest,
  PluginExports,
  StreamToolCall,
  SubAgentRegistry,
  VectorRag,
} from '@mcp-abap-adt/llm-agent';
import {
  AdapterValidationError,
  buildExternalResults,
  type ExternalToolValidationCode,
  type IRag,
  normalizeAndValidateExternalTools,
  QueryEmbedding,
  toToolCallDelta,
} from '@mcp-abap-adt/llm-agent';
import type {
  IPluginLoader,
  SessionAgentParts,
  SessionGraph,
  SmartAgent,
  StopReason,
} from '@mcp-abap-adt/llm-agent-libs';
import {
  ClaudeSkillManager,
  CodexSkillManager,
  ConfigWatcher,
  FileSystemPluginLoader,
  FileSystemSkillManager,
  getDefaultPluginDirs,
  HealthChecker,
  type HotReloadableConfig,
  InMemoryKnowledgeBackend,
  type KnowledgeBackend,
  KnowledgeRag,
  makeLlm,
  mergePluginExports,
  SessionGraphFactory,
  SessionLogger,
  SessionRegistry,
  SmartAgentBuilder,
  type SmartAgentHandle,
  type SmartAgentReconfigureOptions,
  SmartAgentSubAgent,
} from '@mcp-abap-adt/llm-agent-libs';
import {
  MCPClientWrapper,
  McpClientAdapter,
} from '@mcp-abap-adt/llm-agent-mcp';
import type {
  EmbedderResolutionConfig,
  EmbedderResolutionOptions,
} from '@mcp-abap-adt/llm-agent-rag';
import {
  makeRag,
  prefetchEmbedderFactories,
  resolveEmbedder,
} from '@mcp-abap-adt/llm-agent-rag';
import { PACKAGE_VERSION } from '../generated/version.js';
import { resolveAgentEmbedder } from './resolve-agent-embedder.js';
import { resolveSessionIdentity } from './session-identity-resolver.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface SmartServerLlmConfig {
  /** Provider id for the flat schema. Required when no pipeline.llm.main is set. */
  provider?: 'deepseek' | 'openai' | 'anthropic' | 'sap-ai-sdk' | 'ollama';
  apiKey: string;
  /** Custom base URL (OpenAI-compatible endpoints: Ollama, Azure, vLLM). */
  url?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  classifierTemperature?: number;
}

export interface SmartServerRagConfig {
  type?: 'in-memory' | 'qdrant' | 'hana-vector' | 'pg-vector';
  /**
   * Embedder name — resolved from the embedder factory registry.
   * Built-in: 'ollama', 'openai', 'sap-ai-core'. Consumers can register custom factories.
   * When omitted, defaults to 'ollama' for stores that require one.
   */
  embedder?: string;
  url?: string;
  model?: string;
  collectionName?: string;
  dedupThreshold?: number;
  vectorWeight?: number;
  keywordWeight?: number;
  connectionString?: string;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  schema?: string;
  dimension?: number;
  autoCreateSchema?: boolean;
  poolMax?: number;
  connectTimeout?: number;
  /** SAP AI Core resource group (used when embedder is 'sap-ai-core' / 'sap-aicore'). */
  resourceGroup?: string;
  /**
   * SAP AI Core scenario for the embedding model deployment.
   * `'orchestration'` (default) uses the SAP SDK; `'foundation-models'` calls the REST inference API.
   */
  scenario?: 'orchestration' | 'foundation-models';
}

export interface SmartServerMcpConfig {
  type: 'http' | 'stdio';
  url?: string;
  command?: string;
  args?: string[];
  headers?: Record<string, string>;
}

export interface SmartServerAgentConfig {
  externalToolsValidationMode?: 'permissive' | 'strict';
  maxIterations?: number;
  maxToolCalls?: number;
  toolUnavailableTtlMs?: number;
  ragQueryK?: number;
  contextBudgetTokens?: number;
  semanticHistoryEnabled?: boolean;
  historyRecencyWindow?: number;
  historyTurnSummaryPrompt?: string;
  showReasoning?: boolean;
  historyAutoSummarizeLimit?: number;
  queryExpansionEnabled?: boolean;
  toolResultCacheTtlMs?: number;
  sessionTokenBudget?: number;
  /** Whether classification stage runs. Default: true. */
  classificationEnabled?: boolean;
  /** LLM call strategy for tool-loop. 'streaming' (default) | 'non-streaming' | 'fallback'. */
  llmCallStrategy?: 'streaming' | 'non-streaming' | 'fallback';
  /** Tool-selection strategy over RAG results. Default: top-k. */
  toolSelection?: { strategy: string; minScore?: number };
}

export interface SmartServerPromptsConfig {
  system?: string;
  classifier?: string;
  reasoning?: string;
  ragTranslate?: string;
  historySummary?: string;
}

export interface SmartServerSkillsConfig {
  /** Manager type: 'claude' | 'codex' | 'filesystem'. Default: 'claude'. */
  type?: 'claude' | 'codex' | 'filesystem';
  /** Custom directories (filesystem type only). */
  dirs?: string[];
  /** Project root for relative skill dirs (claude/codex types). Defaults to cwd. */
  projectRoot?: string;
}

export type SmartServerMode = 'hard' | 'pass' | 'smart';

export interface SmartServerCircuitBreakerConfig {
  /** Number of consecutive failures before opening. Default: 5 */
  failureThreshold?: number;
  /** Time (ms) to wait before probing again. Default: 30 000 */
  recoveryWindowMs?: number;
}

export interface SmartServerConfig {
  port?: number;
  host?: string;
  llm?: SmartServerLlmConfig | Record<string, SmartServerLlmConfig>;
  rag?: SmartServerRagConfig;
  mcp?: SmartServerMcpConfig | SmartServerMcpConfig[];
  agent?: SmartServerAgentConfig;
  prompts?: SmartServerPromptsConfig;
  mode?: SmartServerMode;
  /**
   * Pipeline selection: which pipeline plugin runs the agent, plus its
   * plugin-specific config dialect (validated by the plugin's `parseConfig`).
   * Built-in names: `flat` | `linear` | `dag` | `stepper`. Plugins may register
   * additional names. When omitted, defaults to `flat`.
   *
   * NOTE: this REPLACES the legacy `pipeline:` block (mcp/rag/stages/llm
   * overrides). Top-level `mcp:`, `rag:`, and `llm:` now own those concerns.
   */
  pipeline?: { name: string; config?: Record<string, unknown> };
  log?: (event: Record<string, unknown>) => void;
  logDir?: string;
  circuitBreaker?: SmartServerCircuitBreakerConfig;
  version?: string;
  /** Path to YAML config file for hot-reload. */
  configFile?: string;
  /** Additional plugin directory (merged with defaults). Used by the default FileSystemPluginLoader. */
  pluginDir?: string;
  /**
   * Explicit plugin module specifiers (npm package names or paths) to
   * dynamically import. Their full {@link PluginExports} (pipelinePlugins,
   * embedderFactories, mcpClients, …) are merged before RAG/embedder build.
   * Relative paths resolve against the user's cwd; bare specifiers via
   * `require.resolve` from cwd.
   */
  plugins?: string[];
  /** Custom plugin loader. When set, replaces the default FileSystemPluginLoader. */
  pluginLoader?: IPluginLoader;
  /** Pre-built embedder injected via DI. Takes precedence over config-driven selection. */
  embedder?: IEmbedder;
  /** Named embedder factories for YAML-driven selection (merged with built-ins). */
  embedderFactories?: Record<string, EmbedderFactory>;
  /**
   * Skill discovery configuration from YAML.
   *
   * `type`: Manager variant — `'claude'` | `'codex'` | `'filesystem'`.
   * `dirs`: Custom directories (filesystem type only).
   * `projectRoot`: Project root for relative skill dirs (claude/codex types).
   *
   * When omitted and no `skillManager` is injected, skills are disabled.
   */
  skills?: SmartServerSkillsConfig;
  /** Pre-built skill manager injected via DI. Takes precedence over `skills` config. */
  skillManager?: ISkillManager;
  /**
   * Skill PLUGIN-HOST config (the `skillPlugins:` YAML key) — a SEPARATE feature
   * from `skills:` above. It feeds consumer-supplied domain skills to the agnostic
   * engine through a grouped skills-RAG (gnostification). When omitted, no host is
   * built and behaviour is unchanged. See {@link SkillPluginsConfig}.
   */
  skillPlugins?: SkillPluginsConfig;
  /** Pre-built MCP clients injected via DI. Takes precedence over `mcp` config. */
  mcpClients?: IMcpClient[];
  /** Client adapters for auto-detecting prompt-based clients (e.g. Cline). */
  clientAdapters?: IClientAdapter[];
  /** Whether to include usage stats in SSE stream. Default: true. */
  reportUsage?: boolean;
  /** API protocol adapters injected via DI. Merged with built-in adapters (openai, anthropic). */
  apiAdapters?: ILlmApiAdapter[];
  /** Disable built-in adapter auto-registration. Default: false. */
  disableBuiltInAdapters?: boolean;
  /** Skip startup model validation (useful for testing). Default: false. */
  skipModelValidation?: boolean;
  /** Model resolver for PUT /v1/config model changes. When not set, model updates are rejected with 400. */
  modelResolver?: IModelResolver;
  /**
   * Nested sub-agents loaded from a top-level `subagents:` YAML block.
   * Each entry is built into a `SmartAgentSubAgent` and registered via
   * `SmartAgentBuilder.withSubAgents(...)`.
   */
  subAgentConfigs?: SmartServerSubAgentConfig[];
  /**
   * Per-session lifecycle tuning. Defaults: idleTtlMs=7_200_000 (2h),
   * maxSessions=1000, cookieName='sid'.
   */
  session?: {
    idleTtlMs?: number;
    maxSessions?: number;
    cookieName?: string;
  };
}

/**
 * DI seam for SmartServer's LLM / embedder / skill-host / MCP construction.
 * Every member is optional and defaults to the real implementation, so omitting
 * `deps` (or passing `{}`) preserves the original behaviour exactly. Used by
 * tests (and a future no-listen `buildAgent()`) to substitute canned
 * implementations without network or port I/O.
 */
export interface BuildAgentDeps {
  makeLlm?: (cfg: SmartServerLlmConfig) => Promise<ILlm>;
  resolveEmbedder?: (
    cfg: EmbedderResolutionConfig,
    options?: EmbedderResolutionOptions,
  ) => IEmbedder;
  prefetchEmbedderFactories?: typeof prefetchEmbedderFactories;
  buildSkillHost?: (
    cfg: SkillPluginsConfig,
    deps: BuildSkillHostDeps,
  ) => Promise<ISkillPluginHost>;
  skillHost?: ISkillPluginHost;
  connectMcp?: (
    mcpCfg: SmartServerMcpConfig | SmartServerMcpConfig[] | undefined | null,
  ) => Promise<IMcpClient[]>;
  /** Injected embedder — short-circuits BOTH resolveAgentEmbedder (diEmbedder) AND
   *  the skill-host embedder resolution + prefetch. */
  embedder?: IEmbedder;
}

/**
 * A nested sub-agent declared via the top-level `subagents:` YAML block.
 * The `config` field is the resolved `SmartServerConfig` for the sub-agent
 * (without `subagents:` of its own — nested orchestration is not supported).
 */
export interface SmartServerSubAgentConfig {
  name: string;
  /**
   * Human-readable capability description. Surfaced to the Coordinator's
   * planner LLM so it can pick the right subagent per step. Optional, but
   * highly recommended — without it the planner sees `(no description)` and
   * routes by name alone.
   */
  description?: string;
  config: Omit<SmartServerConfig, 'log'>;
}

export interface SmartServerHandle {
  port: number;
  close(): Promise<void>;
  requestLogger: IRequestLogger;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapStopReason(r: StopReason): 'stop' | 'length' | 'tool_calls' {
  if (r === 'stop') return 'stop';
  if (r === 'tool_calls') return 'tool_calls';
  return 'length';
}

function jsonError(message: string, type: string, code?: string): string {
  return JSON.stringify({
    error: { message, type, ...(code ? { code } : {}) },
  });
}

function jsonValidationError(
  message: string,
  code: ExternalToolValidationCode,
  param: string,
): string {
  return JSON.stringify({
    error: {
      message,
      type: 'invalid_request_error',
      code,
      param,
    },
  });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function resolveSkillManager(
  cfg?: SmartServerSkillsConfig,
): ISkillManager | undefined {
  if (!cfg) return undefined;
  const type = cfg.type ?? 'claude';
  const root = cfg.projectRoot ?? process.cwd();
  switch (type) {
    case 'claude':
      return new ClaudeSkillManager(root);
    case 'codex':
      return new CodexSkillManager(root);
    case 'filesystem':
      return new FileSystemSkillManager(cfg.dirs ?? []);
    default:
      return undefined;
  }
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// ---------------------------------------------------------------------------
// SmartServer
// ---------------------------------------------------------------------------

import { ControllerPipelinePlugin } from '../pipelines/controller.js';
import { DagPipelinePlugin } from '../pipelines/dag.js';
import { FlatPipelinePlugin } from '../pipelines/flat.js';
import { LinearPipelinePlugin } from '../pipelines/linear.js';
import {
  createServerPipelineContext,
  type IServerPipelineContext,
} from '../pipelines/server-context.js';
import { StepperPipelinePlugin } from '../pipelines/stepper.js';
import type { NormalizedLlmMap } from './config.js';
import {
  normalizeLlmConfig,
  resolveLlmConfig,
  resolveLlmConfigStrict,
  resolveToolSelectionStrategy,
} from './config.js';
import { makeKnowledgeSemanticIndex } from './embedder-knowledge-index.js';
import { JsonlKnowledgeBackend } from './jsonl-knowledge-backend.js';
import { makePgPool, makePgReadPool } from './pg-pool.js';
import type {
  ISessionMetaStore,
  SessionMetaRow,
} from './session-meta-store.js';
import { InMemorySessionMetaStore } from './session-meta-store.js';
import type { SkillPluginsConfig } from './skill-plugins-config.js';
import type { BuildSkillHostDeps } from './skill-plugins-host-factory.js';
import {
  buildSkillHostFromConfig,
  initSkillHost,
} from './skill-plugins-host-factory.js';

export {
  generateConfigTemplate,
  loadYamlConfig,
  type ResolveConfigArgs,
  resolveCoordinatorActivation,
  resolveCoordinatorDispatch,
  resolveCoordinatorPlanning,
  resolveEnvVars,
  resolveSmartServerConfig,
  resolveToolSelectionStrategy,
  YAML_TEMPLATE,
  type YamlConfig,
} from './config.js';
export { makePgPool, makePgReadPool } from './pg-pool.js';
export {
  parseSkillPluginsConfig,
  type SkillPluginsCatalogConfig,
  type SkillPluginsConfig,
  type SkillPluginsFetchedSource,
  type SkillPluginsRecordsSource,
  type SkillPluginsSource,
  type SkillPluginsStoreConfig,
} from './skill-plugins-config.js';
export {
  type BuildSkillHostDeps,
  buildSkillHostFromConfig,
  type IClosablePool,
  initSkillHost,
  validateServedGroups,
} from './skill-plugins-host-factory.js';

// ---------------------------------------------------------------------------
// Worker-LLM cache + RAG-registry sharing (Task A7)
// ---------------------------------------------------------------------------

/**
 * GLOBAL per-worker heavy clients — built once, injected by reference per
 * session. In addition to LLM/embedder clients, the worker's OWN declared
 * `toolsRag`/`historyRag`/`mcpClients` (if any) are cached here too — the
 * per-session re-wire MUST prefer the worker's own resources over the
 * parent's injected ones, so we build them once and reuse by reference.
 */
export interface WorkerLlmSet {
  mainLlm: ILlm;
  classifierLlm: ILlm;
  helperLlm?: ILlm;
  embedder?: IEmbedder;
  /** Worker's OWN tools RAG, built from `subCfg.rag` if declared. */
  toolsRag?: IRag;
  /** Worker's OWN history RAG (mirrors flat-rag block, separate instance). */
  historyRag?: IRag;
  /**
   * Worker's OWN MCP clients (from `subCfg.mcpClients` DI or built once from
   * `subCfg.mcp`). Undefined means the worker did not declare any — caller
   * may fall back to the parent's injected clients.
   */
  mcpClients?: IMcpClient[];
  /**
   * Shutdown function returned by the builder's `SmartAgentHandle.close()`
   * for this worker (Fix #21). Disconnects MCP clients (and any other
   * builder-owned resources) registered to this worker. Captured by
   * `backfillWorkerCacheFromHandle` so `_drainWorkerCache()` can call it on
   * config-reload (PUT /v1/config + hot-reload) and on server shutdown —
   * without this, the per-worker handle is discarded by `buildSubAgent` and
   * lazy rebuilds (Fix #18) accumulate MCP connections with no close path.
   */
  close?: () => Promise<void>;
}

/**
 * Drain every cached worker's `close` (if any), then clear the cache map.
 * Used by config-reload (PUT /v1/config + hot-reload — Fix #14/18/21) and by
 * server `close()` to release per-worker MCP connections that were attached
 * to the discarded `SmartAgentHandle`s.
 *
 * IMPORTANT — in-flight caveat: this aborts any request that is mid-call on
 * a worker's MCP client. That is acceptable for an admin action (config
 * reload, server shutdown) where the alternative is leaking connections.
 * Server `close()` calls this AFTER `lifecycle.disposeAll()` so per-session
 * graphs that reference worker clients are torn down first.
 *
 * Uses `Promise.allSettled` so one failing close cannot block the others.
 */
export async function drainWorkerCache(
  cache: Map<string, WorkerLlmSet>,
): Promise<void> {
  const closers: Array<Promise<void>> = [];
  for (const entry of cache.values()) {
    if (entry.close) {
      try {
        closers.push(entry.close());
      } catch {
        // sync throw (defensive — close is async by contract)
      }
    }
  }
  cache.clear();
  if (closers.length > 0) {
    await Promise.allSettled(closers);
  }
}

/**
 * Build-once-per-worker resolver. The first time a worker name is seen, it
 * constructs the worker's main/classifier/(optional helper) LLM + embedder and
 * caches the set; every later call (e.g. each per-session worker re-wire)
 * returns the SAME set by reference — never reconstructing LLM clients
 * (locked invariant: LLM/embedder clients are global, built once).
 *
 * Accepts optional `makeToolsRag`/`makeHistoryRag`/`makeMcpClients` factories;
 * when provided, the resolver builds them ONCE on the first miss and caches
 * them on the returned set. Subsequent calls return the cached resources by
 * reference — never re-vectorizing or re-connecting MCP.
 */
export async function resolveWorkerLlmSet(input: {
  name: string;
  cache: Map<string, WorkerLlmSet>;
  makeMain: () => Promise<ILlm>;
  makeClassifier: () => Promise<ILlm>;
  makeHelper?: () => Promise<ILlm>;
  makeEmbedder?: () => Promise<IEmbedder>;
  makeToolsRag?: () => Promise<IRag>;
  makeHistoryRag?: () => Promise<IRag>;
  makeMcpClients?: () => Promise<IMcpClient[]>;
}): Promise<WorkerLlmSet> {
  const hit = input.cache.get(input.name);
  if (hit) return hit;
  const mainLlm = await input.makeMain();
  const classifierLlm = await input.makeClassifier();
  const helperLlm = input.makeHelper ? await input.makeHelper() : undefined;
  const embedder = input.makeEmbedder ? await input.makeEmbedder() : undefined;
  const toolsRag = input.makeToolsRag ? await input.makeToolsRag() : undefined;
  const historyRag = input.makeHistoryRag
    ? await input.makeHistoryRag()
    : undefined;
  const mcpClients = input.makeMcpClients
    ? await input.makeMcpClients()
    : undefined;
  const set: WorkerLlmSet = {
    mainLlm,
    classifierLlm,
    helperLlm,
    embedder,
    toolsRag,
    historyRag,
    mcpClients,
  };
  input.cache.set(input.name, set);
  return set;
}

/**
 * Backfill the per-worker cache entry from the BUILT handle (review HIGH #7).
 *
 * The primary `buildSubAgent` populates `cached.mcpClients`/`toolsRag`/
 * `historyRag` only when the worker config provided DI factories. Workers
 * configured with `subCfg.mcp: ...` (regular config that triggers the
 * builder's own auto-connect) or with `subCfg.rag: ...` whose RAG is owned
 * by the builder leave those slots empty — so per-session re-wires would
 * fall back to the PARENT's MCP/RAG, losing the worker's own connection.
 *
 * After the builder finishes, this helper captures what the handle actually
 * holds and stores it BY REFERENCE on the cache entry. Subsequent per-session
 * re-wires read the same slots and find the worker's own resources.
 *
 * Pure helper, mutates `entry` in place. No-op when the corresponding slot
 * is already populated (DI path wins) or when the handle has no resource for
 * that slot (worker simply didn't declare one).
 */
export async function backfillWorkerCacheFromHandle(
  entry: WorkerLlmSet,
  handle: {
    mcpClients?: IMcpClient[];
    ragRegistry: { get(name: string): IRag | undefined };
    close?: () => Promise<void>;
  },
): Promise<void> {
  if (
    (!entry.mcpClients || entry.mcpClients.length === 0) &&
    handle.mcpClients &&
    handle.mcpClients.length > 0
  ) {
    entry.mcpClients = handle.mcpClients;
  }
  if (!entry.toolsRag) {
    const t = handle.ragRegistry.get('tools');
    if (t) entry.toolsRag = t;
  }
  if (!entry.historyRag) {
    const h = handle.ragRegistry.get('history');
    if (h) entry.historyRag = h;
  }
  // Capture the per-worker shutdown function (Fix #21). If the entry already
  // had a close from a previous build (e.g. the same worker name was rebuilt
  // WITHOUT going through `drainWorkerCache` first — defence in depth), await
  // the prior close before overwriting so its MCP connections do not leak.
  if (handle.close) {
    if (entry.close) {
      try {
        await entry.close();
      } catch {
        // Best-effort; never block the new build on a stale close failure.
      }
    }
    entry.close = handle.close;
  }
}

/**
 * Share the parent RAG registry with subagents (per-session worker re-wire).
 * Session/user/global collections written at the top level become visible to
 * workers; the per-call scope filter (`rag-query.ts`) isolates by
 * `ctx.sessionId` / `ctx.options.userId`. A worker's own declared store is
 * registered INTO this same registry under its namespace. When the parent
 * registry is undefined (no top-level registry yet — e.g. unit test seam),
 * return undefined so the builder allocates its own SimpleRagRegistry.
 */
export function resolveSubAgentRagRegistry(input: {
  parentRagRegistry: IRagRegistry | undefined;
}): IRagRegistry | undefined {
  return input.parentRagRegistry;
}

/**
 * Options for `buildSessionLifecycle`. Composes the SessionGraphFactory + the
 * SessionRegistry; exposes a thin facade so `_handle` stays unit-testable.
 */
export interface SessionLifecycleOptions {
  idleTtlMs: number;
  maxSessions: number;
  cookieName: string;
  mcpClients: IMcpClient[];
  toolsRag: IRag | undefined;
  ragRegistry: IRagRegistry;
  buildAgent: (parts: SessionAgentParts) => Promise<SmartAgent | undefined>;
  /** Optional logger forwarded to SessionGraphFactory for cleanup-failure surfacing. */
  logger?: ILogger;
  /**
   * Optional per-session teardown hook run during `SessionGraph.dispose()`.
   * The host wires this to invoke the pipeline plugin's
   * `IPipelineInstance.close()` captured by `buildPipelineInstance`.
   */
  onDispose?: (sessionId: string) => Promise<void>;
}

/**
 * Composes the cookie identity resolver + SessionGraphFactory + SessionRegistry
 * into one lifecycle object the server's `_handle` consumes. The default MCP
 * factory returns the shared GLOBAL clients by reference (one upstream
 * connection); a creds-aware build swaps it out (out of scope here).
 */
export function buildSessionLifecycle(opts: SessionLifecycleOptions): {
  resolve: (
    cookieHeader: string | undefined,
    isHttps: boolean,
  ) => ReturnType<typeof resolveSessionIdentity>;
  acquire: (
    sessionId: string,
  ) => Promise<
    ReturnType<SessionRegistry['acquire']> extends Promise<infer G> ? G : never
  >;
  release: (sessionId: string, graph?: SessionGraph) => void;
  evictIdle: () => Promise<void>;
  disposeAll: () => Promise<void>;
  invalidateAll: () => Promise<void>;
  registry: SessionRegistry;
} {
  const factory = new SessionGraphFactory({
    mcpClientFactory: (_identity) => opts.mcpClients,
    toolsRag: opts.toolsRag,
    ragRegistry: opts.ragRegistry,
    buildAgent: opts.buildAgent,
    logger: opts.logger,
    onDispose: opts.onDispose,
  });
  const registry = new SessionRegistry({
    idleTtlMs: opts.idleTtlMs,
    maxSessions: opts.maxSessions,
    factory,
  });
  return {
    resolve: (cookieHeader, isHttps) =>
      resolveSessionIdentity({
        cookieHeader,
        cookieName: opts.cookieName,
        maxAgeSeconds: Math.max(1, Math.floor(opts.idleTtlMs / 1000)),
        isHttps,
      }),
    acquire: (sessionId) => registry.acquire(sessionId),
    release: (sessionId, graph) => registry.release(sessionId, graph),
    evictIdle: () => registry.evictIdle(),
    disposeAll: () => registry.disposeAll(),
    invalidateAll: () => registry.invalidateAll(),
    registry,
  };
}

export type SessionLifecycle = ReturnType<typeof buildSessionLifecycle>;

// ---------------------------------------------------------------------------
// /v1/sessions extracted handlers (testable without a live HTTP server)
// ---------------------------------------------------------------------------

/** Response shape for GET /v1/sessions */
export interface SessionListBody {
  sessions: SessionMetaRow[];
}

/** Response shape for POST /v1/sessions/:id/resume */
export interface SessionResumeBody {
  ok: boolean;
  session?: SessionMetaRow;
  error?: string;
}

/**
 * Seed session-scope guidance entries into a BRAND-NEW session's knowledge-RAG
 * (deployment-supplied tool-usage guidance the planner/executor read in "Known
 * facts"). Idempotent: rehydrates via init() and writes ONLY when the session is
 * empty (`fingerprint() === 'n=0'`), so resumes never duplicate. Entries are
 * config DATA — the runtime stays MCP-agnostic (no tool knowledge in agent code).
 */
export async function seedSessionKnowledge(
  kr: IKnowledgeRagHandle & {
    init?(): Promise<void>;
    fingerprint?(): string;
  },
  seeds: ReadonlyArray<{ content: string; artifactType: string }>,
  nowIso: string,
): Promise<void> {
  if (seeds.length === 0) return;
  await kr.init?.();
  if (kr.fingerprint?.() !== 'n=0') return; // not a brand-new session → skip
  for (const s of seeds) {
    await kr.write({
      content: s.content,
      metadata: {
        traceId: 'seed',
        turnId: 'seed',
        stepperId: 'seed',
        task: 'session-seed',
        artifactType: s.artifactType,
        createdAt: nowIso,
      },
    });
  }
}

/**
 * Record that a request for `sessionId` STARTED — create the meta row on first
 * sight, else touch it and mark in-progress. Called from the live request path
 * (`_withSession`) so GET /v1/sessions, resume and delete actually see sessions
 * produced by normal chat/stream traffic (review Finding 3). `userIdentity` is
 * the sessionId itself in the default no-auth build — matching how the
 * /v1/sessions endpoints resolve identity (`resolved.identity.sessionId`).
 */
export async function recordSessionStart(
  store: ISessionMetaStore,
  sessionId: string,
  nowIso: string,
): Promise<void> {
  const existing = await store.get(sessionId);
  if (!existing) {
    await store.create({
      sessionId,
      userIdentity: sessionId,
      createdAt: nowIso,
      lastUsedAt: nowIso,
      status: 'in-progress',
    });
    return;
  }
  await store.touch(sessionId, nowIso);
  await store.setStatus(sessionId, 'in-progress');
}

/**
 * Record that a request for `sessionId` FINISHED — touch + mark idle (so it can
 * be resumed). No-op if the row was deleted mid-flight.
 */
export async function recordSessionEnd(
  store: ISessionMetaStore,
  sessionId: string,
  nowIso: string,
): Promise<void> {
  const existing = await store.get(sessionId);
  if (!existing) return;
  await store.touch(sessionId, nowIso);
  await store.setStatus(sessionId, 'idle');
}

/**
 * List all sessions for a given user identity.
 * Extracted for unit-testability (mirrors the /v1/usage handler pattern).
 */
export async function handleListSessions(
  store: ISessionMetaStore,
  identity: string,
): Promise<SessionListBody> {
  const sessions = await store.listForUser(identity);
  return { sessions };
}

/**
 * Resume (claim) a session by ID for a user identity.
 * Sets the session status to 'idle' so it can be re-entered.
 */
export async function handleResumeSession(
  store: ISessionMetaStore,
  identity: string,
  id: string,
): Promise<SessionResumeBody> {
  const row = await store.get(id);
  if (!row || row.userIdentity !== identity) {
    return { ok: false, error: 'session not found' };
  }
  await store.setStatus(id, 'idle');
  const updated = await store.get(id);
  return { ok: true, session: updated };
}

/**
 * Delete a session by ID for a user identity, and evict its RAG state.
 */
export async function handleDeleteSession(
  store: ISessionMetaStore,
  identity: string,
  id: string,
  evictFn: (sessionId: string) => Promise<void>,
): Promise<{ ok: boolean; error?: string }> {
  const row = await store.get(id);
  if (!row || row.userIdentity !== identity) {
    return { ok: false, error: 'session not found' };
  }
  await store.delete(id);
  await evictFn(id);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// MCP bridge for the Stepper path (B-1)
// ---------------------------------------------------------------------------

/**
 * Build a `callMcp(name, args, signal?)` bridge over a list of `IMcpClient`s.
 *
 * Dispatch strategy (mirrors the 17.0 tool-loop):
 * - Iterate the clients; the first client whose `listTools()` contains `name` wins.
 * - On success: return the textual content (stringify structured payloads).
 * - On error: return the error message as a string so the LLM executor can
 *   feed the failure back to the model as a tool result (no throw).
 * - If no client owns the tool: return an informative "Tool not found" string.
 *
 * Exported for testability — tests can call this with a fake IMcpClient list.
 */
/**
 * Connect MCP clients from a YAML `mcp:` config block (single or array).
 *
 * Mirrors the builder's connection logic (builder.ts ~lines 897-920) so the
 * Stepper path gets the same clients that the builder would have connected
 * internally. Exported for testability.
 *
 * @param mcpCfg - single `SmartServerMcpConfig` or array thereof (from
 *   `pipeline.mcp` or `this.cfg.mcp`). Accepts the union so callers can pass
 *   either directly without pre-normalising.
 */

export async function connectMcpClientsFromConfig(
  mcpCfg: SmartServerMcpConfig | SmartServerMcpConfig[] | undefined | null,
): Promise<IMcpClient[]> {
  if (!mcpCfg) return [];
  const list = Array.isArray(mcpCfg) ? mcpCfg : [mcpCfg];
  const connected: IMcpClient[] = [];
  for (const cfg of list) {
    let wrapper: MCPClientWrapper;
    if (cfg.type === 'stdio') {
      wrapper = new MCPClientWrapper({
        transport: 'stdio',
        command: cfg.command,
        args: cfg.args ?? [],
      });
    } else {
      wrapper = new MCPClientWrapper({
        transport: 'auto',
        url: cfg.url,
        headers: cfg.headers,
      });
    }
    await wrapper.connect();
    connected.push(new McpClientAdapter(wrapper));
  }
  return connected;
}

export function buildMcpBridge(
  clients: IMcpClient[],
): (name: string, args: unknown, signal?: AbortSignal) => Promise<string> {
  return async (name: string, args: unknown, _signal?: AbortSignal) => {
    const safeArgs =
      args != null && typeof args === 'object' && !Array.isArray(args)
        ? (args as Record<string, unknown>)
        : {};
    for (const client of clients) {
      const listed = await client.listTools();
      if (!listed.ok) continue;
      const owns = listed.value.some((t) => t.name === name);
      if (!owns) continue;
      const result = await client.callTool(name, safeArgs);
      if (!result.ok) {
        return result.error.message;
      }
      const { content } = result.value;
      return typeof content === 'string' ? content : JSON.stringify(content);
    }
    return `Tool not found: ${name}`;
  };
}

export class SmartServer {
  private readonly cfg: SmartServerConfig;
  private readonly noop = () => {};
  /**
   * GLOBAL per-worker LLM/embedder cache. Populated lazily by `buildSubAgent`
   * the first time each worker name is seen; subsequent per-session re-wires
   * pull from this cache by reference (never reconstructing LLM clients).
   */
  private readonly _workerLlmCache = new Map<string, WorkerLlmSet>();
  /** Lifecycle handle wired in `start()`; consumed by `_handle`. */
  private _lifecycle?: SessionLifecycle;
  /** Hoisted globals used by `buildSessionAgent` to re-wire fresh per-session workers. */
  private _mainLlm?: ILlm;
  private _classifierLlm?: ILlm;
  private _helperLlm?: ILlm;
  private _fileLogger?: ILogger;
  private _mergedEmbedderFactories?: Record<string, EmbedderFactory>;
  /**
   * The embedder resolved ONCE in `start()` (`resolveAgentEmbedder` over
   * `rag.embedder` / `embedder` config). Held so `buildServerCtx` can hand it to
   * every pipeline context (the controller pipeline needs it for target-state
   * semantic distance). Undefined when no embedder is configured.
   */
  private _resolvedEmbedder?: IEmbedder;
  /**
   * The live skill plugin-host, built ONCE in `start()` from `skillPlugins:`
   * config and `await host.load()`-ed before serving. Held so `buildServerCtx`
   * can thread it onto every pipeline context. Undefined when `skillPlugins:` is
   * absent (everything unchanged).
   */
  private _skillHost?: ISkillPluginHost;
  /**
   * pg pools created for the skill plugin-host's `postgres` catalog. Captured at
   * build time so the server can close their real sockets on shutdown (a closer
   * is registered in `closeFns`); otherwise live PG sockets outlive `close()`.
   */
  private _skillPgPools: Array<{ end(): Promise<void> }> = [];
  /** Normalized LLM map + pipeline fallback + main temperature — captured in
   *  `start()` so buildServerCtx can hand the raw role-LLM materials to the
   *  context factory (mirrors the inline DAG/linear resolution). */
  private _llmMap?: NormalizedLlmMap;
  private _pipelineFallback?: SmartServerLlmConfig;
  private _mainTemp?: number;
  private _requestLogger?: IRequestLogger;
  /** ToolsRag handle built by `buildSharedPipelineInfra`; handed to every
   *  pipeline's context (factory defaults to EMPTY_TOOLS_RAG if unset). */
  private _toolsRagHandle?: IToolsRagHandle;
  /**
   * The tools-RAG `IRag` (the store the builder vectorizes MCP `tool:<name>`
   * docs into) captured in `start()`. Held so the `flat`/`smart` pipeline's
   * `ToolSelectHandler` can select MCP tools from RAG hits — and so tests can
   * assert the YAML-path vectorization landed. Distinct from `_toolsRagHandle`
   * (the stepper catalog handle), which falls back to catalog order regardless.
   */
  private _toolsRag?: IRag;
  /**
   * MCP clients connected for the Stepper path from the YAML `mcp:` config
   * block. These are connected ONCE in `start()` (lazily resolved by
   * `connectMcpClientsFromConfig`) and reused across every Stepper request.
   *
   * Populated only when `this.cfg.mcp` / `pipeline.mcp` is set AND no
   * DI/plugin clients exist (DI precedence: `this.cfg.mcpClients` > plugin >
   * yaml). Disposed via the server's `closeFns` on shutdown.
   */
  private _stepperMcpClients?: IMcpClient[];
  /**
   * The MCP clients the pipeline `callMcp` bridge dispatches over — resolved
   * UNCONDITIONALLY in `start()` as DI/plugin clients (`mcpClients`) ?? the
   * YAML-connected `_stepperMcpClients`. Held so every pipeline (not just the
   * stepper) gets a working `ctx.callMcp` without opening a second connection.
   */
  private _sharedMcpClients?: IMcpClient[];
  /**
   * The ONE shared knowledge backend for the Stepper path (set during build).
   * Held so DELETE /v1/sessions/:id can evict a session's entries from it —
   * critical for the long-lived in-memory backend, which would otherwise retain
   * knowledge after a delete and rehydrate it on a same-id re-entry.
   */
  private _stepperKnowledgeBackend?: KnowledgeBackend;
  /**
   * Session meta-store for /v1/sessions endpoints (Task 17).
   * Defaults to InMemorySessionMetaStore; a durable store can be injected via
   * `cfg.sessionMetaStore` in a future extension.
   */
  private readonly _sessionMetaStore: ISessionMetaStore =
    new InMemorySessionMetaStore();
  /**
   * Pipeline-plugin registry, populated in `start()` after plugins load: the 4
   * built-ins (flat/linear/dag/stepper) plus any `plugins.pipelinePlugins`,
   * fail-fast on name collision. `buildPipelineInstance` selects by
   * `cfg.pipeline.name` (default 'flat').
   */
  private _pipelineRegistry!: Map<string, IPipelinePlugin>;
  /**
   * Per-session `IPipelineInstance.close()` hooks, keyed by sessionId. Populated
   * by `buildPipelineInstance` (via `buildSessionAgent`) and invoked from the
   * session lifecycle `onDispose` so per-session pipeline resources (MCP / builder
   * handles owned by the plugin) are freed on eviction / shutdown / reconfigure.
   */
  private readonly _sessionCloseFns = new Map<string, () => Promise<void>>();

  /**
   * Defaulted construction deps (the BuildAgentDeps DI seam). Required members
   * always resolve to the real implementation when not injected; `skillHost`
   * and `embedder` stay optional (present only when injected).
   */
  private readonly _deps: Required<
    Pick<
      BuildAgentDeps,
      | 'makeLlm'
      | 'resolveEmbedder'
      | 'prefetchEmbedderFactories'
      | 'buildSkillHost'
      | 'connectMcp'
    >
  > &
    Pick<BuildAgentDeps, 'skillHost' | 'embedder'>;

  constructor(config: SmartServerConfig, deps: BuildAgentDeps = {}) {
    this.cfg = config;
    this._deps = {
      makeLlm: deps.makeLlm ?? ((cfg) => this._makeLlmDefault(cfg)),
      resolveEmbedder: deps.resolveEmbedder ?? resolveEmbedder,
      prefetchEmbedderFactories:
        deps.prefetchEmbedderFactories ?? prefetchEmbedderFactories,
      buildSkillHost: deps.buildSkillHost ?? buildSkillHostFromConfig,
      connectMcp: deps.connectMcp ?? connectMcpClientsFromConfig,
      ...(deps.skillHost ? { skillHost: deps.skillHost } : {}),
      ...(deps.embedder ? { embedder: deps.embedder } : {}),
    };
  }

  async start(): Promise<SmartServerHandle> {
    // Startup pg-pool cleanup must span the ENTIRE start(): host.load() (via
    // initSkillHost) creates pg pools, but fallible work AFTER it — makeRag,
    // builder.build(), server.listen — can still throw/reject before the handle
    // is returned and `closeFns` becomes callable. Without this guard those
    // pools would leak open sockets and block process exit. initSkillHost keeps
    // its own catch-cleanup (it clears the array, so this finally then no-ops —
    // no double-end; pool end() is idempotent regardless). No-op when
    // skillPlugins is unconfigured (_skillPgPools stays empty).
    let started = false;
    try {
      // Single success path: the handle is only produced once server.listen
      // succeeds (a listen error rejects this promise → finally cleans up).
      const handle = await this._start();
      started = true;
      return handle;
    } finally {
      if (!started) {
        await Promise.allSettled(this._skillPgPools.map((p) => p.end()));
        this._skillPgPools = [];
      }
    }
  }

  private async _start(): Promise<SmartServerHandle> {
    const log = this.cfg.log ?? this.noop;
    const fileLogger: ILogger = {
      log: (e) => log(e as unknown as Record<string, unknown>),
    };
    this._fileLogger = fileLogger;

    // ---- Composition root: resolve config → interfaces --------------------

    // LLM resolution — normalize the flat/map top-level `llm:` block. The legacy
    // per-pipeline `pipeline.llm.*` override is gone; role LLMs derive entirely
    // from the top-level map (resolveLlmConfig falls back to map.main), so the
    // pipelineFallback chain is no longer fed a separate config — it stays
    // undefined and the map.main fallback in resolveLlmConfig covers it.
    const llmMap = normalizeLlmConfig(this.cfg.llm);
    const pipelineFallback: SmartServerLlmConfig | undefined = undefined;

    const topMain = resolveLlmConfig(llmMap, 'main', pipelineFallback);

    const mainTemp = Number(topMain?.temperature ?? 0.7);
    const mainLlm = topMain
      ? await this._deps.makeLlm({ ...topMain, temperature: mainTemp })
      : (() => {
          throw new Error('no LLM configured: provide top-level llm.main');
        })();

    const classifierTemp = Number(topMain?.classifierTemperature ?? 0.1);
    const classifierLlm = topMain
      ? await this._deps.makeLlm({ ...topMain, temperature: classifierTemp })
      : (() => {
          throw new Error('no LLM configured: provide top-level llm.main');
        })();

    // A 'helper' role LLM derives from the top-level `llm:` map when present
    // (built only when an explicit map entry exists).
    const helperCfg = resolveLlmConfigStrict(llmMap, 'helper');
    const helperLlm = helperCfg
      ? await this._deps.makeLlm({
          ...helperCfg,
          temperature: Number(helperCfg.temperature ?? 0.1),
        })
      : undefined;
    this._mainLlm = mainLlm;
    this._classifierLlm = classifierLlm;
    this._helperLlm = helperLlm;
    this._llmMap = llmMap;
    this._pipelineFallback = pipelineFallback;
    this._mainTemp = mainTemp;

    // ---- Plugin loader -------------------------------------------------------
    const pluginLoader: IPluginLoader =
      this.cfg.pluginLoader ??
      (() => {
        const dirs = getDefaultPluginDirs();
        if (this.cfg.pluginDir) dirs.push(this.cfg.pluginDir);
        return new FileSystemPluginLoader({
          dirs,
          log: (msg) => log({ event: 'plugin_loader', message: msg }),
        });
      })();

    // Pre-load to extract embedder factories (needed before RAG resolution)
    const plugins = await pluginLoader.load();
    if (plugins.loadedFiles.length > 0) {
      log({
        event: 'plugins_loaded',
        files: plugins.loadedFiles,
        stageHandlers: [...plugins.stageHandlers.keys()],
        embedderFactories: Object.keys(plugins.embedderFactories),
        hasReranker: !!plugins.reranker,
        hasQueryExpander: !!plugins.queryExpander,
        hasOutputValidator: !!plugins.outputValidator,
        mcpClients: plugins.mcpClients.length,
      });
    }
    if (plugins.errors.length > 0) {
      log({ event: 'plugin_errors', errors: plugins.errors });
    }

    // ---- Explicit plugin specifiers (`plugins: [...]`) -------------------
    // Dynamically import each module specifier and merge its FULL
    // PluginExports (pipelinePlugins, embedderFactories, mcpClients, …) into
    // the same LoadedPlugins object. Done BEFORE the embedder/RAG build below
    // so plugin-supplied embedder factories are visible.
    const requireFromCwd = createRequire(`${process.cwd()}/`);
    for (const spec of this.cfg.plugins ?? []) {
      // Resolve to an ABSOLUTE path against the USER's cwd, then import via
      // a file URL. A bare `await import('./x.js')` would resolve relative to
      // smart-server.js, not the user's cwd.
      const abs = spec.startsWith('.')
        ? pathResolve(process.cwd(), spec)
        : spec.startsWith('/')
          ? spec
          : requireFromCwd.resolve(spec);
      const mod = (await import(pathToFileURL(abs).href)) as PluginExports;
      const registered = mergePluginExports(plugins, mod, spec);
      log({ event: 'plugin_specifier_loaded', spec, registered });
    }

    // ---- Pipeline-plugin registry (sub-goal C) ---------------------------
    // The 4 built-ins are STATIC; plugin-supplied pipelines are merged on top.
    // Fail-fast on a name collision so a plugin cannot silently shadow a
    // built-in (or another plugin). `buildPipelineInstance` selects by
    // `cfg.pipeline.name` (default 'flat') at session-build time.
    const pipelineRegistry = new Map<string, IPipelinePlugin>();
    for (const builtin of [
      new FlatPipelinePlugin(),
      new LinearPipelinePlugin(),
      new DagPipelinePlugin(),
      new StepperPipelinePlugin(),
      new ControllerPipelinePlugin('controller', 'smart-executor'),
      new ControllerPipelinePlugin('controller-weak', 'weak-executor'),
    ]) {
      pipelineRegistry.set(builtin.name, builtin);
    }
    for (const [name, plugin] of plugins.pipelinePlugins) {
      if (pipelineRegistry.has(name)) {
        throw new Error(
          `pipeline plugin name collision: '${name}' is already registered ` +
            '(built-in or another plugin)',
        );
      }
      pipelineRegistry.set(name, plugin);
    }
    this._pipelineRegistry = pipelineRegistry;
    log({
      event: 'pipeline_registry_loaded',
      pipelines: [...pipelineRegistry.keys()],
    });

    // Merge plugin embedder factories with config-provided ones
    const mergedEmbedderFactories = {
      ...plugins.embedderFactories,
      ...this.cfg.embedderFactories, // config takes precedence over plugins
    };
    this._mergedEmbedderFactories = mergedEmbedderFactories;

    // Resolve the embedder ONCE so the same instance feeds both makeRag and the
    // subagent context-builder's toolSource (#137). See resolve-agent-embedder.
    const resolvedEmbedder = await resolveAgentEmbedder(
      this.cfg.rag,
      this._deps.embedder ?? this.cfg.embedder,
      mergedEmbedderFactories,
    );
    // Hold the resolved embedder so buildServerCtx can thread it onto every
    // pipeline context (the controller pipeline needs it for target-state).
    this._resolvedEmbedder = resolvedEmbedder;

    // ---- Skill plugin-host (the `skillPlugins:` feature) ------------------
    // Build the host ONCE from config and `load()` it before serving, so its
    // fixed serving collection set is established at startup. Reuses the SAME
    // embedder-resolution path as the agent RAG (prefetch + resolveEmbedder from
    // llm-agent-rag). Absent `skillPlugins:` → no host, behaviour unchanged.
    if (this.cfg.skillPlugins) {
      const skillCfg = this.cfg.skillPlugins;
      // An injected embedder short-circuits ALL embedder I/O for the skill host
      // (no dedicated build, no prefetch) — the seam owns the embedder.
      const injectedEmbedder = this._deps.embedder;
      const reuseAgentEmbedder =
        injectedEmbedder !== undefined ||
        (skillCfg.embedder === undefined && resolvedEmbedder !== undefined);
      // Prefetch the named embedder factory only when we will actually build a
      // dedicated one (the agent embedder is already prefetched + wrapped).
      if (!reuseAgentEmbedder) {
        await this._deps.prefetchEmbedderFactories([
          skillCfg.embedder?.provider ?? 'ollama',
        ]);
      }
      // Build → load → validate as one fail-fast unit. If ANY step throws, the
      // captured pg pools are ended INSIDE initSkillHost (the later closeFns
      // cleanup never runs when start() rejects before returning a handle), so
      // the pools cannot leak open sockets on a startup failure.
      const buildHost = this._deps.skillHost
        ? async () => this._deps.skillHost as ISkillPluginHost
        : () =>
            this._deps.buildSkillHost(skillCfg, {
              resolveEmbedder: (ec) =>
                reuseAgentEmbedder
                  ? ((injectedEmbedder ?? resolvedEmbedder) as IEmbedder)
                  : this._deps.resolveEmbedder(ec, {
                      extraFactories: mergedEmbedderFactories,
                    }),
              // Real pg `Pool` provider for a `postgres` catalog (qdrant
              // deployment). Lazily imports `pg` and ensures the catalog table
              // exists on first use; pass the configured table so the DDL targets
              // the SAME table the catalog store reads/writes. Absent
              // skillPlugins.catalog.type:postgres this is never invoked.
              makePgPool: (connectionString) => {
                const pool = makePgPool(
                  connectionString,
                  skillCfg.catalog.type === 'postgres'
                    ? skillCfg.catalog.table
                    : undefined,
                );
                this._skillPgPools.push(pool);
                return pool;
              },
              // READ-ONLY pg pool for the recall-only path — NEVER runs DDL, so a
              // recall-only process with read-only pg credentials does not crash
              // attempting to CREATE the catalog table it only reads.
              makePgReadPool: (connectionString) => {
                const pool = makePgReadPool(connectionString);
                this._skillPgPools.push(pool);
                return pool;
              },
            });
      this._skillHost = await initSkillHost(
        buildHost,
        skillCfg,
        this._skillPgPools,
      );
    }

    // ---- RAG resolution (interface-only) ----------------------------------
    // Resolve the tools/history stores and any named collections HERE so the
    // coordinator gate below can read the final `toolsRag`/`resolvedEmbedder`,
    // then hand the ready stores to buildBaseBuilder for wiring.
    let toolsRag: IRag | undefined;
    let historyRag: IRag | undefined;
    const ragCollections: Array<{
      name: string;
      rag: IRag;
      meta: { displayName: string; scope: 'global' };
    }> = [];
    if (this.cfg.rag) {
      const ragOptions = {
        injectedEmbedder: resolvedEmbedder,
        extraFactories: mergedEmbedderFactories,
      };
      toolsRag = await makeRag(this.cfg.rag, ragOptions);
      historyRag = await makeRag({ ...this.cfg.rag }, ragOptions);
    }
    // Capture the tools store for the flat/smart pipeline's ToolSelectHandler
    // (and white-box vectorization assertions). See field doc.
    this._toolsRag = toolsRag;

    // NOTE: the legacy per-pipeline named-RAG multistore (`pipeline.rag.{name}`)
    // is GONE with the `pipeline: {name,config}` migration. The top-level `rag:`
    // block above is the single source of truth for the tools/history stores.
    // Deployments that previously declared `pipeline.rag.{name}` collections must
    // move them to top-level `rag:` (or register them as plugin RAG).

    // MCP clients (DI > plugin > YAML). The YAML `mcp:` block is NOT pre-connected
    // here — see the branch below.
    const diOrPluginMcpClients =
      this.cfg.mcpClients ??
      (plugins.mcpClients.length > 0 ? plugins.mcpClients : undefined);

    // ---- Knowledge backend (no MCP dependency) ----------------------------
    // The remaining shared pipeline infra (`_sharedMcpClients` + the
    // `_toolsRagHandle` MCP catalog) is MCP-client-dependent and is resolved
    // per-branch below — for the YAML-only path it must run AFTER `build()`
    // connects + vectorizes (the builder owns that single connection).
    this.buildKnowledgeBackend();

    // ---- MCP connection strategy (exactly ONE connection) -----------------
    // Two client sources, two orderings — both keep ONE MCP connection AND a
    // vectorized `toolsRag`:
    //
    //   • DI/plugin clients present → inject them into the startup builder via
    //     `withMcpClients` (builder.ts:923 short-circuits its own `cfg.mcp`
    //     auto-connect). These pre-built clients were never vectorized by the
    //     builder (unchanged behavior). `_sharedMcpClients` = that exact set,
    //     and the `_toolsRagHandle` catalog is built now over them.
    //
    //   • YAML-only (no DI/plugin) → do NOT pre-connect and do NOT inject. The
    //     startup builder receives `cfg.mcp` (via buildBaseBuilder, since
    //     `mcpClients` is undefined) so `build()` CONNECTS the YAML block AND
    //     VECTORIZES the tools into `toolsRag` (the `IRag`). AFTER `build()` we
    //     harvest its connected set into `_sharedMcpClients` so `ctx.callMcp`
    //     and per-session agents reuse the SAME single connection, then build
    //     the `_toolsRagHandle` catalog over them. (Restores the
    //     tool-vectorization the inject-skip regressed, with no double-connect.)
    // DI precedence semantics: an explicitly-provided client set (even an EMPTY
    // array) overrides YAML `mcp:`. `cfg.mcpClients: []` is a deliberate "disable
    // MCP / override plugin+YAML" signal — it must take the DI branch (inject `[]`
    // → builder short-circuits via withMcpClients([]) → no YAML auto-connect), NOT
    // fall through to the YAML branch. So gate on presence (`!== undefined`), not
    // length. (`diOrPluginMcpClients` is already undefined when neither DI nor a
    // non-empty plugin set was provided — see its resolution above.)
    const hasDiOrPlugin = diOrPluginMcpClients !== undefined;

    let mcpClients: IMcpClient[] | undefined;
    if (hasDiOrPlugin) {
      // DI/plugin branch — resolve `_sharedMcpClients` + tools-RAG handle NOW
      // (knowledge backend is idempotent; already built above).
      await this.buildSharedPipelineInfra({
        toolsRag,
        resolvedEmbedder,
        mcpClients: diOrPluginMcpClients,
      });
      mcpClients = diOrPluginMcpClients;
    } else {
      // YAML-only / no-mcp branch — let the builder connect + vectorize from
      // `cfg.mcp`; `_sharedMcpClients` + the tools-RAG handle are resolved from
      // the built handle AFTER `build()` (see below).
      mcpClients = undefined;
    }

    // Build SubAgentRegistry from `subagents:` YAML block (if present).
    // Each sub-agent is a minimal SmartAgent reusing the parent's plugin
    // outputs (embedder factories, plugins) but with its own LLM/RAG/MCP/etc.
    // Hoisted so the DAG branch below can reuse the same instances.
    const registry: SubAgentRegistry = new Map();
    if (this.cfg.subAgentConfigs && this.cfg.subAgentConfigs.length > 0) {
      for (const sub of this.cfg.subAgentConfigs) {
        const subAgent = await this.buildSubAgent(
          sub.name,
          sub.config,
          fileLogger,
          mergedEmbedderFactories,
        );
        registry.set(
          sub.name,
          new SmartAgentSubAgent(sub.name, subAgent, {
            description: sub.description,
          }),
        );
        log({
          event: 'subagent_built',
          name: sub.name,
          hasDescription:
            typeof sub.description === 'string' && sub.description.length > 0,
        });
      }
    }

    // ---- Build agent via Builder (interface-only) -------------------------
    // Assemble everything EXCEPT the coordinator via the shared base-builder
    // factory; the coordinator gate below wires the chosen variant.
    const builder = await this.buildBaseBuilder({
      mainLlm,
      classifierLlm,
      helperLlm,
      fileLogger,
      toolsRag,
      historyRag,
      ragCollections,
      mcpClients,
      plugins,
      workerRegistry: registry,
      applyServerExtras: true,
    });

    // ---- Startup global agent = INFRA + passthrough ONLY -------------------
    // No coordinator is wired here. The startup global agent exists purely for
    // infrastructure (/v1/models, /v1/embedding-models, HealthChecker), session
    // lifecycle, passthrough, and cleanup — its coordinator would never be
    // invoked because `_handleChat`/`_handleAdapterRequest` always dispatch to
    // the PER-SESSION agent (`graph.agent`, built by `buildSessionAgent` →
    // `buildPipelineInstance`); the startup agent is only the `?? smartAgent`
    // fallback when no session graph exists. The previous 3-way coordinator gate
    // (stepper / DAG / linear) was therefore dead on this path and is removed.
    // Real coordinated request-serving lives entirely in the session pipeline.
    // (Shared pipeline infra — knowledge backend, tools-RAG handle, MCP bridge —
    // was hoisted UNCONDITIONALLY above via buildSharedPipelineInfra so every
    // pipeline's buildServerCtx resolves its dep-sources.)

    const agentHandle = await builder.build();
    const {
      agent: smartAgent,
      chat,
      streamChat,
      close: closeAgent,
      circuitBreakers,
      ragStores,
      modelProvider,
    } = agentHandle;
    const { ragRegistry: globalRagRegistry, mcpClients: globalMcpClients } =
      agentHandle;

    // ---- YAML-only MCP harvest (single-connect + restored vectorization) ----
    // For the YAML-only branch the startup builder connected the `mcp:` block
    // AND vectorized its tools into `toolsRag`. Harvest the builder's connected
    // set into `_sharedMcpClients` so `ctx.callMcp` and per-session agents reuse
    // the SAME single connection (no second connect), then build the tools-RAG
    // handle catalog over it. The DI/plugin branch already did this earlier.
    if (!hasDiOrPlugin) {
      this._sharedMcpClients = globalMcpClients ?? [];
      await this.buildToolsRagHandle({ toolsRag, resolvedEmbedder });
    }

    // ---- API adapter map (built-in → config DI; DI wins) --------------------
    const { OpenAiApiAdapter, AnthropicApiAdapter } = await import(
      '@mcp-abap-adt/llm-agent'
    );
    const adapterMap = new Map<string, ILlmApiAdapter>();
    if (!this.cfg.disableBuiltInAdapters) {
      const openai = new OpenAiApiAdapter();
      const anthropic = new AnthropicApiAdapter();
      adapterMap.set(openai.name, openai);
      adapterMap.set(anthropic.name, anthropic);
    }
    if (this.cfg.apiAdapters) {
      for (const adapter of this.cfg.apiAdapters) {
        adapterMap.set(adapter.name, adapter);
      }
    }

    const closeFns: Array<() => Promise<void> | void> = [closeAgent];

    // Close any pg pools created for the skill plugin-host's postgres catalog so
    // their sockets do not outlive server shutdown.
    closeFns.push(async () => {
      for (const p of this._skillPgPools) await p.end();
    });

    // Stepper-owned MCP clients (connected from YAML mcp: block when no
    // DI/plugin clients existed). Dispose on server shutdown.
    // TODO: IMcpClient does not currently expose a close() method; add
    //   `for (const c of this._stepperMcpClients) await c.close?.();`
    //   once the interface gains one.
    if (this._stepperMcpClients && this._stepperMcpClients.length > 0) {
      closeFns.push(async () => {
        this._stepperMcpClients = undefined;
      });
    }

    // ---- Per-session lifecycle (cookie identity + graph factory + registry) ----
    const sessionCfg = this.cfg.session ?? {};
    const idleTtlMs = sessionCfg.idleTtlMs ?? 7_200_000;
    const lifecycle = buildSessionLifecycle({
      idleTtlMs,
      maxSessions: sessionCfg.maxSessions ?? 1000,
      cookieName: sessionCfg.cookieName ?? 'sid',
      mcpClients: globalMcpClients,
      // `this._toolsRag` === the `toolsRag` local captured in start(); reference
      // the field as the single source of truth for the tools store.
      toolsRag: this._toolsRag,
      ragRegistry: globalRagRegistry,
      buildAgent: (parts) => this.buildSessionAgent(parts),
      logger: fileLogger,
      // Per-session pipeline teardown: run the IPipelineInstance.close captured
      // by buildPipelineInstance, then drop the entry. Wired here so eviction /
      // shutdown / reconfigure (everything routed through SessionGraph.dispose)
      // frees per-session pipeline resources (MCP / builder handles).
      onDispose: async (sessionId) => {
        const close = this._sessionCloseFns.get(sessionId);
        if (close) {
          this._sessionCloseFns.delete(sessionId);
          await close();
        }
      },
    });
    this._lifecycle = lifecycle;
    const sweepMs = Math.min(idleTtlMs, 60_000);
    const sweep = setInterval(() => {
      void lifecycle.evictIdle();
    }, sweepMs);
    sweep.unref?.();
    closeFns.push(async () => {
      clearInterval(sweep);
      await lifecycle.disposeAll();
      // Fix #21: per-session graphs may reference worker MCP clients, so
      // dispose them FIRST (above), THEN drain per-worker handle.close so the
      // worker-owned MCP clients themselves disconnect. Ordering matters —
      // closing MCP clients while a session graph is mid-use would cut its
      // request short.
      await drainWorkerCache(this._workerLlmCache);
    });

    const startTime = Date.now();
    const healthChecker = new HealthChecker({
      agent: smartAgent,
      startTime,
      version: this.cfg.version ?? PACKAGE_VERSION,
      circuitBreakers,
    });

    // Startup health check removed — use llm-agent-check CLI for diagnostics.
    // Running health check at startup wastes rate-limit budget when combined
    // with tool vectorization (146+ embedding calls).

    // ---- Config hot-reload (optional) ------------------------------------
    if (this.cfg.configFile) {
      const watcher = new ConfigWatcher(this.cfg.configFile);
      watcher.on('reload', (update: HotReloadableConfig) => {
        log({ event: 'config_reload', update });
        // Apply agent config updates
        const agentUpdate: Record<string, unknown> = {};
        if (update.maxIterations !== undefined)
          agentUpdate.maxIterations = update.maxIterations;
        if (update.maxToolCalls !== undefined)
          agentUpdate.maxToolCalls = update.maxToolCalls;
        if (update.ragQueryK !== undefined)
          agentUpdate.ragQueryK = update.ragQueryK;
        if (update.toolUnavailableTtlMs !== undefined)
          agentUpdate.toolUnavailableTtlMs = update.toolUnavailableTtlMs;
        if (update.showReasoning !== undefined)
          agentUpdate.showReasoning = update.showReasoning;
        if (update.historyAutoSummarizeLimit !== undefined)
          agentUpdate.historyAutoSummarizeLimit =
            update.historyAutoSummarizeLimit;
        if (update.prompts?.ragTranslate !== undefined)
          agentUpdate.ragTranslatePrompt = update.prompts.ragTranslate;
        if (update.prompts?.historySummary !== undefined)
          agentUpdate.historySummaryPrompt = update.prompts.historySummary;
        if (update.classificationEnabled !== undefined)
          agentUpdate.classificationEnabled = update.classificationEnabled;
        if (Object.keys(agentUpdate).length > 0) {
          smartAgent.applyConfigUpdate(agentUpdate);
          // Mirror onto `this.cfg.agent` so freshly-built session graphs
          // (which read `this.cfg.agent` in `buildSessionAgent`) observe the
          // update. Deep-merge to preserve untouched startup fields.
          // Note: `agentUpdate` includes flat fields ONLY whitelisted by
          // `AGENT_CONFIG_FIELDS` plus the two prompt fields, which we route
          // into `this.cfg.prompts` separately below.
          const agentPatch: Record<string, unknown> = {};
          for (const k of Object.keys(agentUpdate)) {
            if (k !== 'ragTranslatePrompt' && k !== 'historySummaryPrompt') {
              agentPatch[k] = agentUpdate[k];
            }
          }
          if (Object.keys(agentPatch).length > 0) {
            const mergedAgent: Record<string, unknown> = {
              ...((this.cfg as { agent?: Record<string, unknown> }).agent ??
                {}),
              ...agentPatch,
            };
            (this.cfg as { agent?: Record<string, unknown> }).agent =
              mergedAgent;
          }
          if (
            update.prompts?.ragTranslate !== undefined ||
            update.prompts?.historySummary !== undefined
          ) {
            const mergedPrompts: Record<string, unknown> = {
              ...((this.cfg as { prompts?: Record<string, unknown> }).prompts ??
                {}),
            };
            if (update.prompts?.ragTranslate !== undefined) {
              mergedPrompts.ragTranslate = update.prompts.ragTranslate;
            }
            if (update.prompts?.historySummary !== undefined) {
              mergedPrompts.historySummary = update.prompts.historySummary;
            }
            (this.cfg as { prompts?: Record<string, unknown> }).prompts =
              mergedPrompts;
          }
        }
        // Per-session graphs (built by SessionGraphFactory) captured the OLD
        // config and the OLD cached worker LLM set. Without invalidation,
        // existing sessions keep the stale SmartAgent and a fresh acquire on a
        // cookie-known sessionId still returns it. Clear the worker cache so
        // the next build reads from the just-applied config, then drop every
        // session graph. Failures are non-fatal — log and continue.
        // Fix #21: drain per-worker SmartAgentHandle.close() BEFORE clearing
        // the cache. Hot-reload runs from a synchronous emitter callback, so
        // fire-and-forget here — same async-tolerance as the invalidateAll
        // call below.
        drainWorkerCache(this._workerLlmCache).catch((err: unknown) => {
          log({ event: 'config_reload_drain_error', error: String(err) });
        });
        this._lifecycle?.invalidateAll().catch((err: unknown) => {
          log({ event: 'config_reload_invalidate_error', error: String(err) });
        });
        // Apply RAG weight updates
        if (
          update.vectorWeight !== undefined ||
          update.keywordWeight !== undefined
        ) {
          for (const store of Object.values(ragStores)) {
            if (
              store &&
              typeof (store as VectorRag).updateWeights === 'function'
            ) {
              (store as VectorRag).updateWeights({
                vectorWeight: update.vectorWeight,
                keywordWeight: update.keywordWeight,
              });
            }
          }
        }
      });
      watcher.on('error', (err: unknown) => {
        log({ event: 'config_reload_error', error: String(err) });
      });
      watcher.start();
      closeFns.push(() => watcher.stop());
    }

    const { requestLogger } = agentHandle;

    const server = http.createServer((req, res) =>
      this._handle(
        req,
        res,
        requestLogger,
        smartAgent,
        chat,
        streamChat,
        log,
        healthChecker,
        modelProvider,
        adapterMap,
      ).catch((err) => {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(jsonError(String(err), 'server_error'));
        }
      }),
    );

    return new Promise((resolve, reject) => {
      const port = this.cfg.port ?? 4004;
      const host = this.cfg.host ?? '0.0.0.0';
      server.on('error', reject);
      server.listen(port, host, () => {
        const addr = server.address();
        const actualPort =
          typeof addr === 'object' && addr !== null ? addr.port : port;
        log({ event: 'server_started', port: actualPort, host });
        resolve({
          port: actualPort,
          close: async () => {
            // 1. Stop accepting new connections AND wait for in-flight HTTP
            //    requests to drain. Until server.close() resolves, requests
            //    accepted before shutdown may still be running and pinning
            //    per-session graphs — disposing those graphs first would
            //    violate the active-request pinning guarantee.
            await new Promise<void>((res, rej) =>
              server.close((e) => (e ? rej(e) : res())),
            );
            // 2. Now run lifecycle cleanup: sweep timer, lifecycle.disposeAll,
            //    config watcher stop, agent close. By this point no HTTP
            //    request is in flight, so disposing session graphs is safe.
            for (const fn of closeFns) await fn();
          },
          requestLogger,
        });
      });
    });
  }

  /**
   * Build a `SmartAgent` instance from a nested sub-agent config.
   *
   * Mirrors the parent's composition flow but intentionally narrower:
   *   - reuses the parent's merged embedder factories so plugin-provided
   *     embedders stay available without a second `pluginLoader.load()`;
   *   - shares the parent's file logger to keep one log stream;
   *   - skips features that don't make sense for a nested agent (HTTP
   *     surface, plugin reranker/queryExpander/outputValidator, MCP
   *     client DI, custom client adapters, structured pipeline rag.*
   *     stores). Only the flat `rag:` block is honoured.
   *
   * Sub-agents do not recurse — `subagents:` inside a sub-YAML is
   * rejected at config-parse time, so `subCfg.subAgentConfigs` is
   * always undefined here.
   */
  private async buildSubAgent(
    name: string,
    subCfg: Omit<SmartServerConfig, 'log'>,
    parentLogger: ILogger,
    embedderFactories: Record<string, EmbedderFactory>,
    injected?: {
      ragRegistry: IRagRegistry;
      toolsRag: IRag | undefined;
      mcpClients: IMcpClient[];
      requestLogger: IRequestLogger;
      mainLlm: ILlm;
      classifierLlm: ILlm;
      helperLlm?: ILlm;
      embedder?: IEmbedder;
    },
  ): Promise<SmartAgent> {
    // Normalize subagent llm: either flat { provider, apiKey, ... } or a map
    // { main: {...}, planner: {...} }. normalizeLlmConfig wraps flat shape as
    // { main: flat } so downstream code always reads from .main.
    const subLlmMap = normalizeLlmConfig(subCfg.llm);
    const subLlmMain = subLlmMap?.main;
    if (
      !subLlmMain?.apiKey &&
      subLlmMain?.provider !== 'sap-ai-sdk' &&
      subLlmMain?.provider !== 'ollama'
    ) {
      throw new Error(`subagent '${name}': LLM API key is required`);
    }
    // The subagent's helper role derives from its own top-level `llm:` map.
    const subHelperCfg = resolveLlmConfigStrict(subLlmMap, 'helper');

    // LLM/embedder clients: when the per-session re-wire injected them, use
    // those cached instances by reference (NEVER reconstruct). Otherwise (the
    // primary build()), build-once via the cache so the global agent build
    // also populates it and later per-session re-wires reuse the SAME
    // instances.
    // Note: a per-worker embedder slot is carried in WorkerLlmSet and the
    // injected record for forward-compat with Task A8/A10 per-session wiring.
    // Today's buildSubAgent does not separately resolve an embedder here —
    // embedders are carried by the worker's own store via makeRag's
    // `injectedEmbedder` — so we ignore the embedder field below.
    // Resolve (build-once or load from cache) the worker's own LLMs +
    // toolsRag/historyRag/mcpClients. The cache is keyed by worker name; the
    // primary build() populates it (no `injected` arg), and per-session
    // re-wires (`injected` set) read from it via the same call below — the
    // cache hit short-circuits all factories. This keeps the worker's
    // declared RAG/MCP intact across per-session re-wires (review HIGH #1).
    const subFlatLlm = subLlmMain;
    const mainTemp = Number(subFlatLlm?.temperature ?? 0.7);
    const classifierTemp = Number(subFlatLlm?.classifierTemperature ?? 0.1);
    const cached = await resolveWorkerLlmSet({
      name,
      cache: this._workerLlmCache,
      // Preserve the existing makeLlm derivation exactly.
      makeMain: () =>
        makeLlm(
          {
            // ?? 'deepseek' is a TS type-narrowing net only; the config
            // validator rejects a missing flat-schema provider before
            // this runs.
            provider: subFlatLlm?.provider ?? 'deepseek',
            apiKey: subFlatLlm?.apiKey ?? '',
            baseURL: subFlatLlm?.url,
            model: subFlatLlm?.model,
          },
          mainTemp,
        ),
      makeClassifier: () =>
        makeLlm(
          {
            provider: subFlatLlm?.provider ?? 'deepseek',
            apiKey: subFlatLlm?.apiKey ?? '',
            baseURL: subFlatLlm?.url,
            model: subFlatLlm?.model,
          },
          classifierTemp,
        ),
      makeHelper: subHelperCfg
        ? (
            (h) => () =>
              makeLlm(
                {
                  provider: h.provider ?? 'deepseek',
                  apiKey: h.apiKey,
                  baseURL: h.url,
                  model: h.model,
                },
                Number(h.temperature ?? 0.1),
              )
          )(subHelperCfg)
        : undefined,
      // Worker-OWN tools RAG (from subCfg.rag, if declared). Built once;
      // re-wired per-session by reference — never re-vectorized.
      makeToolsRag: subCfg.rag
        ? () =>
            makeRag(subCfg.rag as SmartServerRagConfig, {
              injectedEmbedder: subCfg.embedder,
              extraFactories: embedderFactories,
            })
        : undefined,
      makeHistoryRag: subCfg.rag
        ? () =>
            makeRag(
              { ...(subCfg.rag as SmartServerRagConfig) },
              {
                injectedEmbedder: subCfg.embedder,
                extraFactories: embedderFactories,
              },
            )
        : undefined,
      // Worker-OWN MCP clients. DI list (subCfg.mcpClients) wins; otherwise
      // SmartAgentBuilder's own MCP-connect path handles `subCfg.mcp` — we
      // don't pre-build those here (connection is the builder's job and is
      // not safe to invoke twice). The cache stores the DI clients only.
      makeMcpClients:
        subCfg.mcpClients && subCfg.mcpClients.length > 0
          ? async () => subCfg.mcpClients as IMcpClient[]
          : undefined,
    });
    const mainLlm: ILlm = cached.mainLlm;
    const classifierLlm: ILlm = cached.classifierLlm;
    const helperLlm: ILlm | undefined = cached.helperLlm;

    let subBuilder = new SmartAgentBuilder({
      mcp: subCfg.mcp,
      agent: subCfg.agent,
      prompts: subCfg.prompts,
      skipModelValidation: subCfg.skipModelValidation,
    })
      .withMainLlm(mainLlm)
      .withClassifierLlm(classifierLlm)
      .withLogger(parentLogger)
      .withMode(subCfg.mode ?? 'smart');

    if (helperLlm) {
      subBuilder = subBuilder.withHelperLlm(helperLlm);
    }

    // SHARE the parent RAG registry + session logger when injected (per-session
    // worker re-wire). The per-call scope filter isolates by ctx.sessionId.
    const sharedReg = resolveSubAgentRagRegistry({
      parentRagRegistry: injected?.ragRegistry,
    });
    if (sharedReg) subBuilder = subBuilder.setRagRegistry(sharedReg);
    if (injected?.requestLogger) {
      subBuilder = subBuilder.withRequestLogger(injected.requestLogger);
    }

    // Tools/History RAG priority (review HIGH #1):
    //   1) worker's OWN cached toolsRag (from subCfg.rag) — built once, reused
    //      by reference across per-session re-wires (never re-vectorized);
    //   2) parent's injected toolsRag (fallback for workers that did not
    //      declare their own store).
    // History RAG: only when the worker has its own cached instance — the
    // parent's history RAG is owned by the parent agent and is not shared.
    if (cached.toolsRag) {
      subBuilder = subBuilder.setToolsRag(cached.toolsRag);
      if (cached.historyRag) {
        subBuilder = subBuilder.setHistoryRag(cached.historyRag);
      }
    } else if (injected?.toolsRag) {
      subBuilder = subBuilder.setToolsRag(injected.toolsRag);
    }

    if (subCfg.skillManager) {
      subBuilder = subBuilder.withSkillManager(subCfg.skillManager);
    }

    // MCP clients priority (review HIGH #1):
    //   1) worker's OWN cached MCP clients (from subCfg.mcpClients DI) — keeps
    //      the worker pointed at its own upstream when the parent has none;
    //   2) parent's injected GLOBAL MCP clients (fallback) — skips re-connect.
    // If neither is set, fall through to the builder's own MCP-connect path
    // (which honours `subCfg.mcp`).
    if (cached.mcpClients && cached.mcpClients.length > 0) {
      subBuilder = subBuilder.withMcpClients(cached.mcpClients);
    } else if (injected?.mcpClients && injected.mcpClients.length > 0) {
      subBuilder = subBuilder.withMcpClients(injected.mcpClients);
    }

    const handle = await subBuilder.build();

    // Backfill the per-worker cache from the BUILT handle (review HIGH #7).
    // Only runs on the primary build path (no `injected`) so per-session
    // re-wires never overwrite the cache. See backfillWorkerCacheFromHandle's
    // doc-comment for the rationale.
    if (!injected) {
      const entry = this._workerLlmCache.get(name);
      if (entry) await backfillWorkerCacheFromHandle(entry, handle);
    }
    return handle.agent;
  }

  // -- Pipeline-context dep sources (promoted from the inline coordinator-gate
  //    closures; consumed by buildServerCtx, which later tasks call) ----------

  /** Build an LLM from a SmartServerLlmConfig (mirrors stepperMakeLlm/DAG).
   *  Routes through the BuildAgentDeps seam so an injected `makeLlm` overrides
   *  the real builder. */
  private _makeLlm(lc: SmartServerLlmConfig): Promise<ILlm> {
    return this._deps.makeLlm(lc);
  }

  /** The real `makeLlm`-backed construction (the seam's default). */
  private _makeLlmDefault(lc: SmartServerLlmConfig): Promise<ILlm> {
    return makeLlm(
      {
        provider: lc.provider ?? 'deepseek',
        apiKey: lc.apiKey,
        baseURL: lc.url,
        model: lc.model,
      },
      Number(lc.temperature ?? this._mainTemp ?? 0.7),
    );
  }

  /** Resolve a per-role LLM through the normalized map → pipelineFallback chain.
   *  'main' returns the captured mainLlm; 'helper'/'classifier' return the
   *  prebuilt instances when present; otherwise the map/fallback config is built. */
  private async resolveRoleLlm(role: string): Promise<ILlm> {
    if (role === 'main' && this._mainLlm) return this._mainLlm;
    if ((role === 'helper' || role === 'planner') && this._helperLlm) {
      return this._helperLlm;
    }
    if (role === 'classifier' && this._classifierLlm)
      return this._classifierLlm;
    const cfg = resolveLlmConfig(this._llmMap, role, this._pipelineFallback);
    if (cfg) return this._makeLlm(cfg);
    if (this._mainLlm) return this._mainLlm;
    throw new Error(`cannot resolve LLM for role '${role}': no config`);
  }

  /**
   * Session-scoped knowledge RAG over the shared knowledge backend (built
   * unconditionally in `start()`; a fresh in-memory backend is a defensive
   * fallback). HOST-level seeding happens HERE so the stepper plugin stays
   * agnostic (it just calls `ctx.knowledgeRagFor`): a BRAND-NEW session is
   * seeded from `pipeline.config.knowledgeSeed` (read defensively — absent for
   * non-stepper pipelines, where an empty seed is a harmless no-op). Idempotent
   * on resume via `seedSessionKnowledge`.
   */
  private async knowledgeRagFor(
    sessionId: string,
  ): Promise<IKnowledgeRagHandle> {
    const backend =
      this._stepperKnowledgeBackend ?? new InMemoryKnowledgeBackend();
    const kr = new KnowledgeRag(backend, sessionId);
    const rawSeed = (this.cfg.pipeline?.config as { knowledgeSeed?: unknown })
      ?.knowledgeSeed;
    const seeds = Array.isArray(rawSeed)
      ? (rawSeed as Array<{ content?: unknown; artifactType?: unknown }>)
          .filter((e) => e && typeof e.content === 'string')
          .map((e) => ({
            content: e.content as string,
            artifactType:
              typeof e.artifactType === 'string' ? e.artifactType : 'guidance',
          }))
      : [];
    await seedSessionKnowledge(kr, seeds, new Date().toISOString());
    return kr;
  }

  /** callMcp bridge over the shared connected MCP clients (empty when none). */
  private callMcp(
    name: string,
    args: unknown,
    signal?: AbortSignal,
  ): Promise<string> {
    return buildMcpBridge(this._sharedMcpClients ?? [])(name, args, signal);
  }

  private _mintStepperId(): string {
    return randomUUID();
  }

  private _mintTurnId(): string {
    return randomUUID();
  }

  /**
   * Build the shared pipeline infra consumed by `buildServerCtx` for EVERY
   * pipeline (sub-goal 5). Populates, on the instance:
   *   - `_stepperKnowledgeBackend` — the ONE knowledge backend (JSONL when a
   *     logDir is set, else in-memory) shared across sessions; `knowledgeRagFor`
   *     keys it by sessionId and host-seeds new sessions from
   *     `pipeline.config.knowledgeSeed`.
   *   - `_sharedMcpClients` — the connected clients the `callMcp` bridge
   *     dispatches over: DI/plugin clients by reference, else the YAML `mcp:`
   *     block connected ONCE here (never a second connection when DI clients
   *     already exist).
   *   - `_toolsRagHandle` — a real IToolsRagHandle over the tools RAG store +
   *     MCP catalog (semantic when an embedder+store exist, catalog-order
   *     fallback otherwise). Undefined toolsRag/embedder still yields a usable
   *     catalog-backed handle.
   */
  private async buildSharedPipelineInfra(input: {
    toolsRag: IRag | undefined;
    resolvedEmbedder: IEmbedder | undefined;
    mcpClients: IMcpClient[] | undefined;
  }): Promise<void> {
    const { toolsRag, resolvedEmbedder, mcpClients } = input;

    // Record the resolved embedder BEFORE building the knowledge backend so the
    // backend can attach the embedder-backed semantic index (controller recall).
    if (resolvedEmbedder) this._resolvedEmbedder = resolvedEmbedder;
    this.buildKnowledgeBackend();

    // MCP clients for the callMcp bridge. DI/plugin clients win; otherwise
    // connect the YAML `mcp:` block ONCE (connect is not safe to invoke twice
    // on the same wrapper — guard via the cache field).
    if (!mcpClients && !this._stepperMcpClients) {
      this._stepperMcpClients = await this._deps.connectMcp(this.cfg.mcp);
    }
    this._sharedMcpClients = mcpClients ?? this._stepperMcpClients ?? [];

    await this.buildToolsRagHandle({ toolsRag, resolvedEmbedder });
  }

  /**
   * Build the ONE knowledge backend shared across all requests (JSONL when a
   * logDir is set, else in-memory). Keyed by sessionId internally for per-session
   * isolation + same-cookie persistence. Idempotent (no-op once built).
   *
   * No MCP dependency — safe to call BEFORE the MCP client set is resolved.
   */
  private buildKnowledgeBackend(): void {
    if (this._stepperKnowledgeBackend) return;
    const logDir = this.cfg.logDir;
    // Attach an embedder-backed semantic index whenever an embedder is resolved —
    // for ANY pipeline. Do NOT throw here: buildKnowledgeBackend runs
    // unconditionally at startup and a flat/stepper deployment without an embedder
    // is valid; only the CONTROLLER mandates embedding recall, enforced at the
    // ControllerFactory boundary, not globally. With an index, the controller's
    // results-RAG recall ranks by meaning instead of recency.
    const semantic = this._resolvedEmbedder
      ? makeKnowledgeSemanticIndex(this._resolvedEmbedder)
      : undefined;
    this._stepperKnowledgeBackend = logDir
      ? new JsonlKnowledgeBackend(logDir, semantic)
      : new InMemoryKnowledgeBackend(semantic);
  }

  /**
   * Build `_toolsRagHandle` — a real IToolsRagHandle over the tools RAG store +
   * MCP catalog, dispatching over the ALREADY-RESOLVED `this._sharedMcpClients`.
   *
   * Split out of `buildSharedPipelineInfra` so the YAML-only path can run it
   * AFTER the startup builder connects + vectorizes (the builder owns the single
   * connection there, and `_sharedMcpClients` is harvested from its handle). For
   * the DI/plugin path it still runs early via `buildSharedPipelineInfra`.
   * Requires `this._sharedMcpClients` to be set by the caller.
   */
  private async buildToolsRagHandle(input: {
    toolsRag: IRag | undefined;
    resolvedEmbedder: IEmbedder | undefined;
  }): Promise<void> {
    const { toolsRag, resolvedEmbedder } = input;

    // Tools RAG handle over the tools store + MCP catalog.
    const stepperMcpClients = this._sharedMcpClients ?? [];
    let catalogCache: Map<string, LlmTool> | undefined;
    const ensureCatalog = async (): Promise<Map<string, LlmTool>> => {
      if (catalogCache) return catalogCache;
      const catalog = new Map<string, LlmTool>();
      await Promise.allSettled(
        stepperMcpClients.map(async (client) => {
          const result = await client.listTools();
          if (result.ok) {
            for (const t of result.value) {
              if (!catalog.has(t.name)) catalog.set(t.name, t as LlmTool);
            }
          }
        }),
      );
      catalogCache = catalog;
      return catalog;
    };
    this._toolsRagHandle = {
      async query(text: string, k?: number, options?: CallOptions) {
        const limit = k ?? 20;
        const catalog = await ensureCatalog();
        if (toolsRag && resolvedEmbedder) {
          // Pass options (requestLogger + trace) so the wrapped embedder logs
          // this query-embedding against the request.
          const embedding = new QueryEmbedding(text, resolvedEmbedder, options);
          const ragResult = await toolsRag.query(embedding, limit);
          if (ragResult.ok) {
            const hits: LlmTool[] = [];
            for (const r of ragResult.value) {
              const id = r.metadata.id as string | undefined;
              if (id?.startsWith('tool:')) {
                const name = id.slice(5).replace(/:.*$/, '');
                const tool = catalog.get(name);
                if (tool) hits.push(tool);
              }
            }
            if (hits.length > 0) return hits;
          }
        }
        return [...catalog.values()].slice(0, limit);
      },
      lookup(name: string) {
        return catalogCache?.get(name);
      },
    };

    // F2: eagerly populate the MCP tool catalog at startup (MCP is connected
    // above), so the SYNC `lookup(name)` contract (IToolsRagHandle.lookup) returns
    // a tool schema BEFORE any `query()` runs. `ensureCatalog` is idempotent —
    // later `query()` calls reuse the cached map. Guard against a catalog-load
    // failure so startup never crashes: on failure `catalogCache` stays unset and
    // `lookup` returns undefined (today's worst case), while the happy path works.
    try {
      await ensureCatalog();
    } catch (err) {
      this.cfg.log?.({
        event: 'tools_catalog_eager_load_failed',
        message:
          'tools catalog eager-load failed; lookup() returns undefined until first query()',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Build the per-session pipeline instance from the registry. Selects the
   * plugin by `cfg.pipeline.name` (default 'flat'), parses its config dialect,
   * and builds it against a session-scoped pipeline context. The returned
   * `IPipelineInstance` carries `{ agent, close }` — the session consumes
   * `agent`; `buildSessionAgent` registers `close` into the session-dispose path.
   */
  private async buildPipelineInstance(scope: {
    sessionId: string;
    parts: SessionAgentParts;
  }): Promise<IPipelineInstance> {
    const name = this.cfg.pipeline?.name ?? 'flat';
    const plugin = this._pipelineRegistry.get(name);
    if (!plugin) {
      throw new Error(
        `unknown pipeline '${name}'; available: ${[
          ...this._pipelineRegistry.keys(),
        ].join(', ')}`,
      );
    }
    const cfg = plugin.parseConfig(this.cfg.pipeline?.config ?? {});
    return plugin.build(cfg, await this.buildServerCtx(scope));
  }

  private warn(msg: string): void {
    (this.cfg.log ?? this.noop)({ event: 'config_warning', message: msg });
  }

  /**
   * Build the FRESH per-session worker (sub-agent) registry from the SAME
   * `subagents:` configs the primary build() used, injecting globals + this
   * session's logger + the CACHED per-worker LLM/embedder (this._workerLlmCache).
   * NEVER reconstructs LLM clients; NEVER reuses the global registry.
   *
   * Extracted from buildSessionAgent so both the legacy session re-wire and the
   * pipeline-plugin context (`buildServerCtx` / `partsToBaseInput`) feed a real
   * per-session worker map to `buildBaseBuilder` instead of an empty `new Map()`.
   */
  private async buildWorkerRegistry(
    parts: SessionAgentParts,
  ): Promise<SubAgentRegistry> {
    const registry: SubAgentRegistry = new Map();
    if (!this.cfg.subAgentConfigs || this.cfg.subAgentConfigs.length === 0) {
      return registry;
    }
    if (!this._fileLogger) {
      throw new Error(
        'buildWorkerRegistry invoked before primary build() captured globals',
      );
    }
    for (const sub of this.cfg.subAgentConfigs) {
      // Lazy build-on-miss (Fix #18). After PUT /v1/config or hot-reload
      // clears `_workerLlmCache`, the next session build used to throw
      // "worker LLM set not cached" because the cache was assumed
      // pre-populated by the primary build(). buildSubAgent itself routes
      // through `resolveWorkerLlmSet` which is build-on-miss, so calling
      // it without an `injected` arg rebuilds the cache entry. We then
      // re-read the entry to honour the per-worker slot priority below.
      if (!this._workerLlmCache.has(sub.name)) {
        await this.buildSubAgent(
          sub.name,
          sub.config,
          this._fileLogger,
          this._mergedEmbedderFactories ?? {},
          // No `injected` → primary path: resolveWorkerLlmSet populates
          // `_workerLlmCache` and backfillWorkerCacheFromHandle fills the
          // mcpClients/toolsRag slots from the built handle.
        );
      }
      const cached = this._workerLlmCache.get(sub.name);
      if (!cached) {
        // Defence in depth — should be impossible after the lazy build
        // above unless buildSubAgent's contract changes.
        throw new Error(`worker LLM set not cached for '${sub.name}'`);
      }
      // Per-worker injected slot priority (review HIGH #7):
      //   worker-cached (from the primary build, includes backfilled
      //   subCfg.mcp / subCfg.rag results) → parent's session-scoped
      //   fallback. Encoded HERE so buildSubAgent does not need to know
      //   the difference; it just consumes injected.mcpClients/toolsRag.
      const injectedMcpClients =
        cached.mcpClients && cached.mcpClients.length > 0
          ? cached.mcpClients
          : parts.mcpClients;
      const injectedToolsRag = cached.toolsRag ?? parts.toolsRag;
      const subAgent = await this.buildSubAgent(
        sub.name,
        sub.config,
        this._fileLogger,
        this._mergedEmbedderFactories ?? {},
        {
          ragRegistry: parts.ragRegistry,
          toolsRag: injectedToolsRag,
          mcpClients: injectedMcpClients,
          requestLogger: parts.logger,
          mainLlm: cached.mainLlm,
          classifierLlm: cached.classifierLlm,
          helperLlm: cached.helperLlm,
          embedder: cached.embedder,
        },
      );
      registry.set(
        sub.name,
        new SmartAgentSubAgent(sub.name, subAgent, {
          description: sub.description,
        }),
      );
    }
    return registry;
  }

  /**
   * Map SessionAgentParts → buildBaseBuilder input. `workerRegistry` is the
   * pre-built per-session worker map (from buildWorkerRegistry). `extras`
   * carries the startup-only inputs (plugins + applyServerExtras + the global
   * history/collection stores); omitted for the session scope.
   */
  private partsToBaseInput(
    parts: SessionAgentParts,
    workerRegistry: SubAgentRegistry,
    extras?: {
      applyServerExtras: boolean;
      plugins?: LoadedPlugins;
      historyRag?: IRag;
      ragCollections?: Array<{
        name: string;
        rag: IRag;
        meta: { displayName: string; scope: 'global' };
      }>;
    },
  ): Parameters<SmartServer['buildBaseBuilder']>[0] {
    return {
      mainLlm: this._mainLlm as ILlm,
      classifierLlm: this._classifierLlm as ILlm,
      helperLlm: this._helperLlm,
      fileLogger: this._fileLogger as ILogger,
      toolsRag: parts.toolsRag,
      historyRag: extras?.historyRag,
      ragCollections: extras?.ragCollections,
      ragRegistry: parts.ragRegistry,
      mcpClients: parts.mcpClients,
      requestLogger: parts.logger,
      plugins: extras?.plugins,
      workerRegistry,
      applyServerExtras: extras?.applyServerExtras ?? false,
    };
  }

  /**
   * Assemble an IServerPipelineContext from `this` for a given scope (startup =
   * global; session = per-session). Builds the FRESH per-session worker registry
   * ONCE and threads it both to the `workerRegistry` field (read by the DAG
   * plugin) and to `createAgentBuilder` (so the agent wires the same workers).
   *
   * `logLlmCall` is sourced from `scope.parts.logger` — the per-session
   * SessionRequestLogger, which implements IRequestLogger.logLlmCall — so token
   * accounting is no longer a no-op (closes the Task-6 `_requestLogger` gap).
   */
  private async buildServerCtx(scope: {
    sessionId: string;
    parts: SessionAgentParts;
    applyServerExtras?: boolean;
    plugins?: LoadedPlugins;
    historyRag?: IRag;
    ragCollections?: Array<{
      name: string;
      rag: IRag;
      meta: { displayName: string; scope: 'global' };
    }>;
  }): Promise<IServerPipelineContext> {
    const workerRegistry = await this.buildWorkerRegistry(scope.parts);
    const extras = {
      applyServerExtras: scope.applyServerExtras ?? false,
      plugins: scope.plugins,
      historyRag: scope.historyRag,
      ragCollections: scope.ragCollections,
    };
    // Per-session request logger (SessionRequestLogger) — the live sink for
    // logLlmCall. Falls back to the server-level _requestLogger if ever unset.
    const requestLogger: IRequestLogger | undefined =
      scope.parts.logger ?? this._requestLogger;
    // Durable knowledge backend is built unconditionally in start()
    // (buildKnowledgeBackend); guard idempotently so the ctx field is always
    // populated even if buildServerCtx is ever reached before start() finishes.
    this.buildKnowledgeBackend();
    return createServerPipelineContext({
      resolveLlm: (role) => this.resolveRoleLlm(role),
      knowledgeRagFor: (sid) => this.knowledgeRagFor(sid),
      // Durable backend + resolved embedder shared with every pipeline; the
      // controller pipeline consumes both (session-bundle persistence +
      // target-state semantic distance).
      stepperKnowledgeBackend:
        this._stepperKnowledgeBackend ?? new InMemoryKnowledgeBackend(),
      embedder: this._resolvedEmbedder,
      // Skill plugin-host (built + loaded once in start()); undefined when no
      // `skillPlugins:` config — pipelines that don't read it are unaffected.
      ...(this._skillHost
        ? {
            skillHost: this._skillHost,
            skillRecall: {
              k: this.cfg.skillPlugins?.k ?? 4,
              ...(this.cfg.skillPlugins?.threshold !== undefined
                ? { threshold: this.cfg.skillPlugins.threshold }
                : {}),
              ...(this.cfg.skillPlugins?.controllerSkillGroup !== undefined
                ? {
                    controllerSkillGroup:
                      this.cfg.skillPlugins.controllerSkillGroup,
                  }
                : {}),
              ...(this.cfg.skillPlugins?.maxInjectChars !== undefined
                ? { maxInjectChars: this.cfg.skillPlugins.maxInjectChars }
                : {}),
              ...(this.cfg.skillPlugins?.serveCollections !== undefined
                ? { serveCollections: this.cfg.skillPlugins.serveCollections }
                : {}),
            },
          }
        : {}),
      // External tools are NOT carried on this build-time ctx: definitions arrive
      // per-REQUEST (HTTP body.tools) and the controller routes them per-request
      // via PipelineContext.externalTools inside the coordinator handler.
      toolsRag: this._toolsRagHandle, // undefined → EMPTY_TOOLS_RAG via factory
      ragRegistry: scope.parts.ragRegistry,
      callMcp: (n, a, s) => this.callMcp(n, a, s),
      mcpClients: scope.parts.mcpClients,
      subagents: (this.cfg.subAgentConfigs ?? []).map((s) => ({
        name: s.name,
        description: s.description,
      })),
      mintStepperId: () => this._mintStepperId(),
      mintTurnId: () => this._mintTurnId(),
      logger: this._fileLogger,
      logLlmCall: (e) => requestLogger?.logLlmCall?.(e),
      createAgentBuilder: () =>
        this.buildBaseBuilder(
          this.partsToBaseInput(scope.parts, workerRegistry, extras),
        ),
      makeLlm: (c) => this._makeLlm(c),
      llmMap: this._llmMap,
      pipelineFallback: this._pipelineFallback,
      mainLlm: this._mainLlm as ILlm,
      helperLlm: this._helperLlm,
      mainTemp: this._mainTemp ?? 0.7,
      workerRegistry,
      warn: (m) => this.warn(m),
    });
  }

  /**
   * Assemble a SmartAgentBuilder wired with all shared infra EXCEPT the
   * coordinator — the part shared by the startup path and buildSessionAgent.
   * The caller wires the coordinator variant AFTER this returns. Each call site
   * supplies its own scope's values (startup = global; session = session-scoped);
   * every `.withXxx` is applied conditionally on its `parts` field so both work.
   *
   * `applyServerExtras` gates the startup-only, config/plugin-derived wiring
   * (circuit breaker, reranker/queryExpander/outputValidator, skill manager,
   * LLM-call & tool-selection strategies, client adapters, and the YAML `mcp:`
   * connect path). The per-session re-wire omits these (it inherits a slimmer
   * agent) so they stay gated to preserve behavior.
   */
  private async buildBaseBuilder(parts: {
    mainLlm: ILlm;
    classifierLlm: ILlm;
    helperLlm?: ILlm;
    fileLogger: ILogger;
    toolsRag?: IRag;
    historyRag?: IRag;
    ragCollections?: Array<{
      name: string;
      rag: IRag;
      meta: { displayName: string; scope: 'global' };
    }>;
    ragRegistry?: IRagRegistry;
    mcpClients?: IMcpClient[];
    requestLogger?: IRequestLogger;
    plugins?: LoadedPlugins;
    workerRegistry: SubAgentRegistry;
    /** Apply the startup-only config/plugin-derived extras (see method doc). */
    applyServerExtras: boolean;
  }): Promise<SmartAgentBuilder> {
    let builder = new SmartAgentBuilder({
      // F1: the YAML `mcp:` block is connected ONCE up-front (in
      // buildSharedPipelineInfra) and injected here via `withMcpClients` below.
      // Only pass `mcp:` to the builder constructor as a LAST-RESORT auto-connect
      // path when NO pre-connected clients are supplied — otherwise omit it so
      // build() cannot open a second connection. (build() already short-circuits
      // on `this._mcpClients`; dropping the key is belt-and-suspenders.)
      ...(parts.applyServerExtras && !parts.mcpClients
        ? { mcp: this.cfg.mcp }
        : {}),
      agent: this.cfg.agent,
      prompts: this.cfg.prompts,
      skipModelValidation: this.cfg.skipModelValidation,
    })
      .withMainLlm(parts.mainLlm)
      .withClassifierLlm(parts.classifierLlm)
      .withLogger(parts.fileLogger)
      .withMode(this.cfg.mode ?? 'smart');

    if (parts.helperLlm) {
      builder = builder.withHelperLlm(parts.helperLlm);
    }

    if (parts.toolsRag) {
      builder = builder.setToolsRag(parts.toolsRag);
    }
    if (parts.historyRag) {
      builder = builder.setHistoryRag(parts.historyRag);
    }
    for (const collection of parts.ragCollections ?? []) {
      builder = builder.addRagCollection(collection);
    }
    if (parts.ragRegistry) {
      builder = builder.setRagRegistry(parts.ragRegistry);
    }
    if (parts.requestLogger) {
      builder = builder.withRequestLogger(parts.requestLogger);
    }

    if (parts.applyServerExtras) {
      const plugins = parts.plugins;
      if (this.cfg.circuitBreaker) {
        builder = builder.withCircuitBreaker(this.cfg.circuitBreaker);
      }
      if (plugins?.reranker) {
        builder = builder.withReranker(plugins.reranker);
      }
      if (plugins?.queryExpander) {
        builder = builder.withQueryExpander(plugins.queryExpander);
      }
      if (plugins?.outputValidator) {
        builder = builder.withOutputValidator(plugins.outputValidator);
      }

      // Skill manager (DI > YAML config > plugin)
      const skillManager =
        this.cfg.skillManager ??
        plugins?.skillManager ??
        resolveSkillManager(this.cfg.skills);
      if (skillManager) {
        builder = builder.withSkillManager(skillManager);
      }

      // LLM call strategy (from agent config)
      const strategyName = this.cfg.agent?.llmCallStrategy;
      if (strategyName) {
        const {
          StreamingLlmCallStrategy,
          NonStreamingLlmCallStrategy,
          FallbackLlmCallStrategy,
        } = await import('@mcp-abap-adt/llm-agent');
        const strategies = {
          streaming: () => new StreamingLlmCallStrategy(),
          'non-streaming': () => new NonStreamingLlmCallStrategy(),
          fallback: () => new FallbackLlmCallStrategy(parts.fileLogger),
        };
        const factory = strategies[strategyName];
        if (factory) {
          builder = builder.withLlmCallStrategy(factory());
        }
      }

      // Tool-selection strategy (from agent.toolSelection config)
      const toolSelectionCfg = this.cfg.agent?.toolSelection;
      if (toolSelectionCfg?.strategy) {
        builder = builder.withToolSelectionStrategy(
          resolveToolSelectionStrategy(toolSelectionCfg.strategy, {
            minScore: toolSelectionCfg.minScore,
          }),
        );
      }
    }

    if (parts.mcpClients) {
      builder = builder.withMcpClients(parts.mcpClients);
    }

    if (parts.applyServerExtras) {
      // Client adapters (DI > plugin; ClineClientAdapter is the default).
      const { ClineClientAdapter } = await import('@mcp-abap-adt/llm-agent');
      const adapterSources = [
        ...(this.cfg.clientAdapters ?? []),
        ...(parts.plugins?.clientAdapters ?? []),
        new ClineClientAdapter(),
      ];
      for (const adapter of adapterSources) {
        builder = builder.withClientAdapter(adapter);
      }
    }

    if (parts.workerRegistry.size > 0) {
      builder = builder.withSubAgents(parts.workerRegistry);
    }

    return builder;
  }

  /**
   * Builds the per-session SmartAgent by routing through the selected pipeline
   * plugin (`buildPipelineInstance`). The pipeline owns coordinator wiring; the
   * session-scoped pipeline context (`buildServerCtx`) supplies the FRESH
   * per-session worker registry + session logger + the global
   * ragRegistry/toolsRag/mcpClients + the CACHED per-worker LLM/embedder
   * (this._workerLlmCache) via `createAgentBuilder`. It NEVER reuses the primary
   * build()'s global registry/coordinator and NEVER constructs new LLM clients.
   *
   * The pipeline returns `{ agent, close }`; we register `close` under the
   * sessionId so the lifecycle `onDispose` hook frees per-session pipeline
   * resources on eviction / shutdown / reconfigure.
   */
  private async buildSessionAgent(
    parts: SessionAgentParts,
  ): Promise<SmartAgent | undefined> {
    // Guard: globals must already be captured by the primary build() before any
    // session graph is built (the registry calls this lazily on first acquire).
    if (!this._mainLlm || !this._classifierLlm || !this._fileLogger) {
      throw new Error(
        'buildSessionAgent invoked before primary build() captured globals',
      );
    }
    const inst = await this.buildPipelineInstance({
      sessionId: parts.sessionId,
      parts,
    });
    // Register the pipeline's disposal hook keyed by sessionId. A prior
    // instance for the same sessionId (e.g. invalidateAll rebuild) is closed
    // first so its resources never leak.
    const prior = this._sessionCloseFns.get(parts.sessionId);
    if (prior) {
      this._sessionCloseFns.delete(parts.sessionId);
      try {
        await prior();
      } catch {
        // Best-effort: a stale close failure must not block the new build.
      }
    }
    this._sessionCloseFns.set(parts.sessionId, () => inst.close());
    // IPipelineInstance.agent is typed as ISmartAgent; the built-in plugins
    // return the concrete SmartAgent from SmartAgentBuilder.build().
    return inst.agent as SmartAgent;
  }

  /**
   * Resolve identity (mint cookie when needed), acquire the per-session graph,
   * run `fn` pinned, and release in `finally`. Order in `finally`:
   *   1. drop the per-traceId logger delta (server-owned free, review HIGH #2)
   *   2. release the refcount pin
   */
  private async _withSession(
    req: IncomingMessage,
    res: ServerResponse,
    fn: (
      graph: SessionGraph,
      sessionId: string,
      traceId: string,
    ) => Promise<void>,
  ): Promise<void> {
    const lifecycle = this._lifecycle;
    if (!lifecycle) {
      throw new Error('SmartServer lifecycle not initialized');
    }
    const traceId = randomUUID();
    const isHttps =
      (req.socket as { encrypted?: boolean }).encrypted === true ||
      req.headers['x-forwarded-proto'] === 'https';
    const resolved = lifecycle.resolve(req.headers['cookie'], isHttps);
    const sessionId = resolved.identity.sessionId;
    if (resolved.minted && resolved.setCookie) {
      res.setHeader('Set-Cookie', resolved.setCookie);
    }
    const graph = await lifecycle.acquire(sessionId);
    // Register/touch the session in the meta store so /v1/sessions, resume and
    // delete reflect real chat/stream traffic (review Finding 3). Best-effort:
    // a meta-store hiccup must never break the actual request.
    try {
      await recordSessionStart(
        this._sessionMetaStore,
        sessionId,
        new Date().toISOString(),
      );
    } catch {
      // swallow — session metadata is non-critical to serving the request
    }
    try {
      await fn(graph, sessionId, traceId);
    } finally {
      try {
        await recordSessionEnd(
          this._sessionMetaStore,
          sessionId,
          new Date().toISOString(),
        );
      } catch {
        // swallow — see above
      }
      graph.logger.dropRequest(traceId);
      // Pass the graph instance — `invalidateAll()` may have detached this
      // graph into the draining map while the request was in flight; we must
      // release THIS specific instance, not whatever currently lives under
      // `sessionId` in the registry.
      lifecycle.release(sessionId, graph);
    }
  }

  private async _handle(
    req: IncomingMessage,
    res: ServerResponse,
    requestLogger: IRequestLogger,
    smartAgent: SmartAgent,
    chat: SmartAgentHandle['chat'],
    streamChat: SmartAgentHandle['streamChat'],
    log: (e: Record<string, unknown>) => void,
    healthChecker: HealthChecker,
    modelProvider?: IModelProvider,
    adapterMap?: Map<string, ILlmApiAdapter>,
  ): Promise<void> {
    const rawUrl = req.url ?? '/';
    const urlPath = rawUrl.split('?')[0].replace(/\/$/, '') || '/';
    for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    log({
      event: 'http_request',
      method: req.method,
      url: rawUrl,
      normalizedPath: urlPath,
    });

    if (
      req.method === 'GET' &&
      (urlPath === '/v1/models' || urlPath === '/models')
    ) {
      const queryString = rawUrl.includes('?') ? rawUrl.split('?')[1] : '';
      const queryParams = new URLSearchParams(queryString);
      const excludeEmbedding = queryParams.get('exclude_embedding') === 'true';
      let data: Array<Record<string, unknown>> = [
        { id: 'smart-agent', object: 'model', owned_by: 'smart-agent' },
      ];
      if (modelProvider) {
        const result = await modelProvider.getModels({ excludeEmbedding });
        if (result.ok) {
          data = result.value.map((m) => ({
            id: m.id,
            object: 'model',
            owned_by: m.owned_by ?? 'unknown',
            ...(m.displayName ? { display_name: m.displayName } : {}),
            ...(m.provider ? { provider: m.provider } : {}),
            ...(m.capabilities ? { capabilities: m.capabilities } : {}),
            ...(m.contextLength ? { context_length: m.contextLength } : {}),
            ...(m.streamingSupported !== undefined
              ? { streaming_supported: m.streamingSupported }
              : {}),
            ...(m.deprecated !== undefined ? { deprecated: m.deprecated } : {}),
          }));
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data }));
      return;
    }
    if (
      req.method === 'GET' &&
      (urlPath === '/v1/embedding-models' || urlPath === '/embedding-models')
    ) {
      let data: Array<Record<string, unknown>> = [];
      if (modelProvider?.getEmbeddingModels) {
        const result = await modelProvider.getEmbeddingModels();
        if (result.ok) {
          data = result.value.map((m) => ({
            id: m.id,
            object: 'model',
            owned_by: m.owned_by ?? 'unknown',
            ...(m.displayName ? { display_name: m.displayName } : {}),
            ...(m.provider ? { provider: m.provider } : {}),
            ...(m.capabilities ? { capabilities: m.capabilities } : {}),
            ...(m.contextLength ? { context_length: m.contextLength } : {}),
            ...(m.streamingSupported !== undefined
              ? { streaming_supported: m.streamingSupported }
              : {}),
            ...(m.deprecated !== undefined ? { deprecated: m.deprecated } : {}),
          }));
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data }));
      return;
    }
    if (req.method === 'GET' && urlPath === '/v1/usage') {
      const lifecycle = this._lifecycle;
      if (!lifecycle) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(jsonError('Session lifecycle not initialized', 'server_error'));
        return;
      }
      const isHttps =
        (req.socket as { encrypted?: boolean }).encrypted === true ||
        req.headers['x-forwarded-proto'] === 'https';
      const resolved = lifecycle.resolve(req.headers['cookie'], isHttps);
      if (resolved.minted && resolved.setCookie) {
        res.setHeader('Set-Cookie', resolved.setCookie);
      }
      const sessionId = resolved.identity.sessionId;
      const graph = await lifecycle.acquire(sessionId);
      try {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(graph.logger.getSummary()));
      } finally {
        lifecycle.release(sessionId, graph);
      }
      return;
    }
    // GET /v1/sessions — list sessions for the current identity
    if (req.method === 'GET' && urlPath === '/v1/sessions') {
      const lifecycle = this._lifecycle;
      if (!lifecycle) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(jsonError('Session lifecycle not initialized', 'server_error'));
        return;
      }
      const isHttps =
        (req.socket as { encrypted?: boolean }).encrypted === true ||
        req.headers['x-forwarded-proto'] === 'https';
      const resolved = lifecycle.resolve(req.headers['cookie'], isHttps);
      if (resolved.minted && resolved.setCookie) {
        res.setHeader('Set-Cookie', resolved.setCookie);
      }
      const identity = resolved.identity.sessionId;
      const body = await handleListSessions(this._sessionMetaStore, identity);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
      return;
    }
    // POST /v1/sessions/:id/resume — resume a session
    {
      const resumeMatch = urlPath.match(/^\/v1\/sessions\/([^/]+)\/resume$/);
      if (req.method === 'POST' && resumeMatch) {
        const sessionId = resumeMatch[1];
        const lifecycle = this._lifecycle;
        if (!lifecycle) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(
            jsonError('Session lifecycle not initialized', 'server_error'),
          );
          return;
        }
        const isHttps =
          (req.socket as { encrypted?: boolean }).encrypted === true ||
          req.headers['x-forwarded-proto'] === 'https';
        const resolved = lifecycle.resolve(req.headers['cookie'], isHttps);
        if (resolved.minted && resolved.setCookie) {
          res.setHeader('Set-Cookie', resolved.setCookie);
        }
        const identity = resolved.identity.sessionId;
        const body = await handleResumeSession(
          this._sessionMetaStore,
          identity,
          sessionId,
        );
        const status = body.ok ? 200 : 404;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
        return;
      }
    }
    // DELETE /v1/sessions/:id — delete a session
    {
      const deleteMatch = urlPath.match(/^\/v1\/sessions\/([^/]+)$/);
      if (req.method === 'DELETE' && deleteMatch) {
        const sessionId = deleteMatch[1];
        const lifecycle = this._lifecycle;
        if (!lifecycle) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(
            jsonError('Session lifecycle not initialized', 'server_error'),
          );
          return;
        }
        const isHttps =
          (req.socket as { encrypted?: boolean }).encrypted === true ||
          req.headers['x-forwarded-proto'] === 'https';
        const resolved = lifecycle.resolve(req.headers['cookie'], isHttps);
        if (resolved.minted && resolved.setCookie) {
          res.setHeader('Set-Cookie', resolved.setCookie);
        }
        const identity = resolved.identity.sessionId;
        const evictFn = async (sid: string) => {
          // (a) Evict/dispose this session's graph from the registry.
          await lifecycle.registry.evictOne(sid);
          // (b) Evict the session's knowledge from the shared backend. This
          // clears the long-lived in-memory backend AND removes the JSONL files
          // (JsonlKnowledgeBackend.deleteSession), so a same-id re-entry never
          // rehydrates stale entries — matching the README "evicts its
          // knowledge-RAG entries" contract.
          await this._stepperKnowledgeBackend?.deleteSession(sid);
        };
        const body = await handleDeleteSession(
          this._sessionMetaStore,
          identity,
          sessionId,
          evictFn,
        );
        const status = body.ok ? 200 : 404;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
        return;
      }
    }
    // /v1/config or /config
    if (urlPath === '/v1/config' || urlPath === '/config') {
      if (req.method === 'GET') {
        const models = smartAgent.getActiveConfig();
        const agent = smartAgent.getAgentConfig();
        const body = { models, agent };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
        return;
      }
      if (req.method === 'PUT') {
        await this._handleConfigUpdate(req, res, smartAgent);
        return;
      }
      // 405 for other methods
      res.setHeader('Allow', 'GET, PUT, OPTIONS');
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(
        jsonError(
          `Method ${req.method} not allowed on ${urlPath}`,
          'invalid_request_error',
        ),
      );
      return;
    }
    if (
      req.method === 'GET' &&
      (urlPath === '/health' || urlPath === '/v1/health')
    ) {
      const status = await healthChecker.check();
      const httpCode = status.status === 'unhealthy' ? 503 : 200;
      res.writeHead(httpCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(status));
      return;
    }
    // POST /v1/messages or /messages → Anthropic adapter
    if (
      req.method === 'POST' &&
      (urlPath === '/v1/messages' || urlPath === '/messages')
    ) {
      const anthropicAdapter = adapterMap?.get('anthropic');
      if (!anthropicAdapter) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(jsonError('Anthropic adapter not registered', 'not_found'));
        return;
      }
      await this._withSession(req, res, async (graph, sessionId, traceId) => {
        await this._handleAdapterRequest(
          req,
          res,
          graph.agent ?? smartAgent,
          anthropicAdapter,
          { sessionId, traceId, graph },
        );
      });
      return;
    }
    if (
      req.method === 'POST' &&
      (urlPath === '/v1/chat/completions' || urlPath === '/chat/completions')
    ) {
      await this._withSession(req, res, async (graph, sessionId, traceId) => {
        await this._handleChat(
          req,
          res,
          requestLogger,
          graph.agent ?? smartAgent,
          chat,
          streamChat,
          log,
          modelProvider,
          { sessionId, traceId, graph },
        );
      });
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(
      jsonError(`Cannot ${req.method} ${urlPath}`, 'invalid_request_error'),
    );
  }

  private async _handleAdapterRequest(
    req: IncomingMessage,
    res: ServerResponse,
    agent: SmartAgent,
    adapter: ILlmApiAdapter,
    session?: { sessionId: string; traceId: string; graph: SessionGraph },
  ): Promise<void> {
    const raw = await readBody(req);
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(jsonError('Invalid JSON', 'invalid_request_error'));
      return;
    }

    let normalized: NormalizedRequest;
    try {
      normalized = adapter.normalizeRequest(body);
    } catch (err) {
      if (err instanceof AdapterValidationError) {
        res.writeHead(err.statusCode, { 'Content-Type': 'application/json' });
        res.end(jsonError(err.message, 'invalid_request_error'));
        return;
      }
      throw err;
    }

    // #171 (review#8): the adapter has already normalized Anthropic
    // tool_use/tool_result blocks into the OpenAI-shaped Message[]
    // (assistant.tool_calls + role:'tool' with tool_call_id). Run the same
    // external-results extraction the OpenAI path uses so Anthropic clients get
    // identical stateless-resume behaviour: consumed external turns are stripped
    // and their results threaded to the agent keyed by deterministic `ext:` id.
    const { results: externalResults, sanitizedMessages } =
      buildExternalResults(normalized.messages);

    const augmentedOptions = session
      ? {
          ...normalized.options,
          sessionId: session.sessionId,
          trace: { traceId: session.traceId },
          toolAvailability: session.graph.toolAvailability,
          pendingToolResults: session.graph.pendingToolResults,
          externalResults,
        }
      : { ...normalized.options, externalResults };

    if (normalized.stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      for await (const event of adapter.transformStream(
        agent.streamProcess(sanitizedMessages, augmentedOptions),
        normalized.context,
      )) {
        const eventLine = event.event ? `event: ${event.event}\n` : '';
        res.write(`${eventLine}data: ${event.data}\n\n`);
      }
      res.end();
      return;
    }

    // Non-streaming
    const result = await agent.process(sanitizedMessages, augmentedOptions);
    res.setHeader('Content-Type', 'application/json');
    if (!result.ok) {
      res.writeHead(500);
      res.end(
        JSON.stringify(
          adapter.formatError?.(result.error, normalized.context) ?? {
            error: {
              message: result.error.message,
              type: result.error.code,
            },
          },
        ),
      );
      return;
    }
    res.writeHead(200);
    res.end(
      JSON.stringify(adapter.formatResult(result.value, normalized.context)),
    );
  }

  private async _handleChat(
    req: IncomingMessage,
    res: ServerResponse,
    _requestLogger: IRequestLogger,
    smartAgent: SmartAgent,
    _chat: SmartAgentHandle['chat'],
    _streamChat: SmartAgentHandle['streamChat'],
    log: (e: Record<string, unknown>) => void,
    modelProvider?: IModelProvider,
    session?: { sessionId: string; traceId: string; graph: SessionGraph },
  ): Promise<void> {
    const rawBody = await readBody(req);
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(jsonError('Invalid JSON body', 'invalid_request_error'));
      return;
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !Array.isArray((parsed as Record<string, unknown>).messages)
    ) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        jsonError(
          'messages must be a non-empty array',
          'invalid_request_error',
        ),
      );
      return;
    }

    const body = parsed as {
      messages: Array<{
        role: string;
        content: unknown;
        tool_call_id?: unknown;
        tool_calls?: unknown;
      }>;
      model?: string;
      temperature?: number;
      max_tokens?: number;
      top_p?: number;
      stop?: string | string[];
      tools?: unknown[];
      stream?: boolean;
      stream_options?: { include_usage?: boolean };
    };

    const extractText = (c: unknown): string => {
      if (c === null || c === undefined) return '';
      if (typeof c === 'string') return c;
      if (!Array.isArray(c)) return '';
      return c
        .filter(
          (b): b is { type: 'text'; text: string } =>
            typeof b === 'object' &&
            b !== null &&
            (b as { type?: unknown }).type === 'text' &&
            typeof (b as { text?: unknown }).text === 'string',
        )
        .map((b) => b.text)
        .join('\n');
    };

    const userMessages = body.messages.filter((m) => m.role === 'user');
    if (userMessages.length === 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        jsonError(
          'at least one message with role "user" is required',
          'invalid_request_error',
        ),
      );
      return;
    }

    // Prefer the session injected by `_withSession` (cookie identity); fall
    // back to the legacy x-session-id header / 'default' bucket only when no
    // session was wired (defensive — production routes always inject one).
    const traceId = session?.traceId ?? randomUUID();
    const sessionId =
      session?.sessionId ??
      (req.headers['x-session-id'] as string) ??
      'default';
    const sessionLogger = new SessionLogger(
      this.cfg.logDir || null,
      sessionId,
      traceId,
    );
    const toolsValidationMode =
      this.cfg.agent?.externalToolsValidationMode ?? 'permissive';
    const externalToolsValidation = normalizeAndValidateExternalTools(
      body.tools,
    );
    const externalTools = externalToolsValidation.tools;
    if (externalToolsValidation.errors.length > 0) {
      log({
        event: 'invalid_external_tools_detected',
        traceId,
        sessionId,
        mode: toolsValidationMode,
        count: externalToolsValidation.errors.length,
        errors: externalToolsValidation.errors,
      });
      sessionLogger.logStep('invalid_external_tools_detected', {
        mode: toolsValidationMode,
        count: externalToolsValidation.errors.length,
        errors: externalToolsValidation.errors,
      });
      if (toolsValidationMode === 'strict') {
        const firstError = externalToolsValidation.errors[0];
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          jsonValidationError(
            firstError.message,
            firstError.code,
            firstError.param,
          ),
        );
        return;
      }
    }

    const t0 = Date.now();
    log({ event: 'request_start', stream: body.stream ?? false, traceId });

    const opts = {
      stream: body.stream,
      externalTools,
      sessionId,
      trace: { traceId },
      sessionLogger,
      model: body.model,
      ...(session
        ? {
            toolAvailability: session.graph.toolAvailability,
            pendingToolResults: session.graph.pendingToolResults,
          }
        : {}),
      ...(body.temperature !== undefined
        ? { temperature: body.temperature }
        : {}),
      ...(body.max_tokens !== undefined ? { maxTokens: body.max_tokens } : {}),
      ...(body.top_p !== undefined ? { topP: body.top_p } : {}),
      ...(body.stop !== undefined
        ? { stop: Array.isArray(body.stop) ? body.stop : [body.stop] }
        : {}),
    };

    const responseModel =
      body.model ?? modelProvider?.getModel() ?? 'smart-agent';

    const normalizedMessages = body.messages
      .map((m) => {
        const role = m.role as Message['role'];
        const normalizedMessage: Message = {
          role,
          content: extractText(m.content),
        };

        if (role === 'tool') {
          if (typeof m.tool_call_id === 'string' && m.tool_call_id.trim()) {
            normalizedMessage.tool_call_id = m.tool_call_id;
          } else {
            sessionLogger.logStep('drop_orphan_tool_message', {
              reason: 'missing_tool_call_id',
            });
            return null;
          }
        }

        if (role === 'assistant' && Array.isArray(m.tool_calls)) {
          const toolCalls = m.tool_calls
            .filter(
              (
                tc,
              ): tc is {
                id: string;
                type: 'function';
                function: { name: string; arguments: string };
              } =>
                typeof tc === 'object' &&
                tc !== null &&
                typeof (tc as { id?: unknown }).id === 'string' &&
                (tc as { type?: unknown }).type === 'function' &&
                typeof (tc as { function?: { name?: unknown } }).function
                  ?.name === 'string' &&
                typeof (tc as { function?: { arguments?: unknown } }).function
                  ?.arguments === 'string',
            )
            .map((tc) => ({
              id: tc.id,
              type: 'function' as const,
              function: {
                name: tc.function.name,
                arguments: tc.function.arguments,
              },
            }));

          if (toolCalls.length > 0) {
            normalizedMessage.tool_calls = toolCalls;
            if (!normalizedMessage.content) normalizedMessage.content = null;
          }
        }

        return normalizedMessage;
      })
      .filter((m): m is Message => m !== null);

    // #171 (review#11): consume external (client-executed) tool result turns
    // from the incoming history into a validated `extId → result` map and strip
    // those raw turns from the messages forwarded to the agent (so no internal
    // LLM call ever sees an unmatched assistant tool_calls). On a normal request
    // with no external history this returns the messages unchanged + an empty
    // map — a safe no-op. The map is threaded via options.externalResults.
    const { results: externalResults, sanitizedMessages } =
      buildExternalResults(normalizedMessages);

    const invalidToolsHeader =
      externalToolsValidation.errors.length > 0
        ? {
            'x-smartagent-invalid-tools': String(
              externalToolsValidation.errors.length,
            ),
          }
        : {};

    if (body.stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        ...invalidToolsHeader,
      });
      const id = `chatcmpl-${randomUUID()}`;
      const created = Math.floor(Date.now() / 1000);

      const stream = smartAgent.streamProcess(sanitizedMessages, {
        ...opts,
        externalResults,
      });
      let firstChunk = true;
      let finishReasonSent = false;
      let lastUsage: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
      } | null = null;

      for await (const chunk of stream) {
        if (!chunk.ok) {
          const errorChunk = {
            id,
            object: 'chat.completion.chunk',
            created,
            model: responseModel,
            choices: [
              {
                index: 0,
                delta: { content: `[Error] ${chunk.error.message}` },
                finish_reason: 'stop',
              },
            ],
          };
          res.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
          finishReasonSent = true;
          break;
        }
        // SSE heartbeat comment — keeps connection alive, ignored by clients
        if (chunk.value.heartbeat) {
          const hb = chunk.value.heartbeat;
          res.write(`: heartbeat tool=${hb.tool} elapsed=${hb.elapsed}ms\n\n`);
          continue;
        }
        // SSE timing breakdown comment — sent with the final chunk
        if (chunk.value.timing) {
          const parts = chunk.value.timing.map(
            (t: { phase: string; duration: number }) =>
              `${t.phase}=${t.duration}ms`,
          );
          res.write(`: timing ${parts.join(' ')}\n\n`);
        }
        if (chunk.value.usage) {
          lastUsage = {
            prompt_tokens: chunk.value.usage.promptTokens,
            completion_tokens: chunk.value.usage.completionTokens,
            total_tokens: chunk.value.usage.totalTokens,
          };
        }
        const baseResponse = {
          id,
          object: 'chat.completion.chunk',
          created,
          model: responseModel,
          usage: null,
        };

        if (firstChunk) {
          res.write(
            `data: ${JSON.stringify({ ...baseResponse, choices: [{ index: 0, delta: { role: 'assistant', content: chunk.value.content || '' }, finish_reason: null }] })}\n\n`,
          );
          firstChunk = false;
          if (!chunk.value.finishReason && !chunk.value.toolCalls) continue;
        }

        if (chunk.value.content || chunk.value.toolCalls) {
          const delta: Record<string, unknown> = {};
          if (chunk.value.content) delta.content = chunk.value.content;
          if (chunk.value.toolCalls) {
            delta.tool_calls = chunk.value.toolCalls.map(
              (call: StreamToolCall, index: number) => {
                const tc = toToolCallDelta(call, index);
                return {
                  index: tc.index,
                  id: tc.id,
                  type: 'function',
                  function: {
                    name: tc.name,
                    arguments: tc.arguments || '',
                  },
                };
              },
            );
          }
          res.write(
            `data: ${JSON.stringify({ ...baseResponse, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
          );
        }

        if (chunk.value.finishReason) {
          res.write(
            `data: ${JSON.stringify({ ...baseResponse, choices: [{ index: 0, delta: {}, finish_reason: mapStopReason(chunk.value.finishReason as StopReason) }] })}\n\n`,
          );
          finishReasonSent = true;
        }
      }

      if (!finishReasonSent) {
        const baseResponse = {
          id,
          object: 'chat.completion.chunk',
          created,
          model: responseModel,
          usage: null,
        };
        res.write(
          `data: ${JSON.stringify({ ...baseResponse, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`,
        );
      }

      if (
        (this.cfg.reportUsage !== false ||
          body.stream_options?.include_usage) &&
        lastUsage
      ) {
        res.write(
          `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: responseModel, choices: [], usage: lastUsage })}\n\n`,
        );
      }
      res.write('data: [DONE]\n\n');
      res.end();
      log({
        event: 'request_done',
        ok: true,
        stream: true,
        finishReason: finishReasonSent ? 'sent' : 'fallback_stop',
        durationMs: Date.now() - t0,
      });
      return;
    }

    const result = await smartAgent.process(sanitizedMessages, {
      ...opts,
      externalResults,
    });
    log({ event: 'request_done', ok: result.ok, durationMs: Date.now() - t0 });
    const finalContent = result.ok
      ? result.value.content ||
        (result.value.toolCalls ? null : '(no response)')
      : `Error: ${result.error.message}`;
    const finalFinishReason = result.ok
      ? mapStopReason(result.value.stopReason)
      : 'stop';
    let finalUsage = null;
    if (result.ok && result.value.usage) {
      finalUsage = {
        prompt_tokens: result.value.usage.promptTokens,
        completion_tokens: result.value.usage.completionTokens,
        total_tokens: result.value.usage.totalTokens,
      };
    }

    const message: Record<string, unknown> = {
      role: 'assistant',
      content: finalContent,
    };
    if (result.ok && result.value.toolCalls) {
      message.tool_calls = result.value.toolCalls;
    }

    res.writeHead(200, {
      'Content-Type': 'application/json',
      ...invalidToolsHeader,
    });
    res.end(
      JSON.stringify({
        id: `chatcmpl-${randomUUID()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: responseModel,
        choices: [
          {
            index: 0,
            message,
            finish_reason: finalFinishReason,
          },
        ],
        usage: finalUsage || {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
        },
      }),
    );
  }

  /** Whitelisted agent config fields allowed via PUT /v1/config. */
  private static readonly AGENT_CONFIG_FIELDS = new Set([
    'maxIterations',
    'maxToolCalls',
    'ragQueryK',
    'toolUnavailableTtlMs',
    'showReasoning',
    'historyAutoSummarizeLimit',
    'classificationEnabled',
  ]);

  private async _handleConfigUpdate(
    req: IncomingMessage,
    res: ServerResponse,
    smartAgent: SmartAgent,
  ): Promise<void> {
    const raw = await readBody(req);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(jsonError('Invalid JSON body', 'invalid_request_error'));
      return;
    }

    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        jsonError(
          'Request body must be a JSON object',
          'invalid_request_error',
        ),
      );
      return;
    }

    const body = parsed as Record<string, unknown>;

    // --- Validate agent fields against whitelist ---
    if (body.agent !== undefined) {
      if (
        typeof body.agent !== 'object' ||
        body.agent === null ||
        Array.isArray(body.agent)
      ) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          jsonError('"agent" must be a JSON object', 'invalid_request_error'),
        );
        return;
      }
      const agentFields = body.agent as Record<string, unknown>;
      const unsupported = Object.keys(agentFields).filter(
        (k) => !SmartServer.AGENT_CONFIG_FIELDS.has(k),
      );
      if (unsupported.length > 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          jsonError(
            `Unsupported agent config fields: ${unsupported.join(', ')}`,
            'invalid_request_error',
          ),
        );
        return;
      }
    }

    // --- Validate and resolve models (atomic: resolve ALL before mutating) ---
    let resolvedModels: SmartAgentReconfigureOptions | undefined;
    if (body.models !== undefined) {
      if (
        typeof body.models !== 'object' ||
        body.models === null ||
        Array.isArray(body.models)
      ) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          jsonError('"models" must be a JSON object', 'invalid_request_error'),
        );
        return;
      }
      if (!this.cfg.modelResolver) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          jsonError('model resolver not configured', 'invalid_request_error'),
        );
        return;
      }
      const modelFields = body.models as Record<string, unknown>;
      const validKeys = new Set([
        'mainModel',
        'classifierModel',
        'helperModel',
      ]);
      const unknownKeys = Object.keys(modelFields).filter(
        (k) => !validKeys.has(k),
      );
      if (unknownKeys.length > 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          jsonError(
            `Unknown model fields: ${unknownKeys.join(', ')}`,
            'invalid_request_error',
          ),
        );
        return;
      }
      try {
        const resolver = this.cfg.modelResolver;
        const [mainLlm, classifierLlm, helperLlm] = await Promise.all([
          modelFields.mainModel
            ? resolver.resolve(String(modelFields.mainModel), 'main')
            : undefined,
          modelFields.classifierModel
            ? resolver.resolve(
                String(modelFields.classifierModel),
                'classifier',
              )
            : undefined,
          modelFields.helperModel
            ? resolver.resolve(String(modelFields.helperModel), 'helper')
            : undefined,
        ]);
        resolvedModels = {};
        if (mainLlm) resolvedModels.mainLlm = mainLlm;
        if (classifierLlm) resolvedModels.classifierLlm = classifierLlm;
        if (helperLlm) resolvedModels.helperLlm = helperLlm;
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(jsonError(String(err), 'server_error'));
        return;
      }
    }

    // --- All validation passed — apply mutations ---
    if (resolvedModels) {
      smartAgent.reconfigure(resolvedModels);
      // Mirror onto the hoisted globals consumed by `buildSessionAgent` so
      // freshly-built session graphs pick up the new LLMs by reference
      // (otherwise `this._mainLlm` etc. would keep pointing at the originals
      // captured during `start()`).
      if (resolvedModels.mainLlm) this._mainLlm = resolvedModels.mainLlm;
      if (resolvedModels.classifierLlm)
        this._classifierLlm = resolvedModels.classifierLlm;
      if (resolvedModels.helperLlm) this._helperLlm = resolvedModels.helperLlm;
    }
    if (body.agent) {
      const patch = body.agent as Record<string, unknown>;
      smartAgent.applyConfigUpdate(patch);
      // Mirror onto `this.cfg.agent` so freshly-built session graphs (which
      // read `this.cfg.agent` in `buildSessionAgent`) observe the update.
      // Deep-merge to preserve untouched startup fields; replacing the whole
      // `agent` block would drop YAML defaults the validator already applied.
      const merged: Record<string, unknown> = {
        ...((this.cfg as { agent?: Record<string, unknown> }).agent ?? {}),
        ...patch,
      };
      (this.cfg as { agent?: Record<string, unknown> }).agent = merged;
    }
    // Invalidate per-session SmartAgents + the worker-LLM cache so the next
    // request mints a session graph that observes the just-applied config.
    // Without this, chat routes dispatch to `graph.agent` (the per-session
    // SmartAgent) which was built with the OLD config, and the PUT is a
    // no-op from the consumer's perspective. Failures are non-fatal so the
    // 200 response isn't blocked by a dispose hiccup.
    if (resolvedModels || body.agent) {
      // Fix #21: drain per-worker SmartAgentHandle.close() BEFORE clearing the
      // cache so MCP clients owned by the discarded handles disconnect.
      await drainWorkerCache(this._workerLlmCache);
      try {
        await this._lifecycle?.invalidateAll();
      } catch {
        // Swallow: cleanup errors must not turn a successful config update
        // into a 500. The next request will still get a fresh build because
        // `_workerLlmCache` is already cleared and dispose is idempotent.
      }
    }
    // --- Return updated config ---
    const models = smartAgent.getActiveConfig();
    const agent = smartAgent.getAgentConfig();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ models, agent }));
  }
}
