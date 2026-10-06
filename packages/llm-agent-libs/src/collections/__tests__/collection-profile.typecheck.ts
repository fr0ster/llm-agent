// Compile-time assertions only: listed in tsconfig.typecheck.json, run by `npm run typecheck`.
import type { IReranker } from '@mcp-abap-adt/llm-agent';
import { mcpToolsVariants } from '../mcp-tools-variants.js';

declare const reranker: IReranker;
export const _ok = mcpToolsVariants.facetedRerank({ reranker, poolItems: 20 });
export const _okFaceted = mcpToolsVariants.faceted();
export const _okNumbers = mcpToolsVariants.faceted({
  poolItems: 12,
  maxItems: 4,
});
// @ts-expect-error baseline takes no options — a decomposer is refused on baseline (spec §6.2)
export const _baselineOptions = mcpToolsVariants.baseline({});
// @ts-expect-error faceted-rerank needs poolItems — how deep the reranker looks is the consumer's (spec §7.4)
export const _noPool = mcpToolsVariants.facetedRerank({ reranker });
// @ts-expect-error faceted-rerank needs the consumer's reranker
export const _noReranker = mcpToolsVariants.facetedRerank({ poolItems: 20 });
// @ts-expect-error the withdrawn compositions are gone (D55)
export const _gone = mcpToolsVariants.smallSetJev;
// @ts-expect-error the withdrawn compositions are gone (D55)
export const _gone2 = mcpToolsVariants.facetedCohere;
// biome-ignore format: one statement per @ts-expect-error line (a wrapped call moves the error off the covered line)
// @ts-expect-error onFailure is not an option: a failed rerank is RERANK_ERROR (spec §9.3, D71)
export const _noOnFailure = mcpToolsVariants.facetedRerank({ reranker, poolItems: 20, onFailure: 'stage1' });
