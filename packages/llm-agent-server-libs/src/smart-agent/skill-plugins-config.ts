/**
 * Parse + validate the top-level `skillPlugins:` server config key into a
 * normalized {@link SkillPluginsConfig}.
 *
 * This is the skill PLUGIN-HOST config — a NEW key, DISTINCT from the existing
 * `skills:` ({@link SmartServerSkillsConfig}, the FS skill-MANAGER consumed by
 * `resolveSkillManager`). The two are unrelated features and must not collide.
 *
 * The host materialises consumer-supplied domain skills into a grouped
 * skills-RAG and the pipelines recall from it. This module only normalizes +
 * fail-loud validates the deployment config; assembly lives in the host factory.
 */

import { resolveSkillSourceStrategy } from '@mcp-abap-adt/llm-agent-libs';

/** Normalized store selection. A persistent (`qdrant`) store carries its URL/auth. */
export type SkillPluginsStoreConfig =
  | { type: 'in-memory' }
  | { type: 'qdrant'; url: string; apiKey?: string; collection?: string };

/** Normalized catalog selection. A persistent store requires a `postgres` catalog. */
export type SkillPluginsCatalogConfig =
  | { type: 'in-process' }
  | { type: 'postgres'; connectionString: string; table?: string };

/** A FETCHED source: a marketplace/registry pulled into memory. Requires a
 *  non-empty `enabled` plugin list (omitting it is a config error, NOT "load all"). */
export interface SkillPluginsFetchedSource {
  id: string;
  registry?: string;
  enabled?: readonly string[];
  /** Acquisition/materialisation strategy name (validated via the registry). */
  strategy?: string;
  /** Opaque, strategy-specific config (incl. any placement rules). */
  strategyConfig?: Record<string, unknown>;
}

/** A PROGRAMMATIC source: the consumer's pre-filtered, in-memory record set.
 *  Carries NO `enabled` (it is already the exact set); each record carries a `group`. */
export interface SkillPluginsRecordsSource {
  id: string;
  records: readonly unknown[];
}

export type SkillPluginsSource =
  | SkillPluginsFetchedSource
  | SkillPluginsRecordsSource;

/** The normalized skill plugin-host config (defaults applied). */
export interface SkillPluginsConfig {
  /** Consumption mode. Only `implicit` is accepted this phase. */
  mode: 'implicit';
  store: SkillPluginsStoreConfig;
  /** Stable vector-space id; MANDATORY for a persistent (qdrant) store. */
  embeddingSpaceId?: string;
  /** Serving embedder selection (provider + optional model). */
  embedder?: { provider: string; model?: string };
  /** Declared embedding dimension (skips the probe embed when set). */
  dimension?: number;
  catalog: SkillPluginsCatalogConfig;
  /** Max records recalled per query. Default 4. */
  k: number;
  /** Min cosine similarity in [0,1]; below → dropped. Default 0.3. */
  threshold: number;
  /** Self-assembling pipelines' "Relevant skills" block char budget. Default 4000. */
  maxInjectChars: number;
  /** Chunking bound. Default 1500. */
  chunk: { maxChars: number };
  /** true → a source failure aborts that group; false → carry-forward. Default false. */
  strict: boolean;
  /** publishCatalog CAS retries on a concurrent-loader conflict. Default 3. */
  catalogCasMaxAttempts: number;
  /** Retired-generation grace before background reclaim (ms). Default 30000 (>= 1000). */
  retiredGraceMs: number;
  /** Orphan-generation grace before crash-resumable reclaim (ms). Default 3600000. */
  orphanGraceMs: number;
  /** Recall deadline (ms) — defaults to floor(retiredGraceMs*0.8) for qdrant; unused in-memory. */
  recallTimeoutMs?: number;
  /** Single collection the controller planner recalls (self-assembling pipelines). */
  controllerSkillGroup?: string;
  /** Which collections assembler pipelines read (implicit). Omit → all produced. */
  serveCollections?: readonly string[];
  /** false = recall-only (no ingest); requires a persistent store. Default true. */
  loadOnStartup: boolean;
  /** Acquisition sources. Absent → recall-only (a persistent store must be present). */
  sources?: readonly SkillPluginsSource[];
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function fail(msg: string): never {
  throw new Error(`skillPlugins: ${msg}`);
}

/**
 * Strict SQL-identifier regex for `catalog.table` — a bare identifier or one
 * optional `schema.table` dot. The table name is interpolated directly into SQL
 * downstream (DDL + queries), so reject anything that is not a plain identifier.
 */
const SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;

/**
 * Parse a numeric knob as a positive INTEGER (finite, integer, `> 0`). A bad
 * value fails loud naming the knob (NOT a silent NaN/default). The key being
 * ABSENT is the caller's concern (defaults applied before this is called).
 */
function posInt(raw: unknown, name: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    fail(`${name} must be a positive integer (got ${JSON.stringify(raw)})`);
  }
  return n;
}

