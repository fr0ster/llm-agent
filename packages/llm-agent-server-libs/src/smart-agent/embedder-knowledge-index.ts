import type {
  CallOptions,
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
 *  BEFORE the cap, so a run's hits are never starved by other runs.
 *
 *  Infrastructure artifact types (e.g. `controller-bundle`, `controller-terminal`)
 *  are skipped on upsert — they carry the full durable transcript and must NOT be
 *  embedded: they waste tokens and, once the bundle grows beyond the embedder's
 *  input limit, the JSONL rebuild fails permanently.
 *
 *  Recallable content (a tool/step result) is embedded from a BOUNDED PREFIX
 *  (`maxEmbedChars`): a large MCP result (e.g. a full dictionary dump) can exceed
 *  the embedder's input limit (SAP AI Core text-embedding-3-small: 8192 tokens),
 *  which would 400 on upsert and break the JSONL rebuild permanently — and, since
 *  recall runs mid-run, stall the whole controller turn. Only the embedding VECTOR
 *  uses the prefix; the STORED entry keeps the full content, so recall still
 *  returns the complete result. The default (16000 chars ≈ ≤ 8000 tokens even at a
 *  pessimistic 2 chars/token) stays safely under the limit with ample ranking
 *  signal; override per deployment if needed. */
export function makeKnowledgeSemanticIndex(
  embedder: IEmbedder,
  skipArtifactTypes: readonly string[] = [
    'controller-bundle',
    'controller-terminal',
  ],
  maxEmbedChars = 16000,
) {
  const bySession = new Map<string, Indexed[]>();
  // Bound the text handed to the embedder so an over-limit document never 400s
  // (the full content is stored separately and returned by recall unchanged).
  const embedInput = (text: string): string =>
    text.length > maxEmbedChars ? text.slice(0, maxEmbedChars) : text;
  return {
    async upsert(
      sid: string,
      e: KnowledgeEntry,
      options?: CallOptions,
    ): Promise<void> {
      // Skip infrastructure artifact types — never embed, never index.
      if (skipArtifactTypes.includes(e.metadata.artifactType)) return;
      const { vector } = await embedder.embed(embedInput(e.content), options);
      const arr = bySession.get(sid);
      if (arr) arr.push({ entry: e, vector });
      else bySession.set(sid, [{ entry: e, vector }]);
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
      const { vector: q } = await embedder.embed(embedInput(text), options);
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
