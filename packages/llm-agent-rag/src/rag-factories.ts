import type {
  IApiKeyCredential,
  IBearerCredential,
  ISecretLoginCredential,
} from '@mcp-abap-adt/interfaces-auth';
import type {
  AnyLogger,
  EmbedderFactory,
  IDocumentEnricher,
  IEmbedder,
  IQueryPreprocessor,
  IRag,
  ISearchStrategy,
} from '@mcp-abap-adt/llm-agent';
import {
  composeResilientEmbedder,
  DEFAULT_MAX_BATCH_SIZE,
  isBatchSizeLimited,
  MissingProviderError,
  VectorRag,
} from '@mcp-abap-adt/llm-agent';
import {
  assertCredentialKind,
  EMBEDDER_CREDENTIALS,
} from './credential-guard.js';
import type { EmbedderFactoryOpts } from './embedder-factories.js';
import { builtInEmbedderFactories } from './embedder-factories.js';

// ---------------------------------------------------------------------------
// Peer-package loading — literal specifiers only
// ---------------------------------------------------------------------------

export const ragBackendNames = Object.freeze([
  'qdrant',
  'hana-vector',
  'pg-vector',
]) as readonly string[];

/**
 * `await import(pkg)` here is a runtime-only lookup — `pkg` is a parameter,
 * so this call itself infers no type (every caller below supplies the type
 * explicitly, e.g. `importPeer<typeof import('@mcp-abap-adt/qdrant-rag')>`,
 * which DOES resolve at compile time because that argument is a literal).
 * `MissingProviderError` is the one runtime check this keeps: a package is
 * either installed or not, and no type can answer that.
 */
async function importPeer<T>(pkg: string, name: string): Promise<T> {
  try {
    return (await import(pkg)) as T;
  } catch {
    throw new MissingProviderError(pkg, name);
  }
}

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
        await importPeer('@mcp-abap-adt/qdrant-rag', name);
        break;
      case 'hana-vector':
        await importPeer('@mcp-abap-adt/hana-vector-rag', name);
        break;
      case 'pg-vector':
        await importPeer('@mcp-abap-adt/pg-vector-rag', name);
        break;
      default:
        throw new MissingProviderError('(unknown)', name);
    }
  }
}

// ---------------------------------------------------------------------------
// High-level async embedder resolution (config-based) — Task B6a's, unchanged
// ---------------------------------------------------------------------------

export interface EmbedderResolutionConfig {
  /** Embedder name — looked up in the factory registry. Default: 'ollama' */
  embedder?: string;
  url?: string;
  model?: string;
  credential?: IApiKeyCredential | IBearerCredential;
  /** Where the credential is valid — the SAP targets take it instead of reading the environment. */
  apiBaseUrl?: string;
  /** SAP AI Core resource group (used when embedder is 'sap-ai-core' / 'sap-aicore'). */
  resourceGroup?: string;
  /**
   * SAP AI Core scenario for the embedding model deployment.
   * `'orchestration'` (default) uses the SAP SDK; `'foundation-models'` calls the REST inference API.
   */
  scenario?: 'orchestration' | 'foundation-models';
  /**
   * Cap on texts per embedBatch call. Precedence: this value → the provider's
   * declared cap (IBatchSizeLimited) → DEFAULT_MAX_BATCH_SIZE. Set it when the
   * tenant's real limit is lower than the model's documented one.
   */
  maxBatchSize?: number;
}

export interface EmbedderResolutionOptions {
  /** Pre-built embedder injected by the consumer (takes precedence). */
  injectedEmbedder?: IEmbedder;
  /**
   * Additional embedder factories (merged with built-ins). Deliberately the
   * NARROW `EmbedderFactory`: a factory the consumer wrote closes over the
   * credential it already holds, so the framework must not promise to carry
   * one for it (spec §4.6.2). The built-ins are the other case — they have no
   * closure, which is why the bag itself carries `credential`.
   */
  extraFactories?: Record<string, EmbedderFactory>;
  /** Receives configuration warnings (e.g. a conflicting maxBatchSize). */
  logger?: AnyLogger;
}

/**
 * Resolve an IEmbedder from config.
 *
 * Priority:
 *   1. Injected embedder instance (DI)
 *   2. Named factory from registry (YAML `embedder: <name>`)
 *   3. Default: 'ollama'
 */
