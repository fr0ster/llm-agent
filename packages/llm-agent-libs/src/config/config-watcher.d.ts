/**
 * ConfigWatcher — watches a YAML config file for changes and emits
 * hot-reloadable config updates.
 *
 * Uses `fs.watch()` with debounce (500ms default) to avoid firing
 * on partial writes. Emits `reload` with the reloadable portion
 * of the config, or `error` on parse failure.
 */
import { EventEmitter } from 'node:events';
export interface HotReloadableConfig {
  maxIterations?: number;
  maxToolCalls?: number;
  ragQueryK?: number;
  toolUnavailableTtlMs?: number;
  showReasoning?: boolean;
  historyAutoSummarizeLimit?: number;
  queryExpansionEnabled?: boolean;
  toolResultCacheTtlMs?: number;
  sessionTokenBudget?: number;
  classificationEnabled?: boolean;
  vectorWeight?: number;
  keywordWeight?: number;
  prompts?: {
    system?: string;
    classifier?: string;
    reasoning?: string;
    ragTranslate?: string;
    historySummary?: string;
  };
  circuitBreaker?: {
    failureThreshold?: number;
    recoveryWindowMs?: number;
  };
  logDir?: string;
}
export interface ConfigWatcherOptions {
  /** Debounce interval in ms. Default: 500 */
  debounceMs?: number;
}
export declare class ConfigWatcher extends EventEmitter {
  private watcher;
  private debounceTimer;
  private readonly debounceMs;
  private readonly filePath;
  constructor(filePath: string, options?: ConfigWatcherOptions);
  /** Start watching the config file. */
  start(): void;
  /** Stop watching. */
  stop(): void;
  private _scheduleReload;
  private _reload;
  private _extractReloadable;
}
//# sourceMappingURL=config-watcher.d.ts.map
