import type {
  IApiKeyCredential,
  ISecretLoginCredential,
} from '@mcp-abap-adt/interfaces-auth';
import type {
  AnyLogger,
  EmbedderFactory,
  IDocumentEnricher,
  IEmbedder,
  IQueryPreprocessor,
  IRag,
  IRetrievalEmbedder,
} from '@mcp-abap-adt/llm-agent';
import {
  composeResilientEmbedder,
  DEFAULT_MAX_BATCH_SIZE,
  isBatchSizeLimited,
  MissingProviderError,
} from '@mcp-abap-adt/llm-agent';
import {
  constructBuiltInEmbedder,
  type EmbedderResolution,
} from './embedder-factories.js';
import { importPeer } from './import-peer.js';
import type { ISearchStrategy } from './search-strategy.js';
import { VectorRag } from './vector-rag.js';

// ---------------------------------------------------------------------------
// Peer-package loading — literal specifiers only
// ---------------------------------------------------------------------------

export const ragBackendNames = Object.freeze([
  'qdrant',
  'hana-vector',
  'pg-vector',
]) as readonly string[];

/**
 * Verify each named peer imports successfully, so a missing driver fails
 * fast at startup rather than on the first request (`llm-agent-server`'s
 * CLI calls this before serving). Caches nothing: `makeRag` imports again,
 * through the same literal specifier, per call — the ES module loader's own
 * cache makes that free, so there is no module store left to keep in sync.
 */
export async function prefetchRagFactories(
  names: readonly string[],
): Promise<void> {
  for (const name of names) {
    switch (name) {
      case 'qdrant':
        await importPeer(
          () => import('@mcp-abap-adt/qdrant-rag'),
          '@mcp-abap-adt/qdrant-rag',
          name,
        );
        break;
      case 'hana-vector':
        await importPeer(
          () => import('@mcp-abap-adt/hana-vector-rag'),
          '@mcp-abap-adt/hana-vector-rag',
          name,
        );
        break;
      case 'pg-vector':
        await importPeer(
          () => import('@mcp-abap-adt/pg-vector-rag'),
          '@mcp-abap-adt/pg-vector-rag',
          name,
        );
        break;
      default:
        throw new MissingProviderError('(unknown)', name);
    }
  }
}

// ---------------------------------------------------------------------------
// Embedder resolution — a discriminated union, not a flat bag
// ---------------------------------------------------------------------------

export interface EmbedderResolutionOptions {
  /**
   * Consumer-registered factories, named by the `factory` arm. Deliberately
   * the NARROW `EmbedderFactory`: a factory the consumer wrote closes over
   * the credential it already holds, so the framework must not promise to
   * carry one for it (spec §4.6.2).
   */
  extraFactories?: Record<string, EmbedderFactory>;
  /** Receives configuration warnings (e.g. a conflicting maxBatchSize). */
  logger?: AnyLogger;
}

/**
 * Chunking and retry are properties of the embedder, applied here — the one
 * choke point every constructed embedder passes through, and the one a
 * consumer's injected instance goes through too (an injected embedder would
 * otherwise bypass chunking entirely). Idempotent.
 */
export function composeEmbedder(
  raw: IEmbedder,
  opts?: { maxBatchSize?: number; logger?: AnyLogger },
): IEmbedder {
  return composeResilientEmbedder(raw, {
    explicitMaxBatchSize: opts?.maxBatchSize,
    fallbackMaxBatchSize: isBatchSizeLimited(raw)
      ? raw.maxBatchSize
      : DEFAULT_MAX_BATCH_SIZE,
    logger: opts?.logger,
  });
}

/**
 * The runtime check left on the embedder side, for a value arriving from an
 * UNTYPED source: a loaded object is not a fresh literal, so no
 * excess-property check ever sees a leftover `apiKey` — and the old name
 * field `embedder` would otherwise fall through to the ollama default in
 * silence. The typed path is `EmbedderResolution` itself.
 */
function refuseLegacyEmbedderFields(cfg: EmbedderResolution): void {
  const raw = cfg as unknown as Record<string, unknown>;
  if ('apiKey' in raw) {
    throw new Error(
      'embedder config still carries "apiKey", which is not a member of any ' +
        'EmbedderResolution arm — replace it with credential (build one with staticApiKey).',
    );
  }
  if ('embedder' in raw) {
    throw new Error(
      'embedder config carries "embedder", which was renamed: name a built-in with ' +
        'provider (openai, ollama, sap-ai-core) or a registered factory with factory.',
    );
  }
}

/**
 * Resolve an IEmbedder from its configuration. Synchronous: the built-ins
 * must have been prefetched (`prefetchEmbedderFactories`). A consumer's own
 * instance does not come through here — pass it to `composeEmbedder`.
 */
