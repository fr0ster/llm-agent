/**
 * BuildToolQueryHandler — composes an enriched query text for tool/skill retrieval.
 *
 * Reads: `ctx.ragText`, `ctx.ragResults`, `ctx.selectedSkills`
 * Writes: `ctx.toolQueryText`
 *
 * The resulting text combines the user-facing RAG query with top-K snippets
 * already retrieved from non-tool RAG stores plus descriptions of skills
 * selected for this request. Downstream stages configured with
 * `queryText: 'toolQueryText'` use this to drive tool discovery, so consumers
 * can steer tool selection by seeding domain knowledge into other RAG stores
 * or skills.
 *
 * ## Config
 *
 * | Field               | Type    | Default | Description                                          |
 * |---------------------|---------|---------|------------------------------------------------------|
 * | `topK`              | number  | 5       | Max RAG snippets (per store, top-scored) to include |
 * | `maxChars`          | number  | 2000    | Hard cap on the composed text length                 |
 * | `includeRagSnippets`| boolean | true    | Append RAG snippets (excluding `tool:*` IDs)         |
 * | `includeSkills`     | boolean | true    | Append selected skill names + descriptions           |
 * | `skipStores`        | string[]| []      | RAG store names to exclude from snippet source       |
 */
import type { ISpan } from '../../tracer/types.js';
import type { PipelineContext } from '../context.js';
import type { IStageHandler } from '../stage-handler.js';
export declare class BuildToolQueryHandler implements IStageHandler {
  execute(
    ctx: PipelineContext,
    config: Record<string, unknown>,
    span: ISpan,
  ): Promise<boolean>;
}
//# sourceMappingURL=build-tool-query.d.ts.map
