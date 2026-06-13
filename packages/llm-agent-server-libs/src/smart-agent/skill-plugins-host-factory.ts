/**
 * Assemble a live {@link ISkillPluginHost} from a normalized
 * {@link SkillPluginsConfig}.
 *
 * This is the WIRING layer for the skill plugin-host: it resolves the serving
 * embedder, maps each config `source` to an {@link ISkillSource}, selects the
 * catalog + store providers by config type, and returns either an INGEST host
 * (materialises sources at `load()`) or a RECALL-ONLY host (serves an
 * already-materialised catalog through a read-only backend).
 *
 * Dependencies are INJECTED so the factory is unit-testable with stubs:
 *   - `resolveEmbedder` — the embedder resolver (the server passes its own
 *     `resolveEmbedder` from `@mcp-abap-adt/llm-agent-rag`; tests pass a stub).
 *   - `makePgPool` — OPTIONAL pg `Pool` provider. The repo avoids a hard `pg`
 *     dependency, so a `postgres` catalog requires the caller to inject one;
 *     absent → a `postgres` catalog throws at build time.
 *   - `makeStoreProvider` / `makeCatalogStore` — OPTIONAL test seams to inject a
 *     mock Qdrant store / pg catalog without real I/O (the live path builds them
 *     from config). When provided they fully replace the config-driven build.
 *
 * Startup lifecycle (`await host.load()` + ctx exposure) is owned by SmartServer.
 */

import type {
  CallOptions,
  IEmbedder,
  ISkillPluginHost,
  ISkillSource,
  ISkillsRagBackendProvider,
  ISkillsStoreProvider,
  SkillGroupInfo,
  SkillIngestResult,
  SkillRecord,
} from '@mcp-abap-adt/llm-agent';
import {
  type ICatalogStore,
  type IPgPool,
  makeHttpTransport,
  makeInMemoryStoreProvider,
  makeInProcessCatalogStore,
  makePgCatalogReader,
  makePgCatalogStore,
  makeQdrantBackendProvider,
  makeQdrantClient,
  makeQdrantReader,
  makeQdrantStoreProvider,
  makeSkillPluginHost,
  pointId,
  resolveSkillSourceStrategy,
} from '@mcp-abap-adt/llm-agent-libs';
import type {
  SkillPluginsConfig,
  SkillPluginsRecordsSource,
} from './skill-plugins-config.js';

/**
 * Host-code constant: the retrievalText composition + chunking contract version.
 * Must agree between the embedder that WROTE a generation and the one that
 * QUERIES it (carried in every published manifest).
 */
const RETRIEVAL_SCHEMA_VERSION = 1;

/** Embedder-resolution input — the subset of config the resolver consumes. */
export interface SkillHostEmbedderConfig {
  embedder?: string;
  model?: string;
}

/** Injected dependencies (DI seams) for {@link buildSkillHostFromConfig}. */
export interface BuildSkillHostDeps {
  /**
   * Resolve the serving embedder from the config's `embedder` selection. The
   * server passes a resolver backed by `@mcp-abap-adt/llm-agent-rag`; tests pass
   * a stub returning a deterministic-vector embedder.
   */
  resolveEmbedder: (cfg: SkillHostEmbedderConfig) => IEmbedder;
  /**
   * OPTIONAL pg `Pool` provider for a `postgres` catalog. The repo keeps `pg`
   * out of its hard dependency set, so this MUST be injected when a deployment
   * configures `catalog.type: postgres`; absent → a config-time throw.
   */
  makePgPool?: (connectionString: string) => IPgPool;
  /** OPTIONAL test seam — fully replaces the config-driven store provider build. */
  makeStoreProvider?: (cfg: SkillPluginsConfig) => ISkillsStoreProvider;
  /** OPTIONAL test seam — fully replaces the config-driven catalog store build. */
  makeCatalogStore?: (cfg: SkillPluginsConfig) => ICatalogStore;
}

/** `embed(text, options) → vector` adapter the store providers consume. */
type Embed = (text: string, options?: CallOptions) => Promise<number[]>;

