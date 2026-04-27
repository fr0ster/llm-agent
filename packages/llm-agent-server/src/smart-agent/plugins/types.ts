/**
 * Plugin contract types.
 *
 * A plugin is a module that exports named registrations matching
 * {@link PluginExports}. The plugin loader discovers and imports
 * plugins, returning merged registrations as {@link LoadedPlugins}.
 *
 * ## Extension model
 *
 * The library provides {@link IPluginLoader} — an interface for plugin
 * discovery — and a default filesystem-based implementation
 * ({@link FileSystemPluginLoader}). Consumers can:
 *
 * - Use the default loader (filesystem scan) as-is
 * - Provide a custom loader (npm packages, remote registry, DB, etc.)
 * - Skip loaders entirely and wire via `SmartAgentBuilder` directly
 *
 * ## Supported exports
 *
 * | Export name          | Type                                      | Registers as           |
 * |----------------------|-------------------------------------------|------------------------|
 * | `stageHandlers`      | `Record<string, IStageHandler>`           | Pipeline stage handlers |
 * | `embedderFactories`  | `Record<string, EmbedderFactory>`         | Embedder factories      |
 * | `reranker`           | `IReranker`                               | RAG reranker            |
 * | `queryExpander`      | `IQueryExpander`                          | Query expander          |
 * | `outputValidator`    | `IOutputValidator`                        | Output validator        |
 * | `skillManager`       | `ISkillManager`                           | Skill manager           |
 * | `mcpClients`         | `IMcpClient[]`                            | MCP clients             |
 *
 * ## Example plugin file (filesystem loader)
 *
 * ```ts
 * // ~/.config/llm-agent/plugins/my-plugin.js
 * import type { PluginExports } from '@mcp-abap-adt/llm-agent';
 *
 * class AuditLogHandler {
 *   async execute(ctx, config, span) {
 *     console.log(`[audit] ${ctx.inputText.slice(0, 100)}`);
 *     return true;
 *   }
 * }
 *
 * export const stageHandlers = {
 *   'audit-log': new AuditLogHandler(),
 * };
 * ```
 *
 * ## Plugin directories (filesystem loader)
 *
 * Plugins are loaded from (in order, later wins):
 * 1. `~/.config/llm-agent/plugins/` (user-level)
 * 2. `./plugins/` (project-level)
 * 3. Path specified via `--plugin-dir` CLI flag or `pluginDir` in YAML
 *
 * Only `.js`, `.mjs`, and `.ts` files are loaded. Subdirectories are ignored.
 */

import type {
  EmbedderFactory,
  IClientAdapter,
  ILlmApiAdapter,
  IMcpClient,
  IQueryExpander,
  ISkillManager,
} from '@mcp-abap-adt/llm-agent';
import type { IStageHandler } from '../pipeline/stage-handler.js';
import type { IReranker } from '../reranker/types.js';
import type { IOutputValidator } from '../validator/types.js';

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
 * a default filesystem-based implementation ({@link FileSystemPluginLoader}).
 * Consumers can provide their own implementation to load plugins from
 * npm packages, remote registries, databases, or any other source.
 *
 * @example Default filesystem loader
 * ```ts
 * const loader = new FileSystemPluginLoader({
 *   dirs: ['~/.config/llm-agent/plugins/', './plugins/'],
 * });
 * builder.withPluginLoader(loader);
 * ```
 *
 * @example Custom npm-based loader
 * ```ts
 * class NpmPluginLoader implements IPluginLoader {
 *   constructor(private packages: string[]) {}
 *   async load() {
 *     const result = emptyLoadedPlugins();
 *     for (const pkg of this.packages) {
 *       const mod = await import(pkg);
 *       mergePluginExports(result, mod, pkg);
 *     }
 *     return result;
 *   }
 * }
 * builder.withPluginLoader(new NpmPluginLoader(['my-plugin-a', 'my-plugin-b']));
 * ```
 */
export interface IPluginLoader {
  /**
   * Discover and load plugins.
   *
   * @returns Merged plugin registrations from all discovered sources.
   */
  load(): Promise<LoadedPlugins>;
}

/**
 * Creates an empty {@link LoadedPlugins} object.
 * Useful for custom `IPluginLoader` implementations.
 */
export function emptyLoadedPlugins(): LoadedPlugins {
  return {
    stageHandlers: new Map(),
    embedderFactories: {},
    mcpClients: [],
    clientAdapters: [],
    apiAdapters: new Map(),
    loadedFiles: [],
    errors: [],
  };
}

/**
 * Merges a single plugin module's exports into a {@link LoadedPlugins} result.
 * Useful for custom `IPluginLoader` implementations.
 *
 * @param result - Target to merge into (mutated in place).
 * @param mod    - Plugin module exports to merge.
 * @param source - Source identifier (file path, package name, etc.).
 * @returns `true` if any registrations were found.
 */
export function mergePluginExports(
  result: LoadedPlugins,
  mod: PluginExports,
  source: string,
): boolean {
  let registered = false;

  if (mod.stageHandlers && typeof mod.stageHandlers === 'object') {
    for (const [type, handler] of Object.entries(mod.stageHandlers)) {
      if (handler && typeof (handler as IStageHandler).execute === 'function') {
        result.stageHandlers.set(type, handler as IStageHandler);
        registered = true;
      }
    }
  }

  if (mod.embedderFactories && typeof mod.embedderFactories === 'object') {
    for (const [name, factory] of Object.entries(mod.embedderFactories)) {
      if (typeof factory === 'function') {
        result.embedderFactories[name] = factory;
        registered = true;
      }
    }
  }

  if (mod.reranker && typeof mod.reranker === 'object') {
    result.reranker = mod.reranker;
    registered = true;
  }

  if (mod.queryExpander && typeof mod.queryExpander === 'object') {
    result.queryExpander = mod.queryExpander;
    registered = true;
  }

  if (mod.outputValidator && typeof mod.outputValidator === 'object') {
    result.outputValidator = mod.outputValidator;
    registered = true;
  }

  if (mod.skillManager && typeof mod.skillManager === 'object') {
    result.skillManager = mod.skillManager;
    registered = true;
  }

  if (mod.mcpClients && Array.isArray(mod.mcpClients)) {
    result.mcpClients.push(...mod.mcpClients);
    registered = true;
  }

  if (mod.clientAdapters && Array.isArray(mod.clientAdapters)) {
    result.clientAdapters.push(...mod.clientAdapters);
    registered = true;
  }

  if (mod.apiAdapters && typeof mod.apiAdapters === 'object') {
    for (const [name, adapter] of Object.entries(mod.apiAdapters)) {
      if (adapter && typeof adapter === 'object' && 'name' in adapter) {
        result.apiAdapters.set(name, adapter as ILlmApiAdapter);
        registered = true;
      }
    }
  }

  if (registered) {
    result.loadedFiles.push(source);
  }

  return registered;
}
