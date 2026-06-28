/**
 * WorkerRegistry — owns the per-worker LLM/embedder/MCP cache and the
 * per-session worker-registry build loop (relocated from SmartServer R6).
 *
 * The cache map, the three free functions (`WorkerLlmSet`, `resolveWorkerLlmSet`,
 * `drainWorkerCache`, `backfillWorkerCacheFromHandle`), and the `buildWorkerRegistry`
 * loop live here. `buildSubAgent` (200-line, deeply coupled to SmartServer) stays
 * in SmartServer and is called through the injected `buildSubAgent` callback.
 */

import type {
  EmbedderFactory,
  IEmbedder,
  ILlm,
  ILogger,
  IMcpClient,
  IRag,
  IRagRegistry,
  IRequestLogger,
  SubAgentRegistry,
} from '@mcp-abap-adt/llm-agent';
import {
  type SessionAgentParts,
  type SmartAgent,
  SmartAgentSubAgent,
} from '@mcp-abap-adt/llm-agent-libs';

// ---------------------------------------------------------------------------
// WorkerLlmSet — the shape of one per-worker cache entry.
// Relocated verbatim from smart-server.ts.
// ---------------------------------------------------------------------------

/**
 * Immutable-ish per-worker LLM/embedder/MCP cache entry, built ONCE per
 * distinct worker name and reused by reference across every per-session
 * session. In addition to LLM/embedder clients, the worker's OWN declared
 * `toolsRag`/`historyRag`/`mcpClients` (if any) are cached here too — the
 * per-session re-wire MUST prefer the worker's own resources over the
 * parent's injected ones, so we build them once and reuse by reference.
 */
