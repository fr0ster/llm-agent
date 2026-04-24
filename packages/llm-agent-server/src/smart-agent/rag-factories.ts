import type { IEmbedder, IRag } from '@mcp-abap-adt/llm-agent';
import { MissingProviderError } from '@mcp-abap-adt/llm-agent';

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