function parseStore(raw: unknown): SkillPluginsStoreConfig {
  if (raw === undefined) return { type: 'in-memory' };
  if (!isObject(raw)) fail('store must be an object');
  const type = raw.type;
  if (type === 'in-memory') return { type: 'in-memory' };
  if (type === 'qdrant') {
    if (typeof raw.url !== 'string' || raw.url.length === 0) {
      fail('store.url is required for store.type qdrant');
    }
    return {
      type: 'qdrant',
      url: raw.url,
      ...(typeof raw.apiKey === 'string' ? { apiKey: raw.apiKey } : {}),
      ...(typeof raw.collection === 'string'
        ? { collection: raw.collection }
        : {}),
    };
  }
  return fail(
    `store.type "${String(type)}" is invalid (one of: in-memory, qdrant)`,
  );
}

function parseCatalog(raw: unknown): SkillPluginsCatalogConfig {
  if (raw === undefined) return { type: 'in-process' };
  if (!isObject(raw)) fail('catalog must be an object');
  const type = raw.type;
  if (type === 'in-process' || type === undefined)
    return { type: 'in-process' };
  if (type === 'postgres') {
    if (
      typeof raw.connectionString !== 'string' ||
      raw.connectionString.length === 0
    ) {
      fail('catalog.connectionString is required for catalog.type postgres');
    }
    if (raw.table !== undefined) {
      if (typeof raw.table !== 'string' || !SQL_IDENTIFIER.test(raw.table)) {
        fail(
          `catalog.table '${String(raw.table)}' is not a valid SQL identifier (must match ${SQL_IDENTIFIER.source})`,
        );
      }
    }
    return {
      type: 'postgres',
      connectionString: raw.connectionString,
      ...(typeof raw.table === 'string' ? { table: raw.table } : {}),
    };
  }
  return fail(
    `catalog.type "${String(type)}" is invalid (one of: in-process, postgres)`,
  );
}

function isFetchedSource(raw: Record<string, unknown>): boolean {
  // A `records` source carries `records`; anything else is a fetched source.
  return !('records' in raw);
}

function parseSource(raw: unknown): SkillPluginsSource {
  if (!isObject(raw)) fail('each source must be an object');
  const id = raw.id;
  if (typeof id !== 'string' || id.length === 0) {
    fail('each source requires a non-empty string id (the stable sourceId)');
  }
  if (!isFetchedSource(raw)) {
    if (!Array.isArray(raw.records)) {
      fail(`source '${id}': records must be an array`);
    }
    return { id, records: raw.records as readonly unknown[] };
  }
  // Fetched source: enabled is REQUIRED and non-empty.
  const enabled = raw.enabled;
  if (
    !Array.isArray(enabled) ||
    enabled.length === 0 ||
    !enabled.every((e) => typeof e === 'string')
  ) {
    fail(
      `source '${id}': a fetched source requires a non-empty 'enabled' plugin list (use ["*"] for all)`,
    );
  }
  const out: SkillPluginsFetchedSource = {
    id,
    enabled: enabled as readonly string[],
    ...(typeof raw.registry === 'string' ? { registry: raw.registry } : {}),
  };
  if (raw.strategy !== undefined) {
    if (typeof raw.strategy !== 'string') {
      fail(`source '${id}': strategy must be a string`);
    }
    // Validate against the strategy registry (throws on unknown name).
    try {
      resolveSkillSourceStrategy(raw.strategy);
    } catch (e) {
      fail(`source '${id}': ${e instanceof Error ? e.message : String(e)}`);
    }
    out.strategy = raw.strategy;
  }
  if (raw.strategyConfig !== undefined) {
    if (!isObject(raw.strategyConfig)) {
      fail(`source '${id}': strategyConfig must be an object`);
    }
    out.strategyConfig = raw.strategyConfig;
  }
  return out;
}

/**
 * Parse + validate the raw `skillPlugins:` YAML/object into a normalized
 * {@link SkillPluginsConfig}. Throws a fail-loud `Error` on any invalid config.
 */
