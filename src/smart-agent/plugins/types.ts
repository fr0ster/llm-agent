/**
 * Plugin contract types.
 *
 * A plugin is a JavaScript/TypeScript module that exports named registrations.
 * The plugin loader scans a directory, dynamically imports each file, and
 * merges the registrations into the builder/server registries.
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
 *
 * ## Example plugin file
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
 * ## Plugin directories
 *
 * Plugins are loaded from (in order, later wins):
 * 1. `~/.config/llm-agent/plugins/` (user-level)
 * 2. `./plugins/` (project-level)
 * 3. Path specified via `--plugin-dir` CLI flag or `pluginDir` in YAML
 *
 * Only `.js`, `.mjs`, and `.ts` files are loaded. Subdirectories are ignored.
 */

import type { EmbedderFactory } from '../interfaces/rag.js';
import type { IStageHandler } from '../pipeline/stage-handler.js';
import type { IQueryExpander } from '../rag/query-expander.js';
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
}

/**
 * Result of loading all plugins from one or more directories.
 * Merged registrations from all plugin files.
 */
export interface LoadedPlugins {
  stageHandlers: Map<string, IStageHandler>;
  embedderFactories: Record<string, EmbedderFactory>;
  reranker?: IReranker;
  queryExpander?: IQueryExpander;
  outputValidator?: IOutputValidator;
  /** Source files that were successfully loaded. */
  loadedFiles: string[];
  /** Files that failed to load, with error messages. */
  errors: Array<{ file: string; error: string }>;
}
