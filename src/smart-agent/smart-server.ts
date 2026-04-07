/**
 * SmartServer — embeddable OpenAI-compatible HTTP server backed by SmartAgent.
 */

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import http from 'node:http';
import { PACKAGE_VERSION } from '../generated/version.js';
import type { Message } from '../types.js';
import type { SmartAgent, SmartAgentRagStores, StopReason } from './agent.js';
import { SmartAgentBuilder, type SmartAgentHandle } from './builder.js';
import {
  ConfigWatcher,
  type HotReloadableConfig,
} from './config/config-watcher.js';
import { HealthChecker } from './health/health-checker.js';
import type {
  ILlmApiAdapter,
  NormalizedRequest,
} from './interfaces/api-adapter.js';
import { AdapterValidationError } from './interfaces/api-adapter.js';
import type { IClientAdapter } from './interfaces/client-adapter.js';
import type { IMcpClient } from './interfaces/mcp-client.js';
import type { IModelProvider } from './interfaces/model-provider.js';
import type { EmbedderFactory, IEmbedder } from './interfaces/rag.js';
import type { IRequestLogger } from './interfaces/request-logger.js';
import type { ISkillManager } from './interfaces/skill.js';
import { SessionLogger } from './logger/session-logger.js';
import type { ILogger } from './logger/types.js';
import type { PipelineConfig } from './pipeline.js';
import {
  FileSystemPluginLoader,
  getDefaultPluginDirs,
} from './plugins/index.js';
import type { IPluginLoader } from './plugins/types.js';
import { makeDefaultLlm, makeLlm, makeRag } from './providers.js';
import type { VectorRag } from './rag/vector-rag.js';
import { ClaudeSkillManager } from './skills/claude-skill-manager.js';
import { CodexSkillManager } from './skills/codex-skill-manager.js';
import { FileSystemSkillManager } from './skills/filesystem-skill-manager.js';
import {
  type ExternalToolValidationCode,
  normalizeAndValidateExternalTools,
} from './utils/external-tools-normalizer.js';
import { toToolCallDelta } from './utils/tool-call-deltas.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface SmartServerLlmConfig {
  apiKey: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  classifierTemperature?: number;
}

export interface SmartServerRagConfig {
  type?: 'ollama' | 'openai' | 'in-memory' | 'qdrant';
  /**
   * Embedder name — resolved from the embedder factory registry.
   * Built-in: 'ollama', 'openai'. Consumers can register custom factories.
   * When omitted, defaults to 'ollama'.
   */
  embedder?: string;
  url?: string;
  model?: string;
  collectionName?: string;
  dedupThreshold?: number;
  vectorWeight?: number;
  keywordWeight?: number;
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
  /** RAG retrieval behavior. 'auto' | 'always' | 'never'. Default: 'auto'. */
  ragRetrievalMode?: 'auto' | 'always' | 'never';
  /** Whether to translate non-ASCII RAG queries to English. Default: true. */
  ragTranslationEnabled?: boolean;
  /** Whether to upsert classified subprompts to RAG stores. Default: true. */
  ragUpsertEnabled?: boolean;
  /** LLM call strategy for tool-loop. 'streaming' (default) | 'non-streaming' | 'fallback'. */
  llmCallStrategy?: 'streaming' | 'non-streaming' | 'fallback';
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
  llm: SmartServerLlmConfig;
  rag?: SmartServerRagConfig;
  mcp?: SmartServerMcpConfig;
  agent?: SmartServerAgentConfig;
  prompts?: SmartServerPromptsConfig;
  mode?: SmartServerMode;
  pipeline?: PipelineConfig;
  log?: (event: Record<string, unknown>) => void;
  logDir?: string;
  circuitBreaker?: SmartServerCircuitBreakerConfig;
  version?: string;
  /** Path to YAML config file for hot-reload. */
  configFile?: string;
  /** Additional plugin directory (merged with defaults). Used by the default FileSystemPluginLoader. */
  pluginDir?: string;
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
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// ---------------------------------------------------------------------------
// SmartServer
// ---------------------------------------------------------------------------

export {
  generateConfigTemplate,
  loadYamlConfig,
  type ResolveConfigArgs,
  resolveEnvVars,
  resolveSmartServerConfig,
  YAML_TEMPLATE,
  type YamlConfig,
} from './config.js';

export class SmartServer {
  private readonly cfg: SmartServerConfig;
  private readonly noop = () => {};