export function parseSkillPluginsConfig(raw: unknown): SkillPluginsConfig {
  if (!isObject(raw)) fail('config must be an object');

  // mode — only 'implicit' this phase.
  const mode = raw.mode ?? 'implicit';
  if (mode === 'explicit') {
    fail('mode: explicit (planner group-selection) is not yet implemented');
  }
  if (mode !== 'implicit') {
    fail(`mode "${String(mode)}" is invalid (only 'implicit' is supported)`);
  }

  const store = parseStore(raw.store);
  const catalog = parseCatalog(raw.catalog);
  const persistentStore = store.type === 'qdrant';

  // A persistent store mandates embeddingSpaceId.
  const embeddingSpaceId =
    typeof raw.embeddingSpaceId === 'string' ? raw.embeddingSpaceId : undefined;
  if (persistentStore && !embeddingSpaceId) {
    fail(
      'embeddingSpaceId is required for a persistent store (it is published in the catalog so a recall-only instance can verify it)',
    );
  }

  // A persistent store mandates a persistent (postgres) catalog.
  if (persistentStore && catalog.type !== 'postgres') {
    fail(
      'a persistent store requires a persistent catalog (postgres); an in-process catalog would vanish on restart and is invisible to a separate recall-only process',
    );
  }

  // Numeric knobs + defaults. A present-but-invalid value fails loud naming the
  // knob (NEVER a silent NaN/default); an ABSENT key keeps today's default.
  const k = raw.k !== undefined ? posInt(raw.k, 'k') : 4;
  let threshold = 0.3;
  if (raw.threshold !== undefined) {
    const t = Number(raw.threshold);
    if (!Number.isFinite(t) || t < 0 || t > 1) {
      fail(
        `threshold must be a finite number in [0, 1] (got ${JSON.stringify(raw.threshold)})`,
      );
    }
    threshold = t;
  }
  const maxInjectChars =
    raw.maxInjectChars !== undefined
      ? posInt(raw.maxInjectChars, 'maxInjectChars')
      : 4000;
  const catalogCasMaxAttempts =
    raw.catalogCasMaxAttempts !== undefined
      ? posInt(raw.catalogCasMaxAttempts, 'catalogCasMaxAttempts')
      : 3;
  const retiredGraceMs =
    raw.retiredGraceMs !== undefined
      ? posInt(raw.retiredGraceMs, 'retiredGraceMs')
      : 30000;
  const orphanGraceMs =
    raw.orphanGraceMs !== undefined
      ? posInt(raw.orphanGraceMs, 'orphanGraceMs')
      : 3600000;
  const chunkRaw = isObject(raw.chunk) ? raw.chunk : undefined;
  const chunk = {
    maxChars:
      chunkRaw && chunkRaw.maxChars !== undefined
        ? posInt(chunkRaw.maxChars, 'chunk.maxChars')
        : 1500,
  };

  if (retiredGraceMs < 1000) {
    fail('retiredGraceMs must be >= 1000 (too small to bound recall)');
  }

  // recallTimeoutMs: explicit must be a positive integer < retiredGraceMs;
  // default = floor(grace*0.8) for a persistent store (always strictly <
  // grace), unused for in-memory.
  let recallTimeoutMs: number | undefined;
  if (raw.recallTimeoutMs !== undefined) {
    recallTimeoutMs = posInt(raw.recallTimeoutMs, 'recallTimeoutMs');
    if (recallTimeoutMs >= retiredGraceMs) {
      fail(
        `recallTimeoutMs (${recallTimeoutMs}) must be < retiredGraceMs (${retiredGraceMs})`,
      );
    }
  } else if (persistentStore) {
    recallTimeoutMs = Math.floor(retiredGraceMs * 0.8);
  }

  // loadOnStartup + sources/store mutual constraints.
  //
  // A PRESENT `sources` that is NOT an array (typo `sources: {...}` / `sources: 5`)
  // must fail loud — otherwise it is mistaken for "no sources", which on a
  // persistent store with the default loadOnStartup:true drives a DESTRUCTIVE
  // empty ingest (tombstone every prior catalog entry + publish an empty catalog).
  const rawSources = raw.sources;
  if (rawSources !== undefined && !Array.isArray(rawSources)) {
    fail(
      `sources must be an array when set (got ${JSON.stringify(rawSources)})`,
    );
  }
  const hasSources = Array.isArray(rawSources) && rawSources.length > 0;
  const loadOnStartupReq =
    raw.loadOnStartup !== undefined ? Boolean(raw.loadOnStartup) : undefined;

  // Resolve loadOnStartup with the no-source safety rule. The contract
  // (`sources` absent → recall-only) means the default true must NEVER turn a
  // no-source config into an ingest: with nothing to ingest, ingest mode only
  // wipes the live catalog. So no sources → recall-only; an EXPLICIT
  // loadOnStartup:true with no sources is a mistake and fails loud.
  let loadOnStartup: boolean;
  if (hasSources) {
    loadOnStartup = loadOnStartupReq ?? true;
    if (loadOnStartup === false) {
      fail(
        'sources cannot be combined with loadOnStartup:false (recall-only has nothing to ingest)',
      );
    }
  } else {
    if (loadOnStartupReq === true) {
      fail(
        'loadOnStartup:true requires sources to ingest — a no-source config is ' +
          'recall-only. Add sources or set loadOnStartup:false. (Ingesting with ' +
          'no sources would tombstone the active catalog and publish an empty one.)',
      );
    }
    loadOnStartup = false;
  }

  if (!hasSources && !persistentStore) {
    fail(
      'recall-only (no sources) requires a persistent store (an in-memory store with nothing to ingest is always empty)',
    );
  }

  // Parse sources + enforce globally-unique sourceIds.
  let sources: SkillPluginsSource[] | undefined;
  if (Array.isArray(rawSources)) {
    sources = rawSources.map(parseSource);
    const seen = new Set<string>();
    for (const s of sources) {
      if (seen.has(s.id)) {
        fail(
          `duplicate sourceId '${s.id}' across sources (ids must be unique)`,
        );
      }
      seen.add(s.id);
    }
  }

  const embedder = isObject(raw.embedder)
    ? {
        provider: String(raw.embedder.provider),
        ...(raw.embedder.model !== undefined
          ? { model: String(raw.embedder.model) }
          : {}),
      }
    : undefined;

  // serveCollections: ABSENT → serve all served groups (downstream default).
  // But a PRESENT key with the wrong shape must FAIL LOUD, not silently fall
  // back to "serve all" — a typo (`serveCollections: abap` instead of
  // `['abap']`) or a non-string entry would otherwise fail-OPEN and register
  // every (possibly conflicting) group. See register-skill-sources.ts, where
  // `undefined` means "all".
  let serveCollections: readonly string[] | undefined;
  if (raw.serveCollections !== undefined) {
    if (
      !Array.isArray(raw.serveCollections) ||
      !raw.serveCollections.every(
        (c) => typeof c === 'string' && c.trim().length > 0,
      )
    ) {
      fail(
        'serveCollections must be an array of non-empty strings when set ' +
          `(got ${JSON.stringify(raw.serveCollections)})`,
      );
    }
    serveCollections = raw.serveCollections as readonly string[];
  }

  // controllerSkillGroup: ABSENT → the controller planner recalls no dedicated
  // skill group. A PRESENT key with the wrong type (a typo `123` / `['abap']`)
  // must FAIL LOUD, not silently drop to undefined — otherwise controller skill
  // recall is silently disabled and the typo never reaches validateServedGroups
  // (skill-plugins-host-factory.ts, which treats an unknown group as a startup
  // config error).
  let controllerSkillGroup: string | undefined;
  if (raw.controllerSkillGroup !== undefined) {
    if (
      typeof raw.controllerSkillGroup !== 'string' ||
      raw.controllerSkillGroup.trim().length === 0
    ) {
      fail(
        'controllerSkillGroup must be a non-empty string when set ' +
          `(got ${JSON.stringify(raw.controllerSkillGroup)})`,
      );
    }
    controllerSkillGroup = raw.controllerSkillGroup;
  }

  return {
    mode: 'implicit',
    store,
    ...(embeddingSpaceId ? { embeddingSpaceId } : {}),
    ...(embedder ? { embedder } : {}),
    ...(raw.dimension !== undefined
      ? { dimension: posInt(raw.dimension, 'dimension') }
      : {}),
    catalog,
    k,
    threshold,
    maxInjectChars,
    chunk,
    strict: raw.strict !== undefined ? Boolean(raw.strict) : false,
    catalogCasMaxAttempts,
    retiredGraceMs,
    orphanGraceMs,
    ...(recallTimeoutMs !== undefined ? { recallTimeoutMs } : {}),
    ...(controllerSkillGroup !== undefined ? { controllerSkillGroup } : {}),
    ...(serveCollections ? { serveCollections } : {}),
    loadOnStartup,
    ...(sources ? { sources } : {}),
  };
}
