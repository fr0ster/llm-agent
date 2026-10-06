// packages/llm-agent-libs/src/collections/size-estimators.ts
import type { IItemSizeEstimator, RagResult } from '@mcp-abap-adt/llm-agent';
import { assertPositiveInteger } from '../util/assert-positive-integer.js';

/** ~4 chars per token — the unit the probability reranker (ex-DecisionReranker) already budgets in. */
const CHARS_PER_TOKEN = 4;

/** Tools: the definition the LLM receives (`metadata.definitionChars`), else the text. */
export class ToolDefinitionSizeEstimator implements IItemSizeEstimator {
  readonly name = 'tool-definition';
  estimate(item: RagResult): number {
    const dc = item.metadata.definitionChars;
    const chars =
      typeof dc === 'number' && Number.isFinite(dc) && dc >= 0
        ? dc
        : item.text.length;
    return Math.ceil(chars / CHARS_PER_TOKEN);
  }
}

/** Shared items and other kinds: the returned text is what reaches the prompt. */
export class CharsPerTokenEstimator implements IItemSizeEstimator {
  readonly name = 'chars-per-token';
  constructor(readonly charsPerToken: number) {
    assertPositiveInteger(
      'CharsPerTokenEstimator',
      'charsPerToken',
      charsPerToken,
    );
  }
  estimate(item: RagResult): number {
    return Math.ceil(item.text.length / this.charsPerToken);
  }
}
