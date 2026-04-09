/**
 * ClassifyHandler — decomposes user input into typed subprompts.
 *
 * Reads: `ctx.inputText`
 * Writes: `ctx.subprompts`, `ctx.isSapRequired`, `ctx.shouldRetrieve`
 *
 * When classification is disabled (`config.classificationEnabled === false`),
 * the input is treated as a single action subprompt.
 */

import { OrchestratorError } from '../../agent.js';
import type { ISpan } from '../../tracer/types.js';
import type { PipelineContext } from '../context.js';
import type { IStageHandler } from '../stage-handler.js';

export class ClassifyHandler implements IStageHandler {
  async execute(
    ctx: PipelineContext,
    _config: Record<string, unknown>,
    span: ISpan,
  ): Promise<boolean> {
    if (ctx.config.classificationEnabled === false) {
      ctx.subprompts = [
        { type: 'action', text: ctx.inputText, dependency: 'independent' },
      ];
      ctx.options?.sessionLogger?.logStep('classification_skipped', {
        text: ctx.inputText,
      });
      span.setAttribute('skipped', true);
      this._updateControlFlags(ctx);
      return true;
    }

    const result = await ctx.classifier.classify(ctx.inputText, ctx.options);
    if (!result.ok) {
      ctx.error = new OrchestratorError(
        result.error.message,
        'CLASSIFIER_ERROR',
      );
      return false;
    }

    ctx.subprompts = result.value;
    ctx.options?.sessionLogger?.logStep('classifier_response', {
      subprompts: result.value,
    });

    for (const sp of ctx.subprompts) {
      ctx.metrics.classifierIntentCount.add(1, { intent: sp.type });
    }

    this._updateControlFlags(ctx);
    return true;
  }

  /**
   * Update control flags based on classified subprompts.
   * These flags are used by `when` conditions on downstream stages.
   */
  private _updateControlFlags(ctx: PipelineContext): void {
    const actions = ctx.subprompts.filter((sp) => sp.type === 'action');
    const mode = ctx.config.mode || 'smart';
    ctx.isSapRequired =
      actions.some((a) => a.context === 'sap-abap') || mode === 'hard';

    // ragRetrievalMode removed from SmartAgentConfig in Task 4 — behavior is 'auto'
    ctx.shouldRetrieve = ctx.isSapRequired;
  }
}
