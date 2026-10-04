import type { IReranker } from '@mcp-abap-adt/llm-agent';

export interface ResolveRerankerInput {
  pluginReranker?: IReranker;
}

/**
 * The one server-wide reranker an agent takes from a plugin. Decision- and
 * LLM-backed rerankers are configured per store through `rag.retrieval` (§13.4).
 */
export async function resolveReranker(
  input: ResolveRerankerInput,
): Promise<IReranker | undefined> {
  return input.pluginReranker;
}
