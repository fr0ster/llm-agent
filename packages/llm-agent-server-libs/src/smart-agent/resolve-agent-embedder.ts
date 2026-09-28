/**
 * Resolve the embedder that the SmartServer agent shares between its RAG
 * (`BuildAgentDeps.makeRag`) and the subagent context-builder's `toolSource`.
 *
 * A DI-injected embedder always wins. Otherwise the embedder is built from the
 * `rag.embedder` section — but ONLY when the RAG actually uses an embedder.
 * A bare in-memory (BM25, no embedder) store needs none, and we must NOT build
 * one, since the seam would otherwise default to `ollama` and falsely require
 * it.
 *
 * Fixes #137: YAML-only deployments (embedder via `rag.embedder`, not DI) used
 * to leave the context-builder's embedder `undefined`, so constrained subagents
 * failed with empty context.
 */

import type {
  AnyLogger,
  EmbedderFactory,
  IEmbedder,
} from '@mcp-abap-adt/llm-agent';
import { wrapEmbedder } from '@mcp-abap-adt/llm-agent-libs';
import {
  composeEmbedder,
  prefetchEmbedderFactories,
} from '@mcp-abap-adt/llm-agent-rag';
import type {
  SmartServerEmbedderConfig,
  SmartServerRagConfig,
} from './rag-config.js';
import type { BuildAgentDeps } from './smart-server.js';

export async function resolveAgentEmbedder(
  rag: SmartServerRagConfig | undefined,
  diEmbedder: IEmbedder | undefined,
  resolve: BuildAgentDeps['resolveEmbedder'],
  extraFactories: Record<string, EmbedderFactory>,
  logger?: AnyLogger,
  /** For an asymmetric model (`rag.embedder.asymmetric`), which half to build;
   *  ignored for a symmetric one and for an injected instance. */
  inputType?: 'document' | 'query',
): Promise<IEmbedder | undefined> {
  // Canonical owner: every non-undefined embedder is wrapped here so its embed()
  // calls log token usage to the per-request logger. wrapEmbedder is idempotent.
  //
  // An instance the consumer built is COMPOSED (chunking and retry), not resolved:
  // it constructs nothing, so it needs neither the seam nor a credential.
  if (diEmbedder) {
    return wrapEmbedder(
      composeEmbedder(diEmbedder, {
        maxBatchSize: rag?.embedder?.maxBatchSize,
        logger,
      }),
    );
  }
  // No RAG, or a keyword-only in-memory store → no embedder is used.
  if (!rag || (rag.store.type === 'in-memory' && rag.embedder === undefined)) {
    return undefined;
  }
  // A vector store with no embedder section keeps the default this path always
  // had ('ollama'); the validator already asked for its model unless provider
  // checks were skipped.
  const section: SmartServerEmbedderConfig = rag.embedder ?? {
    provider: 'ollama',
  };
  // Only a built-in has a peer package to load; a factory is registered, not imported.
  if (section.factory === undefined) {
    await prefetchEmbedderFactories([section.provider]);
  }
  const typed =
    inputType !== undefined &&
    section.factory === undefined &&
    section.asymmetric
      ? { ...section, inputType }
      : section;
  // Construction goes through the app's seam: the library builds no embedder.
  return wrapEmbedder(resolve(typed, { extraFactories, logger }));
}

/**
 * Resolve the embedder for the `pipeline.rag.tools` store, which feeds the
 * subagent context-builder's `toolSource`.
 *
 * If the agent already has an embedder (`current` — DI-injected, or built from
 * the `rag:` block), reuse it so the tools store and the context-builder share
 * one instance. Otherwise (YAML-only multi-store deployments with no top-level
 * `rag:` and no DI) build one from the tools store's own config.
 *
 * The returned value is BOTH this store's `injectedEmbedder` AND the new
 * agent-wide embedder — assign it back to `resolvedEmbedder`. Stays `undefined`
 * for a bare in-memory (BM25) tools store, leaving `toolSource` disabled.
 *
 * Fixes #141: the flat-path fix (#137) didn't reach the multi-store path.
 */
export async function resolveToolsStoreEmbedder(
  current: IEmbedder | undefined,
  toolsStoreCfg: SmartServerRagConfig,
  diEmbedder: IEmbedder | undefined,
  resolve: BuildAgentDeps['resolveEmbedder'],
  extraFactories: Record<string, EmbedderFactory>,
  logger?: AnyLogger,
): Promise<IEmbedder | undefined> {
  if (current) {
    // #141's contract is identity: reuse, never rebuild — compose only when this
    // store asks for a cap, the sole input that can conflict.
    const cap = toolsStoreCfg.embedder?.maxBatchSize;
    if (cap === undefined) return current;
    return composeEmbedder(current, { maxBatchSize: cap, logger });
  }
  return resolveAgentEmbedder(
    toolsStoreCfg,
    diEmbedder,
    resolve,
    extraFactories,
    logger,
  );
}
