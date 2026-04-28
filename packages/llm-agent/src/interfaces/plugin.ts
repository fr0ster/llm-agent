/**
 * Plugin types for SmartAgent extensibility.
 *
 * Plugins allow consumers to attach named RAG stores (with lifecycle scopes)
 * and extend classifier prompts without modifying core agent code.
 */

import type { IClientAdapter } from './client-adapter.js';
import type { ILlmApiAdapter } from './api-adapter.js';
import type { IMcpClient } from './mcp-client.js';
import type { IQueryExpander } from '../rag/query-expander.js';
import type { ISkillManager } from './skill.js';
import type { EmbedderFactory } from './rag.js';
import type { IRag } from './rag.js';
import type { IReranker } from './reranker.js';
import type { IOutputValidator } from './validator.js';

// ---------------------------------------------------------------------------
// RAG scope
// ---------------------------------------------------------------------------

/**
 * Lifecycle scope of a RAG store provided by a plugin.
 *
 * - `'global'`  — shared across all users and sessions; evicted only on restart.
 * - `'user'`    — scoped to a single user; evicted when the user session ends.
 * - `'session'` — scoped to a single conversation session; evicted when the session ends.
 */
export type RagScope = 'global' | 'user' | 'session';

// ---------------------------------------------------------------------------
// IRagStoreConfig
// ---------------------------------------------------------------------------

/**
 * Configuration for a single RAG store contributed by a plugin.
 */
export interface IRagStoreConfig {
  /** The RAG store implementation. */
  rag: IRag;
  /** Lifecycle scope that controls when the store is evicted. */
  scope: RagScope;
  /**
   * Optional time-to-live in seconds.
   * When set, records older than this value are excluded from retrieval.
   */
  ttl?: number;
}

// ---------------------------------------------------------------------------
// ISmartAgentPlugin
// ---------------------------------------------------------------------------

/**
 * A SmartAgent plugin that contributes RAG stores and optional classifier extensions.
 *
 * Plugins are passed to consumer pipeline implementations, not to the builder.
 * The default pipeline ignores plugins — only custom consumer pipelines use them.
 */
export interface ISmartAgentPlugin {
  /** Unique plugin identifier. */
  name: string;
  /**
   * Named RAG stores contributed by this plugin.
   * Keys are store names used to address results in pipeline stages.
   */
  ragStores: Record<string, IRagStoreConfig>;
  /**
   * Optional text appended to the classifier system prompt.
   * Use this to teach the classifier about domain-specific intents
   * introduced by this plugin.
   */
  classifierPromptExtension?: string;
}

// ---------------------------------------------------------------------------
// Plugin loader contract types
// ---------------------------------------------------------------------------

/**
 * Minimal stage handler interface for plugin registration.
 * The full `IStageHandler` (with typed PipelineContext) lives in llm-agent-server.
 */
export interface IStageHandler {
  // biome-ignore lint/suspicious/noExplicitAny: context type is server-defined
  execute(ctx: any, config: Record<string, unknown>, span: unknown): Promise<boolean>;
}

/**
 * Shape of a plugin module's named exports.
 * All fields are optional — a plugin can register any subset.
 */
export interface PluginExports {
  /** Custom pipeline stage handlers, keyed by stage type name. */
  stageHandlers?: Record<string, IStageHandler>;

  /** Custom embedder factories, keyed by embedder name. */
  embedderFactories?: Record<string, EmbedderFactory>;

  /** Custom RAG reranker (replaces the default). */
  reranker?: IReranker;

  /** Custom query expander (replaces the default). */
  queryExpander?: IQueryExpander;

  /** Custom output validator (replaces the default). */
  outputValidator?: IOutputValidator;

  /** Custom skill manager (replaces the default). */
  skillManager?: ISkillManager;

  /** Pre-built MCP clients (accumulated from all plugins). */
  mcpClients?: IMcpClient[];

  /** Client adapters for auto-detecting prompt-based clients (accumulated). */
  clientAdapters?: IClientAdapter[];

  /** API protocol adapters, keyed by adapter name. */
  apiAdapters?: Record<string, ILlmApiAdapter>;
}

/**
 * Result of loading all plugins.
 * Merged registrations from all discovered plugin sources.
 */
export interface LoadedPlugins {
  stageHandlers: Map<string, IStageHandler>;
  embedderFactories: Record<string, EmbedderFactory>;
  reranker?: IReranker;
  queryExpander?: IQueryExpander;
  outputValidator?: IOutputValidator;
  skillManager?: ISkillManager;
  mcpClients: IMcpClient[];
  clientAdapters: IClientAdapter[];
  apiAdapters: Map<string, ILlmApiAdapter>;
  /** Source identifiers for successfully loaded plugins. */
  loadedFiles: string[];
  /** Plugins that failed to load, with error messages. */
  errors: Array<{ file: string; error: string }>;
}

/**
 * Plugin loader interface.
 *
 * Abstracts how plugins are discovered and loaded. The library ships
 * a default filesystem-based implementation (`FileSystemPluginLoader`).
 * Consumers can provide their own implementation to load plugins from
 * npm packages, remote registries, databases, or any other source.
 */
export interface IPluginLoader {
  /**
   * Discover and load plugins.
   *
   * @returns Merged plugin registrations from all discovered sources.
   */
  load(): Promise<LoadedPlugins>;
}
