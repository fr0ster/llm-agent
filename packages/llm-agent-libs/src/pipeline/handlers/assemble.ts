/**
 * AssembleHandler — builds the final LLM context from action + retrieved + history.
 *
 * Reads: `ctx.subprompts`, `ctx.ragResults`, `ctx.mcpTools` (selected), `ctx.history`
 * Writes: `ctx.assembledMessages`
 *
 * Merges multiple action subprompts into a single action, then delegates
 * to the injected IContextAssembler.
 */

import type { McpTool } from '@mcp-abap-adt/llm-agent';
import { OrchestratorError } from '../../agent.js';
import type { ISpan } from '../../tracer/types.js';
import type { PipelineContext } from '../context.js';
import type { IStageHandler } from '../stage-handler.js';

export class AssembleHandler implements IStageHandler {
  async execute(
    ctx: PipelineContext,
    _config: Record<string, unknown>,
    span: ISpan,
  ): Promise<boolean> {
    const actions = ctx.subprompts.filter((sp) => sp.type === 'action');

    // Merge multiple actions into one
    const mainAction =
      actions.length > 1
        ? {
            type: 'action' as const,
            text: actions.map((a) => a.text).join('\n'),
            context: actions.find((a) => a.context)?.context,
            dependency: 'independent' as const,
          }
        : actions.length === 1
          ? actions[0]
          : (ctx.subprompts.find((sp) => sp.type === 'chat') ??
            ctx.subprompts[0]);

    if (actions.length > 1) {
      ctx.options?.sessionLogger?.logStep('actions_merged', {
        count: actions.length,
        actions: actions.map((a) => ({
          text: a.text,
          dependency: a.dependency,
        })),
      });
    }

    // Build retrieved context — select tools that were chosen
    const selectedMcpTools = ctx.mcpTools.filter((t) =>
      ctx.activeTools.some((at) => at.name === t.name),
    );

    const recentActions =
      ctx.historyMemory && ctx.config.semanticHistoryEnabled
        ? ctx.historyMemory.getRecent(
            ctx.sessionId,
            ctx.config.historyRecencyWindow ?? 3,
          )
        : undefined;

    const retrieved = {
      ragResults: ctx.ragResults,
      tools: selectedMcpTools as McpTool[],
      recentActions,
    };

    const result = await ctx.assembler.assemble(
      mainAction,
      retrieved,
      ctx.history,
      ctx.options,
    );

    if (!result.ok) {
      ctx.error = new OrchestratorError(
        result.error.message,
        'ASSEMBLER_ERROR',
      );
      return false;
    }

    ctx.assembledMessages = result.value;

    // Matched skills vary by request and must not change the static system prefix.
    if (ctx.skillContent) {
      let requestIndex = ctx.assembledMessages.length - 1;
      while (
        requestIndex >= 0 &&
        ctx.assembledMessages[requestIndex].role !== 'user'
      ) {
        requestIndex--;
      }
      if (requestIndex >= 0) {
        const request = ctx.assembledMessages[requestIndex];
        ctx.assembledMessages[requestIndex] = {
          ...request,
          content: `${request.content}\n\n## Active Skills\n${ctx.skillContent}`,
        };
      } else {
        ctx.assembledMessages.push({
          role: 'user',
          content: `## Active Skills\n${ctx.skillContent}`,
        });
      }
    }

    ctx.options?.sessionLogger?.logStep('final_context_assembled', {
      messages: result.value,
      tools: ctx.activeTools.map((t) => t.name),
    });

    span.setAttribute('message_count', result.value.length);
    return true;
  }
}
