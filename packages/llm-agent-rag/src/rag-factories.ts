import type {
  EmbedderFactory,
  IDocumentEnricher,
  IEmbedder,
  IQueryPreprocessor,
  IRag,
  ISearchStrategy,
} from '@mcp-abap-adt/llm-agent';
import {
  InMemoryRag,
  MissingProviderError,
  VectorRag,
} from '@mcp-abap-adt/llm-agent';
import { builtInEmbedderFactories } from './embedder-factories.js';

// ---------------------------------------------------------------------------
// Low-level prefetch / resolve — sync, prefetch-based
// ---------------------------------------------------------------------------

export interface RagFactoryOpts {
  url?: string;
  apiKey?: string;
  collectionName?: string;
  embedder: IEmbedder;
  timeoutMs?: number;
  dimension?: number;
  autoCreateSchema?: boolean;
  connectionString?: string;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  schema?: string;
  poolMax?: number;
  connectTimeout?: number;
}

const PACKAGE_BY_NAME: Record<string, string> = {
  qdrant: '@mcp-abap-adt/qdrant-rag',
  'hana-vector': '@mcp-abap-adt/hana-vector-rag',
  'pg-vector': '@mcp-abap-adt/pg-vector-rag',
};

const EXPORT_BY_NAME: Record<string, string> = {
  qdrant: 'QdrantRag',
  'hana-vector': 'HanaVectorRag',
  'pg-vector': 'PgVectorRag',
};

type RagCtor = new (opts: Record<string, unknown>) => IRag;

const prefetched = new Map<string, Record<string, unknown>>();

/**
 * Load peer packages for the RAG backend names given. Call once at server
 * startup before any synchronous resolveRag calls. Missing peer throws
 * MissingProviderError up front so startup fails fast.
 */
export async function prefetchRagFactories(
  names: readonly string[],
): Promise<void> {
  for (const name of names) {
    if (prefetched.has(name)) continue;
    const pkg = PACKAGE_BY_NAME[name];
    if (!pkg) throw new MissingProviderError('(unknown)', name);
    try {
      const mod = (await import(pkg)) as Record<string, unknown>;
      prefetched.set(name, mod);
    } catch {
      throw new MissingProviderError(pkg, name);
    }
  }
}

/** Sync resolve. Caller MUST have awaited prefetchRagFactories(names) first. */
export function resolveRag(name: string, opts: RagFactoryOpts): IRag {
  const mod = prefetched.get(name);
  if (!mod) {
    const pkg = PACKAGE_BY_NAME[name] ?? '(unknown)';
    throw new MissingProviderError(pkg, name);
  }
  const exportName = EXPORT_BY_NAME[name];
  const Cls = mod[exportName] as RagCtor | undefined;
  if (!Cls) {
    throw new MissingProviderError(PACKAGE_BY_NAME[name] ?? '(unknown)', name);
  }
  return new Cls(opts as unknown as Record<string, unknown>);
}

/** Test-only: reset the prefetched map. */
export function _resetPrefetchedRagForTests(): void {
  prefetched.clear();
}

export const ragBackendNames = Object.freeze(
  Object.keys(PACKAGE_BY_NAME),
) as readonly string[];

// ---------------------------------------------------------------------------
// OllamaRag dynamic loader
// ---------------------------------------------------------------------------

