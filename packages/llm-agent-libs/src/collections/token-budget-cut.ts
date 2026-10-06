// packages/llm-agent-libs/src/collections/token-budget-cut.ts
import type {
  IItemCut,
  IItemSizeEstimator,
  ISizeBoundedCut,
  RagResult,
} from '@mcp-abap-adt/llm-agent';
import { assertPositiveInteger } from '../util/assert-positive-integer.js';
import { ToolDefinitionSizeEstimator } from './size-estimators.js';

/**
 * A prompt-size GUARD (spec §4.10), in no default composition: whole items in
 * rank order while their summed size ≤ `budgetTokens`, at most
 * `min(requestedK, maxItems ?? requestedK)`. Stops at the first item that does not fit (D19);
 * never truncates; the top item alone over budget → empty (D17). Implements
 * ISizeBoundedCut (S6), so StagedRetrieval reports its tokens and over_budget.
 */
export class TokenBudgetCut implements IItemCut, ISizeBoundedCut {
  readonly name = 'token-budget';
  readonly budgetTokens: number;
  readonly maxItems: number | undefined;
  readonly estimator: IItemSizeEstimator;

  constructor(opts: {
    budgetTokens: number;
    maxItems?: number;
    estimator?: IItemSizeEstimator;
  }) {
    assertPositiveInteger('TokenBudgetCut', 'budgetTokens', opts.budgetTokens);
    if (opts.maxItems !== undefined) {
      assertPositiveInteger('TokenBudgetCut', 'maxItems', opts.maxItems);
    }
    this.budgetTokens = opts.budgetTokens;
    this.maxItems = opts.maxItems;
    this.estimator = opts.estimator ?? new ToolDefinitionSizeEstimator();
  }

  limit(requestedK: number): number {
    return Math.min(requestedK, this.maxItems ?? requestedK);
  }

  cut(items: readonly RagResult[], requestedK: number): RagResult[] {
    const max = this.limit(requestedK);
    const out: RagResult[] = [];
    let used = 0;
    for (const it of items) {
      if (out.length >= max) break;
      const size = this.estimator.estimate(it);
      if (used + size > this.budgetTokens) break;
      used += size;
      out.push(it);
    }
    return out;
  }
}
