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
  EmbedderFactory,
  IClientAdapter,
  IEmbedder,
  IKnowledgeRagHandle,
  ILlm,
  ILlmApiAdapter,
  ILlmCallStrategy,
  ILogger,
  IMcpClient,
  IModelProvider,
  IModelResolver,
  IOutputValidator,
  IPipelineInstance,
  IPipelinePlugin,
  IPluginLoader,
  IQueryExpander,
  IRagProviderRegistry,
  IRagRegistry,
  IRequestLogger,
  IReranker,
  IRetrievalEmbedder,
  IRetrievalStrategy,
  ISkillManager,
  ISkillPluginHost,
  ISmartAgent,
  IThrottleStrategy,
  IToolNamespace,
  IToolSelectionStrategy,
  IToolsRagHandle,
  LlmTool,
  LoadedPlugins,
  McpCallResult,
  McpClientDescriptor,
  NamespaceClientInput,
  PipelinePluginFactory,
  PluginExports,
  SubAgentRegistry,
} from '@mcp-abap-adt/llm-agent';
import {
  asymmetricEmbedder,
  buildNamespacedTools,
  CircuitBreaker,
  defaultToolNamespace,
  type IAuxiliaryMcpTools,
  type IMcpFailureClassifier,
  type IProbabilityDecision,
  type IRag,
  type IRunExecutionControl,
  type IStepExecutionControl,
  type IWaitStrategy,
  isReadinessReporter,
  symmetricEmbedder,
  type ToolLoopContextStrategyFactory,
  withCircuitBreaker,
} from '@mcp-abap-adt/llm-agent';
import type {
  SessionAgentParts,
  SessionGraph,
  SessionGraphIdentity,
  SmartAgent,
} from '@mcp-abap-adt/llm-agent-libs';
import {
  applyRetrievalStrategy,
  ClaudeSkillManager,
  CodexSkillManager,
  FileSystemPluginLoader,
  FileSystemSkillManager,
  getDefaultPluginDirs,
  HealthChecker,
  InMemoryKnowledgeBackend,
  type KnowledgeBackend,
  KnowledgeRag,
  mergePluginExports,
  SessionRequestLogger,
  SmartAgentBuilder,
  type SmartAgentHandle,
  SmartAgentSubAgent,
  WindowContextStrategy,
} from '@mcp-abap-adt/llm-agent-libs';
import {
  DefaultMcpFailureClassifier,
  MCPClientWrapper,
  McpClientAdapter,
} from '@mcp-abap-adt/llm-agent-mcp';
import type { EmbedderResolutionOptions } from '@mcp-abap-adt/llm-agent-rag';
import {
  prefetchEmbedderFactories,
  SimpleRagProviderRegistry,
} from '@mcp-abap-adt/llm-agent-rag';
import { PACKAGE_VERSION } from '../generated/version.js';
import { ConfigReloadWatcher } from './config-reload-watcher.js';
import { handleAdapterRequest } from './http/adapter-route-handler.js';
import { handleChat } from './http/chat-route-handler.js';
import {
  handleConfigUpdate,
  type IConfigUpdateTarget,
} from './http/config-route-handler.js';
import { handleHealthRoute } from './http/health-route-handler.js';
import {
  handleEmbeddingModelsList,
  handleModelsList,
} from './http/models-route-handler.js';
import {
  CORS_HEADERS,
  jsonError,
  writeNotReady,
} from './http/response-helpers.js';
import { HttpRouteTable, type RouteContext } from './http/route-table.js';
import {
  handleSessionDelete,
  handleSessionResume,
  handleSessionsList,
} from './http/sessions-route-handler.js';
import { handleUsageRoute } from './http/usage-route-handler.js';
import { listedToolsOrThrow } from './listed-tools.js';
import { LlmCircuitBreakers } from './llm/llm-circuit-breakers.js';
import {
  type IRoleLlmResolver,
  RoleLlmResolver,
} from './llm/role-llm-resolver.js';
import {
  assertRagConfigShape,
  embedderSectionFor,
  type MakeRagInput,
  type SmartServerEmbedderConfig,
  type SmartServerRagConfig,
  toMakeRagInput,
} from './rag-config.js';
import { resolveRetrievalEmbedder } from './resolve-agent-embedder.js';
import { resolveReranker } from './resolve-reranker.js';
import {
  resolveRetrievalStrategies,
  unknownRetrievalKeyWarnings,
} from './resolve-retrieval.js';
import { makeToolsRagHandle } from './tools-rag-handle.js';
import { assertWorkerLlmConfig, parseWorkerLlm } from './worker-llm.js';

export { writeNotReady } from './http/response-helpers.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface SmartServerLlmConfig {
  /** Provider id for the flat schema. Required when no pipeline.llm.main is set. */
  provider?: 'deepseek' | 'openai' | 'anthropic' | 'sap-ai-sdk' | 'ollama';
  /**
   * Names the account this role uses; the composition root resolves it to a
   * credential. Omit it and the root's default entry applies. Never a secret:
   * the value never enters this object, which is what `${VAR}` got wrong (§4.6.2).
   */
  credentialRef?: string;
  /** Custom base URL (OpenAI-compatible endpoints: Ollama, Azure, vLLM). */
  url?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  classifierTemperature?: number;
  /**
   * SAP AI Core resource group (`provider: sap-ai-sdk` only). Unset, AI Core's
   * `default` group applies; set on any other provider, startup fails rather
   * than dropping it.
   */
  resourceGroup?: string;
  /**
   * What the provider does when a server throttles it: `maxAttempts` and a
   * `strategy`. Omit and nothing waits — the failure comes back carrying what
   * the server said, and the caller decides.
   *
   * There is no duration here. How long anyone may be held depends on who is
   * waiting at the other end, which this library cannot see.
   */
  whenThrottled?: IThrottleStrategy;
}

