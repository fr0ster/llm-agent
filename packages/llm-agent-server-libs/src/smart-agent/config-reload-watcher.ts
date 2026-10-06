/**
 * ConfigReloadWatcher — wraps ConfigWatcher and applies hot-reload updates
 * to SmartServer's runtime state (agent config, session lifecycle, workers,
 * and RAG store weights).
 */

import { type IRag, isRagDecorator } from '@mcp-abap-adt/llm-agent';
import {
  ConfigWatcher,
  type HotReloadableConfig,
  type HotReloadableInput,
} from '@mcp-abap-adt/llm-agent-libs';
import type { VectorRag } from '@mcp-abap-adt/llm-agent-rag';
import { resolveSmartServerConfig } from './config.js';
import { validateStartConfig } from './config-fields.js';
import type { IConfigTransactionQueue } from './config-transaction-queue.js';
import { normalizeLlmConfig } from './llm-config-map.js';
import {
  checkReloadedPipeline,
  type ReloadPipeline,
} from './pipeline-sections.js';
import { resolveEnvVars, type YamlConfig } from './yaml-loader.js';

/** Decorator chains are short; the cap only guards a cyclic `inner`. */
const MAX_DECORATOR_DEPTH = 16;

/**
 * The store that takes weight updates: `store` itself, or the first one down
 * its `IRagDecorator.inner` chain (a `StrategyRag`, or a consumer's own
 * decorator, hides the `VectorRag` underneath).
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
  /** The server's one config queue (spec V6, V10, D80, D82) — PUT /v1/config runs in it too, and it holds the not-ready state. */
  transactions: IConfigTransactionQueue;
  /**
   * The environment a reload substitutes `${VAR}` from (spec V6, D83 (8)) —
   * the process environment the start's `loadYamlConfig` read, by default.
   */
  env?: NodeJS.ProcessEnv;
  /**
   * The running pipeline and every registered pipeline's section entry
   * (spec V6, D83 (11)): a reload checks its file's `pipeline` against them.
   * Required — a server that forgot it does not compile.
   */
  pipeline: ReloadPipeline;
}

export class ConfigReloadWatcher implements IConfigReloadWatcher {
  private readonly watcher: ConfigWatcher;

  constructor(private readonly deps: ConfigReloadDeps) {
    this.watcher = new ConfigWatcher(deps.configFile, {
      resolveDocument: (doc) => resolveEnvVars(doc, deps.env ?? process.env),
    });
  }

  start(): void {
    this.watcher.on(
      'reload',
      (_values: HotReloadableInput, document: YamlConfig) => {
        // Spec V6 (D77, D82): handled here, at the event boundary — logged as the
        // failure it is, never as applied. Nothing is restored; the queue has
        // recorded the server's not-ready state.
        // Spec D83 (10): the transaction validates the whole resolved document the
        // watcher read; the extracted values are the event's for a direct consumer.
        this._onReload(document).catch((err: unknown) => {
          this.deps.log({ event: 'config_reload_failed', error: String(err) });
        });
      },
    );
    this.watcher.on('error', (err: unknown) => {
      // Spec V6, D82 (9): a file the watcher cannot read, parse or resolve is a
      // failed reload — queued like every reload, so it sets not-ready in order
      // with the PUTs and reloads around it; reported here, as a reload is.
      this._onWatcherError(err).catch((e: unknown) => {
        this.deps.log({ event: 'config_reload_failed', error: String(e) });
      });
    });
    this.watcher.start();
  }

  stop(): void {
    this.watcher.stop();
  }

  /**
   * The reload entry point (spec §14.1 D39, §10.5.9 V6, D80, D82). Runs one
   * complete reload transaction (`_applyReload`) in the server's config queue
   * and returns that transaction's own promise: it starts only after the
   * previous config change (a reload or a PUT) settled. Resolves when this
   * reload is applied; rejects when it failed — nothing restored, the server
   * not ready until a whole config applies. `document` is the whole resolved
   * file the watcher read (D83 (10)).
   */
  private _onReload(document: YamlConfig): Promise<void> {
    // A reload re-reads the whole file: always a whole config (D82 (8)).
    return this.deps.transactions.run('reload', 'full', () =>
      this._applyReload(document),
    );
  }

  /**
   * A watcher error as a reload that fails (spec §10.5.9 V6, D82 (9)): the file
   * could not be read, parsed or resolved, so there are no values to apply.
   * Queued in the server's config queue like `_onReload` (a reload is always a
   * whole config, D82 (8)); the transaction applies nothing and rejects, so the
   * queue sets the not-ready state in queue order.
   */
  private _onWatcherError(err: unknown): Promise<void> {
    const reason = err instanceof Error ? err.message : String(err);
    return this.deps.transactions.run('reload', 'full', async () => {
      throw new Error(
        `config reload failed, the server is not ready until a whole config applies — cannot read the config file: ${reason}`,
      );
    });
  }

