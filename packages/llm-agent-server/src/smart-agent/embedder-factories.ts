import type { IEmbedder } from '@mcp-abap-adt/llm-agent';
import { MissingProviderError } from '@mcp-abap-adt/llm-agent';

export type EmbedderFactoryOpts = Record<string, unknown>;

const PACKAGE_BY_NAME: Record<string, string> = {
  openai: '@mcp-abap-adt/openai-embedder',
  ollama: '@mcp-abap-adt/ollama-embedder',
  'sap-ai-core': '@mcp-abap-adt/sap-aicore-embedder',
  'sap-aicore': '@mcp-abap-adt/sap-aicore-embedder',
};

const EXPORT_BY_NAME: Record<string, string> = {
  openai: 'OpenAiEmbedder',
  ollama: 'OllamaEmbedder',
  'sap-ai-core': 'SapAiCoreEmbedder',
  'sap-aicore': 'SapAiCoreEmbedder',
};

const prefetched = new Map<string, Record<string, unknown>>();

/**
 * Load peer packages for the factory names given. Call once at server
 * startup before any synchronous resolve calls. Missing peer throws
 * MissingProviderError up front so startup fails fast.
 */
export async function prefetchEmbedderFactories(
  names: readonly string[],
): Promise<void> {
  for (const name of names) {
    if (prefetched.has(name)) continue;
    const packageName = PACKAGE_BY_NAME[name];
    if (!packageName) {
      throw new MissingProviderError('(unknown)', name);
    }
    try {
      const mod = (await import(packageName)) as Record<string, unknown>;
      prefetched.set(name, mod);
    } catch {
      throw new MissingProviderError(packageName, name);
    }
  }
}

/** Sync resolve. Caller MUST have awaited prefetchEmbedderFactories(names) first. */
export function resolveEmbedder(
  name: string,
  opts: EmbedderFactoryOpts,
): IEmbedder {
  const mod = prefetched.get(name);
  if (!mod) {
    const packageName = PACKAGE_BY_NAME[name] ?? '(unknown)';
    throw new MissingProviderError(packageName, name);
  }
  const className = EXPORT_BY_NAME[name];
  const Cls = mod[className] as new (opts: EmbedderFactoryOpts) => IEmbedder;
  if (!Cls) {
    throw new MissingProviderError(PACKAGE_BY_NAME[name] ?? '(unknown)', name);
  }
  return new Cls(opts);
}

export const builtInEmbedderFactories: Record<
  string,
  (opts: EmbedderFactoryOpts) => IEmbedder
> = {
  openai: (opts) => resolveEmbedder('openai', opts),
  ollama: (opts) => resolveEmbedder('ollama', opts),
  'sap-ai-core': (opts) => resolveEmbedder('sap-ai-core', opts),
};

/** Test-only: reset the prefetched map (for unit tests). */
export function _resetPrefetchedForTests(): void {
  prefetched.clear();
}