export interface WorkerLlmSet {
  mainLlm: ILlm;
  classifierLlm: ILlm;
  helperLlm?: ILlm;
  embedder?: IEmbedder;
  /** Worker's OWN tools RAG, built from `subCfg.rag` if declared. */
  toolsRag?: IRag;
  /** Worker's OWN history RAG (mirrors flat-rag block, separate instance). */
  historyRag?: IRag;
  /**
   * Worker's OWN MCP clients (from `subCfg.mcpClients` DI or built once from
   * `subCfg.mcp`). Undefined means the worker did not declare any — caller
   * may fall back to the parent's injected clients.
   */
  mcpClients?: IMcpClient[];
  /**
   * Shutdown function returned by the builder's `SmartAgentHandle.close()`
   * for this worker (Fix #21). Disconnects MCP clients (and any other
   * builder-owned resources) registered to this worker. Captured by
   * `backfillWorkerCacheFromHandle` so `_drainWorkerCache()` can call it on
   * config-reload (PUT /v1/config + hot-reload) and on server shutdown —
   * without this, the per-worker handle is discarded by `buildSubAgent` and
   * lazy rebuilds (Fix #18) accumulate MCP connections with no close path.
   */
  close?: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Free functions — relocated verbatim from smart-server.ts.
// ---------------------------------------------------------------------------

/**
 * Drain every cached worker's `close` (if any), then clear the cache map.
 * Used by config-reload (PUT /v1/config + hot-reload — Fix #14/18/21) and by
 * server `close()` to release per-worker MCP connections that were attached
 * to the discarded `SmartAgentHandle`s.
 *
 * IMPORTANT — in-flight caveat: this aborts any request that is mid-call on
 * a worker's MCP client. That is acceptable for an admin action (config
 * reload, server shutdown) where the alternative is leaking connections.
 * Server `close()` calls this AFTER `lifecycle.disposeAll()` so per-session
 * graphs that reference worker clients are torn down first.
 *
 * Uses `Promise.allSettled` so one failing close cannot block the others.
 */
export async function drainWorkerCache(
  cache: Map<string, WorkerLlmSet>,
): Promise<void> {
  const closers: Array<Promise<void>> = [];
  for (const entry of cache.values()) {
    if (entry.close) {
      try {
        closers.push(entry.close());
      } catch {
        // sync throw (defensive — close is async by contract)
      }
    }
  }
  cache.clear();
  if (closers.length > 0) {
    await Promise.allSettled(closers);
  }
}

/**
 * Build-once-per-worker resolver. The first time a worker name is seen, it
 * constructs the worker's main/classifier/(optional helper) LLM + embedder and
 * caches the set; every later call (e.g. each per-session worker re-wire)
 * returns the SAME set by reference — never reconstructing LLM clients
 * (locked invariant: LLM/embedder clients are global, built once).
 *
 * Accepts optional `makeToolsRag`/`makeHistoryRag`/`makeMcpClients` factories;
 * when provided, the resolver builds them ONCE on the first miss and caches
 * them on the returned set. Subsequent calls return the cached resources by
 * reference — never re-vectorizing or re-connecting MCP.
 */
export async function resolveWorkerLlmSet(input: {
  name: string;
  cache: Map<string, WorkerLlmSet>;
  makeMain: () => Promise<ILlm>;
  makeClassifier: () => Promise<ILlm>;
  makeHelper?: () => Promise<ILlm>;
  makeEmbedder?: () => Promise<IEmbedder>;
  makeToolsRag?: () => Promise<IRag>;
  makeHistoryRag?: () => Promise<IRag>;
  makeMcpClients?: () => Promise<IMcpClient[]>;
}): Promise<WorkerLlmSet> {
  const hit = input.cache.get(input.name);
  if (hit) return hit;
  const mainLlm = await input.makeMain();
  const classifierLlm = await input.makeClassifier();
  const helperLlm = input.makeHelper ? await input.makeHelper() : undefined;
  const embedder = input.makeEmbedder ? await input.makeEmbedder() : undefined;
  const toolsRag = input.makeToolsRag ? await input.makeToolsRag() : undefined;
  const historyRag = input.makeHistoryRag
    ? await input.makeHistoryRag()
    : undefined;
  const mcpClients = input.makeMcpClients
    ? await input.makeMcpClients()
    : undefined;
  const set: WorkerLlmSet = {
    mainLlm,
    classifierLlm,
    helperLlm,
    embedder,
    toolsRag,
    historyRag,
    mcpClients,
  };
  input.cache.set(input.name, set);
  return set;
}

/**
 * Backfill the per-worker cache entry from the BUILT handle (review HIGH #7).
 *
 * The primary `buildSubAgent` populates `cached.mcpClients`/`toolsRag`/
 * `historyRag` only when the worker config provided DI factories. Workers
 * configured with `subCfg.mcp: ...` (regular config that triggers the
 * builder's own auto-connect) or with `subCfg.rag: ...` whose RAG is owned
 * by the builder leave those slots empty — so per-session re-wires would
 * fall back to the PARENT's MCP/RAG, losing the worker's own connection.
 *
 * After the builder finishes, this helper captures what the handle actually
 * holds and stores it BY REFERENCE on the cache entry. Subsequent per-session
 * re-wires read the same slots and find the worker's own resources.
 *
 * Pure helper, mutates `entry` in place. No-op when the corresponding slot
 * is already populated (DI path wins) or when the handle has no resource for
 * that slot (worker simply didn't declare one).
 */
export async function backfillWorkerCacheFromHandle(
  entry: WorkerLlmSet,
  handle: {
    mcpClients?: IMcpClient[];
    ragRegistry: { get(name: string): IRag | undefined };
    close?: () => Promise<void>;
  },
): Promise<void> {
  if (
    (!entry.mcpClients || entry.mcpClients.length === 0) &&
    handle.mcpClients &&
    handle.mcpClients.length > 0
  ) {
    entry.mcpClients = handle.mcpClients;
  }
  if (!entry.toolsRag) {
    const t = handle.ragRegistry.get('tools');
    if (t) entry.toolsRag = t;
  }
  if (!entry.historyRag) {
    const h = handle.ragRegistry.get('history');
    if (h) entry.historyRag = h;
  }
  // Capture the per-worker shutdown function (Fix #21). If the entry already
  // had a close from a previous build (e.g. the same worker name was rebuilt
  // WITHOUT going through `drainWorkerCache` first — defence in depth), await
  // the prior close before overwriting so its MCP connections do not leak.
  if (handle.close) {
    if (entry.close) {
      try {
        await entry.close();
      } catch {
        // Best-effort; never block the new build on a stale close failure.
      }
    }
    entry.close = handle.close;
  }
}

// ---------------------------------------------------------------------------
// WorkerRegistry — the class that owns the cache and the build loop.
// ---------------------------------------------------------------------------

/**
 * Sub-agent config entry. Avoids importing SmartServerConfig from
 * smart-server.ts to prevent an import cycle; the server passes a typed cast
 * at the call boundary.
 */
type SubAgentConfigEntry = {
  name: string;
  description?: string;
  config: unknown;
};

/**
 * Injected callback signature that mirrors SmartServer.buildSubAgent.
 * `subCfg` is typed `unknown` here to avoid the cycle; the server passes
 * `(name, subCfg as Omit<SmartServerConfig,'log'>, ...)` at construction.
 */
type BuildSubAgentFn = (
  name: string,
  subCfg: unknown,
  parentLogger: ILogger,
  embedderFactories: Record<string, EmbedderFactory>,
  injected?: {
    ragRegistry: IRagRegistry;
    toolsRag: IRag | undefined;
    mcpClients: IMcpClient[];
    requestLogger: IRequestLogger;
    mainLlm: ILlm;
    classifierLlm: ILlm;
    helperLlm?: ILlm;
    embedder?: IEmbedder;
  },
) => Promise<SmartAgent>;

export interface WorkerRegistryDeps {
  subAgentConfigs: SubAgentConfigEntry[] | undefined;
  getFileLogger(): ILogger | undefined;
  getEmbedderFactories(): Record<string, EmbedderFactory>;
  buildSubAgent: BuildSubAgentFn;
}

export interface IWorkerRegistry {
  build(parts: SessionAgentParts): Promise<SubAgentRegistry>;
  drain(): Promise<void>;
  readonly cache: Map<string, WorkerLlmSet>;
}

export class WorkerRegistry implements IWorkerRegistry {
  readonly cache = new Map<string, WorkerLlmSet>();

