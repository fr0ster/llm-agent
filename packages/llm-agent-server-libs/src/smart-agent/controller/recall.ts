import type {
  CallOptions,
  IEmbedder,
  IKnowledgeRagHandle,
  KnowledgeEntry,
} from '@mcp-abap-adt/llm-agent';
import { cosine } from '../embedder-knowledge-index.js';
import { type Outcome, resolveByPrecedence } from './outcome.js';

/** Top-k recalled artifacts injected into the executor context per step. */
/** Artifact types eligible for recall (excludes the 'controller-bundle' record
 *  that shares the same backend). */
export const RECALL_ARTIFACT_TYPES = ['step-result', 'mcp-result'] as const;
/** Per-kind recall counts (distinct artifacts kept after dedup + cap). */
export const RECALL_K_STEP = 4;
export const RECALL_K_MCP = 4;
/** SEPARATE char budgets per kind, so a huge step-result cannot starve MCP context. */
export const RECALL_MAX_CHARS_STEP = 2000;
export const RECALL_MAX_CHARS_MCP = 2000;
/** Char budget for a single per-`requires` evidence extract handed to the reviewer. */
export const RECALL_EVIDENCE_CHARS = 800;

/** Build a bounded "Relevant prior context" block from recalled artifacts under
 *  the given char budget, or undefined when there is nothing to inject. */
export function buildRecallBlock(
  hits: readonly { content: string }[],
  maxChars: number,
): string | undefined {
  if (hits.length === 0) return undefined;
  const parts: string[] = [];
  let used = 0;
  for (const h of hits) {
    const c = h.content ?? '';
    if (c.length === 0) continue;
    if (used + c.length > maxChars) {
      parts.push(c.slice(0, maxChars - used));
      break;
    }
    parts.push(c);
    used += c.length;
  }
  if (parts.length === 0) return undefined;
  return `Relevant prior context:\n${parts.join('\n')}`;
}

/** Gather the run's approved results, one per seq, resolved by outcome precedence
 *  (ok/exists > partial > failed), ordered by seq. Reconstructs the complete
 *  Outcome from artifact metadata (status/note/remainder) + content. */
export async function collectApproved(
  rag: IKnowledgeRagHandle,
  runId: string,
): Promise<{ seq: number; content: string }[]> {
  const all = await rag.list({ runId, artifactType: 'step-result' });
  const bySeq = new Map<number, Outcome[]>();
  for (const e of all) {
    const seq = e.metadata.seq ?? 0;
    const o: Outcome = {
      status: (e.metadata.status ?? 'failed') as Outcome['status'],
      approved: e.content,
      remainder: e.metadata.remainder ?? '',
      note: e.metadata.note ?? '',
    };
    const arr = bySeq.get(seq);
    if (arr) arr.push(o);
    else bySeq.set(seq, [o]);
  }
  const out: { seq: number; content: string }[] = [];
  for (const [seq, outcomes] of [...bySeq.entries()].sort(
    (a, b) => a[0] - b[0],
  )) {
    const resolved = resolveByPrecedence(outcomes);
    if (resolved && resolved.status !== 'failed')
      out.push({ seq, content: resolved.approved });
  }
  return out;
}

/** The ONE run-scoped results-RAG recall primitive — used by BOTH the whole-step
 *  recall AND the per-`requires` evidence. EMBEDDING-based similarity via the
 *  backend's semantic query (NO homemade lexical scoring): the backend embeds the
 *  query + ranks by vector similarity, with the `runId` filter applied PRE-cap.
 *  Over-fetch `kPrime` (caller-supplied so the duplication bound is justified PER
 *  KIND), then dedup and cap to `k`. Dedup: step-results (have `seq`) →
 *  precedence-winner per seq; mcp-results → by `identityKey`. Embedding rank order
 *  is preserved through the dedup.
 *  `options` is forwarded into the embedder so recall-time embeds are metered. */
export async function runScopedRecall(
  rag: IKnowledgeRagHandle,
  text: string,
  k: number,
  runId: string | undefined,
  kPrime: number,
  artifactType: readonly string[],
  options?: CallOptions,
): Promise<readonly KnowledgeEntry[]> {
  const hits = await rag.query(text, {
    k: kPrime,
    filter: { runId, artifactType },
    options,
  });
  const bestStep = new Map<number, KnowledgeEntry>();
  const bestMcp = new Map<string, KnowledgeEntry>();
  for (const e of hits) {
    if (e.metadata.seq !== undefined && e.metadata.status !== undefined) {
      const prev = bestStep.get(e.metadata.seq);
      if (!prev || isBetterStep(e, prev)) bestStep.set(e.metadata.seq, e);
    } else if (e.metadata.identityKey) {
      const prev = bestMcp.get(e.metadata.identityKey);
      if (!prev || isBetterMcp(e, prev)) bestMcp.set(e.metadata.identityKey, e);
    }
  }
  // Walk hits in embedding-rank order; emit each (runId,seq) / identityKey once.
  const out: KnowledgeEntry[] = [];
  const seenSeq = new Set<number>();
  const seenMcp = new Set<string>();
  for (const e of hits) {
    if (e.metadata.seq !== undefined && e.metadata.status !== undefined) {
      if (seenSeq.has(e.metadata.seq)) continue;
      seenSeq.add(e.metadata.seq);
      // biome-ignore lint/style/noNonNullAssertion: bestStep has this seq (set above).
      out.push(bestStep.get(e.metadata.seq)!);
    } else if (e.metadata.identityKey) {
      if (seenMcp.has(e.metadata.identityKey)) continue;
      seenMcp.add(e.metadata.identityKey);
      // biome-ignore lint/style/noNonNullAssertion: bestMcp has this key (set above).
      out.push(bestMcp.get(e.metadata.identityKey)!);
    } else {
      out.push(e);
    }
    if (out.length >= k) break;
  }
  return out.slice(0, k);
}

