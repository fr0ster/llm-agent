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
export declare class SkillSelectHandler implements IStageHandler {
  execute(
    ctx: PipelineContext,
    _config: Record<string, unknown>,
    span: ISpan,
  ): Promise<boolean>;
}
//# sourceMappingURL=skill-select.d.ts.map
