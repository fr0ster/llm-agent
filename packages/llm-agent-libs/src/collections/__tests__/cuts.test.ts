// packages/llm-agent-libs/src/collections/__tests__/cuts.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isSizeBoundedCut, type RagResult } from '@mcp-abap-adt/llm-agent';
import {
  CharsPerTokenEstimator,
  FixedItemsCut,
  ScoreFloorCut,
  TokenBudgetCut,
  ToolDefinitionSizeEstimator,
  TopItemsCut,
} from '../index.js';

const item = (
  id: string,
  score: number,
  definitionChars?: number,
): RagResult => ({
  text: id.repeat(4),
  metadata: {
    id,
    ...(definitionChars !== undefined ? { definitionChars } : {}),
  },
  score,
});
const ids = (r: RagResult[]) => r.map((x) => x.metadata.id);
const ranked = [item('a', 0.9), item('b', 0.8), item('c', 0.4), item('d', 0.3)];

describe('count cuts', () => {
  it('TopItemsCut: the caller k', () => {
    const c = new TopItemsCut();
    assert.equal(c.limit(3), 3);
    assert.deepEqual(ids(c.cut(ranked, 2)), ['a', 'b']);
  });
  it('FixedItemsCut is a ceiling under the caller k (spec §4.9, F1)', () => {
    const c = new FixedItemsCut(3);
    assert.equal(c.limit(20), 3);
    assert.deepEqual(ids(c.cut(ranked, 20)), ['a', 'b', 'c']);
    assert.equal(c.limit(2), 2);
    assert.deepEqual(ids(c.cut(ranked, 2)), ['a', 'b']);
    assert.throws(() => new FixedItemsCut(0));
  });
  it('ScoreFloorCut: minItems, then up to maxItems while score ≥ minScore — all capped by k', () => {
    const c = new ScoreFloorCut({ minItems: 1, maxItems: 3, minScore: 0.5 });
    assert.equal(c.limit(20), 3);
    assert.deepEqual(ids(c.cut(ranked, 20)), ['a', 'b']);
    const floor3 = new ScoreFloorCut({
      minItems: 3,
      maxItems: 3,
      minScore: 0.95,
    });
    assert.deepEqual(ids(floor3.cut(ranked, 20)), ['a', 'b', 'c']);
    assert.equal(floor3.limit(2), 2);
    assert.deepEqual(ids(floor3.cut(ranked, 2)), ['a', 'b']);
    assert.throws(
      () => new ScoreFloorCut({ minItems: 4, maxItems: 3, minScore: 0 }),
    );
  });
});

describe('TokenBudgetCut', () => {
  const tools = [item('a', 0.9, 400), item('b', 0.8, 400), item('c', 0.7, 40)]; // 100, 100, 10 tokens
  it('a rank-order prefix while the summed size fits', () => {
    const c = new TokenBudgetCut({ budgetTokens: 200 });
    assert.deepEqual(ids(c.cut(tools, 20)), ['a', 'b']);
  });
  it('stops at the first item that does not fit — no skip-ahead (D19)', () => {
    const c = new TokenBudgetCut({ budgetTokens: 150 });
    assert.deepEqual(ids(c.cut(tools, 20)), ['a']);
  });
  it('the top item alone over budget gives an empty result (D17), never truncated', () => {
    const c = new TokenBudgetCut({ budgetTokens: 50 });
    assert.deepEqual(c.cut(tools, 20), []);
  });
  it('min(requestedK, maxItems ?? requestedK) is the ceiling and the limit', () => {
    assert.equal(new TokenBudgetCut({ budgetTokens: 999 }).limit(2), 2);
    assert.deepEqual(
      ids(new TokenBudgetCut({ budgetTokens: 999 }).cut(tools, 2)),
      ['a', 'b'],
    );
    const c = new TokenBudgetCut({ budgetTokens: 999, maxItems: 1 });
    assert.equal(c.limit(20), 1);
    assert.deepEqual(ids(c.cut(tools, 20)), ['a']);
    const wide = new TokenBudgetCut({ budgetTokens: 999, maxItems: 5 });
    assert.equal(wide.limit(2), 2);
    assert.deepEqual(ids(wide.cut(tools, 2)), ['a', 'b']);
  });
  it('returns items unchanged (never truncated)', () => {
    const out = new TokenBudgetCut({ budgetTokens: 999 }).cut(tools, 20);
    assert.equal(out[0], tools[0]);
  });
  it('carries no default budget', () => {
    assert.throws(() => new TokenBudgetCut({ budgetTokens: 0 }));
    assert.throws(() => new TokenBudgetCut({ budgetTokens: 10, maxItems: 0 }));
  });
  it('is an ISizeBoundedCut (S6); the count cuts are not', () => {
    const estimator = new CharsPerTokenEstimator(3);
    const c = new TokenBudgetCut({ budgetTokens: 200, estimator });
    assert.equal(isSizeBoundedCut(c), true);
    assert.equal(c.budgetTokens, 200);
    assert.equal(c.estimator, estimator);
    for (const count of [
      new TopItemsCut(),
      new FixedItemsCut(3),
      new ScoreFloorCut({ minItems: 1, maxItems: 3, minScore: 0 }),
    ]) {
      assert.equal(isSizeBoundedCut(count), false);
    }
  });
});

