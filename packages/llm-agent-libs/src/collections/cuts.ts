// packages/llm-agent-libs/src/collections/cuts.ts
import type { IItemCut, RagResult } from '@mcp-abap-adt/llm-agent';
import { assertPositiveInteger } from '../util/assert-positive-integer.js';

/** The caller's k, in items (the default cut). */
export class TopItemsCut implements IItemCut {
  readonly name = 'top-items';
  limit(requestedK: number): number {
    return requestedK;
  }
  cut(items: readonly RagResult[], requestedK: number): RagResult[] {
    return items.slice(0, requestedK);
  }
}

/** A ceiling: at most `n` items, never more than the caller's k (spec §4.9, F1). */
export class FixedItemsCut implements IItemCut {
  readonly name = 'fixed-items';
  constructor(readonly n: number) {
    assertPositiveInteger('FixedItemsCut', 'n', n);
  }
  limit(requestedK: number): number {
    return Math.min(requestedK, this.n);
  }
  cut(items: readonly RagResult[], requestedK: number): RagResult[] {
    return items.slice(0, this.limit(requestedK));
  }
}

/** First `minItems`, then more up to `maxItems` while `score ≥ minScore`. */
export class ScoreFloorCut implements IItemCut {
  readonly name = 'score-floor';
  constructor(
    readonly opts: { minItems: number; maxItems: number; minScore: number },
  ) {
    if (!Number.isInteger(opts.minItems) || opts.minItems < 0) {
      throw new Error(
        `ScoreFloorCut: minItems must be a non-negative integer (got ${opts.minItems})`,
      );
    }
    assertPositiveInteger('ScoreFloorCut', 'maxItems', opts.maxItems);
    if (opts.minItems > opts.maxItems) {
      throw new Error('ScoreFloorCut: minItems must not exceed maxItems');
    }
    if (!Number.isFinite(opts.minScore)) {
      throw new Error('ScoreFloorCut: minScore must be a finite number');
    }
  }
  limit(requestedK: number): number {
    return Math.min(requestedK, this.opts.maxItems);
  }
  cut(items: readonly RagResult[], requestedK: number): RagResult[] {
    const max = this.limit(requestedK);
    const min = Math.min(this.opts.minItems, max);
    const out: RagResult[] = [];
    for (const it of items) {
      if (out.length >= max) break;
      if (out.length >= min && it.score < this.opts.minScore) {
        break;
      }
      out.push(it);
    }
    return out;
  }
}