export function resolveEmbedder(
  cfg: EmbedderResolution,
  options?: EmbedderResolutionOptions,
): IEmbedder {
  refuseLegacyEmbedderFields(cfg);
  const raw =
    cfg.factory !== undefined
      ? constructFromExtraFactory(cfg, options)
      : constructBuiltInEmbedder(cfg);
  return composeEmbedder(raw, {
    maxBatchSize: cfg.maxBatchSize,
    logger: options?.logger,
  });
}

function constructFromExtraFactory(
  cfg: Extract<EmbedderResolution, { factory: string }>,
  options: EmbedderResolutionOptions | undefined,
): IEmbedder {
  const factory = options?.extraFactories?.[cfg.factory];
  if (!factory) {
    const known = Object.keys(options?.extraFactories ?? {});
    throw new Error(
      `Unknown embedder factory "${cfg.factory}". Registered: ` +
        `${known.length > 0 ? known.join(', ') : '(none)'}. Built-ins are named with ` +
        'provider: openai, ollama, sap-ai-core.',
    );
  }
  // Exactly EmbedderFactoryConfig, built from named fields — nothing spread,
  // so nothing the consumer did not ask for can ride along.
  return factory({
    ...(cfg.url !== undefined ? { url: cfg.url } : {}),
    ...(cfg.model !== undefined ? { model: cfg.model } : {}),
    ...(cfg.timeoutMs !== undefined ? { timeoutMs: cfg.timeoutMs } : {}),
  });
}

// ---------------------------------------------------------------------------
// High-level async RAG resolution — a discriminated union, not a flat bag
// ---------------------------------------------------------------------------

/**
 * What a caller must state to get a store. One arm per backend, each
 * carrying exactly what that backend's own constructor demands — so a
 * wrong credential kind, a missing required one, or a field Task B6 removed
 * is a build error rather than something a guard has to notice at runtime.
 *
 * `embedder` is an already-built `IRetrievalEmbedder`, not a factory name: the
 * store writes records with its `embedDocument` and embeds the search text it
 * handles itself with its `embedQuery`. Build it over embedders that are
 * already composed — `symmetricEmbedder(resolveEmbedder(cfg))`, or
 * `asymmetricEmbedder({ document, query })` for a model that embeds the two
 * differently — and hand it in here.
 *
 * Field sources, read from each store's own config (not invented):
 *   - qdrant: `QdrantRagConfig` (`packages/qdrant-rag/src/qdrant-rag.ts`) —
 *     `url`, `collectionName`, `credential?: IApiKeyCredential`, `timeoutMs?`.
 *   - pg-vector: `PgVectorRagConfig` (`packages/pg-vector-rag/src/connection.ts`) —
 *     `connectionString?`, `host?`, `port?`, `database?`,
 *     `credential?: ISecretLoginCredential`, `schema?`, `collectionName`,
 *     `dimension?`, `autoCreateSchema?`, `poolMax?`, `connectTimeout?`.
 *   - hana-vector: `HanaVectorRagConfig` (`packages/hana-vector-rag/src/connection.ts`) —
 *     same shape as pg-vector's address/tuning fields, but
 *     `credential: ISecretLoginCredential` is **required** — HANA has no
 *     anonymous login (Task B6).
 *   - in-memory: `VectorRagConfig` (`./vector-rag.ts`)
 *     — `dedupThreshold?`, `namespace?`, `vectorWeight?`, `keywordWeight?`,
 *     `strategy?`, `queryPreprocessors?`, `documentEnrichers?`. This arm's
 *     `collectionName` maps to `VectorRagConfig.namespace` (same purpose,
 *     the store's own field uses a different name). Because `embedder` is
 *     required on every arm, the plain, embedder-less `InMemoryRag` is no
 *     longer reachable through `makeRag` — a caller who wants that constructs
 *     `new InMemoryRag(...)` directly, which is still exported unchanged.
 *
 * Chunking and retry belong to the embedders underneath (`resolveEmbedder`
 * and `composeEmbedder` apply them), not to the store: `makeRag` takes the
 * retrieval embedder as it is.
 */
