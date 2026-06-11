import type {
  IEmbedder,
  KnowledgeEntry,
  KnowledgeFilter,
} from '@mcp-abap-adt/llm-agent';
import { matchesKnowledgeFilter } from '@mcp-abap-adt/llm-agent-libs';

interface Indexed {
  entry: KnowledgeEntry;
  vector: number[];
}

/** Cosine similarity of two vectors (0 when either is zero-length). Exported:
 *  reused by the controller's relevantExtract fragment-selector. */
export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

/** Embedder-backed semantic index for the knowledge backend: filter PRE-cap, then
 *  cosine-rank, then top-K. The runId filter is applied to the candidate set
 *  BEFORE the cap, so a run's hits are never starved by other runs. */
export function makeKnowledgeSemanticIndex(embedder: IEmbedder) {
  const bySession = new Map<string, Indexed[]>();
  return {
    async upsert(sid: string, e: KnowledgeEntry): Promise<void> {
      const { vector } = await embedder.embed(e.content);
      const arr = bySession.get(sid);
      if (arr) arr.push({ entry: e, vector });
      else bySession.set(sid, [{ entry: e, vector }]);
    },
    async query(
      sid: string,
      text: string,
      k?: number,
      filter?: KnowledgeFilter,
    ): Promise<readonly KnowledgeEntry[]> {
      const all = bySession.get(sid) ?? [];
      const scoped = filter
        ? all.filter((x) => matchesKnowledgeFilter(x.entry.metadata, filter))
        : all; // PRE-cap
      const { vector: q } = await embedder.embed(text);
      const ranked = scoped
        .map((x) => ({ e: x.entry, s: cosine(q, x.vector) }))
        .sort((a, b) => b.s - a.s)
        .map((x) => x.e);
      return k ? ranked.slice(0, k) : ranked;
    },
    // Session reuse must NOT return a deleted session's vectors.
    deleteSession(sid: string): void {
      bySession.delete(sid);
    },
  };
}