describe('size estimators', () => {
  it('ToolDefinitionSizeEstimator reads definitionChars, else text length', () => {
    const e = new ToolDefinitionSizeEstimator();
    assert.equal(e.estimate(item('a', 1, 401)), 101);
    assert.equal(
      e.estimate({ text: 'x'.repeat(9), metadata: {}, score: 1 }),
      3,
    );
  });
  it('CharsPerTokenEstimator', () => {
    assert.equal(
      new CharsPerTokenEstimator(3).estimate({
        text: 'x'.repeat(10),
        metadata: {},
        score: 1,
      }),
      4,
    );
    assert.throws(() => new CharsPerTokenEstimator(0));
  });
});

describe('cut edge cases', () => {
  const floor3 = new ScoreFloorCut({
    minItems: 3,
    maxItems: 3,
    minScore: 0.95,
  });
  const all = [
    new TopItemsCut(),
    new FixedItemsCut(3),
    new ScoreFloorCut({ minItems: 1, maxItems: 3, minScore: 0.5 }),
    floor3,
    new TokenBudgetCut({ budgetTokens: 999 }),
  ];
  it('k=1 returns at most the top item for every cut', () => {
    for (const c of all) assert.deepEqual(ids(c.cut(ranked, 1)), ['a']);
  });
  it('an empty pool gives an empty result for every cut', () => {
    for (const c of all) assert.deepEqual(c.cut([], 5), []);
  });
  it('ScoreFloorCut keeps items whose score equals minScore, including ties', () => {
    const tied = [
      item('a', 0.9),
      item('b', 0.5),
      item('c', 0.5),
      item('d', 0.5),
      item('e', 0.4),
    ];
    const c = new ScoreFloorCut({ minItems: 1, maxItems: 10, minScore: 0.5 });
    assert.deepEqual(ids(c.cut(tied, 10)), ['a', 'b', 'c', 'd']);
  });
  it('ScoreFloorCut with minItems 0 can return nothing', () => {
    const c = new ScoreFloorCut({ minItems: 0, maxItems: 3, minScore: 0.95 });
    assert.deepEqual(c.cut(ranked, 20), []);
    const lenient = new ScoreFloorCut({
      minItems: 0,
      maxItems: 3,
      minScore: 0.5,
    });
    assert.deepEqual(ids(lenient.cut(ranked, 20)), ['a', 'b']);
  });
  it('TokenBudgetCut refuses a non-finite or negative estimated size', () => {
    for (const bad of [Number.NaN, -1]) {
      const c = new TokenBudgetCut({
        budgetTokens: 100,
        estimator: { name: 'bad-est', estimate: () => bad },
      });
      assert.throws(() => c.cut(ranked, 5), /bad-est.*a|item/);
    }
  });
});