export interface SmartServerMcpConfig {
  type: 'http' | 'stdio';
  url?: string;
  command?: string;
  args?: string[];
  headers?: Record<string, string>;
  /** Default per-call MCP request timeout in ms (default 120000 = 2 min).
   *  Per-tool overrides via toolTimeouts. */
  timeout?: number;
  /** Per-tool MCP request-timeout overrides in ms, keyed by tool name.
   *  Takes precedence over timeout. */
  toolTimeouts?: Record<string, number>;
  /** Stable, human-readable label used as the namespace prefix for this server's colliding tools. */
  name?: string;
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
  /** Opt out of per-session MCP client isolation (default: per-session).
   *  `true` → reuse one shared MCP client across all sessions (pre-#213 behavior). */
  mcpSharedClient?: boolean;
  /** SSE keep-alive / tool-loop heartbeat interval (ms). Default 5000; `<= 0` or
   *  invalid disables. Already populated from yaml by resolveAgentSection. */
  heartbeatIntervalMs?: number;
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
  /** Decision model (`decision:`); built only when a consumer (the reranker) asks. */
  decision?: SmartServerDecisionConfig;
  mcp?: SmartServerMcpConfig | SmartServerMcpConfig[];
  agent?: SmartServerAgentConfig;
  prompts?: SmartServerPromptsConfig;
  mode?: SmartServerMode;
  /**
   * Pipeline selection: which pipeline plugin runs the agent, plus its section
   * (`config`), parsed by the server for a built-in or by the plugin's factory
   * for a dynamic plugin; a plugin reads no configuration (§4.6.7). Built-in
   * names: `flat` | `linear` | `dag` | `stepper` | `controller` |
   * `controller-weak`. Plugins may register additional names. When omitted,
   * defaults to `flat`.
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
 *
 * `makeLlm` and `resolveEmbedder` are REQUIRED (spec §4.6.3 item 3): the library
 * constructs no authenticated provider from configuration, so the composition root
 * supplies them. `makeLlm` receives the SERIALIZABLE section, whose `credentialRef`
 * the root resolves. Passing `{}` no longer compiles, and an untyped caller that
 * omits one is refused at construction. Every other member is optional and defaults
 * to the real implementation; tests substitute canned ones the same way.
 */
export interface BuildAgentDeps {
  makeLlm: (cfg: SmartServerLlmConfig) => Promise<ILlm>;
  /**
   * Receives the serializable embedder section; the root resolves its credentialRef
   * and turns the section into the library's `EmbedderResolution`.
   */
  resolveEmbedder: (
    cfg: SmartServerEmbedderConfig,
    options?: EmbedderResolutionOptions,
  ) => IEmbedder;
  /**
   * Builds a store from its serializable section and, where it needs one, the
   * embedder `resolveEmbedder` built. Required (§4.6.4): the library constructs no
   * authenticated store from configuration any more than an authenticated LLM.
   */
  makeRag: (input: MakeRagInput) => Promise<IRag>;
  /**
   * Builds a decision model from the `decision:` section; the root resolves its
   * credentialRef. Optional: required only when the config asks for a decision
   * model (today: a `rag.retrieval` entry with `reranker: decision`).
   */
  makeDecisionModel?: (
    cfg: SmartServerDecisionConfig,
  ) => Promise<IProbabilityDecision>;
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
   * Descriptor-producing sibling of `connectMcp` (#244) — same `mcpCfg`
   * argument shape, but returns the connected clients PAIRED with stable
   * per-slot descriptors (`clientDescriptors` + `configuredSlotCount`), which
   * the namespacing layer needs to label colliding tools. When present it
   * takes precedence over a bare `connectMcp` (see provisioning precedence at
   * the seam call sites). NOT defaulted — stays `undefined` unless the
   * consumer injects it, so the injected-seam vs YAML-builder distinction is
   * preserved.
   */
  connectMcpWithDescriptors?: (
    mcpCfg: SmartServerMcpConfig | SmartServerMcpConfig[] | undefined | null,
  ) => Promise<McpClientsWithDescriptors>;
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
  /** Custom MCP failure classifier (DI/programmatic only — not in YAML).
   *  Decides whether a failed tool-call is an availability escalation or a
   *  tool-level error. Default: DefaultMcpFailureClassifier. */
  mcpFailureClassifier?: IMcpFailureClassifier;
  /** Factory for per-loop tool-loop context strategy (DI/programmatic only — not in YAML).
   *  When absent, resolved to Legacy at point-of-use. */
  toolLoopContextStrategyFactory?: ToolLoopContextStrategyFactory;
  /** Consumer-swappable per-step execution control (timeout / tool-call budget).
   *  Threaded onto `IPipelineContext.stepExecutionControl`; the controller pipeline
   *  falls back to `DefaultStepExecutionControl` when absent. */
  stepExecutionControl?: IStepExecutionControl;
  /** Consumer-swappable per-run execution control (max steps / run timeout).
   *  Threaded onto `IPipelineContext.runExecutionControl`; the controller pipeline
   *  falls back to `NoopRunExecutionControl` when absent. */
  runExecutionControl?: IRunExecutionControl;
  /** Threaded onto `IPipelineContext.auxiliaryMcpTools`; the pipeline resolves
   *  its own default (e.g. `wait`) when absent. */
  auxiliaryMcpTools?: IAuxiliaryMcpTools;
  /** Consumer-swappable wait mechanism for controller `wait` steps.
   *  Threaded onto `IPipelineContext.waitStrategy`; the controller pipeline
   *  falls back to `DefaultWaitStrategy` when absent. */
  waitStrategy?: IWaitStrategy;
  /**
   * Consumer-swappable tool-namespacing strategy (#244) — decides how a
   * colliding MCP tool name is renamed for LLM/RAG exposure. Threaded onto
   * the startup builder (`withToolNamespace`) so the YAML-builder-connect
   * path's own namespaced snapshot honors it, AND reused by the server's own
   * `resolveAuthoritativeSnapshot()` fallback build (seam / consumer-builder
   * path) so both snapshot sources agree on the SAME naming rule. Default:
   * {@link defaultToolNamespace}.
   */
  toolNamespace?: IToolNamespace;
}

/** A DAG worker's own models: keys of the MAIN file's `llm:` map (§4.6.7).
 *  An omitted role resolves as that name does for the pipeline — the held
 *  helper/classifier, or the held main where no helper is configured. */
export interface SmartServerWorkerLlmKeys {
  main?: string;
  helper?: string;
  classifier?: string;
}

/** A worker file: everything a main file holds except its own `llm:` map and
 *  nested `subagents:`. Its `llm` names keys of the main file's map — a string
 *  is shorthand for `{ main: <key> }`. An inline LLM configuration is refused. */
export type SmartServerWorkerConfig = Omit<
  SmartServerConfig,
  'log' | 'llm' | 'subAgentConfigs'
> & { llm?: string | SmartServerWorkerLlmKeys };

/**
 * A nested sub-agent declared via the top-level `subagents:` YAML block.
 * The `config` field is the resolved `SmartServerWorkerConfig` for the
 * sub-agent (without `subagents:` of its own — nested orchestration is not
 * supported).
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
  config: SmartServerWorkerConfig;
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
      // Spec §10.5.8 S-10, D89: a config built in code skips the YAML field
      // validator — an unknown type still fails, never a server without skills.
      throw new Error(
        `skills.type: unknown skill manager '${String(type)}' — one of claude, codex, filesystem`,
      );
  }
}

// ---------------------------------------------------------------------------
// SmartServer
// ---------------------------------------------------------------------------

import { mcpContentToText } from '../mcp/mcp-content.js';
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
import { checkKnowledgeSeed, FieldCheck, present } from './config-fields.js';
import { ConfigTransactionQueue } from './config-transaction-queue.js';
import type { SmartServerDecisionConfig } from './decision-config.js';
import { makeKnowledgeBackend } from './knowledge/make-knowledge-backend.js';
import {
  buildSessionMcpClients,
  serverOwnsMcpConnection,
  shouldIsolateMcpPerSession,
} from './mcp/build-session-mcp-clients.js';
import type { McpClientsWithDescriptors } from './mcp/mcp-clients-with-descriptors.js';
import {
  buildNamespacedMcpBridge,
  rebindProvenanceToClients,
} from './mcp/namespaced-bridge.js';
import { makePgPool, makePgReadPool } from './pg-pool.js';
import {
  BUILTIN_PIPELINE_PARSERS,
  BUILTIN_PIPELINE_SECTIONS,
  type BuiltinPipelineName,
  type PipelineSectionEntry,
  type PipelineSelection,
} from './pipeline-sections.js';
import { selectPipelinePlugin } from './select-pipeline-plugin.js';
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
  buildSessionRagRegistry,
  recordSessionEnd,
  recordSessionStart,
  resolveSubAgentRagRegistry,
  type SessionLifecycle,
  seedSessionKnowledge,
} from './session-lifecycle/index.js';

export {
  buildSessionLifecycle,
  buildSessionRagRegistry,
  handleDeleteSession,
  handleListSessions,
  handleResumeSession,
  recordSessionEnd,
  recordSessionStart,
  resolveSubAgentRagRegistry,
  type SessionLifecycle,
  type SessionLifecycleOptions,
  type SessionListBody,
  type SessionRagRegistryInput,
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
 * - On success: return the text (unwrap the canonical MCP text-block envelope
 *   via mcpContentToText; stringify genuinely structured payloads). See #267.
 * - On error: return the error message as a string so the LLM executor can
 *   feed the failure back to the model as a tool result (no throw).
 * - If no client owns the tool: return an informative "Tool not found" string.
 *
 * Exported for testability — tests can call this with a fake IMcpClient list.
 */
/**
 * Connect MCP clients from a YAML `mcp:` config block (single or array),
 * pairing each connected client with a stable per-slot descriptor
 * (`{ slotIndex: i, label: cfg[i].name }`, #244).
 *
 * Mirrors the builder's connection logic (builder.ts ~lines 897-920) so the
 * Stepper path gets the same clients that the builder would have connected
 * internally. Exported for testability.
 *
 * @param mcpCfg - single `SmartServerMcpConfig` or array thereof (from
 *   `pipeline.mcp` or `this.cfg.mcp`). Accepts the union so callers can pass
 *   either directly without pre-normalising.
 */
export async function connectMcpClientsWithDescriptorsFromConfig(
  mcpCfg: SmartServerMcpConfig | SmartServerMcpConfig[] | undefined | null,
): Promise<McpClientsWithDescriptors> {
  if (!mcpCfg)
    return { clients: [], clientDescriptors: [], configuredSlotCount: 0 };
  const list = Array.isArray(mcpCfg) ? mcpCfg : [mcpCfg];
  const connected: IMcpClient[] = [];
  const clientDescriptors: McpClientDescriptor[] = [];
  for (let i = 0; i < list.length; i++) {
    const cfg = list[i];
    let wrapper: MCPClientWrapper;
    if (cfg.type === 'stdio') {
      wrapper = new MCPClientWrapper({
        transport: 'stdio',
        command: cfg.command,
        args: cfg.args ?? [],
        ...(cfg.timeout !== undefined ? { timeout: cfg.timeout } : {}),
        ...(cfg.toolTimeouts ? { toolTimeouts: cfg.toolTimeouts } : {}),
      });
    } else {
      wrapper = new MCPClientWrapper({
        transport: 'auto',
        url: cfg.url,
        headers: cfg.headers,
        ...(cfg.timeout !== undefined ? { timeout: cfg.timeout } : {}),
        ...(cfg.toolTimeouts ? { toolTimeouts: cfg.toolTimeouts } : {}),
      });
    }
    await wrapper.connect();
    connected.push(new McpClientAdapter(wrapper));
    clientDescriptors.push({ slotIndex: i, label: cfg.name });
  }
  return {
    clients: connected,
    clientDescriptors,
    configuredSlotCount: list.length,
  };
}

/**
 * Compat wrapper preserving the original bare-array export: delegates to
 * `connectMcpClientsWithDescriptorsFromConfig` and returns only `.clients`.
 * Kept so existing callers/tests that depend on `Promise<IMcpClient[]>` are
 * unaffected by the #244 descriptor-producing seam.
 */
export async function connectMcpClientsFromConfig(
  mcpCfg: SmartServerMcpConfig | SmartServerMcpConfig[] | undefined | null,
): Promise<IMcpClient[]> {
  return (await connectMcpClientsWithDescriptorsFromConfig(mcpCfg)).clients;
}

export function buildMcpBridge(
  clients: IMcpClient[],
  classifier: IMcpFailureClassifier = new DefaultMcpFailureClassifier(),
): (
  name: string,
  args: unknown,
  signal?: AbortSignal,
) => Promise<McpCallResult> {
  return async (name: string, args: unknown, signal?: AbortSignal) => {
    const safeArgs =
      args != null && typeof args === 'object' && !Array.isArray(args)
        ? (args as Record<string, unknown>)
        : {};
    const opts = signal ? { signal } : undefined;
    for (const client of clients) {
      const probe = client.healthCheck
        ? () => client.healthCheck!(opts).then((r) => (r.ok ? r.value : false))
        : undefined;
      const listed = await client.listTools(opts);
      // Spec §10.5.3 M10: a client that cannot list its tools is an error of
      // every class — never silently the next client (the tool would look
      // merely absent, or run on another server).
      if (!listed.ok) throw listed.error;
      const owns = listed.value.some((t) => t.name === name);
      if (!owns) continue;
      const result = await client.callTool(name, safeArgs, opts);
      if (!result.ok) {
        // Availability failure → fail loud; a tool-level error → LLM feedback
        // text WITH isError:true so the caller can see it failed (#213).
        if ((await classifier.classify(result.error, probe)) === 'unavailable')
          throw result.error;
        return { text: result.error.message, isError: true };
      }
      const { content, isError } = result.value;
      return {
        text: mcpContentToText(content),
        isError: isError ?? false,
      };
    }
    return { text: `Tool not found: ${name}`, isError: true };
  };
}

/**
 * The seams the library no longer defaults. The type already makes them required;
 * this runs for callers with no types to check, so a plain-JS embedder of
 * SmartServer is told at construction instead of starting without an LLM.
 */
const REQUIRED_CONSTRUCTION_SEAMS = [
  'makeLlm',
  'resolveEmbedder',
  'makeRag',
] as const;

function assertConstructionSeams(deps: BuildAgentDeps | undefined): void {
  const missing = REQUIRED_CONSTRUCTION_SEAMS.filter(
    (k) => typeof deps?.[k] !== 'function',
  );
  if (missing.length === 0) return;
  throw new Error(
    `${missing.map((k) => `BuildAgentDeps.${k}`).join(', ')} ` +
      `${missing.length > 1 ? 'are' : 'is'} required: the library constructs no ` +
      'LLM, embedder or store from configuration, because doing so meant carrying ' +
      'a secret through a framework config. Supply them from your composition root.',
  );
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
  /** The server's one config queue and its "config not applied" state (spec V6, V10, D80, D82). */
  private readonly _configTransactions = new ConfigTransactionQueue();
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
  /**
   * `circuitBreaker:` — one LLM breaker per `llm:` key, wrapped where each LLM
   * is created (held main/classifier/helper and every resolver entry), so every
   * session and role — controller and stepper included — shares it (§14.2).
   */
  private _llmBreakers?: LlmCircuitBreakers;
  /** `circuitBreaker:` — the one embedder breaker, fed by the retrieval embedder. */
  private _embedderBreaker?: CircuitBreaker;
  /** The one reranker of this server, resolved once in `_buildInfra()` (§7.4). */
  private _reranker?: IReranker;
  /**
   * `rag.retrieval` resolved once in `_buildInfra` — one strategy per listed
   * store key, server-wide (§13.4). Applied at creation of the server-built
   * stores (`tools` / `history`, workers' too) and, through
   * `withRetrievalStrategy`, in every builder's `ragStores` projection.
   */
  private _retrievalStrategies: Map<string, IRetrievalStrategy> = new Map();
  /** `agent.toolSelection`, resolved once; applied to every builder (§13.4). */
  private _toolSelectionStrategy?: IToolSelectionStrategy;
  /** Plugin output validator, resolved once; applied to every builder (§14.1). */
  private _outputValidator?: IOutputValidator;
  /** Plugin query expander, resolved once; applied to every builder (§14.1). */
  private _queryExpander?: IQueryExpander;
  /** DI > plugin > YAML `skills:`, resolved once; vectorized at startup only. */
  private _skillManager?: ISkillManager;
  /**
   * `agent.llmCallStrategy`, resolved once as a FACTORY: a strategy may be
   * stateful (`fallback` disables streaming stickily), so each builder gets its
   * own instance (§14.1).
   */
  private _llmCallStrategyFactory?: () => ILlmCallStrategy;
  /** DI > plugin > default `ClineClientAdapter`, resolved once (§14.1). */
  private _clientAdapters: IClientAdapter[] = [];
  private _fileLogger?: ILogger;
  private _mergedEmbedderFactories?: Record<string, EmbedderFactory>;
  /**
   * The embedder resolved ONCE in `start()` (`resolveAgentEmbedder` over
   * `rag.embedder` / `embedder` config). Held so `buildServerCtx` can hand it to
   * every pipeline context (the controller pipeline needs it for target-state
   * semantic distance). Undefined when no embedder is configured.
   */
  private _resolvedEmbedder?: IRetrievalEmbedder;
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
   * The strategy-wrapped history store, shared by the startup agent and every
   * session agent (one store; reads are scoped per session by metadata).
   * Unset when `rag:` is not configured.
   */
  private _historyRag?: IRag;
  /**
   * The providers every build of this server creates through, and the catalogs
   * a session registry is hydrated from. One object, handed to every build:
   * without it each session build replaced the registry's provider registry
   * with a fresh empty one.
   */
  private readonly _ragProviderRegistry: IRagProviderRegistry =
    new SimpleRagProviderRegistry();
  /**
   * Catalog findings (rejected rows, skipped globals) already logged by one of
   * this server's sessions, so the next session does not repeat them. One per
   * server, never module-global: see SessionRagRegistryInput.reported.
   */
  private readonly _reportedCatalogFindings = new Set<string>();
  /** The deployment's registry, whose globals every session registry holds. */
  private _globalRagRegistry?: IRagRegistry;
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
   * True when the consumer injected an MCP seam (`BuildAgentDeps.mcpClients`,
   * `connectMcp`, or `connectMcpWithDescriptors`). In that case MCP is provisioned
   * ONLY through the seam (the
   * embeddable path must never force a real connect / builder self-connect). When
   * false (default), the YAML `mcp:` path keeps the builder-owned connect so the
   * builder VECTORIZES the tools into `toolsRag` (the ToolSelect ranking contract;
   * see mcp-yaml-vectorization.test.ts).
   */
  private readonly _mcpSeamInjected: boolean;
  /**
   * True when the consumer injected a BARE `connectMcp` (as opposed to it
   * being defaulted to `connectMcpClientsFromConfig` in the constructor).
   * Lets the provisioning precedence distinguish "consumer gave us a
   * connector with no descriptors" (array-index descriptors synthesized)
   * from "nothing was injected, use the descriptor-producing default" (#244).
   */
  private readonly _connectMcpInjected: boolean;
  /**
   * The MCP clients the pipeline `callMcp` bridge dispatches over — resolved
   * UNCONDITIONALLY in `start()` as DI/plugin clients (`mcpClients`) ?? the
   * YAML-connected `_stepperMcpClients`. Held so every pipeline (not just the
   * stepper) gets a working `ctx.callMcp` without opening a second connection.
   */
  private _sharedMcpClients?: IMcpClient[];
  /**
   * Per-slot descriptors paired with `_sharedMcpClients` (#244), captured
   * from whichever provisioning path won (injected `connectMcpWithDescriptors`
   * > injected bare `connectMcp` (array-index descriptors) > the descriptor-
   * producing default). Consumed by Tasks 6/7 (namespacing + toolsChanged).
   */
  private _sharedMcpClientDescriptors?: readonly McpClientDescriptor[];
  /**
   * Total configured `mcp[]` slots (independent of how many actually
   * connected), captured alongside `_sharedMcpClientDescriptors` (#244).
   */
  private _configuredSlotCount?: number;
  /**
   * The ONE authoritative namespaced tool catalog snapshot (#244 Task 6),
   * fed to the tools-RAG handle (`makeToolsRagHandle`'s `namespaced` param).
   * Populated from either source:
   *   - yaml-builder path: harvested from `agentHandle.namespacedTools` (the
   *     startup builder computed it while auto-connecting `cfg.mcp`).
   *   - seam / consumer-builder path: built ONCE by
   *     `resolveAuthoritativeSnapshot()` over `_sharedMcpClients` +
   *     `_sharedMcpClientDescriptors` (the builder never connected itself, so
   *     its handle carries no snapshot).
   * Undefined only when neither source produced one (e.g. no MCP clients).
   */
  private _namespacedTools?: readonly LlmTool[];
  /**
   * Provenance for `_namespacedTools` — exposed (namespaced) name → its
   * originating slot + original tool name. Doubles as the memoization guard
   * for `resolveAuthoritativeSnapshot()`: once set (from either source above)
   * a later call is a no-op. See `_namespacedTools` field doc for the two
   * sources.
   */
  private _toolProvenance?: ReadonlyMap<
    string,
    { slotIndex: number; originalName: string }
  >;
  /**
   * The ONE shared knowledge backend for the Stepper path (set during build).
   * Held so DELETE /v1/sessions/:id can evict a session's entries from it —
   * critical for the long-lived in-memory backend, which would otherwise retain
   * knowledge after a delete and rehydrate it on a same-id re-entry.
   */
  private _stepperKnowledgeBackend?: KnowledgeBackend;
  /** `pipeline.config.knowledgeSeed`, read once at start with the stepper's rule (spec D83 (12)). */
  private _knowledgeSeed: ReadonlyArray<{
    content: string;
    artifactType: string;
  }> = [];
  /**
   * Session meta-store for /v1/sessions endpoints (Task 17).
   * Defaults to InMemorySessionMetaStore; a durable store can be injected via
   * `cfg.sessionMetaStore` in a future extension.
   */
  private readonly _sessionMetaStore: ISessionMetaStore =
    new InMemorySessionMetaStore();
  /**
   * The ONE pipeline plugin this server runs: its factory was selected by
   * `cfg.pipeline.name` (default 'flat') and called once in `_buildInfra`, with
   * `cfg.pipeline.config` parsed by the server (built-ins) or by the plugin author's
   * factory (dynamic). `buildPipelineInstance` only builds it per session.
   */
  private _pipelinePlugin!: IPipelinePlugin;
  /** Set in `_buildInfra` with `_pipelinePlugin`; the reload watcher's `pipeline` (spec D83 (11)). */
  private _pipelineSections!: ReadonlyMap<string, PipelineSectionEntry>;
  /** Set in `_buildInfra` with `_pipelinePlugin`; the reload watcher's `pipeline` (spec D83 (11)). */
  private _pipelineSelection!: PipelineSelection;
  /**
   * Per-session `IPipelineInstance.close()` hooks, keyed by sessionId. Populated
   * by `buildPipelineInstance` (via `buildSessionAgent`) and invoked from the
   * session lifecycle `onDispose` so per-session pipeline resources (MCP / builder
   * handles owned by the plugin) are freed on eviction / shutdown / reconfigure.
   */
  private readonly _sessionCloseFns = new Map<string, () => Promise<void>>();
  /**
   * Instance-level MCP failure classifier (DI/programmatic only — not from YAML).
   * Populated from BuildAgentDeps in the constructor; defaults to DefaultMcpFailureClassifier.
   * Passed to buildMcpBridge (Route B) and threaded into every pipeline ctx (Route A).
   */
  private readonly _mcpFailureClassifier: IMcpFailureClassifier;
  private readonly _toolLoopContextStrategyFactory?: ToolLoopContextStrategyFactory;
  private readonly _stepExecutionControl?: IStepExecutionControl;
  private readonly _runExecutionControl?: IRunExecutionControl;
  private readonly _auxiliaryMcpTools?: IAuxiliaryMcpTools;
  private readonly _waitStrategy?: IWaitStrategy;
  /**
   * Tool-namespacing strategy (#244) — DI'd via `BuildAgentDeps.toolNamespace`,
   * default `defaultToolNamespace`. Threaded onto the startup builder
   * (`buildBaseBuilder` → `.withToolNamespace`) so its own namespaced snapshot
   * (yaml-builder path) honors it, and reused verbatim by
   * `resolveAuthoritativeSnapshot()`'s fallback build (seam path) so both
   * snapshot sources agree on the same naming rule.
   */
  private readonly _toolNamespace: IToolNamespace;

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
      | 'makeRag'
      | 'prefetchEmbedderFactories'
      | 'buildSkillHost'
      | 'connectMcp'
    >
  > &
    Pick<
      BuildAgentDeps,
      | 'skillHost'
      | 'embedder'
      | 'mcpClients'
      | 'connectMcpWithDescriptors'
      | 'makeDecisionModel'
    >;

  constructor(config: SmartServerConfig, deps: BuildAgentDeps) {
    assertConstructionSeams(deps);
    this.cfg = config;
    assertRagConfigShape(config.rag, 'rag');
    for (const sub of config.subAgentConfigs ?? []) {
      assertRagConfigShape(sub.config.rag, `subagent '${sub.name}' rag`);
    }
    this._mcpSeamInjected =
      deps.mcpClients !== undefined ||
      deps.connectMcp !== undefined ||
      deps.connectMcpWithDescriptors !== undefined;
    this._connectMcpInjected = deps.connectMcp !== undefined;
    this._mcpFailureClassifier =
      deps.mcpFailureClassifier ?? new DefaultMcpFailureClassifier();
    // The DI seam carries the CONSUMER-injected factory ONLY (undefined when not
    // injected). It is threaded verbatim onto the pipeline ctx so a consumer
    // override wins on EVERY pipeline — including the controller, which resolves
    // `ctx.toolLoopContextStrategyFactory ?? <its own RagRecall>`. The server's
    // Window default for the NON-controller pipelines is applied ONLY on the
    // builder channel (buildBaseBuilder), so it never leaks into the controller's
    // ctx read. A bare library consumer of DefaultPipeline/SmartAgent (no
    // SmartServer) still falls back to Legacy at point-of-use.
    this._toolLoopContextStrategyFactory = deps.toolLoopContextStrategyFactory;
    this._stepExecutionControl = deps.stepExecutionControl;
    this._runExecutionControl = deps.runExecutionControl;
    this._auxiliaryMcpTools = deps.auxiliaryMcpTools;
    this._waitStrategy = deps.waitStrategy;
    this._toolNamespace = deps.toolNamespace ?? defaultToolNamespace;
    this._deps = {
      makeLlm: deps.makeLlm,
      resolveEmbedder: deps.resolveEmbedder,
      makeRag: deps.makeRag,
      prefetchEmbedderFactories:
        deps.prefetchEmbedderFactories ?? prefetchEmbedderFactories,
      buildSkillHost: deps.buildSkillHost ?? buildSkillHostFromConfig,
      connectMcp: deps.connectMcp ?? connectMcpClientsFromConfig,
      ...(deps.skillHost ? { skillHost: deps.skillHost } : {}),
      ...(deps.embedder ? { embedder: deps.embedder } : {}),
      ...(deps.mcpClients ? { mcpClients: deps.mcpClients } : {}),
      ...(deps.connectMcpWithDescriptors
        ? { connectMcpWithDescriptors: deps.connectMcpWithDescriptors }
        : {}),
      ...(deps.makeDecisionModel
        ? { makeDecisionModel: deps.makeDecisionModel }
        : {}),
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

    // LLM resolution — normalize the flat/map top-level `llm:` block.
    const llmMap = normalizeLlmConfig(this.cfg.llm);
    const topMain = resolveLlmConfig(llmMap, 'main');

    // An unset temperature stays unset all the way to the provider, which then
    // sends none and the model applies its own default — a forced value breaks
    // models that accept only theirs (gpt-5, o-series, claude-opus-4-7+).
    // The resolved config holds validated numbers (spec D83 (7)).
    const mainTemp = topMain?.temperature;
    const mainLlm = topMain
      ? await this._deps.makeLlm({ ...topMain, temperature: mainTemp })
      : (() => {
          throw new Error('no LLM configured: provide top-level llm.main');
        })();

    const classifierEntry = resolveLlmConfigStrict(llmMap, 'classifier');
    const classifierTemp = topMain?.classifierTemperature;
    const classifierLlm = classifierEntry
      ? await this._deps.makeLlm(classifierEntry)
      : topMain
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
          temperature: helperCfg.temperature,
        })
      : undefined;
    // `circuitBreaker:` → the shared breakers (§14.2): created once, before any
    // LLM is held, and wrapped where each LLM is created — never in a builder.
    if (this.cfg.circuitBreaker) {
      this._llmBreakers = new LlmCircuitBreakers(this.cfg.circuitBreaker);
      this._embedderBreaker = new CircuitBreaker(this.cfg.circuitBreaker);
    }
    this._mainLlm = this.guardLlm(mainLlm, 'main');
    this._classifierLlm = this.guardLlm(classifierLlm, 'classifier');
    this._helperLlm = helperLlm && this.guardLlm(helperLlm, 'helper');
    this._llmMap = llmMap;
    this._mainTemp = mainTemp;
    const breakers = this._llmBreakers;
    this._roleLlm = new RoleLlmResolver({
      getMain: () => this._mainLlm,
      getHelper: () => this._helperLlm,
      getClassifier: () => this._classifierLlm,
      getLlmMap: () => this._llmMap,
      build: (entry) => this._deps.makeLlm(entry),
      ...(breakers ? { wrap: (llm, key) => breakers.wrap(llm, key) } : {}),
    });

    // The programmatic subAgentConfigs path never passed the YAML check, so a
    // worker's named keys are checked here too (§4.6.7): startup fails loudly.
    assertWorkerLlmConfig(this.cfg.subAgentConfigs, llmMap);

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

    // ---- Reranker (§7.4) -------------------------------------------------
    // Resolved ONCE here — the infra build shared by start() and the embeddable
    // buildAgent() — and applied by buildBaseBuilder outside the
    // applyServerExtras gate, so per-session agents get it too.
    this._reranker = await resolveReranker({
      pluginReranker: plugins.reranker,
    });

    // ---- Validator, expander, skills, LLM-call strategy, adapters (§14.1) --
    // Resolved ONCE here and applied by buildBaseBuilder to every builder
    // (per-session agents serve the requests).
    this._outputValidator = plugins.outputValidator;
    this._queryExpander = plugins.queryExpander;
    this._skillManager =
      this.cfg.skillManager ??
      plugins.skillManager ??
      resolveSkillManager(this.cfg.skills);
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
        fallback: () => new FallbackLlmCallStrategy(this._fileLogger),
      };
      this._llmCallStrategyFactory = strategies[strategyName];
    }
    const { ClineClientAdapter } = await import('@mcp-abap-adt/llm-agent');
    this._clientAdapters = [
      ...(this.cfg.clientAdapters ?? []),
      ...plugins.clientAdapters,
      new ClineClientAdapter(),
    ];

