import type {
  ActiveSnapshot,
  CallOptions,
  IEmbedder,
  ISkillsRagBackend,
  ISkillsRagHandle,
  SkillHit,
  SkillsEmbeddingDescriptor,
} from '@mcp-abap-adt/llm-agent';
import { SkillsIncompatibleError } from '@mcp-abap-adt/llm-agent'; // value (class)

export interface CompatibleSkillsRagDeps {
  backend: ISkillsRagBackend;
  embedder: IEmbedder;
  embeddingSpaceId: string;
  retrievalSchemaVersion: number;
  dimension?: number; // declared → skip probe; else resolved lazily
  /** Best-effort time-grace bound (P1.4): cap the vector read with a deadline AbortSignal so
   *  a query cannot outlive the backend's retention grace. Set `< retiredGraceMs` for a
   *  time-grace (Qdrant) backend; omit for the exact-lease (in-memory) backend. */
  recallTimeoutMs?: number;
}

export function makeCompatibleSkillsRag(
  deps: CompatibleSkillsRagDeps,
): ISkillsRagHandle {
  let dimension = deps.dimension;
  const verdictByRevision = new Map<string, boolean>();

  const descriptor = (): SkillsEmbeddingDescriptor => ({
    embeddingSpaceId: deps.embeddingSpaceId,
    dimension: dimension as number,
    retrievalSchemaVersion: deps.retrievalSchemaVersion,
  });

  async function ensureDimension(options?: CallOptions): Promise<void> {
    if (dimension === undefined) {
      const probe = await deps.embedder.embed('dimension probe', options);
      dimension = probe.vector.length;
    }
  }

  function compatible(snap: ActiveSnapshot): boolean {
    const cached = verdictByRevision.get(snap.revision);
    if (cached !== undefined) return cached;
    const d = descriptor();
    const ok =
      snap.manifest.embeddingSpaceId === d.embeddingSpaceId &&
      snap.manifest.dimension === d.dimension &&
      snap.manifest.retrievalSchemaVersion === d.retrievalSchemaVersion;
    verdictByRevision.set(snap.revision, ok);
    if (!ok) {
      // loud signal; serving never blocks on this — recall just degrades to empty.
      console.error(
        `[skills] incompatible generation ${snap.revision}: serving descriptor ${JSON.stringify(d)} != manifest ${JSON.stringify(snap.manifest)}`,
      );
    }
    return ok;
  }

  return {
    async activeManifest(
      options?: CallOptions,
    ): Promise<ActiveSnapshot | null> {
      // EAGER fail-fast (startup + healthCheck): THROW on incompatibility (P1.3) so a
      // recall-only load() can actually abort and healthCheck() reports the fault. Only
      // the RUNTIME query() degrades to [] on incompatibility.
      await ensureDimension(options);
      const snap = await deps.backend.activeSnapshot(); // pins if non-null
      try {
        if (snap && !compatible(snap)) {
          throw new SkillsIncompatibleError(
            `serving descriptor != active manifest for generation ${snap.revision}`,
          );
        }
        return snap; // null (no active generation) is OK — empty recall, no abort
      } finally {
        if (snap) deps.backend.release?.(snap.revision);
      }
    },
    async query(
      text: string,
      opts: { k: number; threshold?: number },
      options?: CallOptions,
    ): Promise<readonly SkillHit[]> {
      await ensureDimension(options);
      const snap = await deps.backend.activeSnapshot(); // ONCE — pins the generation (lease)
      if (!snap) return [];
      try {
        if (!compatible(snap)) return []; // no embed on incompatible
        const { vector } = await deps.embedder.embed(text, options); // PAID step, last
        // Bound the vector read with a DEADLINE so it cannot outlive a time-grace backend's
        // retention window (P1.4). For the exact-lease backend recallTimeoutMs is omitted.
        const sigs = [
          options?.signal,
          deps.recallTimeoutMs
            ? AbortSignal.timeout(deps.recallTimeoutMs)
            : undefined,
        ].filter(Boolean) as AbortSignal[];
        const signal = sigs.length ? AbortSignal.any(sigs) : undefined;
        const hits = await deps.backend.queryRevision(
          snap.revision,
          vector,
          opts.k,
          { ...options, signal },
        );
        const threshold = opts.threshold ?? 0.3;
        return hits.filter((h) => h.score >= threshold);
      } catch (e) {
        const n = (e as Error)?.name;
        if (n === 'AbortError' || n === 'TimeoutError') return []; // deadline hit → empty, no crash
        throw e;
      } finally {
        deps.backend.release?.(snap.revision); // EXACT retention: release the lease
      }
    },
  };
}