export function resolveEmbedder(
  cfg: EmbedderResolutionConfig,
  options?: EmbedderResolutionOptions,
): IEmbedder {
  // Chunking and retry are properties of the embedder, applied HERE — this is
  // the single choke point every RAG backend goes through, and the instance
  // startup tool vectorization reaches via the store's private field.
  const compose = (raw: IEmbedder): IEmbedder =>
    composeResilientEmbedder(raw, {
      explicitMaxBatchSize: cfg.maxBatchSize,
      fallbackMaxBatchSize: isBatchSizeLimited(raw)
        ? raw.maxBatchSize
        : DEFAULT_MAX_BATCH_SIZE,
      logger: options?.logger,
    });

  // The injected path is composed too: a consumer's DI'd embedder would
  // otherwise bypass chunking entirely. composeResilientEmbedder is idempotent.
  if (options?.injectedEmbedder) return compose(options.injectedEmbedder);

  const name = cfg.embedder ?? 'ollama';
  const opts: EmbedderFactoryOpts = {
    url: cfg.url,
    model: cfg.model,
    credential: cfg.credential,
    apiBaseUrl: cfg.apiBaseUrl,
    resourceGroup: cfg.resourceGroup,
    scenario: cfg.scenario,
  };
  assertCredentialKind(name, cfg.credential, EMBEDDER_CREDENTIALS[name]);

  // Check built-in prefetch-based factories first
  if (name in builtInEmbedderFactories) {
    return compose(builtInEmbedderFactories[name](opts));
  }

  // Fall back to consumer-registered extra factories
  const extraFactory = options?.extraFactories?.[name];
  if (!extraFactory) {
    const known = [
      ...Object.keys(builtInEmbedderFactories),
      ...Object.keys(options?.extraFactories ?? {}),
    ];
    throw new Error(
      `Unknown embedder "${name}". Register a factory or use: ${known.join(', ')}`,
    );
  }
  return compose(extraFactory(opts));
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
 * `embedder` is an already-built `IEmbedder`, not a factory name: the
 * embedder-resolution members (`embedder?: string`, `url`, `model`,
 * `credential`, `apiBaseUrl`, `resourceGroup`, `scenario`) stay on
 * `EmbedderResolutionConfig`, where Task B6a put them — a caller composes
 * the two, calling `resolveEmbedder` first and handing the result in here.
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
 *   - in-memory: `VectorRagConfig` (`packages/llm-agent/src/rag/vector-rag.ts`)
 *     — `dedupThreshold?`, `namespace?`, `vectorWeight?`, `keywordWeight?`,
 *     `strategy?`, `queryPreprocessors?`, `documentEnrichers?`. This arm's
 *     `collectionName` maps to `VectorRagConfig.namespace` (same purpose,
 *     the store's own field uses a different name). Because `embedder` is
 *     required on every arm, the plain, embedder-less `InMemoryRag` is no
 *     longer reachable through `makeRag` — a caller who wants that constructs
 *     `new InMemoryRag(...)` directly, which is still exported unchanged.
 *
 * `maxBatchSize` is on every arm because `makeRag` still composes chunking
 * and retry onto whatever embedder it is given (the same choke point
 * `resolveEmbedder` applies for its own callers) — see `makeRag` below.
 */
export type RagResolution =
  | {
      type: 'in-memory';
      embedder: IEmbedder;
      collectionName?: string;
      dedupThreshold?: number;
      vectorWeight?: number;
      keywordWeight?: number;
      strategy?: ISearchStrategy;
      queryPreprocessors?: IQueryPreprocessor[];
      documentEnrichers?: IDocumentEnricher[];
      maxBatchSize?: number;
    }
  | {
      type: 'qdrant';
      embedder: IEmbedder;
      collectionName: string;
      url: string;
      credential?: IApiKeyCredential;
      timeoutMs?: number;
      maxBatchSize?: number;
    }
  | {
      type: 'pg-vector';
      embedder: IEmbedder;
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
      maxBatchSize?: number;
    }
  | {
      type: 'hana-vector';
      embedder: IEmbedder;
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
      maxBatchSize?: number;
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
  options?: RagResolutionOptions,
): Promise<IRag> {
  refuseLegacySecretFields(cfg);

  // The same choke point resolveEmbedder applies for its own callers:
  // whatever embedder a caller hands in gets chunking/retry composed here
  // too, so a raw, uncomposed IEmbedder passed straight into RagResolution
  // still gets it (composeResilientEmbedder is idempotent, so an already-
  // composed one is untouched). Defined once, invoked per matched branch —
  // NOT hoisted above the switch — so an unknown `cfg.type` still reaches
  // the clear error below instead of failing inside embedder composition.
  const compose = (raw: IEmbedder): IEmbedder =>
    composeResilientEmbedder(raw, {
      explicitMaxBatchSize: cfg.maxBatchSize,
      fallbackMaxBatchSize: isBatchSizeLimited(raw)
        ? raw.maxBatchSize
        : DEFAULT_MAX_BATCH_SIZE,
      logger: options?.logger,
    });

  switch (cfg.type) {
    case 'in-memory': {
      const embedder = compose(cfg.embedder);
      return new VectorRag(embedder, {
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
      const {
        type: _type,
        maxBatchSize: _mbs,
        embedder: _e,
        ...qdrantCfg
      } = cfg;
      const { QdrantRag } = await importPeer<
        typeof import('@mcp-abap-adt/qdrant-rag')
      >('@mcp-abap-adt/qdrant-rag', 'qdrant');
      return new QdrantRag({ ...qdrantCfg, embedder: compose(cfg.embedder) });
    }

    case 'hana-vector': {
      const { type: _type, maxBatchSize: _mbs, embedder: _e, ...hanaCfg } = cfg;
      const { HanaVectorRag } = await importPeer<
        typeof import('@mcp-abap-adt/hana-vector-rag')
      >('@mcp-abap-adt/hana-vector-rag', 'hana-vector');
      return new HanaVectorRag({
        ...hanaCfg,
        embedder: compose(cfg.embedder),
      });
    }

    case 'pg-vector': {
      const { type: _type, maxBatchSize: _mbs, embedder: _e, ...pgCfg } = cfg;
      const { PgVectorRag } = await importPeer<
        typeof import('@mcp-abap-adt/pg-vector-rag')
      >('@mcp-abap-adt/pg-vector-rag', 'pg-vector');
      return new PgVectorRag({ ...pgCfg, embedder: compose(cfg.embedder) });
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