/** Outcome-precedence rank for step-result dedup (ok/exists > partial > failed). */
function rankStatus(s?: string): number {
  return s === 'ok' || s === 'exists'
    ? 3
    : s === 'partial'
      ? 2
      : s === 'failed'
        ? 1
        : 0;
}

/** True when candidate `a` is a better winner than current `b` for step-result
 *  dedup. Latest-wins by EXECUTION IDENTITY, not by semantic-rank position:
 *  1. Higher status rank wins; on tie →
 *  2. Higher attempt wins; on further tie →
 *  3. Higher writeOrdinal wins (tie-breaks same-timestamp artifacts from one run); on tie →
 *  4. Later createdAt wins (missing = older: compare with '' as sentinel). */
function isBetterStep(a: KnowledgeEntry, b: KnowledgeEntry): boolean {
  const ra = rankStatus(a.metadata.status);
  const rb = rankStatus(b.metadata.status);
  if (ra !== rb) return ra > rb;
  const aa = a.metadata.attempt ?? 0;
  const ba = b.metadata.attempt ?? 0;
  if (aa !== ba) return aa > ba;
  const ao = a.metadata.writeOrdinal ?? -1;
  const bo = b.metadata.writeOrdinal ?? -1;
  if (ao !== bo) return ao > bo;
  return (a.metadata.createdAt ?? '') > (b.metadata.createdAt ?? '');
}

/** True when candidate `a` is a better winner than current `b` for mcp-result
 *  dedup. Latest-fetch wins by writeOrdinal first (handles same-timestamp), then
 *  falls back to createdAt (missing = older). */
function isBetterMcp(a: KnowledgeEntry, b: KnowledgeEntry): boolean {
  const ao = a.metadata.writeOrdinal ?? -1;
  const bo = b.metadata.writeOrdinal ?? -1;
  if (ao !== bo) return ao > bo;
  return (a.metadata.createdAt ?? '') > (b.metadata.createdAt ?? '');
}

const MAX_EXTRACT_WINDOWS = 64;
/** Return the ≤`maxChars` fragment of `content` most similar to `ref` by EMBEDDING
 *  (NOT ASCII lexical overlap). DIRECT single-pass ranking: every candidate is
 *  scored on its own. The SCORED window IS the RETURNED body: candidates are
 *  `body = maxChars - 2` chars (head+tail '…' reserved up front), so the
 *  highest-scoring fragment is never truncated by the markers. Stride is 50%
 *  overlap, widened to span the whole content within MAX_EXTRACT_WINDOWS windows
 *  (point coverage for content ≤ MAX_EXTRACT_WINDOWS×maxChars; larger thins to
 *  non-overlapping, best-effort). Embeds are SEQUENTIAL and BOUNDED to ≤
 *  MAX_EXTRACT_WINDOWS + 1 — touches NO public embedder API (batch is a deferred
 *  optimization). Result STRICTLY ≤ maxChars; tiny maxChars (< 3) → bare slice.
 *  The `requires` ref is English (planner invariant) → a normal embedder suffices. */
export async function relevantExtract(
  content: string,
  ref: string,
  maxChars: number,
  embedder: IEmbedder,
  options?: CallOptions,
): Promise<string> {
  if (content.length <= maxChars) return content;
  if (maxChars < 3) return content.slice(0, Math.max(0, maxChars));
  const body = maxChars - 2;
  const stride = Math.max(
    Math.floor(body / 2),
    Math.ceil(content.length / MAX_EXTRACT_WINDOWS),
  );
  const { vector: q } = await embedder.embed(ref, options);
  let bestStart = 0;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (let s = 0; s < content.length; s += stride) {
    const { vector } = await embedder.embed(
      content.slice(s, s + body),
      options,
    );
    const score = cosine(q, vector);
    if (score > bestScore) {
      bestScore = score;
      bestStart = s;
    }
  }
  const head = bestStart > 0 ? '…' : '';
  const tail = bestStart + body < content.length ? '…' : '';
  return head + content.slice(bestStart, bestStart + body) + tail;
}
