/**
 * SkillSelectHandler — selects skills from the skill manager and loads their content.
 *
 * Reads: `ctx.skillManager`, `ctx.skillRetriever`, `ctx.ragResults`, `ctx.inputText`
 * Writes: `ctx.selectedSkills`, `ctx.skillContent`
 *
 * Uses the configured skill retriever, with semantic RAG matching by default.
 *
 * If no `ctx.skillManager` is configured, this handler is a no-op.
 */

import {
  contextExceededError,
  type StageDefinition,
} from '@mcp-abap-adt/llm-agent';
import type { ISpan } from '../../tracer/types.js';
import { retrievalError } from '../catalogue-retrieval/retrieval-error.js';
import type { PipelineContext } from '../context.js';
import { RagSkillRetriever } from '../skill-retrieval/rag-skill-retriever.js';
import type { IStageHandler } from '../stage-handler.js';

export class SkillSelectHandler implements IStageHandler {
  async execute(
    ctx: PipelineContext,
    config: NonNullable<StageDefinition['config']>,
    span: ISpan,
  ): Promise<boolean> {
    if (!ctx.skillManager) {
      span.setAttribute('skipped', true);
      return true;
    }

    const retriever = ctx.skillRetriever;
    const ragMatches = retriever
      ? undefined
      : await new RagSkillRetriever({
          ragStores: ctx.ragStores,
          ragAccess: ctx.ragAccess,
          embedder: ctx.embedder,
          k: (config.k as number) ?? ctx.config.ragQueryK,
        }).findMatches(
          ctx.ragText || ctx.inputText,
          ctx.ragResults,
          ctx.options,
        );
    if (ragMatches && !ragMatches.ok) {
      ctx.error = ragMatches.error;
      return false;
    }

    const allSkillsResult = await ctx.skillManager.listSkills(ctx.options);
    if (!allSkillsResult.ok) {
      const overflow = contextExceededError(allSkillsResult.error);
      if (overflow) {
        ctx.error = overflow;
        return false;
      }
      ctx.options?.sessionLogger?.logStep('skill_select_error', {
        error: allSkillsResult.error.message,
      });
      return true; // Non-fatal — continue without skills
    }

    const allSkills = allSkillsResult.value;
    let selectedNames = ragMatches?.value;
    if (retriever) {
      const options = { ...ctx.options, requestLogger: ctx.requestLogger };
      try {
        const result = await retriever.retrieve(
          {
            text: ctx.inputText,
            candidates: allSkills.map(({ name, description }) => ({
              name,
              description,
            })),
          },
          options,
        );
        if (!result.ok) {
          ctx.error = result.error;
          return false;
        }
        selectedNames = new Set(result.value.names);
      } catch (error) {
        ctx.error = retrievalError(error, 'skill', options.signal);
        return false;
      }
    }

    ctx.selectedSkills = allSkills.filter((skill) =>
      selectedNames?.has(skill.name),
    );

    // Load content for selected skills
    const contentParts: string[] = [];
    for (const skill of ctx.selectedSkills) {
      const contentResult = await skill.getContent(
        ctx.skillArgs || undefined,
        ctx.options,
      );
      if (!contentResult.ok) {
        const overflow = contextExceededError(contentResult.error);
        if (overflow) {
          ctx.error = overflow;
          return false;
        }
      } else if (contentResult.value) {
        contentParts.push(`### Skill: ${skill.name}\n${contentResult.value}`);
      }
    }

    ctx.skillContent = contentParts.join('\n\n');

    span.setAttribute('total_skills', allSkills.length);
    span.setAttribute('selected_skills', ctx.selectedSkills.length);

    ctx.options?.sessionLogger?.logStep('skills_selected', {
      totalSkills: allSkills.length,
      ...(ragMatches && { ragMatchedSkills: [...ragMatches.value] }),
      ...(retriever && { retriever: retriever.name }),
      selectedCount: ctx.selectedSkills.length,
      selectedNames: ctx.selectedSkills.map((s) => s.name),
    });

    return true;
  }
}
