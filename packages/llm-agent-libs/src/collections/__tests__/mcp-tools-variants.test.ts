// packages/llm-agent-libs/src/collections/__tests__/mcp-tools-variants.test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import type {
  IItemIndexer,
  IReranker,
  ToolItem,
} from '@mcp-abap-adt/llm-agent';
import { InMemoryRag } from '@mcp-abap-adt/llm-agent-rag';
import { heldRerankers } from '../../health/agent-health.js';
import {
  type ComposedToolsProfile,
  EnumValueToolIndexer,
  FacetedToolIndexer,
  FixedItemsCut,
  ItemPool,
  MaxScoreCollapse,
  MCP_TOOLS_VARIANT_NAMES,
  mcpToolsVariants,
  NameTailFacet,
  ParameterNamesToolText,
  ParametersFacet,
  SummaryFacet,
  TokenBudgetCut,
  TopItemsCut,
} from '../index.js';

/** The consumer's reranker — any IReranker; the variants never build one. */
const reranker: IReranker = {
  rerank: async (_q, results) => ({ ok: true, value: results }),
};

function shape(p: ComposedToolsProfile) {
  const c = p.composition;
  assert.ok(
    c.pool instanceof ItemPool,
    'every variant passes an explicit ItemPool',
  );
  return {
    poolAtK4: c.pool.items(4),
    collapse: c.collapse instanceof MaxScoreCollapse,
    cut:
      c.cut instanceof FixedItemsCut
        ? c.cut.n
        : c.cut instanceof TopItemsCut
          ? 'caller-k'
          : 'other',
    reranker: c.rerank?.reranker,
    decompose: c.decompose,
  };
}
function facetsOf(indexer: IItemIndexer<ToolItem>): readonly object[] {
  assert.ok(indexer instanceof FacetedToolIndexer);
  return indexer.facets;
}
const all = () => [
  mcpToolsVariants.faceted(),
  mcpToolsVariants.faceted({ poolItems: 12, maxItems: 4 }),
  mcpToolsVariants.facetedRerank({ reranker, poolItems: 20 }),
  mcpToolsVariants.facetedRerank({ reranker, poolItems: 20, maxItems: 3 }),
];