/**
 * Build a `records` source's {@link ISkillSource}: wrap the pre-supplied records
 * into an `acquire()` returning `{ collections, records }`, STAMPING the
 * configured `id` as each record's `sourceId` and deriving a single-collection
 * catalog from the distinct groups present.
 */
function makeRecordsSource(src: SkillPluginsRecordsSource): ISkillSource {
  // Validate + stamp eagerly so a malformed record fails loudly at acquire().
  const records: SkillRecord[] = src.records.map((raw, ix) => {
    const r = raw as Partial<SkillRecord>;
    if (typeof r.group !== 'string' || r.group.length === 0) {
      throw new Error(
        `skillPlugins source '${src.id}': record[${ix}] is missing a non-empty 'group'`,
      );
    }
    if (typeof r.id !== 'string' || r.id.length === 0) {
      throw new Error(
        `skillPlugins source '${src.id}': record[${ix}] is missing a non-empty 'id'`,
      );
    }
    return {
      id: r.id,
      sourceId: src.id, // STAMP the configured source id
      group: r.group,
      name: typeof r.name === 'string' ? r.name : r.id,
      retrievalText:
        typeof r.retrievalText === 'string'
          ? r.retrievalText
          : (r.content ?? ''),
      content: typeof r.content === 'string' ? r.content : '',
      provenance: typeof r.provenance === 'string' ? r.provenance : r.id,
    };
  });

  // Derive one SkillGroupInfo per distinct group present in the records.
  const collections = new Map<string, SkillGroupInfo>();
  for (const r of records) {
    if (!collections.has(r.group)) {
      collections.set(r.group, {
        group: r.group,
        description: r.group,
        collection: r.group,
      });
    }
  }
  const result: SkillIngestResult = {
    collections: [...collections.values()],
    records,
  };
  return { acquire: async () => result };
}

/** Map every config source to a `{ id, source }` ingest entry. */
function buildSources(
  cfg: SkillPluginsConfig,
): ReadonlyArray<{ id: string; source: ISkillSource }> {
  const out: { id: string; source: ISkillSource }[] = [];
  for (const src of cfg.sources ?? []) {
    if ('records' in src) {
      out.push({ id: src.id, source: makeRecordsSource(src) });
      continue;
    }
    // Fetched (registry) source → resolve the named strategy.
    const strategy = resolveSkillSourceStrategy(
      src.strategy ?? 'one-group-per-plugin',
    );
    out.push({
      id: src.id,
      source: strategy({
        source: src.id,
        enabled: src.enabled ?? [],
        transport: makeHttpTransport({ registry: src.registry ?? '' }),
        chunk: cfg.chunk,
        ...(src.strategyConfig !== undefined
          ? { strategyConfig: src.strategyConfig }
          : {}),
      }),
    });
  }
  return out;
}

/** Build the catalog store by `catalog.type`. */
function buildCatalogStore(
  cfg: SkillPluginsConfig,
  deps: BuildSkillHostDeps,
): ICatalogStore {
  if (deps.makeCatalogStore) return deps.makeCatalogStore(cfg);
  if (cfg.catalog.type === 'in-process') return makeInProcessCatalogStore();
  // postgres
  if (!deps.makePgPool) {
    throw new Error(
      'skillPlugins: postgres catalog requires a pg pool provider (inject deps.makePgPool)',
    );
  }
  return makePgCatalogStore({
    pool: deps.makePgPool(cfg.catalog.connectionString),
    ...(cfg.catalog.table !== undefined ? { table: cfg.catalog.table } : {}),
  });
}

/**
 * Assemble a live {@link ISkillPluginHost} from a normalized
 * {@link SkillPluginsConfig}. INGEST when sources are present (default), else a
 * RECALL-ONLY host over a read-only backend (requires a persistent store).
 *
 * The caller owns `host.load()` (SmartServer runs it once at startup).
 */
