/**
 * PrepareRagText stage handler plugin.
 *
 * Workaround for v3.0.0 structured pipeline: ctx.ragText is initialized
 * as empty string; this stage sets it from classified action subprompts
 * (or falls back to inputText).
 *
 * Usage in smart-server.yaml:
 *   stages:
 *     - id: classify
 *       type: classify
 *     - id: prepare-rag-text
 *       type: prepare-rag-text
 *     - id: rag-retrieval
 *       ...
 */

class PrepareRagTextHandler {
  async execute(ctx, _config, span) {
    // Use all subprompt texts (classifier may classify questions as 'fact', not 'action')
    const texts = (ctx.subprompts || []).map(sp => sp.text).filter(Boolean);
    ctx.ragText = texts.length > 0 ? texts.join(' ') : ctx.inputText;
    span.setAttribute('ragText', ctx.ragText.slice(0, 200));
    return true;
  }
}

/** @type {Record<string, { execute: Function }>} */
export const stageHandlers = {
  'prepare-rag-text': new PrepareRagTextHandler(),
};