describe('mcpToolsVariants — the §7.4 named compositions, no tuned numbers (D55, D56)', () => {
  it('the names are baseline, faceted, faceted-rerank — nothing withdrawn is left', () => {
    assert.deepEqual(
      [...MCP_TOOLS_VARIANT_NAMES],
      ['baseline', 'faceted', 'faceted-rerank'],
    );
    const keys = Object.keys(mcpToolsVariants).sort();
    assert.deepEqual(keys, ['baseline', 'faceted', 'facetedRerank']);
  });
  it('baseline binds nothing', () => {
    assert.equal(mcpToolsVariants.baseline(), undefined);
  });
  it('faceted(): summary + parameters, ItemPool() = the caller k, max, no reranker, TopItemsCut', () => {
    const p = mcpToolsVariants.faceted();
    assert.deepEqual(
      facetsOf(p.composition.indexer).map((f) => f.constructor),
      [SummaryFacet, ParametersFacet],
    );
    assert.deepEqual(shape(p), {
      poolAtK4: 4,
      collapse: true,
      cut: 'caller-k',
      reranker: undefined,
      decompose: undefined,
    });
  });
  it("faceted({ poolItems, maxItems }): the consumer's numbers → ItemPool(n) + FixedItemsCut(n)", () => {
    assert.deepEqual(
      shape(mcpToolsVariants.faceted({ poolItems: 12, maxItems: 4 })),
      {
        poolAtK4: 12,
        collapse: true,
        cut: 4,
        reranker: undefined,
        decompose: undefined,
      },
    );
  });
  it('faceted-rerank: faceted indexing + ItemPool(poolItems) + max + exactly the given reranker + TopItemsCut', () => {
    const p = mcpToolsVariants.facetedRerank({ reranker, poolItems: 20 });
    assert.deepEqual(
      facetsOf(p.composition.indexer).map((f) => f.constructor),
      [SummaryFacet, ParametersFacet],
    );
    const s = shape(p);
    assert.equal(
      s.reranker,
      reranker,
      'the consumer reranker object itself, not a wrapper',
    );
    assert.deepEqual(
      { ...s, reranker: undefined },
      {
        poolAtK4: 20,
        collapse: true,
        cut: 'caller-k',
        reranker: undefined,
        decompose: undefined,
      },
    );
  });
  it('faceted-rerank: maxItems → FixedItemsCut', () => {
    // "no onFailure option" (D71) is a compile-time pin: `collection-profile.typecheck.ts` (`_noOnFailure`).
    const s = shape(
      mcpToolsVariants.facetedRerank({ reranker, poolItems: 20, maxItems: 3 }),
    );
    assert.equal(s.cut, 3);
  });
  it('every cut is the caller k or a ceiling under it (F1)', () => {
    for (const p of all()) assert.ok((p.composition.cut?.limit(2) ?? 2) <= 2);
  });
  it('the default provider text stays C0 (ParameterNamesToolText) in every variant (F4)', () => {
    for (const p of all()) {
      const ix = p.composition.indexer;
      assert.ok(
        ix instanceof FacetedToolIndexer &&
          ix.text instanceof ParameterNamesToolText,
      );
    }
  });
  it('no variant contains NameTailFacet, EnumValueToolIndexer or TokenBudgetCut', () => {
    for (const p of all()) {
      assert.ok(!(p.composition.indexer instanceof EnumValueToolIndexer));
      assert.ok(
        !facetsOf(p.composition.indexer).some(
          (f) => f instanceof NameTailFacet,
        ),
      );
      assert.ok(!(p.composition.cut instanceof TokenBudgetCut));
    }
  });
  it("the consumer's decomposer is passed through; none otherwise", () => {
    const decompose = {
      decomposer: {
        name: 'd',
        decompose: async () => ({ ok: true as const, value: [] }),
      },
      queryEmbedder: { embedQuery: async () => ({ vector: [1] }) },
    };
    assert.equal(
      mcpToolsVariants.facetedRerank({ reranker, poolItems: 20, decompose })
        .composition.decompose,
      decompose,
    );
    assert.equal(
      mcpToolsVariants.faceted({ decompose }).composition.decompose,
      decompose,
    );
    for (const p of all()) assert.equal(p.composition.decompose, undefined);
  });
  it('poolItems and maxItems must be positive integers', () => {
    assert.throws(
      () => mcpToolsVariants.facetedRerank({ reranker, poolItems: 0 }),
      /poolItems/,
    );
    assert.throws(
      () => mcpToolsVariants.facetedRerank({ reranker, poolItems: 2.5 }),
      /poolItems/,
    );
    // Required at runtime too (spec §7.4, no default): a JS caller's missing poolItems never gets the generic pool.
    assert.throws(
      () =>
        mcpToolsVariants.facetedRerank({
          reranker,
          poolItems: undefined as unknown as number,
        }),
      /facetedRerank: poolItems must be a positive integer/,
    );
    assert.throws(
      () =>
        mcpToolsVariants.facetedRerank({
          reranker,
          poolItems: 20,
          maxItems: 0,
        }),
      /maxItems/,
    );
    assert.throws(
      () => mcpToolsVariants.faceted({ poolItems: -1 }),
      /poolItems/,
    );
  });
  it('the variants module carries no numeric literal as a pool or cut size (D55)', () => {
    const src = readFileSync(
      new URL('../mcp-tools-variants.ts', import.meta.url),
      'utf8',
    );
    assert.doesNotMatch(
      src,
      /new (ItemPool|FixedItemsCut|TopItemsCut|ScoreFloorCut|TokenBudgetCut)\(\s*\d/,
    );
    assert.doesNotMatch(src, /(poolItems|maxItems)\s*(\?\?|=)\s*\d/);
  });
  it("the health probe finds the faceted-rerank variant's reranker through the store's strategy (D97)", () => {
    const bound = mcpToolsVariants
      .facetedRerank({ reranker, poolItems: 20 })
      .bind({ key: 'tools', rag: new InMemoryRag() });
    const held = heldRerankers(undefined, { tools: bound.rag });
    assert.equal(held.length, 1);
    assert.equal(held[0].reranker, reranker);
  });
});
