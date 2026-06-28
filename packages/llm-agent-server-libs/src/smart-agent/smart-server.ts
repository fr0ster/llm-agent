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
  ISmartAgent,
  IToolsRagHandle,
  LlmTool,
  LoadedPlugins,
  PluginExports,
  SubAgentRegistry,
} from '@mcp-abap-adt/llm-agent';
import {
  type IRag,
  isMcpUnavailable,
  isReadinessReporter,
  QueryEmbedding,
} from '@mcp-abap-adt/llm-agent';
import type {
  IPluginLoader,
  SessionAgentParts,
  SessionGraph,
  SmartAgent,
} from '@mcp-abap-adt/llm-agent-libs';
import {
  ClaudeSkillManager,
  CodexSkillManager,
  FileSystemPluginLoader,
  FileSystemSkillManager,
  getDefaultPluginDirs,
  HealthChecker,
  InMemoryKnowledgeBackend,
  type KnowledgeBackend,
  KnowledgeRag,
  makeLlm,
  mergePluginExports,
  SessionRequestLogger,
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
import { ConfigReloadWatcher } from './config-reload-watcher.js';
import { handleAdapterRequest } from './http/adapter-route-handler.js';
import { handleChat } from './http/chat-route-handler.js';
import {
  CORS_HEADERS,
  jsonError,
  readBody,
  writeNotReady,
} from './http/response-helpers.js';
import { HttpRouteTable, type RouteContext } from './http/route-table.js';
import {
  type IRoleLlmResolver,
  makeDefaultRoleLlm,
  RoleLlmResolver,
} from './llm/role-llm-resolver.js';
import { resolveAgentEmbedder } from './resolve-agent-embedder.js';

export { writeNotReady } from './http/response-helpers.js';

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
  /**
   * Ready-to-use MCP clients — parallel to `skillHost` (NOT an
   * `IMcpConnectionStrategy`). When present they are used DIRECTLY and take
   * precedence over `cfg.mcpClients`, plugin clients, and the YAML `mcp:` block:
   * NO connect runs (the embeddable `buildAgent(cfg)` path never forces a real
   * MCP connection). Inject `[]` to deliberately disable MCP.
   */
  mcpClients?: IMcpClient[];
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
import { makeKnowledgeBackend } from './knowledge/make-knowledge-backend.js';
import { makePgPool, makePgReadPool } from './pg-pool.js';
import type { ISessionMetaStore } from './session-meta-store.js';
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
// Worker-LLM cache + RAG-registry sharing (Task A7) — relocated to workers/
// ---------------------------------------------------------------------------

export {
  backfillWorkerCacheFromHandle,
  drainWorkerCache,
  type IWorkerRegistry,
  resolveWorkerLlmSet,
  type WorkerLlmSet,
  type WorkerRegistry,
} from './workers/worker-registry.js';

import {
  backfillWorkerCacheFromHandle,
  type IWorkerRegistry,
  resolveWorkerLlmSet,
  WorkerRegistry,
} from './workers/worker-registry.js';

// ---------------------------------------------------------------------------
// Session-lifecycle helpers — relocated to session-lifecycle/ (R3)
// Internal callers (SmartServer methods) import the value symbols they call;
// re-export the full public surface for the package barrel.
// ---------------------------------------------------------------------------

import {
  buildSessionLifecycle,
  handleDeleteSession,
  handleListSessions,
  handleResumeSession,
  recordSessionEnd,
  recordSessionStart,
  resolveSubAgentRagRegistry,
  type SessionLifecycle,
  seedSessionKnowledge,
} from './session-lifecycle/index.js';

export {
  buildSessionLifecycle,
  handleDeleteSession,
  handleListSessions,
  handleResumeSession,
  recordSessionEnd,
  recordSessionStart,
  resolveSubAgentRagRegistry,
  type SessionLifecycle,
  type SessionLifecycleOptions,
  type SessionListBody,
  type SessionResumeBody,
  seedSessionKnowledge,
} from './session-lifecycle/index.js';

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
      if (!listed.ok) {
        // FAIL LOUD on an availability failure: a transient listTools() outage must
        // NOT make the tool look merely absent (→ "Tool not found"/tool-blind). A
        // benign error (this client genuinely can't list) falls through to the next.
        if (isMcpUnavailable(listed.error)) throw listed.error;
        continue;
      }
      const owns = listed.value.some((t) => t.name === name);
      if (!owns) continue;
      const result = await client.callTool(name, safeArgs);
      if (!result.ok) {
        // Availability failure → fail loud; a tool-level error → LLM feedback text.
        if (isMcpUnavailable(result.error)) throw result.error;
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
   * GLOBAL per-worker LLM/embedder cache registry. Populated lazily by `buildSubAgent`
   * the first time each worker name is seen; subsequent per-session re-wires
   * pull from the cache by reference (never reconstructing LLM clients).
   * Constructed in `_buildInfra` after embedder factories are resolved.
   */
  private _workers!: IWorkerRegistry;
  /**
   * Declarative HTTP route table built once; `_handle` delegates to its
   * `dispatch`. Replaces the former ~300-line if/else route chain.
   */
  private readonly _routeTable = this._buildRouteTable();
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
  private _roleLlm?: IRoleLlmResolver;
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
   * True when the consumer injected an MCP seam (`BuildAgentDeps.mcpClients` or
   * `connectMcp`). In that case MCP is provisioned ONLY through the seam (the
   * embeddable path must never force a real connect / builder self-connect). When
   * false (default), the YAML `mcp:` path keeps the builder-owned connect so the
   * builder VECTORIZES the tools into `toolsRag` (the ToolSelect ranking contract;
   * see mcp-yaml-vectorization.test.ts).
   */
  private readonly _mcpSeamInjected: boolean;
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
    Pick<BuildAgentDeps, 'skillHost' | 'embedder' | 'mcpClients'>;

  constructor(config: SmartServerConfig, deps: BuildAgentDeps = {}) {
    this.cfg = config;
    this._mcpSeamInjected =
      deps.mcpClients !== undefined || deps.connectMcp !== undefined;
    this._deps = {
      makeLlm: deps.makeLlm ?? ((cfg) => this._makeLlmDefault(cfg)),
      resolveEmbedder: deps.resolveEmbedder ?? resolveEmbedder,
      prefetchEmbedderFactories:
        deps.prefetchEmbedderFactories ?? prefetchEmbedderFactories,
      buildSkillHost: deps.buildSkillHost ?? buildSkillHostFromConfig,
      connectMcp: deps.connectMcp ?? connectMcpClientsFromConfig,
      ...(deps.skillHost ? { skillHost: deps.skillHost } : {}),
      ...(deps.embedder ? { embedder: deps.embedder } : {}),
      ...(deps.mcpClients ? { mcpClients: deps.mcpClients } : {}),
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

  /**
   * Assemble and return the server INFRA bundle ONLY — every shared resource
   * needed by both the HTTP `_start()` path and the embeddable
   * `_buildEmbeddedAgent()` path: the infra/passthrough `smartAgent`, the
   * server-only locals (`chat`/`streamChat`/`requestLogger`/etc.), the resolved
   * `globalMcpClients`/`globalRagRegistry`, and the `closeFns` loop (exposed as
   * `close`). It does NOT build the `'embedded'` pipeline instance — that idle
   * coordinator is built only on the embeddable path (see `_buildEmbeddedAgent`),
   * so a plain `start()` no longer pays for a coordinator it never serves.
   */
  private async _buildInfra(): Promise<{
    close: () => Promise<void>;
    chat: SmartAgentHandle['chat'];
    streamChat: SmartAgentHandle['streamChat'];
    requestLogger: IRequestLogger;
    smartAgent: SmartAgent;
    globalMcpClients: IMcpClient[] | undefined;
    globalRagRegistry: IRagRegistry;
    log: (e: Record<string, unknown>) => void;
    healthChecker: HealthChecker;
    modelProvider?: IModelProvider;
    adapterMap?: Map<string, ILlmApiAdapter>;
  }> {
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
    this._roleLlm = new RoleLlmResolver({
      getMain: () => this._mainLlm,
      getHelper: () => this._helperLlm,
      getClassifier: () => this._classifierLlm,
      getLlmMap: () => this._llmMap,
      getPipelineFallback: () => this._pipelineFallback,
      makeLlm: (lc) => this._deps.makeLlm(lc),
    });

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

    // Construct the WorkerRegistry (owns the per-worker LLM cache + build loop).
    // Both _fileLogger (set at the top of _buildInfra) and _mergedEmbedderFactories
    // (set above) are captured lazily via the accessor callbacks, so construction
    // here precedes the first use of this._workers.
    this._workers = new WorkerRegistry({
      subAgentConfigs: this.cfg.subAgentConfigs,
      getFileLogger: () => this._fileLogger,
      getEmbedderFactories: () => this._mergedEmbedderFactories ?? {},
      buildSubAgent: (name, subCfg, parentLogger, factories, injected) =>
        this.buildSubAgent(
          name,
          subCfg as Omit<SmartServerConfig, 'log'>,
          parentLogger,
          factories,
          injected,
        ),
    });

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

    // MCP clients (BuildAgentDeps.mcpClients > DI cfg.mcpClients > plugin > YAML).
    // P1b: `this._deps.mcpClients` is the embeddable seam's ready-client override —
    // when present it short-circuits ALL connect paths (parallel to skillHost). The
    // YAML `mcp:` block is otherwise NOT pre-connected here — see the branch below.
    const diOrPluginMcpClients =
      this._deps.mcpClients ??
      this.cfg.mcpClients ??
      (plugins.mcpClients.length > 0 ? plugins.mcpClients : undefined);

    // ---- Knowledge backend (no MCP dependency) ----------------------------
    // The remaining shared pipeline infra (`_sharedMcpClients` + the
    // `_toolsRagHandle` MCP catalog) is MCP-client-dependent and is resolved
    // per-branch below — for the YAML-only path it must run AFTER `build()`
    // connects + vectorizes (the builder owns that single connection).
    this.buildKnowledgeBackend();

    // ---- MCP connection strategy (exactly ONE connection) -----------------
    // P1b: MCP is ALWAYS provisioned through the injected `BuildAgentDeps` seam so
    // the embeddable `buildAgent(cfg)` path never forces a real connect. Two
    // sources, ONE provisioning point:
    //
    //   • Ready clients present (`_deps.mcpClients` / `cfg.mcpClients` / plugin
    //     clients, captured as `diOrPluginMcpClients`) → inject them into the
    //     startup builder via `withMcpClients` (builder short-circuits its own
    //     `cfg.mcp` auto-connect). `_sharedMcpClients` = that exact set, and the
    //     `_toolsRagHandle` catalog is built now over them.
    //
    //   • No ready clients but a YAML `mcp:` block → provision ONCE via the seam
    //     (`this._deps.connectMcp(this.cfg.mcp)`; default = real connect, an
    //     embedded host can inject a stub) and inject those clients too, so the
    //     builder does NOT self-connect from `cfg.mcp` (single provisioning
    //     point). The `_toolsRagHandle` catalog is built over the connected set.
    //     (Tool ranking falls back to the MCP catalog, same as the ready-client
    //     path; the builder no longer vectorizes the YAML `mcp:` block itself.)
    //
    //   • No clients and no `mcp:` block → undefined; no MCP wiring at all.
    // Precedence: a ready client set (even an EMPTY array) overrides YAML `mcp:`.
    // `cfg.mcpClients: []` (or `_deps.mcpClients: []`) is a deliberate "disable
    // MCP / override plugin+YAML" signal — it takes the inject branch (inject `[]`
    // → builder short-circuits → no YAML connect), NOT the YAML connect branch. So
    // gate on presence (`!== undefined`), not length.
    const hasReadyClients = diOrPluginMcpClients !== undefined;
    // YAML `mcp:` with NO ready clients AND NO injected seam → keep the legacy
    // builder-owned connect so the builder VECTORIZES the tools (the ToolSelect
    // ranking contract). `_sharedMcpClients` + the tools-RAG handle are harvested
    // from the built handle AFTER `build()` (see the harvest block below). When
    // the seam IS injected we provision through it instead (no builder connect).
    const yamlBuilderConnect =
      !hasReadyClients && !!this.cfg.mcp && !this._mcpSeamInjected;

    let mcpClients: IMcpClient[] | undefined;
    if (hasReadyClients) {
      mcpClients = diOrPluginMcpClients;
    } else if (this.cfg.mcp && this._mcpSeamInjected) {
      // Injected seam + YAML `mcp:` → the seam is the SINGLE provisioning point
      // (the embeddable path must never force a real connect). Stash on
      // `_stepperMcpClients` so the idempotent guard inside
      // buildSharedPipelineInfra does not connect a second time.
      this._stepperMcpClients = await this._deps.connectMcp(this.cfg.mcp);
      mcpClients = this._stepperMcpClients;
    } else {
      // No MCP, or the YAML-builder-connect path (mcpClients stays undefined so
      // the builder receives `cfg.mcp` and connects + vectorizes itself).
      mcpClients = undefined;
    }
    // Resolve `_sharedMcpClients` + the tools-RAG handle catalog over the
    // provisioned set for every path EXCEPT yamlBuilderConnect, which resolves
    // them AFTER `build()` from the harvested handle (knowledge backend is
    // idempotent; already built above).
    if (!yamlBuilderConnect) {
      await this.buildSharedPipelineInfra({
        toolsRag,
        resolvedEmbedder,
        mcpClients,
      });
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

    // ---- YAML-builder-connect MCP harvest (single-connect + vectorization) ----
    // Only on the `yamlBuilderConnect` path (YAML `mcp:`, no ready clients, no
    // injected seam) did the startup builder OWN the connection AND vectorize the
    // tools into `toolsRag`. Harvest its connected set into `_sharedMcpClients` so
    // `ctx.callMcp` + per-session agents reuse the SAME single connection (no
    // second connect), then build the tools-RAG handle catalog over it. Every
    // other path already resolved these in buildSharedPipelineInfra before build().
    if (yamlBuilderConnect) {
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
      await this._workers.drain();
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
      const reloadWatcher = new ConfigReloadWatcher({
        configFile: this.cfg.configFile,
        log,
        applyAgentUpdate: (u) => smartAgent.applyConfigUpdate(u),
        mirrorCfg: (agentPatch, prompts) => {
          if (Object.keys(agentPatch).length > 0) {
            (this.cfg as { agent?: Record<string, unknown> }).agent = {
              ...((this.cfg as { agent?: Record<string, unknown> }).agent ??
                {}),
              ...agentPatch,
            };
          }
          if (
            prompts.ragTranslate !== undefined ||
            prompts.historySummary !== undefined
          ) {
            const merged: Record<string, unknown> = {
              ...((this.cfg as { prompts?: Record<string, unknown> }).prompts ??
                {}),
            };
            if (prompts.ragTranslate !== undefined)
              merged.ragTranslate = prompts.ragTranslate;
            if (prompts.historySummary !== undefined)
              merged.historySummary = prompts.historySummary;
            (this.cfg as { prompts?: Record<string, unknown> }).prompts =
              merged;
          }
        },
        drainWorkers: () => this._workers.drain(),
        invalidateSessions: () =>
          this._lifecycle?.invalidateAll() ?? Promise.resolve(),
        ragStores,
      });
      reloadWatcher.start();
      closeFns.push(() => reloadWatcher.stop());
    }

    const { requestLogger } = agentHandle;

    return {
      close: async () => {
        for (const fn of closeFns) await fn();
      },
      chat,
      streamChat,
      requestLogger,
      // Infra/passthrough startup agent — `_start()` serves infra endpoints
      // (HealthChecker / /v1/models) from this.
      smartAgent,
      // Resolved globals the embeddable path needs to assemble the `'embedded'`
      // SessionAgentParts (the HTTP path serves per-session graphs instead).
      globalMcpClients,
      globalRagRegistry,
      log,
      healthChecker,
      modelProvider,
      adapterMap,
    };
  }

  /**
   * Build the embeddable COORDINATED agent for the free `buildAgent(cfg)` path.
   *
   * `_buildInfra().smartAgent` is the INFRA/passthrough startup agent — it has
   * NO coordinator, so it would never run the configured pipeline. The HTTP
   * `start()` path serves the PER-SESSION `graph.agent` (built lazily via
   * buildSessionAgent → buildPipelineInstance) and keeps using `smartAgent` for
   * infra endpoints (/v1/models, health). But the embeddable `buildAgent(cfg)`
   * consumer has no session lifecycle, so it must receive a fully COORDINATED
   * agent. Build ONE pipeline instance via the SAME path a session uses — an
   * `'embedded'` session — over the shared infra, and return ITS agent. This is
   * the ONLY caller that builds the embedded instance, so `start()` no longer
   * pays for an idle coordinator it never serves.
   *
   * @internal — reached only by the same-module free `buildAgent(cfg)`; not part
   * of the documented public API. Public (not `private`) solely so that seam can
   * call it by name (a `private` reached only via an external cast trips
   * `noUnusedLocals`).
   */
  async _buildEmbeddedAgent(): Promise<{
    agent: ISmartAgent;
    close: () => Promise<void>;
  }> {
    const infra = await this._buildInfra();
    // If the pipeline-instance build throws, the infra (LLM clients, MCP, skill
    // host, pg pools) is already live — tear it down before propagating so a
    // failed embedded build never leaks the infra.
    let inst: IPipelineInstance;
    try {
      inst = await this.buildPipelineInstance({
        sessionId: 'embedded',
        parts: this._embeddedSessionParts(
          infra.globalMcpClients,
          infra.globalRagRegistry,
        ),
      });
    } catch (e) {
      await infra.close().catch(() => {});
      throw e;
    }
    return {
      // PUBLIC embeddable agent = the coordinated pipeline instance's agent.
      agent: inst.agent,
      // Dispose the pipeline instance FIRST, then the shared infra. `finally`
      // guarantees `infra.close()` runs even if `inst.close()` throws.
      close: async () => {
        try {
          await inst.close();
        } finally {
          await infra.close();
        }
      },
    };
  }

  /**
   * Assemble the `SessionAgentParts` for the single `'embedded'` pipeline
   * instance returned by `_buildEmbeddedAgent` (the embeddable `buildAgent(cfg)`
   * path).
   * Mirrors EXACTLY what the session lifecycle passes to `buildSessionAgent`:
   * the global mcpClients + the global ragRegistry + the global tools store,
   * with a fresh per-(embedded-)session request logger.
   */
  private _embeddedSessionParts(
    mcpClients: IMcpClient[] | undefined,
    ragRegistry: IRagRegistry,
  ): SessionAgentParts {
    return {
      sessionId: 'embedded',
      mcpClients: mcpClients ?? this._sharedMcpClients ?? [],
      toolsRag: this._toolsRag,
      ragRegistry,
      logger: new SessionRequestLogger(),
    };
  }

  private async _start(): Promise<SmartServerHandle> {
    const built = await this._buildInfra();
    const {
      chat,
      streamChat,
      requestLogger,
      smartAgent,
      log,
      healthChecker,
      modelProvider,
      adapterMap,
    } = built;

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
            //    `built.close()` runs the same `closeFns` loop the original
            //    inline close did — order preserved.
            await built.close();
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
      cache: this._workers.cache,
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
      const entry = this._workers.cache.get(name);
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
    return makeDefaultRoleLlm(lc, this._mainTemp);
  }

  /** Resolve a per-role LLM through the normalized map → pipelineFallback chain.
   *  'main' returns the captured mainLlm; 'helper'/'classifier' return the
   *  prebuilt instances when present; otherwise the map/fallback config is built. */
  private async resolveRoleLlm(role: string): Promise<ILlm> {
    if (!this._roleLlm) {
      throw new Error(
        'resolveRoleLlm invoked before _buildInfra built the resolver',
      );
    }
    return this._roleLlm.resolve(role);
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
    this._stepperKnowledgeBackend = makeKnowledgeBackend({
      logDir: this.cfg.logDir,
      embedder: this._resolvedEmbedder,
    });
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
   * session's logger + the CACHED per-worker LLM/embedder (this._workers.cache).
   * NEVER reconstructs LLM clients; NEVER reuses the global registry.
   *
   * Delegates to `this._workers.build(parts)` (WorkerRegistry).
   */
  private async buildWorkerRegistry(
    parts: SessionAgentParts,
  ): Promise<SubAgentRegistry> {
    return this._workers.build(parts);
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
   * (this._workers.cache) via `createAgentBuilder`. It NEVER reuses the primary
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
    // Server readiness: derived from the agent's MCP connection strategy (it
    // implements IReadinessReporter). No strategy / non-reporting ⇒ ready
    // (readiness unknown). Computed ONCE here and reused by /health and the
    // pre-dispatch request gate (messages/chat) via `rc.ready`.
    const ready = isReadinessReporter(smartAgent) ? smartAgent.isReady() : true;
    const rc: RouteContext = {
      req,
      res,
      rawUrl,
      urlPath,
      method: req.method ?? 'GET',
      ready,
      server: this,
      requestLogger,
      smartAgent,
      chat,
      streamChat,
      log,
      healthChecker,
      modelProvider,
      adapterMap,
    };
    await this._routeTable.dispatch(rc);
  }

  /**
   * Declarative route table replacing `_handle`'s if/else chain. Routes are
   * registered in the EXACT order the original chain checked them (first
   * method+path match wins), so dispatch is behaviour-identical. Each handler
   * body is the corresponding original branch moved verbatim, with `this`
   * accessed through `rc.server` and the request locals read from `rc`.
   */
  private _buildRouteTable(): HttpRouteTable {
    const table = new HttpRouteTable();
    table.add({
      method: 'GET',
      match: (p) => p === '/v1/models' || p === '/models',
      handle: async (rc) => {
        const queryString = rc.rawUrl.includes('?')
          ? rc.rawUrl.split('?')[1]
          : '';
        const queryParams = new URLSearchParams(queryString);
        const excludeEmbedding =
          queryParams.get('exclude_embedding') === 'true';
        let data: Array<Record<string, unknown>> = [
          { id: 'smart-agent', object: 'model', owned_by: 'smart-agent' },
        ];
        if (rc.modelProvider) {
          const result = await rc.modelProvider.getModels({ excludeEmbedding });
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
              ...(m.deprecated !== undefined
                ? { deprecated: m.deprecated }
                : {}),
            }));
          }
        }
        rc.res.writeHead(200, { 'Content-Type': 'application/json' });
        rc.res.end(JSON.stringify({ object: 'list', data }));
      },
    });
    table.add({
      method: 'GET',
      match: (p) => p === '/v1/embedding-models' || p === '/embedding-models',
      handle: async (rc) => {
        let data: Array<Record<string, unknown>> = [];
        if (rc.modelProvider?.getEmbeddingModels) {
          const result = await rc.modelProvider.getEmbeddingModels();
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
              ...(m.deprecated !== undefined
                ? { deprecated: m.deprecated }
                : {}),
            }));
          }
        }
        rc.res.writeHead(200, { 'Content-Type': 'application/json' });
        rc.res.end(JSON.stringify({ object: 'list', data }));
      },
    });
    table.add({
      method: 'GET',
      match: (p) => p === '/v1/usage',
      handle: async (rc) => {
        const lifecycle = rc.server._lifecycle;
        if (!lifecycle) {
          rc.res.writeHead(500, { 'Content-Type': 'application/json' });
          rc.res.end(
            jsonError('Session lifecycle not initialized', 'server_error'),
          );
          return;
        }
        const isHttps =
          (rc.req.socket as { encrypted?: boolean }).encrypted === true ||
          rc.req.headers['x-forwarded-proto'] === 'https';
        const resolved = lifecycle.resolve(rc.req.headers['cookie'], isHttps);
        if (resolved.minted && resolved.setCookie) {
          rc.res.setHeader('Set-Cookie', resolved.setCookie);
        }
        const sessionId = resolved.identity.sessionId;
        const graph = await lifecycle.acquire(sessionId);
        try {
          rc.res.writeHead(200, { 'Content-Type': 'application/json' });
          rc.res.end(JSON.stringify(graph.logger.getSummary()));
        } finally {
          lifecycle.release(sessionId, graph);
        }
      },
    });
    // GET /v1/sessions — list sessions for the current identity
    table.add({
      method: 'GET',
      match: (p) => p === '/v1/sessions',
      handle: async (rc) => {
        const lifecycle = rc.server._lifecycle;
        if (!lifecycle) {
          rc.res.writeHead(500, { 'Content-Type': 'application/json' });
          rc.res.end(
            jsonError('Session lifecycle not initialized', 'server_error'),
          );
          return;
        }
        const isHttps =
          (rc.req.socket as { encrypted?: boolean }).encrypted === true ||
          rc.req.headers['x-forwarded-proto'] === 'https';
        const resolved = lifecycle.resolve(rc.req.headers['cookie'], isHttps);
        if (resolved.minted && resolved.setCookie) {
          rc.res.setHeader('Set-Cookie', resolved.setCookie);
        }
        const identity = resolved.identity.sessionId;
        const body = await handleListSessions(
          rc.server._sessionMetaStore,
          identity,
        );
        rc.res.writeHead(200, { 'Content-Type': 'application/json' });
        rc.res.end(JSON.stringify(body));
      },
    });
    // POST /v1/sessions/:id/resume — resume a session
    table.add({
      method: 'POST',
      match: (p) => p.match(/^\/v1\/sessions\/([^/]+)\/resume$/) ?? false,
      handle: async (rc) => {
        const resumeMatch = rc.urlPath.match(
          /^\/v1\/sessions\/([^/]+)\/resume$/,
        );
        if (!resumeMatch) return;
        const sessionId = resumeMatch[1];
        const lifecycle = rc.server._lifecycle;
        if (!lifecycle) {
          rc.res.writeHead(500, { 'Content-Type': 'application/json' });
          rc.res.end(
            jsonError('Session lifecycle not initialized', 'server_error'),
          );
          return;
        }
        const isHttps =
          (rc.req.socket as { encrypted?: boolean }).encrypted === true ||
          rc.req.headers['x-forwarded-proto'] === 'https';
        const resolved = lifecycle.resolve(rc.req.headers['cookie'], isHttps);
        if (resolved.minted && resolved.setCookie) {
          rc.res.setHeader('Set-Cookie', resolved.setCookie);
        }
        const identity = resolved.identity.sessionId;
        const body = await handleResumeSession(
          rc.server._sessionMetaStore,
          identity,
          sessionId,
        );
        const status = body.ok ? 200 : 404;
        rc.res.writeHead(status, { 'Content-Type': 'application/json' });
        rc.res.end(JSON.stringify(body));
      },
    });
    // DELETE /v1/sessions/:id — delete a session
    table.add({
      method: 'DELETE',
      match: (p) => p.match(/^\/v1\/sessions\/([^/]+)$/) ?? false,
      handle: async (rc) => {
        const deleteMatch = rc.urlPath.match(/^\/v1\/sessions\/([^/]+)$/);
        if (!deleteMatch) return;
        const sessionId = deleteMatch[1];
        const lifecycle = rc.server._lifecycle;
        if (!lifecycle) {
          rc.res.writeHead(500, { 'Content-Type': 'application/json' });
          rc.res.end(
            jsonError('Session lifecycle not initialized', 'server_error'),
          );
          return;
        }
        const isHttps =
          (rc.req.socket as { encrypted?: boolean }).encrypted === true ||
          rc.req.headers['x-forwarded-proto'] === 'https';
        const resolved = lifecycle.resolve(rc.req.headers['cookie'], isHttps);
        if (resolved.minted && resolved.setCookie) {
          rc.res.setHeader('Set-Cookie', resolved.setCookie);
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
          await rc.server._stepperKnowledgeBackend?.deleteSession(sid);
        };
        const body = await handleDeleteSession(
          rc.server._sessionMetaStore,
          identity,
          sessionId,
          evictFn,
        );
        const status = body.ok ? 200 : 404;
        rc.res.writeHead(status, { 'Content-Type': 'application/json' });
        rc.res.end(JSON.stringify(body));
      },
    });
    // /v1/config or /config — any method (dispatches GET/PUT/405 internally)
    table.add({
      method: '*',
      match: (p) => p === '/v1/config' || p === '/config',
      handle: async (rc) => {
        if (rc.method === 'GET') {
          const models = rc.smartAgent.getActiveConfig();
          const agent = rc.smartAgent.getAgentConfig();
          const body = { models, agent };
          rc.res.writeHead(200, { 'Content-Type': 'application/json' });
          rc.res.end(JSON.stringify(body));
          return;
        }
        if (rc.method === 'PUT') {
          await rc.server._handleConfigUpdate(rc.req, rc.res, rc.smartAgent);
          return;
        }
        // 405 for other methods
        rc.res.setHeader('Allow', 'GET, PUT, OPTIONS');
        rc.res.writeHead(405, { 'Content-Type': 'application/json' });
        rc.res.end(
          jsonError(
            `Method ${rc.req.method} not allowed on ${rc.urlPath}`,
            'invalid_request_error',
          ),
        );
      },
    });
    table.add({
      method: 'GET',
      match: (p) => p === '/health' || p === '/v1/health',
      handle: async (rc) => {
        const status = await rc.healthChecker.check();
        // MCP-down ⇒ NOT_READY ⇒ 503 too (not just LLM-unhealthy), so a load
        // balancer stops routing while MCP is unreachable.
        const httpCode = status.status === 'unhealthy' || !rc.ready ? 503 : 200;
        rc.res.writeHead(httpCode, { 'Content-Type': 'application/json' });
        rc.res.end(JSON.stringify({ ...status, ready: rc.ready }));
      },
    });
    // POST /v1/messages or /messages → Anthropic adapter
    table.add({
      method: 'POST',
      match: (p) => p === '/v1/messages' || p === '/messages',
      handle: async (rc) => {
        // Pre-dispatch readiness gate: fail loud (503) BEFORE opening any stream.
        if (!rc.ready) {
          writeNotReady(rc.res);
          return;
        }
        const anthropicAdapter = rc.adapterMap?.get('anthropic');
        if (!anthropicAdapter) {
          rc.res.writeHead(404, { 'Content-Type': 'application/json' });
          rc.res.end(
            jsonError('Anthropic adapter not registered', 'not_found'),
          );
          return;
        }
        await rc.server._withSession(
          rc.req,
          rc.res,
          async (graph, sessionId, traceId) => {
            await handleAdapterRequest(
              rc.req,
              rc.res,
              graph.agent ?? rc.smartAgent,
              anthropicAdapter,
              { sessionId, traceId, graph },
            );
          },
        );
      },
    });
    table.add({
      method: 'POST',
      match: (p) => p === '/v1/chat/completions' || p === '/chat/completions',
      handle: async (rc) => {
        // Pre-dispatch readiness gate: fail loud (503) BEFORE opening any SSE stream.
        if (!rc.ready) {
          writeNotReady(rc.res);
          return;
        }
        await rc.server._withSession(
          rc.req,
          rc.res,
          async (graph, sessionId, traceId) => {
            await handleChat(
              rc.req,
              rc.res,
              rc.requestLogger,
              graph.agent ?? rc.smartAgent,
              rc.chat,
              rc.streamChat,
              rc.log,
              rc.modelProvider,
              { sessionId, traceId, graph },
              this.cfg,
            );
          },
        );
      },
    });
    return table;
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
      await this._workers.drain();
      try {
        await this._lifecycle?.invalidateAll();
      } catch {
        // Swallow: cleanup errors must not turn a successful config update
        // into a 500. The next request will still get a fresh build because
        // `_workers.cache` is already cleared and dispose is idempotent.
      }
    }
    // --- Return updated config ---
    const models = smartAgent.getActiveConfig();
    const agent = smartAgent.getAgentConfig();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ models, agent }));
  }
}

/** Build a runnable agent for any configured pipeline WITHOUT binding a port.
 *  `SmartServer.start()` is the default impl that adds HTTP `listen` on top. */
export async function buildAgent(
  cfg: SmartServerConfig,
  deps?: BuildAgentDeps,
): Promise<{ agent: ISmartAgent; close: () => Promise<void> }> {
  const server = new SmartServer(cfg, deps);
  const built = await server._buildEmbeddedAgent();
  return { agent: built.agent, close: built.close };
}