  constructor(config: SmartServerConfig) {
    this.cfg = config;
  }

  async start(): Promise<SmartServerHandle> {
    const log = this.cfg.log ?? this.noop;
    const fileLogger: ILogger = {
      log: (e) => log(e as unknown as Record<string, unknown>),
    };
    const pipeline = this.cfg.pipeline;

    // ---- Composition root: resolve config → interfaces --------------------

    // LLM resolution
    const mainTemp = Number(
      pipeline?.llm?.main?.temperature ?? this.cfg.llm.temperature ?? 0.7,
    );
    const mainLlm = pipeline?.llm?.main
      ? makeLlm(pipeline.llm.main, mainTemp)
      : makeDefaultLlm(
          this.cfg.llm.apiKey,
          this.cfg.llm.model ?? 'deepseek-chat',
          mainTemp,
        );

    const classifierTemp = Number(
      pipeline?.llm?.classifier?.temperature ??
        this.cfg.llm.classifierTemperature ??
        0.1,
    );
    const classifierLlm = pipeline?.llm?.classifier
      ? makeLlm(pipeline.llm.classifier, classifierTemp)
      : pipeline?.llm?.main
        ? makeLlm(pipeline.llm.main, classifierTemp)
        : makeDefaultLlm(
            this.cfg.llm.apiKey,
            this.cfg.llm.model ?? 'deepseek-chat',
            classifierTemp,
          );

    const helperLlm = pipeline?.llm?.helper
      ? makeLlm(
          pipeline.llm.helper,
          Number(pipeline.llm.helper.temperature ?? 0.1),
        )
      : undefined;

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

    // Merge plugin embedder factories with config-provided ones
    const mergedEmbedderFactories = {
      ...plugins.embedderFactories,
      ...this.cfg.embedderFactories, // config takes precedence over plugins
    };

    // RAG resolution
    const ragOptions = {
      injectedEmbedder: this.cfg.embedder,
      extraFactories: mergedEmbedderFactories,
    };

    const stores: SmartAgentRagStores = {};
    if (pipeline?.rag) {
      for (const [key, ragCfg] of Object.entries(pipeline.rag)) {
        if (ragCfg) stores[key] = makeRag(ragCfg, ragOptions);
      }
    } else if (this.cfg.rag) {
      const ragCfg = this.cfg.rag;
      const rag = makeRag(ragCfg, ragOptions);
      stores.facts = rag;
      stores.feedback = makeRag({ ...ragCfg }, ragOptions);
      stores.state = makeRag({ ...ragCfg }, ragOptions);
    }

    // ---- Build agent via Builder (interface-only) -------------------------
    let builder = new SmartAgentBuilder({
      mcp: pipeline?.mcp ?? this.cfg.mcp,
      agent: this.cfg.agent,
      prompts: this.cfg.prompts,
      skipModelValidation: this.cfg.skipModelValidation,
    })
      .withMainLlm(mainLlm)
      .withClassifierLlm(classifierLlm)
      .withLogger(fileLogger)
      .withMode(this.cfg.mode ?? 'smart');

    if (helperLlm) {
      builder = builder.withHelperLlm(helperLlm);
    }

    if (Object.keys(stores).length > 0) {
      builder = builder.withRag(stores);
    }

    if (this.cfg.circuitBreaker) {
      builder = builder.withCircuitBreaker(this.cfg.circuitBreaker);
    }

    // Apply pre-loaded plugin registrations to builder
    // (pre-loaded above to extract embedder factories before RAG resolution)
    for (const [type, handler] of plugins.stageHandlers) {
      builder = builder.withStageHandler(type, handler);
    }
    if (plugins.reranker) {
      builder = builder.withReranker(plugins.reranker);
    }
    if (plugins.queryExpander) {
      builder = builder.withQueryExpander(plugins.queryExpander);
    }
    if (plugins.outputValidator) {
      builder = builder.withOutputValidator(plugins.outputValidator);
    }

    // Skill manager (DI > YAML config > plugin)
    const skillManager =
      this.cfg.skillManager ??
      plugins.skillManager ??
      resolveSkillManager(this.cfg.skills);
    if (skillManager) {
      builder = builder.withSkillManager(skillManager);
    }

    // LLM call strategy (from agent config)
    const strategyName = this.cfg.agent?.llmCallStrategy;
    if (strategyName) {
      const { StreamingLlmCallStrategy } = await import(
        './policy/streaming-llm-call-strategy.js'
      );
      const { NonStreamingLlmCallStrategy } = await import(
        './policy/non-streaming-llm-call-strategy.js'
      );
      const { FallbackLlmCallStrategy } = await import(
        './policy/fallback-llm-call-strategy.js'
      );
      const strategies = {
        streaming: () => new StreamingLlmCallStrategy(),
        'non-streaming': () => new NonStreamingLlmCallStrategy(),
        fallback: () => new FallbackLlmCallStrategy(fileLogger),
      };
      const factory = strategies[strategyName];
      if (factory) {
        builder = builder.withLlmCallStrategy(factory());
      }
    }

    // MCP clients (DI > plugin; YAML fallback handled by builder)
    const mcpClients =
      this.cfg.mcpClients ??
      (plugins.mcpClients.length > 0 ? plugins.mcpClients : undefined);
    if (mcpClients) {
      builder = builder.withMcpClients(mcpClients);
    }

    // Client adapters (DI > plugin; ClineClientAdapter is always registered as default)
    const { ClineClientAdapter } = await import(
      './adapters/cline-client-adapter.js'
    );
    const adapterSources = [
      ...(this.cfg.clientAdapters ?? []),
      ...plugins.clientAdapters,
      new ClineClientAdapter(),
    ];
    for (const adapter of adapterSources) {
      builder = builder.withClientAdapter(adapter);
    }

    // Structured pipeline (when YAML contains `pipeline.stages`)
    if (pipeline?.stages && Array.isArray(pipeline.stages)) {
      builder = builder.withPipeline({
        version: pipeline.version ?? '1',
        stages: pipeline.stages,
      });
    }

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

    // ---- API adapter map (built-in → config DI; DI wins) --------------------
    const { OpenAiApiAdapter } = await import(
      './api-adapters/openai-adapter.js'
    );
    const { AnthropicApiAdapter } = await import(
      './api-adapters/anthropic-adapter.js'
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
        if (update.ragRetrievalMode !== undefined)
          agentUpdate.ragRetrievalMode = update.ragRetrievalMode;
        if (update.ragTranslationEnabled !== undefined)
          agentUpdate.ragTranslationEnabled = update.ragTranslationEnabled;
        if (update.ragUpsertEnabled !== undefined)
          agentUpdate.ragUpsertEnabled = update.ragUpsertEnabled;
        if (Object.keys(agentUpdate).length > 0) {
          smartAgent.applyConfigUpdate(agentUpdate);
        }
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
            for (const fn of closeFns) await fn();
            await new Promise<void>((res, rej) =>
              server.close((e) => (e ? rej(e) : res())),
            );
          },
          requestLogger,
        });
      });
    });
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
      let data: Array<Record<string, unknown>> = [
        { id: 'smart-agent', object: 'model', owned_by: 'smart-agent' },
      ];
      if (modelProvider) {
        const result = await modelProvider.getModels();
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
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(requestLogger.getSummary()));
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
      await this._handleAdapterRequest(req, res, smartAgent, anthropicAdapter);
      return;
    }
    if (
      req.method === 'POST' &&
      (urlPath === '/v1/chat/completions' || urlPath === '/chat/completions')
    ) {
      await this._handleChat(
        req,
        res,
        requestLogger,
        smartAgent,
        chat,
        streamChat,
        log,
        modelProvider,
      );
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

    if (normalized.stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      for await (const event of adapter.transformStream(
        agent.streamProcess(normalized.messages, normalized.options),
        normalized.context,
      )) {
        const eventLine = event.event ? `event: ${event.event}\n` : '';
        res.write(`${eventLine}data: ${event.data}\n\n`);
      }
      res.end();
      return;
    }

    // Non-streaming
    const result = await agent.process(normalized.messages, normalized.options);
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

    const traceId = randomUUID();
    const sessionId = (req.headers['x-session-id'] as string) || 'default';
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

      const stream = smartAgent.streamProcess(normalizedMessages, opts);
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
            (t) => `${t.phase}=${t.duration}ms`,
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
            delta.tool_calls = chunk.value.toolCalls.map((call, index) => {
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
            });
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

    const result = await smartAgent.process(normalizedMessages, opts);
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
}
