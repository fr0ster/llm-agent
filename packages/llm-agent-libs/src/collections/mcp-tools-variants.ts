// packages/llm-agent-libs/src/collections/mcp-tools-variants.ts
/**
 * Named compositions ("variants", spec §7.4). They fill in what the consumer did not
 * choose and carry NO tuned number (D55): a number they need is the consumer's argument
 * or the generic default — the caller's k for the cut and a pool of k items (D56).
 * None relies on one server's conventions (§7.0); none names a reranker vendor (§5.5).
 */
import type { IReranker } from '@mcp-abap-adt/llm-agent';
import { assertPositiveInteger } from '../util/assert-positive-integer.js';
import { ComposedToolsProfile } from './composed-tools-profile.js';
import { FixedItemsCut, TopItemsCut } from './cuts.js';
import { ItemPool } from './item-pool.js';
import { MaxScoreCollapse } from './max-score-collapse.js';
import type { StagedRetrievalOptions } from './staged-retrieval.js';
import { FacetedToolIndexer } from './tools/faceted-tool-indexer.js';
import { ParametersFacet, SummaryFacet } from './tools/facets.js';

/** Records come only from what the provider exports: no intents (D50). */
export interface VariantOptions {
  /** The consumer's own decomposer (none ships, spec §4.5). */
  readonly decompose?: StagedRetrievalOptions['decompose'];
  readonly telemetry?: StagedRetrievalOptions['telemetry'];
}

export interface FacetedOptions extends VariantOptions {
  /** Items per source; absent → the caller's k (ItemPool(), D56). */
  readonly poolItems?: number;
  /** A ceiling below the caller's k (→ FixedItemsCut); absent → TopItemsCut. */
  readonly maxItems?: number;
}

export interface FacetedRerankOptions extends VariantOptions {
  /** The consumer's reranker (e.g. RelevanceReranker over Cohere, ProbabilityReranker
   *  with the TOOL_QUESTION wording over Jev, or its own). Used as given. */
  readonly reranker: IReranker;
  /** Required: a pool of k items could only reorder what stage 1 returned; how deep
   *  the reranker looks is the consumer's calibration (spec §7.4). */
  readonly poolItems: number;
  readonly maxItems?: number;
}

export const MCP_TOOLS_VARIANT_NAMES = [
  'baseline',
  'faceted',
  'faceted-rerank',
] as const;

const facetedIndexer = () =>
  new FacetedToolIndexer([new SummaryFacet(), new ParametersFacet()]);

/** faceted: optional — absent → the caller's k (ItemPool(), D56). */
function optionalPool(label: string, n: number | undefined): ItemPool {
  if (n === undefined) return new ItemPool();
  assertPositiveInteger(label, 'poolItems', n);
  return new ItemPool(n);
}

/** faceted-rerank: required, no default (spec §7.4) — checked even when a JS caller passes undefined. */
function requiredPool(label: string, n: number): ItemPool {
  assertPositiveInteger(label, 'poolItems', n);
  return new ItemPool(n);
}

function cut(
  label: string,
  maxItems: number | undefined,
): FixedItemsCut | TopItemsCut {
  if (maxItems === undefined) return new TopItemsCut();
  assertPositiveInteger(label, 'maxItems', maxItems);
  return new FixedItemsCut(maxItems);
}

const passThrough = (o: VariantOptions) => ({
  ...(o.decompose ? { decompose: o.decompose } : {}),
  ...(o.telemetry ? { telemetry: o.telemetry } : {}),
});

export const mcpToolsVariants = {
  /** No choice made: 30.1.0, one record per tool + top-k records. Binds nothing. */
  baseline(): undefined {
    return undefined;
  },

  /** Several records per tool (full + summary + parameters, provider text only),
   *  collapsed by max. Pool and cut default to the caller's k. */
  faceted(o: FacetedOptions = {}): ComposedToolsProfile {
    return new ComposedToolsProfile({
      indexer: facetedIndexer(),
      pool: optionalPool('faceted', o.poolItems),
      collapse: new MaxScoreCollapse(),
      cut: cut('faceted', o.maxItems),
      ...passThrough(o),
    });
  },

  /** faceted + the consumer's reranker over a pool of `poolItems` items. */
  facetedRerank(o: FacetedRerankOptions): ComposedToolsProfile {
    return new ComposedToolsProfile({
      indexer: facetedIndexer(),
      pool: requiredPool('facetedRerank', o.poolItems),
      collapse: new MaxScoreCollapse(),
      rerank: { reranker: o.reranker },
      cut: cut('facetedRerank', o.maxItems),
      ...passThrough(o),
    });
  },
} as const;
