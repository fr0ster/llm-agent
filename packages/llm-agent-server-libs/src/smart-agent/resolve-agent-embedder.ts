/**
 * Resolve the embedder that the SmartServer agent shares between its RAG
 * (`makeRag`) and the subagent context-builder's `toolSource`.
 *
 * A DI-injected embedder always wins. Otherwise the embedder is built from the
 * flat `rag.embedder` config — but ONLY when the RAG actually uses an embedder.
 * A bare in-memory (BM25, no embedder) store needs none, and we must NOT build
 * one, since `resolveEmbedder` would otherwise default to `ollama` and falsely
 * require it.
 *
 * Fixes #137: YAML-only deployments (embedder via `rag.embedder`, not DI) used
 * to leave the context-builder's embedder `undefined`, so constrained subagents
 * failed with empty context.
 */

import type {
  EmbedderFactory,
  IEmbedder,
  ILogger,
} from '@mcp-abap-adt/llm-agent';
import { wrapEmbedder } from '@mcp-abap-adt/llm-agent-libs';
import {
  prefetchEmbedderFactories,
  resolveEmbedder,
} from '@mcp-abap-adt/llm-agent-rag';
import type { SmartServerRagConfig } from './smart-server.js';

export async function resolveAgentEmbedder(
  rag: SmartServerRagConfig | undefined,
  diEmbedder: IEmbedder | undefined,
  extraFactories: Record<string, EmbedderFactory>,
  logger?: ILogger,
): Promise<IEmbedder | undefined> {
  // Canonical owner: every non-undefined embedder is wrapped here so its
  // embed() calls log token usage to the per-request logger (carried on
  // CallOptions). wrapEmbedder is idempotent, so a later builder.withEmbedder
  // wrap is a no-op.
  //
  // The DI'd embedder goes through resolveEmbedder as well, not straight to
  // wrapEmbedder: otherwise a consumer-supplied embedder would bypass batch
  // chunking and retry entirely.
  if (diEmbedder) {
    return wrapEmbedder(
      resolveEmbedder(rag ?? {}, { injectedEmbedder: diEmbedder, logger }),
    );
  }
  // No RAG, or a bare in-memory BM25 store → no embedder is used.
  if (!rag || (rag.type === 'in-memory' && rag.embedder == null)) {
    return undefined;
  }
  // Named embedders must be built-in (ollama/openai/sap-ai-core); custom
  // embedders are supplied via DI (handled above). Mirrors makeRag's contract.
  await prefetchEmbedderFactories([rag.embedder ?? 'ollama']);
  const resolved = resolveEmbedder(rag, { extraFactories, logger });
  return resolved ? wrapEmbedder(resolved) : undefined;
}

/**
 * Resolve the embedder for the `pipeline.rag.tools` store, which feeds the
 * subagent context-builder's `toolSource`.
 *
 * If the agent already has an embedder (`current` — DI-injected, or built from
 * the flat `rag:` block), reuse it so the tools store and the context-builder
 * share one instance. Otherwise (YAML-only multi-store deployments with no flat
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
  extraFactories: Record<string, EmbedderFactory>,
  logger?: ILogger,
): Promise<IEmbedder | undefined> {
  if (current) {
    // #141's contract is identity: an existing embedder must be reused, never
    // rebuilt. So route through the resolver ONLY when this store explicitly
    // asks for a cap — the sole input that can conflict. Without that, running
    // the resolver would wrap a non-resilient `current` and change identity for
    // configs that requested nothing.
    if (toolsStoreCfg.maxBatchSize === undefined) return current;
    return resolveEmbedder(toolsStoreCfg, {
      injectedEmbedder: current,
      extraFactories,
      logger,
    });
  }
  return resolveAgentEmbedder(
    toolsStoreCfg,
    diEmbedder,
    extraFactories,
    logger,
  );
}