function isMissingOptionalPeer(err: unknown, pkg: string): boolean {
  if (!(err instanceof Error)) return false;
  // Node ESM resolver
  if ((err as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND')
    return true;
  // CJS / generic
  if (
    err.message.includes(pkg) &&
    err.message.toLowerCase().includes('cannot find')
  )
    return true;
  return false;
}

async function loadOllamaRag(): Promise<
  new (
    opts: Record<string, unknown>,
  ) => IRag
> {
  try {
    const mod = await import('@mcp-abap-adt/ollama-embedder');
    return (
      mod as unknown as {
        OllamaRag: new (opts: Record<string, unknown>) => IRag;
      }
    ).OllamaRag;
  } catch (err) {
    if (isMissingOptionalPeer(err, '@mcp-abap-adt/ollama-embedder')) {
      throw new MissingProviderError('@mcp-abap-adt/ollama-embedder', 'ollama');
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// High-level async embedder resolution (config-based)
// ---------------------------------------------------------------------------

export interface EmbedderResolutionConfig {
  /** Embedder name — looked up in the factory registry. Default: 'ollama' */
  embedder?: string;
  url?: string;
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  /** SAP AI Core resource group (used when embedder is 'sap-ai-core' / 'sap-aicore'). */
  resourceGroup?: string;
  /**
   * SAP AI Core scenario for the embedding model deployment.
   * `'orchestration'` (default) uses the SAP SDK; `'foundation-models'` calls the REST inference API.
   */
  scenario?: 'orchestration' | 'foundation-models';
}

export interface EmbedderResolutionOptions {
  /** Pre-built embedder injected by the consumer (takes precedence). */
  injectedEmbedder?: IEmbedder;
  /** Additional embedder factories (merged with built-ins). */
  extraFactories?: Record<string, EmbedderFactory>;
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
  if (options?.injectedEmbedder) return options.injectedEmbedder;

  const name = cfg.embedder ?? 'ollama';
  const opts = {
    url: cfg.url,
    apiKey: cfg.apiKey,
    model: cfg.model,
    timeoutMs: cfg.timeoutMs,
    resourceGroup: cfg.resourceGroup,
    scenario: cfg.scenario,
  };

  // Check built-in prefetch-based factories first
  if (name in builtInEmbedderFactories) {
    return builtInEmbedderFactories[name](opts);
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
  return extraFactory(opts);
}

// ---------------------------------------------------------------------------
// High-level async RAG resolution
// ---------------------------------------------------------------------------

export interface RagResolutionConfig {
  type?:
    | 'ollama'
    | 'openai'
    | 'in-memory'
    | 'qdrant'
    | 'hana-vector'
    | 'pg-vector';
  embedder?: string;
  url?: string;
  apiKey?: string;
  model?: string;
  collectionName?: string;
  dedupThreshold?: number;
  vectorWeight?: number;
  keywordWeight?: number;
  timeoutMs?: number;
  /** Search scoring strategy for hybrid RAG stores (VectorRag). */
  strategy?: ISearchStrategy;
  /** Query preprocessors for this RAG store. */
  queryPreprocessors?: IQueryPreprocessor[];
  /** Document enrichers for this RAG store. */
  documentEnrichers?: IDocumentEnricher[];
  /** Connection string or URL for external vector backends. */
  connectionString?: string;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  schema?: string;
  dimension?: number;
  autoCreateSchema?: boolean;
  poolMax?: number;
  connectTimeout?: number;
  /** SAP AI Core resource group (used when embedder is 'sap-ai-core' / 'sap-aicore'). */
  resourceGroup?: string;
  /**
   * SAP AI Core scenario for the embedding model deployment.
   * `'orchestration'` (default) uses the SAP SDK; `'foundation-models'` calls the REST inference API.
   */
  scenario?: 'orchestration' | 'foundation-models';
}

export interface RagResolutionOptions {
  /** Pre-built embedder injected by the consumer. */
  injectedEmbedder?: IEmbedder;
  /** Additional embedder factories (merged with built-ins). */
  extraFactories?: Record<string, EmbedderFactory>;
}

/**
 * Create an IRag from a declarative store config.
 * This is the only function that knows about concrete RAG implementations.
 */
export async function makeRag(
  cfg: RagResolutionConfig,
  options?: RagResolutionOptions,
): Promise<IRag> {
  if (cfg.type === 'in-memory') {
    // When an embedder is specified, upgrade to VectorRag for hybrid scoring
    if (cfg.embedder || options?.injectedEmbedder) {
      const embedder = resolveEmbedder(cfg, options);
      return new VectorRag(embedder, {
        dedupThreshold: cfg.dedupThreshold,
        vectorWeight: cfg.vectorWeight,
        keywordWeight: cfg.keywordWeight,
        strategy: cfg.strategy,
        queryPreprocessors: cfg.queryPreprocessors,
        documentEnrichers: cfg.documentEnrichers,
      });
    }
    return new InMemoryRag({
      dedupThreshold: cfg.dedupThreshold,
      queryPreprocessors: cfg.queryPreprocessors,
      documentEnrichers: cfg.documentEnrichers,
    });
  }

  if (cfg.type === 'qdrant') {
    if (!cfg.url) {
      throw new Error('Qdrant URL is required for qdrant RAG type');
    }
    const embedder = resolveEmbedder(cfg, options);
    return resolveRag('qdrant', {
      url: cfg.url,
      collectionName: cfg.collectionName ?? 'llm-agent',
      embedder,
      apiKey: cfg.apiKey,
      timeoutMs: cfg.timeoutMs,
    });
  }

  if (cfg.type === 'hana-vector') {
    if (!cfg.collectionName) {
      throw new Error('collectionName is required for hana-vector RAG type');
    }
    const embedder = resolveEmbedder(cfg, options);
    return resolveRag('hana-vector', {
      connectionString: cfg.connectionString,
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password: cfg.password,
      schema: cfg.schema,
      collectionName: cfg.collectionName,
      dimension: cfg.dimension,
      autoCreateSchema: cfg.autoCreateSchema,
      poolMax: cfg.poolMax,
      connectTimeout: cfg.connectTimeout,
      embedder,
    });
  }

  if (cfg.type === 'pg-vector') {
    if (!cfg.collectionName) {
      throw new Error('collectionName is required for pg-vector RAG type');
    }
    const embedder = resolveEmbedder(cfg, options);
    return resolveRag('pg-vector', {
      connectionString: cfg.connectionString,
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password: cfg.password,
      database: cfg.database,
      schema: cfg.schema,
      collectionName: cfg.collectionName,
      dimension: cfg.dimension,
      autoCreateSchema: cfg.autoCreateSchema,
      poolMax: cfg.poolMax,
      connectTimeout: cfg.connectTimeout,
      embedder,
    });
  }

  if (cfg.type === 'openai') {
    const embedder = resolveEmbedder(
      { ...cfg, embedder: cfg.embedder ?? 'openai' },
      options,
    );
    return new VectorRag(embedder, {
      dedupThreshold: cfg.dedupThreshold,
      vectorWeight: cfg.vectorWeight,
      keywordWeight: cfg.keywordWeight,
      strategy: cfg.strategy,
      queryPreprocessors: cfg.queryPreprocessors,
      documentEnrichers: cfg.documentEnrichers,
    });
  }

  // Default: 'ollama'
  // Use convenience OllamaRag when no custom embedder is involved
  if (!options?.injectedEmbedder && !cfg.embedder) {
    const OllamaRag = await loadOllamaRag();
    return new OllamaRag({
      ollamaUrl: cfg.url,
      model: cfg.model,
      timeoutMs: cfg.timeoutMs,
      dedupThreshold: cfg.dedupThreshold,
      vectorWeight: cfg.vectorWeight,
      keywordWeight: cfg.keywordWeight,
      strategy: cfg.strategy,
      queryPreprocessors: cfg.queryPreprocessors,
      documentEnrichers: cfg.documentEnrichers,
    });
  }

  const embedder = resolveEmbedder(
    { ...cfg, embedder: cfg.embedder ?? 'ollama' },
    options,
  );
  return new VectorRag(embedder, {
    dedupThreshold: cfg.dedupThreshold,
    vectorWeight: cfg.vectorWeight,
    keywordWeight: cfg.keywordWeight,
    strategy: cfg.strategy,
    queryPreprocessors: cfg.queryPreprocessors,
    documentEnrichers: cfg.documentEnrichers,
  });
}
