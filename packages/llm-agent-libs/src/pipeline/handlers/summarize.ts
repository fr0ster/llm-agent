import type { ISpan } from '../../tracer/types.js';
import type { PipelineContext } from '../context.js';
import type { IStageHandler } from '../stage-handler.js';

/** @deprecated history is no longer summarized; full history is kept */
export class SummarizeHandler implements IStageHandler {
  async execute(
    _ctx: PipelineContext,
    _config: Parameters<IStageHandler['execute']>[1],
    _span: ISpan,
  ): Promise<boolean> {
    return true;
  }
}