export async function buildSkillHostFromConfig(
  cfg: SkillPluginsConfig,
  deps: BuildSkillHostDeps,
): Promise<ISkillPluginHost> {
  const embedder = deps.resolveEmbedder({
    ...(cfg.embedder?.provider !== undefined
      ? { embedder: cfg.embedder.provider }
      : {}),
    ...(cfg.embedder?.model !== undefined ? { model: cfg.embedder.model } : {}),
  });
  const embed: Embed = (text, options) =>
    embedder.embed(text, options).then((r) => r.vector);

  // ---- RECALL-ONLY (loadOnStartup:false) --------------------------------
  // Serve an already-materialised catalog through a READ-ONLY backend (least
  // privilege — no write credentials). Requires a persistent store + catalog.
  if (cfg.loadOnStartup === false) {
    if (cfg.store.type !== 'qdrant' || cfg.catalog.type !== 'postgres') {
      throw new Error(
        'skillPlugins: recall-only (loadOnStartup:false) requires a qdrant store + postgres catalog',
      );
    }
    if (!deps.makePgPool) {
      throw new Error(
        'skillPlugins: postgres catalog requires a pg pool provider (inject deps.makePgPool)',
      );
    }
    const collection = cfg.store.collection ?? 'skills';
    const backendProvider: ISkillsRagBackendProvider =
      makeQdrantBackendProvider({
        reader: makeQdrantReader({
          url: cfg.store.url,
          ...(cfg.store.apiKey !== undefined
            ? { apiKey: cfg.store.apiKey }
            : {}),
          collection,
        }),
        catalogReader: makePgCatalogReader({
          pool: deps.makePgPool(cfg.catalog.connectionString),
          ...(cfg.catalog.table !== undefined
            ? { table: cfg.catalog.table }
            : {}),
        }),
        collection,
      });
    return makeSkillPluginHost({
      backendProvider,
      embedder,
      // embeddingSpaceId is mandatory for a persistent store (parse-time enforced).
      embeddingSpaceId: cfg.embeddingSpaceId as string,
      retrievalSchemaVersion: RETRIEVAL_SCHEMA_VERSION,
      ...(cfg.dimension !== undefined ? { dimension: cfg.dimension } : {}),
      serveCollections: [...(cfg.serveCollections ?? [])],
      ...(cfg.recallTimeoutMs !== undefined
        ? { recallTimeoutMs: cfg.recallTimeoutMs }
        : {}),
    });
  }

  // ---- INGEST -----------------------------------------------------------
  const storeProvider: ISkillsStoreProvider = deps.makeStoreProvider
    ? deps.makeStoreProvider(cfg)
    : cfg.store.type === 'in-memory'
      ? makeInMemoryStoreProvider({ embed })
      : makeQdrantStoreProvider({
          client: makeQdrantClient({
            url: cfg.store.url,
            ...(cfg.store.apiKey !== undefined
              ? { apiKey: cfg.store.apiKey }
              : {}),
            collection: cfg.store.collection ?? 'skills',
          }),
          collection: cfg.store.collection ?? 'skills',
          catalogStore: buildCatalogStore(cfg, deps),
          embed,
          pointId,
          now: () => Date.now(),
          retiredGraceMs: cfg.retiredGraceMs,
          orphanGraceMs: cfg.orphanGraceMs,
        });

  const sources = buildSources(cfg);

  return makeSkillPluginHost({
    sources,
    storeProvider,
    embedder,
    embeddingSpaceId:
      cfg.embeddingSpaceId ??
      `${cfg.embedder?.provider ?? 'default'}:${cfg.embedder?.model ?? 'default'}`,
    retrievalSchemaVersion: RETRIEVAL_SCHEMA_VERSION,
    ...(cfg.dimension !== undefined ? { dimension: cfg.dimension } : {}),
    strict: cfg.strict,
    catalogCasMaxAttempts: cfg.catalogCasMaxAttempts,
    ...(cfg.recallTimeoutMs !== undefined
      ? { recallTimeoutMs: cfg.recallTimeoutMs }
      : {}),
  });
}
