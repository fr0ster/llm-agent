import type {
  CallOptions,
  IQueryEmbedding,
  IRag,
  ISkillsRagHandle,
  RagResult,
  Result,
} from '@mcp-abap-adt/llm-agent';
import { RagError } from '@mcp-abap-adt/llm-agent'; // value (class)

export interface SkillsRagSourceConfig {
  group: string;
  k: number;
  threshold?: number;
}

/**
 * Read-only {@link IRag} adapter over an {@link ISkillsRagHandle}, letting the
 * SmartAgent context-assembler consume the skills handle as just another RAG
 * source.
 *
 * Skills live in their own embedding space, so this adapter RE-EMBEDS the
 * query via the handle (`IQueryEmbedding.text`) and never reuses the
 * assembler's vector (`IQueryEmbedding.toVector()`).
 */
export function skillsRagSource(
  handle: ISkillsRagHandle,
  cfg: SkillsRagSourceConfig,
): IRag {
  return {
    async query(
      embedding: IQueryEmbedding,
      k: number,
      options?: CallOptions,
    ): Promise<Result<RagResult[], RagError>> {
      try {
        const hits = await handle.query(
          embedding.text,
          { k: k ?? cfg.k, threshold: cfg.threshold },
          options,
        );
        const value: RagResult[] = hits.map((h) => ({
          text: h.record.content,
          score: h.score,
          metadata: {
            id: h.record.id,
            group: cfg.group,
            name: h.record.name,
            provenance: h.record.provenance,
          },
        }));
        return { ok: true, value };
      } catch (e) {
        return {
          ok: false,
          error: new RagError(`skills source error: ${String(e)}`),
        };
      }
    },

    async healthCheck(options?: CallOptions): Promise<Result<void, RagError>> {
      try {
        await handle.activeManifest(options);
        return { ok: true, value: undefined };
      } catch (e) {
        return { ok: false, error: new RagError(String(e)) };
      }
    },

    async getById(): Promise<Result<RagResult | null, RagError>> {
      return { ok: true, value: null };
    },

    writer() {
      return undefined;
    },
  };
}
