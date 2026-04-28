/**
 * ToolSelectHandler — selects MCP tools based on RAG results.
 *
 * Reads: `ctx.ragResults.facts`, `ctx.mcpTools`, `ctx.externalTools`, `ctx.toolClientMap`
 * Writes: `ctx.selectedTools`, `ctx.activeTools`
 *
 * Uses RAG fact IDs with the `tool:` prefix to identify relevant MCP tools.
 *
 * If RAG retrieval was skipped (e.g. `shouldRetrieve` was false), the handler
 * performs its own facts RAG query to discover tools. This ensures tools are
 * always discoverable regardless of domain context detection.
 *
 * Falls back to all MCP tools in `hard` mode or external-only in `smart` mode.
 */
import type { ISpan } from '../../tracer/types.js';
import type { PipelineContext } from '../context.js';
import type { IStageHandler } from '../stage-handler.js';
export declare class ToolSelectHandler implements IStageHandler {
  execute(
    ctx: PipelineContext,
    config: Record<string, unknown>,
    span: ISpan,
  ): Promise<boolean>;
}
//# sourceMappingURL=tool-select.d.ts.map
