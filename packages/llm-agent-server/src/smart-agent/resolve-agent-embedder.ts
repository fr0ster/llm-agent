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
