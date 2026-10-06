/**
 * ConfigWatcher — watches a YAML config file for changes and emits
 * hot-reloadable config updates.
 *
 * Uses `fs.watch()` with debounce (500ms default) to avoid firing
 * on partial writes. Emits `reload` with the reloadable portion
 * of the config — the values as the file holds them (`HotReloadableInput`,
 * not validated), after the injected `resolveDocument`, when given — and, as
 * the event's second argument, the whole resolved document the values were
 * read from (D83 (10)); or `error` on a read, parse or resolve failure.
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

/**
 * The hot-reloadable values exactly as the file holds them (spec §3.8, D83):
 * not validated and not coerced — a value of the wrong type or out of range
 * stays as it is. Validate before applying anything; the server does so with
 * its config field validator, and an invalid value fails the reload.
 */
export type HotReloadableInput = { [K in keyof HotReloadableConfig]?: unknown };

/** The `agent.*` keys the watcher reads. */
const AGENT_KEYS = [
  'maxIterations',
  'maxToolCalls',
  'ragQueryK',
  'toolUnavailableTtlMs',
  'showReasoning',
  'historyAutoSummarizeLimit',
  'queryExpansionEnabled',
  'toolResultCacheTtlMs',
  'sessionTokenBudget',
  'classificationEnabled',
] as const satisfies readonly (keyof HotReloadableConfig)[];

// ---------------------------------------------------------------------------
// ConfigWatcher
// ---------------------------------------------------------------------------

export interface ConfigWatcherOptions {
  /** Debounce interval in ms. Default: 500 */
  debounceMs?: number;
  /**
   * Applied to the whole parsed file before any hot-reloadable field is read
   * (spec §3.8, D83 (8)) — e.g. the server's `${VAR}` substitution, so a reload
   * reads the file as the start read it. A throw is emitted as `error`, like a
   * parse failure. Absent: the values are the file's as written.
   */
  resolveDocument?: (document: unknown) => unknown;
}

export class ConfigWatcher extends EventEmitter {
  private watcher: fs.FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly debounceMs: number;
  private readonly filePath: string;
  private readonly resolveDocument?: (document: unknown) => unknown;

  constructor(filePath: string, options?: ConfigWatcherOptions) {
    super();
    this.filePath = filePath;
    this.debounceMs = options?.debounceMs ?? 500;
    this.resolveDocument = options?.resolveDocument;
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
      const parsed: unknown = parseYaml(raw);
      // Spec D83 (8): the consumer's resolution (the server's ${VAR}) over the
      // whole document, before a field is picked — as the start does.
      const document = this.resolveDocument
        ? this.resolveDocument(parsed)
        : parsed;
      const resolved = (document ?? {}) as Record<string, unknown>;
      const config = this._extractReloadable(resolved);
      // Spec D83 (10): the document the values were read from, beside them — a
      // consumer validates the whole file (the server: with its start
      // validator), never the extracted values alone. One read for both.
      this.emit('reload', config, resolved);
    } catch (err) {
      this.emit('error', err);
    }
  }

  private _extractReloadable(
    yaml: Record<string, unknown>,
  ): HotReloadableInput {
    const agent = (yaml.agent ?? {}) as Record<string, unknown>;
    // The weights belong to the in-memory store, the only one that applies them
    // (VectorRag.updateWeights) — read from rag.store, and only for that type (§4.6.4).
    const ragStore = ((yaml.rag as Record<string, unknown> | undefined)
      ?.store ?? {}) as Record<string, unknown>;
    const inMemory = ragStore.type === 'in-memory';
    // Values as read — never coerced (spec D83): `Number('oops')` is NaN, and a
    // NaN iteration limit never stops the loop. The reader of the event validates.
    const config: HotReloadableInput = {};
    for (const key of AGENT_KEYS) {
      if (agent[key] !== undefined) config[key] = agent[key];
    }
    if (inMemory && ragStore.vectorWeight !== undefined)
      config.vectorWeight = ragStore.vectorWeight;
    if (inMemory && ragStore.keywordWeight !== undefined)
      config.keywordWeight = ragStore.keywordWeight;
    // Passed as read — a section with no value (`prompts:`) too: the reader of
    // the event validates it (the server: `prompts has no value`, D83 (13)).
    if (yaml.prompts !== undefined) config.prompts = yaml.prompts;
    if (yaml.circuitBreaker !== undefined)
      config.circuitBreaker = yaml.circuitBreaker;
    if (yaml.logDir !== undefined) config.logDir = yaml.logDir;
    return config;
  }
}
