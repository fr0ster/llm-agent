import type {
  CallOptions,
  IRetrievalEmbedder,
  KnowledgeEntry,
  KnowledgeFilter,
} from '@mcp-abap-adt/llm-agent';
import {
  bestFragmentScore,
  embedRecord,
  withEmbeddingError,
} from '@mcp-abap-adt/llm-agent';
import { matchesKnowledgeFilter } from '@mcp-abap-adt/llm-agent-libs';

interface Indexed {
  entry: KnowledgeEntry;
  vectors: number[][];
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
 *  BEFORE the cap, so a run's hits are never starved by other runs.
 *
 *  Infrastructure artifact types (e.g. `controller-bundle`, `controller-terminal`)
 *  are skipped on upsert — they carry the full durable transcript and must NOT be
 *  embedded: they waste tokens and, once the bundle grows beyond the embedder's
 *  input limit, the JSONL rebuild fails permanently.
 *
 *  Recallable content is ranked by its highest-scoring document fragment. */
export function makeKnowledgeSemanticIndex(
  /** Embeds the stored entries (`embedDocument`) and the search text (`embedQuery`). */
  embedder: IRetrievalEmbedder,
  skipArtifactTypes: readonly string[] = [
    'controller-bundle',
    'controller-terminal',
  ],
  fragmentSizeChars?: number,
) {
  const bySession = new Map<string, Indexed[]>();
  return {
    async upsert(
      sid: string,
      e: KnowledgeEntry,
      options?: CallOptions,
    ): Promise<void> {
      // Skip infrastructure artifact types — never embed, never index.
      if (skipArtifactTypes.includes(e.metadata.artifactType)) return;
      // Skip empty/whitespace content — a real embedder (e.g. SAP AI Core)
      // rejects empty text with an HTTP 400, which would poison the index (the
      // in-memory upsert throws, and a later lazy JsonlKnowledgeBackend rebuild
      // re-throws it out of an unrelated call). The entry is still durably
      // persisted by the backend's own append/scan; it simply never ranks in
      // semantic recall, which is correct — there is no text to rank on. #243.
      if (e.content.trim().length === 0) return;
      const vectors = await embedRecord(
        embedder,
        e.content,
        fragmentSizeChars,
        options,
      );
      const arr = bySession.get(sid);
      if (arr) arr.push({ entry: e, vectors });
      else bySession.set(sid, [{ entry: e, vectors }]);
    },
    async query(
      sid: string,
      text: string,
      k?: number,
      filter?: KnowledgeFilter,
      options?: CallOptions,
    ): Promise<readonly KnowledgeEntry[]> {
      const all = bySession.get(sid) ?? [];
      const scoped = filter
        ? all.filter((x) => matchesKnowledgeFilter(x.entry.metadata, filter))
        : all; // PRE-cap
      const { vector: q } = await withEmbeddingError(
        () => embedder.embedQuery(text, options),
        options?.signal,
      );
      const ranked = scoped
        .map((x) => ({
          e: x.entry,
          s: bestFragmentScore(q, x.vectors, -Infinity),
        }))
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
