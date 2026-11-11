import type { CallOptions } from '@mcp-abap-adt/llm-agent';

const RELEVANCE_QUERY = Symbol('relevance-query');

type RelevanceOptions = CallOptions & { [RELEVANCE_QUERY]?: string };

/** Keep relevance judgments independent of retrieval query transformations. */
export function withRelevanceQuery(
  options: CallOptions,
  text: string,
): RelevanceOptions {
  return { ...options, [RELEVANCE_QUERY]: text };
}

export function relevanceQuery(options?: RelevanceOptions): string | undefined {
  return options?.[RELEVANCE_QUERY];
}
