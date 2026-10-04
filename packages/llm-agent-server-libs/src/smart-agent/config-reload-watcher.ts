/**
 * ConfigReloadWatcher — wraps ConfigWatcher and applies hot-reload updates
 * to SmartServer's runtime state (agent config, session lifecycle, workers,
 * and RAG store weights).
 */

import {
  type IRag,
  isRagDecorator,
  type VectorRag,
} from '@mcp-abap-adt/llm-agent';
import {
  ConfigWatcher,
  type HotReloadableConfig,
} from '@mcp-abap-adt/llm-agent-libs';

/** Decorator chains are short; the cap only guards a cyclic `inner`. */
const MAX_DECORATOR_DEPTH = 16;

/**
 * The store that takes weight updates: `store` itself, or the first one down
 * its `IRagDecorator.inner` chain (a `StrategyRag` / `FallbackRag` wrapper
 * hides the `VectorRag` underneath).
 */
export function findWeightedStore(store: unknown): VectorRag | undefined {
  let cur: unknown = store;
  for (let depth = 0; cur && depth < MAX_DECORATOR_DEPTH; depth++) {
    if (typeof (cur as VectorRag).updateWeights === 'function') {
      return cur as VectorRag;
    }
    const rag = cur as IRag;
    cur = isRagDecorator(rag) ? rag.inner : undefined;
  }
  return undefined;
}

export interface IConfigReloadWatcher {
  start(): void;
  stop(): void;
}

export interface ConfigReloadDeps {
  configFile: string;
  log: (e: Record<string, unknown>) => void;
  applyAgentUpdate(update: Record<string, unknown>): void;
  mirrorCfg(
    agentPatch: Record<string, unknown>,
    prompts: { ragTranslate?: string; historySummary?: string },
  ): void;
  drainWorkers(): Promise<void>;
  invalidateSessions(): Promise<void>;
  ragStores: Record<string, unknown>;
}

export class ConfigReloadWatcher implements IConfigReloadWatcher {
  private readonly watcher: ConfigWatcher;

  constructor(private readonly deps: ConfigReloadDeps) {
    this.watcher = new ConfigWatcher(deps.configFile);
  }

  start(): void {
    this.watcher.on('reload', (update: HotReloadableConfig) =>
      this._onReload(update),
    );
    this.watcher.on('error', (err: unknown) => {
      this.deps.log({ event: 'config_reload_error', error: String(err) });
    });
    this.watcher.start();
  }

  stop(): void {
    this.watcher.stop();
  }

  private _onReload(update: HotReloadableConfig): void {
    this.deps.log({ event: 'config_reload', update });
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
      agentUpdate.historyAutoSummarizeLimit = update.historyAutoSummarizeLimit;
    if (update.prompts?.ragTranslate !== undefined)
      agentUpdate.ragTranslatePrompt = update.prompts.ragTranslate;
    if (update.prompts?.historySummary !== undefined)
      agentUpdate.historySummaryPrompt = update.prompts.historySummary;
    if (update.classificationEnabled !== undefined)
      agentUpdate.classificationEnabled = update.classificationEnabled;
    if (Object.keys(agentUpdate).length > 0) {
      this.deps.applyAgentUpdate(agentUpdate);
      // Mirror onto `this.cfg.agent` so freshly-built session graphs
      // (which read `this.cfg.agent` in `buildSessionAgent`) observe the
      // update. Deep-merge to preserve untouched startup fields.
      // Note: `agentUpdate` includes flat fields ONLY whitelisted by
      // `AGENT_CONFIG_FIELDS` plus the two prompt fields, which we route
      // into `this.cfg.prompts` separately below.
      const agentPatch: Record<string, unknown> = {};
      for (const k of Object.keys(agentUpdate)) {
        if (k !== 'ragTranslatePrompt' && k !== 'historySummaryPrompt') {
          agentPatch[k] = agentUpdate[k];
        }
      }
      const ragTranslate =
        update.prompts?.ragTranslate !== undefined
          ? update.prompts.ragTranslate
          : undefined;
      const historySummary =
        update.prompts?.historySummary !== undefined
          ? update.prompts.historySummary
          : undefined;
      this.deps.mirrorCfg(agentPatch, { ragTranslate, historySummary });
    }
    // Per-session graphs (built by SessionGraphFactory) captured the OLD
    // config and the OLD cached worker LLM set. Without invalidation,
    // existing sessions keep the stale SmartAgent and a fresh acquire on a
    // cookie-known sessionId still returns it. Clear the worker cache so
    // the next build reads from the just-applied config, then drop every
    // session graph. Failures are non-fatal — log and continue.
    // Fix #21: drain per-worker SmartAgentHandle.close() BEFORE clearing
    // the cache. Hot-reload runs from a synchronous emitter callback, so
    // fire-and-forget here — same async-tolerance as the invalidateAll
    // call below.
    this.deps.drainWorkers().catch((err: unknown) => {
      this.deps.log({ event: 'config_reload_drain_error', error: String(err) });
    });
    this.deps.invalidateSessions().catch((err: unknown) => {
      this.deps.log({
        event: 'config_reload_invalidate_error',
        error: String(err),
      });
    });
    // Apply RAG weight updates
    if (
      update.vectorWeight !== undefined ||
      update.keywordWeight !== undefined
    ) {
      for (const store of Object.values(this.deps.ragStores)) {
        findWeightedStore(store)?.updateWeights({
          vectorWeight: update.vectorWeight,
          keywordWeight: update.keywordWeight,
        });
      }
    }
  }
}