  constructor(private readonly deps: WorkerRegistryDeps) {}

  async drain(): Promise<void> {
    await drainWorkerCache(this.cache);
  }

  /**
   * Build the FRESH per-session worker (sub-agent) registry from the SAME
   * `subagents:` configs the primary build() used, injecting globals + this
   * session's logger + the CACHED per-worker LLM/embedder (this.cache).
   * NEVER reconstructs LLM clients; NEVER reuses the global registry.
   */
  async build(parts: SessionAgentParts): Promise<SubAgentRegistry> {
    const registry: SubAgentRegistry = new Map();
    const subAgentConfigs = this.deps.subAgentConfigs;
    if (!subAgentConfigs || subAgentConfigs.length === 0) {
      return registry;
    }
    const fileLogger = this.deps.getFileLogger();
    if (!fileLogger) {
      throw new Error(
        'buildWorkerRegistry invoked before primary build() captured globals',
      );
    }
    const embedderFactories = this.deps.getEmbedderFactories();
    for (const sub of subAgentConfigs) {
      // Lazy build-on-miss (Fix #18). After PUT /v1/config or hot-reload
      // clears the cache, the next session build used to throw
      // "worker LLM set not cached" because the cache was assumed
      // pre-populated by the primary build(). buildSubAgent itself routes
      // through `resolveWorkerLlmSet` which is build-on-miss, so calling
      // it without an `injected` arg rebuilds the cache entry. We then
      // re-read the entry to honour the per-worker slot priority below.
      if (!this.cache.has(sub.name)) {
        await this.deps.buildSubAgent(
          sub.name,
          sub.config,
          fileLogger,
          embedderFactories,
          // No `injected` → primary path: resolveWorkerLlmSet populates
          // the cache and backfillWorkerCacheFromHandle fills the
          // mcpClients/toolsRag slots from the built handle.
        );
      }
      const cached = this.cache.get(sub.name);
      if (!cached) {
        // Defence in depth — should be impossible after the lazy build
        // above unless buildSubAgent's contract changes.
        throw new Error(`worker LLM set not cached for '${sub.name}'`);
      }
      // Per-worker injected slot priority (review HIGH #7):
      //   worker-cached (from the primary build, includes backfilled
      //   subCfg.mcp / subCfg.rag results) → parent's session-scoped
      //   fallback. Encoded HERE so buildSubAgent does not need to know
      //   the difference; it just consumes injected.mcpClients/toolsRag.
      const injectedMcpClients =
        cached.mcpClients && cached.mcpClients.length > 0
          ? cached.mcpClients
          : parts.mcpClients;
      const injectedToolsRag = cached.toolsRag ?? parts.toolsRag;
      const subAgent = await this.deps.buildSubAgent(
        sub.name,
        sub.config,
        fileLogger,
        embedderFactories,
        {
          ragRegistry: parts.ragRegistry,
          toolsRag: injectedToolsRag,
          mcpClients: injectedMcpClients,
          requestLogger: parts.logger,
          mainLlm: cached.mainLlm,
          classifierLlm: cached.classifierLlm,
          helperLlm: cached.helperLlm,
          embedder: cached.embedder,
        },
      );
      registry.set(
        sub.name,
        new SmartAgentSubAgent(sub.name, subAgent, {
          description: sub.description,
        }),
      );
    }
    return registry;
  }
}
