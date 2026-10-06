// packages/llm-agent-libs/src/collections/max-score-collapse.ts
import type {
  CollapsedItem,
  ICollapseRule,
  RagResult,
  RecordOwner,
  SourcedHit,
} from '@mcp-abap-adt/llm-agent';
import { itemKey, ownerFromMetadata } from './owner.js';

interface Group {
  source: string;
  owner: RecordOwner;
  itemId: string;
  hits: RagResult[];
  first: number;
}

/**
 * Item score = its best record's score — the winner in the consumer's evidence (spec §2.1);
 * count and RRF are not shipped. Hits without an `itemId` or with a malformed
 * owner are not items: the retrieval handles them before collapse.
 */
export class MaxScoreCollapse implements ICollapseRule {
  readonly name = 'max';
  collapse(hits: readonly SourcedHit[]): CollapsedItem[] {
    const groups = new Map<string, Group>();
    hits.forEach((h, i) => {
      const itemId = h.metadata.itemId;
      const owner = ownerFromMetadata(h.metadata);
      if (typeof itemId !== 'string' || !owner) return;
      const k = itemKey(h.source, owner, itemId);
      let g = groups.get(k);
      if (!g) {
        g = { source: h.source, owner, itemId, hits: [], first: i };
        groups.set(k, g);
      }
      g.hits.push(h);
    });
    return [...groups.values()]
      .map((g) => {
        const sorted = [...g.hits].sort((a, b) => b.score - a.score);
        const best = sorted[0];
        // A group is created by its first hit, so it is never empty.
        if (!best) throw new Error('MaxScoreCollapse: empty group');
        return { ...g, hits: sorted, score: best.score };
      })
      .sort((a, b) => b.score - a.score || a.first - b.first)
      .map(({ source, owner, itemId, score, hits }) => ({
        source,
        owner,
        itemId,
        score,
        hits,
      }));
  }
}
