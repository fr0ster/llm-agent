/**
 * ConfigWatcher — watches a YAML config file for changes and emits
 * hot-reloadable config updates.
 *
 * Uses `fs.watch()` with debounce (500ms default) to avoid firing
 * on partial writes. Emits `reload` with the reloadable portion
 * of the config, or `error` on parse failure.
 */

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { parse as parseYaml } from 'yaml';

// ---------------------------------------------------------------------------
// Hot-reloadable config shape
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// ConfigWatcher
// ---------------------------------------------------------------------------

export interface ConfigWatcherOptions {
  /** Debounce interval in ms. Default: 500 */
  debounceMs?: number;
}

export class ConfigWatcher extends EventEmitter {
  private watcher: fs.FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly debounceMs: number;
  private readonly filePath: string;

  constructor(filePath: string, options?: ConfigWatcherOptions) {
    super();
    this.filePath = filePath;
    this.debounceMs = options?.debounceMs ?? 500;
  }

  /** Start watching the config file. */
  start(): void {
    if (this.watcher) return;
    this.watcher = fs.watch(this.filePath, (_eventType) => {
      this._scheduleReload();
    });
    this.watcher.on('error', (err) => {
      this.emit('error', err);
    });
  }

  /** Stop watching. */
  stop(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  private _scheduleReload(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this._reload();
    }, this.debounceMs);
  }

  private _reload(): void {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = parseYaml(raw) as Record<string, unknown>;
      const config = this._extractReloadable(parsed);
      this.emit('reload', config);
    } catch (err) {
      this.emit('error', err);
    }
  }

  private _extractReloadable(
    yaml: Record<string, unknown>,
  ): HotReloadableConfig {
    const agent = (yaml.agent ?? {}) as Record<string, unknown>;
    const rag = (yaml.rag ?? {}) as Record<string, unknown>;
    const prompts = yaml.prompts as Record<string, string> | undefined;
    const cb = yaml.circuitBreaker as Record<string, unknown> | undefined;

    const config: HotReloadableConfig = {};

    if (agent.maxIterations !== undefined)
      config.maxIterations = Number(agent.maxIterations);
    if (agent.maxToolCalls !== undefined)
      config.maxToolCalls = Number(agent.maxToolCalls);
    if (agent.ragQueryK !== undefined)
      config.ragQueryK = Number(agent.ragQueryK);
    if (agent.toolUnavailableTtlMs !== undefined)
      config.toolUnavailableTtlMs = Number(agent.toolUnavailableTtlMs);
    if (agent.showReasoning !== undefined)
      config.showReasoning = Boolean(agent.showReasoning);
    if (agent.historyAutoSummarizeLimit !== undefined)
      config.historyAutoSummarizeLimit = Number(
        agent.historyAutoSummarizeLimit,
      );
    if (agent.queryExpansionEnabled !== undefined)
      config.queryExpansionEnabled = Boolean(agent.queryExpansionEnabled);
    if (agent.toolResultCacheTtlMs !== undefined)
      config.toolResultCacheTtlMs = Number(agent.toolResultCacheTtlMs);
    if (agent.sessionTokenBudget !== undefined)
      config.sessionTokenBudget = Number(agent.sessionTokenBudget);

    if (rag.vectorWeight !== undefined)
      config.vectorWeight = Number(rag.vectorWeight);
    if (rag.keywordWeight !== undefined)
      config.keywordWeight = Number(rag.keywordWeight);

    if (prompts) config.prompts = prompts;
    if (cb) {
      config.circuitBreaker = {};
      if (cb.failureThreshold !== undefined)
        config.circuitBreaker.failureThreshold = Number(cb.failureThreshold);
      if (cb.recoveryWindowMs !== undefined)
        config.circuitBreaker.recoveryWindowMs = Number(cb.recoveryWindowMs);
    }

    if (yaml.logDir !== undefined) config.logDir = String(yaml.logDir);

    return config;
  }
}