    // ---- Per-store retrieval strategies (§13.4) ---------------------------
    // Resolved ONCE, server-wide. An explicit per-store strategy (embedding
    // included) wins over the plugin reranker above; an unlisted store keeps
    // today's behaviour. Decision-backed rerankers share one decision model.
    this._retrievalStrategies = await resolveRetrievalStrategies({
      retrieval: this.cfg.rag?.retrieval,
      decisionCfg: this.cfg.decision,
      makeDecisionModel: this._deps.makeDecisionModel,
      resolveLlm: (key) => this.roleLlm().resolveNamed(key),
    });
    const toolSelectionCfg = this.cfg.agent?.toolSelection;
    this._toolSelectionStrategy = toolSelectionCfg?.strategy
      ? resolveToolSelectionStrategy(toolSelectionCfg.strategy, {
          minScore: toolSelectionCfg.minScore,
        })
      : undefined;

    // Spec D83 (12): pipeline.config.knowledgeSeed with the stepper's rule — a
    // present wrong shape fails the start, never "no seed".
    const seedCheck = new FieldCheck();
    const rawSeed = this.cfg.pipeline?.config?.knowledgeSeed;
    this._knowledgeSeed = seedCheck.done(
      present(rawSeed)
        ? checkKnowledgeSeed(
            seedCheck,
            'pipeline.config.knowledgeSeed',
            rawSeed,
          )
        : [],
    );

