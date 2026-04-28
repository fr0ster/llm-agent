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
export class ConfigWatcher extends EventEmitter {
  watcher = null;
  debounceTimer = null;
  debounceMs;
  filePath;
  constructor(filePath, options) {
    super();
    this.filePath = filePath;
    this.debounceMs = options?.debounceMs ?? 500;
  }
  /** Start watching the config file. */
  start() {
    if (this.watcher) return;
    this.watcher = fs.watch(this.filePath, (_eventType) => {
      this._scheduleReload();
    });
    this.watcher.on('error', (err) => {
      this.emit('error', err);
    });
  }
  /** Stop watching. */
  stop() {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }
  _scheduleReload() {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this._reload();
    }, this.debounceMs);
  }
  _reload() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = parseYaml(raw);
      const config = this._extractReloadable(parsed);
      this.emit('reload', config);
    } catch (err) {
      this.emit('error', err);
    }
  }
  _extractReloadable(yaml) {
    const agent = yaml.agent ?? {};
    const rag = yaml.rag ?? {};
    const prompts = yaml.prompts;
    const cb = yaml.circuitBreaker;
    const config = {};
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
    if (agent.classificationEnabled !== undefined)
      config.classificationEnabled = Boolean(agent.classificationEnabled);
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
//# sourceMappingURL=config-watcher.js.map