export type RagResolution =
  | {
      type: 'in-memory';
      embedder: IRetrievalEmbedder;
      collectionName?: string;
      dedupThreshold?: number;
      vectorWeight?: number;
      keywordWeight?: number;
      strategy?: ISearchStrategy;
      queryPreprocessors?: IQueryPreprocessor[];
      documentEnrichers?: IDocumentEnricher[];
    }
  | {
      type: 'qdrant';
      embedder: IRetrievalEmbedder;
      collectionName: string;
      url: string;
      credential?: IApiKeyCredential;
      timeoutMs?: number;
    }
  | {
      type: 'pg-vector';
      embedder: IRetrievalEmbedder;
      collectionName: string;
      credential?: ISecretLoginCredential;
      connectionString?: string;
      host?: string;
      port?: number;
      database?: string;
      schema?: string;
      poolMax?: number;
      connectTimeout?: number;
      dimension?: number;
      autoCreateSchema?: boolean;
    }
  | {
      type: 'hana-vector';
      embedder: IRetrievalEmbedder;
      collectionName: string;
      credential: ISecretLoginCredential;
      connectionString?: string;
      host?: string;
      port?: number;
      schema?: string;
      poolMax?: number;
      connectTimeout?: number;
      dimension?: number;
      autoCreateSchema?: boolean;
    };

export interface RagResolutionOptions {
  /** Receives configuration warnings (e.g. a conflicting maxBatchSize). */
  logger?: AnyLogger;
}

const LEGACY_SECRET_FIELDS = ['apiKey', 'user', 'password'] as const;

/**
 * The one runtime check left on the store side: a value arriving from an
 * UNTYPED source (YAML, JSON, any JS caller the compiler never saw) can
 * still carry a field no arm of `RagResolution` declares any more, because
 * a loaded object is not a fresh object literal and no excess-property
 * check ever sees it. The typed path (`RagResolution` itself) is the check
 * for everything the compiler DID see — this exists only for what it
 * didn't; it is a boundary, not a second opinion on the type.
 */
function refuseLegacySecretFields(cfg: RagResolution): void {
  for (const field of LEGACY_SECRET_FIELDS) {
    if (field in (cfg as unknown as Record<string, unknown>)) {
      throw new Error(
        `rag config still carries "${field}", which is not a member of any ` +
          'RagResolution arm — replace it with credential (build one with ' +
          'staticApiKey / staticLogin).',
      );
    }
  }
}

/**
 * Create an IRag from a declarative store config.
 * This is the only function that knows about concrete RAG implementations.
 *
 * Every branch knows its store's name at COMPILE time (`cfg.type ===
 * 'qdrant'` narrows the union), so construction goes straight to
 * `new QdrantRag({...})` / `new PgVectorRag({...})` / `new
 * HanaVectorRag({...})` with an object literal checked directly against
 * that store's own config type, reached through a literal import
 * specifier — no name map, no `RagCtor`, no `Record<string, unknown>` cast.
 * A leftover `apiKey`/`user`/`password` key, a `credential` of the wrong
 * kind, or HANA's missing required credential is a build error here, not a
 * condition a test has to exercise at runtime.
 */
export async function makeRag(
  cfg: RagResolution,
  _options?: RagResolutionOptions,
): Promise<IRag> {
  refuseLegacySecretFields(cfg);

  switch (cfg.type) {
    case 'in-memory': {
      return new VectorRag(cfg.embedder, {
        dedupThreshold: cfg.dedupThreshold,
        namespace: cfg.collectionName,
        vectorWeight: cfg.vectorWeight,
        keywordWeight: cfg.keywordWeight,
        strategy: cfg.strategy,
        queryPreprocessors: cfg.queryPreprocessors,
        documentEnrichers: cfg.documentEnrichers,
      });
    }

    case 'qdrant': {
      const { type: _type, ...qdrantCfg } = cfg;
      const { QdrantRag } = await importPeer(
        () => import('@mcp-abap-adt/qdrant-rag'),
        '@mcp-abap-adt/qdrant-rag',
        'qdrant',
      );
      return new QdrantRag(qdrantCfg);
    }

    case 'hana-vector': {
      const { type: _type, ...hanaCfg } = cfg;
      const { HanaVectorRag } = await importPeer(
        () => import('@mcp-abap-adt/hana-vector-rag'),
        '@mcp-abap-adt/hana-vector-rag',
        'hana-vector',
      );
      return new HanaVectorRag(hanaCfg);
    }

    case 'pg-vector': {
      const { type: _type, ...pgCfg } = cfg;
      const { PgVectorRag } = await importPeer(
        () => import('@mcp-abap-adt/pg-vector-rag'),
        '@mcp-abap-adt/pg-vector-rag',
        'pg-vector',
      );
      return new PgVectorRag(pgCfg);
    }

    default: {
      const unreachable: never = cfg;
      throw new Error(
        `Unknown rag.type "${String((unreachable as { type?: unknown }).type)}". ` +
          'Use one of: in-memory, qdrant, hana-vector, pg-vector.',
      );
    }
  }
}