    // ---- Pipeline-plugin registry: factories (§4.6.7) -------------------
    // Built-ins are server code — parse, validate, construct with typed settings.
    // A dynamic instance export is registered as a factory that ignores its
    // section; a dynamic factory is the plugin author's parser. Only the selected
    // entry is ever called, once, below.
    const warn = (m: string) => this.warn(m);
    // Spec D83 (11): the built-in factories call BUILTIN_PIPELINE_PARSERS — the
    // parse the reload runs too; both records are keyed by BuiltinPipelineName,
    // so the compiler keeps the factories and the section entries equal.
    const builtinFactories: Record<BuiltinPipelineName, PipelinePluginFactory> =
      {
        flat: () => new FlatPipelinePlugin(),
        linear: (s) =>
          new LinearPipelinePlugin(BUILTIN_PIPELINE_PARSERS.linear(s)),
        dag: (s) =>
          new DagPipelinePlugin(
            BUILTIN_PIPELINE_PARSERS.dag(s, this._llmMap, warn),
          ),
        stepper: (s) =>
          new StepperPipelinePlugin(BUILTIN_PIPELINE_PARSERS.stepper(s)),
        controller: (s) =>
          new ControllerPipelinePlugin(
            'controller',
            'smart-executor',
            BUILTIN_PIPELINE_PARSERS.controller(s, this._llmMap),
          ),
        'controller-weak': (s) =>
          new ControllerPipelinePlugin(
            'controller-weak',
            'weak-executor',
            BUILTIN_PIPELINE_PARSERS['controller-weak'](s, this._llmMap),
          ),
      };
    const pipelineRegistry = new Map<string, PipelinePluginFactory>(
      Object.entries(builtinFactories),
    );
    const pipelineSections = new Map<string, PipelineSectionEntry>(
      Object.entries(BUILTIN_PIPELINE_SECTIONS),
    );
    const pipelineSources = new Map<string, string>(
      [...pipelineRegistry.keys()].map((k) => [k, 'built-in']),
    );
    const registerPipeline = (
      name: string,
      factory: PipelinePluginFactory,
      entry: PipelineSectionEntry,
    ): void => {
      const source = plugins.pipelinePluginSources.get(name) ?? 'unknown';
      if (pipelineRegistry.has(name)) {
        throw new Error(
          `pipeline plugin name collision: '${name}' is already registered ` +
            `(built-in or another plugin) — '${source}' against '${pipelineSources.get(name)}'`,
        );
      }
      pipelineRegistry.set(name, factory);
      pipelineSources.set(name, source);
      pipelineSections.set(name, entry);
    };
    for (const [name, plugin] of plugins.pipelinePlugins)
      registerPipeline(name, () => plugin, { kind: 'no-section' });
    for (const [name, factory] of plugins.pipelinePluginFactories ?? []) {
      registerPipeline(name, factory, { kind: 'plugin-factory' });
    }
    log({
      event: 'pipeline_registry_loaded',
      pipelines: [...pipelineRegistry.keys()],
    });
    const selection: PipelineSelection = {
      name: this.cfg.pipeline?.name ?? 'flat',
      section: this.cfg.pipeline?.config ?? {},
    };
    this._pipelinePlugin = selectPipelinePlugin(
      pipelineRegistry,
      pipelineSources,
      selection.name,
      selection.section,
    );
    // Spec D83 (11): what a reload checks its file's pipeline against.
    this._pipelineSections = pipelineSections;
    this._pipelineSelection = selection;

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
          subCfg as SmartServerWorkerConfig,
          parentLogger,
          factories,
          injected,
        ),
    });

    // Resolve the embedder ONCE so the same instance feeds both makeRag and the
    // subagent context-builder's toolSource (#137). See resolve-agent-embedder.
    // ONE retrieval embedder: stores write with its `embedDocument`, every
    // search path embeds with its `embedQuery` (an asymmetric model is two
    // halves behind it — see resolveRetrievalEmbedder).
    const resolvedEmbedder = await resolveRetrievalEmbedder(
      this.cfg.rag,
      this._deps.embedder ?? this.cfg.embedder,
      this._deps.resolveEmbedder,
      mergedEmbedderFactories,
      this._fileLogger,
      // The embedder breaker sees the real embedding calls (§14.2): each half
      // is wrapped below the document/query role. Worker embedders keep none.
      this.embedderBreakerWrap(),
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
        const section = embedderSectionFor(skillCfg.embedder?.provider);
        if (section.factory === undefined) {
          await this._deps.prefetchEmbedderFactories([section.provider]);
        }
      }
      // Build → load → validate as one fail-fast unit. If ANY step throws, the
      // captured pg pools are ended INSIDE initSkillHost (the later closeFns
      // cleanup never runs when start() rejects before returning a handle), so
      // the pools cannot leak open sockets on a startup failure.
      const buildHost = this._deps.skillHost
        ? async () => this._deps.skillHost as ISkillPluginHost
        : () =>
            this._deps.buildSkillHost(skillCfg, {
              resolveEmbedder: (ec) => {
                // The agent's retrieval embedder (built from the DI instance
                // when one was injected) serves the skills too.
                if (reuseAgentEmbedder) {
                  if (!resolvedEmbedder) {
                    throw new Error(
                      'skillPlugins: reusing the agent embedder, but none was resolved',
                    );
                  }
                  return resolvedEmbedder;
                }
                const section = embedderSectionFor(ec.embedder, ec.model);
                const build = (sec: SmartServerEmbedderConfig) =>
                  this._deps.resolveEmbedder(sec, {
                    extraFactories: mergedEmbedderFactories,
                  });
                return ec.asymmetric && section.factory === undefined
                  ? asymmetricEmbedder({
                      document: build({
                        ...section,
                        inputType: 'document' as const,
                      }),
                      query: build({ ...section, inputType: 'query' as const }),
                    })
                  : symmetricEmbedder(build(section));
              },
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
        log,
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
      // The embedder was resolved through the seam above; the store is built
      // through its own. Two calls, two stores — the history store never shared
      // the tools store's instance.
      const input = toMakeRagInput(this.cfg.rag.store, resolvedEmbedder, 'rag');
      toolsRag = this.withStrategy('tools', await this._deps.makeRag(input));
      historyRag = this.withStrategy(
        'history',
        await this._deps.makeRag(input),
      );
    }
    // Capture the tools store for the flat/smart pipeline's ToolSelectHandler
    // (and white-box vectorization assertions). See field doc.
    this._toolsRag = toolsRag;
    this._historyRag = historyRag;

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
    // Per-session MCP isolation (#213): the server itself owns ONLY the YAML
    // `mcp:` connection with NO injected seam — that is the path eligible for
    // per-session client isolation. Ready-client sources (deps/cfg/plugin) are
    // consumer/plugin owned and stay shared; an injected `connectMcp` seam is the
    // SINGLE async provisioning point (auth/creds/stub/custom transport) and the
    // sync per-session factory cannot re-invoke it, so it stays shared too. Both
    // conditions are folded into `serverOwnsMcpConnection` → `mcpFromYaml` can
    // never bypass the seam.
    const mcpFromYaml = serverOwnsMcpConnection({
      hasReadyClients,
      hasMcpConfig: !!this.cfg.mcp,
      mcpSeamInjected: this._mcpSeamInjected,
    });
    // YAML `mcp:` with NO ready clients AND NO injected seam → keep the legacy
    // builder-owned connect so the builder VECTORIZES the tools (the ToolSelect
    // ranking contract). `_sharedMcpClients` + the tools-RAG handle are harvested
    // from the built handle AFTER `build()` (see the harvest block below). When
    // the seam IS injected we provision through it instead (no builder connect).
    // Identical to `mcpFromYaml` (server-owned YAML connect) — reuse it.
    const yamlBuilderConnect = mcpFromYaml;

    let mcpClients: IMcpClient[] | undefined;
    if (hasReadyClients) {
      mcpClients = diOrPluginMcpClients;
    } else if (this.cfg.mcp && this._mcpSeamInjected) {
      // Injected seam + YAML `mcp:` → the seam is the SINGLE provisioning point
      // (the embeddable path must never force a real connect). Stash on
      // `_stepperMcpClients` so the idempotent guard inside
      // buildSharedPipelineInfra does not connect a second time. Precedence
      // among seams (connectMcpWithDescriptors > bare connectMcp > default) —
      // and recording `_sharedMcpClientDescriptors`/`_configuredSlotCount` — is
      // handled by `_resolveMcpWithDescriptors` (#244).
      const resolvedMcp = await this._resolveMcpWithDescriptors(this.cfg.mcp);
      this._stepperMcpClients = resolvedMcp.clients;
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
      // The held (breaker-guarded) instances: the builder never wraps an LLM.
      mainLlm: this._mainLlm as ILlm,
      classifierLlm: this._classifierLlm as ILlm,
      helperLlm: this._helperLlm,
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
    this._globalRagRegistry = globalRagRegistry;
    for (const w of unknownRetrievalKeyWarnings(
      this.cfg.rag?.retrieval,
      globalRagRegistry.list().map((c) => c.name),
    )) {
      this.warn(w);
    }
    // Two limits of this server, stated rather than fixed (§6.4): it registers
    // no RAG providers, so no session registry has a catalog to hydrate from —
    // each holds only the deployment's globals; and its sessions carry a
    // sessionId and no userId (llm-agent-libs session-registry.ts builds them
    // from { sessionId }), so user collections are neither hydrated nor
    // creatable through it. Not logged: in today's default deployment it would
    // fire at every start, and an expected warning trains readers to skip the
    // real ones — the limits are stated here, in the CHANGELOG and in the docs.

    // ---- Authoritative namespaced snapshot — yaml-builder path (#244) --------
    // The startup builder computes `namespacedTools`/`toolProvenance` (+ the
    // descriptors backing them) ONLY when it owns the connection itself (the
    // `yamlBuilderConnect` path — no ready clients, no injected seam); on every
    // other path the handle's fields stay undefined (the builder skipped its
    // own connect via `withMcpClients`) and `resolveAuthoritativeSnapshot()`
    // builds the fallback later instead. Guard on presence so an undefined
    // handle field never clobbers a fallback snapshot built earlier in
    // `buildSharedPipelineInfra` (the seam / consumer-builder path runs BEFORE
    // `builder.build()`).
    if (agentHandle.namespacedTools !== undefined) {
      this._namespacedTools = agentHandle.namespacedTools;
    }
    if (agentHandle.toolProvenance !== undefined) {
      this._toolProvenance = agentHandle.toolProvenance;
    }
    if (agentHandle.mcpClientDescriptors !== undefined) {
      this._sharedMcpClientDescriptors = agentHandle.mcpClientDescriptors;
    }
    if (agentHandle.configuredSlotCount !== undefined) {
      this._configuredSlotCount = agentHandle.configuredSlotCount;
    }

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
      // Shared/global-set provenance (#244) — forwarded so the lifecycle's
      // isolation-OFF branch (no `buildPerSessionMcpClients`, or
      // `mcpSharedClient: true`) still pairs `SessionAgentParts.mcpClients`
      // with the ORIGINAL slotIndex-keyed descriptors, even when the shared
      // set is a FILTERED subset (e.g. LazyConnectionStrategy dropped a slot).
      mcpClientDescriptors: this._sharedMcpClientDescriptors,
      configuredSlotCount: this._configuredSlotCount,
      // Per-session MCP isolation (#213): only for the YAML `mcp:` path (the one
      // the server itself connects). Ready-client sources (deps/cfg/plugin) are
      // consumer/plugin-owned and stay shared. `agent.mcpSharedClient: true`
      // opts the YAML path back out to a shared client.
      mcpSharedClient: this.cfg.agent?.mcpSharedClient,
      buildPerSessionMcpClients: shouldIsolateMcpPerSession({
        mcpFromYaml,
        mcpSharedClient: this.cfg.agent?.mcpSharedClient,
      })
        ? () => buildSessionMcpClients(this.cfg.mcp)
        : undefined,
      // `this._toolsRag` === the `toolsRag` local captured in start(); reference
      // the field as the single source of truth for the tools store.
      toolsRag: this._toolsRag,
      // A registry per session, seeded with the deployment's globals and
      // hydrated for its identity (§6.4). Never the shared one: collections are
      // addressed by name, so sharing it would put every session's collections
      // in every session's address space. Hydration finds nothing until a
      // provider is registered, and no user collection while sessions carry no
      // userId — see the limits stated above.
      ragRegistryFactory: (identity) => this._sessionRagRegistry(identity),
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
      // Re-read per check: a PUT /v1/config swap replaces a key's breaker.
      circuitBreakers: this.breakerList() ?? circuitBreakers,
    });

    // Startup health check removed — use `npm run models:check` for diagnostics.
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
        transactions: this._configTransactions,
        pipeline: {
          entries: this._pipelineSections,
          running: this._pipelineSelection,
          warn: (m) => this.warn(m),
        },
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
   * with a fresh per-(embedded-)session request logger. Also threads
   * `_sharedMcpClientDescriptors`/`_configuredSlotCount` (#244) — the shared
   * set's per-slot provenance, captured by whichever descriptor-producing
   * seam won — so the embedded path carries the same descriptor pairing the
   * per-session lifecycle now does.
   */
  private _embeddedSessionParts(
    mcpClients: IMcpClient[] | undefined,
    ragRegistry: IRagRegistry,
  ): SessionAgentParts {
    return {
      sessionId: 'embedded',
      mcpClients: mcpClients ?? this._sharedMcpClients ?? [],
      mcpClientDescriptors: this._sharedMcpClientDescriptors,
      configuredSlotCount: this._configuredSlotCount,
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
    subCfg: SmartServerWorkerConfig,
    parentLogger: ILogger,
    embedderFactories: Record<string, EmbedderFactory>,
    injected?: {
      ragRegistry: IRagRegistry;
      toolsRag: IRag | undefined;
      mcpClients: IMcpClient[];
      requestLogger: IRequestLogger;
      embedder?: IEmbedder;
    },
  ): Promise<SmartAgent> {
    // A worker's three LLM slots come from the SAME resolver as the pipeline's
    // (§4.6.7): a named key resolves strictly, an omitted role as that name
    // does for the pipeline. Instances are held by the resolver, so nothing is
    // built per session and a PUT /v1/config swap reaches workers too.
    const keys = parseWorkerLlm(name, subCfg.llm);
    const [mainLlm, classifierLlm, helperLlm] = await Promise.all([
      this.resolveWorkerRoleLlm(keys.main, 'main'),
      this.resolveWorkerRoleLlm(keys.classifier, 'classifier'),
      this.resolveWorkerRoleLlm(keys.helper, 'helper'),
    ]);

    // LLM/embedder clients: when the per-session re-wire injected them, use
    // those cached instances by reference (NEVER reconstruct). Otherwise (the
    // primary build()), build-once via the cache so the global agent build
    // also populates it and later per-session re-wires reuse the SAME
    // instances.
    // Note: a per-worker embedder slot is carried in WorkerLlmSet and the
    // injected record for forward-compat with Task A8/A10 per-session wiring.
    // The worker's embedder is resolved through `BuildAgentDeps.resolveEmbedder`
    // inside the factories below (`_workerRagInput`), not separately here.
    // Resolve (build-once or load from cache) the worker's own
    // toolsRag/historyRag/mcpClients. The cache is keyed by worker name; the
    // primary build() populates it (no `injected` arg), and per-session
    // re-wires (`injected` set) read from it via the same call below — the
    // cache hit short-circuits all factories. This keeps the worker's
    // declared RAG/MCP intact across per-session re-wires (review HIGH #1).
    const cached = await resolveWorkerLlmSet({
      name,
      cache: this._workers.cache,
      // Worker-OWN tools RAG (from subCfg.rag, if declared). Built once;
      // re-wired per-session by reference — never re-vectorized.
      // rag.retrieval is server-wide: the worker's stores take the MAIN
      // config's strategy for their key (§13.4).
      makeToolsRag: subCfg.rag
        ? async () =>
            this.withStrategy(
              'tools',
              await this._deps.makeRag(
                await this._workerRagInput(
                  name,
                  subCfg.rag as SmartServerRagConfig,
                  subCfg.embedder,
                  embedderFactories,
                ),
              ),
            )
        : undefined,
      makeHistoryRag: subCfg.rag
        ? async () =>
            this.withStrategy(
              'history',
              await this._deps.makeRag(
                await this._workerRagInput(
                  name,
                  subCfg.rag as SmartServerRagConfig,
                  subCfg.embedder,
                  embedderFactories,
                ),
              ),
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

    subBuilder = subBuilder.withHelperLlm(helperLlm);

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
    // What this wire takes from the parent (spec §10.5.12 U10): kept — the
    // consumer chose it by declaring none of its own — and logged below.
    const shared: ('toolsRag' | 'mcpClients')[] = [];
    if (cached.toolsRag) {
      subBuilder = subBuilder.setToolsRag(cached.toolsRag);
      if (cached.historyRag) {
        subBuilder = subBuilder.setHistoryRag(cached.historyRag);
      }
    } else if (injected?.toolsRag) {
      subBuilder = subBuilder.setToolsRag(injected.toolsRag);
      shared.push('toolsRag');
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
      shared.push('mcpClients');
    }
    if (shared.length > 0) {
      (this.cfg.log ?? this.noop)({
        event: 'worker_uses_shared_clients',
        worker: name,
        shared,
      });
    }

    // rag.retrieval is server-wide: a worker's projection (named collections
    // of the shared registry included) gets the same per-store strategies.
    // Its own tools/history are already wrapped; the brand keeps them as is.
    for (const [key, strategy] of this._retrievalStrategies) {
      subBuilder = subBuilder.withRetrievalStrategy(key, strategy);
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

  /**
   * A server-built store (`tools` / `history`, main or worker) wrapped in the
   * strategy `rag.retrieval` configures for its key; unlisted → unchanged.
   * Idempotent (`applyRetrievalStrategy`), so the builder's projection of the
   * same store never wraps it twice — one rerank per query.
   */
  private withStrategy(key: 'tools' | 'history', store: IRag): IRag {
    const strategy = this._retrievalStrategies.get(key);
    return strategy ? applyRetrievalStrategy(store, strategy) : store;
  }

  /** A worker's own store input: its embedder through the seam, then paired. */
  private async _workerRagInput(
    name: string,
    rag: SmartServerRagConfig,
    diEmbedder: IEmbedder | undefined,
    extraFactories: Record<string, EmbedderFactory>,
  ): Promise<MakeRagInput> {
    const embedder = await resolveRetrievalEmbedder(
      rag,
      diEmbedder,
      this._deps.resolveEmbedder,
      extraFactories,
      this._fileLogger,
    );
    return toMakeRagInput(rag.store, embedder, `subagent '${name}' rag`);
  }

  /** `ctx.resolveLlm(role)` — the role's default, through the held role map. */
  private async resolveRoleLlm(role: string): Promise<ILlm> {
    return this.roleLlm().resolve(role);
  }

  /** `ctx.resolveNamedLlm(key)` — strict: an `llm:` entry of exactly that name. */
  private async resolveNamedRoleLlm(key: string): Promise<ILlm> {
    return this.roleLlm().resolveNamed(key);
  }

  /** A worker role's LLM: its named key strictly, else the role's own name —
   *  the same resolver the pipeline reads, so instances are shared (§4.6.7). */
  private async resolveWorkerRoleLlm(
    key: string | undefined,
    role: 'main' | 'helper' | 'classifier',
  ): Promise<ILlm> {
    return key !== undefined
      ? this.roleLlm().resolveNamed(key)
      : this.roleLlm().resolve(role);
  }

  /** `llm` behind its key's circuit breaker when `circuitBreaker:` is set. */
  private guardLlm(llm: ILlm, key: string): ILlm {
    return this._llmBreakers ? this._llmBreakers.wrap(llm, key) : llm;
  }

  /** The `wrap` argument of the main `resolveRetrievalEmbedder` call, if any. */
  private embedderBreakerWrap():
    | ((embedder: IEmbedder) => IEmbedder)
    | undefined {
    const breaker = this._embedderBreaker;
    return breaker ? (e) => withCircuitBreaker(e, breaker) : undefined;
  }

  /** `/health`'s breakers: every key's current LLM breaker, then the embedder's. */
  private breakerList(): (() => readonly CircuitBreaker[]) | undefined {
    const llm = this._llmBreakers;
    const embedder = this._embedderBreaker;
    if (!llm || !embedder) return undefined;
    return () => [...llm.list(), embedder];
  }

  private roleLlm(): IRoleLlmResolver {
    if (!this._roleLlm) {
      throw new Error(
        'role LLM lookup invoked before _buildInfra built the resolver',
      );
    }
    return this._roleLlm;
  }

  /**
   * Session-scoped knowledge RAG over the shared knowledge backend (built
   * unconditionally in `start()`; a fresh in-memory backend is a defensive
   * fallback). HOST-level seeding happens HERE so the stepper plugin stays
   * agnostic (it just calls `ctx.knowledgeRagFor`): a BRAND-NEW session is
   * seeded from `pipeline.config.knowledgeSeed` (read once at start, D83 (12) —
   * absent for non-stepper pipelines, where an empty seed is a harmless no-op). Idempotent
   * on resume via `seedSessionKnowledge`.
   */
  private async knowledgeRagFor(
    sessionId: string,
  ): Promise<IKnowledgeRagHandle> {
    const backend =
      this._stepperKnowledgeBackend ?? new InMemoryKnowledgeBackend();
    const kr = new KnowledgeRag(backend, sessionId);
    await seedSessionKnowledge(
      kr,
      this._knowledgeSeed,
      new Date().toISOString(),
    );
    return kr;
  }

  /**
   * Memoized namespaced bridge over the GLOBAL `_sharedMcpClients` (#244
   * Task 8). Built once, lazily, from the authoritative snapshot's provenance
   * rebound onto `_sharedMcpClients` + `_sharedMcpClientDescriptors` — the
   * dispatch TARGET stays the server-wide shared clients (never retargeted to
   * a session's clients here); only `buildServerCtx`'s per-session
   * `ctx.toolClientMap` uses the session-scoped clients.
   */
  private _namespacedCallMcpBridge?: (
    name: string,
    args: unknown,
    signal?: AbortSignal,
  ) => Promise<McpCallResult>;

  /** callMcp bridge over the shared connected MCP clients (empty when none). */
  private callMcp(
    name: string,
    args: unknown,
    signal?: AbortSignal,
  ): Promise<McpCallResult> {
    // Namespaced routing (#244 Task 8): when the authoritative snapshot has
    // provenance (collision path took effect), dispatch namespaced exposed
    // names to their owning client via the shared bridge — memoized so the
    // rebind only runs once. No provenance (no MCP / no collisions) falls
    // back to today's plain `buildMcpBridge` scan, unchanged.
    if (this._toolProvenance) {
      if (!this._namespacedCallMcpBridge) {
        const toolClientMap = rebindProvenanceToClients(
          this._toolProvenance,
          this._sharedMcpClients ?? [],
          this._sharedMcpClientDescriptors,
        );
        this._namespacedCallMcpBridge = buildNamespacedMcpBridge(
          toolClientMap,
          this._mcpFailureClassifier,
        );
      }
      return this._namespacedCallMcpBridge(name, args, signal);
    }
    return buildMcpBridge(
      this._sharedMcpClients ?? [],
      this._mcpFailureClassifier,
    )(name, args, signal);
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
  /**
   * Resolve MCP clients paired with per-slot descriptors (#244) for the YAML
   * `mcp:` path, honoring provisioning precedence:
   *   1. An injected `connectMcpWithDescriptors` seam wins outright — it
   *      already reports its own descriptors/configuredSlotCount.
   *   2. Else an injected bare `connectMcp` wins next — its clients get
   *      synthesized array-index descriptors (a bare connector cannot report
   *      labels), `configuredSlotCount` = the connected count.
   *   3. Else (neither seam injected) fall back to the descriptor-producing
   *      default, `connectMcpClientsWithDescriptorsFromConfig`, which DOES
   *      read `cfg.name` labels.
   * Used at both seam call sites so `_sharedMcpClientDescriptors` /
   * `_configuredSlotCount` are populated consistently regardless of which
   * path provisioned the clients (Tasks 6/7 consume these fields).
   */
  private async _resolveMcpWithDescriptors(
    mcpCfg: SmartServerMcpConfig | SmartServerMcpConfig[] | undefined | null,
  ): Promise<McpClientsWithDescriptors> {
    let resolved: McpClientsWithDescriptors;
    if (this._deps.connectMcpWithDescriptors) {
      resolved = await this._deps.connectMcpWithDescriptors(mcpCfg);
    } else if (this._connectMcpInjected) {
      const clients = await this._deps.connectMcp(mcpCfg);
      resolved = {
        clients,
        clientDescriptors: clients.map((_, slotIndex) => ({ slotIndex })),
        configuredSlotCount: clients.length,
      };
    } else {
      resolved = await connectMcpClientsWithDescriptorsFromConfig(mcpCfg);
    }
    // Recorded as a side effect (not just returned) so `_sharedMcpClientDescriptors`
    // / `_configuredSlotCount` are populated at BOTH seam call sites through this
    // single funnel — kept in sync with `_sharedMcpClients` for Tasks 6/7.
    this._sharedMcpClientDescriptors = resolved.clientDescriptors;
    this._configuredSlotCount = resolved.configuredSlotCount;
    this.cfg.log?.({
      event: 'mcp_descriptors_resolved',
      configuredSlotCount: this._configuredSlotCount,
      clientDescriptorCount: this._sharedMcpClientDescriptors?.length,
    });
    return resolved;
  }

  private async buildSharedPipelineInfra(input: {
    toolsRag: IRag | undefined;
    resolvedEmbedder: IRetrievalEmbedder | undefined;
    mcpClients: IMcpClient[] | undefined;
  }): Promise<void> {
    const { toolsRag, resolvedEmbedder, mcpClients } = input;

    // Record the resolved embedder BEFORE building the knowledge backend so the
    // backend can attach the embedder-backed semantic index (controller recall).
    if (resolvedEmbedder) this._resolvedEmbedder = resolvedEmbedder;
    this.buildKnowledgeBackend();

    // MCP clients for the callMcp bridge. DI/plugin clients win; otherwise
    // connect the YAML `mcp:` block ONCE (connect is not safe to invoke twice
    // on the same wrapper — guard via the cache field). Seam precedence
    // (connectMcpWithDescriptors > bare connectMcp > default) — and recording
    // `_sharedMcpClientDescriptors`/`_configuredSlotCount` — is handled by
    // `_resolveMcpWithDescriptors` (#244).
    if (!mcpClients && !this._stepperMcpClients) {
      const resolvedMcp = await this._resolveMcpWithDescriptors(this.cfg.mcp);
      this._stepperMcpClients = resolvedMcp.clients;
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
   * Resolve the ONE authoritative namespaced tool snapshot (#244 Task 6) —
   * `this._namespacedTools` / `this._toolProvenance` — from whichever source
   * applies:
   *   - yaml-builder path: the startup builder already computed it, harvested
   *     onto these SAME fields right after `builder.build()` (see the
   *     `agentHandle.namespacedTools`/`toolProvenance` destructure above). This
   *     method is then a no-op (memoized on `_toolProvenance`).
   *   - seam / consumer-builder path (ready clients, or an injected MCP seam):
   *     the handle carries no snapshot (the builder skipped its own connect via
   *     `withMcpClients`), so build ONE here via `buildNamespacedTools` over
   *     `_sharedMcpClients` + `_sharedMcpClientDescriptors` + the server's
   *     `_toolNamespace` — the SAME strategy instance threaded onto the
   *     startup builder, so both snapshot sources agree on the naming rule.
   *
   * Every client must list its tools: any failure rejects with that client's
   * McpError and nothing is memoized (spec §10.5.3 M11). Each client keeps its
   * descriptor's `slotIndex`.
   */
  private async resolveAuthoritativeSnapshot(): Promise<void> {
    // Memoized: a handle-carried snapshot (yaml path) or a prior fallback
    // build (seam path) both set `_toolProvenance` — either way, done.
    if (this._toolProvenance) return;
    const clients = this._sharedMcpClients ?? [];
    if (clients.length === 0) return;
    const descs: readonly McpClientDescriptor[] =
      this._sharedMcpClientDescriptors ??
      clients.map((_, i) => ({ slotIndex: i }));
    // Spec §10.5.3 M11: a client that cannot list its tools fails the
    // snapshot with its McpError; nothing is memoized, so a later call builds
    // it once the client recovers.
    const settled = await Promise.allSettled(
      clients.map((client) => client.listTools()),
    );
    const perClient: NamespaceClientInput[] = listedToolsOrThrow(settled).map(
      (tools, i) => ({
        slotIndex: descs[i]?.slotIndex ?? i,
        label: descs[i]?.label,
        client: clients[i],
        tools,
      }),
    );
    const built = buildNamespacedTools(perClient, this._toolNamespace);
    this._namespacedTools = built.tools;
    this._toolProvenance = built.provenance;
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
   *
   * Also resolves the authoritative namespaced snapshot (#244 Task 6) via
   * `resolveAuthoritativeSnapshot()` — a no-op when the yaml-builder path
   * already harvested one from the handle — and passes it into
   * `makeToolsRagHandle` so the catalog is keyed by the EXPOSED (namespaced)
   * name.
   */
  private async buildToolsRagHandle(input: {
    toolsRag: IRag | undefined;
    resolvedEmbedder: IRetrievalEmbedder | undefined;
  }): Promise<void> {
    const { toolsRag, resolvedEmbedder } = input;
    await this.resolveAuthoritativeSnapshot();
    this._toolsRagHandle = await makeToolsRagHandle(
      this._sharedMcpClients ?? [],
      toolsRag,
      resolvedEmbedder,
      this._namespacedTools
        ? { namespacedTools: this._namespacedTools }
        : undefined,
    );
  }

  /**
   * Build the per-session pipeline instance from the plugin selected at startup,
   * against a session-scoped pipeline context. The returned `IPipelineInstance`
   * carries `{ agent, close }`; `buildSessionAgent` registers `close` into the
   * session-dispose path.
   */
  private async buildPipelineInstance(scope: {
    sessionId: string;
    parts: SessionAgentParts;
    historyRag?: IRag;
  }): Promise<IPipelineInstance> {
    return this._pipelinePlugin.build(await this.buildServerCtx(scope));
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
    // Per-session namespaced tool-client map (#244 Task 8): rebind the
    // authoritative snapshot's provenance (`_toolProvenance`, resolved once at
    // startup via `resolveAuthoritativeSnapshot()`) onto THIS session's own
    // MCP clients, pairing by `slotIndex` from `scope.parts.mcpClientDescriptors`
    // — never by array index (a filtered/reordered per-session client set would
    // otherwise rebind to the wrong client). No provenance (no MCP / no
    // collisions) leaves `toolClientMap` undefined so the pipeline's own
    // fallback bridge (`buildMcpBridge(ctx.mcpClients, …)`) applies unchanged.
    const toolClientMap = this._toolProvenance
      ? rebindProvenanceToClients(
          this._toolProvenance,
          scope.parts.mcpClients,
          scope.parts.mcpClientDescriptors,
        )
      : undefined;
    return createServerPipelineContext({
      resolveLlm: (role) => this.resolveRoleLlm(role),
      resolveNamedLlm: (key) => this.resolveNamedRoleLlm(key),
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
      ...(toolClientMap ? { toolClientMap } : {}),
      mcpFailureClassifier: this._mcpFailureClassifier,
      ...(this._toolLoopContextStrategyFactory
        ? {
            toolLoopContextStrategyFactory:
              this._toolLoopContextStrategyFactory,
          }
        : {}),
      ...(this._stepExecutionControl
        ? { stepExecutionControl: this._stepExecutionControl }
        : {}),
      ...(this._runExecutionControl
        ? { runExecutionControl: this._runExecutionControl }
        : {}),
      ...(this._auxiliaryMcpTools
        ? { auxiliaryMcpTools: this._auxiliaryMcpTools }
        : {}),
      ...(this._waitStrategy ? { waitStrategy: this._waitStrategy } : {}),
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
      mainLlm: this._mainLlm as ILlm,
      helperLlm: this._helperLlm,
      mainTemp: this._mainTemp,
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
   * `applyServerExtras` now guards only the YAML `mcp:` auto-connect fallback,
   * which stays startup-only (one connection). It also decides whether the skill
   * manager vectorizes its skills into the tools store (startup build only).
   * Not gated, because per-session agents serve the requests: the reranker
   * (§7.4), the per-store retrieval strategies and `agent.toolSelection`
   * (§13.4), the shared embedder circuit breaker (§14.2), and the output
   * validator, query expander, skill manager, LLM-call strategy and client
   * adapters (§14.1).
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
    // The server's one provider registry: without it build() substitutes an
    // empty one and sets it on the session's registry, and an adopted
    // collection's delete then reaches no provider.
    builder = builder.setRagProviderRegistry(this._ragProviderRegistry);
    if (parts.requestLogger) {
      builder = builder.withRequestLogger(parts.requestLogger);
    }

    // Not gated: requests are served by per-session agents, built with
    // applyServerExtras=false; the startup agent is infrastructure only.
    if (this._reranker) {
      builder = builder.withReranker(this._reranker);
    }
    // Not gated, same reason: the per-store strategies reach every store the
    // pipeline reads through the builder's `ragStores` projection (named
    // collections included). Server-built stores are already wrapped; the
    // projection sees the brand and leaves them as they are.
    for (const [key, strategy] of this._retrievalStrategies) {
      builder = builder.withRetrievalStrategy(key, strategy);
    }
    // Not gated, same reason: `agent.toolSelection` must reach the per-session
    // agents that serve requests (§13.4). With a reranked `tools` store,
    // `minScore` compares reranker probabilities in [0, 1], not cosine.
    if (this._toolSelectionStrategy) {
      builder = builder.withToolSelectionStrategy(this._toolSelectionStrategy);
    }

    // Not gated, same reason: the output validator, query expander, skill
    // manager, LLM-call strategy and client adapters reach the per-session
    // agents that serve requests (§14.1). Skills are vectorized into the tools
    // store by the startup build only.
    if (this._queryExpander) {
      builder = builder.withQueryExpander(this._queryExpander);
    }
    if (this._outputValidator) {
      builder = builder.withOutputValidator(this._outputValidator);
    }
    if (this._skillManager) {
      builder = builder.withSkillManager(this._skillManager, {
        vectorize: parts.applyServerExtras,
      });
    }
    if (this._llmCallStrategyFactory) {
      builder = builder.withLlmCallStrategy(this._llmCallStrategyFactory());
    }
    for (const adapter of this._clientAdapters) {
      builder = builder.withClientAdapter(adapter);
    }

    if (parts.mcpClients) {
      builder = builder.withMcpClients(parts.mcpClients);
    }

    if (parts.workerRegistry.size > 0) {
      builder = builder.withSubAgents(parts.workerRegistry);
    }

    // Thread the instance-level MCP failure classifier (DI/programmatic only).
    builder = builder.withMcpFailureClassifier(this._mcpFailureClassifier);

    // Thread the tool-namespacing strategy (#244) so the startup builder's OWN
    // namespaced snapshot (yaml-builder-connect path) honors the same rule as
    // `resolveAuthoritativeSnapshot()`'s server-side fallback build below.
    builder = builder.withToolNamespace(this._toolNamespace);

    // Tool-loop context strategy for the NON-controller pipelines (default / flat /
    // linear / dag / direct SmartAgent). Honor a consumer-injected factory; else
    // default to a bounded RAG-less Window (a strict improvement over Legacy's
    // unbounded growing transcript). This Window default is applied ONLY on this
    // builder channel — NOT on the ctx seam — so it never reaches the controller's
    // own `ctx.toolLoopContextStrategyFactory ?? RagRecall` resolution.
    builder = builder.withToolLoopContextStrategyFactory(
      this._toolLoopContextStrategyFactory ??
        (() => new WindowContextStrategy()),
    );

    return builder;
  }

  /** The registry one session owns; see buildSessionRagRegistry. */
  private _sessionRagRegistry(
    identity: SessionGraphIdentity,
  ): Promise<IRagRegistry> {
    if (!this._globalRagRegistry) {
      throw new Error(
        'A session RAG registry was requested before the server infra was built',
      );
    }
    return buildSessionRagRegistry({
      identity,
      globals: this._globalRagRegistry,
      providers: this._ragProviderRegistry,
      logger: this._fileLogger,
      reported: this._reportedCatalogFindings,
    });
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
      historyRag: this._historyRag,
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
    try {
      // Register/touch the session in the meta store so /v1/sessions, resume
      // and delete reflect real chat/stream traffic (review Finding 3). A
      // failed write fails the request (spec §10.5.9 V5): the server's
      // catch-all answers 500 jsonError, and the graph is released below.
      await recordSessionStart(
        this._sessionMetaStore,
        sessionId,
        new Date().toISOString(),
      );
      await fn(graph, sessionId, traceId);
    } finally {
      // End-of-request cleanup (spec §10.5.9 V5): a failure here does not
      // change the response already served — it is logged, never swallowed.
      try {
        await recordSessionEnd(
          this._sessionMetaStore,
          sessionId,
          new Date().toISOString(),
        );
      } catch (err) {
        (this.cfg.log ?? this.noop)({
          event: 'session_meta_end_failed',
          sessionId,
          traceId,
          error: err instanceof Error ? err.message : String(err),
        });
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
    // Server readiness (spec §10.5.10, D82): the agent's MCP connection
    // strategy (IReadinessReporter; none / non-reporting ⇒ ready) AND the
    // config state — a config change that failed to apply leaves the server
    // not ready until a later one applies. Computed ONCE here and reused by
    // /health and the pre-dispatch request gate (messages/chat) via `rc.ready`.
    const mcpReady = isReadinessReporter(smartAgent)
      ? smartAgent.isReady()
      : true;
    const configNotApplied = this._configTransactions.notApplied;
    const ready = mcpReady && configNotApplied === undefined;
    const notReadyMessage = configNotApplied
      ? `config not applied — ${configNotApplied.reason}`
      : mcpReady
        ? undefined
        : 'MCP unavailable — server not ready';
    const rc: RouteContext = {
      req,
      res,
      rawUrl,
      urlPath,
      method: req.method ?? 'GET',
      ready,
      notReadyMessage,
      configNotApplied,
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
      handle: (rc) => handleModelsList(rc),
    });
    table.add({
      method: 'GET',
      match: (p) => p === '/v1/embedding-models' || p === '/embedding-models',
      handle: (rc) => handleEmbeddingModelsList(rc),
    });
    table.add({
      method: 'GET',
      match: (p) => p === '/v1/usage',
      handle: (rc) => handleUsageRoute(rc, rc.server._lifecycle),
    });
    // GET /v1/sessions — list sessions for the current identity
    table.add({
      method: 'GET',
      match: (p) => p === '/v1/sessions',
      handle: (rc) =>
        handleSessionsList(
          rc,
          rc.server._lifecycle,
          rc.server._sessionMetaStore,
        ),
    });
    // POST /v1/sessions/:id/resume — resume a session
    table.add({
      method: 'POST',
      match: (p) => p.match(/^\/v1\/sessions\/([^/]+)\/resume$/) ?? false,
      handle: (rc) =>
        handleSessionResume(
          rc,
          rc.server._lifecycle,
          rc.server._sessionMetaStore,
        ),
    });
    // DELETE /v1/sessions/:id — delete a session
    table.add({
      method: 'DELETE',
      match: (p) => p.match(/^\/v1\/sessions\/([^/]+)$/) ?? false,
      handle: (rc) =>
        handleSessionDelete(
          rc,
          rc.server._lifecycle,
          rc.server._sessionMetaStore,
          rc.server._stepperKnowledgeBackend,
        ),
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
          await handleConfigUpdate(
            rc.req,
            rc.res,
            rc.smartAgent,
            this._configUpdateTarget(),
          );
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
      handle: (rc) => handleHealthRoute(rc),
    });
    // POST /v1/messages or /messages → Anthropic adapter
    table.add({
      method: 'POST',
      match: (p) => p === '/v1/messages' || p === '/messages',
      handle: async (rc) => {
        // Pre-dispatch readiness gate: fail loud (503) BEFORE opening any stream.
        if (!rc.ready) {
          writeNotReady(rc.res, rc.notReadyMessage);
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
              this.cfg.agent?.heartbeatIntervalMs,
              rc.log,
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
          writeNotReady(rc.res, rc.notReadyMessage);
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

  /**
   * Build the PUT /v1/config hot-swap seam over this server's private state.
   * The setters write the SAME `_mainLlm`/`_classifierLlm`/`_helperLlm` fields
   * RoleLlmResolver's live accessors read, so the hot-swap stays observable.
   * A private object literal — NOT `implements` — so the public class shape is
   * unchanged (byte-stable public API).
   */
  private _configUpdateTarget(): IConfigUpdateTarget {
    return {
      modelResolver: this.cfg.modelResolver,
      skipModelValidation: this.cfg.skipModelValidation === true,
      // A swapped-in LLM gets a fresh breaker for its key (§14.2).
      setMainLlm: (llm) => {
        this._mainLlm = this.guardLlm(llm, 'main');
        return this._mainLlm;
      },
      setClassifierLlm: (llm) => {
        this._classifierLlm = this.guardLlm(llm, 'classifier');
        return this._classifierLlm;
      },
      setHelperLlm: (llm) => {
        this._helperLlm = this.guardLlm(llm, 'helper');
        return this._helperLlm;
      },
      mirrorAgentCfg: (patch) => {
        const merged: Record<string, unknown> = {
          ...((this.cfg as { agent?: Record<string, unknown> }).agent ?? {}),
          ...patch,
        };
        (this.cfg as { agent?: Record<string, unknown> }).agent = merged;
      },
      drainWorkers: () => this._workers.drain(),
      invalidateSessions: () =>
        this._lifecycle?.invalidateAll() ?? Promise.resolve(),
      transactions: this._configTransactions,
    };
  }
}

/** Build a runnable agent for any configured pipeline WITHOUT binding a port.
 *  `SmartServer.start()` is the default impl that adds HTTP `listen` on top. */
export async function buildAgent(
  cfg: SmartServerConfig,
  deps: BuildAgentDeps,
): Promise<{ agent: ISmartAgent; close: () => Promise<void> }> {
  const server = new SmartServer(cfg, deps);
  const built = await server._buildEmbeddedAgent();
  return { agent: built.agent, close: built.close };
}
