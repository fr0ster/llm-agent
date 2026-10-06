// packages/llm-agent-libs/src/collections/rerank-check.ts
import type { RagResult } from '@mcp-abap-adt/llm-agent';

/**
 * Every reranker result is checked (spec §4.8), whichever reranker it is: it
 * must hold exactly the candidates it was given — same count, each once — with
 * finite scores. Returns the reason it is not, or undefined.
 */
export function checkRerankOutput(
  candidates: readonly RagResult[],
  out: readonly RagResult[],
): string | undefined {
  if (out.length !== candidates.length) {
    return `reranker returned ${out.length} results for ${candidates.length} candidates`;
  }
  const want = new Set(candidates.map((c) => c.metadata.id));
  const seen = new Set<unknown>();
  for (const r of out) {
    const id = r.metadata.id;
    if (!want.has(id))
      return `reranker returned a result that was not a candidate (${String(id)})`;
    if (seen.has(id)) return `reranker returned candidate ${String(id)} twice`;
    seen.add(id);
    if (typeof r.score !== 'number' || !Number.isFinite(r.score)) {
      return `reranker returned a non-finite score for ${String(id)}`;
    }
  }
  return undefined;
}
