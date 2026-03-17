/**
 * AssembleHandler — builds the final LLM context from action + retrieved + history.
 *
 * Reads: `ctx.subprompts`, `ctx.ragResults`, `ctx.mcpTools` (selected), `ctx.history`
 * Writes: `ctx.assembledMessages`
 *
 * Merges multiple action subprompts into a single action, then delegates
 * to the injected IContextAssembler.
 */

import { OrchestratorError } from '../../agent.js';
import type { McpTool } from '../../interfaces/types.js';
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

    const retrieved = {
      facts: ctx.ragResults.facts,
      feedback: ctx.ragResults.feedback,
      state: ctx.ragResults.state,
      tools: selectedMcpTools as McpTool[],
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

    // Inject skill content into system message (post-assembly)
    if (ctx.skillContent) {
      const sysMsg = ctx.assembledMessages.find((m) => m.role === 'system');
      if (sysMsg) {
        sysMsg.content += `\n\n## Active Skills\n${ctx.skillContent}`;
      } else {
        ctx.assembledMessages.unshift({
          role: 'system',
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
