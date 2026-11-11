import type { PipelineContext } from '../context.js';

export function wrapFinalResponse(
  ctx: Pick<PipelineContext, 'clientAdapter'>,
  content: string,
): string {
  return ctx.clientAdapter && content
    ? ctx.clientAdapter.wrapResponse(content)
    : content;
}
