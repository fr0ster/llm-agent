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
export class ClassifyHandler {
  async execute(ctx, _config, span) {
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
  _updateControlFlags(ctx) {
    const actions = ctx.subprompts.filter((sp) => sp.type === 'action');
    const mode = ctx.config.mode || 'smart';
    const hasRagStores = Object.keys(ctx.ragStores).length > 0;
    const hasMcpClients = ctx.mcpClients.length > 0;
    ctx.isSapRequired =
      actions.some((a) => a.context === 'sap-abap') || mode === 'hard';
    // Populate ragText from action texts — downstream stages (translate, expand,
    // rag-query) all read from ctx.ragText.
    ctx.ragText = actions.map((a) => a.text).join(' ');
    // Retrieve when there are actions and stores/tools to search,
    // or when mode is 'hard' (always retrieve).
    ctx.shouldRetrieve =
      mode === 'hard' ||
      (actions.length > 0 && (hasMcpClients || hasRagStores));
  }
}
//# sourceMappingURL=classify.js.map
