/**
 * SkillSelectHandler — selects skills based on RAG results and loads their content.
 *
 * Reads: `ctx.skillManager`, `ctx.ragResults.facts`, `ctx.config.mode`, `ctx.inputText`
 * Writes: `ctx.selectedSkills`, `ctx.skillContent`
 *
 * Uses RAG fact IDs with the `skill:` prefix to identify relevant skills.
 * Falls back to all skills in `hard` mode, none otherwise.
 *
 * If no `ctx.skillManager` is configured, this handler is a no-op.
 *
 * Spec §10.5.8 S-1: a store whose skill query fails (`ok: false` or a
 * rejection) fails the stage with the store's code; a failed `listSkills` or a
 * selected skill whose content cannot be read fails it with `SKILL_ERROR`.
 */

import {
  OrchestratorError,
  QueryEmbedding,
  RagError,
  TextOnlyEmbedding,
} from '@mcp-abap-adt/llm-agent';
import { rejectionError } from '../../agent/rag-helpers.js';
import type { ISpan } from '../../tracer/types.js';
import type { PipelineContext } from '../context.js';
import type { IStageHandler } from '../stage-handler.js';

export class SkillSelectHandler implements IStageHandler {
  async execute(
    ctx: PipelineContext,
    _config: Record<string, unknown>,
    span: ISpan,
  ): Promise<boolean> {
    if (!ctx.skillManager) {
      span.setAttribute('skipped', true);
      return true;
    }

    const mode = ctx.config.mode || 'smart';

    // Discover skills from all RAG results
    const allRagResults = Object.values(ctx.ragResults).flat();
    const ragSkillNames = new Set(
      allRagResults
        .map((r) => r.metadata.id as string)
        .filter((id) => id?.startsWith('skill:'))
        .map((id) => id.slice(6)),
    );

    // If no skill:* entries in RAG results, do a dedicated query on all stores.
    if (ragSkillNames.size === 0) {
      const k = (_config.k as number) ?? ctx.config.ragQueryK ?? 15;
      const queryText = ctx.ragText || ctx.inputText;
      const storeEntries = Object.entries(ctx.ragStores);
      const embedding = ctx.embedder
        ? new QueryEmbedding(queryText, ctx.embedder, ctx.options)
        : new TextOnlyEmbedding(queryText);
      const queryResults = await Promise.all(
        storeEntries.map(([name, store]) =>
          store.query(embedding, k, ctx.options).then(
            (result) => ({ name, result }),
            (err: unknown) => ({
              name,
              result: {
                ok: false as const,
                error:
                  err instanceof RagError
                    ? err
                    : new RagError(String(err), 'QUERY_ERROR'),
              },
            }),
          ),
        ),
      );
      for (const { name, result } of queryResults) {
        if (!result.ok) {
          span.setAttribute('error', result.error.message);
          ctx.error = new OrchestratorError(
            `skill-select: store "${name}" failed: ${result.error.message}`,
            result.error.code,
          );
          return false;
        }
        for (const r of result.value) {
          const id = r.metadata.id as string;
          if (id?.startsWith('skill:')) {
            ragSkillNames.add(id.slice(6));
          }
        }
      }
      if (ragSkillNames.size > 0) {
        ctx.options?.sessionLogger?.logStep('skill_select_rag_fallback', {
          query: queryText.slice(0, 200),
          k,
          matchedSkills: [...ragSkillNames],
        });
      }
    }

    let allSkillsResult: Awaited<
      ReturnType<typeof ctx.skillManager.listSkills>
    >;
    try {
      allSkillsResult = await ctx.skillManager.listSkills(ctx.options);
    } catch (err) {
      ctx.error = rejectionError(
        'skill-select: listSkills',
        err,
        'SKILL_ERROR',
      );
      span.setAttribute('error', ctx.error.message);
      return false;
    }
    if (!allSkillsResult.ok) {
      span.setAttribute('error', allSkillsResult.error.message);
      ctx.error = new OrchestratorError(
        `skill-select: listSkills failed: ${allSkillsResult.error.message}`,
        allSkillsResult.error.code,
      );
      return false;
    }

    const allSkills = allSkillsResult.value;

    // Select skills based on RAG matches or fallback
    ctx.selectedSkills =
      ragSkillNames.size > 0
        ? allSkills.filter((s) => ragSkillNames.has(s.name))
        : mode === 'hard'
          ? allSkills
          : [];

    // Load content for selected skills
    const contentParts: string[] = [];
    for (const skill of ctx.selectedSkills) {
      let contentResult: Awaited<ReturnType<typeof skill.getContent>>;
      try {
        contentResult = await skill.getContent(
          ctx.skillArgs || undefined,
          ctx.options,
        );
      } catch (err) {
        ctx.error = rejectionError(
          `skill-select: skill "${skill.name}" content`,
          err,
          'SKILL_ERROR',
        );
        span.setAttribute('error', ctx.error.message);
        return false;
      }
      if (!contentResult.ok) {
        span.setAttribute('error', contentResult.error.message);
        ctx.error = new OrchestratorError(
          `skill-select: skill "${skill.name}" content failed: ${contentResult.error.message}`,
          contentResult.error.code,
        );
        return false;
      }
      if (contentResult.value) {
        contentParts.push(`### Skill: ${skill.name}\n${contentResult.value}`);
      }
    }

    ctx.skillContent = contentParts.join('\n\n');

    span.setAttribute('total_skills', allSkills.length);
    span.setAttribute('selected_skills', ctx.selectedSkills.length);

    ctx.options?.sessionLogger?.logStep('skills_selected', {
      totalSkills: allSkills.length,
      ragMatchedSkills: [...ragSkillNames],
      selectedCount: ctx.selectedSkills.length,
      selectedNames: ctx.selectedSkills.map((s) => s.name),
    });

    return true;
  }
}