  /**
   * One reload transaction (spec §10.5.9 V6, D82, D83, D83 (10), D83 (11)). Run
   * only by the queue in `_onReload` (D80). Validates the whole resolved
   * document first, with the start's own validator (D83 (10)) and the selected
   * pipeline's section parser (D83 (11)) — a document the server could not
   * start from fails the transaction before anything applies. Resolves when the
   * reload is applied: the agent update, the worker drain, the session
   * invalidation and the RAG weights. Rejects when anything fails — nothing is
   * restored and the weights are not applied; the queue marks the server not
   * ready.
   */
  private async _applyReload(document: YamlConfig): Promise<void> {
    // Spec V6, D83 (10): the whole resolved file, checked by the start's own
    // validator before anything applies — every section shape and every field a
    // start reads, the worker files included; no command-line overrides (a
    // reload re-reads the file, not the command line). A file the server could
    // not start from fails this transaction here — no agent update, no mirror,
    // no drain, no weights; the queue marks the server not ready with the
    // start's error as the reason.
    let valid: HotReloadableConfig;
    try {
      const resolved = resolveSmartServerConfig(
        {},
        document,
        this.deps.env ?? process.env,
        { configPath: this.deps.configFile },
      );
      // Spec D83 (11): the selected pipeline's own section, by the parse the
      // start's registry entry runs for it — nothing built. The file's own
      // `llm:` keys, as a start from it would check them. A pipeline change, an
      // invalid section or a plugin factory's changed section fails here.
      checkReloadedPipeline(
        this.deps.pipeline,
        {
          name: resolved.pipeline?.name ?? 'flat',
          section: resolved.pipeline?.config ?? {},
        },
        normalizeLlmConfig(resolved.llm),
      );
      // The reload table's values of that document, by the same rules (the
      // start's checkStartConfig over the same document — it cannot fail once
      // the line above passed): typed, never coerced.
      valid = validateStartConfig(document, {});
    } catch (err) {
      throw new Error(
        `config reload failed, the server is not ready until a whole config applies — ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
    this.deps.log({ event: 'config_reload', update: valid });
    // Apply agent config updates
    const agentUpdate: Record<string, unknown> = {};
    if (valid.maxIterations !== undefined)
      agentUpdate.maxIterations = valid.maxIterations;
    if (valid.maxToolCalls !== undefined)
      agentUpdate.maxToolCalls = valid.maxToolCalls;
    if (valid.ragQueryK !== undefined) agentUpdate.ragQueryK = valid.ragQueryK;
    if (valid.toolUnavailableTtlMs !== undefined)
      agentUpdate.toolUnavailableTtlMs = valid.toolUnavailableTtlMs;
    if (valid.showReasoning !== undefined)
      agentUpdate.showReasoning = valid.showReasoning;
    if (valid.historyAutoSummarizeLimit !== undefined)
      agentUpdate.historyAutoSummarizeLimit = valid.historyAutoSummarizeLimit;
    if (valid.prompts?.ragTranslate !== undefined)
      agentUpdate.ragTranslatePrompt = valid.prompts.ragTranslate;
    if (valid.prompts?.historySummary !== undefined)
      agentUpdate.historySummaryPrompt = valid.prompts.historySummary;
    if (valid.classificationEnabled !== undefined)
      agentUpdate.classificationEnabled = valid.classificationEnabled;
    if (Object.keys(agentUpdate).length > 0) {
      this.deps.applyAgentUpdate(agentUpdate);
      // Mirror onto `this.cfg.agent` so freshly-built session graphs
      // (which read `this.cfg.agent` in `buildSessionAgent`) observe the
      // valid. Deep-merge to preserve untouched startup fields.
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
        valid.prompts?.ragTranslate !== undefined
          ? valid.prompts.ragTranslate
          : undefined;
      const historySummary =
        valid.prompts?.historySummary !== undefined
          ? valid.prompts.historySummary
          : undefined;
      this.deps.mirrorCfg(agentPatch, { ragTranslate, historySummary });
    }
    // Per-session graphs (built by SessionGraphFactory) captured the OLD
    // config and the OLD cached worker LLM set: drain the workers (Fix #21:
    // SmartAgentHandle.close() BEFORE the cache is cleared) and drop every
    // session graph so the next build reads the just-applied config.
    // Both run (each settles), then one verdict — a failure is never swallowed
    // into "applied" (spec V6, D77). Called synchronously, as before, so the
    // drain starts in the same turn as the valid.
    const started = (f: () => Promise<void>): Promise<void> => {
      try {
        return f();
      } catch (err) {
        return Promise.reject(err);
      }
    };
    const [drained, invalidated] = await Promise.allSettled([
      started(() => this.deps.drainWorkers()),
      started(() => this.deps.invalidateSessions()),
    ]);
    const failures: string[] = [];
    if (drained.status === 'rejected')
      failures.push(`worker drain: ${String(drained.reason)}`);
    if (invalidated.status === 'rejected') {
      failures.push(`session invalidation: ${String(invalidated.reason)}`);
    }
    if (failures.length > 0) {
      // No rollback (spec D82): what this reload applied stays; the queue
      // records the server's not-ready state from this error.
      throw new Error(
        `config reload failed, the server is not ready until a whole config applies — ${failures.join('; ')}`,
        {
          cause:
            drained.status === 'rejected'
              ? drained.reason
              : invalidated.status === 'rejected'
                ? invalidated.reason
                : undefined,
        },
      );
    }
    // Apply RAG weight updates
    if (valid.vectorWeight !== undefined || valid.keywordWeight !== undefined) {
      for (const store of Object.values(this.deps.ragStores)) {
        findWeightedStore(store)?.updateWeights({
          vectorWeight: valid.vectorWeight,
          keywordWeight: valid.keywordWeight,
        });
      }
    }
    this.deps.log({ event: 'config_reload_applied' });
  }
}
