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
 */

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

    // Discover skills from RAG results
    const ragSkillNames = new Set(
      ctx.ragResults.facts
        .map((r) => r.metadata.id as string)
        .filter((id) => id?.startsWith('skill:'))
        .map((id) => id.slice(6)),
    );

    const allSkillsResult = await ctx.skillManager.listSkills(ctx.options);
    if (!allSkillsResult.ok) {
      ctx.options?.sessionLogger?.logStep('skill_select_error', {
        error: allSkillsResult.error.message,
      });
      return true; // Non-fatal — continue without skills
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
      const contentResult = await skill.getContent(
        ctx.skillArgs || undefined,
        ctx.options,
      );
      if (contentResult.ok && contentResult.value) {
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
