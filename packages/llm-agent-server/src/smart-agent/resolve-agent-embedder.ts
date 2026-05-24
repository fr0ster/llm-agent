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

import type { EmbedderFactory, IEmbedder } from '@mcp-abap-adt/llm-agent';
import {
  prefetchEmbedderFactories,
  resolveEmbedder,
} from '@mcp-abap-adt/llm-agent-rag';
import type { SmartServerRagConfig } from './smart-server.js';

export async function resolveAgentEmbedder(
  rag: SmartServerRagConfig | undefined,
  diEmbedder: IEmbedder | undefined,
  extraFactories: Record<string, EmbedderFactory>,
): Promise<IEmbedder | undefined> {
  if (diEmbedder) return diEmbedder;
  // No RAG, or a bare in-memory BM25 store → no embedder is used.
  if (!rag || (rag.type === 'in-memory' && rag.embedder == null)) {
    return undefined;
  }
  // Named embedders must be built-in (ollama/openai/sap-ai-core); custom
  // embedders are supplied via DI (handled above). Mirrors makeRag's contract.
  await prefetchEmbedderFactories([rag.embedder ?? 'ollama']);
  return resolveEmbedder(rag, { extraFactories });
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
): Promise<IEmbedder | undefined> {
  if (current) return current;
  return resolveAgentEmbedder(toolsStoreCfg, diEmbedder, extraFactories);
}
